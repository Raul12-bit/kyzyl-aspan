"""Мировой архив NASA FIRMS: годовые zip «все страны», параллельная докачка частями.

Сервер FIRMS отдаёт ~80 КБ/с на одно соединение, но поддерживает HTTP Range. Поэтому файл качается
кусками по 4 МБ в несколько потоков; у каждого куска свой срок, повторы с паузой, а список готовых
кусков пишется в `.state` — после обрыва или перезапуска докачка продолжается с того же места.

    python -m helios.world.fetch              # MODIS 2011–2025 + VIIRS S-NPP 2012–2025
    python -m helios.world.fetch --noaa20     # + VIIRS NOAA-20 2018–2025
"""

from __future__ import annotations

import argparse
import json
import queue
import threading
import time
import zipfile
from pathlib import Path

import requests

from ..config import RAW
from ..utils import get_logger

log = get_logger("helios.world.fetch")

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country/zips"
GLOBAL_DIR = RAW / "global"
CHUNK = 4 * 1024 * 1024
CHUNK_DEADLINE_S = 240.0  # кусок, который «капает» дольше, перезапрашиваем новым соединением
UA = {"User-Agent": "HELIOS-SHIELD research pipeline (NASA Space Apps)"}


def jobs(noaa20: bool = False) -> list[tuple[str, int]]:
    out = [("modis", y) for y in range(2011, 2026)]
    out += [("modis", y) for y in range(2010, 1999, -1)]  # 2000–2010: только MODIS (история «26 лет»)
    out += [("viirs-snpp", y) for y in range(2025, 2011, -1)]
    if noaa20:
        out += [("viirs-jpss1", y) for y in range(2025, 2017, -1)]
    return out


def zip_path(sensor: str, year: int) -> Path:
    return GLOBAL_DIR / f"{sensor}_{year}_all_countries.zip"


def _content_length(url: str) -> int | None:
    for k in range(8):
        try:
            r = requests.head(url, timeout=30, allow_redirects=True, headers=UA)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return int(r.headers["Content-Length"])
        except Exception as e:  # сеть / 5xx — ждём и повторяем
            log.warning("HEAD %s: %s", url.rsplit("/", 1)[-1], e)
            time.sleep(min(60, 2 ** k))
    raise RuntimeError(f"HEAD не удался: {url}")


def _fetch_range(sess: requests.Session, url: str, a: int, b: int) -> bytes:
    t0 = time.time()
    buf = bytearray()
    with sess.get(url, headers={**UA, "Range": f"bytes={a}-{b}"}, timeout=(20, 60), stream=True) as r:
        if r.status_code != 206:
            raise IOError(f"HTTP {r.status_code}")
        for block in r.iter_content(256 * 1024):
            buf.extend(block)
            if time.time() - t0 > CHUNK_DEADLINE_S:
                raise TimeoutError("кусок качается слишком медленно")
    if len(buf) != b - a + 1:
        raise IOError(f"получено {len(buf)} из {b - a + 1} байт")
    return bytes(buf)


def download(sensor: str, year: int, threads: int = 8) -> Path | None:
    final = zip_path(sensor, year)
    if final.exists():
        return final
    GLOBAL_DIR.mkdir(parents=True, exist_ok=True)
    url = f"{BASE}/{final.name}"
    size = _content_length(url)
    if size is None:
        log.warning("на сервере нет %s", final.name)
        return None
    part, state_f = final.with_name(final.name + ".part"), final.with_name(final.name + ".state")
    n = (size + CHUNK - 1) // CHUNK
    done: set[int] = set()
    if part.exists() and part.stat().st_size == size and state_f.exists():
        st = json.loads(state_f.read_text())
        if st.get("size") == size:
            done = set(st["done"])
    else:
        with open(part, "wb") as f:
            f.truncate(size)
    todo: queue.Queue[int] = queue.Queue()
    for i in range(n):
        if i not in done:
            todo.put(i)
    lock = threading.Lock()
    failed: list[int] = []
    got = [0]
    t0 = time.time()
    log.info("%s: %.0f МБ, кусков %d (готово %d)", final.name, size / 2**20, n, len(done))

    with open(part, "r+b") as fh:

        def worker() -> None:
            sess = requests.Session()
            while True:
                try:
                    i = todo.get_nowait()
                except queue.Empty:
                    return
                a, b = i * CHUNK, min(size, (i + 1) * CHUNK) - 1
                for k in range(80):
                    try:
                        data = _fetch_range(sess, url, a, b)
                        with lock:
                            fh.seek(a)
                            fh.write(data)
                            done.add(i)
                            got[0] += len(data)
                            if len(done) % 4 == 0 or len(done) == n:
                                fh.flush()
                                state_f.write_text(json.dumps({"size": size, "done": sorted(done)}))
                        break
                    except Exception:
                        sess.close()
                        sess = requests.Session()
                        time.sleep(min(45, 1.5 ** min(k, 9)))
                else:
                    with lock:
                        failed.append(i)

        workers = [threading.Thread(target=worker, daemon=True) for _ in range(threads)]
        for w in workers:
            w.start()
        last = time.time()
        while any(w.is_alive() for w in workers):
            time.sleep(2)
            if time.time() - last > 60:
                last = time.time()
                el = max(time.time() - t0, 1)
                log.info("  %s: %d/%d кусков, %.2f МБ/с", final.name, len(done), n, got[0] / el / 2**20)
        fh.flush()
        state_f.write_text(json.dumps({"size": size, "done": sorted(done)}))

    if failed or len(done) != n:
        raise RuntimeError(f"{final.name}: не скачаны куски {sorted(set(range(n)) - done)[:10]}…")
    with zipfile.ZipFile(part) as z:  # центральный каталог читается — архив цел
        bad = z.testzip()
        if bad:
            raise RuntimeError(f"{final.name}: битый файл внутри архива {bad}")
    part.replace(final)
    state_f.unlink(missing_ok=True)
    el = time.time() - t0
    log.info("готово %s за %.0f с (%.2f МБ/с)", final.name, el, got[0] / max(el, 1) / 2**20)
    return final


def _job(sensor: str, year: int, threads: int) -> Path | None:
    for attempt in range(3):
        try:
            return download(sensor, year, threads)
        except Exception as e:
            log.error("%s %d: %s (попытка %d)", sensor, year, e, attempt + 1)
            time.sleep(30)
    return None


def main() -> None:
    from concurrent.futures import ThreadPoolExecutor

    ap = argparse.ArgumentParser()
    ap.add_argument("--noaa20", action="store_true")
    ap.add_argument("--threads", type=int, default=8, help="соединений на файл")
    ap.add_argument("--files", type=int, default=2, help="файлов одновременно")
    args = ap.parse_args()
    with ThreadPoolExecutor(args.files) as ex:
        list(ex.map(lambda j: _job(j[0], j[1], args.threads), jobs(args.noaa20)))
    log.info("загрузка мирового архива завершена")


if __name__ == "__main__":
    main()
