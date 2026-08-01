import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  checkRegionIntegrity,
  compiledRegionSchema,
  coverageFor,
  evidenceGrade,
  normalizeDestinationQuery,
  type ClarificationSet,
  type CompiledRegion,
} from '@sidequest/core';
import { compileRegion } from './compile';
import { claimsToFacts, prioritiseSubjects } from './enrich';
import { deriveScope } from './scope';
import {
  fakeProviders,
  SYNTHETIC_WORLDS,
  syntheticCandidate,
  type FakeResearchOptions,
} from './testing/fakes';

/**
 * THE RESEARCH FUNNEL, END TO END.
 *
 * These run the whole compiler over synthetic worlds with the research providers
 * configured to fail in specific ways. Each option on `FakeResearchOptions` is a
 * failure mode the live funnel has to survive, and each assertion below is a
 * behaviour that was easy to lose and expensive to lose quietly.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function scopeFor(worldKey: keyof typeof SYNTHETIC_WORLDS) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const candidate = syntheticCandidate(spec);
  const clarifications: ClarificationSet = {
    schemaVersion: CLARIFICATION_SET_VERSION,
    questions: [],
    answers: [],
  };
  const scope = deriveScope({ candidate, clarifications, nights: 3, revision: 1 });
  return {
    ...scope,
    confirmedByUser: true,
    transport: { ...scope.transport, primaryMode: spec.primaryMode },
  };
}

async function compile(
  worldKey: keyof typeof SYNTHETIC_WORLDS,
  options: FakeResearchOptions = {},
): Promise<CompiledRegion> {
  const result = await compileRegion({
    compilationId: `region-${worldKey}`,
    scope: scopeFor(worldKey),
    dates: DATES,
    months: MONTHS,
    providers: fakeProviders(SYNTHETIC_WORLDS[worldKey]!, options),
    now: NOW,
  });
  if (!result.ok) throw new Error(`compilation failed: ${result.code} ${result.message}`);
  return result.region;
}

/**
 * Facts the *research funnel* produced, as distinct from the facts a synthetic
 * world hands over to stand in for map-derived data. Only the first kind is
 * evidence of enrichment; conflating them would make several tests below pass
 * for the wrong reason.
 */
function researchedFacts(region: CompiledRegion) {
  return region.sourceManifest.facts.filter((fact) => fact.extractionPromptVersion !== undefined);
}

/** Calendars an operator published, as distinct from ones the map data implied. */
function sourcedCalendars(region: CompiledRegion) {
  return region.operatingHours.calendars.filter(
    (calendar) => calendar.kind === 'scheduled' && calendar.provenance.kind === 'official',
  );
}

/** Everything a plan could schedule: places and food venues alike. */
function subjectCount(region: CompiledRegion): number {
  return region.places.length + (region.food?.venues.length ?? 0);
}

describe('source-backed enrichment reaches the artifact', () => {
  it('produces facts, evidence and pages that the artifact actually carries', async () => {
    const region = await compile('transit_city');

    expect(researchedFacts(region).length).toBeGreaterThan(0);
    expect(region.sourceManifest.pages.length).toBeGreaterThan(0);
    expect(region.evidence?.places.length).toBeGreaterThan(0);

    // Every researched fact points at a page we recorded reading. A citation
    // nobody can follow is not a citation.
    const pageUrls = new Set(region.sourceManifest.pages.map((page) => page.url));
    for (const fact of researchedFacts(region)) {
      expect(fact.sourceUrl).toBeTruthy();
      expect(pageUrls.has(fact.sourceUrl!)).toBe(true);
    }

    // And the artifact still validates and still hangs together.
    expect(() => compiledRegionSchema.parse(region)).not.toThrow();
    expect(checkRegionIntegrity(region)).toEqual([]);
  });

  it('turns published hours into calendars the planner can enforce', async () => {
    const region = await compile('remote_road');
    const scheduled = sourcedCalendars(region);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const calendar of scheduled) {
      // An official calendar has to say when it was read; the schema insists,
      // and so does anybody deciding whether to trust it.
      expect(calendar.provenance.lastVerified).toBeTruthy();
      expect(calendar.provenance.sourceUrl).toBeTruthy();
    }
  });

  it('refuses to build a calendar when two sources disagree about the hours', async () => {
    const region = await compile('transit_city', { conflictingHours: true });
    const conflicted = (region.evidence?.places ?? []).filter((place) =>
      place.resolved.some((fact) => fact.factPath === 'hours.weekly' && fact.state === 'conflicted'),
    );
    expect(conflicted.length).toBeGreaterThan(0);

    // No conflicted subject gets an operator-sourced calendar. Whatever the map
    // data already said still stands — that is a different source with its own
    // provenance — but the disagreement never becomes an enforced schedule.
    const sourcedIds = new Set(sourcedCalendars(region).map((calendar) => calendar.placeId));
    for (const place of conflicted) {
      expect(sourcedIds.has(place.subjectId)).toBe(false);
    }
  });

  it('keeps both sides of a conflict rather than picking one silently', async () => {
    const region = await compile('transit_city', { conflictingHours: true });
    const conflicted = (region.evidence?.places ?? [])
      .flatMap((place) => place.resolved)
      .find((fact) => fact.state === 'conflicted');
    expect(conflicted?.factIds.length).toBeGreaterThanOrEqual(2);
    expect(conflicted?.rationale).toContain('disagree');
  });

  it('removes a place an official source says is shut, rather than cautioning about it', async () => {
    const open = await compile('remote_road');
    const closed = await compile('remote_road', { temporaryClosure: true });

    // One fewer thing a plan could schedule — whether it was a place or a venue,
    // the closure removed it rather than annotating it.
    expect(subjectCount(closed)).toBeLessThan(subjectCount(open));

    // And nothing that survived still carries a blocking closure.
    const survivors = new Set([
      ...closed.places.map((place) => place.id),
      ...(closed.food?.venues ?? []).map((venue) => venue.id),
    ]);
    for (const place of closed.evidence?.places ?? []) {
      if (place.closures.some((closure) => closure.severity === 'blocks')) {
        expect(survivors.has(place.subjectId)).toBe(false);
      }
    }
  });

  it('surfaces a booking requirement with somewhere to book it', async () => {
    const region = await compile('transit_city', { bookingRequired: true });
    const booked = (region.evidence?.places ?? []).find(
      (place) => place.booking?.reservationRequired === 'yes',
    );
    expect(booked).toBeDefined();
    expect(booked?.booking?.bookingUrl).toBeTruthy();
    // Telling somebody to book with nowhere to do it is a dead end; the hours
    // schema refuses it, so the calendar must carry the link too.
    const calendar = region.operatingHours.calendars.find(
      (entry) => entry.placeId === booked?.subjectId,
    );
    if (calendar && calendar.admission.reservationRequired) {
      expect(calendar.admission.bookingUrl ?? calendar.admission.note).toBeTruthy();
    }
  });

  it('records a published price and never invents a free one', async () => {
    const region = await compile('transit_city');
    const priced = (region.evidence?.places ?? []).filter((place) => place.costs.length > 0);
    expect(priced.length).toBeGreaterThan(0);
    for (const place of priced) {
      for (const cost of place.costs) {
        // Free is only ever a source's word. Everything else carries a currency.
        if (!cost.free) expect(cost.money?.currency ?? cost.note).toBeTruthy();
      }
    }
    const withoutResearch = await compile('weak_data', { officialSourceCoverage: 0 });
    for (const place of withoutResearch.evidence?.places ?? []) {
      expect(place.costs.every((cost) => !cost.free)).toBe(true);
    }
  });

  it('discards a claim with nothing quotable behind it', async () => {
    const cited = await compile('transit_city');
    const uncited = await compile('transit_city', { uncitedClaims: true });
    expect(researchedFacts(uncited).length).toBeLessThan(researchedFacts(cited).length);
  });

  it('ages evidence out and stops enforcing it', async () => {
    const region = await compile('transit_city', { staleSources: true });
    const states = (region.evidence?.places ?? []).flatMap((place) =>
      place.resolved.map((fact) => fact.state),
    );
    expect(states).toContain('stale');
    // Nothing stale becomes an operator-sourced calendar.
    expect(sourcedCalendars(region)).toHaveLength(0);
  });

  it('survives a source-discovery outage with an honest partial rather than a failure', async () => {
    const region = await compile('transit_city', { sourceDiscoveryFails: true });
    expect(region.places.length).toBeGreaterThan(0);
    expect(researchedFacts(region)).toHaveLength(0);
    const quality = coverageFor(region.coverage, 'candidate_quality');
    expect(quality?.level === 'weak' || quality?.level === 'unavailable').toBe(true);
  });

  it('survives a retrieval outage, and says pages were refused rather than absent', async () => {
    const region = await compile('transit_city', { retrievalFails: true });
    expect(researchedFacts(region)).toHaveLength(0);
    expect(region.sourceManifest.pages.length).toBeGreaterThan(0);
    expect(region.sourceManifest.pages.every((page) => page.contentBytes === 0)).toBe(true);
  });

  it('survives an extraction failure without losing the geography', async () => {
    const region = await compile('transit_city', { extractionFails: true });
    expect(region.places.length).toBeGreaterThan(0);
    expect(region.travelTimes.ids.length).toBeGreaterThan(1);
    expect(researchedFacts(region)).toHaveLength(0);
  });

  it('never spends more searches than the budget allows', async () => {
    const result = await compileRegion({
      compilationId: 'region-budget',
      scope: scopeFor('broad_country'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(SYNTHETIC_WORLDS.broad_country!, { officialSourceCoverage: 1 }),
      budget: { maxSourceSearches: 2, maxPagesFetched: 3, maxExtractionCalls: 1 },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const consumed = result.region.diagnostics.budget.consumed;
    expect(consumed.maxSourceSearches ?? 0).toBeLessThanOrEqual(2);
    expect(consumed.maxPagesFetched ?? 0).toBeLessThanOrEqual(3);
    expect(consumed.maxExtractionCalls ?? 0).toBeLessThanOrEqual(1);
    // Running out is a normal outcome that marks the region partial.
    expect(result.partial).toBe(true);
  });

  it('keeps dietary evidence cautious when only a weak hint exists', async () => {
    const region = await compile('transit_city', { weakDietaryEvidence: true });
    for (const venue of region.food?.venues ?? []) {
      for (const claim of venue.dietary) {
        // `venue_states_support` is the only level a traveller with a medical
        // requirement should act on, and it is unreachable from a hint.
        expect(claim.evidence).not.toBe('venue_states_support');
      }
    }
  });

  it('reports coverage from resolved evidence rather than from effort', async () => {
    const researched = await compile('transit_city');
    const unresearched = await compile('transit_city', { sourceDiscoveryFails: true });

    const gradeOf = (region: CompiledRegion, dimension: 'cost' | 'booking' | 'candidate_quality') => {
      const report = coverageFor(region.coverage, dimension)!;
      return evidenceGrade(report);
    };

    expect(gradeOf(unresearched, 'cost')).toBe('none');
    expect(gradeOf(researched, 'cost')).not.toBe('none');
    // Every new dimension is present on both, so a thin region is described
    // rather than silently missing rows.
    for (const dimension of ['candidate_quality', 'access_evidence', 'booking', 'cost', 'safety', 'dietary_evidence', 'planner_readiness'] as const) {
      expect(coverageFor(researched.coverage, dimension), dimension).toBeDefined();
      expect(coverageFor(unresearched.coverage, dimension), dimension).toBeDefined();
    }
  });

  it('is deterministic with research on: the same inputs compile to the same bytes', async () => {
    const first = await compile('ferry_island', { bookingRequired: true });
    const second = await compile('ferry_island', { bookingRequired: true });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('exposes the research stages individually rather than as one opaque step', async () => {
    const stages: string[] = [];
    await compileRegion({
      compilationId: 'region-stages',
      scope: scopeFor('transit_city'),
      dates: DATES,
      months: MONTHS,
      providers: fakeProviders(SYNTHETIC_WORLDS.transit_city!),
      now: NOW,
      onStage: (record) => {
        if (record.status !== 'running') stages.push(record.stage);
      },
    });
    for (const stage of [
      'filtering_quality',
      'enriching_priority_candidates',
      'discovering_sources',
      'retrieving_pages',
      'extracting_facts',
      'reconciling_facts',
      'resolving_hours_and_access',
      'resolving_costs',
      'resolving_safety',
      'enriching_food',
      'validating_routes',
    ]) {
      expect(stages, stage).toContain(stage);
    }
  });
});

describe('research prioritisation', () => {
  const candidate = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    kind: 'museum',
    locality: 'Somewhere',
    coordinates: { lat: 0, lng: 0 },
    fitScore: 0.5,
    gated: false,
    hoursUnknown: false,
    ...overrides,
  });

  it('spends on the candidates whose unknown hours would change the plan', () => {
    const chosen = prioritiseSubjects({
      candidates: [
        candidate('ungated-good-fit', { fitScore: 0.7 }),
        candidate('gated-unknown-hours', { fitScore: 0.5, gated: true, hoursUnknown: true }),
      ],
      maxSubjects: 1,
    });
    expect(chosen[0]!.id).toBe('gated-unknown-hours');
  });

  it('is deterministic and bounded', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => candidate(`c${index}`));
    const a = prioritiseSubjects({ candidates, maxSubjects: 5 });
    const b = prioritiseSubjects({ candidates: [...candidates].reverse(), maxSubjects: 5 });
    expect(a).toHaveLength(5);
    expect(a.map((entry) => entry.id)).toEqual(b.map((entry) => entry.id));
  });
});

describe('claims become facts only when they can be defended', () => {
  const document = {
    subjectId: 's1',
    url: 'https://operator.example/visit',
    text: 'Open 09:00 to 17:00.',
    structuredData: [],
    contentHash: 'sha-1',
    contentBytes: 100,
    retrievedAt: '2026-07-20T00:00:00.000Z',
    robotsAllowed: true,
    authority: 'operator' as const,
    publisher: 'operator.example',
    domain: 'operator.example',
  };

  it('drops a claim pointing at a page that was never fetched', () => {
    const result = claimsToFacts({
      claims: [
        {
          subjectId: 's1',
          documentIndex: 9,
          factPath: 'duration.typical',
          statement: 'Allow an hour.',
          evidenceExcerpt: 'Allow about an hour.',
          derivation: 'directly_stated',
          payload: { minutes: 60 },
        },
      ],
      documents: [document],
      promptVersion: 'p/1',
      schemaVersion: 's/1',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(result.facts).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('drops a claim attributed to a page about a different subject', () => {
    const result = claimsToFacts({
      claims: [
        {
          subjectId: 'somebody-else',
          documentIndex: 0,
          factPath: 'duration.typical',
          statement: 'Allow an hour.',
          evidenceExcerpt: 'Allow about an hour.',
          derivation: 'directly_stated',
          payload: { minutes: 60 },
        },
      ],
      documents: [document],
      promptVersion: 'p/1',
      schemaVersion: 's/1',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(result.facts).toHaveLength(0);
  });

  it('drops a payload that does not validate rather than coercing it', () => {
    const result = claimsToFacts({
      claims: [
        {
          subjectId: 's1',
          documentIndex: 0,
          factPath: 'cost.admission',
          statement: 'Twelve pounds.',
          evidenceExcerpt: 'Admission £12',
          derivation: 'directly_stated',
          payload: { currency: 'POUNDS', amount: 'twelve' },
        },
      ],
      documents: [document],
      promptVersion: 'p/1',
      schemaVersion: 's/1',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(result.facts).toHaveLength(0);
    expect(result.discarded).toBe(1);
  });

  it('stamps every surviving fact with the prompt and schema that produced it', () => {
    const result = claimsToFacts({
      claims: [
        {
          subjectId: 's1',
          documentIndex: 0,
          factPath: 'duration.typical',
          statement: 'Allow an hour.',
          evidenceExcerpt: 'Allow about an hour.',
          derivation: 'directly_stated',
          payload: { minutes: 60 },
        },
      ],
      documents: [document],
      promptVersion: 'p/1',
      schemaVersion: 's/1',
      modelId: 'a-model',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const fact = result.facts[0]!;
    expect(fact.extractionPromptVersion).toBe('p/1');
    expect(fact.modelId).toBe('a-model');
    expect(fact.contentHash).toBe('sha-1');
    expect(fact.sourceDomain).toBe('operator.example');
    // The model is an attribution, never an authority.
    expect(fact.authorityKind).toBe('operator');
  });
});

void normalizeDestinationQuery;

describe('the shortlist is ranked by evidence, not by an inverted proxy for it', () => {
  it('keeps described candidates ahead of bare ones when the budget cuts', async () => {
    /**
     * The live defect: the old ranking added a corroboration score to
     * `hiddenGemScore`, which is computed as the inverse of how richly a place is
     * tagged — so the two terms cancelled and the cut was very nearly arbitrary.
     * A New York compile shortlisted thirty-six of ninety-six candidates, and
     * thirty-three of those had nothing published about them at all.
     */
    const region = await compile('broad_country');
    const kept = new Set(region.places.map((place) => place.id));
    expect(kept.size).toBeGreaterThan(0);

    // Nothing that survived the cut should be a record with no description and
    // no recorded attributes — those are exactly what the cut is for.
    for (const place of region.places) {
      const described =
        place.shortDescription.trim().length > 40 ||
        place.tags.some((tag) => tag.startsWith('attr:'));
      expect(described, `${place.name} survived with no evidence at all`).toBe(true);
    }
  });
});

describe('food does not crowd attractions out of the research budget', () => {
  const candidate = (id: string, isFood: boolean) => ({
    id,
    name: id,
    kind: isFood ? 'restaurant' : 'museum',
    locality: 'Somewhere',
    coordinates: { lat: 0, lng: 0 },
    // The shape that caused the defect: every venue is gated with unknown hours,
    // so on raw score alone food wins every slot.
    fitScore: 0.5,
    gated: true,
    hoursUnknown: true,
    isFood,
  });

  it('caps the share of researched subjects that are places to eat', () => {
    const chosen = prioritiseSubjects({
      candidates: [
        ...Array.from({ length: 18 }, (_, index) => candidate(`food-${index}`, true)),
        ...Array.from({ length: 18 }, (_, index) => candidate(`place-${index}`, false)),
      ],
      maxSubjects: 20,
    });
    const food = chosen.filter((entry) => entry.id.startsWith('food-')).length;
    expect(chosen).toHaveLength(20);
    expect(food).toBeLessThanOrEqual(7);
    expect(chosen.length - food).toBeGreaterThanOrEqual(13);
  });

  it('gives the slots back to food when there is nothing else to research', () => {
    const chosen = prioritiseSubjects({
      candidates: Array.from({ length: 10 }, (_, index) => candidate(`food-${index}`, true)),
      maxSubjects: 8,
    });
    // The cap stops kitchens crowding out attractions; it does not leave budget
    // unspent in a region that has none.
    expect(chosen).toHaveLength(8);
  });
});
