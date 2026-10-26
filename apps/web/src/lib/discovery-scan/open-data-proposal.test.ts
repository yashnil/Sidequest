import { describe, expect, it, vi } from 'vitest';
import type { OverpassElement, OverpassResult } from '../providers/overpass';
import {
  NOTABLE_SELECTORS,
  boxAround,
  boxHalfKmFor,
  dedupePlaces,
  displayNameFor,
  fixtureOpenDataDeps,
  kindForTags,
  proposeFromOpenData,
  rankPlaces,
  readElement,
  selectPool,
  tierPlaces,
  type OpenDataDeps,
  type OpenDataPlace,
} from './open-data-proposal';

/**
 * THE OPEN-DATA PROPOSAL, WITH ZERO CALLS.
 *
 * The scan's fallback when the research model is unavailable: notable mapped
 * places from OpenStreetMap, ordered with Wikidata sitelinks, written as the
 * same `ScanProposal` the model would have produced. Every network answer here
 * is injected.
 */

const CENTER = { lat: 48.2, lng: 16.37 };

function result(elements: OverpassElement[]): OverpassResult {
  return { elements, dataTimestamp: null, calls: 1, cacheHit: false, bytes: 0, failedGroups: [] };
}

function node(id: number, tags: Record<string, string>, dLat = 0.01, dLng = 0.01): OverpassElement {
  return { type: 'node', id, lat: CENTER.lat + dLat, lon: CENTER.lng + dLng, tags };
}

function place(overrides: Partial<OpenDataPlace> & { name: string }): OpenDataPlace {
  const base = readElement(node(1, { tourism: 'museum', name: overrides.name, wikidata: 'Q1' }), CENTER, [])!;
  return { ...base, ...overrides };
}

describe('tag → kind', () => {
  it('maps the notable tags to scan kinds with category defaults', () => {
    expect(kindForTags({ tourism: 'museum' })?.spec).toMatchObject({ kind: 'museum', exposure: 'indoor', rainyDayOk: true });
    expect(kindForTags({ natural: 'waterfall' })?.spec.kind).toBe('waterfall');
    expect(kindForTags({ waterway: 'waterfall' })?.spec.kind).toBe('waterfall');
    expect(kindForTags({ historic: 'castle' })?.spec.kind).toBe('castle_or_palace');
    expect(kindForTags({ natural: 'peak' })?.spec).toMatchObject({ kind: 'day_hike', intensity: 'strenuous' });
    expect(kindForTags({ natural: 'peak' })?.spec.caution).toMatch(/not been checked/);
    expect(kindForTags({ amenity: 'marketplace' })?.spec.kind).toBe('market');
    expect(kindForTags({ place: 'village' })?.spec.kind).toBe('small_town');
    expect(kindForTags({ leisure: 'nature_reserve' })?.spec.kind).toBe('easy_walk');
  });

  it('tells a temple from a church by the religion the map records', () => {
    expect(kindForTags({ amenity: 'place_of_worship', religion: 'buddhist' })?.spec.kind).toBe('temple_or_shrine');
    expect(kindForTags({ amenity: 'place_of_worship', religion: 'christian' })?.spec.kind).toBe('religious_site');
  });

  it('drops statues, busts and plaques, but keeps a memorial site and a statue mapped as an attraction', () => {
    expect(kindForTags({ historic: 'memorial', memorial: 'statue' })).toBeNull();
    expect(kindForTags({ historic: 'memorial', memorial: 'bust' })).toBeNull();
    expect(kindForTags({ historic: 'memorial', memorial: 'plaque' })).toBeNull();
    expect(kindForTags({ historic: 'monument', artwork_type: 'statue' })).toBeNull();
    expect(kindForTags({ historic: 'memorial' })?.spec.kind).toBe('landmark');
    expect(kindForTags({ historic: 'memorial', memorial: 'war_memorial' })?.spec.kind).toBe('landmark');
    expect(kindForTags({ tourism: 'attraction', historic: 'memorial', memorial: 'statue' })?.spec.kind).toBe('landmark');
  });

  it('keeps only water a traveller would visit, and nothing it has no word for', () => {
    expect(kindForTags({ natural: 'water', water: 'lake' })?.spec.kind).toBe('lake_or_river');
    expect(kindForTags({ natural: 'water', water: 'wastewater' })).toBeNull();
    expect(kindForTags({ shop: 'bakery' })).toBeNull();
    expect(kindForTags({ place: 'hamlet' })).toBeNull();
  });
});

describe('names', () => {
  it('prefers name:en when the published name is in another script, and keeps the original as the local name', () => {
    expect(displayNameFor({ name: '清水寺', 'name:en': 'Kiyomizu-dera' })).toEqual({ name: 'Kiyomizu-dera', localName: '清水寺' });
    expect(displayNameFor({ name: 'Schönbrunn Palace', 'name:en': 'Schoenbrunn' })).toEqual({ name: 'Schönbrunn Palace' });
    expect(displayNameFor({ name: '清水寺' })).toEqual({ name: '清水寺' });
    expect(displayNameFor({})).toBeNull();
  });

  it('drops an element with no name, no wikidata id or no position', () => {
    expect(readElement(node(1, { tourism: 'museum', wikidata: 'Q1' }), CENTER, [])).toBeNull();
    expect(readElement(node(1, { tourism: 'museum', name: 'A Museum' }), CENTER, [])).toBeNull();
    expect(readElement({ type: 'way', id: 2, tags: { tourism: 'museum', name: 'A Museum', wikidata: 'Q2' } }, CENTER, [])).toBeNull();
    expect(readElement(node(1, { tourism: 'museum', name: 'A Museum', wikidata: 'Q1' }), CENTER, [])?.name).toBe('A Museum');
  });
});

describe('ranking, dedupe, pool and tiers', () => {
  it('ranks by attention and interest match, never reading unknown sitelinks as zero', () => {
    const popular = place({ name: 'Popular', elementId: 'node/1', wikidata: 'Q1', sitelinks: 120, matched: [] });
    const fitting = place({ name: 'Fitting', elementId: 'node/2', wikidata: 'Q2', sitelinks: 20, matched: ['museums_and_galleries'] });
    const obscure = place({ name: 'Obscure', elementId: 'node/3', wikidata: 'Q3', sitelinks: 1, matched: [] });
    const unknown = place({ name: 'Unknown', elementId: 'node/4', wikidata: 'Q4', matched: [], tags: { wikipedia: 'en:Unknown' } });
    const ranked = rankPlaces([obscure, unknown, fitting, popular]).map((p) => p.name);
    expect(ranked[0]).toBe('Fitting');
    expect(ranked.indexOf('Popular')).toBeLessThan(ranked.indexOf('Obscure'));
    expect(ranked.indexOf('Unknown')).toBeLessThan(ranked.indexOf('Obscure'));
  });

  it('keeps one copy per Wikidata item and per name within 1.5 km', () => {
    const a = place({ name: 'Castle', elementId: 'node/1', wikidata: 'Q1', coordinates: CENTER });
    const sameItem = place({ name: 'Castle Keep', elementId: 'way/9', wikidata: 'Q1', coordinates: CENTER });
    const sameName = place({ name: 'castle', elementId: 'node/2', wikidata: 'Q2', coordinates: { lat: CENTER.lat + 0.005, lng: CENTER.lng } });
    const farNamesake = place({ name: 'Castle', elementId: 'node/3', wikidata: 'Q3', coordinates: { lat: CENTER.lat + 0.3, lng: CENTER.lng } });
    expect(dedupePlaces([a, sameItem, sameName, farNamesake]).map((p) => p.elementId)).toEqual(['node/1', 'node/3']);
  });

  it('caps any one kind at a quarter of the pool so the board stays mixed', () => {
    const peaks = Array.from({ length: 20 }, (_, i) => readElement(node(100 + i, { natural: 'peak', name: `Peak ${i}`, wikidata: `Q${100 + i}` }), CENTER, [])!);
    const museums = Array.from({ length: 5 }, (_, i) => readElement(node(200 + i, { tourism: 'museum', name: `Museum ${i}`, wikidata: `Q${200 + i}` }), CENTER, [])!);
    const pool = selectPool([...peaks, ...museums], 20);
    expect(pool.filter((p) => p.spec.kind === 'day_hike')).toHaveLength(5);
    expect(pool.filter((p) => p.spec.kind === 'museum')).toHaveLength(5);
  });

  it('caps one board category across the kinds that share it', () => {
    const tag = (i: number, tags: Record<string, string>) => readElement(node(300 + i, { ...tags, name: `Site ${i}`, wikidata: `Q${300 + i}` }), CENTER, [])!;
    const historic = [
      ...Array.from({ length: 6 }, (_, i) => tag(i, { historic: 'ruins' })),
      ...Array.from({ length: 6 }, (_, i) => tag(10 + i, { historic: 'castle' })),
      ...Array.from({ length: 6 }, (_, i) => tag(20 + i, { historic: 'memorial' })),
    ];
    const museums = Array.from({ length: 6 }, (_, i) => tag(40 + i, { tourism: 'museum' }));
    const pool = selectPool([...historic, ...museums], 20);
    expect(pool.filter((p) => p.spec.kind === 'museum')).toHaveLength(5);
    expect(pool.filter((p) => ['historic_site', 'castle_or_palace', 'landmark'].includes(p.spec.kind))).toHaveLength(8);
  });

  it('tiers the most-written-about third as classics, far places as side quests, the rest as hidden gems', () => {
    const near = (i: number, sitelinks: number) => place({ name: `P${i}`, elementId: `node/${i}`, wikidata: `Q${i}`, sitelinks, distanceKm: 2 });
    const pool = [near(1, 90), near(2, 50), near(3, 10), near(4, 5), near(5, 3), place({ name: 'Far', elementId: 'node/6', wikidata: 'Q6', sitelinks: 200, distanceKm: 60 })];
    const tiers = tierPlaces(pool, 'city');
    expect(tiers.get('node/6')).toBe('side_quest');
    expect(tiers.get('node/1')).toBe('classic');
    expect(tiers.get('node/5')).toBe('hidden_gem');
  });
});

describe('why', () => {
  it('describes a place by its category alone when no source states anything — no provenance, no distance, no interest clause', async () => {
    const out = await proposeFromOpenData(
      { envelope: { name: 'Harbour City', center: CENTER, scale: 'city' }, days: 5, priorities: ['museums_and_galleries'], carAvailable: true, reachKm: 120 },
      fixtureOpenDataDeps('Harbour City'),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const c of out.proposal.candidates) {
      expect(c.why).not.toMatch(/Wikidata|OpenStreetMap|km from|matches your interest/);
      expect(c.why.length).toBeLessThan(40);
    }
  });

  it('writes what Wikidata states when the details answer, and records how many answered', async () => {
    const deps = fixtureOpenDataDeps('Harbour City');
    const out = await proposeFromOpenData(
      { envelope: { name: 'Harbour City', center: CENTER, scale: 'city' }, days: 5, priorities: [], carAvailable: true, reachKm: 120 },
      {
        ...deps,
        fetchDetails: async (ids) =>
          new Map(
            ids
              .filter((id) => id === 'Q9100002')
              .map((id) => [id, { id, description: 'hilltop castle in Harbour City, Testland', inception: { year: 1147, precision: 9 }, heritage: ['National Monument of Testland'], architects: [], styles: [], instances: ['castle'] }]),
          ),
      },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal.candidates.find((c) => c.name === 'Harbour City Castle')?.why).toBe('Hilltop castle in Harbour City. Dates from 1147; listed as National Monument of Testland.');
    expect(out.diagnostics.detailsAnswered).toBe(1);
    expect(out.diagnostics.detailsAsked).toBeGreaterThan(1);
  });

  it('keeps the category label when the details request throws', async () => {
    const deps = fixtureOpenDataDeps('Harbour City');
    const out = await proposeFromOpenData(
      { envelope: { name: 'Harbour City', center: CENTER, scale: 'city' }, days: 5, priorities: [], carAvailable: true, reachKm: 120 },
      { ...deps, fetchDetails: async () => { throw new Error('down'); } },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal.candidates.find((c) => c.name === 'Harbour City Castle')?.why).toBe('Castle');
  });
});

describe('box sizing', () => {
  it('sizes the box by scale and never past the bbox ceiling', () => {
    expect(boxHalfKmFor('city', true, 120)).toBe(12);
    expect(boxHalfKmFor('local', true, 120)).toBe(6);
    expect(boxHalfKmFor('subregion', true, 250)).toBe(50);
    expect(boxHalfKmFor('region', true, 500)).toBe(90);
    expect(boxHalfKmFor('region', false, 500)).toBe(40);
    expect(boxHalfKmFor('country', true, 1600)).toBe(150);
    expect(boxHalfKmFor('country', false, 1600)).toBe(120);
    const wide = boxAround({ lat: 64, lng: -19 }, 150);
    expect(wide.north - wide.south).toBeLessThanOrEqual(3 + 1e-9);
    expect(wide.east - wide.west).toBeLessThanOrEqual(3 + 1e-9);
  });
});

describe('proposeFromOpenData', () => {
  const input = { envelope: { name: 'Harbour City', center: CENTER, scale: 'city' }, days: 5, priorities: ['museums_and_galleries' as const], carAvailable: true, reachKm: 120 };

  it('writes a normalised proposal with positions straight from the map', async () => {
    const out = await proposeFromOpenData(input, fixtureOpenDataDeps('Harbour City'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal.bases).toHaveLength(1);
    expect(out.proposal.bases[0]!.name).toBe('Harbour City');
    expect(out.proposal.candidates.length).toBeGreaterThanOrEqual(10);
    // The unnamed element is dropped; the castle mapped twice is one candidate.
    expect(out.proposal.candidates.filter((c) => c.name === 'Harbour City Castle')).toHaveLength(1);
    // name:en is shown, the published name kept.
    const temple = out.proposal.candidates.find((c) => c.name === 'Harbour City Hill Temple');
    expect(temple?.kind).toBe('temple_or_shrine');
    expect(temple?.localName).toBe('寺院');
    for (const c of out.proposal.candidates) {
      const position = out.positions.get(c.key);
      expect(position?.provider).toBe('openstreetmap');
      expect(position?.approximate).toBe(false);
      expect(c.why).not.toMatch(/On OpenStreetMap|On Wikidata/);
    }
    expect(out.positions.get(out.proposal.bases[0]!.key)?.coordinates).toEqual(CENTER);
    expect(out.proposal.skipped).toEqual([]);
    expect(out.proposal.foodAreas).toEqual([]);
    // The traveller's priority leads.
    expect(out.proposal.candidates[0]!.kind).toBe('museum');
  });

  it('is a typed failure, never a throw, when the map service refuses everything', async () => {
    const deps: OpenDataDeps = { source: 'openstreetmap+wikidata', fetchGroup: vi.fn(async () => { throw new Error('busy'); }), fetchSitelinks: vi.fn(async () => new Map()) };
    const out = await proposeFromOpenData(input, deps);
    expect(out).toMatchObject({ ok: false, reason: 'map_data_unavailable' });
    expect(deps.fetchGroup).toHaveBeenCalledTimes(NOTABLE_SELECTORS.length);
    expect(deps.fetchSitelinks).not.toHaveBeenCalled();
  });

  it('is map data unavailable, not a board of towns, when only the settlements answered', async () => {
    const towns = Array.from({ length: 12 }, (_, i) => ({ type: 'node' as const, id: 700 + i, lat: CENTER.lat + 0.1 * (i + 1), lon: CENTER.lng, tags: { place: 'town', name: `Town ${i}`, population: '5000', wikidata: `Q${700 + i}` } }));
    const deps: OpenDataDeps = {
      source: 'openstreetmap+wikidata',
      fetchGroup: async (_box, selector) => { if (selector.key !== 'place') throw new Error('busy'); return result(towns); },
      fetchSitelinks: async () => new Map(),
    };
    const out = await proposeFromOpenData({ ...input, envelope: { name: 'The Uplands', center: CENTER, scale: 'region' }, days: 6, reachKm: 500 }, deps);
    expect(out).toMatchObject({ ok: false, reason: 'map_data_unavailable' });
  });

  it('fails as too few places below four usable candidates', async () => {
    const deps: OpenDataDeps = {
      source: 'openstreetmap+wikidata',
      fetchGroup: async (_box, selector) => result(selector.key === 'tourism' ? [node(1, { tourism: 'museum', name: 'One', wikidata: 'Q1' }), node(2, { tourism: 'gallery', name: 'Two', wikidata: 'Q2' })] : []),
      fetchSitelinks: async () => new Map(),
    };
    expect(await proposeFromOpenData(input, deps)).toMatchObject({ ok: false, reason: 'too_few_places' });
  });

  it('survives Wikidata not answering: the order falls back to the map, nothing is read as zero', async () => {
    const deps = fixtureOpenDataDeps('Harbour City');
    const out = await proposeFromOpenData(input, { ...deps, fetchSitelinks: async () => { throw new Error('down'); } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.sitelinksAnswered).toBe(0);
    // With no counts, nothing is a classic by attention.
    expect(out.proposal.candidates.every((c) => c.tier !== 'classic')).toBe(true);
  });

  it('asks for the towns first on a broad trip, so a slow map service cannot starve the bases', async () => {
    const asked: string[] = [];
    const deps: OpenDataDeps = { source: 'openstreetmap+wikidata', fetchGroup: async (_box, selector) => { asked.push(selector.key); return result([]); }, fetchSitelinks: async () => new Map() };
    await proposeFromOpenData({ ...input, envelope: { name: 'The Uplands', center: CENTER, scale: 'country' }, days: 10, reachKm: 1600 }, deps);
    expect(asked[0]).toBe('place');
    asked.length = 0;
    await proposeFromOpenData(input, deps);
    expect(asked).not.toContain('place');
    expect(asked[0]).toBe('tourism');
  });

  it('on a broad multi-day trip sleeps in real towns, never at a centroid when a town is there', async () => {
    const towns = [
      { type: 'node' as const, id: 501, lat: CENTER.lat + 0.05, lon: CENTER.lng, tags: { place: 'town', name: 'Middleton', population: '40000', wikidata: 'Q501' } },
      { type: 'node' as const, id: 502, lat: CENTER.lat + 0.6, lon: CENTER.lng + 0.6, tags: { place: 'town', name: 'Farbury', population: '9000', wikidata: 'Q502' } },
    ];
    const near = (i: number, dLat: number, dLng: number): OverpassElement => node(600 + i, { tourism: 'museum', name: `Museum ${i}`, wikidata: `Q${600 + i}` }, dLat, dLng);
    const elements = [near(1, 0.02, 0), near(2, 0.03, 0.01), near(3, 0, 0.03), near(4, 0.6, 0.62), near(5, 0.62, 0.6), near(6, 0.58, 0.6)];
    const deps: OpenDataDeps = {
      source: 'openstreetmap+wikidata',
      fetchGroup: async (_box, selector) => result(selector.key === 'place' ? towns : selector.key === 'tourism' ? elements : []),
      fetchSitelinks: async () => new Map(),
    };
    const out = await proposeFromOpenData({ ...input, envelope: { name: 'The Uplands', center: CENTER, scale: 'region' }, days: 7, reachKm: 500 }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal.bases.map((b) => b.name)).toEqual(['Middleton', 'Farbury']);
    expect(out.proposal.candidates.some((c) => c.name === 'Middleton' || c.name === 'Farbury')).toBe(false);
    expect(out.positions.get(out.proposal.bases[0]!.key)?.providerRef).toBe('osm:node/501');
  });

  it('drops a row its source places only in another country, and keeps one that states none or both', async () => {
    const towns = [
      { type: 'node' as const, id: 701, lat: CENTER.lat + 0.05, lon: CENTER.lng, tags: { place: 'town', name: 'Homeburg', population: '40000', wikidata: 'Q701', 'sidequest:countries': 'AA' } },
      { type: 'node' as const, id: 702, lat: CENTER.lat + 0.6, lon: CENTER.lng + 0.6, tags: { place: 'city', name: 'Overthere', population: '90000', wikidata: 'Q702', 'sidequest:countries': 'BB' } },
    ];
    const museum = (i: number, dLat: number, dLng: number, countries?: string): OverpassElement => node(800 + i, { tourism: 'museum', name: `Museum ${i}`, wikidata: `Q${800 + i}`, ...(countries ? { 'sidequest:countries': countries } : {}) }, dLat, dLng);
    const elements = [museum(1, 0.02, 0, 'AA'), museum(2, 0.03, 0.01), museum(3, 0, 0.03, 'AA,BB'), museum(4, 0.6, 0.62, 'BB'), museum(5, 0.62, 0.6, 'BB'), museum(6, 0.01, 0.02, 'AA')];
    const deps: OpenDataDeps = {
      source: 'openstreetmap+wikidata',
      fetchGroup: async (_box, selector) => result(selector.key === 'place' ? towns : selector.key === 'tourism' ? elements : []),
      fetchSitelinks: async () => new Map(),
    };
    const out = await proposeFromOpenData({ ...input, envelope: { name: 'Aland', center: CENTER, scale: 'country' }, days: 7, reachKm: 500, countries: ['aa'] }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal.bases.map((b) => b.name)).not.toContain('Overthere');
    const names = out.proposal.candidates.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Museum 1', 'Museum 2', 'Museum 3', 'Museum 6']));
    expect(names).not.toContain('Museum 4');
    expect(out.diagnostics.outsideCountries).toBe(3);
  });

  it('searches each part of a destination in parts, never the open ocean between them, and sleeps in each', async () => {
    const mainland = { lat: 38.72, lng: -9.14 };
    const islands = { lat: 37.74, lng: -25.67 };
    const boxesAsked: { south: number; north: number }[] = [];
    const at = (c: { lat: number; lng: number }, id: number, tags: Record<string, string>, d: number): OverpassElement => ({ type: 'node', id, lat: c.lat + d, lon: c.lng + d, tags });
    const deps: OpenDataDeps = {
      source: 'openstreetmap+wikidata',
      fetchGroup: async (box, selector) => {
        boxesAsked.push({ south: box.south, north: box.north });
        const near = (c: { lat: number; lng: number }) => box.south <= c.lat && c.lat <= box.north;
        if (selector.key === 'place') return result([...(near(mainland) ? [at(mainland, 901, { place: 'city', name: 'Capital', population: '500000', wikidata: 'Q901' }, 0.01)] : []), ...(near(islands) ? [at(islands, 902, { place: 'town', name: 'Harbour Town', population: '60000', wikidata: 'Q902' }, 0.01)] : [])]);
        if (selector.key !== 'tourism') return result([]);
        return result([
          /* A capital far better written about than the islands: forty notable places to their three. */
          ...(near(mainland) ? Array.from({ length: 40 }, (_, i) => at(mainland, 1000 + i, { tourism: ['museum', 'attraction', 'viewpoint', 'gallery'][i % 4]!, name: `Mainland ${i + 1}`, wikidata: `Q${1000 + i}` }, 0.004 * (i + 1))) : []),
          ...(near(islands) ? [1, 2, 3].map((i) => at(islands, 920 + i, { tourism: 'viewpoint', name: `Island ${i}`, wikidata: `Q${920 + i}` }, 0.02 * i)) : []),
        ]);
      },
      fetchSitelinks: async (ids) => new Map(ids.map((id) => [id, Number(id.slice(1)) >= 1000 ? 120 : 6])),
    };
    const union = { lat: (mainland.lat + islands.lat) / 2, lng: (mainland.lng + islands.lng) / 2 };
    const out = await proposeFromOpenData(
      { ...input, envelope: { name: 'Capital and the Isles', center: union, scale: 'region' }, days: 8, reachKm: 2000, parts: [{ label: 'Capital', center: mainland }, { label: 'The Isles', center: islands }] },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // No box was ever drawn around the midpoint in the ocean.
    expect(boxesAsked.every((b) => !(b.south <= union.lat && union.lat <= b.north && Math.abs(b.north - b.south) < 10 && !(b.south <= mainland.lat && mainland.lat <= b.north) && !(b.south <= islands.lat && islands.lat <= b.north)))).toBe(true);
    expect(out.diagnostics.searchCentres).toBe(2);
    const names = out.proposal.candidates.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Mainland 1', 'Island 1']));
    expect(out.proposal.bases.map((b) => b.name)).toEqual(['Capital', 'Harbour Town']);
    // A place is in its part, never in the whole phrase.
    expect(out.proposal.candidates.every((c) => c.locality !== 'Capital and the Isles')).toBe(true);
  });
});
