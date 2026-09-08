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

/* ---------------------------------------------------------------------------
 * THE COMPACT WIRE — THE SAME TRIP, IN FAR FEWER BYTES
 *
 * MVP V3 latency closure. Two live ten-day Kyrgyzstan builds were cancelled at
 * the hundred-second deadline. The diagnosis was not that the model is slow at
 * *planning*; it is that it was asked to *write* far too much, and measurement
 * says where:
 *
 *   Ireland, 10 days, 26 activities — 15,325 bytes
 *     days      9,230  (60%)   of which 3,743 bytes are FIELD NAMES
 *     stays     1,610  (10%)
 *     the rest  4,485  (29%)   packing, beforeYouGo, bookingPriorities,
 *                              foodStrategy, transportNotes, unresolved,
 *                              assumptions — every one of which Sidequest's
 *                              own intelligence layers already build.
 *
 * So this schema removes three kinds of waste and nothing else:
 *
 * 1. **Fields Sidequest derives.** `buildPackingIntelligence` composes the
 *    packing list from weather, activity categories and leg modes and treats a
 *    model list as extra suggestions; `deriveBookings` builds the booking rows
 *    from the plan; readiness builds before-you-go. Asking the model to write
 *    first drafts of those spends the one budget that matters on text that is
 *    then mostly replaced.
 * 2. **Restated content.** A day carried `note` *and* `whyItFits`; one
 *    rationale per day is the contract now.
 * 3. **Derivable structure.** The day number is its position, `relocation` is
 *    the stay changing, and an activity's `role` is its order. None of these
 *    are travel judgement, and all three were re-typed on every row.
 *
 * What it deliberately does NOT do is reduce the trip. Every base, every day,
 * every activity, the transport strategy, the lodging character, the season
 * reasoning, the omissions and the tradeoffs are all still authored by the
 * model, and the field names below are shorter but still words a reader can
 * understand. This is representational compression, not a smaller holiday.
 *
 * The normaliser reads both shapes — every compact name is an alias beside the
 * long one — so every recorded answer still replays.
 * ------------------------------------------------------------------------ */

/*
 * OPTIONAL MEANS OMITTED, NOT NULL.
 *
 * Measured on the recorded answers: a nullable field the model has nothing to
 * say about still costs its name plus `:null` on every row — about 900 bytes
 * across a ten-day draft's activities alone. Every field below that a draft can
 * legitimately have no opinion about is `.optional()`, and the output contract
 * tells the model to leave those out rather than fill them with nulls.
 */

/** One experience. Everything but the name, kind and reason is optional. */
export const compactActivitySchema = z.object({
  name: str(),
  /** Town, valley or neighbourhood — only when it is not the stay itself. */
  near: str().optional(),
  kind: z.enum(ANCHOR_CATEGORIES),
  /** Time on site. Absent means Sidequest estimates it from the kind. */
  mins: z.number().optional(),
  /** How the traveller reaches this one — only when it is not the day's default. */
  how: z.enum(DRAFT_TRANSPORTS).optional(),
  why: str(),
});

/** A place to sleep. `lodging` carries the character — "yurt camp", "guesthouse". */
export const compactStaySchema = z.object({
  name: str(),
  nights: z.number(),
  why: str(),
  lodging: str().optional(),
});

/** Meal intent where a meal is a decision, not three fields on every day. */
export const compactMealsSchema = z.object({ b: str().optional(), l: str().optional(), d: str().optional() });

export const compactDaySchema = z.object({
  /** The stay's name, verbatim. The day number is this day's position. */
  stay: str(),
  theme: str(),
  acts: z.array(compactActivitySchema),
  meals: compactMealsSchema.optional(),
  /** One sentence: why this day, for this traveller. */
  why: str().optional(),
});

export const compactTripDraftWireSchema = z.object({
  archetype: z.enum(TRIP_ARCHETYPES),
  purpose: str(),
  routeRationale: str(),
  /** What this season opens and closes for this trip. */
  timingRationale: str().optional(),
  /** The strategy, in a sentence: who drives, what is hired, what is guided. */
  transportSummary: str(),
  stays: z.array(compactStaySchema),
  days: z.array(compactDaySchema),
  omissions: z.array(z.object({ name: str(), reason: str() })),
  tradeoffs: z.array(str()),
  backups: z.array(z.object({ trigger: str(), alternative: str() })),
});
export type CompactTripDraftWire = z.infer<typeof compactTripDraftWireSchema>;

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
  /** What this season means for this trip — what it opens, what it closes. */
  timingRationale: maybe(),
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
 * ## Why this was rewritten (MVP V3)
 *
 * The provider has refused exactly one schema in this product's history — the
 * 8,706-byte draft schema, with "The compiled grammar is too large" — and the
 * guard written from that observation carried five limits, four of which the
 * provider has never said anything about. Today's wire schema is **3,644 bytes**,
 * 42% of the refused one, and it was still being sent in prompt mode because of
 * `depth 6 > 4`, `44 properties > 32` and `5 arrays of objects > 4`: three
 * invented structural proxies.
 *
 * The cost of that was not theoretical. Prompt-enforced JSON is the only mode in
 * which a model can emit a character-level slip, and the real Hong Kong build lost
 * two complete, paid answers to exactly one — a key that swallowed its `":`
 * delimiter (see `providers/json-repair.ts`). Constrained decoding cannot produce
 * that at all.
 *
 * So the guard now states only what the provider has actually expressed: the size
 * of the compiled grammar, with generous headroom under the one refusal on record,
 * and the JSON-Schema keywords structured outputs are documented not to accept. A
 * schema that grows past the ceiling goes back to prompt mode by itself, and a
 * grammar the provider still refuses is a **pre-generation request rejection** —
 * nothing generated, nothing billed — which the transport classifies narrowly and
 * answers with one prompt-mode attempt inside the same build.
 */
/**
 * Two refusals on record, no successful compile. Both said the same thing —
 * "The compiled grammar is too large" — at 8,706 bytes (2026-09-05) and again
 * at **3,726 bytes** (2026-09-08, the live MVP V3 run). The second one is what
 * matters: the schema *text* is not what the provider is measuring. A grammar
 * compiled from arrays of objects with closed enums is far larger than the JSON
 * Schema that describes it, and this draft's shape is the expensive kind.
 *
 * So the ceiling sits well under the smaller of the two observations, which for
 * this schema means prompt mode. That is not a defeat: prompt mode is now safe,
 * because `providers/json-repair.ts` mends the one slip the model actually makes
 * (three occurrences on record) instead of discarding the answer. A future
 * schema that genuinely gets small enough switches itself back, and the
 * transport's single pre-generation fallback covers the case where the provider
 * still refuses.
 */
export const GRAMMAR_MODE_LIMITS = { bytes: 3_000 } as const;

export function grammarModeSuitable(profile: WireSchemaProfile): { suitable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (profile.unsupportedKeywords.length > 0) reasons.push(`unsupported keywords: ${profile.unsupportedKeywords.join(', ')}`);
  if (profile.bytes > GRAMMAR_MODE_LIMITS.bytes) reasons.push(`${profile.bytes} bytes > ${GRAMMAR_MODE_LIMITS.bytes} (the one limit the provider has expressed)`);
  return { suitable: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// A draft the model abandoned halfway
// ---------------------------------------------------------------------------

/**
 * AN ANSWER THAT STOPPED TRYING IS NOT A SHORTER ANSWER.
 *
 * The live run of 2026-09-08 returned two excellent Hong Kong days and then
 * `{"day3,"stay":"Hong Kong Island (Wan Chai / Causeway Bay)"}` with no
 * activities, no meals and no theme, followed by an empty transportSummary,
 * empty packing, empty backups, and this:
 *
 *     "omissions":[{"name":"placeholder","reason":"placeholder"}]
 *
 * `stop_reason` was `end_turn` and only 1,722 of 16,000 tokens were used, so
 * nothing was truncated — the model decided it had done enough. The day-count
 * check caught that one because the day array was short, but a model that pads
 * to the right *length* with stubs would have passed every check in this file
 * and become a trip.
 *
 * The prompt now forbids it and the effort setting makes it far less likely.
 * This is the check that makes sure neither of those is the only thing standing
 * between a stub and a traveller.
 */
const PLACEHOLDER = /^(placeholder|tbd|todo|n\/a|lorem ipsum|\.\.\.)$/i;

export function abandonedDraftIssues(draft: TripDraft): WireIssue[] {
  const issues: WireIssue[] = [];
  const empty = draft.days.filter((day) => day.anchors.length === 0);
  /*
   * One empty day is legitimate — a departure morning, a rest day the traveller
   * asked for. Two or more, or an empty day that is not at an edge, is a draft
   * that ran out of effort rather than one making a choice.
   */
  const interiorEmpty = empty.filter((day) => day.dayNumber !== 1 && day.dayNumber !== draft.days.length);
  if (interiorEmpty.length > 0) {
    issues.push({
      path: 'days',
      code: 'abandoned',
      message: 'a day in the middle of the trip has nothing in it',
      expected: 'every day between the first and the last carries at least one activity',
      received: `days ${interiorEmpty.map((day) => day.dayNumber).join(', ')} are empty`,
    });
  }
  const placeholders: string[] = [];
  for (const day of draft.days) {
    if (PLACEHOLDER.test(day.theme.trim())) placeholders.push(`days[${day.dayNumber}].theme`);
    for (const anchor of day.anchors) if (PLACEHOLDER.test(anchor.name.trim())) placeholders.push(`days[${day.dayNumber}] anchor "${anchor.name}"`);
  }
  for (const omission of draft.omissions) if (PLACEHOLDER.test(omission.name.trim())) placeholders.push(`omissions "${omission.name}"`);
  if (placeholders.length > 0) {
    issues.push({ path: 'days', code: 'placeholder', message: 'the draft contains placeholder text where content belongs', expected: 'real content in every field the draft filled in', received: placeholders.slice(0, 5).join('; ') });
  }
  return issues;
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
const TRANSPORT_ALIASES: Record<string, DraftTransport> = { walk: 'walk', walking: 'walk', foot: 'walk', on_foot: 'walk', hike: 'walk', metro: 'metro', subway: 'metro', tube: 'metro', underground: 'metro', mtr: 'metro', tram: 'metro', rail: 'rail', train: 'rail', bus: 'bus', coach: 'bus', shuttle: 'bus', car: 'car', drive: 'car', driving: 'car', self_drive: 'car', rental_car: 'car', taxi: 'car', rideshare: 'car', uber: 'car', ferry: 'ferry', boat: 'boat', cruise: 'boat', kayak: 'boat', flight: 'flight', fly: 'flight', plane: 'flight', air: 'flight', private_transfer: 'private_transfer', transfer: 'private_transfer', driver: 'private_transfer', private_driver: 'private_transfer', four_wheel_drive: 'four_wheel_drive', '4x4': 'four_wheel_drive', '4wd': 'four_wheel_drive', jeep: 'four_wheel_drive', game_vehicle: 'four_wheel_drive', horse: 'horse', horseback: 'horse', riding: 'horse', pony: 'horse', horse_trek: 'horse', guide_or_lodge_transfer: 'guide_or_lodge_transfer', guide: 'guide_or_lodge_transfer', guided: 'guide_or_lodge_transfer', lodge_transfer: 'guide_or_lodge_transfer', lodge: 'guide_or_lodge_transfer', tour: 'guide_or_lodge_transfer', unknown: 'unknown' };
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
/**
 * PROSE THAT IS TOO LONG IS TRIMMED, NEVER A REASON TO REFUSE A TRIP.
 *
 * The caps in `DRAFT_SOFT_PROSE_CAPS` are *display* limits — how much of a
 * sentence a card has room for — and they are described as soft in their own
 * name. They were nonetheless enforced only at the canonical schema, where
 * being over one rejected the whole draft.
 *
 * The live Kyrgyzstan run of 2026-09-08 is the case, and it is the reason this
 * argument exists: a complete ten-day draft that arrived inside the deadline,
 * with the right route, the right lodging and a genuinely good season
 * rationale, was thrown away because that rationale was **256 characters
 * against a 240 limit**. Sixteen characters.
 *
 * Trimming is structural repair — it invents nothing and changes no decision —
 * so it belongs here with the other structural repairs, and it is recorded in
 * `normalizedFields` so the audit shows what was shortened. Cut on a word
 * boundary with an ellipsis, because a sentence that stops mid-word reads as a
 * bug to the traveller.
 */
function sanitizeProse(value: unknown, cap?: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return undefined;
  if (cap === undefined || text.length <= cap) return text;
  const room = text.slice(0, cap - 1);
  const lastSpace = room.lastIndexOf(' ');
  const kept = (lastSpace > cap * 0.6 ? room.slice(0, lastSpace) : room).replace(/[\s,;:.\u2014-]+$/, '');
  return `${kept}\u2026`;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(value);
    if (m) return Number(m[0]);
  }
  return undefined;
}

function stringList(value: unknown, path: string, touched: string[], cap?: number): string[] {
  if (value === null || value === undefined) {
    touched.push(`${path} (absent → [])`);
    return [];
  }
  const one = (entry: unknown, index: number) =>
    cap === undefined
      ? sanitizeProse(entry)
      : capped(entry, cap, `${path}[${index}]`, touched);
  if (typeof value === 'string') {
    touched.push(`${path} (string → [string])`);
    const only = one(value, 0);
    return only ? [only] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) =>
      typeof entry === 'string'
        ? one(entry, index)
        : entry && typeof entry === 'object'
          ? one((entry as Record<string, unknown>).text ?? (entry as Record<string, unknown>).note ?? JSON.stringify(entry), index)
          : undefined,
    )
    .filter((entry): entry is string => Boolean(entry));
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
 * What a day's own activities say about how hard it is.
 *
 * Only used when the draft did not state an intensity. Reads the same numbers
 * the reconciler will read afterwards — total minutes on site, and whether any
 * of it is a hike — so the inference and the plan cannot disagree.
 */
function inferIntensity(day: Record<string, unknown>): 'light' | 'moderate' | 'intense' {
  const list = Array.isArray(day.acts) ? day.acts : Array.isArray(day.activities) ? day.activities : Array.isArray(day.anchors) ? day.anchors : [];
  let minutes = 0;
  let strenuous = false;
  for (const entry of list) {
    const activity = record(entry);
    if (!activity) continue;
    const mins = toNumber(activity.mins ?? activity.minutes ?? activity.duration ?? activity.durationMinutes);
    minutes += mins ?? 120;
    const kind = String(activity.kind ?? activity.category ?? activity.type ?? '').toLowerCase();
    if (kind.includes('hike') || kind.includes('trek') || kind.includes('climb')) strenuous = true;
  }
  if (list.length === 0) return 'light';
  if (strenuous || minutes >= 300) return 'intense';
  if (minutes <= 150 && list.length <= 1) return 'light';
  return 'moderate';
}

/**
 * Prose, trimmed to its display cap and the trim recorded.
 *
 * A field that was shortened shows up in `normalizedFields` — and therefore on
 * the build's own audit — so "why is this sentence cut off?" is answerable
 * without re-running anything.
 */
function capped(value: unknown, cap: number, path: string, touched: string[]): string | undefined {
  const full = sanitizeProse(value);
  if (full === undefined) return undefined;
  const trimmed = sanitizeProse(value, cap)!;
  if (trimmed !== full) touched.push(`${path} (${full.length} chars → ${cap} cap)`);
  return trimmed;
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
    const whyRaw = stay.why ?? stay.rationale ?? stay.reason;
    const why = capped(whyRaw, DRAFT_SOFT_PROSE_CAPS.baseWhy, `stays[${index}].why`, touched) ?? `Base for this part of the trip.`;
    if (!sanitizeProse(whyRaw)) touched.push(`stays[${index}].why (absent → default)`);
    const locality = sanitizeProse(stay.locality ?? stay.region);
    const lodgingArea = capped(stay.lodgingArea ?? stay.area, DRAFT_SOFT_PROSE_CAPS.lodgingArea, `stays[${index}].lodgingArea`, touched);
    const lodgingStyle = capped(stay.lodgingStyle ?? stay.style ?? stay.lodging, DRAFT_SOFT_PROSE_CAPS.lodgingStyle, `stays[${index}].lodgingStyle`, touched);
    /* The compact wire carries one `lodging` string; the long wire split area from style. */
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
    /*
     * INTENSITY FROM WHAT THE DAY HOLDS, WHEN NOBODY WROTE ONE.
     *
     * Read from the activities the model *did* author: total time on site and
     * whether any of it is a hike. A day of one short stop is light; a day
     * with a hike or five hours of activity is intense. Stated intensity
     * always wins.
     */
    const intensityGiven = day.intensity;
    const intensity = intensityGiven === undefined || intensityGiven === null || intensityGiven === ''
      ? { value: inferIntensity(day), mapped: false }
      : mapEnum(intensityGiven, INTENSITY_ALIASES, 'moderate');
    if (intensity.mapped) touched.push(`days[${index}].intensity (${String(intensityGiven)} → ${intensity.value})`);
    if (intensityGiven === undefined) touched.push(`days[${index}].intensity (absent → ${intensity.value} from the day's own activities)`);
    const activitiesRaw = Array.isArray(day.activities)
      ? day.activities
      : Array.isArray(day.acts)
        ? day.acts
        : Array.isArray(day.anchors)
          ? (touched.push(`days[${index}].anchors → activities`), day.anchors)
          : [];
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
      /*
       * ROLE IS THE ORDER, WHEN NOBODY WROTE ONE.
       *
       * The compact wire drops `role` because it was a second way of saying
       * what the array already says: the day opens with the thing the day is
       * for. Derived by position — first is core, the next two secondary, the
       * rest optional — and still honoured verbatim when a draft states it.
       */
      const roleGiven = activity.role ?? activity.priority ?? activity.importance;
      const positionRole: (typeof ANCHOR_ROLES)[number] = activityIndex === 0 ? 'core' : activityIndex <= 2 ? 'secondary' : 'optional';
      const role = roleGiven === undefined || roleGiven === null || roleGiven === ''
        ? { value: positionRole, mapped: false }
        : mapEnum(roleGiven, ROLE_ALIASES, positionRole);
      if (role.mapped) touched.push(`days[${index}].activities[${activityIndex}].role (${String(roleGiven)} → ${role.value})`);
      if (roleGiven === undefined) touched.push(`days[${index}].activities[${activityIndex}].role (absent → ${positionRole} by position)`);
      const transportRaw = activity.transport ?? activity.how ?? activity.mode;
      const transport = transportRaw === null || transportRaw === undefined || transportRaw === '' ? { value: null, mapped: false } : mapEnum(transportRaw, TRANSPORT_ALIASES, 'unknown');
      if (transport.mapped) touched.push(`days[${index}].activities[${activityIndex}].transport (${String(transportRaw)} → ${transport.value})`);
      const minutesRaw = activity.minutes ?? activity.mins ?? activity.estimatedDurationMinutes ?? activity.duration ?? activity.durationMinutes;
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
        why: capped(activity.why ?? activity.rationale ?? activity.reason, DRAFT_SOFT_PROSE_CAPS.anchorWhy, `days[${index}].activities[${activityIndex}].why`, touched) ?? '',
      });
    });
    if (anchors.length > 5) {
      touched.push(`days[${index}].activities (${anchors.length} → 5, the last kept as flex would not fit)`);
      anchors.length = 5;
    }
    /* `meals: {b,l,d}` on the compact wire; three flat fields on the long one. */
    const mealsObject = record(day.meals);
    const breakfast = capped(day.breakfast ?? mealsObject?.breakfast ?? mealsObject?.b, DRAFT_SOFT_PROSE_CAPS.meal, `days[${index}].breakfast`, touched);
    const lunch = capped(day.lunch ?? mealsObject?.lunch ?? mealsObject?.l, DRAFT_SOFT_PROSE_CAPS.meal, `days[${index}].lunch`, touched);
    const dinner = capped(day.dinner ?? mealsObject?.dinner ?? mealsObject?.d, DRAFT_SOFT_PROSE_CAPS.meal, `days[${index}].dinner`, touched);
    /*
     * RELOCATION IS THE STAY CHANGING.
     *
     * The compact wire drops the flag because it restated the `stay` field: a
     * day whose stay differs from yesterday's is a day that moves. Derived
     * here, and still honoured when a draft states it.
     */
    const relocationRaw = day.relocation;
    const movedBase = days.length > 0 && days[days.length - 1]!.baseId !== baseId;
    const relocation = typeof relocationRaw === 'boolean'
      ? relocationRaw
      : typeof relocationRaw === 'string'
        ? /^(true|yes|y|1)$/i.test(relocationRaw) || (relocationRaw.trim().length > 3 && !/^(no|none|false|n|0)$/i.test(relocationRaw))
        : movedBase;
    if (typeof relocationRaw === 'string') touched.push(`days[${index}].relocation (string → boolean)`);
    if (relocationRaw === undefined && movedBase) touched.push(`days[${index}].relocation (absent → true, the stay changed)`);
    const note = capped(day.note ?? day.practicalNote ?? day.practical, DRAFT_SOFT_PROSE_CAPS.dayNote, `days[${index}].note`, touched);
    /* One rationale per day on the compact wire; `note` and `whyItFits` on the long one. */
    const whyItFits = capped(day.whyItFits ?? day.travelerFit ?? day.fit ?? day.why, DRAFT_SOFT_PROSE_CAPS.whyItFits, `days[${index}].why`, touched);
    days.push({
      dayNumber: index + 1,
      baseId,
      theme: capped(day.theme ?? day.title, DRAFT_SOFT_PROSE_CAPS.dayTheme, `days[${index}].theme`, touched) ?? `Day ${index + 1}`,
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
    purpose: capped(root.purpose ?? root.travelerFit ?? root.summary, DRAFT_SOFT_PROSE_CAPS.purpose, 'purpose', touched) ?? capped(root.routeRationale, DRAFT_SOFT_PROSE_CAPS.purpose, 'purpose', touched) ?? 'A trip composed for this traveller.',
    routeRationale: capped(root.routeRationale ?? root.route, DRAFT_SOFT_PROSE_CAPS.routeRationale, 'routeRationale', touched) ?? capped(root.purpose, DRAFT_SOFT_PROSE_CAPS.routeRationale, 'routeRationale', touched) ?? 'Bases follow the direction of travel.',
    /*
     * The field that rejected a complete live draft for being sixteen
     * characters long. Trimmed like every other capped sentence now.
     */
    ...(() => {
      const timing = capped(root.timingRationale ?? root.seasonRationale ?? root.whenRationale, DRAFT_SOFT_PROSE_CAPS.routeRationale, 'timingRationale', touched);
      return timing ? { timingRationale: timing } : {};
    })(),
    assumptions: stringList(root.assumptions, 'assumptions', touched, DRAFT_SOFT_PROSE_CAPS.assumption).slice(0, 5),
    tradeoffs: stringList(root.tradeoffs, 'tradeoffs', touched, DRAFT_SOFT_PROSE_CAPS.tradeoff).slice(0, 5),
    bases: bases.slice(0, 8),
    days: days.slice(0, 40),
    omissions: (omissionsRaw as unknown[])
      .map((entry) => {
        const omission = record(entry);
        const name = sanitizeProse(omission?.name ?? (typeof entry === 'string' ? entry : undefined));
        const reason = capped(omission?.reason ?? omission?.why, DRAFT_SOFT_PROSE_CAPS.omissionReason, 'omissions[].reason', touched) ?? 'Left out on purpose.';
        return name ? { name: name.slice(0, 60), reason } : null;
      })
      .filter((entry): entry is { name: string; reason: string } => entry !== null)
      .slice(0, 8),
    unresolved: stringList(root.unresolved, 'unresolved', touched, DRAFT_SOFT_PROSE_CAPS.unresolvedItem).slice(0, 8),
    bookingPriorities: stringList(root.bookingPriorities ?? root.bookFirst, 'bookingPriorities', touched, DRAFT_SOFT_PROSE_CAPS.bookingPriority).slice(0, 8),
    package: {
      foodStrategy: stringList(root.foodStrategy ?? pkg?.foodStrategy, 'foodStrategy', touched, DRAFT_SOFT_PROSE_CAPS.foodStrategy).slice(0, 6),
      transport: {
        summary: capped(root.transportSummary ?? transportObject?.summary, DRAFT_SOFT_PROSE_CAPS.transportSummary, 'transportSummary', touched) ?? 'Getting around as the days describe.',
        notes: stringList(root.transportNotes ?? transportObject?.notes, 'transportNotes', touched, DRAFT_SOFT_PROSE_CAPS.transportNote).slice(0, 6),
      },
      beforeYouGo: stringList(root.beforeYouGo ?? pkg?.beforeYouGo, 'beforeYouGo', touched, DRAFT_SOFT_PROSE_CAPS.beforeYouGo).slice(0, 10),
      packing: stringList(root.packing ?? pkg?.packing, 'packing', touched, DRAFT_SOFT_PROSE_CAPS.packing).slice(0, 15),
      backups: (backupsRaw as unknown[])
        .map((entry) => {
          const backup = record(entry);
          const trigger = capped(backup?.trigger ?? backup?.if, DRAFT_SOFT_PROSE_CAPS.backupTrigger, 'backups[].trigger', touched);
          const alternative = capped(backup?.alternative ?? backup?.then ?? backup?.plan, DRAFT_SOFT_PROSE_CAPS.backupAlternative, 'backups[].alternative', touched);
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
  const abandoned = abandonedDraftIssues(parsed.data);
  if (abandoned.length > 0) return { ok: false, kind: 'semantic', issues: abandoned };
  return { ok: true, draft: parsed.data, normalizedFields: touched };
}

/** The prose caps the canonical layer clips to, exposed so the prompt can say them once. */
export const WIRE_PROSE_CAPS = DRAFT_SOFT_PROSE_CAPS;
