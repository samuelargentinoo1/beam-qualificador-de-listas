'use strict';
// Cliente Supabase + guarda de acesso das APIs na nuvem (Vercel).

const { createClient } = require('@supabase/supabase-js');

function supa() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Autoriza a requisição pelo cabeçalho x-app-pass (senha única do painel).
 * Retorna true se ok; senão já responde o erro e retorna false.
 * Sem APP_PASSWORD configurada → bloqueia (padrão seguro: os leads são dados pessoais).
 */
function guard(req, res) {
  const senha = process.env.APP_PASSWORD;
  if (!senha) {
    res.status(503).json({ error: 'Configure a variável APP_PASSWORD no projeto da Vercel (Settings → Environment Variables) e redeploye.' });
    return false;
  }
  if ((req.headers['x-app-pass'] || '') !== senha) {
    res.status(401).json({ error: 'Senha do painel incorreta.' });
    return false;
  }
  return true;
}

function needDb(res) {
  res.status(503).json({ error: 'Supabase não configurado — confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis da Vercel.' });
}

module.exports = { supa, guard, needDb };
