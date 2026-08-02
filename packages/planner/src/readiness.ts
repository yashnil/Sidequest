import {
  PLANNER_READINESS_VERSION,
  plannerReadinessSchema,
  type PlannerReadiness,
  type PlannerRejection,
  type PlannerRemedyAssessment,
  type UnscheduledPlace,
  type UnscheduledReasonCode,
} from '@sidequest/core';

/**
 * TURNING A FAILED PLAN INTO SOMETHING A TRAVELLER CAN ACT ON.
 *
 * Built from the planner's own counts and its own rejection codes — nothing here
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
  consideredCount: number;
  selectedCount: number;
  eligibleCount: number;
  feasibleCount: number;
  scheduledCount: number;
  unscheduled: readonly UnscheduledPlace[];
  dayCount: number;
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
  const dominantBlockers = rejections
    .filter((entry) => entry.count * 2 >= largest)
    .slice(0, 3);
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
  const nothingFitted = input.scheduledCount === 0;

  const remedies: PlannerRemedyAssessment[] = REMEDY_ORDER.map((remedy) => {
    const answers = ANSWERS[remedy].some((code) => dominantCodes.has(code));
    const helps = remedy === 'more_days' ? answers && !nothingFitted : answers;
    return {
      remedy,
      likelyToHelp: helps,
      detail: helps ? DETAIL[remedy] : RULED_OUT[remedy],
    };
  });

  return plannerReadinessSchema.parse({
    schemaVersion: PLANNER_READINESS_VERSION,
    consideredCount: input.consideredCount,
    selectedCount: input.selectedCount,
    eligibleCount: input.eligibleCount,
    feasibleCount: input.feasibleCount,
    scheduledCount: input.scheduledCount,
    rejections,
    dominantBlockers,
    remedies,
    summary: summarise(input, dominantBlockers),
  });
}

function summarise(input: ReadinessInput, dominant: readonly PlannerRejection[]): string {
  if (input.selectedCount === 0) {
    return 'Nothing on the board is marked to include, so there was nothing to plan.';
  }
  if (input.eligibleCount === 0) {
    return `None of the ${input.selectedCount} places you picked has a travel time we could measure, so none of them could be placed in a day.`;
  }
  if (input.feasibleCount === 0) {
    return `All ${input.selectedCount} places you picked are unreachable or shut on every one of your ${input.dayCount} days.`;
  }
  const lead = dominant[0];
  const blocker = lead ? REASON_PHRASES[lead.reasonCode] : 'they could not be laid out into a day';
  return `${input.feasibleCount} of the ${input.selectedCount} places you picked were reachable and open, and none of them could be scheduled: ${blocker}.`;
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
  exceeds_daily_travel: 'getting to any of them and back is further than you said you would drive in a day',
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
};
