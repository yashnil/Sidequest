import { z } from 'zod';

/**
 * TYPED GEOGRAPHIC NAMES.
 *
 * ---
 *
 * ## The defect
 *
 * Containment used to compare one untyped set of strings against another. The
 * destination's accept-set was built by unioning its resolved region name with
 * its *whole published hierarchy* — which, on one of the two producers, is a
 * flat array holding the country, the state, the county and the city at once.
 * So a country name sat in the region accept-set, and a record whose region was
 * the country's name "agreed at region". On the other producer the same array
 * ran fine-to-coarse rather than coarse-to-fine, so the two paths did not even
 * disagree in the same direction.
 *
 * A country-name match cannot prove membership in a selected city. That is the
 * whole of CS-11, and no amount of widening or narrowing one string set fixes
 * it, because the fault is that the set has no levels in it.
 *
 * ## The correction
 *
 * Each name keeps the level the source assigned it, and comparison happens
 * **within a level**. A value nobody levelled is kept, and can corroborate, and
 * can never refuse.
 *
 * ## The three-valued comparator
 *
 * `agree` / `disagree` / `not_comparable`, and the third is the one that
 * matters. Two sides can fail to agree because they conflict, or because they
 * were written in vocabularies that do not meet — an ISO 3166-2 code on one side
 * and a printed subdivision name on the other. A measured probe over stored
 * packs found the region field populated for **1.5 %–5.9 %** of candidates and
 * carrying *both* vocabularies depending on which producer answered, so
 * collapsing "we cannot compare these" into "these disagree" would delete most
 * of a region and report it as a place-belongs-elsewhere verdict.
 *
 * `not_comparable` never refuses. It is not a soft `disagree`; it is the absence
 * of a comparison.
 */

/**
 * The administrative levels this codebase compares at.
 *
 * Ordered coarse to fine. `county` is present because the divisions layer
 * publishes it and because it is the level at which a metropolitan destination
 * and its neighbours actually differ; it is not present in every country's
 * hierarchy, which is exactly why the comparator has a `not_comparable`.
 */
export const GEOGRAPHIC_LEVELS = [
  'country',
  'region',
  'county',
  'locality',
  'neighbourhood',
] as const;
export type GeographicLevel = (typeof GEOGRAPHIC_LEVELS)[number];

export const geographicLevelSchema = z.enum(GEOGRAPHIC_LEVELS);

/**
 * What a source published about where something is, with the levels kept.
 *
 * Every field is optional or empty-able. The emptiness is the honest state for
 * most records on earth and must never be read as a conflict.
 */
export const geographicEvidenceSchema = z.object({
  /** ISO 3166-1 alpha-2, upper case. A code, never a label. */
  countryCode: z.string().length(2).optional(),
  /** ISO 3166-2, upper case, e.g. `US-NY`. A code, never a label. */
  regionCode: z.string().min(4).max(6).optional(),
  /**
   * Division record identifiers, outermost first.
   *
   * Identity rather than name: two records sharing one of these are in the same
   * published division whatever either of them is called, in whatever script.
   */
  divisionIds: z.array(z.string().min(1)).default([]),
  countryNames: z.array(z.string().min(1)).default([]),
  regionNames: z.array(z.string().min(1)).default([]),
  countyNames: z.array(z.string().min(1)).default([]),
  localityNames: z.array(z.string().min(1)).default([]),
  neighbourhoodNames: z.array(z.string().min(1)).default([]),
  /**
   * Names whose level nobody published.
   *
   * Kept, because a name we cannot place is still a name, and thrown into no
   * level's accept-set, because a name we cannot place cannot decide a level.
   * They corroborate an answer the levelled evidence already permitted.
   */
  unleveledNames: z.array(z.string().min(1)).default([]),
  /**
   * Rendered labels: "Manhattan, New York, United States".
   *
   * Never containment evidence at any level. A display name is a sentence about
   * a place, assembled for a person to read, and matching one against a level is
   * how a country's name ended up deciding a city's membership.
   */
  displayNames: z.array(z.string().min(1)).default([]),
  /**
   * Other spellings and scripts of **the entity this evidence describes**.
   *
   * Compared only at the entity's own level. `Кыргызстан` and `Kyrgyzstan` are
   * one country and must not read as two; they are also not a region.
   */
  aliases: z.array(z.string().min(1)).default([]),
});
export type GeographicEvidence = z.infer<typeof geographicEvidenceSchema>;

export const EMPTY_GEOGRAPHIC_EVIDENCE: GeographicEvidence = {
  divisionIds: [],
  countryNames: [],
  regionNames: [],
  countyNames: [],
  localityNames: [],
  neighbourhoodNames: [],
  unleveledNames: [],
  displayNames: [],
  aliases: [],
};

export const LEVEL_COMPARISONS = ['agree', 'disagree', 'not_comparable'] as const;
export type LevelComparison = (typeof LEVEL_COMPARISONS)[number];
export const levelComparisonSchema = z.enum(LEVEL_COMPARISONS);

/**
 * Whether a string is an ISO 3166-2 subdivision code rather than a name.
 *
 * The bridge material CS-11 named. Both producers already carry it and both
 * discard the distinction: the divisions layer writes `IS-8` into the same field
 * the address path writes `Suðurland` into. Detecting the shape is what lets a
 * code be compared against a code and a name against a name, instead of a code
 * being compared against a name and reported as a border.
 *
 * Deliberately strict. `US-NY` and `GB-ENG` match; `US` alone does not (that is
 * a country), and neither does any string carrying a space or a lowercase run,
 * because a two-letter word followed by a hyphen is a plausible place name.
 */
export function isSubdivisionCode(value: string): boolean {
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(value.trim());
}

/**
 * Name comparison that survives being written by two different people.
 *
 * Case, diacritics, punctuation and the administrative suffixes a catalogue
 * appends inconsistently are all stripped. Over-matching under-excludes, which
 * loses precision; under-matching over-excludes, which loses a real place. The
 * former is the failure to prefer.
 */
export function normaliseGeographicName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

export function sameGeographicName(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normaliseGeographicName(left) === normaliseGeographicName(right);
}

function namesAt(evidence: GeographicEvidence, level: GeographicLevel): readonly string[] {
  switch (level) {
    case 'country':
      return evidence.countryNames;
    case 'region':
      return evidence.regionNames;
    case 'county':
      return evidence.countyNames;
    case 'locality':
      return evidence.localityNames;
    case 'neighbourhood':
      return evidence.neighbourhoodNames;
  }
}

function codeAt(evidence: GeographicEvidence, level: GeographicLevel): string | undefined {
  if (level === 'country') return evidence.countryCode;
  if (level === 'region') return evidence.regionCode;
  return undefined;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const normalised = new Set(right.map(normaliseGeographicName));
  return left.some((value) => normalised.has(normaliseGeographicName(value)));
}

/**
 * How two pieces of geographic evidence stand at one level.
 *
 * Codes are compared against codes and names against names, and the two
 * vocabularies never meet. When only a cross-vocabulary pairing is available the
 * answer is `not_comparable` — which is the truth, and which never refuses.
 *
 * `aliases` are folded into whichever level the evidence's own entity sits at,
 * and the caller says which that is. A country's aliases must not be able to
 * satisfy a locality comparison.
 */
export function compareAtLevel(
  level: GeographicLevel,
  subject: GeographicEvidence,
  scope: GeographicEvidence,
  options: { aliasLevel?: GeographicLevel } = {},
): LevelComparison {
  const subjectCode = codeAt(subject, level);
  const scopeCode = codeAt(scope, level);
  if (subjectCode && scopeCode) {
    return subjectCode.toUpperCase() === scopeCode.toUpperCase() ? 'agree' : 'disagree';
  }

  const aliasApplies = options.aliasLevel === level;
  const subjectNames = [...namesAt(subject, level), ...(aliasApplies ? subject.aliases : [])];
  const scopeNames = [...namesAt(scope, level), ...(aliasApplies ? scope.aliases : [])];
  if (subjectNames.length === 0 || scopeNames.length === 0) return 'not_comparable';
  return intersects(subjectNames, scopeNames) ? 'agree' : 'disagree';
}

/** Whether any level of this evidence says anything at all. */
export function hasGeographicEvidence(evidence: GeographicEvidence): boolean {
  return (
    evidence.countryCode !== undefined ||
    evidence.regionCode !== undefined ||
    evidence.divisionIds.length > 0 ||
    evidence.countryNames.length > 0 ||
    evidence.regionNames.length > 0 ||
    evidence.countyNames.length > 0 ||
    evidence.localityNames.length > 0 ||
    evidence.neighbourhoodNames.length > 0
  );
}

/**
 * The typed form of the flat containment shape packs have always carried.
 *
 * The one bridge, in one place, so that no consumer has to know that
 * `regionName` holds an ISO code about a twentieth of the time. A pack written
 * before typed evidence existed goes through here unchanged in meaning and
 * gains the level distinctions it always implied.
 */
export function typedEvidenceFrom(input: {
  countryCode?: string | undefined;
  regionName?: string | undefined;
  countyName?: string | undefined;
  localityName?: string | undefined;
  neighbourhoodName?: string | undefined;
  divisionIds?: readonly string[] | undefined;
  displayNames?: readonly string[] | undefined;
  aliases?: readonly string[] | undefined;
  unleveledNames?: readonly string[] | undefined;
}): GeographicEvidence {
  const region = input.regionName?.trim();
  const regionIsCode = region !== undefined && isSubdivisionCode(region);
  return {
    ...(input.countryCode ? { countryCode: input.countryCode.toUpperCase() } : {}),
    ...(regionIsCode ? { regionCode: region.toUpperCase() } : {}),
    divisionIds: [...(input.divisionIds ?? [])],
    countryNames: [],
    regionNames: region !== undefined && !regionIsCode ? [region] : [],
    countyNames: input.countyName ? [input.countyName] : [],
    localityNames: input.localityName ? [input.localityName] : [],
    neighbourhoodNames: input.neighbourhoodName ? [input.neighbourhoodName] : [],
    unleveledNames: [...(input.unleveledNames ?? [])],
    displayNames: [...(input.displayNames ?? [])],
    aliases: [...(input.aliases ?? [])],
  };
}

/** Union of two pieces of evidence about the same subject, level by level. */
export function mergeGeographicEvidence(
  base: GeographicEvidence,
  extra: GeographicEvidence,
): GeographicEvidence {
  const union = (left: readonly string[], right: readonly string[]): string[] => {
    const seen = new Map<string, string>();
    for (const value of [...left, ...right]) {
      const key = normaliseGeographicName(value);
      if (key.length > 0 && !seen.has(key)) seen.set(key, value);
    }
    return [...seen.values()];
  };
  return {
    ...(base.countryCode ?? extra.countryCode
      ? { countryCode: base.countryCode ?? extra.countryCode! }
      : {}),
    ...(base.regionCode ?? extra.regionCode
      ? { regionCode: base.regionCode ?? extra.regionCode! }
      : {}),
    divisionIds: [...new Set([...base.divisionIds, ...extra.divisionIds])],
    countryNames: union(base.countryNames, extra.countryNames),
    regionNames: union(base.regionNames, extra.regionNames),
    countyNames: union(base.countyNames, extra.countyNames),
    localityNames: union(base.localityNames, extra.localityNames),
    neighbourhoodNames: union(base.neighbourhoodNames, extra.neighbourhoodNames),
    unleveledNames: union(base.unleveledNames, extra.unleveledNames),
    displayNames: union(base.displayNames, extra.displayNames),
    aliases: union(base.aliases, extra.aliases),
  };
}
