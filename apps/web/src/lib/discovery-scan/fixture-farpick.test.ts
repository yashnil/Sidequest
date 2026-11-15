import { describe, expect, it } from 'vitest';
import { estimateLegMinutes, normalizeScanProposal } from '@sidequest/core';
import { fixtureScanProposal } from './fixture';
import { fixturePlacement } from './placement';

/**
 * The `farpick` fixture token (browser suite: `e2e/travel-limit.spec.ts`) adds
 * four places on a ring round the only base: each alone inside a 150-minute
 * daily driving limit, any two together well past it — and nothing else about
 * the proposal changes.
 */
const drive = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => estimateLegMinutes({ from: a, to: b, mode: 'drive' })!.minutes;

describe('the farpick fixture token', () => {
  it('adds four far places, each a day inside the limit alone and over it in any pair, only when typed', () => {
    const center = { lat: 38.72, lng: -9.14 };
    const plain = normalizeScanProposal(fixtureScanProposal('Harbour City', 'Harbour City', 3));
    const far = normalizeScanProposal(fixtureScanProposal('Harbour City', 'farpick Harbour City', 3));
    if (!plain.ok || !far.ok) throw new Error('the fixture proposal should normalise');
    expect(far.proposal.candidates.length).toBe(plain.proposal.candidates.length + 4);
    const ring = far.proposal.candidates.filter((c) => /Far Reach /.test(c.name));
    expect(ring).toHaveLength(4);
    const placed = fixturePlacement(far.proposal, center);
    const base = placed.positions.get(far.proposal.bases[0]!.key)!.coordinates;
    const at = ring.map((c) => placed.positions.get(c.key)!.coordinates);
    for (const p of at) expect(2 * drive(base, p)).toBeLessThanOrEqual(145);
    for (let i = 0; i < at.length; i += 1) for (let j = i + 1; j < at.length; j += 1) expect(drive(base, at[i]!) + drive(at[i]!, at[j]!) + drive(at[j]!, base)).toBeGreaterThan(170);
    /* Every other place stays near the base. */
    for (const c of far.proposal.candidates.filter((c) => !ring.includes(c))) expect(drive(base, placed.positions.get(c.key)!.coordinates)).toBeLessThan(30);
  });
});
