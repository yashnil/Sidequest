import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_STORE_VERSION,
  RESOLVER_VERSION,
  compiledRegionSchema,
  researchAttemptKey,
  type CanonicalSource,
  type DocumentVersion,
  type EvidenceClaimRecord,
  type ExtractionVersion,
  type ResearchAttempt,
  type ResolvedFact,
  type RetrievalObservation,
  type SourceDiscoveryRecord,
  type StageRecord,
} from '@sidequest/core';
import { compileRegion } from './compile';
import { withSharedEvidence, type EvidenceStorePort, type OperationClaim } from './evidence-store';
import type { CompilerProviders, FactExtractionProvider } from './providers';
import { deriveScope } from './scope';
import { SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';
import { packBackedProviders } from './testing/pack-fakes';

/**
 * THE SEMANTIC ARTIFACT DOES NOT MOVE WHEN THE CACHE DOES.
 *
 * The rule, stated as the thing that can fail:
 *
 * > A semantic artifact must not change because one run had a cache hit and
 * > another had a cache miss, because one worker made fewer calls, because a
 * > provider retried, because a compile happened later, or because one machine
 * > was slower.
 *
 * `compiler.test.ts` already asserts that two runs of one input produce the
 * same bytes — and it could not see the defect this file exists for, because it
 * builds a **fresh** fake store per run. Every run it compares is cold. The
 * failure only appears against a store that one of the two runs has already
 * warmed, which is the ordinary production case: somebody compiled a nearby
 * city first.
 *
 * What was wrong. `withSharedEvidenceCounters` folded `claimsHeld`,
 * `claimsObserved`, `claimsSuperseded`, `subjectsAnsweredFromClaims` and
 * `sharedResolutionsReused` into `region.diagnostics.budget.consumed` from
 * inside the compiler; the rest of `ledger.snapshot()` was already in there and
 * moves for the same reason — a warm store spends fewer searches, fetches fewer
 * pages, transfers fewer bytes and makes fewer model calls for identical
 * output; and `sourceManifest.providers[].calls` was `ledger.spent(...)` again.
 *
 * So this compiles the same region twice against **one** shared evidence store —
 * empty the first time, full of reusable documents, extractions and claims the
 * second — and asserts the artifact is byte-identical while the operational
 * record differs. The boundary it holds is written out in
 * `schemas/compiled-region.ts`.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const WORLD = SYNTHETIC_WORLDS.transit_city!;

/**
 * A budget generous enough that nothing is cut.
 *
 * Deliberate, and worth stating rather than tuning silently: when a counter
 * runs out, the cold run genuinely researches *fewer subjects* than the warm
 * one, and the warm artifact is then legitimately richer. That is a difference
 * in content, not a determinism defect — the artifact is supposed to say so,
 * and `coverage` does. This test is about the other thing: identical content,
 * different bytes.
 */
const AMPLE_BUDGET = {
  maxCoarseCandidates: 400,
  maxShortlistedCandidates: 200,
  maxResearchSubjects: 200,
  maxSourceSearches: 200,
  maxPagesFetched: 400,
  maxExtractionCalls: 100,
  maxRetrievalBytes: 900_000_000,
  maxModelCalls: 500,
};

// ---------------------------------------------------------------------------
// One shared store, in memory, with the same contract as the database one
// ---------------------------------------------------------------------------

function memoryEvidenceStore(): EvidenceStorePort {
  const discovery = new Map<string, SourceDiscoveryRecord>();
  const sources = new Map<string, CanonicalSource>();
  const documents = new Map<string, DocumentVersion>();
  const extractions = new Map<string, ExtractionVersion>();
  const operations = new Map<string, { id: string; startedAt: string; state: string }>();

  return {
    findDiscovery(key, now) {
      const found = discovery.get(key);
      if (!found) return null;
      if (Date.parse(found.expiresAt) <= now.getTime()) {
        discovery.delete(key);
        return null;
      }
      return found;
    },
    saveDiscovery({ record, now }) {
      const ttl = record.outcome === 'provider_unavailable' ? 600_000 : 30 * 86_400_000;
      const full: SourceDiscoveryRecord = {
        ...record,
        schemaVersion: EVIDENCE_STORE_VERSION,
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
      };
      discovery.set(record.key, full);
      return full;
    },
    findSourceByCanonicalUrl(url) {
      return [...sources.values()].find((source) => source.canonicalUrl === url) ?? null;
    },
    upsertSource(source) {
      const existing = sources.get(source.id);
      const merged = existing
        ? { ...existing, ...source, firstSeenAt: existing.firstSeenAt }
        : source;
      sources.set(source.id, merged);
      return merged;
    },
    findLatestDocument(sourceId) {
      const held = [...documents.values()]
        .filter((document) => document.sourceId === sourceId)
        .sort((a, b) => b.contentObservedAt.localeCompare(a.contentObservedAt));
      return held[0] ?? null;
    },
    saveDocument(document) {
      // Content-addressed: the same bytes twice is the same row, and the second
      // write must not move the first's observation time.
      const existing = documents.get(document.id);
      if (existing) return existing;
      documents.set(document.id, document);
      return document;
    },
    recordRevalidation({ documentVersionId, checkedAt, validators }) {
      const existing = documents.get(documentVersionId);
      if (!existing) return null;
      const next: DocumentVersion = {
        ...existing,
        lastCheckedAt: checkedAt,
        validators: { ...existing.validators, ...(validators ?? {}) },
      };
      documents.set(documentVersionId, next);
      return next;
    },
    recordRetrieval(_observation: RetrievalObservation) {
      /* the ledger is not what this test is about */
    },
    findExtraction(key) {
      const found = extractions.get(key);
      return found?.status === 'succeeded' ? found : null;
    },
    saveExtraction(extraction) {
      extractions.set(extraction.key, extraction);
    },
    claimOperation(operationKey): OperationClaim {
      const held = operations.get(operationKey);
      if (held && held.state === 'running') {
        return { kind: 'in_progress', id: held.id, startedAt: held.startedAt };
      }
      const id = `op-${operationKey}-${operations.size}`;
      operations.set(operationKey, { id, startedAt: 'now', state: 'running' });
      return { kind: 'claimed', id };
    },
    heartbeatOperation() {
      /* nothing to do in memory */
    },
    completeOperation({ id }) {
      for (const [key, value] of operations) {
        if (value.id === id) operations.set(key, { ...value, state: 'done' });
      }
    },
    async awaitOperation() {
      return 'completed';
    },
  };
}

function memoryClaimStore() {
  const claims = new Map<string, EvidenceClaimRecord>();
  const factSets = new Map<string, ResolvedFact>();
  const attempts = new Map<string, ResearchAttempt>();

  return {
    claims,
    factSets,
    store: {
      resolverVersion: RESOLVER_VERSION,
      load(subjectKeys: readonly string[]) {
        const wanted = new Set(subjectKeys);
        const byKey = new Map<string, EvidenceClaimRecord[]>();
        for (const claim of claims.values()) {
          if (!wanted.has(claim.subjectKey)) continue;
          byKey.set(claim.subjectKey, [...(byKey.get(claim.subjectKey) ?? []), claim]);
        }
        return byKey;
      },
      save(input: {
        records: readonly EvidenceClaimRecord[];
        supersededIds: readonly string[];
        now: Date;
      }) {
        for (const id of input.supersededIds) {
          const held = claims.get(id);
          if (held) claims.set(id, { ...held, superseded: true });
        }
        for (const record of input.records) {
          const held = claims.get(record.id);
          claims.set(record.id, held ? { ...held, lastSeenAt: record.lastSeenAt } : record);
        }
      },
      loadAttempts(subjectKeys: readonly string[]) {
        const wanted = new Set(subjectKeys);
        const found = new Map<string, ResearchAttempt>();
        for (const [key, attempt] of attempts) {
          if (wanted.has(attempt.subjectKey)) found.set(key, attempt);
        }
        return found;
      },
      saveAttempts(input: { attempts: readonly ResearchAttempt[] }) {
        for (const attempt of input.attempts) attempts.set(researchAttemptKey(attempt), attempt);
      },
      loadFactSets(keys: readonly string[]) {
        const found = new Map<string, ResolvedFact>();
        for (const key of keys) {
          const entry = factSets.get(key);
          if (entry) found.set(key, entry);
        }
        return found;
      },
      saveFactSets(input: { entries: readonly { key: string; resolved: ResolvedFact }[] }) {
        for (const entry of input.entries) factSets.set(entry.key, entry.resolved);
      },
    },
  };
}

function determinismScope() {
  const scope = deriveScope({
    candidate: syntheticCandidate(WORLD),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: DATES.length - 1,
    revision: 1,
  });
  return {
    ...scope,
    confirmedByUser: true,
    transport: { ...scope.transport, primaryMode: WORLD.primaryMode },
  };
}

/**
 * The fixture extractor, made self-consistent.
 *
 * `fakeProviders` declares `schemaVersion: 'fake-extraction/1'` on the provider
 * and returns `'fake/1'` in its result. The shared evidence layer keys the
 * extraction cache on the *declared* version and, when every page is reused,
 * reports the declared version back; the cold path reports whatever the inner
 * provider returned. A claim's id is derived from that contract, so the two
 * disagreeing meant a warm run minted a brand-new id for every claim it had
 * already stored — reuse that is not idempotent.
 *
 * The real extractor declares and returns the same string
 * (`planning-extraction/1` in `providers/live.ts`), so this is a defect in the
 * fixture rather than in the layer. It is corrected here, in a file this agent
 * owns, and filed as an integration request against `testing/fakes.ts`.
 */
function consistentExtraction(inner: FactExtractionProvider): FactExtractionProvider {
  return {
    ...inner,
    async extract(input) {
      const result = await inner.extract(input);
      return {
        ...result,
        promptVersion: inner.promptVersion,
        schemaVersion: inner.schemaVersion,
      };
    },
  };
}

interface RunOptions {
  /** Varied between runs on purpose. None of it may reach the artifact. */
  slowdownMs?: number;
  onStage?: (record: StageRecord) => void;
}

function determinismRun(
  evidenceStore: EvidenceStorePort,
  claims: ReturnType<typeof memoryClaimStore>,
  options: RunOptions = {},
) {
  const base = packBackedProviders(WORLD, { officialSourceCoverage: 1 });
  const inner = {
    sourceDiscovery: base.sourceDiscovery,
    retrieval: {
      ...base.retrieval,
      /*
       * A different wall-clock cost on each run, which is the point: the
       * artifact must not notice. The compiler is timed against the *injected*
       * clock, so a slower run stamps identical timestamps.
       */
      async retrieve(request: Parameters<typeof base.retrieval.retrieve>[0]) {
        if (options.slowdownMs) {
          await new Promise((resolve) => setTimeout(resolve, options.slowdownMs));
        }
        return base.retrieval.retrieve(request);
      },
    },
    extraction: consistentExtraction(base.extraction),
  };

  const shared = withSharedEvidence(inner, {
    store: evidenceStore,
    now: () => NOW,
    pinnedHeaders: ['accept'],
  });

  const providers: CompilerProviders = {
    ...base,
    sourceDiscovery: shared.sourceDiscovery,
    retrieval: shared.retrieval,
    extraction: shared.extraction,
    claims: claims.store,
  };

  return compileRegion({
    // The same semantic inputs means the same artifact id: an id that varied
    // per run would make this test pass for the wrong reason.
    compilationId: 'determinism-region',
    scope: determinismScope(),
    dates: DATES,
    months: [8],
    providers,
    budget: AMPLE_BUDGET,
    now: NOW,
    ...(options.onStage ? { onStage: options.onStage } : {}),
  });
}

/** Canonical serialisation: key order fixed, so a diff is about values. */
function canonical(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

// ---------------------------------------------------------------------------

describe('one shared store, compiled cold then warm', () => {
  it('produces a byte-identical artifact and a different operational record', async () => {
    const evidenceStore = memoryEvidenceStore();
    const claims = memoryClaimStore();

    const cold = await determinismRun(evidenceStore, claims, { slowdownMs: 0 });
    expect(cold.ok, cold.ok ? '' : cold.message).toBe(true);
    if (!cold.ok) return;

    // The store is now full: documents, extractions, discovery records, claims.
    expect(claims.claims.size).toBeGreaterThan(0);

    const warm = await determinismRun(evidenceStore, claims, { slowdownMs: 12 });
    expect(warm.ok, warm.ok ? '' : warm.message).toBe(true);
    if (!warm.ok) return;

    /*
     * THE ASSERTION THIS FILE EXISTS FOR.
     *
     * Canonical serialisation rather than `JSON.stringify`, so a key-order
     * difference cannot pass as a value difference or vice versa.
     */
    expect(canonical(warm.region)).toBe(canonical(cold.region));

    /*
     * And the run genuinely was warm, so the equality above is not vacuous. If
     * the second build had bought everything again there would be nothing to
     * prove.
     */
    expect(warm.operational.sharedEvidence.claimsHeld).toBeGreaterThan(0);
    expect(cold.operational.sharedEvidence.claimsHeld).toBe(0);
    expect(warm.operational.budget.consumed.maxPagesFetched ?? 0).toBeLessThan(
      cold.operational.budget.consumed.maxPagesFetched ?? 0,
    );
    expect(warm.operational.budget.consumed.maxSourceSearches ?? 0).toBeLessThan(
      cold.operational.budget.consumed.maxSourceSearches ?? 0,
    );

    // The operational records differ; the artifacts do not.
    expect(canonical(warm.operational)).not.toBe(canonical(cold.operational));
  });

  it('keeps claim ids, board ids and the itinerary inputs stable across the two', async () => {
    const evidenceStore = memoryEvidenceStore();
    const claims = memoryClaimStore();

    const cold = await determinismRun(evidenceStore, claims);
    if (!cold.ok) throw new Error('the cold build must compile');
    const coldClaimIds = [...claims.claims.keys()].sort();

    const warm = await determinismRun(evidenceStore, claims);
    if (!warm.ok) throw new Error('the warm build must compile');

    /*
     * A claim id is what the claim *says*, not when it was said. A warm build
     * that minted new ids for claims it already held would be reuse that is not
     * idempotent — the store would grow without limit and the retention sweep's
     * protection, which looks for `fact-<claim id>`, would join to nothing.
     */
    expect([...claims.claims.keys()].sort()).toEqual(coldClaimIds);

    // The final board: the places a traveller chooses between, by identity.
    expect(warm.region.places.map((place) => place.id)).toEqual(
      cold.region.places.map((place) => place.id),
    );
    // Everything the deterministic planner reads to lay out a day.
    expect(warm.region.primaryBaseId).toBe(cold.region.primaryBaseId);
    expect(canonical(warm.region.travelTimes)).toBe(canonical(cold.region.travelTimes));
    expect(canonical(warm.region.basePortfolio)).toBe(canonical(cold.region.basePortfolio));
    expect(canonical(warm.region.operatingHours)).toBe(canonical(cold.region.operatingHours));
    expect(canonical(warm.region.access)).toBe(canonical(cold.region.access));
    expect(canonical(warm.region.coverage)).toBe(canonical(cold.region.coverage));
    // Source provenance is not a casualty of the split.
    expect(canonical(warm.region.sourceManifest.pages)).toBe(
      canonical(cold.region.sourceManifest.pages),
    );
    expect(canonical(warm.region.sourceManifest.facts)).toBe(
      canonical(cold.region.sourceManifest.facts),
    );
  });

  it('carries no operational field on the artifact at all', async () => {
    const evidenceStore = memoryEvidenceStore();
    const claims = memoryClaimStore();
    const result = await determinismRun(evidenceStore, claims);
    if (!result.ok) throw new Error('the build must compile');

    expect(result.region.diagnostics.budget).toBeUndefined();
    expect(result.region.diagnostics.stageCount).toBeUndefined();
    expect(result.region.diagnostics.stageTimings).toBeUndefined();
    for (const provider of result.region.sourceManifest.providers) {
      expect(provider.calls, provider.name).toBeUndefined();
      expect(provider.failures, provider.name).toBeUndefined();
    }

    /*
     * Serialised and searched as well as field-checked, because the failure
     * mode is a field somebody adds back later — and a string search catches
     * that where a property assertion does not. These are the five counters
     * `withSharedEvidenceCounters` used to fold in.
     */
    const serialised = JSON.stringify(result.region);
    for (const counter of [
      'claimsHeld',
      'claimsObserved',
      'claimsSuperseded',
      'subjectsAnsweredFromClaims',
      'sharedResolutionsReused',
      'maxSourceSearches',
      'maxPagesFetched',
    ]) {
      expect(serialised, `${counter} is operational and must not be on the artifact`).not.toContain(
        counter,
      );
    }

    // …and every one of them is on the envelope, where it is true.
    expect(result.operational.budget.limits.maxSourceSearches).toBe(
      AMPLE_BUDGET.maxSourceSearches,
    );
    expect(result.operational.stages.length).toBeGreaterThan(0);
    expect(result.operational.providers.length).toBeGreaterThan(0);
  });

  it('does not move when runner counters, retries or wall-clock durations do', async () => {
    /*
     * The three inputs the rule names, varied deliberately: a slower machine, a
     * different observation stream, and a run watched by something that counts.
     * A compilation nobody is watching and one somebody is instrumenting must
     * agree byte for byte.
     */
    const evidenceStore = memoryEvidenceStore();
    const claims = memoryClaimStore();

    const observed: StageRecord[] = [];
    const first = await determinismRun(evidenceStore, claims, {
      slowdownMs: 0,
      onStage: (record) => observed.push(record),
    });
    const second = await determinismRun(evidenceStore, claims, { slowdownMs: 25 });
    if (!first.ok || !second.ok) throw new Error('both builds must compile');

    expect(canonical(second.region)).toBe(canonical(first.region));

    // The observations did move, which is what makes the equality meaningful.
    expect(observed.length).toBeGreaterThan(0);
    const wallSpans = observed
      .filter((record) => record.observedStartedAt && record.observedFinishedAt)
      .map(
        (record) =>
          Date.parse(record.observedFinishedAt!) - Date.parse(record.observedStartedAt!),
      );
    expect(wallSpans.length).toBeGreaterThan(0);
    // And none of those real clock readings is anywhere in the artifact.
    expect(JSON.stringify(first.region)).not.toContain('observedStartedAt');
    expect(JSON.stringify(first.region)).not.toContain('observedFinishedAt');
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility: nothing is rewritten, nothing is rejected
// ---------------------------------------------------------------------------

describe('artifacts written before the split', () => {
  /**
   * An artifact carrying the folded-in counters must keep parsing and keep
   * rendering. A schema that rejected them would make every stored trip
   * compiled before this change un-openable, and a migration that rewrote them
   * would be editing somebody's stored plan to make a schema tidier.
   */
  it('still parse with their embedded reuse counters, unchanged', async () => {
    const evidenceStore = memoryEvidenceStore();
    const claims = memoryClaimStore();
    const result = await determinismRun(evidenceStore, claims);
    if (!result.ok) throw new Error('the build must compile');

    const historical = {
      ...result.region,
      sourceManifest: {
        ...result.region.sourceManifest,
        providers: result.region.sourceManifest.providers.map((provider) => ({
          ...provider,
          calls: 7,
          failures: 1,
        })),
      },
      diagnostics: {
        ...result.region.diagnostics,
        stageCount: 26,
        stageTimings: [{ stage: 'expanding_region' }, { stage: 'compiling' }],
        budget: {
          consumed: {
            maxSourceSearches: 11,
            maxPagesFetched: 30,
            // The five that used to be folded in from inside the compiler…
            claimsHeld: 41,
            claimsObserved: 12,
            claimsSuperseded: 0,
            subjectsAnsweredFromClaims: 9,
            sharedResolutionsReused: 74,
            // …and the ones the runner folded in from outside it.
            geocoderCacheHits: 3,
            evidenceReusePercent: 88,
          },
          limits: { maxSourceSearches: 12, maxPagesFetched: 40 },
          exhausted: ['maxPagesFetched'],
        },
      },
    };

    const parsed = compiledRegionSchema.safeParse(historical);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues[0])).toBe(true);
    if (!parsed.success) return;

    /*
     * Parsed *through* rather than dropped. `budget.consumed` is a permissive
     * `Record<string, number>` precisely so an unknown counter name survives —
     * anything rendering an old artifact's diagnostics reads the same numbers
     * it always did.
     */
    expect(parsed.data.diagnostics.budget?.consumed.sharedResolutionsReused).toBe(74);
    expect(parsed.data.diagnostics.budget?.exhausted).toEqual(['maxPagesFetched']);
    expect(parsed.data.diagnostics.stageCount).toBe(26);
    expect(parsed.data.sourceManifest.providers[0]?.calls).toBe(7);

    // And reading it changed nothing: no migration, no rewrite.
    expect(canonical(parsed.data)).toBe(canonical(historical));
  });
});
