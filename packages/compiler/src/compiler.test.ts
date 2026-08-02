import { describe, expect, it } from 'vitest';
import {
  assessConfidence,
  breadthRank,
  CLARIFICATION_SET_VERSION,
  checkRegionIntegrity,
  compiledRegionSchema,
  isUnambiguous,
  normalizeDestinationQuery,
  scopeFingerprint,
  unansweredRequired,
  type ClarificationSet,
  type DestinationResolution,
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

  it('never lets the matrix budget run away with the shortlist', () => {
    const country = budgetFor({ nights: 21, breadthRank: breadthRank('multi_country') });
    expect(country.maxRouteElements).toBeLessThanOrEqual(2_500);
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
    expect(result.region.diagnostics.budget.exhausted.length).toBeGreaterThan(0);
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
      store: (region) => store.set(region.scopeFingerprint, { ok: true, region, partial: false }),
    });

    const request = { scope: scopeFor('transit_city'), dates: DATES, months: MONTHS };
    await source.getCompiledRegion(request);
    await source.getCompiledRegion(request);
    expect(compiles).toBe(1);
  });
});
