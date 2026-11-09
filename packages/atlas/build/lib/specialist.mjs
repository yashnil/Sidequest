/**
 * ACTIVITY-SPECIFIC EVIDENCE FOR THE EXPERIENCE ESTIMATORS.
 *
 * A fifth signal beside guide text, child places, general features and terrain:
 * for each experience, the most direct open evidence that exists. Dark-sky
 * radiance with cloud for night skies; thermal baths for hot springs; heritage
 * and mountain railways for rail; documented species and Ramsar sites for
 * birding; flagship mammals inside a protected place for safari; huts for
 * trekking. Each is 0–1 and the weight it earns is fitted, per experience, on
 * the curated labels and reported held-out, so a weak signal earns little.
 *
 * The ski file is deliberately absent. It is an ODbL derivative database and is
 * joined in memory at run time (`Atlas.attachSkiAreas`), never written here.
 */
import { PointGrid } from './geo-index.mjs';

const saturate = (x, k) => 1 - Math.exp(-x / k);
const clamp = (x, low = 0, high = 1) => Math.min(high, Math.max(low, x));

/** The kinds that count for each experience, with what one of them is worth. */
const FEATURE_WORTH = {
  hot_springs_wellness: { thermal_bath: 2, geyser: 1, spa: 1 },
  rail_journeys: { rail_mountain: 2, rail_narrow: 1, rail_named: 2, rail_funicular: 0.5 },
  snorkel_dive: { dive_site: 2, wreck: 0.4, marine_reserve: 2 },
  multi_day_trekking: { hut: 1, trail_long: 2 },
  high_mountains: { peak_prominent: 1, via_ferrata: 1, climbing: 0.5 },
  villages_culture: { cathedral: 0.5, fortress: 0.5, open_air_museum: 1 },
  food: { food_market: 2 },
  scenic_driving: { drive_mountain: 2 },
  birding: { ramsar: 2, bird_site: 2, bird_spa: 1, wildlife_refuge: 1 },
};
const WANTED_KINDS = new Set([...Object.values(FEATURE_WORTH).flatMap((table) => Object.keys(table)), 'darksky_designated', 'darksky']);
const PROTECTED_KIND = /national_park|protected_area|wilderness/;
const NOT_SAFARI_GROUPS = /northern|canid|bear/;

/** Reads the evidence files into the lookups the signal needs. Missing files are simply no evidence. */
export async function loadSpecialist({ features, night, sky, wildlife, iucn }) {
  const grid = new PointGrid();
  for (const feature of features) if (feature.kinds.some((kind) => WANTED_KINDS.has(kind))) grid.add(feature.lat, feature.lng, feature.kinds);
  return { grid, night, sky, wildlife, iucn };
}

function countsNear(grid, candidate) {
  const counts = {};
  const km = clamp(candidate.radiusKm, 8, 60);
  grid.near(candidate.lat, candidate.lng, km, (kinds) => {
    for (const kind of kinds) if (WANTED_KINDS.has(kind)) counts[kind] = (counts[kind] ?? 0) + 1;
  });
  return counts;
}

/** Best six months of cloud, as a mean percentage. */
const clearSeasonCloud = (cloud) => {
  const sorted = [...cloud].sort((a, b) => a - b);
  return sorted.slice(0, 6).reduce((sum, value) => sum + value, 0) / 6;
};

export function specialistSignals(candidate, kind, raster, data) {
  const out = {};
  const counts = countsNear(data.grid, candidate);
  for (const [experience, worth] of Object.entries(FEATURE_WORTH)) {
    const total = Object.entries(worth).reduce((sum, [name, value]) => sum + (counts[name] ?? 0) * value, 0);
    if (total > 0) out[experience] = saturate(total, 3);
  }

  const night = data.night.get(candidate.id);
  const sky = data.sky.get(`${candidate.id}#base`) ?? data.sky.get(candidate.id);
  const sqm = night?.darkest25?.sqm ?? night?.sqm ?? null;
  if (sqm !== null && sky?.cloud) {
    const dark = clamp((sqm - 20.5) / 1.4);
    const clear = clamp((80 - clearSeasonCloud(sky.cloud)) / 55);
    out.night_skies = dark * (0.3 + 0.7 * clear);
  }
  if ((counts.darksky_designated ?? 0) + (counts.darksky ?? 0) > 0) out.night_skies = Math.max(out.night_skies ?? 0, 0.9);

  const wild = data.wildlife.get(candidate.id) ?? (candidate.curated ? data.wildlife.get(`curated:${candidate.curated}`) : undefined);
  if (wild) {
    /* A town shares a 1° cell with the reserve beside it; being a protected place is what tells them apart. */
    const category = candidate.qid ? data.iucn.get(candidate.qid) : undefined;
    const shelter = PROTECTED_KIND.test(kind) || category ? 1 : 0.45;
    const large = Object.entries(wild.flagship?.groups ?? {}).reduce((sum, [group, row]) => sum + (NOT_SAFARI_GROUPS.test(group) ? 0 : row.species3), 0);
    if (large > 0) out.big_game_safari = saturate(large, 5) * shelter;
    out.wildlife_general = (0.6 * saturate(wild.flagship?.species3 ?? 0, 4) + 0.4 * saturate(wild.mammalSpecies3 ?? 0, 40)) * (0.5 + 0.5 * shelter);
    if (wild.birdSpeciesRare1k) out.birding = Math.max(out.birding ?? 0, 0.6 * clamp((wild.birdSpeciesRare1k - 120) / 160) * (0.5 + 0.5 * shelter) + 0.4 * (out.birding ?? 0));
    if (raster?.sea?.coastKm !== null && raster?.sea?.coastKm !== undefined && raster.sea.coastKm <= 40) out.marine_wildlife = saturate(wild.marine?.species3 ?? 0, 5);
  }

  /* A road worth driving is climbing or following a coast; no open dataset names them. */
  if (raster?.base) {
    const relief = raster.high ? raster.high.elevM - raster.base.elevM : 0;
    const coast = raster.sea?.coastKm !== null && raster.sea?.coastKm !== undefined && raster.sea.coastKm <= 12 ? 0.6 : 0;
    const proxy = Math.max(clamp(relief / 1500), coast);
    out.scenic_driving = Math.max(out.scenic_driving ?? 0, proxy * (candidate.radiusKm >= 25 ? 1 : 0.4));
  }
  return out;
}

/**
 * What direct evidence establishes outright, as a floor on the 0–3 estimate.
 *
 * A linear fit on 216 labelled places cannot learn that one designated dark-sky
 * park settles the question, so a rare, decisive signal never reaches "strong".
 * These are presence facts inside a tight radius, and their agreement with the
 * curated labels is reported at build time.
 */
export function directFloors(candidate, data) {
  const floors = {};
  const counts = {};
  data.grid.near(candidate.lat, candidate.lng, Math.min(25, Math.max(6, candidate.radiusKm)), (kinds) => {
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  });
  if ((counts.darksky_designated ?? 0) > 0) floors.night_skies = 2.5;
  if ((counts.thermal_bath ?? 0) + (counts.geyser ?? 0) > 0) floors.hot_springs_wellness = (counts.thermal_bath ?? 0) + (counts.geyser ?? 0) >= 2 ? 2.5 : 2;
  if ((counts.rail_mountain ?? 0) + (counts.rail_narrow ?? 0) + (counts.rail_named ?? 0) > 0) floors.rail_journeys = 2;
  /* Only 5 of 25 curated places with a wetland site beside them are labelled strong for birding: a site lifts a place, it does not settle it. */
  if ((counts.ramsar ?? 0) + (counts.bird_site ?? 0) > 0) floors.birding = 1.5;
  if ((counts.hut ?? 0) >= 2 || (counts.trail_long ?? 0) > 0) floors.multi_day_trekking = 2;
  return floors;
}

/** The ski file, reduced to what the run-time join needs and kept under its own licence. */
export function skiRows(rows) {
  return rows.filter((row) => row.status === 'operating' && row.activities?.includes('downhill') && (row.liftCount ?? 0) >= 1).map((row) => [Math.round(row.lat * 1e4) / 1e4, Math.round(row.lng * 1e4) / 1e4, row.liftCount, Math.round(row.verticalM ?? 0), Math.round(row.maxElevM ?? 0), Math.round(row.runKmTotal ?? 0)]);
}
