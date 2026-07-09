'use strict';
// Servidor local da Ferramenta de Qualificação de Listas (Beam + Babuya).
// Rode:  npm start   →  http://localhost:3010

const express = require('express');
const path = require('path');
const fs = require('fs');
const { runJob, LISTS_PATH } = require('./lib/runner');
const ledgerLib = require('./lib/ledger');
const { readJson, titleCase } = require('./lib/util');

const app = express();
const PORT = process.env.PORT || 3010;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------- estado do job
let activeJob = null;
let lastJob = null;

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, stage: job.stage,
    query: job.query, segment: job.segment, city: job.city, uf: job.uf, target: job.target,
    counts: job.counts,
    log: job.log.slice(-80),
    startedAt: job.startedAt,
    result: job.result || null,
    error: job.error || null,
  };
}

// --------------------------------------------------------------- parse query
// "imobiliárias de são josé do rio preto" → segmento + cidade (1º " de "/" em ")
function parseQuery(q) {
  const m = String(q || '').trim().match(/^(.*?)\s+(?:de|em)\s+(.+)$/i);
  if (!m) return null;
  return { segment: m[1].trim(), city: m[2].trim() };
}

// -------------------------------------------------------------------- rotas
app.post('/api/generate', (req, res) => {
  if (activeJob && activeJob.status === 'rodando') {
    return res.status(409).json({ error: 'Já existe uma geração em andamento. Aguarde ou cancele.' });
  }
  const { query, segment, city, uf, target } = req.body || {};
  let seg = segment, cid = city;
  if ((!seg || !cid) && query) {
    const p = parseQuery(query);
    if (p) { seg = seg || p.segment; cid = cid || p.city; }
  }
  if (!seg || !cid) {
    return res.status(400).json({
      error: 'Não entendi o segmento e a cidade. Use o formato "imobiliárias de São José do Rio Preto" ou preencha os campos separados.',
    });
  }
  const tgt = Math.max(1, Math.min(100, parseInt(target, 10) || 60));

  const job = {
    id: 'job_' + Date.now(),
    status: 'rodando',
    stage: 'iniciando',
    query: query || `${seg} de ${cid}`,
    segment: seg, city: cid, uf: (uf || '').toUpperCase().slice(0, 2),
    target: tgt,
    counts: { capturados: 0, limpos: 0, qualificados: 0, descartados: 0, jaEntregues: 0 },
    log: [],
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

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Beam Qualificador de Listas' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✨ Beam — Qualificador de Listas rodando em  http://localhost:${PORT}\n`);
});
