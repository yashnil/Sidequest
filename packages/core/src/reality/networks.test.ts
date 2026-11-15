import { describe, expect, it } from 'vitest';
import { busSparseWithoutRail, highSpeedRailBackbone, publicTransportNetwork, transportNetworkAt } from './jurisdictions';
import { networkComponentAt, singleRegionCode, SUBNATIONAL_NETWORKS } from './networks';
import { buildTravelReality } from './build';
import { modeStatusFor } from './schema';
import { JURISDICTIONS } from './jurisdictions';

/**
 * Transport infrastructure applies per piece of ground, never per country.
 * Every case is coordinates and ISO codes; nothing in the logic names a place.
 */
const P = (lat: number, lng: number) => ({ lat, lng });
const funchal = P(32.65, -16.91);
const arieiro = P(32.735, -16.928);
const lisbon = P(38.72, -9.14);
const porto = P(41.15, -8.61);
const pontaDelgada = P(37.74, -25.67);
const tokyo = P(35.68, 139.76);
const kyoto = P(35.01, 135.77);
const sapporo = P(43.06, 141.35);
const asahikawa = P(43.77, 142.36);
const naha = P(26.21, 127.68);
const cagliari = P(39.22, 9.12);
const sassari = P(40.73, 8.56);
const rome = P(41.9, 12.5);
const florence = P(43.77, 11.25);
const palma = P(39.57, 2.65);
const manacor = P(39.57, 3.21);
const ibiza = P(38.91, 1.43);
const laguna = P(28.49, -16.31);
const honolulu = P(21.31, -157.86);
const hilo = P(19.72, -155.08);
const heraklion = P(35.34, 25.13);
const hobart = P(-42.88, 147.33);
const torshavn = P(62.01, -6.77);

describe('subnational network rows', () => {
  it('every row belongs to a country and every component has land', () => {
    for (const row of SUBNATIONAL_NETWORKS) {
      expect(row.code.startsWith(`${row.countryCode}-`)).toBe(true);
      expect(row.components.length).toBeGreaterThan(0);
      for (const c of row.components) {
        expect(c.extents.length).toBeGreaterThan(0);
        for (const b of c.extents) expect(b.south < b.north && b.west < b.east).toBe(true);
      }
    }
  });

  it('a component never claims a service its country row does not state (rows only narrow)', () => {
    for (const row of SUBNATIONAL_NETWORKS) {
      const country = publicTransportNetwork(row.countryCode);
      for (const c of row.components) {
        const p = { lat: (c.extents[0]!.south + c.extents[0]!.north) / 2, lng: (c.extents[0]!.west + c.extents[0]!.east) / 2 };
        const here = transportNetworkAt(row.countryCode, { points: [p] });
        if (!country.intercityRail) expect(here.intercityRail).toBe(false);
        if (!country.metro) expect(here.metro).toBe(false);
      }
    }
  });

  it('no mainland city of a country falls inside one of its subdivision components', () => {
    expect(networkComponentAt('PT', lisbon)).toBeNull();
    expect(networkComponentAt('PT', porto)).toBeNull();
    expect(networkComponentAt('JP', tokyo)).toBeNull();
    expect(networkComponentAt('JP', kyoto)).toBeNull();
    expect(networkComponentAt('IT', rome)).toBeNull();
    expect(networkComponentAt('IT', florence)).toBeNull();
    expect(networkComponentAt('IT', P(38.11, 15.65))).toBeNull(); // Calabrian shore of the strait
    expect(networkComponentAt('JP', P(41.5, 141.0))).toBeNull(); // Honshu's northern peninsula
  });
});

describe('transportNetworkAt — per subdivision', () => {
  it('Madeira (PT-30): no railway, no metro, thin buses — by code and by coordinates', () => {
    for (const locator of [{ regionCode: 'PT-30' }, { points: [funchal, arieiro] }, { regionCode: 'pt-30', points: [funchal] }]) {
      const n = transportNetworkAt('PT', locator);
      expect(n).toMatchObject({ intercityRail: false, highSpeedRail: false, metro: false, busSparse: true, basis: 'subdivision', subdivisions: ['PT-30'] });
    }
    expect(busSparseWithoutRail('PT', { points: [funchal] })).toBe(true);
  });

  it('the Azores (PT-20) have no railway either', () => {
    expect(publicTransportNetwork('PT', { points: [pontaDelgada] })).toEqual({ intercityRail: false, metro: false });
  });

  it('mainland Portugal keeps its trains: Lisbon to Porto is rail', () => {
    expect(publicTransportNetwork('PT', { points: [lisbon, porto] }).intercityRail).toBe(true);
    expect(transportNetworkAt('PT', { points: [lisbon, porto] }).basis).toBe('country');
  });

  it('a question spanning an island and the mainland gets only what both have', () => {
    expect(publicTransportNetwork('PT', { points: [lisbon, funchal] }).intercityRail).toBe(false);
  });

  it('Japan: Tokyo–Kyoto keeps the high-speed backbone; Hokkaido has trains but not that backbone; Okinawa has no railway', () => {
    expect(highSpeedRailBackbone('JP', { points: [tokyo, kyoto] })).toBe(true);
    expect(highSpeedRailBackbone('JP', { points: [sapporo, asahikawa] })).toBe(false);
    expect(publicTransportNetwork('JP', { points: [sapporo, asahikawa] })).toEqual({ intercityRail: true, metro: true });
    expect(publicTransportNetwork('JP', { points: [naha] })).toEqual({ intercityRail: false, metro: false });
  });

  it('Sardinia keeps regional trains but not Italy\'s high-speed backbone', () => {
    const n = transportNetworkAt('IT', { points: [cagliari, sassari] });
    expect(n.intercityRail).toBe(publicTransportNetwork('IT').intercityRail);
    expect(n.highSpeedRail).toBe(false);
  });

  it('the Balearics: Mallorca keeps its island railway, Ibiza has none, and the code alone is the cautious answer', () => {
    expect(publicTransportNetwork('ES', { regionCode: 'ES-IB', points: [palma, manacor] }).intercityRail).toBe(true);
    expect(publicTransportNetwork('ES', { points: [ibiza] }).intercityRail).toBe(false);
    expect(publicTransportNetwork('ES', { regionCode: 'ES-IB' }).intercityRail).toBe(false);
  });

  it('the Canaries, Hawaii, Crete and Tasmania inherit no mainland rail or metro', () => {
    expect(publicTransportNetwork('ES', { points: [laguna] })).toEqual({ intercityRail: false, metro: false });
    expect(highSpeedRailBackbone('ES', { points: [laguna] })).toBe(false);
    expect(publicTransportNetwork('US', { points: [honolulu, hilo] })).toEqual({ intercityRail: false, metro: false });
    expect(publicTransportNetwork('GR', { points: [heraklion] }).metro).toBe(false);
    expect(publicTransportNetwork('AU', { points: [hobart] }).intercityRail).toBe(false);
    expect(busSparseWithoutRail('US', { points: [hilo] })).toBe(true);
    expect(busSparseWithoutRail('US', { points: [honolulu] })).toBe(false);
  });

  it('the Faroe Islands have no row and no railway: unknown is not a railway', () => {
    expect(publicTransportNetwork('FO', { points: [torshavn] })).toEqual({ intercityRail: false, metro: false });
    expect(highSpeedRailBackbone('FO', { points: [torshavn] })).toBe(false);
  });

  it('a point is only matched against its own country\'s rows', () => {
    expect(networkComponentAt('MA', P(28.3, -14.0))).toBeNull();
    expect(networkComponentAt('ES', P(28.3, -14.0))?.code).toBe('ES-CN');
  });

  it('singleRegionCode reads exactly one subnational jurisdiction in the country', () => {
    expect(singleRegionCode([{ level: 'country', code: 'PT', countryCode: 'PT' }, { level: 'subnational', code: 'PT-30', countryCode: 'PT' }], 'PT')).toBe('PT-30');
    expect(singleRegionCode([{ level: 'subnational', code: 'CA-AB', countryCode: 'CA' }, { level: 'subnational', code: 'CA-BC', countryCode: 'CA' }], 'CA')).toBeNull();
    expect(singleRegionCode([], 'PT')).toBeNull();
  });
});

describe('buildTravelReality — the ground narrows the country', () => {
  const CAPS = { roadRouting: true, transit: false };
  it('an island region of a rail country: trains unavailable, no rail setup, a rail leg is refused by the reality', () => {
    const reality = buildTravelReality({ label: 'An island region', countries: ['PT'], crossBorder: false, entityType: 'state_or_province', traits: ['mountain'], tripDays: 7, capabilities: CAPS, network: { regionCode: 'PT-30', points: [funchal] } });
    expect(modeStatusFor(reality, 'intercity_train', 'regional')).toBe('unavailable');
    expect(reality.recommendation?.regional ?? []).not.toContain('intercity_train');
    expect(reality.facts.some((f) => f.id.startsWith('subdivision-network-'))).toBe(true);
  });

  it('the mainland keeps the country answer', () => {
    const reality = buildTravelReality({ label: 'A mainland region', countries: ['PT'], crossBorder: false, entityType: 'state_or_province', traits: [], tripDays: 7, capabilities: CAPS, network: { points: [lisbon] } });
    expect(modeStatusFor(reality, 'intercity_train', 'regional')).toBe('recommended');
  });

  it('a rail-pass setup item never reaches a subdivision with no railway', () => {
    const jp = JURISDICTIONS.find((j) => j.code === 'JP')!;
    const railSetup = jp.setup.filter((s) => s.onlyWhen === 'rail').map((s) => s.id);
    const reality = buildTravelReality({ label: 'Islands', countries: ['JP'], crossBorder: false, entityType: 'state_or_province', traits: ['island'], tripDays: 7, capabilities: CAPS, network: { points: [naha] } });
    for (const id of railSetup) expect(reality.setup.map((s) => s.id)).not.toContain(id);
  });
});
