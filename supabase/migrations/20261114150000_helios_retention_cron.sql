-- Ежедневная очистка оперативных таблиц (03:20 UTC), чтобы бесплатный лимит 500 МБ не заполнился.
-- История (календарь, Fire DNA, Time Machine и т.д.) не трогается.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function private.helios_retention()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  delete from public.spread_forecasts where computed_at < now() - interval '7 days';
  delete from public.comm_blackouts where computed_at < now() - interval '14 days';
  delete from public.comm_passes where aos < now() - interval '3 days';
  delete from public.satellite_delays where computed_at < now() - interval '90 days';
  delete from public.space_weather where time < now() - interval '365 days';
  delete from public.fire_detections_nrt where acq_dt < now() - interval '180 days';
  delete from public.alerts where source = 'nrt' and acq_dt < now() - interval '180 days';
  delete from public.blind_spots where source = 'nrt' and week < (now() - interval '30 days')::date;
  delete from public.risk_forecast
   where as_of_week < (now() - interval '120 days')::date
     and as_of_week < (select max(as_of_week) from public.risk_forecast);
end;
$$;

revoke all on function private.helios_retention() from public, anon, authenticated;

select cron.schedule('helios-retention-daily', '20 3 * * *', $$select private.helios_retention()$$);
