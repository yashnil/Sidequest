#!/usr/bin/env python3
# =============================================================================
# 13-sky-climate.py — monthly cloud cover and wind normals at destination points
# =============================================================================
#
# Offline atlas build. For every input point it writes the measured 1981–2010
# monthly normal of total cloud cover and of near-surface wind speed where
# people stay. No model, no network at sampling time: 24 GeoTIFFs on disk.
#
#   PY=.atlas-cache/venv-sky/bin/python        # miniforge 3.12 + rasterio, see below
#   $PY -I packages/atlas/build/13-sky-climate.py --download            # once, 4.9 GB
#   $PY -I packages/atlas/build/13-sky-climate.py \
#       --points .atlas-cache/work/points.ndjson \
#       --out    .atlas-cache/work/sky-climate.ndjson  [--cache .atlas-cache]
#
#   The interpreter needs numpy, scipy, netCDF4 (all in the miniforge base) and
#   rasterio (not in it):
#     /Users/…/miniforge3/bin/python3.12 -m venv --system-site-packages .atlas-cache/venv-sky
#     .atlas-cache/venv-sky/bin/pip install rasterio
#
# Input line : {"id": str, "lat": num, "lng": num, "radiusKm": num}
# Output line: one per input line, same order —
#   {"id",
#    "cloud": [12] | null,      total cloud cover, percent of sky, Jan…Dec, integer
#    "wind":  [12] | null,      mean 10 m wind speed, m/s, Jan…Dec, 1 decimal
#    "at":    {"lat","lng","snapped": bool} | null}   where the two were read
#   An array is twelve numbers or null — never a zero or a fill value standing
#   in for missing data.
#
# -----------------------------------------------------------------------------
# DATA SOURCE ([file] = read from the files with rasterio; [not in file] = from
# the publisher's documentation)
# -----------------------------------------------------------------------------
#
# CHELSA V2.1 monthly climatologies 1981–2010, variables `clt` and `sfcWind`,
#   raw/chelsa/CHELSA_{clt,sfcWind}_{01..12}_1981-2010_V.2.1.tif
#   https://os.zhdk.cloud.switch.ch/chelsav2/GLOBAL/climatologies/1981-2010/{clt,sfcWind}/
#   (The netCDF folder the temperature and precipitation files came from holds
#   only pr, tas, tasmax and tasmin; these two exist as GeoTIFF only.)
#
#   clt — total cloud area fraction
#   [file] GeoTIFF, uint16, one band, 14401 × 7201, deflate, one-row strips,
#          nodata 65535, band scale 0.01, offset 0, no units tag. Step
#          0.02499999° (90 arc-seconds, ~2.8 km) — three times coarser than the
#          30″ temperature grid. Origin (cell edge) -180.024856, 89.999928:
#          the grid spans 360.025°, so its first and last columns are the same
#          meridian. NORTH-FIRST. 12 files, 0.71 GB.
#   [file] GLOBAL: the open ocean and Antarctica hold values (mid-Pacific,
#          North Atlantic and 80°S all read real numbers), so validity cannot
#          tell land from sea.
#   [verified] percent = raw × 0.01. London January raw 5184 → 52 %, July 37 %;
#          Cairo July 3 %; Mumbai January 8 %, July 64 %; Singapore January 61 %.
#   [not in file] "Total cloud area fraction (reported as a percentage) for the
#          whole atmospheric column" — a mean over all hours, day and night.
#
#   sfcWind — near-surface (10 m) wind speed
#   [file] GeoTIFF, uint16, one band, 43200 × 20880, deflate, one-row strips,
#          nodata 65535, band scale 0.001, offset 0, no units tag. The same
#          30″ grid as the CHELSA netCDF files (origin -180.00013888885,
#          83.99986041515, step 0.0083333333°), NORTH-FIRST. 12 files, 4.15 GB.
#   [file] LAND ONLY: the open ocean and Antarctica are nodata. A coastal ETOPO
#          land cell can therefore be a wind fill cell; see `at` below.
#   [verified] m/s = raw × 0.001. London January 3.4, July 2.6; Wellington 4.1 /
#          3.9; Reykjavik 4.5 / 3.5; Cairo 1.9; Singapore 2.9 / 2.3.
#
#   [not in file] Licence, per https://www.chelsa-climate.org/datasets/chelsa_climatologies
#          (the dataset page for V2.1): "Creative Commons Zero - No Rights
#          Reserved (CC0 1.0)". Citation asked for: Karger, D.N., Conrad, O.,
#          Böhner, J., Kawohl, T., Kreft, H., Soria-Auza, R.W., Zimmermann,
#          N.E., Linder, H.P., Kessler, M. (2021) Climatologies at high
#          resolution for the earth's land surface areas. EnviDat.
#          doi:10.16904/envidat.228; and Karger et al. (2017) Scientific Data 4,
#          170122. The files themselves carry no licence and no citation tag.
#
# Also in that bucket and NOT taken: `hurs` (relative humidity, 4.16 GB) and
#   `rsds` (surface shortwave, 4.89 GB). Neither is cheap, and cloud cover
#   already carries what rsds would add for a sky.
#
# -----------------------------------------------------------------------------
# DEFINITIONS — the sea handling is stage 05's, reused not re-derived
# -----------------------------------------------------------------------------
#
# This script loads `05-rasters.py` from beside itself and calls its functions:
# the ETOPO/OISST connectivity SEA RULE (`build_sea_mask`) and the `base`
# choice (`terrain_pass`) are the same code that wrote rasters.ndjson, so a
# point's cloud and wind are read where its temperature and rain were read.
#
# at.   The centre point when its ETOPO cell is land; otherwise the nearest
#   land cell within 30 km (`snapped: true`). Then, because sfcWind is land-only
#   on CHELSA's own coastline: when that cell has no January wind value, the
#   nearest land cell within 30 km that has one. A centre reads the single
#   raster cell containing the point; a snapped cell reads the raster cells
#   under four quarter-offsets of the ETOPO cell and averages the valid ones.
# wind. Twelve values at `at`, or null when no land cell with wind data lies
#   within 30 km (open-sea reefs, sandbanks, Antarctica, north of 84°N).
# cloud. Twelve values at `at`. Cloud cover is global, so when a point has no
#   land within 30 km it is read at the point itself (`at.snapped` false) and
#   only `wind` is null. null only at the exact North Pole (the grid's top edge).
#
# -----------------------------------------------------------------------------
# KNOWN LIMITS
# -----------------------------------------------------------------------------
#
# * Cloud cover is the all-hours mean. Night-time cloud is what stargazing and
#   aurora need and it differs where there is a strong daily cycle (afternoon
#   convection over tropical land clears at night; marine stratus thickens).
# * A monthly mean cloud fraction is not a count of clear nights: 50 % can be
#   half the nights clear or every night half covered.
# * The cloud grid is 2.8 km and its registration is known only to about half a
#   cell; it does not resolve a valley under a single fog bank.
# * sfcWind is a downscaled reanalysis mean speed at 10 m. It says nothing
#   about gusts and under-reads exposed ridges and passes.
# * Wind at sea is NOT here (the raster is land-only): a coastal point reports
#   the wind over its land, not over the water in front of it.
#
# -----------------------------------------------------------------------------
# SEA STATE (--waves) — separate mode, separate output
# -----------------------------------------------------------------------------
#
#   $PY -I packages/atlas/build/13-sky-climate.py --waves \
#       --points .atlas-cache/work/points.ndjson \
#       --out    .atlas-cache/work/waves.ndjson
#
# Output: one line per COASTAL point only (sea within 60 km, stage 05's sea rule
# and distance, the same condition under which it reads a sea temperature) —
#   {"id", "coastKm", "at": {"lat","lng","km"}, "hs": [12 numbers or nulls]}
#   hs = mean significant wave height, metres, Jan…Dec, 2 decimals; a null month
#   is one the cell has no value in (sea ice). `at` is the WAVERYS cell used and
#   km its distance from the nearest sea cell: a large km means a sheltered water
#   the 0.2° grid does not resolve, whose real waves are smaller.
#
# Source: Copernicus Marine WAVERYS climatology 1993–2021, 0.2°, variable VHM0
#   (int16, scale 0.01, fill -32767, metres; 899 × 1800, longitude -180…179.8):
#   raw/waverys/WAVERYSv1_climatology_19930101_20211231.nc, 77,716,030 bytes,
#   https://s3.waw3-1.cloudferro.com/mdl-native-14/native/GLOBAL_MULTIYEAR_WAV_001_032/cmems_mod_glo_wav_my_0.2deg-climatology_P1M-m_202311/WAVERYSv1_climatology_19930101_20211231.nc
#   The valid-cell mask varies by month with sea ice (925,792–945,486 cells; union
#   987,233), so the nearest cell is chosen from the UNION: a coast frozen in
#   winter keeps its summer waves. Searched to 75 km from the nearest sea cell.
#   Attribution: "Generated using E.U. Copernicus Marine Service Information;
#   https://doi.org/10.48670/moi-00022".
#
# Performance. Both rasters are stored as one-row deflate strips, so a file is
# read in row bands holding samples and fancy-indexed, never cell by cell.
# The sea mask is cached (work/sea-mask-60s.npz, keyed on the stage-05 source
# and its two input files) and shared with 11-nightsky.py.
# =============================================================================

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np

USER_AGENT = "SidequestAtlasBuild/0.1 (open-data research)"
CHELSA_BASE = "https://os.zhdk.cloud.switch.ch/chelsav2/GLOBAL/climatologies/1981-2010"
TIF_NAME = "CHELSA_{var}_{month:02d}_1981-2010_V.2.1.tif"

# variable → (output key, expected band scale, plausible range after scaling, digits)
VARS = {
    "clt": ("cloud", 0.01, (0.0, 100.0), 0),
    "sfcWind": ("wind", 0.001, (0.0, 40.0), 1),
}
NODATA = 65535.0

T0 = time.time()


def log(msg: str) -> None:
    sys.stderr.write(f"[13-sky-climate {time.time() - T0:7.1f}s] {msg}\n")
    sys.stderr.flush()


# -----------------------------------------------------------------------------
# Stage 05, loaded by path (its file name is not an importable identifier)
# -----------------------------------------------------------------------------

def load_stage05(here: str):
    path = os.path.join(here, "05-rasters.py")
    spec = importlib.util.spec_from_file_location("atlas_stage05_rasters", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, path


def sea_mask_cached(s5, s5_path: str, cache: str):
    """ETOPO elevation, its grid and stage 05's sea mask. The mask costs about a
    minute to flood, so it is kept bit-packed and reused while the code that
    defines it and the two files it reads are unchanged."""
    etopo = os.path.join(cache, "raw", "etopo", s5.ETOPO_FILE)
    oisst = os.path.join(cache, "raw", "oisst", s5.OISST_FILE)
    with open(s5_path, "rb") as fh:
        key = hashlib.sha1(fh.read()).hexdigest()
    key += f":{os.path.getsize(etopo)}:{os.path.getsize(oisst)}"
    elev, eg = s5.load_etopo(etopo, False)
    sst, ovalid, og = s5.load_oisst(oisst, False)
    store = os.path.join(cache, "work", "sea-mask-60s.npz")
    if os.path.exists(store):
        try:
            with np.load(store) as z:
                if str(z["key"]) == key and tuple(z["shape"]) == elev.shape:
                    sea = np.unpackbits(z["bits"])[:elev.size].reshape(elev.shape).astype(bool)
                    log(f"sea mask from cache ({int(sea.sum())} sea cells)")
                    return elev, eg, sea, sst, ovalid, og
        except Exception as err:                       # a damaged cache is rebuilt, not trusted
            log(f"sea-mask cache unreadable ({err}); rebuilding")
    sea = s5.build_sea_mask(elev, eg, ovalid, og)
    tmp = store + f".{os.getpid()}.tmp.npz"
    np.savez(tmp, key=np.asarray(key), shape=np.asarray(elev.shape), bits=np.packbits(sea))
    os.replace(tmp, store)
    return elev, eg, sea, sst, ovalid, og


# -----------------------------------------------------------------------------
# Downloads: resumable, and never trusted until three things agree
# -----------------------------------------------------------------------------

def remote_length(url: str) -> int:
    out = subprocess.run(["curl", "-sIL", "-A", USER_AGENT, "--max-time", "60", url],
                         capture_output=True, text=True).stdout
    length = None
    for line in out.splitlines():
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length is None:
        raise SystemExit(f"{url}: the server gave no Content-Length")
    return length


def fetch(url: str, dest: str) -> None:
    """curl exits 0 on a connection the server closed early, so the loop ends
    only when the size on disk equals the server's Content-Length — and the
    file is then parsed (`tiff_complete`) before anything reads it."""
    want = remote_length(url)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for _ in range(12):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        if have == want:
            break
        if have > want:
            os.remove(dest)
        subprocess.run(["curl", "-sL", "-C", "-", "-A", USER_AGENT, "--retry", "3",
                        "-o", dest, url])
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if have != want:
        raise SystemExit(f"{dest}: {have} bytes on disk, the server says {want}")
    tiff_complete(dest)
    log(f"ok {os.path.basename(dest)} {have} bytes")


def tiff_complete(path: str) -> None:
    """Refuse a truncated GeoTIFF: every strip or tile the first directory
    names must end inside the file. (Classic TIFF and BigTIFF.)"""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(16)
        if head[:2] == b"II":
            e = "<"
        elif head[:2] == b"MM":
            e = ">"
        else:
            raise SystemExit(f"{path}: not a TIFF")
        magic = struct.unpack(e + "H", head[2:4])[0]
        if magic == 42:
            big, ifd = False, struct.unpack(e + "I", head[4:8])[0]
        elif magic == 43:
            big, ifd = True, struct.unpack(e + "Q", head[8:16])[0]
        else:
            raise SystemExit(f"{path}: not a TIFF (magic {magic})")
        if ifd >= size:
            raise SystemExit(f"{path}: incomplete download — its directory lies past the end")
        fh.seek(ifd)
        n = struct.unpack(e + ("Q" if big else "H"), fh.read(8 if big else 2))[0]
        entry = 20 if big else 12
        raw = fh.read(n * entry)
        if len(raw) < n * entry:
            raise SystemExit(f"{path}: incomplete download — directory cut short")
        widths = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 16: 8, 17: 8, 18: 8}
        codes = {3: "H", 4: "I", 16: "Q", 17: "q", 18: "Q"}
        tags = {}
        for i in range(n):
            ent = raw[i * entry:(i + 1) * entry]
            tag, typ = struct.unpack(e + "HH", ent[:4])
            if tag not in (273, 279, 324, 325) or typ not in codes:
                continue
            count = struct.unpack(e + ("Q" if big else "I"), ent[4:12 if big else 8])[0]
            field = ent[12:20] if big else ent[8:12]
            nbytes = count * widths[typ]
            if nbytes <= len(field):
                data = field[:nbytes]
            else:
                off = struct.unpack(e + ("Q" if big else "I"), field)[0]
                if off + nbytes > size:
                    raise SystemExit(f"{path}: incomplete download — offset table past the end")
                here = fh.tell()
                fh.seek(off)
                data = fh.read(nbytes)
                fh.seek(here)
            tags[tag] = np.frombuffer(data, dtype=np.dtype(e + codes[typ])).astype(np.uint64)
    offs = tags.get(273, tags.get(324))
    cnts = tags.get(279, tags.get(325))
    if offs is None or cnts is None or offs.size != cnts.size or offs.size == 0:
        raise SystemExit(f"{path}: no strip or tile table")
    end = int((offs + cnts).max())
    if end > size:
        raise SystemExit(f"{path}: incomplete download — {size} bytes on disk, "
                         f"its own strip table ends at {end}")


def tif_path(cache: str, var: str, month: int) -> str:
    return os.path.join(cache, "raw", "chelsa", TIF_NAME.format(var=var, month=month))


def download_all(cache: str) -> None:
    for var in VARS:
        for m in range(1, 13):
            name = TIF_NAME.format(var=var, month=m)
            fetch(f"{CHELSA_BASE}/{var}/{name}", tif_path(cache, var, m))


# -----------------------------------------------------------------------------
# GeoTIFF sampling in row bands
# -----------------------------------------------------------------------------

class TiffSampler:
    """Samples fixed (lat, lng) positions from north-up GeoTIFFs. (row, col) is
    computed once per distinct grid from the file's own affine transform."""

    BAND_ROWS = 512

    def __init__(self, lat, lng):
        self.lat = np.asarray(lat, dtype=np.float64)
        self.lng = np.asarray(lng, dtype=np.float64)
        self._index = {}

    def _indices(self, ds):
        t = ds.transform
        key = (ds.width, ds.height, round(t.a, 12), round(t.e, 12), round(t.c, 9), round(t.f, 9))
        if key not in self._index:
            if t.b != 0.0 or t.d != 0.0 or t.a <= 0.0 or t.e >= 0.0:
                raise SystemExit(f"{ds.name}: not a north-up, unrotated grid")
            fr = (t.f - self.lat) / (-t.e)
            # Longitude in whatever convention: fold into one turn east of the
            # grid's west edge. A grid a fraction of a cell wider than 360°
            # (clt) or narrower (sfcWind, by 1e-6°) is treated as closed.
            x = np.mod(self.lng - t.c, 360.0)
            c = np.minimum(np.floor(x / t.a).astype(np.int64), ds.width - 1)
            closes = abs(ds.width * t.a - 360.0) <= 1.5 * t.a
            ok = (fr >= -1e-9) & (fr <= ds.height + 1e-9)
            if not closes:
                ok &= (x / t.a) < ds.width
            r = np.clip(np.floor(fr), 0, ds.height - 1).astype(np.int64)
            order = np.argsort(r, kind="stable")
            self._index[key] = (order, r[order], c[order], ok)
        return self._index[key]

    def sample(self, path: str, expect_scale: float):
        """Scaled values at every position; NaN on nodata or outside the grid."""
        import rasterio
        from rasterio.windows import Window

        tiff_complete(path)
        with rasterio.open(path) as ds:
            if ds.count != 1:
                raise SystemExit(f"{path}: expected one band, found {ds.count}")
            scale, offset = float(ds.scales[0]), float(ds.offsets[0])
            if abs(scale - expect_scale) > expect_scale * 1e-6 or offset != 0.0:
                raise SystemExit(f"{path}: band scale/offset are {scale}/{offset}, expected "
                                 f"{expect_scale}/0 — re-verify the encoding before trusting it")
            nodata = ds.nodata
            if nodata is None or float(nodata) != NODATA:
                raise SystemExit(f"{path}: nodata is {nodata!r}, expected {NODATA}")
            order, rows, cols, ok = self._indices(ds)
            out = np.full(self.lat.size, np.nan, dtype=np.float64)
            n, i = rows.size, 0
            while i < n:
                r0 = (int(rows[i]) // self.BAND_ROWS) * self.BAND_ROWS
                r1 = min(r0 + self.BAND_ROWS, ds.height)
                j = int(np.searchsorted(rows, r1, side="left"))
                br, bc = rows[i:j], cols[i:j]
                c0, c1 = int(bc.min()), int(bc.max()) + 1
                block = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
                vals = block[br - r0, bc - c0].astype(np.float64)
                bad = vals == NODATA
                vals = vals * scale + offset
                vals[bad] = np.nan
                out[order[i:j]] = vals
                i = j
            out[~ok] = np.nan
        return out


def checked(vals: np.ndarray, lo: float, hi: float, path: str) -> np.ndarray:
    """The files carry no units; a value outside any physical range stops the
    build rather than writing a quiet wrong number."""
    good = vals[np.isfinite(vals)]
    if good.size and (good.min() < lo - 1e-9 or good.max() > hi + 1e-9):
        raise SystemExit(f"{path}: values {good.min()}…{good.max()} are outside {lo}…{hi} — "
                         f"re-verify the encoding")
    return vals


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

WAVES_FILE = "WAVERYSv1_climatology_19930101_20211231.nc"
WAVES_COAST_KM = 60.0
WAVES_SEARCH_KM = 75.0


def write_waves(here: str, cache: str, points_path: str, out_path: str) -> int:
    s5, s5_path = load_stage05(here)
    points = s5.read_points(points_path)
    _, eg, sea, *_ = sea_mask_cached(s5, s5_path, cache)
    ds = s5.open_nc(os.path.join(cache, "raw", "waverys", WAVES_FILE))
    var = ds.variables["VHM0"]
    grid = s5.Grid(s5.coord(ds, ("latitude",)), s5.coord(ds, ("longitude",)), "WAVERYS")
    if var.getncattr("units") != "m" or var.shape[0] != 12:
        raise SystemExit("WAVERYS: expected 12 months of VHM0 in metres")
    raw = var[:]
    scale, offset = s5.scale_offset(var)
    valid = np.ones(raw.shape, dtype=bool)
    for fv in s5.fill_values(var):
        valid &= raw != fv
    hs = raw.astype(np.float64) * scale + offset
    union = valid.any(axis=0)
    ds.close()
    h_coast, h_search = s5.hav_of_km(WAVES_COAST_KM), s5.hav_of_km(WAVES_SEARCH_KM)
    tmp, stats = out_path + ".tmp", {"points": len(points), "coastal": 0, "written": 0}
    with open(tmp, "w", encoding="utf-8") as fh:
        for p in points:
            rs, cs, hav = eg.window(p["lat"], p["lng"], WAVES_COAST_KM)
            mask = sea[rs, cs] & (hav <= h_coast)
            if not mask.any():
                continue
            stats["coastal"] += 1
            k = int(np.argmin(np.where(mask, hav, np.inf)))
            coast = s5.km_of_hav(float(hav.flat[k]))
            r, c = eg.cell_of_window(rs, cs, k, mask.shape[1])
            rs2, cs2, hav2 = grid.window(float(eg.lat[r]), float(eg.lon[c]), WAVES_SEARCH_KM)
            ok = union[rs2, cs2] & (hav2 <= h_search)
            if not ok.any():
                continue
            k2 = int(np.argmin(np.where(ok, hav2, np.inf)))
            wr, wc = grid.cell_of_window(rs2, cs2, k2, ok.shape[1])
            series = [round(float(hs[m, wr, wc]), 2) + 0.0 if valid[m, wr, wc] else None
                      for m in range(12)]
            stats["written"] += 1
            fh.write(json.dumps({"id": p["id"], "coastKm": round(coast, 1),
                                 "at": {"lat": round(float(grid.lat[wr]), 3),
                                        "lng": round(float(grid.lon[wc]), 3),
                                        "km": round(s5.km_of_hav(float(hav2.flat[k2])), 1)},
                                 "hs": series},
                                ensure_ascii=False, allow_nan=False, separators=(",", ":")))
            fh.write("\n")
    os.replace(tmp, out_path)
    log("waves " + json.dumps(stats))
    return 0


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_cache = os.path.normpath(os.path.join(here, "..", "..", "..", ".atlas-cache"))
    ap = argparse.ArgumentParser(description="Sample CHELSA cloud cover and wind normals at points.")
    ap.add_argument("--points", help="input NDJSON: id, lat, lng, radiusKm")
    ap.add_argument("--out", help="output NDJSON, one line per point, same order")
    ap.add_argument("--cache", default=default_cache, help="cache root holding raw/ (default: %(default)s)")
    ap.add_argument("--download", action="store_true",
                    help="fetch the 24 GeoTIFFs (4.9 GB, resumable, verified) and exit unless --points is given")
    ap.add_argument("--waves", action="store_true",
                    help="write the coastal wave-height climatology to --out instead of cloud and wind")
    args = ap.parse_args()
    cache = os.path.abspath(args.cache)

    if args.waves:
        if not args.points or not args.out:
            ap.error("--waves needs --points and --out")
        return write_waves(here, cache, args.points, args.out)

    if args.download:
        download_all(cache)
        if not args.points:
            return 0
    if not args.points or not args.out:
        ap.error("--points and --out are required (or --download alone)")

    files = {(v, m): tif_path(cache, v, m) for v in VARS for m in range(1, 13)}
    missing = [p for p in files.values() if not os.path.exists(p)]
    if missing:
        raise SystemExit("missing CHELSA files (run with --download):\n  " + "\n  ".join(missing))
    for p in files.values():                       # fail before the long work, not after
        tiff_complete(p)

    s5, s5_path = load_stage05(here)
    points = s5.read_points(args.points)
    n = len(points)
    log(f"{n} points from {args.points}")

    elev, eg, sea, sst, ovalid, og = sea_mask_cached(s5, s5_path, cache)
    t = time.time()
    recs = s5.terrain_pass(points, elev, sea, eg, sst, ovalid, og)
    log(f"stage-05 terrain pass (base choice) done in {time.time() - t:.1f}s")

    # --- base → sample positions ------------------------------------------------
    def base_positions(i):
        kind, r, c, _ = recs[i]["base"]
        if kind == "centre":
            return [(points[i]["lat"], points[i]["lng"])]
        return s5.subcell_positions(eg, r, c)

    def wind_valid(positions, group, ngroups):
        if not positions:
            return np.zeros(ngroups, dtype=bool)
        smp = TiffSampler([p[0] for p in positions], [p[1] for p in positions])
        vals = smp.sample(files[("sfcWind", 1)], VARS["sfcWind"][1])
        return np.isfinite(s5.group_mean(vals, group, ngroups))

    # sfcWind is land-only on CHELSA's coastline: a base without a January wind
    # value moves to the nearest land cell that has one, as stage 05 would move
    # a base off a temperature fill cell.
    with_base = [i for i in range(n) if recs[i]["base"] is not None]
    pos, grp = [], []
    for g, i in enumerate(with_base):
        for q in base_positions(i):
            pos.append(q)
            grp.append(g)
    t = time.time()
    ok = wind_valid(pos, np.asarray(grp, dtype=np.int64), len(with_base))
    need = [i for g, i in enumerate(with_base) if not ok[g]]
    moved = 0
    no_wind = set()
    if need:
        cand_of, pos, grp = [], [], []
        for i in need:
            for (r, c) in s5.snap_candidates(points[i], elev, sea, eg):
                g = len(cand_of)
                cand_of.append((i, r, c))
                for q in s5.subcell_positions(eg, r, c):
                    pos.append(q)
                    grp.append(g)
        okc = wind_valid(pos, np.asarray(grp, dtype=np.int64), len(cand_of))
        chosen = {}
        for g, (i, r, c) in enumerate(cand_of):       # candidates are nearest-first
            if okc[g] and i not in chosen:
                chosen[i] = (r, c)
        for i in need:
            if i in chosen:
                r, c = chosen[i]
                recs[i]["base"] = ("snapped", r, c, float(elev[r, c]))
                moved += 1
            else:
                no_wind.add(i)                         # land, but no wind data in reach
    log(f"wind validity pass {time.time() - t:.1f}s: {len(need)} bases on a wind fill cell, "
        f"{moved} moved to land with data, {len(no_wind)} left without wind")

    # --- every sample, once -----------------------------------------------------
    pos, grp = [], []
    for i in range(n):
        if recs[i]["base"] is not None:
            for q in base_positions(i):
                pos.append(q)
                grp.append(i)
        else:
            pos.append((points[i]["lat"], points[i]["lng"]))   # cloud only: no land in reach
            grp.append(i)
    grp = np.asarray(grp, dtype=np.int64)
    ats = []
    for i in range(n):
        if recs[i]["base"] is None:
            ats.append({"lat": round(points[i]["lat"], 5), "lng": round(points[i]["lng"], 5),
                        "snapped": False})
        else:
            kind, r, c, _ = recs[i]["base"]
            if kind == "centre":
                ats.append({"lat": round(points[i]["lat"], 5), "lng": round(points[i]["lng"], 5),
                            "snapped": False})
            else:
                ats.append({"lat": round(float(eg.lat[r]), 5), "lng": round(float(eg.lon[c]), 5),
                            "snapped": True})
    has_base = np.array([rec["base"] is not None for rec in recs], dtype=bool)
    del elev, sea, recs

    smp = TiffSampler([p[0] for p in pos], [p[1] for p in pos])
    clim = {v: np.full((n, 12), np.nan) for v in VARS}
    t = time.time()
    for v, (_, scale, (lo, hi), _) in VARS.items():
        for m in range(1, 13):
            tf = time.time()
            path = files[(v, m)]
            vals = checked(smp.sample(path, scale), lo, hi, path)
            clim[v][:, m - 1] = s5.group_mean(vals, grp, n)
            log(f"  {os.path.basename(path)} {time.time() - tf:.1f}s")
    log(f"sampling done in {time.time() - t:.1f}s")
    clim["sfcWind"][~has_base] = np.nan                # a sea point has no land wind

    # --- write --------------------------------------------------------------------
    stats = {"points": n, "cloudNull": 0, "windNull": 0, "snapped": 0, "noLandWithin30km": 0}
    tmp = args.out + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        for i, p in enumerate(points):
            cloud = s5.fmt_series(clim["clt"][i], VARS["clt"][3])
            wind = s5.fmt_series(clim["sfcWind"][i], VARS["sfcWind"][3])
            stats["cloudNull"] += cloud is None
            stats["windNull"] += wind is None
            stats["snapped"] += ats[i]["snapped"]
            stats["noLandWithin30km"] += not has_base[i]
            fh.write(json.dumps({"id": p["id"], "cloud": cloud, "wind": wind, "at": ats[i]},
                                ensure_ascii=False, allow_nan=False, separators=(",", ":")))
            fh.write("\n")
    os.replace(tmp, args.out)
    log(f"wrote {args.out}")
    log("stats " + json.dumps({k: int(v) for k, v in stats.items()}))
    log(f"total wall time {time.time() - T0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
