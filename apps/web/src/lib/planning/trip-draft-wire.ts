import { z } from 'zod';
import {
  ANCHOR_CATEGORIES,
  ANCHOR_ROLES,
  DRAFT_SOFT_PROSE_CAPS,
  DRAFT_TRANSPORTS,
  TRIP_ARCHETYPES,
  draftStructureIssues,
  normalizeTripDraft,
  tripDraftSchema,
  type AnchorCategory,
  type AnchorRole,
  type DraftTransport,
  type TripArchetype,
  type TripDraft,
} from './trip-draft';

/**
 * THE WIRE DRAFT — WHAT THE MODEL IS ASKED TO EMIT — SEPARATED FROM THE
 * CANONICAL DRAFT SIDEQUEST KEEPS.
 *
 * The Ireland founder test lost a completed, paid composition
 * (`stop_reason: end_turn`) because the transport validated the model's
 * JSON against the full canonical `tripDraftSchema` — prose regexes, caps,
 * closed enums, nested package objects — and refused the whole answer over
 * a shape difference nobody could name afterwards. Two layers now:
 *
 *   TripDraftWire (this file)   what the model authors: names, nights,
 *                               days, activities, meals, rationale, the
 *                               package lists — plain strings, numbers,
 *                               booleans, arrays, `null`s. No ids, no
 *                               provenance, no verification state, nothing
 *                               Sidequest derives itself.
 *        ↓ normalizeTripDraftWire()   deterministic; repairs STRUCTURAL
 *                               variation (aliases, casing, numeric strings,
 *                               absent optionals, a URL in prose), never
 *                               invents content, rejects SEMANTIC failure
 *                               with a precise path.
 *   TripDraft (canonical)       ids generated here, then `tripDraftSchema`
 *                               and the quality audit exactly as before.
 *
 * The wire schema also carries none of the JSON-Schema keywords structured
 * outputs reject, and `wireSchemaProfile` measures it so the request mode is
 * chosen locally — never by a paid request that the provider refuses.
 */

const str = () => z.string();
const maybe = () => z.string().nullable();

export const wireActivitySchema = z.object({
  name: str(),
  locality: maybe(),
  category: z.enum(ANCHOR_CATEGORIES),
  role: z.enum(ANCHOR_ROLES),
  minutes: z.number().nullable(),
  transport: z.enum(DRAFT_TRANSPORTS).nullable(),
  why: str(),
});

export const wireStaySchema = z.object({
  name: str(),
  locality: maybe(),
  nights: z.number(),
  why: str(),
  lodgingArea: maybe(),
  lodgingStyle: maybe(),
});

export const wireDaySchema = z.object({
  day: z.number(),
  stay: str(),
  theme: str(),
  intensity: z.enum(['light', 'moderate', 'intense']),
  relocation: z.boolean(),
  activities: z.array(wireActivitySchema),
  breakfast: maybe(),
  lunch: maybe(),
  dinner: maybe(),
  note: maybe(),
  whyItFits: maybe(),
});

export const tripDraftWireSchema = z.object({
  archetype: z.enum(TRIP_ARCHETYPES),
  purpose: str(),
  routeRationale: str(),
  assumptions: z.array(str()),
  tradeoffs: z.array(str()),
  stays: z.array(wireStaySchema),
  days: z.array(wireDaySchema),
  omissions: z.array(z.object({ name: str(), reason: str() })),
  unresolved: z.array(str()),
  bookingPriorities: z.array(str()),
  foodStrategy: z.array(str()),
  transportSummary: str(),
  transportNotes: z.array(str()),
  beforeYouGo: z.array(str()),
  packing: z.array(str()),
  backups: z.array(z.object({ trigger: str(), alternative: str() })),
});
export type TripDraftWire = z.infer<typeof tripDraftWireSchema>;

/** The wrapper the prompt asks for around the one JSON object. */
export const TRIP_DRAFT_JSON_TAG = 'trip_draft_json';

// ---------------------------------------------------------------------------
// Schema profile + the local grammar-mode guard
// ---------------------------------------------------------------------------

export interface WireSchemaProfile {
  bytes: number;
  depth: number;
  properties: number;
  enumMembers: number;
  arraysOfObjects: number;
  unsupportedKeywords: string[];
}

const UNSUPPORTED_KEYWORDS = ['minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'uniqueItems', 'minContains', 'maxContains', 'format'];

/** Measures the JSON Schema exactly as it goes on the wire (the SDK's own conversion). */
export function wireSchemaProfile(jsonSchema: unknown): WireSchemaProfile {
  const text = JSON.stringify(jsonSchema);
  let depth = 0;
  let properties = 0;
  let enumMembers = 0;
  let arraysOfObjects = 0;
  const walk = (node: unknown, level: number) => {
    if (!node || typeof node !== 'object') return;
    depth = Math.max(depth, level);
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, level);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      const props = record.properties as Record<string, unknown>;
      properties += Object.keys(props).length;
      for (const value of Object.values(props)) walk(value, level + 1);
    }
    if (Array.isArray(record.enum)) enumMembers += record.enum.length;
    if (record.type === 'array' && record.items && typeof record.items === 'object') {
      const items = record.items as Record<string, unknown>;
      if (items.type === 'object' || items.$ref) arraysOfObjects += 1;
      walk(items, level + 1);
    }
    // Nesting is objects inside objects (`properties`) and items inside arrays (`items`); a nullable
    // union (`anyOf: [type, null]`) or a `$defs` table is the same node at the same depth.
    for (const [key, value] of Object.entries(record)) {
      if (key === 'properties' || key === 'items') continue;
      if (value && typeof value === 'object') walk(value, level);
    }
  };
  walk(jsonSchema, 1);
  const unsupported = UNSUPPORTED_KEYWORDS.filter((keyword) => text.includes(`"${keyword}"`));
  return { bytes: text.length, depth, properties, enumMembers, arraysOfObjects, unsupportedKeywords: unsupported };
}

/**
 * Whether grammar (structured-output) mode may be requested for this schema.
 *
 * Calibrated from the one refusal on record: the previous 8,706-byte,
 * 45-property, depth-5 schema was refused with "The compiled grammar is too
 * large". Nobody is allowed to probe the provider's real limit with a paid
 * request, so the limits sit well below that observation; a schema outside
 * them goes straight to prompt-enforced JSON, deliberately, and a future
 * smaller schema switches itself back to grammar mode.
 */
export const GRAMMAR_MODE_LIMITS = { bytes: 5_000, depth: 4, properties: 32, enumMembers: 60, arraysOfObjects: 4 } as const;

export function grammarModeSuitable(profile: WireSchemaProfile): { suitable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (profile.unsupportedKeywords.length > 0) reasons.push(`unsupported keywords: ${profile.unsupportedKeywords.join(', ')}`);
  if (profile.bytes > GRAMMAR_MODE_LIMITS.bytes) reasons.push(`${profile.bytes} bytes > ${GRAMMAR_MODE_LIMITS.bytes}`);
  if (profile.depth > GRAMMAR_MODE_LIMITS.depth) reasons.push(`depth ${profile.depth} > ${GRAMMAR_MODE_LIMITS.depth}`);
  if (profile.properties > GRAMMAR_MODE_LIMITS.properties) reasons.push(`${profile.properties} properties > ${GRAMMAR_MODE_LIMITS.properties}`);
  if (profile.enumMembers > GRAMMAR_MODE_LIMITS.enumMembers) reasons.push(`${profile.enumMembers} enum members > ${GRAMMAR_MODE_LIMITS.enumMembers}`);
  if (profile.arraysOfObjects > GRAMMAR_MODE_LIMITS.arraysOfObjects) reasons.push(`${profile.arraysOfObjects} arrays of objects > ${GRAMMAR_MODE_LIMITS.arraysOfObjects}`);
  return { suitable: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Normalization: wire → canonical
// ---------------------------------------------------------------------------

export interface WireIssue {
  path: string;
  code: string;
  message: string;
  expected?: string;
  received?: string;
}

export type WireNormalization =
  | { ok: true; draft: TripDraft; normalizedFields: readonly string[] }
  | { ok: false; kind: 'structural' | 'semantic'; issues: readonly WireIssue[] };

export interface WireTripFacts {
  /** Days the trip has (nights + 1). When given, a draft with another day count is a semantic failure. */
  days?: number;
}

const CATEGORY_ALIASES: Record<string, AnchorCategory> = {
  landmark: 'landmark', monument: 'landmark', sight: 'landmark', attraction: 'landmark', castle: 'historic', fort: 'historic', ruin: 'historic', ruins: 'historic', heritage: 'historic', history: 'historic', historic: 'historic', historical: 'historic', cathedral: 'historic', church: 'historic', abbey: 'historic', temple: 'historic', palace: 'historic',
  nature: 'nature', park: 'nature', forest: 'nature', garden: 'nature', gardens: 'nature', national_park: 'nature', reserve: 'nature', wilderness: 'nature', cliffs: 'viewpoint', cliff: 'viewpoint', lookout: 'viewpoint', viewpoint: 'viewpoint', view: 'viewpoint', vista: 'viewpoint', summit: 'viewpoint',
  hike: 'hike', hiking: 'hike', walk: 'hike', trail: 'hike', trek: 'hike', water: 'water', lake: 'water', river: 'water', waterfall: 'water', falls: 'water', coast: 'water', bay: 'water', island: 'water', boat: 'water', ferry: 'water', wildlife: 'wildlife', safari: 'wildlife', game_drive: 'wildlife', birds: 'wildlife', birding: 'wildlife', zoo: 'wildlife', aquarium: 'wildlife',
  geothermal: 'geothermal', hot_spring: 'geothermal', hot_springs: 'geothermal', volcano: 'geothermal', museum: 'museum', gallery: 'museum', exhibition: 'museum', neighbourhood: 'neighbourhood', neighborhood: 'neighbourhood', district: 'neighbourhood', quarter: 'neighbourhood', old_town: 'neighbourhood', market: 'market', markets: 'market', food: 'food', restaurant: 'food', pub: 'food', cafe: 'food', café: 'food', dining: 'food', brewery: 'food', distillery: 'food', winery: 'food', tasting: 'food',
  activity: 'activity', experience: 'activity', tour: 'activity', class: 'activity', workshop: 'activity', show: 'activity', performance: 'activity', music: 'activity', scenic_drive: 'scenic_drive', drive: 'scenic_drive', road: 'scenic_drive', route: 'scenic_drive', beach: 'beach', beaches: 'beach', swimming: 'beach', town: 'town', village: 'town', city: 'town', relaxation: 'relaxation', rest: 'relaxation', spa: 'relaxation', pool: 'relaxation', wellness: 'relaxation', other: 'other', transfer: 'other', transport: 'other', flight: 'other',
};
const ROLE_ALIASES: Record<string, AnchorRole> = { core: 'core', main: 'core', must: 'core', must_do: 'core', must_see: 'core', essential: 'core', anchor: 'core', primary: 'core', key: 'core', secondary: 'secondary', side: 'secondary', supporting: 'secondary', optional: 'optional', maybe: 'optional', if_time: 'optional', nice_to_have: 'optional', flex: 'flex', flexible: 'flex', backup: 'flex', spare: 'flex', filler: 'flex' };
const TRANSPORT_ALIASES: Record<string, DraftTransport> = { walk: 'walk', walking: 'walk', foot: 'walk', on_foot: 'walk', hike: 'walk', metro: 'metro', subway: 'metro', tube: 'metro', underground: 'metro', mtr: 'metro', tram: 'metro', rail: 'rail', train: 'rail', bus: 'bus', coach: 'bus', shuttle: 'bus', car: 'car', drive: 'car', driving: 'car', self_drive: 'car', rental_car: 'car', taxi: 'car', rideshare: 'car', uber: 'car', ferry: 'ferry', boat: 'boat', cruise: 'boat', kayak: 'boat', flight: 'flight', fly: 'flight', plane: 'flight', air: 'flight', private_transfer: 'private_transfer', transfer: 'private_transfer', driver: 'private_transfer', private_driver: 'private_transfer', four_wheel_drive: 'four_wheel_drive', '4x4': 'four_wheel_drive', '4wd': 'four_wheel_drive', jeep: 'four_wheel_drive', game_vehicle: 'four_wheel_drive', guide_or_lodge_transfer: 'guide_or_lodge_transfer', guide: 'guide_or_lodge_transfer', guided: 'guide_or_lodge_transfer', lodge_transfer: 'guide_or_lodge_transfer', lodge: 'guide_or_lodge_transfer', tour: 'guide_or_lodge_transfer', unknown: 'unknown' };
const INTENSITY_ALIASES: Record<string, 'light' | 'moderate' | 'intense'> = { light: 'light', easy: 'light', low: 'light', relaxed: 'light', gentle: 'light', rest: 'light', moderate: 'moderate', medium: 'moderate', balanced: 'moderate', normal: 'moderate', intense: 'intense', hard: 'intense', high: 'intense', strenuous: 'intense', full: 'intense', big: 'intense' };
const ARCHETYPE_ALIASES: Record<string, TripArchetype> = Object.fromEntries([
  ...TRIP_ARCHETYPES.map((a) => [a, a] as const),
  ['single_base', 'single_base'], ['one_base', 'single_base_urban'], ['city_break', 'single_base_urban'], ['urban', 'single_base_urban'], ['hub', 'hub_and_spoke'], ['hub_spoke', 'hub_and_spoke'], ['roadtrip', 'road_trip'], ['road', 'road_trip'], ['driving', 'road_trip'], ['self_drive', 'road_trip'], ['rail', 'rail_route'], ['train', 'rail_route'], ['islands', 'island_hopping'], ['island', 'island_hopping'], ['safari', 'lodge_circuit'], ['lodge', 'lodge_circuit'], ['circuit', 'lodge_circuit'], ['remote', 'guided_remote'], ['guided', 'guided_remote'], ['wilderness', 'wilderness_gateway'], ['multi_country', 'multi_region'], ['regions', 'multi_region'], ['loop', 'loop'], ['moving_route', 'moving_route'], ['mixed', 'mixed'],
]) as Record<string, TripArchetype>;

function key(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function mapEnum<T extends string>(value: unknown, aliases: Record<string, T>, fallback: T | null): { value: T | null; mapped: boolean } {
  const k = key(value);
  if (k in aliases) return { value: aliases[k]!, mapped: k !== String(value) };
  // A compound like "scenic drive along the coast" → first alias hit wins.
  for (const part of k.split('_')) if (part in aliases) return { value: aliases[part]!, mapped: true };
  return { value: fallback, mapped: fallback !== null };
}

/** Prose that reaches a browser: no URL, no markup, trimmed, single-spaced. Structural sanitation, never a rewrite of meaning. */
function sanitizeProse(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(value);
    if (m) return Number(m[0]);
  }
  return undefined;
}

function stringList(value: unknown, path: string, touched: string[]): string[] {
  if (value === null || value === undefined) {
    touched.push(`${path} (absent → [])`);
    return [];
  }
  if (typeof value === 'string') {
    touched.push(`${path} (string → [string])`);
    const one = sanitizeProse(value);
    return one ? [one] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' ? sanitizeProse(entry) : entry && typeof entry === 'object' ? sanitizeProse((entry as Record<string, unknown>).text ?? (entry as Record<string, unknown>).note ?? JSON.stringify(entry)) : undefined)).filter((entry): entry is string => Boolean(entry));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function slug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'base';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  taken.add(candidate);
  return candidate;
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Wire (or an older canonical-shaped answer) → canonical TripDraft.
 *
 * Structural deviations are normalized and named in `normalizedFields`;
 * semantic failures are rejected with the precise path, what was expected
 * and what arrived. Nothing here writes travel content the model did not.
 */
export function normalizeTripDraftWire(raw: unknown, facts: WireTripFacts = {}): WireNormalization {
  const root = record(raw);
  if (!root) return { ok: false, kind: 'structural', issues: [{ path: '', code: 'not_an_object', message: 'the answer is not a JSON object', received: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw }] };
  const touched: string[] = [];
  const issues: WireIssue[] = [];

  // --- stays / bases ------------------------------------------------------------------
  const staysRaw = Array.isArray(root.stays) ? root.stays : Array.isArray(root.bases) ? (touched.push('bases → stays'), root.bases) : [];
  const taken = new Set<string>();
  const bases: TripDraft['bases'] = [];
  const baseIdByName = new Map<string, string>();
  const baseIdByGivenId = new Map<string, string>();
  staysRaw.forEach((entry: unknown, index: number) => {
    const stay = record(entry);
    const name = sanitizeProse(stay?.name ?? stay?.base ?? stay?.town ?? stay?.city);
    if (!stay || !name) {
      issues.push({ path: `stays[${index}].name`, code: 'missing', message: 'a stay without a name', received: stay ? JSON.stringify(stay).slice(0, 80) : String(entry) });
      return;
    }
    const nights = toNumber(stay.nights);
    if (nights === undefined || nights < 0) {
      issues.push({ path: `stays[${index}].nights`, code: 'invalid_number', message: 'nights must be a number', expected: 'number ≥ 0', received: String(stay.nights) });
      return;
    }
    if (typeof stay.nights === 'string') touched.push(`stays[${index}].nights (string → number)`);
    const id = slug(name, taken);
    baseIdByName.set(normalizeName(name), id);
    if (typeof stay.id === 'string') baseIdByGivenId.set(stay.id, id);
    const why = sanitizeProse(stay.why ?? stay.rationale ?? stay.reason) ?? `Base for this part of the trip.`;
    if (!sanitizeProse(stay.why ?? stay.rationale ?? stay.reason)) touched.push(`stays[${index}].why (absent → default)`);
    const locality = sanitizeProse(stay.locality ?? stay.region);
    const lodgingArea = sanitizeProse(stay.lodgingArea ?? stay.area);
    const lodgingStyle = sanitizeProse(stay.lodgingStyle ?? stay.style ?? stay.lodging);
    bases.push({ id, name: name.slice(0, 100), nights: Math.round(nights), why, ...(locality ? { locality: locality.slice(0, 40) } : {}), ...(lodgingArea ? { lodgingArea } : {}), ...(lodgingStyle ? { lodgingStyle } : {}) });
  });
  if (bases.length === 0) issues.push({ path: 'stays', code: 'empty', message: 'the draft names no stay', expected: 'at least one stay', received: '0' });

  // --- days ---------------------------------------------------------------------------
  const daysRaw = Array.isArray(root.days) ? root.days : [];
  if (daysRaw.length === 0) issues.push({ path: 'days', code: 'empty', message: 'the draft has no days', expected: facts.days ? `${facts.days} days` : 'at least one day', received: '0' });
  if (facts.days !== undefined && daysRaw.length > 0 && daysRaw.length !== facts.days) {
    issues.push({ path: 'days', code: 'day_count', message: 'the draft covers a different number of days than the trip', expected: `${facts.days} days`, received: `${daysRaw.length} days` });
  }
  const resolveBase = (dayIndex: number, day: Record<string, unknown>): string | null => {
    const given = day.stay ?? day.base ?? day.baseId ?? day.baseName;
    if (typeof given !== 'string' || !given.trim()) return bases.length === 1 ? bases[0]!.id : null;
    if (baseIdByGivenId.has(given)) return baseIdByGivenId.get(given)!;
    const wanted = normalizeName(given);
    if (baseIdByName.has(wanted)) return baseIdByName.get(wanted)!;
    if (bases.some((b) => b.id === given)) return given;
    for (const [name, id] of baseIdByName) if (name.includes(wanted) || wanted.includes(name)) return (touched.push(`days[${dayIndex}].stay (matched "${given}" to ${id})`), id);
    return null;
  };
  const days: TripDraft['days'] = [];
  daysRaw.forEach((entry: unknown, index: number) => {
    const day = record(entry);
    if (!day) {
      issues.push({ path: `days[${index}]`, code: 'not_an_object', message: 'a day that is not an object', received: typeof entry });
      return;
    }
    const givenNumber = toNumber(day.day ?? day.dayNumber);
    if (givenNumber !== undefined && givenNumber !== index + 1) touched.push(`days[${index}].day (${givenNumber} → ${index + 1} by position)`);
    if (givenNumber === undefined) touched.push(`days[${index}].day (absent → ${index + 1})`);
    const baseId = resolveBase(index, day);
    if (!baseId) {
      issues.push({ path: `days[${index}].stay`, code: 'unknown_stay', message: 'the day names a stay the draft does not declare', expected: bases.map((b) => b.name).join(' | ') || 'a declared stay', received: String(day.stay ?? day.base ?? day.baseId ?? '') });
      return;
    }
    const intensity = mapEnum(day.intensity, INTENSITY_ALIASES, 'moderate');
    if (intensity.mapped) touched.push(`days[${index}].intensity (${String(day.intensity)} → ${intensity.value})`);
    const activitiesRaw = Array.isArray(day.activities) ? day.activities : Array.isArray(day.anchors) ? (touched.push(`days[${index}].anchors → activities`), day.anchors) : [];
    const anchors: TripDraft['days'][number]['anchors'] = [];
    const seenNames = new Set<string>();
    activitiesRaw.forEach((activityEntry: unknown, activityIndex: number) => {
      const activity = record(activityEntry);
      const name = sanitizeProse(activity?.name ?? activity?.title ?? activity?.place);
      if (!activity || !name) {
        issues.push({ path: `days[${index}].activities[${activityIndex}].name`, code: 'missing', message: 'an activity without a name', received: activity ? JSON.stringify(activity).slice(0, 80) : String(activityEntry) });
        return;
      }
      const dedupe = normalizeName(name);
      if (seenNames.has(dedupe)) {
        touched.push(`days[${index}].activities[${activityIndex}] (duplicate "${name}" on the same day dropped)`);
        return;
      }
      seenNames.add(dedupe);
      const category = mapEnum(activity.category ?? activity.kind ?? activity.type, CATEGORY_ALIASES, 'other');
      if (category.mapped) touched.push(`days[${index}].activities[${activityIndex}].category (${String(activity.category ?? activity.kind ?? '')} → ${category.value})`);
      const role = mapEnum(activity.role ?? activity.priority ?? activity.importance, ROLE_ALIASES, 'secondary');
      if (role.mapped) touched.push(`days[${index}].activities[${activityIndex}].role (${String(activity.role ?? '')} → ${role.value})`);
      const transportRaw = activity.transport ?? activity.how ?? activity.mode;
      const transport = transportRaw === null || transportRaw === undefined || transportRaw === '' ? { value: null, mapped: false } : mapEnum(transportRaw, TRANSPORT_ALIASES, 'unknown');
      if (transport.mapped) touched.push(`days[${index}].activities[${activityIndex}].transport (${String(transportRaw)} → ${transport.value})`);
      const minutesRaw = activity.minutes ?? activity.estimatedDurationMinutes ?? activity.duration ?? activity.durationMinutes;
      const minutes = toNumber(minutesRaw);
      if (typeof minutesRaw === 'string' && minutes !== undefined) touched.push(`days[${index}].activities[${activityIndex}].minutes (string → number)`);
      const clamped = minutes === undefined ? undefined : Math.min(600, Math.max(10, Math.round(minutes)));
      if (minutes !== undefined && clamped !== Math.round(minutes)) touched.push(`days[${index}].activities[${activityIndex}].minutes (${minutes} clamped to ${clamped})`);
      const locality = sanitizeProse(activity.locality ?? activity.area ?? activity.near);
      anchors.push({
        name: name.slice(0, 60),
        ...(locality ? { locality: locality.slice(0, 40) } : {}),
        category: category.value ?? 'other',
        role: role.value ?? 'secondary',
        ...(clamped !== undefined ? { estimatedDurationMinutes: clamped } : {}),
        ...(transport.value ? { transport: transport.value } : {}),
        why: sanitizeProse(activity.why ?? activity.rationale ?? activity.reason) ?? '',
      });
    });
    if (anchors.length > 5) {
      touched.push(`days[${index}].activities (${anchors.length} → 5, the last kept as flex would not fit)`);
      anchors.length = 5;
    }
    const mealsObject = record(day.meals);
    const breakfast = sanitizeProse(day.breakfast ?? mealsObject?.breakfast);
    const lunch = sanitizeProse(day.lunch ?? mealsObject?.lunch);
    const dinner = sanitizeProse(day.dinner ?? mealsObject?.dinner);
    const relocationRaw = day.relocation;
    const relocation = typeof relocationRaw === 'boolean' ? relocationRaw : typeof relocationRaw === 'string' ? /^(true|yes|y|1)$/i.test(relocationRaw) || (relocationRaw.trim().length > 3 && !/^(no|none|false|n|0)$/i.test(relocationRaw)) : false;
    if (typeof relocationRaw === 'string') touched.push(`days[${index}].relocation (string → boolean)`);
    const note = sanitizeProse(day.note ?? day.practicalNote ?? day.practical);
    const whyItFits = sanitizeProse(day.whyItFits ?? day.travelerFit ?? day.fit);
    days.push({
      dayNumber: index + 1,
      baseId,
      theme: sanitizeProse(day.theme ?? day.title) ?? `Day ${index + 1}`,
      intensity: intensity.value ?? 'moderate',
      ...(relocation ? { relocation: true } : {}),
      anchors,
      ...(breakfast || lunch || dinner ? { meals: { ...(breakfast ? { breakfast } : {}), ...(lunch ? { lunch } : {}), ...(dinner ? { dinner } : {}) } } : {}),
      ...(note ? { note } : {}),
      ...(whyItFits ? { whyItFits } : {}),
    });
  });

  // --- trip-level ---------------------------------------------------------------------
  const archetype = mapEnum(root.archetype ?? root.shape ?? root.tripShape, ARCHETYPE_ALIASES, null);
  if (archetype.value === null) {
    const inferred: TripArchetype = bases.length <= 1 ? 'single_base_urban' : days.some((d) => d.anchors.some((a) => a.transport === 'car')) ? 'road_trip' : 'multi_region';
    touched.push(`archetype (${String(root.archetype ?? '')} → ${inferred} inferred from the shape)`);
    archetype.value = inferred;
  } else if (archetype.mapped) touched.push(`archetype (${String(root.archetype)} → ${archetype.value})`);
  const pkg = record(root.package);
  const transportObject = record(pkg?.transport);
  const backupsRaw = Array.isArray(root.backups) ? root.backups : Array.isArray(pkg?.backups) ? pkg!.backups : [];
  const omissionsRaw = Array.isArray(root.omissions) ? root.omissions : [];

  const candidate = {
    archetype: archetype.value,
    purpose: sanitizeProse(root.purpose ?? root.travelerFit ?? root.summary) ?? sanitizeProse(root.routeRationale) ?? 'A trip composed for this traveller.',
    routeRationale: sanitizeProse(root.routeRationale ?? root.route) ?? sanitizeProse(root.purpose) ?? 'Bases follow the direction of travel.',
    assumptions: stringList(root.assumptions, 'assumptions', touched).slice(0, 5),
    tradeoffs: stringList(root.tradeoffs, 'tradeoffs', touched).slice(0, 5),
    bases: bases.slice(0, 8),
    days: days.slice(0, 40),
    omissions: (omissionsRaw as unknown[])
      .map((entry) => {
        const omission = record(entry);
        const name = sanitizeProse(omission?.name ?? (typeof entry === 'string' ? entry : undefined));
        const reason = sanitizeProse(omission?.reason ?? omission?.why) ?? 'Left out on purpose.';
        return name ? { name: name.slice(0, 60), reason } : null;
      })
      .filter((entry): entry is { name: string; reason: string } => entry !== null)
      .slice(0, 8),
    unresolved: stringList(root.unresolved, 'unresolved', touched).slice(0, 8),
    bookingPriorities: stringList(root.bookingPriorities ?? root.bookFirst, 'bookingPriorities', touched).slice(0, 8),
    package: {
      foodStrategy: stringList(root.foodStrategy ?? pkg?.foodStrategy, 'foodStrategy', touched).slice(0, 6),
      transport: {
        summary: sanitizeProse(root.transportSummary ?? transportObject?.summary) ?? 'Getting around as the days describe.',
        notes: stringList(root.transportNotes ?? transportObject?.notes, 'transportNotes', touched).slice(0, 6),
      },
      beforeYouGo: stringList(root.beforeYouGo ?? pkg?.beforeYouGo, 'beforeYouGo', touched).slice(0, 10),
      packing: stringList(root.packing ?? pkg?.packing, 'packing', touched).slice(0, 15),
      backups: (backupsRaw as unknown[])
        .map((entry) => {
          const backup = record(entry);
          const trigger = sanitizeProse(backup?.trigger ?? backup?.if);
          const alternative = sanitizeProse(backup?.alternative ?? backup?.then ?? backup?.plan);
          return trigger && alternative ? { trigger, alternative } : null;
        })
        .filter((entry): entry is { trigger: string; alternative: string } => entry !== null)
        .slice(0, 6),
    },
  };
  if (!sanitizeProse(root.transportSummary ?? transportObject?.summary)) touched.push('transportSummary (absent → default)');

  if (issues.length > 0) return { ok: false, kind: 'semantic', issues };

  // Canonical clipping (caps), then the strict canonical schema and structure checks.
  const clipped = normalizeTripDraft(candidate);
  touched.push(...clipped.normalizedFields);
  const parsed = tripDraftSchema.safeParse(clipped.value);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'structural',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message, ...(('expected' in issue && issue.expected !== undefined) ? { expected: String(issue.expected) } : {}), ...(('received' in issue && issue.received !== undefined) ? { received: String(issue.received).slice(0, 80) } : {}) })),
    };
  }
  const structure = draftStructureIssues(parsed.data);
  if (structure.length > 0) return { ok: false, kind: 'semantic', issues: structure.map((message) => ({ path: 'days', code: 'structure', message })) };
  return { ok: true, draft: parsed.data, normalizedFields: touched };
}

/** The prose caps the canonical layer clips to, exposed so the prompt can say them once. */
export const WIRE_PROSE_CAPS = DRAFT_SOFT_PROSE_CAPS;
