import { describe, expect, it } from 'vitest';
import { journeyFromSegment, journeyWords, travelModeOfSegment } from '@sidequest/core';
import { reconcileTripDraft } from '../reconcile';
import { draftOf, fictionalWorld } from './harness';

/**
 * V12.1 §50 — THE AEGEAN `public_bus`.
 *
 * ── WHAT THE LIVE ACCEPTANCE FOUND ──────────────────────────────────────────
 *
 * The §50 island-hopping acceptance composed a Greek trip that got the hard
 * part right. Day 5 said, in the draft's own words:
 *
 *     move: { how: "ferry", via: "Athinios port to Naxos port" }
 *
 * — the crossing named, both ports named. And day 5's `baseId` stayed on
 * Santorini, because the traveller is on Santorini that morning. So the bed
 * changes between day 5 and day 6, the relocation leg is built on day **6**,
 * and day 6 declares no move of its own.
 *
 * The stated ferry was dropped, and the leg fell through to the matrix's
 * default: a **`public_bus`, with an estimated duration, across a hundred
 * kilometres of open water**.
 *
 * ── WHY IT MATTERS MORE THAN IT LOOKS ───────────────────────────────────────
 *
 * This is the Canadian Rockies defect wearing the opposite costume. There, a
 * boat leg was invented on dry land; here, a road leg was invented across the
 * sea. Both come from the same place — **an instrument's default outranking the
 * plan's own words** — and the V12.1 mode screen could not catch this one,
 * because a leg with no stated mode has nothing to screen.
 *
 * A draft that says which day it sails and a draft that says which night it
 * sleeps where may disagree by one day without either being wrong. What may not
 * happen is that the disagreement silently discards the mode.
 *
 * Deterministic: a fictional archipelago, no model, no provider.
 */

const AEGEAN = () =>
  fictionalWorld({
    name: 'Cycladia',
    center: { lat: 36.4, lng: 25.4 },
    places: [
      { name: 'Firastani', lat: 36.42, lng: 25.43, entityType: 'city' },
      { name: 'Naxia Town', lat: 37.1, lng: 25.38, entityType: 'city' },
      { name: 'Portara Gate', lat: 37.11, lng: 25.37, entityType: 'city' },
    ],
    basics: { startDate: '2026-06-06', endDate: '2026-06-09' },
  });

/** Days 1–2 on the first island, the crossing declared on day 2, the bed changing on day 3. */
const CROSSING_DRAFT = () =>
  draftOf({
    archetype: 'moving_route',
    bases: [
      { id: 'fira', name: 'Firastani', nights: 2 },
      { id: 'naxia', name: 'Naxia Town', nights: 2 },
    ],
    days: [
      { base: 'fira', anchors: [{ name: 'Firastani', role: 'core' }] },
      /* The day that says how it crosses — and still sleeps on the first island. */
      { base: 'fira', theme: 'Ferry day to Naxia', anchors: [], move: { how: 'ferry', via: 'Firastani port to Naxia port' } },
      { base: 'naxia', anchors: [{ name: 'Portara Gate', role: 'core' }] },
      { base: 'naxia', anchors: [] },
    ],
  });

describe('a crossing declared the day before the bed changes', () => {
  it('reaches the relocation leg as a ferry rather than as the matrix default', async () => {
    const world = AEGEAN();
    const result = await reconcileTripDraft({ draft: CROSSING_DRAFT(), context: world.context });
    const legs = result.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!));
    /*
     * The crossing is the day's **first** leg — the one that departs the previous
     * base — which is an `approach` to the arriving day's first stop. The
     * `transfer` at the end of that day is the short hop from the last stop to
     * the new bed, on the far island.
     */
    const crossing = legs.find((leg) => leg.fromName.includes('Firastani') && leg.toName.includes('Portara'));

    expect(crossing, `no transfer leaving Firastani among ${legs.map((l) => `${l.role}:${l.fromName}→${l.toName}`).join(', ')}`).toBeTruthy();
    expect(crossing!.hint).toBe('ferry');
    expect(crossing!.mode).toBe('ferry');
  });

  it('never puts a road mode on a sea crossing', () => {
    /* The exact shape that shipped: `public_bus`, estimated, across open water. */
    const leg = { mode: 'public_bus', hint: undefined, episodeMode: undefined } as never;
    expect(travelModeOfSegment(leg)).toBe('bus');
    /* And with the crossing's own word restored it is a ferry, which is a different journey entirely. */
    expect(travelModeOfSegment({ mode: 'ferry', hint: 'ferry' } as never)).toBe('ferry');
  });

  it('reads the restored crossing as a timetabled journey nobody has timed', async () => {
    const world = AEGEAN();
    const result = await reconcileTripDraft({ draft: CROSSING_DRAFT(), context: world.context });
    const crossing = result.itinerary.days
      .flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!))
      .find((leg) => leg.fromName.includes('Firastani') && leg.toName.includes('Portara'))!;

    const journey = journeyFromSegment(crossing, { routeCritical: true });
    expect(journey.mode).toBe('ferry');
    expect(journey.control).toBe('timetable_controlled');
    expect(journey.routing).toBe('timetable');

    /* §19 — and it says so in words, without inventing a sailing time. */
    const words = journeyWords(journey);
    expect(words.headline).toMatch(/ferry/i);
    expect(words.headline).not.toMatch(/\d{1,2}[:.]\d{2}/);
    expect(words.headline).not.toMatch(/allowance/i);
  });

  it('still prefers the day’s own move where it has one', async () => {
    /* The fallback must never outrank a statement the relocation day makes itself. */
    const world = AEGEAN();
    const draft = draftOf({
      archetype: 'moving_route',
      bases: [
        { id: 'fira', name: 'Firastani', nights: 2 },
        { id: 'naxia', name: 'Naxia Town', nights: 2 },
      ],
      days: [
        { base: 'fira', anchors: [{ name: 'Firastani', role: 'core' }] },
        { base: 'fira', anchors: [], move: { how: 'ferry', via: 'the slow boat' } },
        /* The relocating day says it flies; that is the more local statement and it wins. */
        { base: 'naxia', anchors: [{ name: 'Portara Gate', role: 'core' }], move: { how: 'flight', via: 'the island hop' } },
        { base: 'naxia', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const crossing = result.itinerary.days
      .flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!))
      .find((leg) => leg.fromName.includes('Firastani') && leg.toName.includes('Portara'))!;
    expect(crossing.hint).toBe('flight');
  });

  it('inherits onto exactly one leg, and never onto a day that is not relocating', async () => {
    /*
     * The bound that keeps this from becoming a leak. Only the leg that departs
     * the previous base may take the previous day's word; every other leg on
     * every other day keeps its own, so a trip does not acquire a fleet of
     * ferries from one declared crossing.
     */
    const world = AEGEAN();
    const result = await reconcileTripDraft({ draft: CROSSING_DRAFT(), context: world.context });
    const ferried = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'travel' && item.travel?.hint === 'ferry').map(() => day.dayNumber),
    );
    /* Day 3 is the day the bed changes; nothing before or after it crosses water. */
    expect(ferried).toEqual([3]);
  });
});

/**
 * V12.1 §50 — THE OTHER HALF, FOUND BY THE SAME RE-RUN.
 *
 * With the crossing restored, the Greek trip produced `ferry · Athens →
 * Acropolis`: a boat to a hilltop three kilometres from where it set off. The
 * day relocated Athens→Naxos and declared a ferry; V11 §M gives a relocation
 * day's first leg the move; and that day's first stop was still in Athens, so
 * the morning's sightseeing inherited the crossing.
 *
 * That is the Canadian Rockies defect one more time — a boat leg on dry land —
 * and the test is geographic rather than a threshold: a leg is the crossing only
 * if it ends nearer the new base than the old one.
 */
describe('a relocation day whose first stop is still at the origin', () => {
  const ATHENS_TO_ISLAND = () =>
    fictionalWorld({
      name: 'Hellenica',
      center: { lat: 37.6, lng: 24.5 },
      places: [
        { name: 'Athina', lat: 37.98, lng: 23.73, entityType: 'city' },
        { name: 'Akropolis Hill', lat: 37.97, lng: 23.72, entityType: 'city' },
        { name: 'Naxia Town', lat: 37.1, lng: 25.38, entityType: 'city' },
      ],
      basics: { startDate: '2026-06-06', endDate: '2026-06-08' },
    });

  const DRAFT = () =>
    draftOf({
      archetype: 'moving_route',
      bases: [
        { id: 'athina', name: 'Athina', nights: 1 },
        { id: 'naxia', name: 'Naxia Town', nights: 2 },
      ],
      days: [
        { base: 'athina', anchors: [{ name: 'Athina', role: 'core' }] },
        /* Sightsee in the capital in the morning, sail in the afternoon. */
        { base: 'naxia', theme: 'Acropolis, then the boat', anchors: [{ name: 'Akropolis Hill', role: 'core' }], move: { how: 'ferry', via: 'Piraeus to Naxia' } },
        { base: 'naxia', anchors: [] },
      ],
    });

  it('does not put the crossing on a stop that never leaves the origin', async () => {
    const world = ATHENS_TO_ISLAND();
    const result = await reconcileTripDraft({ draft: DRAFT(), context: world.context });
    const legs = result.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!));
    const toAcropolis = legs.find((leg) => leg.toName.includes('Akropolis'));
    expect(toAcropolis, 'the leg to the Acropolis exists').toBeTruthy();
    expect(toAcropolis!.hint, 'a boat to a hilltop in the same city').not.toBe('ferry');
    expect(toAcropolis!.mode).not.toBe('ferry');
  });

  it('puts it on the leg that actually reaches the island', async () => {
    const world = ATHENS_TO_ISLAND();
    const result = await reconcileTripDraft({ draft: DRAFT(), context: world.context });
    const legs = result.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!));
    const crossing = legs.find((leg) => leg.toName.includes('Naxia'));
    expect(crossing, `no leg reaching Naxia among ${legs.map((l) => `${l.fromName}→${l.toName}`).join(', ')}`).toBeTruthy();
    expect(crossing!.mode).toBe('ferry');
  });

  it('keeps the V11 behaviour where nothing is placed', async () => {
    /* No coordinates means no question to ask, and a guess would be worse than the rule it replaced. */
    const world = fictionalWorld({ name: 'Nowhere', center: { lat: 0, lng: 0 }, places: [], basics: { startDate: '2026-06-06', endDate: '2026-06-08' } });
    const draft = draftOf({
      archetype: 'moving_route',
      bases: [
        { id: 'a', name: 'Unplaced A', nights: 1 },
        { id: 'b', name: 'Unplaced B', nights: 2 },
      ],
      days: [
        { base: 'a', anchors: [{ name: 'Unmapped One', role: 'core' }] },
        { base: 'b', anchors: [{ name: 'Unmapped Two', role: 'core' }], move: { how: 'ferry', via: 'the crossing' } },
        { base: 'b', anchors: [] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context: world.context });
    const legs = result.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!));
    expect(legs.some((leg) => leg.hint === 'ferry')).toBe(true);
  });
});
