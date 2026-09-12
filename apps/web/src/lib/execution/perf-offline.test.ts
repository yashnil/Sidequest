import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCalendar,
  buildLedger,
  buildNextActions,
  buildPreflight,
  buildTripStateGraph,
  deriveDecisions,
  draftDelta,
  extractConfirmation,
  metricsDelta,
  redactSensitive,
  volatileFacts,
  yearsBetween,
  type CalendarEvent,
  type Itinerary,
  type TravelIntelligence,
  type Trip,
} from '@sidequest/core';
import { tripDraftSchema, type TripDraft } from '@/lib/planning/trip-draft';
import { fictionalWorld } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import { createTrip, getProfile } from '@/lib/db/repository';
import { getIntent } from '@/lib/db/compiler-repository';
import { clearTravelIntelligence, getDraftHints, getFxRate, getReadinessProfile, getTravelIntelligence, listBookedItems, listChecks } from '@/lib/db/intelligence-repository';
import { listBookingResolutions } from '@/lib/db/execution-repository';
import { applyTripPatch, patchReach, tripPatchSchema } from '@/lib/refine/patch';
import { buildTripCalendar, calendarEventsFor, type TripCalendarSource } from './calendar-events';
import { prepareImport } from './import';

/**
 * V9.1 §4 — PERFORMANCE OF THE IN-PROCESS PATHS, MEASURED OFFLINE.
 *
 * Every V9 surface is a pure function of persisted facts, so its cost can be
 * measured with no server, no browser and no provider: the stored Iceland
 * draft (`live-v9-draft.json`, the one whose refinement timed out live) is
 * reconciled once through the acceptance harness's programmable providers
 * into a full itinerary, the intelligence is built from it, and then every
 * execution engine is timed over ≥ 20 repetitions with `performance.now()`.
 *
 * One `PERF {...}` JSON line per figure goes to stdout so a run can be read
 * into a table. The assertions are generous ceilings only — a slow CI worker
 * must not fail the suite; a regression of an order of magnitude must.
 *
 * The fictional world's positions are for measurement only. They are not
 * travel knowledge and nothing here asserts on them.
 */
const NOW = new Date('2026-09-01T09:00:00Z');
const FIXTURE = new URL('../planning/acceptance/fixtures/iceland/live-v9-draft.json', import.meta.url);
const TIME_ZONE = 'Atlantic/Reykjavik';
const REPS = 30;

/* --------------------------------------------------------------------------------------------- *
 * Measurement helpers
 * --------------------------------------------------------------------------------------------- */

interface Figure {
  name: string;
  reps: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function summarise(name: string, samples: readonly number[], extra: Record<string, unknown> = {}): Figure {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const p95 = sorted[Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))]!;
  const figure: Figure = { name, reps: n, medianMs: round(median), p95Ms: round(p95), minMs: round(sorted[0]!), maxMs: round(sorted[n - 1]!) };
  process.stdout.write(`PERF ${JSON.stringify({ ...figure, ...extra })}\n`);
  return figure;
}

function measure<T>(name: string, fn: () => T, options: { reps?: number; warmup?: number; extra?: Record<string, unknown> } = {}): { figure: Figure; result: T } {
  const reps = options.reps ?? REPS;
  let result!: T;
  for (let i = 0; i < (options.warmup ?? 3); i += 1) result = fn();
  const samples: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const started = performance.now();
    result = fn();
    samples.push(performance.now() - started);
  }
  return { figure: summarise(name, samples, options.extra), result };
}

async function measureAsync<T>(name: string, fn: () => Promise<T>, options: { reps?: number; warmup?: number; extra?: Record<string, unknown> } = {}): Promise<{ figure: Figure; result: T }> {
  const reps = options.reps ?? REPS;
  let result!: T;
  for (let i = 0; i < (options.warmup ?? 3); i += 1) result = await fn();
  const samples: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const started = performance.now();
    result = await fn();
    samples.push(performance.now() - started);
  }
  return { figure: summarise(name, samples, options.extra), result };
}

/** Median under the ceiling, p95 under a wide multiple of it: a ceiling, never a target. */
function under(figure: Figure, ceilingMs: number): void {
  expect(figure.medianMs, `${figure.name} median`).toBeLessThan(ceilingMs);
  expect(figure.p95Ms, `${figure.name} p95`).toBeLessThan(ceilingMs * 4);
}

/* --------------------------------------------------------------------------------------------- *
 * The trip under measurement: the stored Iceland draft, reconciled offline
 * --------------------------------------------------------------------------------------------- */

const draft: TripDraft = tripDraftSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

/** Positions for the fixture geocoder and router. Measurement scaffolding only. */
const PLACES: readonly { name: string; lat: number; lng: number; entityType?: 'city' | 'unknown' }[] = [
  { name: 'Reykjavík', lat: 64.1466, lng: -21.9426, entityType: 'city' },
  { name: 'Vík', lat: 63.4194, lng: -19.006, entityType: 'city' },
  { name: 'Höfn area', lat: 64.2539, lng: -15.2082, entityType: 'city' },
  { name: 'Selfoss', lat: 63.9337, lng: -20.9971, entityType: 'city' },
  { name: 'Hallgrímskirkja', lat: 64.1417, lng: -21.9266 },
  { name: 'Old Harbour', lat: 64.1505, lng: -21.945 },
  { name: 'National Museum of Iceland', lat: 64.1418, lng: -21.949 },
  { name: 'Sky Lagoon', lat: 64.114, lng: -21.943 },
  { name: 'Seljalandsfoss', lat: 63.6156, lng: -19.9886 },
  { name: 'Skógafoss', lat: 63.5321, lng: -19.5114 },
  { name: 'Sólheimajökull', lat: 63.53, lng: -19.37 },
  { name: 'Reynisfjara black sand beach', lat: 63.404, lng: -19.045 },
  { name: 'Dyrhólaey', lat: 63.402, lng: -19.127 },
  { name: 'Fjaðrárgljúfur canyon', lat: 63.771, lng: -18.172 },
  { name: 'Diamond Beach', lat: 64.043, lng: -16.177 },
  { name: 'Jökulsárlón glacier lagoon', lat: 64.048, lng: -16.18 },
  { name: 'Vestrahorn', lat: 64.247, lng: -14.99 },
  { name: 'Höfn harbour', lat: 64.25, lng: -15.21 },
  { name: 'Skaftafell', lat: 64.016, lng: -16.966 },
  { name: 'Kerið crater', lat: 64.041, lng: -20.885 },
  { name: 'Þingvellir National Park', lat: 64.255, lng: -21.13 },
  { name: 'Geysir geothermal area', lat: 64.31, lng: -20.3 },
  { name: 'Gullfoss', lat: 64.327, lng: -20.121 },
  { name: 'Hveragerði geothermal park', lat: 64.0, lng: -21.19 },
  { name: 'Sun Voyager sculpture', lat: 64.1476, lng: -21.9223 },
  { name: 'Grandi harbour district', lat: 64.156, lng: -21.952 },
];

const HOTEL_TEXT = `Booking.com
Your booking is confirmed
Confirmation number: 3141.592.653
Hotel Granvia Kyoto
Address: 901 Higashi-Shiokoji-cho, Kyoto
Check-in: Monday, 12 October 2026 (from 15:00)
Check-out: Thursday, 15 October 2026 (until 11:00)
2 adults
Total price: ¥84,000
Free cancellation until 5 October 2026
Questions? Call +81 75 344 8888 or write to help@booking.com. Card ending 4242 4242 4242 4242.`;

const FLIGHT_TEXT = `Air Canada e-ticket itinerary
Booking reference (PNR): K7Q2ZP
AC 123  YYZ - YYC
Departs 12/10/2026 08:00  Arrives 12/10/2026 10:30 MDT
Passengers: 2
Total charged CAD 912.40`;

const BARE_TEXT = 'Thanks for your order! See you soon.';

const WINDOW = { tripStart: '2026-10-12', tripEnd: '2026-10-22' };

/** A raw RFC 5322 message with a plain body — the `.eml` a traveller saves from a mail client. */
function tinyEml(): Uint8Array {
  const raw = [
    'From: Icelandair <noreply@icelandair.com>',
    'To: alex@example.com',
    'Subject: Your itinerary — record locator K7PQ2M',
    'Date: Tue, 1 Sep 2026 09:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Icelandair booking confirmation',
    'Record locator: K7PQ2M',
    'Passenger: 1 adult',
    'FI 455 KEF → CDG',
    'Departs 18 Sep 2026 at 07:35, arrives 12:50 (CET)',
    'Seat 14A · Boarding at 06:55',
    'Total paid: USD 312.40',
    'Non-refundable fare.',
    '',
  ].join('\r\n');
  return new Uint8Array(Buffer.from(raw, 'utf8'));
}

/** A minimal, valid, uncompressed PDF with one page of Helvetica lines — the same shape `import.test.ts` reads. */
function tinyPdf(lines: readonly string[]): Uint8Array {
  const content = ['BT', '/F1 12 Tf', '72 740 Td', '14 TL', ...lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const shapeOf = (d: TripDraft) => ({
  bases: d.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights })),
  days: d.days.map((day) => ({ dayNumber: day.dayNumber, baseId: day.baseId, anchors: day.anchors.map((a) => ({ name: a.name, role: a.role, transport: a.transport })) })),
});

/* --------------------------------------------------------------------------------------------- *
 * State shared by the measurements
 * --------------------------------------------------------------------------------------------- */

let itinerary: Itinerary;
let intelligence: TravelIntelligence;
let trip: Trip;
let directory: string;

const dbGlobal = globalThis as unknown as { sidequestDb?: { close(): void } };

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-perf-'));
  dbGlobal.sidequestDb?.close();
  delete dbGlobal.sidequestDb;
  process.env.SIDEQUEST_DB_PATH = join(directory, 'perf.db');

  const world = fictionalWorld({
    name: 'Iceland',
    countryCode: 'IS',
    center: { lat: 64.1466, lng: -21.9426 },
    places: PLACES,
    basics: { destinationInput: 'Iceland', startDate: draft.window!.startDate, endDate: draft.window!.endDate },
    profile: { willDrive: true },
    roadKmh: 70,
  });
  const started = performance.now();
  const result = await reconcileTripDraft({ draft, context: world.context });
  summarise('reconcileTripDraft (one offline build of the stored draft)', [performance.now() - started], { days: result.itinerary.days.length, anchors: result.dispositions.length, calls: world.calls });
  itinerary = result.itinerary;
  intelligence = buildTravelIntelligence({
    tripId: itinerary.tripId,
    itinerary,
    draft,
    profile: world.context.profile,
    basics: world.context.basics,
    destination: { name: 'Iceland', countryCode: 'IS', timeZone: TIME_ZONE },
    booked: [],
    readinessProfile: { citizenship: 'US', passportExpiry: '2027-12', transitCountries: [] },
    now: NOW,
  });
  trip = createTrip({ mode: 'known_destination', destinationInput: 'Iceland', regionId: 'dynamic', startDate: draft.window!.startDate, endDate: draft.window!.endDate, arrivalTime: '10:00', departureTime: '17:00', adults: 2, children: 0, travelerNeeds: [] });
}, 60_000);

afterAll(() => {
  dbGlobal.sidequestDb?.close();
  delete dbGlobal.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const daysUntilTrip = () => Math.round((Date.parse(`${itinerary.startDate}T00:00:00Z`) - Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate())) / 86_400_000);

/* --------------------------------------------------------------------------------------------- *
 * The measurements
 * --------------------------------------------------------------------------------------------- */

describe('the offline build under measurement', () => {
  it('is the stored Iceland draft, reconciled whole: ten days, five stays, every anchor disposed', () => {
    expect(itinerary.days).toHaveLength(10);
    expect(itinerary.package?.bases.length).toBeGreaterThanOrEqual(5);
    expect(itinerary.package?.anchors.length).toBe(22);
    expect(intelligence.bookings.items.length).toBeGreaterThan(0);
  });
});

describe('the execution engines', () => {
  it('state graph, next actions, preflight, decisions, ledger and volatile facts each answer in single-digit milliseconds', () => {
    const graphRun = measure('buildTripStateGraph', () => buildTripStateGraph({ itinerary, intelligence, booked: [], now: NOW }));
    const graph = graphRun.result;
    process.stdout.write(`PERF ${JSON.stringify({ name: 'buildTripStateGraph.nodes', nodes: graph.nodes.length, counts: graph.counts })}\n`);
    under(graphRun.figure, 50);

    const decisionsRun = measure('deriveDecisions', () => deriveDecisions({ itinerary, intelligence, travellerFacts: [draft.purpose] }));
    under(decisionsRun.figure, 20);
    expect(decisionsRun.result.length).toBeGreaterThanOrEqual(3);

    const withDecisions = buildTripStateGraph({ itinerary, intelligence, booked: [], decisions: decisionsRun.result, now: NOW });
    const nextRun = measure('buildNextActions', () => buildNextActions({ graph: withDecisions, lifecycle: 'planning', daysUntilTrip: daysUntilTrip(), now: NOW }));
    under(nextRun.figure, 20);
    expect(nextRun.result.actions.length).toBeGreaterThan(0);
    expect(nextRun.result.actions.length).toBeLessThanOrEqual(3);

    const preflightRun = measure('buildPreflight', () => buildPreflight({ graph: withDecisions, intelligence, booked: [], checks: { preflight: [], packing: [], checklist: [] }, daysUntilTrip: daysUntilTrip() }));
    under(preflightRun.figure, 20);
    expect(['ready', 'nearly', 'not_yet']).toContain(preflightRun.result.verdict);

    const ledgerRun = measure('buildLedger', () => buildLedger({ budget: intelligence.budget, booked: [], openNeeds: intelligence.bookings.items.filter((b) => b.status === 'open' && !b.memberIds) }));
    under(ledgerRun.figure, 10);

    const volatileRun = measure('volatileFacts', () => volatileFacts({ itinerary, intelligence, booked: [], now: NOW, capabilities: { forecast: false, hours: false, transit: false } }));
    under(volatileRun.figure, 20);
    expect(volatileRun.result.length).toBeGreaterThan(0);
  });
});

describe('the calendar', () => {
  it('derives the events and writes 56 of them with VTIMEZONE well inside 100 ms', () => {
    const source: TripCalendarSource = {
      tripId: itinerary.tripId,
      itinerary,
      booked: [],
      zonesByBaseId: Object.fromEntries((itinerary.package?.bases ?? []).map((b) => [b.id, TIME_ZONE])),
      primaryTimeZone: TIME_ZONE,
      coordinates: {},
      sequence: 1,
    };
    const derived = measure('calendarEventsFor (the plan’s own events)', () => calendarEventsFor(source));
    process.stdout.write(`PERF ${JSON.stringify({ name: 'calendarEventsFor.events', events: derived.result.events.length, timeZones: derived.result.timeZones })}\n`);
    under(derived.figure, 50);

    /* Exactly 56 events, the live Iceland feed's count, so the figure is comparable run to run. */
    const own = derived.result.events;
    const events: CalendarEvent[] = [];
    for (let i = 0; events.length < 56; i += 1) {
      const base = own[i % own.length]!;
      events.push(i < own.length ? base : { ...base, uid: `${base.uid.replace('@sidequest', '')}-${i}@sidequest` });
    }
    const built = measure('buildCalendar (56 events, VTIMEZONE)', () =>
      buildCalendar({
        name: 'Iceland — Sidequest',
        description: 'Ten days.',
        timeZones: [TIME_ZONE],
        years: yearsBetween(itinerary.startDate, itinerary.endDate),
        events,
        stamp: NOW.toISOString(),
        refreshInterval: 'PT1H',
        primaryTimeZone: TIME_ZONE,
      }),
    );
    under(built.figure, 100);
    expect(built.result.match(/BEGIN:VEVENT/g)).toHaveLength(56);
    expect(built.result).toContain('BEGIN:VTIMEZONE');

    const whole = measure('buildTripCalendar (source → ICS)', () => buildTripCalendar(source, { name: 'Iceland', summary: 'Ten days.', attributions: ['x'], stamp: NOW.toISOString(), refreshInterval: 'PT1H' }));
    under(whole.figure, 100);
  });
});

describe('reading a confirmation', () => {
  it('extractConfirmation reads the hotel, the flight and the bare text in single-digit milliseconds', () => {
    const hotel = measure('extractConfirmation (hotel)', () => extractConfirmation(redactSensitive(HOTEL_TEXT), { ...WINDOW, senderDomain: 'booking.com', subject: 'Your booking is confirmed' }));
    under(hotel.figure, 20);
    expect(hotel.result.type).toBe('lodging');
    const flight = measure('extractConfirmation (flight)', () => extractConfirmation(FLIGHT_TEXT, { ...WINDOW, senderDomain: 'aircanada.com' }));
    under(flight.figure, 20);
    expect(flight.result.type).toBe('flight');
    const bare = measure('extractConfirmation (bare)', () => extractConfirmation(BARE_TEXT, {}));
    under(bare.figure, 20);
    expect(bare.result.type).toBe('custom');
  });

  it('prepareImport reads pasted text, an .eml and a small PDF inside 500 ms, with the first call’s module load reported apart', async () => {
    const text = await measureAsync('prepareImport (pasted text)', () => prepareImport({ kind: 'text', text: HOTEL_TEXT, sender: 'noreply@booking.com' }, WINDOW));
    under(text.figure, 100);
    expect(text.result.ok).toBe(true);

    const eml = tinyEml();
    const emlCold = performance.now();
    const first = await prepareImport({ kind: 'file', fileBase64: b64(eml), filename: 'itinerary.eml' }, WINDOW);
    summarise('prepareImport (.eml) first call, includes loading the mail reader', [performance.now() - emlCold]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.prepared.sourceKind).toBe('eml');
    const emlRun = await measureAsync('prepareImport (.eml)', () => prepareImport({ kind: 'file', fileBase64: b64(eml), filename: 'itinerary.eml' }, WINDOW));
    under(emlRun.figure, 500);
    expect(emlRun.result.ok).toBe(true);
    if (emlRun.result.ok) expect(emlRun.result.prepared.extracted.confirmationRef).toBe('K7PQ2M');

    const pdf = tinyPdf(['Smyril Line - Booking confirmation', 'Booking reference: SL88214', 'Ferry: Hirtshals to Torshavn', 'Departure date: 14 September 2026', 'Departs 15:30', '2 passengers, 1 vehicle', 'Total amount: 3,420.00 DKK']);
    const pdfCold = performance.now();
    const firstPdf = await prepareImport({ kind: 'file', fileBase64: b64(pdf), filename: 'booking.pdf' }, { tripStart: '2026-09-10', tripEnd: '2026-09-20' });
    summarise('prepareImport (.pdf) first call, includes loading the PDF reader', [performance.now() - pdfCold]);
    expect(firstPdf.ok).toBe(true);
    const pdfRun = await measureAsync('prepareImport (.pdf)', () => prepareImport({ kind: 'file', fileBase64: b64(pdf), filename: 'booking.pdf' }, { tripStart: '2026-09-10', tripEnd: '2026-09-20' }), { reps: 20 });
    under(pdfRun.figure, 500);
    expect(pdfRun.result.ok).toBe(true);
    if (pdfRun.result.ok) {
      expect(pdfRun.result.prepared.sourceKind).toBe('pdf');
      expect(pdfRun.result.prepared.extracted.confirmationRef).toBe('SL88214');
    }
  }, 60_000);
});

describe('the refinement dry-run', () => {
  const patch = tripPatchSchema.parse({
    operations: [{ op: 'restructure', stays: [{ id: 'hofn-area', nights: 0 }, { id: 'vik', nights: 4 }], why: 'One hotel change fewer: Höfn folds into Vík.' }],
  });

  it('applyTripPatch with a restructure, its reach, and both deltas answer in a few milliseconds', () => {
    const applied = measure('applyTripPatch (restructure)', () => applyTripPatch({ draft, patch }));
    under(applied.figure, 50);
    expect(applied.result.ok).toBe(true);
    expect(applied.result.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);

    const reach = measure('patchReach (restructure)', () => patchReach(patch, draft));
    under(reach.figure, 50);
    expect(reach.result.bases).toEqual(['hofn-area', 'vik']);

    const before = shapeOf(draft);
    const after = shapeOf(applied.result.draft);
    const delta = measure('draftDelta', () => draftDelta(before, after));
    under(delta.figure, 10);
    expect(delta.result.lines.find((l) => l.label === 'Hotel changes')?.after).toBe('3');

    /* The live Iceland trip's structural metrics before the fold, and after it: one hotel change fewer, a quarter-hour less travel per day. */
    const metricsBefore: Record<string, number | null> = { hotelChurn: 4, travelBurdenMinutesPerDay: 120, freeMinutesPerDay: 90, unmeasuredMajorTransfers: 3, unverifiedCriticalDependencies: 0 };
    const metricsAfter: Record<string, number | null> = { ...metricsBefore, hotelChurn: 3, travelBurdenMinutesPerDay: 105, unmeasuredMajorTransfers: 2 };
    const metrics = measure('metricsDelta', () => metricsDelta(metricsBefore, metricsAfter, itinerary.days.length));
    under(metrics.figure, 5);
    expect(metrics.result.length).toBeGreaterThan(0);
  });
});

describe('the intelligence load, cold and warm', () => {
  it('the pure build stays inside the Iceland replay’s 250 ms, and the loader’s warm path is a snapshot read', () => {
    const build = measure(
      'buildTravelIntelligence (pure)',
      () =>
        buildTravelIntelligence({
          tripId: trip.id,
          itinerary,
          draft,
          profile: getProfile(trip.id) ?? intelligenceProfile(),
          basics: trip.basics,
          destination: { name: 'Iceland', countryCode: 'IS', timeZone: TIME_ZONE },
          booked: [],
          readinessProfile: null,
          now: NOW,
        }),
      { reps: 20 },
    );
    under(build.figure, 250);

    /* Cold: no snapshot on disk, so the loader reads its inputs, builds and persists. */
    const cold: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      clearTravelIntelligence(trip.id);
      const started = performance.now();
      const loaded = loadTripIntelligence({ trip, itinerary, timeZone: TIME_ZONE, now: NOW });
      cold.push(performance.now() - started);
      expect(loaded.intelligence.tripId).toBe(trip.id);
    }
    const coldFigure = summarise('loadTripIntelligence (cold: cache miss, build + persist)', cold);
    under(coldFigure, 500);
    expect(getTravelIntelligence(trip.id)).not.toBeNull();

    /* Warm: the snapshot's fingerprint matches, so no build runs. */
    const warm = measure('loadTripIntelligence (warm: snapshot hit)', () => loadTripIntelligence({ trip, itinerary, timeZone: TIME_ZONE, now: NOW }), { reps: 30 });
    under(warm.figure, 50);
    expect(warm.result.intelligence.builtAt).toBe(NOW.toISOString());

    /*
     * The SQLite share of the warm path, read by read, in the same state. The
     * snapshot read dominates: one row, JSON.parse and a schema parse of the
     * whole TravelIntelligence.
     */
    const reads: Record<string, () => unknown> = {
      listBookedItems: () => listBookedItems(trip.id),
      listBookingResolutions: () => listBookingResolutions(trip.id),
      getIntent: () => getIntent(trip.id),
      getProfile: () => getProfile(trip.id),
      getReadinessProfile: () => getReadinessProfile(trip.id),
      getDraftHints: () => getDraftHints(trip.id),
      getFxRate: () => getFxRate(trip.id),
      getTravelIntelligence: () => getTravelIntelligence(trip.id),
      listChecks: () => listChecks(trip.id),
    };
    let dbMedianTotal = 0;
    for (const [name, read] of Object.entries(reads)) {
      const figure = measure(`db read: ${name}`, read, { reps: 30 }).figure;
      dbMedianTotal += figure.medianMs;
    }
    process.stdout.write(`PERF ${JSON.stringify({ name: 'loadTripIntelligence (warm) DB share, sum of read medians', dbMs: round(dbMedianTotal), ofWarmMedianMs: warm.figure.medianMs })}\n`);
    expect(dbMedianTotal).toBeLessThan(50);
  }, 60_000);
});

function intelligenceProfile() {
  /* The build's own default when no profile row exists for the perf trip; the harness gave the same to the reconciler. */
  return fictionalWorld({ name: 'Iceland', center: { lat: 64.1466, lng: -21.9426 }, places: [], basics: {}, profile: { willDrive: true } }).context.profile;
}
