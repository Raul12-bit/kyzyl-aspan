-- Представления «последнее состояние» для фронтенда
create or replace view public.v_risk_latest with (security_invoker = true) as
  select * from public.risk_forecast
  where as_of_week = (select max(as_of_week) from public.risk_forecast);

create or replace view public.v_comm_blackouts_latest with (security_invoker = true) as
  select * from public.comm_blackouts
  where computed_at = (select max(computed_at) from public.comm_blackouts);
