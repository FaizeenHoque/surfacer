create table if not exists public.shared_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid references public.chat_sessions(id) on delete set null,
  file_path text,
  file_name text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists shared_chats_created_at_idx
  on public.shared_chats (created_at desc);

alter table public.shared_chats enable row level security;

drop policy if exists "shared_chats_insert_own" on public.shared_chats;
create policy "shared_chats_insert_own"
on public.shared_chats
for insert
with check (auth.uid() = user_id);

drop policy if exists "shared_chats_select_public" on public.shared_chats;
create policy "shared_chats_select_public"
on public.shared_chats
for select
using (true);
