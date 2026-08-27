import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard, type DiscoveryBoard } from './board';
import type { DiscoveryCandidate } from './board';
import { kindEvidences, namesOwnKind } from '../interests/offer';
import { INTERESTS, INTEREST_LABELS, type Interest } from '../schemas/common';
import type { Place } from '../schemas/place';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '../testing/fixtures';
import {
  TRANSIT_CITY_ACCESS,
  TRANSIT_CITY_HOURS,
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_PLACES,
  transitCityBoardInput,
  transitCityTraveler,
} from '../testing/transit-city';

/**
 * §9.2 — THE REASONS A BOARD SHOWS, MEASURED AS A DISTRIBUTION.
 *
 * Parsed off a live Tokyo board: of twenty-one card reasons, eleven were the
 * logistics-only form ("N min by car, inside the 60 min you were happy to
 * travel"), six were a locality line, and two named a graded interest. The
 * composer held richer material than it used — the graded interest levels the
 * traveller actually chose, the matched interests, each place's own
 * description — but it spent them on sentences that were IDENTICAL across
 * cards ("You marked scenic viewpoints as …" led seven cards of one fixture
 * board at once). The board prints one sentence per card and never the same
 * sentence twice, so every duplicate after the first fell through to the one
 * line unique to each card: its travel time. Personalisation drained out of
 * the board a card at a time, and no per-card assertion could see it happen.
 *
 * So the guard is a distribution, taken at board level over the fixture
 * worlds, through the same one-line-per-card walk the board itself performs
 * (see `whysForBoard`): each card takes its first sentence no card above it
 * has used. Among cards that hold a graded interest match and a real
 * description — cards with something true and personal to say — the cards
 * left saying only where the place is, or nothing at all, must not be the
 * majority, and no single sentence may lead more than a couple of them.
 *
 * Shapes, never place names: the guard must hold for any destination.
 */

/** The two shapes a purely-logistical reason takes. */
const LOGISTICS_FORMS = [/min you were happy to travel\.$/, /^Minutes from where you are staying/];

const isLogistics = (line: string): boolean => LOGISTICS_FORMS.some((form) => form.test(line));

/**
 * The cards the guard measures: workable, and holding both halves of a real
 * personal sentence — a graded interest the place matches, and a description
 * substantial enough to name what the place offers for it.
 */
function eligibleCards(board: DiscoveryBoard): DiscoveryCandidate[] {
  return board.candidates.filter(
    (candidate) =>
      candidate.fit.band !== 'not_workable' &&
      candidate.fit.blockers.length === 0 &&
      candidate.fit.primaryInterest !== undefined &&
      candidate.place.shortDescription.trim().length >= 45,
  );
}

describe('§9.2 — reasons stay personal at board scale', () => {
  const worlds: Record<string, () => DiscoveryBoard> = {
    'an authored mountain region': () => {
      const ctx = context({ travelerNeeds: [] });
      return buildDiscoveryBoard({
        ...boardContext(AUGUST_DATES),
        profile: profile(MAMMOTH_HIKER_ANSWERS, ctx),
        travelerNeeds: [],
      });
    },
    'a car-free transit city': () =>
      buildDiscoveryBoard(transitCityBoardInput(transitCityTraveler())),
  };

  for (const [name, build] of Object.entries(worlds)) {
    it(`does not let logistics become the majority voice on ${name}`, () => {
      const eligible = eligibleCards(build());
      // The guard has to be measuring a real board, not passing on an empty one.
      expect(eligible.length).toBeGreaterThanOrEqual(4);

      /* One line per card, never the same line twice — the board's own rule. */
      const used = new Set<string>();
      let impersonal = 0;
      for (const candidate of eligible) {
        const line = candidate.fit.reasons.find((reason) => !used.has(reason));
        if (line !== undefined) used.add(line);
        if (line === undefined || isLogistics(line)) impersonal += 1;
      }

      expect(
        impersonal * 2,
        `${impersonal} of ${eligible.length} cards with a graded interest match ` +
          'end up saying only where the place is, or nothing at all',
      ).toBeLessThanOrEqual(eligible.length);
    });

    it(`gives no sentence the lead on more than two cards of ${name}`, () => {
      const eligible = eligibleCards(build());
      expect(eligible.length).toBeGreaterThanOrEqual(4);

      const leads = new Map<string, number>();
      for (const candidate of eligible) {
        const lead = candidate.fit.reasons[0];
        if (lead === undefined) continue;
        leads.set(lead, (leads.get(lead) ?? 0) + 1);
      }
      for (const [lead, count] of leads) {
        expect(
          count,
          `"${lead}" leads ${count} of ${eligible.length} cards — a background, not a reason`,
        ).toBeLessThanOrEqual(2);
      }
    });
  }
});

/**
 * §9.2 / PR-DISC-13 — AN INTEREST CLAIM NEEDS THE KIND TO CARRY IT.
 *
 * The live sentence this bans, verbatim from a served board: "You marked food &
 * local eating as 'a few times', and that is what this delivers: A theme park."
 * The claim was manufactured by the thirteen-value planning bucket — a theme
 * park files under the food-and-towns *category*, the category stamps the food
 * interest, and the reason composer read the stamp as though it were a fact
 * about the record's kind. The same laundering dressed an easy city park as a
 * core scenic-viewpoint pick.
 *
 * The rule: a reason may name an interest only when the record's own kind — the
 * display noun or the source's leaf category — is in that interest's evidence
 * table. An authored place names no kind, and its curated interests stand;
 * that is why the guard bites only on kind-named (compiled-shaped) records.
 */
describe('§9.2 / PR-DISC-13 — an interest claim needs the kind to carry it', () => {
  const LABELLED = new Map<string, Interest>(
    INTERESTS.map((interest) => [INTEREST_LABELS[interest].toLowerCase(), interest]),
  );

  /** The interest a "You marked X …" sentence claims, or nothing for other forms. */
  function claimOf(reason: string): Interest | undefined {
    const match = /^You marked (.+?) as "/.exec(reason);
    return match ? LABELLED.get(match[1]!) : undefined;
  }

  /**
   * A compiled-shaped record: same world, but carrying the kind channels every
   * compiled place carries — the source leaf category as a `=` tag, and the
   * truthful display noun.
   */
  function compiledLike(
    id: string,
    name: string,
    overrides: Partial<Place> & Pick<Place, 'category' | 'interests' | 'tags'>,
  ): Place {
    const seed = TRANSIT_CITY_PLACES.find(
      (entry) => entry.id === TRANSIT_CITY_IDENTITY.candidateA,
    )!;
    return { ...seed, id, name, ...overrides };
  }

  /** The bucket-laundered shape: a theme park filed under the food category. */
  const launderedPark = compiledLike('tc-x-thrill-park', 'Riverside Thrill Park', {
    category: 'town_and_food',
    interests: ['food_and_towns'],
    displayKind: 'theme park',
    tags: ['places=theme_park', 'attr:website', 'attr:opening_hours'],
    shortDescription:
      'Riverside Thrill Park runs coasters and rides along the east bank, with queues that swallow a whole morning.',
  });

  /** The honest control: a museum whose kind genuinely carries the interest. */
  const kindBackedMuseum = compiledLike('tc-x-print-museum', 'Aldgate Print Museum', {
    category: 'museum',
    interests: ['history_and_culture'],
    displayKind: 'museum',
    tags: ['places=art_museum', 'attr:website', 'attr:opening_hours'],
    shortDescription:
      'Aldgate Print Museum keeps three centuries of presses running, with demonstrations through the day.',
  });

  function boardWithCompiledKinds(): DiscoveryBoard {
    const input = transitCityBoardInput(transitCityTraveler());
    return buildDiscoveryBoard({
      ...input,
      places: [...input.places, launderedPark, kindBackedMuseum],
      access: {
        ...TRANSIT_CITY_ACCESS,
        rules: TRANSIT_CITY_ACCESS.rules.map((rule) =>
          rule.id === 'tc-rule-walkable'
            ? { ...rule, placeIds: [...rule.placeIds, launderedPark.id, kindBackedMuseum.id] }
            : rule,
        ),
      },
      hours: {
        ...TRANSIT_CITY_HOURS,
        calendars: [
          ...TRANSIT_CITY_HOURS.calendars,
          ...[launderedPark.id, kindBackedMuseum.id].map((placeId) => ({
            ...TRANSIT_CITY_HOURS.calendars[0]!,
            placeId,
          })),
        ],
      },
    });
  }

  it('makes zero false interest-kind claims across the fixture worlds', () => {
    const boards: DiscoveryBoard[] = [
      buildDiscoveryBoard({
        ...boardContext(AUGUST_DATES),
        profile: profile(MAMMOTH_HIKER_ANSWERS, context({ travelerNeeds: [] })),
        travelerNeeds: [],
      }),
      buildDiscoveryBoard(transitCityBoardInput(transitCityTraveler())),
      boardWithCompiledKinds(),
    ];

    const violations: string[] = [];
    for (const board of boards) {
      for (const candidate of board.candidates) {
        if (!namesOwnKind(candidate.place)) continue;
        for (const reason of candidate.fit.reasons) {
          const claimed = claimOf(reason);
          if (claimed !== undefined && !kindEvidences(candidate.place, claimed)) {
            violations.push(`${candidate.place.name}: "${reason}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('refuses the bucket-laundered claim and keeps the kind-backed one', () => {
    const board = boardWithCompiledKinds();

    const park = board.candidates.find((entry) => entry.place.id === launderedPark.id)!;
    expect(park.fit.band).not.toBe('not_workable');
    /* The honest fallback: the card keeps a reason, just not the false claim. */
    expect(park.fit.reasons.length).toBeGreaterThan(0);
    for (const reason of park.fit.reasons) {
      expect(reason, `a theme park sold as a food interest: "${reason}"`).not.toMatch(
        /^You marked /,
      );
    }

    const museum = board.candidates.find((entry) => entry.place.id === kindBackedMuseum.id)!;
    expect(museum.fit.reasons[0]).toContain(
      INTEREST_LABELS.history_and_culture.toLowerCase(),
    );
  });
});

/**
 * §6 / GROUP H — A "WHY THIS FITS YOU" SENTENCE MAY NOT OUTRUN ITS RECORD.
 *
 * ---
 *
 * **The live evidence class.** Three delivered boards of 2026-08-26. Every
 * record the catalogue filed under its `observatory` word — the word it
 * publishes for an observation *deck*, ticketed, daytime, with a lift — carried
 * `stargazing`, and a destination's principal tower was sold to a traveller who
 * had graded the night sky as that interest delivered. Separately, every record
 * filed under `amusement_park` carried `easy_nature_walks`, and two of them
 * were sold as easy nature walks. Both claims were field-backed in form: the
 * interest really was on the place. Neither was true of the place, because the
 * stamp had been read out of a keyword that names something else.
 *
 * **What these drive.** `buildDiscoveryBoard` over compiled-shaped records —
 * the source's leaf category as a `=` tag, the truthful display noun — which is
 * the same path and the same records the discover page renders. The assertion
 * is on `fit.reasons`, the array `BoardCopy#whyThisFits` prints from.
 *
 * The second test is the half that is easy to lose: where the record's kind
 * supports *no* graded interest, the card must fall through to the sentences
 * that are true of any record and name no interest at all — never reach for a
 * nearby one.
 */
describe('§6 — a graded-interest claim traces to the record’s own kind', () => {
  const LABELLED = new Map<string, Interest>(
    INTERESTS.map((interest) => [INTEREST_LABELS[interest].toLowerCase(), interest]),
  );
  const claimOf = (reason: string): Interest | undefined => {
    const match = /^You marked (.+?) as "/.exec(reason);
    return match ? LABELLED.get(match[1]!) : undefined;
  };

  function compiledLike(id: string, name: string, overrides: Partial<Place>): Place {
    const seed = TRANSIT_CITY_PLACES.find(
      (entry) => entry.id === TRANSIT_CITY_IDENTITY.candidateA,
    )!;
    return { ...seed, id, name, ...overrides };
  }

  /**
   * The observation deck **exactly as the delivered artifact stored it** —
   * stargazing stamp and all.
   *
   * Deliberately not the post-fix stamp. The compiler no longer writes that
   * interest (pinned in the taxonomy's own suite), and a fixture built from the
   * fixed stamp would exercise nothing here: `spokenInterestFor` only ever
   * considers interests the place already carries, so a place without the stamp
   * cannot speak it however wrong the matcher is. Reproducing the stored record
   * is what puts the board's own guard under test, and it is the shape any
   * region compiled before the fix still holds on disk.
   */
  const deck = compiledLike('tc-x-deck', 'Fernwold Sky Deck', {
    category: 'viewpoint',
    interests: ['scenic_viewpoints', 'photography_golden_hour', 'stargazing'],
    displayKind: 'Observatory',
    tags: ['places=observatory', 'attr:website', 'attr:opening_hours'],
    shortDescription:
      'A lift runs to a glassed deck on the top floor, open from mid-morning until late in the evening.',
  });

  /**
   * The ticketed enclosure as the delivered artifact stored it, carrying the
   * green-space interest the `park` substring reached inside `amusement_park`.
   */
  const enclosure = compiledLike('tc-x-fairground', 'Calderbrook Fairground', {
    category: 'town_and_food',
    interests: ['food_and_towns', 'easy_nature_walks'],
    displayKind: 'Amusement park',
    tags: ['places=amusement_park', 'attr:website', 'attr:opening_hours'],
    shortDescription:
      'One gate, one ticket, and a full afternoon of rides and stalls inside the fence.',
  });

  /**
   * The absent-evidence control: a real record whose kind carries none of the
   * interests this traveller graded, and which says nothing else about itself.
   */
  const unsupported = compiledLike('tc-x-yard', 'Marrowgate Yard', {
    category: 'town_and_food',
    interests: ['food_and_towns'],
    displayKind: 'Depot',
    tags: ['places=bus_depot'],
    shortDescription: 'A depot in Marrowgate.',
  });

  const extra = [deck, enclosure, unsupported];

  function boardFor(traveler: Parameters<typeof transitCityBoardInput>[0]): DiscoveryBoard {
    const input = transitCityBoardInput(traveler);
    return buildDiscoveryBoard({
      ...input,
      places: [...input.places, ...extra],
      access: {
        ...TRANSIT_CITY_ACCESS,
        rules: TRANSIT_CITY_ACCESS.rules.map((rule) =>
          rule.id === 'tc-rule-walkable'
            ? { ...rule, placeIds: [...rule.placeIds, ...extra.map((place) => place.id)] }
            : rule,
        ),
      },
      hours: {
        ...TRANSIT_CITY_HOURS,
        calendars: [
          ...TRANSIT_CITY_HOURS.calendars,
          ...extra.map((place) => ({ ...TRANSIT_CITY_HOURS.calendars[0]!, placeId: place.id })),
        ],
      },
    });
  }

  const cardFor = (board: DiscoveryBoard, id: string): DiscoveryCandidate =>
    board.candidates.find((entry) => entry.place.id === id)!;

  it('never sells a daytime viewing deck as the night sky', () => {
    /* A traveller for whom the false claim would have been the strongest one. */
    const board = boardFor(
      transitCityTraveler({
        interests: { stargazing: 'core', easy_nature_walks: 'core' } as never,
      }),
    );

    const card = cardFor(board, deck.id);
    /* The stamp is on the record — and the sentence still refuses to sell it. */
    expect(card.place.interests).toContain('stargazing');
    for (const reason of card.fit.reasons) expect(claimOf(reason)).not.toBe('stargazing');
    /* Nowhere on the board, not merely not on this card. */
    for (const candidate of board.candidates) {
      for (const reason of candidate.fit.reasons) {
        expect(claimOf(reason), `${candidate.place.name}: ${reason}`).not.toBe('stargazing');
      }
    }
  });

  it('never sells a ticketed enclosure as an easy nature walk', () => {
    const board = boardFor(
      transitCityTraveler({ interests: { easy_nature_walks: 'core' } as never }),
    );

    const card = cardFor(board, enclosure.id);
    expect(card.place.interests).toContain('easy_nature_walks');
    for (const reason of card.fit.reasons) {
      expect(claimOf(reason)).not.toBe('easy_nature_walks');
    }
  });

  it('names no interest at all where the record’s kind carries none of them', () => {
    const board = boardFor(
      transitCityTraveler({
        interests: { stargazing: 'core', easy_nature_walks: 'core' } as never,
      }),
    );

    const card = cardFor(board, unsupported.id);
    /*
     * The card is still on the board and still says something — what it must
     * not do is reach for a claim. Every reason it carries is one of the forms
     * that is true of any record: standing, trade-off, or logistics.
     */
    for (const reason of card.fit.reasons) expect(claimOf(reason)).toBeUndefined();
    /* And it invents no description to say it with. */
    expect(card.place.shortDescription.trim().length).toBeLessThan(45);
  });
});
