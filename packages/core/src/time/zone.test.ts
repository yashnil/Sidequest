import { describe, expect, it } from 'vitest';
import {
  describeTimeZone,
  deriveTimeZoneFromLongitude,
  isCivilTimeZone,
  localDateIn,
  offsetLabel,
  resolveTimeZones,
  runtimeTimeZoneDataVersion,
  singleTimeZone,
  timeZoneConfidence,
  utcOffsetMinutesOn,
} from './zone';

/**
 * WHAT TIME IT IS WHERE THE TRAVELLER IS STANDING.
 *
 * Every opening hour, sunrise, day boundary, departure window and forecast
 * timestamp in the product is formatted through these functions, so an error
 * here is not a display bug — it moves a museum's opening time by an hour for
 * half the year across most of the inhabited world.
 *
 * The cases below are chosen because each one has broken a real product
 * somewhere: the sign inversion in POSIX zone names, the countries whose offset
 * is not a whole number of hours, the ones that observe daylight saving by
 * thirty minutes rather than sixty, the regions that span a boundary, and the
 * temptation to treat a fixed offset as a civil clock because it parses.
 */

describe('resolving a destination’s clock', () => {
  it('prefers a provider’s answer, and records that it was one', () => {
    const resolved = resolveTimeZones({
      published: ['Europe/Berlin'],
      center: { lat: 52.5, lng: 13.4 },
      resolved: {
        zones: ['Europe/Berlin'],
        source: 'open-meteo',
        resolvedAt: '2026-08-10T00:00:00.000Z',
      },
    });
    expect(resolved.basis).toBe('provider_resolved');
    expect(resolved.confidence).toBe('authoritative');
    expect(resolved.source).toBe('open-meteo');
    /*
     * The same zone from a weaker basis is a different claim, and the two must
     * not be indistinguishable — which is the entire reason `basis` exists.
     */
    const published = resolveTimeZones({
      published: ['Europe/Berlin'],
      center: { lat: 52.5, lng: 13.4 },
    });
    expect(published.basis).toBe('published');
    expect(published.source).toBeUndefined();
  });

  it('falls back to solar time and marks it degraded rather than authoritative', () => {
    const derived = resolveTimeZones({ published: [], center: { lat: 35.6, lng: 139.7 } });
    expect(derived.basis).toBe('derived_from_longitude');
    expect(derived.confidence).toBe('degraded');
    /* And it is structurally recognisable as a fixed offset, not only by basis. */
    expect(isCivilTimeZone(derived.zones[0]!)).toBe(false);
  });

  it('never lets an empty provider answer count as a resolution', () => {
    /*
     * The failure this prevents: a provider that returns `{ zones: [] }` — which
     * is what an out-of-coverage answer looks like — being recorded as
     * `provider_resolved` with nothing in it. The fallback has to still run.
     */
    const empty = resolveTimeZones({
      published: [],
      center: { lat: -8.4, lng: 115.2 },
      resolved: { zones: [], source: 'open-meteo', resolvedAt: '2026-08-10T00:00:00.000Z' },
    });
    expect(empty.basis).toBe('derived_from_longitude');
    expect(empty.zones).toHaveLength(1);
  });

  it('refuses a fixed offset as a civil zone, however it is spelled', () => {
    expect(isCivilTimeZone('Europe/Lisbon')).toBe(true);
    expect(isCivilTimeZone('America/Argentina/Ushuaia')).toBe(true);
    expect(isCivilTimeZone('Etc/GMT+5')).toBe(false);
    expect(isCivilTimeZone('Etc/UTC')).toBe(false);
    expect(isCivilTimeZone('UTC')).toBe(false);
    expect(isCivilTimeZone('GMT')).toBe(false);
    expect(isCivilTimeZone('')).toBe(false);
    expect(isCivilTimeZone('   ')).toBe(false);
  });

  it('says "more than one" out loud rather than taking the first', () => {
    expect(singleTimeZone(['Europe/Berlin'])).toBe('Europe/Berlin');
    expect(singleTimeZone(['Europe/Berlin', 'Europe/Berlin'])).toBe('Europe/Berlin');
    expect(singleTimeZone(['Europe/Berlin', 'Europe/Warsaw'])).toBeNull();
    expect(singleTimeZone([])).toBeNull();
  });
});

describe('the offset in force on a date', () => {
  it('gets a northern-hemisphere daylight-saving change the right way round', () => {
    /*
     * New York is −5 in January and −4 in July. Getting the sign backwards is a
     * ten-hour error, and it is the mistake `Etc/GMT±N` invites.
     */
    expect(utcOffsetMinutesOn('2026-01-15', 'America/New_York')).toBe(-300);
    expect(utcOffsetMinutesOn('2026-07-15', 'America/New_York')).toBe(-240);
  });

  it('leaves a non-observing zone alone across the year', () => {
    /* Two readings six months apart, and they must be the same number. */
    expect(utcOffsetMinutesOn('2026-01-15', 'Asia/Kolkata')).toBe(330);
    expect(utcOffsetMinutesOn('2026-07-15', 'Asia/Kolkata')).toBe(330);
  });

  it('reads half-hour and quarter-hour offsets rather than truncating them', () => {
    /*
     * The reason `longOffset` is used rather than `shortOffset`: the short form
     * drops the minutes for some zones, and these are exactly the places where
     * the minutes are the whole answer.
     */
    expect(utcOffsetMinutesOn('2026-08-15', 'Asia/Kolkata')).toBe(330);
    expect(utcOffsetMinutesOn('2026-08-15', 'Asia/Kathmandu')).toBe(345);
    expect(utcOffsetMinutesOn('2026-08-15', 'Australia/Eucla')).toBe(525);
    expect(utcOffsetMinutesOn('2026-08-15', 'Pacific/Marquesas')).toBe(-570);
  });

  it('handles a zone whose daylight saving is thirty minutes, not sixty', () => {
    /*
     * Lord Howe shifts by half an hour. Any test asserting "daylight saving
     * moves the clock by exactly 60" would be wrong here, so the claim is that
     * the two readings *differ* — and by the amount this zone actually uses.
     */
    const january = utcOffsetMinutesOn('2026-01-15', 'Australia/Lord_Howe');
    const july = utcOffsetMinutesOn('2026-07-15', 'Australia/Lord_Howe');
    expect(january).not.toBe(july);
    expect(Math.abs(january - july)).toBe(30);
  });

  it('reads a solar fallback zone with the POSIX sign undone', () => {
    /**
     * THE EIGHTEEN-HOUR ERROR, ASSERTED FROM BOTH ENDS.
     *
     * POSIX `Etc/GMT+5` means UTC−5: the sign is inverted relative to everything
     * else anybody writes. So the derivation and the reader are checked against
     * each other — a longitude east of Greenwich must end up with a *positive*
     * offset once the identifier has been round-tripped through `Intl`.
     */
    const tokyo = deriveTimeZoneFromLongitude(139.7);
    expect(tokyo).toBe('Etc/GMT-9');
    expect(utcOffsetMinutesOn('2026-08-15', tokyo)).toBe(540);

    const newYork = deriveTimeZoneFromLongitude(-74);
    expect(newYork).toBe('Etc/GMT+5');
    expect(utcOffsetMinutesOn('2026-08-15', newYork)).toBe(-300);

    expect(deriveTimeZoneFromLongitude(0)).toBe('UTC');
    expect(utcOffsetMinutesOn('2026-08-15', 'UTC')).toBe(0);
  });

  it('answers for a date rather than for the moment the test runs', () => {
    /*
     * No clock is read anywhere in this file, which is what makes every number
     * above a fact rather than a property of the afternoon somebody ran it.
     */
    expect(localDateIn(new Date('2026-08-15T23:30:00.000Z'), 'Pacific/Auckland')).toBe(
      '2026-08-16',
    );
    expect(localDateIn(new Date('2026-08-15T00:30:00.000Z'), 'America/Los_Angeles')).toBe(
      '2026-08-14',
    );
  });
});

describe('what a traveller is told about the clock', () => {
  it('turns a solar fallback back into an offset a person can read, and says it was estimated', () => {
    const text = describeTimeZone({
      zones: ['Etc/GMT+7'],
      basis: 'derived_from_longitude',
    });
    /* Never the raw identifier, and never presented as confirmed. */
    expect(text).not.toContain('Etc/GMT');
    expect(text).toContain('UTC−7');
    expect(text).toMatch(/estimated/i);
  });

  it('prints a real zone plainly, and names a boundary when there is one', () => {
    expect(describeTimeZone({ zones: ['Europe/Lisbon'], basis: 'provider_resolved' })).toBe(
      'Europe/Lisbon',
    );
    const spanning = describeTimeZone({
      zones: ['Europe/Berlin', 'Europe/Warsaw'],
      basis: 'published',
    });
    expect(spanning).toContain('Europe/Berlin');
    expect(spanning).toContain('Europe/Warsaw');
    expect(spanning).toMatch(/more than one/i);
  });

  it('says it does not know rather than inventing a zone', () => {
    expect(describeTimeZone({ zones: [], basis: 'unknown' })).toMatch(/could not establish/i);
    expect(timeZoneConfidence('unknown')).toBe('unknown');
  });

  it('undoes the POSIX inversion in the label, in both directions', () => {
    expect(offsetLabel('Etc/GMT-9')).toBe('UTC+9');
    expect(offsetLabel('Etc/GMT+5')).toBe('UTC−5');
    expect(offsetLabel('UTC')).toBe('UTC');
    /* A civil identifier is not an offset and is returned untouched. */
    expect(offsetLabel('Europe/Lisbon')).toBe('Europe/Lisbon');
  });
});

describe('the database the offsets are computed against', () => {
  it('is reported rather than assumed current', () => {
    /**
     * Not a version assertion — pinning one would fail on every Node upgrade for
     * no useful reason. The claim is that the *basis is knowable*: a runtime
     * lagging the published timezone database is wrong about a rule change that
     * has already happened, undetectably from inside the process, so the version
     * has to travel with the diagnostic rather than be assumed.
     */
    const version = runtimeTimeZoneDataVersion();
    expect(version === null || /^\d{4}[a-z]$/.test(version)).toBe(true);
  });
});
