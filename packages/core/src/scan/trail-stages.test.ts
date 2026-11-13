import { describe, expect, it } from 'vitest';
import { normalizeScanProposal } from './proposal';
import { assessTrailStage, civilDuskMinute, orderTrailStages, resolveTrailStages, trailBedChain, trailLimitsFor, type TrailStage } from './trail-stages';
import { fictionalTrailProposal, fictionalTrailRegion, TRAIL_VILLAGES } from './trail-fixture.test-support';
import { deriveBookings } from '../intelligence/booking-derive';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';

/**
 * POINT-TO-POINT TREKKING — a trail walked in stages from one bed to the next,
 * on a fictional four-stage valley trail (`trail-fixture.test-support.ts`).
 */

const nameOfBase = (assembled: ReturnType<typeof fictionalTrailRegion>, id: string) => assembled.region.bases.find((b) => b.id === id)?.name;

describe('the proposal reads a stage', () => {
  it('keeps stage order, the usual alternative and a stated unsuitability on a one-way walk only', () => {
    const read = normalizeScanProposal({
      bases: [{ name: 'Alder Gate', locality: 'Alder Gate', nightsHint: 1, why: 'x' }],
      candidates: [
        { name: 'A to B', locality: 'Alder Gate', kind: 'day_hike', walk: { shape: 'point_to_point', endName: 'B', stage: 2, unsuitable: 'Too long for children.', alternative: { mode: 'bus', note: 'The valley bus.', openMonths: [4, 5, 6] } } },
        { name: 'Loop', locality: 'Alder Gate', kind: 'day_hike', walk: { shape: 'loop', stage: 1, alternative: { mode: 'bus', note: 'x' } } },
        { name: 'Bad alt', locality: 'Alder Gate', kind: 'day_hike', walk: { shape: 'point_to_point', endName: 'C', alternative: { mode: 'helicopter', note: 'x' } } },
      ],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.proposal.candidates[0]!.walk).toEqual({ shape: 'point_to_point', endName: 'B', stage: 2, unsuitable: 'Too long for children.', alternative: { mode: 'bus', note: 'The valley bus.', openMonths: [4, 5, 6] } });
    expect(read.proposal.candidates[1]!.walk).toEqual({ shape: 'loop' });
    expect(read.proposal.candidates[2]!.walk?.alternative).toBeUndefined();
    expect(read.coerced).toContain('candidates[2].walk.alternative');
  });
});

describe('the stage sequence', () => {
  it('orders the stages so each starts where the last ended, whatever order they were proposed in, and uses measured figures first', () => {
    const { proposal, positions } = fictionalTrailProposal();
    const shuffled = [proposal.candidates[2]!, proposal.candidates[0]!, proposal.candidates[3]!, proposal.candidates[1]!].map((c) => ({ id: `p-${c.key}`, proposal: { ...c, walk: { ...c.walk!, stage: undefined } } }));
    const measured = new Map([[proposal.candidates[1]!.key, { km: 13.4, ascentM: 655 }]]);
    const { stages, dropped } = orderTrailStages({ candidates: shuffled, positionOf: (k) => positions.get(k)?.coordinates ?? null, measured });
    expect(dropped).toEqual([]);
    expect(stages.map((s) => s.name)).toEqual(['Alder Gate to Brackenford', 'Brackenford to Corrie Mill', 'Corrie Mill to Dunmere', 'Dunmere to Eskwater']);
    expect(stages[1]).toMatchObject({ km: 13.4, ascentM: 655, distanceBasis: 'measured', walkMinutes: 244 });
    expect(stages[0]).toMatchObject({ km: 12, ascentM: 500, distanceBasis: 'proposal', walkMinutes: 210 });
  });

  it('leaves out a stage whose end could not be placed, and one that joins nothing — unknown, not invented', () => {
    const { proposal, positions } = fictionalTrailProposal();
    positions.delete(`${proposal.candidates[3]!.key}#end`);
    const candidates = proposal.candidates.slice(0, 4).map((c) => ({ id: `p-${c.key}`, proposal: c }));
    const stray = { id: 'p-stray', proposal: { ...proposal.candidates[0]!, key: 'stray', name: 'Somewhere else entirely' } };
    positions.set('stray', { coordinates: { lat: 35, lng: 137 }, method: 'places', provider: 't', approximate: false });
    positions.set('stray#end', { coordinates: { lat: 35.05, lng: 137.05 }, method: 'places', provider: 't', approximate: false });
    const { stages, dropped } = orderTrailStages({ candidates: [...candidates, stray], positionOf: (k) => positions.get(k)?.coordinates ?? null });
    expect(stages).toHaveLength(3);
    expect(dropped.map((d) => d.name).sort()).toEqual(['Dunmere to Eskwater', 'Somewhere else entirely']);
    expect(dropped.find((d) => d.name === 'Dunmere to Eskwater')!.reason).toMatch(/could not be placed/);
  });
});

describe('a walkable day for this party', () => {
  const stage = (walkMinutes: number, ascentM: number | null = 300): Pick<TrailStage, 'walkMinutes' | 'ascentM'> => ({ walkMinutes, ascentM });
  it('has explicit limits: about six hours for a light or family trip, eight for fit adults asking for intense days', () => {
    expect(trailLimitsFor({ intensity: 'light', children: 0, youngChildren: false, reducedMobility: false })).toMatchObject({ walkMinutes: 360, ascentM: 600 });
    expect(trailLimitsFor({ intensity: 'intense', children: 0, youngChildren: false, reducedMobility: false })).toMatchObject({ walkMinutes: 480, ascentM: 1500 });
    expect(trailLimitsFor({ intensity: 'intense', children: 2, youngChildren: false, reducedMobility: false })).toMatchObject({ walkMinutes: 360, ascentM: 800 });
    expect(trailLimitsFor({ intensity: 'moderate', children: 1, youngChildren: true, reducedMobility: false })).toMatchObject({ walkMinutes: 300, ascentM: 500 });
  });

  it('finishes before civil dusk with a margin: a long walk late in the year cannot start early enough', () => {
    const limits = trailLimitsFor({ intensity: 'intense', children: 0, youngChildren: false, reducedMobility: false });
    const ok = assessTrailStage(stage(400), limits, { month: 10, duskMinute: 17 * 60 + 40, startMinute: 510 });
    expect(ok.ok).toBe(true);
    /* 17:40 dusk − 60 min margin − 400 min × 1.15 = 08:20 at the latest. */
    expect(ok.latestStartMinute).toBe(17 * 60 + 40 - 60 - 460);
    const dark = assessTrailStage(stage(470), limits, { month: 12, duskMinute: 16 * 60 + 30, startMinute: 510 });
    expect(dark.ok).toBe(false);
    expect(dark.problems.map((p) => p.code)).toEqual(['after_dusk']);
    /* Unknown dusk never fails a stage. */
    expect(assessTrailStage(stage(470), limits, { month: 12, duskMinute: null, startMinute: 510 }).ok).toBe(true);
  });

  it('is closed only when the proposal said so for that month (unknown ≠ closed)', () => {
    const limits = trailLimitsFor({ intensity: 'moderate', children: 0, youngChildren: false, reducedMobility: false });
    expect(assessTrailStage({ ...stage(200), openMonths: [4, 5, 6, 7, 8, 9, 10] }, limits, { month: 12, duskMinute: null, startMinute: 510 }).problems.map((p) => p.code)).toEqual(['closed']);
    expect(assessTrailStage(stage(200), limits, { month: 12, duskMinute: null, startMinute: 510 }).ok).toBe(true);
  });

  it('computes civil dusk from the sun, and says nothing without a trusted zone', () => {
    const dusk = civilDuskMinute(TRAIL_VILLAGES.dunmere.at, '2026-10-13', 'Asia/Tokyo');
    expect(dusk).not.toBeNull();
    expect(dusk!).toBeGreaterThan(17 * 60);
    expect(dusk!).toBeLessThan(18 * 60 + 15);
    expect(civilDuskMinute(TRAIL_VILLAGES.dunmere.at, '2026-10-13', 'UTC')).toBeNull();
  });
});

describe('a stage that does not suit is split, replaced or said so', () => {
  const limits = trailLimitsFor({ intensity: 'moderate', children: 0, youngChildren: false, reducedMobility: false });
  const beds = Object.values(TRAIL_VILLAGES).map((v, i) => ({ id: `bed-${i}`, name: v.name, coordinates: v.at }));
  const long: TrailStage = { placeId: 'p3', key: 'c3', name: 'Corrie Mill to Dunmere', order: 3, start: TRAIL_VILLAGES.corrie.at, end: TRAIL_VILLAGES.dunmere.at, km: 30, ascentM: 1600, distanceBasis: 'proposal', walkMinutes: 560 };
  const context = () => ({ month: 10, duskMinute: null, startMinute: 510 });

  it('splits at an intermediate overnight on the way, when both halves suit', () => {
    const resolved = resolveTrailStages({ stages: [long], limits, beds, contextFor: context });
    expect(resolved.map((s) => [s.name, s.resolution, s.part])).toEqual([
      ['Corrie Mill to Dunmere (to Fernhollow)', 'split', 1],
      ['Corrie Mill to Dunmere (from Fernhollow)', 'split', 2],
    ]);
    expect(resolved[0]!.toBaseId).toBe(resolved[1]!.fromBaseId);
    expect(resolved[1]!.placeId).toBe('p3~2');
    expect(resolved[0]!.note).toMatch(/Split with a night in Fernhollow: walked in one day it is about 9 h 20 of walking/);
  });

  it('with no village between, takes the usual bus the proposal named — stated, never invented', () => {
    const noFern = beds.filter((b) => b.name !== 'Fernhollow');
    const withBus = { ...long, alternative: { mode: 'bus' as const, note: 'The valley bus runs from Corrie Mill to Dunmere.' } };
    const [bus] = resolveTrailStages({ stages: [withBus], limits, beds: noFern, contextFor: context });
    expect(bus!.resolution).toBe('alternative');
    expect(bus!.note).toMatch(/so take the bus instead: The valley bus runs from Corrie Mill to Dunmere\./);
    const [none] = resolveTrailStages({ stages: [long], limits, beds: noFern, contextFor: context });
    expect(none!.resolution).toBe('unresolved');
    expect(none!.note).toMatch(/No usual alternative was proposed/);
    /* A seasonal bus that does not run that month is no alternative (but an unknown season would be). */
    const [winter] = resolveTrailStages({ stages: [{ ...withBus, alternative: { ...withBus.alternative, openMonths: [4, 5, 6] } }], limits, beds: noFern, contextFor: context });
    expect(winter!.resolution).toBe('unresolved');
  });

  it('a closed section is not split, it is covered the usual way', () => {
    const closed = { ...long, km: 12, ascentM: 400, walkMinutes: 200, openMonths: [4, 5, 6], alternative: { mode: 'skip' as const, note: 'Most walkers skip this section out of season.' } };
    const [r] = resolveTrailStages({ stages: [closed], limits, beds, contextFor: context });
    expect(r!.resolution).toBe('alternative');
    expect(r!.note).toMatch(/skip this section/);
  });

  it('the beds a run of stages joins, in order', () => {
    const { proposal, positions } = fictionalTrailProposal();
    const { stages } = orderTrailStages({ candidates: proposal.candidates.map((c) => ({ id: `p-${c.key}`, proposal: c })), positionOf: (k) => positions.get(k)?.coordinates ?? null });
    const resolved = resolveTrailStages({ stages, limits, beds, contextFor: context });
    expect(trailBedChain(resolved).chain.map((id) => beds.find((b) => b.id === id)!.name)).toEqual(['Alder Gate', 'Brackenford', 'Corrie Mill', 'Dunmere', 'Eskwater']);
  });
});

describe('the stays follow the trail', () => {
  it('sleeps at every stage end in walking order, each move the day’s walk, a rest day by the hot spring, and the way home estimated', () => {
    const assembled = fictionalTrailRegion();
    const portfolio = assembled.region.basePortfolio!;
    expect(portfolio.bases.map((b) => [b.baseName, b.nights])).toEqual([
      ['Alder Gate', 1],
      ['Brackenford', 1],
      ['Corrie Mill', 1],
      ['Dunmere', 2],
      ['Eskwater', 1],
    ]);
    const trail = portfolio.decision!.trail!;
    expect(trail.followed).toBe(true);
    /* One stage per walking day: days 2, 3, 4 and 6 (day 5 is the rest day in Dunmere). */
    expect(trail.stages.map((s) => [s.order, s.resolution, s.dayNumber, s.fromName, s.toName])).toEqual([
      [1, 'walk', 2, 'Alder Gate', 'Brackenford'],
      [2, 'walk', 3, 'Brackenford', 'Corrie Mill'],
      [3, 'walk', 4, 'Corrie Mill', 'Dunmere'],
      [4, 'walk', 6, 'Dunmere', 'Eskwater'],
    ]);
    expect(trail.restBaseIds.map((id) => nameOfBase(assembled, id))).toEqual(['Dunmere']);
    expect(trail.stages.every((s) => s.latestStartMinute !== undefined && s.duskMinute !== undefined && s.latestStartMinute >= 7 * 60)).toBe(true);
    expect(trail.returnLeg).toMatchObject({ fromName: 'Eskwater', basis: 'estimated' });
    expect(portfolio.decision!.sentence).toMatch(/^Following the trail from bed to bed: Alder Gate → Brackenford → Corrie Mill → Dunmere → Eskwater\. Each move is that day's walk, with the bags sent ahead, and a rest day in Dunmere/);
    /* The stage places carry their place in the sequence and their walking day on the clock. */
    const first = assembled.region.places.find((p) => p.name === 'Alder Gate to Brackenford')!;
    expect(first.tags).toEqual(expect.arrayContaining(['walk:point_to_point', 'trail-stage:1', 'walk-basis:proposal']));
    expect(first.typicalDurationMinutes).toBe(Math.round(210 * 1.15));
  });

  it('splits a too-long stage at the village between and sleeps there', () => {
    const assembled = fictionalTrailRegion({ longThirdStage: true, intermediateVillage: true, dates: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'] });
    const trail = assembled.region.basePortfolio!.decision!.trail!;
    expect(assembled.region.basePortfolio!.bases.map((b) => b.baseName)).toEqual(['Alder Gate', 'Brackenford', 'Corrie Mill', 'Fernhollow', 'Dunmere', 'Eskwater']);
    expect(trail.stages.filter((s) => s.resolution === 'split').map((s) => [s.name, s.dayNumber])).toEqual([
      ['Corrie Mill to Dunmere (to Fernhollow)', 4],
      ['Corrie Mill to Dunmere (from Fernhollow)', 5],
    ]);
    /* The second half is a place of its own, starting at Fernhollow. */
    const second = assembled.region.places.find((p) => p.name === 'Corrie Mill to Dunmere (from Fernhollow)')!;
    expect(second.coordinates).toEqual(TRAIL_VILLAGES.fern.at);
    expect(second.tags).toEqual(expect.arrayContaining(['walk:point_to_point', 'trail-stage:4']));
  });

  it('replaces a too-long stage with its stated bus when there is nowhere to break it', () => {
    const assembled = fictionalTrailRegion({ longThirdStage: true, busAlternative: true });
    const trail = assembled.region.basePortfolio!.decision!.trail!;
    const third = trail.stages.find((s) => s.order === 3)!;
    expect(third.resolution).toBe('alternative');
    expect(third.dayNumber).toBe(4);
    expect(third.note).toMatch(/take the bus instead/);
    expect(assembled.region.basePortfolio!.bases.map((b) => b.baseName)).toEqual(['Alder Gate', 'Brackenford', 'Corrie Mill', 'Dunmere', 'Eskwater']);
  });

  it('a traveller who asked to stay put keeps one base, and the record says why', () => {
    const assembled = fictionalTrailRegion({ moveTolerance: 'stay_put' }, { maxBaseChanges: 0 });
    expect(assembled.region.basePortfolio!.bases).toHaveLength(1);
    const trail = assembled.region.basePortfolio!.decision!.trail!;
    expect(trail.followed).toBe(false);
    expect(trail.gap).toMatch(/keep one place to sleep/);
  });

  it('a trail trip whose proposal gave no stages falls back honestly, with the gap stated — never a fake trek', () => {
    const assembled = fictionalTrailRegion({ noStages: true });
    const trail = assembled.region.basePortfolio!.decision!.trail!;
    expect(trail.followed).toBe(false);
    expect(trail.stages).toEqual([]);
    expect(trail.gap).toMatch(/no trail stages whose ends could be placed/);
    expect(assembled.region.basePortfolio!.decision!.sentence).not.toMatch(/Following the trail/);
  });
});

describe('what a followed trail books', () => {
  it('a luggage transfer for the walking days and a bed at every stage end — no hire car', () => {
    const assembled = fictionalTrailRegion();
    const portfolio = assembled.region.basePortfolio!;
    const dates = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const stayOn = (day: number) => {
      let night = 0;
      for (const b of portfolio.bases) {
        night += b.nights;
        if (day <= night) return b;
      }
      return portfolio.bases[portfolio.bases.length - 1]!;
    };
    const itinerary = {
      tripId: 't',
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      days: dates.map((date, i) => ({ dayNumber: i + 1, date, baseId: stayOn(i + 1).baseId, baseName: stayOn(i + 1).baseName, items: [] })),
      transportStrategy: { primaryMode: 'walk', headline: '', rationale: [], totals: { driveKm: 0 } },
      package: {
        bases: portfolio.bases.map((b) => ({ id: b.baseId, name: b.baseName, nights: b.nights })),
        episodes: [],
        anchors: [],
        backups: [],
        transport: { summary: 'On foot.' },
        planning: { mode: 'planner', weatherMoves: [], mustConflicts: [], stay: portfolio.decision },
      },
    } as unknown as Itinerary;
    const needs = deriveBookings({ itinerary, pkg: itinerary.package as TripPackage, profile: { transport: { willDrive: true } } as unknown as TravelerProfile, legs: [], booked: [], daysUntilTrip: 90, remoteBaseIds: new Set() });
    const luggage = needs.find((n) => n.id === 'booking:luggage-transfer')!;
    expect(luggage).toMatchObject({ kind: 'shuttle', necessity: 'required', dayNumber: 2, title: 'Luggage transfer between the inns (days 2, 3, 4 and 6)' });
    expect(needs.filter((n) => n.id.startsWith('booking:lodging:')).map((n) => n.title)).toEqual(['1 night in Alder Gate', '1 night in Brackenford', '1 night in Corrie Mill', '2 nights in Dunmere', '1 night in Eskwater']);
    expect(needs.some((n) => n.kind === 'rental_vehicle')).toBe(false);
  });
});
