import { describe, expect, it } from 'vitest';
import { autoSelect } from './autoselect';
import { buildDiscoveryBoard, type DiscoveryCandidate } from './board';
import { worthDetourLabel, type DetourClass } from '../region/expansion';
import type { PlaceCategory } from '../schemas/common';
import type { FitBand } from '../scoring/fit';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '../testing/fixtures';

/**
 * AUTO-PICK COMPOSES A PORTFOLIO; IT DOES NOT RANK A LIST.
 *
 * The defect these tests exist to catch, reproduced on a live Tokyo board: every
 * candidate scored within a point or two of the others, selection took strictly
 * the top N, and the traveller was handed six stops twenty-plus minutes away by
 * train while a stop fifteen minutes' walk from the bed sat unselected. Nothing
 * in the code was wrong in the sense of throwing; the ordering simply had no
 * opinion about travel burden, repetition or spread, which §10.7 says it must.
 *
 * The candidates here are *derived from a real board* rather than hand-built, so
 * every field a candidate carries is a field the board actually produces — a
 * synthetic literal would drift from the type the moment either changed, and the
 * assertions below are about ordering rather than about any one field's value.
 */

const REAL = (() => {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 }));
  const board = buildDiscoveryBoard({ ...boardContext(AUGUST_DATES), profile: built, travelerNeeds: [] });
  const template = board.candidates.find(
    (candidate) => candidate.reach.status === 'measured' && candidate.detourClass === 'in_tolerance',
  );
  if (!template) throw new Error('the authored region no longer produces a measured candidate');
  return { profile: built, template };
})();

/**
 * One candidate that differs from a real one only in the ways under test.
 *
 * Score is pinned equal across every variant on purpose: the whole question is
 * what happens when the scorer cannot separate two places, which on a real board
 * is most pairs.
 */
function variant(input: {
  id: string;
  minutes: number;
  category: PlaceCategory;
  lat: number;
  lng: number;
}): DiscoveryCandidate {
  const { template } = REAL;
  if (template.reach.status !== 'measured') throw new Error('template lost its measured reach');
  return {
    ...template,
    place: {
      ...template.place,
      id: input.id,
      name: input.id,
      category: input.category,
      coordinates: { lat: input.lat, lng: input.lng },
      hiddenGemScore: 0.3,
      popularityScore: 0.3,
    },
    fit: { ...template.fit, placeId: input.id, score: 90, band: 'top_pick' },
    travelMinutesFromBase: input.minutes,
    reach: {
      ...template.reach,
      travelMinutes: input.minutes,
      returnMinutes: input.minutes,
      roundTripMinutes: input.minutes * 2,
    },
  };
}

function selectFrom(candidates: DiscoveryCandidate[], tripDays = 3) {
  return autoSelect({ candidates, profile: REAL.profile, tripDays });
}

/**
 * One candidate sitting at a chosen distance class and fit band, carrying the
 * card the board would actually print for that pair.
 *
 * `worthDetour` is recomputed through `worthDetourLabel` rather than inherited
 * from the template, because the label is the thing under test: copying the
 * template's would test that a string survives a spread.
 */
function cell(detourClass: DetourClass, band: FitBand): DiscoveryCandidate {
  const { template } = REAL;
  if (template.reach.status !== 'measured') throw new Error('template lost its measured reach');
  const id = `${detourClass}-${band}`;
  const measured = detourClass !== 'unknown';
  return {
    ...template,
    place: { ...template.place, id, name: id },
    fit: { ...template.fit, placeId: id, band },
    detourClass,
    /*
     * A short, comfortably affordable journey on every cell, so the only thing
     * that can refuse one is the rule under test rather than the travel budget
     * incidentally running out. `unknown` is the one class defined by the
     * *absence* of a measurement, so it gets none: a candidate carrying both an
     * unresolved journey and a duration is a shape no board produces, and a
     * sweep built on one would prove nothing about the board.
     */
    travelMinutesFromBase: measured ? 20 : null,
    travelModeFromBase: measured ? template.travelModeFromBase : null,
    reach: measured
      ? { ...template.reach, travelMinutes: 20, returnMinutes: 20, roundTripMinutes: 40 }
      : {
          baseId: template.reach.baseId,
          candidateId: id,
          status: 'unmeasured',
          reachable: null,
          conflict: false,
          reason: 'no_route_found',
          detail: 'No provider answered for this pair.',
        },
    worthDetour: worthDetourLabel(detourClass, band),
  };
}

describe('auto-pick portfolio', () => {
  it('prefers the stop next door to a further one the scorer cannot separate from it', () => {
    /*
     * The live Tokyo shape: one near stop, six far ones, identical scores. Top-N
     * takes the six far ones and leaves the near one; a portfolio does not.
     */
    const nearby = variant({ id: 'near', minutes: 15, category: 'easy_walk', lat: 37.6, lng: -119.0 });
    const far = Array.from({ length: 6 }, (_, index) =>
      variant({
        id: `far-${index}`,
        minutes: 22 + index,
        category: 'easy_walk',
        lat: 37.9 + index * 0.01,
        lng: -119.4 - index * 0.01,
      }),
    );

    // The far stops are offered first, so a selector that respects input order
    // rather than value would fail this outright.
    const selection = selectFrom([...far, nearby]);
    expect(selection.selectedIds).toContain('near');
  });

  it('spreads picks across kinds of thing rather than repeating the highest-scoring one', () => {
    const categories: PlaceCategory[] = ['easy_walk', 'viewpoint', 'lake', 'museum'];
    const candidates = categories.flatMap((category, categoryIndex) =>
      Array.from({ length: 4 }, (_, index) =>
        variant({
          id: `${category}-${index}`,
          // Distance is held constant so the only axis left is variety.
          minutes: 20,
          category,
          lat: 37.6 + categoryIndex * 0.2,
          lng: -119.0 - index * 0.2,
        }),
      ),
    );

    const selection = selectFrom(candidates);
    const kinds = new Set(
      selection.selectedIds.map((id) => id.slice(0, id.lastIndexOf('-'))),
    );
    expect(selection.selectedIds.length).toBeGreaterThan(2);
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('spreads picks across the map rather than filling one pocket of it', () => {
    /*
     * Two clusters, one of them large. Everything scores the same and everything
     * is the same distance from base, so nothing but geography can decide — and
     * a selector with no geography term would take the big cluster whole.
     */
    const crowded = Array.from({ length: 8 }, (_, index) =>
      variant({
        id: `crowded-${index}`,
        minutes: 20,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 37.6 + index * 0.0001,
        lng: -119.0 + index * 0.0001,
      }),
    );
    const elsewhere = Array.from({ length: 2 }, (_, index) =>
      variant({
        id: `elsewhere-${index}`,
        minutes: 20,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 38.4 + index * 0.0001,
        lng: -118.2 + index * 0.0001,
      }),
    );

    const selection = selectFrom([...crowded, ...elsewhere]);
    expect(selection.selectedIds.some((id) => id.startsWith('elsewhere'))).toBe(true);
  });

  it('always says what it did, even when nothing went wrong', () => {
    /*
     * The observed failure: pressing "choose for me" changed some borders far
     * down a very long page and produced no sentence at all. An unexplained
     * decision made on somebody's behalf is not an intelligent one.
     */
    const candidates = Array.from({ length: 5 }, (_, index) =>
      variant({
        id: `place-${index}`,
        minutes: 15 + index,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 37.6 + index * 0.1,
        lng: -119.0 - index * 0.1,
      }),
    );

    const selection = selectFrom(candidates);
    expect(selection.selectedIds.length).toBeGreaterThan(0);
    expect(selection.notes.length).toBeGreaterThan(0);
    expect(selection.notes.join(' ')).toMatch(/^We picked \d+ place/);
  });

  it('never pre-selects a place whose own card tells the traveller not to go', () => {
    /**
     * THE BOARD AND THE PLAN, ON THE SAME PLACE, ON THE SAME SCREEN.
     *
     * Auto-pick accepts exactly one stop past the stated detour tolerance and
     * announces it — "one pick sits past your usual detour limit because it
     * earned the extra journey". The card for that stop was decided by
     * `worthDetourLabel`, which read the *fit band* to reach a *distance*
     * verdict, so a `stretch` at band `good` came back "Too far for this trip".
     * On the remote-road world that pair landed on the itinerary with its own
     * card telling the traveller not to go.
     *
     * The sweep is the whole grid rather than that one pair, because the fault
     * was a rule and not a cell: every distance class against every band, each
     * offered to auto-pick on its own so that acceptance is decided by the cell
     * under test rather than by whichever other cell reached a shared ceiling
     * first.
     */
    const classes: DetourClass[] = ['base', 'in_tolerance', 'stretch', 'too_far', 'unknown'];
    const bands: FitBand[] = ['top_pick', 'strong', 'good', 'optional', 'weak', 'not_workable'];

    const accepted: DiscoveryCandidate[] = [];
    for (const detourClass of classes) {
      for (const band of bands) {
        const candidate = cell(detourClass, band);
        if (selectFrom([candidate]).selectedIds.includes(candidate.place.id)) {
          accepted.push(candidate);
        }
      }
    }

    expect(
      accepted
        .filter((candidate) => candidate.worthDetour === 'too_far_for_this_trip')
        .map((candidate) => candidate.place.id),
      'auto-pick would put these on the trip while their cards say they are too far to visit',
    ).toEqual([]);
    /*
     * And the sweep has to have reached the case that matters. A run in which
     * auto-pick accepted no `stretch` at all would pass this vacuously, and the
     * one-stop-past-tolerance allowance is documented behaviour.
     */
    expect(
      accepted.some((candidate) => candidate.detourClass === 'stretch'),
      'the sweep never got auto-pick to accept a stop past the tolerance, so it proved nothing',
    ).toBe(true);
  });

  it('stays deterministic: the same board and profile give the same set', () => {
    const candidates = Array.from({ length: 9 }, (_, index) =>
      variant({
        id: `place-${index}`,
        minutes: 12 + index * 3,
        category: (['easy_walk', 'viewpoint', 'lake'] as PlaceCategory[])[index % 3]!,
        lat: 37.6 + index * 0.05,
        lng: -119.0 - index * 0.05,
      }),
    );

    expect(selectFrom(candidates).selectedIds).toEqual(selectFrom(candidates).selectedIds);
  });
});
