import {
  EVIDENCE_STORE_VERSION,
  canonicalizeUrl,
  discoveryKeyFor,
  emptyReuseReport,
  extractionKeyFor,
  fastestClass,
  isUsableDigest,
  isVaryCompatible,
  operationKeyFor,
  needsFullReread,
  needsRevalidation,
  robotsVerdictIsFresh,
  sourceIdFor,
  subjectKeyFor,
  type CanonicalSource,
  type DocumentVersion,
  type EvidenceReuseReport,
  type ExtractionVersion,
  type FactPath,
  type RetrievalObservation,
  type SourceDiscoveryOutcome,
  type SourceDiscoveryRecord,
  type WorkPlanEntry,
} from '@sidequest/core';
import type {
  ExtractedClaim,
  FactExtractionProvider,
  ProviderGap,
  ResearchSubject,
  RetrievedDocument,
  SourceDiscoveryProvider,
  SourceReference,
  SourceRetrievalProvider,
} from './providers';

/**
 * THE SHARED EVIDENCE LAYER.
 *
 * Phase 9 ended with one nameable gap, and this closes it. A region pack was
 * already shared between trips; the *page* it pointed at was not, so every
 * compilation re-searched, re-fetched and re-extracted facts that belong to a
 * museum rather than to a traveller. New York paid for eleven searches and thirty
 * pages every single time.
 *
 * This wraps the three research providers and puts a store in front of each,
 * with a different invalidation rule for each because they fail and cost
 * differently:
 *
 * | Layer | Reused when | Invalidated by |
 * | --- | --- | --- |
 * | discovery | subject + wanted paths + provider version match, and not expired | a new provider version, or the entry ageing out |
 * | retrieval | the document is fresh, or a `304` says it is | content changing, `Vary` we cannot reproduce, the full-re-read window |
 * | extraction | content digest + schema + prompt + model + parser + paths + subject all match | any one of those seven moving |
 *
 * The rule that governs all three: **a cache hit may reduce work and may never
 * increase confidence.** Nothing here upgrades a verification state, hides a
 * conflict, or refreshes a fact's age. Reuse is invisible in the output and
 * visible only in the ledger — which is the only arrangement under which "this
 * was cheap" and "this is true" stay independent claims.
 */

export const RETRIEVAL_VERSION = 'retrieval/2026-08-02.1';
export const PARSER_VERSION = 'parsers/2026-08-02.1';

// ---------------------------------------------------------------------------
// The seam to persistence
// ---------------------------------------------------------------------------

export type OperationClaim =
  { kind: 'claimed'; id: string } | { kind: 'in_progress'; id: string; startedAt: string };

/**
 * Everything this layer needs from a database, and nothing else.
 *
 * A port rather than a direct import so the whole layer is testable offline
 * against an in-memory implementation — which is what lets the 304 behaviour,
 * the schema rollover and the concurrent-adoption cases be tested at all,
 * since none of them can be produced with a real network in a unit test.
 */
export interface EvidenceStorePort {
  findDiscovery(key: string, now: Date): SourceDiscoveryRecord | null;
  saveDiscovery(input: {
    record: Omit<SourceDiscoveryRecord, 'schemaVersion' | 'expiresAt'>;
    now: Date;
  }): SourceDiscoveryRecord;
  findSourceByCanonicalUrl(canonicalUrl: string): CanonicalSource | null;
  upsertSource(source: CanonicalSource): CanonicalSource;
  findLatestDocument(sourceId: string): DocumentVersion | null;
  saveDocument(document: DocumentVersion): DocumentVersion;
  recordRevalidation(input: {
    documentVersionId: string;
    checkedAt: string;
    robotsCheckedAt?: string;
    validators?: Partial<DocumentVersion['validators']>;
  }): DocumentVersion | null;
  recordRetrieval(observation: RetrievalObservation): void;
  findExtraction(key: string): ExtractionVersion | null;
  saveExtraction(extraction: ExtractionVersion): void;
  claimOperation(operationKey: string, now: Date): OperationClaim;
  heartbeatOperation(id: string, now: Date): void;
  completeOperation(input: {
    id: string;
    now: Date;
    state: 'done' | 'failed';
    resultRef?: string;
    detail?: string;
  }): void;
  awaitOperation(input: {
    operationKey: string;
    timeoutMs: number;
    now: () => Date;
  }): Promise<'completed' | 'timed_out'>;
}

export interface SharedEvidenceOptions {
  store: EvidenceStorePort;
  now: () => Date;
  /** Headers we always send, so a `Vary` can be judged against them. */
  pinnedHeaders: readonly string[];
  /** How long to wait for another build already doing the same operation. */
  peerWaitMs?: number;
  /** Model id, for the extraction key. Absent means "no model involved". */
  modelId?: string;
}

export interface SharedEvidenceLayer {
  sourceDiscovery: SourceDiscoveryProvider;
  retrieval: SourceRetrievalProvider;
  extraction: FactExtractionProvider;
  /** The running ledger. Read after a compilation, never during a decision. */
  metrics: EvidenceReuseReport;
  /** What was reused and why, as entries for the compilation's work plan. */
  workPlan(): WorkPlanEntry[];
}

/**
 * Subjects, by the trip-local id the compiler uses.
 *
 * The mapping is the boundary: **inside** this layer everything is keyed by
 * `subjectKey`, which is a fact about a place; **outside** it the compiler keeps
 * using its own ids, which are facts about one compilation. Nothing keyed on a
 * trip-local id is ever written to the store.
 */
function subjectKeysFor(subjects: readonly ResearchSubject[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const subject of subjects) {
    keys.set(subject.id, subjectKeyFor({ name: subject.name, coordinates: subject.coordinates }));
  }
  return keys;
}

export function withSharedEvidence(
  inner: {
    sourceDiscovery: SourceDiscoveryProvider;
    retrieval: SourceRetrievalProvider;
    extraction: FactExtractionProvider;
  },
  options: SharedEvidenceOptions,
): SharedEvidenceLayer {
  const metrics: EvidenceReuseReport = emptyReuseReport();
  const notes: WorkPlanEntry[] = [];
  const peerWaitMs = options.peerWaitMs ?? 8_000;

  // -------------------------------------------------------------------------
  // A. Source discovery
  // -------------------------------------------------------------------------

  const sourceDiscovery: SourceDiscoveryProvider = {
    name: `shared+${inner.sourceDiscovery.name}`,
    version: inner.sourceDiscovery.version,
    async discover(input) {
      const now = options.now();
      const keys = subjectKeysFor(input.subjects);
      const references: SourceReference[] = [];
      const gaps: ProviderGap[] = [];
      const missing: ResearchSubject[] = [];

      const keyFor = (subject: ResearchSubject): string =>
        discoveryKeyFor({
          subjectKey: keys.get(subject.id)!,
          wantedPaths: subject.wantedPaths,
          provider: inner.sourceDiscovery.name,
          providerVersion: inner.sourceDiscovery.version,
        });

      for (const subject of input.subjects) {
        const cached = options.store.findDiscovery(keyFor(subject), now);
        if (!cached) {
          missing.push(subject);
          continue;
        }

        metrics.discoveryHits += 1;
        if (cached.outcome === 'found') {
          for (const reference of cached.references) {
            references.push({
              subjectId: subject.id,
              url: reference.url,
              ...(reference.title ? { title: reference.title } : {}),
              expectedAuthority: reference.expectedAuthority,
              discoveredVia: reference.discoveredVia,
              wantedPaths: subject.wantedPaths,
            });
          }
        } else {
          /**
           * A remembered absence is still an absence, and it is reported as one.
           *
           * Reusing it saves a paid search; presenting it as anything softer
           * than "nobody publishes this" would be a cache changing what the
           * product claims about the world.
           */
          gaps.push({
            subjectId: subject.id,
            reason:
              cached.outcome === 'provider_unavailable' ? 'provider_error' : 'no_official_source',
            detail: 'We could not find a page published by whoever runs this.',
          });
        }
      }

      if (missing.length === 0) {
        notes.push({
          step: 'discovering_sources',
          decision: 'reusable',
          reason: `Every subject already had a known publisher, so no searches were bought.`,
          items: input.subjects.length,
        });
        return { references, gaps, calls: 0, searches: 0 };
      }

      const result = await inner.sourceDiscovery.discover({
        ...input,
        subjects: missing,
      });
      metrics.discoveryMisses += missing.length;

      const byMissingSubject = new Map<string, SourceReference[]>();
      for (const reference of result.references) {
        const bucket = byMissingSubject.get(reference.subjectId) ?? [];
        bucket.push(reference);
        byMissingSubject.set(reference.subjectId, bucket);
      }

      for (const subject of missing) {
        const found = byMissingSubject.get(subject.id) ?? [];
        const outcome: SourceDiscoveryOutcome =
          found.length > 0
            ? 'found'
            : result.gaps.some(
                  (gap) => gap.subjectId === subject.id && gap.reason === 'provider_error',
                ) || result.gaps.some((gap) => gap.subjectId === 'source-discovery')
              ? 'provider_unavailable'
              : 'no_source_found';

        options.store.saveDiscovery({
          now,
          record: {
            key: keyFor(subject),
            outcome,
            references: found.map((reference) => ({
              url: reference.url,
              ...(reference.title ? { title: reference.title } : {}),
              expectedAuthority: reference.expectedAuthority,
              discoveredVia: reference.discoveredVia,
            })),
            provider: inner.sourceDiscovery.name,
            providerVersion: inner.sourceDiscovery.version,
            discoveredAt: now.toISOString(),
            searches: result.searches,
          },
        });
      }

      /**
       * Freshly-found references carry what we wanted from them.
       *
       * Retrieval reads this to decide how often a page is worth rechecking, and
       * a reference that arrived without it would be judged on the most cautious
       * assumption — which is safe, and needlessly expensive.
       */
      const enriched = result.references.map((reference) => ({
        ...reference,
        wantedPaths:
          input.subjects.find((subject) => subject.id === reference.subjectId)?.wantedPaths ??
          reference.wantedPaths,
      }));

      notes.push({
        step: 'discovering_sources',
        decision: metrics.discoveryHits > 0 ? 'revalidate' : 'recompute',
        reason: `${metrics.discoveryHits} publishers were already known; ${missing.length} needed looking up.`,
        items: input.subjects.length,
      });

      return {
        references: [...references, ...enriched],
        gaps: [...gaps, ...result.gaps],
        calls: result.calls,
        searches: result.searches,
      };
    },
  };

  // -------------------------------------------------------------------------
  // B. Retrieval
  // -------------------------------------------------------------------------

  const retrieval: SourceRetrievalProvider = {
    name: `shared+${inner.retrieval.name}`,
    async retrieve(input) {
      const now = options.now();
      const documents: RetrievedDocument[] = [];
      const rejected: Awaited<ReturnType<SourceRetrievalProvider['retrieve']>>['rejected'] = [];

      /** Every reference, resolved once. Canonicalising twice is a subtle bug source. */
      const resolved = input.references.map((reference) => ({
        reference,
        canonical: canonicalizeUrl(reference.url),
      }));

      const toFetch: SourceReference[] = [];
      const reusing: {
        reference: SourceReference;
        document: DocumentVersion;
        source: CanonicalSource;
      }[] = [];
      const revalidating = new Map<
        string,
        {
          reference: SourceReference;
          document: DocumentVersion;
          source: CanonicalSource;
        }
      >();

      for (const { reference, canonical } of resolved) {
        if (!canonical) {
          rejected.push({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: 'rejected_unsafe_source',
            detail: 'That is not an address we can read.',
          });
          continue;
        }

        const source = options.store.findSourceByCanonicalUrl(canonical.url);
        const held = source ? options.store.findLatestDocument(sourceIdFor(canonical)) : null;

        if (!source || !held || !isUsableDigest(held.contentDigest)) {
          toFetch.push(reference);
          continue;
        }

        /**
         * How often this page is worth rechecking, governed by the
         * fastest-changing thing anybody wants out of it.
         *
         * A reference that did not say what it is for is treated as wanting the
         * fastest-changing thing there is. `fastestClass([])` answers "slow",
         * which is the wrong default here — it would give a page nobody declared
         * an appetite for a four-month re-read window. Not knowing is a reason to
         * check more often, not less.
         */
        const changeClass =
          reference.wantedPaths && reference.wantedPaths.length > 0
            ? fastestClass(reference.wantedPaths)
            : 'fast';

        /**
         * Three checks, in order, and the order matters.
         *
         * `Vary` first, because a representation negotiated on a header we do not
         * pin is not ours to reuse under any freshness — reusing it would risk
         * serving one language's page as another's. Then the full-re-read window,
         * which is the answer to a server whose validators never change. Only
         * then the cheap question: is it recent enough to skip even asking?
         */

        /**
         * A site that has withdrawn permission is not read again.
         *
         * The held evidence stays where it is — an artifact built when we were
         * welcome is still a record of what we lawfully read — but it does not
         * enter a *new* compilation, and no request is made. Reported rather than
         * dropped quietly, because a place disappearing from a board with no
         * explanation is worse than one disappearing with one.
         */
        if (!held.robotsAllowed) {
          rejected.push({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: 'blocked_by_robots',
            detail: 'That site now asks us not to read this, so we have stopped.',
          });
          continue;
        }

        if (!isVaryCompatible(held.validators.vary, options.pinnedHeaders)) {
          toFetch.push(reference);
          continue;
        }
        if (
          needsFullReread({
            contentObservedAt: held.contentObservedAt,
            changeClass,
            now,
          })
        ) {
          toFetch.push(reference);
          continue;
        }
        /**
         * Reuse without asking anything is only allowed while *both* clocks
         * hold: the content is inside its window, and the site's permission was
         * confirmed recently enough to still mean something.
         *
         * When permission is stale the reference goes to the conditional path
         * rather than to a full re-read — `fetchIfAllowed` reads robots.txt as
         * part of that request, so the recheck rides along with a request we were
         * going to make anyway.
         */
        const robotsFresh = robotsVerdictIsFresh({
          robotsCheckedAt: held.robotsCheckedAt,
          now,
        });
        if (
          robotsFresh &&
          !needsRevalidation({
            lastCheckedAt: held.lastCheckedAt,
            changeClass,
            now,
          })
        ) {
          reusing.push({ reference, document: held, source });
          continue;
        }
        /**
         * Keyed by page *and* subject, not by page alone.
         *
         * One official page can serve several subjects — a park authority
         * publishing six trails, a museum complex listing its wings. Keying on
         * the URL alone meant the last subject overwrote the others, and every
         * subject but one silently lost its document: not fetched, not reused,
         * just gone. That is the same "one operator, many sites" case the
         * closure-propagation rule exists for, arriving from the other side.
         */
        revalidating.set(revalidationKey(canonical.url, reference.subjectId), {
          reference,
          document: held,
          source,
        });
      }

      // ---- Reuse outright: no request at all ------------------------------
      for (const entry of reusing) {
        metrics.documentsReused += 1;
        metrics.bytesAvoided += entry.document.representation.bytes;
        documents.push(toRetrievedDocument(entry, entry.reference.subjectId));
        options.store.recordRetrieval({
          sourceId: entry.source.id,
          documentVersionId: entry.document.id,
          kind: 'not_modified',
          status: 0,
          observedAt: now.toISOString(),
          bytes: 0,
          bytesAvoided: entry.document.representation.bytes,
          detail: 'Held and still inside its window, so nothing was requested.',
        });
      }

      /**
       * WORK SOMEBODY ELSE IS ALREADY DOING.
       *
       * Two compilations of the same city start seconds apart and would
       * otherwise fetch the same official page twice. Claiming the URL is what
       * makes the second one wait and then *adopt* the first one's result
       * instead of paying for it again.
       *
       * The fallbacks are deliberately generous in the same direction: a peer
       * that times out, dies, or produces nothing usable leaves us doing the
       * work ourselves. Duplicated work is a cost; a compilation stalled behind
       * a dead process is a defect.
       */
      const claimedOperations: string[] = [];
      const fetchable: SourceReference[] = [];
      for (const reference of toFetch) {
        const canonical = canonicalizeUrl(reference.url);
        if (!canonical) continue;
        const operationKey = operationKeyFor('retrieve', canonical.url);
        const claim = options.store.claimOperation(operationKey, now);
        if (claim.kind === 'claimed') {
          claimedOperations.push(claim.id);
          fetchable.push(reference);
          continue;
        }

        await options.store.awaitOperation({
          operationKey,
          timeoutMs: peerWaitMs,
          now: options.now,
        });
        const peerSource = options.store.findSourceByCanonicalUrl(canonical.url);
        const adopted = peerSource ? options.store.findLatestDocument(peerSource.id) : null;
        if (peerSource && adopted && isUsableDigest(adopted.contentDigest)) {
          metrics.operationsAdopted += 1;
          metrics.documentsReused += 1;
          metrics.bytesAvoided += adopted.representation.bytes;
          documents.push(
            toRetrievedDocument({ document: adopted, source: peerSource }, reference.subjectId),
          );
          continue;
        }
        fetchable.push(reference);
      }

      // ---- Ask, conditionally ---------------------------------------------
      const requestable: SourceReference[] = [
        ...[...revalidating.values()].map((entry) => ({
          ...entry.reference,
          conditional: {
            ...(entry.document.validators.etag ? { etag: entry.document.validators.etag } : {}),
            ...(entry.document.validators.lastModified
              ? { lastModified: entry.document.validators.lastModified }
              : {}),
          },
        })),
        ...fetchable,
      ];

      let bytes = 0;
      try {
        if (requestable.length > 0) {
          const result = await inner.retrieval.retrieve({
            ...input,
            references: requestable,
          });
          bytes += result.bytes;
          rejected.push(...result.rejected);

          for (const unchanged of result.unchanged ?? []) {
            const canonical = canonicalizeUrl(unchanged.url);
            const entry = canonical
              ? revalidating.get(revalidationKey(canonical.url, unchanged.subjectId))
              : undefined;
            if (!entry) continue;
            metrics.documentsRevalidated += 1;
            metrics.bytesAvoided += entry.document.representation.bytes;
            /**
             * The 304, handled honestly.
             *
             * `lastCheckedAt` moves because we genuinely checked. `contentObservedAt`
             * does not, because the server said the *representation* is unchanged
             * and said nothing whatsoever about whether the facts on it are still
             * true. Any other handling would let a nightly revalidation keep a
             * lifted closure alive forever, which is the single failure this whole
             * phase is built around.
             */
            const refreshed = options.store.recordRevalidation({
              documentVersionId: entry.document.id,
              checkedAt: now.toISOString(),
              ...(unchanged.validators
                ? {
                    validators: {
                      ...(unchanged.validators.etag ? { etag: unchanged.validators.etag } : {}),
                      ...(unchanged.validators.lastModified
                        ? { lastModified: unchanged.validators.lastModified }
                        : {}),
                    },
                  }
                : {}),
            });
            documents.push(
              toRetrievedDocument(
                { document: refreshed ?? entry.document, source: entry.source },
                unchanged.subjectId,
              ),
            );
            options.store.recordRetrieval({
              sourceId: entry.source.id,
              documentVersionId: entry.document.id,
              kind: 'not_modified',
              status: 304,
              observedAt: now.toISOString(),
              bytes: 0,
              bytesAvoided: unchanged.bytesAvoided || entry.document.representation.bytes,
            });
          }

          for (const document of result.documents) {
            metrics.documentsFetched += 1;
            metrics.bytesTransferred += document.contentBytes;
            documents.push(document);
            persistDocument(options.store, document, now);
          }
        }
      } finally {
        // Released whatever happened above, so a thrown request cannot leave a
        // URL claimed until its heartbeat expires and a waiting peer blocked
        // behind it for no reason.
        for (const id of claimedOperations) {
          options.store.completeOperation({
            id,
            now: options.now(),
            state: 'done',
          });
        }
      }

      notes.push({
        step: 'retrieving_pages',
        decision:
          metrics.documentsFetched === 0 && documents.length > 0
            ? 'reusable'
            : metrics.documentsReused + metrics.documentsRevalidated > 0
              ? 'revalidate'
              : 'recompute',
        reason: `${metrics.documentsReused} held, ${metrics.documentsRevalidated} rechecked and unchanged, ${metrics.documentsFetched} read fresh.`,
        items: input.references.length,
      });

      return { documents, rejected, gaps: [], bytes, requested: requestable.length };
    },
  };

  // -------------------------------------------------------------------------
  // C. Extraction
  // -------------------------------------------------------------------------

  const extraction: FactExtractionProvider = {
    name: `shared+${inner.extraction.name}`,
    promptVersion: inner.extraction.promptVersion,
    schemaVersion: inner.extraction.schemaVersion,
    ...(inner.extraction.modelId ? { modelId: inner.extraction.modelId } : {}),
    async extract(input) {
      const now = options.now();
      const keys = subjectKeysFor(input.subjects);
      const claims: ExtractedClaim[] = [];
      const wantedBySubject = new Map<string, readonly FactPath[]>(
        input.subjects.map((subject) => [subject.id, subject.wantedPaths]),
      );

      const modelId = inner.extraction.modelId ?? options.modelId ?? 'unknown-model';
      const promptVersion = inner.extraction.promptVersion;
      const schemaVersion = inner.extraction.schemaVersion;
      const uncached: { index: number; document: RetrievedDocument }[] = [];
      const cacheKeys = new Map<number, string>();

      for (const [index, document] of input.documents.entries()) {
        const subjectKey = keys.get(document.subjectId);
        const wanted = wantedBySubject.get(document.subjectId) ?? [];
        if (!subjectKey || !isUsableDigest(`sha256:${document.contentHash}`)) {
          uncached.push({ index, document });
          continue;
        }
        const key = extractionKeyFor({
          operation: 'planning-facts',
          contentDigests: [`sha256:${document.contentHash}`],
          schemaVersion,
          promptVersion,
          modelId,
          parserVersion: PARSER_VERSION,
          wantedPaths: wanted,
          subjectKey,
        });
        cacheKeys.set(index, key);

        const hit = options.store.findExtraction(key);
        if (!hit) {
          uncached.push({ index, document });
          continue;
        }

        const stored = cachedClaims(hit);
        if (!stored) {
          uncached.push({ index, document });
          continue;
        }
        metrics.extractionsReused += 1;
        metrics.modelCallsAvoided += 1;
        for (const claim of stored) {
          claims.push({
            ...claim,
            subjectId: document.subjectId,
            documentIndex: index,
          });
        }
      }

      if (uncached.length === 0) {
        notes.push({
          step: 'extracting_facts',
          decision: 'reusable',
          reason: `All ${input.documents.length} pages had already been read into facts under the same contract.`,
          items: input.documents.length,
        });
        return {
          claims,
          unanswered: [],
          gaps: [],
          calls: 0,
          promptVersion,
          schemaVersion,
          ...(modelId !== 'unknown-model' ? { modelId } : {}),
        };
      }

      const result = await inner.extraction.extract({
        ...input,
        documents: uncached.map((entry) => entry.document),
      });
      metrics.extractionsPerformed += uncached.length;

      /**
       * The inner extractor indexes into the list it was given, which is not the
       * list the caller passed. Remapping rather than renumbering keeps the
       * caller's contract — a claim's `documentIndex` still points at the
       * document the caller supplied — and a claim whose index does not resolve
       * is dropped rather than attached to whoever happens to be at that
       * position.
       */
      const byInnerIndex = new Map(uncached.map((entry, position) => [position, entry.index]));
      const grouped = new Map<number, ExtractedClaim[]>();
      for (const claim of result.claims) {
        const outerIndex = byInnerIndex.get(claim.documentIndex);
        if (outerIndex === undefined) continue;
        const remapped = { ...claim, documentIndex: outerIndex };
        claims.push(remapped);
        const bucket = grouped.get(outerIndex) ?? [];
        bucket.push(remapped);
        grouped.set(outerIndex, bucket);
      }

      /**
       * One cache row per document, from one batched call.
       *
       * Batching keeps the bill down; per-document rows are what make the next
       * run cheap when only one page changed. What a row must *not* do is invent
       * a per-document cost: an even split is an apportionment, and an
       * apportionment printed where a measurement is expected is a quiet lie.
       *
       * So each row carries the batch's **exact** totals, says how many documents
       * the batch covered, and labels itself `batch_total`. Anything wanting a
       * per-document figure has to divide deliberately, and anything wanting the
       * true cost reads the ledger, which sums each call once.
       */
      for (const entry of uncached) {
        const key = cacheKeys.get(entry.index);
        if (!key) continue;
        const documentClaims = grouped.get(entry.index) ?? [];
        options.store.saveExtraction({
          schemaVersion: EVIDENCE_STORE_VERSION,
          key,
          inputs: {
            operation: 'planning-facts',
            contentDigests: [`sha256:${entry.document.contentHash}`],
            schemaVersion,
            promptVersion,
            modelId,
            parserVersion: PARSER_VERSION,
            wantedPaths: [...(wantedBySubject.get(entry.document.subjectId) ?? [])],
            ...(keys.get(entry.document.subjectId)
              ? { subjectKey: keys.get(entry.document.subjectId)! }
              : {}),
          },
          status: 'succeeded',
          output: documentClaims.map(
            ({ subjectId: _subjectId, documentIndex: _index, ...rest }) => rest,
          ),
          tokens: {
            input: result.tokens?.input ?? 0,
            output: result.tokens?.output ?? 0,
            cacheRead: result.tokens?.cacheRead ?? 0,
            cacheWrite: result.tokens?.cacheWrite ?? 0,
            basis: uncached.length > 1 ? ('batch_total' as const) : ('measured' as const),
            batchDocuments: uncached.length,
          },
          attempts: 1,
          diagnostics:
            uncached.length > 1
              ? [
                  `These token counts are the whole call, which covered ${uncached.length} pages. They are not this page's share.`,
                ]
              : [],
          createdAt: now.toISOString(),
        });
      }

      notes.push({
        step: 'extracting_facts',
        decision: metrics.extractionsReused > 0 ? 'revalidate' : 'recompute',
        reason: `${metrics.extractionsReused} pages were already read under this contract; ${uncached.length} were read again.`,
        items: input.documents.length,
      });

      return { ...result, claims };
    },
  };

  return {
    sourceDiscovery,
    retrieval,
    extraction,
    metrics,
    workPlan: () => [...notes],
  };
}

function cachedClaims(
  entry: ExtractionVersion,
): Omit<ExtractedClaim, 'subjectId' | 'documentIndex'>[] | null {
  if (!Array.isArray(entry.output)) return null;
  const claims: Omit<ExtractedClaim, 'subjectId' | 'documentIndex'>[] = [];
  for (const candidate of entry.output) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const claim = candidate as Record<string, unknown>;
    if (typeof claim.factPath !== 'string' || typeof claim.statement !== 'string') return null;
    claims.push(claim as unknown as Omit<ExtractedClaim, 'subjectId' | 'documentIndex'>);
  }
  return claims;
}

function toRetrievedDocument(
  entry: { document: DocumentVersion; source: CanonicalSource },
  subjectId: string,
): RetrievedDocument {
  const { document, source } = entry;
  return {
    subjectId,
    url: source.finalUrl ?? source.canonicalUrl,
    text: document.representation.text,
    structuredData: document.representation.structuredData,
    contentHash: document.contentDigest.slice(document.contentDigest.indexOf(':') + 1),
    contentBytes: document.representation.bytes,
    /**
     * The retrieval timestamp a fact will carry is when the *content* was
     * observed, not when we last checked. A fact stamped with today's date
     * because a 304 came back this morning would be a fact claiming a freshness
     * nobody established.
     */
    retrievedAt: document.contentObservedAt,
    ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
    robotsAllowed: document.robotsAllowed,
    authority: source.authority,
    publisher: source.publisher,
    domain: source.host,
    validators: {
      ...(document.validators.etag ? { etag: document.validators.etag } : {}),
      weakEtag: document.validators.weak,
      ...(document.validators.lastModified
        ? { lastModified: document.validators.lastModified }
        : {}),
      ...(document.validators.vary ? { vary: document.validators.vary } : {}),
    },
    truncated: document.representation.truncated,
  };
}

/** One page read on behalf of one subject. Both halves are part of the identity. */
function revalidationKey(canonicalUrl: string, subjectId: string): string {
  return `${canonicalUrl}\u0000${subjectId}`;
}

/**
 * Record a freshly-read page as a source identity plus a content-addressed
 * version.
 *
 * Failure here is deliberately silent at the caller: a document that could not
 * be stored is still a document that was read, and losing a cache write must
 * never lose a compilation.
 */
export function persistDocument(
  store: EvidenceStorePort,
  document: RetrievedDocument,
  now: Date,
): DocumentVersion | null {
  const canonical = canonicalizeUrl(document.url);
  if (!canonical) return null;

  const sourceId = sourceIdFor(canonical);
  const existing = store.findSourceByCanonicalUrl(canonical.url);
  const stamp = now.toISOString();

  const source = store.upsertSource({
    schemaVersion: EVIDENCE_STORE_VERSION,
    id: sourceId,
    submittedUrl: canonical.url,
    canonicalUrl: canonical.url,
    finalUrl: document.url,
    redirectChain: (document.redirects ?? []).slice(0, 6),
    origin: canonical.origin,
    host: canonical.host,
    publisher: document.publisher,
    authority: document.authority,
    identityWarnings: canonical.warnings.slice(0, 6),
    firstSeenAt: existing?.firstSeenAt ?? stamp,
    lastSeenAt: stamp,
    relations: existing?.relations ?? [],
  });

  const digest = `sha256:${document.contentHash}`;
  if (!isUsableDigest(digest)) return null;

  const held = store.findLatestDocument(source.id);
  /**
   * When this content was observed, from the provider that observed it.
   *
   * Two rules, and both matter:
   *
   * **Unchanged content keeps its original observation time.** Re-reading a page
   * that has not changed is not new evidence, and stamping it with today's date
   * would make a year-old page look like this morning's.
   *
   * **New content is stamped with the retrieval's own timestamp, not the
   * store's clock.** The provider stamps `retrievedAt` at the moment the
   * response arrived and is the authority on it; substituting our own `now`
   * would be the store second-guessing the only party that was there. It also
   * made a deterministic provider non-deterministic: a fixture world compiled
   * twice produced facts dated differently on the second pass purely because the
   * store had reached for a wall clock.
   */
  const observedAt =
    held?.contentDigest === digest ? held.contentObservedAt : (document.retrievedAt || stamp);

  return store.saveDocument({
    schemaVersion: EVIDENCE_STORE_VERSION,
    id: `${source.id}@${digest}`,
    sourceId: source.id,
    contentDigest: digest,
    representation: {
      text: document.text.slice(0, 24_000),
      structuredData: document.structuredData.slice(0, 40),
      truncated: document.truncated ?? false,
      mimeType: 'text/html',
      bytes: document.contentBytes,
    },
    status: 200,
    validators: {
      ...(document.validators?.etag ? { etag: document.validators.etag } : {}),
      weak: document.validators?.weakEtag ?? false,
      ...(document.validators?.lastModified
        ? { lastModified: document.validators.lastModified }
        : {}),
      ...(document.validators?.cacheControl
        ? { cacheControl: document.validators.cacheControl }
        : {}),
      ...(document.validators?.vary ? { vary: document.validators.vary } : {}),
    },
    contentObservedAt: observedAt,
    lastCheckedAt: stamp,
    ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
    robotsAllowed: document.robotsAllowed,
    /**
     * Stamped now, not from the content clock: permission was confirmed by this
     * request, whatever age the bytes turned out to be.
     */
    robotsCheckedAt: stamp,
    safetyDiagnostics: [],
    retrievalVersion: RETRIEVAL_VERSION,
  });
}

/**
 * The order the funnel actually runs in, so the panel reads top to bottom.
 *
 * Entries arrive from two places — the compiler, for work it decided not to
 * start, and the evidence layer, for work it started and found already done —
 * and neither knows about the other. Anything unrecognised keeps its arrival
 * order after the known steps rather than being dropped, because a work plan
 * that quietly omits a step is worse than one with a step out of place.
 */
const WORK_PLAN_STEP_ORDER: readonly string[] = [
  'reusing_shared_claims',
  'discovering_sources',
  'retrieving_pages',
  'extracting_facts',
];

export function orderWorkPlan(entries: readonly WorkPlanEntry[]): WorkPlanEntry[] {
  const rank = (entry: WorkPlanEntry): number => {
    const index = WORK_PLAN_STEP_ORDER.indexOf(entry.step);
    return index === -1 ? WORK_PLAN_STEP_ORDER.length : index;
  };
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}
