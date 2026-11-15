import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryCandidate, Trip } from '@sidequest/core';
import { gappedTrailRegion, GAPPED_DATES, type GappedTrailOptions } from '../../../../../packages/core/src/scan/gapped-trail-fixture.test-support';
import { composeWithPlanner, plannerFallbackReasonOf } from './planner-composer';
import { trailInversions } from './structure-planner';
import { defaultProfileFor } from './default-profile';
import type { RegionContext } from '../region';

/**
 * A TRAIL WALKED IN ITS ORDER, HOWEVER THE PROPOSAL NAMED IT — through the
 * scan's stays and the planner, on a pilgrimage trail the proposal names only
 * in pieces (`gapped-trail-fixture.test-support.ts`, shaped on the recorded
 * live Kumano boards). Live runs of the same request slept one base with a hire
 * car, then ten nights in one village with the trail's sections as day trips
 * in no order (its first stage on day 7). Whatever the variation — stage
 * numbers or none, another proposal order, fewer beds, the middle named as one
 * stage or two, a family with children — the days walk the trail forward.
 */

vi.mock('server-only', () => ({}));

function planned(options: GappedTrailOptions = {}) {
  const assembled = gappedTrailRegion(options);
  const compiled = assembled.region;
  const dates = [...GAPPED_DATES];
  const children = options.party?.children ?? 0;
  const trip: Trip = {
    id: 'gapped-trail-trip',
    basics: { mode: 'known_destination', destinationInput: 'The Pilgrimage Trail', regionId: 'dynamic', startDate: dates[0]!, endDate: dates[dates.length - 1]!, arrivalTime: '12:00', departureTime: '15:00', arrivalPrecision: 'exact', departurePrecision: 'exact', adults: 2, children, travelerNeeds: [] },
    status: 'draft',
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  } as Trip;
  const profile = { ...defaultProfileFor(trip, null), dailyIntensity: 'moderate' as const };
  const region = {
    region: compiled.region,
    places: compiled.places,
    access: compiled.access,
    hours: compiled.operatingHours,
    weather: null,
    food: null,
    matrix: compiled.travelTimes,
    transit: undefined,
    scheduledNetwork: null,
    baseId: compiled.bases.find((b) => b.id === compiled.primaryBaseId)!.routingId,
    basePortfolio: compiled.basePortfolio,
    months: [3],
    dates,
    compiled,
  } as unknown as RegionContext;
  const candidates = compiled.places.map((place) => ({ place, fit: { score: 75, blockers: [] } }) as unknown as DiscoveryCandidate);
  const composed = composeWithPlanner({ trip, profile, region, candidates, selections: [], extras: null, destinationName: 'The Pilgrimage Trail', carAvailable: true, maxDailyTravelMinutes: 150 });
  return { composed, compiled, trail: compiled.basePortfolio!.decision!.trail! };
}

/** The trail sections on each day, as (day, order) pairs, in day order. */
function sectionsByDay(composed: ReturnType<typeof planned>['composed']): { day: number; order: number; name: string }[] {
  return composed.plan.days.flatMap((d) => d.stops.filter((s) => s.candidate.trailOrder !== undefined).map((s) => ({ day: d.dayNumber, order: s.candidate.trailOrder!, name: s.candidate.name })));
}

const VARIATIONS: [string, GappedTrailOptions][] = [
  ['the recorded shape: two hot-spring villages proposed as beds', {}],
  ['no stage numbers, proposed out of order', { stageMarks: false, shuffled: true }],
  ['only one place to sleep proposed', { beds: 'one' }],
  ['a bed at every stage end', { beds: 'stage_ends' }],
  ['the middle named as two stages', { middleInTwo: true }],
  ['without the short walk that ends where the last section ends', { noOverlap: true }],
];

describe('a trail the proposal names in pieces is still walked in order, inn to inn', () => {
  for (const [label, options] of VARIATIONS) {
    it(`adults — ${label}`, () => {
      const { composed, trail } = planned(options);
      expect(trail.followed).toBe(true);
      const walked = trail.stages.filter((s) => s.dayNumber !== undefined);
      /* Every section of the trail is a move, in order, on strictly later days. */
      expect(walked.length).toBe(trail.stages.length);
      expect(walked.map((s) => s.order)).toEqual(walked.map((_, i) => i + 1));
      const days = walked.map((s) => s.dayNumber!);
      expect(days).toEqual([...days].sort((a, b) => a - b));
      expect(new Set(days).size).toBe(days.length);
      /* The trail starts at its start and ends at its end, whatever order the proposal gave. */
      expect(trail.stages[0]!.name).toMatch(/^Takijiri/);
      expect(trail.stages[trail.stages.length - 1]!.name).toMatch(/^Koguchi/);
      /* Each stage leaves from the bed the last one reached; a gap in the trail is ridden from that bed. */
      for (let i = 1; i < trail.stages.length; i += 1) expect(trail.stages[i]!.fromBaseId).toBe(trail.stages[i - 1]!.toBaseId);
      expect(trail.stages.filter((s) => s.gapBeforeKm !== undefined).map((s) => s.name.split(' ')[0])).toEqual(['Chikatsuyu', 'Koguchi']);
      /* The short walk that ends where the final section ends is not walked again. */
      expect(trail.stages.some((s) => /^Daimonzaka/.test(s.name))).toBe(false);
      /* The beds follow the stages: one stay per stage end, in walking order. */
      const bases = composed.plannerInput.bases.map((b) => b.name);
      expect(bases.length).toBe(trail.stages.length + 1);
      expect(new Set(bases).size).toBe(bases.length);
      /* The planned days walk the trail forward: every section on its move day, none out of order. */
      const sections = sectionsByDay(composed);
      expect(trailInversions(composed.plan.days.map((d) => d.stops.map((s) => s.candidate)))).toBe(0);
      for (const s of walked) expect(sections.find((x) => x.name === s.name)?.day).toBe(s.dayNumber);
      /* No hire car on a trail walked inn to inn, and no handing the trip to the composition fallback. */
      expect(composed.plannerInput.carAvailable).toBe(false);
      expect(plannerFallbackReasonOf(composed)).toBeNull();
      /* The gaps are stated on their days. */
      const gapNotes = composed.plan.dayNotes.filter((n) => n.code === 'trail_stage' && /where the walk resumes/.test(n.note));
      expect(gapNotes).toHaveLength(2);
    });
  }
});

describe('a family with children: the same order, with the adaptation stated', () => {
  for (const [label, options] of VARIATIONS) {
    it(`two adults and two children — ${label}`, () => {
      const { composed, trail } = planned({ ...options, party: { children: 2 } });
      expect(trail.followed).toBe(true);
      expect(trail.limits).toMatchObject({ walkMinutes: 360, ascentM: 800 });
      /* Climbing beyond the family limit is never walked as written: split, ridden, or left to decide, and said. */
      for (const s of trail.stages) {
        if ((s.ascentM ?? 0) > 800) expect(s.resolution).not.toBe('walk');
        if (s.resolution === 'unresolved' || s.resolution === 'alternative') expect(s.note).toBeTruthy();
      }
      expect(trail.adaptation).toMatch(/^Planned for moderate days, children: at most about 6 h of walking and 800 m of climbing a day, walked in the trail’s order from bed to bed/);
      expect(composed.plan.dayNotes.filter((n) => n.code === 'trail_adaptation')).toHaveLength(1);
      /* The order holds exactly as for adults. */
      const days = trail.stages.map((s) => s.dayNumber!);
      expect(days.every((d) => d !== undefined)).toBe(true);
      expect(days).toEqual([...days].sort((a, b) => a - b));
      expect(trail.stages[0]!.name).toMatch(/^Takijiri/);
      expect(trailInversions(composed.plan.days.map((d) => d.stops.map((s) => s.candidate)))).toBe(0);
    });
  }

  it('the usual bus round the steep final section is taken, and said, rather than leaving the day undecided', () => {
    const { trail } = planned({ party: { children: 2 }, finalBus: true });
    const last = trail.stages[trail.stages.length - 1]!;
    expect(last.resolution).toBe('alternative');
    expect(last.note).toMatch(/take the bus instead/);
    expect(trail.adaptation).toMatch(/1 stage covered by the usual transport instead of on foot/);
  });
});

describe('a trail walked from one base is still walked in order', () => {
  it('a traveller who keeps one bed gets the sections as day walks in the trail’s order, each day saying which section it is', () => {
    const { composed, trail } = planned({ moveTolerance: 'stay_put' });
    expect(trail.followed).toBe(false);
    expect(trail.gap).toMatch(/in the trail’s order/);
    expect(composed.plannerInput.bases).toHaveLength(1);
    const sections = sectionsByDay(composed);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(trailInversions(composed.plan.days.map((d) => d.stops.map((s) => s.candidate)))).toBe(0);
    const orders = sections.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const notes = composed.plan.dayNotes.filter((n) => n.code === 'trail_stage' && /^Section \d+ of \d+ of the trail, walked in its order/.test(n.note));
    expect(notes.map((n) => n.dayNumber)).toEqual(sections.map((s) => s.day));
  });
});
