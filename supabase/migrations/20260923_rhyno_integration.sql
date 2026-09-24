-- ─────────────────────────────────────────────────────────────────────────────
-- Hunter do Xand — tabelas da integração com a Rhyno (Supabase / Postgres)
-- Idempotente: pode rodar mais de uma vez (SQL Editor do Supabase ou `supabase db push`).
-- Tabelas que já existirem não são alteradas.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Admins (login = Supabase Auth; só quem está aqui grava) ──
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- is_admin(): criada só se o projeto ainda não tiver a sua.
do $do$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin' and n.nspname = 'public'
  ) then
    execute $fn$
      create function public.is_admin() returns boolean
      language sql stable security definer set search_path = public as
      $body$ select exists (select 1 from public.admins where user_id = auth.uid()) $body$;
    $fn$;
  end if;
end
$do$;
grant execute on function public.is_admin() to anon, authenticated;

-- ── Estado da rinha (público para leitura) ──
create table if not exists public.rinha_state (
  id         int primary key,
  open       boolean not null default false,
  bonus      numeric,
  updated_at timestamptz not null default now()
);
insert into public.rinha_state (id, open, bonus) values (1, false, 5) on conflict (id) do nothing;

-- ── Fila (Rhyno + manual). id = id da entrada na Rhyno (não duplica) ou uuid gerado no painel ──
create table if not exists public.queue (
  id              text primary key,
  nick            text not null,
  slot            text,
  prov            text,
  source          text not null default 'MANUAL',   -- 'RHYNO' | 'MANUAL'
  external_id     text,                             -- id da entrada na Rhyno
  valor           numeric,
  bonus           numeric,
  platform        text,
  quantity        int not null default 1,
  participated_at bigint,
  "time"          text,
  ts              bigint,
  added_by_admin  boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists queue_external_id_idx on public.queue (external_id);
create index if not exists queue_ts_idx on public.queue (ts);

-- ── Chave Pix, SEPARADA da fila (só admin lê; nunca vai para o ranking público) ──
create table if not exists public.pix (
  id         text primary key,   -- mesmo id da linha em queue / pid no rank
  pix        text not null,
  created_at timestamptz not null default now()
);

-- ── Ranking (público para leitura) ──
create table if not exists public.rank (
  id        text primary key,
  nick      text not null,
  slot      text,
  prov      text,
  platform  text,
  source    text,
  pid       text,
  bonus     numeric,
  paid      numeric,
  pending   boolean not null default false,
  "time"    text,
  paid_at   text,
  paid_date text,
  ts        bigint
);

-- ── Rhyno: eventos disponíveis, evento escolhido, último status e itens já tratados ──
create table if not exists public.rhyno_events (
  id         text primary key,
  name       text not null,
  occupied   int,
  updated_at timestamptz not null default now()
);
create table if not exists public.rhyno_config (
  id       int primary key,
  event_id text
);
insert into public.rhyno_config (id, event_id) values (1, null) on conflict (id) do nothing;

create table if not exists public.rhyno_status (
  id           int primary key,
  ok           boolean not null default false,
  message      text,
  event_name   text,
  entries      int not null default 0,
  pix_missing  int not null default 0,
  slot_missing int not null default 0,
  at           timestamptz not null default now()
);
create table if not exists public.rhyno_seen (
  external_id text primary key,
  seen_at     timestamptz not null default now()
);

-- ── RLS ──
-- Admin (is_admin()) faz tudo. Visitante: lê rinha_state e rank; nas demais recebe lista vazia.
do $do$
declare t text;
begin
  foreach t in array array['admins','rinha_state','queue','pix','rank','rhyno_events','rhyno_config','rhyno_status','rhyno_seen'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin all" on public.%I', t);
    execute format('create policy "admin all" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  foreach t in array array['rinha_state','rank'] loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end
$do$;

-- ── Tempo real (o site escuta postgres_changes nessas tabelas) ──
do $do$
declare t text;
begin
  foreach t in array array['rinha_state','queue','pix','rank','rhyno_events','rhyno_config','rhyno_status'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; -- já estava na publicação
    end;
  end loop;
end
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIONAL — consulta agendada a cada 1 min mesmo com o painel fechado
-- (pg_cron + pg_net + Vault). Rode DEPOIS de publicar a função e trocar <PROJECT_REF>.
-- ─────────────────────────────────────────────────────────────────────────────
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');   -- uma vez só
-- select cron.schedule(
--   'rhyno-sync-1min', '* * * * *',
--   $cron$
--   select net.http_post(
--     url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/rhyno-sync',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
--     ),
--     body    := '{}'::jsonb
--   );
--   $cron$
-- );
-- Para parar: select cron.unschedule('rhyno-sync-1min');
