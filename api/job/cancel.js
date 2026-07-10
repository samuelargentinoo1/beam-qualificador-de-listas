'use strict';
// POST /api/job/cancel — pede cancelamento (na fila: cancela direto; rodando: worker cancela).
const { supa, guard, needDb } = require('../../lib/cloud/supa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  // na fila → cancela na hora
  const { data: fila } = await db.from('jobs')
    .update({ status: 'cancelado', finished_at: new Date().toISOString(), error: null })
    .eq('status', 'na_fila').select('id');
  if (fila && fila.length) return res.json({ ok: true, cancelled: 'na_fila' });

  // rodando → sinaliza pro worker cancelar
  const { data: rodando } = await db.from('jobs')
    .update({ status: 'cancelar' }).eq('status', 'rodando').select('id');
  if (rodando && rodando.length) return res.json({ ok: true, cancelled: 'pedido enviado ao worker' });

  res.status(404).json({ error: 'Nenhuma geração em aberto.' });
};
