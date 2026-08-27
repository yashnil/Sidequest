import { describe, expect, it } from 'vitest';
import { ANCHOR_SLOT_MINUTES, autoSelect } from './autoselect';
import {
  MAX_BOARD_GROUP_SHARE,
  MIN_CARDS_TO_SWALLOW_A_BOARD,
  NEUTRAL_SIGNIFICANCE,
  SIGNIFICANCE_STEP,
  boardOrderingOf,
  boardPriorityOf,
  buildDiscoveryBoard,
  compareBoardOrder,
  establishedOrderingLean,
  type DiscoveryBoard,
  type DiscoveryCandidate,
} from './board';
import {
  EASTERN_SIERRA,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  placeById,
} from '../data/index';
import {
  MAX_BOARD_BACKUP_TRAVEL_MINUTES,
  boardWeatherBackups,
} from '../weather/board-backups';
import {
  WEATHER_DATASET_VERSION,
  weatherDatasetSchema,
  type WeatherDataset,
} from '../schemas/weather';
import {
  assessPlaceStanding,
  MAX_UNMAGNIFIED_PROMINENCE,
  standingFields,
  standsAsEstablishedName,
  WIDELY_NOTED_PROMINENCE,
  WITHHELD_PROMINENCE_READ,
  type StandingEvidence,
} from '../quality/significance';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import type { FitBand } from '../scoring/fit';
import { bindingInterestOf, chargeFrequencyCost, interestLevelSpends } from '../scoring/frequency';
import type { ReachFromBase } from '../travel/reach';
import {
  AUGUST_DATES,
  JANUARY_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  interests,
  profile,
} from '../testing/fixtures';
import {
  TRANSIT_CITY_IDENTITY,
  transitCityBoardInput,
  transitCityTraveler,
} from '../testing/transit-city';
import { MODELLED_WALK_KMH } from '../travel/reach';
import type { TravelTimeMatrix } from '@sidequest/geo';

function setup(
  overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  travelerNeeds: TravelerNeed[] = [],
  tripDays = 4,
): { board: DiscoveryBoard; profile: TravelerProfile; tripDays: number } {
  const ctx = context({ travelerNeeds, tripDays });
  const built = profile(overrides, ctx);
  return {
    board: buildDiscoveryBoard({
      ...boardContext(dates),
      profile: built,
      travelerNeeds,
    }),
    profile: built,
    tripDays,
  };
}

function pick(overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS, dates = AUGUST_DATES, needs: TravelerNeed[] = [], tripDays = 4) {
  const { board, profile: built } = setup(overrides, dates, needs, tripDays);
  return { ...autoSelect({ candidates: board.candidates, profile: built, tripDays }), board, profile: built };
}

/**
 * "CLASSICS WORTH YOUR TIME" HAS TO MEAN SOMETHING, OR IT MEANS THE OPPOSITE.
 *
 * The live evidence class: on three delivered boards this heading — captioned
 * "One of the established names here — the kind of stop this area is known for"
 * — held a suburban lake and a small municipal beach, while a world-famous
 * waterfall rendered under "Probably skip". The reason was the prominence union:
 * an entry and an article, which an open catalogue mints for every row of a
 * class it maps, cleared the bar, so the heading was populated by cataloguing
 * convention rather than by standing. Meanwhile a metropolis's principal castle
 * read 0.15 and lost its seat, because its own row carried no identifier.
 *
 * Both halves are asserted here at the surface a traveller actually reads, and
 * so is the third rule the group has always been held to: a heading with nothing
 * true under it does not render.
 */
describe('the classics heading admits only records that earn it', () => {
  /** Every board place given one compiled standing, so only the standing varies. */
  const boardWhereEveryPlaceHas = (evidence: StandingEvidence): DiscoveryBoard => {
    const base = boardContext(AUGUST_DATES);
    return buildDiscoveryBoard({
      ...base,
      places: base.places.map((place) => ({
        ...place,
        ...standingFields(assessPlaceStanding(evidence)),
      })),
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({})),
      travelerNeeds: [],
    });
  };

  const classicsIn = (built: DiscoveryBoard) =>
    built.groups.find((entry) => entry.group === 'must_see_classics');

  const CAPTION = /established names|names people come here for/;

  it('renders no classics heading at all when the notice was minted for a whole class', () => {
    /*
     * The municipal-facility standing, on every card: a knowledge-base entry, an
     * encyclopaedic article, a second catalogue, and nothing anywhere about how
     * big the noticed thing is. Before the magnitude gate this filled the
     * heading; the honest outcome is that the heading does not appear — the same
     * "never render an empty group" rule `buildDiscoveryBoard` applies to every
     * other heading, rather than a group forced to hold something.
     */
    const built = boardWhereEveryPlaceHas({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
      knowledgeBaseNameCount: 4,
      recordedAttributeCount: 6,
    });
    expect(built.candidates.length).toBeGreaterThan(0);
    expect(classicsIn(built)).toBeUndefined();
    for (const candidate of built.candidates) {
      expect(candidate.group).not.toBe('must_see_classics');
      for (const reason of candidate.fit.reasons) expect(reason).not.toMatch(CAPTION);
    }
  });

  it('refuses the heading to a standing only a landlord and a shared name produced', () => {
    /*
     * The public-housing shape: a government domain that lists the record among
     * its holdings, and an administrative area that carries its name. Both are
     * statements the table gives weight and denies a casting vote — one attests
     * the body that runs it, the other cannot say which way the naming ran — so
     * the notice question was never answered and nothing pointed at the place.
     * The read is capped at what notice alone can assert and the heading is
     * refused, which is the eleven New York developments and the block of
     * agency rental stock that reached a live board as historic sites.
     */
    const built = boardWhereEveryPlaceHas({
      subjectName: 'Fernbrook Estate',
      publishedSites: ['https://housing.fernshire.gov/portfolio'],
      namedInRegionRecords: true,
      recordedAttributeCount: 3,
    });
    for (const candidate of built.candidates) {
      expect(candidate.place.prominenceBasis).toBe('unestablished');
      expect(candidate.place.popularityScore).toBeLessThan(WIDELY_NOTED_PROMINENCE);
      expect(candidate.group).not.toBe('must_see_classics');
      for (const reason of candidate.fit.reasons) expect(reason).not.toMatch(CAPTION);
    }
    expect(classicsIn(built)).toBeUndefined();
  });

  it('seats a standing that was withheld and independently established', () => {
    /*
     * The temple's shape, as the dense-metro packs actually hold it: its own
     * row carries one attribute and its own published address, no catalogue
     * ever linked it, and the surrounding ground's guarded records wear its
     * name. Before this the heading turned on "carries an observed
     * `globalProminence`" — true of a ward park, false of this — and rendered
     * **empty on both metro boards** while the destination's principal temple,
     * shrine, palace and castle read 0.35 beneath ward parks at 0.57–0.69.
     *
     * A withheld read is not a low score: the notice question was never put,
     * the ground pointed at the place, and that is a standing the caption may
     * honestly assert.
     */
    const built = boardWhereEveryPlaceHas({
      groundWitnessCount: 4,
      recordedAttributeCount: 1,
    });
    for (const candidate of built.candidates) {
      expect(candidate.place.globalProminence).toBeUndefined();
      expect(candidate.place.prominenceBasis).toBe('withheld');
      expect(candidate.place.popularityScore).toBeGreaterThanOrEqual(WIDELY_NOTED_PROMINENCE);
    }
    const classics = classicsIn(built);
    expect(classics).toBeDefined();
    expect(classics!.candidates.length).toBeGreaterThan(0);
  });

  it('still seats a record that carries both the notice and the magnitude', () => {
    /*
     * The rule is an exclusion, not a bar nothing can clear — and a heading no
     * board can ever populate is the mirror defect of one every board populates
     * wrongly. Notice from three independent statements, and ground somebody
     * surveyed at destination scale under a conferred status.
     */
    const built = boardWhereEveryPlaceHas({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
      classifyingValues: ['leisure=nature_reserve'],
      mappedExtentMetres: 2_600,
      groundWitnessCount: 5,
      recordedAttributeCount: 2,
    });
    const classics = classicsIn(built);
    expect(classics).toBeDefined();
    expect(classics!.candidates.length).toBeGreaterThan(0);
    for (const candidate of classics!.candidates) {
      expect(candidate.place.globalProminence!).toBeGreaterThanOrEqual(WIDELY_NOTED_PROMINENCE);
      expect(candidate.place.significanceBounded).not.toBe(true);
    }
  });

  it('keeps the heading and the caption reading one rule, on every card', () => {
    /*
     * They were two copies of the same condition in two files, and a copy is
     * where two rules drift. Both now ask `standsAsEstablishedName`, so neither
     * surface may make the claim about a record the other would refuse.
     *
     * Stated as "both imply the predicate" rather than "both imply each other",
     * because the heading has one more gate in front of it that the caption
     * does not and should not: an evidence *outcome* — low confidence, or
     * nothing verifiable — overrides the fit-based grouping entirely and files
     * the card under a heading about our knowledge rather than about the place.
     */
    for (const evidence of [
      { inKnowledgeBase: true, encyclopaedicArticle: true, crossDatasetCorroboration: true },
      { classifyingValues: ['leisure=nature_reserve'], mappedExtentMetres: 2_600 },
      {
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        crossDatasetCorroboration: true,
        classifyingValues: ['leisure=nature_reserve'],
        mappedExtentMetres: 2_600,
        groundWitnessCount: 5,
      },
    ] satisfies StandingEvidence[]) {
      for (const candidate of boardWhereEveryPlaceHas(evidence).candidates) {
        const captioned = candidate.fit.reasons.some((reason) => CAPTION.test(reason));
        if (captioned) expect(standsAsEstablishedName(candidate.place)).toBe(true);
        if (candidate.group === 'must_see_classics') {
          expect(standsAsEstablishedName(candidate.place)).toBe(true);
        }
      }
    }
  });
});

/**
 * THE INVERSION, MEASURED THROUGH THE BOARD THE PRODUCT ACTUALLY BUILDS.
 *
 * The previous wave's prominence fix passed its own tests and the delivered
 * board still inverted, because those tests compared two standings in isolation
 * while the shipped surface compares two *cards*. So every assertion below runs
 * `buildDiscoveryBoard` and `autoSelect` over places whose standing fields come
 * from `standingFields(assessPlaceStanding(...))` — which is the exact chain
 * both producers use — and reads the answer off the cards.
 *
 * The live evidence class, from the boards delivered 2026-08-26:
 *
 * | card                                   | popularityScore | globalProminence |
 * | -------------------------------------- | --------------: | ---------------: |
 * | the destination's principal temple      |            0.35 |          absent  |
 * | its principal shrine                    |            0.35 |          absent  |
 * | its palace                              |            0.35 |          absent  |
 * | the second metropolis's castle          |            0.35 |          absent  |
 * | a ward park                             |            0.57 |            0.57  |
 * | a cruise terminal                       |            0.57 |            0.57  |
 * | a suburban zoo                          |            0.60 |            0.60  |
 * | a flood-basin ward park                 |            0.69 |            0.69  |
 *
 * Every row in the lower half is a record whose catalogue entry a mapper
 * happened to link; every row in the upper half is a place the destination is
 * named for, whose row nobody ever linked. And because 0.69 was the highest any
 * dense-metro card reached, "Classics worth your time — the well-known ones"
 * rendered **empty on both metro boards**.
 *
 * Every fixture here is a *class of evidence* under an invented neutral name.
 */
describe('prominence and the classics heading, on a built board', () => {
  /**
   * The canonical landmark as the packs actually hold one: one recorded
   * attribute — its own published address, on nobody's government domain — no
   * identifier, no article, no second catalogue, and the surrounding ground's
   * own guarded records wearing its name.
   */
  const SPARSE_CANON: StandingEvidence = {
    subjectName: 'Harrowgate Keep',
    groundWitnessCount: 4,
    recordedAttributeCount: 1,
  };

  /**
   * The generic municipal facility as the packs actually hold one: a
   * knowledge-base entry, an encyclopaedic article, a second catalogue, four
   * translated names, a full sheet of attributes — and nothing anywhere about
   * how big the noticed thing is.
   */
  const RICH_MUNICIPAL: StandingEvidence = {
    subjectName: 'Fernbrook Ward Sports Field',
    inKnowledgeBase: true,
    encyclopaedicArticle: true,
    crossDatasetCorroboration: true,
    knowledgeBaseNameCount: 4,
    recordedAttributeCount: 6,
  };

  /**
   * The record that took a 240-minute anchor slot: nothing beyond its name and
   * its position is published about it. Notice never observed, no local
   * standing of any kind, and one attribute — so `sourceConfidence` lands at
   * the same 0.41 the live record carried.
   */
  const NAME_AND_POSITION_ONLY: StandingEvidence = {
    subjectName: 'Coldharbour Ridge Cableway',
    recordedAttributeCount: 1,
  };

  /** A board whose named places carry the given standings; the rest are untouched. */
  const boardWith = (
    standings: Record<string, { name: string; evidence: StandingEvidence }>,
  ): DiscoveryBoard => {
    const base = boardContext(AUGUST_DATES);
    return buildDiscoveryBoard({
      ...base,
      places: base.places.map((place) => {
        const stamped = standings[place.id];
        return stamped === undefined
          ? place
          : {
              ...place,
              name: stamped.name,
              ...standingFields(assessPlaceStanding(stamped.evidence)),
            };
      }),
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({})),
      travelerNeeds: [],
    });
  };

  const cardFor = (built: DiscoveryBoard, id: string): DiscoveryCandidate => {
    const found = built.candidates.find((candidate) => candidate.place.id === id);
    expect(found, `${id} is not on the board`).toBeDefined();
    return found!;
  };

  const CAPTION = /established names|names people come here for/;

  it('seats a sparsely described landmark above a metadata-rich municipal facility', () => {
    /*
     * The exact live inversion as one board: canon at 0.35 beneath ward parks
     * at 0.57–0.69. The facility holds strictly more of everything a source
     * writes down — more names, more attributes, every presence channel the
     * model has — and the landmark holds one attribute and a ground that
     * repeats its name. Both cards are on the board the product builds, and the
     * landmark must read higher on the axis the classics seat, the caption, the
     * tourist-trap penalty and the auto-pick mix are all decided on.
     */
    const built = boardWith({
      'earthquake-fault': { name: 'Harrowgate Keep', evidence: SPARSE_CANON },
      'inyo-craters': { name: 'Fernbrook Ward Sports Field', evidence: RICH_MUNICIPAL },
    });
    const canon = cardFor(built, 'earthquake-fault');
    const facility = cardFor(built, 'inyo-craters');

    expect(facility.place.evidenceRichness!).toBeGreaterThan(canon.place.evidenceRichness!);
    expect(canon.place.globalProminence, 'nobody put the notice question').toBeUndefined();
    expect(facility.place.globalProminence).toBeDefined();

    expect(canon.place.popularityScore).toBeGreaterThan(facility.place.popularityScore);
  });

  it('does not floor a withheld read, and lets presence-only rows outrank nothing', () => {
    /*
     * The two halves of "a withheld read is not a low score". It is not the
     * `WITHHELD_PROMINENCE_READ` floor — that constant is only true of a record
     * nothing said anything about — and it sits on a band no presence-only row
     * can reach, which is the whole of the ledger's invariant.
     */
    const built = boardWith({
      'earthquake-fault': { name: 'Harrowgate Keep', evidence: SPARSE_CANON },
      'inyo-craters': { name: 'Fernbrook Ward Sports Field', evidence: RICH_MUNICIPAL },
      'obsidian-dome': {
        name: 'Coldharbour Ridge Cableway',
        evidence: NAME_AND_POSITION_ONLY,
      },
    });
    const canon = cardFor(built, 'earthquake-fault');
    const facility = cardFor(built, 'inyo-craters');
    const silent = cardFor(built, 'obsidian-dome');

    expect(canon.place.prominenceBasis).toBe('withheld');
    expect(canon.place.popularityScore).toBeGreaterThan(WITHHELD_PROMINENCE_READ);
    expect(canon.place.popularityScore).toBeGreaterThan(MAX_UNMAGNIFIED_PROMINENCE);

    /* Presence with no magnitude behind it cannot climb out of its own band. */
    expect(facility.place.prominenceBasis).toBe('observed');
    expect(facility.place.popularityScore).toBeLessThanOrEqual(MAX_UNMAGNIFIED_PROMINENCE);
    expect(facility.place.popularityScore).toBeLessThan(WIDELY_NOTED_PROMINENCE);

    /* And nothing at all is still nothing at all — the floor's only true case. */
    expect(silent.place.prominenceBasis).toBe('unestablished');
    expect(silent.place.popularityScore).toBe(WITHHELD_PROMINENCE_READ);
  });

  it('admits only the earners to the classics heading, and drops it when there are none', () => {
    /*
     * Both failure modes of the heading in one test. On a board holding one
     * landmark and one metadata-rich facility, the group renders and holds
     * exactly the landmark; on a board holding neither, it does not render at
     * all — the same "never render an empty group" rule every other heading
     * follows. Famous is not mandatory.
     */
    const mixed = boardWith({
      'earthquake-fault': { name: 'Harrowgate Keep', evidence: SPARSE_CANON },
      'inyo-craters': { name: 'Fernbrook Ward Sports Field', evidence: RICH_MUNICIPAL },
    });
    const classics = mixed.groups.find((entry) => entry.group === 'must_see_classics');
    expect(classics).toBeDefined();
    expect(classics!.candidates.map((candidate) => candidate.place.id)).toContain(
      'earthquake-fault',
    );
    expect(classics!.candidates.map((candidate) => candidate.place.id)).not.toContain(
      'inyo-craters',
    );
    expect(cardFor(mixed, 'inyo-craters').fit.reasons.some((r) => CAPTION.test(r))).toBe(false);

    /*
     * And the caption never appears over a card the group refused: the heading
     * and the sentence are one rule, asserted over every card on the board.
     */
    for (const candidate of mixed.candidates) {
      const captioned = candidate.fit.reasons.some((reason) => CAPTION.test(reason));
      if (captioned) expect(standsAsEstablishedName(candidate.place)).toBe(true);
    }

    const nobodyEarnsIt = boardWith(
      Object.fromEntries(
        boardContext(AUGUST_DATES).places.map((place) => [
          place.id,
          { name: `Ward Facility ${place.id}`, evidence: RICH_MUNICIPAL },
        ]),
      ),
    );
    expect(nobodyEarnsIt.candidates.length).toBeGreaterThan(0);
    expect(
      nobodyEarnsIt.groups.find((entry) => entry.group === 'must_see_classics'),
    ).toBeUndefined();
    for (const candidate of nobodyEarnsIt.candidates) {
      for (const reason of candidate.fit.reasons) expect(reason).not.toMatch(CAPTION);
    }
  });

  it('refuses an anchor slot to a record with no evidence beyond its name and position', () => {
    /*
     * Finding 9, through the path that produced it: board → auto-pick. The live
     * record — description "Nothing beyond its name and position is published
     * about it", notice never observed, source confidence 0.41,
     * `typicalDurationMinutes` 240 — was pre-selected and became the sole
     * activity of a day holding 42% of the trip's activity time, and the
     * readiness verdict then depended on it.
     *
     * It stays a card, with its own thin copy, and auto-pick does not build a
     * day around it. A record something outside it established still can be
     * picked, so this is an evidence condition and not a wall.
     */
    const built = boardWith({
      /* 240 minutes — the live record's own duration, and an anchor by any read. */
      'sherwin-lakes-trail': {
        name: 'Coldharbour Ridge Cableway',
        evidence: NAME_AND_POSITION_ONLY,
      },
      /* The same length, and something outside it established it. */
      'mcgee-creek-canyon': { name: 'Harrowgate Keep', evidence: SPARSE_CANON },
      /* 60 minutes and equally unevidenced: not an anchor, so not this rule's business. */
      'obsidian-dome': { name: 'Coldharbour Wayside', evidence: NAME_AND_POSITION_ONLY },
    });
    const picked = autoSelect({
      candidates: built.candidates,
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({})),
      tripDays: 4,
    });

    expect(built.candidates.map((c) => c.place.id)).toContain('sherwin-lakes-trail');
    expect(cardFor(built, 'sherwin-lakes-trail').place.typicalDurationMinutes).toBeGreaterThanOrEqual(
      ANCHOR_SLOT_MINUTES,
    );
    expect(picked.selectedIds).not.toContain('sherwin-lakes-trail');
    expect(
      picked.excluded.find((entry) => entry.placeId === 'sherwin-lakes-trail')?.reason,
    ).toBe('standing_unestablished');

    /* An equally long stop something established is refused for no such reason. */
    expect(
      picked.excluded.find((entry) => entry.placeId === 'mcgee-creek-canyon')?.reason,
    ).not.toBe('standing_unestablished');

    /*
     * And the refusal is as narrow as the claim: a stop that cannot hold a
     * morning is not the thing a day is built around, so the same missing
     * evidence does not keep it out of the pre-selection.
     */
    expect(cardFor(built, 'obsidian-dome').place.typicalDurationMinutes).toBeLessThan(
      ANCHOR_SLOT_MINUTES,
    );
    expect(
      picked.excluded.find((entry) => entry.placeId === 'obsidian-dome')?.reason,
    ).not.toBe('standing_unestablished');
  });

  it('still pre-selects a record something outside it established', () => {
    /*
     * The other direction of the same rule, so the evidence condition cannot be
     * satisfied by refusing everything: with the whole board carrying a
     * withheld-but-established standing, auto-pick fills the trip and excludes
     * nothing for want of evidence.
     */
    const built = boardWith(
      Object.fromEntries(
        boardContext(AUGUST_DATES).places.map((place) => [
          place.id,
          { name: `Harrowgate Site ${place.id}`, evidence: SPARSE_CANON },
        ]),
      ),
    );
    const picked = autoSelect({
      candidates: built.candidates,
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({})),
      tripDays: 4,
    });
    expect(picked.selectedIds.length).toBeGreaterThan(0);
    expect(
      picked.excluded.some((entry) => entry.reason === 'standing_unestablished'),
    ).toBe(false);
  });

  it('says out loud when the evidence condition left the trip thinner', () => {
    /*
     * The same debt the walking refusal owes: the rule leaves no mark on a
     * card, so a traveller handed a short pre-selection would otherwise have no
     * account of the gap. Only where the pass ran out of admissible candidates
     * rather than out of slots.
     */
    const built = boardWith(
      Object.fromEntries(
        boardContext(AUGUST_DATES).places.map((place) => [
          place.id,
          { name: `Coldharbour Site ${place.id}`, evidence: NAME_AND_POSITION_ONLY },
        ]),
      ),
    );
    const picked = autoSelect({
      candidates: built.candidates,
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({})),
      tripDays: 4,
    });
    expect(picked.excluded.some((entry) => entry.reason === 'standing_unestablished')).toBe(true);
    expect(picked.selectedIds.length).toBeLessThan(picked.slots);
    expect(picked.notes.some((note) => /name and position/.test(note))).toBe(true);
  });
});

describe('discovery board grouping', () => {
  it('splits candidates into groups a traveller can actually navigate', () => {
    const { board } = setup();
    const groupIds = board.groups.map((entry) => entry.group);
    expect(groupIds).toContain('must_see_classics');
    expect(groupIds).toContain('hidden_gems');
    expect(groupIds).toContain('nearby_side_quests');
    expect(groupIds).toContain('weak_fit');
  });

  /**
   * THE TWO GROUPS WHOSE HEADINGS TALK ABOUT DISTANCE ARE DECIDED BY DISTANCE.
   *
   * They were not, and this fixture is where the defect is easiest to see. Under
   * the old rule `scenic_detours` was assigned on category alone, so this very
   * board filed Minaret Vista — fifteen minutes from the bed, comfortably inside
   * this traveller's own radius — under a heading reading "Worth the detour ·
   * Further out, and the going is part of it", while `nearby_side_quests`, whose
   * heading in both vocabularies says "short hops from your base", was the
   * catch-all for whatever matched nothing else and duly collected long drives.
   *
   * A heading that asserts a fact its contents contradict is worse than no
   * heading, because a traveller plans around it. So: nothing inside the
   * traveller's radius may be filed as further out, and nothing beyond it may be
   * filed as a short hop.
   */
  it('never files a short hop as a detour, or a long haul as a short hop', () => {
    const { board } = setup();
    const near = new Set(['base', 'in_tolerance', 'unknown']);
    for (const candidate of board.candidates) {
      if (candidate.group === 'scenic_detours') {
        expect(
          near.has(candidate.detourClass),
          `${candidate.place.name} is ${candidate.travelMinutesFromBase} min out and filed under "further out"`,
        ).toBe(false);
      }
      if (candidate.group === 'nearby_side_quests') {
        expect(
          candidate.detourClass,
          `${candidate.place.name} is ${candidate.travelMinutesFromBase} min out and filed as a short hop`,
        ).not.toBe('too_far');
        expect(candidate.detourClass).not.toBe('stretch');
      }
    }
  });

  it('puts each candidate in exactly one group', () => {
    const { board } = setup();
    const grouped = board.groups.flatMap((entry) => entry.candidates.map((c) => c.place.id));
    expect(grouped.length).toBe(board.candidates.length);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('files a genuine hidden gem under hidden gems, not classics', () => {
    const { board } = setup();
    const obsidian = board.candidates.find((c) => c.place.id === 'obsidian-dome');
    expect(obsidian?.group).toBe('hidden_gems');
    expect(placeById('obsidian-dome')?.hiddenGemScore).toBeGreaterThan(0.6);
  });

  it('puts unworkable places in the skip group with an explanation', () => {
    const { board } = setup(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const skip = board.groups.find((entry) => entry.group === 'weak_fit');
    expect(skip).toBeDefined();
    const postpile = skip?.candidates.find((c) => c.place.id === 'devils-postpile');
    expect(postpile).toBeDefined();
    expect(postpile?.fit.blockers[0]?.message.length).toBeGreaterThan(10);
  });

  it('offers bad-weather and low-effort backups', () => {
    const { board } = setup();
    const backups = board.groups.find((entry) => entry.group === 'low_effort_backups');
    expect(backups?.candidates.length).toBeGreaterThan(0);
    for (const candidate of backups?.candidates ?? []) {
      expect(candidate.place.weather.poorWeatherBackup).toBe(true);
    }
  });

  /**
   * A DESTINATION WHERE EVERYTHING IS INDOORS AND EASY GOING — that is, a city.
   *
   * The authored region with two fields flattened across every place, which is
   * the shape a dense metropolis actually has: nothing is strenuous and almost
   * nothing is at the mercy of the weather. Named as a synthetic rather than as
   * "Tokyo", because the property under test is about uniformity and not about
   * one city — but the numbers come from there. On the stored Tokyo artifact
   * (24 cards) the backup branch claimed **13**, so the board's largest heading
   * was "Rainy days and easy days" and a six-day metropolis read as a shelf of
   * things to hold in reserve.
   */
  function uniformlyShelteredBoard(): DiscoveryBoard {
    const ctx = boardContext(AUGUST_DATES);
    return buildDiscoveryBoard({
      ...ctx,
      places: ctx.places.map((place) => ({
        ...place,
        physicalIntensity: 'easy' as const,
        weather: { ...place.weather, poorWeatherBackup: true },
        /*
         * Neither a famous name nor a quiet find, so every card falls past the
         * two headings that describe what a place *is* and reaches the branch
         * under test. Without this the fixture would prove only that gems and
         * classics are grouped first, which they already were.
         */
        hiddenGemScore: 0.2,
        popularityScore: 0.2,
      })),
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 })),
      travelerNeeds: [],
    });
  }

  it('never lets one heading swallow a board that had a truer one to offer', () => {
    const board = uniformlyShelteredBoard();
    const cap = Math.max(
      MIN_CARDS_TO_SWALLOW_A_BOARD,
      Math.floor(board.candidates.length * MAX_BOARD_GROUP_SHARE),
    );
    const backups = board.candidates.filter(
      (candidate) => candidate.group === 'low_effort_backups',
    );

    /*
     * Both halves matter. A guard that emptied the group would pass the ceiling
     * and be a worse board: on a destination with genuine reserves the heading
     * is the most useful one there is, and §10.2 asks for groups that mean
     * something rather than for groups that are small.
     */
    expect(
      backups.length,
      'the fixture no longer reaches the backup branch at all, so this proves nothing',
    ).toBeGreaterThan(0);
    expect(
      backups.length,
      `"Rainy days and easy days" holds ${backups.length} of ${board.candidates.length} cards`,
    ).toBeLessThanOrEqual(cap);

    // Nothing invented on the way out: every card that moved is somewhere its
    // own card already supports, and every card that stayed is really a backup.
    for (const candidate of backups) {
      expect(candidate.place.weather.poorWeatherBackup).toBe(true);
    }
    const moved = board.candidates.filter(
      (candidate) =>
        candidate.place.weather.poorWeatherBackup && candidate.group !== 'low_effort_backups',
    );
    expect(moved.length).toBeGreaterThan(0);
    for (const candidate of moved) {
      expect(
        ['nearby_side_quests', 'scenic_detours', 'weak_fit', 'needs_verification'],
        `${candidate.place.name} was moved to ${candidate.group}`,
      ).toContain(candidate.group);
    }

    // And nothing was lost or duplicated by the settlement.
    const grouped = board.groups.flatMap((entry) => entry.candidates.map((c) => c.place.id));
    expect(grouped.length).toBe(board.candidates.length);
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe('auto-selection', () => {
  it('is deterministic', () => {
    expect(pick().selectedIds).toEqual(pick().selectedIds);
  });

  /**
   * THE SLOT THAT WAS SPENT ON A CARD THE STORE WOULD NOT LET IT TURN ON.
   *
   * `replaceAutoSelections` clears its own rows and inserts
   * `ON CONFLICT DO NOTHING`, so a place the traveller has skipped survives the
   * write untouched — correctly. Auto-pick did not know, so it spent one of its
   * N slots on that place, had the insert quietly refused, and left the product
   * saying "We picked N places" over N − 1. Stated as the arithmetic rather than
   * as a list of ids: refusing something must cost the traveller nothing.
   */
  it('never spends a slot on a place the traveller has already refused', () => {
    const { board, profile: built } = setup();
    const open = autoSelect({ candidates: board.candidates, profile: built, tripDays: 4 });
    const refused = open.selectedIds[0]!;

    const after = autoSelect({
      candidates: board.candidates,
      profile: built,
      tripDays: 4,
      decided: { [refused]: 'excluded' },
    });

    expect(after.selectedIds).not.toContain(refused);
    expect(
      after.selectedIds.length,
      'the refusal cost the traveller a stop it should have replaced',
    ).toBe(open.selectedIds.length);
    // And the note counts what actually changed, which is now the same number.
    expect(after.notes[0]).toContain(`We picked ${after.selectedIds.length} places`);
    // Their answer, not one of ours: this is not a weak fit, it is a decision.
    expect(after.excluded.find((entry) => entry.placeId === refused)?.reason).toBe(
      'already_decided',
    );
  });

  it('counts stops the traveller has already chosen against the trip’s own room', () => {
    /*
     * The other half of the same accounting. A hand-picked place occupies a stop
     * whether or not this pass proposed it, so proposing a full target on top of
     * them would fill the days twice over — and "padding out to fifteen" is an
     * invitation to overfill a trip that is already nine-tenths full.
     */
    const { board, profile: built } = setup();
    const open = autoSelect({ candidates: board.candidates, profile: built, tripDays: 4 });
    const mine = open.selectedIds.slice(0, 3);
    expect(mine).toHaveLength(3);

    const after = autoSelect({
      candidates: board.candidates,
      profile: built,
      tripDays: 4,
      decided: Object.fromEntries(mine.map((id) => [id, 'included' as const])),
    });

    expect(after.targetCount).toBe(open.targetCount);
    expect(after.slots).toBe(open.targetCount - mine.length);
    expect(after.selectedIds.length).toBeLessThanOrEqual(after.slots);
    for (const id of mine) expect(after.selectedIds).not.toContain(id);
  });

  it('says so when the traveller has already filled the trip', () => {
    const { board, profile: built } = setup();
    const open = autoSelect({ candidates: board.candidates, profile: built, tripDays: 4 });
    const everything = Object.fromEntries(
      board.candidates.map((candidate) => [candidate.place.id, 'included' as const]),
    );

    const after = autoSelect({
      candidates: board.candidates,
      profile: built,
      tripDays: 4,
      decided: everything,
    });

    expect(after.slots).toBe(0);
    expect(after.selectedIds).toEqual([]);
    /*
     * The sentence this replaces blamed the destination — "everything on this
     * board is either shut on your dates, past how far you will travel, or a
     * journey nobody could verify" — for a trip the traveller had filled
     * themselves. Every word of it was false in this state.
     */
    expect(after.notes[0]).toContain(`${open.targetCount} stops this trip has room for`);
    expect(after.notes.join(' ')).not.toContain('shut on your dates');
  });

  it('scales the number of picks to trip length and pace', () => {
    const short = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 3);
    const long = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 7);
    expect(long.targetCount).toBeGreaterThan(short.targetCount);

    const slow = pick({ ...MAMMOTH_HIKER_ANSWERS, pace: 'slow' });
    const fast = pick({ ...MAMMOTH_HIKER_ANSWERS, pace: 'fast' });
    expect(fast.targetCount).toBeGreaterThan(slow.targetCount);
  });

  it('never pre-selects something unworkable', () => {
    const { selectedIds, board } = pick(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      expect(candidate?.fit.band).not.toBe('not_workable');
      expect(candidate?.fit.blockers).toHaveLength(0);
    }
  });

  it('honours the frequency ceiling the traveller set', () => {
    // "A few times" hiking on a four-day trip means three, not nine.
    const { selectedIds, board, profile: built } = pick();
    const hikes = selectedIds.filter(
      (id) => board.candidates.find((c) => c.place.id === id)?.fit.primaryInterest === 'hiking',
    );
    expect(hikes.length).toBeLessThanOrEqual(built.derived.frequencyCaps.hiking);
  });

  /**
   * THE BOARD AND THE PLAN HAVE TO BE COUNTING THE SAME THING.
   *
   * `frequencyCaps` is one number read by three modules: auto-pick refuses
   * against it, the planner refuses against it, and the validator afterwards
   * warns when a finished plan exceeded it. The last two count *stops* — an
   * integer, one per place. Auto-pick used to spend fractions: a full unit of a
   * place's primary interest and a half of everything else it happened to
   * satisfy. So four lakeside walks could fill a two-stop lake allowance without
   * a single lake-led stop being picked, and auto-pick would then decline a
   * genuine lake against a ceiling that, counted the way every other reader
   * counts it, was empty. The traveller sees the refusal in the notes and can
   * find nothing on their board that explains it.
   *
   * Stated as the property rather than as a count of picks: every refusal on
   * frequency must be a refusal against an allowance this selection has really
   * filled, in whole stops.
   */
  it('refuses on frequency only against a ceiling its own picks have filled', () => {
    const { board, selectedIds, excluded, profile: built } = pick();
    /*
     * Spend is counted through the shared ledger — `scoring/frequency.ts`, the
     * one definition auto-pick, packer and validator all read — so a refusal
     * is justified exactly when some ceiling the refused place draws on is
     * genuinely full of the board's own picks. Counting a private
     * one-interest-per-stop tally here is how this guard once drifted from
     * what the picker actually charges.
     */
    const placeOf = (id: string) =>
      board.candidates.find((entry) => entry.place.id === id)!.place;
    const spent = new Map<string, number>();
    for (const id of selectedIds) chargeFrequencyCost(placeOf(id), built, spent);

    const refusals = excluded.filter((entry) => entry.reason === 'frequency');
    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      expect(
        bindingInterestOf(placeOf(refusal.placeId), built, spent),
        `${refusal.placeId} was refused on frequency, but no ceiling it draws on is full`,
      ).not.toBeNull();
    }
  });

  it('never pre-selects more stops serving an asked-for interest than its ceiling allows', () => {
    /**
     * §29 G's accounting, applied to the pre-selection: a stop that serves an
     * interest serves it whether or not a ledger files the stop under it, so
     * the count of selected stops *matching* each asked-for interest — not the
     * count charged to it as a primary — is what the traveller's ceiling
     * bounds. One-interest-per-stop ledgers let a fifth stop matching a
     * four-cap interest through whenever its spend was filed under a different
     * primary, and which stop that was depended on nothing but candidate
     * order. The shared ledger makes the bound structural, and this asserts
     * it where the §29 G evaluation measures it.
     */
    const { board, selectedIds, profile: built } = pick();
    const matched = new Map<string, number>();
    for (const id of selectedIds) {
      const candidate = board.candidates.find((entry) => entry.place.id === id)!;
      for (const interest of candidate.place.interests) {
        if (!interestLevelSpends(built.interests[interest])) continue;
        matched.set(interest, (matched.get(interest) ?? 0) + 1);
      }
    }
    expect(matched.size).toBeGreaterThan(0);
    for (const [interest, count] of matched) {
      const cap = built.derived.frequencyCaps[interest as keyof typeof built.derived.frequencyCaps];
      if (typeof cap !== 'number') continue;
      expect(
        count,
        `${interest} is served by ${count} pre-selected stops against a ceiling of ${cap}`,
      ).toBeLessThanOrEqual(cap);
    }
  });

  it('never pre-selects an interest the traveller asked to avoid', () => {
    const { selectedIds, board } = pick({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({ ...MAMMOTH_HIKER_ANSWERS.interests, hot_springs: 'avoid' }),
    });
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      expect(candidate?.fit.primaryInterest).not.toBe('hot_springs');
    }
  });

  it('keeps total driving inside a sane share of the travel budget', () => {
    const { stats, profile: built } = pick();
    expect(stats.totalDriveMinutesOneWay).toBeLessThanOrEqual(
      4 * built.transport.maxDailyDriveMinutes * 0.5,
    );
  });

  it('holds roughly the famous/hidden balance the traveller asked for', () => {
    const balanced = pick();
    expect(Math.abs(balanced.stats.hiddenGemShare - 0.45)).toBeLessThanOrEqual(0.3);
    // Leaning hidden must never produce a more mainstream selection.
    const deepCuts = pick({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' });
    expect(deepCuts.stats.hiddenGemShare).toBeGreaterThanOrEqual(balanced.stats.hiddenGemShare);
  });

  it('shifts composition toward gems once frequency ceilings stop being the binding constraint', () => {
    // On a short trip the traveller's own "a few times" ceilings bind harder than
    // a stylistic preference, so the mix can only reorder the board. Give the trip
    // room and the mix has to change what is actually picked.
    const balanced = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 7);
    const deepCuts = pick(
      { ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' },
      AUGUST_DATES,
      [],
      7,
    );
    expect(deepCuts.stats.hiddenGemShare).toBeGreaterThan(balanced.stats.hiddenGemShare);
    expect(deepCuts.selectedIds).not.toEqual(balanced.selectedIds);
  });

  it('keeps category variety rather than repeating one kind of stop', () => {
    const { stats, selectedIds } = pick();
    const counts = Object.values(stats.byCategory);
    expect(Object.keys(stats.byCategory).length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(selectedIds.length / 2));
  });

  it('explains what it held back and why', () => {
    const { notes } = pick();
    expect(notes.join(' ')).toMatch(/frequency you asked for|pre-selected/);
  });

  it('respects a mobility need by only picking low-effort stops', () => {
    const { selectedIds, board } = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, ['mobility_limited']);
    expect(selectedIds.length).toBeGreaterThan(0);
    for (const id of selectedIds) {
      const intensity = board.candidates.find((c) => c.place.id === id)?.place.physicalIntensity;
      expect(['none', 'easy']).toContain(intensity);
    }
  });

  it('collapses to town stops for a traveller without a car', () => {
    const { selectedIds, board } = pick({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false });
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      // Nothing auto-picked may need a vehicle the traveller does not have.
      expect(candidate?.access.requiredModes).not.toContain('drive');
      expect(candidate?.access.status).not.toBe('blocked');
    }
  });

  it('produces a different selection for a different traveller', () => {
    const hiker = pick().selectedIds;
    const historian = pick({
      interests: interests({
        history_and_culture: 'core',
        food_and_towns: 'frequent',
        easy_nature_walks: 'occasional',
        hiking: 'avoid',
      }),
      maxDailyTravelMinutes: 240,
      regionalExpansion: 'nearby_120',
      detourToleranceMinutes: 120,
    }).selectedIds;
    expect(hiker).not.toEqual(historian);
    expect(historian).toContain('manzanar-historic-site');
  });
});

/**
 * §16B — SIGNIFICANCE REACHES THE TRAVELLER, AND STAYS IN ITS LANE.
 *
 * The handoff these close: "discovery/board.ts sorts by fit.score alone, so
 * experienceSignificance never orders the traveller-facing list". Measured on
 * the stored Tokyo artifact before the repair — eight cards the fit scorer had
 * itself capped at "Good fit" for having established nothing sat at ranks 8–15,
 * above every card the same scorer called "Strong fit"; the two most significant
 * places on the board sat 16th and 24th of 24.
 *
 * Four properties, and the second is the guard on the first. Making a landmark
 * win is easy; making it win *only where it should* is the whole job.
 */
describe('§16B — the board orders by significance as well as by fit', () => {
  /** The authored region with chosen places given a chosen significance. */
  const boardWith = (
    significance: Record<string, number>,
    overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  ): DiscoveryBoard => {
    const base = boardContext(AUGUST_DATES);
    return buildDiscoveryBoard({
      ...base,
      places: base.places.map((place) =>
        place.id in significance
          ? { ...place, experienceSignificance: significance[place.id]! }
          : place,
      ),
      profile: profile(overrides, context({ travelerNeeds: [] })),
      travelerNeeds: [],
    });
  };

  const rankOf = (board: DiscoveryBoard, placeId: string) =>
    board.candidates.findIndex((candidate) => candidate.place.id === placeId);
  const cardOf = (board: DiscoveryBoard, placeId: string) =>
    board.candidates.find((candidate) => candidate.place.id === placeId)!;

  it('leans the same standing the other way for a traveller who asked for the finds', () => {
    /**
     * §29 B, at the ordering term itself. The within-band significance lift
     * used to be worth the same established-first bonus to every traveller —
     * including the one who had just answered "mostly hidden gems" — so a
     * hidden-leaning preference could drop a famous card's *score* while the
     * preference-blind lift held its *rank* at the head of the band. The
     * lift's direction now follows the traveller's own discovery answer
     * through `establishedOrderingLean`: at or below the scale's midpoint the
     * order is untouched; above it, the same magnitude leans the other way.
     */
    const established = { 'convict-lake': 0.9 };
    const balanced = boardWith(established);
    const hiddenLeaning = boardWith(established, {
      ...MAMMOTH_HIKER_ANSWERS,
      discoveryMix: 'mostly_hidden',
    });

    expect(cardOf(balanced, 'convict-lake').ordering.significanceLift).toBeGreaterThan(0);
    expect(cardOf(hiddenLeaning, 'convict-lake').ordering.significanceLift).toBeLessThan(0);
    /* Same magnitude, opposite direction: a preference reorders, it does not erase. */
    expect(Math.abs(cardOf(hiddenLeaning, 'convict-lake').ordering.significanceLift)).toBe(
      Math.abs(cardOf(balanced, 'convict-lake').ordering.significanceLift),
    );

    const target = (mix: QuestionnaireAnswers['discoveryMix']) =>
      profile({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: mix }, context({ travelerNeeds: [] }));
    expect(establishedOrderingLean(target('mostly_classics'))).toBe(1);
    expect(establishedOrderingLean(target('balanced'))).toBe(1);
    expect(establishedOrderingLean(target('mostly_hidden'))).toBe(-1);
    expect(establishedOrderingLean(target('deep_cuts'))).toBe(-1);
  });

  it('separates two candidates the fit scorer cannot separate', () => {
    /*
     * I3's handoff, stated as the smallest case that can hold it: one place,
     * one field varied, everything personal held identical. If the ordering
     * still read `fit.score` alone the two ranks would be the same number.
     */
    const matters = boardWith({ 'convict-lake': 0.9 });
    const does_not = boardWith({ 'convict-lake': 0.1 });

    expect(rankOf(matters, 'convict-lake')).toBeLessThan(rankOf(does_not, 'convict-lake'));
    /*
     * And it did it *beside* the fit rather than through it. §9 asks for
     * dimensions that stay distinct, and `significance-is-not-fit` in
     * `fit.test.ts` guards the same boundary from the other side.
     */
    expect(cardOf(matters, 'convict-lake').fit.score).toBe(
      cardOf(does_not, 'convict-lake').fit.score,
    );
    expect(cardOf(matters, 'convict-lake').fit.band).toBe(
      cardOf(does_not, 'convict-lake').fit.band,
    );
  });

  it('never lifts a card above one the scorer rates higher', () => {
    /**
     * THE FAILURE MODE THIS CHANGE CREATES, AND THE RULE THAT REFUSES IT.
     *
     * A board that flooded with famous places the moment recall improved would
     * be a worse product than the one that ignored significance: §7 asks for a
     * mixture, and a traveller who said they will not drive an hour does not
     * want the region's best-known sight an hour away. So the band — the verdict
     * the traveller is actually shown — is the outer key, and no amount of
     * standing crosses it.
     *
     * Stated over the whole board rather than on one pair, because the property
     * is a rule and not a cell: the worst-fitting workable card is given total
     * canonical significance and every other card almost none, and the list must
     * still descend by band.
     */
    const plain = boardWith({});
    const workable = plain.candidates.filter((c) => c.fit.band !== 'not_workable');
    const weakest = workable[workable.length - 1]!.place.id;
    const strongest = workable[0]!.place.id;
    expect(
      cardOf(plain, strongest).ordering.bandRank,
      'the fixture no longer offers two candidates in different bands, so this proves nothing',
    ).toBeGreaterThan(cardOf(plain, weakest).ordering.bandRank);

    const famousButWrong = boardWith(
      Object.fromEntries(
        plain.candidates.map((candidate) => [
          candidate.place.id,
          candidate.place.id === weakest ? 1 : 0.05,
        ]),
      ),
    );

    for (let index = 1; index < famousButWrong.candidates.length; index += 1) {
      const above = famousButWrong.candidates[index - 1]!;
      const below = famousButWrong.candidates[index]!;
      expect(
        above.ordering.bandRank,
        `${below.place.name} (${below.fit.band}) is ranked above ${above.place.name} (${above.fit.band})`,
      ).toBeGreaterThanOrEqual(below.ordering.bandRank);
    }
    expect(rankOf(famousButWrong, weakest)).toBeGreaterThan(rankOf(famousButWrong, strongest));
  });

  /**
   * THE SCALAR THE PLANNER SORTS ON, AND THE BOUND NOTHING TESTED.
   *
   * `compareBoardOrder` is the board's authority and it is safe by construction:
   * band leads, so nothing below can reach across it. The planner cannot take a
   * comparator — its queue carries a scalar `priority`, sorted and re-sorted in
   * five places and offset by selection bands a thousand apart — so
   * `boardPriorityOf` folds band and within-band into one number, and it is
   * *that* fold which has to preserve the guarantee.
   *
   * It preserves it by normalising `withinBand` against its own full width
   * before adding it to the band rank. Delete the normalisation and every
   * downstream reader still compiles, every existing assertion still passes, and
   * the trip quietly stops agreeing with the board it was built from — the exact
   * disagreement §16B closed, reintroduced as arithmetic. The test above proves
   * the comparator's band order; nothing proved the scalar's, so the two could
   * come apart without a word.
   *
   * The pair below is the extremal one on purpose, because that is where an
   * unbounded term escapes: the best a lower band can ever look against the
   * worst a higher band can ever look. Every term is pushed to the end of its
   * range through `boardOrderingOf` rather than by writing the numbers down, so
   * a fourth ordering term added later widens this case automatically instead of
   * leaving it pinned to the two terms that existed when it was written.
   */
  it('folds band and standing into one number without letting standing cross the band', () => {
    /** A journey nobody established — the other charge on the within-band key. */
    const UNMEASURED_REACH: ReachFromBase = {
      baseId: 'base-mammoth-lakes',
      candidateId: 'anywhere',
      status: 'unmeasured',
      reachable: null,
      conflict: false,
      reason: 'no_route_found',
      detail: 'nobody measured this journey',
    };
    const board = boardWith({});
    const anyCard = board.candidates[0]!;
    const worst = board.candidates[board.candidates.length - 1]!;

    /** A card with every within-band term pushed as far as it will go. */
    const extreme = (
      band: FitBand,
      direction: 'best' | 'worst',
      score = direction === 'best' ? 100 : 0,
    ): DiscoveryCandidate['ordering'] =>
      boardOrderingOf({
        place: {
          ...anyCard.place,
          /*
           * The quantiser reads this, so the value is stated in its own steps:
           * a full step above neutral is the largest lean the board can spend,
           * and a full step below is the largest it can charge.
           */
          experienceSignificance:
            direction === 'best'
              ? NEUTRAL_SIGNIFICANCE +
                Math.ceil(NEUTRAL_SIGNIFICANCE / SIGNIFICANCE_STEP) * SIGNIFICANCE_STEP
              : 0,
        },
        fit: { ...anyCard.fit, band, score },
        /* An unestablished journey is the only other charge on the key. */
        ...(direction === 'best' ? {} : { reach: UNMEASURED_REACH, detourClass: 'in_tolerance' }),
      });

    const bands: FitBand[] = ['top_pick', 'strong', 'good', 'optional', 'weak', 'not_workable'];
    for (let index = 1; index < bands.length; index += 1) {
      const higher = extreme(bands[index - 1]!, 'worst');
      const ceiling = extreme(bands[index]!, 'best');
      /* The fixture has to actually separate the two, or this proves nothing. */
      expect(higher.bandRank).toBeGreaterThan(ceiling.bandRank);
      expect(ceiling.withinBand).toBeGreaterThan(higher.withinBand);
      /*
       * At the exact ceiling the two may *meet* — `within` is bounded to one
       * band's width and the bands are one apart, so a perfect card at the top
       * of the lower band reaches the floor of the one above and stops there.
       * What it may never do is come out ahead.
       */
      expect(
        boardPriorityOf(higher),
        `the best possible ${bands[index]} outranks the worst possible ${bands[index - 1]!} ` +
          'on the scalar the planner sorts by, so the trip would come out in a different ' +
          'order from the board it was built from',
      ).toBeGreaterThanOrEqual(boardPriorityOf(ceiling));
      /*
       * And one point off that ceiling the separation has to be strict, or the
       * assertion above would be satisfied by a clamp that flattens the whole
       * band rather than by a bound that respects it.
       */
      const nearCeiling = extreme(bands[index]!, 'best', 99);
      expect(nearCeiling.withinBand).toBeLessThan(ceiling.withinBand);
      expect(
        boardPriorityOf(higher),
        `a ${bands[index]} card one point off perfect outranks the worst possible ` +
          `${bands[index - 1]!}, so the within-band key is escaping its own band`,
      ).toBeGreaterThan(boardPriorityOf(nearCeiling));
    }

    /*
     * And the scalar agrees with the comparator over the real board, in both
     * directions: same order, and no two cards the comparator separates are
     * folded onto the same number.
     */
    const byComparator = [...board.candidates].sort(compareBoardOrder);
    const byScalar = [...board.candidates].sort(
      (a, b) =>
        boardPriorityOf(b.ordering) - boardPriorityOf(a.ordering) ||
        a.place.id.localeCompare(b.place.id),
    );
    expect(byScalar.map((candidate) => candidate.place.id)).toEqual(
      byComparator.map((candidate) => candidate.place.id),
    );
    /*
     * And the board it was checked against really does span more than one band,
     * or the agreement above is a statement about a single band's contents.
     */
    expect(
      worst.ordering.bandRank,
      'every card on this board is in the same band, so the agreement above proves nothing ' +
        'about whether the fold respects band boundaries',
    ).toBeLessThan(board.candidates[0]!.ordering.bandRank);
  });

  it('leaves a board that records no significance exactly where it was', () => {
    /*
     * Absent is not zero. Every authored region carries no `experienceSignificance`
     * at all, and reading that absence as "none of this matters" would reorder the
     * most-travelled board in the product on the strength of a field nobody filled
     * in. The lift has to be exactly nought, not merely small.
     */
    const board = boardWith({});
    for (const candidate of board.candidates) {
      expect(candidate.place.experienceSignificance).toBeUndefined();
      expect(candidate.ordering.significance).toBeNull();
      expect(candidate.ordering.significanceLift).toBe(0);
    }

    const expected = [...board.candidates]
      .sort(
        (a, b) =>
          b.ordering.bandRank - a.ordering.bandRank ||
          b.fit.score - a.fit.score ||
          a.place.id.localeCompare(b.place.id),
      )
      .map((candidate) => candidate.place.id);
    expect(board.candidates.map((candidate) => candidate.place.id)).toEqual(expected);
  });

  it('does not reorder on a difference smaller than the evidence supports', () => {
    /*
     * Live packs land on figures a hundredth apart — 0.59 against 0.60 — that
     * say nothing about which place somebody would rather see. Ordering on that
     * is §8.3's metadata heuristic with a decimal point, and it demoted the §29
     * dense-city world's most established place two positions past a feature
     * 0.01 above it. Below one step the two are the same claim.
     */
    /*
     * The pair has to be adjacent and a point apart in fit, or the assertion is
     * satisfied by the gap between them rather than by the rule: these two sit
     * next to each other in the same band at 85 and 84, so four hundredths of
     * significance is exactly enough to swap them if the ordering will spend it.
     */
    const flat = boardWith({ 'earthquake-fault': 0.6, 'hot-creek-geologic-site': 0.6 });
    expect(rankOf(flat, 'earthquake-fault') + 1).toBe(rankOf(flat, 'hot-creek-geologic-site'));

    const hair = boardWith({ 'earthquake-fault': 0.6, 'hot-creek-geologic-site': 0.64 });
    expect(hair.candidates.map((candidate) => candidate.place.id)).toEqual(
      flat.candidates.map((candidate) => candidate.place.id),
    );

    // And a real step still moves it, or the assertion above passes vacuously.
    const step = boardWith({ 'earthquake-fault': 0.6, 'hot-creek-geologic-site': 0.8 });
    expect(rankOf(step, 'hot-creek-geologic-site')).toBeLessThan(
      rankOf(step, 'earthquake-fault'),
    );
  });

  it('never pre-selects a famous place that does not suit this traveller', () => {
    /**
     * The same guard where it costs the traveller a day rather than a scroll.
     *
     * Bodie is the fixture's most famous name and it is out of reach on this
     * trip — further in a day than the traveller said they would travel. The
     * live equivalent is on the stored Osaka board: Universal Studios Japan,
     * the region's best-known place and the second-highest significance on the
     * board, ninety-nine minutes away and rated `optional`, sits 22nd of 24
     * after this change exactly as it did before it.
     *
     * The refusal happens before significance is consulted at all — a blocked
     * candidate is not eligible, however established — and that ordering is the
     * point. Standing may argue about which of two workable places to propose.
     * It may not argue about whether somebody can get there.
     */
    const board = boardWith({ 'bodie-state-historic-park': 1 });
    const built = profile(MAMMOTH_HIKER_ANSWERS, context({ travelerNeeds: [] }));
    const selection = autoSelect({ candidates: board.candidates, profile: built, tripDays: 4 });

    const bodie = cardOf(board, 'bodie-state-historic-park');
    expect(bodie.place.experienceSignificance).toBe(1);
    expect(bodie.fit.blockers.map((blocker) => blocker.code)).toContain('exceeds_daily_travel');
    expect(selection.selectedIds).not.toContain('bodie-state-historic-park');
    expect(
      selection.excluded.find((entry) => entry.placeId === 'bodie-state-historic-park')?.reason,
    ).toBe('not_workable');
  });

  it('still lets significance decide between two picks it can otherwise not choose between', () => {
    /*
     * The positive control for the guard above. A pre-selection that refused
     * every famous place would pass the previous test and be a worse product;
     * significance has to actually move the set somewhere.
     */
    const flat = boardWith({});
    const built = profile(MAMMOTH_HIKER_ANSWERS, context({ travelerNeeds: [] }));
    /*
     * Two days, not four: the premise needs a candidate left out purely for
     * want of a *slot*, and under the shared frequency ledger a four-day pick
     * over this region's heavily overlapping interests exhausts the
     * traveller's own ceilings before the slots run out — every exclusion
     * reads `frequency`, which is a different (and separately tested)
     * constraint. A shorter trip keeps the ceilings slack and makes the slots
     * the binding scarcity this test is about.
     */
    const plain = autoSelect({ candidates: flat.candidates, profile: built, tripDays: 2 });

    const overlooked = flat.candidates.find(
      (candidate) =>
        !plain.selectedIds.includes(candidate.place.id) &&
        plain.excluded.find((entry) => entry.placeId === candidate.place.id)?.reason === 'no_slots',
    );
    expect(
      overlooked,
      'nothing was left out purely for want of a slot, so significance has nothing to argue with',
    ).toBeDefined();

    const lifted = boardWith({ [overlooked!.place.id]: 1 });
    const withStanding = autoSelect({
      candidates: lifted.candidates,
      profile: built,
      tripDays: 2,
    });
    expect(withStanding.selectedIds).toContain(overlooked!.place.id);
  });
});

describe('the derived bad-weather backup section', () => {
  /**
   * The defect this closes: `groupFor` assigns a primary group in a fixed order
   * — hidden gem, then popular, then scenic, then backup — so five of the seven
   * places that genuinely are bad-weather options never reach the backup branch.
   * The section is a cross-cut over the same cards rather than a re-grouping,
   * because a place's primary category is not a function of this week's weather.
   */
  function boardWith(weather: WeatherDataset, dates = AUGUST_DATES) {
    return buildDiscoveryBoard({
      ...boardContext(dates),
      profile: profile(),
      weather,
      dates,
    });
  }

  function weatherFor(dates: readonly string[], now: Date) {
    return buildFixtureWeather({
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates,
      now,
    });
  }

  /** Close enough that every date is a forecast, and wet enough to matter. */
  const NOW = new Date('2026-08-10T12:00:00.000Z');

  /**
   * A trip that lands entirely in bad weather.
   *
   * The fixture's four-step cycle is indexed by day-of-year, so any run of four
   * consecutive dates walks clear → showery → wet → stormy and every place gets
   * a good day somewhere. That is the *common* case and it correctly produces no
   * section at all: if the planner can move a stop to Tuesday, it was never in
   * trouble. To have something genuinely at risk you need a short trip whose
   * every day is wet, which is what 14–15 August is (cycle positions 2 and 3).
   */
  const WASHOUT = ['2026-08-14', '2026-08-15'];

  it('says nothing when every stop still has a good day to move to', () => {
    // The ordinary case, and the one that keeps the section from becoming
    // wallpaper: four consecutive dates give everything at least one clear day.
    const board = boardWith(weatherFor(AUGUST_DATES, NOW));
    expect(boardWeatherBackups(board.candidates)).toBeNull();
  });

  it('surfaces a rain-friendly place whose primary group is something else', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates);
    expect(backups, 'a two-day washout should put something at risk').not.toBeNull();

    const ids = backups!.suggestions.map((entry) => entry.placeId);
    expect(ids.length).toBeGreaterThan(0);

    // At least one suggestion must be a place the board files elsewhere —
    // otherwise the section is just the existing group under a new name.
    const elsewhere = backups!.suggestions.filter(
      (entry) => entry.category !== 'low_effort_backups',
    );
    expect(elsewhere.length).toBeGreaterThan(0);
  });

  it('never offers something that is itself in trouble', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    const atRisk = new Set(backups.atRisk.map((entry) => entry.placeId));
    for (const suggestion of backups.suggestions) {
      expect(atRisk.has(suggestion.placeId)).toBe(false);
    }
  });

  it('never offers a place that is equally sensitive to the same weather', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    for (const suggestion of backups.suggestions) {
      const place = placeById(suggestion.placeId)!;
      expect(
        place.weather.poorWeatherBackup || place.weather.exposure === 'indoor',
        `${suggestion.placeId} is not actually a backup`,
      ).toBe(true);
      expect(place.weather.visibilityDependent).toBe(false);
    }
  });

  it('never offers something unreachable, shut, or a long drive away', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    const byId = new Map(board.candidates.map((entry) => [entry.place.id, entry]));
    for (const suggestion of backups.suggestions) {
      const candidate = byId.get(suggestion.placeId)!;
      expect(candidate.access.status).not.toBe('blocked');
      expect(candidate.operating.status).not.toBe('closed_throughout');
      expect(candidate.operating.status).not.toBe('unknown');
      expect(candidate.fit.band).not.toBe('not_workable');
      expect(candidate.travelMinutesFromBase).not.toBeNull();
      expect(candidate.travelMinutesFromBase!).toBeLessThanOrEqual(
        MAX_BOARD_BACKUP_TRAVEL_MINUTES,
      );
    }
  });

  it('never names an unusable place as at risk', () => {
    // A January trip: most of the region is behind a snow gate, and a place
    // nobody can reach is not "at risk from the weather" — it is simply not on
    // this trip, and saying otherwise would double-report the same problem.
    const board = boardWith(weatherFor(JANUARY_DATES, NOW), JANUARY_DATES);
    const backups = boardWeatherBackups(board.candidates);
    const byId = new Map(board.candidates.map((entry) => [entry.place.id, entry]));
    for (const entry of backups?.atRisk ?? []) {
      expect(byId.get(entry.placeId)!.fit.band).not.toBe('not_workable');
    }
  });

  it('keeps forecast and seasonal-pattern evidence distinct', () => {
    const near = boardWeatherBackups(
      boardWith(weatherFor(WASHOUT, NOW), WASHOUT).candidates,
    );
    expect(near?.evidence).toBe('forecast');

    /**
     * An explicitly wet season, built here rather than taken from the fixture.
     *
     * The offline generator's seasonal values sit just under the caution
     * threshold, so a far-future trip against it produces no section — which is
     * a true statement about a reliable September and a useless test. This says
     * outright that four days in five are wet at this time of year, which is the
     * shape the live archive returns for a genuine monsoon or storm season.
     */
    const far = ['2027-11-14', '2027-11-15'];
    const board = boardWith(wetSeason(far), far);
    const distant = boardWeatherBackups(board.candidates);

    expect(distant, 'a wet season should prompt preparation').not.toBeNull();
    expect(distant!.evidence).toBe('historical_pattern');
    expect(distant!.suggestions.length).toBeGreaterThan(0);
  });

  /** A historical pattern that says this period is reliably wet. */
  function wetSeason(dates: readonly string[]): WeatherDataset {
    return weatherDatasetSchema.parse({
      version: WEATHER_DATASET_VERSION,
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      days: EASTERN_SIERRA_WEATHER_LOCATIONS.flatMap((location) =>
        dates.map((date) => ({
          kind: 'historical_pattern' as const,
          locationId: location.id,
          date,
          bandStart: '11-09',
          bandEnd: '11-19',
          sampleYearFrom: 2017,
          sampleYearTo: 2026,
          sampleCount: 110,
          method: 'Test pattern.',
          temperatureMaxC: { p10: 2, p50: 6, p90: 10 },
          temperatureMinC: { p10: -6, p50: -2, p90: 2 },
          wetDayFrequency: 0.8,
          snowDayFrequency: 0.45,
          windGustKphP90: 70,
          computedAt: '2026-08-10T12:00:00.000Z',
          attribution: {
            provider: 'Test',
            notice: 'Test pattern.',
            url: 'https://example.invalid/t',
          },
        })),
      ),
      solar: [],
      generatedAt: '2026-08-10T12:00:00.000Z',
      providerName: 'Test',
    });
  }

  it('is deterministic and free of duplicates', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const first = boardWeatherBackups(board.candidates)!;
    const second = boardWeatherBackups(board.candidates)!;
    expect(second).toEqual(first);
    expect(new Set(first.suggestions.map((entry) => entry.placeId)).size).toBe(
      first.suggestions.length,
    );
  });
});

// ---------------------------------------------------------------------------
// The board and the planner on one car-free trip handed a road matrix
// ---------------------------------------------------------------------------

/**
 * WHAT THIS PROVES, AND WHY IT IS A BOARD TEST RATHER THAN A PLANNER ONE.
 *
 * The compiler is supposed to measure the network a trip is made on. A live
 * Tokyo compilation stored a car-free scope against a `car` matrix, and the
 * planner grew a narrow repair for it: when nothing measured can carry a leg and
 * the road holds a short *distance*, the leg becomes a derived walk.
 *
 * That repair reached the planner and not the Discovery Board, which resolves
 * reach through `resolveCandidateReach`. So the board refused — as a transport
 * conflict — the very stops the planner would have walked to, scored them out,
 * and left auto-pick with nothing to pre-select but the base. A traveller never
 * got as far as the repair.
 *
 * Everything below runs the real board over a road matrix on which every
 * candidate is a short walk from the bed. It asserts the four properties that
 * failed together, and the negative that keeps the fix honest: a road distance
 * nobody would walk is still a refusal, and the road *duration* never appears.
 */
describe('a car-free board handed a road matrix', () => {
  const BASE = TRANSIT_CITY_IDENTITY.baseId;
  const NEAR: readonly string[] = [
    TRANSIT_CITY_IDENTITY.candidateA,
    TRANSIT_CITY_IDENTITY.candidateB,
    TRANSIT_CITY_IDENTITY.candidateC,
  ];
  /** 1.2 road-km: about sixteen minutes at the modelled pace, inside any answer. */
  const NEAR_KM = 1.2;
  /** The road minutes, which must never reach a traveller in any mode. */
  const ROAD_MINUTES = 4;

  /**
   * A road network on which the whole board is walkable — the shape the broken
   * compilation actually produced, rather than the one candidate the shared
   * fixture's road matrix carries.
   */
  function roadMatrix(): TravelTimeMatrix {
    const ids = [BASE, ...NEAR, TRANSIT_CITY_IDENTITY.candidateD];
    const near = new Set(NEAR);
    const value = (from: string, to: string, forNear: number, forFar: number): number => {
      if (from === to) return 0;
      const other = from === BASE ? to : from;
      return near.has(other) ? forNear : forFar;
    };
    return {
      mode: 'car',
      ids,
      minutes: ids.map((from) => ids.map((to) => value(from, to, ROAD_MINUTES, 22))),
      km: ids.map((from) => ids.map((to) => value(from, to, NEAR_KM, 22))),
      provenance: {
        kind: 'measured',
        note: 'Fixture road network, measured by construction.',
        source: 'packages/core/src/discovery/discovery.test.ts',
      },
    };
  }

  function carFreeBoard(): DiscoveryBoard {
    const traveller = transitCityTraveler();
    const input = transitCityBoardInput(traveller);
    return buildDiscoveryBoard({
      ...input,
      /* No timetable either: the point is a road matrix and nothing else. */
      travel: { ...input.travel, matrix: roadMatrix(), transit: null },
    });
  }

  function cardFor(board: DiscoveryBoard, id: string) {
    const found = board.candidates.find((entry) => entry.place.id === id);
    if (!found) throw new Error(`No card for ${id}`);
    return found;
  }

  it('reaches the near stops on foot rather than calling them a transport conflict', () => {
    const board = carFreeBoard();
    const expected = Math.ceil((NEAR_KM * 60) / MODELLED_WALK_KMH);
    for (const id of NEAR) {
      const card = cardFor(board, id);
      expect(card.reach.status, id).toBe('measured');
      expect(card.travelModeFromBase, id).toBe('walk');
      expect(card.travelMinutesFromBase, id).toBe(expected);
      /*
       * The provenance is the whole licence for showing the number: a derived
       * walk that presented itself as a measurement would be the substitution
       * this layer exists to stop.
       */
      expect(card.reach.status === 'measured' && card.reach.provenance, id).toBe('modelled');
      expect(card.reach.status === 'measured' && card.reach.rule, id).toBe('modelled_walk');
      /* And never the road's own duration, in any field. */
      expect(card.travelMinutesFromBase, id).not.toBe(ROAD_MINUTES);
    }
  });

  it('leaves auto-pick something to pre-select', () => {
    const board = carFreeBoard();
    const chosen = autoSelect({
      candidates: board.candidates,
      profile: transitCityTraveler(),
      tripDays: 3,
    });
    const nearChosen = NEAR.filter((id) => chosen.selectedIds.includes(id));
    expect(nearChosen.length).toBeGreaterThan(0);
    for (const id of NEAR) {
      expect(
        chosen.excluded.find((entry) => entry.placeId === id)?.reason,
        `${id} was excluded for an unverified journey`,
      ).not.toBe('reach_unverified');
    }
  });

  it('still refuses a road distance nobody would walk', () => {
    const board = carFreeBoard();
    const far = cardFor(board, TRANSIT_CITY_IDENTITY.candidateD);
    expect(far.reach.status).not.toBe('measured');
    expect(far.travelMinutesFromBase).toBeNull();
  });
});
