'use strict';
// Lista os usuários da conta Moskit (id + nome) — é o id que vai na coluna
// moskit_user_id da tabela `usuarios` do Supabase (login individual do painel).
// Uso:  node scripts/moskit-usuarios.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// .env
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { cfg, listUsers } = require('../lib/moskit');

(async () => {
  const c = cfg();
  if (!c) { console.error('MOSKIT_API_KEY não está no .env'); process.exit(1); }
  const users = (await listUsers(c)).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  console.log('\nUsuários da conta Moskit (id · nome · situação):\n');
  for (const u of users) {
    console.log(`  ${String(u.id).padEnd(8)} ${String(u.name).padEnd(28)} ${u.active ? 'ativo' : 'INATIVO'}`);
  }
  console.log(`\nResponsável padrão no .env (MOSKIT_RESPONSIBLE_ID): ${c.defaultUserId} — só é usado quando o pedido não tem usuário logado.`);
  console.log('\nPra dar acesso a alguém no painel, no SQL Editor do Supabase:');
  console.log("  insert into usuarios (login, senha, nome, moskit_user_id) values ('julia', 'SENHA-AQUI', 'Julia', 155073);");
  console.log('Alguém saiu do time:');
  console.log("  update usuarios set ativo = false where login = 'fulano';\n");
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
