'use strict';
// ============================================================
// PAINEL NO VPS — substitui a Vercel.
//   Serve o front (public/) e as MESMAS APIs de nuvem (api/*),
//   que continuam falando com o Supabase. O worker não muda.
// Rode com:  node painel.js   (no VPS: container "painel" do compose)
// Precisa no .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e APP_PASSWORD.
// ============================================================

const path = require('path');
const fs = require('fs');
const express = require('express');

// ---------- .env simples (mesmo esquema do worker.js, sem dependência)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = express();
app.use(express.json({ limit: '10mb' })); // planilha do Big Data pode ter milhares de linhas

// Os handlers em api/ são no formato da Vercel: (req, res) com os parâmetros de
// rota em req.query. O Express põe em req.params — este adaptador junta os dois.
const wrap = handler => (req, res) => {
  req.query = { ...req.query, ...req.params };
  Promise.resolve(handler(req, res)).catch(e => {
    if (!res.headersSent) res.status(500).json({ error: String(e && e.message).slice(0, 200) });
  });
};

app.all('/api/generate', wrap(require('./api/generate')));
app.all('/api/job/active', wrap(require('./api/job/active')));
app.all('/api/job/cancel', wrap(require('./api/job/cancel')));
app.all('/api/lists', wrap(require('./api/lists/index')));
app.all('/api/lists/:id/file/:kind', wrap(require('./api/lists/[id]/file/[kind]')));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PAINEL_PORT || 8010);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🖥  Painel Beam no ar: http://0.0.0.0:${PORT} (APIs de nuvem + front)`);
  if (!process.env.APP_PASSWORD) {
    console.warn('⚠️  APP_PASSWORD não definida no .env — as APIs vão responder 503 até configurar.');
  }
});
