'use strict';
// ============================================================
// WORKER — roda NO SEU COMPUTADOR e executa a fila da nuvem.
//   painel (Vercel) → fila no Supabase → este worker → motor local
// Rode com:  node worker.js   (o Iniciar Ferramenta.command já faz isso)
// Precisa de um arquivo .env com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- .env simples (sem dependência)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('⚠️  Worker parado: crie um arquivo .env com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (veja .env.example).');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const LOCAL = 'http://localhost:3010';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const stamp = () => new Date().toLocaleTimeString('pt-BR');

// ---------- garante o motor local no ar
async function localUp() {
  try { const r = await fetch(LOCAL + '/api/health'); return r.ok; } catch { return false; }
}
async function ensureLocal() {
  if (await localUp()) return true;
  console.log(`[${stamp()}] motor local parado — iniciando node server.js…`);
  const child = spawn('node', ['server.js'], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 15; i++) { await sleep(1000); if (await localUp()) return true; }
  return false;
}

// ---------- CSV parse (colunas com aspas)
function parseCsv(txt) {
  const lines = txt.replace(/^﻿/, '').split('\n').filter(Boolean);
  const parse = s => {
    const o = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { o.push(cur); cur = ''; }
      else cur += c;
    }
    o.push(cur); return o;
  };
  return lines.slice(1).map(parse);
}

// ---------- sincroniza resultado final pro Supabase
async function syncResult(job, entry) {
  await db.from('lists').upsert({
    id: entry.id, n: entry.n, date: entry.date, segment: entry.segment, city: entry.city,
    uf: entry.uf, key: entry.key, target: entry.target, delivered: entry.delivered,
    status: entry.status, totals: entry.totals,
  });
  const csvPath = entry.files && entry.files.final;
  if (csvPath && fs.existsSync(csvPath)) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    if (rows.length) {
      await db.from('leads').delete().eq('list_id', entry.id); // idempotente
      const leads = rows.map(r => ({
        list_id: entry.id, praca: entry.key,
        nome: r[0], cidade: r[1], estado: r[2], telefone: r[3], site: r[4],
        instagram_url: /^https?:/.test(r[5] || '') ? r[5] : '',
        instagram: (r[5] || '').match(/instagram\.com\/([A-Za-z0-9_.]+)/) ? '@' + r[5].match(/instagram\.com\/([A-Za-z0-9_.]+)/)[1] : (r[5] || ''),
        ig_status: r[6], socios: r[7], decisor: r[8], cnpj: r[9],
      }));
      for (let i = 0; i < leads.length; i += 200) {
        await db.from('leads').insert(leads.slice(i, i + 200));
      }
    }
  }
}

// ---------- executa 1 job da fila
async function runCloudJob(job) {
  console.log(`[${stamp()}] ▶ executando pedido da nuvem: "${job.query}" (meta ${job.target})`);
  await db.from('jobs').update({ status: 'rodando', started_at: now(), stage: 'iniciando' }).eq('id', job.id);

  if (!await ensureLocal()) {
    await db.from('jobs').update({ status: 'erro', error: 'motor local não subiu', finished_at: now() }).eq('id', job.id);
    return;
  }

  const kick = await fetch(LOCAL + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: job.query, uf: job.uf, target: job.target }),
  });
  if (!kick.ok) {
    const e = await kick.json().catch(() => ({}));
    await db.from('jobs').update({ status: 'erro', error: e.error || `motor local recusou (${kick.status})`, finished_at: now() }).eq('id', job.id);
    return;
  }

  // acompanha o motor local e espelha na nuvem
  while (true) {
    await sleep(2500);
    let local;
    try {
      local = (await (await fetch(LOCAL + '/api/job/active')).json()).job;
    } catch { continue; }
    if (!local) continue;

    // pedido de cancelamento vindo do painel?
    const { data: cloud } = await db.from('jobs').select('status').eq('id', job.id).single();
    if (cloud && cloud.status === 'cancelar') {
      await fetch(LOCAL + '/api/job/cancel', { method: 'POST' }).catch(() => {});
    }

    await db.from('jobs').update({
      stage: local.stage, counts: local.counts, log: (local.log || []).slice(-80),
    }).eq('id', job.id);

    if (['concluído', 'erro', 'cancelado'].includes(local.status)) {
      if (local.result) await syncResult(job, local.result);
      await db.from('jobs').update({
        status: local.status, result: local.result || null, error: local.error || null,
        finished_at: now(),
      }).eq('id', job.id);
      console.log(`[${stamp()}] ■ pedido finalizado: ${local.status} (${local.counts?.qualificados ?? 0} leads)`);
      return;
    }
  }
}

// ---------- loop principal
(async () => {
  console.log('⚡ Worker Beam ligado — vigiando a fila da nuvem (Ctrl+C para parar).');
  await ensureLocal();
  while (true) {
    try {
      const { data: fila } = await db.from('jobs')
        .select('*').eq('status', 'na_fila')
        .order('created_at', { ascending: true }).limit(1);
      if (fila && fila.length) await runCloudJob(fila[0]);
    } catch (e) {
      console.error(`[${stamp()}] erro no worker: ${e.message}`);
    }
    await sleep(5000);
  }
})();
