-- ============================================================
-- Beam — Qualificador de Listas · Schema do Supabase
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique RUN.
-- ============================================================

-- Fila de gerações (o painel na Vercel cria; o worker no Mac executa)
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'na_fila',  -- na_fila | rodando | concluído | erro | cancelar | cancelado
  query text,
  uf text,
  target int default 60,
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
  target int,
  delivered int,
  status text,
  totals jsonb
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

-- Segurança: RLS ligado SEM políticas públicas.
-- Só a service_role (usada pelas APIs da Vercel e pelo worker) acessa.
alter table jobs  enable row level security;
alter table lists enable row level security;
alter table leads enable row level security;
