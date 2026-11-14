-- Окна без связи в трёх конфигурациях: только наземные станции / + реальные ретрансляторы / + условный ГСО 76° в.д.
alter table public.comm_blackouts
  add column if not exists minutes_without_link_with_real_relays double precision,
  add column if not exists minutes_without_link_with_relay_76e double precision;

create or replace view public.v_comm_blackouts_latest with (security_invoker = true) as
  select * from public.comm_blackouts
  where computed_at = (select max(computed_at) from public.comm_blackouts);
