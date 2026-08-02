import {
  EVIDENCE_STORE_VERSION,
  canonicalizeUrl,
  claimIdFor,
  extractionContract,
  isContextIndependent,
  liveClaimsByPath,
  normalizeClaimValue,
  parseContract,
  researchAttemptKey,
  shelfLifeFor,
  sourceIdFor,
  supersededBy,
  type EvidenceClaimRecord,
  type FactPath,
  type ResearchAttempt,
  type SourceFact,
} from '@sidequest/core';
import { factKindFor, gateClaim, volatilityOf } from './enrich';
import type { ExtractedClaim, ResearchSubject, RetrievedDocument } from './providers';

/**
 * FROM ONE TRIP'S EXTRACTION TO EVIDENCE EVERYBODY CAN USE.
 *
 * Phase 10's first half made the *page* shared: two trips to one museum read it
 * once. This makes the *fact* shared, which is the half that actually removes
 * the model from a warm run — because a subject whose questions are already
 * answered by durable claims never reaches discovery, retrieval or extraction at
 * all.
 *
 * The direction of travel matters and is one-way:
 *
 *   ExtractedClaim (this trip)  →  EvidenceClaimRecord (everybody)
 *   EvidenceClaimRecord         →  SourceFact (this trip, these dates)
 *
 * Nothing traveller-shaped survives the first arrow. A claim knows what a museum
 * charges and does not know whether that suits anybody's budget; it knows a
 * closure's dates and does not know whether they overlap a trip. Both of those
 * are decided on the way back out, per trip, every time.
 */

/** Bumped when the shape of a stored claim changes in a way that matters. */
export const CLAIM_BUILDER_VERSION = 'claims/2026-08-02.1';

export interface ToClaimRecordsInput {
  claims: readonly ExtractedClaim[];
  documents: readonly RetrievedDocument[];
  /** Trip-local subject id → durable subject key. The boundary, in one map. */
  subjectKeys: ReadonlyMap<string, string>;
  promptVersion: string;
  schemaVersion: string;
  modelId: string;
  parserVersion: string;
  /** Claims already held for these subjects, so supersession can be decided. */
  existing: readonly EvidenceClaimRecord[];
  now: Date;
}

export interface ToClaimRecordsResult {
  /** New or re-observed claims. An unchanged re-read yields the same ids. */
  records: EvidenceClaimRecord[];
  /** Ids of held claims this observation replaced. Never deleted, only marked. */
  supersededIds: string[];
  /** Claims that failed a gate. Counted, never coerced. */
  discarded: number;
}

/**
 * Turn one compilation's extracted claims into durable records.
 *
 * The gates are `enrich.ts`'s, shared rather than re-implemented: a claim good
 * enough to store and not good enough to act on would be a store and a planner
 * disagreeing about what evidence is.
 */
export function toClaimRecords(input: ToClaimRecordsInput): ToClaimRecordsResult {
  const records: EvidenceClaimRecord[] = [];
  const superseded = new Set<string>();
  const seen = new Set<string>();
  let discarded = 0;

  const existingByKey = new Map<string, EvidenceClaimRecord[]>();
  for (const claim of input.existing) {
    const key = `${claim.subjectKey}::${claim.factPath}`;
    existingByKey.set(key, [...(existingByKey.get(key) ?? []), claim]);
  }

  for (const claim of input.claims) {
    const document = input.documents[claim.documentIndex];
    const gate = gateClaim(claim, document);
    if (!gate.ok || !document) {
      discarded += 1;
      continue;
    }

    const subjectKey = input.subjectKeys.get(claim.subjectId);
    if (!subjectKey) {
      // No durable identity for this subject, so no durable claim. It still
      // becomes a fact for this compilation through the ordinary path; what it
      // does not become is something another trip could read.
      discarded += 1;
      continue;
    }

    const contentDigest = `sha256:${document.contentHash}`;
    /**
     * The same source identity the document store uses, not the bare host.
     *
     * A claim naming `museum.example` and a document version named
     * `src-museum.example-<hash>@sha256:…` would look related and join to
     * nothing — the retention sweep protects sources by looking for exactly this
     * id, and a mismatch would quietly make that protection a no-op.
     */
    const canonical = canonicalizeUrl(document.url);
    const sourceId = canonical ? sourceIdFor(canonical) : document.domain;
    const contract =
      claim.evidenceField !== undefined
        ? parseContract(input.parserVersion)
        : extractionContract({
            promptVersion: input.promptVersion,
            schemaVersion: input.schemaVersion,
            modelId: input.modelId,
            parserVersion: input.parserVersion,
          });

    const id = claimIdFor({
      subjectKey,
      factPath: claim.factPath,
      contentDigest,
      contract,
      normalizedValue: normalizeClaimValue(gate.payload, claim.statement),
    });

    /**
     * The same claim twice in one batch is one claim.
     *
     * A model asked about two pages that say the same thing legitimately returns
     * the same answer twice; storing it twice would inflate the claim count and,
     * worse, look like corroboration to anything counting rows.
     */
    if (seen.has(id)) continue;
    seen.add(id);

    const dates = datesFrom(gate.payload);
    const record: EvidenceClaimRecord = {
      schemaVersion: EVIDENCE_STORE_VERSION,
      id,
      subjectKey,
      factPath: claim.factPath,
      statement: claim.statement.slice(0, 400),
      ...(gate.payload !== undefined ? { payload: gate.payload } : {}),
      origin: claim.evidenceField !== undefined ? 'deterministic_parse' : 'model_extraction',
      sourceId,
      documentVersionId: `${sourceId}@${contentDigest}`,
      contentDigest,
      ...(claim.evidenceField === undefined ? { extractionKey: contract } : {}),
      authorityKind: document.authority,
      authorityName: document.publisher,
      sourceUrl: document.url,
      sourceDomain: document.domain,
      ...(gate.excerpt ? { evidenceExcerpt: gate.excerpt } : {}),
      ...(claim.evidenceField ? { evidenceField: claim.evidenceField } : {}),
      derivation: claim.derivation,
      contentObservedAt: document.retrievedAt,
      promptVersion: input.promptVersion,
      extractionSchemaVersion: input.schemaVersion,
      parserVersion: input.parserVersion,
      modelId: input.modelId,
      ...(dates.from ? { appliesFrom: dates.from } : {}),
      ...(dates.to ? { appliesTo: dates.to } : {}),
      firstSeenAt: input.now.toISOString(),
      lastSeenAt: input.now.toISOString(),
      superseded: false,
    };

    /**
     * The same page, the same question, a different answer, read later.
     *
     * Only that supersedes. Two *different* publishers disagreeing is a conflict
     * for the resolver to surface in the open, not a replacement — collapsing
     * them would let whichever page happened to be read last win an argument it
     * should have had visibly.
     */
    for (const replaced of supersededBy(record, existingByKey.get(`${subjectKey}::${claim.factPath}`) ?? [])) {
      if (replaced.contentDigest !== record.contentDigest) superseded.add(replaced.id);
    }

    records.push(record);
  }

  return { records, supersededIds: [...superseded].sort(), discarded };
}

/** A closure or a dated offer carries its own window. Everything else has none. */
function datesFrom(payload: unknown): { from?: string; to?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const value = payload as { from?: unknown; to?: unknown };
  return {
    ...(typeof value.from === 'string' ? { from: value.from } : {}),
    ...(typeof value.to === 'string' ? { to: value.to } : {}),
  };
}

export interface FactsFromClaimsInput {
  claims: readonly EvidenceClaimRecord[];
  /** Durable subject key → this trip's subject id. The boundary, coming back. */
  subjectIds: ReadonlyMap<string, string>;
}

export interface FactsFromClaimsResult {
  facts: SourceFact[];
  payloads: Map<string, unknown>;
}

/**
 * Project durable claims back into the facts one compilation reasons about.
 *
 * The fact id is derived from the claim id rather than from a counter, so an
 * artifact quoting a fact can be traced to the claim and the document behind it
 * — and so two compilations of the same evidence quote the same id.
 *
 * `retrievedAt` is the claim's **content** clock. A claim reused six months
 * later produces a fact that is honestly six months old; stamping it with today
 * would be the cache manufacturing freshness, which is the one thing this whole
 * phase exists to prevent.
 */
export function factsFromClaims(input: FactsFromClaimsInput): FactsFromClaimsResult {
  const facts: SourceFact[] = [];
  const payloads = new Map<string, unknown>();

  for (const claim of input.claims) {
    if (claim.superseded) continue;
    const subjectId = input.subjectIds.get(claim.subjectKey);
    if (!subjectId) continue;

    const volatility = volatilityOf(claim.factPath);
    const recheckRequired = volatility === 'dynamic';
    const id = `fact-${claim.id}`;

    facts.push({
      id,
      subjectId,
      factPath: claim.factPath,
      kind: factKindFor(claim.factPath),
      statement: claim.statement,
      authorityKind: claim.authorityKind,
      authorityName: claim.authorityName,
      ...(claim.sourceUrl ? { sourceUrl: claim.sourceUrl } : {}),
      ...(claim.sourceDomain ? { sourceDomain: claim.sourceDomain } : {}),
      ...(claim.licenceId ? { licenceId: claim.licenceId } : {}),
      retrievedAt: claim.contentObservedAt,
      retrievalStatus: claim.evidenceField !== undefined ? 'structured_data' : 'fetched',
      ...(claim.evidenceExcerpt ? { evidenceExcerpt: claim.evidenceExcerpt } : {}),
      ...(claim.evidenceField ? { evidenceField: claim.evidenceField } : {}),
      contentHash: claim.contentDigest.slice(claim.contentDigest.indexOf(':') + 1),
      ...(claim.promptVersion ? { extractionPromptVersion: claim.promptVersion } : {}),
      ...(claim.extractionSchemaVersion
        ? { extractionSchemaVersion: claim.extractionSchemaVersion }
        : {}),
      ...(claim.modelId ? { modelId: claim.modelId } : {}),
      ...(claim.appliesFrom ? { appliesFrom: claim.appliesFrom } : {}),
      ...(claim.appliesTo ? { appliesTo: claim.appliesTo } : {}),
      derivation: claim.derivation,
      volatility,
      shelfLifeDays: shelfLifeFor(claim.factPath),
      recheckRequired,
      ...(recheckRequired
        ? { recheckNote: 'This changes without notice. Check the official page before you go.' }
        : {}),
    });
    if (claim.payload !== undefined) payloads.set(id, claim.payload);
  }

  return { facts, payloads };
}

export interface ClaimCoverage {
  /** Subjects whose every wanted path is already answered by a live claim. */
  covered: ResearchSubject[];
  /** Subjects still worth spending money on, with the paths they still need. */
  outstanding: ResearchSubject[];
  /** How many wanted paths across all subjects were answered from the store. */
  pathsCovered: number;
}

/**
 * Who still needs researching, and who does not.
 *
 * This is where the money is saved: a subject that has already been researched
 * recently, under the same contract, for the same questions, never reaches
 * source discovery, never has a page fetched, and never reaches the model.
 *
 * **Not** "every question answered", which was the first rule and saved nothing.
 * Sources genuinely do not publish everything — most museums never state a
 * typical visit length — so full coverage was almost never reached and a warm
 * run re-bought the same fruitless search every time. What is actually true is
 * that asking again next week will not make a museum start publishing its
 * admission price.
 *
 * Two conditions, and both are needed. A **fresh attempt**, because that is what
 * says another look would buy nothing. And **at least one live claim**, because
 * an attempt that yielded nothing at all is more likely to have been a bad
 * search than a genuine silence, and is worth one more try.
 */
export function claimCoverage(input: {
  subjects: readonly ResearchSubject[];
  subjectKeys: ReadonlyMap<string, string>;
  claimsBySubjectKey: ReadonlyMap<string, readonly EvidenceClaimRecord[]>;
  /** A claim past its own shelf life does not count as coverage. */
  isFresh: (claim: EvidenceClaimRecord) => boolean;
  /** Attempts already made, by `researchAttemptKey`. */
  attempts: ReadonlyMap<string, ResearchAttempt>;
  /** The contract a fresh attempt must have been made under to count. */
  contract: string;
  now: Date;
}): ClaimCoverage {
  const covered: ResearchSubject[] = [];
  const outstanding: ResearchSubject[] = [];
  let pathsCovered = 0;

  for (const subject of input.subjects) {
    const subjectKey = input.subjectKeys.get(subject.id);
    const held = subjectKey ? (input.claimsBySubjectKey.get(subjectKey) ?? []) : [];
    const byPath = liveClaimsByPath(held);

    const answered = subject.wantedPaths.filter((path) => {
      const claims = byPath.get(path);
      return claims !== undefined && claims.some((claim) => input.isFresh(claim));
    });
    pathsCovered += answered.length;

    const attempt = subjectKey
      ? input.attempts.get(
          researchAttemptKey({
            subjectKey,
            contract: input.contract,
            wantedPaths: subject.wantedPaths,
          }),
        )
      : undefined;

    if (answered.length > 0 && attempt && attemptIsFresh(attempt, subject.wantedPaths, input.now)) {
      covered.push(subject);
    } else {
      outstanding.push(subject);
    }
  }

  return { covered, outstanding, pathsCovered };
}

/**
 * How long an attempt stands, judged by the most perishable thing it asked for.
 *
 * A subject whose questions include a closure is re-asked within three weeks; one
 * asking only where the official site is stands for a year. Derived from the
 * per-path shelf lives rather than being a second number, so the two cannot
 * drift apart.
 */
export function attemptIsFresh(
  attempt: ResearchAttempt,
  wantedPaths: readonly FactPath[],
  now: Date,
): boolean {
  const attempted = Date.parse(attempt.attemptedAt);
  if (Number.isNaN(attempted)) return false;
  const windowDays = wantedPaths.reduce(
    (shortest, path) => Math.min(shortest, shelfLifeFor(path)),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(windowDays)) return false;
  return (now.getTime() - attempted) / 86_400_000 <= windowDays;
}

/**
 * The paths whose resolved answer may be stored once for everybody.
 *
 * Re-exported here so a caller reasoning about claims does not have to know
 * that the rule lives in core — and so there is exactly one list.
 */
export function shareableResolution(path: FactPath): boolean {
  return isContextIndependent(path);
}
