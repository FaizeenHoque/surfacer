alter table public.profiles
  add column if not exists subscription_id text,
  add column if not exists subscription_status text;

create index if not exists profiles_subscription_id_idx
  on public.profiles (subscription_id);
