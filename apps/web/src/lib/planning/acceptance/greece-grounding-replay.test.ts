import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessWalk, walkPurposeOf, walkSuggestsMisplacement, type TravelSegment, type WalkContext } from '@sidequest/core';

/**
 * V12.2 §16 — THE GREEK LIVE TRIP, RE-JUDGED. NO MODEL CALL.
 *
 * `greece-dump` is the trip the third and last V12.1 Anthropic call produced on
 * 2026-09-15, persisted in full. It is the trip that carried **nine walking legs
 * over three kilometres**, the worst of them:
 *
 *     Naxos → Halki · 218.2 km straight line · 3,640 minutes on foot
 *
 * ── WHAT THIS REPLAYS, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * It replays the **decision layer** over the real recorded legs: every stored
 * leg's own geometry, role and episode go through `assessWalk` with this trip's
 * real context, and the verdicts are asserted. That is the layer the defect
 * lived in, and it needs nothing invented.
 *
 * It does not re-run the whole reconciler, which would need a recorded geocoder
 * this dump does not carry. The pipeline wiring — that a refused walk actually
 * loses its figure and its provenance — is covered where it belongs, against a
 * real reconcile, in `live-world-replays.test.ts` and `aegean-crossing.test.ts`.
 *
 * ── THE CONTEXT, TAKEN FROM THE TRIP ITSELF ─────────────────────────────────
 *
 * The traveller answered "boats and local transfers" and "not driving", so the
 * trip has **no ground mode to substitute** — which is precisely why V11 §11's
 * correction kept the walks rather than replacing them, and why the third
 * verdict (`refuse`) had to exist.
 */

const DUMP = '.claude-private/artifacts/v12.1/live/greece-dump';

interface StoredDay {
  day_number: number;
  items: { kind: string; item_json: { travel?: TravelSegment } }[];
}

const days = JSON.parse(readFileSync(`${DUMP}/days.json`, 'utf8')) as StoredDay[];

interface Leg {
  day: number;
  travel: TravelSegment;
  straightLineKm: number | null;
}

const legs: Leg[] = days.flatMap((day) =>
  day.items
    .filter((item) => item.kind === 'travel' && item.item_json.travel)
    .map((item) => ({ day: day.day_number, travel: item.item_json.travel!, straightLineKm: item.item_json.travel!.estimate?.straightLineKm ?? null })),
);

/** The trip as it actually was: island hopping by scheduled transport, no car. */
function contextFor(leg: Leg): WalkContext {
  return {
    segment: leg.travel,
    straightLineKm: leg.straightLineKm,
    mobilityPattern: 'scheduled_transport',
    maxWalkMinutes: 25,
  };
}

/** No car, no taxi arrangement, no driver: nothing to substitute a walk with. */
const SUBSTITUTABLE = false;

const walkLegs = legs.filter((leg) => leg.travel.mode === 'walk');

describe('the Greek trip as it shipped', () => {
  it('reproduces the nine long walking legs', () => {
    const long = walkLegs.filter((leg) => (leg.straightLineKm ?? 0) > 3);
    expect(long).toHaveLength(9);
  });

  it('reproduces the sixty-hour walk', () => {
    const halki = legs.find((leg) => leg.travel.toName === 'Halki')!;
    expect(halki.travel.mode).toBe('walk');
    expect(halki.straightLineKm).toBeGreaterThan(200);
    expect(halki.travel.minutes).toBeGreaterThan(3_000);
  });
});

describe('re-judged under V12.2', () => {
  it('refuses every long transfer walk, because this trip has no other way to cover them', () => {
    const long = walkLegs.filter((leg) => (leg.straightLineKm ?? 0) > 3);
    const verdicts = long.map((leg) => ({ leg, walk: assessWalk(contextFor(leg), SUBSTITUTABLE) }));
    const transfers = verdicts.filter(({ walk }) => walk.purpose !== 'activity_walk');
    expect(transfers.length).toBeGreaterThan(0);
    for (const { leg, walk } of transfers) {
      expect(walk.verdict, `day ${leg.day} ${leg.travel.fromName} → ${leg.travel.toName} (${leg.straightLineKm} km)`).toBe('refuse');
    }
  });

  it('leaves no unjustified transfer walk over three kilometres', () => {
    /* §16's PASS bar. Every long walk is either refused or is deliberately an activity. */
    const survivors = walkLegs.filter((leg) => {
      const walk = assessWalk(contextFor(leg), SUBSTITUTABLE);
      return (leg.straightLineKm ?? 0) > 3 && walk.verdict === 'plausible' && walk.purpose !== 'activity_walk';
    });
    expect(survivors.map((leg) => `day ${leg.day} ${leg.travel.fromName} → ${leg.travel.toName}`)).toEqual([]);
  });

  it('names the sixty-hour walk as a placement error rather than an ambitious day', () => {
    const halki = legs.find((leg) => leg.travel.toName === 'Halki')!;
    const walk = assessWalk(contextFor(halki), SUBSTITUTABLE);
    expect(walk.verdict).toBe('refuse');
    /* "Too far to walk" is true of 218 km and useless; the useful sentence is that the stop is not where we put it. */
    expect(walkSuggestsMisplacement(walk)).toBe(true);
  });

  it('touches none of the short walks the trip is made of', () => {
    const short = walkLegs.filter((leg) => (leg.straightLineKm ?? 0) > 0 && (leg.straightLineKm ?? 0) <= 1.5);
    expect(short.length).toBeGreaterThan(3);
    for (const leg of short) expect(assessWalk(contextFor(leg), SUBSTITUTABLE).verdict).toBe('plausible');
  });

  it('never refuses a walk nobody could place', () => {
    /* Several Greek legs are unmeasured because their stops never resolved. An unknown length refuses nothing. */
    const unplaced = walkLegs.filter((leg) => leg.straightLineKm === null);
    expect(unplaced.length).toBeGreaterThan(0);
    for (const leg of unplaced) expect(assessWalk(contextFor(leg), SUBSTITUTABLE).verdict).toBe('plausible');
  });
});

describe('the ferries the trip depends on are untouched', () => {
  it('keeps all three', () => {
    const ferries = legs.filter((leg) => leg.travel.mode === 'ferry');
    expect(ferries).toHaveLength(3);
    for (const ferry of ferries) expect(ferry.travel.hint).toBe('ferry');
  });

  it('still carries the Athens → Acropolis ferry, because this dump predates the fix for it', () => {
    /*
     * The defect is this test's *input*, exactly as the Canadian Rockies ferries
     * are in `journey-replay.test.ts`. This trip was composed by the third V12.1
     * call; the geographic crossing rule was written afterwards, from what this
     * very leg showed. Asserting the dump were clean would be asserting that a
     * recorded past is different from what it was.
     *
     * The fix is proven where a fix can be proven — against a real reconcile, in
     * `aegean-crossing.test.ts`, whose counterfactual was verified to fail.
     */
    const wrong = legs.filter((leg) => leg.travel.mode === 'ferry' && /acropolis/i.test(leg.travel.toName));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.day).toBe(2);
  });

  it('keeps every crossing honest about its timing', () => {
    for (const ferry of legs.filter((leg) => leg.travel.mode === 'ferry')) {
      expect(ferry.travel.provenance).toBe('unmeasured');
      expect(ferry.travel.minutes).toBeNull();
    }
  });
});

describe('what the walk classification says about this trip', () => {
  it('reads the beach-to-beach hop as a transfer on this trip, not an activity', () => {
    /*
     * Worth stating plainly, because it is the row most arguably wrong to
     * refuse. The plan does not name it as a walk to take — the draft states no
     * transport for it at all — so it is classified as what the plan says it is:
     * a way of arriving. §2's rule is that the *plan* decides this, not the
     * distance, and a plan that wanted a coastal walk can say so.
     */
    const hop = legs.find((leg) => leg.travel.fromName === 'Agios Prokopios' && leg.travel.toName === 'Plaka Beach')!;
    expect(hop.travel.hint).toBeUndefined();
    expect(walkPurposeOf(contextFor(hop))).toBe('transfer_walk');
  });

  it('would have kept it had the plan called it a walk inside a walking experience', () => {
    const hop = legs.find((leg) => leg.travel.fromName === 'Agios Prokopios' && leg.travel.toName === 'Plaka Beach')!;
    const asActivity: WalkContext = { ...contextFor(hop), statedAsActivity: true, mobilityPattern: 'walk_and_transit' };
    expect(assessWalk(asActivity, SUBSTITUTABLE).verdict).toBe('plausible');
  });
});
