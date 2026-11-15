"""Математика созвездия без модернизации спутников: прогноз обрыва, доставка на Землю, эстафета пролётов."""

import numpy as np

from helios.comms.constellation import (
    distance_to_bbox_km,
    forward_min,
    ground_arrival,
    link_forecast,
    outage_risk,
    point_passes,
    time_to_know,
)


def test_link_forecast_counts_minutes_to_drop_and_to_next_link():
    ok = np.array([True, True, True, False, False, True, True])
    drop, nxt = link_forecast(ok, step_s=30)
    assert drop[0] == 1.5 and drop[2] == 0.5  # обрыв на шаге 3
    assert nxt[3] == 1.0 and nxt[4] == 0.5     # связь вернётся на шаге 5
    assert np.isnan(drop[5]) and np.isnan(drop[6])  # до конца окна не обрывается
    assert np.isnan(nxt[0])


def test_ground_arrival_waits_for_the_next_dump_unless_broadcast_is_received():
    dump = np.array([False, False, True, False, False])
    db = np.array([False, True, False, False, False])
    arrive, path = ground_arrival(dump, db)
    assert arrive[0] == 2 and path[0] == 1   # ждёт сброса на шаге 2
    assert arrive[1] == 1 and path[1] == 2   # прямое вещание — сразу
    assert arrive[3] >= 10 ** 9 and path[3] == 0  # в окне сброса больше нет


def test_outage_risk_rises_monotonically_as_the_forecast_margin_falls():
    margins = np.linspace(10, -3, 60)
    p = outage_risk(np.zeros(60), margins, step_s=30)
    assert np.all(np.diff(p) >= -1e-12)
    assert p[0] < 0.01 and p[-1] > 0.99
    # нейросеть, которая при ливне ошибочно говорит «0», не может занизить физику
    assert outage_risk(np.array([0.0]), np.array([-1.0]), 30)[0] > 0.9


def test_forward_min_looks_only_ahead():
    x = np.array([5.0, 4.0, 9.0, 1.0, 7.0])
    assert forward_min(x, 2).tolist() == [4.0, 1.0, 1.0, 7.0, 7.0]


def test_distance_to_bbox_is_zero_inside_and_grows_outside():
    bbox = (46.4, 40.5, 87.4, 55.5)
    assert distance_to_bbox_km(np.array([48.0]), np.array([67.0]), bbox)[0] == 0
    d = distance_to_bbox_km(np.array([48.0]), np.array([40.0]), bbox)[0]
    assert 400 < d < 550  # 6.4° долготы на широте 48°


def _sim(delivery_a, delivery_b):
    """Две орбиты по меридиану 67° в. д.: точка (48, 67) под спутником A на шаге 2, под B — на шаге 6."""
    lats_a = [30, 40, 48, 56, 64, 72, 80, 85]
    lats_b = [-10, 0, 10, 20, 30, 40, 48, 56]
    track = lambda lats: [[67.0, la, 700.0] for la in lats]
    return {
        "step_s": 60,
        "satellites": [
            {"name": "A", "sensor": "VIIRS", "retired": None, "track": track(lats_a)},
            {"name": "B", "sensor": "VIIRS", "retired": None, "track": track(lats_b)},
        ],
        "delivery": [delivery_a, delivery_b],
    }


def test_another_satellite_brings_the_news_first_when_one_link_is_down():
    # A видит пожар раньше, но его данные ждут сброса 50 минут; B пролетает позже и сбрасывает сразу.
    sim = _sim([[50.0, "dump", 0, 50.0]] * 8, [[0.0, "dump", 0, 0.0]] * 8)
    passes = point_passes(sim, 48.0, 67.0)
    assert [p["name"] for p in passes] == ["A", "B"]
    only_a = time_to_know(passes, 8, {"A"})
    both = time_to_know(passes, 8)
    assert both[0] < only_a[0]  # эстафета по времени: узнаём раньше без связи между спутниками
    assert both[0] == passes[1]["ground_t"]
