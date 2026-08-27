import { describe, expect, it } from 'vitest';
import {
  assessCandidateQuality,
  featureScale,
  isSkipOutcome,
  recordedAttributes,
  type Place,
  type PlaceEvidence,
} from '../index';

/**
 * The defect these tests exist for, stated once: a mapped object with a name and
 * a matching tag ranked beside a museum, because "has a name and a matching tag"
 * was the whole test.
 *
 * Every case below is written against a *class* of feature, never a place. The
 * same assertions would hold in any country, which is the property that makes
 * this a quality layer rather than a blocklist.
 */

function place(overrides: Partial<Place> & { id: string; tags: string[] }): Place {
  return {
    regionId: 'compiled-test',
    name: 'A thing on a map',
    locality: 'Somewhere',
    shortDescription: 'A short description that is long enough to count as a description.',
    coordinates: { lat: 10, lng: 10 },
    source: {
      name: 'OpenStreetMap',
      kind: 'osm',
      confidence: 0.7,
      lastVerified: '2026-07-01',
    },
    relationship: 'satellite',
    category: 'historic_site',
    interests: ['history_and_culture'],
    typicalDurationMinutes: 45,
    costLevel: 0,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.4,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'mixed',
      precipitation: 'moderate',
      wind: 'low',
      heat: 'moderate',
      cold: 'moderate',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'moderate',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 5, driveMinutes: 10, driveIsScenic: false },
    ...overrides,
  } as Place;
}

const BASE_INPUT = {
  fitScore: 0.6,
  detourMinutes: 10,
  categoryCount: 0,
  supersededByParent: false,
  duplicate: false,
  usableOnTripDates: true,
  openingUncertain: false,
  detourToleranceMinutes: 60,
};

const RICH_EVIDENCE: PlaceEvidence = {
  subjectId: 'x',
  officialUrl: 'https://operator.example/visit',
  aliases: [],
  booking: {
    reservationRequired: 'no',
    timedEntry: 'no',
    permitRequired: 'no',
    guideRequired: 'unknown',
    claim: { state: 'verified' },
  },
  costs: [
    {
      kind: 'admission',
      free: false,
      money: { currency: 'EUR', amount: 12, unit: 'per_person', estimated: false, taxesUncertain: true },
      advancePurchaseRequired: 'no',
      claim: { state: 'verified' },
    },
  ],
  closures: [],
  safety: [],
  suggestedDurationMinutes: 90,
  resolved: [{ subjectId: 'x', factPath: 'hours.weekly', state: 'verified', factIds: ['f'], independentSources: 1, rationale: 'Stated by the operator.' }],
};

describe('candidate quality', () => {
  it('classifies a single mapped object as a micro feature from its tag alone', () => {
    expect(featureScale(place({ id: 'a', tags: ['historic=memorial'] }))).toBe('micro');
    expect(featureScale(place({ id: 'b', tags: ['tourism=artwork'] }))).toBe('micro');
    expect(featureScale(place({ id: 'c', tags: ['leisure=nature_reserve'] }))).toBe('area');
    expect(featureScale(place({ id: 'd', tags: ['tourism=museum'] }))).toBe('site');
  });

  it('drops a micro feature nobody publishes anything about', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'grave', tags: ['historic=grave'], shortDescription: 'A grave.' }),
    });
    expect(assessment.outcome).toBe('insufficient_evidence');
    expect(isSkipOutcome(assessment.outcome)).toBe(true);
  });

  it('keeps the same class of feature when a source actually publishes about it', () => {
    /**
     * The asymmetry that makes this generic rather than a blocklist: the feature
     * class is an input, not a veto. A monument with an operator, a ticket price
     * and a stated visit duration is a real stop and stays one.
     */
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'monument', tags: ['historic=monument'], shortDescription: 'A monument.' }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'monument' },
    });
    expect(assessment.outcome).not.toBe('insufficient_evidence');
    expect(assessment.signals.publicVisitation).toBe(true);
  });

  it('never ranks on popularity', () => {
    const famousPoorFit = assessCandidateQuality({
      ...BASE_INPUT,
      fitScore: 0.2,
      place: place({ id: 'famous', tags: ['tourism=attraction'], popularityScore: 0.95 }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'famous' },
    });
    const nichGoodFit = assessCandidateQuality({
      ...BASE_INPUT,
      fitScore: 0.85,
      place: place({ id: 'niche', tags: ['tourism=attraction'], popularityScore: 0.05 }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'niche' },
    });
    expect(nichGoodFit.score).toBeGreaterThan(famousPoorFit.score);
  });

  it('calls a detour past what the traveller stated not worth it, and says the number', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      detourMinutes: 140,
      detourToleranceMinutes: 60,
      place: place({ id: 'far', tags: ['tourism=attraction'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'far' },
    });
    expect(assessment.outcome).toBe('not_worth_detour');
    // As a person says it, not as an odometer reads: 140 minutes is 2 hr 20 min.
    expect(assessment.reason).toContain('2 hr 20 min');
  });

  it('blames nobody, and quotes no clock, for a journey nobody could price', () => {
    /**
     * THE SKIP-LIST SENTENCE, AS A RULE.
     *
     * A car-free trip through a city with a metro is compiled onto the only
     * network anybody measured — the pedestrian one — so a seat the traveller
     * would ride to in twenty minutes arrives here as an hour-and-a-half walk.
     * The refusal that produced was "1 hr 29 min each way on foot is past how
     * far you said you would go", and all three of its clauses are false: it is
     * not how far away the place is, it is not how they would go, and it was
     * not their answer that ruled it out. It was our missing timetable, and the
     * sentence billed the traveller for it.
     *
     * Same minutes, same verdict, and the honest sentence instead — which is
     * also the only one they could act on.
     */
    const proxy = assessCandidateQuality({
      ...BASE_INPUT,
      detourMinutes: 89,
      detourMode: 'walk',
      detourToleranceMinutes: 25,
      journeyUnverified: true,
      place: place({ id: 'unpriced', tags: ['tourism=attraction'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'unpriced' },
    });
    expect(proxy.outcome).toBe('not_worth_detour');
    expect(proxy.reason).not.toMatch(/past how far you said you would go/);
    expect(proxy.reason).not.toMatch(/on foot/);
    expect(proxy.reason).not.toMatch(/1 hr 29 min|89/);
    expect(proxy.reason).toMatch(/could not confirm any route/);

    /* The control: the identical journey, where the walk really is the journey. */
    const real = assessCandidateQuality({
      ...BASE_INPUT,
      detourMinutes: 89,
      detourMode: 'walk',
      detourToleranceMinutes: 25,
      place: place({ id: 'genuine', tags: ['tourism=attraction'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'genuine' },
    });
    expect(real.outcome).toBe('not_worth_detour');
    expect(real.reason).toContain('1 hr 29 min');
    expect(real.reason).toMatch(/on foot/);
    expect(real.reason).toMatch(/past how far you said you would go/);
  });

  it('demotes a place that is closed on the dates, ahead of every other judgement', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      usableOnTripDates: false,
      place: place({ id: 'shut', tags: ['tourism=museum'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'shut' },
    });
    expect(assessment.outcome).toBe('closed_or_unavailable');
  });

  it('flags a thin record with unknown hours for verification rather than dropping it', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      openingUncertain: true,
      place: place({ id: 'thin', tags: ['tourism=museum'] }),
    });
    expect(assessment.outcome).toBe('low_confidence');
  });

  it('demotes the tenth of a category without touching the first', () => {
    const first = assessCandidateQuality({
      ...BASE_INPUT,
      categoryCount: 0,
      place: place({ id: 'v1', tags: ['tourism=viewpoint'], category: 'viewpoint' }),
    });
    const tenth = assessCandidateQuality({
      ...BASE_INPUT,
      categoryCount: 9,
      place: place({ id: 'v10', tags: ['tourism=viewpoint'], category: 'viewpoint' }),
    });
    expect(tenth.score).toBeLessThan(first.score);
  });

  it('marks a duplicate redundant rather than showing it twice', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      duplicate: true,
      place: place({ id: 'dupe', tags: ['tourism=museum'] }),
    });
    expect(assessment.outcome).toBe('redundant');
  });

  it('gives every skip a reason a person could argue with', () => {
    for (const input of [
      { ...BASE_INPUT, duplicate: true },
      { ...BASE_INPUT, usableOnTripDates: false },
      { ...BASE_INPUT, detourMinutes: 200 },
    ]) {
      const assessment = assessCandidateQuality({
        ...input,
        place: place({ id: 'x', tags: ['tourism=museum'] }),
      });
      expect(assessment.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('what the source database recorded is evidence in its own right', () => {
  it('keeps a place the map data describes, even before anything is researched', () => {
    /**
     * The live defect this covers: before recorded attributes counted, the only
     * pre-research signal was how long a sentence our own classifier had written,
     * and a New York compile dropped fifteen of twenty candidates on that basis.
     */
    const thin = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'bare', tags: ['tourism=attraction'], shortDescription: 'A thing.' }),
    });
    const described = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'described',
        tags: ['tourism=attraction', 'attr:website', 'attr:opening_hours', 'attr:wikidata'],
        shortDescription: 'A thing.',
      }),
    });

    expect(thin.outcome).toBe('insufficient_evidence');
    expect(described.outcome).not.toBe('insufficient_evidence');
    expect(described.signals.publicVisitation).toBe(true);
    /**
     * And the recorded attributes decide *only* that. The described record is
     * kept and the bare one is refused — that is completeness doing its §7 job
     * — but the two **scores are identical**, because how completely a mapper
     * filled a listing in is not a rank. It held a quarter of the score once,
     * and a live Tokyo board seated memorial plaques over Shinjuku Gyoen on
     * exactly that arithmetic.
     */
    expect(described.score).toBe(thin.score);
  });

  it('reads only attribute names, never values', () => {
    expect(
      recordedAttributes(place({ id: 'x', tags: ['tourism=museum', 'attr:website', 'attr:fee'] })),
    ).toEqual(['website', 'fee']);
  });

  it('still demotes a micro feature whose only attributes say nothing about visiting', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'plaque',
        tags: ['historic=memorial', 'attr:ele'],
        shortDescription: 'A plaque.',
      }),
    });
    expect(assessment.outcome).toBe('insufficient_evidence');
  });
});

describe('metadata completeness must never outrank significance (M02 spirit, at the final cut)', () => {
  /**
   * The defect, measured before the fix on the live Tokyo pack of 2026-08-13
   * (hash 1688f5e37fc4d0cd): the final board cut ranked candidates by
   * `fit·0.5 + completeness·0.25`, so a memorial plaque whose record carried a
   * website attribute held a seat at 0.671 while Shinjuku Gyoen — composed
   * experience significance 0.81, but a thin record — was cut at 0.571, and
   * Kiyosumi Gardens (0.81) fell further still for want of one completeness
   * mark. A count of filled-in fields decided a quarter of the last rung,
   * which is §8.3's metadata heuristic at the exact place the phase exists to
   * kill it.
   *
   * Every case is a class, not a place: a "fully-detailed generic record" and
   * a "thin-metadata significant record" exist in every city on earth.
   */
  const A_LONG_DESCRIPTION =
    'A perfectly pleasant place that a source has described at some length.';

  it('never lets a fully-detailed generic record cut a thin-metadata significant one', () => {
    const detailedGeneric = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'well-tagged-nothing',
        tags: [
          'amenity=cafe',
          'attr:website',
          'attr:opening_hours',
          'attr:operator',
          'attr:phone',
        ],
        shortDescription: A_LONG_DESCRIPTION,
        // The kind prior alone: nobody outside the record has said anything.
        experienceSignificance: 0.12,
      }),
    });
    const thinSignificant = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'famous-garden',
        tags: ['leisure=garden'],
        shortDescription: 'A garden.',
        // Kind prior plus established channels: an encyclopaedic entry and an
        // article — the shape Shinjuku Gyoen actually carries.
        experienceSignificance: 0.73,
      }),
    });

    // Same fit, same detour, and the generic record is far more *complete* —
    // that must buy it a better-verified card, never the significant one's seat.
    expect(detailedGeneric.signals.evidenceCompleteness).toBeGreaterThan(
      thinSignificant.signals.evidenceCompleteness,
    );
    expect(thinSignificant.score).toBeGreaterThan(detailedGeneric.score);
    // And the thin record is not discarded as unknowable on its way past.
    expect(thinSignificant.outcome).not.toBe('insufficient_evidence');
  });

  it('gives completeness no share of the score at all — labels and ties are its whole job', () => {
    const bare = assessCandidateQuality({
      ...BASE_INPUT,
      openingUncertain: true,
      place: place({
        id: 'same-place-bare',
        tags: ['tourism=museum'],
        shortDescription: A_LONG_DESCRIPTION,
        experienceSignificance: 0.4,
      }),
    });
    const complete = assessCandidateQuality({
      ...BASE_INPUT,
      openingUncertain: true,
      place: place({
        id: 'same-place-complete',
        tags: ['tourism=museum', 'attr:website', 'attr:opening_hours', 'attr:fee'],
        shortDescription: A_LONG_DESCRIPTION,
        experienceSignificance: 0.4,
      }),
      evidence: { ...RICH_EVIDENCE, resolved: [], subjectId: 'same-place-complete' },
    });

    // Identical rank: the same kind of place, equally significant, equally fit.
    expect(complete.score).toBe(bare.score);
    // Different verification: the bare record cannot be confirmed and says so.
    expect(bare.outcome).toBe('low_confidence');
    expect(complete.outcome).not.toBe('low_confidence');
  });

  it('treats established significance as evidence: a thin famous record is not "too little known"', () => {
    const thinButVouchedFor = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'noted-canal',
        tags: ['waterway=canal'],
        shortDescription: 'A canal.',
        // Above the kind-only share, so somebody outside the record vouched
        // for it — the live case was an encyclopaedically noted canal at 0.66.
        experienceSignificance: 0.66,
      }),
    });
    const thinAndUnvouched = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'plain-canal',
        tags: ['waterway=canal'],
        shortDescription: 'A canal.',
        // At most the kind prior: no world statement, same empty record.
        experienceSignificance: 0.24,
      }),
    });

    expect(thinButVouchedFor.outcome).not.toBe('insufficient_evidence');
    expect(thinAndUnvouched.outcome).toBe('insufficient_evidence');
  });

  it('does not let the neutral read for an uncomposed significance open the evidence gate', () => {
    // No producer composed a significance here. The ranker substitutes a
    // neutral middle for the *score*, but an absence must never count as
    // "the world vouched for this" — that would hand every legacy record a
    // pass through the gate.
    const uncomposedAndThin = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'legacy-record',
        tags: ['tourism=attraction'],
        shortDescription: 'A thing.',
      }),
    });
    expect(uncomposedAndThin.outcome).toBe('insufficient_evidence');
  });
});

/**
 * §6 / GROUP H — THE HEADING'S CLAIM AND THE SENTENCE'S CLAIM ARE THE SAME
 * CLAIM.
 *
 * ---
 *
 * **The live evidence class.** The delivered packets rendered a *Worth
 * skipping* section headed "Popular or nearby, and still a poor match for how
 * you said you travel. Skipping them is a decision, not an oversight." — a
 * personal-fit verdict — over rows whose sentences said we had not checked
 * something: "Too little is published about this for us to plan a visit around
 * it.", "We could not confirm any route here, so we cannot say how far away it
 * really is." A traveller reading those was told the product had weighed the
 * place against their answers and rejected it. It had not, and the two are
 * acted on differently: a fit refusal is settled, an evidence gap is something
 * they can close in a browser tab in a minute.
 *
 * `reasonBasis` is the structured half of the same value `reason` renders, so a
 * surface routes on the code rather than pattern-matching prose, and the two
 * cannot come apart.
 */
describe('§6 — a skip reason says which kind of claim it is making', () => {
  const thin = place({ id: 'thin', tags: ['tourism=attraction'], shortDescription: 'A hall.' });

  it('calls a data gap a data gap, however the outcome is reached', () => {
    /* Nothing published: no evidence at all, and a description that says so. */
    const unknown = assessCandidateQuality({ ...BASE_INPUT, place: thin, fitScore: 0.6 });
    expect(unknown.outcome).toBe('insufficient_evidence');
    expect(unknown.reasonBasis).toBe('evidence_gap');

    /*
     * And the journey nobody could price. The distance sentence is refused for
     * this candidate — see `journeyUnverified` — so the basis must follow the
     * sentence rather than the outcome name.
     */
    const unpriced = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'unpriced', tags: ['tourism=attraction'], shortDescription: 'A hall that has stood on the square since the town had walls, and still opens for markets.' }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'unpriced' },
      detourMinutes: 96,
      detourToleranceMinutes: 25,
      journeyUnverified: true,
    });
    expect(unpriced.outcome).toBe('not_worth_detour');
    expect(unpriced.reason).toContain('could not confirm any route');
    expect(unpriced.reasonBasis).toBe('evidence_gap');
  });

  it('calls a measured refusal against a stated answer a fit judgement', () => {
    const tooFar = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'far', tags: ['tourism=attraction'], shortDescription: 'A hall that has stood on the square since the town had walls, and still opens for markets.' }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'far' },
      detourMinutes: 96,
      detourToleranceMinutes: 25,
    });
    expect(tooFar.outcome).toBe('not_worth_detour');
    expect(tooFar.reason).toContain('past how far you said you would go');
    expect(tooFar.reasonBasis).toBe('fit_judgement');
  });

  it('calls the trip’s own state neither of those', () => {
    const shut = assessCandidateQuality({ ...BASE_INPUT, place: thin, usableOnTripDates: false });
    expect(shut.reasonBasis).toBe('trip_state');
    const already = assessCandidateQuality({ ...BASE_INPUT, place: thin, duplicate: true });
    expect(already.reasonBasis).toBe('trip_state');
  });

  /**
   * Every outcome carries a basis, and the basis matches the sentence.
   *
   * The property that keeps this honest as reasons are added: a sentence about
   * our knowledge must never be filed as a fit judgement, whichever branch
   * produced it.
   */
  it('never files a “we could not” sentence as a judgement about the traveller', () => {
    const inputs = [
      { place: thin },
      { place: thin, usableOnTripDates: false },
      { place: thin, duplicate: true },
      { place: thin, openingUncertain: true },
      { place: thin, detourMinutes: 200, detourToleranceMinutes: 25 },
      { place: thin, detourMinutes: 200, detourToleranceMinutes: 25, journeyUnverified: true },
      { place: thin, fitScore: 0.1 },
    ];
    for (const overrides of inputs) {
      const assessment = assessCandidateQuality({ ...BASE_INPUT, ...overrides });
      const saysWeCouldNot = /could not|Too little is published|nothing published about it/.test(
        assessment.reason,
      );
      if (saysWeCouldNot) expect(assessment.reasonBasis, assessment.reason).toBe('evidence_gap');
      if (assessment.reasonBasis === 'fit_judgement') {
        expect(assessment.reason, assessment.reason).not.toMatch(/could not/);
      }
    }
  });
});
