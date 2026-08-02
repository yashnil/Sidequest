import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVIDENCE_STORE_VERSION, type DocumentVersion } from '@sidequest/core';
import { getDb } from './client';
import {
  claimOperation,
  completeOperation,
  findClaims,
  findFactSets,
  markClaimsSuperseded,
  saveFactSets,
  evidenceStoreNeedsSweep,
  evidenceStoreSize,
  findDiscovery,
  findExtraction,
  findExtractionAttempt,
  findLatestDocument,
  findSourceByCanonicalUrl,
  getDocument,
  recordRetrieval,
  recordRevalidation,
  saveClaims,
  saveDiscovery,
  saveDocument,
  saveExtraction,
  sweepEvidenceStore,
  upsertSource,
} from './evidence-repository';

/**
 * THE STORE, AGAINST A REAL DATABASE.
 *
 * `evidence-store.test.ts` proves the *decisions*; this proves the storage
 * promises those decisions rest on — immutability, coalescing, degradation on a
 * corrupted row, and a sweep that cannot remove evidence somebody is still
 * pointing at.
 */

let directory: string;
const NOW = new Date('2026-08-02T12:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-evidence-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'evidence.db');
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function source(url = 'https://museum.example/visit') {
  return upsertSource({
    schemaVersion: EVIDENCE_STORE_VERSION,
    id: `src-museum-${url.length}`,
    submittedUrl: url,
    canonicalUrl: url,
    origin: 'https://museum.example',
    host: 'museum.example',
    publisher: 'museum.example',
    authority: 'operator',
    redirectChain: [],
    identityWarnings: [],
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    relations: [],
  });
}

function documentFor(sourceId: string, digest = DIGEST, observedAt = '2026-08-01T00:00:00.000Z'): DocumentVersion {
  return {
    schemaVersion: EVIDENCE_STORE_VERSION,
    id: `${sourceId}@${digest}`,
    sourceId,
    contentDigest: digest,
    representation: {
      text: 'Open daily.',
      structuredData: [],
      truncated: false,
      mimeType: 'text/html',
      bytes: 4096,
    },
    status: 200,
    validators: { weak: false, etag: '"v1"' },
    contentObservedAt: observedAt,
    lastCheckedAt: observedAt,
    robotsAllowed: true,
    safetyDiagnostics: [],
    retrievalVersion: 'retrieval/1',
  };
}

describe('sources', () => {
  it('merges a later sighting into an existing identity rather than replacing it', () => {
    const first = source();
    const second = upsertSource({
      ...first,
      lastSeenAt: '2026-08-05T00:00:00.000Z',
      firstSeenAt: '2026-08-05T00:00:00.000Z',
      relations: [{ relation: 'content_mirror', otherSourceId: 'src-other' }],
    });
    // First seen never moves forward: a later sighting is new information about
    // an existing identity, not a new identity.
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.lastSeenAt).toBe('2026-08-05T00:00:00.000Z');
    expect(second.relations).toHaveLength(1);
    expect(findSourceByCanonicalUrl(first.canonicalUrl)?.id).toBe(first.id);
  });
});

describe('document versions', () => {
  it('never lets a re-read of unchanged content move the observation clock', () => {
    const src = source();
    saveDocument(documentFor(src.id));
    const again = saveDocument({
      ...documentFor(src.id),
      contentObservedAt: '2026-08-09T00:00:00.000Z',
      lastCheckedAt: '2026-08-09T00:00:00.000Z',
    });
    // The bytes are the same, so the evidence is the same age. Anything else
    // would let a nightly re-read make a year-old page look like this morning's.
    expect(again.contentObservedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('keeps two versions apart when the content differs', () => {
    const src = source();
    saveDocument(documentFor(src.id, DIGEST, '2026-08-01T00:00:00.000Z'));
    saveDocument(documentFor(src.id, `sha256:${'b'.repeat(64)}`, '2026-08-06T00:00:00.000Z'));
    const latest = findLatestDocument(src.id);
    expect(latest?.contentDigest).toBe(`sha256:${'b'.repeat(64)}`);
    // History survives: an artifact built last week still points at what built it.
    expect(getDocument(`${src.id}@${DIGEST}`)).not.toBeNull();
  });

  it('advances only the check clock on a revalidation', () => {
    const src = source();
    const stored = saveDocument(documentFor(src.id));
    const revalidated = recordRevalidation({
      documentVersionId: stored.id,
      checkedAt: '2026-08-08T00:00:00.000Z',
      validators: { etag: '"v1-refreshed"' },
    });
    expect(revalidated?.lastCheckedAt).toBe('2026-08-08T00:00:00.000Z');
    expect(revalidated?.contentObservedAt).toBe(stored.contentObservedAt);
    expect(revalidated?.validators.etag).toBe('"v1-refreshed"');
  });

  it('ignores a digest whose algorithm this build cannot verify', () => {
    const src = source();
    saveDocument(documentFor(src.id, 'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    // Unusable means "read it again", never "it matches" and never "it does not".
    expect(findLatestDocument(src.id)).toBeNull();
  });
});

describe('extractions', () => {
  it('never serves a failure as an answer, and lets a later success replace it', () => {
    const inputs = {
      operation: 'planning-facts',
      contentDigests: [DIGEST],
      schemaVersion: 'schema/1',
      promptVersion: 'prompt/1',
      modelId: 'model/1',
      parserVersion: 'parser/1',
      wantedPaths: ['hours.weekly' as const],
    };
    saveExtraction({
      schemaVersion: EVIDENCE_STORE_VERSION,
      key: 'k1',
      inputs,
      status: 'invalid_output',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, basis: 'measured', batchDocuments: 1 },
      attempts: 1,
      diagnostics: ['The model returned a shape we could not read.'],
      createdAt: NOW.toISOString(),
    });
    expect(findExtraction('k1')).toBeNull();
    // Kept, so a retry storm is visible and bounded.
    expect(findExtractionAttempt('k1')?.status).toBe('invalid_output');

    saveExtraction({
      schemaVersion: EVIDENCE_STORE_VERSION,
      key: 'k1',
      inputs,
      status: 'succeeded',
      output: [{ factPath: 'hours.weekly', statement: 'Open daily.' }],
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, basis: 'measured', batchDocuments: 1 },
      attempts: 2,
      diagnostics: [],
      createdAt: NOW.toISOString(),
    });
    // Failing closed must not mean failing forever.
    expect(findExtraction('k1')?.status).toBe('succeeded');
  });
});

describe('discovery', () => {
  it('gives an outage a short memory and an absence a long one', () => {
    saveDiscovery({
      now: NOW,
      record: {
        key: 'outage',
        outcome: 'provider_unavailable',
        references: [],
        provider: 'p',
        providerVersion: 'v1',
        discoveredAt: NOW.toISOString(),
        searches: 0,
      },
    });
    saveDiscovery({
      now: NOW,
      record: {
        key: 'absent',
        outcome: 'no_source_found',
        references: [],
        provider: 'p',
        providerVersion: 'v1',
        discoveredAt: NOW.toISOString(),
        searches: 1,
      },
    });

    const later = new Date(NOW.getTime() + 30 * 60_000);
    // Caching an outage as "nobody publishes this" would turn a five-minute
    // incident into a permanent hole in a destination's coverage.
    expect(findDiscovery('outage', later)).toBeNull();
    expect(findDiscovery('absent', later)?.outcome).toBe('no_source_found');
  });

  it('treats a row that will not parse as absent rather than as an error', () => {
    getDb()
      .prepare(
        `INSERT INTO evidence_discovery (key, outcome, provider, payload_json, discovered_at, expires_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('broken', 'found', 'p', 'not json', NOW.toISOString(), '2030-01-01T00:00:00.000Z');
    expect(findDiscovery('broken', NOW)).toBeNull();
    // And it is swept on the way past, so it stops costing a parse every read.
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM evidence_discovery WHERE key = ?')
      .get('broken') as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe('operation coalescing', () => {
  it('gives the operation to one caller and tells the other to wait', () => {
    const first = claimOperation('retrieve:abc', NOW);
    const second = claimOperation('retrieve:abc', NOW);
    expect(first.kind).toBe('claimed');
    expect(second.kind).toBe('in_progress');
  });

  it('releases the key once the holder finishes', () => {
    const first = claimOperation('retrieve:abc', NOW);
    if (first.kind !== 'claimed') throw new Error('expected a claim');
    completeOperation({ id: first.id, now: NOW, state: 'done' });
    expect(claimOperation('retrieve:abc', NOW).kind).toBe('claimed');
  });

  it('reclaims a claim whose process stopped answering', () => {
    claimOperation('retrieve:abc', NOW);
    const muchLater = new Date(NOW.getTime() + 120_000);
    // A killed process must not wedge a URL forever.
    expect(claimOperation('retrieve:abc', muchLater).kind).toBe('claimed');
  });
});

function claimFixture(sourceId: string, documentVersionId: string) {
  return {
    schemaVersion: EVIDENCE_STORE_VERSION,
    id: 'clm-fixture',
    subjectKey: 'subj:geo:harbour-museum@50.1234,-3.4567',
    factPath: 'hours.weekly' as const,
    statement: 'Open daily.',
    origin: 'model_extraction' as const,
    sourceId,
    documentVersionId,
    contentDigest: DIGEST,
    authorityKind: 'operator' as const,
    authorityName: 'museum.example',
    derivation: 'directly_stated' as const,
    contentObservedAt: '2026-08-01T00:00:00.000Z',
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    superseded: false,
  };
}

describe('the sweep', () => {
  function seed(): void {
    const src = source();
    saveDocument(documentFor(src.id, DIGEST, '2026-08-01T00:00:00.000Z'));
    saveDocument(documentFor(src.id, `sha256:${'b'.repeat(64)}`, '2026-08-02T00:00:00.000Z'));
    saveDocument(documentFor(src.id, `sha256:${'c'.repeat(64)}`, '2026-08-03T00:00:00.000Z'));
    recordRetrieval({
      sourceId: src.id,
      kind: 'fetched',
      status: 200,
      observedAt: NOW.toISOString(),
      bytes: 4096,
      bytesAvoided: 0,
    });
  }

  it('reports what it would remove without removing it', () => {
    seed();
    const before = evidenceStoreSize();
    const plan = sweepEvidenceStore({ dryRun: true, now: NOW });
    expect(plan.documentsSuperseded).toBe(1);
    expect(evidenceStoreSize()).toEqual(before);
  });

  it('never removes a document version a claim still points at', () => {
    const src = source();
    const oldest = saveDocument(documentFor(src.id, DIGEST, '2026-08-01T00:00:00.000Z'));
    saveDocument(documentFor(src.id, `sha256:${'b'.repeat(64)}`, '2026-08-02T00:00:00.000Z'));
    saveDocument(documentFor(src.id, `sha256:${'c'.repeat(64)}`, '2026-08-03T00:00:00.000Z'));

    saveClaims([
      {
        schemaVersion: EVIDENCE_STORE_VERSION,
        id: 'claim-1',
        subjectKey: 'subj:geo:museum@1.0000,2.0000',
        factPath: 'hours.weekly',
        statement: 'Open daily.',
        origin: 'deterministic_parse',
        sourceId: src.id,
        documentVersionId: oldest.id,
        contentDigest: DIGEST,
        authorityKind: 'operator',
        authorityName: 'museum.example',
        derivation: 'directly_stated',
        contentObservedAt: '2026-08-01T00:00:00.000Z',
        firstSeenAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
        superseded: false,
      },
    ]);

    sweepEvidenceStore({ dryRun: false, now: NOW });
    // The version behind a fact somebody can read survives the keep-count.
    expect(getDocument(oldest.id)).not.toBeNull();
  });

  it('removes a superseded version nothing refers to', () => {
    seed();
    sweepEvidenceStore({ dryRun: false, now: NOW });
    expect(getDocument(`${source().id}@${DIGEST}`)).toBeNull();
  });

  it('protects a claim a stored plan quotes, however old it is', () => {
    const src = source();
    const document = saveDocument(documentFor(src.id));
    saveClaims([
      {
        ...claimFixture(src.id, document.id),
        id: 'clm-quoted',
        superseded: true,
        lastSeenAt: '2025-01-01T00:00:00.000Z',
      },
      {
        ...claimFixture(src.id, document.id),
        id: 'clm-forgotten',
        superseded: true,
        lastSeenAt: '2025-01-01T00:00:00.000Z',
      },
    ]);
    // An artifact names one of them. A stored plan carries its own copy of every
    // fact, so removing a claim cannot break it — what it breaks is tracing a
    // fact on somebody's itinerary back to the page behind it.
    getDb()
      .prepare('INSERT INTO compiled_region_claims (compiled_region_id, claim_id) VALUES (?, ?)')
      .run('region-1', 'clm-quoted');

    const plan = sweepEvidenceStore({ dryRun: true, now: NOW });
    expect(plan.claimsSuperseded).toBe(1);

    sweepEvidenceStore({ dryRun: false, now: NOW });
    const remaining = findClaims(claimFixture(src.id, document.id).subjectKey).map(
      (claim) => claim.id,
    );
    expect(remaining).toEqual(['clm-quoted']);
  });

  it('keeps a live claim whatever its age', () => {
    const src = source();
    const document = saveDocument(documentFor(src.id));
    saveClaims([
      { ...claimFixture(src.id, document.id), id: 'clm-live', lastSeenAt: '2024-01-01T00:00:00.000Z' },
    ]);
    const plan = sweepEvidenceStore({ dryRun: true, now: NOW });
    // Live evidence is current evidence. Only a replaced claim is a candidate.
    expect(plan.claimsSuperseded).toBe(0);
  });

  it('marks a replaced claim rather than deleting it', () => {
    const src = source();
    const document = saveDocument(documentFor(src.id));
    saveClaims([{ ...claimFixture(src.id, document.id), id: 'clm-old' }]);
    expect(markClaimsSuperseded(['clm-old'], NOW)).toBe(1);

    const stored = findClaims(claimFixture(src.id, document.id).subjectKey);
    expect(stored).toHaveLength(1);
    // Still there, still explicable, and out of resolution.
    expect(stored[0]!.superseded).toBe(true);
    // Superseding twice is not a second event.
    expect(markClaimsSuperseded(['clm-old'], NOW)).toBe(0);
  });

  it('removes a shared answer whose claims have gone', () => {
    saveFactSets(
      [
        {
          key: 'fs-orphan',
          subjectKey: 'subj:geo:nobody@0.0000,0.0000',
          resolved: {
            subjectId: 'p',
            factPath: 'cost.admission',
            state: 'single_source',
            factIds: ['fact-clm-a'],
            independentSources: 1,
            rationale: 'Somebody says so.',
          },
        },
      ],
      NOW,
    );
    expect(findFactSets(['fs-orphan']).size).toBe(1);

    const plan = sweepEvidenceStore({ dryRun: true, now: NOW });
    expect(plan.factSetsStale).toBe(1);
    sweepEvidenceStore({ dryRun: false, now: NOW });
    // The key is a hash of the claims behind it, so once they are gone the key
    // can never be recomputed — the row is unreachable, not merely stale.
    expect(findFactSets(['fs-orphan']).size).toBe(0);
  });

  it('does not sweep a store that has barely grown', () => {
    seed();
    // The driver is synchronous, so a sweep stalls every request behind it.
    // Paying that on a store of three documents is the cost with none of the
    // benefit.
    expect(evidenceStoreNeedsSweep()).toBe(false);
  });

  it('clears settled operation rows and expired negative caches', () => {
    const claim = claimOperation('retrieve:abc', NOW);
    if (claim.kind === 'claimed') completeOperation({ id: claim.id, now: NOW, state: 'done' });
    saveDiscovery({
      now: new Date(NOW.getTime() - 40 * 86_400_000),
      record: {
        key: 'stale',
        outcome: 'no_source_found',
        references: [],
        provider: 'p',
        providerVersion: 'v1',
        discoveredAt: '2026-06-01T00:00:00.000Z',
        searches: 1,
      },
    });

    const plan = sweepEvidenceStore({ dryRun: false, now: NOW });
    expect(plan.operationsSettled).toBe(1);
    expect(plan.discoveryExpired).toBe(1);
    expect(evidenceStoreSize().discovery).toBe(0);
  });
});
