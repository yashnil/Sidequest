import { describe, expect, it } from 'vitest';
import { OPERATIONAL_SEMANTICS, placeClassFor, enrichmentLevelFor } from './place-class';
import { decodePolyline, encodePolyline, simplifyPolyline } from './polyline';
import { PROVIDER_ERROR_DEGRADATION, ProviderFailure, isPhysicalImpossibility, reasonFromStatus } from './provider-errors';
import { buildRecheckManifest } from './recheck';
import { buildTodayView, localClock } from './today';
import { currencyForCountry } from './budget';
import { durationBasisOf, trafficStateFor } from './transport';
import type { SourceClaim } from './claims';

describe('LIVE WORLD V1 — place classes', () => {
  it('the model’s category outranks provider types; a museum tagged natural_feature is still a venue', () => {
    expect(placeClassFor('museum', { googleTypes: ['natural_feature', 'point_of_interest'] })).toBe('business_venue');
    expect(placeClassFor('lake')).toBe('open_ground');
    expect(placeClassFor(undefined, { googleTypes: ['airport'] })).toBe('transport_terminal');
    expect(placeClassFor('mystery')).toBe('unknown');
  });
  it('unknown hours never mean closed, and open ground needs no hours', () => {
    expect(OPERATIONAL_SEMANTICS.business_venue.noHoursMeaning).toBe('hours_unknown');
    expect(OPERATIONAL_SEMANTICS.open_ground.noHoursMeaning).toBe('open_access');
    expect(OPERATIONAL_SEMANTICS.open_ground.hoursMatter).toBe(false);
    expect(OPERATIONAL_SEMANTICS.transport_terminal.scheduleMatters).toBe(true);
    expect(enrichmentLevelFor('open_ground')).toBe('none');
    expect(enrichmentLevelFor('business_venue')).toBe('operational');
  });
});

describe('LIVE WORLD V1 — polylines', () => {
  it('round-trips a route and simplifies a long one without moving its ends', () => {
    const points = Array.from({ length: 1200 }, (_, i) => ({ lat: 64 + i * 0.001, lng: -21 + Math.sin(i / 10) * 0.01 }));
    const encoded = encodePolyline(simplifyPolyline(points));
    const decoded = decodePolyline(encoded);
    expect(decoded.length).toBeLessThanOrEqual(400);
    expect(decoded[0]!.lat).toBeCloseTo(points[0]!.lat, 4);
    expect(decoded[decoded.length - 1]!.lng).toBeCloseTo(points[points.length - 1]!.lng, 4);
    expect(encoded.length).toBeLessThan(6000);
  });
});

describe('LIVE WORLD V1 — provider errors', () => {
  it('only an affirmative no-route is a contradiction; every other failure degrades', () => {
    expect(isPhysicalImpossibility('no_route')).toBe(true);
    for (const reason of ['timeout', 'quota', 'unauthorized', 'rate_limited', 'provider_error', 'temporarily_unavailable', 'not_found', 'unsupported', 'invalid_request'] as const) {
      expect(isPhysicalImpossibility(reason)).toBe(false);
      expect(PROVIDER_ERROR_DEGRADATION[reason].claimState).not.toBe('contradicted');
    }
    expect(reasonFromStatus(429)).toBe('rate_limited');
    expect(reasonFromStatus(401)).toBe('unauthorized');
    expect(reasonFromStatus(503)).toBe('temporarily_unavailable');
    const failure = new ProviderFailure('quota', 'google-places', 'Daily quota exhausted.');
    expect(failure.message).not.toMatch(/AIza|key=/);
  });
});

describe('LIVE WORLD V1 — temporal honesty', () => {
  it('a static figure is never live traffic, and the leg says what kind of figure it holds', () => {
    expect(durationBasisOf({ provenance: 'measured' })).toBe('measured_static');
    expect(durationBasisOf({ provenance: 'measured', basis: 'traffic_aware' })).toBe('traffic_aware');
    expect(durationBasisOf({ provenance: 'measured', basis: 'scheduled' })).toBe('scheduled_transit');
    const farFuture = new Date('2027-01-01T09:00:00Z');
    const now = new Date('2026-09-04T09:00:00Z');
    expect(trafficStateFor({ mode: 'car', basis: 'measured_static', departAt: farFuture, now, providerTrafficAware: false })).not.toBe('live');
    expect(trafficStateFor({ mode: 'car', basis: 'traffic_aware', departAt: farFuture, now, providerTrafficAware: true })).not.toBe('live');
  });
  it('the recheck manifest states each item by how far out the trip is', () => {
    const claim = (kind: string, id: string): SourceClaim => ({ id, kind: kind as SourceClaim['kind'], claim: `${kind} claim`, authority: 'official_source', state: 'unverified', freshness: 'date_bound', sourceName: 'Test', checkedAt: '2026-09-01T00:00:00.000Z', subject: 'test', blocking: false, notes: [] }) as unknown as SourceClaim;
    const claims = [claim('entry_visa', 'c1'), claim('opening_hours', 'c2'), claim('weather_forecast', 'c3')];
    const far = buildRecheckManifest({ claims, daysUntilTrip: 90, tripDays: 5, drives: true, hasFlights: true, hasFerries: false, capabilities: { forecast: true, traffic: false, hours: false, transit: false } });
    expect(far.items.find((i) => i.id === 'recheck:entry')?.state).toBe('upcoming');
    const near = buildRecheckManifest({ claims, daysUntilTrip: 3, tripDays: 5, drives: true, hasFlights: true, hasFerries: false, capabilities: { forecast: true, traffic: false, hours: false, transit: false } });
    expect(near.items.find((i) => i.id === 'recheck:hours')?.state).toBe('due');
    expect(near.items.find((i) => i.id === 'recheck:entry')?.state).toBe('past');
    expect(near.items.every((i) => i.window)).toBe(true);
  });
  it('local clock and today view respect the destination time zone and the trip’s dates', () => {
    const clock = localClock(new Date('2026-08-13T23:30:00Z'), 'Pacific/Auckland');
    expect(clock.date).toBe('2026-08-14');
    const itinerary = { days: [{ dayNumber: 1, date: '2026-08-14', theme: 'Arrive', baseName: 'Base', items: [{ id: 'a', kind: 'activity', title: 'Harbour walk', startMinute: 600, endMinute: 720, durationMinutes: 120, placeId: 'p1', reason: 'x', weatherSensitive: false }, { id: 'l', kind: 'travel', title: 'Drive to Museum', startMinute: 720, endMinute: 744, durationMinutes: 24, reason: 'x', weatherSensitive: false, travel: { fromId: 'p1', toId: 'p2', fromName: 'Harbour', toName: 'Museum', minutes: 24, km: 10, mode: 'rail', role: 'approach', provenance: 'measured', basis: 'scheduled' } }, { id: 'b', kind: 'activity', title: 'Museum', startMinute: 744, endMinute: 900, durationMinutes: 156, placeId: 'p2', reason: 'x', weatherSensitive: false }], weather: { summary: 'Fine', evidence: 'forecast' }, warnings: [] }] } as never;
    const view = buildTodayView({ itinerary, booked: [], backups: [], now: new Date('2026-08-13T23:30:00Z'), timeZone: 'Pacific/Auckland' });
    expect(view.active).toBe(true);
    expect(view.current?.title).toBe('Harbour walk');
    expect(view.next?.title).toBe('Museum');
    expect(view.nextTransport?.basis).toBe('scheduled');
    const off = buildTodayView({ itinerary, booked: [], backups: [], now: new Date('2026-09-01T10:00:00Z'), timeZone: 'Pacific/Auckland' });
    expect(off.active).toBe(false);
  });
});

describe('LIVE WORLD V1 — currency', () => {
  it('maps the common destinations and refuses to guess the rest', () => {
    expect(currencyForCountry('IS')).toBe('ISK');
    expect(currencyForCountry('jp')).toBe('JPY');
    expect(currencyForCountry('ZZ')).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});
