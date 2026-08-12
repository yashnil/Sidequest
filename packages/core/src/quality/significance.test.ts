import { describe, expect, it } from 'vitest';
import {
  assessCandidateQuality,
  assessPlaceStanding,
  experienceSignificanceOf,
  hasSignificanceEvidence,
  isAuthorityPublishedSite,
  KIND_ONLY_SHARE,
  MAX_GLOBAL_PROMINENCE,
  PRIOR_ELASTICITY,
  MAX_SINGLE_CHANNEL_WEIGHT,
  SIGNIFICANCE_CHANNELS,
  standingFields,
  UNKNOWN_HIDDENNESS_READ,
  UNKNOWN_PROMINENCE_READ,
  WIDELY_NOTED_PROMINENCE,
  type Place,
  type PlaceEvidence,
  type StandingEvidence,
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

  it('reads prominence from what the world published, and needs more than one voice', () => {
    const catalogued = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
    });
    expect(catalogued.globalProminence).toBeGreaterThan(0.7);
    expect(catalogued.localSignificance).toBeUndefined();

    /*
     * The fixture above used to reach the same bar with an entry, a second
     * catalogue and *four translated names*. It cannot now: the top of this
     * scale takes three separate statements about the place, and a count of
     * names is not one of them.
     */
    const withoutTheArticle = assessPlaceStanding({
      inKnowledgeBase: true,
      knowledgeBaseNameCount: 9,
      crossDatasetCorroboration: true,
    });
    expect(withoutTheArticle.globalProminence).toBeLessThan(0.7);
  });

  /**
   * A NAME COUNT IS NOT AN OPINION ABOUT THE PLACE — AND MAY NOT RANK EITHER.
   *
   * The first live failure: a commuter railway line carrying four translated
   * route names (`Keikyū-Hauptlinie`, `Keikyū Main Line`, `Línea Keikyū
   * principal`, `Linea Keikyu principale`) and no knowledge-base entry
   * satisfied `hasSignificanceEvidence`, so the significance gate admitted it
   * as a scenic viewpoint. Multilingual mappers translate route relations; that
   * is a fact about the record, not about the world.
   *
   * The count was then demoted to "corroborating only" — it could no longer
   * *open* a prominence, but it could still raise one — and that is the second
   * live failure, found on a compiled board of a dense city: every distinct
   * prominence on it was one of three values, and the only thing separating
   * them was how many names the row carried. A gate that admits on evidence and
   * a score that then ranks on a count is §8.3's metadata heuristic with an
   * extra step in front of it.
   *
   * So the assertion is now the strong one: the count moves **nothing**.
   */
  it('will not let a count of alternate names establish or rank a prominence', () => {
    const manyNamesOnly = assessPlaceStanding({ knowledgeBaseNameCount: 4 });
    expect(manyNamesOnly.globalProminence).toBeUndefined();
    expect('globalProminence' in manyNamesOnly).toBe(false);
    expect(hasSignificanceEvidence(manyNamesOnly)).toBe(false);

    /* Two is the other rung the old rule had, and it is refused the same way. */
    expect(assessPlaceStanding({ knowledgeBaseNameCount: 2 }).globalProminence).toBeUndefined();

    /*
     * And with the gate already open, the count still buys nothing. This is the
     * assertion that changed: it used to require the translated record to score
     * *higher*, which is the defect stated as a requirement.
     */
    const catalogued = assessPlaceStanding({ inKnowledgeBase: true });
    for (const names of [0, 1, 2, 3, 4, 12]) {
      const translated = assessPlaceStanding({
        inKnowledgeBase: true,
        knowledgeBaseNameCount: names,
      });
      expect(translated.globalProminence).toBe(catalogued.globalProminence);
      expect(experienceSignificanceOf({ standing: translated, categoryWeight: 0.5 })).toBe(
        experienceSignificanceOf({ standing: catalogued, categoryWeight: 0.5 }),
      );
    }
  });

  /**
   * The six channels the gate accepts, each asserted to be a statement somebody
   * outside the record made — and the two channels that are purely facts about
   * the record's own completeness asserted not to open it.
   */
  it('opens the significance gate only on evidence outside the record', () => {
    expect(hasSignificanceEvidence(assessPlaceStanding({ inKnowledgeBase: true }))).toBe(true);
    expect(hasSignificanceEvidence(assessPlaceStanding({ encyclopaedicArticle: true }))).toBe(
      true,
    );
    expect(
      hasSignificanceEvidence(assessPlaceStanding({ crossDatasetCorroboration: true })),
    ).toBe(true);
    expect(
      hasSignificanceEvidence(
        assessPlaceStanding({ publishedSites: ['https://www.parks.example.gov/x'] }),
      ),
    ).toBe(true);
    expect(
      hasSignificanceEvidence(assessPlaceStanding({ classifyingValues: ['heritage_site'] })),
    ).toBe(true);
    expect(hasSignificanceEvidence(assessPlaceStanding({ namedInRegionRecords: true }))).toBe(
      true,
    );

    /* Completeness, in both of its forms, opens nothing. */
    expect(
      hasSignificanceEvidence(
        assessPlaceStanding({
          knowledgeBaseNameCount: 4,
          recordedAttributeCount: 12,
          publishedSites: ['https://some-business.example.com/'],
          classifyingValues: ['amenity=cafe'],
        }),
      ),
    ).toBe(false);
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

// ---------------------------------------------------------------------------
// §8.3, as two properties rather than two intentions
// ---------------------------------------------------------------------------

/** What each channel looks like on its own, keyed by the table's own ids. */
const CHANNEL_EVIDENCE: Record<string, StandingEvidence> = {
  knowledge_base_entry: { inKnowledgeBase: true },
  encyclopaedic_article: { encyclopaedicArticle: true },
  cross_catalogue_corroboration: { crossDatasetCorroboration: true },
  authority_publication: { publishedSites: ['https://www.parks.example.gov/x'] },
  conferred_designation: { classifyingValues: ['leisure=nature_reserve'] },
  region_namesake: { namedInRegionRecords: true },
};

describe('no one statement carries the ordering', () => {
  it('declares every channel it reads, and reads every channel it declares', () => {
    /*
     * A channel in the table that the assessor never consults would be
     * documentation of a model that does not exist — and a channel the assessor
     * consults that is not in the table escapes the bound below. Both are how a
     * six-signal model quietly becomes a one-signal model again.
     */
    expect(Object.keys(CHANNEL_EVIDENCE).sort()).toEqual(
      SIGNIFICANCE_CHANNELS.map((channel) => channel.id).sort(),
    );
    for (const channel of SIGNIFICANCE_CHANNELS) {
      const standing = assessPlaceStanding(CHANNEL_EVIDENCE[channel.id]!);
      const read =
        channel.standing === 'global' ? standing.globalProminence : standing.localSignificance;
      expect(read, `${channel.id} is declared and never read`).toBe(channel.weight);
    }
  });

  it('bounds any single statement, so the top of the scale needs agreement', () => {
    for (const channel of SIGNIFICANCE_CHANNELS) {
      expect(channel.weight).toBeLessThanOrEqual(MAX_SINGLE_CHANNEL_WEIGHT);
    }
    /*
     * The property that bound exists for, stated at the kind most able to
     * exploit it: whatever one channel says, two channels saying different
     * things say more. A model where one statement can reach the ceiling is a
     * model with one signal in it.
     */
    const alone = SIGNIFICANCE_CHANNELS.map((channel) =>
      experienceSignificanceOf({
        standing: assessPlaceStanding(CHANNEL_EVIDENCE[channel.id]!),
        categoryWeight: 1,
      }),
    );
    const together = experienceSignificanceOf({
      standing: assessPlaceStanding(
        Object.assign({}, ...Object.values(CHANNEL_EVIDENCE)) as StandingEvidence,
      ),
      categoryWeight: 1,
    });
    expect(together).toBeGreaterThan(Math.max(...alone));
  });

  it('keeps every published bar inside what the model can actually reach', () => {
    /*
     * `fit.ts` held a tourist-trap threshold at 0.8 while the reachable maximum
     * was 0.81 — attainable only through the alternate-name count. Removing the
     * count would have taken the branch below the ceiling and killed it in
     * silence, which is how a fix becomes dead code.
     */
    expect(WIDELY_NOTED_PROMINENCE).toBeLessThanOrEqual(MAX_GLOBAL_PROMINENCE);
    const everyGlobalChannel = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
    });
    expect(everyGlobalChannel.globalProminence).toBe(MAX_GLOBAL_PROMINENCE);
    expect(everyGlobalChannel.globalProminence!).toBeGreaterThanOrEqual(
      WIDELY_NOTED_PROMINENCE,
    );
  });

  it('moves no ranking score at all when only the counts change', () => {
    /*
     * The counterfactual the second review's claim is really about. Correlation
     * cannot settle it — a place with an encyclopaedic article usually carries
     * translated names too — so everything else is held fixed and the two counts
     * are swung from nothing to a lot.
     */
    const base: StandingEvidence = {
      inKnowledgeBase: true,
      crossDatasetCorroboration: true,
      publishedSites: ['https://www.parks.example.gov/x'],
    };
    const sparse = assessPlaceStanding(base);
    const stuffed = assessPlaceStanding({
      ...base,
      knowledgeBaseNameCount: 12,
      recordedAttributeCount: 30,
    });
    expect(stuffed.globalProminence).toBe(sparse.globalProminence);
    expect(stuffed.localSignificance).toBe(sparse.localSignificance);
    expect(stuffed.hiddenness).toBe(sparse.hiddenness);
    expect(standingFields(stuffed).popularityScore).toBe(standingFields(sparse).popularityScore);
    expect(standingFields(stuffed).hiddenGemScore).toBe(standingFields(sparse).hiddenGemScore);
    for (const categoryWeight of [0, 0.2, 0.4, 0.85, 1]) {
      expect(experienceSignificanceOf({ standing: stuffed, categoryWeight })).toBe(
        experienceSignificanceOf({ standing: sparse, categoryWeight }),
      );
    }
    /* They are not ignored — they are counted as what they are. */
    expect(stuffed.evidenceRichness).toBeGreaterThan(sparse.evidenceRichness);
  });
});

describe('the category is a prior, and evidence can overcome it', () => {
  /** A modest kind: a park, a canal, a walk. */
  const MODEST = 0.4;
  /** A kind the taxonomy rates highly on sight: a museum. */
  const WEIGHTY = 0.85;

  const nothing = assessPlaceStanding({});
  const oneStatement = assessPlaceStanding({ inKnowledgeBase: true });
  const severalStatements = assessPlaceStanding({
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
    crossDatasetCorroboration: true,
    namedInRegionRecords: true,
  });

  it('still lets the kind decide when nobody has established anything', () => {
    /*
     * The floor that keeps a board of micro-features from being ordered only
     * against itself. Unchanged by this rewrite, deliberately: at zero evidence
     * the function returns exactly what it always did.
     */
    expect(experienceSignificanceOf({ standing: nothing, categoryWeight: WEIGHTY })).toBe(0.26);
    expect(experienceSignificanceOf({ standing: nothing, categoryWeight: MODEST })).toBe(0.12);
    expect(experienceSignificanceOf({ standing: nothing, categoryWeight: 0.2 })).toBe(0.06);
    for (const categoryWeight of [0.2, MODEST, WEIGHTY]) {
      expect(experienceSignificanceOf({ standing: nothing, categoryWeight })).toBe(
        Math.round(categoryWeight * KIND_ONLY_SHARE * 100) / 100,
      );
    }
  });

  it('lets an evidenced place pass the ceiling its category used to impose', () => {
    /*
     * The blocker in one line, without a second place to compare against. Under
     * the old shape `categoryWeight` multiplied the finished score, so this
     * value could not exceed `MODEST` by any evidence at all. It has to now.
     */
    expect(
      experienceSignificanceOf({ standing: severalStatements, categoryWeight: MODEST }),
    ).toBeGreaterThan(MODEST);

    /*
     * And by exactly what the elasticity says, so there is one knob rather than
     * a knob and a fudge. At total certainty the modest kind reaches the
     * distance `PRIOR_ELASTICITY` opens between its own weight and one.
     */
    const certain = {
      evidenceRichness: 0,
      sourceConfidence: 0,
      globalProminence: 1,
      localSignificance: 1,
    };
    expect(experienceSignificanceOf({ standing: certain, categoryWeight: MODEST })).toBe(
      Math.round((MODEST + (1 - MODEST) * MODEST * PRIOR_ELASTICITY) * 100) / 100,
    );
  });

  it('lets a famous instance of a modest kind outrank a mediocre instance of a weighty one', () => {
    /**
     * THE RELEASE BLOCKER, AS ONE ASSERTION.
     *
     * `categoryWeight` used to multiply the whole score, which makes it a hard
     * ceiling: a kind weighted 0.4 could never exceed 0.4 whatever the world had
     * said about a particular one, while a kind weighted 0.85 started above that
     * ceiling with nothing said about it at all. So a major urban park with an
     * encyclopaedic article, a second catalogue and the district's own name sat
     * below an anonymous gallery, and §8.3's "significance is about this place"
     * was answered by the category instead.
     */
    const famousModest = experienceSignificanceOf({
      standing: severalStatements,
      categoryWeight: MODEST,
    });
    const mediocreWeighty = experienceSignificanceOf({
      standing: oneStatement,
      categoryWeight: WEIGHTY,
    });
    const unevidencedWeighty = experienceSignificanceOf({
      standing: nothing,
      categoryWeight: WEIGHTY,
    });
    expect(famousModest).toBeGreaterThan(mediocreWeighty);
    expect(famousModest).toBeGreaterThan(unevidencedWeighty);
  });

  it('will not let evidence argue a kind that is not an experience into being one', () => {
    /*
     * The other half of "prior, not ceiling", and the half that keeps the
     * loosening honest: a pylon, a car park, a depot. The kind's weight scales
     * how far evidence can move it, so zero stays zero however much is
     * published — otherwise the repair would hand every well-documented piece of
     * infrastructure a seat on the board.
     */
    for (const standing of [nothing, oneStatement, severalStatements]) {
      expect(experienceSignificanceOf({ standing, categoryWeight: 0 })).toBe(0);
    }
  });

  it('keeps the kind monotone at every level of evidence', () => {
    /* A prior that stopped ordering the kinds would not be a prior. */
    for (const standing of [nothing, oneStatement, severalStatements]) {
      const scores = [0.1, 0.3, 0.5, 0.7, 1].map((categoryWeight) =>
        experienceSignificanceOf({ standing, categoryWeight }),
      );
      for (let index = 1; index < scores.length; index += 1) {
        expect(scores[index]!).toBeGreaterThanOrEqual(scores[index - 1]!);
      }
    }
  });
});

describe('hiddenness is a gap between two channels, not the inverse of one', () => {
  const designatedAndUnknown = assessPlaceStanding({
    classifyingValues: ['boundary=protected_area'],
  });
  const nothingAtAll = assessPlaceStanding({});
  const globallyFamous = assessPlaceStanding({
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
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
      encyclopaedicArticle: true,
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
            encyclopaedicArticle: true,
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
