"""Заполняет docs/backend_template.html цифрами из отчётов конвейера → docs/helios_backend.html.

    python docs/render_backend_doc.py [--db-size "190 MB"]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REPORTS = ROOT / "artifacts" / "reports"
WORLD = ROOT / "data" / "processed" / "world"


def jl(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def ru_int(n) -> str:
    return f"{int(n):,}".replace(",", " ")


def ru_dec(x, nd=3) -> str:
    return f"{float(x):.{nd}f}".replace(".", ",")


def pct(x, nd=0) -> str:
    return f"{100 * float(x):.{nd}f}%".replace(".", ",")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-size", default="—")
    args = ap.parse_args()
    import polars as pl

    v: dict[str, str] = {"GENERATED": time.strftime("%d.%m.%Y"), "DB_SIZE": args.db_size}
    am = pl.read_parquet(WORLD / "agg" / "area_month.parquet")
    w = am.filter(pl.col("area") == "WORLD")
    v["DET_TOTAL"] = f"{w['n_r'].sum() / 1e6:.0f} млн"
    v["COUNTRIES"] = ru_int(am.filter(pl.col("level") == "country")["area"].n_unique())
    v["REGIONS"] = ru_int(am.filter(pl.col("level") == "region")["area"].n_unique())
    st = pl.read_parquet(WORLD / "agg" / "static_r8.parquet")
    v["STATIC_CELLS"] = ru_int(st.height)
    v["STATIC_BUFFER"] = "≈" + ru_int(round(st.height * 4.1, -3))
    v["PARQUET_GB"] = ru_dec(sum(p.stat().st_size for p in (WORLD / "det").glob("*.parquet")) / 2**30, 1)

    rows = []
    desc = {7: "≈5 км², ближний масштаб", 6: "≈36 км², статистика районов и календарь", 5: "≈252 км², прогноз ИИ №3",
            4: "≈1 770 км², страна целиком", 3: "≈12 400 км², континент", 2: "≈86 700 км², весь мир"}
    import duckdb

    con = duckdb.connect()
    for r in (7, 6, 5, 4, 3, 2):
        p = WORLD / "agg" / f"cellmonth_r{r}.parquet"
        if p.exists():
            n = con.execute(f"SELECT count(*) FROM read_parquet('{p.as_posix()}')").fetchall()[0][0]
            rows.append(f"<tr><td><code>cellmonth_r{r}</code></td><td class=\"num\">{ru_int(n)}</td><td>гексагоны H3 res {r}, {desc[r]}</td></tr>")
    p = WORLD / "agg" / "cellday_r7.parquet"
    n = con.execute(f"SELECT count(*) FROM read_parquet('{p.as_posix()}')").fetchall()[0][0]
    rows.insert(0, f"<tr><td><code>cellday_r7</code></td><td class=\"num\">{ru_int(n)}</td><td>горящие гексагоно-сутки: маска потоков, шум, FRP</td></tr>")
    rows.append(f"<tr><td><code>area_month</code></td><td class=\"num\">{ru_int(am.height)}</td><td>ряды по миру, странам и регионам</td></tr>")
    v["AGG_ROWS"] = "\n      ".join(rows)

    m3 = jl(REPORTS / "world_ai3_metrics.json")
    if m3:
        v["AI3_CELLS"] = ru_int(m3["cells"])
        full = m3["variants"]["full"]
        v["AI3_FULL_H1_ROC"] = ru_dec(full["h1"]["test"]["ai"]["roc_auc"])
        v["AI3_BASE_RATE"] = "доля пожаров " + pct(full["h1"]["test"]["base_rate"], 1) + " из " + ru_int(full["h1"]["test"]["rows"])
        out = []
        for variant, label in (("full", "полная"), ("oper", "оперативная")):
            for h, r in m3["variants"].get(variant, {}).items():
                a, b = r["test"]["ai"], r["test"]["baseline_climatology"]
                out.append(f"<tr><td>{label}, {h[1:]} нед.</td><td class=\"num win\">{ru_dec(a['roc_auc'])}</td><td class=\"num\">{ru_dec(b['roc_auc'])}</td>"
                           f"<td class=\"num win\">{ru_dec(a['pr_auc'])}</td><td class=\"num\">{ru_dec(b['pr_auc'])}</td>"
                           f"<td class=\"num\">{pct(a['top10_capture'])} (сезон {pct(b['top10_capture'])})</td></tr>")
        v["AI3_ROWS"] = "\n      ".join(out)
        names = {"KZ": "Казахстан", "RU": "Россия", "BR": "Бразилия", "AU": "Австралия", "US": "США", "CD": "ДР Конго",
                 "AO": "Ангола", "IN": "Индия", "ID": "Индонезия", "CA": "Канада", "AR": "Аргентина", "ZM": "Замбия"}
        cr = []
        for code, r in full["h1"].get("by_country", {}).items():
            cr.append(f"<tr><td>{names.get(code, code)}</td><td class=\"num win\">{ru_dec(r['ai_pr_auc'])}</td>"
                      f"<td class=\"num\">{ru_dec(r['clim_pr_auc'])}</td><td class=\"num\">{ru_dec(r['ai_roc_auc'])}</td></tr>")
        v["AI3_COUNTRY_ROWS"] = "\n      ".join(cr)
    tm = jl(WORLD / "forecast" / "time_machine.json") or []
    if tm:
        better = sum(1 for s in tm if s["horizons"].get("1") and s["horizons"]["1"]["ai"]["pr_auc"] > s["horizons"]["1"]["baseline"]["pr_auc"])
        ex = tm[0]["horizons"].get("1")
        v["TM_LINE"] = (f"Из {len(tm)} дат 2024–2025 годов ИИ точнее сезонного алгоритма в {better} (горизонт неделя); например, на "
                        f"{tm[0]['as_of']} PR-AUC {ru_dec(ex['ai']['pr_auc'])} против {ru_dec(ex['baseline']['pr_auc'])}." if ex else "")
    else:
        v["TM_LINE"] = ""

    a1 = jl(REPORTS / "ai1_world_metrics.json")
    if a1:
        v.update({"AI1_PARAMS": ru_int(a1["model"]["parameters"]), "AI1_HIST": str(a1["history_until"]),
                  "AI1_TRAIN": f"{a1['train_years'][0]}–{a1['train_years'][1]}", "AI1_TEST": f"{a1['test_years'][0]}–{a1['test_years'][1]}",
                  "AI1_NTEST": ru_int(a1["n_test"]), "AI1_REAL_ROC": ru_dec(a1["p_real"]["roc_auc"]),
                  "AI1_REAL_PR": ru_dec(a1["p_real"]["pr_auc"]), "AI1_REAL_BASE": ru_dec(a1["p_real"]["baseline_confidence_only_auc"]),
                  "AI1_ESC_ROC": ru_dec(a1["p_escalation"]["roc_auc"]), "AI1_ESC_PR": ru_dec(a1["p_escalation"]["pr_auc"]),
                  "AI1_ESC_BASE": ru_dec(a1["p_escalation"]["baseline_frp_only_auc"]),
                  "AI1_TH_CRIT": ru_dec(a1["thresholds"]["critical"], 2), "AI1_TH_HIGH": ru_dec(a1["thresholds"]["high"], 2)})
    a2 = jl(REPORTS / "ai2_link_metrics.json")
    if a2:
        v.update({"AI2_RECALL": pct(a2["ai"]["early_warning_recall_at_5pct_false_alarms"]),
                  "AI2_RULE_RECALL": pct(a2["baseline_margin_rule"]["early_warning_recall_at_5pct_false_alarms"]),
                  "AI2_ROC": ru_dec(a2["ai"]["roc_auc"]), "AI2_RULE_ROC": ru_dec(a2["baseline_margin_rule"]["roc_auc"])})

    oc = jl(ROOT / "artifacts" / "onboard_c" / "report.json")
    if oc:
        where = {"ARM Cortex-M0": "бортовые компьютеры кубсатов", "ARM Cortex-M7": "радиационно-стойкие SAMRH71 / SAMV71",
                 "ARM Cortex-R5": "TI Hercules, Xilinx Zynq UltraScale+", "SPARC LEON3": "ESA GR712RC и спутники ЕКА",
                 "PowerPC 750": "RAD750 (Curiosity, JWST, многие NASA)", "RISC-V RV32IMC": "NOEL-V и новые бортовые SoC",
                 "x86-64 Linux": "бортовой Linux и наземные станции"}
        roms = [b["rom_bytes"] for b in oc.get("cross", []) if b.get("ok")]
        v["ONBOARD_ROM"] = f"{ru_dec(min(roms) / 1024, 1)}–{ru_dec(max(roms) / 1024, 1)} КБ" if roms else "—"
        v["ONB_ROWS"] = "\n      ".join(
            f"<tr><td>{b['target'].split(' (')[0]}</td><td>{where.get(b['target'].split(' (')[0], '')}</td><td class=\"num\">{ru_int(b['rom_bytes'])}</td></tr>"
            for b in oc.get("cross", []) if b.get("ok"))
        stt = oc.get("selftest", {})
        v.update({"ONB_VECTORS": ru_int(stt.get("vectors", 0)), "ONB_MISMATCH": ru_int(stt.get("bit_exact_mismatches", 0)),
                  "ONB_AI1_ERR": ru_dec(oc["ai1"]["mean_abs_err"], 4), "ONB_AI2_ERR": ru_dec(oc["ai2"]["mean_abs_err"], 4),
                  "ONB_AI1_AGREE": pct(oc["ai1"]["priority_agreement"], 1),
                  "ONB_AI2_AGREE": pct(oc["ai2"]["decision_agreement_at_0.5"], 1)})

    d = jl(REPORTS / "delivery_summary.json")
    if d:
        lab = {"A_today_nrt": "Как сейчас (NASA NRT, задержка гранул по CMR)", "B_onboard_ai_store_forward": "ИИ №1 на борту + ближайшая станция сети NASA/ESA",
               "C_plus_kz_direct_stations": "+ станции прямого приёма в Казахстане", "D1_plus_real_geo_relays": "+ ретрансляторы на ГСО (TDRS / LCRD)",
               "D2_plus_geo_relay_76E": "+ ретранслятор над Индийским океаном"}

        def fmt_min(m):
            return f"{ru_dec(m * 60, 1)} с" if m < 1 else f"{ru_int(round(m))} мин"
        v["DELIVERY_ROWS"] = "\n      ".join(f"<tr><td>{lab[k]}</td><td class=\"num\">{fmt_min(s['all']['median_min'])}</td></tr>"
                                            for k, s in d["strategies"].items() if k in lab)
        v["DELAY_A"] = ru_int(round(d["strategies"]["A_today_nrt"]["all"]["median_min"]))
        v["DELAY_B"] = ru_int(round(d["strategies"]["B_onboard_ai_store_forward"]["all"]["median_min"]))
        v["DELIVERY_DAY"], v["DELIVERY_ALERTS"] = d["replay_day"], ru_int(d["alerts"])
        cn = d["collaborative_network"]
        v["DELIVERY_CONFIRM"] = (f"{pct(cn['confirmed_by_other_satellite_12h'])} критичных тревог подтвердил другой спутник "
                                 f"в течение 12 часов, медиана — через {ru_int(round(cn['median_minutes_to_confirmation']))} мин."
                                 if cn.get("confirmed_by_other_satellite_12h") is not None else "")
    html = (ROOT / "docs" / "backend_template.html").read_text(encoding="utf-8")
    missing = sorted(set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", html)) - set(v))
    for k, val in v.items():
        html = html.replace("{{" + k + "}}", val)
    html = re.sub(r"\{\{[A-Z0-9_]+\}\}", "—", html)
    out = ROOT / "docs" / "helios_backend.html"
    out.write_text(html, encoding="utf-8")
    print(f"{out} ({len(html) // 1024} KB); без данных: {missing}")


if __name__ == "__main__":
    main()
