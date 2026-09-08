'use strict';
// ============================================================
// REGISTRO DE USUÁRIOS DO PAINEL — quem entra e qual é o id da pessoa no
// Moskit (é ele que decide de quem são os leads da lista).
//
// TRÊS fontes, nesta ordem de prioridade:
//   1) tabela `usuarios` no Supabase — quando existir, é a fonte oficial
//   2) arquivo data/usuarios.json    — criado pelo próprio painel (1º acesso)
//   3) PAINEL_USUARIOS no .env       — login:senha:Nome:idNoMoskit, separados por vírgula
//
// Por que três: criar a TABELA exige o SQL Editor do Supabase (a chave
// service_role não cria tabela). O arquivo permite que a equipe monte os acessos
// sozinha pela tela do painel, sem SQL e sem mexer no servidor. Se um dia a
// tabela for criada, ela passa a mandar — sem trocar código.
// ============================================================

const fs = require('fs');
const path = require('path');

// Onde os acessos criados pela tela ficam salvos. Dá pra apontar pra outro
// lugar com PAINEL_USUARIOS_ARQUIVO (usado pelos testes e por quem quiser
// guardar isso fora da pasta data/).
const ARQUIVO = process.env.PAINEL_USUARIOS_ARQUIVO ||
  path.join(__dirname, '..', '..', 'data', 'usuarios.json');

const normLogin = s => String(s || '').trim().toLowerCase();

function limpo(u) {
  return {
    login: normLogin(u.login),
    senha: String(u.senha || ''),
    nome: String(u.nome || u.login || '').trim(),
    moskit_user_id: parseInt(u.moskit_user_id ?? u.moskitUserId, 10) || null,
    ativo: u.ativo !== false,
  };
}

// ---------------------------------------------------------------- fonte: .env
function lerConfig() {
  const out = new Map();
  for (const parte of String(process.env.PAINEL_USUARIOS || '').split(/[,\n]/)) {
    const linha = parte.trim();
    if (!linha) continue;
    const [login, senha, nome, moskit] = linha.split(':').map(s => (s || '').trim());
    if (!login || !senha) continue;
    out.set(normLogin(login), limpo({ login, senha, nome, moskit_user_id: moskit }));
  }
  return out;
}

// ------------------------------------------------------------- fonte: arquivo
function lerArquivo() {
  const out = new Map();
  try {
    const dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    for (const u of Array.isArray(dados) ? dados : dados.usuarios || []) {
      if (u && u.login && u.senha) out.set(normLogin(u.login), limpo(u));
    }
  } catch { /* não existe ainda, ou está corrompido: trata como vazio */ }
  return out;
}

function salvarArquivo(mapa) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  const lista = [...mapa.values()];
  // grava por cima de um temporário: nunca deixa o arquivo pela metade
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ usuarios: lista }, null, 2));
  fs.renameSync(tmp, ARQUIVO);
}

// ------------------------------------------------------------- fonte: tabela
const semTabela = e =>
  e.code === 'PGRST205' || e.code === '42P01' || /usuarios/i.test(e.message || '');

/** { tabelaOk, usuarios: Map } — tabelaOk=false = a tabela ainda não existe. */
async function daTabela(db) {
  if (!db) return { tabelaOk: false, usuarios: new Map() };
  const { data, error } = await db.from('usuarios')
    .select('login, senha, nome, moskit_user_id, ativo');
  if (error) {
    if (semTabela(error)) return { tabelaOk: false, usuarios: new Map() };
    throw new Error(error.message);
  }
  const m = new Map();
  for (const u of data || []) m.set(normLogin(u.login), limpo(u));
  return { tabelaOk: true, usuarios: m };
}

// ------------------------------------------------------------------ leitura
/**
 * Junta as três fontes (a de MAIOR prioridade vence em caso de login repetido).
 * Retorna { usuarios: Map, tabelaOk, fontes: { tabela, arquivo, config } }.
 */
async function todos(db) {
  const { tabelaOk, usuarios: tabela } = await daTabela(db);
  const arquivo = lerArquivo();
  const config = lerConfig();

  const juntos = new Map();
  for (const [k, v] of config) juntos.set(k, { ...v, fonte: 'config' });
  for (const [k, v] of arquivo) juntos.set(k, { ...v, fonte: 'arquivo' });
  for (const [k, v] of tabela) juntos.set(k, { ...v, fonte: 'tabela' });

  return {
    usuarios: juntos, tabelaOk,
    fontes: { tabela: tabela.size, arquivo: arquivo.size, config: config.size },
  };
}

/** Procura um login. { user (com senha), tabelaOk, temAlgum }. */
async function encontrar(db, login) {
  const { usuarios, tabelaOk } = await todos(db);
  return { user: usuarios.get(normLogin(login)) || null, tabelaOk, temAlgum: usuarios.size > 0 };
}

/** Lista pra tela de equipe (sem senha). */
async function listar(db) {
  const { usuarios } = await todos(db);
  return [...usuarios.values()]
    .map(({ senha, ...resto }) => resto)
    .sort((a, b) => a.login.localeCompare(b.login));
}

/** Ninguém cadastrado em lugar nenhum? (dispara a tela de primeiro acesso) */
async function precisaConfigurar(db) {
  const { usuarios } = await todos(db);
  return usuarios.size === 0;
}

// ------------------------------------------------------------------ escrita
/**
 * Cria/atualiza um usuário. Grava na TABELA quando ela existe; senão, no arquivo.
 * Retorna { ok, fonte } ou { erro }.
 */
async function salvar(db, dados) {
  const u = limpo(dados);
  if (!u.login || !/^[a-z0-9._-]{2,30}$/.test(u.login)) {
    return { erro: 'O usuário deve ter de 2 a 30 letras/números, sem espaço nem acento (ex.: julia).' };
  }
  if (!u.senha || u.senha.length < 4) return { erro: 'A senha precisa de pelo menos 4 caracteres.' };
  if (/[:,]/.test(u.senha)) return { erro: 'A senha não pode ter ":" nem "," .' };
  if (!u.nome) return { erro: 'Escreva o nome que aparece no painel.' };
  if (!u.moskit_user_id) return { erro: 'Escolha a pessoa no Moskit — é ela que recebe os leads.' };

  const { tabelaOk } = await daTabela(db);
  if (tabelaOk) {
    const { error } = await db.from('usuarios').upsert({
      login: u.login, senha: u.senha, nome: u.nome,
      moskit_user_id: u.moskit_user_id, ativo: u.ativo,
    });
    if (error) return { erro: error.message };
    return { ok: true, fonte: 'tabela' };
  }

  const mapa = lerArquivo();
  mapa.set(u.login, u);
  try { salvarArquivo(mapa); } catch (e) { return { erro: 'Não consegui gravar os usuários: ' + e.message }; }
  return { ok: true, fonte: 'arquivo' };
}

/** Liga/desliga o acesso de alguém (quem sai do time). */
async function definirAtivo(db, login, ativo) {
  const alvo = normLogin(login);
  const { tabelaOk, usuarios: tabela } = await daTabela(db);
  if (tabelaOk && tabela.has(alvo)) {
    const { error } = await db.from('usuarios').update({ ativo: !!ativo }).eq('login', alvo);
    return error ? { erro: error.message } : { ok: true, fonte: 'tabela' };
  }
  const mapa = lerArquivo();
  const u = mapa.get(alvo);
  if (!u) return { erro: `"${login}" não está no arquivo de usuários (veio do .env? mude por lá).` };
  u.ativo = !!ativo;
  mapa.set(alvo, u);
  try { salvarArquivo(mapa); } catch (e) { return { erro: 'Não consegui gravar: ' + e.message }; }
  return { ok: true, fonte: 'arquivo' };
}

/** Resumo pra mensagem de subida do painel. */
async function resumo(db) {
  try {
    const { usuarios, tabelaOk, fontes } = await todos(db);
    return { total: usuarios.size, tabelaOk, fontes, logins: [...usuarios.keys()] };
  } catch (e) {
    return { total: 0, tabelaOk: false, fontes: { tabela: 0, arquivo: 0, config: 0 }, logins: [], erro: e.message };
  }
}

module.exports = {
  encontrar, listar, salvar, definirAtivo, precisaConfigurar, resumo, todos,
  ARQUIVO,
};
