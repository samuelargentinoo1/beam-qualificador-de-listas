'use strict';
// Cliente Supabase + guarda de acesso das APIs do painel (login individual).

const { createClient } = require('@supabase/supabase-js');
const { encontrar } = require('./usuarios');

function supa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Autoriza a requisição pelo LOGIN INDIVIDUAL (cabeçalhos x-app-user + x-app-pass).
 * Cada pessoa tem o seu — é assim que a ferramenta sabe quem pediu a lista e põe
 * os leads no Moskit com essa pessoa como responsável.
 * Os usuários vêm de lib/cloud/usuarios.js (tabela do Supabase, arquivo ou .env).
 *
 * Retorna { db, user } se ok; senão já responde o erro e retorna null.
 * Quando NÃO existe nenhum usuário, responde 409 { setup: true } — o painel
 * mostra a tela de primeiro acesso em vez de acusar senha errada.
 */
async function guard(req, res) {
  const db = supa();
  if (!db) { needDb(res); return null; }

  const login = String(req.headers['x-app-user'] || '').trim().toLowerCase();
  const senha = String(req.headers['x-app-pass'] || '').trim();

  let achado;
  try {
    achado = await encontrar(db, login);
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 200) });
    return null;
  }

  if (!achado.temAlgum) {
    res.status(409).json({ setup: true, error: 'O painel ainda não tem nenhum acesso criado.' });
    return null;
  }
  if (!login || !senha) {
    res.status(401).json({ error: 'Entre com o seu usuário e senha.' });
    return null;
  }

  const user = achado.user;
  if (!user || String(user.senha) !== senha) {
    res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    return null;
  }
  if (user.ativo === false) {
    res.status(401).json({ error: `O acesso de ${user.nome} está desativado. Fale com o administrador.` });
    return null;
  }

  const { senha: _s, ...semSenha } = user; // a senha não sai daqui
  return { db, user: semSenha };
}

function needDb(res) {
  res.status(503).json({ error: 'Supabase não configurado — confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do painel.' });
}

module.exports = { supa, guard, needDb };
