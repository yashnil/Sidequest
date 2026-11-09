#!/usr/bin/env python3
# =============================================================================
# 08-geometry.py — real geometry for destinations, computed offline
# =============================================================================
#
# A destination's extent in the atlas is a circle (centre + radius). A circle
# cannot tell a mountain range from the valley beside it, an island from the
# next island, or one side of a border from the other. This stage reads open
# polygon datasets and writes, for every point the atlas knows, WHICH polygons
# contain it — membership tables, not polygons. Nothing geometric ships to the
# runtime: no ring, no coordinate list, only ids, names, areas, distances and
# bounding boxes.
#
#   .atlas-cache/venv-geo/bin/python -I packages/atlas/build/08-geometry.py \
#       [--cache .atlas-cache] \
#       [--points      .atlas-cache/work/points.ndjson] \
#       [--candidates  .atlas-cache/work/candidates.ndjson] \
#       [--out         .atlas-cache/work/geometry.ndjson] \
#       [--polygons    .atlas-cache/work/polygons.ndjson] \
#       [--landmasses  .atlas-cache/work/landmasses.ndjson] \
#       [--stats       .atlas-cache/work/geometry-stats.json] \
#       [--naturalearth <dir of ne_10m_*.zip>] [--gmba <zip>]
#
# Needs numpy, shapely >= 2.0 and pyproj (a venv at .atlas-cache/venv-geo; not
# the base environment). Always run with -I: the inputs are downloaded files.
# The archives are read in memory and never extracted; nothing in them is
# executed, and the two binary formats (.shp, .dbf) are parsed here, by hand,
# with every length taken from the file and checked against its size — a
# truncated download stops the stage, it does not shorten the world.
# About 50 s for 48,000 points.
#
# -----------------------------------------------------------------------------
# OUTPUTS
# -----------------------------------------------------------------------------
#
# geometry.ndjson — one line per line of points.ndjson, same order:
#   {"id",
#    "land":   {"id","areaKm2","kind":"mainland"|"island"} | null,
#    "offshoreKm": num | null,      null on land; km to the nearest coastline
#    "nearestLand": {"id","areaKm2","kind"} | null,      set only when at sea
#    "adm0":   {"iso2","qid","name","a3","sovereignIso2","type",
#               "basis":"contains"|"nearest","km"?} | null,
#    "subunit":{"a3","name","qid","type"} | null,    Natural Earth map subunit
#    "adm1":   {"qid","name","iso3166_2","code","basis","km"?} | null,
#    "disputed":[{"id","name","qid","type","note"}],  disputed/breakaway areas
#    "ranges": [{"id","name","qid","level","areaKm2","feature","unit"}],
#                 every GMBA polygon containing the point, coarsest level first
#    "rangesNear":[{…as ranges…,"km"}],
#                 GMBA polygons that do not contain the point but begin within
#                 RANGE_NEAR_KM of it (the valley town below the range)
#    "regions":[{"id","name","qid","featurecla"}],   NE physical regions
#    "marine": [{"id","name","qid","featurecla"}]}   NE seas, bays, straits
#
# polygons.ndjson — one line per (source polygon, atlas candidate) match:
#   {"candidateId","source","sourceId","sourceName","polygonQid",
#    "matchedBy":"qid"|"name"|"alias","centreInside","centreDistKm",
#    "areaKm2","declaredAreaKm2",               the candidate's Wikidata area
#    "bbox":[w,s,e,n],"wraps",                  w > e when the box crosses 180°
#    "parts","largestPartShare","centrePart":{"index","areaKm2","bbox"}|null,
#    "partList":[{"areaKm2","bbox","memberCount"}],   ten largest, largest = 0
#    "memberIds":[candidates whose centre is inside],"memberCount",
#    "nearKm","nearMemberIds":[outside, within nearKm],"nearMemberCount",
#    "children":{"count","inside","near"},      the candidate's direct children
#    "flags":[…]}
#   flags: qid_shared_by_N_polygons (the candidate is the union of N lines),
#   area_mismatch (polygon and published area differ more than fivefold),
#   qid_differs / candidate_has_no_qid / no_declared_area (a name match with
#   less behind it), name_matches_N_polygons, centre_outside,
#   mountain_terrain_only (every GMBA line), children_disagree (three or more
#   children and fewer than half of them in or beside the polygon).
#
# landmasses.ndjson — one line per landmass holding at least one point:
#   {"id","areaKm2","kind","bbox","wraps","pieces","memberIds","memberCount",
#    "islandCandidateIds","soleIsland":{"candidateId","declaredAreaKm2",
#    "areaRatio"}|null}
#
# geometry-stats.json — every number the validation report quotes.
#
# -----------------------------------------------------------------------------
# DATA SOURCES (facts marked [file] were read from the files themselves)
# -----------------------------------------------------------------------------
#
# 1. Natural Earth 1:10m, eight layers        raw/naturalearth/ne_10m_<layer>.zip
#    admin_0_countries (5.1.1), admin_0_map_subunits (5.1.1),
#    admin_1_states_provinces (5.1.1), admin_0_disputed_areas (5.1.1),
#    land (5.1.1), minor_islands (4.1.0), geography_regions_polys (5.0.0),
#    geography_marine_polys (5.1.0)                       [file: VERSION.txt]
#    Public domain. https://www.naturalearthdata.com/about/terms-of-use/ :
#    "All versions of Natural Earth raster + vector map data found on this
#    website are in the public domain. … invites you to use them for personal,
#    educational, and commercial purposes. No permission is needed to use
#    Natural Earth. Crediting the authors is unnecessary." (The courtesy line,
#    if wanted, is "Made with Natural Earth.")
#    [file] ESRI Polygon shapefiles, WGS84 lon/lat, UTF-8 attribute tables.
#    [file] `land` is 11 records; the one of class "Null island" (a marker at
#           0°,0°) is dropped by that class. The other ten hold 6,836 separate
#           rings and ONE hole: lakes and inland seas are not cut out.
#    [file] `land` 5.1.1 already contains every one of the 2,795
#           `minor_islands` rings; the layer is still read so that an island a
#           future version leaves out is not lost.
#    [file] Polygons that cross the antimeridian are cut at ±180° (and the two
#           sides are 180 and −179.99999999999991, not ±180 exactly); the
#           halves are rejoined here before a landmass is counted.
#    [file] ISO_A2 is "-99" for France, Norway and others and "CN-TW" for
#           Taiwan; the first of ISO_A2, ISO_A2_EH that is two capitals is used.
#    [file] admin-1 `iso_3166_2` holds placeholders ("-99-X…", "FR-X…~");
#           only values shaped like a real code are passed through.
#    [file] Identifiers are NOT clean. Several rows carry another place's QID
#           (the Azorean island of Flores carries the Indonesian one's; a
#           French Antarctic subunit carries the Seychelles'), a city row can
#           carry its province's QID and ISO code (an "admin-1" of 126 km² for
#           a province of 4,900), several rows can share one QID, and NAME_EN
#           is the label of whatever the QID points at. Hence the rules below.
#
# 2. GMBA Mountain Inventory v2.0, "Standard – All"
#    raw/gmba/GMBA_Inventory_v2.0_standard.zip (185,781,797 bytes)
#    CC BY 4.0. https://www.earthenv.org/mountains : "This work is licensed
#    under a Creative Commons Attribution 4.0 International License." and
#    "When using the GMBA Inventory v2.0, both the publication and the dataset
#    must be cited." (The DataCite record of doi:10.48601/earthenv-t9k2-1407
#    and the publisher's LICENSE file say the same; the archive itself carries
#    no licence file. The live page refuses scripted requests, so the quotes
#    were read from its web.archive.org snapshot of 2026-01-02.)
#    Snethlage, M.A., Geschke, J., Spehn, E.M., Ranipeta, A., Yoccoz, N.G.,
#    Körner, Ch., Jetz, W., Fischer, M. & Urbach, D. (2022) A hierarchical
#    inventory of the world's mountains for global comparative mountain
#    science. Scientific Data, doi:10.1038/s41597-022-01256-y; and
#    GMBA Mountain Inventory v2. GMBA-EarthEnv, doi:10.48601/earthenv-t9k2-1407.
#    [file] 8,327 OVERLAPPING polygons in 148,080 parts at up to ten hierarchy
#           levels (`Hier_Lvl`, `Path_ID`); 6,717 are "Basic" (no child), 1,610
#           "Aggregated". 5,924 carry a Wikidata URL (`WikiDataUR`). An
#           aggregated polygon always contains what its children contain
#           (checked on every run).
#    [file] A GMBA polygon is RUGGED TERRAIN ONLY: valley floors and basins are
#           cut out, so the town a range is visited from is usually just
#           outside it (`rangesNear`). Its `Feature` classes "(Sub)-Continent",
#           "Ocean", "Island", "Archipelago", "Peninsula" and "Miscellaneous
#           physical or political Feature" name the mountainous part of
#           something larger — the polygon called "Africa" (Q15) is Africa's
#           mountains, not Africa. Those are reported under `ranges` with their
#           class and are never offered as the polygon OF a candidate
#           (GMBA_NOT_AN_EXTENT).
#
# Evaluated and not used: geoBoundaries gbOpen (the "CC BY 4.0" on its home
# page is the database's; each boundary carries its own licence, and 84 of 199
# ADM1 and 33 of 180 ADM2 files are ODbL from OpenStreetMap, 14 and 12 more
# CC BY-SA), Marine Regions (CC BY, but its terms say it is "developed solely
# for scientific, educational and research purposes"; not downloaded).
# GADM, WDPA and anything OpenStreetMap-derived are excluded by licence.
#
# -----------------------------------------------------------------------------
# RULES
# -----------------------------------------------------------------------------
#
# - Inside means inside: a point belongs to a polygon when the polygon
#   intersects it (boundary included). Membership is never buffered; what is
#   merely close is reported apart, with its distance (`rangesNear`,
#   `nearMemberIds`, `offshoreKm`, `basis: "nearest"`).
# - A landmass is one connected piece of `land` ∪ `minor_islands`, after the
#   antimeridian halves are rejoined. Its id is its centroid in thousandths of
#   a degree ("land:36828N064174E"): the same files give the same id on every
#   run. `kind` is "mainland" at or above MAINLAND_MIN_KM2 and "island" below;
#   nothing in Natural Earth lies between Greenland (2.1 M km²) and Australia
#   (7.6 M km²), so the threshold names no place. Africa–Eurasia is one
#   landmass and so are the Americas: the canals are not cut.
# - A point at sea is not forced onto land: `land` is null and `offshoreKm` /
#   `nearestLand` say how far the nearest coastline is and whose it is. At
#   1:10m a harbour is often "at sea" by a few hundred metres, and a small
#   island may not be drawn at all.
# - A point outside every country polygon takes the nearest one within
#   NEAREST_ADMIN_KM and says so (`basis: "nearest"`, `km`). Beyond that, null.
# - A candidate is matched to a polygon by Wikidata QID, else by name.
#   A QID is evidence, not truth: it must be corroborated by the candidate's
#   centre lying inside the polygon, or inside its padded bounding box with
#   no published area that differs from the polygon's by over AREA_RATIO_LIMIT.
#   A name is the exactly folded name (case, diacritics and punctuation only —
#   never an edit distance, never a stripped word) with the centre inside the
#   polygon or within 5–25 km of it, and never ties a town to an area, a
#   polygon a QID already claimed, or a candidate a QID already placed in the
#   same layer; a name several candidates share for one polygon matches none.
#   An alias (an atlas redirect, or a polygon's alternate name) is as often a
#   constituent as a synonym, so it counts only with the centre inside AND the
#   published area within ALIAS_AREA_TOLERANCE.
# - Unknown is not false: a point outside every range polygon has `ranges: []`
#   because no polygon contains it, not because it is not in the mountains;
#   an unmatched candidate has no line, not an empty one.
# - No place, polygon or measurement is special-cased by name.
# =============================================================================

import argparse
import collections
import json
import math
import os
import re
import struct
import sys
import time
import unicodedata
import zipfile

import numpy as np
import pyproj
import shapely
from shapely import STRtree

GEOD = pyproj.Geod(ellps="WGS84")

MAINLAND_MIN_KM2 = 5_000_000.0
NEAREST_ADMIN_KM = 400.0
RANGE_NEAR_KM = 25.0
POLYGON_NEAR_KM = 10.0
AREA_RATIO_LIMIT = 5.0
ALIAS_AREA_TOLERANCE = 0.25
CHILDREN_MIN = 3
CHILDREN_DISAGREE_SHARE = 0.5
NEAREST_LAND_WINDOWS_DEG = (0.1, 0.4, 1.6, 6.4, 25.6, 90.0)
CHUNK_VERTICES = 24
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LNG = 111.320

NE_LAYERS = {
    "admin0": "ne_10m_admin_0_countries",
    "subunit": "ne_10m_admin_0_map_subunits",
    "admin1": "ne_10m_admin_1_states_provinces",
    "disputed": "ne_10m_admin_0_disputed_areas",
    "land": "ne_10m_land",
    "minor": "ne_10m_minor_islands",
    "region": "ne_10m_geography_regions_polys",
    "marine": "ne_10m_geography_marine_polys",
}
GMBA_ZIP = "GMBA_Inventory_v2.0_standard.zip"

# GMBA feature classes whose polygon is the mountainous part of a larger named
# thing, and so is not that thing's extent.
GMBA_NOT_AN_EXTENT = {
    "(Sub)-Continent",
    "Ocean",
    "Island",
    "Archipelago",
    "Peninsula",
    "Miscellaneous physical or political Feature",
    "Support polygon - unnamed",
}

# Candidate kinds a bare name may not tie to an area polygon.
NAME_MATCH_EXCLUDED_KINDS = {"city", "itinerary"}


def log(message):
    sys.stderr.write(f"[08-geometry +{time.time() - T0:6.1f}s] {message}\n")
    sys.stderr.flush()


T0 = time.time()


# ── Reading the archives ──────────────────────────────────────────────────────

class SourceError(Exception):
    pass


def read_archive(path):
    """The .shp and .dbf of the one shapefile in a zip, as bytes, CRC-checked."""
    if not os.path.isfile(path):
        raise SourceError(f"missing: {path}")
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as error:
        raise SourceError(f"{path}: not a complete zip ({error}) — re-download it") from error
    with archive:
        damaged = archive.testzip()
        if damaged is not None:
            raise SourceError(f"{path}: CRC failure in {damaged} — re-download it")
        members = [name for name in archive.namelist() if not name.startswith("__MACOSX/")]
        shapes = [name for name in members if name.lower().endswith(".shp")]
        if len(shapes) != 1:
            raise SourceError(f"{path}: expected one .shp, found {shapes}")
        stem = shapes[0][:-4]
        by_lower = {name.lower(): name for name in members}
        table = by_lower.get(f"{stem.lower()}.dbf")
        if table is None:
            raise SourceError(f"{path}: no .dbf beside {shapes[0]}")
        encoding = "utf-8"
        codepage = by_lower.get(f"{stem.lower()}.cpg")
        if codepage is not None:
            declared = archive.read(codepage).decode("ascii", "replace").strip().lower()
            if declared not in ("utf-8", "utf8"):
                raise SourceError(f"{path}: unexpected attribute encoding {declared!r}")
        version = None
        for name in members:
            if name.lower().endswith("version.txt"):
                version = archive.read(name).decode("ascii", "replace").strip()
        return archive.read(shapes[0]), archive.read(table), encoding, version


def parse_dbf(data, encoding):
    """dBase III table → list of dicts. Numbers become int/float, blanks None."""
    if len(data) < 33:
        raise SourceError("dbf: truncated header")
    count, header_length, record_length = struct.unpack_from("<IHH", data, 4)
    fields = []
    offset = 32
    while offset < header_length - 1 and data[offset] != 0x0D:
        name = data[offset:offset + 11].split(b"\x00", 1)[0].decode("ascii", "replace")
        kind = chr(data[offset + 11])
        length = data[offset + 16]
        fields.append((name, kind, length))
        offset += 32
    if 1 + sum(length for _, _, length in fields) != record_length:
        raise SourceError("dbf: field lengths disagree with the record length")
    if header_length + count * record_length > len(data):
        raise SourceError("dbf: file is shorter than its header says")
    rows = []
    for index in range(count):
        position = header_length + index * record_length + 1
        row = {}
        for name, kind, length in fields:
            raw = data[position:position + length]
            position += length
            if kind in ("N", "F"):
                text = raw.decode("ascii", "replace").strip().strip("*")
                if not text:
                    row[name] = None
                else:
                    try:
                        row[name] = int(text) if re.fullmatch(r"-?\d+", text) else float(text)
                    except ValueError:
                        row[name] = None
            else:
                row[name] = raw.decode(encoding, "replace").replace("\x00", "").strip()
        rows.append(row)
    return rows


def parse_shp(data):
    """ESRI polygon shapefile → list of (points[N,2] float64, part starts) | None."""
    if len(data) < 100 or struct.unpack_from(">i", data, 0)[0] != 9994:
        raise SourceError("shp: not a shapefile")
    declared = struct.unpack_from(">i", data, 24)[0] * 2
    if declared != len(data):
        raise SourceError(f"shp: header says {declared} bytes, file has {len(data)} — truncated download")
    shapes = []
    position = 100
    while position < len(data):
        _, words = struct.unpack_from(">ii", data, position)
        start = position + 8
        end = start + words * 2
        if end > len(data):
            raise SourceError("shp: record runs past the end of the file")
        kind = struct.unpack_from("<i", data, start)[0]
        if kind == 0:
            shapes.append(None)
        elif kind in (5, 15, 25):
            part_count, point_count = struct.unpack_from("<ii", data, start + 36)
            parts_at = start + 44
            points_at = parts_at + 4 * part_count
            if points_at + 16 * point_count > end:
                raise SourceError("shp: polygon record is shorter than its counts say")
            starts = np.frombuffer(data, dtype="<i4", count=part_count, offset=parts_at)
            points = np.frombuffer(data, dtype="<f8", count=2 * point_count, offset=points_at).reshape(-1, 2)
            shapes.append((points, starts))
        else:
            raise SourceError(f"shp: shape type {kind} is not a polygon")
        position = end
    return shapes


# ── Rings → polygons ──────────────────────────────────────────────────────────

def geodesic_ring_km2(ring):
    area, _ = GEOD.polygon_area_perimeter(ring[:, 0], ring[:, 1])
    return abs(area) / 1e6


def geodesic_polygon_km2(polygon):
    area, _ = GEOD.geometry_area_perimeter(polygon)
    return abs(area) / 1e6


def polygonal_pieces(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry] if not geometry.is_empty else []
    if geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        pieces = []
        for part in geometry.geoms:
            pieces.extend(polygonal_pieces(part))
        return pieces
    return []


def build_parts(points, starts, counters):
    """One shapefile record → [(Polygon, km²)]; one entry per outer ring.

    ESRI rings are clockwise for an outer boundary and anticlockwise for a
    hole. A hole is given to the smallest outer ring that contains it.
    """
    bounds = list(starts) + [len(points)]
    outers, holes = [], []
    for a, b in zip(bounds[:-1], bounds[1:]):
        ring = points[a:b]
        if len(ring) < 4:
            counters["rings_dropped_short"] += 1
            continue
        x, y = ring[:, 0], ring[:, 1]
        signed = float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))
        if signed == 0.0:
            counters["rings_dropped_flat"] += 1
            continue
        (outers if signed < 0 else holes).append(ring)
    if not outers:
        outers, holes = holes, []
    if not outers:
        return []
    shells = shapely.polygons([shapely.linearrings(ring) for ring in outers])
    shell_holes = [[] for _ in outers]
    if holes:
        counters["holes"] += len(holes)
        if len(outers) == 1:
            shell_holes[0] = holes
        else:
            planar = shapely.area(shells)
            tree = STRtree(shells)
            probes = shapely.points([ring[0] for ring in holes])
            hole_index, shell_index = tree.query(probes, predicate="intersects")
            owner = {}
            for h, s in zip(hole_index.tolist(), shell_index.tolist()):
                if h not in owner or planar[s] < planar[owner[h]]:
                    owner[h] = s
            for h, ring in enumerate(holes):
                if h in owner:
                    shell_holes[owner[h]].append(ring)
                else:
                    counters["holes_orphaned"] += 1
    parts = []
    for ring, inner in zip(outers, shell_holes):
        polygon = shapely.Polygon(ring, inner) if inner else shapely.Polygon(ring)
        if shapely.is_valid(polygon):
            area = geodesic_ring_km2(ring) - sum(geodesic_ring_km2(hole) for hole in inner)
            parts.append((polygon, max(area, 0.0)))
        else:
            counters["polygons_repaired"] += 1
            for piece in polygonal_pieces(shapely.make_valid(polygon)):
                parts.append((piece, geodesic_polygon_km2(piece)))
    return parts


class Layer:
    """A polygon layer: attribute rows and, flattened, every part of every row."""

    def __init__(self, key, rows, shapes, keep=None):
        self.key = key
        self.counters = collections.Counter()
        self.rows = []
        geoms, owners, areas = [], [], []
        self.row_parts = []
        for row, shape in zip(rows, shapes):
            if shape is None or (keep is not None and not keep(row)):
                self.counters["rows_skipped"] += 1
                continue
            parts = build_parts(shape[0], shape[1], self.counters)
            if not parts:
                self.counters["rows_without_area"] += 1
                continue
            index = len(self.rows)
            self.rows.append(row)
            first = len(geoms)
            for polygon, area in parts:
                geoms.append(polygon)
                owners.append(index)
                areas.append(area)
            self.row_parts.append(np.arange(first, len(geoms)))
        self.geoms = np.array(geoms, dtype=object)
        self.part_row = np.array(owners, dtype=np.int64)
        self.part_area = np.array(areas, dtype=np.float64)
        self.row_area = np.zeros(len(self.rows))
        np.add.at(self.row_area, self.part_row, self.part_area)
        self.part_bounds = shapely.bounds(self.geoms) if len(self.geoms) else np.zeros((0, 4))
        shapely.prepare(self.geoms)

    def locate(self, tree, point_count):
        """Which points lie in which rows: (per-point row lists, per-part point lists)."""
        part_index, point_index = tree.query(self.geoms, predicate="intersects")
        self.part_points = collections.defaultdict(list)
        for part, point in zip(part_index.tolist(), point_index.tolist()):
            self.part_points[part].append(point)
        pairs = np.unique(np.stack([point_index, self.part_row[part_index]], axis=1), axis=0) if len(part_index) else np.zeros((0, 2), dtype=np.int64)
        self.point_rows = [[] for _ in range(point_count)]
        self.row_points = [[] for _ in self.rows]
        for point, row in pairs.tolist():
            self.point_rows[point].append(row)
            self.row_points[row].append(point)
        # Which part of a row holds a point (the largest, if the parts overlap).
        self.point_part = {}
        for part, point in zip(part_index.tolist(), point_index.tolist()):
            key = (point, int(self.part_row[part]))
            held = self.point_part.get(key)
            if held is None or self.part_area[part] > self.part_area[held]:
                self.point_part[key] = part

    def row_bbox(self, row):
        return wrap_aware_bbox(self.part_bounds[self.row_parts[row]])

    def distance_km(self, row, lng, lat):
        """Distance from a point outside the row's polygon to its boundary."""
        coords, ring = ring_coordinates(self.geoms[self.row_parts[row]])
        best = nearest_on_rings(coords, ring, lng, lat)
        return None if best is None else geodesic_km(lng, lat, best[1], best[2])


def load_layer(path, key, keep=None):
    shp, dbf, encoding, version = read_archive(path)
    rows = parse_dbf(dbf, encoding)
    shapes = parse_shp(shp)
    if len(rows) != len(shapes):
        raise SourceError(f"{path}: {len(shapes)} shapes but {len(rows)} attribute rows")
    layer = Layer(key, rows, shapes, keep)
    layer.version = version
    layer.bytes = os.path.getsize(path)
    log(f"{key}: {len(layer.rows)} polygons in {len(layer.geoms)} parts"
        f"{'' if not layer.counters else ' ' + json.dumps(dict(layer.counters))}")
    return layer


# ── Small geometry helpers ────────────────────────────────────────────────────

def geodesic_km(lng_a, lat_a, lng_b, lat_b):
    return GEOD.inv(lng_a, lat_a, lng_b, lat_b)[2] / 1000.0


def wrap_aware_bbox(bounds):
    """[w, s, e, n] of several boxes; w > e (and True) when the tight box crosses 180°."""
    west, south = float(bounds[:, 0].min()), float(bounds[:, 1].min())
    east, north = float(bounds[:, 2].max()), float(bounds[:, 3].max())
    box, wraps = [west, south, east, north], False
    if east - west > 180.0 and len(bounds) > 1:
        shifted_w = np.where(bounds[:, 2] < 0, bounds[:, 0] + 360.0, bounds[:, 0])
        shifted_e = np.where(bounds[:, 2] < 0, bounds[:, 2] + 360.0, bounds[:, 2])
        if shifted_e.max() - shifted_w.min() < east - west - 1e-9:
            box = [float(shifted_w.min()), south, float(shifted_e.max()) - 360.0, north]
            wraps = True
    return [round(value, 4) for value in box], wraps


def ring_coordinates(polygons):
    rings = shapely.get_rings(polygons)
    return shapely.get_coordinates(rings, return_index=True)


def segment_distances(coords, ring, lng, lat):
    """Squared km from (lng, lat) to every segment of the given rings, with the
    nearest point on each: (squared[N-1], px, py, kx). A pair of consecutive
    vertices that belong to different rings is not a segment (infinite).

    The plane is a local equirectangular one centred on the point, and every
    vertex is brought within 180° of it first, so the antimeridian is no edge.
    """
    kx = KM_PER_DEG_LNG * max(0.02, math.cos(math.radians(lat)))
    dx = ((coords[:, 0] - lng + 180.0) % 360.0 - 180.0) * kx
    dy = (coords[:, 1] - lat) * KM_PER_DEG_LAT
    ax, ay, bx, by = dx[:-1], dy[:-1], dx[1:], dy[1:]
    same = ring[:-1] == ring[1:]
    ex, ey = bx - ax, by - ay
    length = ex * ex + ey * ey
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(length > 0, -(ax * ex + ay * ey) / length, 0.0)
    t = np.clip(t, 0.0, 1.0)
    px, py = ax + t * ex, ay + t * ey
    return np.where(same, px * px + py * py, np.inf), px, py, kx


def nearest_on_rings(coords, ring, lng, lat):
    """Nearest boundary point to (lng, lat): (km in the local plane, lng, lat, segment index)."""
    if len(coords) < 2:
        return None
    squared, px, py, kx = segment_distances(coords, ring, lng, lat)
    index = int(np.argmin(squared))
    if not np.isfinite(squared[index]):
        return None
    return (math.sqrt(float(squared[index])), lng + float(px[index]) / kx, lat + float(py[index]) / KM_PER_DEG_LAT, index)


class BoundaryIndex:
    """Every ring of a layer cut into short runs, so "nearest coastline" reads a
    few hundred vertices instead of a continent's."""

    def __init__(self, geoms, owner_of_part=None):
        rings, part_of_ring = shapely.get_rings(geoms, return_index=True)
        coords, ring_of_coord = shapely.get_coordinates(rings, return_index=True)
        ring_starts = np.flatnonzero(np.r_[True, ring_of_coord[1:] != ring_of_coord[:-1]])
        ring_ends = np.r_[ring_starts[1:], len(coords)]
        chunk_coords, chunk_ids, owners = [], [], []
        chunk = 0
        step = CHUNK_VERTICES - 1
        for start, end in zip(ring_starts.tolist(), ring_ends.tolist()):
            part = int(part_of_ring[ring_of_coord[start]])
            owner = part if owner_of_part is None else int(owner_of_part[part])
            a = start
            while a < end - 1:
                b = min(end, a + CHUNK_VERTICES)
                chunk_coords.append(coords[a:b])
                chunk_ids.append(np.full(b - a, chunk))
                owners.append(owner)
                chunk += 1
                a += step
        self.owner = np.array(owners, dtype=np.int64)
        self.chunks = shapely.linestrings(np.concatenate(chunk_coords), indices=np.concatenate(chunk_ids))
        self.tree = STRtree(self.chunks)

    def nearest(self, lng, lat, max_km, allowed=None):
        """(km, owner, lng, lat) of the nearest boundary within max_km, else None."""
        cos = max(0.02, math.cos(math.radians(lat)))
        for window in NEAREST_LAND_WINDOWS_DEG:
            reach_km = window * KM_PER_DEG_LAT
            half = min(180.0, window / cos)
            found = []
            for shift in (0.0, -360.0, 360.0):
                centre = lng + shift
                if centre - half > 180.0 or centre + half < -180.0:
                    continue
                box = shapely.box(centre - half, max(-90.0, lat - window), centre + half, min(90.0, lat + window))
                found.append(self.tree.query(box))
            hits = np.unique(np.concatenate(found)) if found else np.zeros(0, dtype=np.int64)
            if allowed is not None and len(hits):
                hits = hits[allowed[self.owner[hits]]]
            if len(hits):
                coords, which = shapely.get_coordinates(self.chunks[hits], return_index=True)
                best = nearest_on_rings(coords, which, lng, lat)
                if best is not None and best[0] <= reach_km:
                    km = geodesic_km(lng, lat, best[1], best[2])
                    if km > max_km:
                        return None
                    return (km, int(self.owner[hits[which[best[3]]]]), best[1], best[2])
            if reach_km >= max_km:
                return None
        return None

    def within_many(self, lngs, lats, km):
        """For each point, {owner: km} for every owner whose boundary is within km."""
        lngs = np.asarray(lngs, dtype=float)
        lats = np.asarray(lats, dtype=float)
        result = [None] * len(lngs)
        if not len(self.chunks) or not len(lngs):
            return result
        d_lat = km / KM_PER_DEG_LAT
        d_lng = np.minimum(180.0, km / (KM_PER_DEG_LNG * np.maximum(0.02, np.cos(np.radians(lats)))))
        who = [np.arange(len(lngs))]
        centre = [lngs]
        for shift in (-360.0, 360.0):
            edge = np.flatnonzero((lngs + shift - d_lng <= 180.0) & (lngs + shift + d_lng >= -180.0))
            who.append(edge)
            centre.append(lngs[edge] + shift)
        who = np.concatenate(who)
        centre = np.concatenate(centre)
        boxes = shapely.box(centre - d_lng[who], np.maximum(-90.0, lats[who] - d_lat), centre + d_lng[who], np.minimum(90.0, lats[who] + d_lat))
        box_index, chunk_index = self.tree.query(boxes)
        if not len(box_index):
            return result
        point_index = who[box_index]
        order = np.lexsort((chunk_index, point_index))
        point_index, chunk_index = point_index[order], chunk_index[order]
        starts = np.flatnonzero(np.r_[True, point_index[1:] != point_index[:-1]])
        ends = np.r_[starts[1:], len(point_index)]
        limit = km * km
        for a, b in zip(starts.tolist(), ends.tolist()):
            point = int(point_index[a])
            hits = np.unique(chunk_index[a:b])
            coords, which = shapely.get_coordinates(self.chunks[hits], return_index=True)
            squared = segment_distances(coords, which, float(lngs[point]), float(lats[point]))[0]
            close = np.flatnonzero(squared <= limit)
            if not len(close):
                continue
            found = {}
            owners = self.owner[hits[which[close]]]
            for owner, value in zip(owners.tolist(), squared[close].tolist()):
                if owner not in found or value < found[owner]:
                    found[owner] = value
            result[point] = {owner: math.sqrt(value) for owner, value in found.items()}
        return result


# ── Names ─────────────────────────────────────────────────────────────────────

UNDECOMPOSED = str.maketrans({"ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D",
                              "þ": "th", "Þ": "Th", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ı": "i", "ħ": "h"})


def fold(text):
    """Case, diacritics and punctuation removed; nothing else."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text.translate(UNDECOMPOSED))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    return re.sub(r"[^\w]+", " ", text, flags=re.UNICODE).replace("_", " ").strip()


def qid_of(value):
    match = re.search(r"Q\d+", value or "")
    return match.group(0) if match else None


def clean(value):
    return value if isinstance(value, str) and value and value != "-99" else None


# ── Landmasses ────────────────────────────────────────────────────────────────

class Landmasses:
    def __init__(self, land, minor):
        # `land` 5.1.1 already holds every ring of `minor_islands`; a minor
        # island that touches a land ring is that ring again and is not counted
        # twice. One that touches none is a landmass of its own.
        hit, _ = STRtree(land.geoms).query(minor.geoms, predicate="intersects")
        fresh = np.setdiff1d(np.arange(len(minor.geoms)), hit)
        self.geoms = np.concatenate([land.geoms, minor.geoms[fresh]])
        self.piece_area = np.concatenate([land.part_area, minor.part_area[fresh]])
        self.bounds = shapely.bounds(self.geoms)
        count = len(self.geoms)
        parent = list(range(count))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)

        # Pieces that overlap (a minor island drawn over a land ring) are one landmass.
        tree = STRtree(self.geoms)
        a, b = tree.query(self.geoms, predicate="intersects")
        overlaps = 0
        for i, j in zip(a.tolist(), b.tolist()):
            if i < j:
                union(i, j)
                overlaps += 1
        # Pieces cut at ±180° are one landmass: join an eastern and a western
        # piece where the stretches of latitude they run along the cut overlap
        # (the two files' edges are 180 and −179.9999…, so not an exact test).
        def along_cut(piece, edge):
            ring = shapely.get_coordinates(shapely.get_exterior_ring(self.geoms[piece]))
            on = np.abs(ring[:, 0] - edge) < 1e-6
            both = np.flatnonzero(on[:-1] & on[1:])
            spans = [(min(ring[k, 1], ring[k + 1, 1]), max(ring[k, 1], ring[k + 1, 1])) for k in both.tolist()]
            return [span for span in spans if span[1] - span[0] > 1e-9]

        east = {int(i): along_cut(int(i), 180.0) for i in np.flatnonzero(self.bounds[:, 2] >= 180.0 - 1e-6)}
        west = {int(j): along_cut(int(j), -180.0) for j in np.flatnonzero(self.bounds[:, 0] <= -180.0 + 1e-6)}
        joined = 0
        for i, spans_i in east.items():
            for j, spans_j in west.items():
                if i != j and any(min(a[1], b[1]) - max(a[0], b[0]) > 1e-7 for a in spans_i for b in spans_j):
                    if find(i) != find(j):
                        joined += 1
                    union(i, j)
        self.stats = {"pieces": count, "minorIslandsAlreadyInLand": int(len(minor.geoms) - len(fresh)),
                      "minorIslandsAdded": int(len(fresh)), "touchingPairs": overlaps, "antimeridianJoins": joined}
        roots = np.array([find(i) for i in range(count)])
        order = {root: n for n, root in enumerate(sorted(set(roots.tolist())))}
        self.group = np.array([order[root] for root in roots.tolist()])
        groups = len(order)
        self.area = np.zeros(groups)
        np.add.at(self.area, self.group, self.piece_area)
        self.members = [[] for _ in range(groups)]
        for piece, group in enumerate(self.group.tolist()):
            self.members[group].append(piece)
        # Identity: the area-weighted planar centroid, longitudes unwrapped
        # around the largest piece so a landmass across 180° has one centre.
        centroids = shapely.get_coordinates(shapely.centroid(self.geoms))
        planar = shapely.area(self.geoms)
        self.ids = [None] * groups
        taken = collections.Counter()
        keyed = []
        for group, pieces in enumerate(self.members):
            pieces = np.array(pieces)
            anchor = centroids[pieces[np.argmax(planar[pieces])], 0]
            lngs = (centroids[pieces, 0] - anchor + 180.0) % 360.0 - 180.0 + anchor
            weight = planar[pieces]
            lng = float(np.sum(lngs * weight) / np.sum(weight))
            lat = float(np.sum(centroids[pieces, 1] * weight) / np.sum(weight))
            lng = (lng + 180.0) % 360.0 - 180.0
            key = (f"land:{abs(round(lat * 1000)):05d}{'N' if lat >= 0 else 'S'}"
                   f"{abs(round(lng * 1000)):06d}{'E' if lng >= 0 else 'W'}")
            keyed.append((key, -self.area[group], group))
        for key, _, group in sorted(keyed):
            taken[key] += 1
            self.ids[group] = key if taken[key] == 1 else f"{key}~{taken[key]}"
        self.stats["landmasses"] = groups
        self.stats["idCollisions"] = sum(1 for n in taken.values() if n > 1)
        self.stats["mainlands"] = int(np.sum(self.area >= MAINLAND_MIN_KM2))

    def record(self, group):
        area = float(self.area[group])
        return {"id": self.ids[group], "areaKm2": round_area(area), "kind": "mainland" if area >= MAINLAND_MIN_KM2 else "island"}


def round_area(area):
    return round(area, 3) if area < 10 else round(area, 1) if area < 1000 else int(round(area))


# ── Main ──────────────────────────────────────────────────────────────────────

def read_ndjson(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def candidate_kind(candidate):
    return candidate.get("wvType") or f"wikidata:{candidate.get('featureKind')}"


def percentiles(values, cuts=(50, 90, 99)):
    if not values:
        return {}
    ordered = np.sort(np.array(values, dtype=float))
    summary = {f"p{cut}": round(float(np.percentile(ordered, cut)), 1) for cut in cuts}
    summary["max"] = round(float(ordered[-1]), 1)
    return summary


def main():
    parser = argparse.ArgumentParser(description="Polygon membership for atlas points (stage 08).")
    parser.add_argument("--cache", default=".atlas-cache")
    parser.add_argument("--points")
    parser.add_argument("--candidates")
    parser.add_argument("--out")
    parser.add_argument("--polygons")
    parser.add_argument("--landmasses")
    parser.add_argument("--stats")
    parser.add_argument("--naturalearth", help="directory holding the ne_10m_*.zip files")
    parser.add_argument("--gmba", help="path to GMBA_Inventory_v2.0_standard.zip")
    args = parser.parse_args()
    work = os.path.join(args.cache, "work")
    points_path = args.points or os.path.join(work, "points.ndjson")
    candidates_path = args.candidates or os.path.join(work, "candidates.ndjson")
    out_path = args.out or os.path.join(work, "geometry.ndjson")
    polygons_path = args.polygons or os.path.join(work, "polygons.ndjson")
    landmasses_path = args.landmasses or os.path.join(work, "landmasses.ndjson")
    stats_path = args.stats or os.path.join(work, "geometry-stats.json")
    ne_dir = args.naturalearth or os.path.join(args.cache, "raw", "naturalearth")
    gmba_path = args.gmba or os.path.join(args.cache, "raw", "gmba", GMBA_ZIP)

    stats = {"builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sources": {}, "layers": {}}

    # ── Points ───────────────────────────────────────────────────────────────
    points = read_ndjson(points_path)
    candidates = read_ndjson(candidates_path)
    ids = [point["id"] for point in points]
    lng = [float(point["lng"]) for point in points]
    lat = [float(point["lat"]) for point in points]
    index_of = {identifier: index for index, identifier in enumerate(ids)}
    if len(index_of) != len(ids):
        raise SystemExit("points.ndjson holds a duplicate id")
    output_count = len(ids)
    centre_moved = 0
    candidate_point = []
    for candidate in candidates:
        index = index_of.get(candidate["id"])
        if index is not None and (abs(lng[index] - candidate["lng"]) > 1e-9 or abs(lat[index] - candidate["lat"]) > 1e-9):
            centre_moved += 1
            index = None
        if index is None:
            index = len(lng)
            lng.append(float(candidate["lng"]))
            lat.append(float(candidate["lat"]))
        candidate_point.append(index)
    lng = np.array(lng)
    lat = np.array(lat)
    total = len(lng)
    tree = STRtree(shapely.points(lng, lat))
    candidate_of_point = {point: index for index, point in enumerate(candidate_point)}
    stats["points"] = {"lines": output_count, "candidates": len(candidates), "candidatesWithoutAPointLine": total - output_count,
                       "candidateCentreDiffersFromPointLine": centre_moved}
    log(f"{output_count} points, {len(candidates)} candidates ({total - output_count} centres not in the points file)")

    # ── Layers ───────────────────────────────────────────────────────────────
    def ne(key, keep=None):
        return load_layer(os.path.join(ne_dir, f"{NE_LAYERS[key]}.zip"), key, keep)

    land = ne("land", keep=lambda row: row.get("featurecla") != "Null island")
    minor = ne("minor")
    admin0 = ne("admin0")
    subunit = ne("subunit")
    admin1 = ne("admin1")
    disputed = ne("disputed")
    region = ne("region")
    marine = ne("marine")
    gmba = load_layer(gmba_path, "gmba")
    layers = {"land": land, "minor": minor, "admin0": admin0, "subunit": subunit, "admin1": admin1,
              "disputed": disputed, "region": region, "marine": marine, "gmba": gmba}
    for key, layer in layers.items():
        stats["layers"][key] = {"polygons": len(layer.rows), "parts": int(len(layer.geoms)), "bytes": layer.bytes,
                                "version": layer.version, "repairs": dict(layer.counters)}

    # ── Land ─────────────────────────────────────────────────────────────────
    masses = Landmasses(land, minor)
    stats["land"] = dict(masses.stats)
    largest = np.argsort(-masses.area)[:8]
    stats["land"]["largest"] = [masses.record(int(group)) for group in largest]
    piece_index, point_index = tree.query(masses.geoms, predicate="intersects")
    point_land = np.full(total, -1, dtype=np.int64)
    for piece, point in zip(piece_index.tolist(), point_index.tolist()):
        group = int(masses.group[piece])
        if point_land[point] < 0 or masses.area[group] > masses.area[point_land[point]]:
            point_land[point] = group

    coast = BoundaryIndex(masses.geoms, owner_of_part=masses.group)
    offshore = {}
    for point in np.flatnonzero(point_land < 0).tolist():
        offshore[point] = coast.nearest(float(lng[point]), float(lat[point]), max_km=20000.0)
    log(f"land: {masses.stats['landmasses']} landmasses; {len(offshore)} points at sea")

    # ── Containment ──────────────────────────────────────────────────────────
    for key in ("admin0", "subunit", "admin1", "disputed", "region", "marine", "gmba"):
        layers[key].locate(tree, total)
    log("containment done")

    def smallest(layer, rows):
        return min(rows, key=lambda row: layer.row_area[row]) if rows else None

    # Countries: inside, else the nearest within NEAREST_ADMIN_KM.
    admin0_index = BoundaryIndex(admin0.geoms, owner_of_part=admin0.part_row)
    admin1_index = BoundaryIndex(admin1.geoms, owner_of_part=admin1.part_row)
    admin1_a3 = np.array([row.get("adm0_a3") or "" for row in admin1.rows])
    point_admin0 = {}
    point_admin1 = {}
    for point in range(total):
        row = smallest(admin0, admin0.point_rows[point])
        if row is not None:
            point_admin0[point] = (row, "contains", None)
        else:
            near = admin0_index.nearest(float(lng[point]), float(lat[point]), NEAREST_ADMIN_KM)
            if near is not None:
                point_admin0[point] = (near[1], "nearest", near[0])
        row = smallest(admin1, admin1.point_rows[point])
        if row is not None:
            point_admin1[point] = (row, "contains", None)
        elif point in point_admin0:
            a3 = admin0.rows[point_admin0[point][0]].get("ADM0_A3") or ""
            near = admin1_index.nearest(float(lng[point]), float(lat[point]), NEAREST_ADMIN_KM, allowed=(admin1_a3 == a3))
            if near is not None:
                point_admin1[point] = (near[1], "nearest", near[0])
    log("countries and first-level divisions done")

    # ── Per-row descriptions ─────────────────────────────────────────────────
    def iso2_of(attrs):
        for key in ("ISO_A2", "ISO_A2_EH"):
            value = attrs.get(key) or ""
            if re.fullmatch(r"[A-Z]{2}", value):
                return value
        return None

    sovereign_iso = {attrs.get("SOVEREIGNT"): iso2_of(attrs) for attrs in admin0.rows if attrs.get("ADMIN") == attrs.get("SOVEREIGNT")}

    def admin0_record(row, basis, km):
        attrs = admin0.rows[row]
        record = {"iso2": iso2_of(attrs), "qid": qid_of(attrs.get("WIKIDATAID")), "name": attrs.get("NAME") or attrs.get("ADMIN"),
                  "a3": clean(attrs.get("ADM0_A3")), "sovereignIso2": sovereign_iso.get(attrs.get("SOVEREIGNT")),
                  "type": attrs.get("TYPE") or None, "basis": basis}
        if km is not None:
            record["km"] = round(km, 1)
        return record

    def subunit_record(row):
        attrs = subunit.rows[row]
        return {"a3": clean(attrs.get("SU_A3")), "name": attrs.get("NAME") or attrs.get("SUBUNIT"),
                "qid": qid_of(attrs.get("WIKIDATAID")), "type": attrs.get("TYPE")}

    def admin1_record(row, basis, km):
        attrs = admin1.rows[row]
        code = attrs.get("iso_3166_2") or ""
        record = {"qid": qid_of(attrs.get("wikidataid")), "name": attrs.get("name") or attrs.get("name_en") or None,
                  "iso3166_2": code if re.fullmatch(r"[A-Z]{2}-[A-Z0-9]{1,3}", code) else None,
                  "code": clean(attrs.get("adm1_code")), "basis": basis}
        if km is not None:
            record["km"] = round(km, 1)
        return record

    def disputed_record(row):
        attrs = disputed.rows[row]
        return {"id": f"ne:{attrs.get('NE_ID')}", "name": attrs.get("BRK_NAME") or attrs.get("NAME"),
                "qid": qid_of(attrs.get("WIKIDATAID")), "type": attrs.get("TYPE"), "note": attrs.get("NOTE_BRK") or None}

    def region_record(row):
        attrs = region.rows[row]
        return {"id": f"ne:{attrs.get('NE_ID')}", "name": attrs.get("NAME"), "qid": qid_of(attrs.get("WIKIDATAID")),
                "featurecla": attrs.get("FEATURECLA")}

    def marine_record(row):
        attrs = marine.rows[row]
        return {"id": f"ne:{attrs.get('ne_id')}", "name": attrs.get("name"), "qid": qid_of(attrs.get("wikidataid")),
                "featurecla": attrs.get("featurecla")}

    def range_record(row):
        attrs = gmba.rows[row]
        return {"id": f"gmba:{attrs.get('GMBA_V2_ID')}", "name": attrs.get("MapName"), "qid": qid_of(attrs.get("WikiDataUR")),
                "level": attrs.get("Hier_Lvl"), "areaKm2": round_area(float(gmba.row_area[row])),
                "feature": attrs.get("Feature"), "unit": attrs.get("MapUnit")}

    # ── Ranges a point is beside, not in ─────────────────────────────────────
    # A GMBA polygon is rugged terrain; the valley floor a mountain town stands
    # on is cut out of it. Every range whose terrain begins within
    # RANGE_NEAR_KM is reported with the distance, measured to the "Basic"
    # polygons (the leaves) and passed up their lineage.
    gmba_row_of = {str(attrs.get("GMBA_V2_ID")): row for row, attrs in enumerate(gmba.rows)}
    lineage = []
    for attrs in gmba.rows:
        path = [gmba_row_of.get(part.strip()) for part in (attrs.get("Path_ID") or "").split(">")]
        lineage.append([row for row in path if row is not None])
    leaf_part = np.array([gmba.rows[row].get("MapUnit") == "Basic" for row in gmba.part_row.tolist()])
    range_index = BoundaryIndex(gmba.geoms[leaf_part], owner_of_part=gmba.part_row[leaf_part])
    near_leaves = range_index.within_many(lng, lat, RANGE_NEAR_KM)
    del range_index
    point_ranges_near = {}
    for point, found in enumerate(near_leaves):
        if not found:
            continue
        inside = set(gmba.point_rows[point])
        near = {}
        for leaf, km in found.items():
            for row in lineage[leaf]:
                if row not in inside and (row not in near or km < near[row]):
                    near[row] = km
        if near:
            point_ranges_near[point] = near
    log(f"ranges within {RANGE_NEAR_KM:g} km done")

    # ── geometry.ndjson ──────────────────────────────────────────────────────
    offshore_km = []
    unknown_land = 0
    with open(out_path, "w", encoding="utf-8") as handle:
        for point in range(output_count):
            record = {"id": ids[point]}
            group = int(point_land[point])
            if group >= 0:
                record["land"] = masses.record(group)
                record["offshoreKm"] = None
                record["nearestLand"] = None
            else:
                near = offshore.get(point)
                record["land"] = None
                record["offshoreKm"] = None if near is None else round(near[0], 1)
                record["nearestLand"] = None if near is None else masses.record(near[1])
                if near is None:
                    unknown_land += 1
                else:
                    offshore_km.append(near[0])
            held = point_admin0.get(point)
            record["adm0"] = None if held is None else admin0_record(*held)
            row = smallest(subunit, subunit.point_rows[point])
            record["subunit"] = None if row is None else subunit_record(row)
            held = point_admin1.get(point)
            record["adm1"] = None if held is None else admin1_record(*held)
            record["disputed"] = [disputed_record(row) for row in sorted(disputed.point_rows[point], key=lambda r: -disputed.row_area[r])]
            record["ranges"] = [range_record(row) for row in sorted(
                gmba.point_rows[point], key=lambda r: (gmba.rows[r].get("Hier_Lvl") or 99, -gmba.row_area[r]))]
            beside = point_ranges_near.get(point, {})
            record["rangesNear"] = [{**range_record(row), "km": round(beside[row], 1)} for row in sorted(
                beside, key=lambda r: (gmba.rows[r].get("Hier_Lvl") or 99, beside[r], -gmba.row_area[r]))]
            record["regions"] = [region_record(row) for row in sorted(region.point_rows[point], key=lambda r: -region.row_area[r])]
            record["marine"] = [marine_record(row) for row in sorted(marine.point_rows[point], key=lambda r: -marine.row_area[r])]
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    log(f"wrote {out_path}")

    # ── landmasses.ndjson ────────────────────────────────────────────────────
    land_members = collections.defaultdict(list)
    for index, point in enumerate(candidate_point):
        if point_land[point] >= 0:
            land_members[int(point_land[point])].append(index)
    used = sorted({int(group) for group in point_land[:output_count].tolist() if group >= 0} | set(land_members))
    with open(landmasses_path, "w", encoding="utf-8") as handle:
        for group in sorted(used, key=lambda g: -masses.area[g]):
            box, wraps = wrap_aware_bbox(masses.bounds[np.array(masses.members[group])])
            members = [candidates[index]["id"] for index in land_members.get(group, [])]
            islands = [index for index in land_members.get(group, []) if "island" in (candidates[index].get("selfKinds") or [])]
            sole = None
            if len(islands) == 1 and masses.area[group] < MAINLAND_MIN_KM2:
                declared = candidates[islands[0]].get("wdAreaKm2")
                declared = declared if isinstance(declared, (int, float)) and declared > 0 else None
                sole = {"candidateId": candidates[islands[0]]["id"], "declaredAreaKm2": declared,
                        "areaRatio": None if declared is None else round(float(masses.area[group]) / declared, 3)}
            handle.write(json.dumps({**masses.record(group), "bbox": box, "wraps": wraps, "pieces": len(masses.members[group]),
                                     "memberIds": members, "memberCount": len(members),
                                     "islandCandidateIds": [candidates[index]["id"] for index in islands], "soleIsland": sole},
                                    ensure_ascii=False, separators=(",", ":")) + "\n")
    log(f"wrote {landmasses_path}")

    # ── Matching candidates to polygons ──────────────────────────────────────
    by_qid = {}
    by_name = collections.defaultdict(list)
    for index, candidate in enumerate(candidates):
        if candidate.get("qid"):
            by_qid.setdefault(candidate["qid"], []).append(index)
        seen = set()
        primary = {fold(candidate.get("name")), fold(re.sub(r"\s*\([^)]*\)\s*$", "", candidate.get("title") or ""))} - {""}
        for name in primary:
            seen.add(name)
            by_name[name].append((index, "name"))
        for alias in candidate.get("aliases") or []:
            name = fold(alias)
            if name and name not in seen:
                seen.add(name)
                by_name[name].append((index, "alias"))
    kinds = [candidate_kind(candidate) for candidate in candidates]
    declared_area = [candidate.get("wdAreaKm2") if isinstance(candidate.get("wdAreaKm2"), (int, float)) and candidate.get("wdAreaKm2") > 0 else None
                     for candidate in candidates]

    def names_of(source, attrs):
        """(the polygon's own names, its alternates), folded.

        Natural Earth's NAME_EN / name_en are Wikidata labels fetched through
        the row's QID, so where the QID is wrong they name a different place:
        not used. Its alternates are no better than an atlas alias — the
        province of Brescia lists "Lombardy", Turin lists "Piedmont" — so a
        match through one is held to the alias rule.
        """
        if source == "gmba":
            own, other = [attrs.get("MapName"), attrs.get("DBaseName"), attrs.get("AsciiName")], []
        elif source == "admin1":
            own, other = [attrs.get("name")], (attrs.get("name_alt") or "").split("|")
        elif source in ("admin0", "subunit"):
            own, other = [attrs.get("NAME"), attrs.get("NAME_LONG"), attrs.get("ADMIN" if source == "admin0" else "SUBUNIT")], []
        elif source == "region":
            own, other = [attrs.get("NAME")], (attrs.get("NAMEALT") or "").split("|")
        else:
            own, other = [attrs.get("name")], (attrs.get("namealt") or "").split("|")
        own = {fold(name) for name in own if name} - {""}
        return own, {fold(name) for name in other if name} - {""} - own

    def qid_field(source, attrs):
        return qid_of(attrs.get({"gmba": "WikiDataUR", "admin1": "wikidataid", "marine": "wikidataid"}.get(source, "WIKIDATAID")))

    def source_id(source, attrs):
        if source == "gmba":
            return str(attrs.get("GMBA_V2_ID"))
        if source == "admin1":
            return str(attrs.get("adm1_code") or attrs.get("ne_id"))
        if source == "admin0":
            return str(attrs.get("ADM0_A3"))
        if source == "subunit":
            return str(attrs.get("SU_A3"))
        return str(attrs.get("NE_ID") if source == "region" else attrs.get("ne_id"))

    def display_name(source, attrs):
        return attrs.get({"gmba": "MapName", "admin1": "name", "marine": "name"}.get(source, "NAME")) or None

    source_label = {"admin0": "naturalearth:admin0", "subunit": "naturalearth:subunit", "admin1": "naturalearth:admin1",
                    "region": "naturalearth:region", "marine": "naturalearth:marine", "gmba": "gmba"}
    source_key = {label: key for key, label in source_label.items()}
    country_qids = {qid_field("admin0", attrs) for attrs in admin0.rows} - {None}

    def offerable(source, attrs):
        if source == "gmba":
            return attrs.get("Feature") not in GMBA_NOT_AN_EXTENT
        if source == "subunit":
            # A subunit carrying a country's QID is that country again, or one
            # piece of it; the country layer already has the whole.
            return qid_field("subunit", attrs) not in country_qids
        return True

    def tolerance_km(area):
        return min(25.0, max(5.0, 0.1 * math.sqrt(max(area, 0.0))))

    def in_padded_bbox(layer, row, point, pad_km):
        (west, south, east, north), wraps = layer.row_bbox(row)
        pad_lat = pad_km / KM_PER_DEG_LAT
        pad_lng = pad_km / (KM_PER_DEG_LNG * max(0.02, math.cos(math.radians(float(lat[point])))))
        if not south - pad_lat <= lat[point] <= north + pad_lat:
            return False
        x = float(lng[point])
        if wraps:
            return x >= west - pad_lng or x <= east + pad_lng
        return west - pad_lng <= x <= east + pad_lng

    def area_mismatch(index, area):
        declared = declared_area[index]
        return declared is not None and not (1.0 / AREA_RATIO_LIMIT <= area / declared <= AREA_RATIO_LIMIT)

    matches = []
    rejected = []
    match_stats = collections.defaultdict(collections.Counter)
    for source in ("admin0", "subunit", "admin1", "region", "marine", "gmba"):
        layer = layers[source]
        counter = match_stats[source_label[source]]
        qid_rows = collections.Counter(qid_field(source, attrs) for attrs in layer.rows if offerable(source, attrs))
        claimed_rows = set()
        placed_candidates = set()
        pending = []
        for row, attrs in enumerate(layer.rows):
            if not offerable(source, attrs):
                counter["polygonsNotOfferable"] += 1
                continue
            counter["polygonsOfferable"] += 1
            qid = qid_field(source, attrs)
            if qid:
                counter["polygonsWithQid"] += 1
            for index in by_qid.get(qid, []) if qid else []:
                point = candidate_point[index]
                area = float(layer.row_area[row])
                # A QID is evidence, not truth: several rows of both sources
                # carry another place's QID. The candidate's centre must lie in
                # the polygon, or at least within its bounding box.
                if row not in layer.point_rows[point] and not in_padded_bbox(layer, row, point, tolerance_km(area)):
                    counter["qidRejectedCentreOutsideBbox"] += 1
                    rejected.append({"candidateId": candidates[index]["id"], "source": source_label[source],
                                     "sourceName": display_name(source, attrs), "qid": qid, "areaKm2": round_area(area),
                                     "centreDistKm": round(layer.distance_km(row, float(lng[point]), float(lat[point])) or 0.0, 1)})
                    continue
                flags = []
                if qid_rows[qid] > 1:
                    flags.append(f"qid_shared_by_{qid_rows[qid]}_polygons")
                if area_mismatch(index, area):
                    # Outside the polygon and a different size as well: nothing
                    # but the identifier says these are the same place.
                    if row not in layer.point_rows[point]:
                        counter["qidRejectedOutsideAndAreaMismatch"] += 1
                        rejected.append({"candidateId": candidates[index]["id"], "source": source_label[source],
                                         "sourceName": display_name(source, attrs), "qid": qid, "areaKm2": round_area(area),
                                         "declaredAreaKm2": declared_area[index],
                                         "centreDistKm": round(layer.distance_km(row, float(lng[point]), float(lat[point])) or 0.0, 1)})
                        continue
                    flags.append("area_mismatch")
                pending.append((index, row, "qid", flags))
                claimed_rows.add(row)
                placed_candidates.add(index)
        for row, attrs in enumerate(layer.rows):
            if row in claimed_rows or not offerable(source, attrs):
                continue
            qid = qid_field(source, attrs)
            area = float(layer.row_area[row])
            eligible = {}
            own_names, alternates = names_of(source, attrs)
            for names, exact in ((own_names, True), (alternates, False)):
                for name in names:
                    for index, how in by_name.get(name, []):
                        if index in placed_candidates or kinds[index] in NAME_MATCH_EXCLUDED_KINDS:
                            continue
                        how = how if exact else "alias"
                        if how == "name" or index not in eligible:
                            eligible[index] = how
            near = []
            for index, how in eligible.items():
                point = candidate_point[index]
                if row in layer.point_rows[point]:
                    near.append((index, how))
                    continue
                allowed = tolerance_km(area)
                if not in_padded_bbox(layer, row, point, allowed):
                    continue
                distance = layer.distance_km(row, float(lng[point]), float(lat[point]))
                if distance is not None and distance <= allowed:
                    near.append((index, how))
            if not near:
                continue
            sized = [entry for entry in near if not area_mismatch(entry[0], area)]
            if not sized:
                counter["nameRejectedAreaMismatch"] += 1
                continue
            # An alias in the atlas is a redirect, and a redirect is as often
            # from a constituent ("Dolj County" → Oltenia) as from a synonym.
            # It may tie a candidate to a polygon only with a second, independent
            # agreement: the centre inside and the published area within a quarter.
            by_how = [entry for entry in sized if entry[1] == "name"]
            if not by_how:
                by_how = [entry for entry in sized if declared_area[entry[0]] is not None
                          and row in layer.point_rows[candidate_point[entry[0]]]
                          and abs(area / declared_area[entry[0]] - 1.0) <= ALIAS_AREA_TOLERANCE]
                if not by_how:
                    counter["aliasRejectedWithoutAreaAgreement"] += 1
                    continue
            if len(by_how) > 1:
                counter["nameAmbiguousPolygons"] += 1
                continue
            index, how = by_how[0]
            flags = []
            if qid and candidates[index].get("qid") and candidates[index]["qid"] != qid:
                flags.append("qid_differs")
            elif qid and not candidates[index].get("qid"):
                flags.append("candidate_has_no_qid")
            if declared_area[index] is None:
                flags.append("no_declared_area")
            pending.append((index, row, how, flags))
        # One candidate, several polygons of a layer by name: keep them, and say so.
        per_candidate = collections.Counter(index for index, _, how, _ in pending if how != "qid")
        for index, row, how, flags in pending:
            if how != "qid" and per_candidate[index] > 1:
                flags = flags + [f"name_matches_{per_candidate[index]}_polygons"]
            matches.append((source, index, row, how, flags))
            counter[f"matchedBy_{how}"] += 1
    log(f"{len(matches)} polygon matches ({len(rejected)} QID matches refused)")

    # Candidates just outside a matched polygon (a harbour town off a coarse
    # coastline, a valley town below a range): reported apart from members.
    all_candidate_points = np.array(candidate_point)
    near_members = {}
    for source in ("admin0", "subunit", "admin1", "region", "marine", "gmba"):
        layer = layers[source]
        rows = sorted({row for s, _, row, _, _ in matches if s == source})
        if not rows:
            continue
        wanted = np.isin(layer.part_row, np.array(rows))
        index = BoundaryIndex(layer.geoms[wanted], owner_of_part=layer.part_row[wanted])
        found = index.within_many(lng[all_candidate_points], lat[all_candidate_points], POLYGON_NEAR_KM)
        del index
        for candidate_number, hits in enumerate(found):
            if not hits:
                continue
            inside = layer.point_rows[candidate_point[candidate_number]]
            for row, km in hits.items():
                if row not in inside:
                    near_members.setdefault((source, row), []).append((candidate_number, km))
    log("near members done")

    # The travel hierarchy as a second opinion on every match: of the
    # candidate's direct children, how many does the polygon hold?
    children = collections.defaultdict(list)
    candidate_index = {candidate["id"]: index for index, candidate in enumerate(candidates)}
    for index, candidate in enumerate(candidates):
        parents = candidate.get("parents") or []
        if parents and parents[0] in candidate_index:
            children[candidate_index[parents[0]]].append(index)

    polygon_lines = []
    for source, index, row, how, flags in matches:
        layer = layers[source]
        attrs = layer.rows[row]
        candidate = candidates[index]
        point = candidate_point[index]
        inside = row in layer.point_rows[point]
        distance = 0.0 if inside else layer.distance_km(row, float(lng[point]), float(lat[point]))
        parts = layer.row_parts[row]
        by_area = parts[np.argsort(-layer.part_area[parts], kind="stable")]
        rank = {int(part): position for position, part in enumerate(by_area.tolist())}
        box, wraps = layer.row_bbox(row)
        area = float(layer.row_area[row])
        centre_part = None
        if inside:
            part = layer.point_part[(point, row)]
            centre_part = {"index": rank[part], "areaKm2": round_area(float(layer.part_area[part])),
                           "bbox": [round(float(value), 4) for value in layer.part_bounds[part]]}
        members = sorted({candidate_of_point[p] for p in layer.row_points[row] if p in candidate_of_point})
        beside = sorted(near_members.get((source, row), []))
        part_list = []
        for part in by_area[:10].tolist():
            part_list.append({"areaKm2": round_area(float(layer.part_area[part])),
                              "bbox": [round(float(value), 4) for value in layer.part_bounds[part]],
                              "memberCount": sum(1 for p in layer.part_points.get(part, []) if p in candidate_of_point)})
        flags = list(flags)
        if not inside:
            flags.append("centre_outside")
        if source == "gmba":
            flags.append("mountain_terrain_only")
        kids = children.get(index, [])
        member_set = set(members)
        beside_set = {member for member, _ in beside}
        kids_inside = sum(1 for kid in kids if kid in member_set)
        kids_near = sum(1 for kid in kids if kid in beside_set and kid not in member_set)
        if len(kids) >= CHILDREN_MIN and (kids_inside + kids_near) < CHILDREN_DISAGREE_SHARE * len(kids):
            flags.append("children_disagree")
        polygon_lines.append({
            "candidateId": candidate["id"], "source": source_label[source], "sourceId": source_id(source, attrs),
            "sourceName": display_name(source, attrs), "polygonQid": qid_field(source, attrs), "matchedBy": how,
            "centreInside": inside, "centreDistKm": None if distance is None else round(distance, 1),
            "areaKm2": round_area(area), "declaredAreaKm2": declared_area[index], "bbox": box, "wraps": wraps, "parts": int(len(parts)),
            "largestPartShare": round(float(layer.part_area[by_area[0]]) / area, 4) if area > 0 else None,
            "centrePart": centre_part, "partList": part_list,
            "memberIds": [candidates[member]["id"] for member in members], "memberCount": len(members),
            "nearKm": POLYGON_NEAR_KM, "nearMemberIds": [candidates[member]["id"] for member, _ in beside], "nearMemberCount": len(beside),
            "children": {"count": len(kids), "inside": kids_inside, "near": kids_near},
            "flags": flags, "_candidate": index, "_members": members, "_near": [member for member, _ in beside], "_row": row})
    polygon_lines.sort(key=lambda line: (line["candidateId"], line["source"], line["sourceId"]))
    with open(polygons_path, "w", encoding="utf-8") as handle:
        for line in polygon_lines:
            handle.write(json.dumps({key: value for key, value in line.items() if not key.startswith("_")},
                                    ensure_ascii=False, separators=(",", ":")) + "\n")
    log(f"wrote {polygons_path}")

    # ── Statistics ───────────────────────────────────────────────────────────
    stats["matching"] = {source: dict(counter) for source, counter in match_stats.items()}
    stats["qidMatchesRefused"] = {"count": len(rejected), "farthest": sorted(rejected, key=lambda entry: -entry["centreDistKm"])[:40]}
    matched = collections.defaultdict(set)
    for line in polygon_lines:
        matched[line["_candidate"]].add(line["source"])
    kind_total = collections.Counter(kinds)
    kind_matched = collections.Counter(kinds[index] for index in matched)
    kind_by_source = collections.defaultdict(collections.Counter)
    for index, sources in matched.items():
        for source in sources:
            kind_by_source[kinds[index]][source] += 1
    stats["matchRateByKind"] = {kind: {"candidates": kind_total[kind], "matched": kind_matched[kind],
                                       "rate": round(kind_matched[kind] / kind_total[kind], 4), "bySource": dict(kind_by_source[kind])}
                                for kind in sorted(kind_total, key=lambda k: -kind_total[k])}
    stats["matchedCandidates"] = len(matched)
    stats["polygonLines"] = len(polygon_lines)
    stats["polygonLinesBySource"] = dict(collections.Counter(line["source"] for line in polygon_lines))
    flag_count = collections.defaultdict(collections.Counter)
    for line in polygon_lines:
        for flag in line["flags"]:
            flag_count[line["source"]][re.sub(r"\d+", "N", flag)] += 1
    stats["matchFlags"] = {source: dict(counter) for source, counter in flag_count.items()}
    stats["centreOutsideFarthest"] = [
        {"candidateId": line["candidateId"], "source": line["source"], "sourceName": line["sourceName"], "matchedBy": line["matchedBy"],
         "centreDistKm": line["centreDistKm"], "areaKm2": line["areaKm2"], "parts": line["parts"]}
        for line in sorted(polygon_lines, key=lambda l: -(l["centreDistKm"] or 0)) if not line["centreInside"]][:40]

    # Hierarchy against polygon: direct children of a matched candidate.
    stats["hierarchyParentsWithThreeChildren"] = sum(1 for kids in children.values() if len(kids) >= 3)
    agreement = []
    for line in polygon_lines:
        kids = children.get(line["_candidate"], [])
        if len(kids) < CHILDREN_MIN:
            continue
        members = set(line["_members"])
        beside = set(line["_near"])
        guide = [kid for kid in kids if candidates[kid]["source"] == "wikivoyage"]
        derived = [kid for kid in kids if candidates[kid]["source"] != "wikivoyage"]
        outside = [kid for kid in kids if kid not in members]
        layer = layers[source_key[line["source"]]]
        distances = []
        for kid in outside[:300]:
            point = candidate_point[kid]
            distance = layer.distance_km(line["_row"], float(lng[point]), float(lat[point]))
            if distance is not None:
                distances.append(distance)
        inside_count = len(kids) - len(outside)
        agreement.append({
            "candidateId": line["candidateId"], "kind": kinds[line["_candidate"]], "source": line["source"],
            "sourceName": line["sourceName"], "matchedBy": line["matchedBy"], "areaKm2": line["areaKm2"],
            "declaredAreaKm2": line["declaredAreaKm2"], "parts": line["parts"],
            "children": len(kids), "inside": inside_count, "share": round(inside_count / len(kids), 3),
            "insideOrNear": inside_count + sum(1 for kid in outside if kid in beside),
            "guideChildren": len(guide), "guideInside": sum(1 for kid in guide if kid in members),
            "derivedChildren": len(derived), "derivedInside": sum(1 for kid in derived if kid in members),
            "centreInside": line["centreInside"], "flags": line["flags"],
            "outsideMedianKm": round(float(np.median(distances)), 1) if distances else None,
            "outsideMaxKm": round(max(distances), 1) if distances else None,
            "outsideExamples": [candidates[kid]["id"] for kid in outside[:4]]})

    def summarise(entries):
        kids = sum(entry["children"] for entry in entries)
        inside = sum(entry["inside"] for entry in entries)
        near = sum(entry["insideOrNear"] for entry in entries)
        guide = sum(entry["guideChildren"] for entry in entries)
        guide_in = sum(entry["guideInside"] for entry in entries)
        derived = sum(entry["derivedChildren"] for entry in entries)
        derived_in = sum(entry["derivedInside"] for entry in entries)
        shares = [entry["share"] for entry in entries]
        return {"parents": len(entries), "children": kids, "inside": inside, "share": round(inside / kids, 4) if kids else None,
                "shareInsideOrNear": round(near / kids, 4) if kids else None,
                "medianParentShare": round(float(np.median(shares)), 3) if shares else None,
                "parentsAllInside": sum(1 for share in shares if share == 1.0),
                "parentsAtLeast80Percent": sum(1 for share in shares if share >= 0.8),
                "parentsUnderHalf": sum(1 for share in shares if share < 0.5),
                "parentsNoneInside": sum(1 for share in shares if share == 0.0),
                "guideChildren": guide, "guideShare": round(guide_in / guide, 4) if guide else None,
                "derivedChildren": derived, "derivedShare": round(derived_in / derived, 4) if derived else None}

    by_source = collections.defaultdict(list)
    by_how = collections.defaultdict(list)
    for entry in agreement:
        by_source[entry["source"]].append(entry)
        by_how[entry["matchedBy"]].append(entry)
    clean_lines = [entry for entry in agreement if not ({"area_mismatch", "centre_outside"} & set(entry["flags"])) and not any(
        flag.startswith("qid_shared") for flag in entry["flags"])]
    stats["hierarchyLinesFlaggedChildrenDisagree"] = dict(collections.Counter(
        line["source"] for line in polygon_lines if "children_disagree" in line["flags"]))
    stats["hierarchy"] = {"all": summarise(agreement), "unflagged": summarise(clean_lines),
                          "bySource": {source: summarise(entries) for source, entries in by_source.items()},
                          "byMatch": {how: summarise(entries) for how, entries in by_how.items()},
                          "worst": sorted(agreement, key=lambda entry: (entry["share"], -entry["children"]))[:40],
                          "worstUnflaggedNonGmba": sorted([entry for entry in clean_lines if entry["source"] != "gmba"],
                                                          key=lambda entry: (entry["share"], -entry["children"]))[:40]}

    # Sea, land and islands.
    def offshore_of(index):
        near = offshore.get(candidate_point[index])
        return None if near is None else near[0]

    sea_candidates = [index for index, point in enumerate(candidate_point) if point_land[point] < 0]
    sea_distance = [offshore_of(index) for index in sea_candidates if offshore_of(index) is not None]

    def banded(values):
        bands = collections.Counter()
        for km in values:
            bands["<=1" if km <= 1 else "<=5" if km <= 5 else "<=25" if km <= 25 else "<=100" if km <= 100 else ">100"] += 1
        return {band: bands[band] for band in ("<=1", "<=5", "<=25", "<=100", ">100")}

    sea_by_kind = collections.Counter(kinds[index] for index in sea_candidates)
    far_by_kind = collections.Counter(kinds[index] for index in sea_candidates if (offshore_of(index) or 0) > 25)
    farthest = sorted(sea_candidates, key=lambda index: -(offshore_of(index) or 0))[:30]
    base_sea = [point for point in range(output_count) if ids[point].endswith("#base") and point_land[point] < 0]
    stats["sea"] = {
        "pointLinesAtSea": int(np.sum(point_land[:output_count] < 0)), "pointLinesWithNoLandFound": unknown_land,
        "pointLineDistanceKm": percentiles(offshore_km), "candidateCentresAtSea": len(sea_candidates),
        "candidateDistanceKm": percentiles(sea_distance), "candidateDistanceBands": banded(sea_distance),
        "candidateCentresAtSeaByKind": dict(sea_by_kind.most_common()),
        "candidateCentresOver25KmOffshoreByKind": dict(far_by_kind.most_common()),
        "basePoints": sum(1 for identifier in ids if identifier.endswith("#base")),
        "basePointsAtSea": len(base_sea),
        "basePointDistanceBands": banded([offshore[point][0] for point in base_sea if offshore.get(point)]),
        "basePointDistanceKm": percentiles([offshore[point][0] for point in base_sea if offshore.get(point)]),
        "farthest": [{"id": candidates[index]["id"], "name": candidates[index].get("name"), "kind": kinds[index],
                      "km": None if offshore_of(index) is None else round(offshore_of(index), 1)} for index in farthest]}

    def is_island(candidate):
        return "island" in (candidate.get("selfKinds") or [])

    def is_group(candidate):
        return "islands" in (candidate.get("selfKinds") or [])

    island_on = collections.defaultdict(list)
    island_summary = collections.Counter()
    island_sea = collections.Counter()
    island_sea_km = []
    on_mainland = []
    for index, candidate in enumerate(candidates):
        if not is_island(candidate):
            continue
        island_summary["candidates"] += 1
        group = int(point_land[candidate_point[index]])
        if group < 0:
            island_summary["centreAtSea"] += 1
            near = offshore.get(candidate_point[index])
            if near is None:
                continue
            island_sea_km.append(near[0])
            declared = declared_area[index]
            close = near[0] <= 5.0
            if not close:
                island_sea["nearestLandOver5Km"] += 1
            elif declared is None:
                island_sea["within5Km_noDeclaredArea"] += 1
            elif 0.5 <= masses.area[near[1]] / declared <= 2.0:
                island_sea["within5Km_ofALandmassItsOwnSize"] += 1
            elif masses.area[near[1]] / declared > 2.0:
                island_sea["within5Km_ofAMuchLargerLandmass"] += 1
            else:
                island_sea["within5Km_ofAMuchSmallerLandmass"] += 1
        elif masses.area[group] >= MAINLAND_MIN_KM2:
            island_summary["onAMainland"] += 1
            on_mainland.append(index)
        else:
            island_on[group].append(index)
    shared_examples = []
    for group, members in island_on.items():
        if len(members) == 1:
            island_summary["aloneOnItsLandmass"] += 1
        else:
            island_summary["sharingALandmass"] += len(members)
            island_summary["landmassesShared"] += 1
            sources = {candidates[index]["source"] for index in members}
            island_summary["sharedByOneGuideAndOneDerived" if len(members) == 2 and len(sources) == 2 else "sharedOtherwise"] += 1
            shared_examples.append({"land": masses.record(group), "count": len(members),
                                    "islands": [f"{candidates[index]['id']} ({candidates[index].get('name')})" for index in members[:6]]})
    shared_examples.sort(key=lambda entry: (-entry["count"], -entry["land"]["areaKm2"]))
    ratio = []
    for group, members in island_on.items():
        if len(members) == 1 and declared_area[members[0]] is not None:
            ratio.append(masses.area[group] / declared_area[members[0]])
    ratio = np.array(ratio)
    stats["islands"] = {**dict(island_summary), "centreAtSeaDistanceKm": percentiles(island_sea_km),
                        "centreAtSeaDistanceBands": banded(island_sea_km), "centreAtSeaReading": dict(island_sea),
                        "aloneWithDeclaredArea": int(len(ratio)),
                        "aloneLandmassWithin25PercentOfDeclaredArea": int(np.sum((ratio > 0.75) & (ratio < 1.25))) if len(ratio) else 0,
                        "aloneLandmassOverTwiceDeclaredArea": int(np.sum(ratio > 2.0)) if len(ratio) else 0,
                        "aloneLandmassUnderHalfDeclaredArea": int(np.sum(ratio < 0.5)) if len(ratio) else 0,
                        "sharedExamples": shared_examples[:30],
                        "onAMainlandExamples": [f"{candidates[index]['id']} ({candidates[index].get('name')})" for index in on_mainland[:40]]}
    group_summary = collections.Counter()
    for index, candidate in enumerate(candidates):
        if is_group(candidate):
            group_summary["candidates"] += 1
            group = int(point_land[candidate_point[index]])
            group_summary["centreAtSea" if group < 0 else "centreOnAMainland" if masses.area[group] >= MAINLAND_MIN_KM2 else "centreOnAnIsland"] += 1
    stats["islandGroups"] = dict(group_summary)
    land_kind = collections.Counter()
    for index, point in enumerate(candidate_point):
        group = int(point_land[point])
        land_kind["atSea" if group < 0 else "mainland" if masses.area[group] >= MAINLAND_MIN_KM2 else "island"] += 1
    stats["candidatesByLand"] = dict(land_kind)
    stats["landmassesHoldingACandidate"] = len(land_members)

    # Countries: the polygon against what the candidate already says.
    country = collections.Counter()
    disagreements = collections.Counter()
    for index, candidate in enumerate(candidates):
        held = point_admin0.get(candidate_point[index])
        declared = candidate.get("countries") or []
        if held is None:
            country["noCountryWithin400Km"] += 1
            continue
        country["byContainment" if held[1] == "contains" else "byNearest"] += 1
        record = admin0_record(*held)
        if record["iso2"] is None:
            country["polygonHasNoIso2"] += 1
        if len(declared) == 1 and record["iso2"] is not None:
            country["comparable"] += 1
            if declared[0] == record["iso2"]:
                country["agree"] += 1
            elif declared[0] == record["sovereignIso2"]:
                country["agreeWithSovereign"] += 1
            else:
                country["disagree"] += 1
                country["disagreeByContainment" if held[1] == "contains" else "disagreeByNearest"] += 1
                disagreements[f"{declared[0]}→{record['iso2']}"] += 1
    stats["countries"] = {**dict(country), "topDisagreements": dict(disagreements.most_common(40))}
    with_adm1 = [point for point in range(output_count) if point in point_admin1]
    mismatch = 0
    for point in with_adm1:
        held = point_admin0.get(point)
        if held is not None and held[1] == "contains" and point_admin1[point][1] == "contains":
            if (admin1.rows[point_admin1[point][0]].get("adm0_a3") or "") != (admin0.rows[held[0]].get("ADM0_A3") or ""):
                mismatch += 1
    stats["adm1"] = {"pointLinesWithAdm1": len(with_adm1),
                     "byNearest": sum(1 for point in with_adm1 if point_admin1[point][1] == "nearest"),
                     "withIso3166_2": sum(1 for point in with_adm1 if admin1_record(*point_admin1[point])["iso3166_2"]),
                     "withQid": sum(1 for point in with_adm1 if admin1_record(*point_admin1[point])["qid"]),
                     "insideAnAdm1OfAnotherCountryThanAdm0": mismatch}
    stats["disputed"] = {"pointLinesInADisputedArea": sum(1 for point in range(output_count) if disputed.point_rows[point]),
                         "byArea": dict(collections.Counter(
                             disputed_record(row)["name"] for point in range(output_count) for row in disputed.point_rows[point]).most_common(25))}

    # Ranges.
    depth = collections.Counter(min(len(gmba.point_rows[point]), 10) for point in range(output_count))
    broken = 0
    for point in range(output_count):
        rows = set(gmba.point_rows[point])
        if any(ancestor not in rows for row in rows for ancestor in lineage[row]):
            broken += 1
    only_near = [point for point in range(output_count) if not gmba.point_rows[point] and point in point_ranges_near]
    nearest_km = [min(point_ranges_near[point].values()) for point in only_near]
    stats["ranges"] = {"pointLinesInAnyRange": sum(count for depth_value, count in depth.items() if depth_value > 0),
                       "polygonsPerPoint": {str(key): depth[key] for key in sorted(depth)},
                       "pointsWhereAnAncestorPolygonDoesNotContainThePoint": broken,
                       "pointLinesInNoRangeButWithin25Km": len(only_near),
                       "ofThoseWithin2Km": sum(1 for km in nearest_km if km <= 2), "ofThoseWithin5Km": sum(1 for km in nearest_km if km <= 5),
                       "ofThoseWithin10Km": sum(1 for km in nearest_km if km <= 10),
                       "basePointsInARange": sum(1 for point in range(output_count) if ids[point].endswith("#base") and gmba.point_rows[point]),
                       "basePointsOnlyNearARange": sum(1 for point in only_near if ids[point].endswith("#base")),
                       "pointLinesInARegion": sum(1 for point in range(output_count) if region.point_rows[point]),
                       "pointLinesInAMarinePolygon": sum(1 for point in range(output_count) if marine.point_rows[point])}

    stats["seconds"] = round(time.time() - T0, 1)
    with open(stats_path, "w", encoding="utf-8") as handle:
        json.dump(stats, handle, ensure_ascii=False, indent=1)
    log(f"wrote {stats_path} — done in {stats['seconds']} s")


if __name__ == "__main__":
    try:
        main()
    except SourceError as error:
        sys.stderr.write(f"08-geometry: {error}\n")
        sys.exit(2)
