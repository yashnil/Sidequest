/**
 * PRIVATE ALPHA — WHERE YOU START A HIKE THAT HAS NO SINGLE POINT.
 *
 * A loop, a ridge walk, a lake circuit or a trail section is a route or an
 * area, not a POI: a geocoder answers it with a massif, a ridge line or a park,
 * and a placer that needs a point either drops it (`approximate_only`) or,
 * worse, plans from the middle of a mountain. A live Dolomites scan lost the
 * Tre Cime loop and the Seceda ridge walk that way.
 *
 * The honest point for routing is where the traveller starts: a trailhead, a
 * car park, a lift station, a hut. This module decides — purely, from the
 * proposal and from what a provider said a result *is* — which candidates are
 * worth a bounded search for that point, what to ask, and whether an answer is
 * really an access point. It never invents one: a peak, a ridge, a park
 * centroid or anything with no access evidence is refused, and a candidate
 * whose access point cannot be verified stays unplaced.
 */

/** Kinds whose canonical object is usually a route or an area with a real starting point. */
export const ACCESS_RECOVERY_KINDS: ReadonlySet<string> = new Set(['day_hike', 'easy_walk', 'viewpoint', 'lake_or_river', 'waterfall']);

/** At most this many recovery queries for one candidate. */
export const MAX_ACCESS_QUERIES = 3;
/** At most this many candidates recovered in one scan, so a thin proposal cannot become a provider bill. */
export const MAX_ACCESS_RECOVERIES = 6;
/**
 * A recovered access point must lie this close to the area the activity was
 * found at, when an area was found. Tight on purpose: a live Dolomites replay
 * at 12 km took a ski-area lift sharing the massif's name, 10 km from the loop
 * it was meant to start, for the loop's access point.
 */
export const ACCESS_RADIUS_KM = 6;
/** Two accepted answers further apart than this are two different places: ambiguous, not recovered. */
export const ACCESS_AMBIGUITY_KM = 5;

export type AccessKind = 'trailhead' | 'parking' | 'lift_station' | 'hut' | 'station' | 'entrance';

/**
 * What makes an area-only candidate worth spending recovery queries on. At
 * placement time there is no fit score yet (the board computes it later), so
 * the signals are the ones the proposal and the traveller already give: an
 * explicit include, the model's tier (a signal, not an authority), how many of
 * the traveller's priority interests it serves (the personal-fit proxy),
 * whether it is a famously busy — defining — stop, and whether the model
 * described it as a route.
 */
export interface AccessRecoverySignals {
  kind: string;
  tier: string;
  namedByTraveller: boolean;
  interests?: readonly string[];
  priorities?: readonly string[];
  crowd?: string;
  routeAnchored?: boolean;
}

const TIER_WEIGHT: Record<string, number> = { classic: 3, hidden_gem: 1.5, side_quest: 0.5 };
/** The least a candidate must score to earn recovery queries. A classic alone qualifies; a hidden gem needs the traveller's interest or fame behind it. */
export const ACCESS_RECOVERY_THRESHOLD = 2.5;

/** 0 when not worth recovering; otherwise a priority, so the cap goes to the candidates that matter most. */
export function accessRecoveryPriority(input: AccessRecoverySignals): number {
  if (!ACCESS_RECOVERY_KINDS.has(input.kind)) return 0;
  if (input.namedByTraveller) return 10;
  const priorities = new Set(input.priorities ?? []);
  const served = (input.interests ?? []).filter((i) => priorities.has(i)).length;
  const score = (TIER_WEIGHT[input.tier] ?? 0) + (served >= 2 ? 2 : served === 1 ? 1.5 : 0) + (input.crowd === 'busy' || input.crowd === 'very_busy' ? 1 : 0) + (input.routeAnchored ? 0.5 : 0);
  return score >= ACCESS_RECOVERY_THRESHOLD ? score : 0;
}

export function worthAccessRecovery(input: AccessRecoverySignals): boolean {
  return accessRecoveryPriority(input) > 0;
}

const TRAILING_GENERIC = /\s+(?:loop|circuit|walk|hike|trail|track|path|route|section|traverse|trek|ridge walk|viewpoint walk|panoramic walk|lake walk|lake loop|circular walk|viewpoint|panorama|panoramic|cable car|gondola|chairlift|lift)$/i;

/** The activity's own place name, without the activity words: "Tre Cime di Lavaredo loop" → "Tre Cime di Lavaredo". */
export function accessStemOf(name: string): string {
  let stem = name.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*[/–—-]\s*.*$/, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = stem.replace(TRAILING_GENERIC, '').trim();
    if (next === stem || next.length < 3) break;
    stem = next;
  }
  return stem.length >= 3 ? stem : name.trim();
}

/** The bounded query variants, most specific first. A name that already says how you get up gets the lift first. */
export function accessRecoveryQueries(name: string, kind: string): string[] {
  const stem = accessStemOf(name);
  const lifted = /cable ?car|gondola|chairlift|lift|funivia|seilbahn|cableway/i.test(name);
  const variants = lifted ? ['cable car', 'parking', 'trailhead'] : kind === 'lake_or_river' || kind === 'waterfall' ? ['parking', 'trailhead', 'hut'] : ['trailhead', 'parking', 'cable car'];
  return variants.slice(0, MAX_ACCESS_QUERIES).map((suffix) => `${stem} ${suffix}`);
}

const GOOGLE_ACCESS_TYPES: Record<string, AccessKind> = {
  parking: 'parking',
  transit_station: 'station',
  train_station: 'station',
  bus_station: 'station',
  light_rail_station: 'station',
};
const NAME_ACCESS: [RegExp, AccessKind][] = [
  [/\b(trail ?head|start of the trail|ausgangspunkt|punto di partenza|inizio sentiero)\b/i, 'trailhead'],
  [/\b(parking|car ?park|parcheggio|parkplatz|stationnement)\b/i, 'parking'],
  [/\b(cable ?car|gondola|chair ?lift|funivia|seilbahn|bergstation|talstation|cabinovia|seggiovia|telecabina|lift station)\b/i, 'lift_station'],
  [/\b(rifugio|hütte|huette|hut|refuge|baita)\b/i, 'hut'],
  [/\b(entrance|ingresso|eingang|visitor cent(?:er|re))\b/i, 'entrance'],
];
const OSM_ACCESS: Record<string, AccessKind> = {
  'highway=trailhead': 'trailhead',
  'amenity=parking': 'parking',
  'aerialway=station': 'lift_station',
  'tourism=alpine_hut': 'hut',
  'tourism=wilderness_hut': 'hut',
  'public_transport=station': 'station',
  'railway=station': 'station',
  'railway=halt': 'station',
  'entrance=main': 'entrance',
};
/** What a result must never be taken for, whatever its name says: the area or the summit itself. */
const NEVER_ACCESS = /^(natural=(peak|ridge|mountain_range|valley|massif|saddle|glacier|water|wood)|boundary=|place=|landuse=|leisure=(park|nature_reserve)|tourism=(attraction|viewpoint))/;

const words = (text: string) => new Set(text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/**
 * What kind of access point a provider's answer is, or null when it is not
 * one. It must carry access evidence (a provider type, an OSM class or an
 * access word in its own name) and share a significant word with the
 * activity's stem — "Parcheggio Auronzo" is not evidence for a different
 * mountain. A summit, ridge, park or area row is never an access point.
 */
export function accessEvidence(input: { stem: string; resultName?: string; googleTypes?: readonly string[]; osmClass?: string; osmType?: string }): AccessKind | null {
  const osmKey = input.osmClass && input.osmType ? `${input.osmClass}=${input.osmType}` : null;
  if (osmKey && NEVER_ACCESS.test(osmKey)) return null;
  const stemWords = words(input.stem);
  const resultWords = words(input.resultName ?? '');
  const related = [...stemWords].some((w) => resultWords.has(w));
  if (!related) return null;
  if (osmKey && OSM_ACCESS[osmKey]) return OSM_ACCESS[osmKey];
  for (const type of input.googleTypes ?? []) if (GOOGLE_ACCESS_TYPES[type]) return GOOGLE_ACCESS_TYPES[type]!;
  for (const [pattern, kind] of NAME_ACCESS) if (pattern.test(input.resultName ?? '')) return kind;
  return null;
}

/** Kinds that are routes: walked, not visited at a point. */
const ROUTE_KINDS: ReadonlySet<string> = new Set(['day_hike', 'easy_walk']);
const AREA_ROW = /^(natural=(peak|ridge|arete|mountain_range|valley|massif|saddle|glacier|wood|scrub|grassland|heath|fell|plateau)|boundary=|place=(locality|region|area|island)|landuse=|leisure=(park|nature_reserve))/;
const AREA_GOOGLE_TYPES = new Set(['hiking_area', 'natural_feature', 'park', 'national_park']);

/**
 * Whether a provider's answer for a *route* (a hike, a walk) is an area or a
 * summit rather than somewhere a person starts — the row that, used as a
 * routing point, puts a loop on top of a mountain. Only for route kinds: a
 * lake, a waterfall or a viewpoint is where its row says it is.
 */
export function routeAnswerIsAreaLevel(input: { kind: string; osmClass?: string; osmType?: string; googleTypes?: readonly string[] }): boolean {
  if (!ROUTE_KINDS.has(input.kind)) return false;
  if (input.osmClass && input.osmType && AREA_ROW.test(`${input.osmClass}=${input.osmType}`)) return true;
  return (input.googleTypes ?? []).some((type) => AREA_GOOGLE_TYPES.has(type));
}
