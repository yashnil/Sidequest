import { NEUTRAL_COPY, forbiddenTokensIn } from '@/lib/benchmark/vocabulary';

/**
 * THE WORDS THIS SURFACE ADDS, AND THE FILTER EVERY BORROWED WORD GOES THROUGH.
 *
 * `NEUTRAL_COPY` in `lib/benchmark/vocabulary.ts` is the canonical list and this
 * module may not edit it, so anything the screens need that is not already there
 * lives here — under the same rule, and checked by the same predicate. The
 * leakage test in this directory asserts that every string literal in every
 * module under `app/labs` and `components/benchmark` is clean, which means this
 * file is checked exactly like the ones that use it rather than being trusted.
 *
 * The second half of the file is the more interesting one. Neutral copy handles
 * the words *we* write. It does nothing at all about the words that arrive at
 * render time: a follow-up question composed by one of the two systems, a plan
 * summary, a place name, a case title from the shared library — every one of
 * those is text this surface renders and none of it was written under the
 * blinding rules. One of the seventeen library cases is literally titled "with a
 * prompt-injection payload in the free text", and rendering it verbatim would
 * put a banned word on the page through no fault of anybody's copy.
 *
 * So text from outside is redacted on its way in, and the decision to redact is
 * made by `forbiddenTokensIn` — the same function the tests assert with, so the
 * filter and the check can never disagree about what counts.
 */

/** What a redacted span becomes. Visible, so nobody mistakes it for the text. */
const REDACTION = '[removed]';

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Text with anything identifying taken out of it.
 *
 * The predicate decides *whether* to touch the string; the replacement is
 * deliberately blunt once it has. Matching the token again with its own
 * word-boundary rules would mean restating a rule that lives in one place, and a
 * duplicated rule that drifts is how a redactor comes to disagree with the test
 * that guards it. A string that trips the check gets slightly over-redacted; a
 * string that does not is returned untouched, which is every string this
 * function sees in practice.
 */
export function redactForbidden(text: string): string {
  const found = forbiddenTokensIn(text);
  if (found.length === 0) return text;
  let redacted = text;
  for (const token of found) {
    redacted = redacted.replace(new RegExp(escapeForRegExp(token), 'gi'), REDACTION);
  }
  return redacted;
}

/**
 * The same treatment, applied to every string inside a structure.
 *
 * Field by field would mean the guarantee held only for the fields somebody
 * remembered, and the fields nobody remembered are exactly the ones a leak hides
 * in — an unrendered `title` on a source, a place name inside a travel leg. A
 * walk over the whole value is total by construction.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactForbidden(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry);
    return out as unknown as T;
  }
  return value;
}

/**
 * A minute count from local midnight, as a clock face.
 *
 * `null` is a stated absence rather than midnight, which is the distinction the
 * plan schema is careful about and which a `?? 0` would destroy.
 */
export function clockTime(minute: number | null): string {
  if (minute === null) return NEUTRAL_COPY.notStated;
  const wrapped = minute % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * ONE CURRENCY RENDERER, USED EVERYWHERE A MICRO-USD FIGURE IS DISPLAYED.
 *
 * The unit table exists because a cost read as a count is a figure quoted a
 * million times too small — and the display layer reintroduced exactly that
 * ambiguity: one panel printed "41000 micro_usd" while another printed
 * "~ 0.0623", under the same heading on the same page.
 */
export function usd(microUsd: number): string {
  return `~ $${(microUsd / 1_000_000).toFixed(4)}`;
}

/** Minutes as something a person reads, or the stated absence. */
export function durationText(minutes: number | null): string {
  if (minutes === null) return NEUTRAL_COPY.notStated;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * A stable, producer-independent sort key for a string.
 *
 * Used to shuffle the pooled follow-up questions. Sorting them by the id each
 * system minted would group one system's questions together and put the same
 * system's block first every time, which is an ordering tell that survives every
 * word on the page being neutral. A hash is stable across reloads — so the list
 * does not reorder under the reviewer — and carries nothing about who asked.
 */
export function stableSortKey(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/* ------------------------------------------------------------------ *
 * The copy
 * ------------------------------------------------------------------ */

export const LABS_COPY = {
  shellDescription: 'An internal screen for rating two trip plans side by side.',
  skipToContent: 'Skip to content',
  homeLabel: 'All comparisons',

  /* The session index. */
  indexLede: 'Every comparison that has been started, and what each one is waiting for.',
  startOne: 'Start a comparison',
  noneYet: 'Nothing has been started yet.',
  openLabel: 'Open',
  createdAt: 'Started',
  progressHeading: 'Progress',
  countQuestions: 'Questions',
  countPlans: 'Plans',
  countRounds: 'Change requests',
  dashboardLink: 'Totals across every comparison',

  /**
   * One word per lifecycle state, and each says what the reviewer does next
   * rather than what the machinery is doing.
   */
  sessionStates: {
    created: 'Not started',
    preparing: 'Looking around',
    awaiting_answers: 'Waiting on you',
    running: 'Working',
    ready_for_review: 'Ready to review',
    review_locked: 'Review locked',
    revealed: 'Identities shown',
    corrections: 'Changes requested',
    complete: 'Finished',
    abandoned: 'Stopped',
  },

  /* Starting one. */
  newTitle: 'Start a comparison',
  newLede: 'One request goes to both plans, word for word. Pick a saved traveller, or write one out.',
  chooseSaved: 'Start from a saved traveller',
  chooseSavedHint: 'Seventeen travellers written down once, so every comparison plans the same trips.',
  writeYourOwn: 'Write the request out',
  writeYourOwnHint: 'Everything not asked for here is filled in with an ordinary answer.',
  savedTravellerLabel: 'Saved traveller',
  submitSaved: 'Use this traveller',
  submitWritten: 'Use what I have written',
  couldNotStart: 'That request could not be used. Check the fields marked below.',

  /* The composer's own fields. */
  fieldDestination: 'Where',
  fieldDestinationHint: 'A town, a city, a region or a country.',
  fieldStart: 'Arrive',
  fieldEnd: 'Leave',
  fieldAdults: 'Adults',
  fieldChildren: 'Children',
  fieldCar: 'Is there a car?',
  fieldCarYes: 'Yes, we can drive',
  fieldCarNo: 'No car',
  fieldTransport: 'How would you rather get around?',
  fieldMaxDrive: 'Most driving in a day (minutes)',
  fieldMaxTravel: 'Most travelling in a day (minutes)',
  fieldBases: 'Places to sleep',
  fieldBaseChanges: 'Times you will move',
  fieldPace: 'Pace',
  fieldIntensity: 'How hard the days should be',
  fieldFreeTime: 'Free time',
  fieldEarly: 'Early starts',
  fieldCrowds: 'Crowds',
  fieldMix: 'Famous or quiet',
  fieldBudget: 'Spending',
  fieldInterests: 'What matters, and how often',
  fieldInterestsHint: 'Anything left alone is treated as "only if it is right there".',
  fieldFreeText: 'Anything else',
  fieldFreeTextHint: 'Passed to both, word for word.',

  /* The run screen. */
  runTitle: 'Building both plans',
  runLede: 'Both are being built from the same request. Nothing on this screen says which is which.',
  /**
   * One statement for the pair, and never one per arm.
   *
   * A badge per panel, refreshed every second and a half, announced the quicker
   * arm on every session — one screen earlier than the review, which is gated on
   * both having stopped for precisely that reason. "One of two finished" is the
   * same tell wearing a pooled shape, so these three sentences are the only
   * three this screen is able to say.
   */
  pooledStates: {
    not_started: 'Neither has been started',
    asking: 'Neither has been started',
    working: 'Both are still being built',
    finished: 'Both have finished',
  },
  startBoth: 'Start both',
  startedNote: 'Both were started together.',
  preparingNote:
    'Looking at the area both plans will be built from. This takes a few minutes and nothing is being planned yet.',
  askingNote:
    'The area has been looked at. Answer anything below that you want to, then ask for the plans.',
  planBoth: 'Build both plans',
  planBothHint:
    'Both plans are built together, from the same answers. Anything you leave blank stays unanswered — that is a legitimate answer and is recorded as one.',
  elapsedLabel: 'Time since both were started',
  questionsHeading: 'Questions to answer',
  /*
   * What the screen may honestly claim.
   *
   * It used to say the questions "came from both plans", which is true of the
   * fixture seam and false of every live session: one arm derives its follow-ups
   * from the research it just did, and the other answers its own clarifications
   * from the shared request without ever asking the traveller. Telling a human
   * subject something untrue on the screen where they decide how much to
   * disclose is worse than telling them less.
   */
  questionsLede:
    'Questions raised while looking at the area. They are pooled and unlabelled on purpose, and your answer goes to both plans wherever both can act on it.',
  questionsNone: 'Nothing has been asked.',
  questionWhy: 'Why this is being asked',
  answerLabel: 'Your answer',
  answerSubmit: 'Save this answer',
  answerSaved: 'Answered',
  answersClosed: 'Unanswered — you asked for the plans before this was answered.',
  answerRefused:
    'That was not saved. Pick one of the options, keep it under 500 characters, and answer before asking for the plans.',
  goToReview: 'Go to the review',
  refreshedJustNow: 'Kept up to date on its own.',

  /* Panel states, written once and used for both panels without exception. */
  panelStates: {
    pending: { title: 'Not started', body: 'Nothing has been built for this one yet.' },
    running: { title: 'Working', body: NEUTRAL_COPY.running },
    succeeded: { title: 'Finished', body: 'This one was built end to end.' },
    partial: { title: NEUTRAL_COPY.partialTitle, body: NEUTRAL_COPY.partialBody },
    failed: { title: NEUTRAL_COPY.failedTitle, body: NEUTRAL_COPY.failedBody },
  },

  /* The plan body. */
  planSummary: 'In short',
  planOutline: 'The outline',
  planWhere: 'Where',
  planWhen: 'When',
  planHowWide: 'How wide it reaches',
  planDay: 'Day',
  planTheme: 'Theme',
  planStatedTotals: 'What it says the day adds up to',
  totalTravel: 'Travelling',
  totalDrive: 'Driving',
  totalFree: 'Free',
  blockFrom: 'From',
  blockTo: 'To',
  blockDistance: 'Distance',
  blockHowKnown: 'How that time is known',
  blockOpen: 'Says it is open',
  blockNote: 'Why it is here',
  blockUnsure: 'Unsure about',
  blockSupport: 'Supporting sources',
  nights: 'Nights',
  noDays: 'No days given',
  noBases: 'No places to sleep given',
  noExclusions: 'Nothing was recorded as left out',
  noPreparation: 'Nothing to get ready',
  noWarnings: 'Nothing flagged',
  emptyDay: 'Nothing is planned for this day',

  blockKinds: {
    activity: 'Something to do',
    travel: 'Getting there',
    meal: 'Eating',
    free_time: 'Free time',
    rest: 'Rest',
    transfer: 'Moving on',
  },

  travelModes: {
    walk: 'On foot',
    drive: 'By car',
    transit: 'Local services',
    rail: 'By train',
    bus: 'By bus',
    ferry: 'By boat',
    shuttle: 'By shuttle',
    bicycle: 'By bicycle',
    taxi: 'By taxi',
    unknown: NEUTRAL_COPY.unknownValue,
  },

  travelProvenances: {
    measured: 'Measured for this pair',
    published_timetable: 'From a published timetable',
    unknown: 'Nobody measured it',
  },

  mealSlots: {
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
    snack: 'Something small',
  },

  mealStopKinds: {
    venue: 'At a place that serves it',
    grocery: 'Bought on the way',
    packed: 'Carried',
    unstated: NEUTRAL_COPY.notStated,
  },

  /* The review. */
  reviewTitle: 'Rate the two plans',
  reviewLede:
    'Read both, then answer for each one. You can say you cannot judge wherever that is the honest answer.',
  reviewerLabel: 'Who is reviewing',
  ratingsHeading: 'How good is each one?',
  ratingScaleHint: 'Seven is always the better end.',
  cannotRateLabel: 'I cannot rate this one',
  cannotRateReason: 'Why not',
  choicesHeading: 'Side by side',
  choiceOptions: {
    A: NEUTRAL_COPY.planLabel('A'),
    B: NEUTRAL_COPY.planLabel('B'),
    tie: 'The same',
    cannot_judge: 'Cannot judge',
  },
  explanationLabel: 'Why did you choose that?',
  explanationHint: 'At least twenty characters. This is the one written answer that is required.',
  explanationTooShort: 'A sentence, please — twenty characters or more.',
  correctionHeading: 'Ask for a change',
  correctionLede:
    'One instruction, sent to both plans word for word. There is no way to ask only one of them.',
  correctionLabel: 'What should change?',
  correctionSubmit: 'Send to both',
  correctionRoundsUsed: 'Rounds used',
  correctionLimitReached: 'Both have had as many rounds as they are allowed.',
  correctionUnavailable: 'A change cannot be asked for at the moment. Nothing was sent.',
  correctionSent: 'Sent to both.',
  correctionNoResult:
    'Neither produced a revised plan. The request is recorded and both are unchanged.',
  lockHeading: 'Finish and lock',
  lockLede:
    'Locking saves your answers and cannot be undone. Only after that can either identity be shown.',
  lockButton: 'Lock this review',
  lockConfirmHeading: 'Lock this review?',
  lockConfirmBody: 'Nothing can be changed afterwards.',
  lockConfirm: 'Yes, lock it',
  lockCancel: 'Not yet',
  lockIncomplete: 'Every question above needs an answer before this can be locked.',
  lockRefused: 'This review was already locked. Nothing was changed.',
  locking: 'Locking…',
  /**
   * The only thing the autosave region ever says.
   *
   * There is deliberately no "Saving…" any more. Announcing the transient state
   * meant two interruptions per pause in typing, on the one written answer this
   * form requires, for a screen-reader user who cannot skip past them.
   */
  draftSaved: 'Saved',
  switchTo: 'Show',

  /* The per-session report. */
  resultsTitle: 'What the two were',
  resultsRefusal:
    'Nothing here can be shown until the review is locked. That order is the whole point of it.',
  backToReview: 'Back to the review',
  revealHeading: 'Show which is which',
  revealLede:
    'Your answers are locked. Opening this shows the identities and cannot be undone.',
  revealButton: 'Show me',
  identityHeading: 'Which was which',
  findingsHeading: 'What the checks found',
  severities: {
    critical: 'Cannot be done',
    major: 'Breaks something that was asked for',
    minor: 'Below the bar',
    informational: 'Worth recording',
    unknown: 'Could not be decided',
  },
  verifiabilityHeading: 'How much could be checked',
  verifiabilityBody:
    'Checks decided over checks attempted, beside the count that could not be decided. Neither number means anything on its own.',
  attempted: 'Attempted',
  decided: 'Decided',
  undecided: 'Could not be decided',
  latencyHeading: 'How long it took',
  costHeading: 'What it cost',
  costIsAnEstimate:
    'An estimate worked out from a checked-in rate table. It is not a bill and has never been one.',
  unpricedCalls: 'Calls nobody could price',
  evidenceHeading: 'How much is backed up',
  evidenceBody: 'Parts of the day that name a supporting source, out of all of them.',
  diagnosticsHeading: 'What each one produced in its own shape',
  diagnosticsHint: 'Kept because the neutral conversion loses things. Long, and rarely needed.',
  postRevealHeading: 'Now that you know',
  postRevealLede:
    'The last four questions, and the one that matters most is the last: did anything give it away?',
  postRevealSave: 'Save these answers',
  postRevealSaved: 'Saved.',
  notMeasured: 'Not measured',
  notPriced: 'Nothing that could be priced',
  postRevealQuestions: {
    slowerPlanJustifiesWait: 'Was the slower one worth the wait?',
    wouldWaitForTheBetterPlan: 'Would you wait longer for the better one?',
    wouldUseForARealTrip: 'Which would you use for a real trip?',
    wouldPayMoreFor: 'Would you pay more for either?',
    /**
     * The manual blinding audit, and worth more than the automated one: a token
     * scan proves the banned words are absent and can prove nothing at all about
     * length, structure or tone.
     */
    suspectedIdentityBecause: 'Did anything give it away?',
  },

  /* The cross-session dashboard. */
  dashboardTitle: 'Totals across every comparison',
  dashboardLede: 'Counts first. Rates only where there are enough of them to mean anything.',
  /**
   * The four gates the pre-registered rules put in front of the sample label,
   * printed as readings rather than as a verdict.
   *
   * A label that says only "not enough yet" invites the reader to guess how much
   * is missing, and the guess is always optimistic. Showing each count against
   * its threshold makes the distance visible without anybody having to open the
   * rules file.
   */
  sampleGatesHeading: 'What a meaningful sample would need',
  gateSessions: 'Real comparisons',
  gateReviewers: 'People reviewing',
  gateCaseTypes: 'Kinds of trip with both orderings covered',
  gateReading: (have: number, need: number) => `${have} of ${need}`,
  /** How many observations a figure was worked out from. Printed beside each. */
  sampleSize: (n: number) => `n = ${n}`,
  /**
   * A total that is missing some of its parts, said so in the total itself.
   *
   * A sum over four runs of which two recorded nothing is a lower bound, and
   * printing it as a plain number is the same lie as coalescing the absences to
   * zero — worse, because it looks complete.
   */
  atLeastOverRuns: (over: number, of: number) => `at least, over ${over} of ${of} runs`,
  overRuns: (of: number) => `over ${of} runs`,
  atLeastPrefix: 'At least',
  /** No validator ever ran on this plan. Not the same fact as "no defects". */
  notValidated: 'Not validated',
  weightLabels: {
    smoke: 'Implementation smoke test',
    pilot: 'Directional pilot',
    sample: 'Meaningful sample',
  },
  weightBodies: {
    smoke:
      'Too few comparisons to say anything about either. What follows shows that the machinery runs, and nothing else.',
    pilot:
      'Enough to point at something worth looking into. Not enough to settle any of it.',
    sample:
      'Enough comparisons that the counts below are worth reading. They are still counts, not proof.',
  },
  tooFewForARate: 'Too few to give a rate',
  totalsHeading: 'Comparisons',
  totalSessions: 'Started',
  totalReviewed: 'Reviewed and locked',
  totalPartial: 'Ended part-built',
  totalFailed: 'Ended unbuilt',
  choiceHeading: 'Which one was chosen',
  tieCount: 'The same',
  cannotJudgeCount: 'Could not judge',
  winsLabel: 'Chosen',
  nonTiedRate: 'Share of the ones that were not a draw',
  ratingsAverageHeading: 'Average of each rating',
  defectsAreNotComparableInLevel:
    'These counts are not comparable between the two as levels. The shared checks resolve places against one shared record of the area, and the two plans draw on it to different degrees — so one is simply asked more questions than the other. The rate per hundred decided checks is the comparable figure, and the last row says how far apart the two denominators were.',
  defectsDecided: 'Checks actually decided',
  defectsPerHundred: 'Serious problems per 100 decided checks',
  defectsNotInInventory: 'Checks skipped: place not in the shared record',
  defectHeading: 'What the checks found',
  correctionsHeading: 'Change requests',
  timingHeading: 'Time',
  timingClocksDiffer:
    'Two different clocks. The per-plan figure is that plan alone, and the two are built one after the other — so adding them together is not what anybody waited. The session figures below are.',
  timeToFirstValue: 'To something usable',
  timeArmOperation: 'This plan alone, once it started',
  timeSessionWall: 'Start to finish, everything included',
  timeSessionMachine: 'Of that, without the time you spent answering',
  timeHumanWait: 'Of that, the time you spent answering',
  timeSharedPreparation: 'Shared groundwork, charged to neither',
  parityHeading: 'What each plan could hear',
  parityBody:
    'One request went to both, and this is what became of every field of it inside this plan. A field with nowhere to land is recorded rather than quietly dropped, because a difference in plumbing reads exactly like a difference in planning.',
  parityNone: 'No record was kept for this plan.',
  parityCounts: (binding: number, advisory: number, dropped: number) =>
    `${binding} acted on · ${advisory} stored only · ${dropped} nowhere to put`,
  transferHeading: 'What your answers reached',
  transferCounts: (applied: number, notRepresentable: number, unanswered: number) =>
    `${applied} passed on · ${notRepresentable} nowhere to put · ${unanswered} unanswered`,
  orderCellHeading: 'Split by which one you read first',
  orderCellWhy:
    'With one person reading, a preference for whichever came first looks exactly like a preference for one of the plans. Splitting on which one was actually shown first is what tells them apart: a pure position preference wins one half and loses the other, and a real preference wins both.',
  orderCellLabel: (first: string) => `${first} shown first`,
  /**
   * What a producing system is called before any session has been revealed.
   *
   * The totals page is two clicks from every blind screen and printed both
   * system names unconditionally. Nothing on it is attributed to a system until
   * that session is revealed, so before the first reveal the names label columns
   * of nothing — and the index is stable, so a reader comparing two visits is
   * comparing the same two columns.
   */
  systemPlaceholder: (index: number) => `System ${index}`,
  warmthHeading: 'First run or a repeat',
  warmthCold: 'First run',
  warmthWarm: 'Repeat',
  warmthMixed: 'Both',
  warmthUnknown: NEUTRAL_COPY.unknownValue,
  breakdownHeading: 'By kind of trip',
  fixtureHeading: 'Practice comparisons',
  fixtureBody:
    'Made from stored examples rather than from a real run. Counted separately and never mixed in.',
  liveHeading: 'Real comparisons',

  /* The one error surface. */
  errorRetry: 'Try again',
} as const;

/**
 * The fixture seam's own words, kept apart from the rest.
 *
 * Separate so that nothing a reviewer sees during a real sitting can borrow one
 * of them by accident, and so a reader can tell at a glance which strings belong
 * to the product and which belong to the scaffolding around it.
 */
export const FIXTURE_COPY = {
  heading: 'Write a practice comparison',
  body: 'Fills a whole comparison from stored examples so the screens can be driven without waiting for anything to be built. Never counted with real ones.',
  caseLabel: 'Traveller',
  seedLabel: 'Name for this one',
  shapeLabel: 'How it should turn out',
  /** Keyed by shape, so the select cannot offer an option nothing names. */
  shapeNames: {
    both_complete: 'Both finished',
    partial_and_failed: 'One part-built, one unbuilt',
    awaiting_answers: 'Stopped at the questions, nothing answered',
  },
  write: 'Write it',
  writing: 'Writing…',
  refused: 'Refused. Practice comparisons are switched off in this build.',
} as const;
