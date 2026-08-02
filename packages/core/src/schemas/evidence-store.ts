import { z } from 'zod';
import { httpUrlSchema, isoDateSchema } from './common';
import { factPathSchema, sourceAuthorityKindSchema } from './source-fact';

/**
 * THE SHARED EVIDENCE STORE, AS TYPES.
 *
 * Phase 9 left one nameable gap: a region pack was shared between trips, and the
 * *page it pointed at* was not. Every compilation re-searched, re-fetched and
 * re-extracted facts that are properties of a museum rather than of a traveller.
 *
 * This file is the shape of the fix, and its whole design is one distinction:
 *
 *   **A fact about a place is universal. A fact about a trip is not.**
 *
 * Everything in here is the first kind. There is no field on any of these types
 * that could hold a fit score, a selection, a date range the traveller chose, or
 * an itinerary position — and `architecture.test.ts` fails the build if one
 * appears, because a cache that quietly learned one traveller's preferences and
 * served them to another would be the worst bug this product could have.
 *
 * The layers are separate on purpose. One opaque `provider_cache` blob cannot
 * express "the page is unchanged but the extraction schema moved on", and that is
 * precisely the invalidation this phase has to be surgical about: changing a
 * prompt must not throw away a fetch, and changing a fetch must not throw away a
 * search.
 *
 *   discovery → source identity → document version → parse → extraction → claim
 *
 * Each arrow is a cache boundary. Each one can be invalidated without disturbing
 * the ones to its left.
 */

export const EVIDENCE_STORE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Content identity
// ---------------------------------------------------------------------------

/**
 * A content digest, algorithm-prefixed.
 *
 * The prefix is the migration boundary rather than decoration: a future
 * `blake3:` digest coexists with `sha256:` instead of colliding with it, and a
 * digest whose algorithm this build does not know is treated as **unusable**
 * rather than as non-matching — which is the difference between "re-read that
 * page" and "silently treat two different pages as the same one".
 */
export const contentDigestSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,16}:[0-9a-f]{32,128}$/, 'A digest must be "<algorithm>:<lowercase hex>"');
export type ContentDigest = z.infer<typeof contentDigestSchema>;

// ---------------------------------------------------------------------------
// Layer A — source discovery
// ---------------------------------------------------------------------------

/**
 * Why a search for a subject's official page came back with nothing.
 *
 * Six answers rather than one, because they want different retry behaviour and
 * because "nobody publishes this" and "the provider was down" are different
 * things to tell a traveller. A transient failure gets a short negative cache; a
 * genuine absence gets a long one.
 */
export const SOURCE_DISCOVERY_OUTCOMES = [
  'found',
  'no_source_found',
  'provider_unavailable',
  'budget_exhausted',
  'candidates_rejected',
  'result_invalid',
  'source_found_without_fact',
] as const;
export const sourceDiscoveryOutcomeSchema = z.enum(SOURCE_DISCOVERY_OUTCOMES);
export type SourceDiscoveryOutcome = z.infer<typeof sourceDiscoveryOutcomeSchema>;

/** Whether this outcome is worth remembering for long, or only for minutes. */
export function isTransientDiscoveryOutcome(outcome: SourceDiscoveryOutcome): boolean {
  return outcome === 'provider_unavailable' || outcome === 'budget_exhausted';
}

export const discoveredReferenceSchema = z.object({
  url: httpUrlSchema,
  title: z.string().min(1).max(300).optional(),
  expectedAuthority: sourceAuthorityKindSchema,
  /** `osm_tag`, `wikidata`, `search`. Where the *pointer* came from. */
  discoveredVia: z.string().min(1).max(40),
});
export type DiscoveredReference = z.infer<typeof discoveredReferenceSchema>;

export const sourceDiscoveryRecordSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  /** Hash of the normalised subject identity + wanted paths + provider version. */
  key: z.string().min(1),
  outcome: sourceDiscoveryOutcomeSchema,
  references: z.array(discoveredReferenceSchema).max(12).default([]),
  provider: z.string().min(1),
  providerVersion: z.string().min(1),
  discoveredAt: z.string().min(1),
  expiresAt: z.string().min(1),
  /** Billable searches this record cost when it was first made. */
  searches: z.number().int().min(0).default(0),
});
export type SourceDiscoveryRecord = z.infer<typeof sourceDiscoveryRecordSchema>;

// ---------------------------------------------------------------------------
// Layer B — canonical source identity
// ---------------------------------------------------------------------------

/**
 * How two source identities are related, when they are.
 *
 * `content_mirror` is the load-bearing one. The same bytes on two unrelated
 * domains is **one voice**, and recording it as a relationship rather than
 * merging the identities is what lets the resolver refuse to count a syndicated
 * copy as corroboration while still showing both places it appeared.
 */
export const SOURCE_RELATIONS = [
  'canonical_of',
  'alternate_language_of',
  'redirects_to',
  'content_mirror',
  'unrelated_identical_content',
] as const;
export const sourceRelationSchema = z.enum(SOURCE_RELATIONS);
export type SourceRelation = z.infer<typeof sourceRelationSchema>;

export const canonicalSourceSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  /** Stable id derived from the canonical URL. Never a random uuid. */
  id: z.string().min(1),
  /** Exactly what somebody handed us, minus credentials and secret-ish params. */
  submittedUrl: httpUrlSchema,
  /** Conservatively normalised. Query keys sorted, never dropped wholesale. */
  canonicalUrl: httpUrlSchema,
  /** Where we actually ended up, after redirects. */
  finalUrl: httpUrlSchema.optional(),
  redirectChain: z.array(httpUrlSchema).max(6).default([]),
  /** Scheme + host + port, lowercased and punycode-normalised. */
  origin: z.string().min(1),
  /** Registrable host, lowercased. Two pages here are one voice. */
  host: z.string().min(1),
  publisher: z.string().min(1),
  authority: sourceAuthorityKindSchema,
  /** What the page claims about itself. Recorded, never trusted for identity. */
  declaredCanonicalUrl: httpUrlSchema.optional(),
  /** Licence or terms metadata, where the source states any. */
  licenceId: z.string().min(1).optional(),
  /** Diagnostics a reviewer should see: mixed scripts, punycode, and so on. */
  identityWarnings: z.array(z.string().min(1).max(160)).max(6).default([]),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  relations: z
    .array(
      z.object({
        relation: sourceRelationSchema,
        otherSourceId: z.string().min(1),
        note: z.string().min(1).max(160).optional(),
      }),
    )
    .max(20)
    .default([]),
});
export type CanonicalSource = z.infer<typeof canonicalSourceSchema>;

// ---------------------------------------------------------------------------
// Layer C — retrieved document versions
// ---------------------------------------------------------------------------

/**
 * The validators a conditional request can be built from.
 *
 * `weak` matters: a weak ETag means *semantically equivalent*, not
 * byte-identical, so a 304 against one may not be read as "the bytes are the
 * same". It licenses "the publisher says nothing meaningful changed" and nothing
 * more.
 */
export const responseValidatorsSchema = z.object({
  etag: z.string().min(1).max(256).optional(),
  weak: z.boolean().default(false),
  lastModified: z.string().min(1).max(64).optional(),
  /** Verbatim `Cache-Control`, so a `no-store` can be honoured later. */
  cacheControl: z.string().min(1).max(256).optional(),
  /**
   * Verbatim `Vary`. A document whose `Vary` names a header we do not pin is
   * **not reusable** — reusing it would serve one language's page as another's.
   */
  vary: z.string().min(1).max(256).optional(),
});
export type ResponseValidators = z.infer<typeof responseValidatorsSchema>;

export const documentVersionSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  /** `${sourceId}@${contentDigest}`. Content-addressed, not sequential. */
  id: z.string().min(1),
  sourceId: z.string().min(1),
  contentDigest: contentDigestSchema,
  /** Normalised, never the raw response. See the research note on retention. */
  representation: z.object({
    text: z.string().max(24_000),
    structuredData: z.array(z.unknown()).max(40).default([]),
    /**
     * True when a ceiling stopped the read.
     *
     * Part of the digest envelope on purpose: a partially-read page is not the
     * same evidence as the whole one, and reusing an extraction taken from a
     * truncated document as though it covered the source is a defect the phase
     * brief names explicitly.
     */
    truncated: z.boolean().default(false),
    mimeType: z.string().min(1).max(80),
    bytes: z.number().int().min(0),
  }),
  status: z.number().int().min(100).max(599),
  validators: responseValidatorsSchema,
  /**
   * When the *content* was first observed in this form.
   *
   * Distinct from `lastCheckedAt` and this is the whole point: a 304 advances
   * the check, never the observation. Fact freshness reads this one, so a page
   * that has not changed since 2024 cannot be made current by revalidating it
   * every morning.
   */
  contentObservedAt: z.string().min(1),
  lastCheckedAt: z.string().min(1),
  /** The date the page itself states it was published or updated. */
  publishedAt: isoDateSchema.optional(),
  robotsAllowed: z.boolean(),
  /**
   * When the site's robots policy was last read — its own clock, deliberately.
   *
   * A robots verdict is a fact about *permission*, and permission changes
   * independently of content. A document reused for four months on the strength
   * of a `contentObservedAt` from January would be carrying a January answer to
   * "may we read this?", which is not a question January can answer.
   *
   * Optional because a document stored before robots had a clock is still a
   * valid document; absent is treated as "unknown, therefore due a check".
   */
  robotsCheckedAt: z.string().min(1).optional(),
  /** Prompt-injection and safety observations made at retrieval time. */
  safetyDiagnostics: z.array(z.string().min(1).max(160)).max(8).default([]),
  /** So a parser change can invalidate parses without re-fetching. */
  retrievalVersion: z.string().min(1),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;

/** One attempt to read a source. A 304 is an observation, not a new version. */
export const RETRIEVAL_OBSERVATION_KINDS = [
  'fetched',
  'not_modified',
  'failed',
  'refused_unsafe',
  'blocked_by_robots',
] as const;
export const retrievalObservationKindSchema = z.enum(RETRIEVAL_OBSERVATION_KINDS);
export type RetrievalObservationKind = z.infer<typeof retrievalObservationKindSchema>;

export const retrievalObservationSchema = z.object({
  sourceId: z.string().min(1),
  /** Absent when nothing readable came back. */
  documentVersionId: z.string().min(1).optional(),
  kind: retrievalObservationKindSchema,
  status: z.number().int().min(0).max(599),
  observedAt: z.string().min(1),
  bytes: z.number().int().min(0).default(0),
  /** Bytes a conditional request avoided transferring. */
  bytesAvoided: z.number().int().min(0).default(0),
  detail: z.string().min(1).max(200).optional(),
});
export type RetrievalObservation = z.infer<typeof retrievalObservationSchema>;

// ---------------------------------------------------------------------------
// Layer D/E — parsed structures and model extraction
// ---------------------------------------------------------------------------

/**
 * What produced a piece of structured evidence.
 *
 * The distinction earns its place at the cache layer, not just in the audit: a
 * deterministic parse is free and reproducible, so it is invalidated only by a
 * parser version bump, while a model extraction costs money and is invalidated by
 * four more things.
 */
export const EVIDENCE_ORIGINS = ['deterministic_parse', 'model_extraction'] as const;
export const evidenceOriginSchema = z.enum(EVIDENCE_ORIGINS);
export type EvidenceOrigin = z.infer<typeof evidenceOriginSchema>;

export const parsedDocumentSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  documentVersionId: z.string().min(1),
  contentDigest: contentDigestSchema,
  parserVersion: z.string().min(1),
  /** Fact paths the deterministic parsers fully answered. */
  resolvedPaths: z.array(factPathSchema).default([]),
  /** Validated payloads, keyed by fact path. Anything invalid was dropped. */
  payloads: z.record(z.string(), z.unknown()).default({}),
  /** Where each payload came from, e.g. `schema.org/openingHoursSpecification`. */
  fields: z.record(z.string(), z.string().min(1).max(120)).default({}),
  declaredCanonicalUrl: httpUrlSchema.optional(),
  publishedAt: isoDateSchema.optional(),
  parsedAt: z.string().min(1),
});
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;

/**
 * A model extraction, keyed on everything that could change its answer.
 *
 * The requested paths are in the key, and leaving them out would be a real
 * collision: the same page asked about opening hours and asked about admission
 * price is not the same call.
 */
export const extractionInputsSchema = z.object({
  operation: z.string().min(1),
  contentDigests: z.array(contentDigestSchema).min(1).max(12),
  schemaVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
  parserVersion: z.string().min(1),
  /** Sorted, so two orderings of one request share a cache entry. */
  wantedPaths: z.array(factPathSchema).default([]),
  /** Who the extraction is about, so one page serving six trails stays six answers. */
  subjectKey: z.string().min(1).optional(),
});
export type ExtractionInputs = z.infer<typeof extractionInputsSchema>;

export const EXTRACTION_STATUSES = ['succeeded', 'invalid_output', 'provider_error'] as const;
export const extractionStatusSchema = z.enum(EXTRACTION_STATUSES);
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;

export const extractionVersionSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  key: z.string().min(1),
  inputs: extractionInputsSchema,
  status: extractionStatusSchema,
  /**
   * The validated structured output. Present only on success.
   *
   * A failed extraction is recorded — so a retry storm is visible and bounded —
   * and is **never** served as though it were an answer. Failing closed is the
   * rule: an invalid output must not poison the next valid attempt, so a failure
   * row is superseded by a later success rather than blocking it.
   */
  output: z.unknown().optional(),
  /**
   * What the call cost, and whether this row can honestly claim it.
   *
   * One model call routinely covers several pages, so per-subject figures are an
   * apportionment rather than a measurement — and presenting an apportionment as
   * a measurement is exactly the kind of quiet inaccuracy this codebase refuses
   * elsewhere. So the row carries the **batch's** exact totals, the number of
   * documents that batch covered, and a flag saying which of the two it is.
   *
   * Operation-level cost stays exact: the ledger sums the batch once, from the
   * provider's own usage, and never from these rows.
   */
  tokens: z
    .object({
      input: z.number().int().min(0).default(0),
      output: z.number().int().min(0).default(0),
      cacheRead: z.number().int().min(0).default(0),
      cacheWrite: z.number().int().min(0).default(0),
      /**
       * `measured` — this row is the whole call. `batch_total` — these are the
       * batch's exact numbers and this row is one of `batchDocuments` covered by
       * it. Never a per-row figure that looks measured and is not.
       */
      basis: z.enum(['measured', 'batch_total']).default('measured'),
      batchDocuments: z.number().int().min(1).default(1),
    })
    .prefault({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      basis: 'measured' as const,
      batchDocuments: 1,
    }),
  attempts: z.number().int().min(1).default(1),
  diagnostics: z.array(z.string().min(1).max(200)).max(6).default([]),
  createdAt: z.string().min(1),
});
export type ExtractionVersion = z.infer<typeof extractionVersionSchema>;

// ---------------------------------------------------------------------------
// Layer F — claims
// ---------------------------------------------------------------------------

/**
 * A claim: one source saying one thing about one subject, kept forever.
 *
 * Distinct from a `SourceFact` in one respect that matters: a `SourceFact` is
 * built for *one compilation* and carries that compilation's framing, while a
 * claim is the durable, traveller-independent record the compilation is built
 * from. Superseding is by reference rather than by overwrite, so history stays
 * reconstructible.
 */
export const evidenceClaimRecordSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  id: z.string().min(1),
  /** Stable identity of the thing the claim is about. Never a trip-local id. */
  subjectKey: z.string().min(1),
  factPath: factPathSchema,
  statement: z.string().min(1).max(400),
  /** Validated payload for paths that have one. */
  payload: z.unknown().optional(),
  origin: evidenceOriginSchema,
  sourceId: z.string().min(1),
  documentVersionId: z.string().min(1),
  contentDigest: contentDigestSchema,
  /** Absent for a deterministic parse — nothing was extracted. */
  extractionKey: z.string().min(1).optional(),
  authorityKind: sourceAuthorityKindSchema,
  authorityName: z.string().min(1),
  /**
   * The page the claim was read off, and the host it was read from.
   *
   * Both are needed to rebuild a defensible fact: the schema refuses a
   * directly-stated fact that cannot name its page, and independence is counted
   * by host so that two pages on one domain stay one voice.
   */
  sourceUrl: httpUrlSchema.optional(),
  sourceDomain: z.string().min(1).max(253).optional(),
  /** What the excerpt is kept under, so attribution travels with the claim. */
  licenceId: z.string().min(1).optional(),
  evidenceExcerpt: z.string().min(1).max(400).optional(),
  evidenceField: z.string().min(1).max(120).optional(),
  derivation: z.enum(['directly_stated', 'inferred_from_source', 'model_inference']),
  /**
   * When the *content* this came from was observed — the content clock, not the
   * check clock.
   *
   * A fact rebuilt from a claim inherits this as its `retrievedAt`, which is the
   * whole reason a claim reused six months later is honestly six months old
   * rather than freshly stamped.
   */
  contentObservedAt: z.string().min(1),
  /** Prompt/schema/parser that produced it, so a contract change is traceable. */
  promptVersion: z.string().min(1).optional(),
  extractionSchemaVersion: z.string().min(1).optional(),
  parserVersion: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  /** When the claim applies, where the source dates itself. */
  appliesFrom: isoDateSchema.optional(),
  appliesTo: isoDateSchema.optional(),
  /** Where a source states its own validity window, it wins over shelf life. */
  validFrom: isoDateSchema.optional(),
  validThrough: isoDateSchema.optional(),
  /** Where the claim applies, when it is narrower than the subject. */
  geographicScope: z.string().min(1).max(120).optional(),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  /** The claim this one replaced, if any. History is kept, never rewritten. */
  supersedesClaimId: z.string().min(1).optional(),
  /**
   * True once a later claim about the same question replaced this one.
   *
   * Set on the old row rather than deleting it: an artifact compiled last month
   * quotes a fact id, and that fact has to stay explicable. Superseded claims are
   * never resolved against and are the first thing a sweep may remove once
   * nothing points at them.
   */
  superseded: z.boolean().default(false),
});
export type EvidenceClaimRecord = z.infer<typeof evidenceClaimRecordSchema>;

/**
 * THAT WE ASKED, AND WHAT ASKING YIELDED.
 *
 * The piece without which shared claims save nothing. Coverage cannot mean
 * "every question answered", because sources genuinely do not publish
 * everything — most museums never state a typical visit length, and waiting for
 * one to would mean re-buying the same fruitless search on every compilation
 * forever.
 *
 * What is actually true is narrower and more useful: *we asked this subject
 * these questions under this contract on this date, and this is what there was
 * to get.* Asking again next week will not make a museum start publishing its
 * admission price. So an attempt is remembered, and a subject with a fresh
 * attempt is not researched again — whatever fraction of its questions came
 * back answered.
 *
 * A record of an action, never of a fact. It cannot make anything more certain,
 * and nothing downstream reads it as evidence.
 */
export const researchAttemptSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  subjectKey: z.string().min(1),
  /** Prompt + schema + model + parser, so a contract change re-asks. */
  contract: z.string().min(1),
  /** Sorted. Asking a different set of questions is a different attempt. */
  wantedPaths: z.array(factPathSchema).default([]),
  attemptedAt: z.string().min(1),
  /** How many questions the attempt actually answered. Diagnostic, not a gate. */
  claimsFound: z.number().int().min(0).default(0),
});
export type ResearchAttempt = z.infer<typeof researchAttemptSchema>;

/** The identity of one attempt: this subject, this contract, these questions. */
export function researchAttemptKey(input: {
  subjectKey: string;
  contract: string;
  wantedPaths: readonly string[];
}): string {
  return `${input.subjectKey}::${input.contract}::${[...input.wantedPaths].sort().join(',')}`;
}

// ---------------------------------------------------------------------------
// Layer G — freshness
// ---------------------------------------------------------------------------

/**
 * How fast a kind of fact goes off, above the per-path shelf life.
 *
 * The classes exist so policy can be *reasoned about* rather than only
 * tabulated: "a closure is fast-changing and therefore never enforceable past its
 * window" is a rule, where a table of numbers is a list.
 */
export const FACT_CHANGE_CLASSES = ['fast', 'moderate', 'slow'] as const;
export const factChangeClassSchema = z.enum(FACT_CHANGE_CLASSES);
export type FactChangeClass = z.infer<typeof factChangeClassSchema>;

export const FACT_FRESHNESS_STATES = [
  /** Inside its window and applicable to the trip. Enforceable. */
  'fresh',
  /** Inside its window, but old enough to be worth rechecking before travel. */
  'due_recheck',
  /** Past its own window. Shown with a caution, never enforced. */
  'stale',
  /** The source stated a validity window that ended before the trip. */
  'expired',
  /** The source stated a window that begins after the trip ends. */
  'not_yet_applicable',
] as const;
export const factFreshnessStateSchema = z.enum(FACT_FRESHNESS_STATES);
export type FactFreshnessState = z.infer<typeof factFreshnessStateSchema>;

export const FACT_FRESHNESS_LABELS: Record<FactFreshnessState, string> = {
  fresh: 'Checked recently',
  due_recheck: 'Worth a recheck before you go',
  stale: 'Checked a while ago',
  expired: 'No longer applies by the time you travel',
  not_yet_applicable: 'Starts after your trip ends',
};

// ---------------------------------------------------------------------------
// The incremental work plan
// ---------------------------------------------------------------------------

/**
 * What a compilation decided to do about each stage, before it did any of it.
 *
 * Computed up front and persisted, so "why was this run cheap" has an answer that
 * is a record rather than a reconstruction. `blocked` is separate from
 * `unavailable` on purpose: one means a precondition failed, the other means
 * nothing could answer.
 */
export const WORK_PLAN_DECISIONS = [
  'reusable',
  'revalidate',
  'recompute',
  'unavailable',
  'blocked',
] as const;
export const workPlanDecisionSchema = z.enum(WORK_PLAN_DECISIONS);
export type WorkPlanDecision = z.infer<typeof workPlanDecisionSchema>;

export const WORK_PLAN_DECISION_LABELS: Record<WorkPlanDecision, string> = {
  reusable: 'Reused',
  revalidate: 'Rechecked',
  recompute: 'Rebuilt',
  unavailable: 'Nothing to reuse',
  blocked: 'Could not run',
};

export const workPlanEntrySchema = z.object({
  /** The compilation stage, or a named sub-step inside one. */
  step: z.string().min(1).max(60),
  decision: workPlanDecisionSchema,
  /** One sentence naming the actual reason. Never a generic string. */
  reason: z.string().min(1).max(200),
  /** How many items this covers, where it covers items. */
  items: z.number().int().min(0).optional(),
});
export type WorkPlanEntry = z.infer<typeof workPlanEntrySchema>;

export const compilationWorkPlanSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  /**
   * One entry per stage, recorded at the moment that stage decided.
   *
   * Deliberately not a *forecast* plus a separate list of outcomes. Each
   * decision is taken before the work it governs — reuse or fetch, reuse or
   * extract — and written with the counts that justified it, so a forecast and
   * an outcome would be the same list twice and the second copy would be the
   * one that quietly went out of date.
   */
  entries: z.array(workPlanEntrySchema).default([]),
  computedAt: z.string().min(1),
});
export type CompilationWorkPlan = z.infer<typeof compilationWorkPlanSchema>;

/**
 * What the evidence store saved this compilation, in operations rather than in
 * a percentage.
 *
 * Every number here is counted at the point the work was (or was not) done. None
 * of them is derived from another, because a derived saving is a story rather
 * than a measurement.
 */
export const evidenceReuseReportSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_STORE_VERSION),
  discoveryHits: z.number().int().min(0).default(0),
  discoveryMisses: z.number().int().min(0).default(0),
  documentsReused: z.number().int().min(0).default(0),
  documentsRevalidated: z.number().int().min(0).default(0),
  documentsFetched: z.number().int().min(0).default(0),
  bytesTransferred: z.number().int().min(0).default(0),
  bytesAvoided: z.number().int().min(0).default(0),
  parsesReused: z.number().int().min(0).default(0),
  extractionsReused: z.number().int().min(0).default(0),
  extractionsPerformed: z.number().int().min(0).default(0),
  modelCallsAvoided: z.number().int().min(0).default(0),
  claimsReused: z.number().int().min(0).default(0),
  /** Operations another compilation was already doing, that this one adopted. */
  operationsAdopted: z.number().int().min(0).default(0),
  /** Evidence used despite being past its window. Always visible, never hidden. */
  staleEvidenceUsed: z.number().int().min(0).default(0),
});
export type EvidenceReuseReport = z.infer<typeof evidenceReuseReportSchema>;

export function emptyReuseReport(): EvidenceReuseReport {
  return evidenceReuseReportSchema.parse({ schemaVersion: EVIDENCE_STORE_VERSION });
}

/**
 * The share of eligible work that was reused.
 *
 * Eligible means "an operation the store could plausibly have avoided" —
 * retrievals and extractions. Discovery is included because a search is the most
 * expensive counter in the system. Returns null rather than 1 when there was no
 * eligible work at all, because "100% reused, of nothing" is a lie.
 */
export function reuseShare(report: EvidenceReuseReport): number | null {
  const reused =
    report.discoveryHits +
    report.documentsReused +
    report.documentsRevalidated +
    report.extractionsReused;
  const total =
    reused + report.discoveryMisses + report.documentsFetched + report.extractionsPerformed;
  if (total === 0) return null;
  return reused / total;
}
