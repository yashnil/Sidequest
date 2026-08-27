import { describe, expect, it } from 'vitest';
import {
  assessCandidateQuality,
  assessPlaceStanding,
  attributesExpectVisitors,
  composeExperienceSignificance,
  DESIGNATED_AREA_MIN_METRES,
  DESIGNATED_AREA_STANDING_METRES,
  ESTABLISHED_SHARE,
  EXPERIENCE_CREDIBILITY_FLOOR,
  experienceSignificanceOf,
  hasConferredDesignation,
  hasSignificanceEvidence,
  isAuthorityPublishedSite,
  KIND_ONLY_SHARE,
  MAX_GLOBAL_PROMINENCE,
  MAX_MAGNITUDE_CHANNEL_WEIGHT,
  MAX_SINGLE_CHANNEL_WEIGHT,
  MAX_UNMAGNIFIED_PROMINENCE,
  MINTED_NOTICE_PROMINENCE,
  NOTICE_MAGNITUDE_CHANNELS,
  prominenceBasisOf,
  prominenceRead,
  ratesAsExperience,
  SIGNIFICANCE_CHANNELS,
  standingFields,
  standsAsEstablishedName,
  UNKNOWN_HIDDENNESS_READ,
  WIDELY_NOTED_PROMINENCE,
  WITHHELD_PROMINENCE_READ,
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
    /*
     * Three presence statements *and* the ground that carries the magnitude.
     * The fixture used to be the three statements alone, and it reached this
     * bar on them — which is the defect the magnitude gate closed, because a
     * catalogue mints those same three for a neighbourhood ballfield. The
     * assertion is unchanged; what it takes to satisfy it is not.
     */
    const catalogued = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 2_600,
      groundWitnessCount: 5,
    });
    expect(catalogued.globalProminence).toBeGreaterThan(0.7);

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
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 2_600,
      groundWitnessCount: 5,
    });
    expect(withoutTheArticle.globalProminence).toBeLessThan(0.7);
    /* And the missing article is what did it, with the magnitude held equal. */
    expect(withoutTheArticle.noticeMagnitude).toBe(catalogued.noticeMagnitude);
    expect(withoutTheArticle.globalProminence!).toBeLessThan(catalogued.globalProminence!);
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
   * The five channels that describe the place, each asserted to be a statement
   * somebody outside the record made — and the two channels that are purely
   * facts about the record's own completeness asserted not to open it.
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
        assessPlaceStanding({
          classifyingValues: ['heritage_site'],
          mappedExtentMetres: 400,
        }),
      ),
    ).toBe(true);
    expect(
      hasSignificanceEvidence(
        assessPlaceStanding({
          subjectName: 'Back Valley Bridge',
          publishedSites: ['https://transport.example.gov/bridges/back-valley-bridge.html'],
        }),
      ),
    ).toBe(true);

    /*
     * A SHARED NAME IS A FACT ABOUT NAMES.
     *
     * `region_namesake` used to open this gate. It cannot say which of the two
     * things was named after the other, and on a live New York pack its only
     * wrong answers were of exactly that shape — a public-housing development
     * in the Bronx neighbourhood it is named after, admitted as historically
     * significant on the strength of the borrowed name.
     */
    expect(hasSignificanceEvidence(assessPlaceStanding({ namedInRegionRecords: true }))).toBe(
      false,
    );
    expect(assessPlaceStanding({ namedInRegionRecords: true }).channels).toEqual([
      'region_namesake',
    ]);
    expect(
      assessPlaceStanding({ namedInRegionRecords: true }).localSignificance,
    ).toBeGreaterThan(0);

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

  /**
   * PUBLIC HOUSING IS NOT A HISTORIC SITE, AND THIS IS THE SENTENCE THAT SAID IT
   * WAS.
   *
   * Two live boards on two continents, in the same week: eleven New York
   * public-housing developments and a block of a Tokyo agency's rental stock,
   * every one of them filed by the catalogue under its bare historic-and-cultural
   * node, every one of them typed `historic_site` and labelled "Top pick for
   * you". Each needed a witness that it was historic. Each got one from the page
   * its landlord publishes — a housing authority's own domain, and a letting
   * listing on an urban-renewal agency's.
   *
   * A public body publishes every asset on its books. What the channel observes
   * is who operates a place, and that is a different proposition from whether the
   * place is worth a traveller's day. So it may still *raise* a standing — the
   * park below keeps a positive `localSignificance` — and it may no longer
   * *vouch* for a contested claim on its own.
   */
  it('does not accept a public landlord publishing its own stock as a witness', () => {
    /* The shape both cities produced: a bare structural claim, a government URL. */
    const municipalHousing = assessPlaceStanding({
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      classifyingValues: ['historic_site', 'cultural_and_historic'],
      recordedAttributeCount: 1,
    });
    expect(hasSignificanceEvidence(municipalHousing)).toBe(false);
    expect(municipalHousing.channels).toEqual(['authority_publication']);

    /* Same URL shape, and a boundary drawn round a reserve says what the place is. */
    const designatedReserve = assessPlaceStanding({
      publishedSites: ['https://www.example.gov/back-valley'],
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 900,
    });
    expect(hasSignificanceEvidence(designatedReserve)).toBe(true);

    /**
     * AND THE NARROWING HAS TO STOP AT THE LANDLORD.
     *
     * The first version of this rule refused the whole domain, and the New York
     * board lost the **Brooklyn Bridge** — a record whose only witness is the
     * city transport department's own page for the bridge, at
     * `nyc.gov/…/bridges/brooklyn_bridge.shtml`. Both halves are in this
     * assertion because a fix in one direction is what produced the defect in
     * the other: the same authority, the same domain, two pages that say
     * different things.
     */
    const namedInThePage = assessPlaceStanding({
      subjectName: 'Old Harbour Bridge',
      publishedSites: ['https://www.transport.example.gov/bridges/old_harbour_bridge.shtml'],
      classifyingValues: ['bridge'],
    });
    expect(namedInThePage.channels).toEqual(['authority_page_about_it']);
    expect(hasSignificanceEvidence(namedInThePage)).toBe(true);

    /* The estate is on the landlord's books, and the page is the landlord's. */
    const estate = assessPlaceStanding({
      subjectName: 'Clanton Point Houses',
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      classifyingValues: ['historic_site'],
    });
    expect(estate.channels).toEqual(['authority_publication']);
    expect(hasSignificanceEvidence(estate)).toBe(false);

    /* One page is one witness: the two readings never both fire. */
    expect(namedInThePage.channels).not.toContain('authority_publication');
    expect(namedInThePage.localSignificance).toBe(estate.localSignificance);

    /* The channel is demoted, not deleted: it still moves the score it always did. */
    const unpublished = assessPlaceStanding({ classifyingValues: ['park'] });
    const authorityPublished = assessPlaceStanding({
      publishedSites: ['https://www.parks.example.gov/back-valley'],
      classifyingValues: ['park'],
    });
    expect(
      experienceSignificanceOf({ standing: authorityPublished, categoryWeight: 0.5 }),
    ).toBeGreaterThan(experienceSignificanceOf({ standing: unpublished, categoryWeight: 0.5 }));
  });

  /**
   * A BREWERY IS NOT A NATIONAL PARK, AND THE CATEGORY WORD SAID IT WAS.
   *
   * The heaviest channel in the table, the one that opens the gate on its own,
   * fired from the record's own category string. Two live packs on 2026-08-12
   * certified as holding a protected or heritage designation: an anime shop and
   * a brewery filed under `national_park`; a bench outside a lecture hall, two
   * playgrounds and a drinking fountain filed under `nature_reserve`; and, in a
   * *New York* pack, Yosemite. **92 records fired in New York and 29 in Tokyo,
   * and every one of them fired from a category word** — not one from a
   * designation stated anywhere else in the record.
   *
   * A category is how a catalogue filed a row. The table above promises that no
   * channel can be produced that way, and this is the channel that broke the
   * promise. What cannot be produced by filing is a *boundary*: somebody
   * surveyed ground and traced its edges, which is the act a designation
   * consists of, and on those same packs every offending record was a point
   * carrying a one-to-three-metre box while every real designated area had a
   * shape hundreds of metres to kilometres across.
   */
  it('will not certify a designation from a category word with no ground under it', () => {
    /* The shape both cities produced: a POI point filed under a park word. */
    for (const word of ['national_park', 'nature_reserve', 'wildlife_sanctuary', 'state_park']) {
      const filedUnderIt = assessPlaceStanding({
        classifyingValues: [word, 'sports_and_recreation', 'park'],
        mappedExtentMetres: undefined,
        recordedAttributeCount: 1,
      });
      expect(filedUnderIt.channels, word).not.toContain('conferred_designation');
      expect(filedUnderIt.localSignificance, word).toBeUndefined();
      expect(hasSignificanceEvidence(filedUnderIt), word).toBe(false);
      expect(hasConferredDesignation({ classifyingValues: [word] }), word).toBe(false);
    }

    /* A bounding box a metre across is a point with rounding noise on it. */
    expect(
      assessPlaceStanding({
        classifyingValues: ['national_park'],
        mappedExtentMetres: DESIGNATED_AREA_MIN_METRES - 1,
      }).channels,
    ).not.toContain('conferred_designation');

    /*
     * Ground with a shape, and the same word, is the claim the channel is for
     * — graded by the scale of the drawn boundary. The minimum outline is a
     * pocket designation: real, place-attesting, and not the full channel,
     * because on live artifacts every suburban micro-site that outranked a
     * destination's canon rode the full weight on 204-303 m of ground while
     * every recognisable reserve measures upward of a kilometre.
     */
    const pocketArea = assessPlaceStanding({
      classifyingValues: ['national_park'],
      mappedExtentMetres: DESIGNATED_AREA_MIN_METRES,
    });
    expect(pocketArea.channels).toContain('pocket_designation');
    expect(pocketArea.channels).not.toContain('conferred_designation');
    expect(hasSignificanceEvidence(pocketArea)).toBe(true);
    const designatedArea = assessPlaceStanding({
      classifyingValues: ['national_park'],
      mappedExtentMetres: DESIGNATED_AREA_STANDING_METRES,
    });
    expect(designatedArea.channels).toContain('conferred_designation');
    expect(hasSignificanceEvidence(designatedArea)).toBe(true);

    /* And an outline alone certifies nothing: a large car park is a car park. */
    expect(
      assessPlaceStanding({ classifyingValues: ['parking'], mappedExtentMetres: 4_000 }).channels,
    ).toEqual([]);
  });

  /**
   * The channel table has to keep saying which of the two propositions each
   * statement answers, because the gate is now built on that column rather than
   * on a hand-kept list of ids.
   */
  it('classifies every channel as evidence about the place, its operator or its name', () => {
    const operatorChannels = SIGNIFICANCE_CHANNELS.filter(
      (channel) => channel.attests === 'its_operator',
    ).map((channel) => channel.id);
    expect(operatorChannels).toEqual(['authority_publication']);
    const nameChannels = SIGNIFICANCE_CHANNELS.filter(
      (channel) => channel.attests === 'its_name',
    ).map((channel) => channel.id);
    expect(nameChannels).toEqual(['ground_witness', 'region_namesake']);
    for (const channel of SIGNIFICANCE_CHANNELS) {
      const standing = assessPlaceStanding(CHANNEL_EVIDENCE[channel.id]!);
      expect(standing.channels, `${channel.id} never records that it fired`).toContain(channel.id);
      expect(hasSignificanceEvidence(standing), channel.id).toBe(channel.attests === 'the_place');
    }
  });

  it('reads local significance from channels a business cannot publish about itself', () => {
    const designated = assessPlaceStanding({
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 900,
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
  /*
   * The same government domain, and a page addressed to one named thing rather
   * than to the department. That is the whole difference, and it is what tells
   * the Brooklyn Bridge's transport-department page from a housing authority's
   * front door.
   */
  authority_page_about_it: {
    subjectName: 'Back Valley Bridge',
    publishedSites: ['https://transport.example.gov/bridges/back-valley-bridge.html'],
  },
  /*
   * Pocket first, standing second: the merged-evidence case below folds these
   * with `Object.assign`, and the standing extent must be the one that
   * survives so the strongest designation claim is what "every channel
   * together" means.
   */
  pocket_designation: {
    classifyingValues: ['leisure=nature_reserve'],
    mappedExtentMetres: 200,
  },
  conferred_designation: {
    classifyingValues: ['leisure=nature_reserve'],
    mappedExtentMetres: 1_500,
  },
  ground_witness: { groundWitnessCount: 2 },
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
    /*
     * Every global channel *and* every magnitude channel, because since the
     * magnitude gate the published maximum is reachable only that way — which
     * is the same dead-branch hazard one rung along. If a magnitude weight is
     * ever lowered far enough that this stops reaching the maximum, the two
     * published bars above become branches nothing can run, and this fails.
     */
    const everyGlobalChannel = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: DESIGNATED_AREA_STANDING_METRES,
      groundWitnessCount: 6,
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

// ---------------------------------------------------------------------------
// Presence is not magnitude, and a missing tag is not obscurity
// ---------------------------------------------------------------------------

/**
 * THE LIVE EVIDENCE CLASS, IN ONE PARAGRAPH.
 *
 * Three delivered boards. A metropolis's principal castle — a
 * destination-defining attraction whose own catalogue row carries no
 * knowledge-base identifier — read `popularityScore` **0.15** with
 * `globalProminence` absent, and lost its board seat. A municipal sports park in
 * the same city read **0.70**. A city tower, a suburban park twenty kilometres
 * out and a famous waterfall all read **0.79**, indistinguishably. In another
 * region a world-famous waterfall rendered under "Probably skip" while a
 * suburban lake and a small municipal beach rendered under "Classics worth your
 * time", captioned "One of the established names here — the kind of stop this
 * area is known for".
 *
 * Two faults produced all of that, and both are asserted below. The prominence
 * union had only *presence* channels, so an entry and an article — which an open
 * catalogue mints for every row of a class it maps at all — saturated a
 * ballfield to landmark standing. And a **missing** tag was read as a low score
 * rather than an absent one, so absence of evidence became evidence of
 * obscurity and the castle sank beneath everything.
 *
 * Every fixture here is a class of evidence under an invented name, as the rest
 * of this file is: the assertions must hold in any country.
 */
describe('notice minted for a whole class cannot outrank a landmark', () => {
  /**
   * A destination-defining attraction as the packs actually hold one: its own
   * row carries a website and nothing else — no identifier, no article, no
   * second catalogue — while the ground around it is surveyed at destination
   * scale under a conferred status and repeats its name.
   */
  const SPARSE_LANDMARK: StandingEvidence = {
    subjectName: 'Harrowgate Keep',
    classifyingValues: ['leisure=nature_reserve'],
    mappedExtentMetres: 2_600,
    groundWitnessCount: 5,
    recordedAttributeCount: 1,
  };

  /**
   * A generic municipal facility as the packs actually hold one: a
   * knowledge-base entry, an encyclopaedic article, a second catalogue, four
   * translated names, a full sheet of attributes — and nothing anywhere about
   * scale.
   */
  const RICH_MUNICIPAL_FACILITY: StandingEvidence = {
    subjectName: 'Fernbrook Ward Sports Field',
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
    crossDatasetCorroboration: true,
    knowledgeBaseNameCount: 4,
    recordedAttributeCount: 6,
  };

  it('ranks a sparsely described landmark above a metadata-rich municipal facility', () => {
    /*
     * The exact live inversion, as one assertion: a principal castle at 0.15
     * beneath a municipal sports park at 0.70. The facility holds strictly more
     * metadata — more names, more attributes, every presence channel the model
     * has — and the landmark holds one attribute and a boundary. The required
     * invariant is that the landmark can still win.
     */
    const landmark = assessPlaceStanding(SPARSE_LANDMARK);
    const facility = assessPlaceStanding(RICH_MUNICIPAL_FACILITY);

    expect(facility.evidenceRichness).toBeGreaterThan(landmark.evidenceRichness);
    expect(landmark.globalProminence, 'the landmark carries no notice at all').toBeUndefined();

    /* The rank the retention pass and the seat cut actually order on. */
    for (const categoryWeight of [0.35, 0.5, 0.75, 1]) {
      expect(
        experienceSignificanceOf({ standing: landmark, categoryWeight }),
        `landmark loses to the facility at kind weight ${categoryWeight}`,
      ).toBeGreaterThan(experienceSignificanceOf({ standing: facility, categoryWeight }));
    }

    /* And the legacy read a board, an autoselector and a caption all consult. */
    expect(prominenceRead(landmark)).toBeGreaterThan(prominenceRead(facility));
  });

  it('refuses landmark standing to a knowledge-base tag with no magnitude behind it', () => {
    /*
     * The sports park at 0.70 and the suburban park at 0.79: every presence
     * channel the model has, and no statement whatsoever about how big the
     * noticed thing is. It must not saturate.
     */
    const minted = assessPlaceStanding(RICH_MUNICIPAL_FACILITY);
    expect(minted.noticeMagnitude, 'nothing said anything about scale').toBeUndefined();
    expect(minted.globalProminence!).toBeLessThan(WIDELY_NOTED_PROMINENCE);
    expect(standsAsEstablishedName({ ...standingFields(minted), evidenceRichness: 1 })).toBe(false);

    /* The ceiling is a property of the model, not of this fixture. */
    const everyPresenceChannel = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
    });
    expect(everyPresenceChannel.globalProminence!).toBeLessThan(WIDELY_NOTED_PROMINENCE);

    /*
     * And the compression is not a flattener. The band presence alone can reach
     * still *orders*, or the seat cut inside it falls back to the id lottery —
     * the defect the witness bound one layer down already had to repair.
     */
    const entryOnly = assessPlaceStanding({ inKnowledgeBase: true }).globalProminence!;
    const withArticle = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
    }).globalProminence!;
    expect(entryOnly).toBeLessThan(withArticle);
    expect(withArticle).toBeLessThan(everyPresenceChannel.globalProminence!);
  });

  it('withholds prominence for a missing knowledge-base tag rather than flooring it', () => {
    /*
     * The castle. No knowledge base mentions its row, and that is *not* a claim
     * that the world has not noticed it — so the honest reads are: the channel
     * stays absent, and the read is banded rather than floored.
     */
    const landmark = assessPlaceStanding(SPARSE_LANDMARK);
    expect('globalProminence' in landmark).toBe(false);
    expect(prominenceBasisOf(landmark)).toBe('withheld');
    expect(prominenceRead(landmark)).toBeGreaterThan(WITHHELD_PROMINENCE_READ);

    /*
     * Banded, not substituted. The release that stopped flooring started
     * projecting the *local* union onto the notice axis, and a local weight
     * lands inside the presence band — which is where the delivered boards put
     * a destination's principal temple, shrine, palace and castle at 0.35,
     * beneath a ward park at 0.57 and a suburban zoo at 0.60. The withheld read
     * sits above everything notice alone can assert, and never above what an
     * observed read could say.
     */
    expect(prominenceRead(landmark)).toBeGreaterThan(MAX_UNMAGNIFIED_PROMINENCE);
    expect(prominenceRead(landmark)).toBeLessThanOrEqual(MAX_GLOBAL_PROMINENCE);

    /* Nothing at all still reads as nothing at all. */
    expect(prominenceRead(assessPlaceStanding({ recordedAttributeCount: 6 }))).toBe(
      WITHHELD_PROMINENCE_READ,
    );

    /*
     * And a withheld read the ground itself pointed at may wear the caption:
     * that is the "plausible path to strong standing through independent
     * evidence" the empty classics heading proved was foreclosed.
     */
    const fields = standingFields(landmark);
    expect(fields.popularityScore).toBeGreaterThanOrEqual(WIDELY_NOTED_PROMINENCE);
    expect(standsAsEstablishedName({ ...fields, evidenceRichness: fields.evidenceRichness })).toBe(
      true,
    );

    /*
     * A standing nothing pointed at does not get there, and cannot: a
     * government domain that merely lists the record and an area that shares
     * its name are the two statements the table gives weight and denies a
     * casting vote, so the read is capped at what notice alone can assert.
     */
    const landlordAndName = assessPlaceStanding({
      subjectName: 'Fernbrook Estate',
      publishedSites: ['https://housing.fernshire.gov/portfolio'],
      namedInRegionRecords: true,
      recordedAttributeCount: 3,
    });
    expect(prominenceBasisOf(landlordAndName)).toBe('unestablished');
    expect(prominenceRead(landlordAndName)).toBeLessThanOrEqual(MAX_UNMAGNIFIED_PROMINENCE);
    expect(prominenceRead(landlordAndName)).toBeLessThan(WIDELY_NOTED_PROMINENCE);
    const landlordFields = standingFields(landlordAndName);
    expect(
      standsAsEstablishedName({
        ...landlordFields,
        evidenceRichness: landlordFields.evidenceRichness,
      }),
    ).toBe(false);
  });

  /**
   * THE PHASE-16 DISTINCTIONS, ASSERTED AGAINST THE NEW CHANNEL BY NAME.
   *
   * Each of these was a shipped defect that a previous wave removed, and each
   * one is a door a *magnitude* channel could quietly reopen — magnitude reads
   * an extent and a namesake count, and both are one careless line away from
   * becoming "how much did somebody write down". Asserted here so that this
   * change cannot undo any of them in silence.
   */
  it('keeps every distinction the magnitude channel could have reopened', () => {
    const bare = assessPlaceStanding({ inKnowledgeBase: true, encyclopaedicArticle: true });

    /* Metadata completeness is not significance, and is not magnitude either. */
    const stuffed = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      knowledgeBaseNameCount: 12,
      recordedAttributeCount: 30,
    });
    expect(stuffed.noticeMagnitude).toBeUndefined();
    expect(stuffed.globalProminence).toBe(bare.globalProminence);
    expect(stuffed.evidenceRichness).toBeGreaterThan(bare.evidenceRichness);

    /* An operator or landlord URL is not significance, and buys no magnitude. */
    const landlord = assessPlaceStanding({
      subjectName: 'Marlow Court Estate',
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      classifyingValues: ['historic_site'],
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
    });
    expect(landlord.channels).toContain('authority_publication');
    expect(hasSignificanceEvidence(assessPlaceStanding({
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      classifyingValues: ['historic_site'],
    }))).toBe(false);
    expect(landlord.noticeMagnitude).toBeUndefined();
    expect(landlord.globalProminence).toBe(bare.globalProminence);

    /*
     * A category token self-certifying is not heritage evidence — and now not a
     * magnitude either, which is the sharper version of the same rule: the
     * magnitude channel reads `designationChannelFor`, so a point filed under a
     * park word gets neither the designation nor the scale.
     */
    for (const word of ['national_park', 'nature_reserve', 'wildlife_sanctuary']) {
      const filedUnderIt = assessPlaceStanding({
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        classifyingValues: [word],
        recordedAttributeCount: 1,
      });
      expect(filedUnderIt.noticeMagnitude, word).toBeUndefined();
      expect(filedUnderIt.globalProminence, word).toBe(bare.globalProminence);
    }
    /* And the pocket tier is a designation without the scale, so it is not one. */
    const pocket = assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      classifyingValues: ['nature_reserve'],
      mappedExtentMetres: DESIGNATED_AREA_STANDING_METRES - 1,
    });
    expect(pocket.channels).toContain('pocket_designation');
    expect(pocket.noticeMagnitude).toBeUndefined();

    /*
     * Hiddenness is not lack of metadata. The landmark below holds one
     * attribute and is not hidden because of that — it is hidden because the
     * region establishes it and the world has published nothing, which is the
     * gap the channel measures.
     */
    const local = assessPlaceStanding(SPARSE_LANDMARK);
    expect(local.evidenceRichness).toBeLessThan(0.5);
    expect(local.hiddenness!).toBeGreaterThanOrEqual(0.6);
    expect(assessPlaceStanding({ recordedAttributeCount: 0 }).hiddenness).toBeUndefined();

    /* Popularity is not personal fit: no fit input reaches any of this. */
    expect(Object.keys(assessPlaceStanding({}))).not.toContain('fit');
  });

  /**
   * THE SAME DISTINCTIONS, AGAINST THE WITHHELD BAND.
   *
   * `prominenceRead`'s withheld band is a new door into a *high* read, and
   * every one of the distinctions above is one careless line away from walking
   * through it: a band opened by a count would be metadata completeness with a
   * new ceiling, a band opened by an operator URL would be the landlord's front
   * door again, a band opened by a category word would be the self-certifying
   * token. Asserted by name so this change cannot undo any of them in silence.
   */
  it('opens the withheld band to nothing the earlier waves already shut out', () => {
    const readOf = (evidence: StandingEvidence) => prominenceRead(assessPlaceStanding(evidence));

    /* Metadata completeness is not significance, and does not open the band. */
    const stuffed = assessPlaceStanding({
      knowledgeBaseNameCount: 12,
      recordedAttributeCount: 30,
    });
    expect(stuffed.evidenceRichness).toBe(1);
    expect(prominenceBasisOf(stuffed)).toBe('unestablished');
    expect(prominenceRead(stuffed)).toBe(WITHHELD_PROMINENCE_READ);

    /*
     * An operator URL is not significance. A government domain that lists a
     * record among its holdings keeps its weight and does not open the band —
     * the eleven public-housing developments and the block of agency rental
     * stock that reached live boards as historic sites.
     */
    const landlord = assessPlaceStanding({
      subjectName: 'Marlow Court Estate',
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      recordedAttributeCount: 4,
    });
    expect(landlord.channels).toContain('authority_publication');
    expect(prominenceBasisOf(landlord)).toBe('unestablished');
    expect(prominenceRead(landlord)).toBeLessThanOrEqual(MAX_UNMAGNIFIED_PROMINENCE);

    /* An area that shares a name cannot say which way the naming ran. */
    const namesake = assessPlaceStanding({
      subjectName: 'Clayfield Point',
      namedInRegionRecords: true,
      recordedAttributeCount: 4,
    });
    expect(namesake.channels).toContain('region_namesake');
    expect(prominenceBasisOf(namesake)).toBe('unestablished');
    expect(prominenceRead(namesake)).toBeLessThan(WIDELY_NOTED_PROMINENCE);

    /* Nor can both of them together, which is the live pairing. */
    const both = assessPlaceStanding({
      subjectName: 'Marlow Court Estate',
      publishedSites: ['https://www.example.gov/HOUSING-AUTHORITY'],
      namedInRegionRecords: true,
    });
    expect(prominenceBasisOf(both)).toBe('unestablished');
    expect(prominenceRead(both)).toBeLessThanOrEqual(MAX_UNMAGNIFIED_PROMINENCE);

    /* A category token does not self-certify its way into the band either. */
    for (const word of ['national_park', 'nature_reserve', 'wildlife_sanctuary']) {
      expect(prominenceBasisOf(assessPlaceStanding({ classifyingValues: [word] })), word).toBe(
        'unestablished',
      );
      expect(readOf({ classifyingValues: [word], recordedAttributeCount: 6 }), word).toBe(
        WITHHELD_PROMINENCE_READ,
      );
    }

    /*
     * Hiddenness is not lack of metadata, and the band does not change that: a
     * record nothing established is still absent on hiddenness rather than
     * promoted into the hidden-gem group by its own emptiness.
     */
    expect(assessPlaceStanding({ recordedAttributeCount: 6 }).hiddenness).toBeUndefined();
    expect(standingFields(assessPlaceStanding({ recordedAttributeCount: 6 })).hiddenGemScore).toBe(
      UNKNOWN_HIDDENNESS_READ,
    );

    /* And the band's two bounds are properties of the tables, not of a fixture. */
    expect(MAX_UNMAGNIFIED_PROMINENCE).toBeLessThan(WIDELY_NOTED_PROMINENCE);
    expect(MAX_UNMAGNIFIED_PROMINENCE).toBeLessThan(MAX_GLOBAL_PROMINENCE);
    for (const evidence of [
      { groundWitnessCount: 1 },
      { subjectName: 'Harrowgate Keep', publishedSites: ['https://parks.example.gov/harrowgate-keep'] },
      { classifyingValues: ['nature_reserve'], mappedExtentMetres: 2_600 },
      { classifyingValues: ['nature_reserve'], mappedExtentMetres: 2_600, groundWitnessCount: 6 },
    ] satisfies StandingEvidence[]) {
      const standing = assessPlaceStanding(evidence);
      expect(prominenceBasisOf(standing)).toBe('withheld');
      expect(prominenceRead(standing)).toBeGreaterThan(MAX_UNMAGNIFIED_PROMINENCE);
      expect(prominenceRead(standing)).toBeLessThanOrEqual(MAX_GLOBAL_PROMINENCE);
    }
  });

  /**
   * The table's own guard for the new column, in the shape the other two
   * columns already have: a column nobody reads documents a model that does not
   * exist, and a column that agrees with `attests` everywhere is `attests`
   * under a second name.
   */
  it('declares which statements point at the place, and differs from attestation once', () => {
    const differing = SIGNIFICANCE_CHANNELS.filter(
      (channel) => channel.pointsAtThePlace !== (channel.attests === 'the_place'),
    );
    /*
     * Exactly one, and it is the ground's own guarded witnesses: a precinct of
     * namesakes is the ground pointing at a landmark, which is not the
     * encyclopaedia describing it (so it may not open the candidacy gate) and is
     * not an administrative area sharing a name (so it may open a standing).
     */
    expect(differing.map((channel) => channel.id)).toEqual(['ground_witness']);
    for (const channel of SIGNIFICANCE_CHANNELS) {
      if (channel.attests === 'its_operator') {
        expect(channel.pointsAtThePlace, channel.id).toBe(false);
      }
    }
  });

  it('declares every magnitude channel it reads, and bounds each one', () => {
    /*
     * The magnitude table's own form of the guard `SIGNIFICANCE_CHANNELS` has:
     * a channel nobody consults documents a model that does not exist, and a
     * weight of 1 would let one reading of one field decide how far a record's
     * notice reaches. Both are how a two-signal dimension quietly becomes one.
     */
    const evidenceFor: Record<string, StandingEvidence> = {
      destination_scale_ground: {
        classifyingValues: ['leisure=nature_reserve'],
        mappedExtentMetres: DESIGNATED_AREA_STANDING_METRES,
      },
      ground_namesake_precinct: { groundWitnessCount: 3 },
    };
    expect(Object.keys(evidenceFor).sort()).toEqual(
      NOTICE_MAGNITUDE_CHANNELS.map((channel) => channel.id).sort(),
    );
    for (const channel of NOTICE_MAGNITUDE_CHANNELS) {
      expect(channel.weight).toBeLessThanOrEqual(MAX_MAGNITUDE_CHANNEL_WEIGHT);
      expect(channel.weight, `${channel.id} decides the dimension alone`).toBeLessThan(1);
      const alone = assessPlaceStanding({
        inKnowledgeBase: true,
        ...evidenceFor[channel.id]!,
      });
      expect(alone.noticeMagnitude, `${channel.id} is declared and never read`).toBe(
        channel.weight,
      );
    }

    /* And the two published bars still bracket what the model can produce. */
    expect(MINTED_NOTICE_PROMINENCE).toBeLessThan(WIDELY_NOTED_PROMINENCE);
    expect(WIDELY_NOTED_PROMINENCE).toBeLessThanOrEqual(MAX_GLOBAL_PROMINENCE);
  });
});

describe('the category is a prior, and evidence can overcome it', () => {
  /** A modest kind: a park, a canal, a walk. */
  const MODEST = 0.4;
  /** A kind the taxonomy rates highly on sight: a museum. */
  const WEIGHTY = 0.85;

  const nothing = assessPlaceStanding({});
  const oneStatement = assessPlaceStanding({ inKnowledgeBase: true });
  /*
   * Several statements, and one of them about *scale*. The fixture used to be
   * the three presence bits and a shared name, which is exactly the evidence a
   * catalogue mints for a neighbourhood ballfield — so under the magnitude gate
   * that is no longer a famous place and this block would have been asserting
   * fame off a record that has none. The precinct of namesakes is what makes it
   * one, and it is evidence the compiled path already computes.
   */
  const severalStatements = assessPlaceStanding({
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
    crossDatasetCorroboration: true,
    groundWitnessCount: 4,
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
     * And by exactly the two published bounds, so the number is readable off the
     * constants rather than off a curve. At total certainty a kind that admits
     * evidence in full reaches its own share of the kind budget plus the whole
     * evidence budget.
     */
    const certain = {
      evidenceRichness: 0,
      sourceConfidence: 0,
      globalProminence: 1,
      localSignificance: 1,
      channels: ['knowledge_base_entry'] as const,
    };
    expect(experienceSignificanceOf({ standing: certain, categoryWeight: MODEST })).toBe(
      Math.round((MODEST * KIND_ONLY_SHARE + ESTABLISHED_SHARE) * 100) / 100,
    );
  });

  it('composes from two bounded contributions, neither of which caps the other', () => {
    /**
     * THE STRUCTURE, ASSERTED RATHER THAN DESCRIBED.
     *
     * `finalScore = f(categoryWeight) × g(evidence)` is the family the §16B
     * brief rules out, and it is not enough to test that one example escapes it
     * — a softened multiplier passes that and is still a multiplier. What
     * distinguishes the shapes is *additivity*: the evidence contribution at a
     * given level of evidence must be the same number whatever the kind is,
     * once the kind is credible at all. Under any product it is proportional to
     * the kind, which is what a ceiling is.
     */
    const credible = [
      EXPERIENCE_CREDIBILITY_FLOOR,
      0.4,
      0.6,
      WEIGHTY,
      1,
    ];
    for (const standing of [nothing, oneStatement, severalStatements]) {
      const composed = credible.map((categoryWeight) =>
        composeExperienceSignificance({ standing, categoryWeight }),
      );
      for (const entry of composed) {
        expect(entry.kindContribution).toBeLessThanOrEqual(KIND_ONLY_SHARE);
        expect(entry.evidenceContribution).toBeLessThanOrEqual(ESTABLISHED_SHARE);
        /* The explanation is the ranking: no third, unnamed term. */
        expect(entry.score).toBeCloseTo(entry.kindContribution + entry.evidenceContribution, 10);
      }
      const evidenceTerms = new Set(composed.map((entry) => entry.evidenceContribution));
      expect(
        evidenceTerms.size,
        'the evidence contribution changed with the kind, which is a multiplicative ceiling',
      ).toBe(1);
    }
  });

  it('leaves the whole scale reachable, which a ceiling never does', () => {
    /*
     * Under the shape this replaced the maximum was `w(1 + 1.5(1 − w))`, so a
     * kind weighted 0.3 could not pass 0.62 with every channel in the model
     * agreeing — while a record filed under a 0.85 word reached 0.61 on a single
     * knowledge-base row. Those two numbers crossing is the defect; the test is
     * that the modest kind now clears the heavy one's floor by a margin.
     */
    expect(
      experienceSignificanceOf({
        standing: {
          evidenceRichness: 0,
          sourceConfidence: 0,
          globalProminence: 1,
          channels: ['knowledge_base_entry'],
        },
        categoryWeight: 1,
      }),
    ).toBe(1);

    const everyChannel = assessPlaceStanding(
      Object.assign({}, ...Object.values(CHANNEL_EVIDENCE)) as StandingEvidence,
    );
    expect(
      experienceSignificanceOf({ standing: everyChannel, categoryWeight: 0.3 }),
    ).toBeGreaterThan(experienceSignificanceOf({ standing: oneStatement, categoryWeight: 0.85 }));
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

  it('still lets the kind materially order records whose evidence ties', () => {
    /**
     * THE MIRROR OF THE RELEASE BLOCKER, AND THE EASIER WAY TO "FIX" IT.
     *
     * A category weight that no longer capped anything because it no longer did
     * anything would satisfy every assertion above. It would also be wrong, and
     * wrong in the way this file already has scars from: evidence ties
     * constantly on real packs, because the two channels an open catalogue
     * populates at scale are the same two for every record in a country. On the
     * live Osaka pack every record with any evidence at all had *exactly* 0.7 of
     * it, so on a real board the kind is the only thing left to order with.
     *
     * Material means a step you could see: a museum against a walk, with the
     * same statements behind each, has to separate by a real fraction of the
     * kind budget rather than by a rounding artefact.
     */
    for (const standing of [nothing, oneStatement, severalStatements]) {
      const walk = experienceSignificanceOf({ standing, categoryWeight: 0.35 });
      const museum = experienceSignificanceOf({ standing, categoryWeight: WEIGHTY });
      expect(museum - walk).toBeCloseTo((WEIGHTY - 0.35) * KIND_ONLY_SHARE, 2);
      expect(museum - walk).toBeGreaterThan(0.1);
    }
  });

  it('will not let a low-value kind win on its tagging alone', () => {
    /**
     * §16B's sixth guard: a map feature must not reach a board because of the
     * word it is filed under. Two halves, and both have shipped as defects.
     *
     * The kinds below are the taxonomy's own bottom end — a patch of woodland,
     * an unrecognised geographic feature, a pylon — and none of them may reach
     * even the score of a *thoroughly unevidenced* ordinary attraction on the
     * strength of its category. Evidence is the only route up for them, and for
     * the kind weighted zero there is no route at all.
     */
    const ordinaryUnevidenced = experienceSignificanceOf({
      standing: nothing,
      categoryWeight: WEIGHTY,
    });
    for (const categoryWeight of [0, 0.15, 0.2, 0.3]) {
      expect(experienceSignificanceOf({ standing: nothing, categoryWeight })).toBeLessThan(
        ordinaryUnevidenced,
      );
    }

    /*
     * And below the credibility floor the evidence contribution is discounted
     * rather than paid in full, so a well-catalogued fragment cannot buy its way
     * to what a credible kind gets for the same statements.
     */
    const fragment = composeExperienceSignificance({
      standing: severalStatements,
      categoryWeight: 0.15,
    });
    const credible = composeExperienceSignificance({
      standing: severalStatements,
      categoryWeight: EXPERIENCE_CREDIBILITY_FLOOR,
    });
    expect(fragment.evidenceAdmission).toBeLessThan(1);
    expect(credible.evidenceAdmission).toBe(1);
    expect(fragment.evidenceContribution).toBeLessThan(credible.evidenceContribution);
  });

  /**
   * ZERO IS THE MODEL DECLINING, NOT THE MODEL RANKING LAST — AND IT HAS TO BE
   * TRUE BY CONSTRUCTION, BECAUSE A CONSUMER ACTS ON IT.
   *
   * A stored Tokyo pack retained 1,840 place records across nine partition
   * cells, and exactly 20 of every cell's 205 seats — 175 rows, 9.5 % — went to
   * records scoring 0.000: a chiropractor, an insurance agency, a package
   * locker, an ATM. Those roles can never become candidates, so each seat is one
   * no traveller will ever see, and they were held in the same nine cells where
   * canonical attractions were outranked.
   *
   * The retention pass ranks on this function, so "score is zero" is the only
   * signal it has for "this is not a place to go". That was true by luck: it held
   * because no kind in the taxonomy happened to be weighted low enough for its
   * contribution to round away. Asserted here so that tuning a weight to 0.01
   * cannot silently reclassify a rated kind as an unrated one.
   */
  it('scores exactly zero when, and only when, the kind is not a travel experience', () => {
    for (const standing of [nothing, oneStatement, severalStatements]) {
      expect(experienceSignificanceOf({ standing, categoryWeight: 0 })).toBe(0);
      expect(ratesAsExperience(experienceSignificanceOf({ standing, categoryWeight: 0 }))).toBe(
        false,
      );
    }

    /* Every positive weight the table could hold, including ones it does not yet. */
    for (const categoryWeight of [0.005, 0.01, 0.03, 0.1, 0.15, 0.2, 0.3, WEIGHTY, 1]) {
      const score = experienceSignificanceOf({ standing: nothing, categoryWeight });
      expect(score, `weight ${categoryWeight} rounded away to "not a place"`).toBeGreaterThan(0);
      expect(ratesAsExperience(score)).toBe(true);
    }
  });
});

describe('hiddenness is a gap between two channels, not the inverse of one', () => {
  const designatedAndUnknown = assessPlaceStanding({
    classifyingValues: ['boundary=protected_area'],
    mappedExtentMetres: 2_400,
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
    expect(standingFields(rich).popularityScore).toBe(WITHHELD_PROMINENCE_READ);
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
      /* Genuinely famous now takes a magnitude too — see the gate above. */
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 2_600,
      groundWitnessCount: 5,
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
    popularityScore: WITHHELD_PROMINENCE_READ,
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

describe('the witness opens the gate and does not buy the seat', () => {
  /**
   * The §4 regression this pins, measured on a stored dense-metro compile: six
   * river crossings and a rail overpass, each carrying one encyclopaedic
   * article and nothing else, composed 0.66–0.71 as viewpoints and held
   * final-board seats over the destination's palace and both headline
   * sanctuaries. For a kind that is only a candidate because a witness vouched
   * (`witnessRequired`), the same statement was opening the gate *and* paying
   * the full established share of the rank. Every fixture below is a class of
   * evidence, never a place.
   */
  const articleOnly = assessPlaceStanding({
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
  });

  it('bounds encyclopaedic-only credit for a witness-demanding kind at what the kind is worth', () => {
    const crossing = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.35,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(crossing.evidenceContribution).toBeLessThanOrEqual(crossing.kindContribution);
    expect(crossing.score).toBeLessThanOrEqual(crossing.kindContribution * 2);
  });

  it('keeps an article-only crossing below an unevidenced heavier kind with local standing', () => {
    /* The palace shape: a strong named-building prior, nothing but the
     * region's own naming behind it — the exact record the crossings outranked. */
    const namedBuilding = composeExperienceSignificance({
      standing: assessPlaceStanding({ namedInRegionRecords: true }),
      categoryWeight: 0.75,
      witnessRequired: false,
    });
    const crossing = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.35,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(namedBuilding.score).toBeGreaterThan(crossing.score);
  });

  it('lifts the bound entirely for a gated structure somebody operates for visitors', () => {
    const tower = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.45,
      witnessRequired: true,
      expectsVisitors: true,
    });
    const open = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.45,
      witnessRequired: false,
    });
    expect(tower.score).toBe(open.score);
    const boundedCrossing = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.45,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(tower.score).toBeGreaterThan(boundedCrossing.score);
  });

  it('lifts the bound for a designation conferred on drawn ground, and for an authority page about it', () => {
    const designated = composeExperienceSignificance({
      standing: assessPlaceStanding({
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        classifyingValues: ['nature_reserve'],
        /* Standing scale: only a boundary of that order certifies the visit. */
        mappedExtentMetres: DESIGNATED_AREA_STANDING_METRES,
      }),
      categoryWeight: 0.35,
      witnessRequired: true,
      expectsVisitors: false,
    });
    /* The designation raised the established union, so full admission must
     * score strictly above the bounded article-only shape. */
    const bounded = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.35,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(designated.evidenceContribution).toBeGreaterThan(designated.kindContribution);
    expect(designated.score).toBeGreaterThan(bounded.score);

    const namedByAuthority = composeExperienceSignificance({
      standing: assessPlaceStanding({
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        subjectName: 'Longspan Harbour Crossing',
        publishedSites: ['https://transport.example.gov/bridges/longspan_harbour_crossing.html'],
      }),
      categoryWeight: 0.35,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(namedByAuthority.evidenceContribution).toBeGreaterThan(
      namedByAuthority.kindContribution,
    );
  });

  it('never touches kinds that did not need a witness', () => {
    const withFlag = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.75,
      witnessRequired: false,
      expectsVisitors: false,
    });
    const withoutFlag = composeExperienceSignificance({
      standing: articleOnly,
      categoryWeight: 0.75,
    });
    expect(withFlag).toEqual(withoutFlag);
  });

  it('reads visit expectation from operational attributes and never from the encyclopaedic ones', () => {
    expect(attributesExpectVisitors(['opening_hours'])).toBe(true);
    expect(attributesExpectVisitors(['fee'])).toBe(true);
    /* The gate's own key must not unlock the bound. */
    expect(attributesExpectVisitors(['wikidata', 'wikipedia'])).toBe(false);
    /* A URL is a web page, and an operator runs a structure; neither is a visit. */
    expect(attributesExpectVisitors(['website', 'operator', 'phone'])).toBe(false);
    expect(attributesExpectVisitors([])).toBe(false);
  });
});
