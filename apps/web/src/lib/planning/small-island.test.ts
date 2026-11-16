import { describe, expect, it, vi } from 'vitest';
import { onSmallIsland } from './small-island';

vi.mock('server-only', () => ({}));

const p = (lat: number, lng: number) => ({ lat, lng });

describe('a small island never takes the mainland train', () => {
  it.each([
    ['Naxos Town → Filoti (the live Cyclades plan)', [p(37.105, 25.376), p(37.051, 25.494)]],
    ['Valletta → Mdina (a small island state)', [p(35.899, 14.514), p(35.886, 14.403)]],
    ['Paros: Parikia → Naoussa', [p(37.085, 25.149), p(37.123, 25.238)]],
  ])('%s is a small island', (_label, points) => {
    expect(onSmallIsland(points)).toBe(true);
  });

  it.each([
    ['Athens → Corinth (mainland Greece)', [p(37.984, 23.728), p(37.94, 22.93)]],
    ['Cagliari → Oristano (Sardinia has its own railway)', [p(39.223, 9.121), p(39.903, 8.592)]],
    ['Naxos → Paros (two islands: not one landmass at all)', [p(37.105, 25.376), p(37.085, 25.149)]],
  ])('%s is not', (_label, points) => {
    expect(onSmallIsland(points)).toBe(false);
  });

  it('an end that cannot be placed changes nothing', () => {
    expect(onSmallIsland([p(37.105, 25.376), null])).toBe(false);
  });
});
