'use strict';
// Cliente Supabase + guarda de acesso das APIs do painel (login individual).

const { createClient } = require('@supabase/supabase-js');

function supa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Autoriza a requisição pelo LOGIN INDIVIDUAL (cabeçalhos x-app-user + x-app-pass),
 * conferido na tabela `usuarios` do Supabase. Cada SDR tem o seu — é assim que a
 * ferramenta sabe quem pediu a lista e põe os leads no Moskit com essa pessoa
 * como responsável.
 *
 * Retorna { db, user } se ok; senão já responde o erro e retorna null.
 * Sem Supabase configurado → bloqueia (padrão seguro: os leads são dados pessoais).
 */
async function guard(req, res) {
  const db = supa();
  if (!db) { needDb(res); return null; }

  const login = String(req.headers['x-app-user'] || '').trim().toLowerCase();
  const senha = String(req.headers['x-app-pass'] || '').trim();
  if (!login || !senha) {
    res.status(401).json({ error: 'Entre com o seu usuário e senha.' });
    return null;
  }

  const { data: user, error } = await db.from('usuarios')
    .select('login, senha, nome, moskit_user_id, ativo').eq('login', login).maybeSingle();
  if (error) {
    // tabela ainda não criada → instrução clara em vez do erro cru do PostgREST
    if (error.code === '42P01' || error.code === 'PGRST205' || /usuarios/i.test(error.message)) {
      res.status(503).json({
        error: 'O banco ainda não tem a tabela de usuários. Rode o arquivo supabase-schema.sql ' +
               'no SQL Editor do Supabase e cadastre os SDRs (veja o Readme).',
      });
    } else {
      res.status(500).json({ error: error.message });
    }
    return null;
  }
  if (!user || String(user.senha) !== senha) {
    res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    return null;
  }
  if (user.ativo === false) {
    res.status(401).json({ error: `O acesso de ${user.nome} está desativado. Fale com o Samuel.` });
    return null;
  }
  const { senha: _senha, ...semSenha } = user; // a senha não sai daqui
  return { db, user: semSenha };
}

function needDb(res) {
  res.status(503).json({ error: 'Supabase não configurado — confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do painel.' });
}

module.exports = { supa, guard, needDb };
