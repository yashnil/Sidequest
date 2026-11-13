import { haversineKm } from '../travel/estimate';
import { twilightFor, TWILIGHT_DEPRESSION_DEGREES } from '../weather/solar';
import { utcOffsetMinutesOn } from '../time/zone';
import { walkingMinutes, type ScanCandidateProposal, type ScanStageAlternative } from './proposal';
import type { TrailStageRecord } from '../schemas/stay';

/**
 * 2026-11 — POINT-TO-POINT TREKKING: A TRAIL WALKED FROM ONE BED TO THE NEXT.
 *
 * A pilgrimage or a long-distance path is walked in stages, inn to inn, with the
 * bags sent ahead; the eleven-day plan that drove back to one base every
 * evening treated each stage as a day hike. This module turns the proposal's
 * one-way walks into an ordered, contiguous stage sequence and judges each
 * stage against the party:
 *
 * - **Order is checked, never believed.** A stage joins the sequence only when
 *   its start lies within `STAGE_JOIN_KM` of the previous stage's end; the
 *   model's own stage numbers only break ties. A stage whose end could not be
 *   placed is left out of the sequence (unknown, not invented).
 * - **Distance and ascent**: a hiking router's figures where one answered
 *   (`distanceBasis: 'measured'`), else the proposal's own (`proposal`), else
 *   the time on site the proposal gave (`duration`); walking time from them by
 *   the same Naismith-style rule as every other walk (`walkingMinutes`).
 * - **A day is walkable** when its walking time is within the party's limit,
 *   its ascent within their effort, it is open that month (unknown ≠ closed),
 *   and a sensible start still reaches the next bed before civil dusk with a
 *   margin. A day that is not is split at an intermediate overnight, or covered
 *   by the usual bus or skip the proposal named, or left unresolved and said so.
 *
 * Pure: no clock, no provider, no model. Every word here is about walking;
 * nothing names a trail or a place.
 */

/** A stage's start must lie this close to the previous stage's end for the two to be one walk. */
export const STAGE_JOIN_KM = 6;
/** How near a bed a trail stage must start, and end, to join two beds. */
export const TRAIL_START_NEAR_BED_KM = 12;
export const TRAIL_END_AT_BED_KM = 4;
/** The most stages one trip follows. */
export const MAX_TRAIL_STAGES = 8;

/**
 * Walking a stage is at most this many minutes a day, by the traveller's daily
 * effort answer: about six hours on a light trip, seven on a moderate one,
 * eight for somebody who asked for intense days. Moving time, before rests.
 */
export const TRAIL_WALKING_LIMIT_MINUTES = { light: 360, moderate: 420, intense: 480 } as const;
/** …and at most this much climbing. */
export const TRAIL_ASCENT_LIMIT_M = { light: 600, moderate: 1000, intense: 1500 } as const;
/** A party with children walks at most this long and climbs at most this much, whatever the effort answer. */
export const TRAIL_FAMILY_LIMIT = { walkMinutes: 360, ascentM: 800 } as const;
/** Young children, reduced mobility or older travellers in the party: shorter still. */
export const TRAIL_GENTLE_LIMIT = { walkMinutes: 300, ascentM: 500 } as const;
/** Rests, lunch and the shrine or viewpoint on the way: a walking day is this much longer than its moving time. */
export const TRAIL_REST_SHARE = 0.15;
/** Into the next village at least this long before civil dusk. */
export const TRAIL_DUSK_MARGIN_MINUTES = 60;
/** The earliest start a stage day is planned around. */
export const EARLIEST_TRAIL_START_MINUTE = 7 * 60;
/** The start a stage day assumes when the trip's own day window is unknown. */
export const DEFAULT_TRAIL_START_MINUTE = 8 * 60 + 30;
/** A split point must be roughly on the way: going through it is at most this much longer than the straight line. */
const SPLIT_DETOUR_RATIO = 1.3;

export interface TrailParty {
  intensity: 'light' | 'moderate' | 'intense';
  children: number;
  youngChildren: boolean;
  reducedMobility: boolean;
  pace?: 'slow' | 'balanced' | 'fast';
}

export interface TrailLimits {
  walkMinutes: number;
  ascentM: number;
  basis: string;
}

export function trailLimitsFor(party: TrailParty): TrailLimits {
  let walk: number = TRAIL_WALKING_LIMIT_MINUTES[party.intensity];
  let ascent: number = TRAIL_ASCENT_LIMIT_M[party.intensity];
  const why = [`${party.intensity} days`];
  if (party.youngChildren || party.reducedMobility) {
    walk = Math.min(walk, TRAIL_GENTLE_LIMIT.walkMinutes);
    ascent = Math.min(ascent, TRAIL_GENTLE_LIMIT.ascentM);
    why.push(party.youngChildren ? 'young children' : 'reduced mobility');
  } else if (party.children > 0) {
    walk = Math.min(walk, TRAIL_FAMILY_LIMIT.walkMinutes);
    ascent = Math.min(ascent, TRAIL_FAMILY_LIMIT.ascentM);
    why.push('children');
  }
  if (party.pace === 'slow') {
    walk = Math.min(walk, TRAIL_WALKING_LIMIT_MINUTES.light);
    why.push('a slow pace');
  }
  return { walkMinutes: walk, ascentM: ascent, basis: why.join(', ') };
}

type Point = { lat: number; lng: number };

export interface TrailStage {
  placeId: string;
  key: string;
  name: string;
  /** 1-based position in the followed sequence. */
  order: number;
  start: Point;
  end: Point;
  endName?: string;
  km: number | null;
  ascentM: number | null;
  distanceBasis: 'measured' | 'proposal' | 'duration';
  walkMinutes: number;
  openMonths?: readonly number[];
  seasonalNote?: string;
  alternative?: ScanStageAlternative;
  unsuitable?: string;
  /** Which half of a split stage this is; the second half's `placeId` and `key` are the first's with `~2`. */
  part?: 1 | 2;
  /** Where a split stage breaks: the intermediate overnight. */
  splitAt?: { baseId: string; name: string; at: Point };
}

export interface TrailStageInput {
  id: string;
  proposal: ScanCandidateProposal;
}

export interface MeasuredStage {
  km: number;
  ascentM: number;
}

function walkFigures(c: ScanCandidateProposal, measured: MeasuredStage | undefined): Pick<TrailStage, 'km' | 'ascentM' | 'distanceBasis' | 'walkMinutes'> {
  if (measured) return { km: measured.km, ascentM: measured.ascentM, distanceBasis: 'measured', walkMinutes: walkingMinutes(measured.km, measured.ascentM) };
  if (c.walk?.km) return { km: c.walk.km, ascentM: c.walk.ascentM ?? null, distanceBasis: 'proposal', walkMinutes: walkingMinutes(c.walk.km, c.walk.ascentM ?? 0) };
  return { km: null, ascentM: c.walk?.ascentM ?? null, distanceBasis: 'duration', walkMinutes: Math.max(15, c.durationMinutes) };
}

/**
 * The proposal's one-way walks as one ordered, contiguous sequence: the
 * longest chain in which each stage starts where the last one ended. Stages
 * that cannot be placed, or that join nothing, are reported and left to be
 * planned as walks of their own.
 */
export function orderTrailStages(input: {
  candidates: readonly TrailStageInput[];
  positionOf: (key: string) => Point | null;
  measured?: ReadonlyMap<string, MeasuredStage>;
}): { stages: TrailStage[]; dropped: { name: string; reason: string }[] } {
  const dropped: { name: string; reason: string }[] = [];
  const eligible: (TrailStage & { stated?: number; index: number })[] = [];
  input.candidates.forEach(({ id, proposal: c }, index) => {
    if (c.walk?.shape !== 'point_to_point') return;
    const start = input.positionOf(c.key);
    const end = input.positionOf(`${c.key}#end`);
    if (!start || !end) {
      dropped.push({ name: c.name, reason: `${c.walk.endName ? `Its end, ${c.walk.endName},` : 'Its end'} could not be placed on a map, so it is not walked as a stage.` });
      return;
    }
    eligible.push({
      placeId: id,
      key: c.key,
      name: c.name,
      order: 0,
      start,
      end,
      ...(c.walk.endName ? { endName: c.walk.endName } : {}),
      ...walkFigures(c, input.measured?.get(c.key)),
      ...(c.openMonths ? { openMonths: c.openMonths } : {}),
      ...(c.seasonalNote ? { seasonalNote: c.seasonalNote } : {}),
      ...(c.walk.alternative ? { alternative: c.walk.alternative } : {}),
      ...(c.walk.unsuitable ? { unsuitable: c.walk.unsuitable } : {}),
      ...(c.walk.stage !== undefined ? { stated: c.walk.stage } : {}),
      index,
    });
  });
  if (eligible.length === 0) return { stages: [], dropped };

  const joins = (a: TrailStage, b: TrailStage) => haversineKm(a.end, b.start) <= STAGE_JOIN_KM;
  /* The model's stated order, then its proposal order: only ever a tie-break between stages that genuinely join. */
  const rank = (s: { stated?: number; index: number }) => (s.stated ?? 1000) * 1000 + s.index;
  const chainFrom = (head: (typeof eligible)[number]) => {
    const chain = [head];
    const used = new Set([head.key]);
    for (;;) {
      const at = chain[chain.length - 1]!;
      const next = eligible
        .filter((s) => !used.has(s.key) && joins(at, s))
        .sort((a, b) => {
          const wantA = at.stated !== undefined && a.stated === at.stated + 1 ? 0 : 1;
          const wantB = at.stated !== undefined && b.stated === at.stated + 1 ? 0 : 1;
          return wantA - wantB || haversineKm(at.end, a.start) - haversineKm(at.end, b.start) || rank(a) - rank(b);
        })[0];
      if (!next || chain.length >= MAX_TRAIL_STAGES) break;
      chain.push(next);
      used.add(next.key);
    }
    return chain;
  };
  const heads = eligible.filter((s) => !eligible.some((o) => o !== s && joins(o, s)));
  const tries = (heads.length > 0 ? heads : eligible).slice().sort((a, b) => rank(a) - rank(b));
  let best: (typeof eligible)[number][] = [];
  for (const head of tries) {
    const chain = chainFrom(head);
    if (chain.length > best.length) best = chain;
  }
  const kept = new Set(best.map((s) => s.key));
  for (const s of eligible) if (!kept.has(s.key)) dropped.push({ name: s.name, reason: 'It does not join the stages before and after it, so it stays a walk of its own.' });
  const stages = best.map(({ stated: _stated, index: _index, ...stage }, i) => ({ ...stage, order: i + 1 }));
  return { stages, dropped };
}

/** Civil dusk at a point on a date, minutes from local midnight; null when it cannot honestly be said (no trusted zone, a white night). */
export function civilDuskMinute(point: Point, date: string, timeZone: string | undefined): number | null {
  if (!timeZone || (/^(Etc\/)?(UTC|GMT)$/i.test(timeZone) && Math.abs(point.lng) > 22.5)) return null;
  try {
    const offset = utcOffsetMinutesOn(date, timeZone);
    const civil = twilightFor(point, date, offset, TWILIGHT_DEPRESSION_DEGREES.civil);
    return civil.kind === 'normal' ? civil.duskMinute : null;
  } catch {
    return null;
  }
}

/** A walking day's length on the clock: moving time plus rests. */
export function trailDayMinutes(walkMinutes: number): number {
  return Math.round(walkMinutes * (1 + TRAIL_REST_SHARE));
}

export interface StageContext {
  /** Month (1–12) of the day it would be walked. */
  month: number;
  /** Civil dusk that day at the stage's end; null when unknown, which never fails a stage. */
  duskMinute: number | null;
  /** When the trip's day ordinarily starts. */
  startMinute: number;
}

export type StageProblemCode = 'too_long' | 'too_much_ascent' | 'after_dusk' | 'closed' | 'unsuitable';
export interface StageAssessment {
  ok: boolean;
  problems: { code: StageProblemCode; detail: string }[];
  /** The latest start that still arrives before dusk with the margin; null when dusk is unknown. */
  latestStartMinute: number | null;
}

export function trailClock(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function trailHours(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes / 10) * 10);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

export function assessTrailStage(stage: Pick<TrailStage, 'walkMinutes' | 'ascentM' | 'openMonths' | 'seasonalNote' | 'unsuitable'>, limits: TrailLimits, context: StageContext): StageAssessment {
  const problems: StageAssessment['problems'] = [];
  if (stage.openMonths && stage.openMonths.length > 0 && !stage.openMonths.includes(context.month)) {
    problems.push({ code: 'closed', detail: stage.seasonalNote ? `closed or impractical in this month (${stage.seasonalNote})` : 'closed or impractical in this month' });
  }
  if (stage.unsuitable) problems.push({ code: 'unsuitable', detail: stage.unsuitable.replace(/\.$/, '') });
  if (stage.walkMinutes > limits.walkMinutes) problems.push({ code: 'too_long', detail: `about ${trailHours(stage.walkMinutes)} of walking, more than the ${trailHours(limits.walkMinutes)} a day this party is planned for` });
  if (stage.ascentM !== null && stage.ascentM > limits.ascentM) problems.push({ code: 'too_much_ascent', detail: `${Math.round(stage.ascentM)} m of climbing, more than the ${limits.ascentM} m this party is planned for` });
  let latestStartMinute: number | null = null;
  if (context.duskMinute !== null) {
    latestStartMinute = context.duskMinute - TRAIL_DUSK_MARGIN_MINUTES - trailDayMinutes(stage.walkMinutes);
    if (latestStartMinute < EARLIEST_TRAIL_START_MINUTE) problems.push({ code: 'after_dusk', detail: `even starting at ${trailClock(EARLIEST_TRAIL_START_MINUTE)} it would finish after dark (dusk about ${trailClock(context.duskMinute)})` });
  }
  return { ok: problems.length === 0, problems, latestStartMinute };
}

export interface ResolvedTrailStage extends TrailStage {
  resolution: 'walk' | 'split' | 'alternative' | 'unresolved';
  fromBaseId: string | null;
  toBaseId: string | null;
  note?: string;
  latestStartMinute?: number;
  duskMinute?: number;
}

export interface TrailBed {
  id: string;
  name: string;
  coordinates: Point;
}

function nearestBed(point: Point, beds: readonly TrailBed[], limitKm: number, not?: string | null): TrailBed | null {
  let best: { bed: TrailBed; km: number } | null = null;
  for (const bed of beds) {
    if (bed.id === not) continue;
    const km = haversineKm(point, bed.coordinates);
    if (km <= limitKm && (!best || km < best.km)) best = { bed, km };
  }
  return best?.bed ?? null;
}

const capitalise = (s: string) => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Each stage judged for this party, in order. A stage that does not suit is
 * split at an intermediate overnight when one lies on the way and both halves
 * suit; else covered the usual way the proposal named, when that way is open
 * that month (unknown ≠ closed); else left as it is and said so on the day.
 */
export function resolveTrailStages(input: {
  stages: readonly TrailStage[];
  limits: TrailLimits;
  beds: readonly TrailBed[];
  contextFor: (index: number, stage: TrailStage) => StageContext;
}): ResolvedTrailStage[] {
  const out: ResolvedTrailStage[] = [];
  input.stages.forEach((stage, index) => {
    const context = input.contextFor(index, stage);
    const assessment = assessTrailStage(stage, input.limits, context);
    const timing = (a: StageAssessment) => ({ ...(a.latestStartMinute !== null ? { latestStartMinute: a.latestStartMinute } : {}), ...(context.duskMinute !== null ? { duskMinute: context.duskMinute } : {}) });
    const reasons = assessment.problems.map((p) => p.detail).join('; ');
    if (assessment.ok) {
      out.push({ ...stage, resolution: 'walk', fromBaseId: null, toBaseId: null, ...timing(assessment) });
      return;
    }
    /* Only length, climbing and daylight are mended by an extra night: a closed or unsuitable section is not walked at all. */
    const splittable = assessment.problems.every((p) => p.code === 'too_long' || p.code === 'too_much_ascent' || p.code === 'after_dusk');
    if (splittable) {
      const straight = haversineKm(stage.start, stage.end);
      const options = input.beds
        .map((bed) => ({ bed, a: haversineKm(stage.start, bed.coordinates), b: haversineKm(bed.coordinates, stage.end) }))
        .filter((o) => straight > 2 && o.a > 1 && o.b > 1 && o.a + o.b <= SPLIT_DETOUR_RATIO * straight)
        .sort((x, y) => Math.abs(x.a / (x.a + x.b) - 0.5) - Math.abs(y.a / (y.a + y.b) - 0.5) || x.bed.id.localeCompare(y.bed.id));
      for (const option of options) {
        const share = option.a / (option.a + option.b);
        const half = (s: number): Pick<TrailStage, 'km' | 'ascentM' | 'walkMinutes'> => {
          const km = stage.km !== null ? Math.round(stage.km * s * 10) / 10 : null;
          const ascentM = stage.ascentM !== null ? Math.round(stage.ascentM * s) : null;
          return { km, ascentM, walkMinutes: km !== null ? walkingMinutes(km, ascentM ?? 0) : Math.round(stage.walkMinutes * s) };
        };
        const first = { ...stage, ...half(share) };
        const second = { ...stage, ...half(1 - share) };
        const a1 = assessTrailStage(first, input.limits, context);
        const a2 = assessTrailStage(second, input.limits, input.contextFor(index + 1, stage));
        if (!a1.ok || !a2.ok) continue;
        const at = { baseId: option.bed.id, name: option.bed.name, at: option.bed.coordinates };
        const note = `Split with a night in ${option.bed.name}: walked in one day it is ${reasons}.`;
        out.push({ ...first, end: option.bed.coordinates, endName: option.bed.name, name: `${stage.name} (to ${option.bed.name})`, part: 1, splitAt: at, resolution: 'split', note, fromBaseId: null, toBaseId: null, ...timing(a1) });
        out.push({ ...second, start: option.bed.coordinates, placeId: `${stage.placeId}~2`, key: `${stage.key}~2`, name: `${stage.name} (from ${option.bed.name})`, part: 2, splitAt: at, resolution: 'split', note, fromBaseId: null, toBaseId: null, ...timing(a2) });
        return;
      }
    }
    const alt = stage.alternative;
    const altOpen = alt && (!alt.openMonths || alt.openMonths.length === 0 || alt.openMonths.includes(context.month));
    if (alt && altOpen) {
      const instead = alt.mode === 'skip' ? 'skip this section' : `take the ${alt.mode} instead`;
      out.push({ ...stage, resolution: 'alternative', fromBaseId: null, toBaseId: null, note: `${capitalise(reasons)} for this party, so ${instead}: ${alt.note.replace(/\.$/, '')}.`, ...timing(assessment) });
      return;
    }
    out.push({
      ...stage,
      resolution: 'unresolved',
      fromBaseId: null,
      toBaseId: null,
      note: `${capitalise(reasons)}.${alt ? ` The usual alternative (${alt.mode}) does not run this month either.` : ' No usual alternative was proposed: ask the inn about a taxi for part of the way, or plan a shorter day.'}`,
      ...timing(assessment),
    });
  });
  /* Which bed each stage leaves from and arrives at. */
  return out.map((stage, i) => {
    const from = nearestBed(stage.start, input.beds, TRAIL_START_NEAR_BED_KM);
    const to = nearestBed(stage.end, input.beds, TRAIL_END_AT_BED_KM, from?.id ?? null);
    return { ...stage, order: i + 1, fromBaseId: from?.id ?? null, toBaseId: to?.id ?? null };
  });
}

/**
 * The beds the trail sleeps in, in order: the longest run of stages in which
 * each leaves from the bed the last one reached. A stage with no bed at one of
 * its ends breaks the run; a run that would come back to a bed it already slept
 * in stops there.
 */
export function trailBedChain(stages: readonly ResolvedTrailStage[]): { chain: string[]; stages: ResolvedTrailStage[] } {
  let best: { chain: string[]; stages: ResolvedTrailStage[] } = { chain: [], stages: [] };
  let run: ResolvedTrailStage[] = [];
  let beds: string[] = [];
  const close = () => {
    if (run.length > best.stages.length) best = { chain: [...beds], stages: [...run] };
    run = [];
    beds = [];
  };
  for (const stage of stages) {
    const ok = stage.fromBaseId !== null && stage.toBaseId !== null;
    if (!ok) {
      close();
      continue;
    }
    const continues = run.length > 0 && beds[beds.length - 1] === stage.fromBaseId && !beds.includes(stage.toBaseId!);
    if (!continues) {
      close();
      beds = [stage.fromBaseId!];
    }
    run.push(stage);
    beds.push(stage.toBaseId!);
  }
  close();
  return best;
}

/** The record the stay decision carries. */
export function trailStageRecord(stage: ResolvedTrailStage, nameOf: (baseId: string) => string | undefined, dayNumber?: number): TrailStageRecord {
  return {
    placeId: stage.placeId,
    name: stage.name,
    order: stage.order,
    fromBaseId: stage.fromBaseId,
    toBaseId: stage.toBaseId,
    fromName: stage.fromBaseId ? nameOf(stage.fromBaseId) ?? null : null,
    toName: stage.toBaseId ? nameOf(stage.toBaseId) ?? null : null,
    km: stage.km,
    ascentM: stage.ascentM,
    distanceBasis: stage.distanceBasis,
    walkMinutes: stage.walkMinutes,
    resolution: stage.resolution,
    ...(dayNumber !== undefined ? { dayNumber } : {}),
    ...(stage.latestStartMinute !== undefined ? { latestStartMinute: stage.latestStartMinute } : {}),
    ...(stage.duskMinute !== undefined ? { duskMinute: stage.duskMinute } : {}),
    ...(stage.note ? { note: stage.note } : {}),
    ...(stage.part ? { part: stage.part } : {}),
  };
}
