'use strict';
// ============================================================
// REGISTRO DE USUÁRIOS DO PAINEL — quem pode entrar e qual é o id
// da pessoa no Moskit (é ele que define de quem são os leads da lista).
//
// Duas fontes, nesta ordem de prioridade:
//   1) tabela `usuarios` no Supabase — jeito definitivo, gerenciado por SQL
//   2) variável PAINEL_USUARIOS no .env do servidor — funciona SEM criar tabela
//
// Por que as duas: criar a tabela exige o SQL Editor do Supabase (a chave
// service_role não cria tabela). A fonte 2 garante que a equipe tenha acesso
// enquanto isso não acontece. Assim que a tabela existir, ela passa a mandar
// sozinha — sem trocar código nem redeploy.
//
// Formato do PAINEL_USUARIOS (vários usuários separados por vírgula ou linha):
//   login:senha:Nome Exibido:idNoMoskit
//   ex.: julia:SENHA-DELA:Julia:155073,samuel:SENHA-DELE:Samuel:113717
// A senha não pode conter ":" nem "," (o resto é livre).
// ============================================================

/** Lê os usuários do .env do servidor. Retorna Map(login → usuário). */
function lerConfig() {
  const out = new Map();
  for (const parte of String(process.env.PAINEL_USUARIOS || '').split(/[,\n]/)) {
    const linha = parte.trim();
    if (!linha) continue;
    const [login, senha, nome, moskit] = linha.split(':').map(s => (s || '').trim());
    if (!login || !senha) continue;
    out.set(login.toLowerCase(), {
      login: login.toLowerCase(),
      senha,
      nome: nome || login,
      moskit_user_id: parseInt(moskit, 10) || null,
      ativo: true,
    });
  }
  return out;
}

const semTabela = e =>
  e.code === 'PGRST205' || e.code === '42P01' || /usuarios/i.test(e.message || '');

/** Busca na tabela do Supabase. { tabelaOk, user } — tabelaOk=false = tabela ainda não existe. */
async function daTabela(db, login) {
  const { data, error } = await db.from('usuarios')
    .select('login, senha, nome, moskit_user_id, ativo').eq('login', login).maybeSingle();
  if (error) {
    if (semTabela(error)) return { tabelaOk: false, user: null };
    throw new Error(error.message);
  }
  return { tabelaOk: true, user: data || null };
}

/**
 * Procura um login nas duas fontes (tabela primeiro).
 * Retorna { user, fonte, tabelaOk, temConfig } — user com a senha, pra quem chamou conferir.
 */
async function encontrar(db, login) {
  const alvo = String(login || '').trim().toLowerCase();
  const { tabelaOk, user } = await daTabela(db, alvo);
  if (user) return { user, fonte: 'tabela', tabelaOk, temConfig: lerConfig().size > 0 };

  const config = lerConfig();
  return { user: config.get(alvo) || null, fonte: 'config', tabelaOk, temConfig: config.size > 0 };
}

/** Resumo pra mensagem de subida do painel: quantos há em cada fonte. */
async function resumo(db) {
  const config = lerConfig();
  let naTabela = null; // null = tabela ainda não existe
  try {
    const { data, error } = await db.from('usuarios').select('login').eq('ativo', true).limit(500);
    if (error) { if (!semTabela(error)) throw new Error(error.message); }
    else naTabela = (data || []).length;
  } catch { /* mantém null */ }
  return { naTabela, naConfig: config.size, logins: [...config.keys()] };
}

module.exports = { encontrar, resumo, lerConfig };
