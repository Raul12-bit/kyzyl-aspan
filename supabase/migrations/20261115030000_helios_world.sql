-- HELIOS-SHIELD: мировой контур — все страны, регионы (admin-1) и прогноз ИИ №3 для всего мира.
-- Компактно (бесплатный тариф 500 МБ): страны по месяцам, регионы по годам, текущий прогноз.

create table if not exists public.world_regions (
  region_id   text primary key,           -- Natural Earth adm1_code
  iso2        text not null,
  name        text not null,
  name_ru     text,
  kind        text,
  bbox        jsonb,
  area_km2    real
);

create table if not exists public.world_country_month (
  iso2            text not null,
  month           date not null,
  hexdays         integer not null,         -- горящие гексагоно-сутки H3 res 6 (чистые, любой сенсор)
  hex_modis       integer not null,
  hex_viirs       integer not null,
  detections      bigint not null,          -- после фильтра шума
  detections_raw  bigint not null,
  low_conf        bigint not null,
  static_src      bigint not null,
  frp_sum         double precision,
  primary key (iso2, month)
);

create table if not exists public.world_region_year (
  region_id   text not null,
  iso2        text not null,
  year        smallint not null,
  hexdays     integer not null,
  hex_modis   integer not null,
  hex_viirs   integer not null,
  detections  bigint not null,
  frp_sum     double precision,
  primary key (region_id, year)
);

create table if not exists public.world_risk_latest (
  h3             text not null,             -- H3 res 5 (~252 км²)
  horizon_weeks  smallint not null,
  p_fire         real not null,
  p_climatology  real,
  lat            real,
  lon            real,
  as_of          date,
  primary key (h3, horizon_weeks)
);

create index if not exists world_country_month_month_idx on public.world_country_month (month);
create index if not exists world_region_year_iso_idx on public.world_region_year (iso2, year);
create index if not exists world_risk_latest_p_idx on public.world_risk_latest (horizon_weeks, p_fire desc);

do $$
declare t text;
begin
  foreach t in array array['world_regions','world_country_month','world_region_year','world_risk_latest'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- запись по-прежнему только сервером по токену: добавляем новые таблицы в белый список
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
    'space_weather','model_registry','ai_analyses','reports',
    'world_regions','world_country_month','world_region_year','world_risk_latest'];
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
