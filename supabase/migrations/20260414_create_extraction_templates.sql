create table if not exists public.extraction_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  fields_csv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint extraction_templates_name_length check (char_length(name) between 2 and 80),
  constraint extraction_templates_fields_length check (char_length(fields_csv) between 3 and 1500)
);

create index if not exists extraction_templates_user_created_at_idx
  on public.extraction_templates (user_id, created_at desc);

drop trigger if exists trg_extraction_templates_set_updated_at on public.extraction_templates;
create trigger trg_extraction_templates_set_updated_at
before update on public.extraction_templates
for each row
execute function public.set_updated_at();

alter table public.extraction_templates enable row level security;

drop policy if exists "extraction_templates_select_own" on public.extraction_templates;
create policy "extraction_templates_select_own"
on public.extraction_templates
for select
using (auth.uid() = user_id);

drop policy if exists "extraction_templates_insert_own" on public.extraction_templates;
create policy "extraction_templates_insert_own"
on public.extraction_templates
for insert
with check (auth.uid() = user_id);

drop policy if exists "extraction_templates_update_own" on public.extraction_templates;
create policy "extraction_templates_update_own"
on public.extraction_templates
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "extraction_templates_delete_own" on public.extraction_templates;
create policy "extraction_templates_delete_own"
on public.extraction_templates
for delete
using (auth.uid() = user_id);
