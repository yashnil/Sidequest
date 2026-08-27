import {
  PLANNER_READINESS_VERSION,
  plannerReadinessSchema,
  type PlannerFunnel,
  type PlannerReadiness,
  type PlannerReadinessLevel,
  type PlannerRejection,
  type PlannerRemedyAssessment,
  type PlannerSupply,
  type PlannerUnresolved,
  type TravelerProfile,
  type UnscheduledPlace,
  type UnscheduledReasonCode,
} from '@sidequest/core';

/**
 * TURNING A PLAN — FAILED OR PARTIAL — INTO SOMETHING A TRAVELLER CAN ACT ON.
 *
 * Built from the planner's own counts and its own rejection codes; nothing here
 * re-derives a reason or guesses at one. That matters because the remedies are
 * chosen from the codes, and a remedy chosen from a guess sends somebody to
 * change the wrong thing.
 *
 * The mapping from blocker to remedy is the whole content of this file, and each
 * line of it is a claim about what would actually change the outcome:
 *
 * - **Nothing could be measured** (`missing_travel_data`) is an infrastructure
 *   failure, so retrying and rebuilding are the answers and adding days is not.
 * - **Everything is too far** (`exceeds_daily_travel`, `no_time_left`) is a
 *   travel-budget or geography problem. More days genuinely helps when the
 *   places fit individually and the *week* is full; it helps not at all when a
 *   single round trip already exceeds the daily limit, and the two are
 *   distinguished by whether anything was scheduled at all.
 * - **Shut or unreachable** (`closed_on_trip_dates`, `access_unavailable`) is a
 *   dates-and-evidence problem, and no amount of retrying moves it.
 *
 * Two invariants sit above that mapping. Both exist because a plan can be
 * internally consistent and still be no use to the person holding it.
 *
 * **Feasibility is not completeness.** The verdict used to be computed from
 * conflicts alone, so a six-day trip holding one stop — five days rendering "An
 * open day … Nothing scheduled" — was headed "Ready, with cautions / The plan
 * works". Two live compilations produced funnels of
 * `{considered:24, selected:5, eligible:1, scheduled:1}` and
 * `{considered:24, selected:8, eligible:2, scheduled:2}`, and both read as
 * ready because nothing anywhere consulted how much of the trip got filled.
 * `coverageOf` is that missing question, and it is asked *of this traveller*:
 * see the note on it for why a flat "three stops a day" would be the wrong
 * answer in both directions.
 *
 * **A remedy may relax a preference and must never break an answer.** The
 * `adjust_transport` detail was a fixed string reading "Raising your daily
 * driving limit, or planning around a car, is what would bring these within
 * reach", and it was the remedy mapped to `transport_mode_unavailable` — so a
 * car-free trip whose own itinerary page said "This plan assumes no car" was
 * told, on the board, to plan around one. Worse, the itinerary page gave the
 * *correct* reason for the very same places ("you said 25 min is the furthest
 * you would walk"), so two surfaces contradicted each other about one journey.
 * `transportDetail` reads the traveller's hard constraints and quotes the
 * planner's own refusal rather than composing a second, different one, and
 * `respectsHardConstraints` is the net under every remedy in the list.
 */

const REMEDY_ORDER = [
  'adjust_transport',
  'adjust_scope',
  'choose_manually',
  'more_days',
  'refresh_evidence',
  'retry',
] as const;

/** Which blockers each remedy plausibly answers. */
const ANSWERS: Record<(typeof REMEDY_ORDER)[number], readonly UnscheduledReasonCode[]> = {
  adjust_transport: [
    'exceeds_daily_travel',
    'no_time_left',
    'transport_mode_unavailable',
    'missed_last_return',
    'access_unavailable',
    'not_feasible',
  ],
  adjust_scope: ['exceeds_daily_travel', 'no_time_left', 'missed_last_return', 'not_feasible'],
  choose_manually: ['lower_priority', 'frequency_reached', 'exceeds_intensity', 'no_time_left'],
  more_days: ['no_time_left', 'frequency_reached', 'lower_priority'],
  refresh_evidence: [
    'closed_on_trip_dates',
    'hours_do_not_fit',
    'access_unavailable',
    'service_not_operating',
    'seasonally_closed',
  ],
  retry: ['missing_travel_data'],
};

const DETAIL: Record<(typeof REMEDY_ORDER)[number], string> = {
  adjust_transport:
    'Raising your daily driving limit, or planning around a car, is what would bring these within reach.',
  adjust_scope:
    'Everything we found sits further out than this trip can cross from where it is anchored. A tighter region, or a base nearer the places, would change that.',
  choose_manually:
    'Pick the stops yourself on the board — auto-pick chose a set that cannot be laid out together.',
  more_days: 'There is more here than these dates can hold. More days would make room.',
  refresh_evidence:
    'These are shut, or nobody publishes when they open. Rebuilding the region looks again; different dates may also help.',
  retry: 'A source did not answer while this was being built. Building again may go differently.',
};

const RULED_OUT: Record<(typeof REMEDY_ORDER)[number], string> = {
  adjust_transport: 'Your travel limits are not what stopped these.',
  adjust_scope: 'The region is not what stopped these.',
  choose_manually: 'Choosing by hand would hit the same blocker.',
  more_days:
    'More days would not help: not one of these fits inside a single day as it stands, so a longer trip has nowhere to put them either.',
  refresh_evidence: 'This is not an evidence gap — we know enough, and the answer is no.',
  retry: 'Nothing here failed transiently, so building again would produce the same result.',
};

export interface ReadinessInput {
  funnel: PlannerFunnel;
  unscheduled: readonly UnscheduledPlace[];
  dayCount: number;
  daysWithFullMeals?: number;
  supply?: PlannerSupply;
  unresolved?: Partial<PlannerUnresolved>;
  /**
   * The traveller both invariants are judged against.
   *
   * Optional, and absent means "not measured here" rather than "no
   * constraints" — the same rule the funnel counts follow. Without it there is
   * no pace to weigh the plan's fullness against and no declared mode to keep a
   * remedy inside, so the completeness invariant does not fire and the remedy
   * copy is exactly what it always was. `planTrip` always has the profile, so
   * absent only ever means a caller that is not planning a trip.
   */
  profile?: TravelerProfile;
  /**
   * Days that ended up with at least one experience on them.
   *
   * Measured by the caller from the built days rather than inferred from
   * `scheduled`, because the two say different things: six stops on one day and
   * six stops across six days are the same count and not the same trip, and it
   * was the second number the live plans were failing on ("1 stop across 1 of 6
   * days").
   */
  daysWithActivity?: number;
}

/**
 * WHAT THIS TRAVELLER'S OWN ANSWERS SAY THE TRIP SHOULD HOLD, AND WHETHER IT DOES.
 *
 * Relative to the person, never to a constant. A flat rule — "three stops a
 * day" — is wrong in both directions at once: it calls a slow traveller who
 * asked for space and got one anchor a day a failure, and it lets a
 * checklist-pace traveller who got a third of what they asked for pass. So the
 * bar is built from their answers:
 *
 *   - **days they can actually fill.** Arrival and departure are shaped lighter
 *     by construction (`edge_day_overfull` exists to enforce it), and between
 *     them they cost about one full day, so that is what comes off.
 *   - **times their own pace.** `derived.activitySlotsPerDay` is the product's
 *     one answer to "how many real activities a day can hold at this pace",
 *     already carrying pace, daily intensity and who is travelling. Nothing
 *     here re-derives it.
 *   - **halved.** A plan legitimately holds less than the ceiling of its own
 *     ambition; the question is not "did they get everything" but "is this a
 *     trip". Half is the same threshold `placedShare` below states out loud,
 *     and it is stated rather than buried for the same reason.
 *
 * `everyDayAnchored` is the second way to clear it, and it is the one that
 * keeps a deliberately sparse trip honest: a traveller who asked for a slow,
 * spacious trip and got one anchor on every day they have **has a trip**,
 * whatever their pace ceiling would have allowed. A count can be low because
 * the plan is thin or because the plan is spacious, and only the distribution
 * across days tells the two apart.
 *
 * Null when there is nothing to judge against — no profile, or no day the trip
 * could fill. Absent is not zero, and a bar nobody could compute must not read
 * as a bar the plan failed.
 */
export interface PlanCoverage {
  /** Days the trip can actually fill, with the arrival/departure shape taken off. */
  plannableDays: number;
  /** What their stated pace says those days would hold. Never rounded up into a promise. */
  pacedStops: number;
  /** The number this plan had to reach, from that pace and those days. */
  bar: number;
  scheduled: number;
  daysWithActivity: number;
  /** Every day the trip could fill has something on it. */
  everyDayAnchored: boolean;
  /** Below the pace's ceiling, and spread across the days anyway. Asked for, not failed. */
  spacious: boolean;
  /** Too little, across too few days, to call this a trip. */
  short: boolean;
}

export function coverageOf(input: ReadinessInput): PlanCoverage | null {
  const profile = input.profile;
  if (!profile) return null;

  /*
   * The days between arrival and departure, which is what the planner itself
   * means by a day that is not an edge day (`PlannedDay.isEdgeDay`, capped by
   * `edgeDayCapacityShare`). This used to come off as "about one full day"
   * between the two, and that approximation cost a trip its verdict: an
   * eight-day road trip that anchored every one of days two through seven —
   * arriving late on the first and leaving early on the last, both left empty
   * by the planner's own shaping — was measured against seven fillable days,
   * missed `everyDayAnchored` by the one day nobody could have filled, and read
   * as "not enough here to plan a trip around". Two edges cost two part-days,
   * not one, and the planner already draws that line.
   */
  const plannableDays = input.dayCount <= 2 ? Math.max(1, input.dayCount - 1) : input.dayCount - 2;
  if (plannableDays <= 0) return null;

  const pacedStops = plannableDays * profile.derived.activitySlotsPerDay;
  const bar = Math.max(1, Math.ceil(pacedStops / 2));
  const scheduled = input.funnel.scheduled;
  /*
   * Unmeasured days cannot anchor anything. A caller that did not count them
   * gets the volume half of the test only, which is the conservative reading:
   * it can call a plan short, never call a short one spacious.
   */
  const daysWithActivity = input.daysWithActivity ?? 0;
  const everyDayAnchored =
    input.daysWithActivity !== undefined && daysWithActivity >= plannableDays;

  /*
   * DELIBERATELY NOT CONDITIONED ON WHAT THE TRAVELLER SELECTED.
   *
   * The tempting carve-out is "a plan holding every place they chose is never
   * short", and it is wrong: auto-pick scales its target to what the region
   * supplied, so an eight-day trip can select five, schedule all five, leave
   * four days empty and clear the test on a technicality. "Some of what you
   * chose could not be scheduled" is a *different* verdict — it is `partial`,
   * measured a few lines below against `selected` — and running the two together
   * is precisely how a plan with four empty days came to read as finished. This
   * one is about the trip, and the trip is what the traveller is looking at.
   */

  return {
    plannableDays,
    pacedStops,
    bar,
    scheduled,
    daysWithActivity,
    everyDayAnchored,
    spacious: everyDayAnchored && scheduled < pacedStops,
    short: scheduled < bar && !everyDayAnchored,
  };
}

/**
 * THE ANSWERS A REMEDY MAY NOT PROPOSE BREAKING.
 *
 * The line this file draws is between a **preference**, which a remedy may ask
 * the traveller to relax, and an **answer**, which it may not ask them to
 * contradict. "Raise your daily driving limit" is the first — the number is a
 * dial and moving it is a real option. "Plan around a car" said to somebody who
 * answered that they will not drive is the second, and it is not advice, it is
 * the product forgetting what it was told.
 */
interface HardConstraints {
  /** Whether a car is available to this trip at all. */
  canDrive: boolean;
  willUseShuttles: boolean;
  /** The stated furthest walk to reach a stop. The answer the planner enforces per leg. */
  maxAccessWalkMinutes: number;
  maxDailyTransportMinutes: number;
}

function hardConstraintsOf(profile: TravelerProfile): HardConstraints {
  return {
    canDrive: profile.transport.willDrive,
    willUseShuttles: profile.transport.willUseShuttles,
    maxAccessWalkMinutes: profile.transport.maxAccessWalkMinutes,
    maxDailyTransportMinutes: profile.transport.maxDailyTransportMinutes,
  };
}

/**
 * Modes the traveller ruled out, as the words that name them.
 *
 * A word list rather than a structured check because what is being guarded is
 * the *sentence*: these strings are read by a person, and one of them offering a
 * car to somebody with no car is the defect, whatever produced it. Applied to
 * every remedy detail — including the ones quoted from elsewhere in the planner
 * — so a sentence composed correctly today cannot drift into the violation
 * later.
 */
const DRIVING_WORDS = /\b(driv\w+|cars?|rent\w*|vehicles?|wheel)\b/i;
const SHUTTLE_WORDS = /\b(shuttles?|ferry|ferries)\b/i;

function respectsHardConstraints(sentence: string, constraints: HardConstraints): boolean {
  if (!constraints.canDrive && DRIVING_WORDS.test(sentence)) return false;
  if (!constraints.willUseShuttles && SHUTTLE_WORDS.test(sentence)) return false;
  return true;
}

/**
 * The blockers whose answer is genuinely a transport one, as opposed to the
 * two `adjust_transport` also answers because a travel budget is involved
 * (`no_time_left`, `not_feasible`). Only these carry a per-place refusal worth
 * quoting.
 */
const TRANSPORT_CONFLICT_CODES: readonly UnscheduledReasonCode[] = [
  'transport_mode_unavailable',
  'access_unavailable',
  'missed_last_return',
  'exceeds_daily_travel',
];

/**
 * The transport remedy, in the terms of the transport this trip actually has.
 *
 * With a car declared, the sentence is the one it always was: raising a daily
 * driving limit is a dial the traveller owns and moving it is a real option.
 *
 * Without one, the honest remedy is the answer that actually bound the leg —
 * and the planner has already composed that sentence, per place, in
 * `modelled-walk.ts`. Quoting it is deliberate: the itinerary page prints the
 * same `reason` for the same place, and two surfaces composing their own
 * wording for one journey is how the board came to say "plan around a car"
 * beside a page saying "you said 25 min is the furthest you would walk".
 */
function transportDetail(
  input: ReadinessInput,
  dominantCodes: ReadonlySet<UnscheduledReasonCode>,
  constraints: HardConstraints | null,
): string {
  if (!constraints || constraints.canDrive) return DETAIL.adjust_transport;

  for (const entry of input.unscheduled) {
    if (!dominantCodes.has(entry.reasonCode)) continue;
    if (!TRANSPORT_CONFLICT_CODES.includes(entry.reasonCode)) continue;
    for (const sentence of [entry.reason, entry.suggestedRemedy]) {
      if (sentence && respectsHardConstraints(sentence, constraints)) return sentence;
    }
  }

  /*
   * Nothing quotable, so the answers themselves are named. Deliberately without
   * the words for the modes this trip ruled out — not because the guard below
   * would catch them, but because naming an absent mode at all invites somebody
   * to go and change the one answer they already told us is not a dial.
   */
  return `The answers that bind these are the ${constraints.maxAccessWalkMinutes} min you said you would walk to reach a stop and the ${constraints.maxDailyTransportMinutes} min of travel a day this trip allows. Raising one of those, or basing the trip nearer these places, is what would change it.`;
}

export function buildPlannerReadiness(input: ReadinessInput): PlannerReadiness {
  const byCode = new Map<UnscheduledReasonCode, { count: number; examples: string[] }>();
  for (const entry of input.unscheduled) {
    const bucket = byCode.get(entry.reasonCode) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 3) bucket.examples.push(entry.name);
    byCode.set(entry.reasonCode, bucket);
  }

  const rejections: PlannerRejection[] = [...byCode.entries()]
    .map(([reasonCode, bucket]) => ({
      reasonCode,
      count: bucket.count,
      examples: bucket.examples,
    }))
    // Largest first, then alphabetically, so two identical inputs order alike.
    .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode));

  /**
   * The blockers that account for most of the loss.
   *
   * "Most" is deliberately generous — everything at or above half the largest
   * count — because two codes tying for first is common and picking one of them
   * would misdescribe the problem.
   */
  const largest = rejections[0]?.count ?? 0;
  const dominantBlockers = rejections.filter((entry) => entry.count * 2 >= largest).slice(0, 3);
  const dominantCodes = new Set(dominantBlockers.map((entry) => entry.reasonCode));

  /**
   * `more_days` is the one remedy that has to be reasoned about rather than
   * looked up.
   *
   * "There was no room this week" and "no single day can hold this at all" both
   * arrive as `no_time_left`, and they want opposite advice. Nothing scheduled
   * at all means every day was empty and still nothing fitted — so the days were
   * not the constraint, and more of them are not the answer.
   */
  const nothingFitted = input.funnel.scheduled === 0;

  const constraints = input.profile ? hardConstraintsOf(input.profile) : null;

  const remedies: PlannerRemedyAssessment[] = REMEDY_ORDER.map((remedy) => {
    const answers = ANSWERS[remedy].some((code) => dominantCodes.has(code));
    const wouldHelp = remedy === 'more_days' ? answers && !nothingFitted : answers;
    const proposal = remedy === 'adjust_transport'
      ? transportDetail(input, dominantCodes, constraints)
      : DETAIL[remedy];
    /*
     * The net, over every remedy rather than only the one that broke.
     *
     * A change this traveller has already told us they will not make is not a
     * remedy for them, so it is demoted rather than reworded: leaving
     * `likelyToHelp` true while swapping the sentence would file it under "what
     * would help" and then say it would not. `transportDetail` composes inside
     * the constraints already; this catches anything that stops doing so later.
     */
    const permitted = !constraints || respectsHardConstraints(proposal, constraints);
    const helps = wouldHelp && permitted;
    return { remedy, likelyToHelp: helps, detail: helps ? proposal : RULED_OUT[remedy] };
  });

  const unresolved: PlannerUnresolved = {
    routePairs: input.unresolved?.routePairs ?? 0,
    criticalHours: input.unresolved?.criticalHours ?? 0,
    accessRequirements: input.unresolved?.accessRequirements ?? 0,
    blockingClosures: input.unresolved?.blockingClosures ?? 0,
    exhaustedBudgets: input.unresolved?.exhaustedBudgets ?? [],
  };

  const coverage = coverageOf(input);

  return plannerReadinessSchema.parse({
    schemaVersion: PLANNER_READINESS_VERSION,
    level: decideLevel(input.funnel, unresolved, coverage),
    funnel: input.funnel,
    supply: input.supply ?? {},
    unresolved,
    daysRequested: input.dayCount,
    daysWithFullMeals: input.daysWithFullMeals ?? 0,
    rejections,
    dominantBlockers,
    remedies,
    summary: summarise(input, dominantBlockers, coverage, constraints),
  });
}

/**
 * Ready, partial, insufficient, or broken — by rule.
 *
 * The order is the argument. Infrastructure first, because "we could not
 * measure anything" must never be reported as "there is nothing here" — the
 * first is our failure and the second is a claim about the traveller's
 * destination. Then zero, which is always a refusal whatever else is true. Only
 * then the question of *how much* got through.
 *
 * Completeness comes before `partial` and after zero, because the two shortfalls
 * are different claims and the bigger one has to win. "Some of what you chose
 * could not be scheduled" is a disappointing plan; "there is not enough here to
 * call it a trip" is not a plan, and a traveller who reads the first when the
 * second is true goes looking for the four stops they think they have.
 */
export function decideLevel(
  funnel: PlannerFunnel,
  unresolved: PlannerUnresolved,
  coverage?: PlanCoverage | null,
): PlannerReadinessLevel {
  if (funnel.selected > 0 && funnel.eligible === 0 && unresolved.routePairs > 0) {
    return 'infrastructure_failure';
  }
  if (funnel.scheduled === 0) return 'insufficient';
  if (coverage?.short) return 'insufficient';

  /**
   * Partial when a meaningful share of what the traveller picked did not make
   * it, or when a day of the trip ended up with nothing on it.
   *
   * Half is a threshold rather than a measurement, and it is stated here rather
   * than buried: below it the plan is worth showing and worth captioning, above
   * it the plan stands on its own.
   */
  const placedShare = funnel.selected === 0 ? 1 : funnel.scheduled / funnel.selected;
  if (placedShare < 0.5) return 'partial';
  return 'ready';
}

function summarise(
  input: ReadinessInput,
  dominant: readonly PlannerRejection[],
  coverage: PlanCoverage | null,
  constraints: HardConstraints | null,
): string {
  const { funnel } = input;
  /*
   * The shortfall first, and in the trip's own terms.
   *
   * Placed above every funnel branch below because those all answer "what
   * happened to the things you picked", and none of them can say the thing a
   * traveller looking at five empty days needs to hear. "2 of the 8 places you
   * picked are in the plan" was, on a live build, technically true and read as
   * an ordinary partial result.
   */
  if (coverage?.short && funnel.scheduled > 0) {
    const stops = `${funnel.scheduled} ${funnel.scheduled === 1 ? 'stop' : 'stops'}`;
    const days = `${coverage.daysWithActivity} of your ${input.dayCount} days`;
    const lead = dominant[0];
    const because = lead ? ` The rest are out because ${phraseFor(lead.reasonCode, constraints)}.` : '';
    return `This plan holds ${stops} across ${days}. At the pace you asked for these dates have room for around ${Math.round(coverage.pacedStops)}, so there is not yet enough here to plan a trip around.${because}`;
  }
  if (funnel.selected === 0) {
    return 'Nothing on the board is marked to include, so there was nothing to plan.';
  }
  if (funnel.eligible === 0) {
    /*
     * Two different zeros, and only one of them is a measurement gap. When the
     * dominant blocker is a transport conflict — a road measured for a trip
     * with no car, a walk past the traveller's own limit — saying "we could not
     * measure" sends them to retry something that will never go differently.
     * The blocker names what actually stops these, so the summary reads it.
     */
    const lead = dominant[0];
    if (lead && (lead.reasonCode === 'transport_mode_unavailable' || lead.reasonCode === 'access_unavailable')) {
      return `None of the ${funnel.selected} places you picked can be reached with the transport this trip has — ${phraseFor(lead.reasonCode, constraints)}.`;
    }
    return `None of the ${funnel.selected} places you picked has a travel time we could measure, so none of them could be placed in a day.`;
  }
  if (funnel.accessFeasible === 0) {
    return `There is no legal way in to any of the ${funnel.selected} places you picked on any day of your trip.`;
  }
  if (funnel.feasible === 0) {
    return `All ${funnel.selected} places you picked are unreachable or shut on every one of your ${input.dayCount} days.`;
  }
  if (funnel.scheduled === 0) {
    const lead = dominant[0];
    const blocker = lead ? phraseFor(lead.reasonCode, constraints) : 'they could not be laid out into a day';
    return `${funnel.feasible} of the ${funnel.selected} places you picked were reachable and open, and none of them could be scheduled: ${blocker}.`;
  }
  /*
   * The one distinction between "thin" and "spacious", said out loud.
   *
   * Appended rather than substituted: the blocker is still why the rest are
   * not here and a traveller is owed it. What this adds is the fact that the
   * room left over is the room they asked for — without it, a slow traveller's
   * plan and a broken one read identically, and the difference between them is
   * the whole reason the completeness bar is drawn from the profile.
   */
  const spacious = coverage?.spacious
    ? ' Every day of the trip has something on it, and the room around it is the pace you asked for.'
    : '';
  if (funnel.scheduled < funnel.selected) {
    const lead = dominant[0];
    const blocker = lead ? phraseFor(lead.reasonCode, constraints) : 'they did not fit';
    return `${funnel.scheduled} of the ${funnel.selected} places you picked are in the plan. The rest are out because ${blocker}.${spacious}`;
  }
  return `All ${funnel.scheduled} places you picked are in the plan.${spacious}`;
}

/**
 * The blocker as a clause, in the traveller's terms.
 *
 * Deliberately not the per-place `reason` string, which names one place. This
 * names the pattern across all of them, which is what a summary is for.
 */
const REASON_PHRASES: Record<UnscheduledReasonCode, string> = {
  seasonally_closed: 'they are out of season on your dates',
  not_feasible: 'they do not work with the answers you gave',
  no_time_left: 'no single day had the hours and the travel budget for them',
  exceeds_daily_travel:
    'getting to any of them and back is further than you said you would drive in a day',
  exceeds_intensity: 'they are harder going than you said you wanted',
  frequency_reached: 'you asked for fewer of this kind of thing than the board offered',
  lower_priority: 'they were maybes, and the definite choices took the room',
  missing_travel_data: 'we have no measured travel time to them',
  access_unavailable: 'there is no legal way in on any day of your trip',
  service_not_operating: 'the service that reaches them does not run on your days',
  missed_last_return: 'you could get there but not back before the last way out',
  transport_mode_unavailable: 'the way in needs transport this trip does not have',
  closed_on_trip_dates: 'they are shut on every day of your trip',
  hours_do_not_fit: 'their opening hours never leave long enough for a visit',
  weather_incompatible: 'the weather rules them out on every day they could have gone on',
  selection_not_on_board:
    'they were on an earlier version of your board and are not on this one',
};

/**
 * The same clause, held to what this trip can actually do.
 *
 * Only one phrase names a mode, and it names the wrong one on a trip with no
 * car: "further than you said you would drive in a day" was printed above a
 * remedy panel for a traveller who had answered that they will not drive, about
 * places a walking budget ruled out. The daily transport budget is the limit
 * that actually bound them, and it is the one the sentence names.
 *
 * Without constraints — a caller that is not planning a trip — the phrase is
 * exactly what it always was.
 */
function phraseFor(code: UnscheduledReasonCode, constraints: HardConstraints | null): string {
  if (code === 'exceeds_daily_travel' && constraints && !constraints.canDrive) {
    return 'getting to any of them and back is further than this trip allows for travel in a day';
  }
  return REASON_PHRASES[code];
}
