import 'server-only';
import { existingPlanPlaceNames } from './plan-critique';
import {
  ARRIVAL_PRECISION_LABELS,
  countNights,
  dietaryRequirementsOf,
  hasStrictDietaryRequirement,
  nightsFrom,
  type ArrivalPrecision,
  type DateIntent,
  type DietaryRequirement,
  type EdgeTime,
  type Interest,
  type InterestLevel,
  type PreferenceProvenance,
  type TravelerProfile,
  type Trip,
  type TripComposerAnswers,
} from '@sidequest/core';

/**
 * THE ONE PRODUCTION BUILD INPUT.
 *
 * PRODUCTION LOCK V5, §2 and §3. Before this file, both production build
 * surfaces — the full interview and "plan with Sidequest's recommendations" —
 * converged on `buildHybridTripRequest`, which produced a
 * `BenchmarkTripRequest`: a schema designed so a benchmark harness could
 * compare two planners on equal footing. Its vocabularies are therefore fixed
 * and narrow, and the production path inherited every one of those bounds.
 * That is what crashed the founder's own trip on Build (the diet "no beef, no
 * pork" has no benchmark representation, so it was filtered to nothing while
 * its strictness travelled on, and the benchmark schema — correctly — refuses
 * strictness with nothing to be strict about).
 *
 * `CanonicalTripBuildInput` holds **only real product state**: the destination
 * as the traveller and the resolver left it, the timing intent, the duration,
 * the party, the booked facts, the stored `TravelerProfile`, the hard rules and
 * the explicit answers. Nothing here is narrowed to fit a comparison harness,
 * and nothing here is invented: every value is either something a person said
 * or a documented default that says so in its own lineage.
 *
 * Benchmark request adapters remain, and belong only to tests, acceptance,
 * fixtures and benchmark tooling. `benchmark-isolation.test.ts` holds the
 * canonical planning modules to that rule.
 *
 * ## Fact lineage
 *
 * Every planning-critical value is a `TravelerFact`: a value beside where it
 * came from, how confident we are, when it was set and which version of the
 * input it belongs to. A fact may not silently mutate — `lineage.test.ts`
 * follows February from the composer through to the composition request and
 * proves October cannot appear from a fallback.
 */

export const CANONICAL_BUILD_INPUT_VERSION = 'sidequest-canonical-build-input/1' as const;

/**
 * WHERE A PLANNING-CRITICAL VALUE CAME FROM.
 *
 * Deliberately the same five words the interview already uses for preference
 * provenance (`PREFERENCE_SOURCES`), collapsed to the distinctions that decide
 * whether a value may be *stated to a traveller as a fact about their trip*:
 *
 * - `explicit` — they chose or typed it. It may be stated.
 * - `accepted_recommendation` — Sidequest proposed it and they pressed accept.
 *   It may be stated, attributed.
 * - `smart_default` — Sidequest chose it because nobody answered. It may drive
 *   planning; it may never be stated as the traveller's decision.
 * - `derived` — computed from other facts (nights from two dates). Statable
 *   only where the inputs were.
 * - `unknown` — nobody knows. **The value is null and no substitute exists.**
 */
export const FACT_SOURCES = ['explicit', 'accepted_recommendation', 'sidequest_chosen', 'smart_default', 'derived', 'unknown'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export interface TravelerFact<T> {
  /** `null` only when `source` is `unknown`. */
  value: T | null;
  source: FactSource;
  /** 0–1. `explicit` is 1; a smart default is honest about being a guess. */
  confidence: number;
  /** ISO timestamp of the answer, the acceptance or the derivation. */
  updatedAt: string;
  /** Which build-input version produced this fact, so a stale lineage is visible. */
  version: typeof CANONICAL_BUILD_INPUT_VERSION;
  /** One sentence a person can read. Present for everything but `explicit`. */
  reason?: string;
}

/** True when this fact may be spoken to a traveller as a fact about their own trip. */
export function isStatable<T>(fact: TravelerFact<T>): boolean {
  /*
   * V6 — `sidequest_chosen` is statable because it is attributed: the
   * composition chose the window and every screen says so. What it may never
   * be presented as is the traveller's own decision; `describeFactSource`
   * carries the difference.
   */
  return fact.value !== null && (fact.source === 'explicit' || fact.source === 'accepted_recommendation' || fact.source === 'sidequest_chosen');
}

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

/**
 * WHAT THE TRAVELLER SAID ABOUT WHEN, AND WHO DECIDES.
 *
 * §5 and §6. "Tell me when it is best" used to be answered at preliminary
 * intake from climate normals alone, before anything knew whether this was a
 * mountain expedition or a food trip in the same country — and the two do not
 * share a best month. `sidequestChooses` says the question is still open when
 * the composition call runs, so the model picks the window *together with* the
 * route and the experiences. `provisional` may be shown as a hint and is never
 * canonical.
 */
export interface TimingIntent {
  mode: DateIntent['mode'];
  /** True when the traveller asked Sidequest to choose, and nobody has accepted a window yet. */
  sidequestChooses: boolean;
  /** V6 — who closed the question, when it is closed. Absent while open, or for a legacy row nobody recorded. */
  lock?: 'traveler' | 'sidequest';
  /** The dates, when they are real. `source: 'unknown'` while Sidequest still has to choose. */
  startDate: TravelerFact<string>;
  endDate: TravelerFact<string>;
  /** A seasonal hint to show while the question is open. Never canonical, never planned on. */
  provisional?: { startDate: string; endDate: string; label: string; basis: string };
  /** Named months or a season, when that is all the traveller gave. */
  months?: readonly number[];
  season?: string;
  /** The outer bounds a `window` traveller is free between. */
  earliest?: string;
  latest?: string;
  flexDays: number;
}

/**
 * ARRIVAL AND DEPARTURE AT THE PRECISION SOMEBODY ACTUALLY KNOWS THEM.
 *
 * §7. `planningMinute` is an internal allowance the scheduler may use;
 * `statable` decides whether any surface may write a clock time. When the
 * precision is `unknown` or `not_booked`, `statable` is false and there is no
 * time to state — the trip says the time is not set yet, and means it.
 */
export interface EdgeIntent {
  precision: ArrivalPrecision;
  /** The exact time, only when the traveller gave one. */
  time: TravelerFact<string>;
  /** Minutes from local midnight the planner may reserve. Null when nothing is known. */
  planningMinute: number | null;
  /** True only when a surface may print a clock time for this edge. */
  statable: boolean;
  /** "at 11:00", "in the afternoon", "not booked yet" — always safe to print. */
  phrase: string;
}

/* ------------------------------------------------------------------ *
 * The input
 * ------------------------------------------------------------------ */

export interface CanonicalParty {
  adults: number;
  children: number;
  childAges: readonly number[];
  seniorsInGroup: boolean;
  mobilityLimited: boolean;
  altitudeSensitive: boolean;
  mobilityNotes: string;
  /** §4 — real requirements, each with its own strictness. Never a list plus a loose boolean. */
  dietary: readonly DietaryRequirement[];
  /** True when at least one requirement is a "cannot". Derived, never stored twice. */
  dietaryAbsolute: boolean;
}

export interface CanonicalMovement {
  /** What the traveller said about getting around, in the product's own words. */
  preference: 'drive' | 'public_transport' | 'mixed' | 'guided_or_transfers' | 'no_preference';
  /** V6 — true when the traveller answered the transport question themselves; a derived or default preference is never a prohibition. */
  preferenceExplicit: boolean;
  carAvailable: boolean;
  comfortableMountainRoads: boolean;
  comfortableUnpavedRoads: boolean;
  willUseShuttlesAndFerries: boolean;
  maxDailyDriveMinutes: TravelerFact<number>;
  maxDailyTravelMinutes: TravelerFact<number>;
  maxAccessWalkMinutes: number;
  desiredBaseCount: TravelerFact<number>;
  maxBaseChanges: TravelerFact<number>;
}

export interface CanonicalTripBuildInput {
  version: typeof CANONICAL_BUILD_INPUT_VERSION;
  tripId: string;
  /** What the traveller typed, verbatim. Never replaced by a resolver's match. */
  destinationPhrase: string;
  timing: TimingIntent;
  /** Nights on the ground. Derived from two real dates, or the stated duration. */
  nights: TravelerFact<number>;
  arrival: EdgeIntent;
  departure: EdgeIntent;
  origin: string;
  party: CanonicalParty;
  movement: CanonicalMovement;
  /** The stored profile, unchanged. The brief renders it; nothing here re-encodes it. */
  profile: TravelerProfile;
  /** The traveller's own words, verbatim and untrusted. */
  ownWords: { mustDo: readonly string[]; dislikes: readonly string[]; freeText: string };
  /** One line per binding booking, already compacted. */
  bookedFacts: readonly string[];
  /** Interests at or above "once or twice", for the audit and the brief. */
  priorities: readonly { interest: Interest; level: InterestLevel; explicit: boolean }[];
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

function fact<T>(value: T | null, source: FactSource, at: string, reason?: string): TravelerFact<T> {
  const confidence = value === null || source === 'unknown' ? 0 : source === 'explicit' ? 1 : source === 'accepted_recommendation' ? 0.9 : source === 'sidequest_chosen' ? 0.85 : source === 'derived' ? 0.8 : 0.4;
  return { value, source, confidence, updatedAt: at, version: CANONICAL_BUILD_INPUT_VERSION, ...(reason ? { reason } : {}) };
}

function unknownFact<T>(at: string, reason: string): TravelerFact<T> {
  return fact<T>(null, 'unknown', at, reason);
}

const ARRIVAL_ALLOWANCE: Record<ArrivalPrecision, number | null> = { exact: null, morning: 11 * 60, afternoon: 16 * 60, evening: 20 * 60, unknown: null, not_booked: null };
const DEPARTURE_ALLOWANCE: Record<ArrivalPrecision, number | null> = { exact: null, morning: 9 * 60, afternoon: 13 * 60, evening: 18 * 60, unknown: null, not_booked: null };

/**
 * One edge, with the difference between "planning may assume" and "a screen may
 * say" made explicit and unavoidable.
 */
export function edgeIntentOf(edge: EdgeTime | undefined, kind: 'arrival' | 'departure', at: string): EdgeIntent {
  const precision = edge?.precision ?? 'unknown';
  const allowance = kind === 'arrival' ? ARRIVAL_ALLOWANCE : DEPARTURE_ALLOWANCE;
  if (precision === 'exact' && edge?.time) {
    const [h, m] = edge.time.split(':').map(Number);
    const minute = Number.isFinite(h) && Number.isFinite(m) ? (h as number) * 60 + (m as number) : null;
    return { precision, time: fact(edge.time, 'explicit', at), planningMinute: minute, statable: true, phrase: `at ${edge.time}` };
  }
  if (precision === 'morning' || precision === 'afternoon' || precision === 'evening') {
    return {
      precision,
      time: unknownFact(at, 'The traveller gave a part of the day, not a time.'),
      planningMinute: allowance[precision],
      statable: false,
      phrase: precision === 'evening' ? 'in the evening or later' : `in the ${precision}`,
    };
  }
  return {
    precision,
    time: unknownFact(at, precision === 'not_booked' ? 'Not booked yet.' : 'Nobody has said.'),
    planningMinute: null,
    statable: false,
    phrase: precision === 'not_booked' ? 'not booked yet' : 'time not set yet',
  };
}

/** How settled the timing is, and whether Sidequest still owes the traveller a window. */
export function timingIntentOf(input: { composer: TripComposerAnswers | null; trip: Trip; at: string }): TimingIntent {
  const { composer, trip, at } = input;
  const dates = composer?.dates;
  const recommendation = dates?.recommendation;
  const mode = dates?.mode ?? 'exact';
  /*
   * V6 — THE ROW'S LOCK WINS.
   *
   * `trips.timing_lock` is written in the same statement as the dates it
   * protects, by every door that closes the question: typed dates, "Use this
   * timing", "Move my trip to June", and the composition's own choice. When it
   * is set the question is closed whatever the composer blob says — including
   * when the blob fails to parse and arrives here as null, which used to fall
   * through to "Sidequest chooses" and hand the model date authority nobody
   * had given it.
   */
  const rowLock = trip.basics.timingLock;
  if (rowLock && trip.basics.startDate && trip.basics.endDate) {
    const source: FactSource = rowLock === 'traveler' ? (recommendation?.accepted && recommendation.decidedBy !== 'sidequest' ? 'accepted_recommendation' : 'explicit') : 'sidequest_chosen';
    const reason =
      rowLock === 'traveler'
        ? recommendation?.accepted && recommendation.decidedBy !== 'sidequest'
          ? `Sidequest proposed ${recommendation.label} and the traveller accepted it.`
          : undefined
        : 'The composition chose this window with the plan, because the traveller asked Sidequest when the trip is best.';
    return {
      mode,
      sidequestChooses: false,
      lock: rowLock,
      startDate: fact(trip.basics.startDate, source, recommendation?.generatedAt ?? at, reason),
      endDate: fact(trip.basics.endDate, source, recommendation?.generatedAt ?? at, reason),
      flexDays: dates?.flexDays ?? 0,
      ...(dates?.months ? { months: dates.months } : {}),
      ...(dates?.season ? { season: dates.season } : {}),
    };
  }
  /*
   * Sidequest still chooses when the traveller asked it to and has not accepted
   * a window. An accepted recommendation is a decision and stops being open.
   */
  const asksSidequest = mode === 'best_time' || mode === 'window' || mode === 'months' || mode === 'season' || mode === 'undecided' || Boolean(dates?.wantsRecommendation);
  const accepted = recommendation?.accepted === true;
  const sidequestChooses = asksSidequest && !accepted;

  if (accepted && recommendation) {
    const byModel = recommendation.decidedBy === 'sidequest' || recommendation.basis === 'composed_with_trip';
    return {
      mode,
      sidequestChooses: false,
      lock: byModel ? 'sidequest' : 'traveler',
      startDate: fact(recommendation.startDate, byModel ? 'sidequest_chosen' : 'accepted_recommendation', recommendation.generatedAt, byModel ? 'The composition chose this window with the plan.' : `Sidequest proposed ${recommendation.label} and the traveller accepted it.`),
      endDate: fact(recommendation.endDate, byModel ? 'sidequest_chosen' : 'accepted_recommendation', recommendation.generatedAt, byModel ? 'The composition chose this window with the plan.' : `Sidequest proposed ${recommendation.label} and the traveller accepted it.`),
      flexDays: dates?.flexDays ?? 0,
      ...(dates?.months ? { months: dates.months } : {}),
      ...(dates?.season ? { season: dates.season } : {}),
    };
  }
  if (!sidequestChooses && dates?.startDate && dates.endDate) {
    return {
      mode,
      sidequestChooses: false,
      lock: 'traveler',
      startDate: fact(dates.startDate, 'explicit', at),
      endDate: fact(dates.endDate, 'explicit', at),
      flexDays: dates.flexDays ?? 0,
    };
  }
  /*
   * V6 — no composer at all (a row written by an older door, or a blob that
   * failed to parse) is not a request for Sidequest to choose. The row's dates
   * are the only dates there are; they travel as `derived`, which no screen
   * may print as the traveller's decision, and the question stays closed.
   */
  if (!composer && trip.basics.startDate && trip.basics.endDate) {
    return {
      mode,
      sidequestChooses: false,
      startDate: fact(trip.basics.startDate, 'derived', at, 'Read from the trip’s stored dates; nothing recorded who chose them.'),
      endDate: fact(trip.basics.endDate, 'derived', at, 'Read from the trip’s stored dates; nothing recorded who chose them.'),
      flexDays: 0,
    };
  }
  /*
   * The open case. The trip row always holds two dates because the schema
   * demands them, but while Sidequest still owes a window those dates are a
   * placeholder and saying otherwise is how February becomes October. They
   * travel as a `provisional` hint, labelled, and the facts stay unknown.
   */
  const provisional = recommendation
    ? { startDate: recommendation.startDate, endDate: recommendation.endDate, label: recommendation.label, basis: recommendation.basis }
    : trip.basics.startDate
      ? { startDate: trip.basics.startDate, endDate: trip.basics.endDate, label: 'placeholder dates on the trip row', basis: 'placeholder' }
      : undefined;
  const reason = mode === 'best_time' ? 'The traveller asked Sidequest to choose the timing; the trip has not been composed yet.' : 'Sidequest has been asked to choose inside the traveller’s window.';
  return {
    mode,
    sidequestChooses,
    startDate: unknownFact(at, reason),
    endDate: unknownFact(at, reason),
    flexDays: dates?.flexDays ?? 0,
    ...(provisional ? { provisional } : {}),
    ...(dates?.months ? { months: dates.months } : {}),
    ...(dates?.season ? { season: dates.season } : {}),
    ...(dates?.earliest ? { earliest: dates.earliest } : {}),
    ...(dates?.latest ? { latest: dates.latest } : {}),
  };
}

function explicitly(provenance: Record<string, PreferenceProvenance>, id: string): boolean {
  const entry = provenance[id];
  return entry?.source === 'explicit' || entry?.source === 'existing_profile';
}

/**
 * The one production build input, from real product state and nothing else.
 *
 * Total by construction: every field is either read from what the traveller
 * said or given a documented default whose lineage says `smart_default`.
 */
export function buildCanonicalTripBuildInput(input: {
  trip: Trip;
  composer: TripComposerAnswers | null;
  profile: TravelerProfile;
  bookedFacts?: readonly string[];
  destinationPhrase?: string;
  now: Date;
}): CanonicalTripBuildInput {
  const { trip, composer, profile } = input;
  const at = input.now.toISOString();
  const timing = timingIntentOf({ composer, trip, at });

  const statedNights = composer ? nightsFrom(composer) : null;
  const rowNights = countNights(trip.basics.startDate, trip.basics.endDate);
  const nights: TravelerFact<number> =
    composer?.duration.mode === 'fixed' && composer.duration.nights
      ? fact(composer.duration.nights, 'explicit', at)
      : statedNights !== null
        ? fact(statedNights, 'derived', at, 'Counted from the dates the traveller gave.')
        : rowNights > 0
          ? fact(rowNights, 'derived', at, 'Counted from the trip’s stored dates.')
          : fact(1, 'smart_default', at, 'Nobody stated a length; one night is the smallest plannable trip.');

  const dietary = dietaryRequirementsOf({ needs: profile.food.dietaryNeeds, strict: profile.food.dietaryStrict, ...(profile.food.dietaryNotes ? { notes: profile.food.dietaryNotes } : {}) });

  const carAvailable = profile.transport.willDrive;
  const maxDrive = profile.transport.maxDailyDriveMinutes;
  const driveExplicit = explicitly(profile.provenance, 'max_drive') || composer?.maxDailyDriveMinutes !== undefined;
  const desiredBaseCount = baseCountFrom(profile, composer?.shape, nights.value ?? 1);
  const baseExplicit = explicitly(profile.provenance, 'base_moves');

  const preference: CanonicalMovement['preference'] =
    !carAvailable && profile.interview.guideWillingness === 'prefer'
      ? 'guided_or_transfers'
      : carAvailable && explicitly(profile.provenance, 'transport_mode')
        ? 'drive'
        : !carAvailable && explicitly(profile.provenance, 'transport_mode')
          ? 'public_transport'
          : composer?.transport === 'drive'
            ? 'drive'
            : composer?.transport === 'public_transport'
              ? 'public_transport'
              : composer?.transport === 'mixed'
                ? 'mixed'
                : 'no_preference';

  const priorities = (Object.entries(profile.interests) as [Interest, InterestLevel][])
    .filter(([, level]) => level === 'core' || level === 'frequent' || level === 'occasional')
    .map(([interest, level]) => ({ interest, level, explicit: explicitly(profile.provenance, `interest:${interest}`) || explicitly(profile.provenance, 'interests') }));

  return {
    version: CANONICAL_BUILD_INPUT_VERSION,
    tripId: trip.id,
    destinationPhrase: (input.destinationPhrase ?? composer?.destinationQuery ?? trip.basics.destinationInput ?? '').trim(),
    timing,
    nights,
    arrival: edgeIntentOf(composer?.arrival, 'arrival', at),
    departure: edgeIntentOf(composer?.departure, 'departure', at),
    origin: composer?.origin ?? '',
    party: {
      adults: trip.basics.adults,
      children: trip.basics.children,
      childAges: [],
      seniorsInGroup: trip.basics.travelerNeeds.includes('seniors_in_group'),
      mobilityLimited: trip.basics.travelerNeeds.includes('mobility_limited') || profile.accessibility.mobilityLimited,
      altitudeSensitive: trip.basics.travelerNeeds.includes('altitude_sensitive'),
      mobilityNotes: profile.accessibility.notes ?? '',
      dietary,
      dietaryAbsolute: hasStrictDietaryRequirement(dietary),
    },
    movement: {
      preference,
      preferenceExplicit: explicitly(profile.provenance, 'transport_mode') || (composer?.transport !== undefined && composer.transport !== null),
      carAvailable,
      comfortableMountainRoads: profile.transport.comfortableMountainRoads,
      comfortableUnpavedRoads: profile.transport.comfortableGravelRoads,
      willUseShuttlesAndFerries: profile.interview.boatsAndFerries !== 'cannot' && profile.transport.willUseShuttles,
      maxDailyDriveMinutes: driveExplicit ? fact(maxDrive, 'explicit', at) : fact(maxDrive, 'smart_default', at, 'Nobody set a driving ceiling; this is Sidequest’s default for this transport choice.'),
      maxDailyTravelMinutes: fact(profile.transport.maxDailyTransportMinutes, driveExplicit ? 'derived' : 'smart_default', at, 'Driving plus riding plus walking to reach things.'),
      maxAccessWalkMinutes: profile.transport.maxAccessWalkMinutes,
      desiredBaseCount: baseExplicit ? fact(desiredBaseCount, 'explicit', at) : fact(desiredBaseCount, 'smart_default', at, 'Derived from trip length and the shape the traveller leaned towards.'),
      maxBaseChanges: fact(
        profile.interview.baseMoveTolerance === 'stay_put' ? 0 : profile.interview.baseMoveTolerance === 'move_once' ? 1 : Math.max(desiredBaseCount - 1, desiredBaseCount),
        baseExplicit ? 'explicit' : 'smart_default',
        at,
        'How many times the traveller is willing to change where they sleep.',
      ),
    },
    profile,
    ownWords: {
      mustDo: [...new Set([...splitFreeText(composer?.mustDo), ...existingPlanPlaceNames(composer?.existingPlan).slice(0, 20)])],
      dislikes: splitFreeText(composer?.avoid),
      freeText: [composer?.mustDo, composer?.avoid, composer?.existingPlan].filter(Boolean).join('\n').slice(0, 2000),
    },
    bookedFacts: input.bookedFacts ?? [],
    priorities,
  };
}

function baseCountFrom(profile: TravelerProfile, shape: string | undefined, nights: number): number {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  if (profile.interview.baseMoveTolerance === 'stay_put') return 1;
  if (profile.interview.baseMoveTolerance === 'move_once') return Math.min(2, Math.max(1, nights));
  if (profile.interview.scopeStrategy === 'depth') return clamp(nights / 4, 1, 2);
  if (profile.interview.scopeStrategy === 'breadth' || profile.interview.baseMoveTolerance === 'move_freely') return clamp(nights / 2.5, 2, 8);
  if (shape === 'one_base') return 1;
  if (shape === 'two_bases') return 2;
  if (shape === 'circuit') return clamp(nights / 2.5, 3, 8);
  return clamp(nights / 3, 1, 6);
}

function splitFreeText(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 10);
}

/** The label a screen may show for an edge precision. Re-exported so no surface re-derives it. */
export { ARRIVAL_PRECISION_LABELS };

/* ------------------------------------------------------------------ *
 * What the composition call is told about timing
 * ------------------------------------------------------------------ */

/**
 * §6 — TIMING, COMPACTED FOR THE ONE MODEL CALL.
 *
 * Deliberately tiny: whether the decision is still open, and the constraint the
 * traveller put on it. Everything else the model needs about season it already
 * knows about the world, and everything Sidequest knows about climate is
 * verification, not input.
 */
export interface CompositionTimingBrief {
  sidequestChooses: boolean;
  /** "August or September", "free between 2027-06-01 and 2027-07-15", "summer". Absent when unconstrained. */
  constraint?: string;
  /**
   * §6 — today, and the earliest date a window may start.
   *
   * A model has no clock. The live Hong Kong build picked the right *season* and
   * a year that had already gone, because nothing told it when now was. Both
   * dates travel so the choice is anchored rather than guessed.
   */
  today: string;
  earliestStart: string;
}

/**
 * How far out a chosen window may begin.
 *
 * Two weeks, not one day: a trip somebody has not booked cannot start tomorrow,
 * and a window inside that would be refused downstream anyway for lack of time
 * to arrange anything.
 */
export const EARLIEST_CHOSEN_START_DAYS = 14;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function compositionTimingBriefOf(timing: TimingIntent, now: Date = new Date()): CompositionTimingBrief {
  const today = now.toISOString().slice(0, 10);
  const earliestStart = new Date(now.getTime() + EARLIEST_CHOSEN_START_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (!timing.sidequestChooses) return { sidequestChooses: false, today, earliestStart };
  const parts: string[] = [];
  if (timing.months && timing.months.length > 0) parts.push(timing.months.map((m) => MONTH_NAMES[m - 1] ?? String(m)).join(' or '));
  if (timing.season) parts.push(timing.season);
  if (timing.earliest && timing.latest) parts.push(`free between ${timing.earliest} and ${timing.latest}`);
  return { sidequestChooses: true, today, earliestStart, ...(parts.length > 0 ? { constraint: parts.join('; ') } : {}) };
}
