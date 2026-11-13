import { describe, expect, it } from 'vitest';
import { statedTravelMode } from './stated-mode';

describe('statedTravelMode — a mode written into the destination', () => {
  it('reads public transport from an explicit clause', () => {
    for (const phrase of ['Tokyo and Kyoto by train', 'Switzerland by rail', 'Scotland by public transport', 'Andalusia by bus', 'Europe on a rail pass', 'Bavaria without a car', 'car-free Mallorca']) {
      expect(statedTravelMode(phrase), phrase).toBe('public_transport');
    }
  });

  it('reads driving from an explicit clause', () => {
    for (const phrase of ['Scottish Highlands road trip', 'Iceland by car', 'New Zealand in a campervan', 'Utah self-drive', 'driving the Garden Route']) {
      expect(statedTravelMode(phrase), phrase).toBe('drive');
    }
  });

  it('a place name is not a mode: roads, drives and trains in names say nothing', () => {
    for (const phrase of ['Iceland Ring Road', 'Going-to-the-Sun Road', 'Great Ocean Road', 'Lisbon, Portugal', 'Kumano Kodo, Japan', 'Trainspotting locations Edinburgh', 'Rodeo Drive', '']) {
      expect(statedTravelMode(phrase), phrase).toBeNull();
    }
  });

  it('both or neither is no reading', () => {
    expect(statedTravelMode('Norway by car and by train')).toBeNull();
    expect(statedTravelMode(undefined)).toBeNull();
  });
});

describe('withoutModeClause — the places, without how the traveller moves between them', () => {
  it('drops "by …", "without a car" and a car-free prefix; keeps route words', async () => {
    const { withoutModeClause } = await import('./stated-mode');
    expect(withoutModeClause('Tokyo and Kyoto by train')).toBe('Tokyo and Kyoto');
    expect(withoutModeClause('Bavaria without a car')).toBe('Bavaria');
    expect(withoutModeClause('car-free Mallorca')).toBe('Mallorca');
    expect(withoutModeClause('Iceland by car')).toBe('Iceland');
    expect(withoutModeClause('Scottish Highlands road trip')).toBe('Scottish Highlands road trip');
    expect(withoutModeClause('Iceland Ring Road')).toBe('Iceland Ring Road');
    expect(withoutModeClause('by train')).toBe('by train');
  });

  it('drops a trailing trip word, so the place is resolved at its own scale (eval v2: "Tanzania safari")', async () => {
    const { withoutModeClause } = await import('./stated-mode');
    expect(withoutModeClause('Tanzania safari')).toBe('Tanzania');
    expect(withoutModeClause('Kyrgyzstan adventure')).toBe('Kyrgyzstan');
    expect(withoutModeClause('Dolomites hiking')).toBe('Dolomites');
    expect(withoutModeClause('Patagonia trekking holiday')).toBe('Patagonia');
    expect(withoutModeClause('Scottish Highlands road trip')).toBe('Scottish Highlands road trip');
    expect(withoutModeClause('Safari')).toBe('Safari');
    expect(withoutModeClause('Kumano Kodo, Japan')).toBe('Kumano Kodo, Japan');
  });

  it('a "Tokyo and Kyoto by train" intent has two parts named Tokyo and Kyoto', async () => {
    const { parseDestinationIntent } = await import('./intent-graph');
    const graph = parseDestinationIntent('Tokyo and Kyoto by train');
    expect(graph.children.map((c) => c.label)).toEqual(['Tokyo', 'Kyoto']);
  });
});
