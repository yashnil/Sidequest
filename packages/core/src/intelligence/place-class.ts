/**
 * OPERATIONAL SEMANTICS BY WHAT A PLACE IS.
 *
 * Restaurant rules do not apply to a lake. Each class says whether commercial
 * opening hours mean anything, whether access can be controlled (season,
 * permit, gate), and whether a transport terminal's schedule is the fact that
 * matters. Tests hold two lines: unknown hours never mean closed, and a
 * natural site with no hours is never unusable.
 */
export const PLACE_CLASSES = ['business_venue', 'controlled_site', 'open_ground', 'area', 'transport_terminal', 'unknown'] as const;
export type PlaceClass = (typeof PLACE_CLASSES)[number];

const OPEN_GROUND = new Set(['hike', 'viewpoint', 'water', 'beach', 'nature', 'scenic_drive', 'wildlife', 'day_hike', 'easy_walk', 'lake', 'trail', 'waterfall', 'coast', 'summit']);
const CONTROLLED = new Set(['geothermal', 'hot_spring', 'park', 'national_park', 'gorge', 'cave', 'glacier', 'garden', 'zoo', 'reserve']);
const VENUE = new Set(['museum', 'historic', 'landmark', 'food', 'market', 'activity', 'gallery', 'restaurant', 'cafe', 'shop', 'spa', 'theatre', 'bar']);
const AREA = new Set(['neighbourhood', 'town', 'city', 'region', 'district', 'relaxation', 'other']);
const TERMINAL = new Set(['airport', 'station', 'port', 'ferry_terminal', 'bus_station']);

export function placeClassFor(category: string | undefined, hints: { googleTypes?: readonly string[]; osmTags?: Record<string, string> } = {}): PlaceClass {
  const c = (category ?? '').toLowerCase();
  const types = (hints.googleTypes ?? []).map((t) => t.toLowerCase());
  // Sidequest's own category is the stronger signal: the model said what the stop is for.
  if (TERMINAL.has(c)) return 'transport_terminal';
  if (OPEN_GROUND.has(c)) return 'open_ground';
  if (CONTROLLED.has(c)) return 'controlled_site';
  if (VENUE.has(c)) return 'business_venue';
  if (AREA.has(c)) return 'area';
  // Otherwise the provider's types decide.
  if (types.some((t) => /airport|train_station|transit_station|bus_station|ferry_terminal|subway_station/.test(t))) return 'transport_terminal';
  if (types.some((t) => /hiking_area|natural_feature|beach|campground/.test(t))) return 'open_ground';
  if (types.some((t) => /national_park|park|zoo|botanical_garden|state_park/.test(t))) return 'controlled_site';
  if (types.some((t) => /museum|restaurant|cafe|store|bar|art_gallery|tourist_attraction|point_of_interest|establishment/.test(t))) return 'business_venue';
  if (types.some((t) => /locality|neighborhood|sublocality|administrative_area/.test(t))) return 'area';
  return 'unknown';
}

export interface OperationalSemantics {
  /** Whether posted opening hours are a meaningful constraint. */
  hoursMatter: boolean;
  /** Whether access can be seasonal, gated or permit-controlled. */
  accessControlled: boolean;
  /** Whether a published service schedule is the fact that matters. */
  scheduleMatters: boolean;
  /** Whether "business status" (closed permanently, temporarily) applies. */
  businessStatusMatters: boolean;
  /** What to say when nothing is published. */
  noHoursMeaning: 'open_access' | 'hours_unknown' | 'not_applicable';
}

export const OPERATIONAL_SEMANTICS: Record<PlaceClass, OperationalSemantics> = {
  business_venue: { hoursMatter: true, accessControlled: false, scheduleMatters: false, businessStatusMatters: true, noHoursMeaning: 'hours_unknown' },
  controlled_site: { hoursMatter: true, accessControlled: true, scheduleMatters: false, businessStatusMatters: false, noHoursMeaning: 'hours_unknown' },
  open_ground: { hoursMatter: false, accessControlled: true, scheduleMatters: false, businessStatusMatters: false, noHoursMeaning: 'open_access' },
  area: { hoursMatter: false, accessControlled: false, scheduleMatters: false, businessStatusMatters: false, noHoursMeaning: 'not_applicable' },
  transport_terminal: { hoursMatter: false, accessControlled: false, scheduleMatters: true, businessStatusMatters: false, noHoursMeaning: 'not_applicable' },
  unknown: { hoursMatter: false, accessControlled: false, scheduleMatters: false, businessStatusMatters: false, noHoursMeaning: 'hours_unknown' },
};

/** Which Google Places lookup level a class deserves during enrichment. Open ground and areas never pay for hours. */
export function enrichmentLevelFor(placeClass: PlaceClass): 'none' | 'operational' {
  return placeClass === 'business_venue' || placeClass === 'controlled_site' ? 'operational' : 'none';
}
