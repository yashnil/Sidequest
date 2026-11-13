import { describe, expect, it } from 'vitest';
import { MAX_ESSENTIAL_PILLARS, normalizeScanProposal } from './proposal';

describe('pillars from the proposal', () => {
  const candidate = (name: string) => ({ name, locality: 'x', kind: 'wildlife', tier: 'classic', why: 'y' });
  it('match candidates by name (case- and accent-blind), keep an empty pillar as a gap, cap essentials, mark essential candidates defining', () => {
    const out = normalizeScanProposal({
      bases: [{ name: 'Camp', locality: 'x', nightsHint: 3, why: 'z' }],
      candidates: [candidate('Plains Drive'), candidate('Crater Floor'), candidate('Baobab Park'), candidate('Lake Park')],
      pillars: [
        { name: 'Plains', tier: 'essential', why: 'migration', candidates: ['plains drive'] },
        { name: 'Crater', tier: 'essential', why: '', candidates: ['Crátér Floor'] },
        { name: 'South', tier: 'recommended', why: '', candidates: ['Baobab Park', 'Lake Park'] },
        { name: 'Remote', tier: 'essential', why: '', candidates: ['Nowhere Reserve'] },
        { name: 'Extra', tier: 'essential', why: '', candidates: ['Lake Park'] },
      ],
    });
    if (!out.ok) throw new Error(out.reason);
    const pillars = out.proposal.pillars!;
    expect(pillars.map((p) => [p.name, p.tier, p.candidateKeys.length])).toEqual([['Plains', 'essential', 1], ['Crater', 'essential', 1], ['South', 'recommended', 2], ['Remote', 'essential', 0], ['Extra', 'recommended', 1]]);
    expect(pillars.filter((p) => p.tier === 'essential').length).toBeLessThanOrEqual(MAX_ESSENTIAL_PILLARS);
    expect(out.proposal.candidates.filter((c) => c.defining).map((c) => c.name)).toEqual(['Plains Drive', 'Crater Floor']);
  });
});
