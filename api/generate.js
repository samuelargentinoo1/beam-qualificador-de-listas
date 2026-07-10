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

  // uma geração por vez (na fila ou rodando)
  const { data: abertos } = await db.from('jobs')
    .select('id,status').in('status', ['na_fila', 'rodando', 'cancelar']).limit(1);
  if (abertos && abertos.length) {
    return res.status(409).json({ error: 'Já existe uma geração na fila ou em andamento. Aguarde ou cancele.' });
  }

  const { data, error } = await db.from('jobs').insert({
    query: String(query).trim(),
    uf: String(uf || '').toUpperCase().slice(0, 2),
    target: Math.max(1, Math.min(100, parseInt(target, 10) || 60)),
    log: ['Pedido criado no painel — aguardando o computador de geração (worker) pegar a fila…'],
  }).select('id').single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ jobId: data.id, queued: true });
};
