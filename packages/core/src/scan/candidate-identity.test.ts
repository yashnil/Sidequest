import { describe, expect, it } from 'vitest';
import { accessRecoveryPriority, worthAccessRecovery } from './access-point';
import { normalizeCandidateIdentity, providerNameCoversPhrase, providerNameIsCanonical } from './candidate-identity';
import { normalizeScanProposal } from './proposal';

describe('the place a candidate is looked up as', () => {
  it('A — a place with descriptive words is looked up by its name, and the words are kept', () => {
    expect(normalizeCandidateIdentity('Rifugio Scotoni traditional lunch stop')).toMatchObject({ lookupName: 'Rifugio Scotoni', type: 'descriptive_suffix_removed', qualifier: 'traditional lunch stop' });
  });

  it('B — a place with an activity is looked up by its name, and the activity is kept', () => {
    expect(normalizeCandidateIdentity('Val Fiscalina easy walk')).toMatchObject({ lookupName: 'Val Fiscalina', type: 'activity_qualifier_removed', qualifier: 'easy walk' });
    expect(normalizeCandidateIdentity('Passo Sella scenic drive and viewpoint')).toMatchObject({ lookupName: 'Passo Sella', type: 'activity_qualifier_removed' });
  });

  it('C — a route is anchored at where it starts, with both ends recorded', () => {
    expect(normalizeCandidateIdentity('Passo Falzarego to Lagazuoi sunset viewpoint')).toMatchObject({ lookupName: 'Passo Falzarego', type: 'route_anchor', route: { from: 'Passo Falzarego', to: 'Lagazuoi' } });
    expect(normalizeCandidateIdentity('Rifugio Puez via Val di Funes viewpoint')).toMatchObject({ lookupName: 'Val di Funes', type: 'route_anchor', route: { from: 'Val di Funes', to: 'Rifugio Puez' } });
  });

  it('D/E — two places joined are never collapsed into one of them', () => {
    expect(normalizeCandidateIdentity('Ortisei funicular and Alpe di Siusi view')).toMatchObject({ lookupName: 'Ortisei funicular and Alpe di Siusi view', type: 'ambiguous' });
    expect(normalizeCandidateIdentity('Tokyo and Kyoto')).toMatchObject({ lookupName: 'Tokyo and Kyoto', type: 'ambiguous' });
  });

  it('an ordinary place name is unchanged, including lowercase words that are part of the name', () => {
    for (const name of ['Lago di Braies', 'Senso-ji', "Musée d'Orsay", 'Museo della Grande Guerra', 'Road to Hana', 'Gateway to the Valley']) {
      expect(normalizeCandidateIdentity(name)).toMatchObject({ lookupName: name, type: 'unchanged' });
    }
  });

  it('the proposal keeps what the model wrote as the name and carries the lookup alongside', () => {
    const n = normalizeScanProposal({ bases: [{ name: 'Corvara', locality: 'Corvara', nightsHint: 3, why: 'Central.' }], candidates: [{ name: 'Rifugio Scotoni traditional lunch stop', locality: 'Alta Badia', kind: 'cultural_experience', tier: 'hidden_gem', why: 'Grilled meats on the terrace.' }] });
    if (!n.ok) throw new Error(n.reason);
    expect(n.proposal.candidates[0]).toMatchObject({ name: 'Rifugio Scotoni traditional lunch stop', why: 'Grilled meats on the terrace.', tier: 'hidden_gem', identity: { lookupName: 'Rifugio Scotoni' } });
  });
});

describe('a provider name as the canonical identity', () => {
  it('accepts the clean form of what was asked and refuses a different place', () => {
    expect(providerNameIsCanonical('Rifugio Scotoni traditional lunch stop', 'Rifugio Scotoni')).toBe(true);
    expect(providerNameIsCanonical('Rifugio Scotoni lunch stop', 'Rifugio Lagazuoi')).toBe(false);
    expect(providerNameIsCanonical('Tokyo and Kyoto', 'Tokyo')).toBe(false);
    expect(providerNameIsCanonical('Seceda', 'Seceda Ridgeline Gondola Station Ortisei')).toBe(false);
  });

  it('an ambiguous phrase is placed only by an answer that names all of it', () => {
    expect(providerNameCoversPhrase('Tokyo and Kyoto', 'Tokyo')).toBe(false);
    expect(providerNameCoversPhrase('Ortisei funicular and Alpe di Siusi view', 'Alpe di Siusi')).toBe(false);
    expect(providerNameCoversPhrase('Lewis and Clark Caverns', 'Lewis and Clark Caverns State Park')).toBe(true);
  });
});

describe('who earns access-point recovery', () => {
  it('a traveller-selected lower-tier hike is recovered first', () => {
    expect(accessRecoveryPriority({ kind: 'day_hike', tier: 'side_quest', namedByTraveller: true })).toBe(10);
  });

  it('a hidden gem the traveller cares about, or a famous one, qualifies; on tier alone it does not', () => {
    expect(worthAccessRecovery({ kind: 'day_hike', tier: 'hidden_gem', namedByTraveller: false })).toBe(false);
    expect(worthAccessRecovery({ kind: 'day_hike', tier: 'hidden_gem', namedByTraveller: false, interests: ['hiking'], priorities: ['hiking'] })).toBe(true);
    expect(worthAccessRecovery({ kind: 'viewpoint', tier: 'hidden_gem', namedByTraveller: false, crowd: 'busy' })).toBe(true);
  });

  it('a low-value area candidate costs nothing', () => {
    expect(accessRecoveryPriority({ kind: 'easy_walk', tier: 'side_quest', namedByTraveller: false, interests: ['photography'], priorities: ['hiking'] })).toBe(0);
    expect(accessRecoveryPriority({ kind: 'neighbourhood', tier: 'classic', namedByTraveller: false })).toBe(0);
  });
});
