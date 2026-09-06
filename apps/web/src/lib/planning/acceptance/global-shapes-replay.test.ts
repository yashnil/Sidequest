import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { itinerarySchema, tripDates, unavailableWeatherDataset, type Trip } from '@sidequest/core';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import type { GeocodedLocality } from '../skeleton-adapter';
import { defaultProfileFor } from '../production-plan';
import { auditItinerary } from '../quality-audit';
import { normalizeTripDraftWire } from '../trip-draft-wire';
import type { TripDraft } from '../trip-draft';

/**
 * PRODUCT RECOVERY V1 — THE OTHER REGRESSION SHAPES.
 *
 * The Ireland fixes must not be Ireland-specific. The two live drafts saved
 * from the Quality V1 pass replay here with no provider evidence at all:
 *
 *   - East Africa (lodge circuit): tented camps and lodges are the real
 *     overnight bases and keep their own names; nothing renames "Tarangire
 *     area" to a nearby town; unmeasured legs collapse nothing.
 *   - Tasmania (road trip): localities normalise as places to sleep; the
 *     loop keeps its nights; the temporal audit passes without a router.
 *
 * Both: zero silent loss, no zero-minute travel between different places,
 * every day coherent, the intelligence layer building in under a quarter
 * second with no call.
 */
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/${name}-draft.json`, import.meta.url), 'utf8')) as unknown;

function draftOf(name: string): TripDraft {
  const stored = read(name) as { days: unknown[] };
  const normalized = normalizeTripDraftWire(stored, { days: stored.days.length });
  if (!normalized.ok) throw new Error(`fixture ${name} did not normalise: ${JSON.stringify(normalized.issues?.slice(0, 3))}`);
  return normalized.draft;
}

function contextFor(input: { id: string; destination: string; country: string; start: string; end: string; centre: { lat: number; lng: number }; drives: boolean; geocodes?: Record<string, GeocodedLocality[]> }): ReconcileContext {
  const trip: Trip = {
    id: input.id,
    basics: { mode: 'known_destination', destinationInput: input.destination, regionId: 'dynamic', startDate: input.start, endDate: input.end, arrivalTime: '16:00', departureTime: '09:00', adults: 2, children: 0, travelerNeeds: [] },
    status: 'planned',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
  const base = defaultProfileFor(trip, null);
  const profile = { ...base, transport: { ...base.transport, willDrive: input.drives, maxDailyDriveMinutes: 240, maxDailyTransportMinutes: 360 } };
  const regionId = `${input.id}-region`;
  const dates = tripDates(input.start, input.end);
  return {
    tripId: trip.id,
    basics: trip.basics,
    profile,
    region: { id: regionId, name: input.destination, baseName: input.destination, baseCoordinates: input.centre, summary: 'Replay.', maxRadiusKm: 900, aliases: [], transportSummary: '', noVehicleSummary: '' },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: input.drives ? 'car' : 'foot', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'Replay: no compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: `${regionId}:centre`, label: input.destination, coordinates: input.centre, elevationMetres: 0, timeZone: 'UTC', placeIds: [`${regionId}:centre`], limitation: 'One point.' }], dates, now: new Date('2026-09-05T00:00:00Z'), reason: 'not_configured', message: 'No weather in the replay.' }),
    now: new Date('2026-09-05T00:00:00Z'),
    baseId: `${regionId}:centre`,
    compiledBases: [],
    ...(input.geocodes
      ? {
          geocodeLocality: async (query: string) => {
            const key = query.toLowerCase().split(',')[0]!.trim();
            return input.geocodes![key] ?? [];
          },
        }
      : {}),
    destinationScope: { countryCode: input.country, boundaryEvidence: 'reach_circle', reachRadiusKm: 900 },
    subregionGeometries: [],
    deadlineReached: () => false,
  };
}

function assertCoherent(itinerary: ReturnType<typeof itinerarySchema.parse>) {
  const legs = itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel'));
  expect(legs.filter((l) => l.durationMinutes === 0 && l.travel && l.travel.fromId !== l.travel.toId)).toEqual([]);
  for (const day of itinerary.days) {
    const items = [...day.items].filter((i) => i.kind !== 'free_time').sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < items.length; i += 1) expect(items[i]!.startMinute, `day ${day.dayNumber}: ${items[i]!.title}`).toBeGreaterThanOrEqual(items[i - 1]!.endMinute);
  }
}

describe('East Africa lodge circuit, replayed offline', () => {
  it('camps and lodges stay the bases they are; nothing is renamed to a town; zero silent loss; coherent without a router', async () => {
    const draft = draftOf('east-africa');
    const context = contextFor({
      id: 'east-africa-replay',
      destination: 'Tanzania and Kenya',
      country: 'TZ',
      start: '2026-08-12',
      end: '2026-08-26',
      centre: { lat: -3.4, lng: 36.7 },
      drives: false,
      geocodes: {
        // The geocoder answers the towns; the camps it does not know at all.
        arusha: [{ sourceId: 'relation/1', name: 'Arusha', lat: -3.3869, lng: 36.68, countryCode: 'tz', entityType: 'city', importance: 0.7 }],
        zanzibar: [{ sourceId: 'relation/2', name: 'Zanzibar City', lat: -6.1659, lng: 39.2026, countryCode: 'tz', entityType: 'city', importance: 0.7 }],
        serengeti: [{ sourceId: 'relation/3', name: 'Serengeti National Park', lat: -2.3333, lng: 34.8333, countryCode: 'tz', entityType: 'protected_area', importance: 0.6 }],
      },
    });
    const result = await reconcileTripDraft({ draft, context });
    const itinerary = result.itinerary;
    expect(itinerarySchema.safeParse(itinerary).success).toBe(true);
    const bases = itinerary.package!.bases;
    // The draft's own base names survive; camps/lodges are typed as such and never renamed.
    for (const b of bases) expect(draft.bases.some((d) => d.name === b.name), `base ${b.name} should be a draft base name`).toBe(true);
    const camps = bases.filter((b) => b.baseKind === 'camp' || b.baseKind === 'lodge');
    expect(camps.length).toBeGreaterThanOrEqual(3);
    expect(bases.find((b) => /serengeti/i.test(b.name))?.baseKind).toBe('camp');
    expect(bases.find((b) => /serengeti/i.test(b.name))?.name).toBe('Serengeti');
    expect(bases.reduce((s, b) => s + b.nights, 0)).toBe(14);
    expect(result.dispositions.length).toBe(draft.days.reduce((n, d) => n + d.anchors.length, 0));
    const kept = result.dispositions.filter((d) => !d.disposition.startsWith('rejected') && d.disposition !== 'unscheduled_capacity');
    expect(kept.length).toBeGreaterThanOrEqual(result.dispositions.length - 2);
    assertCoherent(itinerary);
    // Non-road legs (flight, transfer) are never estimated from geometry; they hold an allowance and say why.
    const nonRoad = itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel' && i.travel?.unmeasuredReason === 'mode_not_routed'));
    for (const leg of nonRoad) expect(leg.durationMinutes).toBeGreaterThan(0);
    const audit = auditItinerary({ draft, itinerary, profile: context.profile, trip: { id: context.tripId, basics: context.basics, status: 'planned', createdAt: '', updatedAt: '' } });
    expect(audit.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    const intel = buildTravelIntelligence({ tripId: context.tripId, itinerary, draft, profile: context.profile, basics: context.basics, destination: { name: 'Tanzania and Kenya', countryCode: 'TZ' }, booked: [], readinessProfile: null, now: new Date('2026-06-01T00:00:00Z') });
    expect(intel.lodging.bases.map((b) => b.name)).toEqual(bases.map((b) => b.name));
    expect(intel.readiness.entries.filter((e) => e.tier !== 'more' && e.state !== 'not_applicable').length).toBeLessThanOrEqual(7);
  });
});

describe('Tasmania road trip, replayed offline', () => {
  it('localities normalise to places to sleep, nights hold, the temporal audit passes with no router', async () => {
    const draft = draftOf('tasmania');
    const context = contextFor({
      id: 'tasmania-replay',
      destination: 'Tasmania',
      country: 'AU',
      start: '2026-11-05',
      end: '2026-11-12',
      centre: { lat: -42.0, lng: 146.6 },
      drives: true,
      geocodes: {
        hobart: [{ sourceId: 'relation/10', name: 'City of Hobart', lat: -42.8821, lng: 147.3272, countryCode: 'au', entityType: 'city', importance: 0.8 }, { sourceId: 'way/11', name: 'Hobart Airport', lat: -42.8364, lng: 147.5103, countryCode: 'au', entityType: 'unknown', importance: 0.5 }],
        'coles bay': [{ sourceId: 'way/12', name: 'Coles Bay Foreshore Reserve', lat: -42.1236, lng: 148.2917, countryCode: 'au', entityType: 'unknown', importance: 0.4 }],
        'cradle mountain': [{ sourceId: 'node/13', name: 'Cradle Mountain', lat: -41.6842, lng: 145.9497, countryCode: 'au', entityType: 'unknown', importance: 0.6 }],
      },
    });
    const result = await reconcileTripDraft({ draft, context });
    const itinerary = result.itinerary;
    expect(itinerarySchema.safeParse(itinerary).success).toBe(true);
    const names = itinerary.package!.bases.map((b) => b.name);
    // "City of Hobart" contains the draft's "Hobart" → the traveller's word wins; a foreshore reserve answering for Coles Bay is kept for position only.
    expect(names[0]).toBe('Hobart');
    expect(names).toContain('Coles Bay');
    expect(names).toContain('Cradle Mountain');
    expect(names.some((n) => /reserve|airport/i.test(n))).toBe(false);
    expect(itinerary.package!.bases.reduce((s, b) => s + b.nights, 0)).toBe(7);
    assertCoherent(itinerary);
    const audit = auditItinerary({ draft, itinerary, profile: context.profile, trip: { id: context.tripId, basics: context.basics, status: 'planned', createdAt: '', updatedAt: '' } });
    expect(audit.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(result.dispositions.filter((d) => d.disposition.startsWith('rejected'))).toEqual([]);
  });
});
