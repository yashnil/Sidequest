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
