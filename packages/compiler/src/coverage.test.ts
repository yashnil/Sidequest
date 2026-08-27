import {
  CLARIFICATION_SET_VERSION,
  OPERATING_HOURS_DATASET_VERSION,
  REGION_EVIDENCE_VERSION,
  type AccessRule,
  type ClarificationSet,
  type CoverageDimensionReport,
  type OperatingHoursDataset,
  type Place,
  type PlaceEvidence,
  type RegionEvidence,
  type ResolvedFact,
  type SourceFact,
  type SourceProvenance,
  type TransportService,
  sourceFactSchema,
} from '@sidequest/core';
import { describe, expect, it } from 'vitest';
import { BudgetLedger, DEFAULT_COMPILER_BUDGET } from './budget';
import { compileRegion } from './compile';
import { buildCoverageReport, type CoverageInput } from './coverage';
import type { RoutingMatrixResult } from './providers';
import { deriveScope } from './scope';
import { SYNTHETIC_WORLDS, syntheticCandidate, syntheticPlace } from './testing/fakes';
import { packBackedProviders } from './testing/pack-fakes';

/**
 * THE ROW THAT SAYS WHERE THIS IS, AND WHY IT MAY NOT SAY IT LIGHTLY.
 *
 * `geographic_resolution` is one of three dimensions that block an itinerary
 * outright, and it used to be graded `high` the moment one place survived —
 * printing "The region resolved to a real boundary and everything below sits
 * inside it." On the Tokyo artifact stored on this machine neither half was
 * true: the scope's edge is a reach circle drawn around a centre point, and
 * 3,767 of the pack's 3,787 records came back with no membership verdict at all.
 * The blocking row was asserting the one thing it most needs to prove, from a
 * count that cannot support it.
 *
 * Every case here is written so that it fails if the grade can climb back to
 * `high` without the two pieces of evidence the sentence rests on.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');

const NO_HOURS: OperatingHoursDataset = {
  version: OPERATING_HOURS_DATASET_VERSION,
  regionId: 'coverage-test',
  calendars: [],
};

function matrixFor(places: readonly Place[]): RoutingMatrixResult {
  const ids = places.map((place) => place.id);
  return {
    ids,
    minutes: ids.map(() => ids.map(() => 10)),
    km: ids.map(() => ids.map(() => 6)),
    provenance: { kind: 'measured', note: 'test' },
    failedPairs: [],
    calls: 1,
    elements: ids.length * ids.length,
  };
}

/**
 * Everything except the geography evidence, held constant.
 *
 * The other dimensions are exercised elsewhere; what varies between these cases
 * is the edge and the placement arithmetic, and nothing else, so a difference in
 * the geography row can only have come from those two.
 */
function inputWith(geography: CoverageInput['geography'], placeCount = 8): CoverageInput {
  const spec = SYNTHETIC_WORLDS.transit_city!;
  const places = Array.from({ length: placeCount }, (_, index) => syntheticPlace(spec, index));
  return {
    places,
    hours: NO_HOURS,
    weatherLocations: [],
    foodVenueCount: 0,
    matrix: matrixFor(places),
    matrixMode: 'foot',
    facts: [],
    gaps: [],
    ledger: new BudgetLedger(DEFAULT_COMPILER_BUDGET, NOW.getTime()),
    drivingPlanned: false,
    walkingPlanned: true,
    ...(geography ? { geography } : {}),
    now: NOW,
  };
}

/* ------------------------------------------------------------------ *
 * Fixtures for the rows the same audit found afterwards
 * ------------------------------------------------------------------ */

/** A report row by name, so a missing row fails loudly rather than as `undefined`. */
function rowFor(input: CoverageInput, dimension: string): CoverageDimensionReport {
  const row = buildCoverageReport(input).dimensions.find(
    (entry) => entry.dimension === dimension,
  );
  expect(row, dimension).toBeDefined();
  return row!;
}

/** Places with the two scores and the category under this file's control. */
function placesWith(
  count: number,
  shape: (index: number) => Partial<Pick<Place, 'popularityScore' | 'hiddenGemScore' | 'category'>>,
): Place[] {
  const spec = SYNTHETIC_WORLDS.transit_city!;
  return Array.from({ length: count }, (_, index) => ({
    ...syntheticPlace(spec, index),
    popularityScore: 0.1,
    hiddenGemScore: 0.1,
    category: 'museum' as Place['category'],
    ...shape(index),
  }));
}

const OFFICIAL: SourceProvenance = {
  kind: 'official',
  sourceName: 'Synthetic authority',
  sourceUrl: 'https://example.org/access',
  lastVerified: '2026-07-01',
  confidence: 0.9,
  volatility: 'stable',
};

const MODELLED: SourceProvenance = {
  kind: 'estimated',
  sourceName: 'Modelled from map data',
  confidence: 0.4,
  volatility: 'stable',
};

function ruleFor(place: Place, provenance: SourceProvenance): AccessRule {
  return {
    id: `rule-${place.id}`,
    label: `Access to ${place.name}`,
    placeIds: [place.id],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    approachMode: 'walk',
    approachMinutes: null,
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 0,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [],
    provenance,
  };
}

function crossing(mode: 'ferry' | 'rail' | 'public_bus'): TransportService {
  return {
    id: `service-${mode}`,
    label: `The ${mode} service`,
    operator: 'Synthetic operator',
    mode,
    boardingPointId: 'gateway-a',
    dropOffPointId: 'gateway-b',
    operatingMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    window: { firstDeparture: 7 * 60, lastOutboundDeparture: 17 * 60, lastReturnDeparture: 19 * 60 },
    rideMinutes: 25,
    transferBufferMinutes: 10,
    provenance: OFFICIAL,
  };
}

/** One researched place carrying `answered` access facts and nothing else. */
function placeEvidence(subjectId: string, answered: number): PlaceEvidence {
  const resolved: ResolvedFact[] = Array.from({ length: answered }, (_, index) => ({
    subjectId,
    factPath: index % 2 === 0 ? ('access.method' as const) : ('access.permit' as const),
    state: 'verified' as const,
    factIds: [`fact-${subjectId}-${index}`],
    independentSources: 1,
    rationale: 'Stated on the operator’s own page.',
  }));
  return { subjectId, aliases: [], costs: [], closures: [], safety: [], resolved };
}

function evidenceOver(shape: readonly number[]): RegionEvidence {
  return {
    version: REGION_EVIDENCE_VERSION,
    places: shape.map((answered, index) => placeEvidence(`subject-${index}`, answered)),
    regionSafety: [],
  };
}

/**
 * A researched place, with the two things `candidate_quality` has to tell apart.
 *
 * `link` is where the operator's URL came from. `'map_tag'` is the production
 * case — `compile.ts` lifts it off `place.source.url`, `enrich.ts` mints its
 * claim through `knownClaim`, and `knownClaim` writes no `factId` because there
 * is no fact: nobody fetched anything. `'fetched'` is the same URL established
 * by a resolved fact, which is the only version that means a page was read.
 */
function researchedPlace(
  subjectId: string,
  options: { answers: number; link?: 'map_tag' | 'fetched' },
): PlaceEvidence {
  const resolved: ResolvedFact[] = [
    ...Array.from({ length: options.answers }, (_, index) => ({
      subjectId,
      factPath: 'hours.weekly' as const,
      state: 'verified' as const,
      acceptedFactId: `fact-${subjectId}-${index}`,
      factIds: [`fact-${subjectId}-${index}`],
      independentSources: 1,
      rationale: 'Stated on the operator’s own page.',
    })),
    /*
     * The shape of a question that was asked and could not be answered. Present
     * on every real subject, which is why "has a resolved entry" cannot be the
     * test and the *state* has to be.
     */
    {
      subjectId,
      factPath: 'cost.admission' as const,
      state: 'unknown' as const,
      factIds: [],
      independentSources: 0,
      rationale: 'Nothing published said.',
    },
  ];
  return {
    subjectId,
    aliases: [],
    costs: [],
    closures: [],
    safety: [],
    resolved,
    ...(options.link
      ? {
          officialUrl: `https://example.org/${subjectId}`,
          officialUrlClaim:
            options.link === 'fetched'
              ? {
                  factId: `fact-${subjectId}-site`,
                  state: 'verified' as const,
                  factPath: 'identity.officialSite' as const,
                }
              : { state: 'single_source' as const, factPath: 'identity.officialSite' as const },
        }
      : {}),
  };
}

/**
 * A place with an answer on every evidence path, so the four evidence rows all
 * grade above the line. Used only to reach the summary's `weak.length === 0`
 * branch, which is otherwise unreachable and would leave that branch untested.
 */
function wellDocumented(subjectId: string): PlaceEvidence {
  const answered = (factPath: ResolvedFact['factPath']): ResolvedFact => ({
    subjectId,
    factPath,
    state: 'verified',
    acceptedFactId: `fact-${subjectId}-${factPath}`,
    factIds: [`fact-${subjectId}-${factPath}`],
    independentSources: 1,
    rationale: 'Stated on the operator’s own page.',
  });
  return {
    subjectId,
    aliases: [],
    costs: [
      {
        kind: 'admission',
        free: false,
        money: {
          amount: 10,
          currency: 'USD',
          unit: 'per_person',
          estimated: false,
          taxesUncertain: false,
        },
        advancePurchaseRequired: 'unknown',
        claim: { state: 'verified' },
      },
    ],
    closures: [],
    safety: [
      {
        statement: 'Bring water on the exposed section.',
        severity: 'informs',
        requires: [],
        claim: { state: 'verified' },
      },
    ],
    resolved: [
      answered('access.method'),
      answered('booking.required'),
      answered('cost.admission'),
      answered('safety.caution'),
    ],
  };
}

function evidenceOf(places: readonly PlaceEvidence[]): RegionEvidence {
  return { version: REGION_EVIDENCE_VERSION, places: [...places], regionSafety: [] };
}

/** A fact that never expires, so `temporary_access` sees a non-empty table with nothing seasonal in it. */
function stableFact(id: string): SourceFact {
  return sourceFactSchema.parse({
    id,
    subjectId: 'subject-0',
    kind: 'general',
    statement: 'The main gate is on the north side.',
    authorityKind: 'managing_authority',
    authorityName: 'Synthetic authority',
    sourceUrl: 'https://example.org/about',
    retrievedAt: '2026-08-01T00:00:00.000Z',
    derivation: 'directly_stated',
    volatility: 'stable',
    recheckRequired: false,
  });
}

/** A fact that changes with the season, so `temporary_access` has something to report. */
function seasonalFact(id: string): SourceFact {
  return sourceFactSchema.parse({
    id,
    subjectId: 'subject-0',
    kind: 'general',
    statement: 'The north road closes over winter.',
    authorityKind: 'managing_authority',
    authorityName: 'Synthetic authority',
    sourceUrl: 'https://example.org/seasonal',
    retrievedAt: '2026-08-01T00:00:00.000Z',
    derivation: 'directly_stated',
    volatility: 'seasonal_recurring',
    recheckRequired: false,
  });
}

function geographyRow(input: CoverageInput) {
  const row = buildCoverageReport(input).dimensions.find(
    (entry) => entry.dimension === 'geographic_resolution',
  );
  expect(row).toBeDefined();
  return row!;
}

describe('geographic_resolution grades on the edge and on what was placed against it', () => {
  it('refuses a good grade for a reach circle, however well everything was placed', () => {
    /*
     * The Tokyo shape, minus the Tokyo failure: containment placed every single
     * record positively. That is the strongest placement evidence obtainable,
     * and it still cannot make "the region resolved to a real boundary" true —
     * nobody published a boundary. A circle drawn at a travelling distance from
     * a centre point is a statement about the traveller, not about where the
     * destination ends.
     */
    const row = geographyRow(
      inputWith({
        boundaryEvidence: 'reach_circle',
        placement: { read: 3787, placed: 3787, inside: 3787 },
      }),
    );
    expect(row.level).not.toBe('high');
    expect(row.level).toBe('usable_with_cautions');
    expect(row.detail).toMatch(/Nobody publishes an outline/i);
    expect(row.detail).not.toMatch(/resolved to a real boundary/i);
  });

  it('grades the live Tokyo arithmetic as thin rather than as good', () => {
    /*
     * The numbers off the stored artifact: a reach circle for an edge, and
     * 3,767 of 3,787 records with no membership verdict. Before this row was
     * graded on evidence it read "Good — The region resolved to a real boundary
     * and everything below sits inside it."
     */
    const row = geographyRow(
      inputWith({
        boundaryEvidence: 'reach_circle',
        placement: { read: 3787, placed: 20, inside: 20 },
      }),
    );
    expect(row.level).toBe('weak');
    expect(row.detail).toContain('3787');
    expect(row.detail).toContain('20');
    expect(row.reasons).toContain('partial_results_returned');
  });

  it('refuses a good grade when a published boundary could place almost nothing', () => {
    /*
     * The other half of the pair. A real published outline is not on its own a
     * statement that anything sits inside it, so the same near-zero placement
     * share has to grade thin even with the best possible edge.
     */
    const row = geographyRow(
      inputWith({
        boundaryEvidence: 'published_boundary',
        placement: { read: 3787, placed: 20, inside: 20 },
      }),
    );
    expect(row.level).toBe('weak');
  });

  it('refuses a good grade when everything placed landed somewhere other than the destination', () => {
    const row = geographyRow(
      inputWith({
        boundaryEvidence: 'published_boundary',
        placement: { read: 400, placed: 400, inside: 0 },
      }),
    );
    expect(row.level).toBe('weak');
    expect(row.detail).toMatch(/not one of them inside the destination/i);
  });

  it('says it does not know rather than claiming a boundary when nothing measured placement', () => {
    const row = geographyRow(inputWith({ boundaryEvidence: 'measured_extent' }));
    expect(row.level).toBe('usable_with_cautions');
    expect(row.reasons).toContain('inferred_not_sourced');
    expect(row.detail).toMatch(/Nothing on this build checked/i);
  });

  it('grades good only when there is a real edge and nearly everything was placed against it', () => {
    const row = geographyRow(
      inputWith({
        boundaryEvidence: 'measured_extent',
        placement: { read: 400, placed: 396, inside: 380 },
      }),
    );
    expect(row.level).toBe('high');
    expect(row.reasons).toEqual(['fully_covered']);
    expect(row.detail).toContain('396');
    expect(row.detail).toContain('380');
  });
});

describe('the other rows found by the same audit', () => {
  /**
   * Two more grades that were derived from a proxy their own sentence could not
   * support. Both are the geography row's shape in different clothes.
   */
  it('does not call an empty fact table fresh', () => {
    const row = buildCoverageReport(inputWith(undefined)).dimensions.find(
      (entry) => entry.dimension === 'source_freshness',
    );
    expect(row).toBeDefined();
    /*
     * Zero facts read means zero stale facts, and this row graded that `high`
     * and printed "Everything here was read within its own freshness window".
     */
    expect(row!.level).not.toBe('high');
    expect(row!.detail).not.toMatch(/read within its own freshness window/i);
    expect(row!.detail).toMatch(/nothing to say about how recently/i);
  });

  it('does not call an estimated travel matrix measured on the row that says a plan is possible', () => {
    const input = inputWith(undefined);
    const row = buildCoverageReport({
      ...input,
      matrix: {
        ...input.matrix,
        provenance: { kind: 'estimated', note: 'straight-line fallback' },
      },
    }).dimensions.find((entry) => entry.dimension === 'planner_readiness');
    expect(row).toBeDefined();
    expect(row!.detail).toContain('estimated travel between them');
    expect(row!.detail).not.toContain('measured travel between them');
  });
});

describe('ferry_or_rail counts the crossings we hold rather than the modes we were allowed', () => {
  /**
   * The dead branch. `hasWaterOrRail` came off `scope.transport.allowedModes`,
   * and `deriveScope` grants `rail` on every trip it builds — so the row's
   * `not_applicable` case could not be reached in production and every
   * destination on earth, coast or no coast, was told "Crossings are modelled as
   * services with calendars" over a build holding no service at all.
   */
  it('reports an empty timetable as empty rather than as modelled crossings', () => {
    const row = rowFor({ ...inputWith(undefined), access: { rules: [], services: [] } }, 'ferry_or_rail');
    expect(row.level).toBe('unavailable');
    expect(row.detail).not.toMatch(/Crossings are modelled/i);
    expect(row.detail).not.toMatch(/No ferries and no passenger rail in this region/i);
    expect(row.detail).toMatch(/We hold no ferry or train timetable/i);
  });

  it('does not turn a bus network into a crossing', () => {
    const row = rowFor(
      { ...inputWith(undefined), access: { rules: [], services: [crossing('public_bus')] } },
      'ferry_or_rail',
    );
    expect(row.level).toBe('unavailable');
  });

  it('names the crossings when there are some', () => {
    const row = rowFor(
      { ...inputWith(undefined), access: { rules: [], services: [crossing('ferry'), crossing('rail')] } },
      'ferry_or_rail',
    );
    expect(row.level).toBe('usable_with_cautions');
    expect(row.detail).toMatch(/^2 ferry or train services/);
  });

  it('says it does not know rather than reporting a zero when no access layer ran', () => {
    const row = rowFor(inputWith(undefined), 'ferry_or_rail');
    expect(row.detail).toMatch(/Nothing on this build recorded/i);
    expect(row.reasons).toContain('inferred_not_sourced');
  });
});

describe('transportation grades on the access rules, not on a headcount', () => {
  it('refuses to claim every place has a way in when only some do', () => {
    const base = inputWith(undefined, 8);
    const row = rowFor(
      { ...base, access: { rules: base.places.slice(0, 3).map((place) => ruleFor(place, OFFICIAL)), services: [] } },
      'transportation',
    );
    expect(row.detail).toBe(
      '3 of 8 places have a recorded way in, 3 of them published by whoever runs the place.',
    );
    expect(row.detail).not.toMatch(/Every place carries an access rule/i);
    expect(row.level).toBe('weak');
    expect(row.covered).toBe(3);
    expect(row.expected).toBe(8);
  });

  /**
   * The half a place count could never see. Both builds have a rule for every
   * place; only one of them has a rule anybody published, and a grade that
   * cannot tell those apart is describing our own modelling as evidence.
   */
  it('separates a rule we worked out from a rule the operator published', () => {
    const base = inputWith(undefined, 8);
    const published = rowFor(
      { ...base, access: { rules: base.places.map((place) => ruleFor(place, OFFICIAL)), services: [] } },
      'transportation',
    );
    const modelled = rowFor(
      { ...base, access: { rules: base.places.map((place) => ruleFor(place, MODELLED)), services: [] } },
      'transportation',
    );
    expect(published.level).toBe('high');
    expect(modelled.level).toBe('usable_with_cautions');
    expect(modelled.detail).toContain('0 of them published by whoever runs the place');
    expect(modelled.reasons).toContain('no_official_source_found');
  });

  it('says it does not know rather than grading on a place count when no access layer ran', () => {
    const row = rowFor(inputWith(undefined, 8), 'transportation');
    expect(row.level).toBe('usable_with_cautions');
    expect(row.detail).toMatch(/Nothing on this build recorded how these places are reached/i);
    expect(row.covered).toBeUndefined();
  });
});

describe('access_evidence divides places by places', () => {
  /**
   * THE UNIT MISMATCH.
   *
   * The old grade was `answered / researched` — every `access.*` fact summed
   * over every researched place, divided by the number of places. One
   * well-documented museum with twenty facts among ten places produced a ratio
   * of 2.0 and printed "Good — getting in", from one building.
   */
  it('does not let one thoroughly researched place grade the whole region', () => {
    const row = rowFor(
      { ...inputWith(undefined), evidence: evidenceOver([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      'access_evidence',
    );
    expect(row.level).toBe('weak');
    expect(row.detail).toBe(
      '1 of 10 researched places have a sourced statement about getting in.',
    );
    expect(row.covered).toBe(1);
    expect(row.expected).toBe(10);
  });

  it('cannot produce a ratio above one', () => {
    const report = buildCoverageReport({
      ...inputWith(undefined),
      evidence: evidenceOver([9, 9, 9]),
    });
    const row = report.dimensions.find((entry) => entry.dimension === 'access_evidence')!;
    expect(row.covered).toBeLessThanOrEqual(row.expected!);
    expect(row.level).toBe('high');
  });
});

describe('candidate_quality counts what came back, not links printed on map records', () => {
  /**
   * THE ROW THAT TOLD A TRAVELLER WE HAD READ PAGES NOBODY FETCHED.
   *
   * It was `officialUrl !== undefined`, graded as a share of researched places
   * and printed as "N of M researched places have an official page behind them".
   * `officialUrl` is filled from the `website` tag that travelled with the map
   * record — `identity.officialSite` is deliberately never a wanted path, so the
   * fact branch of that chain is unreachable in production and **every** count
   * the row produced came from a string in a map record.
   *
   * Both halves are asserted: the sentence may not claim a page was read, and
   * the *grade* may not climb on links alone.
   */
  it('refuses a good grade for map records that carry a website nobody opened', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        evidence: evidenceOf(
          Array.from({ length: 10 }, (_, index) =>
            researchedPlace(`subject-${index}`, { answers: 0, link: 'map_tag' }),
          ),
        ),
      },
      'candidate_quality',
    );
    /* Ten of ten links used to be a ratio of 1.0, which is `high`. */
    expect(row.level).not.toBe('high');
    expect(row.level).toBe('unavailable');
    expect(row.covered).toBe(0);
    expect(row.detail).not.toMatch(/have an official page behind them/i);
    expect(row.detail).toMatch(/Nothing we looked up came back with a published statement/i);
    /* The links are still reported — as links, and as unopened. */
    expect(row.detail).toMatch(/10 carry a website the map data listed for them/i);
    expect(row.detail).toMatch(/nothing here has opened/i);
  });

  it('grades on the places that came back with something a source states', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        evidence: evidenceOf(
          Array.from({ length: 10 }, (_, index) =>
            researchedPlace(`subject-${index}`, {
              answers: index < 3 ? 2 : 0,
              /* Every one of them carries a link, so only the answers can move the grade. */
              link: 'map_tag',
            }),
          ),
        ),
      },
      'candidate_quality',
    );
    expect(row.covered).toBe(3);
    expect(row.expected).toBe(10);
    expect(row.level).toBe('weak');
    expect(row.detail).toMatch(/^3 of 10 places we looked up came back with something/);
  });

  it('separates a link a fetched fact established from a link a map record listed', () => {
    const fetched = rowFor(
      {
        ...inputWith(undefined),
        evidence: evidenceOf([researchedPlace('subject-0', { answers: 1, link: 'fetched' })]),
      },
      'candidate_quality',
    );
    const listed = rowFor(
      {
        ...inputWith(undefined),
        evidence: evidenceOf([researchedPlace('subject-0', { answers: 1, link: 'map_tag' })]),
      },
      'candidate_quality',
    );
    /* Same grade — the answer is what grades — and two different sentences. */
    expect(fetched.level).toBe(listed.level);
    expect(fetched.detail).not.toMatch(/map data listed/i);
    expect(listed.detail).toMatch(/1 carry a website the map data listed/i);
  });

  /**
   * THE ANTI-VACUITY CASE.
   *
   * The three above build their own evidence, so they prove the rule and not the
   * wiring. This drives the real `compileRegion` over a pack-backed world and
   * first asserts the world is one where the defect was reachable — it publishes
   * map-record websites and **not one** of them is backed by a resolved fact —
   * then asserts the row describes what came back rather than those links.
   */
  it('describes a real compilation by what it retrieved, over a pack that publishes links', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const clarifications: ClarificationSet = {
      schemaVersion: CLARIFICATION_SET_VERSION,
      questions: [],
      answers: [],
    };
    const scope = {
      ...deriveScope({
        candidate: syntheticCandidate(spec),
        clarifications,
        nights: 4,
        revision: 1,
      }),
      confirmedByUser: true,
    };
    const result = await compileRegion({
      compilationId: 'coverage-candidate-quality',
      scope,
      dates: ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'],
      months: [8],
      providers: packBackedProviders(spec),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evidencePlaces = result.region.evidence?.places ?? [];
    const linked = evidencePlaces.filter((place) => place.officialUrl !== undefined);
    expect(linked.length, 'the world must publish links for this case to mean anything').toBeGreaterThan(0);
    expect(
      linked.filter((place) => place.officialUrlClaim?.factId !== undefined),
      'not one link in a real compilation is backed by a fetched fact',
    ).toHaveLength(0);

    const row = result.region.coverage.dimensions.find(
      (entry) => entry.dimension === 'candidate_quality',
    );
    expect(row).toBeDefined();
    expect(row!.detail).not.toMatch(/have an official page behind them/i);
    expect(row!.detail).toMatch(/came back with something a published source states/i);
    expect(row!.detail).toMatch(new RegExp(`${linked.length} carry a website the map data listed`));
    /*
     * The number that grades is the count of places that answered, which is a
     * different number from the link count on this world. Equal counts would let
     * a link-based grade satisfy this case.
     */
    expect(row!.covered).not.toBe(linked.length);
    expect(row!.covered).toBe(
      evidencePlaces.filter((place) =>
        place.resolved.some((fact) => fact.state !== 'unknown' && fact.state !== 'unavailable'),
      ).length,
    );
  });
});

describe('planner_readiness counts places, not matrix nodes', () => {
  /**
   * `matrix.ids` also holds bases, food venues and gateways. The old test was
   * `placeCount >= 4 && matrix.ids.length > 1`, so four places and a matrix made
   * of one place plus three hotels passed it — and the row then printed "Enough
   * to lay out days: 4 places with measured travel between them" over three
   * places with no measurable leg to anything.
   */
  it('refuses to call a trip plannable when the matrix holds bases rather than places', () => {
    const base = inputWith(undefined, 5);
    const row = rowFor(
      {
        ...base,
        matrix: {
          ...base.matrix,
          ids: [base.places[0]!.id, 'base-a', 'base-b', 'food-a'],
        },
      },
      'planner_readiness',
    );
    expect(row.level).toBe('unavailable');
    expect(row.detail).toBe('Not enough here to lay out a day around.');
  });

  it('counts the places the matrix actually measured in the sentence', () => {
    const base = inputWith(undefined, 6);
    const row = rowFor(
      {
        ...base,
        matrix: {
          ...base.matrix,
          ids: [...base.places.slice(0, 4).map((place) => place.id), 'base-a'],
        },
      },
      'planner_readiness',
    );
    expect(row.detail).toContain('4 places with measured travel between them');
    expect(row.detail).not.toContain('6 places');
  });
});

describe('natural_features reports our sample, not the destination', () => {
  it('does not declare a destination free of landscape because we found none', () => {
    const row = rowFor(
      { ...inputWith(undefined), places: placesWith(8, () => ({ category: 'museum' })) },
      'natural_features',
    );
    expect(row.detail).not.toMatch(/Nothing here is landscape/i);
    expect(row.detail).toMatch(/We did not find any lakes, viewpoints, trails or open ground here/i);
    expect(row.level).not.toBe('not_applicable');
    expect(row.level).toBe('unavailable');
  });

  it('does not call one lake among eight stops good coverage of the outdoors', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        places: placesWith(8, (index) => ({ category: index === 0 ? 'lake' : 'museum' })),
      },
      'natural_features',
    );
    expect(row.level).toBe('weak');
    expect(row.detail).toBe('1 of the 8 places we found are lakes, viewpoints, trails or open ground.');
  });

  it('grades good only when there is enough landscape to build a day around', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        places: placesWith(8, (index) => ({ category: index < 6 ? 'viewpoint' : 'museum' })),
      },
      'natural_features',
    );
    expect(row.level).toBe('high');
  });
});

describe('temporary_access separates "we read nothing" from "we read nothing seasonal"', () => {
  it('does not report an empty fact table as a region nobody publishes closures for', () => {
    const row = rowFor({ ...inputWith(undefined), facts: [] }, 'temporary_access');
    expect(row.detail).not.toMatch(/Nobody publishes closure or permit information/i);
    expect(row.detail).toMatch(/Nothing here was read from a dated source/i);
    expect(row.level).toBe('unavailable');
  });

  it('says what it read when it read something with nothing seasonal in it', () => {
    const row = rowFor(
      { ...inputWith(undefined), facts: [stableFact('fact-a'), stableFact('fact-b')] },
      'temporary_access',
    );
    expect(row.level).toBe('weak');
    expect(row.detail).toContain('Nothing in the 2 facts we read');
    expect(row.detail).toMatch(/not as there being none/i);
  });
});

describe('mainstream_attractions and hidden_gems drop the self-referential denominator', () => {
  /**
   * §4, expressed as a grade. `expected = round(placeCount * 0.3)` made "Good"
   * mean "three in ten of the things we found score popular on our own scale",
   * which a board made entirely of municipal ponds satisfies as long as the
   * scorer likes three of them. Three well-known stops is three, whatever the
   * pool size, and the row now says so.
   */
  it('does not turn three popular places out of ten into full coverage of the famous ones', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        places: placesWith(10, (index) => ({ popularityScore: index < 3 ? 0.9 : 0.1 })),
      },
      'mainstream_attractions',
    );
    expect(row.level).not.toBe('high');
    expect(row.level).toBe('usable_with_cautions');
    expect(row.expected).toBeUndefined();
    expect(row.covered).toBeUndefined();
    expect(row.detail).toContain('3 of the 10 places we found');
    expect(row.detail).toMatch(/we cannot promise it is every famous stop here/i);
  });

  it('does not turn three quiet places out of ten into full coverage of the quiet ones', () => {
    const row = rowFor(
      {
        ...inputWith(undefined),
        places: placesWith(10, (index) => ({ hiddenGemScore: index < 3 ? 0.9 : 0.1 })),
      },
      'hidden_gems',
    );
    expect(row.level).not.toBe('high');
    expect(row.expected).toBeUndefined();
    expect(row.detail).toContain('3 of the 10 places we found');
  });

  it('still reports finding none of either as nothing found', () => {
    const input = { ...inputWith(undefined), places: placesWith(10, () => ({})) };
    expect(rowFor(input, 'mainstream_attractions').level).toBe('unavailable');
    expect(rowFor(input, 'hidden_gems').level).toBe('unavailable');
  });
});

describe('every row’s reason agrees with the grade beside it', () => {
  /**
   * `COVERAGE_REASON_COPY.fully_covered` is the word "Covered.", and five rows
   * attached it on any non-empty count whatever level was computed on the line
   * above — so a region with three places rendered **Thin — Covered.** Two
   * contradictory verdicts on one row tell a reader the grade is decorative.
   */
  const shapes: Record<string, CoverageInput> = {
    'a thin region': { ...inputWith(undefined), places: placesWith(3, () => ({})) },
    'a partly covered region': {
      ...inputWith(undefined, 20),
      weatherLocations: [
        {
          id: 'w-1',
          label: 'Centre',
          coordinates: { lat: 1, lng: 1 },
          elevationMetres: 10,
          timeZone: 'UTC',
          placeIds: ['transit-city-place-0'],
          limitation: 'One point for the whole area.',
        },
      ],
      facts: [stableFact('fact-a')],
    },
    'an empty region': { ...inputWith(undefined), places: [], matrix: { ...inputWith(undefined).matrix, ids: [] } },
  };

  for (const [label, input] of Object.entries(shapes)) {
    it(`holds for ${label}`, () => {
      for (const row of buildCoverageReport(input).dimensions) {
        if (row.reasons.includes('fully_covered')) {
          expect(row.level, `${row.dimension} says "Covered."`).toBe('high');
        }
        if (row.reasons.includes('not_relevant_to_region')) {
          expect(row.level, `${row.dimension} says "Does not apply here."`).toBe('not_applicable');
        }
        if (row.reasons.includes('partial_results_returned')) {
          expect(row.level, `${row.dimension} says "We found some of it."`).not.toBe('high');
        }
      }
    });
  }

  it('is the five rows that used to disagree', () => {
    const thin = buildCoverageReport({
      ...inputWith(undefined),
      places: placesWith(3, (index) => ({ popularityScore: index === 0 ? 0.9 : 0.1, hiddenGemScore: index === 0 ? 0.9 : 0.1 })),
      weatherLocations: [
        {
          id: 'w-1',
          label: 'Centre',
          coordinates: { lat: 1, lng: 1 },
          elevationMetres: 10,
          timeZone: 'UTC',
          placeIds: [],
          limitation: 'One point for the whole area.',
        },
      ],
      facts: [stableFact('fact-a')],
    });
    for (const dimension of ['places', 'mainstream_attractions', 'hidden_gems', 'weather', 'official_sources'] as const) {
      const row = thin.dimensions.find((entry) => entry.dimension === dimension)!;
      if (row.level !== 'high') {
        expect(row.reasons, dimension).not.toContain('fully_covered');
      }
    }
  });
});

describe('the summary says when the sources refused', () => {
  /**
   * THE GREEN INSTRUMENT DURING A TOTAL OUTAGE.
   *
   * The summary knew about the budget running out and said so. It knew nothing
   * about every provider erroring — which is the failure that happens at three
   * in the morning, and the one a cached pack hides, because a row whose
   * evidence came out of the cache grades on the cache. So the top line read
   * "Everything the planner needs is here, with sources." over a build on which
   * nothing external answered at all.
   */
  const outage = (subjects: number): CoverageInput['gaps'] =>
    Array.from({ length: subjects }, (_, index) => ({
      subjectId: `subject-${index}`,
      reason: 'provider_error' as const,
      detail: 'The provider returned 503.',
    }));

  /** Every layer above the line, which is what makes the green branch reachable. */
  function healthy(): CoverageInput {
    const base = inputWith({
      boundaryEvidence: 'published_boundary',
      placement: { read: 400, placed: 396, inside: 380 },
    }, 20);
    return {
      ...base,
      hours: {
        ...NO_HOURS,
        /*
         * A published calendar for every place, so `operating_hours` grades
         * above the line. `always_open` is the simplest kind that carries real
         * provenance and asserts nothing about a timetable nobody read.
         */
        calendars: base.places.map((place) => ({
          placeId: place.id,
          kind: 'always_open' as const,
          admission: {
            reservationRequired: false,
            timedEntry: false,
            permitRequired: false,
            walkInAllowed: true,
            capacityLimited: false,
          },
          daylightOnly: false,
          provenance: OFFICIAL,
        })),
      } as OperatingHoursDataset,
      access: {
        rules: base.places.map((place) => ruleFor(place, OFFICIAL)),
        services: [crossing('ferry')],
      },
      foodVenueCount: 8,
      foodVenues: base.places.slice(0, 8).map((place) => ({
        id: `venue-${place.id}`,
        dietary: [{ tag: 'vegetarian' }],
      })) as unknown as CoverageInput['foodVenues'],
      weatherLocations: [
        {
          id: 'w-1',
          label: 'Centre',
          coordinates: { lat: 1, lng: 1 },
          elevationMetres: 10,
          timeZone: 'UTC',
          placeIds: base.places.map((place) => place.id),
          limitation: 'One point for the whole area.',
        },
      ],
      facts: [stableFact('fact-a'), seasonalFact('fact-b')],
      /*
       * Every evidence row answered, so the only thing that can move the summary
       * between the two builds below is the refusals.
       */
      evidence: evidenceOf(base.places.map((place) => wellDocumented(place.id))),
      transit: { requested: 10, measured: 10 },
    };
  }

  it('does not claim sources on a build where every source refused', () => {
    const quiet = buildCoverageReport(healthy());
    const outaged = buildCoverageReport({ ...healthy(), gaps: outage(12) });
    /*
     * Asserted, because the case is only meaningful against it: this shape does
     * reach the green branch, so the difference below can only be the refusals.
     */
    expect(quiet.summary).toBe('Everything the planner needs is here, with sources.');
    expect(outaged.summary).not.toBe(quiet.summary);
    expect(outaged.summary).not.toMatch(/with sources/i);
    expect(outaged.summary).toMatch(/12 lookups failed or were turned away/i);
  });

  it('says it on a partly covered build too, where the green branch is not taken', () => {
    const partial = buildCoverageReport({ ...inputWith(undefined), gaps: outage(3) });
    expect(partial.summary).toMatch(/^Enough to plan on, with gaps in/);
    expect(partial.summary).toMatch(/3 lookups failed or were turned away/i);
  });

  it('does not report a source that simply had no answer as a refusal', () => {
    /*
     * `not_found` and `no_official_source` are answers. Counting them would put
     * an outage sentence on every ordinary build and teach a reader to ignore it.
     */
    const report = buildCoverageReport({
      ...inputWith(undefined),
      gaps: [
        { subjectId: 'a', reason: 'not_found', detail: 'Nothing matched.' },
        { subjectId: 'b', reason: 'no_official_source', detail: 'No operator page.' },
      ],
    });
    expect(report.summary).not.toMatch(/failed or were turned away/i);
  });

  it('keeps the budget sentence beside it rather than instead of it', () => {
    const ledger = new BudgetLedger({ ...DEFAULT_COMPILER_BUDGET, maxSourceSearches: 1 }, NOW.getTime());
    ledger.take('maxSourceSearches', 5);
    const report = buildCoverageReport({ ...inputWith(undefined), ledger, gaps: outage(2) });
    expect(report.summary).toMatch(/2 lookups failed or were turned away/i);
    expect(report.summary).toMatch(/ran out of lookups/i);
  });
});

describe('the compiler supplies the geography evidence it grades on', () => {
  /**
   * THE ANTI-VACUITY CASE.
   *
   * An optional field no production caller fills is a grading rule that never
   * runs. This drives the real `compileRegion` over a pack-backed world and
   * asserts the row carries that world's own placement counts — which is only
   * possible if the compile stage passed `geography` through from the scope and
   * the portfolio facts. Delete that block and this case fails on the sentence,
   * not merely on a level.
   */
  it('carries the scope edge and the real placement counts into the coverage row', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const clarifications: ClarificationSet = {
      schemaVersion: CLARIFICATION_SET_VERSION,
      questions: [],
      answers: [],
    };
    const scope = {
      ...deriveScope({
        candidate: syntheticCandidate(spec),
        clarifications,
        nights: 4,
        revision: 1,
      }),
      confirmedByUser: true,
    };
    const result = await compileRegion({
      compilationId: 'coverage-geography',
      scope,
      dates: ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'],
      months: [8],
      providers: packBackedProviders(spec),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * The synthetic candidate publishes no bounds, so `deriveScope` records a
     * reach circle — the same edge every real city gets. Asserted rather than
     * assumed, because the rest of this case is only meaningful against it.
     */
    expect(scope.boundaryEvidence).toBe('reach_circle');

    const row = result.region.coverage.dimensions.find(
      (entry) => entry.dimension === 'geographic_resolution',
    );
    expect(row).toBeDefined();
    expect(row!.level).not.toBe('high');
    expect(row!.detail).toMatch(/Nobody publishes an outline/i);
    /*
     * A real count, from the pack this compilation actually read. The fallback
     * sentence for "nothing supplied placement" cannot satisfy this, which is
     * what makes the wiring load-bearing rather than declared.
     */
    expect(row!.detail).toMatch(/Of the \d+ map entries we read here, \d+ could be placed/i);
    expect(row!.detail).not.toMatch(/Nothing on this build/i);
  });

  /**
   * THE SECOND ANTI-VACUITY CASE, for the access layer.
   *
   * `access` is optional for the same reason `geography` is, and carries the
   * same risk: an optional field no production caller fills is a grading rule
   * that never runs, and the two rows that read it would sit permanently on
   * their "we do not know" branches while every unit test above stayed green.
   *
   * This drives the real `compileRegion` and asserts both rows carry the
   * compilation's own numbers. Delete the `access:` block at the call site and
   * this fails on the sentences, not merely on the levels.
   */
  it('carries the access rules and the modelled services into the two rows that grade on them', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const clarifications: ClarificationSet = {
      schemaVersion: CLARIFICATION_SET_VERSION,
      questions: [],
      answers: [],
    };
    const scope = {
      ...deriveScope({
        candidate: syntheticCandidate(spec),
        clarifications,
        nights: 4,
        revision: 1,
      }),
      confirmedByUser: true,
    };
    const result = await compileRegion({
      compilationId: 'coverage-access',
      scope,
      dates: ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'],
      months: [8],
      providers: packBackedProviders(spec),
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * The scope grants rail on every trip this function builds — the exact
     * reason `ferry_or_rail` could not reach `not_applicable` and told every
     * landlocked destination its crossings were modelled. Asserted, because the
     * assertion below is only meaningful against it.
     */
    expect(scope.transport.allowedModes).toContain('rail');

    const rows = result.region.coverage.dimensions;
    const transport = rows.find((entry) => entry.dimension === 'transportation');
    expect(transport).toBeDefined();
    expect(transport!.detail).toMatch(
      /^\d+ of \d+ places have a recorded way in, \d+ of them published by whoever runs the place\.$/,
    );
    expect(transport!.detail).not.toMatch(/Nothing on this build/i);
    expect(transport!.covered).toBe(result.region.places.length);

    /*
     * The pack fixture models access rules but no boat and no train, so the row
     * has to say so. The old grade said "Crossings are modelled as services with
     * calendars" for exactly this build.
     */
    const crossings = rows.find((entry) => entry.dimension === 'ferry_or_rail');
    expect(crossings).toBeDefined();
    expect(crossings!.level).toBe('unavailable');
    expect(crossings!.detail).toMatch(/We hold no ferry or train timetable/i);
    expect(crossings!.detail).not.toMatch(/Nothing on this build/i);
    expect(crossings!.detail).not.toMatch(/Crossings are modelled/i);
  });
});
