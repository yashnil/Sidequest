import { describe, expect, it } from 'vitest';
import { utcOffsetMinutesOn } from './zone';
import { zoneAt, zoneAtPoint, zoneForPlace } from './zone-lookup';

/*
 * Real coordinates, chosen for what makes each zone hard: a half-hour or
 * quarter-hour offset, a half-hour daylight shift, an island a country default
 * gets wrong, a border city pair, the high Arctic and the open sea.
 */
describe('zoneAt — the civil zone at a coordinate, from the boundaries', () => {
  it('Kauai is Pacific/Honolulu, never the United States default', () => {
    expect(zoneAt(22.07, -159.5)).toBe('Pacific/Honolulu');
  });

  it('the Western Australia border: Eucla keeps its own +08:45 zone, Perth and Adelaide theirs', () => {
    expect(zoneAt(-31.68, 128.88)).toBe('Australia/Eucla');
    expect(utcOffsetMinutesOn('2027-01-15', 'Australia/Eucla')).toBe(8 * 60 + 45);
    expect(zoneAt(-31.95, 115.86)).toBe('Australia/Perth');
    expect(zoneAt(-34.93, 138.6)).toBe('Australia/Adelaide');
  });

  it('Kathmandu is +05:45', () => {
    expect(zoneAt(27.7, 85.32)).toBe('Asia/Kathmandu');
    expect(utcOffsetMinutesOn('2027-01-15', 'Asia/Kathmandu')).toBe(5 * 60 + 45);
  });

  it('Lord Howe Island is its own zone with a half-hour daylight shift', () => {
    expect(zoneAt(-31.55, 159.08)).toBe('Australia/Lord_Howe');
    expect(utcOffsetMinutesOn('2027-01-15', 'Australia/Lord_Howe') - utcOffsetMinutesOn('2027-07-15', 'Australia/Lord_Howe')).toBe(30);
  });

  it('a cross-border pair: Ciudad Juárez and El Paso are a river apart and on different zones', () => {
    const juarez = zoneAt(31.69, -106.42);
    const elPaso = zoneAt(31.8, -106.45);
    expect(juarez).toBe('America/Ciudad_Juarez');
    expect(elPaso).toBe('America/Denver');
    expect(juarez).not.toBe(elPaso);
  });

  it('Svalbard answers a zone the runtime knows, on Central European time', () => {
    const zone = zoneAt(78.22, 15.65)!;
    expect(zone).not.toBeNull();
    expect(utcOffsetMinutesOn('2027-01-15', zone)).toBe(60);
  });

  /*
   * Decided: open ocean is `null`. The table answers a nautical `Etc/GMT±N`
   * there, which is a fixed offset, not anybody's civil clock; returning it
   * would let a caller treat it as resolved. A caller's own last resort
   * (`deriveTimeZoneFromLongitude`) produces the same offset, labelled derived.
   */
  it('open ocean is null, never a nautical Etc zone presented as resolved', () => {
    expect(zoneAt(0, -140)).toBeNull();
    expect(zoneAt(-40, -120)).toBeNull();
  });

  it('an invalid coordinate is null rather than a throw', () => {
    expect(zoneAt(Number.NaN, 10)).toBeNull();
    expect(zoneAt(91, 10)).toBeNull();
    expect(zoneAt(10, 181)).toBeNull();
    expect(zoneAtPoint(null)).toBeNull();
    expect(zoneAtPoint({ lat: 0, lng: 0 })).toBeNull();
  });
});

describe('zoneForPlace — the coordinate is the authority, a carried zone the fallback', () => {
  it('the zone at the centre outranks a country default the source carried', () => {
    expect(zoneForPlace({ center: { lat: 22.07, lng: -159.5 }, published: 'America/New_York' })).toBe('Pacific/Honolulu');
  });

  it('a carried zone stands only where the boundaries cannot answer, and only if it fits the longitude', () => {
    expect(zoneForPlace({ center: null, published: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(zoneForPlace({ center: { lat: 0, lng: -140 }, published: 'America/New_York' })).toBeNull();
    expect(zoneForPlace({ center: { lat: 0, lng: -140 }, published: 'Pacific/Marquesas' })).toBe('Pacific/Marquesas');
    expect(zoneForPlace({ center: null, published: 'Etc/GMT+1' })).toBeNull();
    expect(zoneForPlace({ center: null, published: 'Pacific time' })).toBeNull();
  });

  it('a whole country keeps its published civil zone ahead of a centroid that is nowhere anybody stays', () => {
    expect(zoneForPlace({ center: { lat: -25.27, lng: 133.78 }, published: 'Australia/Sydney', wholeCountry: true })).toBe('Australia/Sydney');
    expect(zoneForPlace({ center: { lat: -25.27, lng: 133.78 }, published: null, wholeCountry: true })).toBe('Australia/Darwin');
  });
});
