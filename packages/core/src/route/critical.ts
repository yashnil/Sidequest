import { z } from 'zod';
import { sameIdentity } from '../naming/aliases';
import { coordinatesSchema } from '../schemas/common';

/**
 * V10 §5 — ROUTE-CRITICAL PLACEMENT IS MANDATORY, AND MEASURED.
 *
 * Not every name in a plan has to be on the map. A café suggestion may stay a
 * suggestion; a decorative viewpoint may stay unverified. But four classes of
 * name decide the *shape* of the trip, and if one of those is unplaced the plan
 * is not a plan:
 *
 *   base                 — somewhere the traveller sleeps
 *   gateway              — where the trip enters and leaves
 *   route_defining_stop  — a stop the day's geography is built around
 *   signature_experience — what the trip is for
 *
 * The founder's trip placed 21 of 22 stops and **2 of 5 bases**, and every
 * consequence followed from the three that failed: four base transfers never
 * measured, a day-3 reversal invisible because the day could not be judged, and
 * a feasibility verdict of `unresolved_major_dependency` handed to a traveller
 * anyway. All three were ordinary named towns in the destination country.
 *
 * Two things fix that, and both live here:
 *
 * 1. **A query ladder** (`placementQueries`). A bare name is the *worst* way to
 *    ask: one of those three town names is also a waterfall elsewhere in the
 *    same country, another is a common noun in its own language, and the third
 *    arrived with "area" appended — not a place name at all, the draft's own
 *    hedge word defeating an exact match. So the name is asked with its region and
 *    country, and with its hedge words stripped, in a deterministic order, and
 *    the ladder stops at the first accepted answer.
 * 2. **A placement report** (`PlacementReport`). The rate is recorded on every
 *    build, each unresolved critical name says what was asked and what came
 *    back, and "Ready" is gated on it — so this can never again be invisible.
 */

export const ROUTE_CRITICAL_KINDS = ['base', 'gateway', 'route_defining_stop', 'signature_experience'] as const;
export const routeCriticalKindSchema = z.enum(ROUTE_CRITICAL_KINDS);
export type RouteCriticalKind = z.infer<typeof routeCriticalKindSchema>;

export const PLACEMENT_OUTCOMES = [
  'placed',
  /** Asked, and no candidate the geographic screen would accept came back. */
  'no_acceptable_candidate',
  /** Asked, and several real places matched equally well. A question for the traveller, not a guess. */
  'ambiguous',
  /** The provider failed, timed out or was rate-limited. Never "does not exist". */
  'provider_unavailable',
  /** Never asked: the verification deadline had already passed. */
  'not_attempted',
  /** No geocoder or places provider is configured at all. */
  'no_provider',
] as const;
export const placementOutcomeSchema = z.enum(PLACEMENT_OUTCOMES);
export type PlacementOutcome = z.infer<typeof placementOutcomeSchema>;

export const placementAttemptSchema = z.object({
  query: z.string().min(1).max(200),
  outcome: placementOutcomeSchema,
  /** How many candidates came back, before the geographic screen. */
  candidates: z.number().int().nonnegative().optional(),
});
export type PlacementAttempt = z.infer<typeof placementAttemptSchema>;

export const routeCriticalPlacementSchema = z.object({
  id: z.string().min(1).max(96),
  name: z.string().min(1).max(160),
  kind: routeCriticalKindSchema,
  outcome: placementOutcomeSchema,
  coordinates: coordinatesSchema.optional(),
  /** Every query the ladder tried, in order. The diagnostic that was missing entirely. */
  attempts: z.array(placementAttemptSchema).max(8).default([]),
  /** One traveller-readable sentence when it failed. No field names (§19). */
  travellerNote: z.string().max(240).optional(),
});
export type RouteCriticalPlacement = z.infer<typeof routeCriticalPlacementSchema>;

export const PLACEMENT_REPORT_VERSION = 1 as const;

export const placementReportSchema = z.object({
  version: z.literal(PLACEMENT_REPORT_VERSION),
  placements: z.array(routeCriticalPlacementSchema).max(120).default([]),
  /**
   * Geocoder requests the base and gateway ladders spent, for the latency budget.
   * Anchor lookups are counted by the provider budget rather than here, because
   * they run through the places seam as well.
   */
  providerCalls: z.number().int().nonnegative().default(0),
  /** Wall-clock milliseconds the whole placement pass took. */
  elapsedMs: z.number().int().nonnegative().default(0),
});
export type PlacementReport = z.infer<typeof placementReportSchema>;

/** Placed over total, for the four critical kinds only. 1 when there is nothing critical to place. */
export function routeCriticalRate(report: PlacementReport): number {
  if (report.placements.length === 0) return 1;
  const placed = report.placements.filter((p) => p.outcome === 'placed').length;
  return Math.round((placed / report.placements.length) * 100) / 100;
}

/** The critical names still unplaced. §22: a finished self-drive trip may not have these. */
export function unplacedCritical(report: PlacementReport): RouteCriticalPlacement[] {
  return report.placements.filter((p) => p.outcome !== 'placed');
}

/**
 * Outcomes where a provider *answered* and the answer was unusable. These are
 * the ones that say something about the plan.
 */
const ANSWERED_BADLY: ReadonlySet<PlacementOutcome> = new Set<PlacementOutcome>(['no_acceptable_candidate', 'ambiguous']);

/**
 * §5 §19 — a critical anchor the map could not settle means the trip is not
 * "Ready".
 *
 * Two deliberate limits. It is not "the trip is broken": the plan stands, the
 * content stands, and the traveller is told precisely which location could not
 * be placed. And it is **not triggered by Sidequest's own gaps** — no geocoder
 * configured, the deadline reached first, a provider that timed out. §19 forbids
 * turning Sidequest's work into the traveller's decision, and there is no
 * decision to make when nobody was asked; those gaps are reported as issues and
 * the unmeasured transfers they cause already lower readiness on their own.
 */
export function placementBlocksReady(report: PlacementReport): boolean {
  return unplacedCritical(report).some((p) => (p.kind === 'base' || p.kind === 'gateway') && ANSWERED_BADLY.has(p.outcome));
}

// ---------------------------------------------------------------------------
// The query ladder
// ---------------------------------------------------------------------------

/**
 * Words a draft uses to hedge a location rather than to name one.
 *
 * "<town> area" is not a place; "<town>" is. Generic English hedges only — never a
 * place name, and never a language-specific rule that would mangle a real name.
 * `vík` stays `vík`.
 */
const TRAILING_HEDGES = new Set(['area', 'areas', 'region', 'vicinity', 'surrounds', 'surroundings', 'outskirts', 'environs']);
const LEADING_HEDGES = new Set(['greater']);

/**
 * V10 §5 — WHAT A DRAFT ADDS TO A PLACE NAME THAT A GAZETTEER DOES NOT CARRY.
 *
 * A live composition wrote a glacier's name followed by "glacier walk", a
 * locality's followed by "hiking trails", and a gorge's followed by "canyon".
 * Every one is a real place followed by what you *do* there or what kind of thing
 * it is — helpful to a traveller and fatal to an exact match, because no map
 * source holds the phrase.
 *
 * Two rules keep this from doing damage. The suffix has to be *trailing*, and the
 * form it produces is tried **after** the name as written — so a beach, a lagoon
 * or a district whose own name ends in the word is asked for as itself first, and
 * a wrong strip costs one extra request rather than a wrong answer. And the
 * remainder has to still look like a name: stripping down to one short word is
 * refused.
 */
const TRAILING_DESCRIPTORS = [
  'hiking trails',
  'hiking trail',
  'walking trails',
  'walking trail',
  'roadside views',
  'roadside view',
  'glacier walk',
  'glacier hike',
  'crater lake',
  'national park',
  'nature reserve',
  'viewpoint',
  'viewpoints',
  'lookout',
  'trails',
  'trail',
  'canyon',
  'gorge',
  'walk',
  'hike',
];
/**
 * A remainder shorter than this is not a name, so the descriptor was part of it.
 *
 * `village`, `town` and `harbour` are deliberately absent from the list above for
 * the same reason at the other end: plenty of real settlements end in one of
 * those words, and the names that merely *describe* themselves that way place as
 * written anyway — so stripping them buys nothing and risks a wrong answer.
 */
const MIN_REMAINDER_LENGTH = 4;

/** A name with a trailing descriptor removed, or null when it carries none. */
export function stripTrailingDescriptor(name: string): string | null {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  for (const descriptor of TRAILING_DESCRIPTORS) {
    if (!lower.endsWith(` ${descriptor}`)) continue;
    const remainder = trimmed.slice(0, trimmed.length - descriptor.length - 1).trim();
    if (remainder.length >= MIN_REMAINDER_LENGTH) return remainder;
  }
  return null;
}

/**
 * V10 §5 — a name offering a choice ("<town> / <lagoon> area") is two names.
 *
 * A live composition wrote exactly that shape as a base, and it placed nothing:
 * no gazetteer holds a slash. Each side is a real answer, and asking for them in
 * order is how §5 says to resolve another candidate rather than give up.
 */
export function splitAlternatives(name: string): string[] {
  if (!/[/]|\bor\b/i.test(name)) return [];
  /*
   * Two characters, not four: a real place name can be three letters long, and
   * the live base this exists for names one of those on the left of its slash.
   * The longer minimum below is for a *descriptor* remainder, where three letters
   * left over is more likely a mangling than a name.
   */
  const parts = name
    .split(/\s*\/\s*|\s+\bor\b\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  return parts.length > 1 ? parts : [];
}

/**
 * A name with its hedge words removed, or null when nothing was hedged.
 *
 * Deliberately a short list, and deliberately position-sensitive. "District",
 * "Central", "Near" and "Side" are all hedge-shaped and all of them are part of
 * real place names — stripping them would turn a lake district into a lake and a
 * central park into a park. The ladder tries the unstripped form too, so a
 * missed hedge costs one query; a wrong strip can cost a wrong answer, which is
 * the more expensive mistake.
 */
export function stripHedgeWords(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}]/gu, '');
  let start = 0;
  let end = words.length;
  while (start < end - 1 && LEADING_HEDGES.has(bare(words[start]!))) start += 1;
  while (end > start + 1 && TRAILING_HEDGES.has(bare(words[end - 1]!))) end -= 1;
  const stripped = words.slice(start, end).join(' ');
  if (!stripped || stripped === name.trim()) return null;
  return stripped;
}

export interface PlacementQueryInput {
  /** What the draft called it. */
  name: string;
  /** The locality the draft put it in, when it named one separately. */
  locality?: string | undefined;
  /** The destination's own label, for the region tier. */
  regionName?: string | undefined;
  /** The country's published name, for the country tier. Not a code. */
  countryName?: string | undefined;
  /** First-level divisions the destination sits in, for the province tier. */
  divisions?: readonly string[] | undefined;
  /**
   * V11 §K — other spellings of the same name, from the traveller or the plan.
   *
   * Never generated: a romanisation this product invented is a query for a place
   * that may not exist under it. These are spellings somebody actually wrote —
   * the traveller's own words for a must-do, the draft's name for the same stop
   * — and they are asked in order after the name as written.
   */
  aliases?: readonly string[] | undefined;
}

function contains(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(haystack);
}

/**
 * The queries to try, in order, deduplicated.
 *
 * Most specific context first, because that is what disambiguates: a name with
 * its province and country cannot be the same-named town in another country. The
 * hedge-stripped form is tried alongside each tier rather than only at the end,
 * because a hedge defeats an exact match at *every* tier.
 */
/**
 * How many queries a ladder may spend, by what the name is worth.
 *
 * A base or a gateway decides the shape of the trip, so it is worth three
 * attempts. A stop is worth two: the most-qualified form and one fallback. The
 * cap matters because a provider that answers *empty* rather than throwing walks
 * the whole ladder for every name — a 22-stop trip against a silent geocoder
 * would otherwise cost six times what it used to and spend the verification
 * budget establishing the same silence twenty-two times.
 */
export const LADDER_LIMITS = { base: 4, gateway: 2, route_defining_stop: 3, signature_experience: 3 } as const satisfies Record<RouteCriticalKind, number>;

export function placementQueries(input: PlacementQueryInput): string[] {
  const raw = input.name.trim();
  /*
   * The forms to ask for, best-known first: the name as written, then with the
   * draft's hedge word removed, then each side of an alternation, then with a
   * trailing descriptor removed. Every later form is a *fallback* — it is only
   * ever reached because the earlier one found nothing acceptable — so a wrong
   * strip costs one request and never a wrong answer.
   */
  const forms: string[] = [];
  /*
   * V11 §K — DEDUPLICATED BY IDENTITY, NOT BY STRING.
   *
   * `Song-Köl` and `Song-Kul` are the same question asked twice. A case-folded
   * string comparison cannot see that — they differ by a letter, not by a mark —
   * so the ladder spent two of its eight queries on one name, and on a trip with
   * several such names it spent them all before reaching the qualified forms
   * that actually resolve. `sameIdentity` reduces both to one, which is a cheaper
   * *and* better-qualified ladder.
   */
  const addForm = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !forms.some((existing) => sameIdentity(existing, trimmed))) forms.push(trimmed);
  };
  addForm(raw);
  /* Spellings the traveller or the plan used for the same place; never invented here. */
  for (const alias of input.aliases ?? []) addForm(alias);
  const stripped = stripHedgeWords(raw);
  addForm(stripped);
  for (const alternative of splitAlternatives(stripped ?? raw)) {
    addForm(alternative);
    addForm(stripHedgeWords(alternative));
  }
  for (const form of [...forms]) addForm(stripTrailingDescriptor(form));
  const out: string[] = [];
  const push = (query: string) => {
    const trimmed = query.trim().replace(/\s*,\s*/g, ', ').replace(/(,\s*)+$/, '');
    if (trimmed && !out.some((q) => sameIdentity(q, trimmed))) out.push(trimmed);
  };
  /* The qualifiers, coarsest last. Each is skipped when the name already carries it. */
  const qualifierTiers: string[][] = [];
  const locality = input.locality?.trim();
  const region = input.regionName?.trim();
  const country = input.countryName?.trim();
  const divisions = (input.divisions ?? []).map((d) => d.trim()).filter(Boolean);
  for (const form of forms) {
    const parts: string[] = [];
    /* Each qualifier is added only when nothing already in the query carries it. A draft that writes "Alberta, Canada" as the locality has already said the country. */
    const already = (needle: string) => contains(form, needle) || parts.some((part) => contains(part, needle));
    if (locality && !already(locality)) parts.push(locality);
    /*
     * The destination's divisions are a *list* for a region that spans several,
     * and the base's own locality usually names the right one already. Adding the
     * first of the list regardless produced "Field, British Columbia, Canada,
     * Alberta", which is two provinces in one query and matches nothing.
     */
    if (divisions.length > 0 && !divisions.some((division) => already(division))) parts.push(divisions[0]!);
    if (country && !already(country)) parts.push(country);
    if (parts.length > 0) qualifierTiers.push([form, ...parts]);
  }
  for (const tier of qualifierTiers) push(tier.join(', '));
  /* Then the name with the country alone, then with the destination's own label, then bare. */
  for (const form of forms) {
    if (country && !contains(form, country)) push(`${form}, ${country}`);
    if (region && !contains(form, region) && region !== country) push(`${form}, ${region}`);
  }
  for (const form of forms) push(form);
  return out.slice(0, 8);
}

/** The sentence a traveller reads for an unplaced critical name. Never a field name, never a provider. */
export function describeUnplaced(placement: RouteCriticalPlacement): string {
  switch (placement.outcome) {
    case 'ambiguous':
      /*
       * V12.3 §15 — the traveller is the one who can settle this, so the sentence
       * says what would settle it. "Could not find it" was both wrong and a dead
       * end; several candidates were found, and naming the area chooses.
       */
      return `More than one place is called ${placement.name}, and Sidequest will not guess which you mean — tell it the island, town or area and it will place it.`;
    case 'no_acceptable_candidate':
      return `Sidequest could not find ${placement.name} on the map, so the travel to and from it is not timed.`;
    case 'provider_unavailable':
      return `The map lookup for ${placement.name} did not answer, so the travel to and from it is not timed yet.`;
    case 'not_attempted':
      return `${placement.name} was not looked up before this plan was returned; the travel to and from it is not timed yet.`;
    case 'no_provider':
      return `${placement.name} has not been placed on the map, so the travel to and from it is not timed.`;
    default:
      return '';
  }
}
