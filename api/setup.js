'use strict';
// PRIMEIRO ACESSO — cria o acesso inicial do painel pela própria tela, sem SQL
// e sem mexer no servidor.
//
//   GET  /api/setup  → { precisaConfigurar, exigeChave, pessoas: [...] }
//   POST /api/setup  → { chave, login, senha, nome, moskitUserId }
//
// Só funciona enquanto NÃO existe nenhum usuário. Depois disso, novas pessoas
// entram pela aba Equipe (com alguém logado) e este endereço passa a recusar.
// A "chave" é a senha antiga do painel (APP_PASSWORD), que já está no servidor:
// serve pra ninguém de fora criar o primeiro acesso antes de você.
const { supa, needDb } = require('../lib/cloud/supa');
const { precisaConfigurar, salvar } = require('../lib/cloud/usuarios');
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
  const db = supa();
  if (!db) return needDb(res);

  let precisa;
  try { precisa = await precisaConfigurar(db); }
  catch (e) { return res.status(500).json({ error: String(e.message).slice(0, 200) }); }

  const exigeChave = !!process.env.APP_PASSWORD;

  if (req.method !== 'POST') {
    // por padrão responde na hora; a lista do Moskit (lenta) só quando pedida,
    // pra tela de primeiro acesso aparecer sem espera
    const querPessoas = String(req.query.pessoas || '') === '1';
    return res.json({
      precisaConfigurar: precisa,
      exigeChave,
      pessoas: querPessoas && precisa ? await pessoasDoMoskit() : [],
    });
  }

  if (!precisa) {
    return res.status(409).json({ error: 'O painel já tem acesso criado. Entre e use a aba Equipe para adicionar pessoas.' });
  }

  const { chave, login, senha, nome, moskitUserId } = req.body || {};
  if (exigeChave && String(chave || '').trim() !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Chave de instalação incorreta. É a senha que o painel usava antes.' });
  }

  const r = await salvar(db, { login, senha, nome, moskit_user_id: moskitUserId, ativo: true });
  if (r.erro) return res.status(400).json({ error: r.erro });

  res.json({ ok: true, fonte: r.fonte, login: String(login).trim().toLowerCase() });
};
