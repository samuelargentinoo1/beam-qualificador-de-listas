'use strict';
// EQUIPE — quem tem acesso ao painel (precisa estar logado).
//   GET  /api/usuarios → { usuarios: [...], pessoas: [...do Moskit], fonte }
//   POST /api/usuarios → cria/atualiza  { login, senha, nome, moskitUserId }
//                        ou liga/desliga { login, ativo: false }
const { guard } = require('../lib/cloud/supa');
const { listar, salvar, definirAtivo, todos } = require('../lib/cloud/usuarios');
const { cfg, listUsers } = require('../lib/moskit');

async function pessoasDoMoskit() {
  const c = cfg();
  if (!c) return [];
  try {
    return (await listUsers(c))
      .filter(u => u.active)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch { return []; }
}

module.exports = async (req, res) => {
  const auth = await guard(req, res);
  if (!auth) return;
  const { db, user } = auth;

  if (req.method !== 'POST') {
    const { tabelaOk } = await todos(db);
    return res.json({
      usuarios: await listar(db),
      pessoas: await pessoasDoMoskit(),
      onde: tabelaOk ? 'tabela do Supabase' : 'arquivo do servidor',
      eu: user.login,
    });
  }

  const { login, senha, nome, moskitUserId, ativo } = req.body || {};

  // ligar/desligar acesso
  if (typeof ativo === 'boolean' && !senha) {
    if (String(login).trim().toLowerCase() === user.login && ativo === false) {
      return res.status(400).json({ error: 'Você não pode desativar o seu próprio acesso.' });
    }
    const r = await definirAtivo(db, login, ativo);
    if (r.erro) return res.status(400).json({ error: r.erro });
    return res.json({ ok: true, usuarios: await listar(db) });
  }

  const r = await salvar(db, { login, senha, nome, moskit_user_id: moskitUserId, ativo: true });
  if (r.erro) return res.status(400).json({ error: r.erro });
  res.json({ ok: true, fonte: r.fonte, usuarios: await listar(db) });
};
