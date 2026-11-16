#!/usr/bin/env python3
# WATER BETWEEN TWO POINTS — the offline land and lake indexes.
#
# Builds two files read by `packages/core/src/travel/water.ts`:
#
#   packages/atlas/data/land.odbl.bin.gz   which landmass a point stands on
#   packages/atlas/data/lakes.ccby.bin.gz  whether a point is inside a large lake
#
# Why: a leg no router measured used to be estimated from straight-line
# distance and printed as a drive, and a straight line does not know about the
# sea ("Drive to Mykines", an island reached by boat). With these indexes a
# leg can say "these two ends stand on different landmasses" or "this straight
# line is mostly water", so an unmeasured crossing is never shown as a timed
# drive. They prove the *absence* of a land path for a straight line only; a
# bridge or a vehicle ferry is still the router's to measure (unknown ≠ false).
#
# Sources (download by hand; nothing is fetched at build or request time):
#
#   1. OpenStreetMap coastline land polygons, simplified,
#      https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip
#      © OpenStreetMap contributors, ODbL 1.0. The output is its own derived
#      database, kept in its own file and joined only in memory, exactly like
#      `ski-areas.odbl.json.gz`. Never write values derived from it into
#      `atlas.json.gz`.
#   2. HydroLAKES v1.0 polygons, https://www.hydrosheds.org/products/hydrolakes
#      Messager, M.L., Lehner, B., Grill, G., Nedeva, I., Schmitt, O. (2016):
#      Estimating the volume and age of water stored in global lakes using a
#      geo-statistical approach. Nature Communications 7: 13603. CC BY 4.0.
#      Only lakes of at least LAKE_MIN_KM2, simplified to ~250 m, are kept.
#
# Usage:
#   python3 -I packages/atlas/build/10-water.py \
#     --land <dir>/simplified_land_polygons.shp --lakes <dir>/HydroLAKES_polys_v10.shp
#
# Needs pyshp and shapely 2.
#
# FORMAT (little-endian, then gzip). A two-level grid: 1° cells, each either
# uniform (one component id, 0 = none) or split into SUB×SUB sub-cells; a
# sub-cell is uniform or "coastal", in which case it stores the id of the
# component holding its south-west corner (nudged by CORNER_EPS) and every
# boundary edge that touches it. A query casts a segment from that corner to
# the point and flips component on each boundary it crosses: since the
# polygons of one file never overlap, the point is inside polygon k exactly
# when an odd number of k's edges separate it from the corner (holes included).
#
#   'SQWI' u16 version u16 SUB
#   i32[360*180]          L1: >=0 uniform id, <0 → -(subtable index + 1)
#   u32 nSub, i32[nSub*SUB*SUB]  sub-cells: >=0 uniform id, <0 → -(coastal index + 1)
#   u32 nCoast, u32[nCoast+1] byte offsets into the payload
#   u32 nIds, then per id: f32 area in km² (index 0 unused)
#   payload: per coastal cell varint cornerId, varint nRuns, then per run
#            varint polygonId, varint nPoints, nPoints × (zigzag varint dx, dy)
#            in 1e-5° from the previous point (the first from the cell's corner)

import argparse
import gzip
import math
import struct
import sys
from collections import defaultdict

import numpy as np
import shapefile
import shapely
from shapely.geometry import Polygon, shape
from shapely.strtree import STRtree

SUB = 10
Q = 1e5
CORNER_EPS = 1e-6
LAKE_MIN_KM2 = 20.0
R = 20037508.342789244


def merc_to_lonlat(coords):
    a = np.asarray(coords, dtype=np.float64)
    lon = a[:, 0] / R * 180.0
    lat = np.degrees(2.0 * np.arctan(np.exp(a[:, 1] / R * math.pi)) - math.pi / 2.0)
    return np.column_stack([lon, lat])


def varint(out, v):
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def zigzag(v):
    return (v << 1) if v >= 0 else ((-v) << 1) - 1


def cells_of_segment(x0, y0, x1, y1):
    """Grid cells (in sub-cell units) a segment touches, conservatively."""
    cx0, cx1 = int(math.floor(min(x0, x1))), int(math.floor(max(x0, x1)))
    cy0, cy1 = int(math.floor(min(y0, y1))), int(math.floor(max(y0, y1)))
    if cx0 == cx1 or cy0 == cy1:
        return [(cx, cy) for cx in range(cx0, cx1 + 1) for cy in range(cy0, cy1 + 1)]
    seg = shapely.LineString([(x0, y0), (x1, y1)])
    out = []
    for cx in range(cx0, cx1 + 1):
        for cy in range(cy0, cy1 + 1):
            if seg.intersects(shapely.box(cx, cy, cx + 1, cy + 1)):
                out.append((cx, cy))
    return out


def build(polys, areas, label):
    """polys: list of shapely Polygons in lon/lat. Ids are index + 1."""
    W, H = 360 * SUB, 180 * SUB
    runs = defaultdict(list)  # cell -> list of [polyId, [(qx,qy), ...]]
    last = {}  # (cell, ring key) -> run list object, for continuity
    for pid, poly in enumerate(polys, start=1):
        rings = [poly.exterior] + list(poly.interiors)
        for rk, ring in enumerate(rings):
            pts = np.asarray(ring.coords)
            gx = (pts[:, 0] + 180.0) * SUB
            gy = (pts[:, 1] + 90.0) * SUB
            q = np.round(pts * Q).astype(np.int64)
            for s in range(len(pts) - 1):
                for cell in cells_of_segment(gx[s], gy[s], gx[s + 1], gy[s + 1]):
                    cx, cy = cell
                    if not (0 <= cx < W and 0 <= cy < H):
                        cx, cy = min(max(cx, 0), W - 1), min(max(cy, 0), H - 1)
                        cell = (cx, cy)
                    key = (cell, pid, rk)
                    a = (int(q[s, 0]), int(q[s, 1]))
                    b = (int(q[s + 1, 0]), int(q[s + 1, 1]))
                    run = last.get(key)
                    if run is not None and run[1][-1] == a:
                        run[1].append(b)
                    else:
                        run = [pid, [a, b]]
                        runs[cell].append(run)
                        last[key] = run
        if pid % 5000 == 0:
            print(f"  {label}: {pid}/{len(polys)} polygons, {len(runs)} coastal cells", file=sys.stderr)
    print(f"  {label}: {len(runs)} coastal sub-cells", file=sys.stderr)

    tree = STRtree(polys)

    def component_at(xs, ys):
        pts = shapely.points(xs, ys)
        res = np.zeros(len(xs), dtype=np.int64)
        idx_pt, idx_poly = tree.query(pts, predicate="within")
        res[idx_pt] = idx_poly + 1
        return res

    coastal_l1 = set((cx // SUB, cy // SUB) for (cx, cy) in runs)
    # L1 uniform cells: test the centre.
    l1 = np.zeros((180, 360), dtype=np.int32)
    ux, uy, uk = [], [], []
    for j in range(180):
        for i in range(360):
            if (i, j) not in coastal_l1:
                ux.append(i - 180 + 0.5)
                uy.append(j - 90 + 0.5)
                uk.append((j, i))
    ids = component_at(np.array(ux), np.array(uy))
    for (j, i), v in zip(uk, ids):
        l1[j, i] = v

    coastal_list = sorted(runs.keys())
    coastal_index = {c: n for n, c in enumerate(coastal_list)}
    corners = component_at(
        np.array([cx / SUB - 180 + CORNER_EPS for cx, _ in coastal_list]),
        np.array([cy / SUB - 90 + CORNER_EPS for _, cy in coastal_list]),
    )

    subtables = []
    sx, sy, sk = [], [], []
    for (i, j) in sorted(coastal_l1):
        t = len(subtables)
        table = np.zeros(SUB * SUB, dtype=np.int32)
        subtables.append(table)
        l1[j, i] = -(t + 1)
        for b in range(SUB):
            for a in range(SUB):
                cell = (i * SUB + a, j * SUB + b)
                if cell in coastal_index:
                    table[b * SUB + a] = -(coastal_index[cell] + 1)
                else:
                    sx.append((i * SUB + a + 0.5) / SUB - 180)
                    sy.append((j * SUB + b + 0.5) / SUB - 90)
                    sk.append((t, b * SUB + a))
    ids = component_at(np.array(sx), np.array(sy))
    for (t, k), v in zip(sk, ids):
        subtables[t][k] = v

    payload = bytearray()
    offsets = [0]
    for n, cell in enumerate(coastal_list):
        cx, cy = cell
        ox = int(round((cx / SUB - 180) * Q))
        oy = int(round((cy / SUB - 90) * Q))
        varint(payload, int(corners[n]))
        cell_runs = runs[cell]
        varint(payload, len(cell_runs))
        for pid, pts in cell_runs:
            varint(payload, pid)
            varint(payload, len(pts))
            px, py = ox, oy
            for x, y in pts:
                varint(payload, zigzag(x - px))
                varint(payload, zigzag(y - py))
                px, py = x, y
        offsets.append(len(payload))

    out = bytearray(b"SQWI")
    out += struct.pack("<HH", 1, SUB)
    out += l1.astype("<i4").tobytes()
    out += struct.pack("<I", len(subtables))
    for t in subtables:
        out += t.astype("<i4").tobytes()
    out += struct.pack("<I", len(coastal_list))
    out += np.array(offsets, dtype="<u4").tobytes()
    out += struct.pack("<I", len(areas) + 1)
    out += np.array([0.0] + list(areas), dtype="<f4").tobytes()
    out += payload
    return bytes(out)


def polygon_parts(geom):
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type == "MultiPolygon":
        return list(geom.geoms)
    return []


def km2(poly):
    lat = poly.centroid.y
    return abs(poly.area) * (111.32 ** 2) * math.cos(math.radians(lat))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--land", required=True)
    ap.add_argument("--lakes", required=True)
    ap.add_argument("--out", default="packages/atlas/data")
    ap.add_argument("--only", choices=["land", "lakes"], help="rebuild one file")
    args = ap.parse_args()

    if args.only != "lakes":
        build_land(args)
    if args.only != "land":
        build_lakes(args)


def build_land(args):
    print("land polygons…", file=sys.stderr)
    land = []
    for s in shapefile.Reader(args.land).iterShapes():
        g = shape(s.__geo_interface__)
        for p in polygon_parts(g):
            ext = merc_to_lonlat(p.exterior.coords)
            holes = [merc_to_lonlat(r.coords) for r in p.interiors]
            q = Polygon(ext, holes)
            if not q.is_valid:
                q = shapely.make_valid(q)
                for part in polygon_parts(q):
                    land.append(part)
                continue
            land.append(q)
    land_areas = [km2(p) for p in land]
    blob = build(land, land_areas, "land")
    with gzip.open(f"{args.out}/land.odbl.bin.gz", "wb", compresslevel=9) as f:
        f.write(blob)
    print(f"land: {len(land)} polygons, {len(blob)} bytes raw", file=sys.stderr)


def build_lakes(args):
    print("lakes…", file=sys.stderr)
    # HydroLAKES' name fields are not all UTF-8; only the area is read.
    reader = shapefile.Reader(args.lakes, encoding="latin1", encodingErrors="replace")
    lakes, lake_areas = [], []
    for sr in reader.iterShapeRecords(fields=["Lake_area"]):
        area = float(sr.record[0])
        if area < LAKE_MIN_KM2:
            continue
        g = shape(sr.shape.__geo_interface__).simplify(0.0025, preserve_topology=True)
        for p in polygon_parts(g if g.is_valid else shapely.make_valid(g)):
            if km2(p) < LAKE_MIN_KM2 / 4:
                continue
            lakes.append(p)
            lake_areas.append(area)
    blob = build(lakes, lake_areas, "lakes")
    with gzip.open(f"{args.out}/lakes.ccby.bin.gz", "wb", compresslevel=9) as f:
        f.write(blob)
    print(f"lakes: {len(lakes)} polygons, {len(blob)} bytes raw", file=sys.stderr)


if __name__ == "__main__":
    main()
