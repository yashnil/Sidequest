import { z } from 'zod';
import { httpUrlSchema, isoDateSchema } from './common';
import { sourceVolatilitySchema } from './provenance';

/**
 * One sourced claim about the world, with everything needed to defend it.
 *
 * `SourceProvenance` in `provenance.ts` answers "where did this authored fixture
 * come from". This answers a harder question: a fact that was *researched at
 * runtime*, possibly by a model reading a page, has to carry enough with it that
 * a human can check the model's work and that the system can tell the difference
 * between what a page said and what a model concluded from it.
 *
 * The two do not merge. A fixture fact is written once by a person who read the
 * page; a compiled fact is produced by a pipeline and must be auditable as one.
 */

export const SOURCE_FACT_KINDS = [
  'operating_hours',
  'seasonal_access',
  'permit_or_reservation',
  'closure',
  'transport_service',
  'parking',
  'minimum_duration',
  'fee',
  'route_condition',
  'general',
] as const;
export const sourceFactKindSchema = z.enum(SOURCE_FACT_KINDS);
export type SourceFactKind = z.infer<typeof sourceFactKindSchema>;

/**
 * Who is speaking, in the order their word is worth taking.
 *
 * `sourceAuthorityRank` is the tie-break when two sources disagree, and it is a
 * total order on purpose: "prefer the more official one" has to be a decision a
 * program can make without a model's help.
 */
export const SOURCE_AUTHORITY_KINDS = [
  /** The agency that runs the thing: a park service, a transit authority. */
  'managing_authority',
  /** The business itself. */
  'operator',
  /** A ministry, a municipality, a national advisory. Not the operator. */
  'government',
  /** A transit, ferry or shuttle operator, speaking about its own service. */
  'official_transit',
  /** An official tourism organisation that is not the operator. */
  'official_tourism',
  /**
   * An open structured database: Wikidata, OpenStreetMap.
   *
   * Ranked below every official voice and above every commercial API, because
   * it is checkable, licence-clean and correctable upstream — but it is a
   * volunteer record of what an operator says, not the operator.
   */
  'open_structured_database',
  /** A structured API: Places, a routing service. */
  'structured_provider',
  /** A reputable third party with editorial standards. */
  'authoritative_secondary',
  /** A reputable third party. Retained for fixtures written before the split. */
  'secondary',
  /** Community-mapped geodata that is not one of the databases above. */
  'community_geographic',
  /** Anything else that published a sentence. */
  'unverified_secondary',
  /** Nobody said this; a model concluded it. */
  'model_inference',
] as const;
export const sourceAuthorityKindSchema = z.enum(SOURCE_AUTHORITY_KINDS);
export type SourceAuthorityKind = z.infer<typeof sourceAuthorityKindSchema>;

const AUTHORITY_RANK: Record<SourceAuthorityKind, number> = {
  managing_authority: 0,
  operator: 1,
  government: 2,
  official_transit: 3,
  official_tourism: 4,
  open_structured_database: 5,
  structured_provider: 6,
  authoritative_secondary: 7,
  secondary: 8,
  community_geographic: 9,
  unverified_secondary: 10,
  model_inference: 11,
};

/** Lower is more authoritative. */
export function sourceAuthorityRank(kind: SourceAuthorityKind): number {
  return AUTHORITY_RANK[kind];
}

/**
 * Whether this voice speaks for the thing, or for the state that regulates it.
 *
 * `open_structured_database` is deliberately **not** official. Wikidata may
 * carry a museum's opening hours and it is still not the museum; treating it as
 * official is how a five-year-old volunteer edit becomes a verified fact.
 */
export function isOfficialAuthority(kind: SourceAuthorityKind): boolean {
  return (
    kind === 'managing_authority' ||
    kind === 'operator' ||
    kind === 'government' ||
    kind === 'official_transit' ||
    kind === 'official_tourism'
  );
}

/**
 * WHAT A FACT IS ABOUT, as a value rather than as prose.
 *
 * Two sources "disagree" only when they answer the *same question* about the
 * same subject. Without a machine-readable question, a resolver has to compare
 * sentences — and "open 09:00–17:00" versus "last entry 16:30" are not a
 * conflict, they are two facts a naive string comparison would fight over.
 *
 * So every claim names its path, conflicts are grouped by
 * `(subjectId, factPath)`, and a fact with no path is evidence a human can read
 * rather than something the resolver will act on.
 */
export const FACT_PATHS = [
  'identity.officialSite',
  'identity.bookingUrl',
  'hours.weekly',
  'hours.seasonal',
  'hours.lastAdmission',
  'hours.closure',
  'access.method',
  'access.permit',
  'booking.required',
  'booking.timedEntry',
  'booking.leadTime',
  'cost.admission',
  'cost.parking',
  'cost.transport',
  'duration.typical',
  'safety.caution',
  'safety.requirement',
  'food.hours',
  'food.price',
  'food.dietary',
  'food.reservation',
] as const;
export const factPathSchema = z.enum(FACT_PATHS);
export type FactPath = z.infer<typeof factPathSchema>;

export const FACT_PATH_LABELS: Record<FactPath, string> = {
  'identity.officialSite': 'Official page',
  'identity.bookingUrl': 'Where to book',
  'hours.weekly': 'Opening hours',
  'hours.seasonal': 'Season',
  'hours.lastAdmission': 'Last admission',
  'hours.closure': 'Closure',
  'access.method': 'Getting there',
  'access.permit': 'Permit',
  'booking.required': 'Booking',
  'booking.timedEntry': 'Timed entry',
  'booking.leadTime': 'How far ahead to book',
  'cost.admission': 'Admission',
  'cost.parking': 'Parking',
  'cost.transport': 'Transport fare',
  'duration.typical': 'How long to allow',
  'safety.caution': 'Caution',
  'safety.requirement': 'What to bring',
  'food.hours': 'Serving hours',
  'food.price': 'Prices',
  'food.dietary': 'Dietary options',
  'food.reservation': 'Reservations',
};

/**
 * How a claim reached us, and whether it can be re-read.
 *
 * A fact whose page 404s today is not the same as a fact nobody looked for. The
 * first is stale evidence with a broken link; the second is silence.
 */
export const RETRIEVAL_STATUSES = [
  'fetched',
  'structured_data',
  'provider_field',
  'fetch_failed',
  'blocked_by_robots',
  'rejected_unsafe',
] as const;
export const retrievalStatusSchema = z.enum(RETRIEVAL_STATUSES);
export type RetrievalStatus = z.infer<typeof retrievalStatusSchema>;

/**
 * How the claim got from the source to here.
 *
 * The distinction that matters most in the whole file. A page that says "open
 * 9-5 daily" directly states its hours. A page that says "we are closed on
 * public holidays" plus a holiday calendar *implies* a closure on 25 December,
 * and a model that concludes "probably closed in winter" from photographs has
 * inferred something nobody wrote down. Only the first may be presented as a
 * fact without qualification.
 */
export const FACT_DERIVATIONS = ['directly_stated', 'inferred_from_source', 'model_inference'] as const;
export const factDerivationSchema = z.enum(FACT_DERIVATIONS);
export type FactDerivation = z.infer<typeof factDerivationSchema>;

/** The longest excerpt we will keep. Enough to justify a fact, not a copy of the page. */
export const MAX_EVIDENCE_EXCERPT_CHARS = 400;

export const sourceFactSchema = z
  .object({
    id: z.string().min(1),
    /** The place, service or region this is about. */
    subjectId: z.string().min(1),
    kind: sourceFactKindSchema,
    /** The claim, in one sentence, as it will be shown. */
    statement: z.string().min(1).max(400),

    /**
     * Which question this answers. Absent means "reads as context", and the
     * resolver will not act on it — see `FACT_PATHS`.
     */
    factPath: factPathSchema.optional(),

    authorityKind: sourceAuthorityKindSchema,
    /** The publisher's name: a park service, a transit authority, a database. */
    authorityName: z.string().min(1),
    sourceUrl: httpUrlSchema.optional(),
    sourceTitle: z.string().min(1).optional(),
    /**
     * The registrable host the claim came from, lowercased.
     *
     * Load-bearing for independence: two pages on one domain are one voice, and
     * counting them as two is how a single press release becomes "corroborated
     * by multiple sources".
     */
    sourceDomain: z.string().min(1).optional(),
    /** Which licence the excerpt is kept under, where one is known. */
    licenceId: z.string().min(1).optional(),

    retrievedAt: z.string().min(1),
    verifiedAt: z.string().min(1).optional(),
    /** When the source itself says it was published or last updated. */
    publishedAt: isoDateSchema.optional(),
    retrievalStatus: retrievalStatusSchema.optional(),

    /**
     * The words the claim came from, capped hard.
     *
     * Kept because a fact with no quotable basis cannot be checked; capped
     * because storing whole pages would be both a licensing problem and a way to
     * carry an injection payload around in the database.
     */
    evidenceExcerpt: z.string().min(1).max(MAX_EVIDENCE_EXCERPT_CHARS).optional(),
    /** For structured providers: which field, e.g. `openingHoursSpecification`. */
    evidenceField: z.string().min(1).optional(),
    /**
     * SHA-256 of the extracted page text this came from.
     *
     * Two facts sharing a hash came from the same bytes — a mirror, a syndicated
     * copy, the same page fetched twice — and are one voice however many domains
     * they arrived on.
     */
    contentHash: z.string().min(1).optional(),

    /** Which prompt and schema produced this, where a model was involved. */
    extractionPromptVersion: z.string().min(1).optional(),
    extractionSchemaVersion: z.string().min(1).optional(),
    /** The model that did the extracting. Never an authority — an attribution. */
    modelId: z.string().min(1).optional(),

    derivation: factDerivationSchema,
    volatility: sourceVolatilitySchema,
    /** How long this stays worth believing. Absent for `stable` facts. */
    shelfLifeDays: z.number().int().min(1).max(3650).optional(),
    /** When the claim applies, where it is dated. */
    appliesFrom: isoDateSchema.optional(),
    appliesTo: isoDateSchema.optional(),

    recheckRequired: z.boolean(),
    recheckNote: z.string().min(1).optional(),
    /**
     * Facts that answer the same question about the same subject. Two facts in
     * one group disagree by construction, and both are kept.
     */
    conflictGroup: z.string().min(1).optional(),
  })
  .refine((value) => value.derivation !== 'directly_stated' || value.sourceUrl !== undefined, {
    message: 'A directly-stated fact must name the page it was stated on',
    path: ['sourceUrl'],
  })
  .refine((value) => !value.recheckRequired || value.recheckNote !== undefined, {
    message: 'A fact flagged for recheck must say what to recheck',
    path: ['recheckNote'],
  })
  .refine(
    (value) => value.authorityKind !== 'model_inference' || value.derivation === 'model_inference',
    { message: 'A model-authored fact must be marked as model inference', path: ['derivation'] },
  );
export type SourceFact = z.infer<typeof sourceFactSchema>;

/** A page we actually fetched. Kept for audit; the body is deliberately not. */
export const retrievedPageSchema = z.object({
  url: httpUrlSchema,
  title: z.string().min(1).optional(),
  retrievedAt: z.string().min(1),
  /** Bytes read after limits were applied, so an audit can spot truncation. */
  contentBytes: z.number().int().min(0),
  /** SHA-256 of the extracted text. Lets a later run notice the page changed. */
  contentHash: z.string().min(1).optional(),
  /** Whether the page's robots policy allowed this. Never assumed. */
  robotsAllowed: z.boolean(),
});
export type RetrievedPage = z.infer<typeof retrievedPageSchema>;

export const sourceManifestSchema = z.object({
  facts: z.array(sourceFactSchema).default([]),
  pages: z.array(retrievedPageSchema).default([]),
  /** Every provider consulted, whether or not it answered. */
  providers: z
    .array(
      z.object({
        name: z.string().min(1),
        /** e.g. `places:v1`, `routes:v2`, `claude-opus-5`. */
        version: z.string().min(1),
        calls: z.number().int().min(0),
        failures: z.number().int().min(0),
      }),
    )
    .default([]),
  /** Attribution strings that must be rendered wherever this data is shown. */
  attributions: z.array(z.string().min(1)).default([]),
});
export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/**
 * WHAT WE ARE ENTITLED TO SAY ABOUT A FACT.
 *
 * Eight states rather than a number, because a percentage cannot express the
 * difference between "two independent official sources agree" and "one page
 * said it eighteen months ago" — and those two want different words on a card.
 *
 * Every one of these is **computed** in `evidence/resolve.ts` from source class,
 * corroboration, freshness, specificity and conflict. Nothing may set one
 * directly, and no model is asked for one.
 */
export const FACT_VERIFICATION_STATES = [
  /** Official, directly stated, in date. Act on it. */
  'verified',
  /** Two genuinely independent sources agree. Act on it. */
  'corroborated',
  /** One source, believable, uncorroborated. Act on it and say so. */
  'single_source',
  /** Derived from what a source said rather than stated by it. */
  'inferred',
  /** Sources disagree. Both kept; the planner treats the subject as uncertain. */
  'conflicted',
  /** Past its own shelf life. Shown, flagged, not enforced. */
  'stale',
  /** Nobody was asked, or nobody answered. */
  'unknown',
  /** We looked and the source could not be read: 404, robots, unsafe. */
  'unavailable',
] as const;
export const factVerificationStateSchema = z.enum(FACT_VERIFICATION_STATES);
export type FactVerificationState = z.infer<typeof factVerificationStateSchema>;

export const FACT_VERIFICATION_LABELS: Record<FactVerificationState, string> = {
  verified: 'Verified',
  corroborated: 'Two sources agree',
  single_source: 'One source',
  inferred: 'Worked out',
  conflicted: 'Sources disagree',
  stale: 'Checked a while ago',
  unknown: 'Unknown',
  unavailable: 'Could not check',
};

/** Whether a planner may treat this as a constraint rather than as a caution. */
export function isEnforceable(state: FactVerificationState): boolean {
  return state === 'verified' || state === 'corroborated' || state === 'single_source';
}

export const resolvedFactSchema = z.object({
  subjectId: z.string().min(1),
  factPath: factPathSchema,
  state: factVerificationStateSchema,
  /** The fact to act on. Absent when the state is `unknown` or `unavailable`. */
  acceptedFactId: z.string().min(1).optional(),
  /** Every fact considered, accepted first. Conflicts are kept, never averaged. */
  factIds: z.array(z.string().min(1)).default([]),
  /** Distinct voices behind the accepted answer. 2+ is what earns corroboration. */
  independentSources: z.number().int().min(0),
  /** One sentence naming why this state and not another. Rendered as-is. */
  rationale: z.string().min(1),
});
export type ResolvedFact = z.infer<typeof resolvedFactSchema>;

/**
 * The key two facts must differ on to count as two voices.
 *
 * Domain first, because a syndicated copy on the same host is one voice however
 * many URLs it has; then the content hash, because the same bytes on two hosts
 * is also one voice. Falling back to the fact id means "we cannot tell", and
 * cannot-tell must not silently earn corroboration — so it yields a key unique
 * to that fact, which groups with nothing.
 */
export function factIndependenceKey(fact: SourceFact): string {
  if (fact.contentHash) return `hash:${fact.contentHash}`;
  if (fact.sourceDomain) return `domain:${fact.sourceDomain.toLowerCase()}`;
  if (fact.sourceUrl) {
    try {
      return `domain:${new URL(fact.sourceUrl).hostname.toLowerCase()}`;
    } catch {
      /* fall through to the unique key */
    }
  }
  return `fact:${fact.id}`;
}

/**
 * Facts in a conflict group, ranked. The head is the one to act on; the rest are
 * kept and shown, because "these two sources disagree" is a thing a traveller
 * needs told rather than a thing to average away.
 */
export function rankConflictingFacts(facts: readonly SourceFact[]): SourceFact[] {
  return [...facts].sort((a, b) => {
    const byAuthority = sourceAuthorityRank(a.authorityKind) - sourceAuthorityRank(b.authorityKind);
    if (byAuthority !== 0) return byAuthority;
    const byDerivation = derivationRank(a.derivation) - derivationRank(b.derivation);
    if (byDerivation !== 0) return byDerivation;
    /**
     * Structured before prose, at equal authority.
     *
     * An `openingHoursSpecification` block is a machine-readable statement by
     * the same publisher whose paragraph we would otherwise be reading; a model
     * cannot misread it, and that is the whole of the difference.
     */
    const bySpecificity = specificityRank(a) - specificityRank(b);
    if (bySpecificity !== 0) return bySpecificity;
    // A dated page beats an undated one, and a newer date beats an older one.
    if (a.publishedAt !== b.publishedAt) {
      if (a.publishedAt === undefined) return 1;
      if (b.publishedAt === undefined) return -1;
      return a.publishedAt < b.publishedAt ? 1 : -1;
    }
    // Most recently retrieved wins the last tie, so a re-read beats a stale copy.
    if (a.retrievedAt !== b.retrievedAt) return a.retrievedAt < b.retrievedAt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

function specificityRank(fact: SourceFact): number {
  if (fact.retrievalStatus === 'structured_data' || fact.evidenceField !== undefined) return 0;
  if (fact.evidenceExcerpt !== undefined) return 1;
  return 2;
}

function derivationRank(derivation: FactDerivation): number {
  return derivation === 'directly_stated' ? 0 : derivation === 'inferred_from_source' ? 1 : 2;
}

/**
 * Whether a fact has aged out of its own shelf life.
 *
 * A fact with no shelf life never goes stale, which is correct only for `stable`
 * facts — the schema does not enforce that pairing because a `stable` fact with
 * an explicit shelf life is a legitimate way to say "recheck this annually
 * anyway".
 */
export function isFactStale(fact: SourceFact, now: Date): boolean {
  if (fact.shelfLifeDays === undefined) return false;
  const read = Date.parse(fact.verifiedAt ?? fact.retrievedAt);
  if (Number.isNaN(read)) return true;
  return now.getTime() - read > fact.shelfLifeDays * 86_400_000;
}
