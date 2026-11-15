import { haversineKm } from '../travel/estimate';
import { twilightFor, TWILIGHT_DEPRESSION_DEGREES } from '../weather/solar';
import { utcOffsetMinutesOn, zoneFitsLongitude } from '../time/zone';
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
  /** Which piece of a split stage this is, 1 first; a later piece's `placeId` and `key` are the first's with `~2`, `~3`. */
  part?: number;
  /** Where a split stage breaks: the intermediate overnight. */
  splitAt?: { baseId: string; name: string; at: Point };
  /** A gap in the trail before this stage, in km: the proposal named no stage between the last one's end and this one's start, so the way there is ridden. */
  gapBeforeKm?: number;
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
 * A gap in the trail no more than this long — between where one walked section
 * ends and the next begins — is ridden (a bus or a taxi from tonight's bed to
 * where the walk resumes); a section farther than this from the rest is not
 * part of the same walk.
 */
export const STAGE_GAP_MAX_KM = 40;
/** A stage ending this close to where the sequence already ended walks ground it has already covered. */
export const STAGE_OVERLAP_KM = 2;
/** The most sequences of sections the ordering compares; far beyond any real proposal. */
const SECTION_SEARCH_BUDGET = 20000;

/**
 * The proposal's one-way walks as one ordered sequence along the trail.
 *
 * Final pass — a proposal rarely names every stage: a live Kumano scan gave
 * the trail's first stage, a gap, three joined stages and a separate final
 * section. Following only the longest contiguous run left the other sections
 * to be scheduled as day trips in any order (the trail's start on day 7). So
 * the stages are first joined into contiguous sections (each starts where the
 * last ended, within `STAGE_JOIN_KM`), and the sections are then put in one
 * order: the one that walks the most stages, then the shortest total gap
 * between sections, the model's own stage numbers only ever breaking a tie.
 * A section after a gap carries `gapBeforeKm` (the ride from the last bed to
 * where the walk resumes). A section farther than `STAGE_GAP_MAX_KM` from the
 * rest, or one that ends where the sequence already ended, is reported and
 * left out. Order is decided by where the stages are, never by their names.
 */
export function orderTrailStages(input: {
  candidates: readonly TrailStageInput[];
  positionOf: (key: string) => Point | null;
  measured?: ReadonlyMap<string, MeasuredStage>;
}): { stages: TrailStage[]; dropped: { name: string; reason: string }[] } {
  const dropped: { name: string; reason: string }[] = [];
  type Eligible = TrailStage & { stated?: number; index: number };
  const eligible: Eligible[] = [];
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
  /* Walking on to somewhere new: a stage that ends where the last one ended, or back where it began, covers ground already walked. */
  const progresses = (a: TrailStage, b: TrailStage) => haversineKm(a.end, b.end) > STAGE_OVERLAP_KM && haversineKm(a.start, b.end) > STAGE_OVERLAP_KM;
  /* The model's stated order, then its proposal order: only ever a tie-break between stages that genuinely join. */
  const rank = (s: { stated?: number; index: number }) => (s.stated ?? 1000) * 1000 + s.index;
  const chainFrom = (head: Eligible, pool: readonly Eligible[]) => {
    const chain = [head];
    const used = new Set([head.key]);
    for (;;) {
      const at = chain[chain.length - 1]!;
      const next = pool
        .filter((s) => !used.has(s.key) && joins(at, s) && progresses(at, s))
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
  /* 1. Contiguous sections: the longest run first, then the longest among what is left, and so on. */
  const sections: Eligible[][] = [];
  let left = eligible.slice();
  while (left.length > 0) {
    const heads = left.filter((s) => !left.some((o) => o !== s && joins(o, s) && progresses(o, s)));
    const tries = (heads.length > 0 ? heads : left).slice().sort((a, b) => rank(a) - rank(b));
    let best: Eligible[] = [];
    for (const head of tries) {
      const chain = chainFrom(head, left);
      if (chain.length > best.length) best = chain;
    }
    sections.push(best);
    const used = new Set(best.map((s) => s.key));
    left = left.filter((s) => !used.has(s.key));
  }
  /* 2. One order over the sections: the most stages, then the least riding between sections, then the stated order. */
  const firstRank = (section: readonly Eligible[]) => rank(section[0]!);
  type Order = { path: number[]; stages: number; gapKm: number; inversions: number };
  const ends = (path: readonly number[]) => path.flatMap((i) => sections[i]!.map((s) => s.end));
  const better = (a: Order, b: Order | null) => {
    if (!b) return true;
    if (a.stages !== b.stages) return a.stages > b.stages;
    if (Math.abs(a.gapKm - b.gapKm) > 0.5) return a.gapKm < b.gapKm;
    if (a.inversions !== b.inversions) return a.inversions < b.inversions;
    return a.path.map((i) => firstRank(sections[i]!)).join(',') < b.path.map((i) => firstRank(sections[i]!)).join(',');
  };
  let bestOrder: Order | null = null;
  let budget = SECTION_SEARCH_BUDGET;
  const visit = (path: number[], stages: number, gapKm: number, inversions: number) => {
    budget -= 1;
    const here: Order = { path: [...path], stages, gapKm, inversions };
    if (better(here, bestOrder)) bestOrder = here;
    if (budget <= 0 || stages >= MAX_TRAIL_STAGES) return;
    const last = sections[path[path.length - 1]!]!;
    const lastStage = last[last.length - 1]!;
    const walked = ends(path);
    for (let i = 0; i < sections.length; i += 1) {
      if (path.includes(i)) continue;
      const section = sections[i]!;
      const gap = haversineKm(lastStage.end, section[0]!.start);
      if (gap > STAGE_GAP_MAX_KM) continue;
      if (section.some((s) => walked.some((e) => haversineKm(e, s.end) <= STAGE_OVERLAP_KM)) || !progresses(lastStage, section[0]!)) continue;
      const stated = (s: Eligible) => s.stated;
      const inv = path.reduce((n, j) => n + sections[j]!.filter((a) => section.some((b) => stated(a) !== undefined && stated(b) !== undefined && stated(a)! > stated(b)!)).length, 0);
      path.push(i);
      visit(path, stages + section.length, gapKm + gap, inversions + inv);
      path.pop();
    }
  };
  sections.forEach((_, i) => visit([i], sections[i]!.length, 0, 0));
  const chosen = (bestOrder as Order | null)?.path ?? [0];
  const flat: (Eligible & { gapBeforeKm?: number })[] = [];
  chosen.forEach((i, n) => {
    sections[i]!.forEach((stage, k) => {
      if (flat.length >= MAX_TRAIL_STAGES) return;
      const previous = flat[flat.length - 1];
      flat.push(n > 0 && k === 0 && previous ? { ...stage, gapBeforeKm: Math.round(haversineKm(previous.end, stage.start) * 10) / 10 } : stage);
    });
  });
  const kept = new Set(flat.map((s) => s.key));
  const keptEnds = flat.map((s) => s.end);
  for (const s of eligible) {
    if (kept.has(s.key)) continue;
    const overlaps = keptEnds.some((e) => haversineKm(e, s.end) <= STAGE_OVERLAP_KM);
    dropped.push({ name: s.name, reason: overlaps ? 'It ends where another stage already ends, so it walks ground the trail already covers and stays a walk of its own.' : 'It does not join the stages before and after it, so it stays a walk of its own.' });
  }
  const stages = flat.map(({ stated: _stated, index: _index, ...stage }, i) => ({ ...stage, order: i + 1 }));
  return { stages, dropped };
}

/** Civil dusk at a point on a date, minutes from local midnight; null when it cannot honestly be said (no trusted zone, a white night). */
export function civilDuskMinute(point: Point, date: string, timeZone: string | undefined): number | null {
  if (!timeZone || (/^(Etc\/)?(UTC|GMT)$/i.test(timeZone) && Math.abs(point.lng) > 22.5) || !zoneFitsLongitude(timeZone, point.lng)) return null;
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

/**
 * A point a long stage could break at for the night that is not one of the
 * proposal's beds: where another proposed walk starts or ends, or a small town
 * the scan placed. Splitting there adds a place to sleep the traveller has to
 * book; the assembler makes it a stay of its own (`assemble.ts`).
 */
export type TrailWaypoint = TrailBed;

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
 * Where a point sits against the straight line from `start` to `end`: how far
 * along it (0 at the start, 1 at the end) and how far off it, in km. A local
 * flat projection; a stage is tens of kilometres, where that is exact enough.
 */
export function corridorPosition(start: Point, end: Point, point: Point): { along: number; offKm: number } {
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos((((start.lat + end.lat) / 2) * Math.PI) / 180);
  const ex = (end.lng - start.lng) * kmPerLng;
  const ey = (end.lat - start.lat) * kmPerLat;
  const px = (point.lng - start.lng) * kmPerLng;
  const py = (point.lat - start.lat) * kmPerLat;
  const length2 = ex * ex + ey * ey;
  if (length2 === 0) return { along: 0, offKm: Math.hypot(px, py) };
  const along = (px * ex + py * ey) / length2;
  const t = Math.max(0, Math.min(1, along));
  return { along, offKm: Math.hypot(px - t * ex, py - t * ey) };
}

/** A split point must lie between a tenth and nine tenths of the way along the stage… */
const SPLIT_ALONG_MIN = 0.1;
/** …and within this corridor of the straight line: a fifth of the stage's length, never less than 2 km. */
const SPLIT_CORRIDOR_SHARE = 0.2;
const SPLIT_CORRIDOR_MIN_KM = 2;
/** A stage too long for one day is broken into at most this many walking days. */
export const MAX_STAGE_PARTS = 3;
/** Between two nearly equally balanced splits, one at a proposed bed wins unless the other is this much better balanced. */
const BED_PREFERENCE = 0.1;

type SplitPoint = TrailBed & { bed: boolean };
type Part = Pick<TrailStage, 'km' | 'ascentM' | 'walkMinutes'> & { start: Point; end: Point };

/** The points that lie on the way along a stage, in walking order. Pure geometry: nothing is measured here. */
export function splitPointsAlong(stage: Pick<TrailStage, 'start' | 'end'>, points: readonly SplitPoint[]): (SplitPoint & { along: number })[] {
  const straight = haversineKm(stage.start, stage.end);
  if (straight <= 2) return [];
  const corridor = Math.max(SPLIT_CORRIDOR_MIN_KM, SPLIT_CORRIDOR_SHARE * straight);
  const seen = new Set<string>();
  return points
    .map((p) => ({ ...p, ...corridorPosition(stage.start, stage.end, p.coordinates), a: haversineKm(stage.start, p.coordinates), b: haversineKm(p.coordinates, stage.end) }))
    .filter((p) => p.along >= SPLIT_ALONG_MIN && p.along <= 1 - SPLIT_ALONG_MIN && p.a > 1 && p.b > 1 && (p.offKm <= corridor || p.a + p.b <= SPLIT_DETOUR_RATIO * straight))
    .sort((x, y) => x.along - y.along || Number(y.bed) - Number(x.bed) || x.id.localeCompare(y.id))
    /* Two points in the same square kilometre or so are one place to break, the bed first. */
    .filter((p) => {
      const key = `${Math.round(p.coordinates.lat * 100)}:${Math.round(p.coordinates.lng * 100)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ a: _a, b: _b, offKm: _off, ...p }) => p);
}

/** The figures of one piece of a stage: its share of the distance and climb (stated as a share, never measured), the walking time from them. */
function partOf(stage: TrailStage, from: number, to: number, start: Point, end: Point): Part {
  const share = Math.max(0, to - from);
  const km = stage.km !== null ? Math.round(stage.km * share * 10) / 10 : null;
  const ascentM = stage.ascentM !== null ? Math.round(stage.ascentM * share) : null;
  return { km, ascentM, walkMinutes: km !== null ? walkingMinutes(km, ascentM ?? 0) : Math.round(stage.walkMinutes * share), start, end };
}

/** How hard the hardest day of a split is against the party's limits: 1 is exactly at a limit. Lower is better balanced. */
function heaviest(parts: readonly Part[], limits: TrailLimits): number {
  return Math.max(...parts.map((p) => Math.max(p.walkMinutes / limits.walkMinutes, p.ascentM !== null ? p.ascentM / limits.ascentM : 0)));
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and then ${names[names.length - 1]}`;
}

/**
 * The best way to break a stage: one night on the way if any single point
 * makes both days walkable, else two. Among the walkable splits, the one whose
 * hardest day is lightest, a proposed bed preferred when it is nearly as good.
 */
function bestStageSplit(stage: TrailStage, along: readonly (SplitPoint & { along: number })[], limits: TrailLimits, contextAt: (offset: number) => StageContext): { parts: Part[]; at: SplitPoint[] } | null {
  const shareOf = (p: SplitPoint) => {
    const a = haversineKm(stage.start, p.coordinates);
    return a / (a + haversineKm(p.coordinates, stage.end));
  };
  const walkable = (parts: readonly Part[]) => parts.every((part, i) => assessTrailStage({ ...stage, ...part }, limits, contextAt(i)).ok);
  type Option = { parts: Part[]; at: SplitPoint[]; load: number; beds: number };
  const pick = (options: readonly Option[]): Option | null => {
    if (options.length === 0) return null;
    const lightest = Math.min(...options.map((o) => o.load));
    return [...options].filter((o) => o.load <= lightest + BED_PREFERENCE).sort((x, y) => y.beds - x.beds || x.load - y.load || x.at.map((p) => p.id).join().localeCompare(y.at.map((p) => p.id).join()))[0]!;
  };
  const singles: Option[] = [];
  for (const p of along) {
    const s = shareOf(p);
    const parts = [partOf(stage, 0, s, stage.start, p.coordinates), partOf(stage, s, 1, p.coordinates, stage.end)];
    if (walkable(parts)) singles.push({ parts, at: [p], load: heaviest(parts, limits), beds: Number(p.bed) });
  }
  const one = pick(singles);
  if (one) return { parts: one.parts, at: one.at };
  if (MAX_STAGE_PARTS < 3) return null;
  const doubles: Option[] = [];
  for (let i = 0; i < along.length; i += 1) {
    for (let j = i + 1; j < along.length; j += 1) {
      const p = along[i]!;
      const q = along[j]!;
      const s1 = shareOf(p);
      /* The second point's share of the whole stage, along the way through the first. */
      const a = haversineKm(stage.start, p.coordinates) + haversineKm(p.coordinates, q.coordinates);
      const s2 = a / (a + haversineKm(q.coordinates, stage.end));
      if (s2 <= s1) continue;
      const parts = [partOf(stage, 0, s1, stage.start, p.coordinates), partOf(stage, s1, s2, p.coordinates, q.coordinates), partOf(stage, s2, 1, q.coordinates, stage.end)];
      if (walkable(parts)) doubles.push({ parts, at: [p, q], load: heaviest(parts, limits), beds: Number(p.bed) + Number(q.bed) });
    }
  }
  const two = pick(doubles);
  return two ? { parts: two.parts, at: two.at } : null;
}

/**
 * Each stage judged for this party, in order. A stage that does not suit for
 * length, climbing or daylight is split for the night at a point on the way —
 * a proposed bed, or a point where another walk starts or ends, or a placed
 * small town — choosing the split whose hardest day is lightest, into at most
 * `MAX_STAGE_PARTS` days. A split needs a spare day in the trip (a free or
 * rest day it uses up); without one the usual way round the proposal named is
 * taken first, and only then the split, which then costs the trail's last
 * stage. Else the stage is covered the usual way the proposal named, when that
 * way is open that month (unknown ≠ closed); else left as it is and said so on
 * the day, which is then not ready.
 */
export function resolveTrailStages(input: {
  stages: readonly TrailStage[];
  limits: TrailLimits;
  beds: readonly TrailBed[];
  /** Points on the way that are not proposed beds; a split there adds a night the traveller books. */
  waypoints?: readonly TrailWaypoint[];
  /** Days the trip has beyond one per stage; each extra walking day a split adds uses one. Absent: unknown, never a reason not to split. */
  spareDays?: number;
  contextFor: (index: number, stage: TrailStage) => StageContext;
}): ResolvedTrailStage[] {
  const out: ResolvedTrailStage[] = [];
  const points: SplitPoint[] = [...input.beds.map((b) => ({ ...b, bed: true })), ...(input.waypoints ?? []).map((w) => ({ ...w, bed: false }))];
  let spare = input.spareDays ?? Number.POSITIVE_INFINITY;
  /* Waypoints a split chose sleep a night: they join the beds the stages are matched to. */
  const sleptAt: TrailBed[] = [];
  input.stages.forEach((stage, index) => {
    const context = input.contextFor(index, stage);
    const assessment = assessTrailStage(stage, input.limits, context);
    const timing = (a: StageAssessment, c: StageContext = context) => ({ ...(a.latestStartMinute !== null ? { latestStartMinute: a.latestStartMinute } : {}), ...(c.duskMinute !== null ? { duskMinute: c.duskMinute } : {}) });
    const reasons = assessment.problems.map((p) => p.detail).join('; ');
    if (assessment.ok) {
      out.push({ ...stage, resolution: 'walk', fromBaseId: null, toBaseId: null, ...timing(assessment) });
      return;
    }
    /* Only length, climbing and daylight are mended by an extra night: a closed or unsuitable section is not walked at all. */
    const splittable = assessment.problems.every((p) => p.code === 'too_long' || p.code === 'too_much_ascent' || p.code === 'after_dusk');
    const split = splittable ? bestStageSplit(stage, splitPointsAlong(stage, points), input.limits, (offset) => input.contextFor(index + offset, stage)) : null;
    const alt = stage.alternative;
    const altOpen = Boolean(alt && (!alt.openMonths || alt.openMonths.length === 0 || alt.openMonths.includes(context.month)));
    const extraDays = split ? split.at.length : 0;
    /* A split that needs a day the trip does not have yields to the usual way round, when there is one. */
    if (split && (extraDays <= spare || !altOpen)) {
      const fits = extraDays <= spare;
      if (fits) spare -= extraDays;
      const note = `Split with a night in ${joinNames(split.at.map((p) => p.name))}: walked in one day it is ${reasons}.${fits ? '' : ' The trip has no spare day for the extra walking day, so the trail ends a stage earlier.'}`;
      split.parts.forEach((part, i) => {
        const fromName = i === 0 ? null : split.at[i - 1]!.name;
        const toName = i < split.at.length ? split.at[i]!.name : null;
        const label = fromName && toName ? `${fromName} to ${toName}` : toName ? `to ${toName}` : `from ${fromName}`;
        const c = input.contextFor(index + i, stage);
        const a = assessTrailStage({ ...stage, ...part }, input.limits, c);
        const at = split.at[Math.min(i, split.at.length - 1)]!;
        const { endName: _endName, ...rest } = stage;
        out.push({
          ...rest,
          km: part.km,
          ascentM: part.ascentM,
          walkMinutes: part.walkMinutes,
          start: part.start,
          end: part.end,
          ...(toName ? { endName: toName } : stage.endName ? { endName: stage.endName } : {}),
          name: `${stage.name} (${label})`,
          placeId: i === 0 ? stage.placeId : `${stage.placeId}~${i + 1}`,
          key: i === 0 ? stage.key : `${stage.key}~${i + 1}`,
          part: i + 1,
          splitAt: { baseId: at.id, name: at.name, at: at.coordinates },
          resolution: 'split',
          note,
          fromBaseId: null,
          toBaseId: null,
          ...timing(a, c),
        });
      });
      for (const p of split.at) if (!p.bed && !sleptAt.some((b) => b.id === p.id)) sleptAt.push({ id: p.id, name: p.name, coordinates: p.coordinates });
      return;
    }
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
      note: `${capitalise(reasons)}.${splittable ? ' Nowhere to sleep was found on the way to break it.' : ''}${alt ? ` The usual alternative (${alt.mode}) does not run this month either.` : ' No usual alternative was proposed: ask the inn about a taxi or bus for part of the way, or plan a shorter day.'}`,
      ...timing(assessment),
    });
  });
  /*
   * Which bed each stage leaves from and arrives at. A stage after another one
   * leaves from the bed the last one reached — walking on when it starts there,
   * or riding the gap to where the walk resumes (`gapBeforeKm`) — never from
   * some other bed merely nearer its start: that is how a live plan "walked"
   * one stage from a hot-spring base and left the rest as day trips.
   */
  const beds = [...input.beds, ...sleptAt];
  const mapped: ResolvedTrailStage[] = [];
  out.forEach((stage, i) => {
    const previous = mapped[i - 1];
    const fromId = previous?.toBaseId ?? nearestBed(stage.start, beds, TRAIL_START_NEAR_BED_KM)?.id ?? null;
    const to = nearestBed(stage.end, beds, TRAIL_END_AT_BED_KM, fromId);
    mapped.push({ ...stage, order: i + 1, fromBaseId: fromId, toBaseId: to?.id ?? null });
  });
  return mapped;
}

/**
 * When a walking day sets off. Never later than the trip's own start; a long
 * day (five hours or more on the clock) by 08:00 and a very long one (seven or
 * more) by 07:30, whatever the trip's usual morning; and always early enough to
 * reach the next bed before civil dusk with the margin and half an hour to
 * spare, when dusk is known. Never before `EARLIEST_TRAIL_START_MINUTE`: a
 * day that would need that is already not walkable (`after_dusk`).
 */
export const LONG_STAGE_DAY_MINUTES = 300;
export const VERY_LONG_STAGE_DAY_MINUTES = 420;
export function trailStartMinute(stage: { walkMinutes: number; latestStartMinute?: number | null }, dayStartMinute: number): number {
  const day = trailDayMinutes(stage.walkMinutes);
  let start = dayStartMinute;
  if (day >= VERY_LONG_STAGE_DAY_MINUTES) start = Math.min(start, 7 * 60 + 30);
  else if (day >= LONG_STAGE_DAY_MINUTES) start = Math.min(start, 8 * 60);
  if (stage.latestStartMinute !== undefined && stage.latestStartMinute !== null) start = Math.min(start, stage.latestStartMinute - 30);
  return Math.max(EARLIEST_TRAIL_START_MINUTE, Math.floor(start / 15) * 15);
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
export function trailStageRecord(stage: ResolvedTrailStage, nameOf: (baseId: string) => string | undefined, dayNumber?: number, extra: { startMinute?: number; addedBed?: boolean } = {}): TrailStageRecord {
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
    ...(extra.startMinute !== undefined ? { startMinute: extra.startMinute } : {}),
    ...(extra.addedBed ? { addedBed: true } : {}),
    ...(stage.gapBeforeKm !== undefined ? { gapBeforeKm: stage.gapBeforeKm } : {}),
  };
}

/**
 * How the trail is fitted to this party, in one or two sentences: the daily
 * limits it is planned for, and what that changed — stages split with a night
 * on the way, covered the usual other way, still to decide, and the gaps in
 * the trail ridden between sections. Absent when nothing was adapted for an
 * unremarkable party. Every word is about walking; nothing names a trail.
 */
export function trailAdaptation(stages: readonly Pick<ResolvedTrailStage, 'resolution' | 'part' | 'gapBeforeKm' | 'alternative'>[], limits: TrailLimits, followed: boolean): string | undefined {
  const splits = stages.filter((s) => s.resolution === 'split' && s.part === 1).length;
  const ridden = stages.filter((s) => s.resolution === 'alternative' && s.alternative?.mode !== 'skip').length;
  const skipped = stages.filter((s) => s.resolution === 'alternative' && s.alternative?.mode === 'skip').length;
  const open = stages.filter((s) => s.resolution === 'unresolved').length;
  const gaps = stages.filter((s) => s.gapBeforeKm !== undefined).length;
  const special = /children|mobility|slow/.test(limits.basis);
  if (!special && splits + ridden + skipped + open + gaps === 0) return undefined;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const changes = [
    splits > 0 ? `${n(splits, 'stage', 'stages')} split with a night on the way` : null,
    ridden > 0 ? `${n(ridden, 'stage', 'stages')} covered by the usual transport instead of on foot` : null,
    skipped > 0 ? `${n(skipped, 'section', 'sections')} skipped, as walkers usually do` : null,
    open > 0 ? `${n(open, 'stage', 'stages')} still too long for this party, to decide on the day` : null,
    gaps > 0 ? `${n(gaps, 'gap', 'gaps')} in the trail ridden between walked sections` : null,
  ].filter((x): x is string => x !== null);
  const lead = `Planned for ${limits.basis}: at most about ${trailHours(limits.walkMinutes)} of walking and ${limits.ascentM} m of climbing a day`;
  const how = followed ? 'walked in the trail’s order from bed to bed' : 'walked in the trail’s order as day walks from where you sleep';
  return `${lead}, ${how}${changes.length > 0 ? `; ${changes.join(', ')}` : ''}.`;
}
