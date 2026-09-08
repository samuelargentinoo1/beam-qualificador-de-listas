-- ============================================================
-- Beam — Qualificador de Listas · Schema do Supabase
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique RUN.
-- Rodar de novo não faz mal (tudo é "if not exists").
-- ============================================================

-- Usuários do painel — LOGIN INDIVIDUAL de cada SDR.
-- É por aqui que a ferramenta sabe QUEM pediu a lista e põe os leads
-- no Moskit com essa pessoa como responsável.
create table if not exists usuarios (
  login text primary key,                -- minúsculo, sem espaço: "julia"
  senha text not null,
  nome text not null,                    -- como aparece no painel: "Julia"
  moskit_user_id int not null,           -- id do usuário no Moskit (node scripts/moskit-usuarios.js lista todos)
  ativo boolean not null default true,   -- false = pessoa saiu do time (não entra mais)
  created_at timestamptz default now()
);

-- Exemplo de cadastro (troque a senha):
--   insert into usuarios (login, senha, nome, moskit_user_id) values ('julia', 'SENHA-AQUI', 'Julia', 155073);
-- Alguém saiu do time:
--   update usuarios set ativo = false where login = 'fulano';

-- Fila de gerações (o painel cria; o worker executa)
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'na_fila',  -- na_fila | rodando | concluído | erro | cancelar | cancelado
  query text,
  uf text,
  origem text default 'maps',              -- maps | planilha
  rows jsonb,                              -- modo planilha: [{ name, cnpj, cnpjDigits }]
  target int default 60,
  usuario text,                            -- login de quem pediu
  usuario_nome text,                       -- nome de quem pediu (pra exibir)
  moskit_user_id int,                      -- responsável dos leads no Moskit (= quem pediu)
  stage text,
  counts jsonb default '{}'::jsonb,
  log jsonb default '[]'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Histórico de listas geradas
create table if not exists lists (
  id text primary key,
  n int,
  date timestamptz,
  segment text,
  city text,
  uf text,
  key text,          -- praça: "imobiliarias__ponta-grossa"
  origem text default 'maps',
  target int,
  delivered int,
  status text,
  totals jsonb,
  usuario text,      -- login de quem pediu
  usuario_nome text  -- nome de quem pediu
);

-- Leads qualificados (dados cruzados) — 1 linha por lead entregue
create table if not exists leads (
  id bigint generated always as identity primary key,
  list_id text references lists(id) on delete cascade,
  praca text,
  nome text,
  cidade text,
  estado text,
  telefone text,
  site text,
  instagram text,        -- @handle
  instagram_url text,    -- link completo
  ig_status text,
  socios text,
  decisor text,
  cnpj text,
  created_at timestamptz default now()
);
create index if not exists leads_list_idx on leads(list_id);
create index if not exists leads_praca_idx on leads(praca);

-- ------------------------------------------------------------
-- MIGRAÇÃO — para bancos criados antes do modo planilha e do login individual.
-- O "create table if not exists" acima não altera tabela que já existe,
-- então estas linhas garantem as colunas novas. Rodar de novo não faz mal.
-- ------------------------------------------------------------
alter table jobs  add column if not exists origem text default 'maps';
alter table jobs  add column if not exists rows jsonb;
alter table jobs  add column if not exists usuario text;
alter table jobs  add column if not exists usuario_nome text;
alter table jobs  add column if not exists moskit_user_id int;
alter table lists add column if not exists origem text default 'maps';
alter table lists add column if not exists usuario text;
alter table lists add column if not exists usuario_nome text;

-- Segurança: RLS ligado SEM políticas públicas.
-- Só a service_role (usada pelas APIs do painel e pelo worker) acessa.
alter table usuarios enable row level security;
alter table jobs     enable row level security;
alter table lists    enable row level security;
alter table leads    enable row level security;
