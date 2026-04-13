create table if not exists public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid references public.chat_sessions(id) on delete set null,
  file_path text not null,
  file_name text not null,
  prompt text not null,
  result text not null,
  created_at timestamptz not null default now()
);

create index if not exists extraction_runs_user_created_at_idx
  on public.extraction_runs (user_id, created_at desc);

create index if not exists extraction_runs_file_name_idx
  on public.extraction_runs (file_name);

alter table public.extraction_runs enable row level security;

drop policy if exists "extraction_runs_select_own" on public.extraction_runs;
create policy "extraction_runs_select_own"
on public.extraction_runs
for select
using (auth.uid() = user_id);

drop policy if exists "extraction_runs_insert_own" on public.extraction_runs;
create policy "extraction_runs_insert_own"
on public.extraction_runs
for insert
with check (auth.uid() = user_id);

drop policy if exists "extraction_runs_update_own" on public.extraction_runs;
create policy "extraction_runs_update_own"
on public.extraction_runs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
