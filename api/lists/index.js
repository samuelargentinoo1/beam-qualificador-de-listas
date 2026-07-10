'use strict';
// GET /api/lists — histórico de listas + total entregue por praça.
const { supa, guard, needDb } = require('../../lib/cloud/supa');

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  const { data: lists, error } = await db.from('lists')
    .select('*').order('n', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const { data: pracas } = await db.from('leads').select('praca');
  const deliveredByKey = {};
  for (const p of pracas || []) deliveredByKey[p.praca] = (deliveredByKey[p.praca] || 0) + 1;

  // no painel da nuvem só há download de Final e Pipedrive (gerados do banco)
  res.json({
    lists: (lists || []).map(l => ({ ...l, files: { final: true, pipedrive: true } })),
    deliveredByKey,
  });
};
