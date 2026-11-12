import { describe, expect, it } from 'vitest';
import { bookingComSearchUrl, propertyMapUrl } from './links';
import { lodgingTypeFromName, nameSaysHotSpring, isNotAProperty, type LodgingPropertyCandidate } from './property';
import { rankLodgingProperties, readTripForLodging, type LodgingBaseContext } from './rank';

/** Synthetic candidates around a synthetic base; the recorded corpus is exercised in `apps/web/src/lib/providers/lodging/lodging.test.ts`. */
const BASE: LodgingBaseContext = {
  baseId: 'b1',
  name: 'Valley Town',
  coordinates: { lat: 40, lng: 10 },
  nights: 3,
  checkIn: '2026-09-12',
  checkOut: '2026-09-15',
  dayStarts: [],
};

function at(dLatKm: number, dLngKm = 0): { lat: number; lng: number } {
  return { lat: 40 + dLatKm / 111, lng: 10 + dLngKm / (111 * Math.cos((40 * Math.PI) / 180)) };
}

function candidate(partial: Partial<LodgingPropertyCandidate> & { sourceId: string; name: string }): LodgingPropertyCandidate {
  return {
    source: 'overture',
    coordinates: at(0.3),
    type: 'hotel',
    typeBasis: 'category',
    amenities: [],
    licence: 'CDLA-Permissive-2.0',
    attribution: 'Overture Maps Foundation',
    website: `https://example.org/${partial.sourceId}`,
    confidence: 0.96,
    ...partial,
  };
}

describe('lodging ranking — what a property does for this trip', () => {
  it('a hot-springs trip puts the inn with its own bath first, and says why from the record', () => {
    const reading = readTripForLodging({ interests: { hot_springs: 'core' }, primaryMode: 'rail', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(
      [
        candidate({ sourceId: 'a', name: 'Central Hotel', coordinates: at(0.1) }),
        candidate({ sourceId: 'b', name: 'Riverside Onsen Inn', coordinates: at(1.4), type: 'inn', amenities: [{ kind: 'onsen', value: 'yes', basis: 'mapped' }], source: 'osm', licence: 'ODbL-1.0' }),
        candidate({ sourceId: 'c', name: 'Budget Rooms', coordinates: at(0.2) }),
      ],
      BASE,
      reading,
    );
    expect(ranked.recommendations[0]!.name).toBe('Riverside Onsen Inn');
    expect(ranked.recommendations[0]!.why[0]).toMatch(/hot-spring bath on site \(mapped on OpenStreetMap\).*hot springs you put at the centre/);
    expect(ranked.recommendations[0]!.sourceLabel).toMatch(/OpenStreetMap \(ODbL-1\.0\)/);
    expect(ranked.recommendations[0]!.facts).toContain('Hot-spring bath — mapped');
  });

  it('without a hot-springs interest, the same bath is a footnote and the nearer hotel wins', () => {
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(
      [candidate({ sourceId: 'a', name: 'Central Hotel', coordinates: at(0.1) }), candidate({ sourceId: 'b', name: 'Riverside Onsen Inn', coordinates: at(1.4), amenities: [{ kind: 'onsen', value: 'yes', basis: 'mapped' }] })],
      BASE,
      reading,
    );
    expect(ranked.recommendations[0]!.name).toBe('Central Hotel');
  });

  it('a car trip prefers mapped parking over a nearer property with none, and tells the unknown to ask', () => {
    const reading = readTripForLodging({ primaryMode: 'drive', adults: 2, children: 0 });
    expect(reading.mode).toBe('drive');
    const ranked = rankLodgingProperties(
      [
        candidate({ sourceId: 'town', name: 'Old Town Hotel', coordinates: at(0.2), source: 'osm', licence: 'ODbL-1.0', amenities: [{ kind: 'parking', value: 'no', basis: 'mapped' }] }),
        candidate({ sourceId: 'edge', name: 'Edge of Town Lodge', coordinates: at(3), type: 'lodge', source: 'osm', licence: 'ODbL-1.0', amenities: [{ kind: 'parking', value: 'yes', basis: 'mapped' }] }),
        candidate({ sourceId: 'unknown', name: 'Quiet Hotel', coordinates: at(2) }),
      ],
      BASE,
      reading,
    );
    expect(ranked.recommendations.map((r) => r.name)).toEqual(['Edge of Town Lodge', 'Quiet Hotel', 'Old Town Hotel']);
    expect(ranked.recommendations[0]!.why.join(' ')).toMatch(/Parking on record.*driving/);
    expect(ranked.recommendations[1]!.tradeoffs).toContain('Parking is not recorded — ask before you book.');
    expect(ranked.recommendations[2]!.tradeoffs.join(' ')).toMatch(/no parking/);
  });

  it('a walking trip ranks by the first trail stop of each day, not by the town centre', () => {
    const trailhead = at(3.5);
    const base: LodgingBaseContext = { ...BASE, dayStarts: [{ dayNumber: 2, name: 'Upper Trailhead', coordinates: trailhead }] };
    const reading = readTripForLodging({ primaryMode: 'walk', adults: 1, children: 0 });
    expect(reading.mode).toBe('foot');
    const ranked = rankLodgingProperties(
      [candidate({ sourceId: 'centre', name: 'Square Hotel', coordinates: at(0.05) }), candidate({ sourceId: 'trail', name: 'Trailside Guesthouse', type: 'guesthouse', coordinates: at(3.3) })],
      base,
      reading,
    );
    expect(ranked.recommendations[0]!.name).toBe('Trailside Guesthouse');
    expect(ranked.recommendations[0]!.why[0]).toMatch(/from where day 2 starts \(Upper Trailhead\)/);
    expect(ranked.recommendations[1]!.tradeoffs.join(' ')).toMatch(/nearest day's starting point/);
  });

  it('never shows a property without a name or a position, nor one outside the radius', () => {
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 0 });
    const ranked = rankLodgingProperties(
      [
        candidate({ sourceId: 'a', name: '' }),
        candidate({ sourceId: 'b', name: 'Nowhere Inn', coordinates: { lat: Number.NaN, lng: 10 } }),
        candidate({ sourceId: 'c', name: 'Far Hotel', coordinates: at(30) }),
        candidate({ sourceId: 'd', name: 'Real Hotel' }),
      ],
      BASE,
      reading,
    );
    expect(ranked.recommendations.map((r) => r.name)).toEqual(['Real Hotel']);
    expect(ranked.dropped).toEqual(expect.arrayContaining([{ reason: 'no name or no position', count: 2 }, { reason: 'outside the search radius', count: 1 }]));
  });

  it('one property in two sources is shown once, from one record, never merged', () => {
    const reading = readTripForLodging({ interests: { hot_springs: 'core' }, primaryMode: 'rail', adults: 2, children: 0 });
    const osm = candidate({ sourceId: 'osm:node/9', source: 'osm', licence: 'ODbL-1.0', name: '湯の宿 山水', altName: 'Sansui Inn', coordinates: at(0.5), amenities: [{ kind: 'onsen', value: 'yes', basis: 'mapped' }], stars: 3 });
    const overture = candidate({ sourceId: 'overture:x', name: 'Sansui Inn', coordinates: at(0.52), website: 'https://sansui.example.jp/' });
    const ranked = rankLodgingProperties([overture, osm], BASE, reading);
    expect(ranked.recommendations).toHaveLength(1);
    const shown = ranked.recommendations[0]!;
    expect(shown.source).toBe('osm');
    /* The OSM record does not borrow the Overture website. */
    expect(shown.links.some((l) => l.kind === 'website')).toBe(true);
    expect(shown.links.find((l) => l.kind === 'website')!.href).toBe('https://example.org/osm:node/9');
    expect(ranked.dropped).toContainEqual({ reason: 'the same property listed twice', count: 1 });
  });

  it('keeps a Japanese name exactly, and searches by the Latin name the record carries', () => {
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 1 });
    const ranked = rankLodgingProperties([candidate({ sourceId: 'j', name: '旅館あづまや', altName: 'Ryokan Azumaya', type: 'ryokan', typeBasis: 'name', locality: '田辺市' })], BASE, reading);
    const rec = ranked.recommendations[0]!;
    expect(rec.name).toBe('旅館あづまや');
    expect(rec.typeLabel).toBe('Ryokan (traditional inn)');
    const search = new URL(rec.links.find((l) => l.kind === 'booking_search')!.href);
    expect(search.searchParams.get('ss')).toBe('Ryokan Azumaya, 田辺市');
    expect(search.searchParams.get('checkin')).toBe('2026-09-12');
    expect(search.searchParams.get('checkout')).toBe('2026-09-15');
    expect(search.searchParams.get('group_adults')).toBe('2');
    expect(search.searchParams.get('group_children')).toBe('1');
    expect(search.searchParams.get('no_rooms')).toBe('1');
  });

  it('shows at most five, four by default, and never a price or an availability', () => {
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 0 });
    const many = Array.from({ length: 9 }, (_, i) => candidate({ sourceId: `h${i}`, name: `Hotel Number ${'ABCDEFGHI'[i]}`, coordinates: at(0.2 * i, 0.1 * i) }));
    expect(rankLodgingProperties(many, BASE, reading).recommendations).toHaveLength(4);
    expect(rankLodgingProperties(many, BASE, reading, { limit: 9 }).recommendations).toHaveLength(5);
    expect(JSON.stringify(rankLodgingProperties(many, BASE, reading))).not.toMatch(/price|available|availability|per night|\$|€|¥/i);
  });

  it('a stated trip concept adds its themes beside the profile', () => {
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 0, concept: [{ theme: 'wellness', because: 'a slow trip built around bathing' }] });
    expect(reading.themes.find((t) => t.theme === 'wellness')).toEqual({ theme: 'wellness', because: 'a slow trip built around bathing', source: 'concept' });
  });
});

describe('property words and links', () => {
  it('reads a type and a hot spring from a name, and refuses listings that are not properties', () => {
    expect(lodgingTypeFromName('民宿てるてや')).toBe('minshuku');
    expect(lodgingTypeFromName('よしのや旅館')).toBe('ryokan');
    expect(lodgingTypeFromName('Old Mill Guest House')).toBe('guesthouse');
    expect(lodgingTypeFromName('Hotel Katla')).toBeNull();
    expect(nameSaysHotSpring('温泉民宿大村屋')).toBe(true);
    expect(nameSaysHotSpring('Guest house and onsen Wadama')).toBe(true);
    expect(nameSaysHotSpring('Hotel Katla')).toBe(false);
    expect(isNotAProperty('湯の峰温泉 バス停')).toBe(true);
    expect(isNotAProperty('伊せや')).toBe(false);
  });

  it('builds one booking search with dates and party, and a map link at the recorded point', () => {
    expect(bookingComSearchUrl({ query: 'Hotel Katla, Vík', checkIn: '2026-09-12', checkOut: '2026-09-15', adults: 2, children: 0 })).toBe(
      'https://www.booking.com/searchresults.html?ss=Hotel%20Katla%2C%20V%C3%ADk&checkin=2026-09-12&checkout=2026-09-15&group_adults=2&no_rooms=1',
    );
    expect(propertyMapUrl({ lat: 1.234567, lng: 2.5 }, 'node/42')).toBe('https://www.openstreetmap.org/node/42');
    expect(propertyMapUrl({ lat: 1.234567, lng: 2.5 })).toBe('https://www.openstreetmap.org/?mlat=1.23457&mlon=2.50000#map=18/1.23457/2.50000');
  });
});
