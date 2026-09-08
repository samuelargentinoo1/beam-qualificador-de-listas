'use strict';
// ============================================================
// PAINEL NO VPS — substitui a Vercel.
//   Serve o front (public/) e as MESMAS APIs de nuvem (api/*),
//   que continuam falando com o Supabase. O worker não muda.
// Rode com:  node painel.js   (no VPS: container "painel" do compose)
// Precisa no .env: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
// O login é INDIVIDUAL (tabela `usuarios` no Supabase — veja supabase-schema.sql):
// é assim que cada lista sabe quem pediu e os leads vão pra essa pessoa no Moskit.
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

app.all('/api/setup', wrap(require('./api/setup')));
app.all('/api/usuarios', wrap(require('./api/usuarios')));
app.all('/api/me', wrap(require('./api/me')));
app.all('/api/generate', wrap(require('./api/generate')));
app.all('/api/job/active', wrap(require('./api/job/active')));
app.all('/api/job/cancel', wrap(require('./api/job/cancel')));
app.all('/api/lists', wrap(require('./api/lists/index')));
app.all('/api/lists/:id/file/:kind', wrap(require('./api/lists/[id]/file/[kind]')));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PAINEL_PORT || 8010);
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🖥  Painel Beam no ar: http://0.0.0.0:${PORT} (APIs de nuvem + front)`);
  // quem pode entrar: tabela `usuarios` do Supabase e/ou PAINEL_USUARIOS do .env
  const { supa } = require('./lib/cloud/supa');
  const { resumo } = require('./lib/cloud/usuarios');
  const db = supa();
  if (!db) {
    console.warn('⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não definidos no .env — as APIs vão responder 503.');
    return;
  }
  const r = await resumo(db);
  const f = r.fontes;
  if (!r.total) {
    console.log('🔧 Nenhum acesso criado ainda — o painel vai abrir na tela de PRIMEIRO ACESSO.');
    console.log(`   ${process.env.APP_PASSWORD ? 'A chave de instalação é a senha antiga do painel (APP_PASSWORD).' : '⚠️  Sem APP_PASSWORD no .env: a tela de primeiro acesso fica aberta a quem tiver o link.'}`);
  } else {
    console.log(`👤 ${r.total} acesso(s): ${r.logins.join(', ')}`);
    console.log(`   onde: tabela=${f.tabela} · arquivo=${f.arquivo} · .env=${f.config} ` +
                `(a tabela do Supabase manda quando existe)`);
    console.log('   os leads de cada lista vão pro Moskit no nome de quem pediu.');
  }
});
