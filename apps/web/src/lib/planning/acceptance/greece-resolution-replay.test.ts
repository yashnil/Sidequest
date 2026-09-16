import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAuthoritative, tripDates, unavailableWeatherDataset, type Trip, type TripBasics } from '@sidequest/core';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import { defaultProfileFor } from '../production-plan';
import { geocodedLocalityFrom } from '../skeleton-orchestrator';
import { tripDraftSchema } from '../trip-draft';
import type { NominatimPlace } from '@/lib/providers/nominatim';

/**
 * V12.3 §17 — THE GREEK TRIP'S WRONG ISLAND, THROUGH THE REAL RECONCILER.
 *
 * ── WHAT ACTUALLY HAPPENED, FROM THE SAVED TRIP ────────────────────────────
 *
 * The live V12.1 Greek trip persisted its day-5 stop `Halki` as
 *
 *     placeId  google-places:ChIJsQokTEq_lRQRwapax-i__90
 *     at       36.2296, 27.5672      — Chalki, in the Dodecanese
 *
 * while the day is based on **Naxos**, 218 km away, on a trip whose traveller
 * answered "boats and local transfers, not driving". V12.2 refused the resulting
 * sixty-hour walk; the *placement* stayed wrong, and that is this pass's P1.
 *
 * The identity is the whole finding. It is a **places-provider** reference, not
 * a geocoder one: the ladder never got past its third rung. So none of V12.3's
 * candidate scoring could have helped — that tier returns exactly one answer,
 * with no field to rank and no runner-up to measure a margin against.
 *
 * What this test replays is therefore the real shape of the defect: a places
 * provider that confidently answers with the island, the recorded Nominatim rows
 * for the query the ladder would make, and the real reconciler between them.
 *
 * Zero model calls. Zero network. The geocoder rows were recorded from the
 * public instance during this pass (ODbL) and are replayed through
 * `geocodedLocalityFrom`, the same function production reads rows with.
 */

const DUMP = '.claude-private/artifacts/v12.1/live/greece-dump';
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/resolution/nominatim.json', import.meta.url), 'utf8')) as Record<string, { results: NominatimPlace[] }>;

/** Exactly what the live trip persisted, as the places provider that produced it. */
const CHALKI_ISLAND = { lat: 36.2295823, lng: 27.5672 };
/** The village the day meant: Χαλκί, in the middle of Naxos, 11 km from the base. */
const NAXOS_VILLAGE = { lat: 37.0639027, lng: 25.4839886 };
const NAXOS_BASE = { lat: 37.1021, lng: 25.3762 };

const NOW = new Date('2026-09-15T07:00:00Z');
const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'the Greek Islands',
  regionId: 'dynamic',
  startDate: '2026-06-06',
  endDate: '2026-06-15',
  arrivalTime: '13:00',
  departureTime: '17:00',
  arrivalPrecision: 'not_booked',
  departurePrecision: 'not_booked',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

const TRIP: Trip = { id: 'greece-replay', basics: BASICS, status: 'draft', createdAt: '2026-09-15T07:00:00.000Z', updatedAt: '2026-09-15T07:00:00.000Z' };

const draft = tripDraftSchema.parse(
  (() => {
    const row = JSON.parse(readFileSync(`${DUMP}/trip-draft.json`, 'utf8')) as { draft_json: unknown };
    return typeof row.draft_json === 'string' ? JSON.parse(row.draft_json) : row.draft_json;
  })(),
);

/**
 * The ladder's queries, answered from the recordings.
 *
 * `"Halki, Greece"` is the one that matters and it is recorded verbatim: the
 * geocoder puts the Naxos village first and a car-repair shop in Thessaly
 * second. Anything unrecorded answers nothing, which the reconciler reads as a
 * blank rather than a refusal.
 */
function geocoder(log: string[]) {
  const table: Record<string, string> = {
    halki: 'halki',
    'halki, greece': 'halki-greece',
    'halki, the greek islands, greece': 'halki-greece',
    'halki, naxos': 'halki-naxos',
    'halki, naxos, greece': 'halki-naxos',
    /* The bases, so the days resolve where the live trip's did and each day has a bed. */
    naxos: 'naxos-greece',
    'naxos, greece': 'naxos-greece',
    'naxos, the greek islands, greece': 'naxos-greece',
    paros: 'paros-greece',
    'paros, greece': 'paros-greece',
    'paros, the greek islands, greece': 'paros-greece',
    athens: 'athens-greece',
    'athens, greece': 'athens-greece',
    'athens, the greek islands, greece': 'athens-greece',
  };
  return async (query: string) => {
    log.push(query);
    const slug = table[query.toLowerCase().replace(/\s+/g, ' ').trim()];
    if (!slug) return [];
    return RECORDED[slug]!.results.flatMap((row) => {
      const locality = geocodedLocalityFrom(row);
      return locality ? [locality] : [];
    });
  };
}

/** The places provider as it behaved on the live trip: one confident, wrong answer. */
function placesProvider(calls: { n: number }) {
  return async (request: { name: string }) => {
    calls.n += 1;
    if (request.name !== 'Halki') return null;
    return { provider: 'google-places', providerRef: 'ChIJsQokTEq_lRQRwapax-i__90', name: 'Chalki', coordinates: CHALKI_ISLAND, countryCode: 'gr', confidence: 'strong' as const };
  };
}

function contextFor(log: string[], calls: { n: number }): ReconcileContext {
  const regionId = `draft-region:${TRIP.id}`;
  const dates = tripDates(BASICS.startDate, BASICS.endDate);
  return {
    tripId: 'greece-replay',
    basics: BASICS,
    profile: { ...defaultProfileFor(TRIP, null) },
    region: {
      id: regionId,
      name: 'the Greek Islands',
      baseName: 'the Greek Islands',
      baseCoordinates: NAXOS_BASE,
      summary: 'The Cyclades, planned from the saved composed draft.',
      maxRadiusKm: 400,
      aliases: [],
      transportSummary: 'Ferries and local transfers.',
      noVehicleSummary: 'No self-driving.',
    },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: 'car', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'No compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: `${regionId}:centre`, label: 'the Greek Islands', coordinates: NAXOS_BASE, elevationMetres: 0, timeZone: 'Europe/Athens', placeIds: [`${regionId}:centre`], limitation: 'One point.' }], dates, now: NOW, reason: 'not_configured', message: 'No weather was fetched.' }),
    now: NOW,
    baseId: `${regionId}:centre`,
    compiledBases: [],
    geocodeLocality: geocoder(log),
    resolvePlaceIdentity: placesProvider(calls) as unknown as ReconcileContext['resolvePlaceIdentity'],
    destinationScope: { countryCode: 'gr', center: NAXOS_BASE, radiusKm: 400, boundaryEvidence: 'reach_circle' },
    subregionGeometries: [],
    deadlineReached: () => false,
    mustIncludeNames: [],
    destinationCountryName: 'Greece',
  } as unknown as ReconcileContext;
}

async function run() {
  const log: string[] = [];
  const calls = { n: 0 };
  const result = await reconcileTripDraft({ draft, context: contextFor(log, calls) });
  const halki = result.itinerary.days.flatMap((day) => day.items).find((item) => item.title === 'Halki' || item.id.includes('halki'));
  const anchor = result.dispositions.find((a) => a.name === 'Halki');
  return { result, log, calls, halki, anchor };
}

describe('§17 — Halki, on the real trip, through the real reconciler', () => {
  it('reproduces the tier the wrong answer came from', async () => {
    const { calls } = await run();
    /* The places provider is asked, as it was live. The defect is not that it was consulted. */
    expect(calls.n).toBeGreaterThan(0);
  });

  it('asks the map for a second opinion, because the answer sat 218 km from the base', async () => {
    const { log } = await run();
    /*
     * Before V12.3 this list was empty for Halki: the places provider answered
     * and the ladder never ran. The query is the fix's whole cost — one request,
     * on a route-critical stop whose answer was already suspicious.
     */
    expect(log.some((query) => query.toLowerCase().startsWith('halki'))).toBe(true);
  });

  it('places Halki on Naxos, not in the Dodecanese', async () => {
    const { anchor } = await run();
    expect(anchor).toBeTruthy();
    const point = anchor!.identity?.coordinates;
    expect(point).toBeTruthy();
    expect(point!.lat).toBeCloseTo(NAXOS_VILLAGE.lat, 1);
    expect(point!.lng).toBeCloseTo(NAXOS_VILLAGE.lng, 1);
    /* The 218 km error, stated as the thing that is gone. */
    expect(Math.abs(point!.lat - CHALKI_ISLAND.lat)).toBeGreaterThan(0.5);
  });

  it('records how grounded the answer is, so nothing downstream has to guess', async () => {
    const { anchor } = await run();
    expect(anchor!.identity?.resolutionConfidence).toBeDefined();
    expect(isAuthoritative(anchor!.identity!.resolutionConfidence!)).toBe(true);
  });

  it('leaves the rest of the trip alone', async () => {
    const { result } = await run();
    /* Nine days of a real draft still reconcile; the fix is one stop, not a rewrite. */
    expect(result.itinerary.days.length).toBe(draft.days.length);
    const names = result.dispositions.map((a) => a.name);
    expect(names).toContain('Apiranthos');
    expect(names).toContain('Portara');
  });
});
