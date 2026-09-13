import type { TransportMode } from '../schemas/access';
import type { ItineraryItem, TravelSegment } from '../schemas/itinerary';

/**
 * TRAVEL-TIME SEMANTICS — ONE CANONICAL STATE, AND AN HONEST ESTIMATOR.
 *
 * The founder's Ireland trip printed "09:30 Dublin · 09:30 Kilkenny" because
 * a leg nobody measured was scheduled as a leg that takes no time. This module
 * owns the vocabulary that makes that impossible:
 *
 *   measured        a router or provider timed this exact pair
 *   scheduled       a published timetable
 *   model_estimate  the composing model's own figure (not used on the wire today)
 *   geo_estimate    Sidequest's estimate from resolved coordinates — great-circle
 *                   distance × a mode detour factor, at a distance-banded speed
 *   unknown         nothing at all; the schedule holds a conservative allowance
 *                   and the day is shown in time bands, never fake minutes
 *
 * A geo estimate is an ESTIMATE. It is never labelled measured, its km is never
 * persisted as a road distance, and it never triggers a hard-constraint removal
 * (only affirmative measured evidence corrects; see `reconcile.ts`). It exists
 * so that the clock advances by a believable amount between two places that
 * are really 90 km apart.
 */
export const TRAVEL_DURATION_STATES = ['measured', 'scheduled', 'model_estimate', 'geo_estimate', 'unknown'] as const;
export type TravelDurationState = (typeof TRAVEL_DURATION_STATES)[number];

export function travelDurationStateOf(segment: Pick<TravelSegment, 'provenance' | 'basis' | 'minutes' | 'estimateKind' | 'unverifiedScheduled'>): TravelDurationState {
  if (segment.minutes === null || segment.provenance === 'unmeasured') return 'unknown';
  if (segment.provenance === 'official') return segment.unverifiedScheduled ? 'model_estimate' : 'scheduled';
  if (segment.provenance === 'measured') return segment.basis === 'scheduled' ? 'scheduled' : segment.basis === 'estimated' ? 'geo_estimate' : 'measured';
  if (segment.estimateKind === 'model') return 'model_estimate';
  return 'geo_estimate';
}

/** Which of the traveller-facing time styles a leg or item earns. */
export type TimePrecision = 'fixed' | 'measured' | 'estimated' | 'band';

export function timePrecisionOf(state: TravelDurationState): TimePrecision {
  switch (state) {
    case 'scheduled':
      return 'fixed';
    case 'measured':
      return 'measured';
    case 'model_estimate':
    case 'geo_estimate':
      return 'estimated';
    case 'unknown':
      return 'band';
  }
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Two points closer than this are the same place for scheduling purposes: no leg, no minutes. */
export const COLOCATED_KM = 0.15;

/**
 * Mode-dependent estimator. Speeds are deliberately conservative and banded by
 * straight-line distance because a 3 km hop is streets and a 90 km hop is
 * national road; the detour factor turns crow-flies into road-ish distance
 * without pretending to know the road. Overhead covers parking, finding the
 * entrance, waiting for a bus.
 */
interface ModeModel {
  detour: number;
  overheadMinutes: number;
  /** [uptoStraightKm, kmh] bands, ascending; the last applies beyond. */
  speedBands: readonly [number, number][];
}

const MODE_MODELS: Record<'drive' | 'walk' | 'transit' | 'bicycle', ModeModel> = {
  drive: { detour: 1.3, overheadMinutes: 8, speedBands: [[3, 22], [10, 32], [30, 48], [80, 62], [Number.POSITIVE_INFINITY, 72]] },
  walk: { detour: 1.25, overheadMinutes: 2, speedBands: [[Number.POSITIVE_INFINITY, 4.5]] },
  transit: { detour: 1.35, overheadMinutes: 12, speedBands: [[5, 14], [25, 24], [Number.POSITIVE_INFINITY, 45]] },
  bicycle: { detour: 1.25, overheadMinutes: 4, speedBands: [[Number.POSITIVE_INFINITY, 14]] },
};

function modelFor(mode: TransportMode): ModeModel | null {
  switch (mode) {
    case 'drive':
    case 'rideshare':
    case 'private_transfer':
    case 'shuttle':
      return MODE_MODELS.drive;
    case 'walk':
      return MODE_MODELS.walk;
    case 'public_bus':
    case 'rail':
      return MODE_MODELS.transit;
    case 'bicycle':
      return MODE_MODELS.bicycle;
    default:
      return null; // ferry, unsupported: no honest estimate without a timetable
  }
}

export interface GeoEstimate {
  minutes: number;
  straightLineKm: number;
  /** Road-ish distance implied by the detour factor — reported as approximate, never as a measured km. */
  approxKm: number;
  kmh: number;
}

/**
 * An estimate for a leg between two resolved points, or null when the mode
 * cannot be estimated from geometry (a ferry, a flight). Rounded to 5 minutes
 * so it never reads as precision it does not have.
 */
export function estimateLegMinutes(input: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; mode: TransportMode }): GeoEstimate | null {
  const model = modelFor(input.mode);
  if (!model) return null;
  const straightLineKm = haversineKm(input.from, input.to);
  if (straightLineKm <= COLOCATED_KM) return { minutes: 0, straightLineKm, approxKm: 0, kmh: 0 };
  const kmh = model.speedBands.find(([upto]) => straightLineKm <= upto)?.[1] ?? model.speedBands[model.speedBands.length - 1]![1];
  const approxKm = straightLineKm * model.detour;
  const raw = (approxKm / kmh) * 60 + model.overheadMinutes;
  const minutes = Math.max(5, Math.round(raw / 5) * 5);
  return { minutes, straightLineKm, approxKm: Math.round(approxKm), kmh };
}

/** Beyond this straight-line distance a "walk" between two stops is not a walk. */
export const MAX_PLAUSIBLE_WALK_KM = 3;
/** Beyond this, a bicycle hint between stops is a ride, not an errand; kept generous. */
export const MAX_PLAUSIBLE_BICYCLE_KM = 40;

/**
 * How the trip's ground travel is actually arranged, as the correction below
 * needs to know it. V11 §10.
 *
 * This is the *trip's* contract, not the traveller's licence. A group with a
 * private driver `canDrive: false` — they are not driving — but their ground
 * mode is emphatically a car, and answering "bus" for them is a substitution
 * the trip does not contain.
 */
export type GroundArrangement = 'self_drive' | 'driver' | 'taxi' | 'operator' | 'transit' | 'none';

/**
 * The mode the trip itself uses on the ground, or null when it has no road mode
 * at all. This is what a corrected leg becomes.
 */
export function groundModeFor(arrangement: GroundArrangement): TransportMode | null {
  switch (arrangement) {
    case 'self_drive':
      return 'drive';
    case 'driver':
      return 'private_transfer';
    case 'taxi':
      return 'rideshare';
    case 'operator':
      return 'shuttle';
    case 'transit':
      return 'public_bus';
    case 'none':
      return null;
  }
}

/**
 * The mode that can plausibly carry this leg given the geometry and how the
 * trip moves. A walk hint over 3 km of open country becomes the trip's own
 * ground mode; ferries and transfers are never overridden (the router cannot
 * see them and geometry says nothing).
 *
 * V11 §10 — WHAT THE CORRECTION MAY SUBSTITUTE.
 *
 * This used to answer `canDrive ? 'drive' : 'public_bus'`, and on the founder's
 * Kyrgyzstan trip — private driver and guides for every transfer, explicitly no
 * self-driving — `canDrive` was false, so a 22 km leg to a trek trailhead was
 * corrected to **"Bus to Altyn-Arashan valley"**. The trip has no bus in it. A
 * correction may only ever produce a mode the trip actually uses; where the
 * trip has no ground mode at all, the hint stands uncorrected and the leg stays
 * honest about being unmeasurable rather than being handed an invented one.
 */
export function plausibleModeFor(input: {
  hinted: TransportMode;
  straightLineKm: number | null;
  /** How the trip's ground travel is arranged. Preferred over `canDrive`, which is only a fallback for callers that have not been given one. */
  arrangement?: GroundArrangement | undefined;
  canDrive: boolean;
  transitTrip: boolean;
}): { mode: TransportMode; corrected: boolean } {
  const { hinted, straightLineKm } = input;
  if (straightLineKm === null) return { mode: hinted, corrected: false };
  const ground =
    input.arrangement !== undefined
      ? groundModeFor(input.arrangement)
      : /*
         * No arrangement stated. What the traveller can do is the fallback, and
         * where they neither drive nor are on a transit trip the honest answer
         * is a road leg somebody else drives — never a bus, which is a service
         * that either exists or does not and which nothing here has checked.
         */
        input.canDrive
        ? 'drive'
        : input.transitTrip
          ? 'public_bus'
          : 'rideshare';
  if (ground === null) return { mode: hinted, corrected: false };
  if (hinted === 'walk' && straightLineKm > MAX_PLAUSIBLE_WALK_KM) return { mode: ground, corrected: true };
  if (hinted === 'bicycle' && straightLineKm > MAX_PLAUSIBLE_BICYCLE_KM) return { mode: ground, corrected: true };
  return { mode: hinted, corrected: false };
}

/**
 * The allowance a schedule holds for a leg nobody could time and nobody can
 * estimate (no coordinates on one end). Conservative and mode-aware; the day
 * is shown in bands, so the exact figure is never presented as a clock time.
 */
export function unknownLegAllowanceMinutes(input: { mode: TransportMode; sameLocality: boolean; role: TravelSegment['role'] }): number {
  if (input.sameLocality) return input.mode === 'walk' ? 15 : 20;
  if (input.role === 'transfer') return 120;
  return input.mode === 'walk' ? 25 : 60;
}

/** A day is only as precise as its least precise leg. */
export function dayPrecisionOf(items: readonly Pick<ItineraryItem, 'kind' | 'travel'>[]): TimePrecision {
  let precision: TimePrecision = 'measured';
  for (const item of items) {
    if (item.kind !== 'travel' || !item.travel || item.travel.fromId === item.travel.toId) continue;
    const state = travelDurationStateOf(item.travel);
    const p = timePrecisionOf(state);
    if (p === 'band') return 'band';
    if (p === 'estimated') precision = 'estimated';
  }
  return precision;
}

/** Day-part bands used when a day cannot honestly show minutes. */
export function dayPartFor(minute: number): string {
  if (minute < 9 * 60) return 'Early morning';
  if (minute < 11 * 60 + 30) return 'Morning';
  if (minute < 13 * 60 + 30) return 'Late morning';
  if (minute < 17 * 60) return 'Afternoon';
  if (minute < 19 * 60 + 30) return 'Early evening';
  return 'Evening';
}
