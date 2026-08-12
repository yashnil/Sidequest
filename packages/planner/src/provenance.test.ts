import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_ACCESS, easternSierraTravelMatrix } from '@sidequest/core/data';
import type { AccessDataset, AccessRule } from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { planTrip } from './plan';
import { MODELLED_WALK_KMH } from './modelled-walk';
import { buildScenario } from './testing/scenario';
import type { Itinerary, TravelSegment } from '@sidequest/core';

/**
 * Where every number on the timeline came from.
 *
 * This file exists because the product shipped a plan in which every travel time
 * a car-free traveller saw was the literal `10`. It was not a rounding error and
 * it was not a model: a schema required non-driving approaches to state a
 * duration, the live provider had no source for one, and so it wrote a constant
 * for every place on earth. The number then flowed into the day totals, the trip
 * totals and both travel-budget validators, and the interface labelled it
 * "estimated travel time", which a traveller reads as "roughly measured".
 *
 * Three thousand tests passed over that. None of them asked the only question
 * that would have caught it — *does this number correspond to anything?* — so
 * that is the question here, asked structurally rather than by example.
 */

/** Every travel segment on a plan, flattened, with the day it came from. */
function travelSegments(itinerary: Itinerary): { dayNumber: number; travel: TravelSegment }[] {
  return itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.travel !== undefined)
      .map((item) => ({ dayNumber: day.dayNumber, travel: item.travel! })),
  );
}

function matrixLeg(
  matrix: TravelTimeMatrix,
  fromId: string,
  toId: string,
): { minutes: number; km: number } | null {
  const from = matrix.ids.indexOf(fromId);
  const to = matrix.ids.indexOf(toId);
  if (from < 0 || to < 0) return null;
  return { minutes: matrix.minutes[from]![to]!, km: matrix.km[from]![to]! };
}

/**
 * Every duration an authored access dataset states, anywhere.
 *
 * A leg labelled `estimated` is legitimate exactly when a human-curated dataset
 * put that number there and named a source. Collecting them lets the test below
 * distinguish "a dataset said twelve minutes" from "something said ten minutes",
 * which is the whole distinction the product got wrong.
 */
function authoredDurations(dataset: AccessDataset): Set<number> {
  const stated = new Set<number>();
  for (const rule of dataset.rules) {
    if (typeof rule.approachMinutes === 'number') stated.add(rule.approachMinutes);
    stated.add(rule.walkMinutesFromDropOff);
    stated.add(rule.internalTransfer.minutes);
  }
  for (const service of dataset.services) {
    stated.add(service.rideMinutes);
    stated.add(service.transferBufferMinutes);
  }
  return stated;
}

describe('travel-time provenance', () => {
  it('gives every stated duration on the timeline a source that stands behind it', () => {
    const scenario = buildScenario();
    const result = planTrip(scenario);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matrix = scenario.matrix;
    const authored = authoredDurations(scenario.access);
    const segments = travelSegments(result.itinerary);
    expect(segments.length).toBeGreaterThan(0);

    for (const { dayNumber, travel } of segments) {
      const where = `day ${dayNumber}: ${travel.fromName} → ${travel.toName} (${travel.provenance})`;

      if (travel.provenance === 'unmeasured') {
        // The contract's own rule, restated at the point it matters.
        expect(travel.minutes, where).toBeNull();
        expect(travel.unmeasuredReason, where).toBeDefined();
        continue;
      }

      expect(travel.minutes, where).not.toBeNull();
      const minutes = travel.minutes!;

      if (travel.provenance === 'measured' || travel.provenance === 'modelled') {
        /**
         * A measured leg must equal the measurement, exactly.
         *
         * Not "be close to" — the matrix is the source, so any difference means
         * the number was computed from something else and then labelled with the
         * matrix's provenance. That is precisely what a fabricated constant
         * wearing a measured label looks like.
         *
         * One derivation is legitimate and has its own identity: a walk derived
         * from a road matrix's *distance* (never its time) for a traveller the
         * road time cannot serve. It must equal the distance at the stated
         * conservative pace — anything else under the `modelled` label is the
         * fabricated constant returning.
         */
        const leg = matrixLeg(matrix, travel.fromId, travel.toId);
        expect(leg, `${where}: claims to be measured but the matrix has no such pair`).not.toBeNull();
        if (travel.mode === 'walk' && matrix.mode === 'car') {
          expect(minutes, where).toBe(Math.ceil((leg!.km * 60) / MODELLED_WALK_KMH));
        } else {
          expect(minutes, where).toBe(leg!.minutes);
        }
        continue;
      }

      // `estimated` and `official` are authored values. They must actually
      // appear in the dataset that is supposed to have authored them.
      expect(authored.has(minutes), `${where}: ${minutes} min is in no authored dataset`).toBe(true);
    }
  });

  it('never sums a duration nobody measured into a day total', () => {
    const scenario = buildScenario();
    const result = planTrip(scenario);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const day of result.itinerary.days) {
      const unmeasured = day.items.filter(
        (item) => item.travel !== undefined && item.travel.minutes === null,
      );
      expect(day.totals.unmeasuredLegCount).toBe(unmeasured.length);

      const stated = day.items
        .filter((item) => item.travel !== undefined && item.travel.minutes !== null)
        .reduce((sum, item) => sum + item.travel!.minutes!, 0);
      // The day's travel total is the sum of what was stated, and nothing else.
      expect(day.totals.travelMinutes).toBe(stated);
    }
  });
});

/**
 * The shape the live provider actually emits.
 *
 * One permissive rule per place, walking approach, and — since the fix — no
 * stated allowance, because a routable location is not a walking time. These two
 * tests pin the two honest outcomes: measure it when the matrix is a walking
 * matrix, and refuse the place when it is not. Neither outcome is a number.
 */
function liveShapedAccess(dataset: AccessDataset, approachMinutes: number | null): AccessDataset {
  const rules: AccessRule[] = dataset.rules.map((rule) => ({
    ...rule,
    approachMode: 'walk' as const,
    approachMinutes,
    walkMinutesFromDropOff: 0,
    serviceRequirement: 'none' as const,
    privateVehicle: 'allowed' as const,
    ...(rule.serviceId !== undefined ? { serviceId: undefined } : {}),
  }));
  return { ...dataset, rules, services: [] };
}

/** The same corridor model, relabelled as what it would be if measured on foot. */
function footMatrix(): TravelTimeMatrix {
  const car = easternSierraTravelMatrix();
  return {
    ...car,
    mode: 'foot',
    provenance: { kind: 'measured', note: 'Test pedestrian matrix.', source: 'provenance.test.ts' },
  };
}

describe('a car-free traveller against a live-shaped access dataset', () => {
  it('measures the walk when the matrix was measured on foot, and copies it exactly', () => {
    const scenario = buildScenario({
      answers: { willDrive: false },
      access: liveShapedAccess(EASTERN_SIERRA_ACCESS, null),
    });
    const withFoot = { ...scenario, matrix: footMatrix() };
    const result = planTrip(withFoot);
    if (!result.ok) return; // A refusal is also honest; the assertion below is about numbers.

    const walks = travelSegments(result.itinerary).filter((s) => s.travel.mode === 'walk');
    for (const { travel } of walks) {
      if (travel.minutes === null) continue;
      const leg = matrixLeg(withFoot.matrix, travel.fromId, travel.toId);
      expect(leg).not.toBeNull();
      expect(travel.minutes).toBe(leg!.minutes);
      expect(travel.provenance).toBe('measured');
    }
  });

  it('never states a road time as a walk when the only matrix measures roads', () => {
    /**
     * The regression, stated as sharply as it can be — and then the repair.
     *
     * Car matrix, walking traveller, no authored allowance: there is no
     * *measured* duration available for any approach. Before the first fix this
     * produced a plan in which every leg read `10`. The first fix refused the
     * whole trip — honest about every leg and a dead end for the traveller,
     * because it turned "the compiler stored the wrong network" into "there is
     * no legal way in to anything", including stops a short stroll from the
     * base.
     *
     * The contract now: a near stop gets a **derived walk** — the road distance
     * at a deliberately slow pace, labelled `modelled`, bounded by the
     * traveller's own walking radius — and a far stop is refused by name with
     * the distance in the sentence. What must still never appear is the old
     * defect in either direction: a road *time* wearing a walking label, or a
     * constant unrelated to its endpoints.
     */
    const scenario = buildScenario({
      answers: { willDrive: false },
      access: liveShapedAccess(EASTERN_SIERRA_ACCESS, null),
    });
    const result = planTrip(scenario); // scenario.matrix is the car corridor model

    /*
     * The fixture region has stops within town-walking range of the base, so a
     * blanket refusal is now itself the defect this test exists to catch.
     */
    expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const walks = travelSegments(result.itinerary).filter((s) => s.travel.mode === 'walk');
    const stated = walks.map((s) => s.travel.minutes).filter((m): m is number => m !== null);
    expect(walks.length, 'a car-free plan with no walking legs at all').toBeGreaterThan(0);

    for (const { travel } of walks) {
      if (travel.minutes === null) {
        expect(travel.provenance).toBe('unmeasured');
        continue;
      }
      const leg = matrixLeg(scenario.matrix, travel.fromId, travel.toId);
      expect(leg, `${travel.fromName} → ${travel.toName} states ${travel.minutes} min`).not.toBeNull();
      /*
       * The derived-walk identity: the minutes are the road *distance* at the
       * conservative pace, never the road *time*, and the label says model.
       */
      expect(travel.provenance).toBe('modelled');
      expect(travel.minutes).toBe(Math.ceil((leg!.km * 60) / MODELLED_WALK_KMH));
    }

    /*
     * And the far stops came back refused by name rather than silently dropped
     * — a transport conflict the traveller can weigh, not a data gap to retry.
     */
    const conflicts = result.itinerary.unscheduled.filter(
      (entry) => entry.reasonCode === 'transport_mode_unavailable',
    );
    expect(conflicts.length, 'no far stop was refused as a transport conflict').toBeGreaterThan(0);
    for (const entry of conflicts) {
      expect(entry.reason).toMatch(/km by road|on foot/);
    }

    /**
     * And the shape of the old defect, caught directly: a single value repeated
     * across many different pairs is a constant, whatever it is labelled.
     */
    if (stated.length >= 3) {
      expect(new Set(stated).size, `every walking leg stated the same ${stated[0]} min`).toBeGreaterThan(1);
    }
  });
});
