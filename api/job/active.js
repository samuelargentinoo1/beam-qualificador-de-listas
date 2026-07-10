'use strict';
// GET /api/job/active — job em aberto (na fila/rodando) ou o último finalizado.
const { supa, guard, needDb } = require('../../lib/cloud/supa');

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  let { data: job } = await db.from('jobs')
    .select('*').in('status', ['na_fila', 'rodando', 'cancelar'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  if (!job) {
    const r = await db.from('jobs')
      .select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
    job = r.data;
  }
  if (!job) return res.json({ job: null });

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
      result: job.result || null,
      error: job.error || null,
      queued: job.status === 'na_fila',
    },
  });
};
