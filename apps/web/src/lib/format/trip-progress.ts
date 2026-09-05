/**
 * WHERE A TRIP ACTUALLY IS, AS ONE ANSWER RATHER THAN A GUESS PER SCREEN.
 *
 * The homepage used to decide this with a single ternary: `draft` printed "Not
 * finished" and everything else printed "Discovery board ready". So a trip
 * whose build had died eight days earlier — job row still saying `running`, no
 * artifact, no board — was announced to the traveller as a finished discovery
 * board, and the link took them to a page that redirected them somewhere else.
 * A binary over a four-value column cannot say anything true about a journey
 * with seven distinct stopping points in it.
 *
 * This is the whole vocabulary, derived from facts that are all cheap to read:
 * the trip's own status column, the latest job row, and whether an itinerary
 * exists. Nothing here parses a compiled region — a homepage listing sixty
 * trips must not deserialise sixty regions to write sixty labels.
 *
 * Pure on purpose. The reads happen in the page; this decides what they mean,
 * so the meaning is testable without a database and cannot differ between the
 * two places that need it.
 */

export type TripProgressState =
  | 'not_started'
  | 'building'
  | 'build_stopped'
  | 'build_failed'
  | 'needs_answers'
  | 'board_ready'
  | 'plan_ready';

export interface TripProgressFacts {
  /** The trip's own status column: `draft` before anybody answered anything. */
  status: 'draft' | 'profiled' | 'discovering' | 'planned';
  /**
   * The latest compilation job's state, or null when none was ever started.
   *
   * `awaiting_input` is a build that stopped to ask the traveller something, so
   * it belongs with the states that need a person rather than with the ones
   * that are running — see the branch below, which routes it back to the flow
   * that holds the question.
   */
  jobState:
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'ready'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | null;
  /**
   * Whether that job is still alive — a heartbeat inside the timeout.
   *
   * Separate from the state because a killed process leaves the row saying
   * `running` for ever. `isAbandoned` in core owns the threshold; this only
   * needs the answer.
   */
  jobLive: boolean;
  /** Whether the job produced a region artifact this trip points at. */
  hasCompiledRegion: boolean;
  /** Whether a plan has been built, at any schema version. */
  hasItinerary: boolean;
}

export interface TripProgress {
  state: TripProgressState;
  /** What to call it in a list, in the traveller's language. */
  label: string;
  /** The one action that carries on from here. */
  action: string;
  /** Where that action goes, relative to the trip. */
  path: (tripId: string) => string;
  tone: 'neutral' | 'pine' | 'amber' | 'blue' | 'clay';
  /**
   * How near the top of "your trips" this belongs.
   *
   * Lower sorts first. The ordering is by what somebody is most likely to have
   * come back for — a build happening right now, then a finished plan, then
   * work that is waiting on them — rather than by creation date, which is what
   * buried the only planned trip in the product below seven abandoned drafts.
   */
  rank: number;
}

export function tripProgress(facts: TripProgressFacts): TripProgress {
  /*
   * A live build outranks everything, including a finished plan. Somebody who
   * left a build running came back to watch it, and telling them about last
   * week's itinerary instead is answering a question they did not ask.
   */
  if (facts.jobLive && (facts.jobState === 'queued' || facts.jobState === 'running')) {
    return {
      state: 'building',
      label: 'Building now',
      action: 'See how it is going',
      path: (id) => `/trips/${id}/plan`,
      tone: 'blue',
      rank: 0,
    };
  }

  if (facts.hasItinerary) {
    return {
      state: 'plan_ready',
      label: 'Plan ready',
      action: 'Open the plan',
      path: (id) => `/trips/${id}/itinerary`,
      tone: 'pine',
      rank: 1,
    };
  }

  /*
   * A compiled region and a set of answers means the board is genuinely there.
   * `status` carries the answers because `saveProfile` sets it — which is why
   * this needs no profile read.
   */
  if (facts.hasCompiledRegion && facts.status !== 'draft') {
    return {
      state: 'board_ready',
      label: 'Places found',
      action: 'Open the board',
      path: (id) => `/trips/${id}/discover`,
      tone: 'pine',
      rank: 2,
    };
  }

  /*
   * A build that paused for an answer is waiting on the traveller, not on us.
   * Ranked with the other things that need them rather than with the failures.
   */
  if (facts.jobState === 'awaiting_input') {
    return {
      state: 'needs_answers',
      label: 'Waiting on your answers',
      action: 'Answer the questions',
      path: (id) => `/trips/${id}/plan`,
      tone: 'amber',
      rank: 3,
    };
  }

  if (facts.hasCompiledRegion) {
    return {
      state: 'needs_answers',
      label: 'Waiting on your answers',
      action: 'Answer the questions',
      path: (id) => `/trips/${id}/questionnaire`,
      tone: 'amber',
      rank: 3,
    };
  }

  /*
   * A job that stopped without an artifact. `failed` and `cancelled` are told
   * apart because one is ours and one is theirs, and the sentence a traveller
   * needs is different: "it broke, try again" versus "you stopped this".
   */
  if (facts.jobState === 'failed' || (!facts.jobLive && facts.jobState === 'running') ||
      (!facts.jobLive && facts.jobState === 'queued')) {
    return {
      state: 'build_failed',
      label: 'Research stopped',
      action: 'Pick it up again',
      path: (id) => `/trips/${id}/plan`,
      tone: 'clay',
      rank: 4,
    };
  }

  if (facts.jobState === 'cancelled' || facts.jobState === 'partial') {
    return {
      state: 'build_stopped',
      label: facts.jobState === 'cancelled' ? 'You stopped this' : 'Finished with gaps',
      action: 'Pick it up again',
      path: (id) => `/trips/${id}/plan`,
      tone: 'amber',
      rank: 4,
    };
  }

  return {
    state: 'not_started',
    label: 'Not planned yet',
    action: 'Carry on',
    path: (id) => `/trips/${id}/plan`,
    tone: 'neutral',
    rank: 5,
  };
}
