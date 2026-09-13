import { describe, expect, it } from 'vitest';
import {
  centreIsStandIn,
  degradedToCountry,
  jurisdictionPhrase,
  parseDestinationIntent,
  phraseSemanticType,
  placementBlocksReady,
  requiredAccess,
  routeCriticalRate,
  tripDates,
  unavailableWeatherDataset,
  type Trip,
  type TripBasics,
} from '@sidequest/core';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import { normalizeName } from '../skeleton-adapter';
import { defaultProfileFor } from '../production-plan';
import { compileQuality } from '../quality-compiler';
import { deriveExperienceGraph } from '../experience-graph';
import { accessConstraintsFor } from '@/lib/providers/access-constraints';
import { resolveDestinationPhrase } from '@/lib/destinations/intent-resolution';
import { fixtureInterpreter } from '@/lib/destinations/interpretation';
import { recordedResolver } from '@/lib/destinations/fixtures/recorded-resolver';
import { tripDraftSchema, type TripDraft } from '../trip-draft';
import { recordedGeocoder } from './fixtures/founder-v10/recorded-geocoder';

/**
 * V10 §17 — THE CANADIAN ROCKIES HALF OF THE FOUNDER BENCHMARK.
 *
 * The production trip's own rows are not in any local database
 * (`V10-FOUNDER-AUDIT.md` §0), so this reproduces every criterion the brief sets
 * for it, from evidence:
 *
 *   the setup map shows the western mountain region rather than Canada
 *   jurisdiction language is correct: Canada, with Alberta and British Columbia
 *   route-critical stops place — against real recorded geocoder rows for names
 *     that are genuinely ambiguous bare ("Jasper" is three US counties; "Field"
 *     is in the United States and Australia)
 *   routing completes
 *   current closures and access restrictions change the itinerary, from official
 *     Parks Canada rows loaded as data
 *
 * Zero model calls, zero network. The geocoder rows were recorded from the public
 * instance on 2026-09-12 (ODbL) and are replayed through the same
 * `classifyNominatim` the product uses.
 */

const NOW = new Date('2026-09-12T12:00:00Z');
const ROCKIES_CENTRE = { lat: 51.65, lng: -116.57 };

/** Late September: inside Moraine Lake's shuttle season and inside the 2026 Maligne Canyon closure. */
const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'the Canadian Rockies',
  regionId: 'dynamic',
  startDate: '2026-09-19',
  endDate: '2026-09-27',
  arrivalTime: '14:30',
  departureTime: '18:00',
  arrivalPrecision: 'not_booked',
  departurePrecision: 'not_booked',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};
const TRIP: Trip = { id: 'founder-v10-rockies', basics: BASICS, status: 'draft', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };

/**
 * A draft in the shape a regional mountain road trip takes: four bases in one
 * direction, a signature lake behind a shuttle, a canyon that is closed, and a
 * tea house that is part of the trail above the lake rather than a stop of its own.
 *
 * Every anchor carries the province-and-country locality a real draft carries for
 * a two-province region, which is also what makes the recorded queries the ones
 * the production ladder issues.
 */
const AB = 'Alberta, Canada';
const BC = 'British Columbia, Canada';
const draft: TripDraft = tripDraftSchema.parse({
  archetype: 'road_trip',
  purpose: 'A mountain road trip built on the high lakes, the Icefields Parkway and two nights within reach of the glacier.',
  routeRationale: 'North from Calgary through Canmore and Banff, up the Parkway to Jasper, and back through Yoho, so no day repeats a stretch of road.',
  routeAlternative: 'A single base in Banff with long days out is the other option; it trades the Parkway and Jasper for less driving and no packing.',
  timingRationale: 'Late September holds the larches and the shuttle season and comes before the Parkway closes to snow.',
  assumptions: ['Self-drive hire car collected at the airport on arrival'],
  tradeoffs: ['Two nights in Jasper rather than three, to keep the Parkway a whole day rather than half of one'],
  signatures: ['The Icefields Parkway', 'Moraine Lake and Lake Louise', 'Lake Agnes above Lake Louise'],
  bases: [
    { id: 'canmore', name: 'Canmore', locality: AB, nights: 1, why: 'An easy first night within an hour of the airport.', lodgingStyle: 'small hotel on Main Street' },
    { id: 'lake-louise', name: 'Lake Louise', locality: AB, nights: 3, why: 'Walking distance of the shuttle hub for the two high lakes.', lodgingStyle: 'lodge near the village' },
    { id: 'jasper', name: 'Jasper', locality: AB, nights: 2, why: 'The north end of the Parkway, and a base for the glacier country.', lodgingStyle: 'guesthouse in town' },
    { id: 'field', name: 'Field', locality: BC, nights: 2, why: 'Inside Yoho for the last two days, on the way back south.', lodgingStyle: 'inn by the river' },
  ],
  days: [
    { dayNumber: 1, baseId: 'canmore', theme: 'Arrive and settle', intensity: 'light', anchors: [], meals: { dinner: 'a bistro on Main Street' }, whyItFits: 'A short first evening after the flight.' },
    { dayNumber: 2, baseId: 'lake-louise', relocation: true, theme: 'Into the high lakes', intensity: 'moderate', anchors: [{ name: 'Johnston Canyon', locality: AB, category: 'nature', role: 'secondary', estimatedDurationMinutes: 90, why: 'A short canyon walk on the Bow Valley Parkway, on the way north.' }, { name: 'Moraine Lake', locality: AB, category: 'water', role: 'core', estimatedDurationMinutes: 120, why: 'The lake the trip is built around.' }], meals: { lunch: 'a bakery in Banff' }, whyItFits: 'One stop en route and the signature lake in the afternoon.' },
    { dayNumber: 3, baseId: 'lake-louise', theme: 'Above the lake', intensity: 'intense', anchors: [{ name: 'Lake Agnes', locality: AB, category: 'hike', role: 'core', estimatedDurationMinutes: 180, why: 'The classic climb from the lakeshore.' }, { name: 'Lake Agnes Tea House', locality: 'Lake Agnes', category: 'food', role: 'optional', estimatedDurationMinutes: 40, why: 'On the trail itself, most of the way up.' }], meals: { dinner: 'the lodge dining room' }, whyItFits: 'The day the hiking in the brief is actually for.' },
    { dayNumber: 4, baseId: 'lake-louise', theme: 'Yoho across the pass', intensity: 'moderate', anchors: [{ name: 'Emerald Lake', locality: BC, category: 'water', role: 'core', estimatedDurationMinutes: 120, why: 'The other great lake, and quieter.' }, { name: 'Takakkaw Falls', locality: BC, category: 'water', role: 'secondary', estimatedDurationMinutes: 60, why: 'One of the tallest falls in the country, a short detour.' }], meals: { lunch: 'a packed lunch' }, whyItFits: 'A day out over the pass and back.' },
    { dayNumber: 5, baseId: 'jasper', relocation: true, theme: 'The Icefields Parkway', intensity: 'moderate', anchors: [{ name: 'Peyto Lake', locality: AB, category: 'viewpoint', role: 'core', estimatedDurationMinutes: 45, why: 'The Parkway viewpoint everyone comes for.' }, { name: 'Sunwapta Falls', locality: AB, category: 'water', role: 'secondary', estimatedDurationMinutes: 45, why: 'A short stop near the north end.' }, { name: 'Athabasca Falls', locality: AB, category: 'water', role: 'secondary', estimatedDurationMinutes: 45, why: 'The last stop before town.' }], meals: { lunch: 'a picnic at a Parkway pull-off' }, whyItFits: 'The whole day is the drive, which is the point of it.' },
    { dayNumber: 6, baseId: 'jasper', theme: 'Around Jasper', intensity: 'moderate', anchors: [{ name: 'Maligne Canyon', locality: AB, category: 'nature', role: 'core', estimatedDurationMinutes: 120, why: 'The gorge walk above the town.' }], meals: { dinner: 'a pub in town' }, whyItFits: 'A shorter day after the Parkway.' },
    { dayNumber: 7, baseId: 'field', relocation: true, theme: 'South into Yoho', intensity: 'moderate', anchors: [{ name: 'Athabasca Falls', locality: AB, category: 'water', role: 'optional', estimatedDurationMinutes: 30, why: 'Worth a second look on the way south.' }], meals: { lunch: 'a packed lunch' }, whyItFits: 'A long transfer with one stop on the way.' },
    { dayNumber: 8, baseId: 'field', theme: 'Yoho at ease', intensity: 'light', anchors: [{ name: 'Emerald Lake', locality: BC, category: 'water', role: 'secondary', estimatedDurationMinutes: 90, why: 'A slow morning at the lake.' }], meals: { dinner: 'the inn' }, whyItFits: 'The recovery day the week has earned.' },
    { dayNumber: 9, baseId: 'field', theme: 'Fly home from Calgary', intensity: 'light', anchors: [{ name: 'Calgary International Airport', locality: AB, category: 'other', role: 'core', estimatedDurationMinutes: 30, why: 'The departure gateway.' }], meals: { breakfast: 'the inn' }, whyItFits: 'A long run to the airport and nothing else.' },
  ],
  omissions: [
    { name: 'Kananaskis Country', reason: 'South of the route and would cost a night from the high lakes.' },
    { name: 'Waterton Lakes', reason: 'Too far south to reach without two more driving days.' },
  ],
  unresolved: [],
  bookingPriorities: ['The Lake Louise and Moraine Lake shuttle, as soon as the window opens'],
  driving: 'rental_self_drive',
  package: {
    transport: { primaryMode: 'car', summary: 'A hire car collected at Calgary and returned there, on paved highways throughout.', notes: [] },
    foodStrategy: ['Mountain-town bakeries and one lodge dinner'],
    beforeYouGo: ['A Parks Canada pass for the windscreen'],
    packing: ['Layers for above the treeline'],
    backups: [
      { trigger: 'The lakeshore shuttle is full or the weather closes the trail', alternative: 'The Bow Valley Parkway and Johnston Canyon instead', day: 3 },
      { trigger: 'Snow on the Parkway', alternative: 'Stay in Jasper and walk the lake trails in town', day: 5 },
    ],
  },
});

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** A router that answers every pair from geometry, so an unmeasured leg is unambiguously a placement failure. */
function geometryRouter(calls: { matrix: number; confirm: number }) {
  const leg = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    const km = Math.round(haversineKm(from, to) * 1.35 * 10) / 10;
    return { minutes: Math.max(1, Math.round((km / 70) * 60)), km };
  };
  return {
    routeMatrix: async (points: readonly { id: string; lat: number; lng: number }[]) => {
      calls.matrix += 1;
      return { ids: points.map((p) => p.id), minutes: points.map((a) => points.map((b) => leg(a, b).minutes)), km: points.map((a) => points.map((b) => leg(a, b).km)), failedPairs: [] as { fromId: string; toId: string; reason: string }[] };
    },
    confirmRoute: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
      calls.confirm += 1;
      const { minutes, km } = leg(from, to);
      return { found: true as const, minutes, km, basis: 'static' as const, provider: 'fixture-geometry' };
    },
  };
}

const CONSTRAINTS = accessConstraintsFor(['CA']);

async function run() {
  const log: string[] = [];
  const calls = { matrix: 0, confirm: 0 };
  const regionId = `draft-region:${TRIP.id}`;
  const router = geometryRouter(calls);
  const profile = defaultProfileFor(TRIP, null);
  const context = {
    tripId: TRIP.id,
    basics: BASICS,
    profile,
    region: { id: regionId, name: 'the Canadian Rockies', baseName: 'the Canadian Rockies', baseCoordinates: ROCKIES_CENTRE, summary: 'A mountain region across two provinces.', maxRadiusKm: 500, aliases: [], transportSummary: 'Self-drive.', noVehicleSummary: 'Not applicable.' },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: 'car', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'No compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: `${regionId}:centre`, label: 'the Canadian Rockies', coordinates: ROCKIES_CENTRE, elevationMetres: 0, timeZone: 'America/Edmonton', placeIds: [`${regionId}:centre`], limitation: 'One point.' }], dates: tripDates(BASICS.startDate, BASICS.endDate), now: NOW, reason: 'not_configured', message: 'No weather was fetched.' }),
    now: NOW,
    baseId: `${regionId}:centre`,
    compiledBases: [],
    geocodeLocality: recordedGeocoder(log),
    routeMatrix: router.routeMatrix,
    confirmRoute: router.confirmRoute,
    destinationScope: { countryCode: 'ca', center: ROCKIES_CENTRE, radiusKm: 500, boundaryEvidence: 'reach_circle' },
    subregionGeometries: [],
    deadlineReached: () => false,
    mustIncludeNames: [],
    destinationCountryName: 'Canada',
    destinationDivisions: ['Alberta', 'British Columbia'],
    destinationGateways: [{ label: 'Calgary International Airport' }],
  } as unknown as ReconcileContext;
  const result = await reconcileTripDraft({ draft, context });
  const experiences = deriveExperienceGraph({
    draft,
    datesByDay: new Map(result.itinerary.days.map((d) => [d.dayNumber, d.date])),
    accessConstraints: CONSTRAINTS,
    placeIdByAnchor: new Map((result.itinerary.package?.anchors ?? []).filter((a) => a.placeId).map((a) => [a.id, a.placeId!])),
  });
  const compiled = compileQuality({ itinerary: result.itinerary, draft, trip: TRIP, profile, placement: result.placement, dayOrders: result.dayOrders, gateway: result.gateway, accessConstraints: CONSTRAINTS, experiences });
  return { result, compiled, experiences, log, calls };
}

describe('the Canadian Rockies, from evidence', () => {
  it('reads the destination as a mountain region across two provinces, never as Canada', async () => {
    const { semantics } = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(), now: NOW, interpreter: fixtureInterpreter() });
    const phraseType = phraseSemanticType(parseDestinationIntent('the Canadian Rockies').children);
    expect(semantics.type).toBe('mountain_region');
    expect(degradedToCountry({ phraseType, type: semantics.type, scale: semantics.scale, centerBasis: semantics.centerBasis })).toBe(false);
    expect(centreIsStandIn(semantics.centerBasis)).toBe(false);

    /* The centre is in the western mountains, not in eastern Canada. */
    expect(semantics.center!.lng).toBeLessThan(-114);
    expect(haversineKm(semantics.center!, { lat: 43.65, lng: -79.38 })).toBeGreaterThan(2000);
    expect(semantics.extent).toBeDefined();

    /* Jurisdiction: Canada, with the two provinces named separately and never as the destination. */
    expect(jurisdictionPhrase(semantics.jurisdictions)).toBe('Canada');
    expect(semantics.jurisdictions.filter((j) => j.level === 'subnational').map((j) => j.name).sort()).toEqual(['Alberta', 'British Columbia']);
    expect(semantics.label).toBe('the Canadian Rockies');
  });

  it('places every base, including the two whose bare names are elsewhere entirely', async () => {
    const { result, log } = await run();
    const bases = result.itinerary.package!.bases;
    expect(bases.map((b) => normalizeName(b.name))).toEqual(['canmore', 'lake louise', 'jasper', 'field']);
    for (const base of bases) expect(base.coordinates, `${base.name} unplaced`).toBeDefined();

    /* Every base was asked with its province and country, which is what disambiguates it. */
    expect(log).toContain('Jasper, Alberta, Canada');
    expect(log).toContain('Field, British Columbia, Canada');

    const byName = new Map(bases.map((b) => [normalizeName(b.name), b.coordinates!]));
    /* Jasper in Alberta (52.9 N), not Jasper County, Indiana or Texas. */
    expect(byName.get('jasper')!.lat).toBeGreaterThan(52);
    expect(byName.get('jasper')!.lng).toBeLessThan(-117);
    /* Field in British Columbia (51.4 N, -116.5), not Field in the United States or Australia. */
    expect(haversineKm(byName.get('field')!, { lat: 51.397, lng: -116.49 })).toBeLessThan(25);

    expect(routeCriticalRate(result.placement)).toBe(1);
    expect(placementBlocksReady(result.placement)).toBe(false);
  });

  it('measures every base transfer and every day-local leg', async () => {
    const { result } = await run();
    let measured = 0;
    let unmeasured = 0;
    let transfersUnmeasured = 0;
    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        const travel = item.travel;
        if (!travel || travel.fromId === travel.toId) continue;
        if (travel.provenance === 'measured') measured += 1;
        else {
          unmeasured += 1;
          if (travel.role === 'transfer') transfersUnmeasured += 1;
        }
      }
    }
    /* The production trip reported 0 of 38. */
    expect(transfersUnmeasured).toBe(0);
    expect(measured).toBeGreaterThan(15);
    expect(measured / (measured + unmeasured)).toBe(1);
  });

  it('leaves no day doubling back, and judges every day', async () => {
    const { result } = await run();
    expect(result.dayOrders.filter((o) => o.report.verdict === 'violation' && !o.corrected)).toEqual([]);
    expect(result.dayOrders.filter((o) => o.report.verdict === 'unplaceable').map((o) => o.dayNumber)).toEqual([]);
  });

  it('refuses the closed canyon as an ordinary stop, and says what to do instead', async () => {
    const { compiled } = await run();
    const closed = compiled.report.issues.filter((i) => i.check === 'no_closed_stop' && i.severity === 'blocker');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.dayNumber).toBe(6);
    expect(closed[0]!.detail).toContain('Parks Canada');
    expect(closed[0]!.travellerNote).toContain('closed');
    /* The official row carries the alternative, and the traveller is given it. */
    expect(closed[0]!.travellerNote).toMatch(/Falls/);
    /* And the plan is not called ready with a closed stop on it. */
    expect(compiled.report.passed).toBe(false);
  });

  it('makes the shuttle-only lake a dependency in words, not a parking note', async () => {
    const { compiled, experiences } = await run();
    const shuttleOnly = requiredAccess(experiences).filter((r) => r.access.mode === 'shuttle');
    /*
     * Moraine Lake is a stop and its access is a dependency on the day it is on.
     * Lake Louise is where the traveller *sleeps*, and the lakeshore's own shuttle
     * row names the lakeshore rather than the village, so a base is never confused
     * with the attraction it is named after.
     */
    expect(shuttleOnly.map((r) => r.experience.name)).toEqual(['Moraine Lake']);
    expect(shuttleOnly[0]!.access.reservationRequired).toBe(true);
    const said = compiled.report.issues.filter((i) => i.check === 'access_requirements_represented');
    expect(said.length).toBeGreaterThan(0);
    const notes = said.map((i) => i.travellerNote ?? '');
    expect(notes.some((n) => /requires a shuttle — reserve this/.test(n))).toBe(true);
    for (const note of notes) expect(note).not.toMatch(/access_constraint|requiredMode|mode=/);
  });

  it('counts the tea house as part of the trail above the lake, not as a second stop', async () => {
    const { experiences, compiled } = await run();
    const agnes = experiences.experiences.find((e) => e.name === 'Lake Agnes')!;
    expect(agnes.components.map((c) => c.name)).toEqual(['Lake Agnes Tea House']);
    expect(agnes.components[0]!.kind).toBe('refreshment');
    expect(compiled.report.issues.filter((i) => i.check === 'no_duplicate_experience')).toEqual([]);
  });

  it('holds both gateways, and the departure one is the airport the last day runs to', async () => {
    const { result } = await run();
    const gateway = result.gateway!;
    expect(gateway.arrival?.name).toContain('Calgary International Airport');
    expect(gateway.arrival?.kind).toBe('airport');
    expect(gateway.arrivalTransfer?.basis).toBe('measured');
    expect(gateway.departureTransfer?.basis).toBe('measured');
    /* An 18:00 flight from a base two hours out: the leave-by time is named, not assumed. */
    expect(gateway.leaveFinalBaseByMinute).toBeLessThan(15 * 60);
    expect(gateway.notes.length).toBeGreaterThan(0);
  });

  it('attaches each backup to the day the model named it for', async () => {
    const { result } = await run();
    expect(result.itinerary.package!.backups.map((b) => ({ days: b.dayNumbers, match: b.match }))).toEqual([
      { days: [3], match: 'authored' },
      { days: [5], match: 'authored' },
    ]);
  });

  it('states the route alternative and explains what it left out', async () => {
    expect(draft.routeAlternative).toContain('single base in Banff');
    expect(draft.omissions.map((o) => o.name)).toEqual(['Kananaskis Country', 'Waterton Lakes']);
    for (const omission of draft.omissions) expect(omission.reason.length).toBeGreaterThan(10);
  });

  it('reports the metrics the Canadian Rockies benchmark is judged on', async () => {
    const { result, compiled, experiences } = await run();
    let measured = 0;
    let unmeasured = 0;
    let transfers = 0;
    let transfersUnmeasured = 0;
    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        const travel = item.travel;
        if (!travel || travel.fromId === travel.toId) continue;
        if (travel.role === 'transfer') transfers += 1;
        if (travel.provenance === 'measured') measured += 1;
        else {
          unmeasured += 1;
          if (travel.role === 'transfer') transfersUnmeasured += 1;
        }
      }
    }
    const bases = result.itinerary.package!.bases;
    const metrics = {
      trip: 'Canadian Rockies (a regional draft, replayed)',
      basesPlaced: `${bases.filter((b) => b.coordinates).length}/${bases.length}`,
      routeCriticalRate: routeCriticalRate(result.placement),
      transfersMeasured: `${transfers - transfersUnmeasured}/${transfers}`,
      legsMeasured: `${measured}/${measured + unmeasured}`,
      orderViolationsUncorrected: result.dayOrders.filter((o) => o.report.verdict === 'violation' && !o.corrected).length,
      daysUnjudgeable: result.dayOrders.filter((o) => o.report.verdict === 'unplaceable').map((o) => o.dayNumber),
      operationalBlockers: compiled.report.issues.filter((i) => i.severity === 'blocker').map((i) => i.check),
      requiredAccessLegs: requiredAccess(experiences).length,
      gatewayArrival: result.gateway?.arrivalFeasibility ?? 'none',
      gatewayDeparture: result.gateway?.departureFeasibility ?? 'none',
      placementProviderCalls: result.placement.providerCalls,
    };
    console.warn('V10-METRICS', JSON.stringify(metrics));
    expect(metrics.basesPlaced).toBe('4/4');
  });

  it('loads the official access rows as data, each with its own source and window', () => {
    expect(CONSTRAINTS.length).toBeGreaterThanOrEqual(4);
    for (const constraint of CONSTRAINTS) {
      expect(constraint.sourceName).toMatch(/Parks Canada/);
      expect(constraint.authority).toBe('official_current');
      expect(constraint.checkedAt.length).toBeGreaterThanOrEqual(10);
    }
    /* The 2026 closure is dated to 2026, so it is a fact about 2026 and not about the place. */
    const closure = CONSTRAINTS.find((c) => c.status === 'seasonal_closure')!;
    expect(closure.validFrom).toMatch(/^2026-/);
    expect(closure.validUntil).toMatch(/^2026-/);
    expect(closure.alternative).toBeDefined();
  });
});
