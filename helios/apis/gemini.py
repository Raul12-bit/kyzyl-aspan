"""Gemini API — текстовый анализ рисков по клику на регион (идея Kiln-Watch, своя реализация).

Принцип «модель пишет слова, числа — из пайплайна»: в промпт уходит готовая
статистическая сводка (JSON), и модели запрещено придумывать цифры. Без ключа
GEMINI_API_KEY работает офлайн-аналитик по шаблону (ответ того же формата).
"""

from __future__ import annotations

import json
from typing import Any

from ..config import env, settings
from ..utils import get_logger

log = get_logger("helios.gemini")

SYSTEM_PROMPT = """Ты — аналитик системы HELIOS-SHIELD (гармонизированные данные пожаров NASA MODIS + VIIRS).
Правила:
- Используй ТОЛЬКО числа из JSON-сводки. Ничего не придумывай и не экстраполируй.
- Пиши по-русски, кратко: вердикт (уровень риска), 3–5 пунктов «почему», 2–3 рекомендации.
- Различай природу горения: постоянные источники (факелы, заводы) — это не лесной пожар.
- Если в сводке есть слепые зоны (облачность, мало пролётов) — обязательно предупреди:
  «Недостаточно данных, возможны пропущенные очаги».
- Прогноз ИИ — это вероятность, а не гарантия; укажи качество модели, если оно есть в сводке.
- Формат Markdown: ключевые числа и уровень риска выделяй **жирным**.
"""

RISK_WORDS = [(0.15, "низкий"), (0.35, "умеренный"), (0.6, "высокий"), (1.01, "очень высокий")]


def _risk_word(p: float | None) -> str:
    if p is None:
        return "неизвестен"
    return next(word for thr, word in RISK_WORDS if p < thr)


def offline_analysis(stats: dict[str, Any]) -> str:
    """Шаблонный анализ без внешнего API (резерв, когда нет ключа или сети)."""
    p = stats.get("risk_probability_next_7d")
    lines = [f"**Уровень риска на 7 дней: {_risk_word(p)}**" + (f" (вероятность **{p:.0%}**)" if p is not None else "")]
    why = []
    if stats.get("detections_last_7d") is not None:
        why.append(f"За последние 7 дней отфильтрованных очагов: **{stats['detections_last_7d']}**.")
    if stats.get("climatology_probability") is not None:
        why.append(f"Исторически в эту неделю года пожары здесь бывают с вероятностью **{stats['climatology_probability']:.0%}**.")
    if stats.get("fire_dna"):
        dna = stats["fire_dna"]
        why.append(f"Характер горения (Fire DNA): **{dna.get('label_ru', dna.get('class'))}**, уверенность {dna.get('confidence', 0):.0%}.")
    if stats.get("weather"):
        w = stats["weather"]
        why.append(f"Погода: t° макс {w.get('t2m_max')}°C, влажность {w.get('rh2m')}%, ветер {w.get('ws10m')} м/с, осадки {w.get('precip_7d')} мм за 7 дней.")
    if stats.get("season_shift_days_per_decade") is not None:
        why.append(f"Сдвиг пика сезона: **{stats['season_shift_days_per_decade']:+.1f} дн./10 лет**.")
    lines += [f"- {w}" for w in why] or ["- Недостаточно статистики для пояснений."]
    if stats.get("blind_spot"):
        lines.append("> ⚠️ Недостаточно данных: облачность/мало пролётов. Возможны пропущенные очаги.")
    rec = ["Сверить свежие снимки VIIRS (слой GIBS) перед выездом."]
    if p is not None and p >= 0.35:
        rec.insert(0, "Предупредить лесхоз/МЧС района, проверить готовность техники.")
    if stats.get("fire_dna", {}).get("class") == "industrial":
        rec.append("Точки похожи на промышленный источник — не учитывать как лесной пожар.")
    lines.append("**Рекомендации:**")
    lines += [f"- {r}" for r in rec]
    return "\n".join(lines)


def analyze_region(stats: dict[str, Any], question: str | None = None) -> dict[str, Any]:
    """Сводка региона -> текст анализа. Возвращает {text, model, source}."""
    key = env("GEMINI_API_KEY")
    if not key:
        return {"text": offline_analysis(stats), "model": "offline-template", "source": "offline"}
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return {"text": offline_analysis(stats), "model": "offline-template", "source": "offline"}

    client = genai.Client(api_key=key)
    user = "Сводка по региону (JSON):\n" + json.dumps(stats, ensure_ascii=False, default=str)
    if question:
        user += f"\n\nВопрос пользователя: {question}"
    cfg = settings()["apis"]
    models = [env("GEMINI_MODEL", cfg["gemini_model"]), *cfg.get("gemini_fallback_models", [])]
    last_err = None
    for model in models:
        try:
            resp = client.models.generate_content(
                model=model,
                contents=user,
                config=types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT, temperature=0.3,
                                                   max_output_tokens=900),
            )
            text = (resp.text or "").strip()
            if text:
                return {"text": text, "model": model, "source": "gemini"}
        except Exception as exc:  # неверная модель/квота — пробуем следующую
            last_err = exc
            log.warning("Gemini %s: %s", model, exc)
    return {"text": offline_analysis(stats), "model": "offline-template", "source": f"offline ({last_err})"}
