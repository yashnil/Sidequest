import type { ProvisionalBoard } from '@sidequest/core';
import { describe, expect, it } from 'vitest';
import {
  assessConfidence,
  breadthRank,
  decodeStoredJob,
  terminateOpenStages,
  COMPILATION_JOB_VERSION,
  COMPILATION_OPERATIONAL_VERSION,
  CLARIFICATION_SET_VERSION,
  checkRegionIntegrity,
  compiledRegionSchema,
  isUnambiguous,
  normalizeDestinationQuery,
  scopeFingerprint,
  unansweredRequired,
  type ClarificationSet,
  type DestinationResolution,
  type StageRecord,
} from '@sidequest/core';
import { BudgetLedger, budgetFor, DEFAULT_COMPILER_BUDGET } from './budget';
import { deriveClarificationQuestions, QUESTION_IDS, rebuildClarificationSet } from './clarify';
import { compileRegion } from './compile';
import { dedupeCandidates, normalizeName } from './dedupe';
import { deriveScope, scopeFitsTrip } from './scope';
import { createDynamicRegionSource } from './source';
import { fakeProviders, failingProviders, SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

function resolutionFor(worldKey: keyof typeof SYNTHETIC_WORLDS): DestinationResolution {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const candidate = syntheticCandidate(spec);
  return {
    schemaVersion: 1,
    query: spec.name,
    normalizedQuery: normalizeDestinationQuery(spec.name),
    candidates: [candidate],
    ambiguityReasons: [],
    unambiguousCandidateId: candidate.id,
    providersConsulted: ['fake-resolver'],
    resolvedAt: '2026-07-01T00:00:00.000Z',
  };
}

function scopeFor(
  worldKey: keyof typeof SYNTHETIC_WORLDS,
  overrides: { nights?: number; answers?: ClarificationSet } = {},
) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const candidate = syntheticCandidate(spec);
  const scope = deriveScope({
    candidate,
    clarifications: overrides.answers ?? emptyClarifications(),
    nights: overrides.nights ?? DATES.length - 1,
    revision: 1,
  });
  // The compiler refuses an unconfirmed scope, which is the point of the flag.
  return { ...scope, confirmedByUser: true, transport: { ...scope.transport, primaryMode: spec.primaryMode } };
}

// ---------------------------------------------------------------------------
// Confidence is derived from signals, never authored
// ---------------------------------------------------------------------------

describe('confidence', () => {
  it('reads as low when the only basis is a model saying so', () => {
    expect(assessConfidence(['model_inference_only']).level).toBe('low');
  });

  it('reads as low when providers disagree, whatever else corroborates it', () => {
    const assessment = assessConfidence([
      'exact_name_match',
      'administrative_hierarchy_match',
      'boundary_available',
      'conflicting_providers',
    ]);
    expect(assessment.level).toBe('low');
  });

  it('treats a traveller confirming it as final', () => {
    expect(assessConfidence(['user_confirmed', 'conflicting_providers']).level).toBe('high');
  });

  it('needs three independent positives and nothing against for high', () => {
    expect(
      assessConfidence(['exact_name_match', 'administrative_hierarchy_match', 'boundary_available']).level,
    ).toBe('high');
    expect(assessConfidence(['exact_name_match', 'single_provider_only']).level).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Ambiguity is preserved, never silently resolved
// ---------------------------------------------------------------------------

describe('destination resolution', () => {
  it('is only unambiguous with one high-confidence candidate and no recorded ambiguity', () => {
    const resolution = resolutionFor('transit_city');
    expect(isUnambiguous(resolution)).toBe(true);

    expect(isUnambiguous({ ...resolution, ambiguityReasons: ['multiple_matching_places'] })).toBe(false);
    expect(isUnambiguous({ ...resolution, unambiguousCandidateId: undefined })).toBe(false);
  });

  it('never treats "first candidate wins" as unambiguous', () => {
    const resolution = resolutionFor('transit_city');
    const second = { ...resolution.candidates[0]!, id: 'other' };
    expect(isUnambiguous({ ...resolution, candidates: [...resolution.candidates, second] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clarification: the minimum set, and never a question the profile answers
// ---------------------------------------------------------------------------

describe('clarification rules', () => {
  it('asks a whole country how it wants to be taken on', () => {
    const spec = SYNTHETIC_WORLDS.broad_country!;
    const questions = deriveClarificationQuestions({
      resolution: resolutionFor('broad_country'),
      candidate: syntheticCandidate(spec),
      nights: 7,
    });
    const breadth = questions.find((question) => question.id === QUESTION_IDS.breadthStrategy);
    expect(breadth?.required).toBe(true);
    expect(breadth?.reason).toBe('scope_too_broad');
  });

  it('does not ask a small city to narrow itself down', () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const questions = deriveClarificationQuestions({
      resolution: resolutionFor('transit_city'),
      candidate: syntheticCandidate(spec),
      nights: 3,
    });
    expect(questions.map((question) => question.id)).not.toContain(QUESTION_IDS.breadthStrategy);
  });

  it('asks an archipelago about boats and does not ask the mainland', () => {
    const island = deriveClarificationQuestions({
      resolution: resolutionFor('ferry_island'),
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.ferry_island!),
      nights: 5,
    });
    expect(island.map((question) => question.id)).toContain(QUESTION_IDS.waterOrAir);

    const inland = deriveClarificationQuestions({
      resolution: resolutionFor('remote_road'),
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.remote_road!),
      nights: 5,
    });
    expect(inland.map((question) => question.id)).not.toContain(QUESTION_IDS.waterOrAir);
  });

  it('stops asking about a car once the questionnaire has answered it', () => {
    const candidate = syntheticCandidate(SYNTHETIC_WORLDS.remote_road!);
    const withoutProfile = deriveClarificationQuestions({
      resolution: resolutionFor('remote_road'),
      candidate,
      nights: 6,
    });
    expect(withoutProfile.map((question) => question.id)).toContain(QUESTION_IDS.carAvailable);
  });

  it('keeps answers whose questions survive a re-derivation, and drops the rest', () => {
    const candidate = syntheticCandidate(SYNTHETIC_WORLDS.broad_country!);
    const input = { resolution: resolutionFor('broad_country'), candidate, nights: 8 };
    const first = rebuildClarificationSet(input);
    const answered: ClarificationSet = {
      ...first,
      answers: [
        { questionId: QUESTION_IDS.breadthStrategy, values: ['one_area'], answeredAt: '2026-08-01T00:00:00Z' },
        { questionId: 'question.that.no.longer.exists', values: ['x'], answeredAt: '2026-08-01T00:00:00Z' },
      ],
    };
    const rebuilt = rebuildClarificationSet(input, answered);
    expect(rebuilt.answers.map((answer) => answer.questionId)).toEqual([QUESTION_IDS.breadthStrategy]);
  });

  it('reports a required question as blocking until it is answered', () => {
    const candidate = syntheticCandidate(SYNTHETIC_WORLDS.broad_country!);
    const set = rebuildClarificationSet({
      resolution: resolutionFor('broad_country'),
      candidate,
      nights: 8,
    });
    expect(unansweredRequired(set).length).toBeGreaterThan(0);

    const answered: ClarificationSet = {
      ...set,
      answers: set.questions
        .filter((question) => question.required)
        .map((question) => ({
          questionId: question.id,
          values: [question.options[0]?.value ?? 'something'],
          answeredAt: '2026-08-01T00:00:00Z',
        })),
    };
    expect(unansweredRequired(answered)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope derivation', () => {
  it('keeps "we have not established a car" distinct from "no car"', () => {
    const scope = scopeFor('remote_road');
    expect(scope.transport.carAvailable).toBeNull();
    expect(scope.transport.note).toMatch(/have not established/i);
  });

  it('never collapses several timezones to one', () => {
    const scope = scopeFor('rail_corridor');
    expect(scope.timeZones.length).toBe(2);
  });

  it('reaches further for a car than on foot, for the same trip length', () => {
    const driving = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.remote_road!),
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId: QUESTION_IDS.carAvailable, values: ['yes'], answeredAt: 'x' }],
      },
      nights: 4,
      revision: 1,
    });
    const walking = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.transit_city!),
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId: QUESTION_IDS.carAvailable, values: ['no'], answeredAt: 'x' }],
      },
      nights: 4,
      revision: 1,
    });
    const radiusOf = (shape: typeof driving.shape): number =>
      shape.kind === 'radius' ? shape.radiusKm : 0;
    expect(radiusOf(driving.shape)).toBeGreaterThan(radiusOf(walking.shape));
  });

  it('clips a published boundary to what the trip can actually cross', () => {
    /**
     * A live New York evaluation took the city's full fifty-kilometre
     * administrative boundary for a four-night walking trip. The router then
     * refused two hundred and seventy-two of three hundred and eighty walking
     * legs across the harbour, and the plan came back as whichever borough the
     * base landed in. A boundary is a fact about governance; what a traveller
     * covers is a fact about their transport.
     */
    const wide = {
      ...syntheticCandidate(SYNTHETIC_WORLDS.transit_city!),
      // Roughly the span of a large metropolitan boundary.
      bounds: {
        southWest: { lat: 38.5, lng: -9.4 },
        northEast: { lat: 38.95, lng: -8.85 },
      },
      center: { lat: 38.72, lng: -9.14 },
    };
    const scope = deriveScope({
      candidate: wide,
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId: QUESTION_IDS.carAvailable, values: ['no'], answeredAt: 'x' }],
      },
      nights: 4,
      revision: 1,
    });

    expect(scope.shape.kind).toBe('bounds');
    if (scope.shape.kind !== 'bounds') return;
    const latSpanKm = (scope.shape.bounds.northEast.lat - scope.shape.bounds.southWest.lat) * 111;
    // Four walking nights reach about twelve kilometres, not fifty.
    expect(latSpanKm).toBeLessThan(30);
    // And the scope's own bounds agree with its shape, because everything
    // downstream reads one of the two and they must not disagree.
    expect(scope.bounds).toEqual(scope.shape.bounds);
  });

  it('leaves a boundary alone when the trip can genuinely cross it', () => {
    const small = {
      ...syntheticCandidate(SYNTHETIC_WORLDS.transit_city!),
      bounds: {
        southWest: { lat: 38.70, lng: -9.17 },
        northEast: { lat: 38.74, lng: -9.11 },
      },
      center: { lat: 38.72, lng: -9.14 },
    };
    const scope = deriveScope({
      candidate: small,
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId: QUESTION_IDS.carAvailable, values: ['yes'], answeredAt: 'x' }],
      },
      nights: 4,
      revision: 1,
    });
    expect(scope.shape).toEqual({ kind: 'bounds', bounds: small.bounds });
  });

  it('refuses a whole country from a single base rather than quietly shrinking it', () => {
    const scope = scopeFor('broad_country');
    const verdict = scopeFitsTrip({ ...scope, breadth: 'country', maxBaseChanges: 0 });
    expect(verdict.fits).toBe(false);
    expect(verdict.reason).toMatch(/name a part of it|allow a hotel change/i);
  });

  it('changes its fingerprint when anything that changes the compilation changes', () => {
    const scope = scopeFor('transit_city');
    const base = scopeFingerprint(scope);
    expect(scopeFingerprint({ ...scope, revision: 2 })).not.toBe(base);
    expect(scopeFingerprint({ ...scope, maxBaseChanges: 2 })).not.toBe(base);
    // Rationale is prose. It must not invalidate a compiled artifact.
    expect(scopeFingerprint({ ...scope, rationale: 'reworded' })).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  it('folds accents and articles so one lake is one lake', () => {
    expect(normalizeName('The Sørvágsvatn')).toBe(normalizeName('Sorvagsvatn'));
  });

  it('merges on a shared provider id even when the names differ', () => {
    const providers = fakeProviders(SYNTHETIC_WORLDS.transit_city!);
    return providers.places.discover({ scope: scopeFor('transit_city'), queries: [] }).then((result) => {
      const first = result.candidates[0]!;
      const renamed = {
        ...first,
        place: { ...first.place, name: 'A completely different name' },
      };
      const merged = dedupeCandidates([first, renamed]);
      expect(merged.candidates).toHaveLength(1);
      expect(merged.mergedCount).toBe(1);
    });
  });

  it('does not merge two different places that share a coordinate', async () => {
    const providers = fakeProviders(SYNTHETIC_WORLDS.transit_city!);
    const result = await providers.places.discover({ scope: scopeFor('transit_city'), queries: [] });
    const first = result.candidates[0]!;
    const colocated = {
      ...first,
      place: { ...first.place, id: 'other-place', name: 'Something Else Entirely' },
      providerRefs: [{ provider: 'fake-places', externalId: 'other-place' }],
    };
    const merged = dedupeCandidates([first, colocated]);
    expect(merged.candidates).toHaveLength(2);
  });

  it('records that two providers agreed, which no single result could show', async () => {
    const providers = fakeProviders(SYNTHETIC_WORLDS.transit_city!);
    const result = await providers.places.discover({ scope: scopeFor('transit_city'), queries: [] });
    const first = result.candidates[0]!;
    const fromElsewhere = {
      ...first,
      providerRefs: [{ provider: 'another-provider', externalId: 'x1' }],
      confidenceSignals: ['single_provider_only' as const],
    };
    const merged = dedupeCandidates([first, fromElsewhere]);
    expect(merged.candidates[0]!.confidenceSignals).toContain('multiple_providers_agree');
    expect(merged.candidates[0]!.confidenceSignals).not.toContain('single_provider_only');
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('budget', () => {
  it('hands back only what is left, and marks the counter exhausted', () => {
    const ledger = new BudgetLedger({ ...DEFAULT_COMPILER_BUDGET, maxCoarseCandidates: 10 }, 0);
    expect(ledger.take('maxCoarseCandidates', 6)).toBe(6);
    expect(ledger.take('maxCoarseCandidates', 9)).toBe(4);
    expect(ledger.take('maxCoarseCandidates', 1)).toBe(0);
    expect(ledger.exhausted()).toContain('maxCoarseCandidates');
  });

  it('gives a broad country more room than a small town, for the same trip', () => {
    const town = budgetFor({ nights: 4, breadthRank: breadthRank('city') });
    const country = budgetFor({ nights: 4, breadthRank: breadthRank('country') });
    expect(country.maxCoarseCandidates).toBeGreaterThan(town.maxCoarseCandidates);
  });

  it('keeps the matrix budget bounded however broad the trip is', () => {
    /*
     * The ceiling moved from 2,500 to 4,800 when routing became hierarchical,
     * and the reason is worth recording: under the flat all-pairs design roughly
     * seventy per cent of a matrix was cells no consumer could read, so most of
     * the old budget bought nothing. Every pair inside the new one is targeted,
     * so the same money goes about three times as far — and the property that
     * actually matters is unchanged: it is *bounded*, and it does not grow with
     * the candidate count.
     */
    const country = budgetFor({ nights: 21, breadthRank: breadthRank('multi_country') });
    expect(country.maxRouteElements).toBeLessThanOrEqual(4_800);

    const longer = budgetFor({ nights: 30, breadthRank: breadthRank('multi_country') });
    expect(longer.maxRouteElements).toBe(country.maxRouteElements);
  });
});

// ---------------------------------------------------------------------------
// Reading a job back out of a row, and ending one that died
// ---------------------------------------------------------------------------

/**
 * THE READ POLICY, TESTED WHERE IT IS DECIDED.
 *
 * `rowToJob` did two things wrong and both were in a read path, which is the
 * worst place for them: it stamped the *current* schema version onto whatever
 * had been stored, and it called `JSON.parse(row.stages_json)` unguarded. One
 * truncated write therefore threw out of `getActiveJob` and made a trip
 * permanently un-openable — with no self-healing, because the row is durable.
 */
describe('decodeStoredJob', () => {
  const ROW = {
    id: 'job-1',
    trip_id: 'trip-1',
    scope_fingerprint: 'fp-1',
    state: 'running',
    stage: 'expanding_region',
    stages_json: JSON.stringify([
      { stage: 'expanding_region', status: 'running', startedAt: '2026-08-10T09:00:00.000Z' },
    ]),
    started_at: '2026-08-10T09:00:00.000Z',
    updated_at: '2026-08-10T09:00:01.000Z',
    finished_at: null,
    heartbeat_at: '2026-08-10T09:00:01.000Z',
    cancel_requested: 0,
    error_code: null,
    error_detail: null,
    compiled_region_id: null,
    correlation_id: 'corr-1',
  };

  it('reads the version off the row rather than stamping the current one on', () => {
    expect(decodeStoredJob(ROW)?.schemaVersion).toBe(COMPILATION_JOB_VERSION);
    /*
     * A row written under a version this build does not read degrades to
     * absent, and the caller offers a rebuild — the same policy
     * `getCompiledRegion` already uses. Claiming it is the current version and
     * parsing it as one is a row asserting it was written under rules it has
     * never been read against.
     */
    expect(decodeStoredJob({ ...ROW, schema_version: COMPILATION_JOB_VERSION + 1 })).toBeNull();
  });

  it('treats a database written before the version column as version 1', () => {
    // The column is absent, and 1 is the honest reading: it is the only version
    // that has ever been written.
    const { ...withoutColumn } = ROW;
    expect(decodeStoredJob(withoutColumn)?.id).toBe('job-1');
  });

  it('degrades an unreadable stage list to no stages rather than throwing', () => {
    const corrupt = decodeStoredJob({ ...ROW, stages_json: '[{"stage":"expanding_regi' });
    expect(corrupt).not.toBeNull();
    expect(corrupt!.stages).toEqual([]);
    // The trip is still openable, which is the whole point.
    expect(corrupt!.state).toBe('running');
  });

  it('drops a stage entry it cannot validate without losing the job', () => {
    const bad = decodeStoredJob({
      ...ROW,
      stages_json: JSON.stringify([{ stage: 'a_stage_that_does_not_exist', status: 'done' }]),
    });
    expect(bad).not.toBeNull();
    expect(bad!.stages).toEqual([]);
  });

  it('returns nothing when the job itself is unreadable', () => {
    expect(decodeStoredJob({ ...ROW, state: 'a_state_that_does_not_exist' })).toBeNull();
  });
});

/**
 * A DEAD JOB'S CLOCK STOPS.
 *
 * `groupStages` computes a phase's elapsed time as `now − start` for as long as
 * anything in that phase is `running`, and nothing terminated the in-flight
 * record when a job failed or was cancelled. A build that died eleven minutes
 * ago rendered "Verifying what matters — 11m" and kept counting, on a job whose
 * own state said `failed`.
 */
describe('terminateOpenStages', () => {
  const now = new Date('2026-08-10T09:05:00.000Z');

  it('closes a running stage and leaves finished ones exactly as they were', () => {
    const done: StageRecord = {
      stage: 'expanding_region',
      status: 'done',
      startedAt: 'a',
      finishedAt: 'b',
      outcome: '3 bases',
    };
    const running: StageRecord = {
      stage: 'retrieving_pages',
      status: 'running',
      startedAt: 'c',
    };
    const closed = terminateOpenStages([done, running], {
      now,
      outcome: 'failed',
      note: 'One of our sources did not answer.',
    });

    expect(closed[0]).toEqual(done);
    expect(closed[1]!.status).toBe('failed');
    expect(closed[1]!.finishedAt).toBe(now.toISOString());
    expect(closed[1]!.observedFinishedAt).toBe(now.toISOString());
    expect(closed[1]!.note).toBe('One of our sources did not answer.');
  });

  it('writes a terminal record when a job died before any stage was recorded', () => {
    // No scope, no credentials, a crash between starting and the first stage.
    const closed = terminateOpenStages([], {
      now,
      outcome: 'cancelled',
      note: 'Stopped.',
      stage: 'expanding_region',
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.stage).toBe('expanding_region');
    expect(closed[0]!.status).toBe('failed');
    expect(closed[0]!.finishedAt).toBe(now.toISOString());
  });

  it('is idempotent, so a second terminal write rewrites nothing', () => {
    const once = terminateOpenStages(
      [{ stage: 'retrieving_pages', status: 'running', startedAt: 'c' }],
      { now, outcome: 'failed', note: 'gone' },
    );
    const twice = terminateOpenStages(once, {
      now: new Date('2026-08-10T09:09:00.000Z'),
      outcome: 'failed',
      note: 'gone again',
    });
    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// The pipeline, over six worlds that are not the Eastern Sierra
// ---------------------------------------------------------------------------

describe('compileRegion', () => {
  const worldKeys = Object.keys(SYNTHETIC_WORLDS) as (keyof typeof SYNTHETIC_WORLDS)[];

  for (const key of worldKeys) {
    it(`produces a schema-valid, internally consistent region for ${key}`, async () => {
      const spec = SYNTHETIC_WORLDS[key]!;
      const result = await compileRegion({
        compilationId: `test-${spec.id}`,
        scope: scopeFor(key),
        dates: DATES,
        months: MONTHS,
        providers: fakeProviders(spec),
        now: NOW,
      });

      if (!result.ok) {
        // A world may legitimately be too thin to compile; if so it must say
        // which stage stopped it rather than returning something half-built.
        expect(result.code).toBeTruthy();
        expect(result.message.length).toBeGreaterThan(10);
        return;
      }

      expect(() => compiledRegionSchema.parse(result.region)).not.toThrow();
      expect(checkRegionIntegrity(result.region)).toEqual([]);
      expect(result.region.places.length).toBeGreaterThan(0);
      expect(result.region.bases.length).toBeGreaterThan(0);
    });
  }

  it('never reports a negative or impossible leg count', async () => {
    /*
     * A live country-scale run put **"-13116 of 272 legs measured"** on a
     * traveller's screen. The numerator counted routing failures accumulated
     * across every batch the provider was asked — including points later
     * dropped — and the denominator counted pairs of the *final* id set. Two
     * populations, one subtraction.
     *
     * Counted from the matrix now, so the property is structural: measured is a
     * count of finite cells, and a count cannot exceed its own total or fall
     * below zero.
     */
    for (const key of worldKeys) {
      const stages: StageRecord[] = [];
      await compileRegion({
        compilationId: `legs-${key}`,
        scope: scopeFor(key),
        dates: DATES,
        months: MONTHS,
        providers: fakeProviders(SYNTHETIC_WORLDS[key]!),
        now: NOW,
        onStage: (record) => stages.push(record),
      });

      const routes = stages.find((record) => record.stage === 'validating_routes');
      if (!routes?.outcome) continue;
      const match = /^(-?\d+) of (-?\d+) legs measured$/.exec(routes.outcome);
      expect(match, `unreadable outcome for ${key}: ${routes.outcome}`).toBeTruthy();
      const measured = Number(match![1]);
      const total = Number(match![2]);
      expect(measured).toBeGreaterThanOrEqual(0);
      expect(total).toBeGreaterThanOrEqual(0);
      expect(measured).toBeLessThanOrEqual(total);
    }
  });

  it('never invents opening hours for a region nobody publishes them for', async () => {
    const spec = SYNTHETIC_WORLDS.weak_data!;
    const result = await compileRegion({
      compilationId: 'test-weak',
      scope: scopeFor('weak_data'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(spec),
      now: NOW,
    });
    if (!result.ok) return;

    const unknown = result.region.operatingHours.calendars.filter(
      (calendar) => calendar.kind === 'unknown',
    );
    expect(unknown.length).toBeGreaterThan(0);
    // The one value that must never appear in place of missing evidence.
    expect(
      result.region.operatingHours.calendars.every(
        (calendar) => calendar.kind !== 'always_open' || calendar.provenance.confidence > 0,
      ),
    ).toBe(true);
  });

  it('drops a place it cannot establish access for rather than assuming a road', async () => {
    const spec = SYNTHETIC_WORLDS.weak_data!;
    const result = await compileRegion({
      compilationId: 'test-weak-access',
      scope: scopeFor('weak_data'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(spec),
      now: NOW,
    });
    if (!result.ok) return;
    expect(result.region.places.length).toBeLessThan(spec.placeCount);
    expect(result.region.diagnostics.warnings.join(' ')).toMatch(/will not assume a road exists/i);
  });

  it('reports a car-free city as not-applicable for road routing rather than as a gap', async () => {
    const result = await compileRegion({
      compilationId: 'test-city',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(SYNTHETIC_WORLDS.transit_city!),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const road = result.region.coverage.dimensions.find((entry) => entry.dimension === 'road_routing');
    expect(road?.level).toBe('not_applicable');
    expect(result.region.coverage.blocksItinerary).toBe(false);
  });

  it('fails honestly when the discovery provider is down', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const result = await compileRegion({
      compilationId: 'test-outage',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      providers: failingProviders(spec),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('coverage_insufficient');
  });

  /**
   * A STOPPED BUILD SAYS WHERE IT STOPPED.
   *
   * No code path in the compiler emitted a `StageRecord` with
   * `status: 'failed'`. Three things followed from that one absence:
   * `PhaseStatus` could never be `failed`, the estimator's `degraded` bucket
   * was unreachable so every struggling run was averaged in with the healthy
   * ones, and the stage that was in flight when a build died stayed `running`
   * for as long as the row existed — which is why `groupStages`, computing
   * `now − start`, rendered "Verifying what matters — 11m" and kept counting on
   * a job that had failed eleven minutes earlier.
   */
  it('records a terminal failed stage when it stops, rather than leaving one running', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const stages: StageRecord[] = [];
    const result = await compileRegion({
      compilationId: 'test-terminal-stage',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      providers: failingProviders(spec),
      now: NOW,
      onStage: (record) => stages.push(record),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const failed = stages.filter((record) => record.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    // Named, and carrying the same sentence the traveller is given.
    expect(failed[failed.length - 1]!.note).toBe(result.message);
    // The last thing said about that stage is that it ended.
    const last = failed[failed.length - 1]!;
    const afterwards = stages.filter(
      (record) => record.stage === last.stage && record.status === 'running',
    );
    expect(stages.lastIndexOf(last)).toBeGreaterThan(
      Math.max(...afterwards.map((record) => stages.indexOf(record)), -1),
    );
    // And it carries a real timestamp on both clocks, so no phase clock runs on.
    expect(last.finishedAt).toBeTruthy();
    expect(last.observedFinishedAt).toBeTruthy();
  });

  /**
   * DEGRADATION IS DERIVED, NOT ASSERTED.
   *
   * A build that ran a counter dry or lost a provider takes a completely
   * different amount of time from a healthy one — usually less, because it
   * stopped doing things — so it belongs in its own estimator bucket. Before
   * this, the only route to the flag was a failed stage record that nothing
   * emitted, so the bucket was unreachable and every degraded run was written
   * into the healthy population a progress screen reads from.
   */
  it('marks the run and the stage degraded when a counter runs dry', async () => {
    const stages: StageRecord[] = [];
    const result = await compileRegion({
      compilationId: 'test-degraded',
      scope: scopeFor('broad_country'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(SYNTHETIC_WORLDS.broad_country!),
      budget: { maxCoarseCandidates: 6, maxShortlistedCandidates: 4 },
      now: NOW,
      onStage: (record) => stages.push(record),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.operational.degraded).toBe(true);
    expect(result.operational.degradedReasons.some((reason) => reason.startsWith('budget_exhausted:'))).toBe(
      true,
    );
    // The stage that ran the counter dry says so, and its neighbours do not.
    const marked = stages.filter((record) => record.degraded === true);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.length).toBeLessThan(stages.length);
    // A degraded stage is still `done`: it produced its result, and the phase
    // card must not read as failed because a ceiling was reached.
    expect(marked.every((record) => record.status !== 'failed')).toBe(true);
  });

  /**
   * FOUR STAGES THAT WERE PROMISED AND NEVER RECORDED.
   *
   * `compile.ts` has documented since the backbone landed that "a build with no
   * backbone provider records all four as skipped". It recorded none of them,
   * so `displayStages` synthesised four `waiting` rows and the *shaping* phase
   * read "Working" for the whole compilation — and then for ever, on a finished
   * job, because nothing was ever going to arrive.
   */
  it('records the four backbone stages as skipped when there is no pack provider', async () => {
    const stages: StageRecord[] = [];
    await compileRegion({
      compilationId: 'test-no-pack',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      // `fakeProviders` has no `regionPack`; `packBackedProviders` does.
      providers: fakeProviders(SYNTHETIC_WORLDS.transit_city!),
      now: NOW,
      onStage: (record) => stages.push(record),
    });

    for (const stage of [
      'partitioning_scope',
      'building_region_pack',
      'resolving_source_release',
      'linking_sources',
    ] as const) {
      const record = stages.filter((entry) => entry.stage === stage).pop();
      expect(record, `${stage} was never recorded`).toBeDefined();
      expect(record!.status, stage).toBe('skipped');
      // A skipped stage without a reason is indistinguishable from one that hung.
      expect(record!.note, stage).toBeTruthy();
    }
  });

  /**
   * WORK UNITS AND RETRIES ARE MEASURED WHERE THEY HAPPEN.
   *
   * The observation schema declared both with a written rationale and the
   * runner supplied `retries: 0` as a constant and `workUnits` never. A field
   * whose comment describes a value nobody writes is worse than no field.
   */
  it('reports work units per stage, and the one retry the pipeline actually makes', async () => {
    const stages: StageRecord[] = [];
    const result = await compileRegion({
      compilationId: 'test-work-units',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(SYNTHETIC_WORLDS.transit_city!),
      now: NOW,
      onStage: (record) => stages.push(record),
    });
    expect(result.ok).toBe(true);

    const withUnits = stages.filter((record) => record.workUnits !== undefined);
    expect(withUnits.length).toBeGreaterThan(0);
    expect(withUnits.every((record) => Number.isInteger(record.workUnits))).toBe(true);

    /*
     * Exactly one stage in the pipeline can honestly report a retry: routing,
     * falling back to the road network when the footpath network came back with
     * nothing. Everything else is one-shot by design, and says nothing rather
     * than reporting a zero nobody measured.
     */
    const reportsRetries = stages.filter((record) => record.retries !== undefined);
    expect(reportsRetries.map((record) => record.stage)).toEqual(
      reportsRetries.map(() => 'computing_travel_times'),
    );
  });

  it('marks a compilation partial when a budget ran out, rather than calling it complete', async () => {
    const spec = SYNTHETIC_WORLDS.broad_country!;
    const result = await compileRegion({
      compilationId: 'test-budget',
      scope: scopeFor('broad_country'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(spec),
      budget: { maxCoarseCandidates: 6, maxShortlistedCandidates: 4 },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.partial).toBe(true);
    /*
     * On the envelope. `exhausted` is derived from `consumed` against `limits`,
     * and `consumed` is exactly what a warm shared store changes — so it cannot
     * live on an artifact that has to be byte-identical across two builds of
     * the same region. What the *artifact* says about running out is in
     * `coverage`, which is where a traveller reads it.
     */
    expect(result.operational.budget.exhausted.length).toBeGreaterThan(0);
    expect(result.operational.degraded).toBe(true);
    expect(result.region.diagnostics.budget).toBeUndefined();
  });

  it('is deterministic: the same inputs compile to the same bytes', async () => {
    const spec = SYNTHETIC_WORLDS.ferry_island!;
    const run = () =>
      compileRegion({
        compilationId: 'test-determinism',
        scope: scopeFor('ferry_island'),
        dates: DATES,
        months: MONTHS,
        providers: fakeProviders(spec),
        now: NOW,
      });
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.region)).toBe(JSON.stringify(second.region));
  });

  it('claims every surviving place with exactly one forecast point', async () => {
    for (const key of worldKeys) {
      const spec = SYNTHETIC_WORLDS[key]!;
      const result = await compileRegion({
        compilationId: `test-weather-${spec.id}`,
        scope: scopeFor(key),
        dates: DATES,
        months: MONTHS,
        providers: fakeProviders(spec),
        now: NOW,
      });
      if (!result.ok) continue;
      const counts = new Map<string, number>();
      for (const location of result.region.weatherLocations) {
        for (const placeId of location.placeIds) {
          counts.set(placeId, (counts.get(placeId) ?? 0) + 1);
        }
      }
      for (const place of result.region.places) {
        expect(counts.get(place.id), `${spec.id}/${place.id}`).toBe(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The region source, and the rule that a render never recompiles
// ---------------------------------------------------------------------------

describe('dynamic region source', () => {
  it('refuses to compile a scope nobody confirmed', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const source = createDynamicRegionSource({ providers: fakeProviders(spec), now: () => NOW });
    const unconfirmed = { ...scopeFor('transit_city'), confirmedByUser: false };
    expect(source.supports({ scope: unconfirmed, dates: DATES, months: MONTHS })).toBe(false);

    // And refuses through the back door too, not only through `supports`.
    const result = await source.getCompiledRegion({ scope: unconfirmed, dates: DATES, months: MONTHS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('scope_not_confirmed');
  });

  it('serves a cached artifact rather than recompiling on a second read', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const store = new Map<string, Awaited<ReturnType<typeof compileRegion>>>();
    let compiles = 0;
    const providers = fakeProviders(spec);
    const source = createDynamicRegionSource({
      providers: {
        ...providers,
        places: {
          name: providers.places.name,
          async discover(input) {
            compiles += 1;
            return providers.places.discover(input);
          },
        },
      },
      now: () => NOW,
      lookup: (fingerprint) => {
        const hit = store.get(fingerprint);
        return hit && hit.ok ? hit.region : null;
      },
      store: (region) =>
        store.set(region.scopeFingerprint, {
          ok: true,
          region,
          partial: false,
          removals: [],
          operational: {
            schemaVersion: COMPILATION_OPERATIONAL_VERSION,
            budget: { consumed: {}, limits: {}, exhausted: [] },
            stages: [],
            retrieval: { pagesRead: 0, pagesRefused: 0, bytesRead: 0 },
            providers: [],
            sharedEvidence: {
              claimsHeld: 0,
              claimsObserved: 0,
              claimsSuperseded: 0,
              subjectsAnsweredFromClaims: 0,
              sharedResolutionsReused: 0,
            },
            degraded: false,
            degradedReasons: [],
          },
        }),
    });

    const request = { scope: scopeFor('transit_city'), dates: DATES, months: MONTHS };
    await source.getCompiledRegion(request);
    await source.getCompiledRegion(request);
    expect(compiles).toBe(1);
  });
});

/**
 * THE CUT.
 *
 * `AVAILABILITY_AFTER.finding` has promised "a provisional board — nothing on it
 * is verified yet" since Phase 11 and there was never a board. These assert the
 * two properties that make the promise meaningful rather than merely kept:
 * the board arrives **before anything is bought**, and it carries **no number
 * nobody measured**.
 *
 * Asserted here rather than in the browser because the fixture compiler finishes
 * a synthetic world in about a second — shorter than the progress screen's own
 * poll interval — so a browser test of the *ordering* would be racing the
 * environment rather than checking the product.
 */
describe('the provisional board', () => {
  const spec = SYNTHETIC_WORLDS.ferry_island!;

  function run(onProvisionalBoard?: (board: ProvisionalBoard) => void, spy?: string[]) {
    const providers = fakeProviders(spec);
    const wrapped: typeof providers = {
      ...providers,
      sourceDiscovery: {
        ...providers.sourceDiscovery,
        discover: async (...args: Parameters<typeof providers.sourceDiscovery.discover>) => {
          spy?.push('sourceDiscovery');
          return providers.sourceDiscovery.discover(...args);
        },
      },
    };
    return compileRegion({
      compilationId: 'test-provisional',
      scope: scopeFor('ferry_island'),
      dates: DATES,
      months: MONTHS,
      providers: wrapped,
      now: NOW,
      ...(onProvisionalBoard ? { onProvisionalBoard } : {}),
    });
  }

  it('is emitted exactly once, before the first billable call', async () => {
    const order: string[] = [];
    const boards: ProvisionalBoard[] = [];
    await run((board) => {
      order.push('provisional');
      boards.push(board);
    }, order);

    expect(boards).toHaveLength(1);
    expect(order[0], 'the board must land before anything is bought').toBe('provisional');
    expect(order.filter((entry) => entry === 'provisional')).toHaveLength(1);
  });

  it('claims nothing it has not measured', async () => {
    const boards: ProvisionalBoard[] = [];
    await run((board) => boards.push(board));
    const board = boards[0]!;

    expect(board.verifiedClaimCount).toBe(0);
    expect(board.travelTimesMeasured).toBe(false);
    expect(board.estimated).toBe(true);
    expect(board.cards.length).toBeGreaterThan(0);

    /*
     * The rule the separate type exists for. Serialised and searched rather than
     * field-checked, because the failure mode is a field somebody adds later —
     * and a string search catches that where a property assertion does not.
     */
    const serialised = JSON.stringify(board);
    expect(serialised).not.toMatch(/driveMinutes/);
    expect(serialised).not.toMatch(/distanceKm/);
    expect(serialised).not.toMatch(/travelFromBase/);
    expect(serialised).not.toMatch(/openMonths/);

    for (const card of board.cards) {
      expect(card.evidence).toBe('provisional');
      expect(card.pending, `${card.name} must admit it has no travel time`).toContain('travel_time');
      expect(card.preliminaryFit).toBeGreaterThanOrEqual(0);
      expect(card.preliminaryFit).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic, like the artifact it precedes', async () => {
    const first: ProvisionalBoard[] = [];
    const second: ProvisionalBoard[] = [];
    await run((board) => first.push(board));
    await run((board) => second.push(board));
    expect(JSON.stringify(first[0])).toBe(JSON.stringify(second[0]));
  });

  it('groups every card into an area that exists', async () => {
    const boards: ProvisionalBoard[] = [];
    await run((board) => boards.push(board));
    const board = boards[0]!;

    const areaIds = new Set(board.clusters.map((cluster) => cluster.id));
    for (const card of board.cards) expect(areaIds.has(card.clusterId)).toBe(true);

    const counted = board.clusters.reduce((total, cluster) => total + cluster.cardCount, 0);
    expect(counted).toBe(board.cards.length);
  });

  it('compiles unchanged when nobody is watching', async () => {
    const withHook = await run(() => {});
    const without = await run();
    expect(withHook.ok).toBe(without.ok);
    if (!withHook.ok || !without.ok) return;
    expect(JSON.stringify(withHook.region)).toBe(JSON.stringify(without.region));
  });
});

/**
 * PINNING STEERS THE QUEUE, AND NEVER LENGTHENS IT.
 *
 * The failure this guards against is a button that is also a meter: a traveller
 * pins two hundred places and the compilation buys two hundred research
 * subjects. The budget stays in charge — `maxResearchSubjects` decides *how
 * many* are looked up, and a pin only decides *which*.
 */
describe('research priority from provisional feedback', () => {
  const spec = SYNTHETIC_WORLDS.ferry_island!;

  function compile(priorityHints?: {
    pinned: string[];
    interested: string[];
    suppressed: string[];
  }) {
    return compileRegion({
      compilationId: 'test-priority',
      scope: scopeFor('ferry_island'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(spec),
      now: NOW,
      ...(priorityHints ? { priorityHints } : {}),
    });
  }

  it('does not buy more research because somebody pinned more', async () => {
    const none = await compile();
    // Every id the compilation could possibly produce, pinned. The world's own
    // shape does not matter — what matters is that the ceiling does not move.
    const everything = await compile({
      pinned: none.ok ? none.region.places.map((place) => place.id) : [],
      interested: [],
      suppressed: [],
    });

    expect(none.ok && everything.ok).toBe(true);
    if (!none.ok || !everything.ok) return;

    const subjectsOf = (result: Extract<typeof none, { ok: true }>): number =>
      result.operational.budget.consumed.maxResearchSubjects ?? 0;
    expect(subjectsOf(everything)).toBeLessThanOrEqual(subjectsOf(none));
  });

  it('leaves the compilation valid when nobody has marked anything', async () => {
    const result = await compile({ pinned: [], interested: [], suppressed: [] });
    expect(result.ok).toBe(true);
  });
});
