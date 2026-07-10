'use strict';
// GET /api/lists/:id/file/:kind — baixa o CSV (final | pipedrive) gerado do banco.
const { supa, guard, needDb } = require('../../../../lib/cloud/supa');
const { finalCsv, pipedriveCsv } = require('../../../../lib/cloud/csv');
const { createHash } = require('crypto');

module.exports = async (req, res) => {
  // o navegador não manda header em cliques de link → aceita ?pass= também
  if (req.query.pass) req.headers['x-app-pass'] = String(req.query.pass);
  if (!guard(req, res)) return;
  const db = supa();
  if (!db) return needDb(res);

  const { id, kind } = req.query;
  const { data: list } = await db.from('lists').select('*').eq('id', id).maybeSingle();
  if (!list) return res.status(404).json({ error: 'Lista não encontrada' });

  const { data: leads, error } = await db.from('leads')
    .select('*').eq('list_id', id).order('id', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  let csv, name;
  const slugBase = `${String(list.segment || 'lista').toLowerCase()}-${String(list.city || '').toLowerCase()}`
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
  if (kind === 'pipedrive') {
    csv = pipedriveCsv(leads || []);
    name = `#${list.n}-pipedrive-import-${slugBase}.csv`;
  } else {
    csv = finalCsv(leads || []);
    name = `#${list.n}-lista-final-de-prospeccao-${slugBase}.csv`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('ETag', createHash('md5').update(csv).digest('hex'));
  res.send(csv);
};
