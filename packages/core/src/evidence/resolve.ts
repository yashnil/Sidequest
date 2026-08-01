import {
  factIndependenceKey,
  isFactStale,
  isOfficialAuthority,
  rankConflictingFacts,
  type FactPath,
  type FactVerificationState,
  type ResolvedFact,
  type SourceFact,
} from '../schemas/source-fact';

/**
 * THE RESOLVER.
 *
 * Several sources say things about one subject. This decides, deterministically,
 * which one the planner acts on and how much the product is entitled to claim.
 *
 * Three rules hold, and everything else is detail:
 *
 * 1. **A model never wins.** A `model_inference` fact cannot be accepted over a
 *    sourced one, and a set containing only model inferences never rises above
 *    `inferred`. There is an architecture test for this because a comment would
 *    not survive the next convenience.
 *
 * 2. **Corroboration means independence.** Two pages on one domain are one
 *    voice; the same bytes on two domains are one voice. `factIndependenceKey`
 *    is what decides, and when it cannot tell, it declines to group — so
 *    "cannot tell" costs a corroboration rather than granting one.
 *
 * 3. **Missing is not false.** A path nobody answered resolves to `unknown`,
 *    which is a state the planner reads and the UI shows. It never becomes a
 *    default, and a closure that was never found never becomes "open".
 *
 * The function is pure and takes `now`, so two runs of one compilation produce
 * byte-identical evidence — which is what makes a compiled artifact checkable.
 */

/**
 * How fast each kind of fact goes off, in days.
 *
 * Not one number, because they genuinely differ: a museum's address is true for
 * years and its winter hours are true for a season. A closure notice is the
 * shortest of all — it is the fact most likely to be *lifted* without anyone
 * telling us, and a stale closure strands a traveller in the opposite direction
 * from every other stale fact.
 */
export const FACT_SHELF_LIFE_DAYS: Record<FactPath, number> = {
  'identity.officialSite': 365,
  'identity.bookingUrl': 180,
  'hours.weekly': 90,
  'hours.seasonal': 180,
  'hours.lastAdmission': 90,
  'hours.closure': 21,
  'access.method': 180,
  'access.permit': 120,
  'booking.required': 120,
  'booking.timedEntry': 120,
  'booking.leadTime': 120,
  'cost.admission': 180,
  'cost.parking': 180,
  'cost.transport': 120,
  'duration.typical': 365,
  'safety.caution': 30,
  'safety.requirement': 180,
  'food.hours': 60,
  'food.price': 180,
  'food.dietary': 180,
  'food.reservation': 120,
};

/** The shelf life a fact should carry, where it did not bring its own. */
export function shelfLifeFor(path: FactPath): number {
  return FACT_SHELF_LIFE_DAYS[path];
}

/**
 * Whether two claims about the same path actually disagree.
 *
 * Deliberately conservative and textual: this system does not parse two opening
 * calendars and diff them, so it compares the normalised statement. The failure
 * mode is calling two phrasings of the same fact a conflict, which costs a
 * caution; the opposite failure — missing a real disagreement — costs somebody a
 * wasted morning. When in doubt, say the sources disagree.
 */
export function statementsDisagree(a: SourceFact, b: SourceFact): boolean {
  return normaliseStatement(a.statement) !== normaliseStatement(b.statement);
}

function normaliseStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9:.-]+/g, ' ')
    .trim();
}

export interface ResolveInput {
  facts: readonly SourceFact[];
  /** Every subject and path we wanted an answer for, so silence is reported. */
  wanted?: readonly { subjectId: string; factPath: FactPath }[];
  now: Date;
}

export interface ResolveResult {
  resolved: ResolvedFact[];
  /** Indexed for the callers that ask about one cell. */
  byKey: Map<string, ResolvedFact>;
}

export function resolutionKey(subjectId: string, path: FactPath): string {
  return `${subjectId}::${path}`;
}

export function resolveFacts(input: ResolveInput): ResolveResult {
  const groups = new Map<string, SourceFact[]>();
  for (const fact of input.facts) {
    if (!fact.factPath) continue;
    const key = resolutionKey(fact.subjectId, fact.factPath);
    const bucket = groups.get(key);
    if (bucket) bucket.push(fact);
    else groups.set(key, [fact]);
  }

  for (const want of input.wanted ?? []) {
    const key = resolutionKey(want.subjectId, want.factPath);
    if (!groups.has(key)) groups.set(key, []);
  }

  const resolved: ResolvedFact[] = [];
  for (const [key, facts] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [subjectId = '', path = ''] = key.split('::');
    resolved.push(resolveOne(subjectId, path as FactPath, facts, input.now));
  }

  const byKey = new Map(
    resolved.map((entry) => [resolutionKey(entry.subjectId, entry.factPath), entry]),
  );
  return { resolved, byKey };
}

function resolveOne(
  subjectId: string,
  factPath: FactPath,
  facts: readonly SourceFact[],
  now: Date,
): ResolvedFact {
  if (facts.length === 0) {
    return {
      subjectId,
      factPath,
      state: 'unknown',
      factIds: [],
      independentSources: 0,
      rationale: 'Nobody we could read publishes this.',
    };
  }

  /**
   * A fact whose page could not be read is evidence of an attempt, not of a
   * fact. It is kept — a broken official link is worth showing — but it can
   * never be the accepted answer.
   */
  const readable = facts.filter(
    (fact) =>
      fact.retrievalStatus !== 'fetch_failed' &&
      fact.retrievalStatus !== 'blocked_by_robots' &&
      fact.retrievalStatus !== 'rejected_unsafe',
  );
  if (readable.length === 0) {
    return {
      subjectId,
      factPath,
      state: 'unavailable',
      factIds: facts.map((fact) => fact.id),
      independentSources: 0,
      rationale: 'We found a source for this and could not read it.',
    };
  }

  const ranked = rankConflictingFacts(readable);
  const accepted = ranked[0]!;

  /**
   * An accepted fact whose only support is a model is not a fact.
   *
   * The whole set being model inference is the case this catches: the state
   * drops to `inferred`, which the planner does not enforce and the card labels
   * as worked out rather than looked up.
   */
  const modelOnly = ranked.every((fact) => fact.authorityKind === 'model_inference');

  const disagreeing = ranked.slice(1).filter((fact) => statementsDisagree(accepted, fact));
  const agreeing = ranked.filter((fact) => !statementsDisagree(accepted, fact));
  const independentSources = new Set(
    agreeing
      .filter((fact) => fact.authorityKind !== 'model_inference')
      .map((fact) => factIndependenceKey(fact)),
  ).size;

  const stale = isStaleFor(accepted, factPath, now);

  const state = decideState({
    accepted,
    modelOnly,
    conflicted: disagreeing.length > 0,
    independentSources,
    stale,
  });

  return {
    subjectId,
    factPath,
    state,
    ...(state === 'unknown' ? {} : { acceptedFactId: accepted.id }),
    factIds: [accepted.id, ...ranked.slice(1).map((fact) => fact.id)],
    independentSources,
    rationale: rationaleFor({
      state,
      accepted,
      conflictCount: disagreeing.length,
      independentSources,
    }),
  };
}

function decideState(input: {
  accepted: SourceFact;
  modelOnly: boolean;
  conflicted: boolean;
  independentSources: number;
  stale: boolean;
}): FactVerificationState {
  /**
   * Conflict outranks freshness and authority both.
   *
   * A traveller told "verified, and by the way two sources disagree" has been
   * told two incompatible things. Disagreement is the headline.
   */
  if (input.conflicted) return 'conflicted';
  if (input.modelOnly) return 'inferred';
  if (input.stale) return 'stale';
  if (input.accepted.derivation !== 'directly_stated') return 'inferred';
  if (isOfficialAuthority(input.accepted.authorityKind)) return 'verified';
  if (input.independentSources >= 2) return 'corroborated';
  return 'single_source';
}

/** A fact's own shelf life if it declared one, otherwise its path's. */
export function isStaleFor(fact: SourceFact, path: FactPath, now: Date): boolean {
  if (fact.shelfLifeDays !== undefined) return isFactStale(fact, now);
  return isFactStale({ ...fact, shelfLifeDays: shelfLifeFor(path) }, now);
}

function rationaleFor(input: {
  state: FactVerificationState;
  accepted: SourceFact;
  conflictCount: number;
  independentSources: number;
}): string {
  const who = input.accepted.authorityName;
  switch (input.state) {
    case 'verified':
      return `Stated by ${who}, which runs it.`;
    case 'corroborated':
      return `${input.independentSources} independent sources say the same thing.`;
    case 'single_source':
      return `${who} says so, and nobody else we read mentions it.`;
    case 'inferred':
      return `Worked out from what ${who} says rather than stated by anyone.`;
    case 'conflicted':
      return `${input.conflictCount + 1} sources disagree. We have kept them all and will not pick for you.`;
    case 'stale':
      return `${who} said so, but that was long enough ago to be worth rechecking.`;
    case 'unavailable':
      return 'We found a source for this and could not read it.';
    default:
      return 'Nobody we could read publishes this.';
  }
}
