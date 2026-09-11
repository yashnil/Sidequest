import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport, buildTravelReality, defaultAnswers, buildTravelerProfile, type Itinerary } from '@sidequest/core';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { auditItinerary } from '../quality-audit';
import { reconcileTripDraft } from '../reconcile';
import { episodesOf, type TripDraft } from '../trip-draft';
import { TRIP_DRAFT_JSON_TAG, normalizeTripDraftWire } from '../trip-draft-wire';
import { extractJsonObject } from '@/lib/providers/json-extract';
import { fictionalWorld } from './harness';
import { vi } from 'vitest';

vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({ EaseDayButton: () => null, PrintExpand: () => null, RegenerateButton: () => null, StopEditMenu: () => null }));
vi.mock('@/app/(product)/trips/[id]/itinerary/live-controls', () => ({ AddStopForm: () => null, BookedStatusControl: () => null, DiscoverButton: () => null, FixDayButton: () => null, StopDayControls: () => null }));
vi.mock('@/components/PrintButton', () => ({ PrintButton: () => null }));

/**
 * V7 §10 — THE CHONGQING FAILURE, REPLAYED OFFLINE.
 *
 * No production dump exists in this workspace; the fixture reconstructs the
 * production draft's SHAPE from the failure report: a three-night Yangtze
 * cruise written as `partOf` days on a boat base with gorge stops and no
 * transport hints, a Wulong relocation, a return to Chongqing to board, and a
 * last day whose title promises "disembark at Yichang and fly home via
 * Chongqing" while holding only breakfast. Two shapes are held:
 *
 *   production-shape.json — what the V6 model wrote (no episodes, no moves).
 *     The V7 compiler must read the cruise from the days it has, never build a
 *     road leg to a gorge, and refuse "Ready" while the promised flight is not
 *     structured.
 *   v7-shape.json — the same trip with the episode, the moves and the food the
 *     V7 prompt asks for. Every promise is a leg; the flight is counted once,
 *     everywhere.
 *
 * Nothing here calls a provider or a model; the world is a fixture geocoder
 * and a fixture router at real-ish coordinates.
 */
const NOW = new Date('2026-09-10T12:00:00Z');

const PLACES = [
  { name: 'Chongqing', lat: 29.5630, lng: 106.5516, entityType: 'city' as const },
  { name: 'Hongya Cave', lat: 29.5628, lng: 106.5787 },
  { name: 'Jiefangbei', lat: 29.5566, lng: 106.5766, entityType: 'neighbourhood' as const },
  { name: 'Ciqikou Ancient Town', lat: 29.5817, lng: 106.4530 },
  { name: 'Liziba Station', lat: 29.5558, lng: 106.5213 },
  { name: 'Eling Park', lat: 29.5527, lng: 106.5333 },
  { name: 'Yangtze River Cableway', lat: 29.5563, lng: 106.5834 },
  { name: 'Shibati', lat: 29.5535, lng: 106.5716, entityType: 'neighbourhood' as const },
  { name: 'Wulong', lat: 29.3254, lng: 107.7592, entityType: 'city' as const },
  { name: 'Three Natural Bridges', lat: 29.4700, lng: 107.7900 },
  { name: 'Longshuixia Fissure Gorge', lat: 29.4560, lng: 107.7700 },
  { name: 'Furong Cave', lat: 29.2340, lng: 107.8990 },
  { name: 'Chaotianmen Pier', lat: 29.5723, lng: 106.5861 },
  { name: 'Fengdu Ghost City', lat: 29.8900, lng: 107.7200 },
  { name: 'Qutang Gorge', lat: 31.0450, lng: 109.5600 },
  { name: 'Wu Gorge', lat: 31.0500, lng: 109.9000 },
  { name: 'Little Three Gorges', lat: 31.1500, lng: 109.9200 },
  { name: 'Three Gorges Dam', lat: 30.8230, lng: 111.0030 },
  { name: 'Yichang', lat: 30.6919, lng: 111.2864, entityType: 'city' as const },
  /* Names the live 2026-09-11 answer used. */
  { name: 'Hongyadong', lat: 29.5628, lng: 106.5787 },
  { name: 'Chaotianmen Square', lat: 29.5723, lng: 106.5861 },
  { name: 'Chongqing Chaotianmen Port', lat: 29.5725, lng: 106.5870 },
  { name: 'Nanshan Yikeshu viewpoint', lat: 29.5390, lng: 106.6180 },
  { name: 'Xiling Gorge', lat: 30.8000, lng: 111.1000 },
  { name: 'Loquat Hill Park', lat: 29.5560, lng: 106.5690 },
];

function fixture(name: string): TripDraft {
  const text = readFileSync(resolve(process.cwd(), 'apps/web/src/lib/planning/acceptance/fixtures/chongqing', name), 'utf8');
  let raw: unknown;
  if (name.endsWith('.txt')) {
    /* A recorded model answer, exactly as it arrived: the same extraction the build uses. */
    const extracted = extractJsonObject(text, { wrapperTag: TRIP_DRAFT_JSON_TAG });
    if (!extracted.ok) throw new Error(`fixture ${name} did not extract`);
    raw = extracted.json;
  } else {
    raw = JSON.parse(text) as unknown;
  }
  const normalized = normalizeTripDraftWire(raw, { days: 9 });
  if (!normalized.ok) throw new Error(`fixture ${name} did not normalise: ${JSON.stringify(normalized.issues)}`);
  return normalized.draft;
}

async function build(draft: TripDraft) {
  const world = fictionalWorld({
    name: 'Chongqing',
    countryCode: 'CN',
    center: { lat: 29.5630, lng: 106.5516 },
    places: PLACES,
    basics: { startDate: '2026-10-24', endDate: '2026-11-01', arrivalTime: '14:00', departureTime: '18:00', adults: 4, children: 0 },
    profile: { willDrive: false },
  });
  const { context, trip } = world;
  const result = await reconcileTripDraft({ draft, context });
  const reality = buildTravelReality({ label: 'Chongqing', countries: ['CN'], crossBorder: false, entityType: 'municipality', traits: ['dense_urban', 'city_region', 'broad_geography', 'food_dense'], tripDays: 9, party: { size: 4, drivers: null }, capabilities: { roadRouting: true, transit: false } });
  const withReality: Itinerary = { ...result.itinerary, package: result.itinerary.package ? { ...result.itinerary.package, reality } : undefined };
  const audit = auditItinerary({ draft, itinerary: withReality, profile: context.profile, trip, reality });
  const feasibility = buildFeasibilityReport({ itinerary: withReality, audit });
  const answers = { ...defaultAnswers({ travelerNeeds: [], tripDays: 9 }), dietaryNeeds: ['no_beef', 'no_pork'] as never, dietaryStrict: true };
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 9 });
  const intel = buildTravelIntelligence({
    tripId: trip.id,
    itinerary: withReality,
    draft: { days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name, ...(a.transport ? { transport: a.transport } : {}) })) })), bases: draft.bases.map((b) => ({ id: b.id, ...(b.overnight ? { overnight: b.overnight } : {}) })), ...(draft.driving ? { driving: draft.driving } : {}) },
    profile,
    basics: trip.basics,
    destination: { name: 'Chongqing', countryCode: 'CN', timeZone: 'Asia/Shanghai' },
    booked: [],
    readinessProfile: { citizenship: 'US', residence: 'US', transitCountries: [] },
    now: NOW,
  });
  return { draft, itinerary: withReality, audit, feasibility, intel, world };
}

const legsOf = (itinerary: Itinerary, dayNumber: number) => itinerary.days.find((d) => d.dayNumber === dayNumber)!.items.filter((i) => i.kind === 'travel' && i.travel);
const failing = (audit: { checks: { id: string; ok: boolean; detail: string }[] }) => audit.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);

describe('the Chongqing production draft, replayed through the V7 compiler', () => {
  it('reads the cruise as an episode from the days it has, and never drives to a gorge from the ship', async () => {
    const draft = fixture('production-shape.json');
    expect(episodesOf(draft)).toEqual([expect.objectContaining({ name: 'Yangtze cruise', kind: 'cruise', mode: 'boat', fromDay: 7, toDay: 9 })]);
    const { itinerary, audit } = await build(draft);
    const cruiseBase = itinerary.package!.bases.find((b) => /cruise ship/i.test(b.name))!;
    expect(cruiseBase.baseKind).toBe('vessel');
    expect(cruiseBase.episode).toBe('Yangtze cruise');
    expect(cruiseBase.placeId).toBeUndefined();
    const gorgeLegs = legsOf(itinerary, 8);
    expect(gorgeLegs.length).toBeGreaterThan(0);
    for (const leg of gorgeLegs) {
      expect(leg.travel!.mode, leg.title).not.toBe('drive');
      expect(leg.travel!.episode, leg.title).toBe('Yangtze cruise');
      expect(leg.travel!.episodeMode).toBe('boat');
      expect(leg.title).toMatch(/^Boat passage to/);
      expect(leg.durationMinutes).toBeLessThan(120);
    }
    expect(audit.checks.find((c) => c.id === 'episode_modes_respected')!.ok).toBe(true);
    expect(itinerary.package!.episodes).toHaveLength(1);
    expect(itinerary.package!.episodes[0]).toMatchObject({ kind: 'cruise', mode: 'boat', dayNumbers: [7, 8, 9], timing: 'operator' });
  });

  it('the Wulong transfer is explicit and the return to Chongqing is chronological', async () => {
    const { itinerary, audit } = await build(fixture('production-shape.json'));
    const toWulong = legsOf(itinerary, 4).find((l) => l.travel!.role === 'transfer' || l.travel!.fromName === 'Chongqing');
    expect(toWulong, 'day 4 leaves Chongqing for Wulong').toBeDefined();
    const day6 = itinerary.days[5]!;
    expect(day6.baseName).toBe('Chongqing');
    const back = legsOf(itinerary, 6).find((l) => l.travel!.fromName === 'Wulong' || l.travel!.role === 'transfer');
    expect(back, 'day 6 leaves Wulong').toBeDefined();
    expect(audit.checks.find((c) => c.id === 'base_moves_have_transfers')!.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'transfer_endpoints_match')!.ok).toBe(true);
  });

  it('a last day that promises "fly home via Chongqing" with only breakfast cannot be Ready', async () => {
    const { itinerary, audit, feasibility } = await build(fixture('production-shape.json'));
    const promise = audit.checks.find((c) => c.id === 'promised_transport_is_structured')!;
    expect(promise.ok).toBe(false);
    expect(promise.detail).toMatch(/day 9 promises a flight/);
    expect(audit.checks.find((c) => c.id === 'last_day_reaches_departure')!.ok).toBe(false);
    expect(feasibility.verdict).toBe('unresolved_major_dependency');
    expect(feasibility.items.some((i) => /promised flight/i.test(i.detail))).toBe(true);
    expect(itinerary.package!.episodes[0]!.exitLeg).toBe('missing');
    expect(feasibility.items.some((i) => /does not say how you leave it/.test(i.detail))).toBe(true);
  });

  it('the cruise is booked as one thing, never as parking, a hotel night or a two-litre water bottle', async () => {
    const { intel } = await build(fixture('production-shape.json'));
    const cruise = intel.bookings.items.find((b) => b.kind === 'cruise');
    expect(cruise).toBeDefined();
    expect(cruise!.priority).toBe('book_first');
    expect(cruise!.title).toMatch(/Yangtze cruise/);
    expect(intel.bookings.items.filter((b) => b.kind === 'accommodation' && /cruise ship/i.test(b.title))).toEqual([]);
    const vessel = intel.lodging.bases.find((b) => /cruise ship/i.test(b.name))!;
    expect(vessel.advantages.join(' ')).not.toMatch(/parking/i);
    expect(intel.lodging.bases.flatMap((b) => b.advantages).join(' ')).not.toMatch(/Parking at the door/);
    const packing = intel.packing.items.map((i) => i.label).join(' | ');
    /* Water is packed for the Wulong trail days, never as universal advice for a cruise. */
    expect(intel.packing.items.find((i) => /litres of water/i.test(i.label))?.label ?? 'trail days').toMatch(/trail days/);
    expect(packing).not.toMatch(/Headtorch/);
    expect(packing).not.toMatch(/Car charger/);
    expect(packing).toMatch(/day bag for shore stops/);
    const cruiseLine = intel.budget.lines.find((l) => l.bundle);
    expect(cruiseLine).toBeDefined();
    expect(cruiseLine!.precision).toBe('unknown');
    expect(intel.budget.lines.find((l) => l.category === 'lodging' && !l.bundle)!.basis).toMatch(/6 nights .*2 on board/);
    expect(cruiseLine!.basis).toMatch(/2 nights on board/);
  });

  it('with the V7 shape, the flight exists once and everywhere: days, transport, budget, bookings; the plan is coherent', async () => {
    const draft = fixture('v7-shape.json');
    expect(draft.episodes).toHaveLength(1);
    expect(draft.days[8]!.move).toEqual({ how: 'flight', via: 'Chongqing', when: 'end' });
    expect(draft.package.foodStrategy[0]).toMatch(/^Seek: hotpot/);
    const { itinerary, audit, feasibility, intel } = await build(draft);
    expect(failing(audit).filter((f) => /^(base_moves|transfer_endpoints|episode_modes|promised_transport|last_day|transport_reality)/.test(f)).join('\n')).toBe('');
    const flightLegs = intel.transport.legs.filter((l) => l.mode === 'flight');
    expect(flightLegs).toHaveLength(1);
    expect(flightLegs[0]!.originName).toMatch(/cruise ship/i);
    expect(flightLegs[0]!.destinationName).toBe('Chongqing');
    expect(flightLegs[0]!.dayNumber).toBe(9);
    expect(intel.budget.lines.find((l) => l.category === 'long_distance_transport')!.basis).toMatch(/1 internal flight/);
    expect(intel.bookings.items.find((b) => b.kind === 'flight')!.title).toMatch(/Flight: .*cruise ship.* → Chongqing/i);
    expect(intel.bookings.items.filter((b) => b.priority === 'book_first').map((b) => b.kind)).toContain('cruise');
    expect(itinerary.package!.episodes[0]!.exitLeg).toBe('present');
    expect(itinerary.package!.episodes[0]!.entryLeg).toBe('present');
    expect(feasibility.verdict).not.toBe('unresolved_major_dependency');
    expect(feasibility.verdict).not.toBe('infeasible');
    /* The day the cruise is boarded opens with the transfer, so boarding is not scheduled after the day's stops. */
    const day6 = itinerary.days[5]!;
    const firstTravel = day6.items.find((i) => i.kind === 'travel');
    expect(firstTravel?.travel?.role).toBe('transfer');
    /* No self-drive advice for a trip with a hired driver, and the reality says so too. */
    expect(audit.checks.find((c) => c.id === 'transport_arrangement_consistent')!.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'transport_reality_respected')!.ok).toBe(true);
    expect(itinerary.transportStrategy.parkingSummary).toMatch(/nothing on this trip is yours to park/i);
    /* Prepare: the China set-up reaches readiness as reference, never as official confirmation. */
    const setup = intel.readiness.entries.filter((e) => e.kind === 'local_setup');
    expect(setup.map((e) => e.title).join(' | ')).toMatch(/Alipay|WeChat/);
    expect(setup.map((e) => e.title).join(' | ')).toMatch(/12306/);
    expect(setup.every((e) => e.state === 'unverified')).toBe(true);
    /* The food strategy is the model's, not a template. */
    expect(itinerary.package!.foodStrategy.join(' ')).toMatch(/xiaomian/);
    expect(itinerary.foodPlan.headline).not.toBe('Meals follow the route.');
  });
});

/*
 * V7 §15 — THE HUB SAYS WHAT THE COMPILER KNOWS.
 *
 * Rendered server-side from the same replay: a cruise day carries its badge and
 * reads "on board" rather than "based in"; the map's legend names the boat
 * line; Prepare opens with the compiled set-up for the country; nothing on the
 * page advises parking on a ship.
 */
describe('the Chongqing V7 shape, rendered', () => {
  it('shows the cruise as one thing on the days, the map and Prepare', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ItineraryView } = await import('@/components/ItineraryView');
    const { itinerary, intel, world } = await build(fixture('v7-shape.json'));
    const html = renderToStaticMarkup(
      createElement(ItineraryView, {
        itinerary,
        intelligence: intel,
        preparation: [],
        tripId: world.trip.id,
        dateLabel: '10–18 Oct',
        renderedAt: NOW.getTime(),
        coordinates: {},
        rationale: {},
      }),
    );
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    expect(html).toMatch(/data-testid="day-episode-8"[^>]*data-episode-kind="cruise"/);
    expect(text).toMatch(/Cruise · day 2 of 3 · Yangtze cruise/);
    expect(text).toMatch(/on board Yangtze cruise ship|on board .{0,40}cruise/i);
    expect(html).toMatch(/data-testid="local-setup"/);
    expect(text).toMatch(/Set these up before you land/);
    expect(text).not.toMatch(/Parking at the door/);
    expect(text).not.toMatch(/Nothing is guessed/);
  });
});

/*
 * THE LIVE 2026-09-11 ANSWER, REPLAYED WITH ZERO CALLS.
 *
 * Sonnet 5's real answer for four friends, eight nights, best time, no beef and
 * no pork: a three-night city base, a four-day cruise declared as an episode
 * with a boat move at its start and a high-speed-rail move at its end, and a
 * food strategy written around the diet. What the first compile of it got
 * wrong — the night after the train still on the ship, a walk from a moored
 * vessel to a park, no dinner on the arrival evening, a cableway read as a
 * car — is pinned here against the raw text.
 */
describe('the live Chongqing answer of 2026-09-11, replayed', () => {
  it('the train home ends the cruise day, the night moves to the city, and the arrival evening eats', async () => {
    const draft = fixture('live-2026-09-11.txt');
    expect(draft.episodes?.[0]).toMatchObject({ kind: 'cruise', mode: 'boat', fromDay: 4, toDay: 7 });
    const cableway = draft.days[2]!.anchors.find((a) => /Cableway/.test(a.name));
    expect(cableway?.transport).not.toBe('car');
    const { itinerary, audit, feasibility } = await build(draft);
    const day7 = itinerary.days[6]!;
    expect(day7.baseName).toMatch(/Chongqing city/);
    const rail = legsOf(itinerary, 7).find((l) => l.travel!.role === 'transfer');
    expect(rail, 'day 7 ends with the train to Chongqing').toBeDefined();
    expect(rail!.travel!.hint).toBe('high_speed_rail');
    expect(rail!.travel!.mode).toBe('rail');
    expect(rail!.travel!.toName).toMatch(/Chongqing city/);
    /* Day 8 starts in the city, never on a moored ship. */
    const day8First = legsOf(itinerary, 8)[0];
    expect(day8First?.travel!.fromName ?? '').not.toMatch(/cruise ship/);
    expect(itinerary.package!.bases.map((b) => [b.name, b.nights])).toEqual([
      ['Chongqing city (Jiefangbei/Yuzhong)', 3],
      ['Yangtze cruise ship', 3],
      ['Chongqing city (Jiefangbei/Yuzhong)', 2],
    ]);
    expect(itinerary.package!.episodes[0]).toMatchObject({ kind: 'cruise', entryLeg: 'present', exitLeg: 'present' });
    /* The arrival evening has its hotpot before the skyline. */
    const day1 = itinerary.days[0]!;
    expect(day1.items.some((i) => i.kind === 'meal' && /hotpot/i.test(i.title))).toBe(true);
    expect(audit.checks.find((c) => c.id === 'promised_transport_is_structured')!.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'meals_present')!.ok).toBe(true);
    expect(feasibility.items.filter((i) => i.severity === 'dependency').map((i) => i.detail)).toEqual([]);
    expect(feasibility.verdict).not.toBe('unresolved_major_dependency');
  });
});
