import { describe, expect, it } from 'vitest';
import { assessCandidateQuality, type Place, type QualityAssessment } from '@sidequest/core';
import { compareShortlist, cutShortlist, type SeatCandidate, type ShortlistEntry } from './compile';

/**
 * THE FINAL BOARD CUT'S ORDER, TESTED AT THE CALL SITE'S OWN SEAM.
 *
 * `compareShortlist` is the comparator the classify/shortlist stage hands to
 * its sort, and the seats it orders are the seats `maxShortlistedCandidates`
 * keeps — on the live Tokyo build of 2026-08-13 that was the 125-to-45 cut
 * that decided the 23-place board. The quality layer's own tests prove what
 * the *score* may read; these prove what the *cut* does with it: score first,
 * corroboration second, and metadata completeness only ever between candidates
 * the honest dimensions cannot separate.
 *
 * Entries are built through the real assessor rather than hand-written
 * numbers, so a change to the score's composition is visible here too — a
 * comparator test over invented scores would keep passing while the score
 * itself went back to ranking on completeness.
 */

function place(overrides: Partial<Place> & { id: string; tags: string[] }): Place {
  return {
    regionId: 'compiled-test',
    name: 'A thing on a map',
    locality: 'Somewhere',
    shortDescription: 'A short description that is long enough to count as a description.',
    coordinates: { lat: 10, lng: 10 },
    source: { name: 'OpenStreetMap', kind: 'osm', confidence: 0.7, lastVerified: '2026-07-01' },
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

/** Assessed exactly as the classify stage assesses: pre-research inputs. */
function entryFor(
  subject: Place,
  providerRefs = 1,
): ShortlistEntry & { assessment: QualityAssessment } {
  return {
    candidate: { place: subject, providerRefs: Array.from({ length: providerRefs }, (_, i) => ({ ref: i })) as never },
    assessment: assessCandidateQuality({
      place: subject,
      fitScore: 0.6,
      detourMinutes: subject.travelFromBase.driveMinutes,
      categoryCount: 0,
      supersededByParent: false,
      duplicate: false,
      usableOnTripDates: true,
      openingUncertain: true,
      detourToleranceMinutes: 60,
    }),
  };
}

describe('the shortlist cut (M02 spirit, at the seat allocation itself)', () => {
  it('seats a thin-metadata significant record ahead of a fully-detailed generic one', () => {
    const detailedGeneric = entryFor(
      place({
        id: 'well-tagged-nothing',
        tags: ['amenity=cafe', 'attr:website', 'attr:opening_hours', 'attr:operator', 'attr:phone'],
        experienceSignificance: 0.12,
      }),
    );
    const thinSignificant = entryFor(
      place({
        id: 'famous-garden',
        tags: ['leisure=garden'],
        shortDescription: 'A garden.',
        experienceSignificance: 0.73,
      }),
    );

    // The generic record is more complete — and still loses the seat.
    expect(detailedGeneric.assessment.signals.evidenceCompleteness).toBeGreaterThan(
      thinSignificant.assessment.signals.evidenceCompleteness,
    );
    expect(compareShortlist(thinSignificant, detailedGeneric)).toBeLessThan(0);
    expect([detailedGeneric, thinSignificant].sort(compareShortlist)[0]).toBe(thinSignificant);
  });

  it('lets completeness break a genuine tie, and only a genuine tie', () => {
    const bare = entryFor(
      place({ id: 'z-same-place-bare', tags: ['tourism=museum'], experienceSignificance: 0.4 }),
    );
    const complete = entryFor(
      place({
        id: 'zz-same-place-complete',
        tags: ['tourism=museum', 'attr:website', 'attr:opening_hours', 'attr:fee'],
        experienceSignificance: 0.4,
      }),
    );

    // Same score — completeness holds no share of it.
    expect(complete.assessment.score).toBe(bare.assessment.score);
    // The better-described record wins the tie, id order notwithstanding.
    expect(compareShortlist(complete, bare)).toBeLessThan(0);
  });

  it('never lets the tie-break overturn the score', () => {
    const moreSignificant = entryFor(
      place({
        id: 'thin-but-significant',
        tags: ['leisure=garden'],
        shortDescription: 'A garden.',
        experienceSignificance: 0.7,
      }),
    );
    const moreComplete = entryFor(
      place({
        id: 'complete-but-generic',
        tags: ['amenity=cafe', 'attr:website', 'attr:opening_hours', 'attr:operator'],
        experienceSignificance: 0.2,
      }),
    );
    expect(moreComplete.assessment.signals.evidenceCompleteness).toBeGreaterThan(
      moreSignificant.assessment.signals.evidenceCompleteness,
    );
    const ordered = [moreComplete, moreSignificant].sort(compareShortlist);
    expect(ordered[0]).toBe(moreSignificant);
  });

  it('keeps corroboration ahead of completeness: two catalogues beat a filled-in listing', () => {
    const corroborated = entryFor(
      place({ id: 'seen-twice', tags: ['tourism=museum'], experienceSignificance: 0.4 }),
      2,
    );
    const filledIn = entryFor(
      place({
        id: 'described-once',
        tags: ['tourism=museum', 'attr:website', 'attr:opening_hours', 'attr:fee'],
        experienceSignificance: 0.4,
      }),
      1,
    );
    expect(filledIn.assessment.score).toBe(corroborated.assessment.score);
    expect(compareShortlist(corroborated, filledIn)).toBeLessThan(0);
  });
});

describe('the cut composes the board with the assessor’s own saturation signal', () => {
  /**
   * `assessCandidateQuality` has always carried `categorySaturation`; the
   * classify stage passed `categoryCount: 0` for every candidate, so the one
   * signal built to stop a monoculture was silent at the only cut that
   * produces one. On a stored dense-metro compile the 45-seat shortlist came
   * out twenty-two near-identical parks plus article-bearing crossings, and
   * the destination's palace — holding a portfolio anchor seat — sat below
   * the cut. These fixtures assert the mechanism, with synthetic records only.
   */
  const CENTER = { lat: 10, lng: 10 };

  function seatEntry(
    subject: Place,
    fitScore = 0.5,
  ): SeatCandidate & { assessment: QualityAssessment } {
    const assessAt = (categoryCount: number): QualityAssessment =>
      assessCandidateQuality({
        place: subject,
        fitScore,
        detourMinutes: subject.travelFromBase.driveMinutes,
        categoryCount,
        supersededByParent: false,
        duplicate: false,
        usableOnTripDates: true,
        openingUncertain: true,
        detourToleranceMinutes: 60,
      });
    return {
      candidate: {
        place: subject,
        providerRefs: [{ ref: 0 }] as never,
      },
      assessment: assessAt(0),
      reassess: assessAt,
    };
  }

  it('does not let one flooding category hold every seat', () => {
    /* Twelve interchangeable records of one kind, scoring above three records
     * of another kind — the monoculture shape. */
    const floods = Array.from({ length: 12 }, (_, index) =>
      seatEntry(
        place({
          id: `walk-${String(index).padStart(2, '0')}`,
          category: 'easy_walk',
          tags: ['leisure=park'],
          experienceSignificance: 0.72,
          coordinates: { lat: 10.01 + index * 0.001, lng: 10 },
        }),
      ),
    );
    const starved = Array.from({ length: 3 }, (_, index) =>
      seatEntry(
        place({
          id: `site-${index}`,
          category: 'historic_site',
          tags: ['historic=palace'],
          experienceSignificance: 0.46,
          coordinates: { lat: 10.02, lng: 10.01 + index * 0.001 },
        }),
      ),
    );

    const seatsPreFix = [...floods, ...starved].sort(compareShortlist).slice(0, 8);
    /* The defect, stated: a flat slice of the sorted list seats the flood only. */
    expect(seatsPreFix.every((entry) => entry.candidate.place.category === 'easy_walk')).toBe(true);

    const seated = cutShortlist([...floods, ...starved], 8, CENTER);
    const categories = seated.map((entry) => entry.candidate.place.category);
    expect(categories.filter((category) => category === 'historic_site').length).toBeGreaterThan(0);
    /* Fit and significance still lead: the flood's best records keep the front seats. */
    expect(categories[0]).toBe('easy_walk');
  });

  it('keeps the traveller’s fit in charge: a genuinely better-fitting flood is not rationed below its worth', () => {
    const strongFits = Array.from({ length: 6 }, (_, index) =>
      seatEntry(
        place({
          id: `fit-${index}`,
          category: 'day_hike',
          tags: ['route=hiking'],
          experienceSignificance: 0.6,
          coordinates: { lat: 10.03, lng: 10 + index * 0.001 },
        }),
        0.9,
      ),
    );
    const weakOther = seatEntry(
      place({
        id: 'weak-other',
        category: 'museum',
        tags: ['tourism=museum'],
        experienceSignificance: 0.2,
        coordinates: { lat: 10, lng: 10 },
      }),
      0.2,
    );
    const seated = cutShortlist([...strongFits, weakOther], 5, CENTER);
    /* Five seats, six strong fits: the saturation share never overturns a
     * fit gap this large, so every seat stays with the better fit. */
    expect(seated.every((entry) => entry.candidate.place.category === 'day_hike')).toBe(true);
  });

  it('breaks otherwise-identical seats towards the destination’s centre, id last', () => {
    const far = seatEntry(
      place({
        id: 'a-far-twin',
        category: 'easy_walk',
        tags: ['leisure=park'],
        experienceSignificance: 0.5,
        coordinates: { lat: 10.4, lng: 10.4 },
      }),
    );
    const near = seatEntry(
      place({
        id: 'z-near-twin',
        category: 'easy_walk',
        tags: ['leisure=park'],
        experienceSignificance: 0.5,
        coordinates: { lat: 10.01, lng: 10.01 },
      }),
    );
    /* Identical on every honest dimension; the id ordering would seat the far
     * twin first, and the centre distance must outrank the id. */
    expect(compareShortlist(far, near)).toBeLessThan(0);
    const seated = cutShortlist([far, near], 1, CENTER);
    expect(seated[0]!.candidate.place.id).toBe('z-near-twin');
  });
});
