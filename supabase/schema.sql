-- Bem de Colo: conta familiar privada + estado compartilhado
-- Execute uma única vez no SQL Editor do projeto Supabase.

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  invite_code text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table if not exists public.family_state (
  family_id uuid primary key references public.families(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_device text
);

create index if not exists family_members_user_id_idx on public.family_members(user_id);

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_state enable row level security;

-- Cada usuário lê apenas seu próprio vínculo. Isso permite que as políticas
-- das outras tabelas verifiquem a associação sem expor a lista de membros.
drop policy if exists "members can read own membership" on public.family_members;
create policy "members can read own membership"
  on public.family_members for select to authenticated
  using (user_id = (select auth.uid()));

-- O responsável e os integrantes da família podem consultar os dados da família.
drop policy if exists "family members can read family" on public.families;
create policy "family members can read family"
  on public.families for select to authenticated
  using (
    created_by = (select auth.uid())
    or id in (
      select fm.family_id from public.family_members as fm
      where fm.user_id = (select auth.uid())
    )
  );

-- Somente integrantes daquela família podem ler ou alterar seu estado compartilhado.
drop policy if exists "family members can read shared state" on public.family_state;
create policy "family members can read shared state"
  on public.family_state for select to authenticated
  using (
    exists (
      select 1 from public.family_members as fm
      where fm.family_id = family_state.family_id
        and fm.user_id = (select auth.uid())
    )
  );

drop policy if exists "family members can create shared state" on public.family_state;
create policy "family members can create shared state"
  on public.family_state for insert to authenticated
  with check (
    exists (
      select 1 from public.family_members as fm
      where fm.family_id = family_state.family_id
        and fm.user_id = (select auth.uid())
    )
  );

drop policy if exists "family members can update shared state" on public.family_state;
create policy "family members can update shared state"
  on public.family_state for update to authenticated
  using (
    exists (
      select 1 from public.family_members as fm
      where fm.family_id = family_state.family_id
        and fm.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.family_members as fm
      where fm.family_id = family_state.family_id
        and fm.user_id = (select auth.uid())
    )
  );

grant select on public.families, public.family_members to authenticated;
grant select, insert, update on public.family_state to authenticated;

-- Funções privilegiadas ficam no schema private, que não deve ser exposto pela API.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- O horário da sincronização é definido pelo banco, evitando divergência de relógio entre celulares.
create or replace function private.touch_family_state_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function private.touch_family_state_updated_at() from public, anon;
grant execute on function private.touch_family_state_updated_at() to authenticated;

drop trigger if exists family_state_touch_updated_at on public.family_state;
create trigger family_state_touch_updated_at
  before insert or update on public.family_state
  for each row execute function private.touch_family_state_updated_at();

-- Cria a família e torna o usuário atual seu primeiro responsável.
-- SECURITY DEFINER é limitado, valida auth.uid(), usa search_path vazio
-- e qualifica explicitamente todas as tabelas e funções.
create or replace function private.create_family_impl(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_family_id uuid;
  v_invite_code text;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
begin
  if v_user_id is null then
    raise exception 'É necessário entrar na conta.' using errcode = '28000';
  end if;
  if pg_catalog.char_length(v_name) < 2 or pg_catalog.char_length(v_name) > 80 then
    raise exception 'O nome da família deve ter entre 2 e 80 caracteres.' using errcode = '22023';
  end if;
  if exists (select 1 from public.family_members where user_id = v_user_id) then
    raise exception 'Este usuário já participa de uma conta familiar.' using errcode = '23505';
  end if;

  v_invite_code := pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 16));
  insert into public.families(name, invite_code, created_by)
    values (v_name, v_invite_code, v_user_id)
    returning id into v_family_id;
  insert into public.family_members(family_id, user_id, role)
    values (v_family_id, v_user_id, 'owner');

  return pg_catalog.jsonb_build_object('id', v_family_id, 'name', v_name, 'invite_code', v_invite_code);
end;
$$;

-- O segundo responsável entra usando o código privado. A família aceita no máximo 2 usuários.
create or replace function private.join_family_impl(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_family_id uuid;
  v_member_count integer;
  v_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_invite_code, '')));
begin
  if v_user_id is null then
    raise exception 'É necessário entrar na conta.' using errcode = '28000';
  end if;
  if pg_catalog.char_length(v_code) < 8 or pg_catalog.char_length(v_code) > 16 then
    raise exception 'Código de convite inválido.' using errcode = '22023';
  end if;
  if exists (select 1 from public.family_members where user_id = v_user_id) then
    raise exception 'Este usuário já participa de uma conta familiar.' using errcode = '23505';
  end if;

  select id into v_family_id
    from public.families
    where invite_code = v_code
    for update;
  if v_family_id is null then
    raise exception 'Código de convite não encontrado.' using errcode = 'P0002';
  end if;

  select pg_catalog.count(*) into v_member_count
    from public.family_members where family_id = v_family_id;
  if v_member_count >= 2 then
    raise exception 'Esta conta familiar já possui dois responsáveis.' using errcode = '23505';
  end if;

  insert into public.family_members(family_id, user_id, role)
    values (v_family_id, v_user_id, 'member');
  return v_family_id;
end;
$$;

revoke all on function private.create_family_impl(text) from public, anon;
revoke all on function private.join_family_impl(text) from public, anon;
grant execute on function private.create_family_impl(text) to authenticated;
grant execute on function private.join_family_impl(text) to authenticated;

-- Wrappers invoker expostos ao aplicativo; a lógica privilegiada permanece em private.
create or replace function public.create_family(p_name text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.create_family_impl(p_name); $$;

create or replace function public.join_family(p_invite_code text)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.join_family_impl(p_invite_code); $$;

revoke all on function public.create_family(text) from public, anon;
revoke all on function public.join_family(text) from public, anon;
grant execute on function public.create_family(text) to authenticated;
grant execute on function public.join_family(text) to authenticated;

-- Habilita Realtime para a tabela que guarda o estado da família.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'family_state'
     ) then
    execute 'alter publication supabase_realtime add table public.family_state';
  end if;
end;
$$;

notify pgrst, 'reload schema';
