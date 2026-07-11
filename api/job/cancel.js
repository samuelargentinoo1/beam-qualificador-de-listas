'use strict';
// POST /api/job/cancel — pede cancelamento (na fila: cancela direto; rodando: worker cancela).
const { supa, guard, needDb } = require('../../lib/cloud/supa');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  // rodando → sinaliza pro worker cancelar (a fila continua intacta)
  const { data: rodando } = await db.from('jobs')
    .update({ status: 'cancelar' }).eq('status', 'rodando').select('id');
  if (rodando && rodando.length) return res.json({ ok: true, cancelled: 'pedido enviado ao worker' });

  // nada rodando → cancela só o PRÓXIMO da fila (o exibido na tela)
  const { data: prox } = await db.from('jobs')
    .select('id').eq('status', 'na_fila')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (prox) {
    await db.from('jobs')
      .update({ status: 'cancelado', finished_at: new Date().toISOString() })
      .eq('id', prox.id);
    return res.json({ ok: true, cancelled: 'na_fila' });
  }

  res.status(404).json({ error: 'Nenhuma geração em aberto.' });
};
