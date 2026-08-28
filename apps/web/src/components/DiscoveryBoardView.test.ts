import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDiscoveryBoard,
  FIT_BAND_LABELS,
  type DestinationImage as ImageRecord,
  type DiscoveryCandidate,
} from '@sidequest/core';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '@sidequest/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryBoardView, type SerializedGroup } from './DiscoveryBoardView';
import {
  WEATHER_NOT_FETCHED_NOTE,
  WEATHER_OUTAGE_NOTES,
  honestWeatherNote,
  sharedBoardFacts,
} from './BoardCopy';

/*
 * The board imports its server actions for the three buttons on every card. They
 * open a database and are irrelevant to what is under test here, which is the
 * markup: nothing below presses anything.
 */
/*
 * The board asks the router to re-fetch this route once background imagery
 * lands — `router.refresh()`, never a hard reload, because a reload tears down
 * an in-flight "Build my trip". A static render mounts no router, so the hook
 * needs one here; nothing below presses anything that would call it.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock('@/app/(product)/trips/[id]/discover/actions', () => ({
  autoPickAction: async () => ({ ok: true }),
  fillBoardImageryAction: async () => ({ ok: true, accepted: 0 }),
  setSelectionAction: async () => ({ ok: true }),
}));
vi.mock('./BuildTripButton', () => ({
  BuildTripButton: () => null,
  PlannerReadinessPanel: () => null,
}));

/**
 * §18's BANNED PATTERN, ASSERTED RATHER THAN ARGUED ABOUT.
 *
 * A fresh designer graded the rebuilt board against §18 and returned the same
 * verdict the rebuild was meant to answer: "24 cards that are identical in
 * plate, in chips, in numbers ('Free / Easy / journey not timed / Not verified')
 * and in prose ('A easy walk.' ×11, 'A viewpoint.' ×7, 'A lake.' ×4) — the exact
 * 'endless identical cards' pattern §18 bans, verbatim."
 *
 * Each of those four is a measurable property of the rendered document, so each
 * one is measured here. The rule they share is the one `BoardCopy` states at the
 * top of itself: **a fact true of most of the board is a fact about the board**,
 * said once above the cards and suppressed on every card it covers — plus its
 * visual half, which the copy layer could not reach: a card's *drawing* must
 * differ when the places differ.
 */

const BOARD = (() => {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 }));
  return buildDiscoveryBoard({ ...boardContext(AUGUST_DATES), profile: built, travelerNeeds: [] });
})();

/** The groups as the page serialises them, unchanged. */
const GROUPS: SerializedGroup[] = BOARD.groups.map((entry) => ({
  group: entry.group,
  candidates: entry.candidates,
}));

function render(groups: SerializedGroup[] = GROUPS): string {
  return renderToStaticMarkup(
    createElement(DiscoveryBoardView, {
      tripId: 'trip-board-render',
      groups,
      initialSelections: {},
      autoPickNotes: [],
      hasItinerary: false,
      weatherBackups: null,
      base: { name: 'Mammoth Lakes', coordinates: { lat: 37.6485, lng: -118.9721 } },
    }),
  );
}

/**
 * Every occurrence of an element with the given `data-testid`, up to its close.
 *
 * The close tag is named by the caller because a regex cannot balance nesting,
 * and the first `</` inside a `<dl>` of three `<div>`s is not the end of it —
 * an earlier version of this helper stopped there and quietly compared the first
 * eight characters of every card.
 */
/**
 * ONE CARD, TWO ANSWERS, AND THE CONFIDENT ONE WAS FALSE.
 *
 * A car-free metropolitan board rendered "2 hr 17 min on foot from base" over
 * the destination's best-known tower — twenty-five minutes away by a train
 * nobody could price — directly above that same card's own sentence saying no
 * route here could be confirmed. Both came from one measured walk.
 *
 * The card read `detourClass`, which is a statement about the traveller's
 * *budgets*: a stand-in walk long enough to bust the day's travel allowance is
 * filed `too_far` before the proxy rule is reached, and from there the phrase
 * went back to quoting a walking clock as this traveller's distance. So the
 * fact rides on the candidate and the card asks for it by name.
 *
 * Rendered rather than asserted on the helper, because the helper was already
 * right: `describeTransitBlindWalk` has produced the honest sentence since it
 * was written, and the card simply did not call it on this branch.
 */
function proxyCard(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  const base = GROUPS.flatMap((group) => group.candidates).find(
    (candidate) => candidate.reach.status === 'measured',
  )!;
  return {
    ...base,
    journeyProxy: true,
    detourClass: 'too_far',
    worthDetour: 'reach_unverified',
    reach: { ...base.reach, mode: 'walk', travelMinutes: 137, returnMinutes: 140 },
    ...overrides,
  } as DiscoveryCandidate;
}

describe('a journey priced by a walk nobody would make', () => {
  it('says the route is unverified instead of quoting a walking clock as the distance', () => {
    const card = proxyCard();
    const html = render([{ group: 'nearby_side_quests', candidates: [card] }]);
    expect(html).toContain('We could not verify the transit route yet');
    expect(html).not.toMatch(/2 hr 17 min on foot from base/);
    /* And the refusal is still legible: the day cannot hold that walk. */
    expect(html).toContain('more than a day here can hold');
  });

  it('keeps the ordinary walking phrase for a walk that really is the journey', () => {
    const card = proxyCard({ journeyProxy: false, detourClass: 'in_tolerance' });
    const html = render([{ group: 'nearby_side_quests', candidates: [card] }]);
    expect(html).not.toContain('We could not verify the transit route yet');
    expect(html).toMatch(/on foot from base/);
  });
});

describe('a card the trip cannot reach', () => {
  /**
   * FIT IS ABOUT TASTE; REACH IS ABOUT THE TRIP — EXCEPT WHERE FIT IS A REFUSAL.
   *
   * Nine cards on a delivered board sat under "Probably skip — here for
   * completeness, with the reason we would leave them out" wearing a "Strong
   * fit" chip: one card, two verdicts, and the card's own reason line gave the
   * true one. So a workable band stops answering a question the heading has
   * already closed.
   *
   * The two weak bands are the exception and the browser suite found it: "Not
   * workable this trip" is a *refusal*, it is what explains a disabled Include
   * button beside it, and it makes no claim about a journey at all.
   */
  it('drops a taste verdict the heading has already closed', () => {
    const card = proxyCard({ journeyProxy: false, detourClass: 'too_far' });
    const html = render([{ group: 'weak_fit', candidates: [card] }]);
    expect(html).not.toContain(FIT_BAND_LABELS[card.fit.band]);
  });

  it('keeps a refusal, because that is the thing the traveller needs told', () => {
    const base = GROUPS.flatMap((group) => group.candidates)[0]!;
    const refused = {
      ...base,
      detourClass: 'too_far',
      fit: { ...base.fit, band: 'not_workable' },
    } as DiscoveryCandidate;
    const html = render([{ group: 'weak_fit', candidates: [refused] }]);
    expect(html).toContain(FIT_BAND_LABELS.not_workable);
  });
});

function chunks(html: string, testId: string, closeTag: string): string[] {
  return [...html.matchAll(new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</${closeTag}>`, 'g'))].map(
    (match) => match[1] ?? '',
  );
}

/**
 * The document split into one string per card, keyed by place id.
 *
 * Split rather than searched, because every assertion below is about what *one*
 * card carries relative to its neighbours — a document-wide `toContain` cannot
 * tell "eleven identical cards" from "one card in eleven".
 */
function cards(html: string): Map<string, string> {
  const parts = html.split('data-place-card="').slice(1);
  const found = new Map<string, string>();
  for (const part of parts) {
    const id = part.slice(0, part.indexOf('"'));
    found.set(id, part);
  }
  return found;
}

/**
 * The plate's own drawing out of a card fragment.
 *
 * The whole SVG rather than its `d` attributes: a quiet find is drawn with a
 * broken line, which is a `stroke-dasharray` and not a path — and a comparison
 * that reads only the paths would call two visibly different plates identical.
 */
function plateOf(fragment: string): string {
  const start = fragment.indexOf('viewBox="0 0 100 60"');
  if (start < 0) return '';
  const end = fragment.indexOf('</svg>', start);
  return fragment.slice(start, end < 0 ? undefined : end);
}

describe('the board is not twenty-four copies of one card', () => {
  it('draws a different plate for two places of the same kind that differ', () => {
    /*
     * The sharp form of the finding. The plate encoded exactly one fact — the
     * category — so any two places of the same kind were drawn with the same
     * path, whatever else was true of them: "four consecutive cards carry the
     * same flat green gradient with the same white squiggle".
     *
     * Two cards of one category whose effort or visit length differ must be
     * drawn differently, because those are the two things the plate now draws.
     */
    const drawn = cards(render());
    const byCategory = new Map<string, DiscoveryCandidate[]>();
    for (const candidate of BOARD.candidates) {
      if (candidate.group === 'weak_fit') continue;
      const list = byCategory.get(candidate.place.category) ?? [];
      list.push(candidate);
      byCategory.set(candidate.place.category, list);
    }

    /*
     * The three facts the plate claims to draw, at the coarseness it draws them.
     * The visit length is bucketed and clamped because a plate is a glance, not
     * a chart — so two four-hour stops are allowed to look alike, and a half-hour
     * stop beside a four-hour one is not.
     */
    const drawnFacts = (candidate: DiscoveryCandidate) =>
      [
        candidate.place.physicalIntensity,
        Math.max(2, Math.min(5, Math.round(candidate.place.typicalDurationMinutes / 60) + 1)),
        candidate.place.hiddenGemScore >= 0.6,
      ].join('/');

    let compared = 0;
    for (const list of byCategory.values()) {
      for (const a of list) {
        for (const b of list) {
          if (a.place.id >= b.place.id) continue;
          if (drawnFacts(a) === drawnFacts(b)) continue;
          compared += 1;
          const left = plateOf(drawn.get(a.place.id) ?? '');
          expect(left.length, `${a.place.name} has no plate to compare`).toBeGreaterThan(0);
          expect(
            left,
            `${a.place.name} and ${b.place.name} are drawn identically`,
          ).not.toBe(plateOf(drawn.get(b.place.id) ?? ''));
        }
      }
    }
    expect(compared, 'this fixture has no two comparable places, so it proves nothing')
      .toBeGreaterThan(0);
  });

  it('prints only the numbers a card does not share with the board', () => {
    /*
     * The observed failure, verbatim: "Time there 1 hr 15/30 min · Cost Free ·
     * Effort Easy" on card after card. Where a value is what most of the board
     * says, the board states it once above the cards and no card repeats it.
     */
    const norms = sharedBoardFacts(BOARD.candidates).norms;
    const dominant = [norms.cost, norms.effort, norms.duration].filter(
      (value): value is string => value !== null,
    );
    expect(
      dominant.length,
      'no value dominates this board, so this test proves nothing',
    ).toBeGreaterThan(0);

    const html = render();
    const stats = chunks(html, 'card-stats', 'dl');
    expect(stats.length).toBeGreaterThan(0);
    for (const value of dominant) {
      const repeats = stats.filter((entry) => entry.includes(`>${value}<`)).length;
      expect(repeats, `"${value}" is printed on ${repeats} cards and is the board's norm`).toBe(0);
    }
    // And the board says it once, in its own voice.
    expect(html).toContain('Unless a card says otherwise these are');
  });

  it('never prints a description that only restates the category', () => {
    /*
     * §8.7 names these exact strings. They are the classifier's honest minimal
     * sentence for a record nothing is published about, and as card copy they
     * cost a reader a fixation and return nothing. Forced onto the fixture,
     * because the authored region has real descriptions and a live compilation
     * is what produces the stubs.
     */
    const stubs = ['A lake.', 'A viewpoint.', 'A easy walk.'];
    const stubbed = BOARD.candidates.slice(0, 9).map((candidate, index) => ({
      ...candidate,
      place: { ...candidate.place, shortDescription: stubs[index % stubs.length]! },
    }));
    const html = render([{ group: 'must_see_classics', candidates: stubbed }]);
    for (const stub of stubs) {
      expect(html, `${stub} reached the board`).not.toContain(`>${stub}<`);
    }
  });

  it('marks the minority side of the evidence line, not the majority', () => {
    /*
     * A chip earns its space by telling cards apart. "Not verified" on nineteen
     * of twenty-four does the opposite, and the reader then skips it on the five
     * cards where it is the whole story. Whichever side is smaller is the side
     * worth marking.
     */
    const unverified: DiscoveryCandidate[] = BOARD.candidates.map((candidate, index) => ({
      ...candidate,
      fit: { ...candidate.fit, evidenceLimited: index > 2, blockers: [] },
    }));
    const html = render([
      { group: 'must_see_classics', candidates: unverified.slice(0, 12) },
    ]);
    const marks = chunks(html, 'card-chips', 'div').join(' ');
    expect(marks).toContain('Details checked');
    expect(marks).not.toContain('Not verified');
  });

  it('gives a photograph the file\'s own shape, and puts its credit under the card', () => {
    /*
     * A licensing rule had been implemented as a layout rule. Share-alike files
     * must not be cropped, so the frame and the file were allowed to disagree by
     * any amount — which on a real board produced a photograph as a letterboxed
     * sliver between two coloured bands, a different sliver in every card, under
     * two to four lines of dotted-underlined attribution *above* the place's
     * name. Cropping is not the only way out of that: the frame takes the file's
     * shape, and the credit stays verbatim and reachable at the card's foot.
     */
    const subject = BOARD.candidates.find((candidate) => candidate.group !== 'weak_fit')!;
    const image = {
      schemaVersion: 1,
      fileTitle: 'File:Somewhere.jpg',
      filePageUrl: 'https://commons.wikimedia.org/wiki/File:Somewhere.jpg',
      thumbnailUrl: 'https://upload.wikimedia.org/somewhere.jpg',
      width: 800,
      height: 600,
      mediaType: 'image/jpeg',
      subject: { kind: 'candidate', id: subject.place.id },
      matchBasis: 'entity_image',
      subjectConfidence: 'strong',
      attributionText: 'Photo by A. Photographer, CC BY-SA 4.0',
      licenceId: 'CC-BY-SA-4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      creatorUrl: 'https://commons.wikimedia.org/wiki/User:APhotographer',
    } as unknown as ImageRecord;

    const html = renderToStaticMarkup(
      createElement(DiscoveryBoardView, {
        tripId: 'trip-board-render',
        groups: [{ group: 'must_see_classics', candidates: [subject] }],
        initialSelections: {},
        autoPickNotes: [],
        hasItinerary: false,
        weatherBackups: null,
        images: { [subject.place.id]: image },
        base: { name: 'Mammoth Lakes', coordinates: { lat: 37.6485, lng: -118.9721 } },
      }),
    );

    /* The frame is the file's shape, so nothing is letterboxed and nothing is cropped. */
    expect(html).toContain('aspect-ratio:800 / 600');
    expect(html).not.toContain('object-cover');
    /* And the credit is below the name rather than above it. */
    const name = html.indexOf('font-display');
    const credit = html.indexOf('A. Photographer');
    expect(credit).toBeGreaterThan(-1);
    expect(credit, 'the photographer is louder than the place').toBeGreaterThan(name);
  });

  it('gives the eye somewhere to start rather than a grid of equal cells', () => {
    const html = render();
    expect(
      html,
      'no card leads its group, so the board is a wall of identical cells',
    ).toContain('sm:col-span-2');
  });

  it('folds the board-wide caveats behind one line rather than a wall of them', () => {
    /*
     * Six consecutive negative sentences stood between the trip header and the
     * first place on a live board, which on a phone is about two viewports of
     * apparatus before anything a traveller can decide on. Hoisted *and* folded:
     * the count is on screen and the sentences are one press away.
     */
    const html = render();
    const banner = chunks(html, 'board-weather-note', 'details');
    if (banner.length > 0) {
      expect(html).toMatch(/things we could not check across this board|One thing we could not check/);
      expect(html).toContain('see what they are');
    }
    /* And the places come before the map in the document, not after it. */
    const firstCard = html.indexOf('data-place-card');
    const map = html.indexOf('data-testid="board-map"');
    expect(firstCard).toBeGreaterThan(-1);
    expect(map).toBeGreaterThan(-1);
    expect(firstCard, 'the map still comes before the first place').toBeLessThan(map);
  });
});

/**
 * ONE WEATHER STORY PER PAGE.
 *
 * A live Iceland board told two stories about one absent dataset: a banner
 * claiming "We could not reach a weather source for your dates" — an outage —
 * while the weather panel on the same page said "not fetched" and offered a
 * fetch button. The card sentence is composed in core from per-day evidence
 * that cannot tell a failed fetch from a fetch nobody asked for; only the page
 * knows which (`weatherFreshness === 'not_fetched'` means no snapshot row
 * exists), so the page reconciles the words before anything renders them.
 */
describe('an unfetched forecast is one story, not an outage claim beside a fetch button', () => {
  const OUTAGE =
    'We could not reach a weather source for your dates, so nothing here has been checked against one.';

  /** Every card carrying the outage sentence, as core writes it for absent evidence. */
  const OUTAGE_GROUPS: SerializedGroup[] = GROUPS.map((entry) => ({
    ...entry,
    candidates: entry.candidates.map((candidate) => ({
      ...candidate,
      weather: { ...candidate.weather, note: OUTAGE },
    })),
  }));

  function renderWithFreshness(freshness: 'not_fetched' | 'fresh'): string {
    return renderToStaticMarkup(
      createElement(DiscoveryBoardView, {
        tripId: 'trip-weather-story',
        groups: OUTAGE_GROUPS,
        initialSelections: {},
        autoPickNotes: [],
        hasItinerary: false,
        weatherBackups: null,
        weatherFreshness: freshness,
        base: { name: 'Mammoth Lakes', coordinates: { lat: 37.6485, lng: -118.9721 } },
      }),
    );
  }

  it('tells the not-fetched truth when no snapshot exists, and points at the button that fixes it', () => {
    const html = renderWithFreshness('not_fetched');
    expect(html, 'the outage claim must not render over a dataset nobody fetched').not.toContain(
      'could not reach a weather source',
    );
    expect(html).toContain('We have not fetched the weather for this trip yet');
    expect(html).toContain('the weather panel below can fetch it');
  });

  it('keeps the outage story when a snapshot exists and the absence really was a failure', () => {
    const html = renderWithFreshness('fresh');
    expect(html).toContain('could not reach a weather source');
    expect(html).not.toContain('We have not fetched the weather for this trip yet');
  });

  it('pins the outage sentences to the ones core actually composes', () => {
    /*
     * `honestWeatherNote` recognises the outage sentences verbatim. If core
     * rewords them, recognition silently stops and the two stories return —
     * so the literals are asserted against core's own source, and a reword
     * breaks this test instead of the page.
     */
    const boardSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../packages/core/src/weather/board.ts',
      ),
      'utf8',
    );
    for (const note of WEATHER_OUTAGE_NOTES) {
      expect(boardSource).toContain(note);
    }
  });

  it('maps only the outage sentences, and only for the unfetched case', () => {
    expect(honestWeatherNote(OUTAGE, 'not_fetched')).toBe(WEATHER_NOT_FETCHED_NOTE);
    expect(honestWeatherNote(OUTAGE, 'fresh')).toBe(OUTAGE);
    expect(honestWeatherNote(OUTAGE, undefined)).toBe(OUTAGE);
    const forecastNote = 'Thursday looks like the day for this one in the current forecast.';
    expect(honestWeatherNote(forecastNote, 'not_fetched')).toBe(forecastNote);
  });
});
