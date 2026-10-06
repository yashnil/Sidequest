import { tourMinutes, type PlannerCandidate, type StructurePlan, type StructurePlannerInput } from './structure-planner';
import { matchNamedMustDos } from '../discovery-scan/match';

/**
 * V1 CONVERGENCE — "I ALREADY HAVE A PLAN", CHECKED.
 *
 * Master prompt §7 Mode 3: somebody with a rough itinerary wants to know
 * whether it is too rushed, whether the order wastes time, whether a day goes
 * further than they want to travel, and what they are missing. This reads the
 * plan as they wrote it (days in order, places in order) and checks it against
 * exactly what the build would use — the board's places and fit, the same
 * travel minutes, the same daily windows, the same pace and the same forecast.
 *
 * Pure and deterministic: no model, no provider. It never rewrites their plan;
 * it says what it found and the build (which seeds their places as their own
 * includes) does the rest. Unknown ≠ false: a place we could not find on the
 * board is "not checked", never "wrong", and a leg nobody measured is an
 * estimate that is said to be one.
 */

export interface ExistingPlanDay {
  /** The day number the traveller wrote, or the line's position when they did not number it. */
  dayNumber: number;
  places: string[];
}

export interface ExistingPlan {
  /** True when the traveller wrote days ("Day 1: …" or one line per day); false for a single list. */
  hasDays: boolean;
  days: ExistingPlanDay[];
}

const DAY_PREFIX = /^\s*(?:day\s*(\d{1,2})|d(\d{1,2}))\s*[:.)\-–—]?\s*/i;
const ITEM_SEPARATOR = /\s*(?:,|;|→|->|\bthen\b|\band then\b|\s\+\s|\s&\s|\s\/\s)\s*/i;
const MAX_DAYS = 30;
const MAX_PLACES = 40;

/** The traveller's plan, as days of place names in their order. Lines are days; a single line is one list. */
export function parseExistingPlan(text: string | null | undefined): ExistingPlan | null {
  if (!text || !text.trim()) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const numbered = lines.some((l) => DAY_PREFIX.test(l));
  const hasDays = numbered || lines.length > 1;
  const days: ExistingPlanDay[] = [];
  let total = 0;
  for (const [index, line] of lines.entries()) {
    const marker = DAY_PREFIX.exec(line);
    const dayNumber = marker ? Number(marker[1] ?? marker[2]) : index + 1;
    const body = marker ? line.slice(marker[0].length) : line;
    const places = body
      .split(ITEM_SEPARATOR)
      .map((p) => p.replace(/^[-•*]\s*/, '').replace(/[.!]+$/, '').trim())
      .filter((p) => p.length >= 3)
      .slice(0, Math.max(0, MAX_PLACES - total));
    total += places.length;
    if (places.length === 0) continue;
    const existing = days.find((d) => d.dayNumber === dayNumber);
    if (existing) existing.places.push(...places);
    else days.push({ dayNumber, places });
    if (days.length >= MAX_DAYS || total >= MAX_PLACES) break;
  }
  if (days.length === 0) return null;
  days.sort((a, b) => a.dayNumber - b.dayNumber);
  return { hasDays, days };
}

/** Every place the plan names, in order, for the scan to propose and the board to seed as the traveller's own. */
export function existingPlanPlaceNames(text: string | null | undefined): string[] {
  const plan = parseExistingPlan(text);
  if (!plan) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const day of plan.days) {
    for (const place of day.places) {
      const key = place.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(place);
    }
  }
  return out;
}

export type CritiqueKind =
  | 'too_many_days'
  | 'rushed_day'
  | 'travel_over_limit'
  | 'order_wastes_time'
  | 'too_strenuous'
  | 'back_to_back_strenuous'
  | 'closed_that_day'
  | 'out_of_season'
  | 'blocked'
  | 'weather'
  | 'too_much_overall'
  | 'not_checked'
  | 'missing_classic';

export interface CritiqueFinding {
  kind: CritiqueKind;
  /** `major`: the plan does not work as written; `minor`: it works but costs something; `note`: worth knowing. */
  severity: 'major' | 'minor' | 'note';
  dayNumber: number | null;
  sentence: string;
  placeIds: string[];
}

export interface PlanCritique {
  verdict: 'works' | 'works_with_changes' | 'rethink';
  headline: string;
  findings: CritiqueFinding[];
  /** How many of the plan's places were found on the board, of how many it names. */
  matched: number;
  named: number;
  /** True when any minute here came from an estimate rather than a router. */
  minutesEstimated: boolean;
}

const INTENSITY_RANK = { none: 0, easy: 1, moderate: 2, strenuous: 3 } as const;
const BUFFER_BY_PACE = { slow: 90, balanced: 45, fast: 20 } as const;
const LUNCH_MINUTES = 60;
/** Reordering is worth mentioning only when it saves at least this much, and a noticeable share (8%) of the day's travel. */
const ORDER_SAVING_MIN = 20;

const list = (names: readonly string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const mins = (m: number) => (m >= 90 ? `${Math.floor(m / 60)} h ${Math.round(m % 60) > 0 ? `${Math.round(m % 60)} min` : ''}`.trim() : `${Math.round(m)} min`);

export function critiqueExistingPlan(input: {
  plan: ExistingPlan;
  planner: StructurePlannerInput;
  /** Sidequest's own plan over the same board, for what it would add. */
  proposal: StructurePlan;
  /** Whether the matrix behind `planner.minutes` was estimated rather than routed. */
  minutesEstimated: boolean;
}): PlanCritique {
  const { plan, planner } = input;
  const findings: CritiqueFinding[] = [];
  const byId = new Map(planner.candidates.map((c) => [c.id, c]));
  const places = planner.candidates.map((c) => ({ id: c.id, name: c.name }));
  const tripDays = planner.windows.length;

  // --- what we could find ---------------------------------------------------------------------
  const resolvedDays = plan.days.map((day) => {
    const stops: PlannerCandidate[] = [];
    const unmatched: string[] = [];
    for (const name of day.places) {
      const ids = matchNamedMustDos([name], places).filter((id) => !stops.some((s) => s.id === id));
      const hit = ids.map((id) => byId.get(id)!).sort((a, b) => b.fit - a.fit)[0];
      if (hit) stops.push(hit);
      else unmatched.push(name);
    }
    return { day, stops, unmatched };
  });
  const named = plan.days.reduce((n, d) => n + d.places.length, 0);
  const unmatched = resolvedDays.flatMap((d) => d.unmatched);
  const inPlan = new Set(resolvedDays.flatMap((d) => d.stops.map((s) => s.id)));

  if (plan.hasDays && plan.days.length > tripDays) {
    findings.push({ kind: 'too_many_days', severity: 'major', dayNumber: null, sentence: `Your plan has ${plan.days.length} days; this trip has ${tripDays}. Days ${tripDays + 1}–${plan.days.length} need to fold into the others or be dropped.`, placeIds: [] });
  }

  // --- day by day ------------------------------------------------------------------------------
  let previousStrenuous = false;
  for (const { day, stops } of resolvedDays) {
    const window = plan.hasDays ? planner.windows[day.dayNumber - 1] : undefined;
    const base = window ? planner.bases.find((b) => window.date >= b.fromDate && window.date < b.toDate) ?? planner.bases[planner.bases.length - 1] : undefined;
    const dayLabel = plan.hasDays ? `Day ${day.dayNumber}` : 'Your plan';

    for (const stop of stops) {
      if (stop.blocked) findings.push({ kind: 'blocked', severity: 'major', dayNumber: plan.hasDays ? day.dayNumber : null, sentence: `${stop.name}: ${stop.blocked}`, placeIds: [stop.id] });
      else if (!stop.openOnTripDates) findings.push({ kind: 'out_of_season', severity: 'major', dayNumber: plan.hasDays ? day.dayNumber : null, sentence: `${stop.name} is not open in the months of this trip.`, placeIds: [stop.id] });
      else if (window && stop.closedDates?.includes(window.date)) findings.push({ kind: 'closed_that_day', severity: 'major', dayNumber: day.dayNumber, sentence: `${stop.name} is closed on ${dayLabel} (${window.date}) by its published hours — another day works.`, placeIds: [stop.id] });
      if (INTENSITY_RANK[stop.intensity] > INTENSITY_RANK[planner.maxPhysicalIntensity]) {
        findings.push({ kind: 'too_strenuous', severity: 'minor', dayNumber: plan.hasDays ? day.dayNumber : null, sentence: `${stop.name} is ${stop.intensity}, harder than the effort you asked for.`, placeIds: [stop.id] });
      }
    }

    if (!plan.hasDays || !window || !base) continue;
    const daytime = stops.filter((s) => s.bestTime !== 'sunrise' && s.bestTime !== 'sunset' && s.bestTime !== 'night');

    // Their order, as written, out from the base and back.
    const ids = stops.map((s) => s.id);
    let written = 0;
    let estimatedLeg = false;
    for (let i = 0; i <= ids.length; i += 1) {
      const from = i === 0 ? base.id : ids[i - 1]!;
      const to = i === ids.length ? base.id : ids[i]!;
      const m = planner.minutes(from, to);
      if (m === null) estimatedLeg = true;
      written += m ?? 0;
    }
    if (ids.length > 0 && !estimatedLeg) {
      const best = tourMinutes(base.id, ids, planner.minutes);
      const saving = written - best.total;
      if (ids.length >= 3 && saving >= ORDER_SAVING_MIN && saving >= written * 0.08) {
        const order = best.order.map((id) => byId.get(id)!.name);
        findings.push({ kind: 'order_wastes_time', severity: 'minor', dayNumber: day.dayNumber, sentence: `${dayLabel} doubles back: ${list(order)} in that order saves about ${mins(saving)} of travel.`, placeIds: best.order });
      }
      if (written > planner.maxDailyTravelMinutes) {
        findings.push({ kind: 'travel_over_limit', severity: 'major', dayNumber: day.dayNumber, sentence: `${dayLabel} is about ${mins(written)} of travel from ${base.name} and back, over your ${mins(planner.maxDailyTravelMinutes)} a day.`, placeIds: ids });
      }
    }

    const capacity = window.endMinute - window.startMinute - BUFFER_BY_PACE[planner.pace];
    const activity = daytime.reduce((n, s) => n + s.durationMinutes, 0);
    const needed = activity + Math.min(written, planner.maxDailyTravelMinutes * 2) + (daytime.length > 0 ? LUNCH_MINUTES : 0);
    if (daytime.length > planner.maxStopsPerDay || needed > capacity) {
      const why = daytime.length > planner.maxStopsPerDay ? `${daytime.length} stops where your pace holds ${planner.maxStopsPerDay}` : `about ${mins(needed)} of visits, travel and lunch in a ${mins(capacity)} day`;
      findings.push({ kind: 'rushed_day', severity: needed > capacity * 1.25 ? 'major' : 'minor', dayNumber: day.dayNumber, sentence: `${dayLabel} is rushed: ${why}.`, placeIds: daytime.map((s) => s.id) });
    }

    const strenuous = stops.some((s) => s.intensity === 'strenuous');
    if (strenuous && previousStrenuous && planner.pace !== 'fast') {
      findings.push({ kind: 'back_to_back_strenuous', severity: 'note', dayNumber: day.dayNumber, sentence: `Days ${day.dayNumber - 1} and ${day.dayNumber} are both strenuous; an easier day between them is kinder at your pace.`, placeIds: stops.filter((s) => s.intensity === 'strenuous').map((s) => s.id) });
    }
    previousStrenuous = strenuous;

    const weather = planner.weather.find((w) => w.date === window.date);
    if (weather && weather.severity >= 2) {
      const exposed = stops.filter((s) => s.exposure === 'outdoor');
      if (exposed.length > 0) {
        const better = planner.weather.filter((w) => w.severity < 2 && planner.windows.some((x) => x.date === w.date)).map((w) => planner.windows.findIndex((x) => x.date === w.date) + 1);
        findings.push({ kind: 'weather', severity: 'note', dayNumber: day.dayNumber, sentence: `${dayLabel} looks ${weather.label.toLowerCase()} for ${list(exposed.map((s) => s.name))}${better.length > 0 ? `; day ${better.slice(0, 3).join(', ')} look${better.length === 1 ? 's' : ''} better` : ''}.`, placeIds: exposed.map((s) => s.id) });
      }
    }
  }

  // --- a list without days: does it fit the trip at all? ---------------------------------------
  if (!plan.hasDays) {
    const daytime = resolvedDays.flatMap((d) => d.stops).filter((s) => s.bestTime !== 'sunrise' && s.bestTime !== 'sunset' && s.bestTime !== 'night');
    const room = tripDays * planner.maxStopsPerDay;
    if (daytime.length > room) {
      findings.push({ kind: 'too_much_overall', severity: 'major', dayNumber: null, sentence: `${daytime.length} daytime places is more than ${tripDays} days hold at your pace (about ${room}); Sidequest's plan keeps the best fits and says what it left out.`, placeIds: daytime.map((s) => s.id) });
    }
  }

  if (unmatched.length > 0) {
    findings.push({ kind: 'not_checked', severity: 'note', dayNumber: null, sentence: `Not checked — we could not find ${list(unmatched.slice(0, 5).map((n) => `"${n}"`))}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ''} among this trip's places, so nothing here says they are wrong.`, placeIds: [] });
  }

  // --- what Sidequest would add: defining places the plan leaves out ----------------------------
  const proposed = new Set(input.proposal.days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
  const missing = planner.candidates
    .filter((c) => !inPlan.has(c.id) && !c.blocked && c.openOnTripDates && c.significance >= 0.75 && c.fit >= 70 && proposed.has(c.id))
    .sort((a, b) => b.fit + b.significance * 20 - (a.fit + a.significance * 20))
    .slice(0, 3);
  if (missing.length > 0) {
    findings.push({ kind: 'missing_classic', severity: 'note', dayNumber: null, sentence: `Worth a look: ${list(missing.map((c) => c.name))} — strong fits for you that your plan leaves out.`, placeIds: missing.map((c) => c.id) });
  }

  const majors = findings.filter((f) => f.severity === 'major').length;
  const minors = findings.filter((f) => f.severity === 'minor').length;
  const verdict: PlanCritique['verdict'] = majors >= 2 ? 'rethink' : majors + minors > 0 ? 'works_with_changes' : 'works';
  const matched = named - unmatched.length;
  const headline =
    matched === 0
      ? 'We could not find the places in your plan on this trip yet, so there is nothing to check.'
      : verdict === 'works'
        ? `Your plan works: ${matched} of ${named} places checked, nothing that does not fit.`
        : verdict === 'works_with_changes'
          ? `Your plan mostly works — ${majors + minors} thing${majors + minors === 1 ? '' : 's'} to change.`
          : `Your plan needs rethinking: ${majors} things do not work as written.`;
  const rank = { major: 0, minor: 1, note: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.dayNumber ?? 99) - (b.dayNumber ?? 99));
  return { verdict, headline, findings, matched, named, minutesEstimated: input.minutesEstimated };
}
