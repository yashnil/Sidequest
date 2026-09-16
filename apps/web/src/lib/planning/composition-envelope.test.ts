import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, decomposeDestination, defaultAnswers, deriveAffordances, destinationConceptSchema, routeObjectivesFor, selectModes, type Trip } from '@sidequest/core';
import { COMPOSITION_INSTRUCTION, buildCompositionTask, type DestinationEnvelope } from './composition';
import { buildCanonicalTripBuildInput } from './canonical-input';
import { travelerBriefFor } from './production-plan';
import { accessConstraintsFor } from '@/lib/providers/access-constraints';

/**
 * V10 §11 — WHAT THE ONE CALL IS TOLD, AND WHAT IT IS ASKED TO STATE.
 *
 * The model remains the composer and the old candidate-selection universe stays
 * retired. What V10 changes is the *envelope*: a broad region used to arrive as a
 * name, a scale word and a centre, and was asked to invent both the geography and
 * the trip. It now arrives with its coverage graph, its jurisdictions kept apart
 * from itself, its gateways, the operational facts that would otherwise have to
 * be corrected afterwards, and what the route is for.
 *
 * Asserted on the rendered task, because a section nobody renders is a section
 * the model never sees.
 */

const NOW = new Date('2026-09-12T12:00:00Z');

/** "the Canadian Rockies" as the semantic layer resolves it: a mountain region across two provinces. */
const CONCEPT = destinationConceptSchema.parse({
  version: 1,
  rawText: 'the Canadian Rockies',
  label: 'the Canadian Rockies',
  type: 'mountain_region',
  scale: 'region',
  countries: ['CA'],
  regions: ['Alberta', 'British Columbia'],
  landscape: 'mountains',
  center: { lat: 51.65, lng: -116.57 },
  centerBasis: 'interpreted_parts',
  extent: { bounds: { southWest: { lat: 50.6, lng: -118.2 }, northEast: { lat: 53.2, lng: -114.9 } }, source: 'interpreted_parts' },
  confidence: 'medium',
  evidence: [{ source: 'traveller', note: 'You wrote "the Canadian Rockies".' }],
  ambiguities: [],
  parts: [
    { label: 'Banff National Park', center: { lat: 51.3, lng: -115.9 }, source: 'geocoder', featureType: 'protected_area', countryCode: 'ca' },
    { label: 'Jasper National Park', center: { lat: 52.9, lng: -117.9 }, source: 'geocoder', featureType: 'protected_area', countryCode: 'ca' },
    { label: 'Yoho National Park', center: { lat: 51.4, lng: -116.5 }, source: 'geocoder', featureType: 'protected_area', countryCode: 'ca' },
    { label: 'Kootenay National Park', center: { lat: 50.9, lng: -115.9 }, source: 'geocoder', featureType: 'protected_area', countryCode: 'ca' },
  ],
  gateways: [{ label: 'Calgary', center: { lat: 51.05, lng: -114.07 }, countryCode: 'ca', source: 'geocoder' }],
  refused: [],
  jurisdictions: [
    { level: 'country', code: 'CA', name: 'Canada', countryCode: 'CA' },
    { level: 'subnational', code: 'CA-AB', name: 'Alberta', countryCode: 'CA' },
    { level: 'subnational', code: 'CA-BC', name: 'British Columbia', countryCode: 'CA' },
  ],
});

const TRIP: Trip = {
  id: 'envelope',
  basics: { mode: 'known_destination', destinationInput: 'the Canadian Rockies', regionId: 'dynamic', startDate: '2026-09-19', endDate: '2026-09-27', arrivalTime: '14:30', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [], timingLock: 'traveler' },
  status: 'draft',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function taskFor(overrides: Partial<DestinationEnvelope> = {}): string {
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 9 });
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 9 });
  const input = buildCanonicalTripBuildInput({ trip: TRIP, composer: null, profile, now: NOW });
  const decomposition = decomposeDestination({ concept: CONCEPT });
  const accessFacts = accessConstraintsFor(['CA'])
    .filter((c) => c.status !== 'unknown' && c.status !== 'open')
    .filter((c) => {
      const from = c.validFrom ?? '0000-01-01';
      const until = c.validUntil ?? '9999-12-31';
      return TRIP.basics.endDate >= from && TRIP.basics.startDate <= until;
    })
    .map((c) => `${c.travellerNote} (${c.sourceName})`);
  const envelope: DestinationEnvelope = {
    name: 'the Canadian Rockies',
    countryCode: 'CA',
    countryName: 'Canada',
    scale: 'region',
    center: CONCEPT.center!,
    coverage: decomposition.zones.map((z) => ({ label: z.label, role: z.role, kmFromCentre: z.kmFromCentre, signatureExperiences: z.signatureExperiences })),
    coverageNote: decomposition.note,
    jurisdictions: CONCEPT.jurisdictions.map((j) => ({ level: j.level, name: j.name })),
    gateways: CONCEPT.gateways.map((g) => g.label),
    accessFacts,
    routeObjectives: routeObjectivesFor({ concept: CONCEPT, profile, nights: 8, coreZones: decomposition.zones.filter((z) => z.role === 'core').length }),
    ...overrides,
  };
  const brief = travelerBriefFor({ input, envelope });
  return buildCompositionTask({ brief, envelope, mode: 'full', timing: { sidequestChooses: false, today: '2026-09-12', earliestStart: '2026-09-19' } });
}

describe('the composition envelope', () => {
  const task = taskFor();

  it('names the jurisdiction separately, and says outright that the region does not have a currency', () => {
    expect(task).toContain('JURISDICTION.');
    expect(task).toContain('sits inside Canada');
    expect(task).toContain('Alberta, British Columbia');
    expect(task).toMatch(/Currency, visas, driving rules and park passes belong to those, never to the destination itself/);
    /* The worked example the founder's trip got wrong, stated as the counterexample. */
    expect(task).toContain('never "the Canadian Rockies uses the Canadian dollar"');
  });

  it('hands over the coverage graph with roles and distances, and requires the omissions to be explained', () => {
    expect(task).toContain('COVERAGE.');
    for (const park of ['Banff National Park', 'Jasper National Park', 'Yoho National Park', 'Kootenay National Park']) expect(task).toContain(park);
    expect(task).toMatch(/\(core, ~\d+ km from centre\)/);
  });

  it('asks the stable prompt for the omissions and the alternative, and for exactly one sentence of it', () => {
    /*
     * The quality contract and the output contract live in the system prompt,
     * which is stable across trips and cached. The *evidence* travels in the task
     * above; what to do with it is asked once, here.
     */
    expect(COMPOSITION_INSTRUCTION).toMatch(/every core zone you do not visit belongs in omissions with the reason/);
    expect(COMPOSITION_INSTRUCTION).toMatch(/routeAlternative \(ONE sentence/);
    expect(COMPOSITION_INSTRUCTION).toMatch(/not a second itinerary/);
    expect(COMPOSITION_INSTRUCTION).toMatch(/One sentence, never a second plan/);
  });

  it('names the gateways as context for the edges rather than as places to spend the trip', () => {
    expect(task).toContain('GATEWAYS.');
    expect(task).toContain('Calgary');
    expect(task).toMatch(/a gateway is not a stop to spend time at/);
  });

  it('gives the operational facts before the plan is written, with their sources', () => {
    expect(task).toContain('ACCESS AND CLOSURES (hard, from official sources)');
    expect(task).toContain('Moraine Lake road');
    expect(task).toContain('Maligne Canyon is closed for the 2026 season');
    expect(task).toContain('Parks Canada');
    expect(task).toMatch(/Design around these rather than around what is normally true/);
  });

  it('states the route objectives rather than leaving them to be inferred', () => {
    expect(task).toContain('ROUTE OBJECTIVES.');
    expect(task).toMatch(/Keep each day's travel under [\d.]+ hours/);
    expect(task).toMatch(/depth beats breadth|choose the subset that goes deep/);
  });

  it('costs the call a bounded number of bytes, and says nothing when there is nothing to say', () => {
    const bare = taskFor({ coverage: undefined, coverageNote: undefined, jurisdictions: undefined, gateways: undefined, accessFacts: undefined, routeObjectives: undefined });
    /* Every new section is additive and absent when its evidence is: a city with no coverage graph is not told about one. */
    for (const heading of ['COVERAGE.', 'GATEWAYS.', 'ACCESS AND CLOSURES', 'ROUTE OBJECTIVES.', 'JURISDICTION.']) expect(bare).not.toContain(heading);
    /* And the whole enlargement is a few hundred bytes, not a packet. */
    const added = task.length - bare.length;
    expect(added).toBeGreaterThan(400);
    expect(added, `the V10 envelope added ${added} bytes`).toBeLessThan(4_000);
  });

  it('still never hands over a coordinate for a stop, an opening hour or a provider id', () => {
    /* The V8/V9 invariant, re-asserted against the enlarged envelope. */
    expect(task).not.toMatch(/google-places:|relation\/\d|nominatim/);
    expect(task).not.toMatch(/openMinute|closeMinute|providerRef/);
    /* The destination's own centre is context and is the only coordinate in the task. */
    expect((task.match(/-?\d+\.\d{2,},\s*-?\d+\.\d{2,}/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});

/**
 * V12.1 §6 §7 — WHAT THE MODEL IS TOLD ABOUT HOW THIS TRIP MOVES.
 *
 * Prevention at source, and the reason it is worth a section of its own: the
 * V11 Canadian Rockies build — this exact envelope — hinted `boat` three times
 * in a landlocked mountain park, once between Lake Louise and its own lakeshore.
 * The reconciler now refuses such a hint, and a refusal is still a leg whose
 * mode had to be replaced. A model told plainly that this trip does not cross
 * water does not propose the ferry in the first place.
 *
 * Asserted on the rendered task, like everything else here, because a section
 * nobody renders is a section the model never sees.
 */
describe('how this trip can move', () => {
  const ROCKIES_WORLD = {
    affordances: deriveAffordances({
      destination: {
        traits: ['mountain', 'road_trip_region', 'car_dependent'] as const,
        basis: { mountain: 'Screened as a mountain region.', road_trip_region: 'Covered along its roads.', car_dependent: 'Most of what is here needs a drive.' },
      } as Parameters<typeof deriveAffordances>[0]['destination'],
    }),
    reality: null,
  };

  function taskWithMobility(pattern: Parameters<typeof selectModes>[0]['policy']) {
    const mobility = selectModes({ policy: pattern, world: ROCKIES_WORLD });
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 9 });
    const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 9 });
    const input = buildCanonicalTripBuildInput({ trip: TRIP, composer: null, profile, now: NOW });
    const envelope: DestinationEnvelope = {
      name: 'the Canadian Rockies',
      countryCode: 'CA',
      countryName: 'Canada',
      scale: 'region',
      center: CONCEPT.center!,
    };
    const brief = travelerBriefFor({ input, envelope });
    return buildCompositionTask({ brief, envelope, mode: 'full', timing: { sidequestChooses: false, today: '2026-09-12', earliestStart: '2026-09-19' }, mobility });
  }

  it('names the ways a self-drive mountain trip can travel', () => {
    const task = taskWithMobility({ mobilityPattern: 'self_drive' });
    expect(task).toContain('<how_this_trip_can_move>');
    expect(task).toMatch(/Ways this trip can travel:.*drive/i);
  });

  it('says outright that this trip does not cross water, with the reason', () => {
    const task = taskWithMobility({ mobilityPattern: 'self_drive' });
    expect(task).toMatch(/Not ferry:/i);
    expect(task).toMatch(/crosses water/i);
  });

  it('tells the model this is what is possible, never what to use', () => {
    const task = taskWithMobility({ mobilityPattern: 'self_drive' });
    expect(task).toContain('This is what is possible, not what to use. It never decides a day.');
  });

  it('renders nothing at all when no selection was derived', () => {
    /* A build whose derivation threw keeps exactly the envelope V12 sent. */
    expect(taskFor()).not.toContain('<how_this_trip_can_move>');
  });
});
