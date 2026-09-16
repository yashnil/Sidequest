import type { TravelSegment, UnmeasuredTravelReason } from '../schemas/itinerary';
import {
  controlForMode,
  routingForMode,
  scheduleForMode,
  type Journey,
  type JourneyBookingOwner,
  type JourneyEvidence,
  type JourneyRequirement,
  type JourneyTruth,
  type JourneyUnknownReason,
} from './journey';
import { isOperatorMode, travelModeFromDraft, travelModeFromEpisode, travelModeFromTransport, type TravelMode } from './vocabulary';

/**
 * V12.1 §4 — THE ADAPTER, SO NOTHING HAS TO BE REWRITTEN AT ONCE.
 *
 * §4 is explicit: do not rewrite the product around `Journey` in one risky
 * step. So `TravelSegment` is unchanged — same fields, same refinements, same
 * stored shape — and this derives a `Journey` from one whenever a surface wants
 * journey semantics. Every existing trip loads, every stored draft parses, every
 * export keeps working, and nothing needed a migration.
 *
 * The derivation is **pure and total**: any segment yields a journey, and a
 * segment carrying no hint and no episode still yields one, built from the only
 * three things it has (mode, provenance, unmeasured reason). That matters
 * because the oldest stored itineraries have exactly those three.
 *
 * ── WHERE THE MODE ACTUALLY COMES FROM ──────────────────────────────────────
 *
 * In priority order, most specific first:
 *
 *   1. `hint`        — the composing model's own word, the richest of the three
 *   2. `episodeMode` — how the multi-day experience this sits inside moves
 *   3. `mode`        — the ten-value persisted label, the lossiest
 *
 * `hint` first is what recovers the seven distinctions `transportModeFor`
 * collapsed: a leg stored as `private_transfer` with `hint: "horse"` is a horse
 * again, and one stored as `drive` with `hint: "four_wheel_drive"` stops being
 * an ordinary road journey. Nothing is invented — the hint was already on the
 * leg and already being re-parsed by three separate readers with three separate
 * string comparisons.
 */

export interface JourneyContext {
  /** Whether the shape of the trip rests on this leg (V10 §19's route-critical set). */
  routeCritical?: boolean;
  /** What a provider could have done for this mode here, from the capability registry (§9). */
  providerCanMeasureMode?: boolean;
  /** Set when an affirmative source says this journey cannot be made. Never inferred from a silence. */
  contradiction?: string;
  /** The operator the plan names for this movement, where it names one. */
  operator?: string;
  /** Whether a reservation is required, where evidence says so. Unknown is the honest default. */
  reservation?: JourneyRequirement;
}

/**
 * WHERE AN EPISODE'S OWN MOVEMENT OUTRANKS THE STOP'S WORD.
 *
 * A trek's second stage is written `transport: "walk"`, because walking is what
 * the traveller does, and it is not a walk in the sense a city block is. Inside
 * a walking episode it is a **trail**: nobody times it to the minute, the day is
 * shown in parts, and no pedestrian router should be asked. The same is true of
 * a "car" hint inside a four-wheel-drive episode and a "ferry" hint inside a
 * boat one.
 *
 * So the hint still wins — except where the episode's mode is a *refinement* of
 * it, which is this table. A refinement is always the more specific of the two
 * and never contradicts it: a trail is a walk, a 4x4 leg is a drive, an
 * operator's boat is a boat. Anything the episode says that is not a refinement
 * is a disagreement, and the stop's own word wins, because the stop is the more
 * local statement.
 */
const EPISODE_REFINES: Partial<Record<TravelMode, readonly TravelMode[]>> = {
  walk: ['trail', 'horse'],
  drive: ['four_wheel_drive'],
  ferry: ['boat'],
  private_transfer: ['operator_transfer', 'horse'],
  unknown: [],
};

/** The mode this leg really is, reading the specific evidence before the lossy label. */
export function travelModeOfSegment(segment: Pick<TravelSegment, 'mode' | 'hint' | 'episodeMode'>): TravelMode {
  const fromHint = travelModeFromDraft(segment.hint);
  const fromEpisode = travelModeFromEpisode(segment.episodeMode);
  if (fromHint !== 'unknown') {
    if (fromEpisode !== 'unknown' && (EPISODE_REFINES[fromHint] ?? []).includes(fromEpisode)) return fromEpisode;
    return fromHint;
  }
  if (fromEpisode !== 'unknown') return fromEpisode;
  return travelModeFromTransport(segment.mode);
}

/**
 * Why a journey is unknown, from the leg's own reason.
 *
 * Every mapping here preserves §11's finding: five of the six are statements
 * about Sidequest, and the sixth — `no_route_found` — is the only one that is a
 * statement about the world. It still does not produce `contradicted` on its
 * own, because V9.1 requires that a no-route verdict come from a provider that
 * evaluated *two resolved endpoints on the requested profile*, and a
 * `TravelSegment` does not record whether that was true. The caller supplies
 * `contradiction` when it knows; otherwise a no-route stays an absence.
 */
const UNKNOWN_REASON: Record<UnmeasuredTravelReason, JourneyUnknownReason> = {
  mode_not_routed: 'no_provider_for_mode',
  no_route_found: 'provider_did_not_answer',
  operator_unpublished: 'operator_has_not_published',
  not_remeasured_after_edit: 'not_required',
  provider_unavailable: 'outside_provider_coverage',
};

function truthOf(segment: TravelSegment, mode: TravelMode, context: JourneyContext): JourneyTruth {
  if (context.contradiction) return 'contradicted';
  /*
   * A stand-in is never the journey. `unverifiedScheduled` means the number on
   * this leg was measured for a *different* network than the one the traveller
   * will use — the pedestrian one standing in for a rail journey — so it cannot
   * be `measured`, and calling it `timetabled` would be worse.
   */
  if (segment.unverifiedScheduled) return 'estimated';
  switch (segment.provenance) {
    case 'measured':
      return segment.basis === 'scheduled' ? 'timetabled' : segment.basis === 'estimated' ? 'estimated' : 'measured';
    case 'official':
      return 'timetabled';
    case 'estimated':
    case 'modelled':
      return 'estimated';
    case 'unmeasured':
    default:
      /*
       * AN OPERATOR'S SILENCE IS NOT THE SAME KIND OF SILENCE AS OURS.
       *
       * A trek shuttle, a lodge transfer or a horse stage that no road router
       * could answer is not an unknown journey — it is a journey whose timing
       * belongs to whoever runs it, and saying so is both true and useful. This
       * is the one promotion this function makes, and it is bounded by the mode's
       * own `control`: only a journey somebody else runs may be read as one they
       * have timed. A hire car nobody could route stays `unknown`, because there
       * is no operator to have set it.
       */
      if (controlForMode(mode) === 'operator_controlled' && (segment.unmeasuredReason === 'mode_not_routed' || segment.unmeasuredReason === 'operator_unpublished')) return 'operator_set';
      return 'unknown';
  }
}

function evidenceOf(segment: TravelSegment, truth: JourneyTruth): JourneyEvidence {
  const base = {
    ...(segment.provider ? { provider: segment.provider } : {}),
    ...(segment.measuredAt ? { measuredAt: segment.measuredAt } : {}),
  };
  switch (truth) {
    case 'measured':
      return { source: 'router', freshness: segment.basis === 'traffic_aware' ? 'volatile' : 'stable', ...base };
    case 'timetabled':
      return { source: 'timetable', freshness: 'seasonal', ...base };
    case 'operator_set':
      return { source: 'operator', freshness: 'date_bound', ...base };
    case 'estimated':
      return { source: segment.estimateKind === 'model' ? 'model' : 'sidequest_estimate', freshness: 'stable', ...base };
    case 'contradicted':
      return { source: 'none', freshness: 'unknown', ...base };
    case 'unknown':
    default:
      return { source: 'none', freshness: 'unknown', ...base };
  }
}

function bookingOwnerOf(mode: TravelMode, truth: JourneyTruth): JourneyBookingOwner {
  if (truth === 'operator_set') return 'operator';
  if (isOperatorMode(mode)) return 'operator';
  if (mode === 'rail' || mode === 'ferry' || mode === 'flight') return 'traveler';
  if (mode === 'walk' || mode === 'trail' || mode === 'drive' || mode === 'four_wheel_drive' || mode === 'bike') return 'nobody';
  return 'unknown';
}

/**
 * A `Journey` for one persisted leg.
 *
 * Never throws and never needs a provider. A caller with no context at all gets
 * a journey whose `routeCritical` is false and whose reservation is `unknown` —
 * both of which are the honest readings of "nobody said".
 */
export function journeyFromSegment(segment: TravelSegment, context: JourneyContext = {}): Journey {
  const mode = travelModeOfSegment(segment);
  const truth = truthOf(segment, mode, context);
  const unknownReason: JourneyUnknownReason | undefined =
    truth === 'unknown'
      ? segment.unmeasuredReason
        ? UNKNOWN_REASON[segment.unmeasuredReason]
        : context.providerCanMeasureMode === false
          ? 'no_provider_for_mode'
          : 'provider_did_not_answer'
      : undefined;

  return {
    version: 1,
    origin: { id: segment.fromId, name: segment.fromName },
    destination: { id: segment.toId, name: segment.toName },
    mode,
    control: controlForMode(mode),
    routing: routingForMode(mode),
    schedule: scheduleForMode(mode),
    truth,
    minutes: segment.minutes,
    /*
     * A road distance belongs only to a road journey. A ferry leg that inherited
     * a `km` from a matrix would put water on the day's driving total, which is
     * the same class of error as a metro ride adding kilometres to a car.
     */
    km: segment.km !== null && (mode === 'drive' || mode === 'four_wheel_drive' || mode === 'taxi' || mode === 'bus' || mode === 'private_transfer' || mode === 'walk' || mode === 'bike' || mode === 'shuttle' || mode === 'operator_transfer') ? segment.km : null,
    reservation: context.reservation ?? 'unknown',
    booking: bookingOwnerOf(mode, truth),
    evidence: evidenceOf(segment, truth),
    routeCritical: context.routeCritical ?? false,
    ...(unknownReason ? { unknownReason } : {}),
    ...(context.contradiction ? { contradiction: context.contradiction } : {}),
    ...(context.operator ? { operator: context.operator } : {}),
    ...(segment.modeCorrectedFrom ? { modeRefusedFrom: travelModeFromTransport(segment.modeCorrectedFrom) } : {}),
    ...(segment.episode ? { episode: segment.episode } : {}),
  };
}

/** Every journey on a day, in order, from its travel items. */
export function journeysOfDay(items: readonly { kind: string; travel?: TravelSegment | undefined }[], context: (segment: TravelSegment) => JourneyContext = () => ({})): Journey[] {
  const out: Journey[] = [];
  for (const item of items) {
    if (item.kind !== 'travel' || !item.travel) continue;
    out.push(journeyFromSegment(item.travel, context(item.travel)));
  }
  return out;
}
