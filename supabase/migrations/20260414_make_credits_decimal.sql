alter table public.profiles
  alter column credits type numeric(12,2) using credits::numeric,
  alter column credits set default 35;

alter table public.profiles
  drop constraint if exists profiles_credits_check;

alter table public.profiles
  add constraint profiles_credits_check check (credits >= 0);
