-- HELIOS-SHIELD: схема базы данных Supabase
-- Чтение — публичное (ключ publishable/anon, для фронтенда). Запись — только сервер:
-- service_role ключ ИЛИ функция helios_ingest(токен) (токен хранится в .env, в БД — только sha256-хэш).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.ingest_tokens (
  token_hash text primary key,
  label text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- справочники
create table if not exists public.regions (
  id text primary key,
  name text not null,
  bbox jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.satellites (
  id text primary key,              -- поток: MODIS_T, MODIS_A, VIIRS_SNPP, VIIRS_NOAA20, VIIRS_NOAA21
  name text not null,
  norad integer,
  sensor text,
  role text,
  active boolean default true,
  note text
);

create table if not exists public.ground_stations (
  id text primary key,
  name text not null,
  lat double precision not null,
  lon double precision not null,
  alt_m double precision,
  kind text,                        -- rf | optical
  bands text[],
  dish_m double precision,
  aperture_m double precision,
  geomag_lat double precision,
  is_real boolean default true
);

-- ---------------------------------------------------------------- история и гармонизация
create table if not exists public.burning_calendar (
  region_id text not null references public.regions(id),
  month date not null,
  year integer,
  mon integer,
  harmonized double precision,
  harmonized_day double precision,
  harmonized_night double precision,
  lo95 double precision,
  hi95 double precision,
  raw_detections integer,
  raw_union_celldays integer,
  celldays_modis_a integer,
  celldays_modis_t integer,
  celldays_viirs_snpp integer,
  celldays_viirs_noaa20 integer,
  anomaly_z double precision,
  pct_rank double precision,
  streams text,
  primary key (region_id, month)
);

create table if not exists public.calibration (
  stream text not null,
  dn text not null,
  cal_month integer not null,
  ref text,
  beta double precision,
  sigma2 double precision,
  sigma2_extra double precision,
  beta_to_aqua double precision,
  n_months integer,
  primary key (stream, dn, cal_month)
);

create table if not exists public.static_sources (
  h3_r8 text primary key,
  lat double precision,
  lon double precision,
  n integer,
  static_score double precision,
  static_type_share double precision,
  max_months_in_year integer,
  years_with_6m integer,
  night_share double precision,
  frp_median double precision,
  first_year integer,
  last_year integer,
  ev_type boolean,
  ev_temporal boolean,
  ev_hdbscan boolean
);

create table if not exists public.fire_dna (
  h3_r7 text primary key,
  lat double precision,
  lon double precision,
  dna_class text,
  label_ru text,
  confidence double precision,
  p_industrial double precision,
  p_agricultural double precision,
  p_wildfire double precision,
  p_sporadic double precision,
  n_det integer,
  n_years integer,
  first_year integer,
  last_year integer,
  peak_doy double precision,
  night_share double precision,
  frp_median double precision
);
create index if not exists fire_dna_class_idx on public.fire_dna (dna_class);
create index if not exists fire_dna_latlon_idx on public.fire_dna (lat, lon);

create table if not exists public.cell_activity_monthly (
  h3_r5 text not null,
  month date not null,
  union_celldays integer,
  harmonized_celldays double precision,
  frp_sum double precision,
  primary key (h3_r5, month)
);
create index if not exists cell_activity_month_idx on public.cell_activity_monthly (month);

create table if not exists public.season_shift_cells (
  h3_r4 text primary key,
  lat double precision,
  lon double precision,
  years integer,
  mean_peak_doy double precision,
  n_years integer,
  days_per_decade double precision,
  kendall_tau double precision,
  p_value double precision,
  significant boolean
);

-- ---------------------------------------------------------------- прогнозы ИИ №3
create table if not exists public.risk_forecast (
  h3_r5 text not null,
  as_of_week date not null,
  horizon_weeks integer not null,
  target_week date,
  lat double precision,
  lon double precision,
  p_fire double precision,
  p_climatology double precision,
  recent_celldays_4w double precision,
  precip_28d double precision,
  gwet double precision,
  actual integer,
  primary key (h3_r5, as_of_week, horizon_weeks)
);
create index if not exists risk_forecast_week_idx on public.risk_forecast (as_of_week, horizon_weeks);

create table if not exists public.time_machine (
  as_of date not null,
  horizon_weeks integer not null,
  h3_r5 text not null,
  target_week date,
  lat double precision,
  lon double precision,
  p_fire double precision,
  p_climatology double precision,
  actual integer,
  primary key (as_of, horizon_weeks, h3_r5)
);

create table if not exists public.blind_spots (
  h3 text not null,
  week date not null,
  source text not null,             -- history | nrt
  expected_fire_p double precision,
  cloud_frac double precision,
  blind_score double precision,
  fire_next_week boolean,
  message text,
  lat double precision,
  lon double precision,
  primary key (h3, week, source)
);

create table if not exists public.spread_forecasts (
  cluster_id text not null,
  computed_at timestamptz not null,
  lat double precision,
  lon double precision,
  gfdi double precision,
  danger_ru text,
  ros_kmh double precision,
  wind_kmh double precision,
  wind_from_deg double precision,
  spread_to_deg double precision,
  rain_next_24h_mm double precision,
  polygon_6h jsonb,
  polygon_12h jsonb,
  polygon_24h jsonb,
  primary key (cluster_id, computed_at)
);

-- ---------------------------------------------------------------- оперативные данные (NRT)
create table if not exists public.fire_detections_nrt (
  id text primary key,
  acq_dt timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  stream text,
  sensor text,
  frp double precision,
  conf_cat text,
  p_fire double precision,
  keep_veg boolean,
  is_static boolean,
  noise_reason text,
  h3_r7 text,
  h3_r5 text,
  p_real double precision,
  p_escalation double precision,
  priority text,
  ingested_at timestamptz not null default now()
);
create index if not exists fire_nrt_time_idx on public.fire_detections_nrt (acq_dt desc);

create table if not exists public.alerts (
  alert_id text primary key,
  source text,                      -- nrt | replay
  stream text,
  acq_dt timestamptz,
  lat double precision,
  lon double precision,
  h3_r7 text,
  priority text,
  p_real double precision,
  p_escalation double precision,
  frp_sum double precision,
  cluster_n integer,
  packet_hex text,
  latency_a_nrt_min double precision,
  latency_b_storeforward_min double precision,
  latency_c_kz_station_min double precision,
  latency_d1_real_relay_min double precision,
  latency_d2_relay_76e_min double precision,
  station_b text,
  relay_d1 text,
  confirmed boolean,
  confirm_stream text,
  confirm_delay_min double precision,
  next_look_sat text,
  next_look_min double precision,
  created_at timestamptz not null default now()
);
create index if not exists alerts_time_idx on public.alerts (acq_dt desc);
create index if not exists alerts_priority_idx on public.alerts (priority);

create table if not exists public.comm_passes (
  satellite text not null,
  station text not null,
  aos timestamptz not null,
  los timestamptz,
  max_el double precision,
  duration_min double precision,
  s_availability double precision,
  x_availability double precision,
  ka_availability double precision,
  opt_availability double precision,
  recommended_channel text,
  expected_volume_gb double precision,
  primary key (satellite, station, aos)
);

create table if not exists public.comm_blackouts (
  satellite text not null,
  computed_at timestamptz not null,
  hours integer,
  minutes_without_any_link double precision,
  longest_gap_min double precision,
  next_gap_start timestamptz,
  next_gap_end timestamptz,
  relay_coverage jsonb,
  gaps jsonb,
  primary key (satellite, computed_at)
);

create table if not exists public.satellite_delays (
  stream text not null,
  computed_at timestamptz not null,
  granules integer,
  median_latency_min double precision,
  p90_latency_min double precision,
  recent_latency_min double precision,
  robust_z double precision,
  status text,
  last_granule timestamptz,
  primary key (stream, computed_at)
);

create table if not exists public.space_weather (
  time timestamptz primary key,
  kp double precision,
  xray_flux double precision,
  flare_class text,
  f107 double precision
);

-- ---------------------------------------------------------------- ИИ: реестр моделей, анализы, отчёты
create table if not exists public.model_registry (
  name text primary key,
  kind text,
  version text,
  metrics jsonb,
  artifact text,
  trained_at timestamptz default now()
);

create table if not exists public.ai_analyses (
  id bigint generated always as identity primary key,
  h3 text,
  region_id text,
  question text,
  stats jsonb,
  response text,
  model text,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS: всем можно читать, писать — никому (кроме сервера)
do $$
declare t text;
begin
  foreach t in array array['regions','satellites','ground_stations','burning_calendar','calibration','static_sources',
    'fire_dna','cell_activity_monthly','season_shift_cells','risk_forecast','time_machine','blind_spots',
    'spread_forecasts','fire_detections_nrt','alerts','comm_passes','comm_blackouts','satellite_delays',
    'space_weather','model_registry','ai_analyses','reports']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- серверная запись по токену
create or replace function public.helios_ingest(p_token text, p_table text, p_rows jsonb, p_mode text default 'upsert')
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  allowed text[] := array['regions','satellites','ground_stations','burning_calendar','calibration','static_sources',
    'fire_dna','cell_activity_monthly','season_shift_cells','risk_forecast','time_machine','blind_spots',
    'spread_forecasts','fire_detections_nrt','alerts','comm_passes','comm_blackouts','satellite_delays',
    'space_weather','model_registry','ai_analyses','reports'];
  cols text;
  pk_cols text;
  upd text;
  n integer := 0;
begin
  if p_token is null or not exists (
    select 1 from private.ingest_tokens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  ) then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;
  if not (p_table = any(allowed)) then
    raise exception 'table % is not allowed', p_table;
  end if;
  if p_mode = 'replace' then
    execute format('delete from public.%I where true', p_table);
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  -- колонки = ключи первой записи, которые реально есть в таблице (identity/default не трогаем)
  select string_agg(quote_ident(c.column_name), ',' order by c.ordinal_position) into cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = p_table
    and c.column_name in (select jsonb_object_keys(p_rows -> 0))
    and c.is_identity = 'NO';

  select string_agg(quote_ident(a.attname), ',') into pk_cols
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = format('public.%I', p_table)::regclass and i.indisprimary;

  select string_agg(format('%1$I = excluded.%1$I', c.column_name), ',') into upd
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = p_table
    and c.column_name in (select jsonb_object_keys(p_rows -> 0))
    and c.is_identity = 'NO'
    and quote_ident(c.column_name) <> all (string_to_array(coalesce(pk_cols, ''), ','));

  if p_table = 'ai_analyses' or pk_cols is null then
    execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1)',
                   p_table, cols) using p_rows;
  elsif upd is null then
    execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) on conflict (%3$s) do nothing',
                   p_table, cols, pk_cols) using p_rows;
  else
    execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) on conflict (%3$s) do update set %4$s',
                   p_table, cols, pk_cols, upd) using p_rows;
  end if;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.helios_ingest(text, text, jsonb, text) from public;
grant execute on function public.helios_ingest(text, text, jsonb, text) to anon, authenticated, service_role;

-- удобные представления для фронтенда
create or replace view public.v_latest_alerts with (security_invoker = true) as
  select * from public.alerts order by acq_dt desc limit 500;

create or replace view public.v_calendar_matrix with (security_invoker = true) as
  select region_id, year, mon, harmonized, lo95, hi95, anomaly_z, raw_detections from public.burning_calendar;
