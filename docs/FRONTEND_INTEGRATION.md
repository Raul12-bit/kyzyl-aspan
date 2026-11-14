# Как фронтенд берёт данные

> **Сайт Kyzyl Aspan уже подключён** через `/v1/*` (`api/kyzyl.py`): клиент — `kyzyl-aspan/src/features/helios/api.ts`
> и `kyzyl-aspan/src/data/`, Vite проксирует `/v1` на `http://127.0.0.1:8000`. Ниже — прямые запросы к Supabase и
> общему API, если понадобится другой клиент (мобильное приложение, бот).

Два источника:
1. **Supabase** (готовые таблицы, только чтение, ключ publishable) — карты, календарь, тревоги, прогнозы.
2. **FastAPI** `api/server.py` (живые вычисления и всё, где нужны секреты) — Gemini, ИИ №1 на новых точках,
   симулятор «радио vs лазер», положение спутников, план связи.

## Supabase (supabase-js)

```js
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://aqebcurookfuqkwzdzws.supabase.co",
  "sb_publishable_3t9J1nv76IoGplwShpmnaA_o1iNdIPo" // публичный ключ (только чтение, RLS)
);

// Burning Activity Calendar (год × месяц)
const { data: calendar } = await supabase.from("v_calendar_matrix").select("*").order("year");

// Карта риска ИИ №3 на ближайшую неделю (представление берёт самый свежий прогноз)
const { data: risk } = await supabase.from("v_risk_latest")
  .select("h3_r5,lat,lon,p_fire,p_climatology,target_week")
  .eq("horizon_weeks", 1).gte("p_fire", 0.01);

// Свежие тревоги (ИИ №1) и детекции NRT
const { data: alerts } = await supabase.from("v_latest_alerts").select("*").eq("source", "nrt");
const { data: fires } = await supabase.from("fire_detections_nrt").select("*").order("acq_dt", { ascending: false }).limit(5000);

// Fire DNA в видимой области карты
const { data: dna } = await supabase.from("fire_dna").select("h3_r7,lat,lon,dna_class,label_ru,confidence")
  .gte("lat", south).lte("lat", north).gte("lon", west).lte("lon", east).limit(20000);

// Time Machine: прогноз «как будто сегодня» и факт
const { data: tm } = await supabase.from("time_machine").select("*").eq("as_of", "2024-06-03").eq("horizon_weeks", 1);

// Окна без связи и задержки спутников
const { data: blackouts } = await supabase.from("v_comm_blackouts_latest").select("*");
const { data: delays } = await supabase.from("satellite_delays").select("*").order("computed_at", { ascending: false }).limit(5);

// Отчёты для слайдов/виджетов (метрики, валидация гармонизации, доставка тревог)
const { data: rep } = await supabase.from("reports").select("payload").eq("key", "delivery_summary").single();
```

Шестиугольники H3 на карте — `h3-js`: `cellToBoundary(h3_r5, true)` даёт полигон `[lng, lat]`.

## FastAPI

```js
const API = "http://127.0.0.1:8000";
// клик по карте → анализ риска (Gemini или офлайн-аналитик)
await fetch(`${API}/api/analyze`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lat, lon, question: "Насколько опасно на этой неделе?" }) }).then(r => r.json());
// слайдеры «вспышка / буря / дождь / облака» → запасы каналов и рекомендованный канал
await fetch(`${API}/api/link/simulate?xray_flux=1e-4&kp=8&rain_mm_h=12&cloud_frac=0.85`).then(r => r.json());
// спутники сейчас + трасса на 100 минут
await fetch(`${API}/api/satellites/positions`).then(r => r.json());
// слои снимков NASA GIBS (XYZ-тайлы для Leaflet/MapLibre)
await fetch(`${API}/api/config`).then(r => r.json()); // .gibs_layers[].url
```

Полный список эндпоинтов — Swagger: `http://127.0.0.1:8000/docs`.
