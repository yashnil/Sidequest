#!/usr/bin/env python3
# =============================================================================
# 11-nightsky.py — how dark the night sky is at destination points
# =============================================================================
#
# THIS IS A MODEL, NOT A MEASUREMENT OF THE SKY. Its input is measured (satellite
# upward radiance); the zenith sky brightness is computed from it with a
# Walker-type distance law and one calibration constant. The only published
# global raster of measured-input, radiative-transfer sky brightness (Falchi et
# al. 2016) is CC BY-NC 4.0 and cannot be used in a commercial product. Nothing
# here is derived from or calibrated against it.
#
#   PY=.atlas-cache/venv-sky/bin/python          # miniforge 3.12 + rasterio
#   $PY -I packages/atlas/build/11-nightsky.py \
#       --points .atlas-cache/work/points.ndjson \
#       --out    .atlas-cache/work/nightsky.ndjson  [--cache .atlas-cache]
#
# Input line : {"id": str, "lat": num, "lng": num, "radiusKm": num}
# Output line: one per input line, same order —
#   {"id",
#    "artificial": num|null,   MODELLED artificial zenith luminance, mcd/m²
#    "sqm":        num|null,   zenith sky brightness, mag/arcsec² (higher = darker)
#    "bortle":     int|null,   APPROXIMATE Bortle class, 1…9, from sqm only
#    "radiance":   num|null,   MEASURED upward radiance of the 2.5 km cell, nW/cm²/sr
#    "darkest25":  {artificial, sqm, bortle, km, bearing}|null,
#    "darkest50":  {artificial, sqm, bortle, km, bearing}|null,
#    "median25":   {artificial, sqm, bortle}|null}
#   km/bearing say where the darkest sample lies from the point (0/null = the point).
#   null: outside the raster's 75°N–65°S (Svalbard, high Arctic, Antarctica).
#
# -----------------------------------------------------------------------------
# DATA SOURCE
# -----------------------------------------------------------------------------
#
# "The global NPP-VIIRS-like nighttime light data", Chen, Yu, Yang, Zhou, Yao,
#   Qian, Wang, Wu & Wu, Harvard Dataverse, doi:10.7910/DVN/YGIVCD, file
#   2023_HasMask_Version1.zip (206,419,377 bytes, MD5
#   2265b45991c6a1e25feec3d38c15f99b, datafile id 10186848) →
#   https://dataverse.harvard.edu/api/access/datafile/10186848  (no login)
#   Licence per the Dataverse API (`latestVersion.license`): "CC0 1.0".
#   Citation asked for by the depositors: Chen et al. (2021) ESSD 13(3):889–906.
#   [file] LongNTL_2023.tif, float32, 80151 × 31170, tiled 128², step
#          0.00449157642° (~500 m), 75.0004°N … -65.0021°, nodata -3.4e38 over
#          water (a water mask was applied by the producer). Values below about
#          1 nW/cm²/sr are zero; the file's maximum is ~508.
#
# WHY 2023 VERSION 1 AND NOT THE NEWEST FILE. Measured in this build:
#   * The 2024 files (Version 1 masked and Version 2) hold NO light north of
#     64.8°N — Tromsø, Murmansk, Fairbanks and Reykjavik read zero — and
#     understate 55–65°N (a 25 km box round Copenhagen sums to 3,057 against
#     68,514 in 2023, Stavanger 4,153 against 51,557). Their composites have no
#     usable summer-free coverage there. South of about 50°N the years agree.
#   * LongNTL_2023 has light to 75°N. Its price is a noise pedestal north of
#     about 52°N (below).
#
# -----------------------------------------------------------------------------
# METHOD
# -----------------------------------------------------------------------------
#
# 1. NOISE FLOOR. North of about 52°N the 2023 file has a pedestal of 1.0–2.0
#    nW/cm²/sr over empty land (near 100 % of cells non-zero in the empty Yukon,
#    median 1.5, 99.9th percentile 2.1; aurora and stray light). A cell below
#      floor(lat) = 2.5 × clamp((lat − 51) / 3, 0, 1)   nW/cm²/sr
#    counts as dark. The southern hemisphere has no pedestal.
# 2. AGGREGATE five raster cells to a 0.0224579° grid (~2.5 km): mean radiance.
# 3. PROPAGATE. Each cell's source strength is radiance × cell area; the
#    artificial zenith luminance at a point is
#      A = K · Σ_cells  radiance · area_km² · (d² + r0²)^(−2.5/2) · exp(−d/D)
#    d great-circle-approximate km, r0 = 1.5 km (softening), D = 100 km, summed
#    to 200 km. d^−2.5 is Walker's law (Walker 1977); the exponential stands in
#    for the steeper falloff of Garstang-type models beyond ~50 km. Convolved by
#    FFT in 1°-latitude bands so a degree of longitude has its true length.
# 4. CALIBRATE. K is computed on every run (0.04835 for this source and these
#    candidates, logged): it makes the median centre of city candidates with
#    population ≥ 5 million (133 of them) read 17.5 mag/arcsec² (published
#    zenith SQM readings in such city centres are about 16.5–18.5). The absolute
#    scale is good to roughly ±1 mag; the ORDER of places is what the data
#    supports.
# 5. sqm = 22.0 − 2.5 · log10(1 + A / 0.174). 0.174 mcd/m² = 22.0 mag/arcsec² is
#    the natural sky adopted by Falchi et al. 2016.
# 6. Bortle (APPROXIMATE; the scale is defined by what the eye sees, not by a
#    number) from common SQM equivalences: ≥21.99 → 1, ≥21.89 → 2, ≥21.69 → 3,
#    ≥20.49 → 4, ≥19.50 → 5, ≥18.94 → 6, ≥18.38 → 7, ≥17.80 → 8, else 9.
#
# Area statistics. Samples are the point and rings at 10, 25 and 50 km in eight
#   directions. Rings over sea (stage 05's ETOPO/OISST sea mask) are dropped;
#   the point itself is always kept. darkest25/median25 use the point and the
#   10 and 25 km rings; darkest50 adds the 50 km ring.
#
# -----------------------------------------------------------------------------
# KNOWN LIMITS
# -----------------------------------------------------------------------------
#
# * Everything below ~1 nW/cm²/sr is zero in the source, so dim rural light is
#   invisible and the darkest places all tie at 22.0: the top of the scale does
#   not separate a good rural sky from a pristine one.
# * VIIRS DNB does not see below about 500 nm, so blue-rich LED lighting is
#   under-counted; a city that converted to LED reads darker than it is.
# * No terrain or atmosphere: a mountain ridge does not shield a valley, and
#   altitude and aerosol do not change the answer. Light over water is masked by
#   the producer (ships and platforms are absent).
# * Not checked against ground SQM measurements in this build.
# * The depositors' CC0 is their declaration over a product derived from VIIRS
#   composites; see the build report.
# =============================================================================

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import time
import zipfile

import numpy as np
from scipy import fft as sfft

SOURCE_ZIP = "2023_HasMask_Version1.zip"
SOURCE_TIF = "LongNTL_2023.tif"
SOURCE_BYTES = 206419377
FACTOR = 5                # raster cells aggregated per side (~2.5 km)
R0_KM = 1.5
D_KM = 100.0
CUT_KM = 200.0
NATURAL_MCD = 0.174
RINGS_KM = (10.0, 25.0, 50.0)
BEARINGS = tuple(range(0, 360, 45))
EARTH_KM = 6371.0088
KM_PER_DEG = math.pi * EARTH_KM / 180.0
CALIBRATION_POP = 5_000_000
CALIBRATION_TARGET_SQM = 17.5
AGG_VERSION = "floor-2.5-51-54-v1"

T0 = time.time()


def log(msg: str) -> None:
    sys.stderr.write(f"[11-nightsky {time.time() - T0:7.1f}s] {msg}\n")
    sys.stderr.flush()


def noise_floor(lat: np.ndarray) -> np.ndarray:
    return 2.5 * np.clip((lat - 51.0) / 3.0, 0.0, 1.0)


def source_tif(cache: str) -> str:
    """The 10 GB GeoTIFF inside the archive, extracted once. rasterio's zip://
    path re-inflates from the start for every tile and took minutes a row."""
    out_dir = os.path.join(cache, "work", "tmp-nightlights", "v1_2023")
    tif = os.path.join(out_dir, SOURCE_TIF)
    if os.path.exists(tif):
        return tif
    arc = os.path.join(cache, "raw", "nightlights-chen", SOURCE_ZIP)
    if os.path.getsize(arc) != SOURCE_BYTES:
        raise SystemExit(f"{arc}: not the expected {SOURCE_BYTES} bytes")
    os.makedirs(out_dir, exist_ok=True)
    log(f"extracting {SOURCE_TIF}")
    with zipfile.ZipFile(arc) as z:
        z.extract(SOURCE_TIF, out_dir)
    return tif


def aggregate(cache: str):
    """Mean radiance on the ~2.5 km grid, floor applied at full resolution.
    Cached: returns (radiance[rows, cols], lat_top, step)."""
    store = os.path.join(cache, "work", f"nightlights-2023-agg{FACTOR}.npz")
    if os.path.exists(store):
        with np.load(store) as z:
            if str(z["version"]) == AGG_VERSION:
                log("aggregate from cache")
                return z["rad"], float(z["top"]), float(z["step"])
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(source_tif(cache)) as ds:
        t = ds.transform
        step = t.a * FACTOR
        cols = int(round(360.0 / step))
        rows = ds.height // FACTOR
        width = cols * FACTOR
        if abs(t.c + 180.0) > t.a or width > ds.width:
            raise SystemExit(f"{ds.name}: unexpected longitude layout {t.c} {ds.width}")
        rad = np.zeros((rows, cols), dtype=np.float32)
        band = 1000 * FACTOR
        for r0 in range(0, rows * FACTOR, band):
            h = min(band, rows * FACTOR - r0)
            a = ds.read(1, window=Window(0, r0, width, h))
            a[~np.isfinite(a) | (a < 0)] = 0.0
            lat = t.f + t.e * (np.arange(r0, r0 + h) + 0.5)
            a[a < noise_floor(lat)[:, None]] = 0.0
            m = a.reshape(h // FACTOR, FACTOR, cols, FACTOR).mean(axis=(1, 3))
            rad[r0 // FACTOR:r0 // FACTOR + h // FACTOR] = m
        top = t.f
    np.savez_compressed(store, rad=rad, top=top, step=step, version=np.asarray(AGG_VERSION))
    log(f"aggregated to {rad.shape}")
    return rad, top, step


def propagate(rad: np.ndarray, top: float, step: float) -> np.ndarray:
    """A / K on the same grid, by FFT, one 1°-latitude band at a time."""
    rows, cols = rad.shape
    cell_km = step * KM_PER_DEG
    lat = top - step * (np.arange(rows) + 0.5)
    src = rad.astype(np.float64) * np.cos(np.radians(lat))[:, None] * cell_km * cell_km
    pad = int(math.ceil(CUT_KM / cell_km)) + 1
    per_deg = int(round(1.0 / step))
    out = np.zeros(rad.shape, dtype=np.float32)
    for a in range(0, rows, per_deg):
        b = min(rows, a + per_deg)
        lo, hi = max(0, a - pad), min(rows, b + pad)
        size = (hi - lo) + 2 * pad
        coslat = max(0.2, math.cos(math.radians(float(lat[(a + b) // 2]))))
        dx = cell_km * coslat
        m = np.fft.fftfreq(size, 1.0 / size)            # signed integer lags
        nlag = np.minimum(np.arange(cols), cols - np.arange(cols)).astype(np.float64)
        d2 = (m[:, None] * cell_km) ** 2 + (nlag[None, :] * dx) ** 2
        d = np.sqrt(d2)
        ker = (d2 + R0_KM * R0_KM) ** -1.25 * np.exp(-d / D_KM)
        ker[d > CUT_KM] = 0.0
        res = sfft.irfft2(sfft.rfft2(src[lo:hi], s=(size, cols), workers=-1)
                          * sfft.rfft2(ker, workers=-1), s=(size, cols), workers=-1)
        out[a:b] = np.maximum(res[a - lo:b - lo], 0.0)
    return out


def destination(lat: float, lng: float, km: float, bearing: float):
    d = km / EARTH_KM
    phi, lam, th = math.radians(lat), math.radians(lng), math.radians(bearing)
    p2 = math.asin(min(1.0, max(-1.0, math.sin(phi) * math.cos(d)
                                + math.cos(phi) * math.sin(d) * math.cos(th))))
    l2 = lam + math.atan2(math.sin(th) * math.sin(d) * math.cos(phi),
                          math.cos(d) - math.sin(phi) * math.sin(p2))
    return math.degrees(p2), ((math.degrees(l2) + 180.0) % 360.0) - 180.0


def to_sqm(art):
    return 22.0 - 2.5 * np.log10(1.0 + np.asarray(art, dtype=np.float64) / NATURAL_MCD)


def bortle(sqm: float) -> int:
    for cls, lim in ((1, 21.99), (2, 21.89), (3, 21.69), (4, 20.49), (5, 19.50),
                     (6, 18.94), (7, 18.38), (8, 17.80)):
        if sqm >= lim:
            return cls
    return 9


def reading(art: float, extra=None):
    s = float(to_sqm(art))
    o = {"artificial": round(art, 4), "sqm": round(s, 2), "bortle": bortle(s)}
    if extra:
        o.update(extra)
    return o


def load_by_path(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def calibrate(glow, top, step, candidates: str):
    pops = []
    rows, cols = glow.shape
    for line in open(candidates, encoding="utf-8"):
        o = json.loads(line)
        if o.get("wvType") == "city" and (o.get("population") or 0) >= CALIBRATION_POP:
            r = int((top - o["lat"]) / step)
            c = int(((o["lng"] + 180.0) % 360.0) / step) % cols
            if 0 <= r < rows:
                pops.append(float(glow[r, c]))
    target = NATURAL_MCD * (10 ** ((22.0 - CALIBRATION_TARGET_SQM) / 2.5) - 1.0)
    med = float(np.median(pops))
    log(f"calibration: {len(pops)} cities ≥ {CALIBRATION_POP}, median raw {med:.6g}, "
        f"target {target:.4g} mcd/m² → K = {target / med:.6g}")
    return target / med


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_cache = os.path.normpath(os.path.join(here, "..", "..", "..", ".atlas-cache"))
    ap = argparse.ArgumentParser(description="Model zenith sky brightness at points.")
    ap.add_argument("--points", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=default_cache)
    args = ap.parse_args()
    cache = os.path.abspath(args.cache)

    rad, top, step = aggregate(cache)
    rows, cols = rad.shape
    t = time.time()
    glow = propagate(rad, top, step)
    log(f"propagated in {time.time() - t:.1f}s")
    k = calibrate(glow, top, step, os.path.join(cache, "work", "candidates.ndjson"))
    glow = glow * np.float32(k)            # the one calibration constant, K
    np.savez_compressed(os.path.join(cache, "work", "nightsky-model-2.5km.npz"),
                        art=glow, top=top, step=step, k=k)

    s5 = load_by_path("atlas_stage05_rasters", os.path.join(here, "05-rasters.py"))
    s13 = load_by_path("atlas_stage13_sky", os.path.join(here, "13-sky-climate.py"))
    _, eg, sea, *_ = s13.sea_mask_cached(s5, os.path.join(here, "05-rasters.py"), cache)
    points = s5.read_points(args.points)

    def cell(lat, lng):
        r = int(math.floor((top - lat) / step))
        if r < 0 or r >= rows:
            return None
        return r, int(((lng + 180.0) % 360.0) / step) % cols

    stats = {"points": len(points), "null": 0, "ringsOnSea": 0, "ringsTotal": 0}
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for p in points:
            lat, lng = p["lat"], p["lng"]
            at = cell(lat, lng)
            rec = {"id": p["id"], "artificial": None, "sqm": None, "bortle": None, "radiance": None,
                   "darkest25": None, "darkest50": None, "median25": None}
            if at is None:
                stats["null"] += 1
            else:
                art0 = float(glow[at])
                rec.update(reading(art0))
                rec["radiance"] = round(float(rad[at]), 3)
                samples = [(art0, 0.0, None)]
                for km in RINGS_KM:
                    for b in BEARINGS:
                        la, lo = destination(lat, lng, km, b)
                        stats["ringsTotal"] += 1
                        if sea[eg.row(la), eg.col(lo)]:
                            stats["ringsOnSea"] += 1
                            continue
                        c2 = cell(la, lo)
                        if c2 is not None:
                            samples.append((float(glow[c2]), km, b))
                near = [s for s in samples if s[1] <= 25.0]
                for key, pool in (("darkest25", near), ("darkest50", samples)):
                    best = min(pool, key=lambda s: (s[0], s[1]))
                    rec[key] = reading(best[0], {"km": best[1], "bearing": best[2]})
                rec["median25"] = reading(float(np.median([s[0] for s in near])))
            fh.write(json.dumps(rec, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
            fh.write("\n")
    os.replace(tmp, args.out)
    log("stats " + json.dumps(stats))
    log(f"wrote {args.out}; total {time.time() - T0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
