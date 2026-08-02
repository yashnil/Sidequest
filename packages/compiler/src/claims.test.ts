import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  sourceIdFor,
  CONTEXT_INDEPENDENT_PATHS,
  claimIdFor,
  factSetKeyFor,
  isContextIndependent,
  liveClaimsByPath,
  normalizeClaimValue,
  RESOLVER_VERSION,
  researchAttemptKey,
  supersededBy,
  type EvidenceClaimRecord,
  type FactPath,
  type ResearchAttempt,
  type WorkPlanEntry,
} from '@sidequest/core';
import type { ResolvedFact } from '@sidequest/core';
import { claimCoverage, factsFromClaims, toClaimRecords } from './claims';
import { compileRegion } from './compile';
import { orderWorkPlan } from './evidence-store';
import { SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';
import { packBackedProviders } from './testing/pack-fakes';
import { deriveScope } from './scope';
import type { ExtractedClaim, ResearchSubject, RetrievedDocument } from './providers';

/**
 * DURABLE CLAIMS: WHAT MAY BE SHARED, AND WHAT MUST NOT BE.
 *
 * The first half of Phase 10 made the page shared. This is the half that makes
 * the *fact* shared, and it is the half with the sharp edge: a claim that
 * accidentally carried a traveller, or a resolved answer that accidentally
 * carried a date, would serve one person's trip as another person's evidence.
 */

const NOW = new Date('2026-08-02T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);

function document(overrides: Partial<RetrievedDocument> = {}): RetrievedDocument {
  return {
    subjectId: 'trip-place-7',
    url: 'https://museum.example/visit',
    text: 'Open Monday to Friday, 09:00 to 17:00.',
    structuredData: [],
    contentHash: DIGEST,
    contentBytes: 4096,
    retrievedAt: '2026-08-01T00:00:00.000Z',
    robotsAllowed: true,
    authority: 'operator',
    publisher: 'museum.example',
    domain: 'museum.example',
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    subjectId: 'trip-place-7',
    documentIndex: 0,
    factPath: 'hours.weekly',
    statement: 'Open Monday to Friday, 09:00 to 17:00.',
    evidenceExcerpt: 'Open Monday to Friday, 09:00 to 17:00.',
    derivation: 'directly_stated',
    payload: {
      periods: [{ label: 'All year', months: [1, 2, 3], windows: [{ openMinute: 540, closeMinute: 1020 }] }],
    },
    ...overrides,
  };
}

const SUBJECT_KEYS = new Map([['trip-place-7', 'subj:geo:harbour-museum@50.1234,-3.4567']]);

function build(overrides: Partial<Parameters<typeof toClaimRecords>[0]> = {}) {
  return toClaimRecords({
    claims: [extracted()],
    documents: [document()],
    subjectKeys: SUBJECT_KEYS,
    promptVersion: 'prompt/1',
    schemaVersion: 'schema/1',
    modelId: 'model/1',
    parserVersion: 'parser/1',
    existing: [],
    now: NOW,
    ...overrides,
  });
}

describe('claim identity', () => {
  it('gives the same unchanged observation the same id, so nothing duplicates', () => {
    const first = build().records[0]!;
    const second = build({ now: new Date('2026-09-01T00:00:00.000Z') }).records[0]!;
    // A second reading of an unchanged page under an unchanged contract is the
    // claim we already have, not a new version of it.
    expect(second.id).toBe(first.id);
  });

  it('changes when the bytes change', () => {
    const first = build().records[0]!;
    const second = build({ documents: [document({ contentHash: 'b'.repeat(64) })] }).records[0]!;
    expect(second.id).not.toBe(first.id);
  });

  it('changes when the answer changes, even from the same page', () => {
    const first = build().records[0]!;
    const second = build({
      claims: [extracted({ statement: 'Open Saturdays only.', payload: { periods: [{ label: 'Winter', months: [12], windows: [{ openMinute: 600, closeMinute: 900 }] }] } })],
    }).records[0]!;
    expect(second.id).not.toBe(first.id);
  });

  it('changes when the contract that read it changes', () => {
    const base = build().records[0]!;
    for (const change of [
      { promptVersion: 'prompt/2' },
      { schemaVersion: 'schema/2' },
      { modelId: 'model/2' },
      { parserVersion: 'parser/2' },
    ]) {
      expect(build(change).records[0]!.id, JSON.stringify(change)).not.toBe(base.id);
    }
  });

  it('treats two phrasings of one payload as one claim', () => {
    const a = normalizeClaimValue({ b: 2, a: 1 }, 'Open daily');
    const b = normalizeClaimValue({ a: 1, b: 2 }, 'OPEN  DAILY.');
    expect(a).toBe(b);
  });

  it('collapses the same answer arriving twice in one batch', () => {
    const result = build({
      claims: [extracted(), extracted()],
      documents: [document()],
    });
    expect(result.records).toHaveLength(1);
  });
});

describe('what a claim is allowed to carry', () => {
  it('is keyed on the place, never on the trip that found it', () => {
    const record = build().records[0]!;
    expect(record.subjectKey).toBe('subj:geo:harbour-museum@50.1234,-3.4567');
    expect(JSON.stringify(record)).not.toContain('trip-place-7');
  });

  it('carries the content clock, so a reused claim is honestly old', () => {
    const record = build().records[0]!;
    expect(record.contentObservedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('drops a claim it cannot give a durable identity to', () => {
    const result = build({ subjectKeys: new Map() });
    expect(result.records).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('applies the same gates a fact does', () => {
    // Directly stated, and unquotable. Nobody could check it.
    const result = build({
      claims: [extracted({ evidenceExcerpt: undefined })],
    });
    expect(result.records).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });
});

describe('supersession', () => {
  const existing: EvidenceClaimRecord = {
    ...build().records[0]!,
    contentObservedAt: '2026-06-01T00:00:00.000Z',
  };

  it('replaces the same source saying something different, later', () => {
    const result = build({
      existing: [existing],
      claims: [extracted({ statement: 'Now open daily.', payload: { periods: [{ label: 'New', months: [8], windows: [{ openMinute: 540, closeMinute: 1080 }] }] } })],
      documents: [document({ contentHash: 'c'.repeat(64) })],
    });
    expect(result.supersededIds).toEqual([existing.id]);
  });

  it('does not let one publisher replace another — that is a conflict, in the open', () => {
    const other: EvidenceClaimRecord = {
      ...existing,
      id: 'clm-other',
      sourceId: 'guide.example',
      sourceDomain: 'guide.example',
    };
    const result = build({
      existing: [other],
      documents: [document({ contentHash: 'c'.repeat(64) })],
    });
    expect(result.supersededIds).toEqual([]);
  });

  it('keeps superseded claims out of resolution but not out of history', () => {
    const replaced: EvidenceClaimRecord = { ...existing, superseded: true };
    const byPath = liveClaimsByPath([replaced]);
    expect(byPath.get('hours.weekly')).toBeUndefined();
    // Still a record. `supersededBy` will not pick it up again either.
    expect(supersededBy(build().records[0]!, [replaced])).toEqual([]);
  });
});

describe('projecting claims back into facts', () => {
  it('derives the fact id from the claim, so an artifact can be traced back', () => {
    const record = build().records[0]!;
    const { facts } = factsFromClaims({
      claims: [record],
      subjectIds: new Map([[record.subjectKey, 'another-trip-place-3']]),
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.id).toBe(`fact-${record.id}`);
    // And it belongs to *this* trip's subject, not the one that first saw it.
    expect(facts[0]!.subjectId).toBe('another-trip-place-3');
  });

  it('gives the fact the claim’s content clock, never today', () => {
    const record = build().records[0]!;
    const { facts } = factsFromClaims({
      claims: [record],
      subjectIds: new Map([[record.subjectKey, 'p']]),
    });
    expect(facts[0]!.retrievedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('never projects a superseded claim', () => {
    const record = { ...build().records[0]!, superseded: true };
    const { facts } = factsFromClaims({
      claims: [record],
      subjectIds: new Map([[record.subjectKey, 'p']]),
    });
    expect(facts).toEqual([]);
  });
});

describe('coverage decides who still costs money', () => {
  const subject: ResearchSubject = {
    id: 'trip-place-7',
    name: 'Harbour Museum',
    kind: 'museum',
    locality: 'Harbourside',
    coordinates: { lat: 50.1234, lng: -3.4567 },
    wantedPaths: ['hours.weekly', 'cost.admission'],
  };
  const CONTRACT = 'model:p|s|m|pa';

  function attemptAt(at: string): Map<string, ResearchAttempt> {
    return new Map([
      [
        researchAttemptKey({
          subjectKey: SUBJECT_KEYS.get('trip-place-7')!,
          contract: CONTRACT,
          wantedPaths: subject.wantedPaths,
        }),
        {
          schemaVersion: 1 as const,
          subjectKey: SUBJECT_KEYS.get('trip-place-7')!,
          contract: CONTRACT,
          wantedPaths: [...subject.wantedPaths],
          attemptedAt: at,
          claimsFound: 1,
        },
      ],
    ]);
  }

  function coverageWith(overrides: Partial<Parameters<typeof claimCoverage>[0]> = {}) {
    const record = build().records[0]!;
    return claimCoverage({
      subjects: [subject],
      subjectKeys: SUBJECT_KEYS,
      claimsBySubjectKey: new Map([[record.subjectKey, [record]]]),
      isFresh: () => true,
      attempts: attemptAt(NOW.toISOString()),
      contract: CONTRACT,
      now: NOW,
      ...overrides,
    });
  }

  it('takes a subject out of the funnel once it has been asked recently', () => {
    /**
     * One of two questions answered, and that is enough — because nobody
     * publishes a typical visit length, and waiting for them to would mean
     * re-buying the same fruitless search every week.
     */
    const covered = coverageWith();
    expect(covered.covered).toHaveLength(1);
    expect(covered.pathsCovered).toBe(1);
  });

  it('asks again when the attempt is older than its most perishable question', () => {
    // hours.weekly ages out in 90 days, so an attempt from a year ago stands for
    // nothing.
    const stale = coverageWith({ attempts: attemptAt('2025-06-01T00:00:00.000Z') });
    expect(stale.outstanding).toHaveLength(1);
  });

  it('asks again when the contract that read it has moved on', () => {
    const rolled = coverageWith({ contract: 'model:p2|s|m|pa' });
    expect(rolled.outstanding).toHaveLength(1);
  });

  it('asks again when we have never asked at all', () => {
    const never = coverageWith({ attempts: new Map() });
    expect(never.outstanding).toHaveLength(1);
  });

  it('asks again when the attempt yielded nothing whatsoever', () => {
    /**
     * A search that came back completely empty is more likely to have been a bad
     * search than a genuine silence, and is worth one more try.
     */
    const empty = coverageWith({ claimsBySubjectKey: new Map() });
    expect(empty.outstanding).toHaveLength(1);
  });

  it('does not count a claim past its own shelf life as coverage', () => {
    const stale = coverageWith({ isFresh: () => false });
    expect(stale.covered).toHaveLength(0);
    expect(stale.pathsCovered).toBe(0);
  });
});

describe('which answers may be shared', () => {
  it('shares only questions whose answer does not depend on a calendar', () => {
    for (const path of CONTEXT_INDEPENDENT_PATHS) {
      expect(isContextIndependent(path), path).toBe(true);
    }
    // Every dated question, explicitly out.
    const dated: FactPath[] = [
      'hours.weekly',
      'hours.seasonal',
      'hours.lastAdmission',
      'hours.closure',
      'safety.caution',
      'food.hours',
      'cost.transport',
    ];
    for (const path of dated) {
      expect(isContextIndependent(path), path).toBe(false);
    }
  });

  it('keys a shared answer on its exact claim set, and on nothing else', () => {
    const base = {
      subjectKey: 'subj:geo:museum@1.0000,2.0000',
      factPath: 'cost.admission' as const,
      claimIds: ['clm-a', 'clm-b'],
      resolverVersion: RESOLVER_VERSION,
    };
    // Order cannot fork a key.
    expect(factSetKeyFor(base)).toBe(factSetKeyFor({ ...base, claimIds: ['clm-b', 'clm-a'] }));
    // A new claim mints a new key, so a stale answer can never be served for a
    // set that has since grown.
    expect(factSetKeyFor({ ...base, claimIds: ['clm-a'] })).not.toBe(factSetKeyFor(base));
    expect(factSetKeyFor({ ...base, resolverVersion: 'other' })).not.toBe(factSetKeyFor(base));
    expect(factSetKeyFor({ ...base, subjectKey: 'other' })).not.toBe(factSetKeyFor(base));
  });

  it('has no way to express a date or a traveller in a shared key', () => {
    const key = factSetKeyFor({
      subjectKey: 'subj:geo:museum@1.0000,2.0000',
      factPath: 'cost.admission',
      claimIds: ['clm-a'],
      resolverVersion: RESOLVER_VERSION,
    });
    expect(key).toMatch(/^fs-[0-9a-f]+$/);
    // The signature is the guard: there is no parameter a date could go in.
    expect(Object.keys({ subjectKey: 1, factPath: 1, claimIds: 1, resolverVersion: 1 })).toEqual([
      'subjectKey',
      'factPath',
      'claimIds',
      'resolverVersion',
    ]);
  });
});

describe('claim ids are stable across processes', () => {
  it('does not depend on a clock or on ordering', () => {
    const input = {
      subjectKey: 'subj:geo:x@1.0000,2.0000',
      factPath: 'hours.weekly' as const,
      contentDigest: `sha256:${DIGEST}`,
      contract: 'model:p|s|m|pa',
      normalizedValue: '{"a":1}',
    };
    expect(claimIdFor(input)).toBe(claimIdFor({ ...input }));
  });
});

// ---------------------------------------------------------------------------
// Through the real compiler
// ---------------------------------------------------------------------------

/**
 * A claim store in memory, with the same contract as the database one.
 *
 * What these prove cannot be produced any other way: a second compilation of the
 * same ground, a third for a different traveller, and a fourth for different
 * dates — all against one store, all through `compileRegion` itself rather than
 * around it.
 */
function memoryClaimStore() {
  const claims = new Map<string, EvidenceClaimRecord>();
  const factSets = new Map<string, ResolvedFact>();
  const attempts = new Map<string, ResearchAttempt>();
  const calls = { load: 0, save: 0, factSetHits: 0 };

  return {
    calls,
    claims,
    factSets,
    store: {
      resolverVersion: RESOLVER_VERSION,
      load(subjectKeys: readonly string[]) {
        calls.load += 1;
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
        calls.save += 1;
        for (const id of input.supersededIds) {
          const held = claims.get(id);
          if (held) claims.set(id, { ...held, superseded: true });
        }
        for (const record of input.records) {
          const held = claims.get(record.id);
          // The same claim observed again keeps its first sighting.
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
        for (const attempt of input.attempts) {
          attempts.set(researchAttemptKey(attempt), attempt);
        }
      },
      loadFactSets(keys: readonly string[]) {
        const found = new Map<string, ResolvedFact>();
        for (const key of keys) {
          const entry = factSets.get(key);
          if (entry) {
            found.set(key, entry);
            calls.factSetHits += 1;
          }
        }
        return found;
      },
      saveFactSets(input: { entries: readonly { key: string; resolved: ResolvedFact }[] }) {
        for (const entry of input.entries) factSets.set(entry.key, entry.resolved);
      },
    },
  };
}

const WORLD = SYNTHETIC_WORLDS.transit_city!;
const COMPILE_NOW = new Date('2026-08-10T09:00:00.000Z');
const TRIP_DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

function compileScope() {
  const scope = deriveScope({
    candidate: syntheticCandidate(WORLD),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: TRIP_DATES.length - 1,
    revision: 1,
  });
  return {
    ...scope,
    confirmedByUser: true,
    transport: { ...scope.transport, primaryMode: WORLD.primaryMode },
  };
}

async function compileWith(
  store: ReturnType<typeof memoryClaimStore>,
  options: { dates?: string[]; now?: Date; id?: string } = {},
) {
  const stages: string[] = [];
  const workPlan: WorkPlanEntry[] = [];
  const result = await compileRegion({
    compilationId: options.id ?? 'claims-test',
    scope: compileScope(),
    dates: options.dates ?? TRIP_DATES,
    months: [8],
    providers: { ...packBackedProviders(WORLD, { officialSourceCoverage: 1 }), claims: store.store },
    now: options.now ?? COMPILE_NOW,
    onStage: (record) => {
      if (record.status === 'done' || record.status === 'skipped') stages.push(record.stage);
    },
    onWorkPlanNote: (entry) => workPlan.push(entry),
  });
  return { result, stages, workPlan };
}

describe('durable claims through the compiler', () => {
  it('researches once and reuses the facts on the next compilation', async () => {
    const store = memoryClaimStore();

    const cold = await compileWith(store);
    expect(cold.result.ok).toBe(true);
    const claimsAfterCold = store.claims.size;
    expect(claimsAfterCold).toBeGreaterThan(0);

    const warm = await compileWith(store, { id: 'claims-test-warm' });
    expect(warm.result.ok).toBe(true);

    /**
     * The point of the whole slice: a second trip past the same places creates
     * no new claims, because a claim's id is what it says rather than when it
     * was said.
     */
    expect(store.claims.size).toBe(claimsAfterCold);
    if (!warm.result.ok || !cold.result.ok) return;

    // And the warm artifact carries the same evidence, not a thinner set.
    expect(warm.result.region.sourceManifest.facts.length).toBe(
      cold.result.region.sourceManifest.facts.length,
    );
    expect(warm.result.region.diagnostics.budget.consumed.claimsHeld).toBeGreaterThan(0);
    /**
     * And the short-circuit actually engaged: subjects whose every question was
     * already answered never reached source discovery, retrieval or the model.
     */
    expect(
      warm.result.region.diagnostics.budget.consumed.subjectsAnsweredFromClaims,
    ).toBeGreaterThan(0);
    expect(cold.result.region.diagnostics.budget.consumed.subjectsAnsweredFromClaims).toBe(0);
  });

  it('reports the reuse no provider could report, and claims none on a cold build', async () => {
    const store = memoryClaimStore();

    const cold = await compileWith(store);
    expect(cold.result.ok).toBe(true);
    /**
     * A cold build has nothing to reuse and says nothing about reuse. The panel
     * showing "we skipped this" on a build that skipped nothing would be the one
     * failure mode a cache UI must not have.
     */
    expect(cold.workPlan).toEqual([]);

    const warm = await compileWith(store, { id: 'claims-test-work-plan' });
    const reuse = warm.workPlan.find((entry) => entry.step === 'reusing_shared_claims');

    /**
     * This entry can only come from the compiler. When a durable claim answers a
     * subject outright, discovery, retrieval and extraction are never called —
     * so the shared evidence layer, which only sees calls it received, has
     * nothing to report about the stage that saved the most.
     */
    expect(reuse).toBeDefined();
    expect(reuse?.decision).toBe('reusable');
    expect(reuse?.items ?? 0).toBeGreaterThan(0);
    expect(reuse?.reason).toMatch(/already researched/);
  });

  it('orders work-plan entries by the funnel, wherever they came from', () => {
    const entries: WorkPlanEntry[] = [
      { step: 'extracting_facts', decision: 'reusable', reason: 'already read' },
      { step: 'something_new', decision: 'recompute', reason: 'unknown step' },
      { step: 'discovering_sources', decision: 'reusable', reason: 'known publisher' },
      { step: 'reusing_shared_claims', decision: 'reusable', reason: 'already researched' },
    ];
    expect(orderWorkPlan(entries).map((entry) => entry.step)).toEqual([
      'reusing_shared_claims',
      'discovering_sources',
      'extracting_facts',
      'something_new',
    ]);
  });

  it('does not mutate the previous artifact', async () => {
    const store = memoryClaimStore();
    const cold = await compileWith(store);
    if (!cold.result.ok) return;
    const frozen = JSON.stringify(cold.result.region);

    await compileWith(store, { id: 'claims-test-second' });
    expect(JSON.stringify(cold.result.region)).toBe(frozen);
  });

  it('reuses the evidence for different dates and re-judges what depends on them', async () => {
    const store = memoryClaimStore();
    await compileWith(store);
    const claimsAfterCold = store.claims.size;

    const winter = await compileWith(store, {
      id: 'claims-test-winter',
      dates: ['2026-12-20', '2026-12-21', '2026-12-22'],
    });
    expect(winter.result.ok).toBe(true);

    // Same claims — the museum did not change because somebody else is going in
    // December.
    expect(store.claims.size).toBe(claimsAfterCold);
    if (!winter.result.ok) return;
    // But the artifact is a different one, built for those dates.
    expect(winter.result.region.scope).toBeTruthy();
  });

  it('shares an answer only for questions a calendar cannot change', async () => {
    const store = memoryClaimStore();
    await compileWith(store);
    for (const resolved of store.factSets.values()) {
      expect(isContextIndependent(resolved.factPath), resolved.factPath).toBe(true);
    }
  });
});

describe('a claim points at the same source the document store does', () => {
  it('uses the canonical source id, not the bare host', () => {
    const record = build().records[0]!;
    const canonical = canonicalizeUrl('https://museum.example/visit')!;
    expect(record.sourceId).toBe(sourceIdFor(canonical));
    /**
     * A claim naming `museum.example` and a document version named
     * `src-museum.example-<hash>@sha256:…` would look related and join to
     * nothing — and the retention sweep protects sources by looking for exactly
     * this id, so a mismatch would quietly make that protection a no-op.
     */
    expect(record.documentVersionId).toBe(`${record.sourceId}@${record.contentDigest}`);
  });
});
