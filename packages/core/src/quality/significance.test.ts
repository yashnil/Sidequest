import { describe, expect, it } from 'vitest';
import {
  assessCandidateQuality,
  assessPlaceStanding,
  isAuthorityPublishedSite,
  standingFields,
  UNKNOWN_HIDDENNESS_READ,
  UNKNOWN_PROMINENCE_READ,
  type Place,
  type PlaceEvidence,
} from '../index';

/**
 * THE MODEL, ON ITS OWN.
 *
 * `significance.ts` is where the four conflated scores were taken apart. These
 * tests are about the property that separation exists for: the scores are
 * allowed to disagree, and an unestablished score is *absent* rather than low.
 *
 * Every case is written against a class of evidence, never a place. The same
 * assertions hold in any country, which is what makes this a model rather than
 * a table of opinions.
 */

describe('the scores answer different questions from different evidence', () => {
  it('leaves prominence absent when no knowledge base mentions the place', () => {
    const standing = assessPlaceStanding({ recordedAttributeCount: 6 });
    expect(standing.globalProminence).toBeUndefined();
    // Not zero, not a half. Nobody looked this up and found it wanting; nobody
    // found it at all, and the two are different sentences.
    expect('globalProminence' in standing).toBe(false);
  });

  it('reads prominence from knowledge-base breadth alone', () => {
    const catalogued = assessPlaceStanding({
      inKnowledgeBase: true,
      knowledgeBaseNameCount: 4,
      crossDatasetCorroboration: true,
    });
    expect(catalogued.globalProminence).toBeGreaterThan(0.7);
    expect(catalogued.localSignificance).toBeUndefined();
  });

  it('reads local significance from channels a business cannot publish about itself', () => {
    const designated = assessPlaceStanding({
      classifyingValues: ['leisure=nature_reserve'],
    });
    expect(designated.localSignificance).toBeGreaterThan(0);

    const selfPublished = assessPlaceStanding({
      publishedSites: ['https://chaincoffee.example.com/third-street'],
      classifyingValues: ['amenity=cafe'],
      recordedAttributeCount: 6,
    });
    expect(selfPublished.localSignificance).toBeUndefined();

    const authorityPublished = assessPlaceStanding({
      publishedSites: ['https://www.parks.example.gov/back-valley'],
    });
    expect(authorityPublished.localSignificance).toBeGreaterThan(0);
  });

  it('reads an authority domain rather than a hopeful-looking name', () => {
    expect(isAuthorityPublishedSite('https://www.fs.usda.gov/anything')).toBe(true);
    expect(isAuthorityPublishedSite('https://www.mairie.gouv.fr/x')).toBe(true);
    expect(isAuthorityPublishedSite('https://visit-somewhere.com/official')).toBe(false);
    expect(isAuthorityPublishedSite('not a url at all')).toBe(false);
  });
});

describe('hiddenness is a gap between two channels, not the inverse of one', () => {
  const designatedAndUnknown = assessPlaceStanding({
    classifyingValues: ['boundary=protected_area'],
  });
  const nothingAtAll = assessPlaceStanding({});
  const globallyFamous = assessPlaceStanding({
    inKnowledgeBase: true,
    knowledgeBaseNameCount: 4,
    crossDatasetCorroboration: true,
  });

  it('calls the locally significant, globally unnoticed place hidden', () => {
    expect(designatedAndUnknown.hiddenness).toBeGreaterThanOrEqual(0.6);
  });

  it('says nothing at all about a place nothing is known about', () => {
    expect(nothingAtAll.hiddenness).toBeUndefined();
    expect(nothingAtAll.globalProminence).toBeUndefined();
    expect(nothingAtAll.localSignificance).toBeUndefined();
  });

  it('does not call a globally noted place hidden', () => {
    expect(globallyFamous.hiddenness).toBe(0);
  });

  it('keeps the required read below the product’s hidden-gem bar when unknown', () => {
    /**
     * `discovery/board.ts` groups at `hiddenGemScore >= 0.6`. The unknown read
     * has to sit below that bar — otherwise a record with no evidence is
     * promoted into the hidden-gems group on the strength of its own emptiness,
     * which is what `1 − popularity` did — and above what a famous place scores,
     * so the ordering a traveller sees still makes sense.
     */
    expect(UNKNOWN_HIDDENNESS_READ).toBeLessThan(0.6);
    expect(standingFields(nothingAtAll).hiddenGemScore).toBe(UNKNOWN_HIDDENNESS_READ);
    expect(standingFields(nothingAtAll).hiddenGemScore).toBeGreaterThan(
      standingFields(globallyFamous).hiddenGemScore,
    );
    expect(standingFields(designatedAndUnknown).hiddenGemScore).toBeGreaterThanOrEqual(0.6);
  });
});

describe('metadata richness feeds confidence and nothing else', () => {
  const bare = assessPlaceStanding({ recordedAttributeCount: 0 });
  const rich = assessPlaceStanding({ recordedAttributeCount: 6 });
  const richAndCorroborated = assessPlaceStanding({
    recordedAttributeCount: 6,
    crossDatasetCorroboration: true,
  });

  it('moves source confidence, which used to be the constant 0.7', () => {
    expect(bare.sourceConfidence).toBeLessThan(rich.sourceConfidence);
    expect(rich.sourceConfidence).toBeLessThan(richAndCorroborated.sourceConfidence);
    expect(new Set([bare, rich, richAndCorroborated].map((s) => s.sourceConfidence)).size).toBe(3);
  });

  it('moves no ranking score at all', () => {
    expect(rich.globalProminence).toBeUndefined();
    expect(rich.localSignificance).toBeUndefined();
    expect(rich.hiddenness).toBeUndefined();
    expect(rich.crowdExpectation).toBeUndefined();
    expect(standingFields(rich).popularityScore).toBe(standingFields(bare).popularityScore);
    expect(standingFields(rich).popularityScore).toBe(UNKNOWN_PROMINENCE_READ);
  });
});

describe('crowd comes from crowd evidence or from nowhere', () => {
  it('is absent when nothing about visitation was published', () => {
    expect(assessPlaceStanding({ recordedAttributeCount: 6 }).crowdExpectation).toBeUndefined();
    expect(
      assessPlaceStanding({ inKnowledgeBase: true, knowledgeBaseNameCount: 6 }).crowdExpectation,
    ).toBeUndefined();
  });

  it('bands published visitor numbers, and reads managed entry as demand', () => {
    expect(assessPlaceStanding({ crowd: { annualVisitors: 4_000_000 } }).crowdExpectation).toBe(
      'very_busy',
    );
    expect(assessPlaceStanding({ crowd: { annualVisitors: 4_000 } }).crowdExpectation).toBe('quiet');
    expect(assessPlaceStanding({ crowd: { managedEntry: true } }).crowdExpectation).toBe('busy');
    expect(assessPlaceStanding({ crowd: { seasonalConcentration: true } }).crowdExpectation).toBe(
      'moderate',
    );
  });

  it('lets a famous place be quiet and an unknown one be packed', () => {
    /**
     * Impossible under `crowdLevel = popularity > 0.7`, which is the point. A
     * catalogued monument in an empty valley and an untraceable beach in high
     * season are both real, and the old rule could express neither.
     */
    const famousAndEmpty = assessPlaceStanding({
      inKnowledgeBase: true,
      knowledgeBaseNameCount: 5,
      crossDatasetCorroboration: true,
      crowd: { annualVisitors: 900 },
    });
    const unknownAndPacked = assessPlaceStanding({ crowd: { annualVisitors: 2_000_000 } });
    expect(famousAndEmpty.crowdExpectation).toBe('quiet');
    expect(famousAndEmpty.globalProminence).toBeGreaterThan(0.7);
    expect(unknownAndPacked.crowdExpectation).toBe('very_busy');
    expect(unknownAndPacked.globalProminence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The board outcome, which is where a traveller sees the difference
// ---------------------------------------------------------------------------

function placeWith(overrides: Partial<Place>): Place {
  return {
    id: 'p',
    regionId: 'compiled-test',
    name: 'A thing on a map',
    locality: 'Somewhere',
    shortDescription: 'A short description that is long enough to count as a description.',
    coordinates: { lat: 10, lng: 10 },
    tags: ['tourism=attraction'],
    source: { name: 'OpenStreetMap', kind: 'osm', confidence: 0.7, lastVerified: '2026-07-01' },
    relationship: 'satellite',
    category: 'historic_site',
    interests: ['history_and_culture'],
    typicalDurationMinutes: 45,
    costLevel: 0,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: UNKNOWN_PROMINENCE_READ,
    hiddenGemScore: UNKNOWN_HIDDENNESS_READ,
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

const CORROBORATED: PlaceEvidence = {
  subjectId: 'p',
  officialUrl: 'https://operator.example/visit',
  aliases: [],
  costs: [],
  closures: [],
  safety: [],
  resolved: [
    {
      subjectId: 'p',
      factPath: 'hours.weekly',
      state: 'verified',
      factIds: ['f'],
      independentSources: 1,
      rationale: 'Stated by the operator.',
    },
  ],
};

describe('the board’s classics group cannot be reached by tagging', () => {
  it('does not promote a thoroughly described record with no prominence', () => {
    /**
     * The end of the chain this whole change is about: attribute count became
     * popularity, popularity ≥ 0.7 became "must-see classic", and a franchise
     * publishing its own hours walked into the group reserved for the things a
     * traveller would regret missing.
     */
    const described = placeWith({
      tags: [
        'tourism=attraction',
        'attr:website',
        'attr:opening_hours',
        'attr:operator',
        'attr:phone',
        'attr:wheelchair',
        'attr:takeaway',
      ],
      ...standingFields(assessPlaceStanding({ recordedAttributeCount: 6 })),
    });
    expect(described.popularityScore).toBeLessThan(0.7);
    expect(described.evidenceRichness).toBeGreaterThan(0.9);

    const assessment = assessCandidateQuality({
      place: described,
      fitScore: 0.8,
      detourMinutes: 10,
      categoryCount: 0,
      supersededByParent: false,
      duplicate: false,
      usableOnTripDates: true,
      openingUncertain: false,
      detourToleranceMinutes: 60,
    });
    expect(assessment.outcome).not.toBe('must_see_classic');
  });

  it('still calls a corroborated, well-fitting, unhidden place a classic', () => {
    // The rule is an exclusion of richness, not a bar nothing can clear.
    const assessment = assessCandidateQuality({
      place: placeWith({
        ...standingFields(
          assessPlaceStanding({
            inKnowledgeBase: true,
            knowledgeBaseNameCount: 4,
            crossDatasetCorroboration: true,
          }),
        ),
      }),
      evidence: CORROBORATED,
      fitScore: 0.8,
      detourMinutes: 10,
      categoryCount: 0,
      supersededByParent: false,
      duplicate: false,
      usableOnTripDates: true,
      openingUncertain: false,
      detourToleranceMinutes: 60,
    });
    expect(assessment.outcome).toBe('must_see_classic');
  });
});
