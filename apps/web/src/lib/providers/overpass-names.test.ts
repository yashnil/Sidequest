import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeElement } from './overpass';

const cafe = (tags: Record<string, string>) => ({ type: 'node' as const, id: 1, lat: 35.68, lon: 139.76, tags: { amenity: 'restaurant', ...tags } });

describe('a venue name a traveller can read (live Tokyo finding)', () => {
  it('uses the English or Latin name the map publishes when the primary name is in another script', () => {
    expect(normalizeElement(cafe({ name: '鮨鶴', 'name:en': 'Sushi Tsuru' }))?.name).toBe('Sushi Tsuru');
    expect(normalizeElement(cafe({ name: '昇楽', 'name:latin': 'Shoraku' }))?.name).toBe('Shoraku');
  });
  it('keeps the published name when there is no alternative, and never touches a Latin-script name', () => {
    expect(normalizeElement(cafe({ name: '昇楽' }))?.name).toBe('昇楽');
    expect(normalizeElement(cafe({ name: 'Phở Bát Đàn', 'name:en': 'Pho Bat Dan' }))?.name).toBe('Phở Bát Đàn');
  });
});
