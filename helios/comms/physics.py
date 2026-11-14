"""Физико-математическая модель связи «радио ↔ лазер» (идея ментора, честная физика).

Формулы со слайда ментора верны по форме; числа и выводы мы проверили:

1. Плазменная частота f_p ≈ 8.98·√N_e Гц. Днём N_e(F2) ~ 1e12 м⁻³ → f_p ≈ 9 МГц.
   Поглощение α ∝ N_e·ν/f². Вспышка на Солнце (рентген) «глушит» КВ-радио (3–30 МГц) на
   дневной стороне, а для X-диапазона (8 ГГц) поглощение ~1e-5 дБ — НИЧТОЖНО. Поэтому
   реальные угрозы радиоканалу S/X/Ka — это: дождь (Ka!), ионосферные мерцания у полярных
   станций при геомагнитных бурях (Kp), шум Солнца, когда оно рядом с лучом антенны.
   Лазеру ионосфера не мешает вовсе, но его режут облака и турбулентность.
   → Отсюда гибрид: радио + лазер + разнесённые станции + ретранслятор на ГСО (LCRD).
2. Дифракция: θ ≈ 1.22·λ/D. λ=1064 нм, D=15 см → 8.6 мкрад (верно).
3. Гауссов пучок: w(R) = w0·√(1+(λR/πw0²)²), P_R = P_T·η·T_atm·(1−exp(−2r²/w²)).
   100 Вт с 800 км на приёмник r=0.5 м: ~3.8 Вт оптики → ~2 Вт электричества при КПД 55%.
   Для СВЯЗИ 100 Вт не нужно: детектору хватает ~100 фотонов на бит (≈ −50 дБм на 1 Гбит/с).
4. SNR приёмника с фильтром Фабри–Перо: SNR = (M·R·P_s)² / (2qBM²F(R·P_s + R·P_bg + I_d) + 4kTB/R_L).
   Солнце прямо в поле зрения даже через фильтр 0.1 нм даёт фон ~0.05 Вт на апертуру 0.8 м² —
   поэтому в реальных терминалах есть «угол исключения Солнца».
"""

from __future__ import annotations

import math

import numpy as np

C = 299_792_458.0
K_B = 1.380649e-23
H_PLANCK = 6.62607015e-34
Q_E = 1.602176634e-19
EPS0 = 8.8541878128e-12
M_E = 9.1093837015e-31
R_E_KM = 6378.137
MU_EARTH = 398_600.4418  # км³/с²


# ============================================================ 1. Ионосфера
def plasma_frequency_hz(ne_m3: float) -> float:
    return math.sqrt(ne_m3 * Q_E ** 2 / (EPS0 * M_E)) / (2 * math.pi)


def flare_d_region_ne(xray_flux_wm2: float) -> float:
    """Электронная плотность D-слоя при вспышке (грубая масштабная модель): B1→3e8, X1→3e10 м⁻³."""
    return 3e8 * math.sqrt(max(xray_flux_wm2, 1e-8) / 1e-7)


def ionospheric_absorption_db(f_hz: float, ne_m3: float, nu_hz: float = 5e6, path_km: float = 20.0) -> float:
    """Неотклоняющее поглощение: κ = e²/(2ε0·m·c)·N·ν/(ω²+ν²) [Нп/м]."""
    omega = 2 * math.pi * f_hz
    kappa = Q_E ** 2 / (2 * EPS0 * M_E * C) * ne_m3 * nu_hz / (omega ** 2 + nu_hz ** 2)
    return 8.686 * kappa * path_km * 1000.0


# ============================================================ 2–3. Оптика пучка
def airy_half_angle_rad(lambda_m: float, d_m: float) -> float:
    return 1.22 * lambda_m / d_m


def beam_radius_m(r_m: float, lambda_m: float, w0_m: float) -> float:
    return w0_m * math.sqrt(1.0 + (lambda_m * r_m / (math.pi * w0_m ** 2)) ** 2)


def captured_fraction(r_rx_m: float, w_m: float) -> float:
    return 1.0 - math.exp(-2.0 * r_rx_m ** 2 / w_m ** 2)


def laser_received_power_w(p_t_w: float, r_m: float, lambda_m: float = 1550e-9, w0_m: float = 0.05,
                           r_rx_m: float = 0.2, eta_t: float = 0.8, eta_r: float = 0.8,
                           t_atm: float = 1.0, pointing_loss_db: float = 3.0) -> float:
    w = beam_radius_m(r_m, lambda_m, w0_m)
    return p_t_w * eta_t * eta_r * t_atm * captured_fraction(r_rx_m, w) * 10 ** (-pointing_loss_db / 10)


def atmospheric_transmission(el_deg: float, tau_zenith: float = 0.15) -> float:
    return math.exp(-tau_zenith / max(math.sin(math.radians(max(el_deg, 1.0))), 0.02))


def solar_spectral_irradiance(lambda_nm: float) -> float:
    """Спектральная освещённость Солнца у Земли, Вт/м²/нм (Планк, 5772 K)."""
    lam = lambda_nm * 1e-9
    t = 5772.0
    b = 2 * H_PLANCK * C ** 2 / lam ** 5 / (math.exp(H_PLANCK * C / (lam * K_B * t)) - 1)
    omega_sun = 6.794e-5  # телесный угол диска Солнца, ср
    return b * omega_sun * 1e-9


def optical_snr(p_signal_w: float, p_background_w: float, bandwidth_hz: float = 1e9, responsivity: float = 0.9,
                apd_gain: float = 10.0, excess_noise: float = 4.0, dark_current_a: float = 1e-9,
                temp_k: float = 300.0, r_load: float = 50.0) -> float:
    m, r = apd_gain, responsivity
    signal = (m * r * p_signal_w) ** 2
    shot = 2 * Q_E * bandwidth_hz * m ** 2 * excess_noise * (r * p_signal_w + r * p_background_w + dark_current_a)
    thermal = 4 * K_B * temp_k * bandwidth_hz / r_load
    return signal / (shot + thermal)


def photons_required_w(rate_bps: float, photons_per_bit: float = 100.0, lambda_m: float = 1550e-9) -> float:
    return photons_per_bit * H_PLANCK * C / lambda_m * rate_bps


# ============================================================ Радиоканал
# ITU-R P.838-3, горизонтальная поляризация: f, k_H, α_H
_P838 = np.array([
    [1, 0.0000259, 0.9691], [2, 0.0000847, 1.0664], [4, 0.0001071, 1.6009], [6, 0.0007056, 1.5900],
    [8, 0.004115, 1.3905], [10, 0.01217, 1.2571], [12, 0.02386, 1.1825], [15, 0.04481, 1.1233],
    [20, 0.09164, 1.0568], [25, 0.1571, 0.9991], [30, 0.2403, 0.9485], [35, 0.3374, 0.9047],
    [40, 0.4431, 0.8673],
])


def fspl_db(f_hz: float | np.ndarray, d_m: float | np.ndarray) -> np.ndarray:
    return 20 * np.log10(4 * np.pi * np.asarray(d_m) * f_hz / C)


def rain_coeffs(f_ghz: float) -> tuple[float, float]:
    lf = np.log(_P838[:, 0])
    k = float(np.exp(np.interp(np.log(f_ghz), lf, np.log(_P838[:, 1]))))
    a = float(np.interp(np.log(f_ghz), lf, _P838[:, 2]))
    return k, a


def rain_attenuation_db(f_ghz: float, rain_mm_h: np.ndarray, el_deg: np.ndarray, lat: float, alt_km: float = 0.0) -> np.ndarray:
    """ITU-R P.618 (упрощённо): γ=kR^α, наклонный путь до высоты дождя, редукция по горизонтали."""
    k, a = rain_coeffs(f_ghz)
    rain = np.maximum(np.asarray(rain_mm_h, dtype=float), 0.0)
    el = np.radians(np.maximum(np.asarray(el_deg, dtype=float), 5.0))
    h_rain = 5.0 - 0.075 * max(abs(lat) - 23.0, 0.0) + 0.36  # P.839 (старая форма)
    ls = np.maximum(h_rain - alt_km, 0.0) / np.sin(el)
    gamma = k * rain ** a
    lg = ls * np.cos(el)
    r = 1.0 / (1.0 + 0.78 * np.sqrt(np.maximum(lg * gamma, 0) / f_ghz) - 0.38 * (1 - np.exp(-2 * lg)))
    return gamma * ls * np.clip(r, 0.1, 1.5)


def fso_rain_attenuation_db(rain_mm_h: np.ndarray, el_deg: np.ndarray, lat: float, alt_km: float = 0.0) -> np.ndarray:
    """Дождь на лазере 1550 нм (ITU-R P.1814, модель Carbonneau): γ = 1.076·R^0.67 дБ/км до высоты дождя.
    Слабый дождь лазер переживает, ливень 20+ мм/ч его гасит — в отличие от S/X-диапазонов."""
    rain = np.maximum(np.asarray(rain_mm_h, dtype=float), 0.0)
    el = np.radians(np.maximum(np.asarray(el_deg, dtype=float), 5.0))
    h_rain = 5.0 - 0.075 * max(abs(lat) - 23.0, 0.0) + 0.36
    return 1.076 * rain ** 0.67 * np.maximum(h_rain - alt_km, 0.0) / np.sin(el)


def cloud_attenuation_db(f_ghz: float, lwc_mm: np.ndarray, el_deg: np.ndarray) -> np.ndarray:
    """ITU-R P.840 (упрощённо): A = K_l(f)·L / sin(el), K_l ≈ 6e-4·f² дБ/мм."""
    return 6e-4 * f_ghz ** 2 * np.asarray(lwc_mm) / np.sin(np.radians(np.maximum(el_deg, 5.0)))


def gas_attenuation_db(f_ghz: float, el_deg: np.ndarray, rh: np.ndarray) -> np.ndarray:
    zenith = 0.035 + 0.0025 * f_ghz + (0.25 * np.exp(-((f_ghz - 22.2) / 6) ** 2) + 0.004 * f_ghz) * np.asarray(rh) / 100
    return zenith / np.sin(np.radians(np.maximum(el_deg, 5.0)))


def scintillation_s4(f_ghz: float, kp: np.ndarray, geomag_lat: float) -> np.ndarray:
    """Индекс мерцаний S4: L-диапазон ~0.05 в спокойствие, до ~0.6 в бурю у полярных станций; ∝ f^-1.5."""
    kp = np.asarray(kp, dtype=float)
    gm = abs(geomag_lat)
    zone = 1.0 if gm >= 60 else (0.35 if gm >= 50 else (0.6 if gm <= 20 else 0.15))
    s4_l = zone * (0.05 + 0.55 / (1 + np.exp(-(kp - 6.0) * 1.2)))
    return s4_l * (1.575 / f_ghz) ** 1.5


def scintillation_fade_db(s4: np.ndarray, rng: np.random.Generator | None = None) -> np.ndarray:
    """Мгновенное замирание по Накагами-m (m = 1/S4²); без rng — 99%-ная глубина ≈ 27.5·S4^1.26."""
    s4 = np.clip(np.asarray(s4, dtype=float), 1e-3, 1.0)
    if rng is None:
        return 27.5 * s4 ** 1.26 / 2
    m = np.maximum(1.0 / s4 ** 2, 0.5)
    power = rng.gamma(shape=m, scale=1.0 / m)
    return np.maximum(-10 * np.log10(np.maximum(power, 1e-4)), 0.0)


def solar_noise_increase_db(f_ghz: float, sep_deg: np.ndarray, dish_m: float, f107: float, xray_flux: float,
                            t_sys_k: float = 150.0) -> np.ndarray:
    """Рост шумовой температуры, когда Солнце рядом с лучом антенны (радиовсплески при вспышках)."""
    lam = C / (f_ghz * 1e9)
    bw = 70 * lam / dish_m  # ширина луча по половинной мощности, °
    t_quiet = 6000 + 1.2e5 * (2.8 / f_ghz) ** 1.8 * (f107 / 100.0)  # яркостная температура диска, К
    burst = 1 + 200 * max(xray_flux / 1e-4, 0) * (2.8 / f_ghz) ** 1.5  # X1 → x200 на S-диапазоне
    fill = min(1.0, (0.53 / bw) ** 2)
    gain = np.exp(-4 * math.log(2) * (np.asarray(sep_deg) / bw) ** 2)
    dt = t_quiet * burst * fill * gain
    return 10 * np.log10(1 + dt / t_sys_k)


# Параметры каналов «тяжёлых данных»: частота, ЭИИМ спутника, скорость, требуемое Eb/N0, Tсист.
# Подобраны так, чтобы запас при угле места 5° на 11-м антенне был ~6 дБ (типовой проектный запас).
RF_CHANNELS = {
    "S": {"f_ghz": 2.25, "eirp_dbw": 0.0, "rate_bps": 20e6, "ebn0_req_db": 4.0, "t_sys_k": 150.0},
    "X": {"f_ghz": 8.2, "eirp_dbw": 10.0, "rate_bps": 150e6, "ebn0_req_db": 4.5, "t_sys_k": 150.0},
    "Ka": {"f_ghz": 26.5, "eirp_dbw": 19.0, "rate_bps": 600e6, "ebn0_req_db": 5.0, "t_sys_k": 250.0},
}
# Короткие пакеты тревоги идут в робастном режиме на низкой скорости → запас больше на 10·lg(R/R_alert)
ALERT_RATE_BPS = 64e3


def alert_gain_db(channel: str) -> float:
    rate = OPTICAL["rate_bps"] if channel == "OPT" else RF_CHANNELS[channel]["rate_bps"]
    return 10 * math.log10(rate / ALERT_RATE_BPS)


def g_over_t_db(f_ghz: float, dish_m: float, eff: float = 0.6, t_sys_k: float = 150.0) -> float:
    lam = C / (f_ghz * 1e9)
    gain = 10 * math.log10(eff * (math.pi * dish_m / lam) ** 2)
    return gain - 10 * math.log10(t_sys_k)


def rf_margin_db(band: str, range_km: np.ndarray, el_deg: np.ndarray, dish_m: float, lat: float, alt_km: float,
                 rain_mm_h: np.ndarray, lwc_mm: np.ndarray, rh: np.ndarray, kp: np.ndarray, geomag_lat: float,
                 sun_sep_deg: np.ndarray, f107: float = 120.0, xray_flux: float = 1e-7,
                 rng: np.random.Generator | None = None, scint_mult: np.ndarray | float = 1.0) -> np.ndarray:
    """Запас радиолинии (дБ) = Eb/N0(принятое) − Eb/N0(требуемое)."""
    ch = RF_CHANNELS[band]
    f = ch["f_ghz"]
    losses = (
        fspl_db(f * 1e9, np.asarray(range_km) * 1000)
        + rain_attenuation_db(f, rain_mm_h, el_deg, lat, alt_km)
        + cloud_attenuation_db(f, lwc_mm, el_deg)
        + gas_attenuation_db(f, el_deg, rh)
        + scintillation_fade_db(scintillation_s4(f, kp, geomag_lat), rng) * scint_mult
        + 1.5  # поляризация, наведение, реализация
    )
    noise_rise = solar_noise_increase_db(f, sun_sep_deg, dish_m, f107, xray_flux, ch["t_sys_k"])
    cn0 = ch["eirp_dbw"] - losses + g_over_t_db(f, dish_m, t_sys_k=ch["t_sys_k"]) - noise_rise + 228.6
    return cn0 - 10 * np.log10(ch["rate_bps"]) - ch["ebn0_req_db"]


# ============================================================ Лазерные каналы
OPTICAL = {"lambda_m": 1550e-9, "p_t_w": 2.0, "w0_m": 0.05, "rate_bps": 1.2e9, "photons_per_bit": 100.0}


def optical_ground_margin_db(range_km: np.ndarray, el_deg: np.ndarray, cloud_frac: np.ndarray, aperture_m: float,
                             sun_sep_deg: np.ndarray, rng: np.random.Generator | None = None,
                             rain_mm_h: np.ndarray | float = 0.0, lat: float = 46.0, alt_km: float = 0.0) -> np.ndarray:
    """Запас оптической линии «спутник/ГСО → наземная станция»: облака режут линию почти полностью, ливень — тоже."""
    o = OPTICAL
    rng_m = np.asarray(range_km, dtype=float) * 1000
    lam, w0 = o["lambda_m"], o["w0_m"]
    w = w0 * np.sqrt(1 + (lam * rng_m / (np.pi * w0 ** 2)) ** 2)
    capture = 1 - np.exp(-2 * (aperture_m / 2) ** 2 / w ** 2)
    el = np.maximum(np.asarray(el_deg, dtype=float), 1.0)
    t_atm = np.exp(-0.12 / np.sin(np.radians(el)))
    turb_db = 1.0 + 6.0 * np.exp(-(el - 5) / 12)  # турбулентность хуже у горизонта
    cloud = np.asarray(cloud_frac, dtype=float)
    # оптически толстое облако ослабляет лазер на 60–120 дБ: линия просто «закрыта»
    if rng is None:
        cloud_db = 150.0 * np.clip((cloud - 0.5) / 0.3, 0, 1)
    else:
        n = len(np.atleast_1d(cloud))
        cloud_db = np.where(rng.random(n) < cloud, rng.uniform(60.0, 120.0, n), 0.0)
    rain_db = fso_rain_attenuation_db(rain_mm_h, el, lat, alt_km)
    p_rx = o["p_t_w"] * 0.64 * t_atm * capture * 10 ** (-(3.0 + turb_db + cloud_db + rain_db) / 10)
    sun_pen = np.where(np.asarray(sun_sep_deg) < 3.0, 10.0, 0.0)  # угол исключения Солнца
    need = photons_required_w(o["rate_bps"], o["photons_per_bit"], lam)
    return 10 * np.log10(np.maximum(p_rx, 1e-30) / need) - sun_pen


def isl_optical_margin_db(range_km: np.ndarray, sun_sep_deg: np.ndarray, rx_aperture_m: float = 0.108) -> np.ndarray:
    """Межспутниковый лазер LEO→ГСО (как ILLUMA-T→LCRD): вакуум, только дифракция и наведение."""
    o = OPTICAL
    rng_m = np.asarray(range_km, dtype=float) * 1000
    w = o["w0_m"] * np.sqrt(1 + (o["lambda_m"] * rng_m / (np.pi * o["w0_m"] ** 2)) ** 2)
    p_rx = o["p_t_w"] * 0.64 * (1 - np.exp(-2 * (rx_aperture_m / 2) ** 2 / w ** 2)) * 10 ** (-4.0 / 10)
    need = photons_required_w(o["rate_bps"], o["photons_per_bit"], o["lambda_m"])
    return 10 * np.log10(p_rx / need) - np.where(np.asarray(sun_sep_deg) < 5.0, 15.0, 0.0)


# ============================================================ Проектирование миссии
def orbital_period_min(alt_km: float) -> float:
    a = R_E_KM + alt_km
    return 2 * math.pi * math.sqrt(a ** 3 / MU_EARTH) / 60


def aperture_for_gsd_m(gsd_m: float, alt_km: float, wavelength_um: float) -> float:
    """Минимальный диаметр объектива по дифракции: D = 1.22·λ·H / GSD."""
    return 1.22 * wavelength_um * 1e-6 * alt_km * 1000 / gsd_m


def swath_km(alt_km: float, max_scan_deg: float) -> float:
    """Ширина полосы обзора на сферической Земле для угла сканирования ±max_scan."""
    rs = R_E_KM + alt_km
    s = math.radians(max_scan_deg)
    nadir_angle = math.asin(min(1.0, rs / R_E_KM * math.sin(s)))
    return 2 * R_E_KM * (nadir_angle - s)


def max_slant_range_km(alt_km: float, min_el_deg: float) -> float:
    el = math.radians(min_el_deg)
    rs = R_E_KM + alt_km
    return -R_E_KM * math.sin(el) + math.sqrt((R_E_KM * math.sin(el)) ** 2 + rs ** 2 - R_E_KM ** 2)


def max_pass_minutes(alt_km: float, min_el_deg: float) -> float:
    el = math.radians(min_el_deg)
    rs = R_E_KM + alt_km
    central = math.acos(R_E_KM / rs * math.cos(el)) - el
    return orbital_period_min(alt_km) * (2 * central) / (2 * math.pi)


def mission_design_table() -> list[dict]:
    """Высоты орбит, на которых тепловизор «добивает» до поверхности, и нужный объектив."""
    rows = []
    for name, alt, scan in (("ISS / ECOSTRESS", 410, 25.5), ("Terra/Aqua MODIS", 705, 55.0),
                            ("Suomi-NPP / NOAA-20/21 VIIRS", 829, 56.3), ("Средняя орбита (MEO)", 8000, 10.0),
                            ("Геостационар (GOES ABI, Himawari)", 35786, 8.7)):
        rows.append({
            "orbit": name, "alt_km": alt, "period_min": round(orbital_period_min(alt), 1),
            "swath_km": round(swath_km(alt, scan), 0),
            "aperture_cm_for_375m_at_4um": round(100 * aperture_for_gsd_m(375, alt, 4.0), 1),
            "aperture_cm_for_1km_at_11um": round(100 * aperture_for_gsd_m(1000, alt, 11.0), 1),
            "aperture_cm_for_30m_at_11um": round(100 * aperture_for_gsd_m(30, alt, 11.0), 1),
            "max_pass_min_el10": round(max_pass_minutes(alt, 10), 1) if alt < 20000 else None,
            "max_range_km_el5": round(max_slant_range_km(alt, 5), 0),
        })
    return rows


# ============================================================ Симулятор «радио vs лазер»
def simulate_space_link(xray_flux_wm2: float = 1e-6, kp: float = 3.0, rain_mm_h: float = 0.0, cloud_frac: float = 0.2,
                        distance_km: float = 800.0, elevation_deg: float = 30.0, laser_power_w: float = 2.0,
                        receiver_radius_m: float = 0.2, station_geomag_lat: float = 46.0) -> dict:
    """Интерактив для сайта: условия → запасы радиолиний S/X/Ka и лазера + какой канал выбрать."""
    out = {"inputs": dict(xray_flux_wm2=xray_flux_wm2, kp=kp, rain_mm_h=rain_mm_h, cloud_frac=cloud_frac,
                          distance_km=distance_km, elevation_deg=elevation_deg, laser_power_w=laser_power_w)}
    ne = flare_d_region_ne(xray_flux_wm2)
    out["ionosphere"] = {
        "d_region_ne_m3": ne,
        "plasma_freq_F2_MHz": round(plasma_frequency_hz(1e12) / 1e6, 2),
        "absorption_db": {name: round(ionospheric_absorption_db(f, ne), 6)
                          for name, f in (("HF_10MHz", 10e6), ("S_2.25GHz", 2.25e9), ("X_8.2GHz", 8.2e9),
                                          ("laser_1550nm", C / 1550e-9))},
    }
    el, rng_km = np.array([elevation_deg]), np.array([distance_km])
    margins = {}
    for band in ("S", "X", "Ka"):
        m = rf_margin_db(band, rng_km, el, 11.0, 50.0, 0.3, np.array([rain_mm_h]), np.array([cloud_frac * 0.4 + rain_mm_h * 0.05]),
                         np.array([70.0]), np.array([kp]), station_geomag_lat, np.array([60.0]), 120.0, xray_flux_wm2)
        margins[band] = round(float(m[0]), 2)
    opt = optical_ground_margin_db(rng_km, el, np.array([cloud_frac]), 1.0, np.array([60.0]),
                                   rain_mm_h=np.array([rain_mm_h]), lat=50.0, alt_km=0.3)
    margins["laser_ground"] = round(float(opt[0]), 2)
    margins["laser_ISL_to_GEO"] = round(float(isl_optical_margin_db(np.array([38000.0]), np.array([60.0]))[0]), 2)
    out["margins_db"] = margins
    out["alert_mode_margins_db"] = {k: round(v + alert_gain_db({"laser_ground": "OPT", "laser_ISL_to_GEO": "OPT"}.get(k, k)), 1)
                                    for k, v in margins.items()}
    out["p_clear_line_of_sight_laser"] = round(1.0 - cloud_frac, 2)
    w = beam_radius_m(distance_km * 1000, 1064e-9, 0.075)
    p_opt = laser_received_power_w(laser_power_w, distance_km * 1000, 1064e-9, 0.075, receiver_radius_m,
                                   t_atm=atmospheric_transmission(elevation_deg) * (1 - min(cloud_frac, 1.0)), pointing_loss_db=0)
    out["laser_beam"] = {"spot_radius_m": round(w, 2), "divergence_urad": round(airy_half_angle_rad(1064e-9, 0.15) * 1e6, 2),
                         "optical_received_w": round(p_opt, 4), "pv_electric_w_GaAs55pct": round(0.55 * p_opt, 4)}
    # из «живых» каналов (запас > 3 дБ) берём самый быстрый: лазер > Ka > X > S
    speed = {"laser_ground": 1.2e9, "laser_ISL_to_GEO": 1.2e9, "Ka": 600e6, "X": 150e6, "S": 20e6}
    usable = [k for k, v in margins.items() if v > 3.0]
    out["recommended_channel"] = max(usable, key=lambda k: (speed[k], margins[k])) if usable else "store_and_forward"
    alert_ok = [k for k, v in out["alert_mode_margins_db"].items() if v > 3.0]
    out["alert_channel"] = max(alert_ok, key=lambda k: out["alert_mode_margins_db"][k]) if alert_ok else "store_and_forward"
    return out
