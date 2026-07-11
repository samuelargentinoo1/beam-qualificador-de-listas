'use strict';
// POST /api/generate — coloca um pedido de lista na FILA (o worker no Mac executa).
const { supa, guard, needDb } = require('../lib/cloud/supa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  const { query, uf, target } = req.body || {};
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'Digite o que você quer, ex.: "imobiliárias de Curitiba".' });
  }

  // FILA: aceita vários pedidos (a equipe toda pode pedir); roda um por vez, em ordem.
  const { data: fila } = await db.from('jobs')
    .select('id').eq('status', 'na_fila');
  if ((fila || []).length >= 10) {
    return res.status(429).json({ error: 'A fila já tem 10 pedidos aguardando — deixa ela andar antes de pedir mais.' });
  }

  const { data, error } = await db.from('jobs').insert({
    query: String(query).trim(),
    uf: String(uf || '').toUpperCase().slice(0, 2),
    target: Math.max(1, Math.min(100, parseInt(target, 10) || 60)),
    log: ['Pedido criado no painel — aguardando o computador de geração (worker) pegar a fila…'],
  }).select('id').single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ jobId: data.id, queued: true, position: (fila || []).length + 1 });
};
