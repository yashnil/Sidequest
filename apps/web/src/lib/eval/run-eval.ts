import 'server-only';
import { haversineKm, type Itinerary } from '@sidequest/core';
import { createTripFromComposer } from '../../app/(product)/trips/new/actions';
import { resolveDestinationAction } from '../../app/(product)/trips/[id]/plan/actions';
import { completeQuestionnaireAction, confirmInterpretationAction } from '../../app/(product)/trips/[id]/questionnaire/actions';
import { autoPickAction } from '../../app/(product)/trips/[id]/discover/actions';
import { toComposerAnswers, toQuestionnaireAnswers } from '../benchmark/sidequest/request-adapter';
import { getIntent } from '../db/compiler-repository';
import { getItinerary, getProfile, getTrip } from '../db/repository';
import { beginScan, getScanProposalExtras, scanView } from '../db/scan-repository';
import { runDiscoveryScan } from '../discovery-scan/run';
import { generateSidequestPlanForTrip } from '../planning/production-plan';
import { DYNAMIC_REGION_ID, resolveTripRegion } from '../region';
import { reverseGeocode } from '../providers/nominatim';
import { loadTripIntelligence } from '../intelligence/load';
import type { EvalProfile } from './profiles';

/**
 * THE EVALUATION RUN — ONE PROFILE, END TO END, THROUGH THE PRODUCT'S OWN DOORS.
 *
 * composer action → the planning door's real destination resolver → the
 * questionnaire action → the discovery scan (awaited directly; with no model
 * key it is the open-data proposal) → the board's auto-pick action → the one
 * canonical generation (`generateSidequestPlanForTrip`, planner path, no model).
 *
 * Nothing here repairs, retries or hand-builds anything: a stage that fails is
 * the finding. Stage clocks inside the scan come from marks the test file's
 * module wrappers write onto `globalThis.__evalMarks` (see `eval.live.test.ts`),
 * so the product code is not edited to be measured.
 *
 * Every metric below is computed from what was persisted (the itinerary and its
 * package: preservation, quality audit, quality compiler, feasibility, metrics)
 * plus the scan's compiled region for coordinates. Country checks reverse-geocode
 * each distinct stop through the same rate-gated Nominatim client the product
 * uses; that is evaluation work and is never counted in a trip's latency.
 */

export interface StageMark {
  name: string;
  at: number;
}

export function evalMarks(): StageMark[] {
  const holder = globalThis as unknown as { __evalMarks?: StageMark[] };
  holder.__evalMarks ??= [];
  return holder.__evalMarks;
}

export function evalMark(name: string): void {
  evalMarks().push({ name, at: Date.now() });
}

export interface StageTimes {
  create_ms: number | null;
  resolve_ms: number | null;
  questionnaire_ms: number | null;
  scan_total_ms: number | null;
  scan_propose_ms: number | null;
  scan_place_ms: number | null;
  scan_time_ms: number | null;
  scan_food_ms: number | null;
  scan_assemble_ms: number | null;
  autopick_ms: number | null;
  build_ms: number | null;
  total_ms: number | null;
}

export interface EvalRecord {
  id: string;
  title: string;
  destination: string;
  categories: string[];
  tripId: string | null;
  outcome: 'complete' | 'failed' | 'timeout';
  failedStage: string | null;
  failureDetail: string | null;
  stages: StageTimes;
  resolution: { name: string | null; scale: string | null; type: string | null; countries: string[]; center: { lat: number; lng: number } | null } | null;
  scan: { state: string; failureKind: string | null; proposalSource: string | null; candidates: number; placed: number; bases: number; boardCandidates: number; autoPicks: number; foodVenues: number | null; routing: string | null } | null;
  scanLog?: string[];
  authoredRegion?: boolean;
  openData: { failedGroups: string[]; groups: number; elements: number; usable: number; kept: number; bases: number; boxHalfKm: number } | null;
  metrics: TripMetrics | null;
}

export interface LegCounts {
  measured: number;
  scheduled: number;
  geo_estimate: number;
  model_estimate: number;
  modelled: number;
  unknown: number;
  zeroWithDistance: number;
}

export interface StopRecord {
  day: number;
  title: string;
  placeId: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
  kmFromCentre: number | null;
  country: string | null;
}

export interface TripMetrics {
  itineraryStatus: string;
  feasibility: string | null;
  days: number;
  emptyDays: number;
  stopsPerDay: number[];
  meanStopsPerDay: number;
  travelMinutesPerDay: number[];
  maxTravelMinutes: number;
  meanTravelMinutes: number;
  legs: LegCounts;
  carLegsOnCarFreeTrip: number;
  longestCarLegOnCarFreeTrip: number | null;
  hoursConflicts: number;
  hoursConflictDetails: string[];
  stops: StopRecord[];
  maxKmFromCentre: number | null;
  stopsBeyondReach: number;
  wrongCountryStops: number;
  unknownCountryStops: number;
  duplicateStops: string[];
  distinctCategories: number;
  mealsPerDay: number[];
  daysWithLunch: number;
  daysWithDinner: number;
  namedMeals: number;
  describedMeals: number;
  overpackedDays: number;
  overrunDays: number;
  slotsPerDay: number | null;
  budget: { present: boolean; detail: string | null; perPersonPerDayLow: number | null; perPersonPerDayHigh: number | null; currency: string | null; envelopeFit: string | null; style: string | null };
  planText: string[];
  silentAnchorLoss: number | null;
  anchors: Record<string, number>;
  unscheduled: number;
  qualityAudit: { checks: number; failed: string[] } | null;
  qualityCompiler: { ran: number; notRun: number; failed: string[] } | null;
  issues: Record<string, number>;
  tripQuality: Record<string, string>;
  packageMetrics: Record<string, number | null> | null;
  bases: string[];
}

export interface RunOptions {
  /** Ceiling for the whole trip; a stage still running when it passes is recorded as a timeout. */
  tripTimeoutMs: number;
  /** Reverse-geocode each distinct stop for the country check. */
  countryCheck: boolean;
}

class StageTimeout extends Error {}

function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.reject(new StageTimeout('deadline passed'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StageTimeout(`stage exceeded the trip deadline`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

function emptyStages(): StageTimes {
  return { create_ms: null, resolve_ms: null, questionnaire_ms: null, scan_total_ms: null, scan_propose_ms: null, scan_place_ms: null, scan_time_ms: null, scan_food_ms: null, scan_assemble_ms: null, autopick_ms: null, build_ms: null, total_ms: null };
}

/** The scan's internal stage durations from the marks the module wrappers wrote. */
function scanStageTimes(marks: StageMark[], scanStart: number, scanEnd: number): Pick<StageTimes, 'scan_propose_ms' | 'scan_place_ms' | 'scan_time_ms' | 'scan_food_ms' | 'scan_assemble_ms'> {
  const at = (name: string) => marks.find((m) => m.name === name)?.at ?? null;
  const placing = at('scan:placing');
  const timing = at('scan:timing');
  const foodStart = at('food:start');
  const foodEnd = at('food:end');
  const assembling = at('scan:assembling');
  const complete = at('scan:complete') ?? scanEnd;
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? Math.max(0, b - a) : null);
  return {
    scan_propose_ms: diff(scanStart, placing),
    scan_place_ms: diff(placing, timing),
    scan_time_ms: diff(timing, foodStart ?? assembling),
    scan_food_ms: diff(foodStart, foodEnd),
    scan_assemble_ms: diff(assembling, complete),
  };
}

export async function runProfile(profile: EvalProfile, options: RunOptions): Promise<EvalRecord> {
  const started = Date.now();
  const deadline = started + options.tripTimeoutMs;
  const stages = emptyStages();
  const record: EvalRecord = {
    id: profile.id,
    title: profile.title,
    destination: profile.request.destination.text,
    categories: profile.categories,
    tripId: null,
    outcome: 'failed',
    failedStage: null,
    failureDetail: null,
    stages,
    resolution: null,
    scan: null,
    openData: null,
    metrics: null,
  };
  let stage = 'create';
  const fail = (detail: string) => {
    record.failedStage = stage;
    record.failureDetail = detail;
    stages.total_ms = Date.now() - started;
    return record;
  };
  const timed = async <T>(key: keyof StageTimes, work: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await within(work(), deadline);
    } finally {
      stages[key] = Date.now() - t0;
    }
  };

  try {
    // --- create -----------------------------------------------------------------
    const created = await timed('create_ms', () => createTripFromComposer(toComposerAnswers(profile.request)));
    if (!created.ok) return fail(`composer refused: ${created.error ?? JSON.stringify(created.fieldErrors)}`);
    const tripId = /^\/trips\/([^/]+)\//.exec(created.href)?.[1] ?? null;
    if (!tripId) return fail(`no trip id in ${created.href}`);
    record.tripId = tripId;
    const proposed = (getIntent(tripId)?.composer?.interpretation?.chips ?? []).filter((c) => c.status === 'proposed').map((c) => c.id);
    if (proposed.length > 0) await confirmInterpretationAction(tripId, [...proposed]);

    // --- resolve (the planning door's resolver: intent graph + semantic gate + Nominatim) ---
    stage = 'resolve';
    /* A destination the product ships as an authored region skips resolution and the scan, exactly as the composer's redirect does. */
    const authored = getTrip(tripId)!.basics.regionId !== DYNAMIC_REGION_ID;
    record.authoredRegion = authored;
    const resolved = authored ? { ok: true as const } : await timed('resolve_ms', () => resolveDestinationAction(tripId));
    const intent = getIntent(tripId);
    const semantics = (intent as unknown as { destinationIntent?: { semantics?: { label?: string; scale?: string; type?: string; countries?: string[]; center?: { lat: number; lng: number } } } } | null)?.destinationIntent?.semantics;
    record.resolution = {
      name: semantics?.label ?? null,
      scale: semantics?.scale ?? null,
      type: semantics?.type ?? null,
      countries: semantics?.countries ?? [],
      center: semantics?.center ?? null,
    };
    if (!resolved.ok) return fail(`resolver: ${'error' in resolved ? resolved.error : 'refused'}`);

    // --- questionnaire ------------------------------------------------------------
    stage = 'questionnaire';
    const { answers } = toQuestionnaireAnswers(profile.request);
    await timed('questionnaire_ms', async () => {
      try {
        const result = await completeQuestionnaireAction(tripId, answers, 'board');
        if (result && result.ok === false) throw new Error(`questionnaire refused: ${result.error}`);
      } catch (error) {
        if (!isRedirect(error)) throw error;
      }
    });
    if (!getProfile(tripId)) return fail('no profile saved');

    // --- scan --------------------------------------------------------------------
    stage = 'scan';
    if (!authored) {
    evalMarks().length = 0;
    const scanStart = Date.now();
    const { scanId } = beginScan(tripId, new Date(), { autoBuild: false });
    /* The scan reports its own failure detail only to the console; keep the lines that explain an outcome. */
    const scanLog: string[] = [];
    const original = { error: console.error, warn: console.warn };
    const keep = (level: 'error' | 'warn') => (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
      if (/Discovery scan|Scan food|Scan matrix|open data/i.test(line)) scanLog.push(line.slice(0, 600));
      original[level](...args);
    };
    console.error = keep('error');
    console.warn = keep('warn');
    try {
      await timed('scan_total_ms', () => runDiscoveryScan(tripId, scanId, { caller: 'eval' }));
    } finally {
      console.error = original.error;
      console.warn = original.warn;
      record.scanLog = scanLog;
    }
    Object.assign(stages, scanStageTimes(evalMarks(), scanStart, Date.now()));
    const view = scanView(tripId);
    const extras = getScanProposalExtras(tripId);
    record.scan = {
      state: view.state,
      failureKind: view.failureKind,
      proposalSource: extras?.diagnostics?.proposalSource ?? null,
      candidates: view.counters.proposed ?? 0,
      placed: view.counters.placed ?? 0,
      bases: 0,
      boardCandidates: 0,
      autoPicks: 0,
      foodVenues: null,
      routing: null,
    };
    record.openData = (extras?.diagnostics as { openData?: EvalRecord['openData'] } | undefined)?.openData ?? null;
    if (view.state !== 'ready') return fail(`scan ${view.state}: ${view.failureKind ?? 'unknown'}`);
    }
    record.scan ??= { state: 'authored_region', failureKind: null, proposalSource: 'authored', candidates: 0, placed: 0, bases: 0, boardCandidates: 0, autoPicks: 0, foodVenues: null, routing: null };
    const region = await resolveTripRegion(getTrip(tripId)!);
    if (region.ok) {
      record.scan.bases = region.context.compiled.basePortfolio?.bases.length ?? 1;
      record.scan.foodVenues = region.context.compiled.food?.venues.length ?? null;
      record.scan.routing = region.context.compiled.sourceManifest.providers.map((p) => p.name).join(', ');
    }

    // --- auto-pick ------------------------------------------------------------------
    stage = 'autopick';
    const picked = await timed('autopick_ms', () => autoPickAction(tripId));
    if (!picked.ok) return fail(`auto-pick: ${picked.error}`);
    record.scan.autoPicks = picked.autoPicks?.length ?? 0;
    record.scan.boardCandidates = region.ok ? region.context.places.length : 0;

    // --- build ------------------------------------------------------------------------
    stage = 'build';
    const built = await timed('build_ms', () => generateSidequestPlanForTrip(tripId, { caller: 'eval', mode: 'full' }));
    stages.total_ms = Date.now() - started;
    if (!built.ok) return fail(`build: ${'error' in built ? built.error : 'not ok'}`);
    const itinerary = getItinerary(tripId);
    if (!itinerary) return fail('build ok but no itinerary persisted');
    record.outcome = 'complete';
    stage = 'metrics';
    record.metrics = await metricsFor(tripId, itinerary, profile, record.resolution?.center ?? null, options);
    return record;
  } catch (error) {
    if (error instanceof StageTimeout) {
      record.outcome = 'timeout';
      return fail(`timed out after ${Math.round((Date.now() - started) / 1000)}s`);
    }
    return fail(error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 5).join('\n')}` : String(error));
  }
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

const countryCache = new Map<string, string | null>();

async function countryAt(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (countryCache.has(key)) return countryCache.get(key)!;
  try {
    const { place } = await reverseGeocode(lat, lng, { zoom: 5 });
    const code = (place as { address?: { country_code?: string } } | null)?.address?.country_code?.toUpperCase() ?? null;
    countryCache.set(key, code);
    return code;
  } catch {
    return null;
  }
}

function legState(travel: NonNullable<Itinerary['days'][number]['items'][number]['travel']>): keyof Omit<LegCounts, 'zeroWithDistance'> {
  if (travel.provenance === 'unmeasured' || travel.minutes === null) return 'unknown';
  if (travel.provenance === 'measured') return 'measured';
  if (travel.provenance === 'official' || travel.basis === 'scheduled') return 'scheduled';
  if (travel.provenance === 'modelled') return 'modelled';
  return travel.estimateKind === 'model' ? 'model_estimate' : 'geo_estimate';
}

const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function metricsFor(tripId: string, itinerary: Itinerary, profile: EvalProfile, centre: { lat: number; lng: number } | null, options: RunOptions): Promise<TripMetrics> {
  const trip = getTrip(tripId)!;
  const travelerProfile = getProfile(tripId);
  const region = await resolveTripRegion(trip);
  const places = new Map(region.ok ? region.context.places.map((p) => [p.id, p] as const) : []);
  const regionCentre = centre ?? (region.ok ? (region.context.compiled as unknown as { center?: { lat: number; lng: number } }).center ?? null : null);
  const reachKm = (getScanProposalExtras(tripId)?.diagnostics as { envelope?: { reachKm?: number } } | undefined)?.envelope?.reachKm ?? null;
  const carFree = !profile.request.movement.carAvailable;

  const legs: LegCounts = { measured: 0, scheduled: 0, geo_estimate: 0, model_estimate: 0, modelled: 0, unknown: 0, zeroWithDistance: 0 };
  let carLegsOnCarFreeTrip = 0;
  let longestCarLeg: number | null = null;
  const stops: StopRecord[] = [];
  const hoursConflictDetails: string[] = [];
  const stopsPerDay: number[] = [];
  const mealsPerDay: number[] = [];
  let daysWithLunch = 0;
  let daysWithDinner = 0;
  let namedMeals = 0;
  let describedMeals = 0;
  let overrunDays = 0;
  const slots = travelerProfile?.derived.activitySlotsPerDay ?? null;
  let overpackedDays = 0;

  for (const day of itinerary.days) {
    const activities = day.items.filter((i) => i.kind === 'activity');
    stopsPerDay.push(activities.length);
    if (slots !== null && activities.length > slots + 1) overpackedDays += 1;
    const lastEnd = Math.max(0, ...day.items.map((i) => i.endMinute));
    if (lastEnd > day.window.endMinute + 30) overrunDays += 1;
    const meals = day.items.filter((i) => i.kind === 'meal');
    mealsPerDay.push(meals.length);
    if (meals.some((m) => m.startMinute >= 11 * 60 && m.startMinute <= 15 * 60)) daysWithLunch += 1;
    if (meals.some((m) => m.startMinute >= 17 * 60)) daysWithDinner += 1;
    for (const m of meals) {
      if (m.food && (m.food as { venueId?: string }).venueId) namedMeals += 1;
      else describedMeals += 1;
    }
    for (const item of day.items) {
      if (item.travel) {
        const state = legState(item.travel);
        legs[state] += 1;
        if (item.travel.minutes === 0 && (item.travel.km ?? item.travel.estimate?.straightLineKm ?? 0) > 0.5) legs.zeroWithDistance += 1;
        if (carFree && item.travel.mode === 'drive' && (item.travel.minutes ?? 0) > 0) {
          carLegsOnCarFreeTrip += 1;
          longestCarLeg = Math.max(longestCarLeg ?? 0, item.travel.minutes ?? 0);
        }
      }
      const op = item.operational?.outcome;
      if (op && ['closed_on_date', 'closed_permanently', 'closed_temporarily_now', 'opens_later', 'closes_earlier'].includes(op)) hoursConflictDetails.push(`day ${day.dayNumber} ${item.title}: ${op}`);
      if (item.kind === 'activity') {
        const place = item.placeId ? places.get(item.placeId) : undefined;
        const coords = (place as unknown as { coordinates?: { lat: number; lng: number } } | undefined)?.coordinates ?? null;
        stops.push({
          day: day.dayNumber,
          title: item.title,
          placeId: item.placeId ?? null,
          category: (place as unknown as { category?: string } | undefined)?.category ?? null,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
          kmFromCentre: coords && regionCentre ? Math.round(haversineKm(regionCentre, coords)) : null,
          country: null,
        });
      }
    }
  }
  for (const issue of itinerary.issues) {
    if (/hour|closed|opening/i.test(issue.code)) hoursConflictDetails.push(`${issue.code}: ${issue.message.slice(0, 120)}`);
  }

  if (options.countryCheck) {
    for (const stop of stops) if (stop.lat !== null && stop.lng !== null) stop.country = await countryAt(stop.lat, stop.lng);
  }
  const expected = new Set(profile.expectedCountries);
  const wrongCountryStops = stops.filter((s) => s.country !== null && !expected.has(s.country)).length;
  const unknownCountryStops = stops.filter((s) => s.country === null).length;

  const byKey = new Map<string, number[]>();
  for (const s of stops) {
    const key = s.placeId ?? norm(s.title);
    byKey.set(key, [...(byKey.get(key) ?? []), s.day]);
  }
  const duplicateStops = [...byKey.entries()].filter(([, days]) => days.length > 1).map(([key, days]) => `${stops.find((s) => (s.placeId ?? norm(s.title)) === key)!.title} (days ${days.join(',')})`);

  const pkg = itinerary.package as unknown as Record<string, unknown> | undefined;
  const anchors: Record<string, number> = {};
  for (const a of (pkg?.anchors as { disposition: string }[] | undefined) ?? []) anchors[a.disposition] = (anchors[a.disposition] ?? 0) + 1;
  const preservation = pkg?.preservation as { silentLoss?: number; silent_loss?: number; counts?: Record<string, number> } | undefined;
  const silentAnchorLoss = preservation ? (preservation.silentLoss ?? preservation.silent_loss ?? preservation.counts?.silentLoss ?? null) : null;
  const feasibility = (pkg?.feasibility as { verdict?: string; status?: string } | undefined) ?? null;
  const quality = pkg?.quality as { checks?: { id: string; ok: boolean; severity: string }[] } | undefined;
  const qualityAudit = quality?.checks ? { checks: quality.checks.length, failed: quality.checks.filter((c) => !c.ok).map((c) => `${c.id}(${c.severity})`) } : null;
  const qc = pkg?.qualityCompiler as { clean?: string[]; issues?: { check: string; corrected?: boolean }[]; skipped?: { check: string }[] } | undefined;
  const qualityCompiler = qc
    ? { ran: (qc.clean?.length ?? 0) + new Set((qc.issues ?? []).map((i) => i.check)).size, notRun: qc.skipped?.length ?? 0, failed: [...new Set((qc.issues ?? []).map((i) => `${i.check}${i.corrected ? '(corrected)' : ''}`))] }
    : null;
  const tripQuality: Record<string, string> = {};
  for (const f of ((pkg?.tripQuality as { findings?: { dimension: string; verdict: string }[] } | undefined)?.findings ?? [])) tripQuality[f.dimension] = f.verdict;
  const issues: Record<string, number> = {};
  for (const issue of itinerary.issues) issues[issue.code] = (issues[issue.code] ?? 0) + 1;
  let budget: TripMetrics['budget'] = { present: false, detail: null, perPersonPerDayLow: null, perPersonPerDayHigh: null, currency: null, envelopeFit: null, style: travelerProfile?.budgetStyle ?? null };
  try {
    const b = loadTripIntelligence({ trip, itinerary, persist: false }).intelligence.budget as { currency: string; total: { low: number; high: number; perPerson: boolean }; travellers: number; envelope?: { fit: string }; referenceCurrency?: string } | undefined;
    if (b) {
      const div = (b.total.perPerson ? 1 : Math.max(1, b.travellers)) * Math.max(1, itinerary.days.length);
      budget = { ...budget, present: true, detail: null, perPersonPerDayLow: Math.round(b.total.low / div), perPersonPerDayHigh: Math.round(b.total.high / div), currency: b.currency, envelopeFit: b.envelope?.fit ?? null };
    }
  } catch (error) {
    budget = { ...budget, detail: `intelligence failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}` };
  }
  const planText = itinerary.days.map((d) => `D${d.dayNumber} ${d.date} @${d.baseName} [${d.window.startMinute}-${d.window.endMinute}]: ` + d.items.map((i) => {
    const clock = `${Math.floor(i.startMinute / 60)}:${String(i.startMinute % 60).padStart(2, '0')}`;
    if (i.kind === 'travel' && i.travel) return `${clock} ~${i.travel.mode} ${i.travel.minutes ?? '?'}m/${i.travel.km ?? i.travel.estimate?.approxKm ?? '?'}km(${legState(i.travel)})`;
    return `${clock} ${i.kind === 'activity' ? '' : `[${i.kind}] `}${i.title} ${i.durationMinutes}m`;
  }).join(' | '));
  const travel = itinerary.days.map((d) => d.totals.travelMinutes);
  const kms = stops.map((s) => s.kmFromCentre).filter((k): k is number => k !== null);

  return {
    itineraryStatus: itinerary.status,
    feasibility: feasibility?.verdict ?? feasibility?.status ?? null,
    days: itinerary.days.length,
    emptyDays: stopsPerDay.filter((n) => n === 0).length,
    stopsPerDay,
    meanStopsPerDay: round1(stopsPerDay.reduce((a, b) => a + b, 0) / Math.max(1, stopsPerDay.length)),
    travelMinutesPerDay: travel,
    maxTravelMinutes: Math.max(0, ...travel),
    meanTravelMinutes: Math.round(travel.reduce((a, b) => a + b, 0) / Math.max(1, travel.length)),
    legs,
    carLegsOnCarFreeTrip,
    longestCarLegOnCarFreeTrip: longestCarLeg,
    hoursConflicts: hoursConflictDetails.length,
    hoursConflictDetails,
    stops,
    maxKmFromCentre: kms.length > 0 ? Math.max(...kms) : null,
    stopsBeyondReach: reachKm !== null ? kms.filter((k) => k > reachKm).length : 0,
    wrongCountryStops,
    unknownCountryStops,
    duplicateStops,
    distinctCategories: new Set(stops.map((s) => s.category).filter(Boolean)).size,
    mealsPerDay,
    daysWithLunch,
    daysWithDinner,
    namedMeals,
    describedMeals,
    overpackedDays,
    overrunDays,
    slotsPerDay: slots,
    budget,
    planText,
    silentAnchorLoss,
    anchors,
    unscheduled: itinerary.unscheduled.length,
    qualityAudit,
    qualityCompiler,
    issues,
    tripQuality,
    packageMetrics: (pkg?.metrics as Record<string, number | null> | undefined) ?? null,
    bases: (itinerary.package?.bases ?? []).map((b) => `${b.name} (${b.nights}n)`),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
