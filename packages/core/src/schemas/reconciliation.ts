import { z } from 'zod';
import { provisionalIntentSchema } from './provisional';

/**
 * WHAT HAPPENED TO THE THINGS YOU PICKED.
 *
 * A traveller curates twelve places off a provisional board and gets five back.
 * That is not a bug — the research funnel is *for* discovering that a museum is
 * shut, a lake has no road to it, and two records were the same place. But it is
 * the moment the product is most likely to feel like it lied, and the difference
 * between "we found out these things" and "half your choices vanished" is
 * entirely whether every removal has a name attached to it.
 *
 * So reconciliation is deterministic, total, and reported. Every provisional
 * selection has exactly one outcome. A pinned place that did not survive is
 * never silently dropped: it appears with the reason, and with the best
 * deterministic alternative from the same cluster and role — **offered, not
 * applied**. Choosing a replacement on somebody's behalf while they are not
 * looking is how a plan comes to contain a place they never agreed to.
 *
 * ---
 *
 * WHAT CHANGED AT SCHEMA VERSION 2, AND WHY EACH FIELD IS HERE.
 *
 * Version 1 recorded an outcome and a sentence. That was enough to render a
 * panel and not enough to answer the questions somebody actually asks a week
 * later: *which* board did I mark this on, what did I say about it, is this the
 * same record that ended up in my plan, and did anybody ever tell me it was
 * gone? Each of the fields added below exists because one of those questions had
 * no stored answer.
 *
 *   - `provisionalBoardId` / `provisionalBoardVersion` — a board is superseded on
 *     every rebuild, and "you unpinned it" and "the board you pinned it on no
 *     longer exists" look identical without the identity the choice was made
 *     *on*. Stamping it from the board being reconciled *against* — which is
 *     what the first two slices did — is the same failure with more ceremony.
 *     Both are optional, because a mark that predates board identity has none
 *     and version 1 would be a guess dressed as a record.
 *   - `reasonCode` — the outcome says what happened; a machine-readable reason
 *     says *why*, in a closed vocabulary an export or a later slice can branch
 *     on without parsing English.
 *   - `explanation` — required, not optional. A row with no sentence is a row
 *     that renders as a name and a shrug, and the fallback copy is always
 *     available, so there is never a reason for one to be missing.
 *   - `finalPlaceId` — the identity that actually reached the plan. Absent for a
 *     removal, and for a duplicate it is the survivor: without it, "kept as
 *     something else" is a claim with nothing behind it.
 *   - `alternatives` — plural, deterministic, and each one carries the *basis*
 *     on which it is offered, so nothing here can be read as a substitution that
 *     was made.
 *   - `acknowledgementRequired` / the acknowledgement store — a pinned removal
 *     that scrolled past unread is, from the traveller's side, the same event as
 *     a silent one. The requirement lives on the entry; whether it *was*
 *     acknowledged is stored separately, because it is a fact about the person
 *     and not about the artifact.
 */

/**
 * Every way a provisional selection can end up.
 *
 * A closed enum, and each value corresponds to a real drop site in the compiler
 * rather than to a category somebody imagined. Adding a value means finding the
 * place in the pipeline that causes it.
 */
export const RECONCILE_OUTCOMES = [
  /** Survived, and nothing about it changed that a traveller would notice. */
  'retained',
  /** Survived, and verification changed something on the card. */
  'retained_with_changes',
  /** Two records turned out to be one place, and the survivor reached the plan. */
  'replaced_duplicate',
  /**
   * Two records turned out to be one place, and that place did not make it.
   *
   * `replaced_duplicate` used to be returned on the strength of a duplicate
   * mapping alone, without ever checking that the named survivor was on the
   * final board. It is vacuous today because deduplication runs before the cut —
   * but it is a claim the code was not entitled to make, and the moment
   * deduplication moves, or a survivor is later removed for being shut, the
   * traveller is told their place was "kept as" something that is not in their
   * plan. So the survivor is asserted, and this is what the assertion failing
   * looks like: a loss, with its own name.
   */
  'removed_duplicate_survivor_lost',
  /** An official source says it is shut on these dates. */
  'removed_closed',
  /**
   * A safety notice blocks it, which is a different claim from a closure.
   *
   * The evidence layer blocks a subject for either reason and used to report
   * both as `removed_closed` — "an official source says it is shut on your
   * dates". For a flood warning, an avalanche closure order or a public-health
   * notice that is a false statement about the world: the place is open and it
   * is not safe, and a traveller who reads "shut" will go back next week and
   * find the door unlocked. The remedies differ too, which is the practical
   * test for whether two things deserve one name.
   */
  'removed_safety_blocked',
  /** No route could be measured to it, so no day could hold it. */
  'removed_unreachable',
  /** A parent record covers it; keeping both would double-count the visit. */
  'removed_redundant',
  /** Nobody publishes enough about it to plan around it. */
  'removed_insufficient_support',
  /** Reachable, but not by the transport this traveller said they would use. */
  'removed_access_conflict',
  /** The source record was stale or failed validation on re-read. */
  'removed_stale_record',
  /**
   * The *identity* stopped resolving, as opposed to the record going stale.
   *
   * Distinct from `removed_stale_record` because the remedies are different and
   * the sentences are different. A stale record still names a place and the
   * details it carried have aged; an invalid identity means the id itself no
   * longer points anywhere — a merge that reversed, an external identifier that
   * was retired, a linked record that turned out to be two things. Collapsing
   * the two would tell somebody their museum's hours had changed when what
   * actually happened is that we can no longer say which museum it was.
   */
  'removed_identity_invalid',
  /** The budget ran out before we got to it. Ours, not the world's. */
  'unresolved_budget',
  /** A provider did not answer. A statement about us, never about the place. */
  'unresolved_infrastructure',
  /**
   * We read the sources and could not reconcile what they said.
   *
   * Not an infrastructure failure — everything answered — and not a removal,
   * because nothing established that the place is unusable. The honest position
   * is that verification ran and reached no conclusion, which is a third thing
   * and needs its own name or it gets filed as one of the other two.
   */
  'unresolved_verification_failed',
  /**
   * The outcome that used to be silence.
   *
   * A choice we can find no trace of: not on the board version being reconciled,
   * not on the final one, and with no recorded removal. Every other value here
   * is a statement about a place; this one is a statement about *us*, and it
   * exists so the pipeline can admit it lost track of something rather than
   * simply not mentioning it. If this ever appears in volume, that is a defect
   * report and not a category of travel.
   */
  'disappeared_unexpectedly',
] as const;
export const reconcileOutcomeSchema = z.enum(RECONCILE_OUTCOMES);
export type ReconcileOutcome = z.infer<typeof reconcileOutcomeSchema>;

export function isRemoval(outcome: ReconcileOutcome): boolean {
  return outcome.startsWith('removed_');
}

export function isUnresolved(outcome: ReconcileOutcome): boolean {
  return outcome.startsWith('unresolved_');
}

/** Neither kept nor explained: the outcome that names a failure of ours. */
export function isUnaccounted(outcome: ReconcileOutcome): boolean {
  return outcome === 'disappeared_unexpectedly';
}

/** Whether the traveller ended the funnel without the thing they chose. */
export function isLoss(outcome: ReconcileOutcome): boolean {
  return isRemoval(outcome) || isUnresolved(outcome) || isUnaccounted(outcome);
}

/**
 * The machine-readable half of "why".
 *
 * Separate from the outcome because one outcome has several causes and a caller
 * that needs to branch — an export, a retry policy, the reconciliation pass that
 * threads the compiler's own gap list through — should not be matching on prose.
 * Closed, so a new cause is a type error at every switch rather than a silent
 * `default`.
 */
export const RECONCILE_REASON_CODES = [
  /** Nothing to explain: it came through. */
  'survived',
  /** Survived, and a verified fact on the card differs from the provisional one. */
  'details_changed',
  /** Deduplication resolved two records to one, and that one is in the plan. */
  'duplicate_resolved',
  /** Deduplication resolved two records to one, and that one did not survive. */
  'duplicate_survivor_lost',
  /** An operating calendar or an official notice closes it on these dates. */
  'closed_on_trip_dates',
  /** A safety notice blocks visiting it. The place is open; going is not advised. */
  'safety_advisory_blocks',
  /** The router returned no measurable leg to it. */
  'no_route_measured',
  /** It is a feature of another place already on the board. */
  'contained_by_another_place',
  /** Too little published about it to plan around. */
  'insufficient_published_support',
  /** The only ways in are modes this traveller ruled out. */
  'access_mode_conflict',
  /** The stored source record failed validation on re-read. */
  'source_record_invalid',
  /** The identifier no longer resolves to a single place. */
  'identity_unresolvable',
  /** The lookup budget was spent before this one was reached. */
  'budget_exhausted',
  /** A provider we needed did not answer. */
  'provider_unavailable',
  /** Sources answered and disagreed, and nothing broke the tie. */
  'sources_conflict',
  /**
   * The selection names a card this board version does not hold.
   *
   * The routine cause is a superseded board — the choice was made on version 2
   * and reconciliation ran against version 3. It is reported rather than skipped
   * because the traveller is asking what became of a *decision*, and "we no
   * longer have a record of it" is a truthful answer where silence is not.
   */
  'not_present_on_this_board',
  /** On neither board and never removed by anything we can name. */
  'unexplained',
] as const;
export const reconcileReasonCodeSchema = z.enum(RECONCILE_REASON_CODES);
export type ReconcileReasonCode = z.infer<typeof reconcileReasonCodeSchema>;

/**
 * One sentence per outcome, in the product's register.
 *
 * Written here rather than at each call site so the board, the reconciliation
 * panel and any export say the same thing — and so an outcome added without copy
 * is a type error.
 */
export const RECONCILE_OUTCOME_COPY: Record<ReconcileOutcome, string> = {
  retained: 'Still on the board.',
  retained_with_changes: 'Still on the board, and something about it changed.',
  replaced_duplicate: 'The same place turned up twice. We kept one of them.',
  removed_duplicate_survivor_lost:
    'This turned out to be the same place as another record we had, and that record did not make it through either.',
  removed_closed: 'An official source says it is shut on your dates.',
  removed_safety_blocked:
    'A safety notice tells people not to go there at the moment. It is not shut — we are not willing to put it in a plan while that stands.',
  removed_unreachable: 'We could not work out how long it takes to get there, so no day could hold it.',
  removed_redundant: 'It sits inside somewhere else already on your board.',
  removed_insufficient_support: 'Nobody publishes enough about it for us to plan around it.',
  removed_access_conflict: 'There is no way to reach it with the transport you told us about.',
  removed_stale_record: 'The map record for it no longer holds up.',
  removed_identity_invalid:
    'The record we had for it no longer points at one identifiable place, so we cannot be sure what we would be sending you to.',
  unresolved_budget: 'We ran out of lookups before we got to this one. That is our limit, not a verdict on the place.',
  unresolved_infrastructure: 'A source we needed did not answer. Nothing here is a claim about the place.',
  unresolved_verification_failed:
    'We read what is published about it and could not get the sources to agree, so we are not going to state anything about it either way.',
  disappeared_unexpectedly:
    'We have lost track of this one. You chose it, and we cannot show you where it went — that is our failure rather than anything about the place.',
};

/** The label for a traveller-visible list of causes. Same discipline as above. */
export const RECONCILE_REASON_COPY: Record<ReconcileReasonCode, string> = {
  survived: 'Came through as it was',
  details_changed: 'Details changed once we checked',
  duplicate_resolved: 'The same place under two names',
  duplicate_survivor_lost: 'The same place under two names, and neither made it',
  closed_on_trip_dates: 'Shut on your dates',
  safety_advisory_blocks: 'A safety notice advises against going',
  no_route_measured: 'No measurable way there',
  contained_by_another_place: 'Part of somewhere else on your board',
  insufficient_published_support: 'Too little published about it',
  access_mode_conflict: 'Not reachable the way you are travelling',
  source_record_invalid: 'The source record no longer holds up',
  identity_unresolvable: 'We can no longer tell which place this is',
  budget_exhausted: 'We ran out of lookups',
  provider_unavailable: 'A source did not answer',
  sources_conflict: 'The sources disagreed',
  not_present_on_this_board: 'Not on the board we checked against',
  unexplained: 'We cannot say',
};

/**
 * WHICH PART OF THE PIPELINE A SENTENCE CAME FROM.
 *
 * The compiler records a gap per subject per stage and the reconciliation used
 * to attach *any* of them to *any* removal, then render it **instead of** the
 * outcome sentence. Two failures in one line: a traveller whose lake was
 * unreachable could be told "we could not establish what it costs", and the
 * sentence that said what actually happened was gone.
 *
 * So a detail now travels with the stage that produced it, and it is attached
 * only when that stage is the one that caused the removal. An unstamped
 * sentence, or one from a stage that did not cause this, is not shown — a
 * specific claim attributed to the wrong cause is worse than a generic one.
 */
export const REMOVAL_STAGES = [
  /** Operating calendars, closures, seasonal access. */
  'availability',
  /** Safety notices and advisories. */
  'safety',
  /** The route matrix. */
  'routing',
  /** How you would get in, against how this traveller travels. */
  'access',
  /** Whether the identifier still resolves to one place. */
  'identity',
  /** What is published about it, and whether the sources agree. */
  'evidence',
  /** Containment and duplicate resolution. */
  'deduplication',
  /** Our lookup budget. */
  'budget',
  /** A provider that did not answer. */
  'infrastructure',
] as const;
export const removalStageSchema = z.enum(REMOVAL_STAGES);
export type RemovalStage = z.infer<typeof removalStageSchema>;

/**
 * The stage that causes each outcome. Exhaustive, so a new outcome without a
 * cause does not compile.
 *
 * `null` for the outcomes no stage produces: a retention has no cause, and
 * `disappeared_unexpectedly` is the absence of one.
 */
export const STAGE_FOR_OUTCOME: Record<ReconcileOutcome, RemovalStage | null> = {
  retained: null,
  retained_with_changes: 'evidence',
  replaced_duplicate: 'deduplication',
  removed_duplicate_survivor_lost: 'deduplication',
  removed_closed: 'availability',
  removed_safety_blocked: 'safety',
  removed_unreachable: 'routing',
  removed_redundant: 'deduplication',
  removed_insufficient_support: 'evidence',
  removed_access_conflict: 'access',
  removed_stale_record: 'evidence',
  removed_identity_invalid: 'identity',
  unresolved_budget: 'budget',
  unresolved_infrastructure: 'infrastructure',
  unresolved_verification_failed: 'evidence',
  disappeared_unexpectedly: null,
};

/**
 * Whether a sentence from `stage` is entitled to explain `outcome`.
 *
 * An unstamped sentence is not: we cannot tell whether it describes what
 * happened or something else we happened to notice about the same place.
 */
export function detailExplains(
  outcome: ReconcileOutcome,
  stage: RemovalStage | undefined,
): boolean {
  return stage !== undefined && STAGE_FOR_OUTCOME[outcome] === stage;
}

/**
 * What a card is called when nothing we hold can name it.
 *
 * Never the identity itself. `place/osm/way/128374` rendered where a name goes
 * is not a fallback, it is a leak — it tells the traveller nothing, and it looks
 * like a bug in a panel whose entire job is to be trusted.
 */
export const UNNAMED_ENTRY_COPY = 'A place we no longer have a name for';

/**
 * Why an alternative is being shown, on the alternative itself.
 *
 * A suggestion with no stated basis reads as a decision. Naming the basis is
 * what keeps "the closest thing of the same kind in the same area" from being
 * mistaken for "we swapped it for you".
 */
export const ALTERNATIVE_BASES = [
  /** Same geometric cluster, same planning role, highest preliminary fit. */
  'same_area_same_role',
  /** The surviving half of a duplicate pair. The only exact stand-in there is. */
  'duplicate_survivor',
] as const;
export const alternativeBasisSchema = z.enum(ALTERNATIVE_BASES);
export type AlternativeBasis = z.infer<typeof alternativeBasisSchema>;

export const reconcileAlternativeSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  basis: alternativeBasisSchema,
});
export type ReconcileAlternative = z.infer<typeof reconcileAlternativeSchema>;

/**
 * How many alternatives one entry may offer.
 *
 * Three, because a list long enough to scroll stops being an offer and becomes a
 * second board — and the traveller already has one of those directly below.
 */
export const MAX_ALTERNATIVES = 3;

export const reconciledSelectionSchema = z.object({
  /** The identity as the provisional board carried it. */
  placeId: z.string().min(1),
  /** The name as the provisional board showed it, so the row is recognisable. */
  name: z.string().min(1),
  /**
   * Which board this choice was made **on** — not the one it was checked
   * against.
   *
   * On the entry rather than only on the reconciliation, because selections are
   * keyed on the trip and survive a rebuild: one reconciliation holds choices
   * made across several board versions, and reading them all as the board being
   * reconciled against is how a removal gets blamed on a board the traveller
   * never saw. It was stamped from the wrong side for two slices.
   *
   * Optional, and absent means *we do not know* rather than version 1. A mark
   * recorded before board identity was carried genuinely has no board attached,
   * and filling in 1 would assert it was made on the first board — inventing
   * exactly the field that exists to stop things being invented.
   */
  provisionalBoardId: z.string().min(1).optional(),
  provisionalBoardVersion: z.number().int().positive().optional(),
  /** What they had said about it. Preserved through the transition. */
  intent: provisionalIntentSchema,
  outcome: reconcileOutcomeSchema,
  /** The cause, in a closed vocabulary. Never prose. */
  reasonCode: reconcileReasonCodeSchema,
  /**
   * The sentence a traveller reads. Required, and **always the outcome copy**.
   *
   * It used to be `detail ?? outcomeCopy`, so a compiler sentence *replaced* the
   * statement of what happened rather than accompanying it. That is how a
   * removal came to be reported as "we could not establish what it costs" with
   * nothing anywhere saying the place had been dropped. What happened is not
   * optional; the extra sentence is.
   */
  explanation: z.string().min(1),
  /**
   * The specific sentence a stage produced, where the stage that produced it is
   * the stage that caused this outcome.
   *
   * Beside `explanation`, never instead of it, and never attached on the
   * strength of subject alone: a gap recorded by the evidence stage does not
   * explain a routing removal, and attributing it to one is a more convincing
   * lie than saying nothing.
   */
  detail: z.string().min(1).optional(),
  /** Which stage the detail came from, so the attribution is checkable. */
  detailStage: removalStageSchema.optional(),
  /**
   * The identity that actually reached the plan, where one did.
   *
   * Equal to `placeId` for a straight retention, the survivor for a duplicate,
   * and absent for every loss. Without it, "kept as something else" is a claim
   * with nothing behind it.
   */
  finalPlaceId: z.string().min(1).optional(),
  /** For `replaced_duplicate`: the place that survived. */
  replacedByPlaceId: z.string().min(1).optional(),
  replacedByName: z.string().min(1).optional(),
  /**
   * Deterministic stand-ins, for a *pinned* loss only.
   *
   * Offered, never applied. Same cluster and same role, highest preliminary fit
   * among the survivors, ordered and tie-broken on id so the list does not move
   * between two renders. Choosing on somebody's behalf while they are not
   * looking is how a plan comes to hold a place they never agreed to.
   */
  alternatives: z.array(reconcileAlternativeSchema).max(MAX_ALTERNATIVES).default([]),
  /**
   * Whether this row has to be acknowledged before the panel can be dismissed.
   *
   * True for a pinned loss and for nothing else. A pinned removal that scrolled
   * past unread is, from the traveller's side, indistinguishable from a silent
   * one — so the product refuses to consider it delivered until somebody says
   * they saw it.
   */
  acknowledgementRequired: z.boolean().default(false),
  /** The best alternative, kept for readers written against version 1. */
  suggestedPlaceId: z.string().min(1).optional(),
  suggestedName: z.string().min(1).optional(),
});
export type ReconciledSelection = z.infer<typeof reconciledSelectionSchema>;

/**
 * WHAT THE RUN THAT PRODUCED THIS ACCOUNT FOUND.
 *
 * Stored with the account, and the reason is B-1: a mark made *after* the
 * artifact was committed still has to be reconciled, and by then the compile
 * result — which is where removals travel, deliberately, because a removal is a
 * fact about a run and not about a region — is long gone. Without a persisted
 * ledger the late mark can only ever resolve to the honest default, and a
 * traveller who pins a closed museum a minute after the build would be told
 * "nobody publishes enough about it" instead of "it is shut on your dates".
 *
 * It is not part of the artifact and never becomes one. It is a record of what
 * one run concluded, kept beside the account that run wrote.
 */
export const recordedRemovalSchema = z.object({
  placeId: z.string().min(1),
  outcome: reconcileOutcomeSchema,
  detail: z.string().min(1).optional(),
  detailStage: removalStageSchema.optional(),
});
export type RecordedRemoval = z.infer<typeof recordedRemovalSchema>;

export const reconciliationBasisSchema = z.object({
  removals: z.array(recordedRemovalSchema).default([]),
  /** The record that lost, and the one that won. */
  duplicates: z
    .array(z.object({ placeId: z.string().min(1), survivorPlaceId: z.string().min(1) }))
    .default([]),
  /** Survived, and a verified fact on the card differs from the provisional one. */
  changedPlaceIds: z.array(z.string().min(1)).default([]),
});
export type ReconciliationBasis = z.infer<typeof reconciliationBasisSchema>;

export const EMPTY_BASIS: ReconciliationBasis = {
  removals: [],
  duplicates: [],
  changedPlaceIds: [],
};

/**
 * Version 2. A stored version-1 payload no longer parses, on purpose.
 *
 * The same policy the provisional board already follows: a stored account that
 * will not parse is treated as absent, because it is a convenience rather than
 * something a plan depends on. Coercing a version-1 row forward would mean
 * inventing a board version and an explanation it never had — filling in exactly
 * the fields that exist to stop things being invented.
 *
 * It stays at 2 across the versioned-intent change because every difference is
 * either additive with a default (`basis`, `reconciliationVersion`,
 * `provisionalBoardId` on an entry) or a relaxation (an entry's
 * `provisionalBoardVersion` became optional). Every stored version-2 payload
 * therefore still parses, which is the point: the alternative was to bump and
 * have every existing account degrade to absent, losing the explanations this
 * module exists to keep.
 */
export const RECONCILIATION_VERSION = 2 as const;

export const boardReconciliationSchema = z.object({
  schemaVersion: z.literal(RECONCILIATION_VERSION),
  tripId: z.string().min(1),
  /** Which provisional board this account was reconciled against. */
  provisionalBoardId: z.string().min(1),
  /** That board's version, so a superseded one can be named rather than implied. */
  provisionalBoardVersion: z.number().int().positive(),
  /** Which compiled artifact they were reconciled against. */
  compiledRegionId: z.string().min(1),
  /**
   * Monotonic per trip. The compare-and-set token.
   *
   * A worker holding version 2 cannot overwrite an account already at 3, which
   * is the whole of the stale-writer defence and needs no lock to hold. A
   * superseding artifact bumps it and moves the prior account into history
   * rather than over it.
   */
  reconciliationVersion: z.number().int().positive().default(1),
  entries: z.array(reconciledSelectionSchema).default([]),
  /** Cards on the final board that were not on the provisional one. */
  addedPlaceIds: z.array(z.string().min(1)).default([]),
  /** What the run concluded, so a later mark can be reconciled against it too. */
  basis: reconciliationBasisSchema.default(EMPTY_BASIS),
  reconciledAt: z.string().min(1),
});
export type BoardReconciliation = z.infer<typeof boardReconciliationSchema>;

/**
 * WHO SAW WHAT.
 *
 * Stored apart from the reconciliation, in its own column, because it is a fact
 * about the person rather than about the artifact. Folding it into the payload
 * would mean rewriting an account of what the compiler found every time somebody
 * clicks a button — and an audit record you rewrite on interaction is not one.
 */
export const boardAcknowledgementSchema = z.object({
  placeId: z.string().min(1),
  /** The outcome that was on screen when they acknowledged it. */
  outcome: reconcileOutcomeSchema,
  acknowledgedAt: z.string().min(1),
});
export type BoardAcknowledgement = z.infer<typeof boardAcknowledgementSchema>;

export const boardAcknowledgementsSchema = z.object({
  tripId: z.string().min(1),
  /** Which account was acknowledged. An older one does not count for a newer one. */
  compiledRegionId: z.string().min(1),
  entries: z.array(boardAcknowledgementSchema).default([]),
});
export type BoardAcknowledgements = z.infer<typeof boardAcknowledgementsSchema>;

/** Whether anything happened that the traveller should be shown. */
export function hasChanges(reconciliation: BoardReconciliation): boolean {
  return reconciliation.entries.some((entry) => entry.outcome !== 'retained');
}

/** Removals of things they had pinned. The ones that need the loudest explanation. */
export function pinnedRemovals(reconciliation: BoardReconciliation): ReconciledSelection[] {
  return reconciliation.entries.filter(
    (entry) => entry.intent === 'pinned' && isLoss(entry.outcome),
  );
}

/**
 * The rows that still need somebody to say they saw them.
 *
 * An acknowledgement is matched on the compiled region as well as the place: a
 * traveller who acknowledged a removal from last week's compilation has not
 * acknowledged the same removal from this one, and treating those as the same
 * event would let a rebuild suppress its own bad news.
 */
export function unacknowledged(
  reconciliation: BoardReconciliation,
  acknowledgements: BoardAcknowledgements | null,
): ReconciledSelection[] {
  const seen =
    acknowledgements && acknowledgements.compiledRegionId === reconciliation.compiledRegionId
      ? new Set(acknowledgements.entries.map((entry) => entry.placeId))
      : new Set<string>();
  return reconciliation.entries.filter(
    (entry) => entry.acknowledgementRequired && !seen.has(entry.placeId),
  );
}
