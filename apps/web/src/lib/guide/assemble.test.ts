import { describe, expect, it } from 'vitest';
import type { BookedPlanItem, Itinerary, TravelIntelligence } from '@sidequest/core';
import { boardWorld, draftOf } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { assembleGuide, oneSentence, sentenceKey, stayRuns, zoneLabel, type GuideInput } from './assemble';
import { japanGuideFixture } from './fixtures/japan';
import type { GuideModel } from './model';

/**
 * THE GUIDE'S DECISIONS, WITHOUT A BROWSER.
 *
 * A real plan from the acceptance harness (two bases in the Eastern Sierra),
 * real intelligence built from it, then the assembler — so the variant rules,
 * the said-once rule and the public boundary are checked against the shape a
 * traveller's trip actually has.
 */
const NOW = new Date('2026-06-01T00:00:00.000Z');

async function world(): Promise<{ itinerary: Itinerary; intelligence: TravelIntelligence; coordinates: GuideInput['coordinates'] }> {
  const draft = draftOf({
    bases: [
      { id: 'mammoth', name: 'Mammoth Lakes', nights: 2 },
      { id: 'lee', name: 'Lee Vining', nights: 2 },
    ],
    days: [
      { base: 'mammoth', anchors: [{ name: 'Convict Lake', transport: 'car' }] },
      { base: 'mammoth', anchors: [{ name: 'Hot Creek', transport: 'car' }] },
      { base: 'lee', anchors: [{ name: 'Mono Lake', transport: 'car' }] },
      { base: 'lee', anchors: [{ name: 'Convict Lake', transport: 'car' }] },
      { base: 'lee', anchors: [] },
    ],
  });
  const context = boardWorld();
  const result = await reconcileTripDraft({ draft, context });
  const intelligence = buildTravelIntelligence({
    tripId: context.tripId,
    itinerary: result.itinerary,
    draft: { days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name })) })), bases: draft.bases.map((b) => ({ id: b.id })) },
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Mammoth Lakes', countryCode: 'US' },
    composer: null,
    booked: [],
    readinessProfile: null,
    sourcedAreas: [],
    worthSkipping: [],
    userPlaces: [],
    bookedHonored: [],
    bookedConflicts: [],
    now: NOW,
    fx: null,
  });
  const coordinates: GuideInput['coordinates'] = {};
  for (const place of context.compiledPlaces ?? []) coordinates[place.id] = place.coordinates;
  for (const anchor of result.itinerary.package?.anchors ?? []) if (anchor.placeId && anchor.identity) coordinates[anchor.placeId] ??= anchor.identity.coordinates;
  return { itinerary: result.itinerary, intelligence, coordinates };
}

const LODGING: BookedPlanItem = {
  id: 'b1',
  tripId: 't',
  type: 'lodging',
  title: 'Creekside Inn',
  date: '2026-07-10',
  endDate: '2026-07-12',
  location: '123 Secret Lane',
  confirmationRef: 'CONF-998877',
  notes: 'Door code 4411',
  cost: { amount: 512, currency: 'USD' },
  status: 'booked',
  locked: true,
  createdAt: NOW.toISOString(),
};

function input(base: Awaited<ReturnType<typeof world>>, overrides: Partial<GuideInput> = {}): GuideInput {
  return {
    variant: 'compact',
    audience: 'owner',
    trip: { destination: 'Mammoth Lakes', startDate: base.itinerary.startDate, endDate: base.itinerary.endDate, adults: 2, children: 1 },
    itinerary: base.itinerary,
    intelligence: base.intelligence,
    booked: [{ ...LODGING, date: base.itinerary.startDate, endDate: base.itinerary.days[1]?.date ?? base.itinerary.startDate }],
    coordinates: base.coordinates,
    images: {},
    rationale: {},
    personality: 'Lakes, craters and a long scenic drive, at an easy pace.',
    timeZone: 'America/Los_Angeles',
    attributions: ['© OpenStreetMap contributors'],
    worthSkipping: [{ name: 'A crowded viewpoint', reason: 'Busy all day in July.' }],
    links: { trip: 'https://sidequest.example/trips/t/itinerary', share: 'https://sidequest.example/share/abc' },
    generatedAt: NOW,
    ...overrides,
  };
}

/** Every sentence the guide prints, from every section. */
function sentences(guide: GuideModel): string[] {
  return [
    guide.identity.thesis,
    ...guide.glance.highlights.map((h) => h.why),
    guide.glance.getAround,
    ...guide.glance.throughout,
    ...guide.days.flatMap((day) => [...day.items.map((i) => i.detail), ...day.notes, day.backup]),
    ...guide.stays.map((s) => s.why),
    ...guide.transport.points,
    ...guide.prep.beforeYouGo,
    ...(guide.appendix?.planning ?? []),
  ].filter((text): text is string => Boolean(text));
}

describe('assembleGuide', () => {
  it('lays out the stays and the move between them', async () => {
    const base = await world();
    const guide = assembleGuide(input(base));
    const runs = stayRuns(base.itinerary);
    expect(guide.stays.map((s) => s.nights)).toEqual(runs.map((r) => r.nights));
    expect(guide.identity.route.length).toBe(new Set(runs.map((r) => r.name)).size);
    if (runs.length > 1) expect(guide.transport.moves.length).toBeGreaterThan(0);
    expect(guide.days).toHaveLength(base.itinerary.days.length);
  });

  it('keeps the compact copy to the essentials and gives the complete copy maps, backups and appendices', async () => {
    const base = await world();
    const compact = assembleGuide(input(base, { variant: 'compact' }));
    const complete = assembleGuide(input(base, { variant: 'complete' }));
    expect(compact.appendix).toBeUndefined();
    expect(compact.days.every((day) => !day.map && !day.photo && !day.backup)).toBe(true);
    expect(compact.prep.packing).toEqual([]);
    expect(complete.appendix).toBeDefined();
    expect(complete.days.some((day) => day.map)).toBe(true);
    expect(complete.appendix!.positions.length).toBeGreaterThan(0);
    expect(complete.bookings.length).toBeGreaterThanOrEqual(compact.bookings.length);
  });

  it('says every planning sentence once', async () => {
    const base = await world();
    for (const variant of ['compact', 'complete'] as const) {
      const keys = sentences(assembleGuide(input(base, { variant }))).map(sentenceKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('lifts a warning true on most days to the overview instead of repeating it on every day', async () => {
    const base = await world();
    const warning = 'Mountain weather turns quickly in the afternoon.';
    const itinerary = { ...base.itinerary, days: base.itinerary.days.map((day) => ({ ...day, warnings: [...day.warnings, warning] })) };
    const guide = assembleGuide(input({ ...base, itinerary }));
    expect(guide.glance.throughout).toContain(warning);
    expect(guide.days.some((day) => day.notes.includes(warning))).toBe(false);
  });

  it('gives the owner the party, stay status and budget', async () => {
    const base = await world();
    const guide = assembleGuide(input(base, { variant: 'complete' }));
    expect(guide.identity.party).toBe('2 adults, 1 child');
    expect(guide.stays[0]?.status).toBe('Booked');
    expect(guide.stays[0]?.booked).toContain('Creekside Inn');
    expect(guide.reference.links.some((link) => link.url.includes('/trips/'))).toBe(true);
  });

  it('puts nothing private into a shared copy', async () => {
    const base = await world();
    const guide = assembleGuide(input(base, { variant: 'complete', audience: 'public', links: { share: 'https://sidequest.example/share/abc' } }));
    const json = JSON.stringify(guide);
    expect(guide.identity.party).toBeUndefined();
    expect(guide.stays.every((stay) => stay.status === undefined && stay.booked === undefined)).toBe(true);
    expect(guide.bookings.every((booking) => booking.status === undefined)).toBe(true);
    expect(guide.appendix?.budget).toBeUndefined();
    expect(guide.reference.links.some((link) => link.url.includes('/trips/'))).toBe(false);
    for (const secret of ['CONF-998877', 'Door code', '123 Secret Lane', 'Creekside Inn', '512', 'adults']) expect(json).not.toContain(secret);
  });

  it('never prints a raw URL: every link is a QR target with a label', async () => {
    const base = await world();
    const guide = assembleGuide(input(base));
    for (const link of guide.reference.links) {
      expect(link.label).not.toMatch(/https?:/);
      if (link.short) expect(link.short).not.toMatch(/^https?:|\?/);
    }
  });

  it('states the zone the times are in', async () => {
    const base = await world();
    expect(assembleGuide(input(base)).identity.timeZone?.id).toBe('America/Los_Angeles');
    expect(zoneLabel('Asia/Tokyo', '2027-04-08')).toEqual({ id: 'Asia/Tokyo', abbreviation: 'GMT+9' });
    expect(zoneLabel('Not/AZone', '2027-04-08')).toBeUndefined();
  });
});

describe('oneSentence', () => {
  it('drops the fit model lead-in and keeps the specific clause', () => {
    expect(oneSentence('You marked hiking as "build the trip around it", and that is what this delivers: five alpine lakes. More here.')).toBe('Five alpine lakes.');
  });
  it('cuts long text at a word with an ellipsis', () => {
    const cut = oneSentence('word '.repeat(80));
    expect(cut.length).toBeLessThanOrEqual(231);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('the Japanese rendering fixture', () => {
  it('marks place names as Japanese and keeps the complete copy richer than the compact one', () => {
    const compact = japanGuideFixture('compact');
    const complete = japanGuideFixture('complete');
    expect(compact.placeLang).toBe('ja');
    expect(compact.days.every((day) => !day.map && !day.photo)).toBe(true);
    expect(complete.days.some((day) => day.map && day.photo)).toBe(true);
  });
});
