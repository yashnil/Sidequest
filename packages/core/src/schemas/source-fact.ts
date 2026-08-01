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
  /** A government or official tourism board that is not the operator. */
  'official_tourism',
  /** A structured API: Places, a routing service. */
  'structured_provider',
  /** A reputable third party. */
  'secondary',
  /** Nobody said this; a model concluded it. */
  'model_inference',
] as const;
export const sourceAuthorityKindSchema = z.enum(SOURCE_AUTHORITY_KINDS);
export type SourceAuthorityKind = z.infer<typeof sourceAuthorityKindSchema>;

const AUTHORITY_RANK: Record<SourceAuthorityKind, number> = {
  managing_authority: 0,
  operator: 1,
  official_tourism: 2,
  structured_provider: 3,
  secondary: 4,
  model_inference: 5,
};

/** Lower is more authoritative. */
export function sourceAuthorityRank(kind: SourceAuthorityKind): number {
  return AUTHORITY_RANK[kind];
}

export function isOfficialAuthority(kind: SourceAuthorityKind): boolean {
  return kind === 'managing_authority' || kind === 'operator' || kind === 'official_tourism';
}

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

    authorityKind: sourceAuthorityKindSchema,
    /** The publisher's name: "Inyo National Forest", "Google Places". */
    authorityName: z.string().min(1),
    sourceUrl: httpUrlSchema.optional(),
    sourceTitle: z.string().min(1).optional(),

    retrievedAt: z.string().min(1),
    verifiedAt: z.string().min(1).optional(),

    /**
     * The words the claim came from, capped hard.
     *
     * Kept because a fact with no quotable basis cannot be checked; capped
     * because storing whole pages would be both a licensing problem and a way to
     * carry an injection payload around in the database.
     */
    evidenceExcerpt: z.string().min(1).max(MAX_EVIDENCE_EXCERPT_CHARS).optional(),
    /** For structured providers: which field, e.g. `regularOpeningHours`. */
    evidenceField: z.string().min(1).optional(),

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
    // Most recently retrieved wins the last tie, so a re-read beats a stale copy.
    if (a.retrievedAt !== b.retrievedAt) return a.retrievedAt < b.retrievedAt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
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
