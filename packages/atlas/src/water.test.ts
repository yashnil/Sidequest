import { describe, expect, it } from 'vitest';
import { assessCrossing } from '@sidequest/core';
import { loadWaterIndex } from './water';

/*
 * The shipped land and lake indexes against real geography. The two reported
 * failures (Faroe "Drive to Mykines", Lake Atitlán villages) are here, but most
 * cases are places the planner has never been tuned on: the module may only
 * read geometry, never a name.
 */
const index = loadWaterIndex();
const p = (lat: number, lng: number) => ({ lat, lng });

describe('the shipped water index', () => {
  it('loads both files', () => {
    expect(index).not.toBeNull();
    expect(index!.lakes).not.toBeNull();
  });

  it.each([
    ['a passenger-ferry island (Faroe: Miðvágur → Mykines)', p(62.05, -7.19), p(62.1047, -7.6447)],
    ['a bridge-connected island is still another landmass (Copenhagen → Malmö)', p(55.676, 12.568), p(55.605, 13.003)],
    ['an island whose harbour pin sits just offshore (Split → Hvar town)', p(43.508, 16.44), p(43.172, 16.442)],
    ['an archipelago hop (Lofoten Reine → Bodø)', p(67.932, 13.089), p(67.28, 14.405)],
    ['a vehicle-ferry island (Naples → Capri)', p(40.85, 14.25), p(40.551, 14.243)],
    ['a Pacific island pair (Maui Kahului → Lānaʻi City)', p(20.889, -156.47), p(20.827, -156.92)],
  ])('%s is two landmasses', (_label, a, b) => {
    expect(assessCrossing(index, a, b).verdict).toBe('separate_land');
  });

  it.each([
    ['across Lake Atitlán (Panajachel → San Pedro La Laguna)', p(14.74, -91.158), p(14.693, -91.272)],
    ['across Lake Geneva (Lausanne → Évian)', p(46.507, 6.627), p(46.401, 6.59)],
    ['to an island in a lake (Granada → Moyogalpa, Ometepe)', p(11.93, -85.956), p(11.54, -85.697)],
  ])('%s is water on the same land, mostly lake', (_label, a, b) => {
    const out = assessCrossing(index, a, b);
    expect(['water_between', 'separate_land']).toContain(out.verdict);
    expect(out.lake).toBe(true);
  });

  /* A narrow fjord (Geirangerfjord, ~1 km) is below the simplified coastline's resolution and reads as land: a known limit, where only a router can speak. */
  it('a wide fjord crossing on one landmass is water between (Sognefjord: Balestrand → Vangsnes)', () => {
    const out = assessCrossing(index, p(61.207, 6.531), p(61.168, 6.64));
    expect(out.verdict).toBe('water_between');
    expect(out.lake).toBe(false);
  });

  it.each([
    ['inland Switzerland (Zürich → Lucerne)', p(47.377, 8.541), p(47.05, 8.309)],
    ['a mountain barrier is not water (Chamonix → Courmayeur)', p(45.924, 6.869), p(45.797, 6.972)],
    ['one island end to end (Honolulu → Kailua, Oʻahu)', p(21.307, -157.858), p(21.402, -157.739)],
    ['along a coast (Lisbon → Cascais)', p(38.722, -9.139), p(38.697, -9.421)],
    ['across a peninsula ridge (Sorrento → Positano)', p(40.626, 14.376), p(40.628, 14.485)],
  ])('%s is land', (_label, a, b) => {
    expect(assessCrossing(index, a, b).verdict).toBe('land');
  });

  it('a bay the road goes around is water between, not a short drive (Sorrento → Pompeii)', () => {
    expect(assessCrossing(index, p(40.626, 14.376), p(40.749, 14.484)).verdict).toBe('water_between');
  });

  it('a point far out at sea cannot be placed and says unknown, never "no water"', () => {
    expect(assessCrossing(index, p(62.05, -7.19), p(60.0, -20.0)).verdict).toBe('unknown');
  });

  it('with no index loaded, nothing is claimed', () => {
    expect(assessCrossing(null, p(62.05, -7.19), p(62.1047, -7.6447)).verdict).toBe('unknown');
  });

  it('is fast enough to run on every unmeasured cell of a scan matrix', () => {
    const started = performance.now();
    for (let k = 0; k < 200; k += 1) assessCrossing(index, p(62.0 + k * 0.001, -7.0), p(62.1, -7.6 + k * 0.001));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
