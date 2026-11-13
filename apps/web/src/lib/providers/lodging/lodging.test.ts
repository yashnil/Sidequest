import { describe, expect, it } from 'vitest';
import { rankLodgingProperties, readTripForLodging, type LodgingBaseContext, type LodgingPropertyCandidate } from '@sidequest/core';
import hongu from './fixtures/hongu.json';
import mammoth from './fixtures/mammoth.json';
import vik from './fixtures/vik.json';
import { discoverLodgingNear } from './discover';
import { fetchOvertureLodging, overtureLodgingRow, withNearbyHotSprings, type OvertureLodgingBox } from './overture-lodging';
import { osmLodgingCandidate, osmLodgingFromElements, type OsmLodgingElement } from './osm-lodging';

/*
 * Recorded with `coverage.harness.ts` (Overture place files, 2026-11). No test
 * here touches the network: the readers are injected.
 */
const HONGU = hongu.overture as unknown as OvertureLodgingBox;
const HONGU_CANDIDATES = withNearbyHotSprings(HONGU);
const near = hongu.base.near;

function baseAt(point: { lat: number; lng: number }, dayStarts: LodgingBaseContext['dayStarts'] = []): LodgingBaseContext {
  return { baseId: 'b', name: 'Hongū', coordinates: point, nights: 2, checkIn: '2026-10-03', checkOut: '2026-10-05', dayStarts };
}

describe('Overture lodging rows (recorded around Hongū)', () => {
  it('keeps Japanese names exactly as recorded, every one with a position', () => {
    const names = HONGU.candidates.map((c) => c.name);
    expect(names).toContain('旅館あづまや');
    expect(names).toContain('民宿てるてや');
    expect(names).toContain('湯の峯荘');
    for (const c of HONGU.candidates) {
      expect(c.name.length).toBeGreaterThan(1);
      expect(Number.isFinite(c.coordinates.lat) && Number.isFinite(c.coordinates.lng)).toBe(true);
      expect(c.source).toBe('overture');
      expect(c.licence).not.toBe('ODbL-1.0');
    }
  });

  it('refines a generic category by the name and reads a hot spring only from the name', () => {
    const byName = new Map(HONGU.candidates.map((c) => [c.name, c] as const));
    expect(byName.get('旅館あづまや')!.type).toBe('ryokan');
    expect(byName.get('民宿くらや')!.type).toBe('minshuku');
    expect(byName.get('温泉民宿大村屋')!.amenities).toEqual([{ kind: 'onsen', value: 'yes', basis: 'name' }]);
    expect(byName.get('伊せや')!.amenities).toEqual([]);
    /* The bus stop Overture filed as a hotel is not a place to stay. */
    expect(names()).not.toContain('湯の峰温泉 バス停');
  });

  it('attaches a public hot spring from the same source within 600 m', () => {
    const iseya = HONGU_CANDIDATES.find((c) => c.name === '伊せや')!;
    expect(iseya.nearbyHotSpring?.metres).toBeLessThan(600);
  });

  it('maps a raw row, and drops one below the confidence floor or closed', () => {
    const row = { id: 'abc', names: { primary: '民宿テスト', common: { en: 'Minshuku Test' } }, confidence: 0.9, operating_status: 'open', basic_category: 'hotel', taxonomy: { primary: 'hotel', hierarchy: ['lodging', 'hotel'] }, websites: ['https://example.jp'], sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0' }], addresses: [{ locality: '田辺市' }], bbox: { xmin: 135.7, xmax: 135.7, ymin: 33.8, ymax: 33.8 } };
    const mapped = overtureLodgingRow(row)!;
    expect(mapped).toMatchObject({ sourceId: 'overture:abc', name: '民宿テスト', altName: 'Minshuku Test', type: 'minshuku', typeBasis: 'name', website: 'https://example.jp/', locality: '田辺市', licence: 'CDLA-Permissive-2.0' });
    expect(overtureLodgingRow({ ...row, confidence: 0.5 })).toBeNull();
    expect(overtureLodgingRow({ ...row, operating_status: 'permanently_closed' })).toBeNull();
    expect(overtureLodgingRow({ ...row, basic_category: 'restaurant', taxonomy: { primary: 'restaurant', hierarchy: ['food_and_drink', 'restaurant'] } })).toBeNull();
  });
});

function names(): string[] {
  return HONGU.candidates.map((c) => c.name);
}

describe('ranking on the recorded corpus', () => {
  it('a hot-springs trip based at Hongū is shown hot-spring lodging first', () => {
    const reading = readTripForLodging({ interests: { hot_springs: 'core' }, primaryMode: 'rail', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(HONGU_CANDIDATES, baseAt(near), reading);
    expect(ranked.recommendations.length).toBeGreaterThanOrEqual(3);
    expect(ranked.recommendations.length).toBeLessThanOrEqual(5);
    const top = ranked.recommendations[0]!;
    expect(top.why.join(' ')).toMatch(/hot-spring bath on site|public hot spring/);
    /* Every pick names a real record with a position and a dated search. */
    for (const rec of ranked.recommendations) {
      expect(rec.name.length).toBeGreaterThan(1);
      const search = new URL(rec.links.find((l) => l.kind === 'booking_search')!.href);
      expect(search.searchParams.get('checkin')).toBe('2026-10-03');
      expect(search.searchParams.get('group_adults')).toBe('2');
    }
  });

  it('a walking trip whose next day starts at the Yunomine trailhead is shown beds beside it', () => {
    const trailhead = { lat: 33.8291, lng: 135.7577 };
    const reading = readTripForLodging({ primaryMode: 'walk', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(HONGU_CANDIDATES, baseAt(near, [{ dayNumber: 2, name: 'Yunomine trailhead', coordinates: trailhead }]), reading);
    for (const rec of ranked.recommendations.slice(0, 3)) expect(rec.why.join(' ')).toMatch(/from where day 2 starts/);
  });

  it('the same inn in two languages is shown once', () => {
    const reading = readTripForLodging({ interests: { hot_springs: 'core' }, primaryMode: 'walk', adults: 2, children: 0 });
    const yunomine = { lat: 33.824, lng: 135.7544 };
    const ranked = rankLodgingProperties(HONGU_CANDIDATES, baseAt(yunomine), reading, { limit: 5 });
    const picked = ranked.recommendations.map((r) => r.name);
    expect(picked.filter((n) => n === '湯の峯荘' || n === 'Ryokan Yunomineso').length).toBeLessThanOrEqual(1);
  });

  it('a car trip around a mountain town keeps every pick inside the drive radius, parking unknown said plainly', () => {
    const box = mammoth.overture as unknown as OvertureLodgingBox;
    const reading = readTripForLodging({ primaryMode: 'drive', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(withNearbyHotSprings(box), { ...baseAt(mammoth.base.near), name: 'the town' }, reading);
    expect(ranked.recommendations.length).toBe(4);
    for (const rec of ranked.recommendations) {
      expect(rec.distanceKm).toBeLessThanOrEqual(12);
      if (rec.source === 'overture') expect(rec.tradeoffs).toContain('Parking is not recorded — ask before you book.');
    }
  });
});

describe('OpenStreetMap lodging elements', () => {
  /* Shapes as Overpass returns them (`out center tags`). */
  const elements: OsmLodgingElement[] = [
    { type: 'node' as const, id: 101, lat: 33.829, lon: 135.758, tags: { tourism: 'guest_house', guest_house: 'minshuku', name: '民宿テスト', 'name:en': 'Minshuku Test', 'bath:type': 'onsen', parking: 'yes', wheelchair: 'limited', website: 'example.jp' } },
    { type: 'way' as const, id: 202, center: { lat: 33.8295, lon: 135.7579 }, tags: { tourism: 'hotel', name: 'Hotel Test', stars: '4', rooms: '30' } },
    { type: 'node' as const, id: 303, lat: 33.8292, lon: 135.7577, tags: { amenity: 'public_bath', 'bath:type': 'onsen', name: 'つぼ湯' } },
    { type: 'node' as const, id: 404, lat: 33.8, lon: 135.7, tags: { tourism: 'hotel' } },
  ];

  it('labels every amenity mapped, carries ODbL, and leaves an absent tag unknown', () => {
    const [minshuku, hotel] = osmLodgingFromElements(elements);
    expect(minshuku).toMatchObject({ source: 'osm', sourceId: 'osm:node/101', name: '民宿テスト', altName: 'Minshuku Test', type: 'minshuku', licence: 'ODbL-1.0', website: 'https://example.jp/' });
    expect(minshuku!.amenities).toEqual([
      { kind: 'onsen', value: 'yes', basis: 'mapped' },
      { kind: 'parking', value: 'yes', basis: 'mapped' },
      { kind: 'wheelchair', value: 'limited', basis: 'mapped' },
    ]);
    expect(hotel).toMatchObject({ sourceId: 'osm:way/202', stars: 4, rooms: 30, amenities: [] });
    expect(hotel!.nearbyHotSpring).toEqual({ name: 'つぼ湯', metres: expect.any(Number) });
    expect(osmLodgingCandidate(elements[3]!)).toBeNull();
  });
});

describe('recorded OpenStreetMap elements (Overpass, 2026-11)', () => {
  it('maps every recorded Hongū element to an ODbL row with a name and a position, Japanese names intact', () => {
    const osm = osmLodgingFromElements(hongu.osm.elements as never);
    expect(osm.length).toBeGreaterThan(20);
    for (const c of osm) {
      expect(c.source).toBe('osm');
      expect(c.licence).toBe('ODbL-1.0');
      expect(c.sourceId).toMatch(/^osm:(node|way|relation)\/\d+$/);
      expect(c.name.length).toBeGreaterThan(1);
      for (const a of c.amenities) expect(['mapped', 'name']).toContain(a.basis);
    }
    expect(osm.map((c) => c.name)).toContain('民宿すみや');
  });

  it('ranking both sources together shows each property once and never moves a fact across sources', () => {
    const osm = osmLodgingFromElements(hongu.osm.elements as never);
    const reading = readTripForLodging({ interests: { hot_springs: 'core' }, primaryMode: 'walk', adults: 2, children: 0 });
    const ranked = rankLodgingProperties([...HONGU_CANDIDATES, ...osm], baseAt({ lat: 33.8291, lng: 135.7577 }), reading, { limit: 5 });
    const all = new Map([...HONGU_CANDIDATES, ...osm].map((c) => [c.sourceId, c] as const));
    for (const rec of ranked.recommendations) {
      const record = all.get(rec.sourceId)!;
      expect(rec.name).toBe(record.name);
      const website = rec.links.find((l) => l.kind === 'website');
      expect(website?.href).toBe(record.website);
      expect(rec.sourceLabel).toMatch(record.source === 'osm' ? /OpenStreetMap/ : /Overture/);
    }
    expect(ranked.dropped.find((d) => d.reason === 'the same property listed twice')?.count ?? 0).toBeGreaterThan(0);
  });

  it('a car trip at Vík ranks both sources inside the drive radius', () => {
    const candidates = [...withNearbyHotSprings(vik.overture as unknown as OvertureLodgingBox), ...osmLodgingFromElements(vik.osm.elements as never)];
    const ranked = rankLodgingProperties(candidates, { ...baseAt(vik.base.near), name: 'Vík' }, readTripForLodging({ primaryMode: 'drive', adults: 2, children: 0 }));
    expect(ranked.recommendations).toHaveLength(4);
    expect(new Set(ranked.recommendations.map((r) => r.name)).size).toBe(4);
  });
});

describe('discoverLodgingNear — two sources side by side, never merged', () => {
  const overtureBox: OvertureLodgingBox = { candidates: HONGU.candidates.slice(0, 5), hotSprings: [] };
  const memory = new Map<string, OvertureLodgingBox>();
  const deps = {
    overture: { readBox: async () => overtureBox, cache: { read: (k: string) => memory.get(k) ?? null, write: (k: string, v: OvertureLodgingBox) => void memory.set(k, v) } },
    overpass: async () => ({ elements: [{ type: 'node' as const, id: 9, lat: near.lat, lon: near.lng, tags: { tourism: 'hostel', name: 'OSM Hostel' } }], dataTimestamp: null, calls: 1, cacheHit: false, bytes: 10, failedGroups: [] }),
  };

  it('returns each source with its own status and licence, no price, and caches the Overture box', async () => {
    const first = await discoverLodgingNear({ near, radiusKm: 4 }, {}, deps);
    expect(first.available).toBe(true);
    expect(first.noLivePricing).toBe(true);
    expect(first.sources).toEqual([
      { source: 'overture', status: 'ok', count: 5, cacheHit: false },
      { source: 'osm', status: 'ok', count: 1, cacheHit: false },
    ]);
    const osm = first.candidates.filter((c: LodgingPropertyCandidate) => c.source === 'osm');
    expect(osm.map((c) => c.licence)).toEqual(['ODbL-1.0']);
    expect(first.candidates.filter((c) => c.source === 'overture').every((c) => c.licence !== 'ODbL-1.0')).toBe(true);
    expect(first.attribution.join(' ')).toMatch(/OpenStreetMap contributors/);
    const second = await discoverLodgingNear({ near, radiusKm: 4 }, {}, deps);
    expect(second.sources[0]!.cacheHit).toBe(true);
  });

  it('a failing source is an absence, said in words, never a guess', async () => {
    const result = await discoverLodgingNear({ near, radiusKm: 4 }, {}, { overture: { readBox: async () => { throw new Error('timeout'); }, cache: { read: () => null, write: () => undefined } } });
    expect(result.available).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.sources).toEqual([{ source: 'overture', status: 'failed', count: 0 }, { source: 'osm', status: 'off', count: 0 }]);
    expect(result.reason).toMatch(/Nothing was guessed/);
  });

  it('a source that never answers is cut off at the ceiling, and the other source still shows', async () => {
    const stalled = { readBox: () => new Promise<OvertureLodgingBox>(() => undefined), cache: { read: () => null, write: () => undefined } };
    const started = Date.now();
    const result = await discoverLodgingNear({ near, radiusKm: 4 }, {}, { overture: stalled, overpass: deps.overpass }, 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.sources).toEqual([
      { source: 'overture', status: 'failed', count: 0 },
      { source: 'osm', status: 'ok', count: 1, cacheHit: false },
    ]);
    expect(result.available).toBe(true);
  });

  it('with the fixture compiler, fixture properties stand in', async () => {
    const result = await discoverLodgingNear({ near, radiusKm: 4 }, { SIDEQUEST_COMPILER_PROVIDER: 'fixture' });
    expect(result.provider).toBe('fixture');
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('the Overture reader is not called again for a cached box', async () => {
    let reads = 0;
    const cache = new Map<string, OvertureLodgingBox>();
    const d = { readBox: async () => { reads += 1; return overtureBox; }, cache: { read: (k: string) => cache.get(k) ?? null, write: (k: string, v: OvertureLodgingBox) => void cache.set(k, v) } };
    const box = { south: 1, west: 2, north: 3, east: 4 };
    await fetchOvertureLodging(box, d);
    await fetchOvertureLodging(box, d);
    expect(reads).toBe(1);
  });
});
