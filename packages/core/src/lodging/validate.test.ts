import { describe, expect, it } from 'vitest';
import { lodgingTypeFromName, type LodgingPropertyCandidate } from './property';
import { rankLodgingProperties, readTripForLodging, type LodgingBaseContext } from './rank';
import { isNonLodgingCategory, validateLodgingCandidates } from './validate';

/*
 * Rows shaped like the live staging failures: a web-design firm filed under
 * lodging (Arusha), a bare town row (Les Houches), and a Japanese Alps hut whose
 * source row put it in central Tokyo. Coordinates are real; the neighbours are
 * the ordinary hotels any box around those points holds.
 */

function overture(partial: Partial<LodgingPropertyCandidate> & { sourceId: string; name: string; coordinates: { lat: number; lng: number } }): LodgingPropertyCandidate {
  return {
    source: 'overture',
    type: 'hotel',
    typeBasis: 'category',
    amenities: [],
    licence: 'CDLA-Permissive-2.0',
    attribution: 'Overture Maps Foundation',
    website: `https://example.org/${partial.sourceId}`,
    confidence: 0.95,
    evidence: { categories: ['hotel'] },
    ...partial,
  };
}

function osm(partial: Partial<LodgingPropertyCandidate> & { sourceId: string; name: string; coordinates: { lat: number; lng: number } }): LodgingPropertyCandidate {
  return {
    source: 'osm',
    type: 'hotel',
    typeBasis: 'category',
    amenities: [],
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors (ODbL)',
    evidence: { categories: ['tourism=hotel'] },
    ...partial,
  };
}

/** n hotels scattered within ~400 m of a point, each stating `region`. */
function hotelsAround(prefix: string, at: { lat: number; lng: number }, n: number, region: string): LodgingPropertyCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    overture({ sourceId: `${prefix}-${i}`, name: `${prefix} Hotel ${i + 1}`, coordinates: { lat: at.lat + ((i % 5) - 2) * 0.0007, lng: at.lng + (Math.floor(i / 5) - 1) * 0.0008 }, evidence: { categories: ['hotel'], region, country: 'JP' } }),
  );
}

const SHINJUKU = { lat: 35.6905, lng: 139.7005 };
const ARUSHA = { lat: -3.3869, lng: 36.683 };
const LES_HOUCHES = { lat: 45.8906, lng: 6.7989 };
const KAMIKOCHI = { lat: 36.2486, lng: 137.6378 };

describe('lodging validation — evidence, not names', () => {
  it('refuses a web-design firm filed under lodging by its other category, whatever its name', () => {
    const firm = overture({ sourceId: 'web', name: 'Kilimanjaro Creative Studio', coordinates: ARUSHA, evidence: { categories: ['hotel', 'web_designer', 'software_development'] } });
    const named = overture({ sourceId: 'web2', name: 'Arusha Website Design', coordinates: { lat: ARUSHA.lat + 0.001, lng: ARUSHA.lng } });
    const hotel = overture({ sourceId: 'h', name: 'Arusha Coffee Lodge', coordinates: { lat: ARUSHA.lat + 0.01, lng: ARUSHA.lng }, type: 'lodge', evidence: { categories: ['lodge', 'restaurant', 'bar'] } });
    const result = validateLodgingCandidates([firm, named, hotel], { name: 'Arusha', coordinates: ARUSHA }, { radiusKm: 3 });
    expect(result.kept.map((c) => c.name)).toEqual(['Arusha Coffee Lodge']);
    expect(result.rejected.map((r) => [r.candidate.sourceId, r.reason])).toEqual([
      ['web', 'filed under another trade too'],
      ['web2', 'not somewhere to sleep'],
    ]);
  });

  it('reads category ids by token, so a hotel bar or a bus tour is not another trade', () => {
    expect(isNonLodgingCategory('web_designer')).toBe(true);
    expect(isNonLodgingCategory('office=it')).toBe(true);
    expect(isNonLodgingCategory('insurance_agency')).toBe(true);
    expect(isNonLodgingCategory('hotel_bar')).toBe(false);
    expect(isNonLodgingCategory('bus_tour_agency')).toBe(false);
    expect(isNonLodgingCategory('restaurant')).toBe(false);
    expect(isNonLodgingCategory('tourism=guest_house')).toBe(false);
  });

  it('refuses a row that is only its town, while a guesthouse with only an OSM tag stays', () => {
    const town = overture({ sourceId: 'town', name: 'Les Houches', coordinates: LES_HOUCHES, type: 'other' });
    const gite = osm({ sourceId: 'osm:node/9', name: 'Gîte Michel Fagot', coordinates: { lat: LES_HOUCHES.lat + 0.004, lng: LES_HOUCHES.lng }, type: 'guesthouse', evidence: { categories: ['tourism=guest_house'] } });
    const result = validateLodgingCandidates([town, gite], { name: 'Les Houches', coordinates: LES_HOUCHES }, { radiusKm: 4 });
    expect(result.kept.map((c) => c.sourceId)).toEqual(['osm:node/9']);
    expect(result.rejected[0]).toMatchObject({ reason: 'not somewhere to sleep' });
  });

  it('refuses a mountain hut placed among Shinjuku hotels, by type against setting and by its own address', () => {
    const hotels = hotelsAround('Shinjuku', SHINJUKU, 15, '東京都');
    expect(lodgingTypeFromName('涸沢ヒュッテ')).toBe('mountain_hut');
    const hut = overture({ sourceId: 'karasawa', name: '涸沢ヒュッテ', coordinates: { lat: SHINJUKU.lat + 0.0003, lng: SHINJUKU.lng + 0.0002 }, type: 'mountain_hut', website: undefined, evidence: { categories: ['mountain_hut'], region: '長野県', country: 'JP' } });
    const result = validateLodgingCandidates([...hotels, hut], { name: 'Shinjuku', coordinates: SHINJUKU }, { radiusKm: 3 });
    expect(result.kept.some((c) => c.sourceId === 'karasawa')).toBe(false);
    expect(result.kept).toHaveLength(15);

    /* The address alone is enough, even if the source had called it a hotel. */
    const asHotel = { ...hut, sourceId: 'karasawa-hotel', type: 'hotel' as const };
    const byAddress = validateLodgingCandidates([...hotels, asHotel], { name: 'Shinjuku', coordinates: SHINJUKU }, { radiusKm: 3 });
    expect(byAddress.rejected).toEqual([{ candidate: asHotel, reason: 'its own address names somewhere else' }]);

    /* And with no address, the setting alone: a hut with fifteen hotels inside 500 m. */
    const bare = { ...hut, sourceId: 'karasawa-bare', evidence: { categories: ['mountain_hut'] } };
    const bySetting = validateLodgingCandidates([...hotels, bare], { name: 'Shinjuku', coordinates: SHINJUKU }, { radiusKm: 3 });
    expect(bySetting.rejected).toEqual([{ candidate: bare, reason: 'its type does not fit where it is placed' }]);
  });

  it('refuses the same hut placed at its true position when the base is Tokyo — it is out of reach', () => {
    const hut = overture({ sourceId: 'karasawa', name: '涸沢ヒュッテ', coordinates: { lat: 36.2925, lng: 137.6497 }, type: 'mountain_hut' });
    const result = validateLodgingCandidates([hut], { name: 'Tokyo', coordinates: SHINJUKU }, { radiusKm: 12 });
    expect(result.rejected[0]!.reason).toBe('outside the search radius');
  });

  it('keeps a genuine city hotel, and a genuine hut at a mountain base', () => {
    const hotels = hotelsAround('Shinjuku', SHINJUKU, 15, '東京都');
    const city = validateLodgingCandidates(hotels, { name: 'Shinjuku', coordinates: SHINJUKU }, { radiusKm: 3 });
    expect(city.kept).toHaveLength(15);

    const lodge = overture({ sourceId: 'lodge', name: 'Kamikochi Lodge', coordinates: KAMIKOCHI, type: 'lodge', evidence: { categories: ['lodge'], region: '長野県', country: 'JP' } });
    const hut = osm({ sourceId: 'osm:node/77', name: '徳沢ヒュッテ', coordinates: { lat: 36.2733, lng: 137.6797 }, type: 'mountain_hut', evidence: { categories: ['tourism=alpine_hut'], region: '長野県' } });
    const mountain = validateLodgingCandidates([lodge, hut], { name: 'Kamikochi', coordinates: KAMIKOCHI }, { radiusKm: 6 });
    expect(mountain.kept.map((c) => c.sourceId)).toEqual(['lodge', 'osm:node/77']);
  });

  it('never reads a spelling as a wrong address: "Tokyo" among "東京都" is the same place', () => {
    const hotels = hotelsAround('Shinjuku', SHINJUKU, 8, '東京都');
    const latin = overture({ sourceId: 'latin', name: 'Hotel Gracery', coordinates: SHINJUKU, evidence: { categories: ['hotel'], region: 'Tokyo', country: 'JP' } });
    expect(validateLodgingCandidates([...hotels, latin], { name: 'Shinjuku', coordinates: SHINJUKU }, { radiusKm: 3 }).kept).toContain(latin);
  });

  it('refuses a thin listing with no website unless the other source holds the same property', () => {
    const thin = overture({ sourceId: 'thin', name: 'Haus Alpenblick', coordinates: LES_HOUCHES, confidence: 0.74, website: undefined });
    expect(validateLodgingCandidates([thin], { name: 'Les Houches', coordinates: LES_HOUCHES }, { radiusKm: 4 }).rejected[0]!.reason).toBe('too thinly listed to stand behind');
    const mapped = osm({ sourceId: 'osm:way/5', name: 'Haus Alpenblick', coordinates: { lat: LES_HOUCHES.lat + 0.0004, lng: LES_HOUCHES.lng } });
    expect(validateLodgingCandidates([thin, mapped], { name: 'Les Houches', coordinates: LES_HOUCHES }, { radiusKm: 4 }).kept).toHaveLength(2);
  });

  it('keeps a thin listing whose own name says it is somewhere to sleep', () => {
    const named = overture({ sourceId: 'named', name: 'Crater Rim Hotel', coordinates: LES_HOUCHES, confidence: 0.6, website: undefined });
    expect(validateLodgingCandidates([named], { name: 'Les Houches', coordinates: LES_HOUCHES }, { radiusKm: 4 }).kept).toContain(named);
  });

  it('the ranker shows fewer and counts what it held back', () => {
    const base: LodgingBaseContext = { baseId: 'b', name: 'Shinjuku', coordinates: SHINJUKU, nights: 2, checkIn: '2026-10-01', checkOut: '2026-10-03', dayStarts: [] };
    const reading = readTripForLodging({ primaryMode: 'rail', adults: 2, children: 0, rusticLodgingOk: true });
    const ranked = rankLodgingProperties(
      [
        overture({ sourceId: 'real', name: 'Hotel Sunroute Plaza', coordinates: SHINJUKU }),
        overture({ sourceId: 'firm', name: 'Shinjuku Digital', coordinates: SHINJUKU, evidence: { categories: ['hotel', 'digital_marketing_agency'] } }),
        overture({ sourceId: 'town', name: 'Shinjuku', coordinates: SHINJUKU }),
      ],
      base,
      reading,
    );
    expect(ranked.recommendations.map((r) => r.sourceId)).toEqual(['real']);
    expect(ranked.heldBack).toBe(2);
    expect(ranked.limit).toBe(4);
  });
});
