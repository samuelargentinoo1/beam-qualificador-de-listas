'use strict';
// GET /api/job/active — job em aberto (na fila/rodando) ou o último finalizado.
const { supa, guard, needDb } = require('../../lib/cloud/supa');

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  // prioridade de exibição: RODANDO > próximo da fila (mais antigo) > último finalizado
  let { data: job } = await db.from('jobs')
    .select('*').in('status', ['rodando', 'cancelar'])
    .order('created_at', { ascending: true }).limit(1).maybeSingle();

  if (!job) {
    const r = await db.from('jobs')
      .select('*').eq('status', 'na_fila')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    job = r.data;
  }
  if (!job) {
    const r = await db.from('jobs')
      .select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
    job = r.data;
  }
  if (!job) return res.json({ job: null });

  const { count: naFila } = await db.from('jobs')
    .select('id', { count: 'exact', head: true }).eq('status', 'na_fila');

  res.json({
    job: {
      id: job.id,
      status: job.status === 'cancelar' ? 'rodando' : job.status,
      stage: job.stage || (job.status === 'na_fila' ? 'na fila' : ''),
      query: job.query,
      uf: job.uf,
      target: job.target,
      counts: job.counts || {},
      log: job.log || [],
      startedAt: job.started_at,
      // no painel da nuvem só existem os downloads gerados do banco (Final + Pipedrive)
      result: job.result ? { ...job.result, files: { final: true, pipedrive: true } } : null,
      error: job.error || null,
      queued: job.status === 'na_fila',
      queueCount: naFila || 0,
    },
  });
};
