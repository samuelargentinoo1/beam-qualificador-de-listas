'use strict';
// Servidor local da Ferramenta de Qualificação de Listas (Beam + Babuya).
// Rode:  npm start   →  http://localhost:3010

const express = require('express');
const path = require('path');
const fs = require('fs');

// carrega o .env (Moskit, Supabase etc.) sem dependência externa
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();
const { runJob, LISTS_PATH } = require('./lib/runner');
const ledgerLib = require('./lib/ledger');
const { lerPlanilha } = require('./lib/importar');
const { readJson, titleCase } = require('./lib/util');

const app = express();
const PORT = process.env.PORT || 3010;
// 10mb: uma planilha do banco pode ter milhares de linhas de nome+CNPJ.
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------- estado do job
let activeJob = null;
let lastJob = null;

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, stage: job.stage,
    query: job.query, segment: job.segment, city: job.city, uf: job.uf, target: job.target,
    // as linhas em si não vão no view (podem ser milhares) — só quantas são
    origem: job.origem || 'maps',
    linhasPlanilha: Array.isArray(job.rows) ? job.rows.length : 0,
    usuario: job.usuario || null,
    counts: job.counts,
    log: job.log.slice(-80),
    startedAt: job.startedAt,
    result: job.result || null,
    error: job.error || null,
  };
}

// --------------------------------------------------------------- parse query
// Aceita: "imobiliárias de são josé do rio preto", "imobiliárias em curitiba",
// "imobiliárias, maringá", "imobiliárias curitiba" (sem conector).
function parseQuery(q) {
  let s = String(q || '').trim()
    .replace(/^(gerar|quero|preciso de|lista de|listas de|leads de)\s+/i, '');
  // 1) conector explícito " de " / " em "
  let m = s.match(/^(.*?)\s+(?:de|em)\s+(.+)$/i);
  if (m) return { segment: m[1].trim(), city: m[2].trim() };
  // 2) vírgula ou hífen: "imobiliárias, maringá"
  m = s.match(/^([^,\-]+)[,\-]\s*(.+)$/);
  if (m) return { segment: m[1].trim(), city: m[2].trim() };
  // 3) sem conector: 1ª palavra = segmento, resto = cidade
  m = s.match(/^(\S+)\s+(.+)$/);
  if (m) return { segment: m[1].trim(), city: m[2].trim() };
  return null;
}

// -------------------------------------------------------------------- rotas
app.post('/api/generate', (req, res) => {
  console.log(`[api] pedido de geração: ${JSON.stringify(req.body || {})}`);
  if (activeJob && activeJob.status === 'rodando') {
    console.log('[api] recusado: já existe geração em andamento');
    return res.status(409).json({ error: 'Já existe uma geração em andamento. Aguarde ou cancele.' });
  }
  const { query, segment, city, uf, target, rows, planilha, usuario, moskitUserId } = req.body || {};

  // MODO PLANILHA: os alvos vêm prontos (nome+CNPJ). Aceita as linhas já lidas
  // (`rows`, é o que a nuvem manda) ou o CSV cru (`planilha`, útil em teste local).
  let linhas = Array.isArray(rows) ? rows : null;
  let infoPlanilha = null;
  // "mandou planilha" ≠ "a planilha tem linhas boas": sem separar os dois, uma
  // planilha toda inválida cairia no erro de segmento/cidade, que confunde.
  const enviouPlanilha = !!(Array.isArray(rows) || (typeof planilha === 'string' && planilha.trim()));
  if (!linhas && typeof planilha === 'string' && planilha.trim()) {
    const lido = lerPlanilha(planilha);
    if (lido.info && lido.info.erro) return res.status(400).json({ error: lido.info.erro });
    linhas = lido.rows;
    infoPlanilha = lido.info;
    if (lido.descartes.length) console.log(`[api] planilha: ${lido.descartes.length} linha(s) descartada(s) na leitura`);
    if (!lido.rows.length) {
      const ex = lido.descartes.slice(0, 3).map(d => `${d.name}: ${d.reason}`).join(' · ');
      return res.status(400).json({
        error: `Nenhuma linha da planilha tem CNPJ válido.${ex ? ' Ex.: ' + ex : ''}`,
      });
    }
  }
  if (enviouPlanilha && (!linhas || !linhas.length)) {
    return res.status(400).json({ error: 'A planilha não tem nenhuma linha com CNPJ válido.' });
  }
  const modoPlanilha = !!(linhas && linhas.length);

  let seg = segment, cid = city;
  if ((!seg || !cid) && query) {
    const p = parseQuery(query);
    if (p) { seg = seg || p.segment; cid = cid || p.city; }
  }
  // No modo planilha a CIDADE é opcional: cada lead traz a sua, vinda da Receita.
  // O segmento continua necessário — é ele que forma a praça do anti-repetido.
  if (modoPlanilha) {
    if (!seg) seg = String(query || '').trim() || 'empresas';
  } else if (!seg || !cid) {
    console.log(`[api] recusado: não entendi segmento/cidade em "${query}"`);
    return res.status(400).json({
      error: `Não entendi o segmento e a cidade em "${query}". Escreva no formato "SEGMENTO de CIDADE" — ex.: "imobiliárias de Curitiba".`,
    });
  }
  // Planilha: o alvo padrão é qualificar a planilha inteira (não a meta de 60).
  const tgt = modoPlanilha
    ? Math.max(1, Math.min(2000, parseInt(target, 10) || linhas.length))
    : Math.max(1, Math.min(100, parseInt(target, 10) || 60));

  const job = {
    id: 'job_' + Date.now(),
    status: 'rodando',
    stage: 'iniciando',
    query: query || (modoPlanilha ? `${seg} (planilha)` : `${seg} de ${cid}`),
    segment: seg, city: cid || '', uf: (uf || '').toUpperCase().slice(0, 2),
    target: tgt,
    rows: modoPlanilha ? linhas : null,
    origem: modoPlanilha ? 'planilha' : 'maps',
    // quem pediu no painel (vem do worker) → responsável dos leads no Moskit.
    // Sem isso (geração local direta) o Moskit usa o padrão do .env.
    usuario: usuario ? String(usuario).slice(0, 80) : null,
    moskitUserId: parseInt(moskitUserId, 10) || null,
    counts: { capturados: 0, limpos: 0, qualificados: 0, descartados: 0, jaEntregues: 0, adiados: 0 },
    log: infoPlanilha
      ? [`[${new Date().toLocaleTimeString('pt-BR')}] Planilha lida: coluna de nome "${infoPlanilha.colunaNome}", ` +
         `coluna de CNPJ "${infoPlanilha.colunaCnpj}" — ${linhas.length} empresa(s) válida(s).`]
      : [],
    cancel: false,
    startedAt: new Date().toISOString(),
  };
  activeJob = job;

  runJob(job)
    .catch(e => {
      job.status = 'erro';
      job.stage = 'erro';
      job.error = String(e.message || e);
      job.log.push('ERRO: ' + job.error);
    })
    .finally(() => { lastJob = job; if (activeJob === job) activeJob = null; });

  res.json({ jobId: job.id });
});

app.get('/api/job/active', (_req, res) => {
  res.json({ job: jobView(activeJob) || jobView(lastJob) });
});

app.post('/api/job/cancel', (_req, res) => {
  if (activeJob) { activeJob.cancel = true; return res.json({ ok: true }); }
  res.status(404).json({ error: 'Nenhuma geração em andamento.' });
});

app.get('/api/lists', (_req, res) => {
  const lists = readJson(LISTS_PATH, []);
  const ledger = ledgerLib.load();
  const counts = {};
  for (const l of lists) counts[l.key] = ledgerLib.deliveredCount(ledger, l.key);
  res.json({ lists, deliveredByKey: counts });
});

// download seguro: só arquivos registrados no histórico
app.get('/api/lists/:id/file/:kind', (req, res) => {
  const lists = readJson(LISTS_PATH, []);
  const item = lists.find(l => l.id === req.params.id);
  if (!item) return res.status(404).send('Lista não encontrada');
  const file = item.files && item.files[req.params.kind];
  if (!file || !fs.existsSync(file)) return res.status(404).send('Arquivo não encontrado');
  res.download(file);
});

// modo local não tem login: o painel esconde o nome no topo
app.get('/api/me', (_req, res) => res.json({ local: true, login: null, nome: null }));

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Beam Qualificador de Listas' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✨ Beam — Qualificador de Listas rodando em  http://localhost:${PORT}\n`);
});
