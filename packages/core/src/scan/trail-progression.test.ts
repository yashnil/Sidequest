import { describe, expect, it } from 'vitest';
import { orderTrailStages, resolveTrailStages, trailBedChain, trailLimitsFor } from './trail-stages';
import { gappedTrailProposal, gappedTrailRegion, type GappedTrailOptions } from './gapped-trail-fixture.test-support';

/**
 * A TRAIL NAMED IN PIECES IS ONE ORDERED WALK — the stage sequence and the
 * stays on a proposal shaped like the recorded live Kumano boards: gaps
 * between named stages, a short walk ending where the final section ends.
 */

const order = (options: GappedTrailOptions = {}) => {
  const { proposal, positions } = gappedTrailProposal(options);
  return orderTrailStages({ candidates: proposal.candidates.map((c) => ({ id: `p-${c.key}`, proposal: c })), positionOf: (k) => positions.get(k)?.coordinates ?? null });
};

describe('the sections of a trail in one order', () => {
  it('joins sections across the gaps the proposal left, in trail order, whatever order and numbering it gave', () => {
    const expected = ['Takijiri-oji to Takahara', 'Chikatsuyu to Hosshinmon-oji', 'Hosshinmon-oji to Kumano Hongu Taisha', 'Hongu to Yunomine Onsen via Dainichi-goe', 'Koguchi to Nachisan via Ogumotori-goe'];
    for (const options of [{}, { stageMarks: false }, { shuffled: true }, { stageMarks: false, shuffled: true }] as GappedTrailOptions[]) {
      const { stages } = order(options);
      expect(stages.map((s) => s.name)).toEqual(expected);
      expect(stages.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
      expect(stages.map((s) => s.gapBeforeKm !== undefined)).toEqual([false, true, false, false, true]);
    }
  });

  it('leaves out a walk that ends where the trail already ends, and says why', () => {
    const { dropped } = order();
    expect(dropped).toEqual([{ name: 'Daimonzaka to Nachi Taisha and Nachi Falls', reason: expect.stringMatching(/ends where another stage already ends/) }]);
  });

  it('each stage leaves from the bed the last one reached, so a gap never breaks the chain of beds', () => {
    const { stages } = order();
    const beds = [
      { id: 'takahara', name: 'Takahara', coordinates: { lat: 33.8022, lng: 135.5822 } },
      { id: 'hosshinmon', name: 'Hosshinmon', coordinates: { lat: 33.865, lng: 135.756 } },
      { id: 'hongu', name: 'Hongu', coordinates: { lat: 33.8403, lng: 135.7733 } },
      { id: 'yunomine', name: 'Yunomine', coordinates: { lat: 33.8185, lng: 135.7625 } },
      { id: 'nachi', name: 'Nachi', coordinates: { lat: 33.6686, lng: 135.8903 } },
      { id: 'takijiri', name: 'Takijiri', coordinates: { lat: 33.7944, lng: 135.5592 } },
    ];
    const resolved = resolveTrailStages({ stages, limits: trailLimitsFor({ intensity: 'moderate', children: 0, youngChildren: false, reducedMobility: false }), beds, contextFor: () => ({ month: 3, duskMinute: null, startMinute: 9 * 60 }) });
    expect(trailBedChain(resolved).chain).toEqual(['takijiri', 'takahara', 'hosshinmon', 'hongu', 'yunomine', 'nachi']);
  });
});

describe('the stays follow every section, with the beds the proposal did not name', () => {
  it('two proposed hot-spring villages (the recorded live shape) no longer reduce the trail to one stage between them', () => {
    const trail = gappedTrailRegion().region.basePortfolio!.decision!.trail!;
    expect(trail.followed).toBe(true);
    expect(trail.stages.map((s) => [s.order, s.fromName, s.toName])).toEqual([
      [1, 'Takijiri', 'Takahara'],
      [2, 'Takahara', 'Hosshinmon'],
      [3, 'Hosshinmon', 'Hongu'],
      [4, 'Hongu', 'Yunomine Onsen'],
      [5, 'Yunomine Onsen', 'Nachisan'],
    ]);
    expect(trail.adaptation).toMatch(/2 gaps in the trail ridden between walked sections/);
  });
});
