import { describe, expect, it } from 'vitest';
import { chooseStays, DEFAULT_STAY_TRAVELLER, moveCostFor, type StayObjectiveInput, type StayTraveller } from './stay-objective';

/**
 * The structure of a trip is arithmetic over geometry and the traveller. Each
 * geometry here is built to separate one question, and the same board must be
 * able to give different travellers different answers.
 */

type Point = { x: number; y: number };
/** 1 unit = 1 km; 50 km/h door to door with a 5-minute floor. */
const drive = (a: Point, b: Point) => Math.round(Math.max(5, (Math.hypot(a.x - b.x, a.y - b.y) / 50) * 60));

interface Geometry {
  bases: Record<string, Point>;
  places: Record<string, Point>;
  crossing?: (a: Point, b: Point) => number;
  /** Minutes multiplier for travel: public transport is slower door to door. */
  scale?: number;
}

function input(g: Geometry, nights: number, traveller: Partial<StayTraveller> = {}, maxBaseChanges = 4): StayObjectiveInput {
  const at = (id: string) => g.bases[id] ?? g.places[id]!;
  return {
    bases: Object.keys(g.bases).map((id) => ({ id, name: id })),
    places: Object.keys(g.places).map((id) => ({ id, durationMinutes: 120, weight: 1 })),
    minutes: (a, b) => (a === b ? 0 : Math.round(drive(at(a), at(b)) * (g.scale ?? 1)) + (g.crossing?.(at(a), at(b)) ?? 0)),
    nights,
    maxBaseChanges,
    traveller: { ...DEFAULT_STAY_TRAVELLER, ...traveller },
  };
}

const around = (label: string, c: Point, n: number, r = 8): Record<string, Point> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${label}${i}`, { x: c.x + Math.cos(i * 2.4) * r * (0.4 + (i % 3) * 0.3), y: c.y + Math.sin(i * 2.4) * r * (0.4 + (i % 3) * 0.3) }]));

const names = (input_: StayObjectiveInput) => chooseStays(input_).stays.map((s) => s.baseId);

const compact: Geometry = { bases: { town: { x: 0, y: 0 }, harbour: { x: 10, y: 6 } }, places: { ...around('a', { x: 0, y: 0 }, 10), ...around('b', { x: 10, y: 6 }, 8) } };
const coast: Geometry = { bases: { a: { x: 0, y: 0 }, b: { x: 90, y: 0 }, c: { x: 180, y: 0 }, d: { x: 270, y: 0 } }, places: { ...around('pa', { x: 0, y: 0 }, 6, 14), ...around('pb', { x: 90, y: 0 }, 6, 14), ...around('pc', { x: 180, y: 0 }, 6, 14), ...around('pd', { x: 270, y: 0 }, 6, 14) } };
const twin: Geometry = { bases: { west: { x: 0, y: 0 }, east: { x: 170, y: 0 } }, places: { ...around('w', { x: 0, y: 0 }, 10, 10), ...around('e', { x: 170, y: 0 }, 10, 10) } };
const hub: Geometry = {
  bases: { hub: { x: 0, y: 0 }, spoke1: { x: 45, y: 0 }, spoke2: { x: -30, y: 40 } },
  places: { ...around('h', { x: 0, y: 0 }, 8, 5), ...around('s', { x: 45, y: 0 }, 3, 5), ...around('t', { x: -30, y: 40 }, 3, 5), ...around('u', { x: 0, y: -50 }, 3, 5) },
};
const ferry: Geometry = { bases: { port: { x: 0, y: 0 }, isle: { x: 40, y: 0 } }, places: { ...around('m', { x: 0, y: 0 }, 9, 8), ...around('i', { x: 40, y: 0 }, 8, 6) }, crossing: (a, b) => ((a.x > 20) !== (b.x > 20) ? 75 : 0) };

describe('the stay objective on geometries', () => {
  it('a compact cluster keeps one base, even for somebody happy to move', () => {
    expect(names(input(compact, 6))).toHaveLength(1);
    expect(names(input(compact, 6, { moveTolerance: 'move_freely' }))).toHaveLength(1);
  });

  it('a long linear coast moves, and moves less for a family than for someone who does not mind', () => {
    const freely = names(input(coast, 8, { moveTolerance: 'move_freely' }));
    const family = names(input(coast, 8, { youngChildren: true, children: 2, pace: 'slow' }));
    expect(freely.length).toBeGreaterThanOrEqual(2);
    expect(family.length).toBeLessThanOrEqual(freely.length);
  });

  it('two clusters three hours apart: both on a week, one on a weekend', () => {
    expect(names(input(twin, 7))).toHaveLength(2);
    expect(names(input(twin, 2))).toHaveLength(1);
  });

  it('hub and spoke stays at the hub while the spokes are day trips', () => {
    expect(names(input(hub, 7))).toEqual(['hub']);
  });

  it('a low daily travel limit can earn a base the same board did not need', () => {
    const relaxed = input(hub, 7, { maxDailyTravelMinutes: 240 });
    const tight = input(hub, 7, { maxDailyTravelMinutes: 60, moveTolerance: 'move_freely' });
    expect(names(tight).length).toBeGreaterThanOrEqual(names(relaxed).length);
    expect(chooseStays(tight).decision.chosen.placesSeen).toBeGreaterThan(0);
  });

  it('an island behind a ferry earns a stay, and the ferry is on the bill', () => {
    const choice = chooseStays(input(ferry, 6));
    expect(choice.stays.map((s) => s.baseId)).toEqual(['port', 'isle']);
    expect(choice.decision.chosen.transferMinutes).toBeGreaterThan(75);
  });

  it('slower transport changes the structure on the same board', () => {
    const anHourApart: Geometry = { bases: { a: { x: 0, y: 0 }, b: { x: 55, y: 0 } }, places: { ...around('p', { x: 0, y: 0 }, 5, 6), ...around('q', { x: 55, y: 0 }, 3, 6) } };
    const byCar = input(anHourApart, 7, { maxDailyTravelMinutes: 180 });
    const byBus = input({ ...anHourApart, scale: 2.2 }, 7, { carAvailable: false, maxDailyTravelMinutes: 180 });
    expect(names(byCar)).toHaveLength(1);
    expect(names(byBus)).toHaveLength(2);
  });
});

describe('the stay objective’s guarantees', () => {
  it('never exceeds the traveller’s cap, and says what the cap cost', () => {
    const one = chooseStays(input(twin, 7, { moveTolerance: 'stay_put' }, 0));
    expect(one.stays).toHaveLength(1);
    expect(one.decision.sentence).toMatch(/as you asked/);
    expect(one.decision.alternatives.some((a) => a.moves === 1)).toBe(true);
    expect(names(input(coast, 8, { moveTolerance: 'move_once' }, 1)).length).toBeLessThanOrEqual(2);
  });

  it('every night is assigned, every stay is long enough', () => {
    for (const nights of [1, 2, 3, 5, 8, 13]) {
      const choice = chooseStays(input(coast, nights));
      expect(choice.stays.reduce((n, s) => n + s.nights, 0)).toBe(nights);
      if (nights >= 4 && choice.stays.length > 1) expect(Math.min(...choice.stays.map((s) => s.nights))).toBeGreaterThanOrEqual(2);
    }
  });

  it('a part the traveller named is slept in, whatever it costs', () => {
    const near = { ...input(twin, 7, { maxDailyTravelMinutes: 400 }), mustCover: [{ name: 'West', baseIds: ['west'] }, { name: 'East', baseIds: ['east'] }] };
    expect(names(near).sort()).toEqual(['east', 'west']);
  });

  it('a must-see out of reach earns the stay that reaches it; the cap still wins', () => {
    const base = input(twin, 3);
    const named: StayObjectiveInput = { ...base, places: base.places.map((p) => (p.id === 'e0' ? { ...p, mustSee: true } : p)) };
    expect(names(named)).toContain('east');
    expect(names({ ...named, maxBaseChanges: 0, traveller: { ...named.traveller, moveTolerance: 'stay_put' } })).toHaveLength(1);
  });

  it('an unmeasured leg never makes a place far', () => {
    const base = input(twin, 7);
    const blind: StayObjectiveInput = { ...base, minutes: (a, b) => (a === b ? 0 : (a === 'west' && b === 'e0') || (b === 'west' && a === 'e0') ? null : base.minutes(a, b)), places: base.places.map((p) => (p.id === 'e0' ? { ...p, mustSee: true } : p)) };
    /* From the west alone the must-see has no figure, so it counts as within reach: nothing forces a second base on its account. */
    expect(chooseStays({ ...blind, maxBaseChanges: 0, traveller: { ...blind.traveller, moveTolerance: 'stay_put' } }).stays).toEqual([{ baseId: 'west', nights: 7 }]);
  });

  it('what a move costs grows with who is moving', () => {
    const plain = moveCostFor(DEFAULT_STAY_TRAVELLER);
    const family = moveCostFor({ ...DEFAULT_STAY_TRAVELLER, children: 2, youngChildren: true });
    const noCar = moveCostFor({ ...DEFAULT_STAY_TRAVELLER, carAvailable: false });
    const freely = moveCostFor({ ...DEFAULT_STAY_TRAVELLER, moveTolerance: 'move_freely' });
    expect(family.overheadMinutes).toBeGreaterThan(plain.overheadMinutes);
    expect(family.inconvenienceMinutes).toBeGreaterThan(plain.inconvenienceMinutes);
    expect(noCar.overheadMinutes).toBeGreaterThan(plain.overheadMinutes);
    expect(freely.inconvenienceMinutes).toBe(0);
  });

  it('records the numbers behind a sentence a screen can show', () => {
    const { decision } = chooseStays(input(twin, 7));
    expect(decision.chosen.moves).toBe(1);
    expect(decision.alternatives.length).toBeGreaterThan(0);
    expect(decision.basis).toBe('estimated');
    expect(decision.sentence).toMatch(/2 bases, west, east/);
  });
});
