import type { BenchmarkGroundTruth, InventoryEntry } from '../ground-truth';
import { type BenchFinding } from '../schemas/finding';
import { type BenchmarkPlan, type PlanBlock, type PlanDay } from '../schemas/plan';
import type { HARD_AVOIDANCES, MOBILITY_CONSTRAINTS } from '../schemas/request';
import {
  displayNameOf,
  entityIdOf,
  isActivity,
  normaliseTag,
  normaliseText,
  report,
  safeArray,
  subjectOf,
  unresolved,
  type CheckContext,
} from './context';

/**
 * The things the traveller said out loud.
 *
 * These are the checks where a violation is not a matter of taste. A hard
 * avoidance is a filter rather than a leaning — the request schema says so in as
 * many words — so a plan containing one has broken an instruction rather than
 * made a debatable call, and that is why every finding here is critical.
 *
 * All of it turns on ground truth the inventory may simply not hold. An entry
 * with no access record and no tags cannot exonerate or convict a plan, and the
 * check says `unknown` rather than assuming the place is fine. Assuming it is
 * fine would let a system score well by choosing obscure places nobody has
 * catalogued.
 */

type MobilityConstraint = (typeof MOBILITY_CONSTRAINTS)[number];

/** Everything that makes a strenuous or serviceless place a problem. */
const RESTRICTIVE_MOBILITY: readonly MobilityConstraint[] = [
  'limited_walking',
  'no_stairs',
  'wheelchair_user',
  'low_stamina',
  'altitude_sensitive',
];

/**
 * How a hard avoidance is recognised in the shared tag vocabulary.
 *
 * Tags, never names. The inventory publishes categories; the traveller picked
 * from a closed list; this table is the join between them, and it is exported so
 * a test can pin every avoidance to at least one tag rather than letting an
 * unmapped one silently never fire.
 */
export const AVOIDANCE_TAGS: Record<(typeof HARD_AVOIDANCES)[number], readonly string[]> = {
  crowds_and_tourist_traps: ['crowded', 'crowds', 'tourist_trap', 'very_busy'],
  long_hikes: ['long_hike', 'multi_hour_hike', 'full_day_hike', 'backpacking'],
  strenuous_activity: ['strenuous', 'steep', 'scramble'],
  long_drives: ['long_drive', 'remote_drive'],
  rough_or_unpaved_roads: ['unpaved', 'gravel', 'rough_road', 'four_wheel_drive'],
  high_altitude_exertion: ['high_altitude', 'altitude'],
  early_mornings: ['sunrise', 'pre_dawn', 'early_morning'],
  remote_areas_without_services: ['remote', 'no_services', 'backcountry', 'wilderness'],
  expensive_activities: ['expensive', 'high_cost', 'premium_priced'],
  cold_water: ['cold_water', 'glacial_water', 'snowmelt'],
  extreme_heat: ['extreme_heat', 'desert_heat'],
  extreme_cold: ['extreme_cold', 'sub_zero'],
  boats_and_ferries: ['boat', 'ferry', 'cruise', 'kayak'],
  nightlife: ['nightlife', 'bar', 'club', 'late_night'],
  heights_and_exposure: ['exposure', 'exposed', 'cliff_edge', 'heights', 'via_ferrata'],
  small_aircraft: ['small_aircraft', 'flightseeing', 'bush_plane', 'helicopter'],
};

export function checkConstraints(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  for (const day of safeArray(plan.days)) {
    safeArray(day.blocks).forEach((block, index) => {
      if (!isActivity(block)) return;
      findings.push(...checkMobility(day, block, index, truth, ctx));
      findings.push(...checkAvoidances(day, block, index, truth, ctx));
    });
  }

  findings.push(...checkMustDo(plan, truth, ctx));
  return findings;
}

/* ------------------------------------------------------------------ *
 * Mobility and access
 * ------------------------------------------------------------------ */

function checkMobility(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });

  if (entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'mobility_conflict',
        subject,
        `${displayNameOf(block)} carries no shared identity, so nothing is known about getting to it.`,
        'plan.days[].blocks[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  const entry = truth.place(entityId);
  if (!entry) {
    ctx.undecided();
    return [
      unresolved(
        'mobility_conflict',
        subject,
        `The shared inventory does not hold ${displayNameOf(block)}.`,
        'truth.place',
        'subject_not_in_inventory',
      ),
    ];
  }
  if (
    entry.strenuous === null &&
    entry.unpavedApproach === null &&
    entry.remoteNoServices === null &&
    entry.requiresCar === null
  ) {
    ctx.undecided();
    return [
      unresolved(
        'mobility_conflict',
        subject,
        `Nobody has recorded how ${entry.name} is reached or how hard it is.`,
        'truth.place',
        'no_dataset',
      ),
    ];
  }

  ctx.decided();
  const conflict = firstMobilityConflict(entry, ctx);
  if (!conflict) return [];
  return [
    report(
      'mobility_conflict',
      'critical',
      subject,
      `${entry.name} ${conflict.because}, which the traveller told us they cannot do.`,
      'truth.place',
      { observed: { conflict: conflict.kind }, expected: { conflict: null } },
    ),
  ];
}

/**
 * One finding per stop, naming the first conflict in a fixed order.
 *
 * A place that is strenuous *and* down a gravel track is one problem for the
 * traveller, not two, and emitting a finding for each would let a single
 * unsuitable stop outweigh a whole broken day.
 */
function firstMobilityConflict(
  entry: InventoryEntry,
  ctx: CheckContext,
): { kind: string; because: string } | null {
  const party = ctx.request?.party;
  const movement = ctx.request?.movement;
  const mobility = safeArray(party?.mobility) as readonly MobilityConstraint[];
  const restricted = mobility.some((constraint) => RESTRICTIVE_MOBILITY.includes(constraint));

  if (entry.strenuous === true && restricted) {
    return { kind: 'strenuous', because: 'is a strenuous visit' };
  }
  if (entry.unpavedApproach === true && movement?.comfortableUnpavedRoads === false) {
    return { kind: 'unpaved_approach', because: 'is reached on an unpaved road' };
  }
  if (entry.remoteNoServices === true && restricted) {
    return { kind: 'remote_no_services', because: 'is out where there are no services' };
  }
  if (entry.requiresCar === true && movement?.carAvailable === false) {
    return { kind: 'requires_car', because: 'can only be reached by car' };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Hard avoidances
 * ------------------------------------------------------------------ */

function checkAvoidances(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const avoidances = safeArray(ctx.request?.taste?.hardAvoidances);
  // Nothing to enforce is not missing evidence. Counting an unknown per stop for
  // a traveller who ruled nothing out would bury the verifiability ratio in
  // noise about a question nobody asked.
  if (avoidances.length === 0) return [];

  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });

  if (entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'hard_avoidance_violated',
        subject,
        `${displayNameOf(block)} carries no shared identity, so its categories are unknown.`,
        'plan.days[].blocks[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  const entry = truth.place(entityId);
  if (!entry || entry.tags.length === 0) {
    ctx.undecided();
    return [
      unresolved(
        'hard_avoidance_violated',
        subject,
        `Nothing is on record about what kind of place ${displayNameOf(block)} is.`,
        'truth.place',
        entry ? 'no_dataset' : 'subject_not_in_inventory',
      ),
    ];
  }

  ctx.decided();
  const tags = new Set(entry.tags.map(normaliseTag));
  const violated = avoidances.filter((avoidance) => violates(avoidance, tags));
  if (violated.length === 0) return [];

  return [
    report(
      'hard_avoidance_violated',
      'critical',
      subject,
      `${entry.name} is ${violated.map(readable).join(' and ')}, which the traveller ruled out.`,
      'truth.place',
      { observed: { avoidances: violated.join(',') }, expected: { avoidances: '' } },
    ),
  ];
}

function violates(avoidance: (typeof HARD_AVOIDANCES)[number], tags: ReadonlySet<string>): boolean {
  if (tags.has(avoidance)) return true;
  const tokens = AVOIDANCE_TAGS[avoidance] ?? [];
  for (const tag of tags) {
    const parts = new Set(tag.split('_'));
    for (const token of tokens) {
      if (tag === token) return true;
      // Whole-token matching only. Substring matching would let "harbour" answer
      // for "bar" and turn a waterfront walk into a nightlife violation.
      if (!token.includes('_') && parts.has(token)) return true;
      if (token.includes('_') && tag.includes(token)) return true;
    }
  }
  return false;
}

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Must-do
 * ------------------------------------------------------------------ */

/**
 * THE ONE PLACE NAME MATCHING IS PERMITTED.
 *
 * Everywhere else in this validator, places are resolved by `entityId`, because
 * a checker that matched "Convict Lake" to a block by string similarity would
 * turn phrasing into a scoring axis and would quietly favour whichever system
 * names things the way the checker's author does.
 *
 * `taste.mustDo` is free text by design — a closed list could not hold "the
 * sunrise hike my brother did" — so there is no identity to match on, for either
 * competitor, and the choice is between text matching and not checking must-dos
 * at all. Text matching is therefore confined to this function and to two kinds
 * of haystack: what the plan put on the timeline, and the names of the places it
 * says it left out.
 *
 * Free-text reasons are deliberately not among them. An exclusion reason is
 * prose about *why*, of no fixed length, and one converter concatenates the
 * reason with the remedy it suggests — so the same must-do was likelier to be
 * found in the longer sentence, and finding it turned a critical
 * `must_do_ignored` into a major `must_do_deferred_with_reason`. A severity that
 * moves with how much a system writes is not measuring the plan.
 */
function checkMustDo(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const mustDo = safeArray(ctx.request?.taste?.mustDo);
  if (mustDo.length === 0) return findings;

  const scheduledText = scheduledPhrases(plan);
  const exclusions = safeArray(plan.exclusions);

  for (const wanted of mustDo) {
    const needle = normaliseText(String(wanted));
    if (needle.length === 0) continue;

    if (scheduledText.some((phrase) => mentions(phrase, needle))) {
      ctx.decided();
      continue;
    }

    const excluded = exclusions.find((exclusion) =>
      mentions(normaliseText(String(exclusion.place?.name ?? '')), needle),
    );

    if (!excluded) {
      ctx.decided();
      findings.push(
        report(
          'must_do_ignored',
          'critical',
          {},
          `"${wanted}" is something the traveller asked for, and the plan neither includes it nor says why not.`,
          'request.taste.mustDo',
          { observed: { mustDo: String(wanted), scheduled: false, explained: false } },
        ),
      );
      continue;
    }

    /*
     * THREE OUTCOMES, BECAUSE "WE COULD NOT CHECK" IS NOT "THE REASON IS FALSE".
     *
     * This graded `major` unless the record confirmed the plan's reason — and the
     * record answers `unknown` for almost every place, because the shared opening
     * calendar reads one expression and refuses the rest. So a plan that gave a
     * reason nobody could verify scored identically to one whose reason was
     * contradicted, at a severity that sums into the defect count. That is
     * insufficient evidence graded as a defect, which is the one thing §8 says
     * must never happen.
     *
     * Confirmed is informational, contradicted is major, and unestablished is
     * `unknown` with a reason.
     */
    const verdict = exclusionReasonVerdict(excluded.place?.entityId ?? null, truth, ctx);
    const subject = excluded.place?.entityId ? { entityId: excluded.place.entityId } : {};

    if (verdict === 'unestablished') {
      ctx.undecided();
      findings.push(
        unresolved(
          'must_do_deferred_with_reason',
          subject,
          `"${wanted}" is left out with a reason, and nothing on record either supports or contradicts it.`,
          'truth.openingOn',
          'no_dataset',
        ),
      );
      continue;
    }

    ctx.decided();
    const confirmed = verdict === 'confirmed';
    findings.push(
      report(
        'must_do_deferred_with_reason',
        confirmed ? 'informational' : 'major',
        subject,
        confirmed
          ? `"${wanted}" is left out, and the reason holds: it is closed on every day of the trip.`
          : `"${wanted}" is something the traveller asked for and the plan leaves it out: ${excluded.reason}`,
        confirmed ? 'truth.openingOn' : 'plan.exclusions',
        {
          observed: {
            mustDo: String(wanted),
            groundTruthConfirms: confirmed,
            // See `derived` on the plan schema: whether this explanation was
            // written by the system or swept up from its reject pile.
            explanationWasDerived: excluded.derived === true,
          },
        },
      ),
    );
  }

  return findings;
}

/** Everything the plan actually put on the timeline, as flattened text. */
function scheduledPhrases(plan: BenchmarkPlan): string[] {
  const phrases: string[] = [];
  for (const day of safeArray(plan.days)) {
    for (const block of safeArray(day.blocks)) {
      if (block.kind === 'travel') continue;
      phrases.push(normaliseText(String(block.title ?? '')));
      const name = block.place?.name;
      if (typeof name === 'string') phrases.push(normaliseText(name));
      const venue = block.meal?.venue?.name;
      if (typeof venue === 'string') phrases.push(normaliseText(venue));
    }
  }
  return phrases.filter((phrase) => phrase.length > 0);
}

/**
 * Words that name a kind of thing to do without naming a thing to do.
 *
 * A block called "Breakfast" or "The hike" is a category, and a must-do that
 * happens to contain the word has not been satisfied by scheduling one —
 * "breakfast at the harbour bakery" would otherwise be answered by any breakfast
 * anywhere.
 *
 * Deliberately narrow. It holds bare activity nouns and the grammar around them
 * and nothing that turns up inside a place name, because a list containing
 * "trail" or "morning" would have disqualified "Morning Trail" — which is a
 * name, and exactly the match this is meant to keep. This is not a vocabulary
 * either system uses; it is the set of words that carry no reference.
 */
const GENERIC_ACTIVITY_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'at',
  'break',
  'breakfast',
  'brunch',
  'coffee',
  'dinner',
  'drinks',
  'drive',
  'driving',
  'food',
  'free',
  'hike',
  'hiking',
  'in',
  'lunch',
  'meal',
  'of',
  'on',
  'rest',
  'stop',
  'the',
  'time',
  'to',
  'tour',
  'visit',
  'walk',
  'walking',
]);

/**
 * Whether a phrase from the plan answers a phrase from the traveller.
 *
 * Containment forwards is unconditional: a block titled "Sunrise at Minaret
 * Vista" plainly satisfies a must-do of "Minaret Vista".
 *
 * Backwards — the plan's phrase sitting inside the traveller's longer one — is
 * kept because it is a real match, "Minaret Vista" against "sunrise at Minaret
 * Vista", but is now fenced. The unfenced version let a one-word block satisfy
 * any must-do containing that word, so a bare "Breakfast" answered "breakfast at
 * the harbour bakery" and a bare "Hike" answered almost anything, and the plan
 * that scheduled the least specific thing scored as having granted the request.
 * The fence is that the shorter side must name something: at least two words,
 * and at least one of them not a generic label for an activity.
 */
function mentions(haystack: string, needle: string): boolean {
  if (haystack.length === 0 || needle.length === 0) return false;
  if (haystack.includes(needle)) return true;
  if (!needle.includes(haystack)) return false;
  return namesSomething(haystack);
}

function namesSomething(phrase: string): boolean {
  const words = phrase.split(' ').filter((word) => word.length > 0);
  if (words.length < 2) return false;
  return words.some((word) => !GENERIC_ACTIVITY_WORDS.has(word));
}

/**
 * Whether ground truth backs the reason the plan gave.
 *
 * Only the strongest form counts: shut on every single date of the trip. A place
 * closed on one day was skippable rather than impossible, and calling that
 * confirmed would let any plan drop a must-do with a plausible sentence.
 */
function exclusionReasonVerdict(
  entityId: string | null,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): 'confirmed' | 'contradicted' | 'unestablished' {
  if (entityId === null || ctx.tripDates.length === 0) return 'unestablished';

  let sawAnswer = false;
  let closedEveryDay = true;
  for (const date of ctx.tripDates) {
    const opening = truth.openingOn(entityId, date);
    const seasonal = truth.seasonallyOpenOn(entityId, date);
    const closed =
      (opening !== null && opening.status === 'closed') || seasonal === false;
    // `always_open` is as positive a statement as `open` and used to be missed,
    // which turned a place with no gate at all into an unestablished one.
    const open =
      (opening !== null && (opening.status === 'open' || opening.status === 'always_open')) ||
      seasonal === true;
    if (closed || open) sawAnswer = true;
    if (!closed) closedEveryDay = false;
  }

  if (closedEveryDay && sawAnswer) return 'confirmed';
  // Something was established on at least one date and it was not "shut all
  // trip", so the reason is contradicted rather than merely unchecked.
  if (sawAnswer) return 'contradicted';
  return 'unestablished';
}

/** Exported so a test can pin the one permitted piece of text matching. */
export { mentions as matchesMustDoText };
