import type { IntentNodeKind } from '../destinations/intent-graph';
import type { ModeConcept, ModeStatus } from '../reality/schema';
import { jurisdictionFor } from '../reality/jurisdictions';
import { estimateLegMinutes, haversineKm, MAX_GEO_ESTIMATE_DRIVE_KM } from '../travel/estimate';
import type { StopNightsBasis } from './parse';

/**
 * "IS THAT TOO MUCH?" — A DETERMINISTIC CRITIQUE OF A ROUGH PLAN.
 *
 * Master prompt §7, Mode 3. Before any trip exists, before any board or
 * scan: the places the traveller named, placed on the map by the resolver,
 * checked for three things anyone would ask a friend who travels a lot —
 *
 * 1. **Pace.** Nights per stop against a sensible minimum for the kind of
 *    place, hotel moves against the trip's length, and how much of the trip
 *    moving between beds costs.
 * 2. **Route order.** The given order against the shortest ordering of the
 *    same stops with the first and last held where they are (they are usually
 *    the flights). Backtracking is named with the distance it costs.
 * 3. **Transport realism.** Each move estimated in the mode the country's own
 *    facts make the backbone (`reality/jurisdictions.ts`), with
 *    `travel/estimate.ts`'s estimator — and a jump too far for a day overland
 *    is a flight, never a heroic drive.
 *
 * Every sentence is built from a number computed here, and every travel figure
 * is an estimate that says it is one: nothing on this path is measured, and
 * nothing claims to be. A stop the resolver could not place is "not checked",
 * never wrong (unknown ≠ false). No place is known by name; the only inputs are
 * coordinates, the intent graph's kind, nights and ISO country codes.
 */

export interface PlanCheckStopInput {
  /** The traveller's words. */
  label: string;
  /** What the resolver found, for display; the label stays theirs. */
  placedName?: string | null;
  point: { lat: number; lng: number } | null;
  countryCode: string | null;
  kind: IntentNodeKind;
  nights: number | null;
  nightsBasis: StopNightsBasis | null;
  dayTrip: boolean;
}

export type PlanMoveMode = 'high_speed_rail' | 'rail' | 'drive' | 'bus' | 'flight';

export const PLAN_MOVE_MODE_LABELS: Record<PlanMoveMode, string> = {
  high_speed_rail: 'high-speed rail',
  rail: 'train',
  drive: 'road',
  bus: 'bus',
  flight: 'flight',
};

export interface PlanMove {
  fromIndex: number;
  toIndex: number;
  from: string;
  to: string;
  /** Great-circle kilometres between the two placed points; null when either end is unplaced. */
  straightKm: number | null;
  mode: PlanMoveMode | null;
  /** Estimated minutes door to door for `mode`; null when there is no honest figure. Always an estimate. */
  minutes: number | null;
  /** Why this mode: the country fact, or the distance. */
  modeReason: string;
  /** A flight is the practical choice even though a ground estimate exists. */
  flightSuggested: boolean;
  /** Door-to-door estimate by air (air time plus airport allowance), when a flight is relevant. */
  flightMinutes: number | null;
  /** One end is an island: the estimate assumes an overland link nobody has checked. */
  mayNeedWater: boolean;
  /** A day trip, not a hotel move. */
  dayTrip: boolean;
}

export type PlanFindingTopic = 'pace' | 'route' | 'transport' | 'placement' | 'length';

export interface PlanFinding {
  id: string;
  topic: PlanFindingTopic;
  /** `major`: the plan strains as written; `minor`: it works but costs something; `note`: worth knowing. */
  severity: 'major' | 'minor' | 'note';
  sentence: string;
}

export type PlanSuggestionKind = 'merge' | 'cut' | 'reorder' | 'add_nights' | 'side_trip' | 'fly';

export interface PlanSuggestion {
  id: string;
  kind: PlanSuggestionKind;
  sentence: string;
}

export interface ImprovedPlanStop {
  label: string;
  nights: number;
  dayTrip: boolean;
}

export interface PlanCheckResult {
  verdict: 'comfortable' | 'full' | 'too_much' | 'unknown';
  headline: string;
  metrics: {
    stops: number;
    bases: number;
    hotelMoves: number;
    totalNights: number | null;
    totalDays: number | null;
    nightsPerBase: number | null;
    /** Estimated minutes of travel across every hotel move whose ends were placed. */
    moveMinutesEstimated: number;
    /** Days' worth of the trip spent changing beds (travel plus checking out and in), estimated. */
    moveDaysEstimated: number;
    shareOfDaysMoving: number | null;
    /** Straight-line kilometres of the route as given, and at its best order. */
    routeKm: number | null;
    bestRouteKm: number | null;
    unplaced: string[];
  };
  moves: PlanMove[];
  findings: PlanFinding[];
  suggestions: PlanSuggestion[];
  /** The plan with the suggestions applied, or null when there is nothing to change. */
  improved: { stops: ImprovedPlanStop[]; changes: string[] } | null;
}

/* ------------------------------------------------------------------------- */
/* Constants — each one the threshold a sentence names                        */
/* ------------------------------------------------------------------------- */

/** Nights a stop needs before it stops being mostly arriving and leaving: a town or city, then a region. */
const MIN_NIGHTS_PLACE = 2;
const MIN_NIGHTS_REGION = 3;
const REGION_KINDS: ReadonlySet<IntentNodeKind> = new Set(['admin_region', 'natural_region', 'island', 'island_chain', 'mountain_range', 'coast', 'country', 'vague_region', 'corridor', 'park']);
const ISLAND_KINDS: ReadonlySet<IntentNodeKind> = new Set(['island', 'island_chain']);
/** Checking out, getting to the station or car, finding the new place, checking in. */
export const MOVE_OVERHEAD_MINUTES = 90;
/** The waking hours a travel day is measured against. */
const DAY_MINUTES = 600;
/** Beyond this straight line, a flight is usually the practical choice even where a ground route exists. */
export const FLIGHT_SUGGESTED_KM = 600;
/** Beyond this, flying is offered as an alternative where the country's facts call flights normal. */
const FLIGHT_OFFERED_KM = 450;
/** High-speed rail is the backbone only for real distances; a 40 km hop is a regional train or a road. */
const HSR_MIN_KM = 100;
/** Each way, the longest a day trip from a neighbouring bed reasonably takes. */
export const DAY_TRIP_MAX_MINUTES = 120;
/** The improved version drops at most this many stops; beyond it the traveller decides. */
export const MAX_IMPROVEMENT_CUTS = 1;
/** A reorder is worth saying only when it saves this share and this many straight-line km. */
const REORDER_MIN_SHARE = 0.15;
const REORDER_MIN_KM = 80;
/** Airport time on a domestic or short-haul flight: getting there, security, boarding, bags. */
const AIRPORT_ALLOWANCE_MINUTES = 150;

const round5 = (m: number) => Math.max(5, Math.round(m / 5) * 5);

export function formatPlanMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** "2", "2.5": a ratio of nights without a spurious ".0". */
const ratio = (n: number) => (Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n)) : n.toFixed(1));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (names: readonly string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/* ------------------------------------------------------------------------- */
/* How a move is made, from the country's facts                              */
/* ------------------------------------------------------------------------- */

const STATUS_RANK: Record<ModeStatus, number> = { recommended: 0, viable: 1, friction: 2, discouraged: 3, unknown: 4, unavailable: 5 };

function modeStatus(countries: readonly string[], mode: ModeConcept): ModeStatus | null {
  const rows = countries.map((c) => jurisdictionFor(c)).filter((j): j is NonNullable<typeof j> => j !== null);
  if (rows.length === 0) return null;
  /* Across a border the mode has to work on both sides: the worse of the two statuses. */
  let worst: ModeStatus | null = null;
  for (const row of rows) {
    const rule = row.modes.find((m) => m.mode === mode);
    const status = rule?.status ?? 'unknown';
    if (worst === null || STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

const good = (status: ModeStatus | null, at: 'recommended' | 'viable') => status !== null && STATUS_RANK[status] <= STATUS_RANK[at];

/**
 * Sidequest's high-speed-rail estimate: a straight-line distance at a
 * banded line speed, a gentler detour than roads (lines are straighter), and
 * the time it takes to reach and leave two stations. An estimate; never a
 * timetable.
 */
export function estimateHighSpeedRailMinutes(km: number): number {
  const speed = km <= 150 ? 110 : km <= 400 ? 160 : 200;
  return round5(((km * 1.2) / speed) * 60 + 40);
}

/** Door-to-door by air: time aloft at a short-haul cruise average plus the airport allowance. */
export function estimateFlightMinutes(km: number): number {
  return round5(((km * 1.05) / 700) * 60 + 30 + AIRPORT_ALLOWANCE_MINUTES);
}

interface ModeChoice {
  mode: PlanMoveMode | null;
  minutes: number | null;
  reason: string;
}

function groundChoice(countries: readonly string[], km: number): ModeChoice {
  const hsr = modeStatus(countries, 'high_speed_rail');
  const train = modeStatus(countries, 'intercity_train');
  const drive = [modeStatus(countries, 'self_drive'), modeStatus(countries, 'rental_car')].sort((a, b) => STATUS_RANK[a ?? 'unknown'] - STATUS_RANK[b ?? 'unknown'])[0] ?? null;
  const bus = modeStatus(countries, 'bus');
  const any = [hsr, train, drive, bus].some((s) => s !== null);
  const pick = (mode: PlanMoveMode, reason: string): ModeChoice => ({ mode, minutes: null, reason });
  if (!any) return pick('drive', 'No transport facts for this country are bundled, so this is a road estimate.');
  if (km >= HSR_MIN_KM && good(hsr, 'viable')) return pick('high_speed_rail', 'High-speed rail is the backbone between regions here.');
  if (good(train, 'recommended')) return pick('rail', 'Trains are the recommended way between places here.');
  if (good(drive, 'recommended')) return pick('drive', 'Driving is the recommended way between places here.');
  if (good(train, 'viable')) return pick('rail', 'Trains link places here.');
  if (good(drive, 'viable')) return pick('drive', 'Driving is a workable way between places here.');
  if (good(bus, 'viable')) return pick('bus', 'Buses are the workable link between places here.');
  return pick('drive', 'No mode is marked as workable between places here, so this is a road estimate.');
}

/** The estimate and mode for one move between two placed points. */
export function estimateMove(a: { point: { lat: number; lng: number }; countryCode: string | null }, b: { point: { lat: number; lng: number }; countryCode: string | null }): ModeChoice & { straightKm: number; flightSuggested: boolean; flightMinutes: number | null } {
  const km = haversineKm(a.point, b.point);
  const countries = [...new Set([a.countryCode, b.countryCode].filter((c): c is string => Boolean(c)))];
  const flightStatus = modeStatus(countries, 'flight');
  if (km > MAX_GEO_ESTIMATE_DRIVE_KM) {
    const minutes = estimateFlightMinutes(km);
    return { mode: 'flight', minutes, reason: `${Math.round(km)} km in a straight line is beyond what Sidequest estimates overland, so this is treated as a flight.`, straightKm: km, flightSuggested: true, flightMinutes: minutes };
  }
  const choice = groundChoice(countries, km);
  const minutes =
    choice.mode === 'high_speed_rail'
      ? estimateHighSpeedRailMinutes(km)
      : choice.mode === 'rail'
        ? estimateLegMinutes({ from: a.point, to: b.point, mode: 'rail' })?.minutes ?? null
        : choice.mode === 'bus'
          ? estimateLegMinutes({ from: a.point, to: b.point, mode: 'public_bus' })?.minutes ?? null
          : estimateLegMinutes({ from: a.point, to: b.point, mode: 'drive' })?.minutes ?? null;
  const flightSuggested = km > FLIGHT_SUGGESTED_KM || (km > FLIGHT_OFFERED_KM && good(flightStatus, 'viable'));
  return { ...choice, minutes, straightKm: km, flightSuggested, flightMinutes: flightSuggested ? estimateFlightMinutes(km) : null };
}

/* ------------------------------------------------------------------------- */
/* Route order                                                                */
/* ------------------------------------------------------------------------- */

function pathKm(points: readonly { lat: number; lng: number }[], order: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < order.length; i += 1) total += haversineKm(points[order[i - 1]!]!, points[order[i]!]!);
  return total;
}

function permutations(items: number[]): number[][] {
  if (items.length <= 1) return [items];
  const out: number[][] = [];
  for (const [i, item] of items.entries()) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  }
  return out;
}

/** The shortest straight-line order of the same points with the first and last held in place. Exhaustive up to nine stops. */
export function bestFixedEndsOrder(points: readonly { lat: number; lng: number }[]): number[] {
  const n = points.length;
  const identity = points.map((_, i) => i);
  if (n <= 3 || n > 9) return identity;
  let best = identity;
  let bestKm = pathKm(points, identity);
  for (const middle of permutations(identity.slice(1, -1))) {
    const order = [0, ...middle, n - 1];
    const km = pathKm(points, order);
    if (km < bestKm - 1e-6) {
      best = order;
      bestKm = km;
    }
  }
  return best;
}

/* ------------------------------------------------------------------------- */
/* The critique                                                               */
/* ------------------------------------------------------------------------- */

const minNightsFor = (kind: IntentNodeKind) => (REGION_KINDS.has(kind) ? MIN_NIGHTS_REGION : MIN_NIGHTS_PLACE);

interface Base {
  index: number;
  stop: PlanCheckStopInput;
}

function movesFor(stops: readonly PlanCheckStopInput[]): PlanMove[] {
  const moves: PlanMove[] = [];
  let lastBed: number | null = null;
  for (const [index, stop] of stops.entries()) {
    if (lastBed === null) {
      if (!stop.dayTrip) lastBed = index;
      continue;
    }
    const from = stops[lastBed]!;
    const base: Omit<PlanMove, 'straightKm' | 'mode' | 'minutes' | 'modeReason' | 'flightSuggested' | 'flightMinutes'> = {
      fromIndex: lastBed,
      toIndex: index,
      from: from.label,
      to: stop.label,
      mayNeedWater: ISLAND_KINDS.has(from.kind) || ISLAND_KINDS.has(stop.kind),
      dayTrip: stop.dayTrip,
    };
    if (from.point && stop.point) {
      const est = estimateMove({ point: from.point, countryCode: from.countryCode }, { point: stop.point, countryCode: stop.countryCode });
      moves.push({ ...base, straightKm: est.straightKm, mode: est.mode, minutes: est.minutes, modeReason: est.reason, flightSuggested: est.flightSuggested, flightMinutes: est.flightMinutes });
    } else {
      moves.push({ ...base, straightKm: null, mode: null, minutes: null, modeReason: 'One end could not be placed, so this move is not estimated.', flightSuggested: false, flightMinutes: null });
    }
    if (!stop.dayTrip) lastBed = index;
  }
  return moves;
}

/** What a hotel move costs, in minutes: the practical option's travel plus the overhead of changing beds. */
function moveCost(move: PlanMove): number | null {
  if (move.dayTrip) return null;
  const travel = move.flightSuggested && move.flightMinutes !== null ? (move.minutes !== null ? Math.min(move.minutes, move.flightMinutes) : move.flightMinutes) : move.minutes;
  return travel === null ? null : travel + MOVE_OVERHEAD_MINUTES;
}

interface PaceReading {
  verdict: PlanCheckResult['verdict'];
  bases: Base[];
  hotelMoves: number;
  nightsPerBase: number | null;
  moveMinutes: number;
  moveDays: number;
  share: number | null;
  shortStops: Base[];
}

function readPace(stops: readonly PlanCheckStopInput[], totalNights: number | null): PaceReading {
  const bases = stops.map((stop, index) => ({ index, stop })).filter((b) => !b.stop.dayTrip);
  let hotelMoves = 0;
  for (let i = 1; i < bases.length; i += 1) if (bases[i]!.stop.label.toLowerCase() !== bases[i - 1]!.stop.label.toLowerCase()) hotelMoves += 1;
  const moves = movesFor(stops);
  let moveMinutes = 0;
  let moveDays = 0;
  for (const move of moves) {
    const cost = moveCost(move);
    if (cost === null) continue;
    moveMinutes += cost - MOVE_OVERHEAD_MINUTES;
    moveDays += Math.min(1, cost / DAY_MINUTES);
  }
  const totalDays = totalNights !== null ? totalNights + 1 : null;
  const share = totalDays ? moveDays / totalDays : null;
  const nightsPerBase = totalNights !== null && bases.length > 0 ? totalNights / bases.length : null;
  /* The last stop's nights are often the night before a flight home; a short last stop is still a short stop. */
  const shortStops = bases.filter((b) => b.stop.nights !== null && b.stop.nights < minNightsFor(b.stop.kind));
  let verdict: PlanCheckResult['verdict'] = 'unknown';
  if (totalNights !== null && bases.length > 0) {
    const oneNighters = shortStops.filter((b) => b.stop.nights !== null && b.stop.nights <= 1).length;
    const tooMuch = (nightsPerBase !== null && nightsPerBase < 2) || (share !== null && share > 0.3) || oneNighters >= 2;
    const full = (nightsPerBase !== null && nightsPerBase < 3) || (share !== null && share > 0.18) || shortStops.length > 0;
    verdict = tooMuch ? 'too_much' : full ? 'full' : 'comfortable';
  }
  return { verdict, bases, hotelMoves, nightsPerBase, moveMinutes, moveDays, share, shortStops };
}

function nightsWord(stop: PlanCheckStopInput): string {
  const n = stop.nights ?? 0;
  return stop.nightsBasis === 'spread' ? `${plural(n, 'night')} (an even split — you didn’t say)` : plural(n, 'night');
}

function moveSentence(move: PlanMove): string {
  if (move.minutes === null && move.mode !== 'flight') return `${move.from} → ${move.to}: not estimated (${move.modeReason.toLowerCase()})`;
  const km = move.straightKm !== null ? `${Math.round(move.straightKm)} km in a straight line` : '';
  if (move.mode === 'flight') return `${move.from} → ${move.to}: ${km}, so this is a flight — about ${formatPlanMinutes(move.minutes ?? 0)} door to door (estimate).`;
  const by = PLAN_MOVE_MODE_LABELS[move.mode!];
  return `${move.from} → ${move.to}: about ${formatPlanMinutes(move.minutes!)} by ${by} (estimate, ${km}).`;
}

export interface PlanCheckInput {
  stops: PlanCheckStopInput[];
  totalNights: number | null;
}

export function critiquePlan(input: PlanCheckInput): PlanCheckResult {
  const { stops, totalNights } = input;
  const findings: PlanFinding[] = [];
  const suggestions: PlanSuggestion[] = [];
  const moves = movesFor(stops);
  const pace = readPace(stops, totalNights);
  const totalDays = totalNights !== null ? totalNights + 1 : null;
  const unplaced = stops.filter((s) => !s.point).map((s) => s.label);

  /* ---- placement ---- */
  if (unplaced.length > 0) {
    findings.push({ id: 'unplaced', topic: 'placement', severity: 'note', sentence: `Not checked: we couldn’t place ${list(unplaced.map((n) => `“${n}”`))} on the map, so nothing here says ${unplaced.length === 1 ? 'it is' : 'they are'} wrong — only that ${unplaced.length === 1 ? 'its' : 'their'} travel isn’t estimated.` });
  }

  /* ---- length and pace ---- */
  if (totalNights === null) {
    findings.push({ id: 'no-length', topic: 'length', severity: 'note', sentence: 'We can’t judge the pace without a length — add “in 10 days”, dates, or nights per place.' });
  } else if (pace.bases.length > 0) {
    const perBase = pace.nightsPerBase!;
    findings.push({
      id: 'moves',
      topic: 'pace',
      severity: perBase < 2 ? 'major' : perBase < 3 ? 'minor' : 'note',
      sentence: `${plural(pace.bases.length, 'place')} to sleep in ${plural(totalNights, 'night')} is ${plural(pace.hotelMoves, 'hotel move')} — about ${ratio(perBase)} nights per place${perBase < 3 ? '; three or more is where a stay stops being mostly arriving and leaving' : ''}.`,
    });
    if (pace.share !== null && pace.moveDays > 0) {
      const pct = Math.round(pace.share * 100);
      findings.push({
        id: 'move-share',
        topic: 'pace',
        severity: pace.share > 0.3 ? 'major' : pace.share > 0.18 ? 'minor' : 'note',
        sentence: `Changing beds costs about ${ratio(pace.moveDays)} of your ${totalDays} days (${pct}%) — ${formatPlanMinutes(pace.moveMinutes)} of travel plus about ${formatPlanMinutes(MOVE_OVERHEAD_MINUTES)} each time to check out, get going and check in (estimate).`,
      });
    }
    for (const short of pace.shortStops) {
      const min = minNightsFor(short.stop.kind);
      const last = short.index === pace.bases[pace.bases.length - 1]!.index;
      findings.push({
        id: `short-${short.index}`,
        topic: 'pace',
        severity: (short.stop.nights ?? 0) <= 1 && !last ? 'major' : 'minor',
        sentence:
          (short.stop.nights ?? 0) === 0
            ? `${short.stop.label} has no night of its own${last ? ' — fine if it is where you fly out, but there is no time to see it' : ''}.`
            : `${short.stop.label} gets ${nightsWord(short.stop)}; ${REGION_KINDS.has(short.stop.kind) ? 'a region' : 'a place'} like this needs about ${min} to be more than a check-in and a check-out.`,
      });
    }
  }

  /* ---- transport realism ---- */
  for (const move of moves) {
    if (move.dayTrip) continue;
    if (move.mode === 'flight') {
      findings.push({ id: `fly-${move.toIndex}`, topic: 'transport', severity: 'minor', sentence: `${moveSentence(move)} Sidequest doesn’t estimate an overland journey this long; a train or ferry may exist, but it would take most of a day or a night.` });
    } else if (move.minutes !== null && move.minutes > 300) {
      findings.push({ id: `long-${move.toIndex}`, topic: 'transport', severity: move.flightSuggested ? 'minor' : 'note', sentence: `${moveSentence(move)} That is most of a day.` });
    }
    if (move.flightSuggested && move.mode !== 'flight' && move.flightMinutes !== null) {
      suggestions.push({ id: `fly-${move.toIndex}`, kind: 'fly', sentence: `${move.from} → ${move.to} is ${Math.round(move.straightKm ?? 0)} km in a straight line: a flight is about ${formatPlanMinutes(move.flightMinutes)} door to door against about ${move.minutes !== null ? formatPlanMinutes(move.minutes) : 'an unestimated time'} by ${PLAN_MOVE_MODE_LABELS[move.mode ?? 'drive']} (both estimates).` });
    }
    if (move.mayNeedWater) {
      findings.push({ id: `water-${move.toIndex}`, topic: 'transport', severity: 'note', sentence: `${move.from} → ${move.to} involves an island: the estimate assumes a road or rail link, which Sidequest hasn’t checked — it may be a ferry or a flight.` });
    }
  }

  /* ---- route order ---- */
  const placedBases = pace.bases.filter((b) => b.stop.point);
  let reorder: number[] | null = null; // indices into `stops`
  let routeKm: number | null = null;
  let bestRouteKm: number | null = null;
  if (placedBases.length >= 2 && placedBases.length === pace.bases.length) {
    const points = placedBases.map((b) => b.stop.point!);
    routeKm = pathKm(points, points.map((_, i) => i));
    const best = bestFixedEndsOrder(points);
    bestRouteKm = pathKm(points, best);
    const saving = routeKm - bestRouteKm;
    if (saving >= REORDER_MIN_KM && saving >= routeKm * REORDER_MIN_SHARE) {
      reorder = best.map((i) => placedBases[i]!.index);
      const names = reorder.map((i) => stops[i]!.label);
      findings.push({ id: 'order', topic: 'route', severity: saving >= routeKm * 0.3 ? 'major' : 'minor', sentence: `The order doubles back: as written it covers about ${Math.round(routeKm)} km in straight lines; ${list(names)} covers about ${Math.round(bestRouteKm)} km (${Math.round((saving / routeKm) * 100)}% less), with the first and last stops kept where they are.` });
      suggestions.push({ id: 'reorder', kind: 'reorder', sentence: `Reorder to ${names.join(' → ')} — about ${Math.round(saving)} km less in straight lines, with your first and last stops unchanged.` });
    }
  }
  /* The same place twice, apart: one stay split in two. A loop back to the start is a normal way to fly home. */
  const seen = new Map<string, number>();
  for (const base of pace.bases) {
    const key = base.stop.label.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined && base.index !== pace.bases[pace.bases.length - 1]!.index) {
      findings.push({ id: `revisit-${base.index}`, topic: 'route', severity: 'minor', sentence: `You return to ${base.stop.label}; staying there once, for all its nights, saves a hotel move.` });
    }
    if (first === undefined) seen.set(key, base.index);
  }

  /* ---- improve: merge short stops into day trips, cut (once) if still too much, add nights ---- */
  let working: ImprovedPlanStop[] = (reorder ? [...reorder.map((i) => stops[i]!), ...stops.filter((s) => s.dayTrip)] : [...stops]).map((s) => ({ label: s.label, nights: s.nights ?? 0, dayTrip: s.dayTrip }));
  const changes: string[] = [];
  if (reorder) changes.push('Reordered to cut backtracking.');
  const byLabel = new Map(stops.map((s) => [s.label, s] as const));

  if (totalNights !== null && pace.verdict !== 'comfortable' && pace.verdict !== 'unknown') {
    const bedsNow = () => working.filter((s) => !s.dayTrip);
    for (const short of pace.shortStops) {
      const label = short.stop.label;
      const beds = bedsNow();
      const at = beds.findIndex((s) => s.label === label);
      if (at < 0 || beds.length <= 1 || !short.stop.point) continue;
      const neighbours = [beds[at - 1], beds[at + 1]].filter((n): n is ImprovedPlanStop => Boolean(n));
      let bestNeighbour: { stop: ImprovedPlanStop; minutes: number } | null = null;
      for (const neighbour of neighbours) {
        const original = byLabel.get(neighbour.label);
        if (!original?.point) continue;
        const est = estimateMove({ point: original.point, countryCode: original.countryCode }, { point: short.stop.point, countryCode: short.stop.countryCode });
        if (est.mode === 'flight' || est.minutes === null || est.minutes > DAY_TRIP_MAX_MINUTES) continue;
        if (!bestNeighbour || est.minutes < bestNeighbour.minutes) bestNeighbour = { stop: neighbour, minutes: est.minutes };
      }
      if (!bestNeighbour) continue;
      const host = bestNeighbour.stop;
      const nights = working.find((s) => s.label === label)!.nights;
      working = working.map((s) => (s.label === host.label && !s.dayTrip ? { ...s, nights: s.nights + nights } : s.label === label ? { ...s, nights: 0, dayTrip: true } : s));
      const sentence = `See ${label} as a day trip from ${host.label} — about ${formatPlanMinutes(bestNeighbour.minutes)} each way (estimate) — and give its ${plural(nights, 'night')} to ${host.label}: one hotel move fewer.`;
      suggestions.push({ id: `merge-${short.index}`, kind: 'merge', sentence });
      changes.push(`${label} becomes a day trip from ${host.label}.`);
    }

    /*
     * Still too many beds for the nights: drop the short stop that costs the
     * route the most to reach — at most ONE. The critique does not know which
     * stop is the traveller's highlight; cutting until the pace reads well
     * turned "Seattle, Rainier, Olympic, Portland in 6 days" into a city pair
     * with both parks gone. One cut, and "add nights" beside it, leaves the
     * bigger reshaping to the traveller.
     */
    const improvedStops = (): PlanCheckStopInput[] => working.map((s) => ({ ...byLabel.get(s.label)!, nights: s.nights, dayTrip: s.dayTrip, nightsBasis: byLabel.get(s.label)!.nightsBasis }));
    let after = readPace(improvedStops(), totalNights);
    let cuts = 0;
    while (cuts < MAX_IMPROVEMENT_CUTS && after.verdict === 'too_much' && after.bases.length > 2) {
      cuts += 1;
      const beds = working.filter((s) => !s.dayTrip);
      const candidates = beds
        .map((bed, i) => ({ bed, i }))
        .filter(({ bed, i }) => i > 0 && i < beds.length - 1 && bed.nights < minNightsFor(byLabel.get(bed.label)!.kind))
        .map(({ bed, i }) => {
          const p = byLabel.get(beds[i - 1]!.label)!.point;
          const s = byLabel.get(bed.label)!.point;
          const n = byLabel.get(beds[i + 1]!.label)!.point;
          const detour = p && s && n ? haversineKm(p, s) + haversineKm(s, n) - haversineKm(p, n) : null;
          return { bed, i, detour };
        })
        .filter((c): c is { bed: ImprovedPlanStop; i: number; detour: number } => c.detour !== null)
        .sort((a, b) => b.detour - a.detour);
      const drop = candidates[0];
      if (!drop) break;
      const receiver = beds[drop.i - 1]!;
      const onward = beds[drop.i + 1]!;
      working = working.filter((s) => s.label !== drop.bed.label).map((s) => (s.label === receiver.label && !s.dayTrip ? { ...s, nights: s.nights + drop.bed.nights } : s));
      suggestions.push({ id: `cut-${drop.bed.label}`, kind: 'cut', sentence: `Drop ${drop.bed.label}: it is about ${Math.round(drop.detour)} km off the line between ${receiver.label} and ${onward.label} (straight-line), and its ${plural(drop.bed.nights, 'night')} go to ${receiver.label}.` });
      changes.push(`${drop.bed.label} is dropped; its nights go to ${receiver.label}.`);
      after = readPace(improvedStops(), totalNights);
    }

    /* What it would take to keep every stop as written. */
    const missing = pace.bases.reduce((n, b) => n + Math.max(0, minNightsFor(b.stop.kind) - (b.stop.nights ?? 0)), 0);
    if (missing > 0 && pace.bases.length > 1) {
      suggestions.push({ id: 'add-nights', kind: 'add_nights', sentence: `Or keep every stop and add ${plural(missing, 'night')} (${totalNights + missing} in all), which gives each place at least its minimum.` });
    }
  }

  /* Room to spare: a long stay is where a side trip fits. */
  if (pace.verdict === 'comfortable') {
    for (const base of pace.bases) {
      if ((base.stop.nights ?? 0) >= 4) suggestions.push({ id: `side-${base.index}`, kind: 'side_trip', sentence: `${base.stop.label} has ${plural(base.stop.nights ?? 0, 'night')} — room for a day trip or two; the discovery scan looks for side trips within about ${formatPlanMinutes(DAY_TRIP_MAX_MINUTES)} of it.` });
    }
  }

  const improved = changes.length > 0 ? { stops: working, changes } : null;

  /* ---- headline ---- */
  const placeWord = plural(pace.bases.length, 'place');
  let headline: string;
  if (pace.verdict === 'unknown') headline = stops.length === 0 ? 'We couldn’t find any places in that plan.' : `${placeWord} in order — add a length and we can judge the pace.`;
  else if (pace.verdict === 'too_much') headline = `Too much for ${plural(totalNights!, 'night')}: ${placeWord} means ${plural(pace.hotelMoves, 'hotel move')}${pace.share !== null ? `, and about ${ratio(pace.moveDays)} of ${totalDays} days go to moving (estimate)` : ''}.`;
  else if (pace.verdict === 'full') headline = `Doable but full: ${placeWord} in ${plural(totalNights!, 'night')}, about ${ratio(pace.nightsPerBase!)} nights each.`;
  else headline = `A comfortable pace: ${placeWord} in ${plural(totalNights!, 'night')}, about ${ratio(pace.nightsPerBase!)} nights each.`;

  const rank = { major: 0, minor: 1, note: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    verdict: pace.verdict,
    headline,
    metrics: {
      stops: stops.length,
      bases: pace.bases.length,
      hotelMoves: pace.hotelMoves,
      totalNights,
      totalDays,
      nightsPerBase: pace.nightsPerBase,
      moveMinutesEstimated: pace.moveMinutes,
      moveDaysEstimated: Math.round(pace.moveDays * 10) / 10,
      shareOfDaysMoving: pace.share,
      routeKm,
      bestRouteKm,
      unplaced,
    },
    moves,
    findings,
    suggestions,
    improved,
  };
}
