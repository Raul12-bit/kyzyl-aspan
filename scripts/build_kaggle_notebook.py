"""Собирает самодостаточный Kaggle-ноутбук из исходников пакета helios.

    python scripts/build_kaggle_notebook.py  ->  notebooks/helios_kaggle_training.ipynb

Ноутбук: ставит зависимости, записывает пакет (%%writefile — код виден жюри),
скачивает данные NASA и обучает три ИИ. На Kaggle включите Settings -> Internet: On.
Секреты (необязательно) — Add-ons -> Secrets: GEMINI_API_KEY, FIRMS_MAP_KEY, SUPABASE_URL,
SUPABASE_PUBLISHABLE_KEY, HELIOS_INGEST_TOKEN, SUPABASE_SERVICE_ROLE_KEY, EARTHDATA_TOKEN, NASA_API_KEY.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "notebooks" / "helios_kaggle_training.ipynb"

SECTIONS = [
    ("Конфигурация", ["config/settings.yaml"]),
    ("Ядро и коннекторы к API (NASA FIRMS, POWER, CMR, EONET, GIBS, DONKI; CelesTrak, NOAA SWPC, GFZ, Open-Meteo, Gemini)",
     ["helios/__init__.py", "helios/config.py", "helios/utils.py", "helios/apis/__init__.py", "helios/apis/firms.py",
      "helios/apis/boundaries.py", "helios/apis/nasa_power.py", "helios/apis/open_meteo.py", "helios/apis/celestrak.py",
      "helios/apis/space_weather.py", "helios/apis/earthdata.py", "helios/apis/eonet.py", "helios/apis/gibs.py",
      "helios/apis/gemini.py", "helios/apis/health.py"]),
    ("Обработка: фильтрация шума, H3, гармонизация, аналитика",
     ["helios/processing/__init__.py", "helios/processing/solar.py", "helios/processing/footprint.py",
      "helios/processing/persistence.py", "helios/processing/filters.py", "helios/processing/harmonize.py",
      "helios/processing/fire_dna.py", "helios/processing/season_shift.py", "helios/processing/blind_spots.py",
      "helios/processing/spread.py"]),
    ("Связь: орбиты, станции, физика радио/лазер, пакеты, планировщик, доставка",
     ["helios/comms/__init__.py", "helios/comms/orbits.py", "helios/comms/stations.py", "helios/comms/physics.py",
      "helios/comms/packets.py", "helios/comms/link_sim.py", "helios/comms/scheduler.py", "helios/comms/delivery.py"]),
    ("Модели ИИ", ["helios/models/__init__.py", "helios/models/features.py", "helios/models/edge_detector.py",
                   "helios/models/link_ai.py", "helios/models/ground_forecast.py", "helios/models/time_machine.py"]),
    ("База данных и оркестрация", ["helios/db/__init__.py", "helios/db/supabase_sync.py", "helios/analysis.py",
                                   "helios/pipeline.py", "helios/cli.py"]),
    ("Весь мир: архив всех стран, регионы, гексагоны, ИИ на мировых данных",
     ["helios/world/__init__.py", "helios/world/fetch.py", "helios/world/ingest.py", "helios/world/regions.py",
      "helios/world/aggregate.py", "helios/world/nrt.py", "helios/world/forecast.py", "helios/world/edge.py"]),
    ("Бортовой ИИ для любого спутника (C99, int8)",
     ["helios/onboard/__init__.py", "helios/onboard/quant.py", "helios/onboard/export_c.py"]),
]


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(keepends=True)}


def code(text: str, collapsed: bool = False) -> dict:
    meta = {"jupyter": {"source_hidden": True}} if collapsed else {}
    return {"cell_type": "code", "execution_count": None, "metadata": meta, "outputs": [],
            "source": text.strip("\n").splitlines(keepends=True)}


def build() -> Path:
    cells = [md("""
# 🔥🛰️ HELIOS-SHIELD — обучение ИИ на 26 годах пожаров NASA (MODIS + VIIRS)

**Задача:** гармонизировать 26-летнюю историю активных пожаров MODIS (1 км, с 2000 г.) и VIIRS (375 м, с 2012 г.),
отсеять шум (факелы, заводы, блики, одиночные артефакты) и обучить три ИИ:

| ИИ | Где работает | Что делает |
|---|---|---|
| **№1 Edge Detector** | на борту спутника | по первому снимку: настоящий ли это пожар и разрастётся ли он → приоритет тревоги |
| **№2 Link AI** | на борту спутника | заранее предсказывает потерю связи (дождь, облака, мерцания, уход за горизонт) и выбирает канал радио/лазер |
| **№3 Ground Forecast** | на Земле («суперкомпьютер») | прогноз риска на 1–4 недели, погода NASA POWER, распространение по ветру, задержки спутников |

**Структура ноутбука**
1. **Historical Intelligence** — MODIS + VIIRS, H3, фильтрация постоянных источников, гармонизация 26 лет.
2. **Edge AI Simulation** — небольшая модель оценивает новые наблюдения, сравнивает с историей и формирует короткие приоритетные тревоги.
3. **Smart Alert Delivery** — окна связи, задержки, сначала важные сообщения, результат на карте.

> ⚙️ На Kaggle включите **Settings → Internet: On**. Ключи не обязательны: всё основное работает на открытых данных NASA.
> Секреты (по желанию) — **Add-ons → Secrets**: `GEMINI_API_KEY`, `FIRMS_MAP_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `HELIOS_INGEST_TOKEN`.

Фильтрация основана на открытых проектах **flare-chronos** (MIT), **MODIS-VIIRS-fires** (Franklin et al. 2025, MIT) и идеях **Kiln-Watch** — и улучшена (см. `helios/processing/filters.py`).
"""),
             code("""
!pip install -q h3 sgp4 onnx onnxruntime onnxscript google-genai python-dotenv pyarrow duckdb h3ronpy lightgbm shapely polars ziglang
"""),
             code("""
import os, sys, pathlib
ROOT = pathlib.Path('/kaggle/working') if pathlib.Path('/kaggle').exists() else pathlib.Path.cwd()
os.chdir(ROOT)
os.environ['HELIOS_ROOT'] = str(ROOT)
for d in ['config', 'helios/apis', 'helios/processing', 'helios/comms', 'helios/models', 'helios/db', 'helios/world', 'helios/onboard']:
    (ROOT / d).mkdir(parents=True, exist_ok=True)
# секреты Kaggle -> переменные окружения (если заданы)
try:
    from kaggle_secrets import UserSecretsClient
    sec = UserSecretsClient()
    for k in ['GEMINI_API_KEY', 'FIRMS_MAP_KEY', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'HELIOS_INGEST_TOKEN',
              'SUPABASE_SERVICE_ROLE_KEY', 'EARTHDATA_TOKEN', 'NASA_API_KEY']:
        try:
            os.environ[k] = sec.get_secret(k)
        except Exception:
            pass
except ImportError:
    pass
print('working dir:', ROOT)
""")]
    cells.append(md("## 0. Код пакета `helios` (записывается в рабочую папку)"))
    for title, files in SECTIONS:
        cells.append(md(f"### {title}"))
        for rel in files:
            text = (ROOT / rel).read_text(encoding="utf-8")
            cells.append(code(f"%%writefile {rel}\n{text}", collapsed=True))
    cells += [
        code("""
import importlib, helios, json, shutil, pandas as pd, numpy as np
import matplotlib.pyplot as plt
from helios.config import ensure_dirs, REPORTS_DIR, PROCESSED
ensure_dirs()
pd.set_option('display.width', 200)
def show(name):
    print(json.dumps(json.loads((REPORTS_DIR / f'{name}.json').read_text(encoding='utf-8')), ensure_ascii=False, indent=1)[:4000])
"""),
        md("## Проверка API (что доступно без ключей)"),
        code("""
from helios.apis.health import check_all
for name, info in check_all().items():
    print(('OK ' if info['ok'] else '-- ') + f"{name:24s} {info['detail']}")
"""),
        md("""
# 1. Historical Intelligence
Годовой архив FIRMS по стране (научное качество, с полем `type`) → геометрия пикселя и Солнца → реестр постоянных
источников (4 улики) → единый фильтр шума → «сгоревшие гексагоны» H3 → калибровка VIIRS к шкале Aqua MODIS
(эмпирический Байес) → Burning Activity Calendar. Проверки: ступеньки 2012/2018 и тест «MODIS выключили».
"""),
        code("""
from helios.apis.firms import download_country_archive
_ = download_country_archive(workers=6)
"""),
        code("""
from helios.pipeline import build_history
res = build_history()
show('filter_report'); show('harmonization_validation')
"""),
        code("""
cal = pd.read_parquet(PROCESSED / 'calendar_monthly.parquet')
cal['month'] = pd.to_datetime(cal['month'])
fig, ax = plt.subplots(2, 1, figsize=(14, 8))
ax[0].plot(cal['month'], cal['raw_detections'], label='сырые точки (все спутники)', alpha=.6)
ax[0].plot(cal['month'], cal['harmonized'], label='гармонизировано (шкала Aqua MODIS)', lw=2)
ax[0].fill_between(cal['month'], cal['lo95'], cal['hi95'], alpha=.25, label='95% интервал')
for x, t in [('2012-01-19', 'Suomi-NPP'), ('2018-01-05', 'NOAA-20')]:
    ax[0].axvline(pd.Timestamp(x), ls='--', c='gray'); ax[0].text(pd.Timestamp(x), ax[0].get_ylim()[1]*.9, t)
ax[0].set_yscale('log'); ax[0].legend(); ax[0].set_title('Без гармонизации появление новых спутников выглядит как «рост пожаров»')
mat = cal.pivot_table(index='year', columns='mon', values='harmonized')
im = ax[1].imshow(np.log1p(mat.values), aspect='auto', cmap='inferno'); ax[1].set_yticks(range(len(mat.index)), mat.index)
ax[1].set_xticks(range(12), ['Я','Ф','М','А','М','И','И','А','С','О','Н','Д']); ax[1].set_title('Burning Activity Calendar (log)')
plt.tight_layout(); plt.show()
"""),
        code("""
reg = pd.read_parquet(PROCESSED / 'static_registry.parquet'); st = reg[reg.is_static]
det = pd.read_parquet(PROCESSED / 'detections_filtered.parquet', columns=['lat','lon','keep_veg','acq_dt'])
s = det[det.acq_dt.dt.year == 2023].sample(60000, random_state=0)
plt.figure(figsize=(12, 6)); plt.scatter(s.lon, s.lat, s=1, c=np.where(s.keep_veg, 'tab:orange', 'lightgray'))
plt.scatter(st.lon, st.lat, s=8, c='blue', label=f'постоянные источники ({len(st)})'); plt.legend()
plt.title('Пожары 2023 (оранжевые — природные/растительные) и найденные факелы/заводы (синие)'); plt.show()
"""),
        md("### Погода NASA POWER по сетке H3 res-3 (для ИИ №3 и детектора слепых зон)"),
        code("""
from helios.pipeline import fetch_weather
w = fetch_weather(); print(w.shape)
"""),
        md("""
# 2. Edge AI Simulation — ИИ №1 (на борту)
Крошечная MLP (≈1.5 тыс. параметров, ONNX int8 ≈ 6 КБ) + бортовая таблица истории (≈0.4 МБ, только до 2018 г.).
Метки из будущего: разросся ли пожар (≥6 «сгоревших гексагонов» в 10 км за 72 ч). Тест — 2025 год.
"""),
        code("""
from helios.models import edge_detector
m1 = edge_detector.train(); print(json.dumps(m1, ensure_ascii=False, indent=1))
"""),
        md("### ИИ №2 (на борту): прогноз потери связи + физика «радио vs лазер»"),
        code("""
from helios.models import link_ai
m2 = link_ai.train(); print(json.dumps(m2, ensure_ascii=False, indent=1))
from helios.comms.physics import simulate_space_link, mission_design_table
for case in [dict(), dict(xray_flux_wm2=1e-4, kp=8, rain_mm_h=12, cloud_frac=0.85)]:
    r = simulate_space_link(**case); print(case, '->', r['margins_db'], '| канал:', r['recommended_channel'], '| тревоги:', r['alert_channel'])
pd.DataFrame(mission_design_table())
"""),
        md("### ИИ №3 (Земля): прогноз пожарного риска на 1–4 недели + Time Machine, Fire DNA, сдвиг сезона, слепые зоны"),
        code("""
from helios.models import ground_forecast
m3 = ground_forecast.train()
for h, v in m3['horizons'].items():
    print(h, 'TEST AI', v['test']['ai'], '| климатология', v['test']['baseline_climatology'])
print('важность признаков:', list(m3.get('feature_importance_h1', {}).items())[:10])
"""),
        code("""
from helios.pipeline import run_analytics, forecast_now
summary = run_analytics(); show('analytics_summary')
risk = forecast_now(); risk.sort_values('p_fire', ascending=False).head(10)
"""),
        md("""
# 3. Smart Alert Delivery
Реальный пожарный день → ИИ №1 → пакеты по 24 байта → когда тревога окажется на Земле при разных схемах связи
(как сейчас / ИИ на борту + сеть станций / + станции в Казахстане / + ретранслятор на ГСО) + подтверждение другим спутником.
"""),
        code("""
from helios.comms.delivery import run_delivery_simulation
d = run_delivery_simulation()
for k, v in d['strategies'].items(): print(f'{k:32s}', 'медиана, мин:', v['all']['median_min'], '| критичные:', (v['critical'] or {}).get('median_min'))
print(d['collaborative_network'])
al = pd.read_parquet(PROCESSED / 'delivery_alerts.parquet')
colors = {'ROUTINE': 'gold', 'HIGH': 'orange', 'CRITICAL': 'red'}
plt.figure(figsize=(12, 6))
for p_, g in al.groupby('priority'): plt.scatter(g.lon, g.lat, s=10 + 30 * (p_ == 'CRITICAL'), c=colors.get(str(p_), 'gray'), label=str(p_))
plt.legend(); plt.title(f"Тревоги ИИ №1 за {d['replay_day']}"); plt.show()
"""),
        code("""
from helios.comms.scheduler import plan
pl = plan(hours=24)
pd.DataFrame([{k: b[k] for k in ('satellite','minutes_without_any_link','longest_gap_min','minutes_without_link_with_real_relays','minutes_without_link_with_relay_76E')} for b in pl['blackouts']])
"""),
        md("## Оперативный режим (свежие пожары NRT) + анализ Gemini"),
        code("""
from helios.pipeline import run_nrt
nrt = run_nrt('48h'); print(json.dumps(nrt, ensure_ascii=False, default=str, indent=1)[:2500])
from helios.analysis import cell_stats, reload; reload()
from helios.apis.gemini import analyze_region
stats = cell_stats(lat=48.34, lon=57.40); print(analyze_region(stats, 'Насколько опасно на этой неделе?')['text'])
"""),
        md("""
# 4. Весь мир: все страны, регионы и ИИ на мировых данных
Годовые архивы FIRMS «все страны» (MODIS с 2000 г., VIIRS S-NPP с 2012 г.) → Parquet → реестр постоянных источников
мира → «горящие гексагоно-сутки» H3 res 2–7 по каждому спутнику и дню/ночи → ряды по 240 странам и 4 589 регионам →
ИИ №3 (LightGBM, весь мир, H3 res 5, 1–4 недели) и ИИ №1 v2 (бортовой, весь мир). Полный архив ~7 ГБ:
для быстрого прогона на Kaggle ограничьте годы в `WORLD_YEARS` (модели тогда учатся на меньшем периоде).
"""),
        code("""
from helios.world import fetch, ingest, regions, aggregate
WORLD_YEARS = range(2000, 2026)          # например range(2018, 2026) для быстрого прогона
for y in WORLD_YEARS:
    fetch.download('modis', y)
    if y >= 2012:
        fetch.download('viirs-snpp', y)
for z in ingest.pending():
    ingest.ingest_zip(z); z.unlink()       # zip больше не нужен — экономим диск Kaggle
regions.build_regions()
print(aggregate.build_all())
"""),
        code("""
from helios.world import edge, forecast
m1w = edge.train(); print(json.dumps({k: m1w[k] for k in ('p_real', 'p_escalation', 'thresholds')}, ensure_ascii=False, indent=1))
m3w = forecast.train_all()
for v, hs in m3w['variants'].items():
    for h, r in hs.items(): print(v, h, 'ИИ', r['test']['ai'], '| сезонный алгоритм', r['test']['baseline_climatology'])
"""),
        md("""
# 5. Бортовой ИИ для любого спутника
ИИ №1 и ИИ №2 → int8 + целочисленный C99 без float, malloc и libc (5–7 КБ ПЗУ, < 200 байт стека).
Самопроверка сравнивает C с эталоном на Python бит-в-бит; кросс-компиляция — ARM Cortex-M0/M7/R5,
SPARC LEON3 (ESA), PowerPC 750 (RAD750), RISC-V. Архив `helios_onboard_c.zip` — готовый код для бортового ПО.
"""),
        code("""
from helios.onboard.export_c import export, OUT
rep = export(build=True)
print(json.dumps({k: rep[k] for k in ('ai1', 'ai2', 'selftest') if k in rep}, ensure_ascii=False, indent=1))
print(pd.DataFrame([{'target': b['target'], 'ok': b['ok'], 'ROM, bytes': b.get('rom_bytes')} for b in rep.get('cross', [])]))
shutil.make_archive('helios_onboard_c', 'zip', OUT)
"""),
        md("## Экспорт: модели и отчёты (+ выгрузка в Supabase, если заданы секреты)"),
        code("""
import shutil, os
shutil.make_archive('helios_artifacts', 'zip', 'artifacts'); print('artifacts -> helios_artifacts.zip')
if os.environ.get('SUPABASE_URL') and (os.environ.get('HELIOS_INGEST_TOKEN') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY')):
    from helios.db.supabase_sync import sync_all
    print(sync_all())
else:
    print('Supabase-секреты не заданы — выгрузку пропускаю')
"""),
    ]
    nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                       "language_info": {"name": "python", "version": "3.11"}},
          "nbformat": 4, "nbformat_minor": 5}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    return OUT


if __name__ == "__main__":
    path = build()
    print(f"notebook -> {path} ({path.stat().st_size / 1024:.0f} KB)")
