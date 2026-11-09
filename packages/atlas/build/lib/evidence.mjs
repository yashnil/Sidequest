/**
 * WHAT THE ATLAS NOW KNOWS BEYOND CIRCLES AND COUNTRY AVERAGES.
 *
 * Pure functions over the work files of stages 08 (geometry), 12 (prices) and
 * `advisories.mjs`, used by `06-assemble.mjs`:
 *
 * - **Location checks and landmasses.** A row whose centre is far out at sea is
 *   a bad coordinate, however good its text. Two places on different landmasses
 *   are different trips, however their circles overlap.
 * - **Polygon scope.** A named region with a real boundary contains what lies
 *   inside the boundary, and a derived place the polygon refuses is re-filed.
 * - **Regional advisories.** A warning covers a destination only when the warned
 *   area contains it. What cannot be resolved stays a caution: it is never
 *   dropped, and no place is called safe because no warning was matched.
 * - **Cost.** Precision-weighted shrinkage: a prior from the destination's
 *   hierarchy and country, updated by its own dated listings, with a range.
 */

export const fold = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const GENERIC = /\b(state|states|county|counties|province|provinces|department|departments|region|regions|governorate|governorates|district|districts|division|prefecture|oblast|territory|municipality)\b/g;
export const placeKey = (text) => fold(text).replace(GENERIC, ' ').replace(/^the /, '').replace(/\s+/g, ' ').trim();

// ── Location ────────────────────────────────────────────────────────────────

const ISLANDLIKE = /island|archipelago|atoll|reef|sea|ocean|marine|coast/;

/**
 * Whether a row's coordinates contradict what it is. A town 800 km into an
 * ocean is a wrong sign somewhere. Islands are held to less, because the land
 * layer does not draw every small one, and only fail when the nearest land is
 * also in another country.
 */
export function suspectLocation(candidate, geometry, wikidataKind) {
  if (!geometry || geometry.offshoreKm === null || geometry.offshoreKm === undefined) return false;
  const islandlike = ISLANDLIKE.test(`${wikidataKind ?? ''} ${candidate.wvType ?? ''}`) || (candidate.selfKinds ?? []).some((kind) => ISLANDLIKE.test(kind));
  if (!islandlike) return geometry.offshoreKm > 25;
  return false;
}

/**
 * The landmass a row stands on, or null when that cannot be said. An island
 * whose centre falls in the water adopts the nearest land only when that land
 * is about its own size: otherwise the island is simply not drawn, and calling
 * it part of the big neighbour would merge two separate trips.
 */
export function landmassOf(candidate, geometry) {
  if (!geometry) return null;
  if (geometry.land) return geometry.land.id;
  const near = geometry.nearestLand;
  if (!near || !(geometry.offshoreKm <= 5) || !candidate.wdAreaKm2) return null;
  const ratio = near.areaKm2 / candidate.wdAreaKm2;
  return ratio >= 0.5 && ratio <= 2 ? near.id : null;
}

// ── Polygon scope ───────────────────────────────────────────────────────────

const SCOPE_SOURCES = new Set(['admin1', 'subunit', 'regions', 'region', 'gmba']);
const sourceKey = (line) => String(line.source ?? '').replace(/^ne[_:-]?/, '');

/** Polygon lines usable as a region's real extent, unioned per candidate. */
export function polygonScopes(lines) {
  const byCandidate = new Map();
  for (const line of lines) {
    const flags = line.flags ?? [];
    if (!SCOPE_SOURCES.has(sourceKey(line))) continue;
    if (flags.includes('children_disagree') || flags.includes('area_mismatch')) continue;
    const entry = byCandidate.get(line.candidateId) ?? new Set();
    for (const id of line.memberIds ?? []) entry.add(id);
    /* Mountain polygons cut out the valley floors where the towns are: "at the foot of" counts. */
    if (sourceKey(line) === 'gmba') for (const id of line.nearMemberIds ?? []) entry.add(id);
    byCandidate.set(line.candidateId, entry);
  }
  return byCandidate;
}

/** Drops the parents a real boundary refuses, for places that were filed under them only by a circle. */
export function refiledParents(candidate, scopes) {
  if (candidate.title || candidate.parents.length === 0) return candidate.parents;
  return candidate.parents.filter((parent) => {
    const members = scopes.get(parent);
    return !members || members.size === 0 || members.has(candidate.id);
  });
}

// ── Advisories ──────────────────────────────────────────────────────────────

const AUTHORITY_WORDS = { us: 'The U.S. Department of State', uk: 'The UK Foreign Office', ca: 'Global Affairs Canada' };
const PLACE_KINDS = new Set(['place']);

/**
 * Reads every authority's advice for one country into what a destination needs.
 * `places` is the destination's own name, its ancestors and its first-level
 * division, already folded by `placeKey`.
 */
function exempted(texts, places) {
  return texts.some((text) => {
    const words = ` ${fold(text)} `;
    return places.some((place) => place.length >= 4 && words.includes(` ${place} `));
  });
}

export function advisoryTables(v2) {
  const countries = {};
  const prepared = new Map();
  for (const [iso, entry] of Object.entries(v2.countries)) {
    const whole = [];
    const areas = [];
    const partly = new Map();
    let national = 0;
    let nationalBy = null;
    for (const advisory of entry.advisories) {
      const source = AUTHORITY_WORDS[advisory.authority] ?? advisory.authority;
      if (advisory.wholeCountry && (advisory.nationalLevel ?? advisory.level) > national) {
        national = advisory.nationalLevel ?? advisory.level;
        nationalBy = advisory;
      }
      if (advisory.wholeCountry && advisory.level === 4) whole.push({ source, label: advisory.label, url: advisory.url, updatedAt: advisory.updatedAt });
      for (const regional of advisory.regional ?? []) {
        if (regional.level >= 3) {
          const slot = partly.get(source) ?? { level: 0, url: advisory.url };
          slot.level = Math.max(slot.level, regional.level);
          partly.set(source, slot);
        }
        if (regional.unparsed) continue;
        for (const area of regional.areas ?? []) {
          const rest = area.kind === 'rest_of_country';
          if (!rest && (!PLACE_KINDS.has(area.kind) || area.scope === 'part' || area.within)) continue;
          areas.push({
            rest,
            key: rest ? '' : placeKey(area.name),
            name: area.name,
            level: regional.level,
            source,
            label: regional.label,
            text: regional.text,
            url: advisory.url,
            updatedAt: advisory.updatedAt,
            exceptions: [...(regional.exceptions ?? []), ...(area.except ? [area.except].flat() : [])],
          });
        }
      }
      if (advisory.regionalUnparsed) {
        const slot = partly.get(source) ?? { level: 0, url: advisory.url };
        slot.level = Math.max(slot.level, 3);
        partly.set(source, slot);
      }
    }
    const parts = [...partly.entries()].sort((a, b) => b[1].level - a[1].level);
    countries[iso] = {
      level: national,
      ...(nationalBy ? { source: AUTHORITY_WORDS[nationalBy.authority] ?? nationalBy.authority, asOf: nationalBy.updatedAt, url: nationalBy.url, label: nationalBy.label } : {}),
      ...(whole.length > 0 ? { whole } : {}),
      ...(parts.length > 0 ? { parts: parts.map(([source, slot]) => ({ source, level: slot.level, url: slot.url })) } : {}),
    };
    prepared.set(iso, { areas, whole: whole.length > 0 });
  }
  return { countries, prepared };
}

/** The warning that covers one destination, if an area could be matched to it. */
export function areaWarningFor(prepared, iso, { places, division, name, ancestors, radiusKm }) {
  const entry = prepared.get(iso);
  if (!entry) return null;
  let best = null;
  let exempt = false;
  for (const area of entry.areas) {
    if (area.rest) {
      if (exempted(area.exceptions, places)) {
        exempt = true;
        continue;
      }
      if (!best || area.level > best.level) best = area;
      continue;
    }
    const own = area.key === name || ancestors.includes(area.key);
    /* A place wider than the province its centre happens to sit in is not covered by that province's warning. */
    const inside = own || (area.key === division && radiusKm <= 120);
    if (!inside || !area.key) continue;
    /* Exceptions are often the very places people go ("except Tsavo National Park"). */
    if (exempted(area.exceptions, places)) continue;
    if (!best || area.level > best.level) best = area;
  }
  if (!best && !exempt) return null;
  return { level: best?.level ?? 0, exempt, ...(best ? { area: best.rest ? null : best.name, source: best.source, label: best.label, text: String(best.text ?? '').slice(0, 300), url: best.url, asOf: best.updatedAt } : {}) };
}

// ── Cost ────────────────────────────────────────────────────────────────────

const TIER_OFFSET = { budget: 0.6, mid: 1.09, splurge: 2.06 };
export const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** A page's room prices on one footing: tiers taken out, older listings counted for less. */
export function ownRoomEvidence(sleep, year) {
  if (!sleep || sleep.n === 0 || !sleep.usdRealMedian) return null;
  let weight = 0;
  let sum = 0;
  for (const [tier, offset] of Object.entries(TIER_OFFSET)) {
    const row = sleep.tiers?.[tier];
    if (!row?.usdRealMedian || !row.n) continue;
    sum += row.n * Math.log(row.usdRealMedian / offset);
    weight += row.n;
  }
  const untiered = sleep.n - weight;
  if (untiered > 0) {
    sum += untiered * Math.log(sleep.usdRealMedian);
    weight += untiered;
  }
  const age = year - (sleep.yearMedian ?? year - 12);
  const decay = age <= 3 ? 1 : age <= 7 ? 0.65 : age <= 9 ? 0.45 : 0.35;
  return { logUsd: sum / weight, n: sleep.n, nEff: sleep.n * decay, yearMin: sleep.yearMin, yearMax: sleep.yearMax, age };
}

/** Least squares for a handful of predictors; the rows are few and well conditioned. */
export function ols(rows, targets, ridge = 1e-6) {
  const width = rows[0].length;
  const a = Array.from({ length: width }, () => new Array(width + 1).fill(0));
  rows.forEach((row, index) => {
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < width; j += 1) a[i][j] += row[i] * row[j];
      a[i][width] += row[i] * targets[index];
    }
  });
  for (let i = 0; i < width; i += 1) a[i][i] += ridge;
  for (let i = 0; i < width; i += 1) {
    let pivot = i;
    for (let k = i + 1; k < width; k += 1) if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    for (let k = i + 1; k < width; k += 1) {
      const factor = a[k][i] / a[i][i];
      for (let j = i; j <= width; j += 1) a[k][j] -= factor * a[i][j];
    }
  }
  const beta = new Array(width).fill(0);
  for (let i = width - 1; i >= 0; i -= 1) {
    let sum = a[i][width];
    for (let j = i + 1; j < width; j += 1) sum -= a[i][j] * beta[j];
    beta[i] = sum / a[i][i];
  }
  return beta;
}

const TAU = 0.33;
const SIGMA = [[1, 0.51], [3, 0.31], [5, 0.23], [12, 0.21]];
/** How far one destination's own listings can be trusted, as a standard deviation in log price. */
export function listingSigma(nEff) {
  if (nEff <= 1) return 0.51 * Math.sqrt(1 / Math.max(nEff, 0.25));
  for (let i = 1; i < SIGMA.length; i += 1) {
    const [n0, s0] = SIGMA[i - 1];
    const [n1, s1] = SIGMA[i];
    if (nEff <= n1) return s0 + ((nEff - n0) / (n1 - n0)) * (s1 - s0);
  }
  return SIGMA[SIGMA.length - 1][1];
}
export const ownWeight = (nEff) => TAU ** 2 / (TAU ** 2 + listingSigma(nEff) ** 2);

/** The range around an estimate, as a multiplier, from the held-out spread of the fit (80 % interval). */
export function spreadFor(nEff, wide) {
  const base = nEff >= 5 ? 1.27 : nEff >= 3 ? 1.34 : nEff >= 1 ? 1.42 : 1.53;
  return wide ? base * 1.25 : base;
}
