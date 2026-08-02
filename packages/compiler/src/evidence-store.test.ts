import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_STORE_VERSION,
  type CanonicalSource,
  type DocumentVersion,
  type ExtractionVersion,
  type RetrievalObservation,
  type SourceDiscoveryRecord,
} from '@sidequest/core';
import { withSharedEvidence, type EvidenceStorePort, type OperationClaim } from './evidence-store';
import type {
  ExtractedClaim,
  FactExtractionProvider,
  ResearchSubject,
  RetrievedDocument,
  SourceDiscoveryProvider,
  SourceRetrievalProvider,
} from './providers';

/**
 * THE SHARED EVIDENCE LAYER, OFFLINE.
 *
 * Every case here is one the phase exists to get right and none of them can be
 * produced with a real network in a unit test: a server that returns 304 forever,
 * a page whose bytes change while its ETag does not, a prompt version moving
 * under an unchanged page, two builds racing for one URL.
 *
 * So the store is in memory and the providers are counters. What is being tested
 * is the *decisions* — which is where all the risk is.
 */

// ---------------------------------------------------------------------------
// An in-memory store with the same contract as the database one
// ---------------------------------------------------------------------------

function memoryStore(): EvidenceStorePort & {
  documents: Map<string, DocumentVersion>;
  observations: RetrievalObservation[];
  extractions: Map<string, ExtractionVersion>;
} {
  const discovery = new Map<string, SourceDiscoveryRecord>();
  const sources = new Map<string, CanonicalSource>();
  const documents = new Map<string, DocumentVersion>();
  const extractions = new Map<string, ExtractionVersion>();
  const operations = new Map<string, { id: string; startedAt: string; state: string }>();
  const observations: RetrievalObservation[] = [];

  return {
    documents,
    observations,
    extractions,
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
      const merged = existing ? { ...existing, ...source, firstSeenAt: existing.firstSeenAt } : source;
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
    recordRetrieval(observation) {
      observations.push(observation);
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

// ---------------------------------------------------------------------------
// Counting providers
// ---------------------------------------------------------------------------

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

interface Counters {
  searches: number;
  fetches: number;
  extractions: number;
}

function subject(
  id: string,
  name = 'Harbour Museum',
  wantedPaths: ResearchSubject['wantedPaths'] = ['hours.weekly', 'cost.admission'],
): ResearchSubject {
  return {
    id,
    name,
    kind: 'museum',
    locality: 'Harbourside',
    coordinates: { lat: 50.1234, lng: -3.4567 },
    wantedPaths,
  };
}

/**
 * A subject whose questions are all slow-changing, so its content revalidation
 * window is 72 hours. That is what makes the robots window — 24 hours — testable
 * on its own: between the two there is a span where the content needs nothing
 * and the permission needs rechecking.
 */
const SLOW_PATHS: ResearchSubject['wantedPaths'] = ['identity.officialSite', 'access.method'];

function providers(counters: Counters, options: {
  contentHash?: string;
  etag?: string;
  vary?: string;
  notModified?: boolean;
  promptVersion?: string;
  schemaVersion?: string;
  modelId?: string;
} = {}) {
  const sourceDiscovery: SourceDiscoveryProvider = {
    name: 'test-discovery',
    version: 'test/1',
    async discover({ subjects }) {
      counters.searches += subjects.length;
      return {
        references: subjects.map((entry) => ({
          subjectId: entry.id,
          url: 'https://museum.example/visit',
          expectedAuthority: 'operator' as const,
          discoveredVia: 'search',
        })),
        gaps: [],
        calls: 1,
        searches: subjects.length,
      };
    },
  };

  const retrieval: SourceRetrievalProvider = {
    name: 'test-retrieval',
    async retrieve({ references }) {
      const documents: RetrievedDocument[] = [];
      const unchanged: NonNullable<Awaited<ReturnType<SourceRetrievalProvider['retrieve']>>['unchanged']> = [];
      for (const reference of references) {
        counters.fetches += 1;
        if (options.notModified && reference.conditional?.etag) {
          unchanged.push({
            url: reference.url,
            subjectId: reference.subjectId,
            validators: { etag: reference.conditional.etag, weakEtag: false },
            bytesAvoided: 4096,
          });
          continue;
        }
        documents.push({
          subjectId: reference.subjectId,
          url: reference.url,
          text: 'Open Monday to Friday, 09:00 to 17:00.',
          structuredData: [],
          contentHash: options.contentHash ?? DIGEST_A,
          contentBytes: 4096,
          retrievedAt: '2026-08-01T00:00:00.000Z',
          robotsAllowed: true,
          authority: 'operator',
          publisher: 'museum.example',
          domain: 'museum.example',
          validators: {
            ...(options.etag ? { etag: options.etag } : {}),
            weakEtag: false,
            ...(options.vary ? { vary: options.vary } : {}),
          },
          truncated: false,
        });
      }
      return { documents, unchanged, rejected: [], gaps: [], bytes: documents.length * 4096 };
    },
  };

  const extraction: FactExtractionProvider = {
    name: 'test-extraction',
    promptVersion: options.promptVersion ?? 'prompt/1',
    schemaVersion: options.schemaVersion ?? 'schema/1',
    modelId: options.modelId ?? 'model/1',
    async extract({ documents }) {
      counters.extractions += 1;
      const claims: ExtractedClaim[] = documents.map((document, index) => ({
        subjectId: document.subjectId,
        documentIndex: index,
        factPath: 'hours.weekly' as const,
        statement: 'Open Monday to Friday, 09:00 to 17:00.',
        evidenceExcerpt: 'Open Monday to Friday, 09:00 to 17:00.',
        derivation: 'directly_stated' as const,
      }));
      return {
        claims,
        unanswered: [],
        gaps: [],
        calls: 1,
        promptVersion: options.promptVersion ?? 'prompt/1',
        schemaVersion: options.schemaVersion ?? 'schema/1',
        modelId: options.modelId ?? 'model/1',
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      };
    },
  };

  return { sourceDiscovery, retrieval, extraction };
}

const PINNED = ['accept', 'accept-encoding', 'user-agent'];

async function runOnce(
  store: EvidenceStorePort,
  counters: Counters,
  options: Parameters<typeof providers>[1] = {},
  at = '2026-08-02T12:00:00.000Z',
  subjects: ResearchSubject[] = [subject('place-1')],
) {
  const layer = withSharedEvidence(providers(counters, options), {
    store,
    now: () => new Date(at),
    pinnedHeaders: PINNED,
  });

  const discovered = await layer.sourceDiscovery.discover({
    scope: {} as never,
    subjects,
    maxSearches: 5,
    maxReferencesPerSubject: 2,
  });

  const retrieved = await layer.retrieval.retrieve({
    references: discovered.references,
    maxPages: 10,
    maxBytes: 1_000_000,
    deadlineMs: Date.now() + 10_000,
  });

  const extracted = await layer.extraction.extract({
    subjects,
    documents: retrieved.documents,
    dates: ['2026-09-10'],
    maxCalls: 5,
  });

  return { layer, discovered, retrieved, extracted };
}

// ---------------------------------------------------------------------------

describe('a cold run followed by an immediate warm run', () => {
  it('buys nothing the second time', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };

    const cold = await runOnce(store, counters, { etag: '"v1"' });
    expect(counters).toEqual({ searches: 1, fetches: 1, extractions: 1 });
    expect(cold.extracted.claims).toHaveLength(1);

    const warm = await runOnce(store, counters, { etag: '"v1"' });
    // No new search, no new request, no new extraction.
    expect(counters).toEqual({ searches: 1, fetches: 1, extractions: 1 });
    expect(warm.extracted.claims).toHaveLength(1);
    expect(warm.layer.metrics.documentsReused).toBe(1);
    expect(warm.layer.metrics.extractionsReused).toBe(1);
    expect(warm.layer.metrics.modelCallsAvoided).toBe(1);
  });

  it('reuses one trip’s research for a different trip’s ids', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };

    await runOnce(store, counters, {}, '2026-08-02T12:00:00.000Z', [subject('trip-a-place-7')]);
    expect(counters.extractions).toBe(1);

    /**
     * A different trip, a different local id, the same museum. This is the whole
     * point of the phase: evidence is keyed on what a place *is*, not on which
     * compilation happened to find it.
     */
    const second = await runOnce(store, counters, {}, '2026-08-02T12:05:00.000Z', [
      subject('trip-b-place-42'),
    ]);
    expect(counters).toEqual({ searches: 1, fetches: 1, extractions: 1 });
    expect(second.extracted.claims[0]?.subjectId).toBe('trip-b-place-42');
  });
});

describe('conditional revalidation', () => {
  it('sends validators once the freshness window has passed, and transfers nothing', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z');

    // Two days later: past the revalidate window, inside the re-read window.
    const warm = await runOnce(store, counters, { etag: '"v1"', notModified: true }, '2026-08-04T12:00:00.000Z');
    expect(warm.layer.metrics.documentsRevalidated).toBe(1);
    expect(warm.layer.metrics.documentsFetched).toBe(0);
    expect(warm.layer.metrics.bytesTransferred).toBe(0);
    expect(counters.extractions).toBe(1);
  });

  it('never lets a 304 make the content look newer than it is', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z');
    const before = [...store.documents.values()][0]!;

    await runOnce(store, counters, { etag: '"v1"', notModified: true }, '2026-08-04T12:00:00.000Z');
    const after = [...store.documents.values()][0]!;

    // The check advanced. The observation did not — which is the rule that stops
    // a nightly revalidation keeping a lifted closure alive forever.
    expect(after.lastCheckedAt).not.toBe(before.lastCheckedAt);
    expect(after.contentObservedAt).toBe(before.contentObservedAt);
  });

  it('re-reads in full once a document outlives its class window, whatever the ETag says', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { etag: '"never-changes"' }, '2026-08-02T12:00:00.000Z');

    // Well past the moderate class's 45-day full-re-read window.
    const later = await runOnce(store, counters, { etag: '"never-changes"' }, '2026-11-02T12:00:00.000Z');
    expect(later.layer.metrics.documentsFetched).toBe(1);
  });
});

describe('changed content', () => {
  it('creates a new version rather than rewriting history, and re-extracts', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { contentHash: DIGEST_A }, '2026-08-02T12:00:00.000Z');
    expect(store.documents.size).toBe(1);

    await runOnce(store, counters, { contentHash: DIGEST_B }, '2026-11-02T12:00:00.000Z');
    expect(store.documents.size).toBe(2);
    expect(counters.extractions).toBe(2);

    const digests = [...store.documents.values()].map((document) => document.contentDigest).sort();
    expect(digests).toEqual([`sha256:${DIGEST_A}`, `sha256:${DIGEST_B}`]);
  });
});

describe('invalidation is surgical', () => {
  const cases: { label: string; change: Parameters<typeof providers>[1] }[] = [
    { label: 'a new prompt version', change: { promptVersion: 'prompt/2' } },
    { label: 'a new schema version', change: { schemaVersion: 'schema/2' } },
    { label: 'a different model', change: { modelId: 'model/2' } },
  ];

  for (const { label, change } of cases) {
    it(`${label} re-extracts without re-fetching`, async () => {
      const store = memoryStore();
      const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
      await runOnce(store, counters);
      expect(counters).toEqual({ searches: 1, fetches: 1, extractions: 1 });

      const rolled = await runOnce(store, counters, change);
      // The extraction contract moved; the page did not.
      expect(counters.extractions).toBe(2);
      expect(counters.fetches).toBe(1);
      expect(counters.searches).toBe(1);
      expect(rolled.layer.metrics.documentsReused).toBe(1);
    });
  }

  it('a new discovery provider version re-searches without re-reading anything else', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters);

    const rolled = withSharedEvidence(
      {
        ...providers(counters),
        sourceDiscovery: { ...providers(counters).sourceDiscovery, version: 'test/2' },
      },
      { store, now: () => new Date('2026-08-02T12:00:00.000Z'), pinnedHeaders: PINNED },
    );
    await rolled.sourceDiscovery.discover({
      scope: {} as never,
      subjects: [subject('place-1')],
      maxSearches: 5,
      maxReferencesPerSubject: 2,
    });
    expect(counters.searches).toBe(2);
    expect(counters.fetches).toBe(1);
  });
});

describe('Vary', () => {
  it('refuses to reuse a representation negotiated on a header we do not send', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { vary: 'Accept-Language' });
    const warm = await runOnce(store, counters, { vary: 'Accept-Language' });
    expect(warm.layer.metrics.documentsReused).toBe(0);
    expect(counters.fetches).toBe(2);
  });

  it('reuses one that varies only on headers we pin', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { vary: 'Accept-Encoding' });
    const warm = await runOnce(store, counters, { vary: 'Accept-Encoding' });
    expect(warm.layer.metrics.documentsReused).toBe(1);
    expect(counters.fetches).toBe(1);
  });
});

describe('negative results', () => {
  it('remembers "nobody publishes this" without re-buying the search', async () => {
    const store = memoryStore();
    let searches = 0;
    const empty: SourceDiscoveryProvider = {
      name: 'empty',
      version: 'v1',
      async discover({ subjects }) {
        searches += 1;
        return {
          references: [],
          gaps: subjects.map((entry) => ({
            subjectId: entry.id,
            reason: 'no_official_source' as const,
            detail: 'nothing found',
          })),
          calls: 1,
          searches: 1,
        };
      },
    };
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const base = providers(counters);

    const build = () =>
      withSharedEvidence(
        { ...base, sourceDiscovery: empty },
        { store, now: () => new Date('2026-08-02T12:00:00.000Z'), pinnedHeaders: PINNED },
      );

    const first = await build().sourceDiscovery.discover({
      scope: {} as never,
      subjects: [subject('place-1')],
      maxSearches: 5,
      maxReferencesPerSubject: 2,
    });
    expect(first.gaps).toHaveLength(1);

    const second = await build().sourceDiscovery.discover({
      scope: {} as never,
      subjects: [subject('place-1')],
      maxSearches: 5,
      maxReferencesPerSubject: 2,
    });
    expect(searches).toBe(1);
    // A remembered absence is still reported as an absence, never softened.
    expect(second.gaps).toHaveLength(1);
    expect(second.gaps[0]?.reason).toBe('no_official_source');
  });

  it('gives a provider outage a short memory rather than a long one', async () => {
    const store = memoryStore();
    let calls = 0;
    const flaky: SourceDiscoveryProvider = {
      name: 'flaky',
      version: 'v1',
      async discover() {
        calls += 1;
        return {
          references: [],
          gaps: [
            { subjectId: 'source-discovery', reason: 'provider_error' as const, detail: 'down' },
          ],
          calls: 0,
          searches: 0,
        };
      },
    };
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const base = providers(counters);

    const run = (at: string) =>
      withSharedEvidence(
        { ...base, sourceDiscovery: flaky },
        { store, now: () => new Date(at), pinnedHeaders: PINNED },
      ).sourceDiscovery.discover({
        scope: {} as never,
        subjects: [subject('place-1')],
        maxSearches: 5,
        maxReferencesPerSubject: 2,
      });

    await run('2026-08-02T12:00:00.000Z');
    await run('2026-08-02T12:01:00.000Z');
    expect(calls).toBe(1); // inside the transient window

    await run('2026-08-02T12:30:00.000Z');
    expect(calls).toBe(2); // an outage is not evidence about the world
  });
});

describe('the ledger', () => {
  it('reports what was avoided without claiming anything about quality', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters);
    const warm = await runOnce(store, counters);

    expect(warm.layer.metrics.bytesTransferred).toBe(0);
    expect(warm.layer.metrics.bytesAvoided).toBeGreaterThan(0);
    const plan = warm.layer.workPlan();
    expect(plan.map((entry) => entry.step)).toContain('retrieving_pages');
    expect(plan.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('carries the content clock into the facts, not the check clock', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z');
    const warm = await runOnce(store, counters, { etag: '"v1"', notModified: true }, '2026-08-04T12:00:00.000Z');

    /**
     * The fact still carries the moment the *content* was read, two days ago,
     * not the moment the 304 came back this morning. A fact stamped with today's
     * date because a server said "unchanged" would be a fact claiming a
     * freshness nobody established.
     */
    expect(warm.retrieved.documents[0]?.retrievedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(warm.layer.metrics.documentsRevalidated).toBe(1);
  });
});

describe('two builds racing for one page', () => {
  it('makes the second adopt the first’s result rather than paying for it again', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };

    /**
     * A peer that has claimed the URL and already written a document — which is
     * the state a second compilation of the same city finds itself in seconds
     * after the first one starts.
     */
    await runOnce(store, counters);
    const held = [...store.documents.values()][0]!;
    store.claimOperation(`retrieve:${'x'}`, new Date());

    // Force the "somebody else is reading this" branch by claiming the real key.
    const canonicalKey = [...store.documents.keys()][0]!;
    expect(canonicalKey).toContain('sha256:');
    expect(held.representation.bytes).toBeGreaterThan(0);

    // A far-future run: past every window, so it would otherwise re-fetch.
    const peerStore: EvidenceStorePort = {
      ...store,
      claimOperation: () => ({ kind: 'in_progress', id: 'peer', startedAt: 'now' }),
    };
    const layer = withSharedEvidence(providers(counters), {
      store: peerStore,
      now: () => new Date('2027-08-02T12:00:00.000Z'),
      pinnedHeaders: PINNED,
      peerWaitMs: 10,
    });
    const discovered = await layer.sourceDiscovery.discover({
      scope: {} as never,
      subjects: [subject('place-1')],
      maxSearches: 5,
      maxReferencesPerSubject: 2,
    });
    const before = counters.fetches;
    const retrieved = await layer.retrieval.retrieve({
      references: discovered.references,
      maxPages: 10,
      maxBytes: 1_000_000,
      deadlineMs: Date.now() + 10_000,
    });

    expect(counters.fetches).toBe(before);
    expect(layer.metrics.operationsAdopted).toBe(1);
    expect(retrieved.documents).toHaveLength(1);
  });

  it('does the work itself when the peer produced nothing usable', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const blocked: EvidenceStorePort = {
      ...store,
      claimOperation: () => ({ kind: 'in_progress', id: 'peer', startedAt: 'now' }),
    };
    const layer = withSharedEvidence(providers(counters), {
      store: blocked,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      pinnedHeaders: PINNED,
      peerWaitMs: 10,
    });
    const discovered = await layer.sourceDiscovery.discover({
      scope: {} as never,
      subjects: [subject('place-1')],
      maxSearches: 5,
      maxReferencesPerSubject: 2,
    });
    const retrieved = await layer.retrieval.retrieve({
      references: discovered.references,
      maxPages: 10,
      maxBytes: 1_000_000,
      deadlineMs: Date.now() + 10_000,
    });
    // A stalled peer costs a duplicate call, never a failed compilation.
    expect(retrieved.documents).toHaveLength(1);
    expect(counters.fetches).toBe(1);
  });
});

describe('one page serving several subjects', () => {
  it('gives every subject its document, not just the last one', async () => {
    /**
     * A park authority page covering two trails, a museum complex listing two
     * wings. Keying held documents on the URL alone made the last subject
     * overwrite the others, and every subject but one silently lost its
     * document — not fetched, not reused, just gone.
     */
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const subjects = [subject('trail-a', 'Summit Trail'), subject('trail-b', 'Valley Trail')];

    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z', subjects);

    // Two days later: past the revalidate window, so both go conditional.
    const warm = await runOnce(
      store,
      counters,
      { etag: '"v1"', notModified: true },
      '2026-08-04T12:00:00.000Z',
      subjects,
    );

    expect(warm.retrieved.documents).toHaveLength(2);
    expect(warm.retrieved.documents.map((document) => document.subjectId).sort()).toEqual([
      'trail-a',
      'trail-b',
    ]);
    expect(warm.layer.metrics.documentsRevalidated).toBe(2);
  });
});

describe('permission has its own clock', () => {
  /**
   * Two clocks govern reuse-without-a-request, and they are not the same clock.
   * A page can be byte-identical for a year while its site adds a `Disallow`
   * this morning; reusing on content freshness alone would never find out.
   */
  it('reuses outright while both the content and the permission are fresh', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const slow = [subject('place-1', 'Harbour Museum', SLOW_PATHS)];
    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z', slow);

    /**
     * The control for the test below: same subject, same held page, twenty hours
     * on — inside *both* windows. This reuses without asking anything, which is
     * what makes the next test's extra request attributable to the robots clock
     * and nothing else.
     */
    const warm = await runOnce(
      store,
      counters,
      { etag: '"v1"' },
      '2026-08-03T08:00:00.000Z',
      slow,
    );
    expect(warm.layer.metrics.documentsReused).toBe(1);
    expect(counters.fetches).toBe(1); // still just the cold run's request
  });

  it('rechecks before reusing once the robots verdict has gone stale', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    const slow = [subject('place-1', 'Harbour Museum', SLOW_PATHS)];
    await runOnce(store, counters, { etag: '"v1"' }, '2026-08-02T12:00:00.000Z', slow);

    /**
     * Thirty hours later, and the window either side of that is the whole point:
     * these are slow-changing questions, so the content is not due for a recheck
     * for another forty-two hours — but the permission verdict expired six hours
     * ago. Without its own clock this would reuse silently, and a site that had
     * added a `Disallow` overnight would keep being read.
     */
    const warm = await runOnce(
      store,
      counters,
      { etag: '"v1"', notModified: true },
      '2026-08-03T18:00:00.000Z',
      slow,
    );
    expect(warm.layer.metrics.documentsReused).toBe(0);
    expect(warm.layer.metrics.documentsRevalidated).toBe(1);
    // A conditional request, not a full re-read: nothing was transferred.
    expect(warm.layer.metrics.bytesTransferred).toBe(0);
    // And it cost no model call, because the content never changed.
    expect(counters.extractions).toBe(1);
  });
});

describe('what a stored token count is a count of', () => {
  it('labels a single-document call as measured', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };
    await runOnce(store, counters, {}, '2026-08-02T12:00:00.000Z', [subject('place-1')]);

    const stored = [...store.extractions.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokens?.basis).toBe('measured');
  });

  it('never presents one call’s tokens as each document’s share of it', async () => {
    const store = memoryStore();
    const counters: Counters = { searches: 0, fetches: 0, extractions: 0 };

    /**
     * Two subjects, two documents, one extraction call. Dividing that call's
     * tokens by two and storing the halves would read like a measurement of each
     * page and be nothing of the kind. The row says what it is instead.
     */
    await runOnce(store, counters, {}, '2026-08-02T12:00:00.000Z', [
      subject('place-1', 'Harbour Museum'),
      subject('place-2', 'Harbour Gallery'),
    ]);

    const stored = [...store.extractions.values()];
    expect(stored.length).toBeGreaterThan(1);
    for (const extraction of stored) {
      expect(extraction.tokens?.basis).toBe('batch_total');
      expect(extraction.tokens?.batchDocuments).toBe(stored.length);
      // The whole call's numbers, unapportioned, on every row it covered.
      expect(extraction.tokens?.input).toBe(1000);
    }
  });
});
