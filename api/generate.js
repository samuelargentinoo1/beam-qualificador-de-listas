'use strict';
// POST /api/generate — coloca um pedido de lista na FILA (o worker executa).
//
// Duas origens de alvo:
//   • Maps      — { query, uf, target }
//   • Planilha  — { query, planilha: "<csv cru>" }  (nome + CNPJ)
// A planilha é LIDA e VALIDADA aqui, não no navegador: assim a pessoa descobre
// na hora se as colunas estão erradas, em vez de esperar o worker pegar a fila.
const { supa, guard, needDb } = require('../lib/cloud/supa');
const { lerPlanilha } = require('../lib/importar');

const MAX_LINHAS = 2000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  const { query, uf, target, planilha } = req.body || {};
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'Digite o que você quer, ex.: "imobiliárias de Curitiba".' });
  }

  // ---------- modo planilha
  let rows = null;
  let avisoPlanilha = null;
  if (typeof planilha === 'string' && planilha.trim()) {
    const lido = lerPlanilha(planilha);
    if (lido.info && lido.info.erro) return res.status(400).json({ error: lido.info.erro });
    if (!lido.rows.length) {
      const motivos = lido.descartes.slice(0, 3).map(d => `${d.name}: ${d.reason}`).join(' · ');
      return res.status(400).json({
        error: `Nenhuma linha da planilha tem CNPJ válido.${motivos ? ' Ex.: ' + motivos : ''}`,
      });
    }
    if (lido.rows.length > MAX_LINHAS) {
      return res.status(400).json({
        error: `A planilha tem ${lido.rows.length} empresas — o limite por pedido é ${MAX_LINHAS}. Quebre em partes.`,
      });
    }
    rows = lido.rows;
    avisoPlanilha = {
      validas: lido.rows.length,
      descartadas: lido.descartes.length,
      colunaNome: lido.info.colunaNome,
      colunaCnpj: lido.info.colunaCnpj,
    };
  }

  // FILA: aceita vários pedidos (a equipe toda pode pedir); roda um por vez, em ordem.
  const { data: fila } = await db.from('jobs')
    .select('id').eq('status', 'na_fila');
  if ((fila || []).length >= 10) {
    return res.status(429).json({ error: 'A fila já tem 10 pedidos aguardando — deixa ela andar antes de pedir mais.' });
  }

  const primeiraLinha = rows
    ? `Pedido criado no painel — planilha com ${rows.length} empresa(s) ` +
      `(colunas "${avisoPlanilha.colunaNome}" e "${avisoPlanilha.colunaCnpj}"` +
      `${avisoPlanilha.descartadas ? `, ${avisoPlanilha.descartadas} linha(s) descartada(s) na leitura` : ''}). ` +
      'Aguardando o worker pegar a fila…'
    : 'Pedido criado no painel — aguardando o computador de geração (worker) pegar a fila…';

  const registro = {
    query: String(query).trim(),
    uf: String(uf || '').toUpperCase().slice(0, 2),
    // planilha: o alvo padrão é qualificar tudo que veio; Maps segue com meta de 60
    target: rows
      ? Math.max(1, Math.min(MAX_LINHAS, parseInt(target, 10) || rows.length))
      : Math.max(1, Math.min(100, parseInt(target, 10) || 60)),
    log: [primeiraLinha],
  };
  if (rows) { registro.rows = rows; registro.origem = 'planilha'; }

  const { data, error } = await db.from('jobs').insert(registro).select('id').single();

  if (error) {
    // Coluna nova ainda não criada no banco: erro claro em vez do erro cru do
    // PostgREST ("column ... does not exist" OU "Could not find the '...' column
    // of 'jobs' in the schema cache" — a ordem das palavras varia).
    if (/column/i.test(error.message) && /rows|origem/i.test(error.message)) {
      return res.status(500).json({
        error: 'O banco ainda não tem as colunas do modo planilha. Rode no SQL Editor do Supabase: ' +
               'alter table jobs add column if not exists rows jsonb, add column if not exists origem text;',
      });
    }
    return res.status(500).json({ error: error.message });
  }

  res.json({
    jobId: data.id, queued: true, position: (fila || []).length + 1,
    planilha: avisoPlanilha,
  });
};
