import type { MobilityPattern } from '../operating/model';
import type { TravelSegment } from '../schemas/itinerary';

/**
 * V12.2 §2 §3 — A WALK HAS TO BE A WALK SOMEBODY WOULD ACTUALLY TAKE.
 *
 * ── WHAT SHIPPED ───────────────────────────────────────────────────────────
 *
 * The V12.1 Greek acceptance put **nine walking legs over three kilometres**
 * into a finished itinerary, and the worst of them was:
 *
 *     Naxos → Halki · 218 km straight line · 273 km estimated · 3,640 minutes
 *
 * **Sixty hours of walking**, priced at 4.5 km/h and rendered as an ordinary
 * travel row. Two defects stacked: "Halki" — a village in the middle of Naxos —
 * was placed on Halki *island* 218 km away, and nothing then asked whether the
 * resulting walk was a thing a person does.
 *
 * ── WHY THE EXISTING GUARD DID NOT FIRE ────────────────────────────────────
 *
 * `plausibleModeFor` (V11 §11) exists for exactly this and its rule is right:
 * *a correction may only produce a mode the trip actually uses*. That rule is
 * what stopped a Kyrgyz trek transfer becoming a bus on a trip with no buses.
 *
 * The Greek traveller answered "boats and local transfers" and "not driving", so
 * the trip had **no road mode at all** — and with nothing to substitute, the
 * correction kept the walk. The rule is sound; the **fallback** was wrong.
 * Keeping an implausible figure is worse than having none, because a figure is
 * believed and an absence is not.
 *
 * So this module adds the third answer. A walk is plausible, or it is
 * substitutable, or it is **refused** — and a refused leg keeps its endpoints
 * and loses only its claim, exactly as V11 §11 does for a refused measurement.
 *
 * ── AND NOT EVERY LONG WALK IS WRONG (§2) ──────────────────────────────────
 *
 * One cutoff cannot work. A four-kilometre wander through a city's quarters is
 * the afternoon's plan; a four-kilometre transfer with luggage is a mistake; an
 * eight-kilometre trek stage is the trip. What separates them is not distance
 * but **what the walk is for**, so that is what is classified first.
 *
 * Pure: no provider, no clock, no model.
 */

/** What a walking leg is *for*. Only a transfer faces transfer-distance expectations. */
export const WALK_PURPOSES = [
  /** The walking is the point: a trail stage, a coast path, a quarter explored on foot. */
  'activity_walk',
  /** Getting from A to B because the plan needs you at B. */
  'transfer_walk',
  /** Between one base and the next, usually with luggage. The least forgiving of the three. */
  'base_transfer_walk',
] as const;
export type WalkPurpose = (typeof WALK_PURPOSES)[number];

export const WALK_VERDICTS = [
  /** A walk a person would take. Nothing changes. */
  'plausible',
  /** Too far to walk, and the trip has a mode that could carry it. */
  'substitute',
  /** Too far to walk, and nothing else is supportable. The leg keeps its ends and loses its figure. */
  'refuse',
] as const;
export type WalkVerdict = (typeof WALK_VERDICTS)[number];

export interface WalkAssessment {
  purpose: WalkPurpose;
  verdict: WalkVerdict;
  /** The distance the verdict was reached on, and where it came from. */
  km: number | null;
  basis: 'measured' | 'geodesic' | 'none';
  /** The ceiling applied, so a finding can explain itself rather than assert. */
  ceilingKm: number;
  /** One sentence for the audit. Traveller wording is composed elsewhere (§13). */
  note: string;
}

/**
 * How far each kind of walk may reasonably run, in kilometres.
 *
 * These are **ceilings on ordinary cases**, adjusted below by what the trip is
 * and who is walking. Deliberately not one number: the whole point of §2.
 *
 * `activity_walk` is generous because a walk somebody chose is bounded by their
 * own appetite, which the interview already asked about, rather than by a rule
 * here. `base_transfer_walk` is the tightest because it is the one with the
 * suitcase.
 */
const BASE_CEILING_KM: Record<WalkPurpose, number> = {
  activity_walk: 25,
  transfer_walk: 3,
  base_transfer_walk: 2,
};

/** Trips whose whole shape is walking give their activity walks more room. */
const PATTERN_ACTIVITY_BONUS: Partial<Record<MobilityPattern, number>> = {
  trail: 20,
  walk_and_transit: 2,
};

export interface WalkContext {
  /** The leg, as persisted. Only the fields a walk verdict can legitimately read. */
  segment: Pick<TravelSegment, 'role' | 'km' | 'hint' | 'episode' | 'episodeMode' | 'estimate' | 'provenance'>;
  /** Straight-line distance between the two ends, when both are placed. */
  straightLineKm?: number | null | undefined;
  /** How this kind of trip moves. Absent means no policy was derived. */
  mobilityPattern?: MobilityPattern | undefined;
  /** What the traveller said they would walk, in minutes, when the interview asked. */
  maxWalkMinutes?: number | undefined;
  /** True when the party has a recorded mobility limitation. */
  mobilityLimited?: boolean | undefined;
  /** True when the draft names this leg as something to *do* rather than a way to arrive. */
  statedAsActivity?: boolean | undefined;
}

/**
 * What this walk is for.
 *
 * Read from the plan rather than guessed from distance, which would make the
 * classification circular. Four affirmative signals, each of which the plan
 * states for its own reasons:
 *
 *   - the leg moves between two bases                 → base transfer
 *   - it is inside a multi-day experience that walks  → activity
 *   - the draft's own transport word is a trail       → activity
 *   - the caller says the plan names it as a thing to do → activity
 *
 * Everything else is a transfer, which is the honest default: a leg with
 * nothing said about it is a way of arriving.
 */
export function walkPurposeOf(context: WalkContext): WalkPurpose {
  const { segment } = context;
  if (segment.role === 'transfer') return 'base_transfer_walk';
  if (context.statedAsActivity) return 'activity_walk';
  if (segment.episode && (segment.episodeMode === 'walk' || segment.episodeMode === 'horse')) return 'activity_walk';
  if (segment.hint === 'walk' && segment.episode) return 'activity_walk';
  return 'transfer_walk';
}

/** The ceiling for this walk, after the trip and the traveller have had their say. */
export function walkCeilingKm(purpose: WalkPurpose, context: WalkContext): number {
  let ceiling = BASE_CEILING_KM[purpose];
  if (purpose === 'activity_walk' && context.mobilityPattern) ceiling += PATTERN_ACTIVITY_BONUS[context.mobilityPattern] ?? 0;
  /*
   * A city trip walks further between its stops than a driving one does, and
   * says so through its own mobility pattern rather than through a guess about
   * urban density.
   */
  if (purpose === 'transfer_walk' && context.mobilityPattern === 'walk_and_transit') ceiling += 1.5;
  if (purpose === 'transfer_walk' && context.mobilityPattern === 'trail') ceiling += 5;
  /*
   * What the traveller said they would walk, converted at an ordinary pace —
   * and applied to **transfers only**.
   *
   * The field is `maxAccessWalkMinutes`: how far somebody will walk *to reach*
   * a stop. It is not a statement about how long a walk they would enjoy. A
   * traveller who will walk twenty-five minutes from a bus stop may still want
   * the two-hour coastal path that is the whole point of the afternoon, and
   * capping an activity walk with an access tolerance reads a limit the
   * traveller never set.
   *
   * A stated limit only ever *lowers* a transfer ceiling; it never raises one.
   */
  if (purpose !== 'activity_walk' && context.maxWalkMinutes !== undefined) ceiling = Math.min(ceiling, (context.maxWalkMinutes / 60) * 4.5);
  if (context.mobilityLimited) ceiling = Math.min(ceiling, 1.5);
  return Math.round(ceiling * 10) / 10;
}

/**
 * Whether this walk is one a person would take, and what to do if not.
 *
 * `substitutable` is the caller's answer, not this module's: only the caller
 * knows which modes the trip actually uses, and inventing one here is the
 * mistake V11 §11 exists to prevent. This says *whether* a substitute is
 * needed; the caller says whether one exists.
 */
export function assessWalk(context: WalkContext, substitutable: boolean): WalkAssessment {
  const purpose = walkPurposeOf(context);
  const ceilingKm = walkCeilingKm(purpose, context);

  /*
   * The distance, and where it came from. A measured road distance is the best
   * evidence; a straight line is a **lower bound** and is therefore safe to
   * refuse on — a walk that is already too far as the crow flies is further on
   * the ground. An estimate's own `approxKm` is a detour-adjusted figure and is
   * used only when nothing better exists.
   */
  const measured = context.segment.provenance === 'measured' ? (context.segment.km ?? null) : null;
  const geodesic = context.straightLineKm ?? context.segment.estimate?.straightLineKm ?? null;
  const km = measured ?? geodesic;
  const basis: WalkAssessment['basis'] = measured !== null ? 'measured' : geodesic !== null ? 'geodesic' : 'none';

  if (km === null) {
    return { purpose, verdict: 'plausible', km: null, basis, ceilingKm, note: 'Nothing places both ends of this walk, so its length is unknown and it is left as it is.' };
  }
  if (km <= ceilingKm) {
    return { purpose, verdict: 'plausible', km, basis, ceilingKm, note: `${km.toFixed(1)} km on foot, within the ${ceilingKm} km this kind of walk runs to.` };
  }
  return {
    purpose,
    verdict: substitutable ? 'substitute' : 'refuse',
    km,
    basis,
    ceilingKm,
    note: substitutable
      ? `${Math.round(km)} km is past the ${ceilingKm} km this kind of walk runs to; the trip has another way to cover it.`
      : `${Math.round(km)} km is past the ${ceilingKm} km this kind of walk runs to, and this trip has no other way to cover it, so no journey time is claimed.`,
  };
}

/**
 * Whether a distance is so far past walking that it is evidence of a **placement
 * error** rather than of an ambitious day.
 *
 * Separate from the ceiling, and deliberately much higher, because the two mean
 * different things. Twenty kilometres is a walk nobody would take; two hundred
 * is a stop in the wrong place — the Halki defect, where a village on Naxos was
 * matched to an island in the Dodecanese. A finding that says "too far to walk"
 * about 273 km is true and useless; the useful sentence is "this stop is not
 * where we put it".
 */
export const WALK_SUGGESTS_MISPLACEMENT_KM = 60;

export function walkSuggestsMisplacement(assessment: WalkAssessment): boolean {
  return assessment.km !== null && assessment.km >= WALK_SUGGESTS_MISPLACEMENT_KM;
}
