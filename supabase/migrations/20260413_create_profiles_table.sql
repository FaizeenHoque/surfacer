-- Profiles table used by auth bootstrap flow.
-- New users receive 35 credits on first app login.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  credits integer not null default 35 check (credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, file_path)
);

create index if not exists chat_sessions_user_id_idx
  on public.chat_sessions (user_id);

create index if not exists chat_sessions_file_path_idx
  on public.chat_sessions (file_path);

drop trigger if exists trg_chat_sessions_set_updated_at on public.chat_sessions;
create trigger trg_chat_sessions_set_updated_at
before update on public.chat_sessions
for each row
execute function public.set_updated_at();

alter table public.chat_sessions enable row level security;

drop policy if exists "chat_sessions_select_own" on public.chat_sessions;
create policy "chat_sessions_select_own"
on public.chat_sessions
for select
using (auth.uid() = user_id);

drop policy if exists "chat_sessions_insert_own" on public.chat_sessions;
create policy "chat_sessions_insert_own"
on public.chat_sessions
for insert
with check (auth.uid() = user_id);

drop policy if exists "chat_sessions_update_own" on public.chat_sessions;
create policy "chat_sessions_update_own"
on public.chat_sessions
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_chat_id_created_at_idx
  on public.chat_messages (chat_id, created_at, id);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages_select_own" on public.chat_messages;
create policy "chat_messages_select_own"
on public.chat_messages
for select
using (
  exists (
    select 1
    from public.chat_sessions
    where chat_sessions.id = chat_messages.chat_id
      and chat_sessions.user_id = auth.uid()
  )
);

drop policy if exists "chat_messages_insert_own" on public.chat_messages;
create policy "chat_messages_insert_own"
on public.chat_messages
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.chat_sessions
    where chat_sessions.id = chat_messages.chat_id
      and chat_sessions.user_id = auth.uid()
  )
);

drop policy if exists "chat_messages_update_own" on public.chat_messages;
create policy "chat_messages_update_own"
on public.chat_messages
for update
using (
  exists (
    select 1
    from public.chat_sessions
    where chat_sessions.id = chat_messages.chat_id
      and chat_sessions.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.chat_sessions
    where chat_sessions.id = chat_messages.chat_id
      and chat_sessions.user_id = auth.uid()
  )
);
