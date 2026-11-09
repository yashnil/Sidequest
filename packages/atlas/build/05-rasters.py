#!/usr/bin/env python3
# =============================================================================
# 05-rasters.py — sample open gridded data at destination points
# =============================================================================
#
# Stage 5 of the offline atlas build. For every input point it writes the
# measured monthly climate where people stay (`base`), the same for the high
# country above it (`high`), terrain statistics for the surrounding disc
# (`relief`) and the distance to, and temperature of, the nearest sea (`sea`).
# No model, no network: three sets of files on disk and numpy.
#
#   python3 -I packages/atlas/build/05-rasters.py \
#       --points .atlas-cache/work/points.ndjson \
#       --out    .atlas-cache/work/rasters.ndjson  [--cache .atlas-cache]
#
# Input line : {"id": str, "lat": num, "lng": num, "radiusKm": num}
# Output line: one per input line, same order —
#   {"id",
#    "base":   {"lat","lng","elevM","tmax":[12],"tmin":[12],"pr":[12]} | null,
#    "high":   {"lat","lng","elevM","tmax":[12],"tmin":[12],"pr":[12]} | null,
#    "relief": {"maxM","minLandM","meanLandM","landFrac"},
#    "sea":    {"coastKm": num|null, "sst": [12]|null}}
#   tmax/tmin in °C (1 decimal), pr in mm/month (integer), elevations in metres
#   (integer), sst in °C (1 decimal), coastKm in km (1 decimal).
#   A climate array is either twelve numbers or null — never a zero or a raw
#   fill value standing in for missing data.
#
# -----------------------------------------------------------------------------
# DATA SOURCES (facts below marked [file] were read from the files themselves
# with netCDF4, auto-scaling off; facts marked [not in file] are not carried by
# the file metadata and are stated from the publisher's documentation)
# -----------------------------------------------------------------------------
#
# 1. CHELSA V2.1 monthly climatologies 1981–2010 (tasmax, tasmin, pr), 36 files
#    raw/chelsa/CHELSA_{tasmax,tasmin,pr}_{01..12}_1981-2010_V.2.1.nc
#    [file] NetCDF-4, one variable `Band1` float32 (lat, lon) = (20880, 43200),
#           chunks 500×500, zlib level 6 + shuffle, _FillValue -2147483648.
#           lat ASCENDING (south first) -89.99597 … 83.99569, lon -179.99597 …
#           179.99569, step 0.0083333333° (30 arc-seconds); GeoTransform origin
#           -180.00013888885, 83.99986041515 (cell edges, GDAL "Area").
#           Global attributes are only GDAL/NCO processing history: the files
#           carry NO units, NO scale_factor/add_offset, NO citation and NO
#           licence attribute.
#    [file] COVERAGE IS GLOBAL, NOT LAND-ONLY: a full scan of tasmax_01 and
#           pr_01 found zero fill cells — the open ocean and Antarctica hold
#           values. CHELSA validity therefore cannot tell land from sea; the
#           ETOPO/OISST sea rule below does that. There is no data north of
#           84°N (outside the grid).
#    [verified] tasmax/tasmin are stored as Kelvin × 10 in unscaled float32
#           integers (Cairo July tasmax raw 3092 → 36.05 °C).
#           °C = raw × 0.1 − 273.15.
#    [verified] pr is stored as mm/month × 10 (kg m-2 month-1 × 10) in unscaled
#           float32 integers (London January raw 594 → 59 mm; Singapore January
#           2423 → 242 mm). mm/month = raw × 0.1. (The ×0.01 reading sometimes
#           quoted for V2.1 gives London 6 mm and is wrong for these files.)
#    [verified] pr carries an UNFLAGGED nodata sentinel: 846 cells within 0.02°
#           of the South Pole hold 65535 (the UInt16 ceiling of the source
#           raster); nothing lies between 20000 and 65535. Raw pr ≥ 65535 is
#           treated as missing.
#    [not in file] Citation: Karger, D.N., Conrad, O., Böhner, J., Kawohl, T.,
#           Kreft, H., Soria-Auza, R.W., Zimmermann, N.E., Linder, H.P. &
#           Kessler, M. (2017) Climatologies at high resolution for the earth's
#           land surface areas. Scientific Data 4, 170122,
#           doi:10.1038/sdata.2017.122; data: Karger et al., EnviDat,
#           doi:10.16904/envidat.228.v2.1. Licence per chelsa-climate.org:
#           CC0 1.0 / public domain — NOT confirmable from the file metadata.
#
# 2. ETOPO 2022 v1, 60 arc-second surface elevation
#    raw/etopo/ETOPO_2022_v1_60s_N90W180_surface.nc
#    [file] NetCDF-4 classic. `z` float32 (lat, lon) = (10800, 21600), chunks
#           1350×2700, zlib level 5 + shuffle, units "meters", positive "up",
#           standard_name "height", vert_crs_name "EGM2008" (EPSG:3855),
#           _FillValue -99999 (no fill cell present), NO scale/offset.
#           lat ASCENDING -89.99167 … 89.99167, lon -179.99167 … 179.99167,
#           step 1/60°; GeoTransform origin -180, 90 (cell edges, GDAL "Area",
#           node_offset 1). Range -10752 … 8157 m. The ocean, the Caspian and
#           the Great Lakes hold BATHYMETRY, not a water surface: the bed of
#           Lake Ontario or Lake Superior is below 0 m, the bed of Lake Erie
#           and of the shallow shelves of the others is above it.
#    [file] GDAL_TIFFTAG_COPYRIGHT "DOC/NOAA/NESDIS/NCEI > National Centers for
#           Environmental Information, NESDIS, NOAA, U.S. Department of
#           Commerce"; GDAL_TIFFTAG_IMAGEDESCRIPTION "Topography-Bathymetry;
#           EGM2008 height". No citation and no licence attribute.
#    [not in file] Citation: NOAA National Centers for Environmental
#           Information (2022): ETOPO 2022 15 Arc-Second Global Relief Model,
#           doi:10.25921/fd45-gt74. A U.S. Government work, public domain.
#
# 3. NOAA OISST v2.1 high-resolution monthly long-term mean SST 1991–2020
#    raw/oisst/sst.mon.ltm.1991-2020.nc
#    [file] NetCDF-4 classic. `sst` float32 (time, lat, lon) = (12, 720, 1440),
#           units degC, valid_range [-3, 45], missing_value -9.96921e36 over
#           land, NO scale/offset. lat ASCENDING -89.875 … 89.875; lon is
#           0–360 (0.125 … 359.875), step 0.25°. climo_period
#           "1991/01/01 - 2020/12/31". The valid mask is identical in all
#           twelve months (691,150 cells) and every valid cell is a 30-year
#           mean.
#    [file] title "NOAA/NCEI 1/4 Degree Daily Optimum Interpolation Sea Surface
#           Temperature (OISST) Analysis, Version 2.1"; institution NOAA/NCEI;
#           references Reynolds et al. (2007) doi:10.1175/2007JCLI1824.1,
#           Banzon et al. (2016) doi:10.5194/essd-8-165-2016 and Huang et al.
#           (2021). No licence attribute; NOAA data, public domain
#           [not in file]. Provided by NOAA PSL, Boulder, Colorado, USA.
#    [file] OISST has values in the Caspian Sea, the Great Lakes, Lake Ladoga,
#           the Black Sea and Sea of Azov, the Baltic, the Red Sea and the
#           Persian Gulf. It has none in the Dead Sea, the Aral Sea, Lake
#           Victoria, Lake Tanganyika, Lake Baikal, Lake Titicaca, the Great
#           Salt Lake, Lake Winnipeg, Great Bear or Great Slave Lake.
#
# -----------------------------------------------------------------------------
# DEFINITIONS
# -----------------------------------------------------------------------------
#
# SEA RULE (connectivity). WATER is an ETOPO cell at or below the local datum:
#   0 m everywhere, except the Caspian basin (lat 36–48, lng 46–56), whose
#   surface stands about 28 m below sea level and whose datum is -28.5 m. A
#   SEED is a water cell inside, or within 15 km of, the footprint of a valid
#   OISST cell. SEA is every water cell 8-connected to a seed through water
#   (scipy.ndimage.label, joined across the antimeridian). Everything else is
#   land — including ground below sea level that is not connected to seeded
#   water (the Dead Sea shore, the Sea of Galilee, Death Valley, the Turpan
#   and Qattara depressions, the Caspian lowland above -28.5 m).
#
# base.  The centre point when its ETOPO cell is land and CHELSA has data
#   there; otherwise the nearest land cell with CHELSA data within 30 km.
#   null when there is no land within 30 km. A base at the centre reads the one
#   CHELSA cell that contains the point; a snapped base reads the CHELSA cells
#   inside the ETOPO cell it snapped to.
# high.  The highest land cell of ETOPO within D = min(max(radiusKm, 10), 60)
#   km of the centre, reported only when it stands ≥ 400 m above base.elevM.
#   Its climate is the mean of the CHELSA cells inside that ETOPO cell.
# relief. Over land cells inside the same disc D; means and the land fraction
#   are weighted by cell area (cos latitude). maxM is the highest LAND cell.
#   maxM/minLandM/meanLandM are null (and landFrac 0) when the disc holds no
#   land.
# sea.coastKm. Great-circle distance from the centre to the centre of the
#   nearest sea cell within 150 km (0 when the centre's own cell is sea).
# sea.sst. Only when coastKm ≤ 60: OISST at the valid cell nearest to that sea
#   cell, searched to 75 km.
#
# -----------------------------------------------------------------------------
# KNOWN LIMITS (measured, see the build report)
# -----------------------------------------------------------------------------
#
# * The sea rule follows water inward from the open coast, so fjords, sounds
#   and channels OISST cannot see are sea as long as they stay connected at
#   60″ (a channel narrower than a cell, or a sill above 0 m, cuts them off).
#   Accepted consequences:
#   - below-sea-level ground CONTIGUOUS with the sea reads as sea: Dutch-style
#     polders, the Mississippi delta. They are at the coast anyway; it lowers
#     landFrac there and can put coastKm at a polder edge.
#   - lakes OISST does not cover are land/inland at whatever ETOPO holds: a
#     flat surface for the Dead Sea (-427 m), the Sea of Galilee, Lake Geneva,
#     Lake Victoria or Titicaca; the lake bed for Baikal (minLandM near
#     Listvyanka is about -990 m).
#   - a lake OISST does cover is sea only where its bed is at or below 0 m:
#     Chicago has no sea, Toronto has one where Lake Ontario's bed drops
#     below 0 m.
#   - the Caspian datum is one number for a basin whose level drifts by
#     decimetres a decade; shoals above -28.5 m read as land.
# * CHELSA V2.1 tasmax runs about 2–3.5 °C under station normals, and tasmin
#   over them, on small islands and tropical coasts (Honolulu, Singapore,
#   Mumbai), and 4–5 °C under in winter in some mountain basins (Queenstown,
#   Ushuaia); the mean of the two is close. Grid alignment was checked
#   against ETOPO (correlation of tasmax with elevation peaks at zero shift).
# * elevM is a 60″ cell mean: a town in a narrow valley reads high (Skardu
#   2402 m against ~2230 m, Interlaken 800 m against ~570 m).
#
# Geometry. Discs are built from a latitude/longitude window whose longitude
#   half-width is the exact half-width of the spherical cap
#   (asin(sin(d/R)/cos(lat))), wrapped across the antimeridian and widened to
#   the full circle at the poles; membership is then decided by haversine
#   distance on a sphere of radius 6371.0088 km.
#
# Performance. ETOPO (10800×21600) and OISST are held in memory. CHELSA is
#   never read cell by cell: every sample's (row, col) is computed once, then
#   each of the 36 files is read in chunk-aligned latitude bands — only bands
#   that hold samples, only their column span — and fancy-indexed.
# =============================================================================

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import numpy as np
import netCDF4

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEG = math.pi * EARTH_RADIUS_KM / 180.0

SNAP_KM = 30.0            # base: nearest land within this distance
HIGH_MIN_KM = 10.0        # disc radius is min(max(radiusKm, HIGH_MIN_KM), HIGH_MAX_KM)
HIGH_MAX_KM = 60.0
HIGH_MIN_RISE_M = 400.0   # `high` only when this far above base.elevM
COAST_SEARCH_KM = 150.0   # coastKm is null beyond this
SST_MAX_COAST_KM = 60.0   # sst only when the sea is this close
SST_SEARCH_KM = 75.0      # nearest valid OISST cell to the sea cell
SEED_KM = 15.0            # sea rule: a seed lies within this distance of a valid OISST cell
# Water-surface datum of enclosed basins that OISST covers and whose surface is
# not at 0 m: (lat_south, lat_north, lng_west, lng_east, datum_m). Everywhere
# else the datum is 0 m. The Caspian Sea stands about 28 m below global sea
# level; with a 0 m datum its whole below-sea-level lowland (Atyrau, Astrakhan)
# floods. This is a basin's physical level held as data, not a place patch.
ENCLOSED_BASIN_DATUMS = (
    (36.0, 48.0, 46.0, 56.0, -28.5),   # Caspian basin
)
SNAP_CANDIDATES = 512     # nearest land cells kept for the CHELSA-validity fallback

CHELSA_VARS = ("tasmax", "tasmin", "pr")
CHELSA_FILE = "CHELSA_{var}_{month:02d}_1981-2010_V.2.1.nc"
ETOPO_FILE = "ETOPO_2022_v1_60s_N90W180_surface.nc"
OISST_FILE = "sst.mon.ltm.1991-2020.nc"

T0 = time.time()


def log(msg: str) -> None:
    sys.stderr.write(f"[05-rasters {time.time() - T0:7.1f}s] {msg}\n")
    sys.stderr.flush()


def hav_of_km(km: float) -> float:
    """Haversine of the central angle subtended by `km` — distances are
    compared in this form so no arcsine is needed per cell."""
    return math.sin(km / (2.0 * EARTH_RADIUS_KM)) ** 2


def km_of_hav(h: float) -> float:
    return 2.0 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(max(0.0, h))))


# -----------------------------------------------------------------------------
# Regular grids, described by their own coordinate arrays
# -----------------------------------------------------------------------------

class Grid:
    """A regular lat/lng grid of cell centres. Orientation (north-first or
    south-first) and longitude convention (-180…180 or 0…360) are read from the
    coordinate arrays, never assumed."""

    def __init__(self, lat, lon, name: str):
        lat = np.asarray(lat, dtype=np.float64)
        lon = np.asarray(lon, dtype=np.float64)
        self.name = name
        self.nlat, self.nlon = int(lat.size), int(lon.size)
        self.dlat = float((lat[-1] - lat[0]) / (self.nlat - 1))   # signed
        self.dlon = float((lon[-1] - lon[0]) / (self.nlon - 1))
        if self.dlon <= 0:
            raise SystemExit(f"{name}: longitude is not ascending")
        for arr, step, what in ((lat, self.dlat, "lat"), (lon, self.dlon, "lon")):
            if np.abs(np.diff(arr) - step).max() > abs(step) * 1e-3:
                raise SystemExit(f"{name}: {what} is not a regular axis")
        self.lat, self.lon = lat, lon
        self.lat0 = float(lat[0] - self.dlat / 2.0)   # outer edge of row 0
        self.lon0 = float(lon[0] - self.dlon / 2.0)   # west edge of col 0
        # Does the longitude axis close on itself? (CHELSA spans 359.9999986°.)
        self.wraps = abs(self.nlon * self.dlon - 360.0) < self.dlon / 2.0
        # Trigonometry of the centres, for separable haversines.
        self.lat_rad = np.radians(lat)
        self.cos_lat = np.cos(self.lat_rad)
        self.lon_rad = np.radians(lon)

    def signature(self):
        return (self.nlat, self.nlon, round(self.lat0, 9), round(self.lon0, 9),
                round(self.dlat, 12), round(self.dlon, 12))

    def rows(self, lat):
        """Row index of each latitude and whether it is inside the grid."""
        f = (np.asarray(lat, dtype=np.float64) - self.lat0) / self.dlat
        ok = (f >= -1e-9) & (f <= self.nlat + 1e-9)
        return np.clip(np.floor(f), 0, self.nlat - 1).astype(np.int64), ok

    def cols(self, lng):
        """Column index of each longitude (any convention) and validity."""
        x = np.mod(np.asarray(lng, dtype=np.float64) - self.lon0, 360.0)
        c = np.floor(x / self.dlon).astype(np.int64)
        if self.wraps:
            return np.minimum(c, self.nlon - 1), np.ones(c.shape, dtype=bool)
        return np.minimum(c, self.nlon - 1), c < self.nlon

    def row(self, lat: float) -> int:
        return int(min(self.nlat - 1, max(0, math.floor((lat - self.lat0) / self.dlat))))

    def col(self, lng: float) -> int:
        return int(min(self.nlon - 1, math.floor(((lng - self.lon0) % 360.0) / self.dlon)))

    def window(self, lat: float, lng: float, radius_km: float):
        """The rows and columns that can hold a cell centre within `radius_km`
        of (lat, lng), and the haversine of every such cell's distance.

        Returns (row_slice, col_index, hav) where col_index is a slice when the
        window does not cross the grid's seam and an index array (wrapped
        modulo the grid width) when it does. hav has shape (rows, cols)."""
        ddeg = radius_km / KM_PER_DEG
        fa = (lat - ddeg - self.lat0) / self.dlat
        fb = (lat + ddeg - self.lat0) / self.dlat
        r_lo = max(0, int(math.floor(min(fa, fb))))
        r_hi = min(self.nlat - 1, int(math.floor(max(fa, fb))))
        rs = slice(r_lo, r_hi + 1)

        # Longitude half-width of a spherical cap: sin(dλ) = sin(d/R)/cos(φ),
        # valid while the cap does not contain a pole; otherwise every
        # longitude is inside.
        full = abs(lat) + ddeg >= 90.0
        k = 0
        if not full:
            s = math.sin(radius_km / EARTH_RADIUS_KM) / math.cos(math.radians(lat))
            if s >= 1.0:
                full = True
            else:
                k = int(math.degrees(math.asin(s)) / self.dlon) + 1
                full = 2 * k + 1 >= self.nlon
        if full:
            cs = slice(0, self.nlon)
        else:
            c0 = self.col(lng)
            lo, hi = c0 - k, c0 + k
            if lo >= 0 and hi < self.nlon:
                cs = slice(lo, hi + 1)
            elif self.wraps:
                cs = np.arange(lo, hi + 1) % self.nlon       # across the seam
            else:
                cs = slice(max(lo, 0), min(hi, self.nlon - 1) + 1)

        phi, lam = math.radians(lat), math.radians(lng)
        a = np.sin((self.lat_rad[rs] - phi) * 0.5) ** 2
        b = math.cos(phi) * self.cos_lat[rs]
        c = np.sin((self.lon_rad[cs] - lam) * 0.5) ** 2
        hav = a[:, None] + b[:, None] * c[None, :]
        return rs, cs, hav

    def cell_of_window(self, rs, cs, flat_index: int, ncols: int):
        """(row, col) in the full grid of a flat index into a window."""
        wr, wc = divmod(int(flat_index), ncols)
        r = rs.start + wr
        c = cs.start + wc if isinstance(cs, slice) else int(cs[wc])
        return r, c


def check_complete(path: str) -> None:
    """Refuse a truncated download. An HDF5 superblock records the file's own
    end-of-file address; curl can exit 0 on a connection the server closed
    early, and a short file otherwise only shows up as an opaque "HDF error"
    — or, worse, opens and fails halfway through a band."""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(64)
    if head[:8] != b"\x89HDF\r\n\x1a\n":
        if head[:3] == b"CDF":
            return                                  # classic netCDF-3: no stored length
        raise SystemExit(f"{path}: not a netCDF/HDF5 file")
    version = head[8]
    if version in (2, 3):
        width = head[9]
        eof = int.from_bytes(head[12 + 2 * width:12 + 3 * width], "little")
    elif version in (0, 1):
        width = head[13]
        start = 24 if version == 0 else 28
        eof = int.from_bytes(head[start + 2 * width:start + 3 * width], "little")
    else:
        return
    if eof != size:
        raise SystemExit(f"{path}: incomplete download — {size} bytes on disk, "
                         f"the file's own header says {eof}")


def open_nc(path: str):
    check_complete(path)
    ds = netCDF4.Dataset(path, "r")
    # Nothing is scaled or masked behind our back; scale/offset/fill are read
    # from the attributes and applied explicitly below.
    ds.set_auto_maskandscale(False)
    return ds


def coord(ds, names):
    for n in names:
        if n in ds.variables and ds.variables[n].ndim == 1:
            return np.asarray(ds.variables[n][:], dtype=np.float64)
    raise SystemExit(f"{ds.filepath()}: no coordinate variable among {names}")


def data_var(ds, prefer=()):
    """The one gridded variable of a file: a preferred name when present, else
    the only variable whose trailing dimensions are (lat, lon)."""
    for n in prefer:
        if n in ds.variables:
            return ds.variables[n]
    found = [v for v in ds.variables.values()
             if v.ndim >= 2 and v.dimensions[-2] in ("lat", "latitude", "y")
             and v.dimensions[-1] in ("lon", "longitude", "x")]
    if len(found) != 1:
        raise SystemExit(f"{ds.filepath()}: expected one gridded variable, found "
                         f"{[v.name for v in found]}")
    return found[0]


def fill_values(var):
    out = []
    for a in ("_FillValue", "missing_value"):
        if a in var.ncattrs():
            out.append(np.asarray(var.getncattr(a)).reshape(-1)[0])
    return out


def scale_offset(var):
    s = float(var.getncattr("scale_factor")) if "scale_factor" in var.ncattrs() else 1.0
    o = float(var.getncattr("add_offset")) if "add_offset" in var.ncattrs() else 0.0
    return s, o


def describe(ds, var, grid: Grid) -> str:
    attrs = {a: var.getncattr(a) for a in var.ncattrs()}
    keep = {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in attrs.items()
            if k in ("units", "scale_factor", "add_offset", "_FillValue", "missing_value",
                     "valid_range", "long_name", "standard_name")}
    return (f"{os.path.basename(ds.filepath())}: var {var.name} {var.dtype} {var.dimensions} "
            f"{var.shape} chunks={var.chunking()} attrs={keep}; "
            f"lat {grid.lat[0]:.5f}→{grid.lat[-1]:.5f} "
            f"({'south-first' if grid.dlat > 0 else 'north-first'}, step {grid.dlat:.10f}); "
            f"lon {grid.lon[0]:.5f}→{grid.lon[-1]:.5f} (step {grid.dlon:.10f}, "
            f"{'wraps' if grid.wraps else 'does not wrap'})")


# -----------------------------------------------------------------------------
# ETOPO and OISST: small enough to hold whole
# -----------------------------------------------------------------------------

def load_etopo(path: str, verbose: bool):
    ds = open_nc(path)
    var = data_var(ds, prefer=("z", "elevation", "Band1"))
    grid = Grid(coord(ds, ("lat", "latitude", "y")), coord(ds, ("lon", "longitude", "x")), "ETOPO")
    if verbose:
        log(describe(ds, var, grid))
        for a in ds.ncattrs():
            log(f"  ETOPO global {a} = {str(ds.getncattr(a))[:300]!r}")
    raw = var[:]
    s, o = scale_offset(var)
    elev = raw.astype(np.float32, copy=False)
    bad = ~np.isfinite(elev)
    for fv in fill_values(var):
        bad |= raw == fv
    if s != 1.0 or o != 0.0:
        elev = elev * np.float32(s) + np.float32(o)
    n_bad = int(bad.sum())
    if n_bad:
        # Unknown ground is neither land nor sea.
        elev = elev.copy()
        elev[bad] = np.nan
    units = var.getncattr("units") if "units" in var.ncattrs() else None
    if units is None:
        log("WARNING ETOPO: the elevation variable declares no units; metres assumed")
    elif str(units).strip().lower() not in ("meters", "m", "metre", "metres", "meter"):
        raise SystemExit(f"ETOPO: elevation units are {units!r}, expected metres")
    ds.close()
    log(f"ETOPO loaded {elev.shape} {elev.dtype}, nodata cells {n_bad}, "
        f"min {np.nanmin(elev):.0f} m, max {np.nanmax(elev):.0f} m")
    return elev, grid


def load_oisst(path: str, verbose: bool):
    ds = open_nc(path)
    var = ds.variables["sst"]
    grid = Grid(coord(ds, ("lat",)), coord(ds, ("lon",)), "OISST")
    if verbose:
        log(describe(ds, var, grid))
    units = var.getncattr("units")
    if units != "degC":
        raise SystemExit(f"OISST: sst units are {units!r}, expected degC")
    if var.shape[0] != 12:
        raise SystemExit(f"OISST: expected 12 months, found {var.shape[0]}")
    raw = var[:]
    s, o = scale_offset(var)
    sst = raw.astype(np.float32) * np.float32(s) + np.float32(o)
    lo, hi = (float(x) for x in var.getncattr("valid_range")) \
        if "valid_range" in var.ncattrs() else (-3.0, 45.0)
    ok = np.isfinite(sst) & (sst >= lo) & (sst <= hi)
    for fv in fill_values(var):
        ok &= raw != fv
    valid = ok.all(axis=0)          # a cell counts only with all twelve months
    ds.close()
    log(f"OISST loaded {sst.shape}, valid cells {int(valid.sum())} of {valid.size} "
        f"(valid in any month {int(ok.any(axis=0).sum())})")
    return sst, valid, grid


def datum_grid(eg: Grid):
    """Water-surface datum per ETOPO row/column: 0 m, except inside the boxes
    of ENCLOSED_BASIN_DATUMS. Returned as the list of (row_slice, col_slice,
    datum) overrides — the boxes are few and rectangular."""
    out = []
    for lat_s, lat_n, lng_w, lng_e, datum in ENCLOSED_BASIN_DATUMS:
        rows = np.nonzero((eg.lat >= lat_s) & (eg.lat <= lat_n))[0]
        cols = np.nonzero((eg.lon >= lng_w) & (eg.lon <= lng_e))[0]
        if rows.size and cols.size:
            out.append((slice(int(rows[0]), int(rows[-1]) + 1),
                        slice(int(cols[0]), int(cols[-1]) + 1), float(datum)))
    return out


def build_sea_mask(elev, eg: Grid, ovalid, og: Grid):
    """The connectivity sea rule.

    water[r, c]  — ETOPO elevation ≤ the local datum (0 m; the basin's own
                   level inside ENCLOSED_BASIN_DATUMS).
    seed[r, c]   — water inside, or within SEED_KM of, the footprint of a
                   valid OISST cell.
    sea          — every water cell 8-connected to a seed through water,
                   with the grid joined across the antimeridian."""
    from scipy import ndimage

    water = elev <= 0                               # NaN compares False: unknown is not water
    for rs, cs, datum in datum_grid(eg):
        water[rs, cs] = elev[rs, cs] <= datum

    # --- seeds: (a) the footprint of every valid OISST cell ------------------
    orow, orow_ok = og.rows(eg.lat)
    ocol, ocol_ok = og.cols(eg.lon)
    near = ovalid[np.ix_(orow, ocol)]
    near[~orow_ok, :] = False
    near[:, ~ocol_ok] = False

    # --- seeds: (b) SEED_KM beyond the footprint of each valid cell that has a
    # non-valid cell close enough for that margin to reach into it ------------
    half_lat, half_lon = abs(og.dlat) / 2.0, og.dlon / 2.0
    cell_km = KM_PER_DEG * abs(og.dlat)
    nr = int(SEED_KM // cell_km) + 1
    hmax = hav_of_km(SEED_KM)
    invalid = ~ovalid
    stamps = 0
    for j in range(og.nlat):
        if not ovalid[j].any():
            continue
        j0, j1 = max(0, j - nr), min(og.nlat - 1, j + nr)
        inv = invalid[j0:j1 + 1].any(axis=0)
        if j - nr < 0 or j + nr > og.nlat - 1:
            inv[:] = True                           # the grid's own edge counts as non-valid
        if not inv.any():
            continue
        coslat = max(1e-6, float(og.cos_lat[j0:j1 + 1].min()))
        nc = int(SEED_KM // (KM_PER_DEG * og.dlon * coslat)) + 1
        if 2 * nc + 1 >= og.nlon:
            dil = np.ones(og.nlon, dtype=bool)
        else:
            ext = np.concatenate([inv[-nc:], inv, inv[:nc]]).astype(np.int32)
            csum = np.concatenate([[0], np.cumsum(ext)])
            dil = (csum[2 * nc + 1:] - csum[:og.nlon]) > 0
        latc = float(og.lat[j])
        lat_lo, lat_hi = latc - half_lat, latc + half_lat
        # Window radius: the margin plus the footprint's half-diagonal.
        reach = SEED_KM + KM_PER_DEG * math.hypot(half_lat, half_lon)
        for i in np.nonzero(ovalid[j] & dil)[0]:
            lonc = float(og.lon[i])
            rs, cs, _ = eg.window(latc, lonc, reach)
            # Distance from each ETOPO cell to the footprint rectangle: clamp
            # the cell's own latitude and longitude into the rectangle and
            # measure to that point (separable, like every other haversine here).
            lat_r = eg.lat[rs]
            lat_q = np.clip(lat_r, lat_lo, lat_hi)
            dlon = (eg.lon[cs] - lonc + 180.0) % 360.0 - 180.0
            off = dlon - np.clip(dlon, -half_lon, half_lon)
            a = np.sin(np.radians(lat_r - lat_q) * 0.5) ** 2
            b = eg.cos_lat[rs] * np.cos(np.radians(lat_q))
            c = np.sin(np.radians(off) * 0.5) ** 2
            near[rs, cs] |= (a[:, None] + b[:, None] * c[None, :]) <= hmax
            stamps += 1
    seed = near
    seed &= water
    n_seed = int(seed.sum())

    # --- flood: water components that hold a seed ------------------------------
    lab, nlab = ndimage.label(water, structure=np.ones((3, 3), dtype=bool))
    keep = np.zeros(nlab + 1, dtype=bool)
    keep[lab[seed]] = True
    keep[0] = False
    if eg.wraps:
        # Join across the antimeridian: a component touching the last column is
        # the same water as one touching the first column in the same or an
        # adjacent row. Only "does it hold a seed" has to cross the seam.
        west, east = lab[:, 0], lab[:, -1]
        pairs = set()
        for dr in (-1, 0, 1):
            w = west[max(0, dr):eg.nlat + min(0, dr)]
            e = east[max(0, -dr):eg.nlat + min(0, -dr)]
            both = (w > 0) & (e > 0) & (w != e)
            pairs.update(zip(w[both].tolist(), e[both].tolist()))
        changed = True
        while changed:
            changed = False
            for x, y in pairs:
                if keep[x] != keep[y]:
                    keep[x] = keep[y] = True
                    changed = True
    sea = keep[lab]
    log(f"sea mask built: {stamps} coastal OISST margins stamped, {n_seed} seed cells, "
        f"{nlab} water components, sea cells {int(sea.sum())} of {sea.size}")
    return sea


# -----------------------------------------------------------------------------
# Terrain pass: one small ETOPO window per point
# -----------------------------------------------------------------------------

def terrain_pass(points, elev, sea, eg: Grid, sst, ovalid, og: Grid):
    """Everything that needs only ETOPO and OISST. Returns one record per
    point; the base is provisional until CHELSA validity is known."""
    out = []
    h_snap = hav_of_km(SNAP_KM)
    h_coast = hav_of_km(COAST_SEARCH_KM)
    h_sst = hav_of_km(SST_SEARCH_KM)
    cos_lat = eg.cos_lat
    INF = np.float64(np.inf)

    for p in points:
        lat, lng = p["lat"], p["lng"]
        disc_km = min(max(p["radiusKm"], HIGH_MIN_KM), HIGH_MAX_KM)
        win_km = max(disc_km, SNAP_KM)
        rs, cs, hav = eg.window(lat, lng, win_km)
        e = elev[rs, cs]
        s = sea[rs, cs]
        ncols = e.shape[1]
        land = ~s & np.isfinite(e)

        # --- relief and the highest cell, over the disc -----------------------
        in_disc = hav <= hav_of_km(disc_km)
        land_d = land & in_disc
        w = np.broadcast_to(cos_lat[rs][:, None], e.shape)
        w_all = float(w[in_disc].sum())
        rec = {"relief": {"maxM": None, "minLandM": None, "meanLandM": None, "landFrac": 0.0},
               "top": None, "base": None,
               "sea": {"coastKm": None, "sst": None}}
        if land_d.any():
            le, lw = e[land_d], w[land_d]
            rec["relief"] = {
                "maxM": int(round(float(le.max()))),
                "minLandM": int(round(float(le.min()))),
                "meanLandM": int(round(float((le.astype(np.float64) * lw).sum() / lw.sum()))),
                "landFrac": round(min(1.0, float(lw.sum()) / w_all), 3) if w_all > 0 else 0.0,
            }
            k = int(np.argmax(np.where(land_d, e, -np.inf)))
            r, c = eg.cell_of_window(rs, cs, k, ncols)
            rec["top"] = (r, c, float(elev[r, c]))

        # --- base: the centre, else the nearest land within SNAP_KM -----------
        rc, cc = eg.row(lat), eg.col(lng)
        centre_sea = bool(sea[rc, cc])
        centre_land = (not centre_sea) and math.isfinite(float(elev[rc, cc]))
        land_s = land & (hav <= h_snap)
        if centre_land:
            rec["base"] = ("centre", rc, cc, float(elev[rc, cc]))
        elif land_s.any():
            k = int(np.argmin(np.where(land_s, hav, INF)))
            r, c = eg.cell_of_window(rs, cs, k, ncols)
            rec["base"] = ("snapped", r, c, float(elev[r, c]))
        # --- nearest sea ------------------------------------------------------
        sea_cell = None
        if centre_sea:
            sea_cell, coast = (rc, cc), 0.0
        else:
            hmin = INF
            if s.any():
                k = int(np.argmin(np.where(s, hav, INF)))
                hmin = hav.flat[k]
            if hmin <= hav_of_km(win_km):
                # Inside the window's own radius the window is complete, so
                # this is the true nearest.
                sea_cell, coast = eg.cell_of_window(rs, cs, k, ncols), km_of_hav(float(hmin))
            else:
                rs2, cs2, hav2 = eg.window(lat, lng, COAST_SEARCH_KM)
                s2 = sea[rs2, cs2]
                if s2.any():
                    k = int(np.argmin(np.where(s2, hav2, INF)))
                    if hav2.flat[k] <= h_coast:
                        sea_cell = eg.cell_of_window(rs2, cs2, k, s2.shape[1])
                        coast = km_of_hav(float(hav2.flat[k]))
        if sea_cell is not None:
            rec["sea"]["coastKm"] = round(coast, 1)
            if coast <= SST_MAX_COAST_KM:
                slat, slng = float(eg.lat[sea_cell[0]]), float(eg.lon[sea_cell[1]])
                rso, cso, havo = og.window(slat, slng, SST_SEARCH_KM)
                vo = ovalid[rso, cso]
                if vo.any():
                    k = int(np.argmin(np.where(vo, havo, INF)))
                    if havo.flat[k] <= h_sst:
                        r, c = og.cell_of_window(rso, cso, k, vo.shape[1])
                        rec["sea"]["sst"] = [round(float(x), 1) for x in sst[:, r, c]]
        out.append(rec)
    return out


def snap_candidates(p, elev, sea, eg: Grid):
    """Land cells within SNAP_KM of a point, nearest first, capped at
    SNAP_CANDIDATES — recomputed only for the (rare) point whose first choice
    of base turns out to have no CHELSA data."""
    rs, cs, hav = eg.window(p["lat"], p["lng"], SNAP_KM)
    land_s = ~sea[rs, cs] & np.isfinite(elev[rs, cs]) & (hav <= hav_of_km(SNAP_KM))
    idx = np.flatnonzero(land_s)
    if idx.size == 0:
        return []
    order = idx[np.argsort(hav.flat[idx], kind="stable")][:SNAP_CANDIDATES]
    return [eg.cell_of_window(rs, cs, int(k), land_s.shape[1]) for k in order]


# -----------------------------------------------------------------------------
# CHELSA: band-wise sampling
# -----------------------------------------------------------------------------

class ChelsaSampler:
    """Samples a set of (lat, lng) positions from CHELSA files. (row, col) is
    computed once per distinct grid; each file is then read in chunk-aligned
    latitude bands that contain samples."""

    def __init__(self, lat, lng):
        self.lat = np.asarray(lat, dtype=np.float64)
        self.lng = np.asarray(lng, dtype=np.float64)
        self._index = {}       # grid signature → (order, rows_sorted, cols_sorted, ok)
        self.described = False

    def _indices(self, grid: Grid):
        key = grid.signature()
        if key not in self._index:
            r, rok = grid.rows(self.lat)
            c, cok = grid.cols(self.lng)
            ok = rok & cok
            order = np.argsort(r, kind="stable")
            self._index[key] = (order, r[order], c[order], ok)
        return self._index[key]

    def sample(self, path: str, verbose: bool = False):
        """Raw file values at every position (scale/offset applied when the
        file declares them), NaN where the file has fill or no grid."""
        ds = open_nc(path)
        var = data_var(ds, prefer=("Band1",))
        grid = Grid(coord(ds, ("lat", "latitude", "y")), coord(ds, ("lon", "longitude", "x")),
                    os.path.basename(path))
        if verbose and not self.described:
            log(describe(ds, var, grid))
            self.described = True
        order, rows, cols, ok = self._indices(grid)
        out = np.full(self.lat.size, np.nan, dtype=np.float64)
        fills = fill_values(var)
        s, o = scale_offset(var)
        chunks = var.chunking()
        crow = chunks[0] if isinstance(chunks, (list, tuple)) else 512
        ccol = chunks[1] if isinstance(chunks, (list, tuple)) else 512
        band = crow * max(1, 1024 // crow)
        n = rows.size
        i = 0
        while i < n:
            r0 = (int(rows[i]) // band) * band
            r1 = min(r0 + band, grid.nlat)
            j = int(np.searchsorted(rows, r1, side="left"))
            br, bc = rows[i:j], cols[i:j]
            # Only the chunk-aligned column span the band's samples need.
            c0 = (int(bc.min()) // ccol) * ccol
            c1 = min((int(bc.max()) // ccol + 1) * ccol, grid.nlon)
            block = var[r0:r1, c0:c1]
            vals = block[br - r0, bc - c0]
            bad = ~np.isfinite(vals)
            for fv in fills:
                bad |= vals == fv
            vals = vals.astype(np.float64) * s + o
            vals[bad] = np.nan
            out[order[i:j]] = vals
            i = j
        out[~ok] = np.nan
        ds.close()
        return out


def to_celsius(raw: np.ndarray, path: str) -> np.ndarray:
    """CHELSA V2.1 netCDF tasmax/tasmin: Kelvin × 10 → °C. The files carry no
    units attribute, so the encoding is guarded by range: a file in any other
    encoding stops the build instead of producing a quiet wrong number."""
    good = raw[np.isfinite(raw)]
    if good.size and (good.min() < 1700.0 or good.max() > 3400.0):
        raise SystemExit(f"{path}: temperature values {good.min()}…{good.max()} are not "
                         f"Kelvin×10 — re-verify the encoding before trusting this file")
    return raw * 0.1 - 273.15


def to_mm(raw: np.ndarray, path: str) -> np.ndarray:
    """CHELSA V2.1 netCDF pr: (mm/month) × 10 → mm/month. 65535 is the source
    raster's unflagged UInt16 nodata sentinel and reads as missing."""
    out = raw * 0.1
    out[raw >= 65535.0] = np.nan
    good = out[np.isfinite(out)]
    if good.size and (good.min() < 0.0 or good.max() > 4000.0):
        raise SystemExit(f"{path}: precipitation values {good.min()}…{good.max()} mm/month "
                         f"are outside any plausible range — re-verify the encoding")
    return out


def chelsa_path(cache: str, var: str, month: int) -> str:
    return os.path.join(cache, "raw", "chelsa", CHELSA_FILE.format(var=var, month=month))


def group_mean(values: np.ndarray, group: np.ndarray, ngroups: int) -> np.ndarray:
    """Mean of the valid samples of each group; NaN for a group with none."""
    ok = np.isfinite(values)
    tot = np.bincount(group[ok], weights=values[ok], minlength=ngroups)
    cnt = np.bincount(group[ok], minlength=ngroups)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)


def subcell_positions(eg: Grid, r: int, c: int):
    """Four positions a quarter-cell off the centre of an ETOPO cell — the
    centres of the CHELSA 30″ cells nested inside a 60″ ETOPO cell (and the
    same single cell four times over on a grid no finer than ETOPO)."""
    la, lo = float(eg.lat[r]), float(eg.lon[c])
    qa, qo = abs(eg.dlat) / 4.0, eg.dlon / 4.0
    return [(la - qa, lo - qo), (la - qa, lo + qo), (la + qa, lo - qo), (la + qa, lo + qo)]


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def read_points(path: str):
    pts = []
    with open(path, "r", encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                pid, lat, lng = o["id"], float(o["lat"]), float(o["lng"])
                radius = float(o.get("radiusKm") or 0.0)
            except (ValueError, KeyError, TypeError) as err:
                raise SystemExit(f"{path}:{n}: bad point line ({err})")
            if not (math.isfinite(lat) and math.isfinite(lng) and -90.0 <= lat <= 90.0
                    and -540.0 <= lng <= 540.0 and math.isfinite(radius) and radius >= 0):
                raise SystemExit(f"{path}:{n}: coordinates or radius out of range")
            lng = ((lng + 180.0) % 360.0) - 180.0          # one convention inside
            pts.append({"id": pid, "lat": lat, "lng": lng, "radiusKm": radius})
    return pts


def fmt_series(a, digits):
    """Twelve numbers, or null when any month is missing."""
    if a is None or not np.all(np.isfinite(a)):
        return None
    if digits == 0:
        return [int(round(float(x))) for x in a]
    return [round(float(x), digits) + 0.0 for x in a]      # + 0.0 turns -0.0 into 0.0


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_cache = os.path.normpath(os.path.join(here, "..", "..", "..", ".atlas-cache"))
    ap = argparse.ArgumentParser(description="Sample CHELSA, ETOPO and OISST at points.")
    ap.add_argument("--points", required=True, help="input NDJSON: id, lat, lng, radiusKm")
    ap.add_argument("--out", required=True, help="output NDJSON, one line per point, same order")
    ap.add_argument("--cache", default=default_cache, help="cache root holding raw/ (default: %(default)s)")
    ap.add_argument("--describe", action="store_true", help="log each file's structure as read")
    ap.add_argument("--partial", action="store_true",
                    help="DEVELOPMENT ONLY: tolerate missing CHELSA files (their arrays come out null)")
    args = ap.parse_args()
    cache = os.path.abspath(args.cache)

    points = read_points(args.points)
    n = len(points)
    log(f"{n} points from {args.points}")

    # CHELSA files present?
    files = {(v, m): chelsa_path(cache, v, m) for v in CHELSA_VARS for m in range(1, 13)}
    missing = [p for p in files.values() if not os.path.exists(p)]
    if missing and not args.partial:
        raise SystemExit("missing CHELSA files:\n  " + "\n  ".join(missing))
    for p in files.values():                       # fail before the long work, not after
        if os.path.exists(p):
            check_complete(p)
    if missing:
        log(f"WARNING --partial: {len(missing)} CHELSA files missing; their variables come out null")

    elev, eg = load_etopo(os.path.join(cache, "raw", "etopo", ETOPO_FILE), args.describe)
    sst, ovalid, og = load_oisst(os.path.join(cache, "raw", "oisst", OISST_FILE), args.describe)
    sea = build_sea_mask(elev, eg, ovalid, og)

    t = time.time()
    recs = terrain_pass(points, elev, sea, eg, sst, ovalid, og)
    log(f"terrain pass done in {time.time() - t:.1f}s")

    # --- CHELSA validity at the provisional bases -----------------------------
    # A base must have data in the reference month of every variable. CHELSA
    # V2.1 is global south of 84°N, so this normally moves nothing; it exists
    # so that a fill cell can never become a base while a valid one is nearby.
    ref_files = [files[(v, 1)] for v in CHELSA_VARS if os.path.exists(files[(v, 1)])]

    def base_positions(i):
        kind, r, c, _ = recs[i]["base"]
        if kind == "centre":
            return [(points[i]["lat"], points[i]["lng"])]
        return subcell_positions(eg, r, c)

    def valid_groups(positions, group, ngroups):
        if not positions:
            return np.zeros(ngroups, dtype=bool)
        smp = ChelsaSampler([p[0] for p in positions], [p[1] for p in positions])
        okg = np.ones(ngroups, dtype=bool)
        for path in ref_files:
            okg &= np.isfinite(group_mean(smp.sample(path), group, ngroups))
        return okg

    with_base = [i for i in range(n) if recs[i]["base"] is not None]
    pos, grp = [], []
    for g, i in enumerate(with_base):
        for q in base_positions(i):
            pos.append(q)
            grp.append(g)
    t = time.time()
    base_ok = valid_groups(pos, np.asarray(grp, dtype=np.int64), len(with_base))
    need = [i for g, i in enumerate(with_base) if not base_ok[g]]
    moved = unresolved = 0
    if need:
        cand_of, pos, grp = [], [], []
        for i in need:
            for (r, c) in snap_candidates(points[i], elev, sea, eg):
                g = len(cand_of)
                cand_of.append((i, r, c))
                for q in subcell_positions(eg, r, c):
                    pos.append(q)
                    grp.append(g)
        ok = valid_groups(pos, np.asarray(grp, dtype=np.int64), len(cand_of))
        chosen = {}
        for g, (i, r, c) in enumerate(cand_of):       # candidates are nearest-first
            if ok[g] and i not in chosen:
                chosen[i] = (r, c)
        for i in need:
            if i in chosen:
                r, c = chosen[i]
                recs[i]["base"] = ("snapped", r, c, float(elev[r, c]))
                moved += 1
            else:
                unresolved += 1       # land, but no CHELSA data in reach: arrays stay null
    log(f"CHELSA validity pass {time.time() - t:.1f}s: {len(need)} bases on fill, "
        f"{moved} moved to valid land, {unresolved} left without climate")

    # --- decide `high` now that the base elevation is final --------------------
    for rec in recs:
        rec["high"] = None
        if rec["base"] is not None and rec["top"] is not None:
            r, c, top = rec["top"]
            if top - rec["base"][3] >= HIGH_MIN_RISE_M:
                rec["high"] = (r, c, top)

    # --- every CHELSA sample, once --------------------------------------------
    # group g < n is the base of point g; group n + g is its high point.
    pos, grp = [], []
    for i, rec in enumerate(recs):
        if rec["base"] is not None:
            for q in base_positions(i):
                pos.append(q)
                grp.append(i)
        if rec["high"] is not None:
            for q in subcell_positions(eg, rec["high"][0], rec["high"][1]):
                pos.append(q)
                grp.append(n + i)
    grp = np.asarray(grp, dtype=np.int64)
    clim = {v: np.full((2 * n, 12), np.nan) for v in CHELSA_VARS}
    del elev, sea                      # free ~1.2 GB before the band reads
    t = time.time()
    if pos:
        smp = ChelsaSampler([p[0] for p in pos], [p[1] for p in pos])
        log(f"sampling {len(pos)} CHELSA cells for {len(np.unique(grp))} base/high targets")
        for v in CHELSA_VARS:
            for m in range(1, 13):
                path = files[(v, m)]
                if not os.path.exists(path):
                    continue
                tf = time.time()
                raw = smp.sample(path, args.describe)
                val = to_mm(raw, path) if v == "pr" else to_celsius(raw, path)
                clim[v][:, m - 1] = group_mean(val, grp, 2 * n)
                log(f"  {os.path.basename(path)} {time.time() - tf:.1f}s")
    log(f"CHELSA sampling done in {time.time() - t:.1f}s")

    # --- write ----------------------------------------------------------------
    stats = {"points": n, "baseNull": 0, "baseSnapped": 0, "baseNoClimate": 0, "high": 0,
             "coastKnown": 0, "sst": 0, "noLandInDisc": 0}
    tmp = args.out + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as fh:
        for i, (p, rec) in enumerate(zip(points, recs)):
            base = high = None
            if rec["base"] is not None:
                kind, r, c, e = rec["base"]
                if kind == "centre":
                    blat, blng = p["lat"], p["lng"]
                else:
                    blat, blng = float(eg.lat[r]), float(eg.lon[c])
                    stats["baseSnapped"] += 1
                base = {"lat": round(blat, 5), "lng": round(blng, 5), "elevM": int(round(e)),
                        "tmax": fmt_series(clim["tasmax"][i], 1),
                        "tmin": fmt_series(clim["tasmin"][i], 1),
                        "pr": fmt_series(clim["pr"][i], 0)}
                if base["tmax"] is None and base["tmin"] is None and base["pr"] is None:
                    stats["baseNoClimate"] += 1
            else:
                stats["baseNull"] += 1
            if rec["high"] is not None:
                r, c, e = rec["high"]
                high = {"lat": round(float(eg.lat[r]), 5), "lng": round(float(eg.lon[c]), 5),
                        "elevM": int(round(e)),
                        "tmax": fmt_series(clim["tasmax"][n + i], 1),
                        "tmin": fmt_series(clim["tasmin"][n + i], 1),
                        "pr": fmt_series(clim["pr"][n + i], 0)}
                stats["high"] += 1
            if rec["relief"]["maxM"] is None:
                stats["noLandInDisc"] += 1
            if rec["sea"]["coastKm"] is not None:
                stats["coastKnown"] += 1
            if rec["sea"]["sst"] is not None:
                stats["sst"] += 1
            fh.write(json.dumps({"id": p["id"], "base": base, "high": high,
                                 "relief": rec["relief"], "sea": rec["sea"]},
                                ensure_ascii=False, allow_nan=False, separators=(",", ":")))
            fh.write("\n")
    os.replace(tmp, args.out)
    log(f"wrote {args.out}")
    log("stats " + json.dumps(stats))
    log(f"total wall time {time.time() - T0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
