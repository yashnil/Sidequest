import { stableHash } from '../evidence/identity';
import {
  MAX_MODEL_PROPOSALS,
  MAX_UNRESOLVED_CHARS_PER_CALL,
  MAX_UNRESOLVED_SPANS_PER_CALL,
  MODEL_INTERPRETATION_SCHEMA_VERSION,
  MODEL_STRENGTH_CEILING,
  PREFERENCE_TAXONOMY_VERSION,
  chipTargetForKey,
  modelInterpretationResponseSchema,
  preferenceValenceOf,
  type ChipTarget,
  type InterpretationClarificationReason,
  type InterpretationConfidence,
  type InterpretationSet,
  type InterpretedChip,
  type ModelFallbackOutcome,
  type ModelPreferenceProposal,
  type PreferenceStrength,
  type SuggestedQuestion,
} from '../schemas/interpretation';
import { chipIdFor, strengthOf } from './classify';
import { LEXICON_LOCALE, SAFETY_ADJACENT } from './phrases';

/**
 * THE BOUNDED FALLBACK, AND EVERYTHING THAT DECIDES WHETHER TO TRUST IT.
 *
 * No model client lives in this file, and none ever will: `@sidequest/core` is
 * framework-free, and the fence around the call belongs next to the SDK. What
 * lives here is the half that has to be checkable — the spans that may be sent,
 * the key the answer is cached under, the validation that turns a response into
 * chips, and the confidence those chips carry.
 *
 * The execution order is not negotiable and is enforced by the shapes rather
 * than by discipline:
 *
 * ```
 * deterministic parse  →  unresolved spans only  →  at most ONE structured call
 *   →  strict validation  →  proposed chips  →  traveller confirmation
 *   →  controlled preferences applied
 * ```
 *
 * `spansForModel` takes an `InterpretationSet`, which only exists once the
 * parser has run, and reads only its `unresolved` array — so "send the whole
 * sentence" is not a mistake somebody can make here, because the whole sentence
 * is not in scope. `mergeModelProposals` writes chips at `status: 'proposed'`
 * and never sets `confirmedAt`, so nothing it produces reaches the board,
 * the ranker, the research funnel or the planner until somebody presses the
 * button — `activeChips` returns an empty list for an unconfirmed set, which is
 * the same gate the deterministic pass has always been behind.
 *
 * Three rules the code below spends most of its length on:
 *
 * **The parser wins.** A proposal that lands on ground a phrase-table chip
 * already claimed is downgraded rather than trusted, because the table is free,
 * reproducible and reviewable and the model is none of those.
 *
 * **Confidence is derived, never reported.** `deriveConfidence` is a pure
 * function of five observable signals. The model has no field to assert
 * confidence in; if it did, it would fill it in fluently whether or not it had
 * a basis, and the number would look exactly like a measurement.
 *
 * **Sensitive text stays a question.** Checked here a second time, after the
 * schema has already made a sensitive *key* impossible, because defence against
 * "somebody adds a mobility value to the interest enum one day" costs four
 * lines and the failure it prevents is somebody stranded at a trailhead.
 */

// ---------------------------------------------------------------------------
// What may be sent
// ---------------------------------------------------------------------------

/** One numbered span, exactly as the traveller typed it. */
export interface UnresolvedSpan {
  /** Position in the list handed to the model. The model returns this back. */
  index: number;
  field: 'mustDo' | 'avoid';
  /** `[start, end)` into the traveller's own stored string for that field. */
  span: [number, number];
  /** The traveller's own characters. Never paraphrased, never expanded. */
  text: string;
}

export interface SpansForModelResult {
  spans: UnresolvedSpan[];
  /** Set when there is a reason not to call at all. */
  refusal: Extract<ModelFallbackOutcome, 'nothing_unresolved' | 'oversized_input'> | null;
}

/**
 * The exact spans the parser could not resolve, numbered, and nothing else.
 *
 * Note what this function has no parameter for: the destination, the dates, the
 * rest of the composer, the traveller's profile, the trip. It cannot leak them
 * because it never receives them — which is a stronger guarantee than a prompt
 * that promises not to mention them.
 *
 * Oversized input refuses the call outright rather than truncating it. A
 * truncated call would silently drop half of somebody's sentence and then show
 * a confident-looking result for the half that survived, which is worse than
 * saying "there was too much of this to read in one go".
 */
export function spansForModel(set: InterpretationSet | undefined): SpansForModelResult {
  const unresolved = set?.unresolved ?? [];
  const spans: UnresolvedSpan[] = [];

  for (const entry of unresolved) {
    const text = entry.quote.trim();
    if (text.length === 0) continue;
    // Belt and braces: a span that already raised a question is never re-asked.
    if (isSafetyAdjacent(text)) continue;
    spans.push({
      index: spans.length,
      field: entry.field ?? 'mustDo',
      span: [entry.span[0], entry.span[1]],
      text,
    });
  }

  if (spans.length === 0) return { spans: [], refusal: 'nothing_unresolved' };
  if (spans.length > MAX_UNRESOLVED_SPANS_PER_CALL) return { spans: [], refusal: 'oversized_input' };

  const characters = spans.reduce((total, entry) => total + entry.text.length, 0);
  if (characters > MAX_UNRESOLVED_CHARS_PER_CALL) return { spans: [], refusal: 'oversized_input' };

  return { spans, refusal: null };
}

/** Lower-cased, control-stripped, whitespace-collapsed. Never shown to anybody. */
function isSafetyAdjacent(text: string): boolean {
  const folded = foldForMatching(text);
  return SAFETY_ADJACENT.some(([phrase]) => folded.includes(phrase));
}

function foldForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// The cache key
// ---------------------------------------------------------------------------

/**
 * Everything that could change the answer, and nothing that could not.
 *
 * The five versions are here because a reading produced under a different
 * taxonomy, a different prompt, a different response schema, a different model
 * or a different locale is a reading produced under different rules — serving
 * it from cache would be presenting an old contract's output as the current
 * one's. The locale is in the key rather than assumed, for the same reason
 * `lexiconLocale` is on every result.
 */
export interface InterpretationCacheKeyInput {
  /** The unresolved spans, in the order they were offered. */
  spans: readonly string[];
  taxonomyVersion: string;
  promptVersion: string;
  schemaVersion: number;
  modelId: string;
  locale: string;
}

/**
 * NFKC, controls stripped, case-folded, whitespace collapsed.
 *
 * Compatibility normalisation only. It deliberately does **not** fold visually
 * confusable characters across scripts: a Cyrillic "о" is a different character
 * from a Latin "o", and treating them as the same would mean one traveller's
 * text could be served the cached reading of a different traveller's text that
 * merely looked like it. Bidirectional and zero-width controls *are* stripped,
 * because those are invisible by definition — two strings that render
 * identically and differ only by an invisible override are the same sentence,
 * and letting them key differently would just be two cache misses.
 */
export function normalizeSpanForKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A key for one traveller's sentence, on one trip.
 *
 * **This value must never appear in a shared cache.** It is a reading of one
 * person's words; a destination profile, a shared destination ranking, a shared
 * evidence claim and a geographic cache are all statements about the world.
 * Letting this key into any of them would mean one traveller's phrasing steering
 * another traveller's ranking, which is the worst bug this product could have
 * and the one nothing about the code's shape would make obvious. The
 * `interpretation_cache` table therefore carries a `trip_id` and cascades from
 * `trips` — the exact inverse of the evidence tables — and
 * `fallback.architecture.test.ts` asserts both halves.
 */
export function interpretationCacheKey(input: InterpretationCacheKeyInput): string {
  const canonical = [
    `v:${input.schemaVersion}`,
    `taxonomy:${input.taxonomyVersion}`,
    `prompt:${input.promptVersion}`,
    `model:${input.modelId}`,
    `locale:${input.locale}`,
    `spans:${input.spans.map(normalizeSpanForKey).join('\u0000')}`,
  ].join('|');
  return `interp:${stableHash(canonical)}`;
}

/** The key for a set, with the versions this build actually uses. */
export function cacheKeyForSpans(input: {
  spans: readonly UnresolvedSpan[];
  taxonomyVersion: string;
  promptVersion: string;
  modelId: string;
  locale?: string;
}): string {
  return interpretationCacheKey({
    /*
     * The field travels with the text, because it changes what a reading means.
     *
     * The same sentence in the must-do box and in the avoid box is two different
     * questions, and a key over the text alone served the answer to one of them
     * for the other. `decide()` catches the affirm-out-of-the-avoid-box
     * direction; nothing caught the reverse.
     */
    spans: input.spans.map((entry) => `${entry.field}\u0001${entry.text}`),
    /*
     * Both taxonomies, not one.
     *
     * The caller passes the *lexicon* version, which versions the phrase table.
     * The preference taxonomy — how many strengths exist and what each is worth
     * — can move without the table gaining a word, and a reading produced under
     * four strengths means something different under seven. Serving the old one
     * back would present a previous contract's output as this one's, which is
     * the exact thing the other versions are in the key to prevent.
     */
    taxonomyVersion: `${input.taxonomyVersion}+${PREFERENCE_TAXONOMY_VERSION}`,
    promptVersion: input.promptVersion,
    schemaVersion: MODEL_INTERPRETATION_SCHEMA_VERSION,
    modelId: input.modelId,
    locale: input.locale ?? LEXICON_LOCALE,
  });
}

// ---------------------------------------------------------------------------
// Confidence, derived
// ---------------------------------------------------------------------------

export interface ConfidenceSignals {
  /** The response parsed against the strict schema. */
  schemaValid: boolean;
  /** `spanIndex` resolved to a span we actually offered. */
  spanAligned: boolean;
  /** More than one distinct key was proposed for the same span. */
  ambiguous: boolean;
  /** The same key was proposed with both polarities somewhere in the answer. */
  contradicted: boolean;
  /** The span overlaps ground a deterministic chip already claimed. */
  overlapsParser: boolean;
  /** The model itself said this needs asking rather than applying. */
  flaggedForClarification: boolean;
}

/**
 * Five observable signals in, one level out, and nothing else consulted.
 *
 * Order matters: the two hard failures come first, because a response that did
 * not parse or that points at a span we never sent is not a weak reading, it is
 * not a reading at all. Everything after that is a reason to be less sure rather
 * than a reason to discard.
 */
export function deriveConfidence(signals: ConfidenceSignals): InterpretationConfidence {
  if (!signals.schemaValid || !signals.spanAligned) return 'low';
  if (signals.contradicted || signals.ambiguous || signals.flaggedForClarification) return 'low';
  if (signals.overlapsParser) return 'medium';
  return 'high';
}

/** Only these become chips. `low` stays unresolved, with a reason on screen. */
export function isApplicableConfidence(confidence: InterpretationConfidence): boolean {
  return confidence !== 'low';
}

/**
 * WHAT A MODEL READING IS ALLOWED TO BE WORTH.
 *
 * A model chip can never be a requirement or a refusal. `must_have` produces a
 * board that will not drop the thing and `hard_avoid` produces the sentence
 * "which you asked us to skip" — and a traveller who never wrote the marker
 * never asked us anything of the kind. `strengthOf` already refuses to invent a
 * marker; this refuses to trust one even when the marker is there, because the
 * span reached a model precisely because we could not read it.
 *
 * Written against the valence table rather than against a list of member names,
 * for a reason the seven-member taxonomy made concrete: the old version was two
 * `if`s naming `must_have` and `hard_avoid`, and adding `strong_preference` and
 * `strong_dislike` would have let both straight through. The rule is "no model
 * reading may exceed the per-direction ceiling", and it is now expressed as
 * exactly that — so a level added tomorrow is clamped by construction.
 *
 * It is also total over garbage: a strength this build does not recognise has no
 * valence, and something with no valence is clamped to the *weakest* affirming
 * rung rather than trusted or dropped silently.
 */
export function clampModelStrength(strength: PreferenceStrength): PreferenceStrength {
  const valence = preferenceValenceOf(strength);
  if (!valence) return 'low_preference';
  const ceiling = MODEL_STRENGTH_CEILING[valence.polarity];
  const ceilingValence = preferenceValenceOf(ceiling);
  if (!ceilingValence) return 'low_preference';
  if (valence.exclusionary) return ceiling;
  return valence.magnitude > ceilingValence.magnitude ? ceiling : strength;
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export interface MergeModelProposalsInput {
  set: InterpretationSet;
  /** The spans that were offered, in the order they were offered. */
  spans: readonly UnresolvedSpan[];
  /** Whatever came back. Unparsed on purpose — validation is this file's job. */
  response: unknown;
  attemptedAt: string;
  promptVersion: string;
  modelId: string;
  /**
   * Zero when the answer came out of the trip's own cache.
   *
   * The distinction is not bookkeeping: `calls` is what `canOfferModelPass`
   * reads to decide whether the trip has spent its one reading, so charging a
   * cache hit against it would mean a refresh silently consumed the budget for
   * a sentence nobody re-read.
   */
  calls?: 0 | 1;
}

export interface MergeModelProposalsResult {
  /** The set to store. Chips are `proposed`; `confirmedAt` is never touched. */
  set: InterpretationSet;
  outcome: ModelFallbackOutcome;
  /** The chips that were added, for a report rather than for an assertion. */
  accepted: InterpretedChip[];
  /** Spans that stayed unresolved, and our sentence for why. */
  declined: { spanIndex: number; reason: InterpretationClarificationReason }[];
}

export function mergeModelProposals(input: MergeModelProposalsInput): MergeModelProposalsResult {
  const { set, spans } = input;
  const calls = input.calls ?? 1;
  const parsed = modelInterpretationResponseSchema.safeParse(input.response);

  if (!parsed.success) {
    /*
     * An unusable answer is a non-event, not a partial success.
     *
     * Nothing is salvaged from a response that failed the schema — not the
     * proposals that happened to validate individually, not a "best effort"
     * subset. A schema this narrow fails for one of two reasons: the provider
     * returned something malformed, or something tried to widen the shape. In
     * both cases the correct number of chips to keep is zero, and the
     * traveller's own text is untouched either way.
     */
    return {
      set: recordModelPass({
        set,
        outcome: 'invalid_response',
        attemptedAt: input.attemptedAt,
        promptVersion: input.promptVersion,
        modelId: input.modelId,
        spansOffered: spans.length,
        calls,
      }),
      outcome: 'invalid_response',
      accepted: [],
      declined: [],
    };
  }

  const proposals = parsed.data.proposals.slice(0, MAX_MODEL_PROPOSALS);
  if (proposals.length === 0) {
    return {
      set: recordModelPass({
        set,
        outcome: 'no_proposals',
        attemptedAt: input.attemptedAt,
        promptVersion: input.promptVersion,
        modelId: input.modelId,
        spansOffered: spans.length,
        calls,
      }),
      outcome: 'no_proposals',
      accepted: [],
      declined: [],
    };
  }

  const byIndex = new Map(spans.map((entry) => [entry.index, entry]));
  const keysPerSpan = new Map<number, Set<string>>();
  const polaritiesPerKey = new Map<string, Set<string>>();
  for (const proposal of proposals) {
    if (!byIndex.has(proposal.spanIndex)) continue;
    const keys = keysPerSpan.get(proposal.spanIndex) ?? new Set<string>();
    keys.add(proposal.key);
    keysPerSpan.set(proposal.spanIndex, keys);
    const polarities = polaritiesPerKey.get(proposal.key) ?? new Set<string>();
    polarities.add(proposal.polarity);
    polaritiesPerKey.set(proposal.key, polarities);
  }

  const chips = [...set.chips];
  const accepted: InterpretedChip[] = [];
  const declined: MergeModelProposalsResult['declined'] = [];
  const questions = new Map<string, SuggestedQuestion>(
    set.suggestedQuestions.map((question) => [question.topic, question]),
  );
  const reasonBySpan = new Map<number, InterpretationClarificationReason>();

  for (const proposal of proposals) {
    const span = byIndex.get(proposal.spanIndex);
    if (!span) {
      // A span index we never sent. Nothing to attach it to, so nothing happens.
      declined.push({ spanIndex: proposal.spanIndex, reason: 'not_a_preference' });
      continue;
    }

    const decision = decide({ proposal, span, chips: set.chips, keysPerSpan, polaritiesPerKey });
    if (decision.kind === 'declined') {
      declined.push({ spanIndex: span.index, reason: decision.reason });
      if (!reasonBySpan.has(span.index)) reasonBySpan.set(span.index, decision.reason);
      continue;
    }

    const id = chipIdFor(span.field, decision.target, span.span[0]);
    if (chips.some((chip) => chip.id === id)) {
      /*
       * A chip with this identity already exists — including one the traveller
       * rejected on an earlier pass. Re-proposing it would resurrect a decision
       * they already made, which is the one thing stable chip ids exist to stop.
       */
      declined.push({ spanIndex: span.index, reason: 'not_a_preference' });
      continue;
    }

    const chip: InterpretedChip = {
      id,
      field: span.field,
      span: span.span,
      quote: span.text.slice(0, 200),
      strength: decision.strength,
      target: decision.target,
      source: 'model',
      status: 'proposed',
      confidence: decision.confidence,
    };
    chips.push(chip);
    accepted.push(chip);
  }

  /*
   * A span that produced a chip leaves the unresolved list; a span that did not
   * stays, and gains our sentence for why. Nothing is deleted: the traveller's
   * words survive whatever happened, which is the failure requirement and also
   * the success one.
   */
  const resolvedSpanStarts = new Set(accepted.map((chip) => `${chip.field}:${chip.span[0]}`));
  const unresolved = set.unresolved
    .map((entry) => {
      const field = entry.field ?? 'mustDo';
      const offered = spans.find(
        (candidate) => candidate.field === field && candidate.span[0] === entry.span[0],
      );
      const reason = offered ? reasonBySpan.get(offered.index) : undefined;
      /*
       * A locale finding outranks whatever the reader said about the span.
       *
       * "We only read one language and this is not it" is a fact about our
       * reader, established before the call by looking at the characters. "We
       * have no setting that means this" is a claim about the taxonomy. When
       * both are available the first is the true one, and overwriting it with
       * the second is how the wrong cause got named in the first place.
       */
      if (entry.clarificationReason === 'outside_the_locale_we_read') return entry;
      return reason ? { ...entry, clarificationReason: reason } : entry;
    })
    .filter((entry) => !resolvedSpanStarts.has(`${entry.field ?? 'mustDo'}:${entry.span[0]}`));

  const outcome: ModelFallbackOutcome = accepted.length > 0 ? 'proposed' : 'no_proposals';

  return {
    set: recordModelPass({
      set: {
        ...set,
        chips: chips.slice(0, 24),
        unresolved: unresolved.slice(0, 24),
        suggestedQuestions: [...questions.values()].slice(0, 4),
      },
      outcome,
      attemptedAt: input.attemptedAt,
      promptVersion: input.promptVersion,
      modelId: input.modelId,
      spansOffered: spans.length,
      proposalsReceived: proposals.length,
      chipsAccepted: accepted.length,
      calls,
    }),
    outcome,
    accepted,
    declined,
  };
}

type Decision =
  | { kind: 'declined'; reason: InterpretationClarificationReason }
  | {
      kind: 'accepted';
      target: ChipTarget;
      strength: PreferenceStrength;
      confidence: InterpretationConfidence;
    };

function decide(input: {
  proposal: ModelPreferenceProposal;
  span: UnresolvedSpan;
  chips: readonly InterpretedChip[];
  keysPerSpan: Map<number, Set<string>>;
  polaritiesPerKey: Map<string, Set<string>>;
}): Decision {
  const { proposal, span } = input;

  /*
   * The safety asymmetry, checked on the traveller's own characters.
   *
   * The key set already makes a mobility, dietary or group constraint
   * unrepresentable, so this can only fire when a *permitted* key was proposed
   * for a span that also mentions a knee or an allergy. That is exactly the case
   * worth catching: a confident-looking food preference sitting next to "nut
   * allergy" reads as though we understood the allergy.
   */
  if (isSafetyAdjacent(span.text)) {
    return { kind: 'declined', reason: 'for_the_traveller_to_state_themselves' };
  }

  if (proposal.needsClarification) {
    return {
      kind: 'declined',
      reason: proposal.clarificationReason ?? 'ambiguous_between_preferences',
    };
  }

  const target = chipTargetForKey(proposal.key);
  if (!target) return { kind: 'declined', reason: 'outside_the_controlled_vocabulary' };

  const polarity = proposal.polarity === 'refuses' ? 'negative' : 'positive';

  /*
   * The same rule `resolveTarget` enforces on the deterministic path: an
   * avoidance is already a negative statement, so a *positive* mention of one
   * has no representation in the vocabulary and resolves to nothing rather than
   * to a made-up inverse. "We love a crowd" is not "avoid crowds" reversed.
   */
  if (target.kind === 'avoidance' && polarity !== 'negative') {
    return { kind: 'declined', reason: 'outside_the_controlled_vocabulary' };
  }

  /*
   * The avoid box is negative by definition. A span typed under "anything you
   * would rather not do" cannot produce an affirmation, whatever the model read
   * — that would be the single most likely way this path could return the
   * opposite of what somebody meant.
   */
  if (span.field === 'avoid' && polarity !== 'negative') {
    return { kind: 'declined', reason: 'contradicts_another_part_of_the_text' };
  }

  const ambiguous = (input.keysPerSpan.get(span.index)?.size ?? 0) > 1;
  const contradicted = (input.polaritiesPerKey.get(proposal.key)?.size ?? 0) > 1;
  const overlapsParser = input.chips.some(
    (chip) =>
      chip.source === 'deterministic' &&
      chip.field === span.field &&
      chip.span[0] < span.span[1] &&
      chip.span[1] > span.span[0],
  );

  const confidence = deriveConfidence({
    schemaValid: true,
    spanAligned: true,
    ambiguous,
    contradicted,
    overlapsParser,
    flaggedForClarification: false,
  });

  if (!isApplicableConfidence(confidence)) {
    return {
      kind: 'declined',
      reason: contradicted ? 'contradicts_another_part_of_the_text' : 'ambiguous_between_preferences',
    };
  }

  /*
   * The strength comes from the traveller's own characters, then through the
   * ceiling. The `no ` prefix the avoid box used to be given here is gone for
   * the same reason it is gone from `classifyPreferences`: it synthesised a
   * refusal marker nobody typed, and then read it back as though they had. The
   * box supplies the direction, which is `polarity`, and nothing else.
   */
  const strength = clampModelStrength(strengthOf(span.text, polarity));

  return { kind: 'accepted', target, strength, confidence };
}

// ---------------------------------------------------------------------------
// Recording what happened, including when nothing did
// ---------------------------------------------------------------------------

export interface RecordModelPassInput {
  set: InterpretationSet;
  outcome: ModelFallbackOutcome;
  attemptedAt: string;
  promptVersion: string;
  modelId: string;
  spansOffered: number;
  proposalsReceived?: number;
  chipsAccepted?: number;
  /** Zero for every path that decided not to call. Capped at one by the schema. */
  calls: number;
}

/**
 * The record of the attempt, on the set, whatever the attempt did.
 *
 * Chips and unresolved text are untouched here by construction — a failure must
 * never be able to lose somebody's words on its way out. Every outage, refusal,
 * bad response and exhausted budget goes through this one function, which is
 * why "the failure paths do not mutate the traveller's text" is a property of
 * one function rather than a promise about six call sites.
 */
export function recordModelPass(input: RecordModelPassInput): InterpretationSet {
  return {
    ...input.set,
    modelPass: {
      outcome: input.outcome,
      attemptedAt: input.attemptedAt,
      calls: Math.max(0, Math.min(1, input.calls)),
      promptVersion: input.promptVersion,
      modelId: input.modelId,
      schemaVersion: MODEL_INTERPRETATION_SCHEMA_VERSION,
      spansOffered: input.spansOffered,
      proposalsReceived: input.proposalsReceived ?? 0,
      chipsAccepted: input.chipsAccepted ?? 0,
    },
  };
}

/**
 * Whether there is a reading to offer. Drives the button, and only the button.
 *
 * Deliberately stricter than the server-side guard: this is false the moment
 * *any* pass has been recorded, spent or not, so a traveller is offered one
 * reading rather than a button that repeats an answer they already have. The
 * action's own check is the narrower `calls > 0`, because that is the thing
 * that actually costs money — two guards at two widths, and the cheap one is
 * the one a screen can get wrong.
 */
export function canOfferModelPass(set: InterpretationSet | undefined): boolean {
  if (!set || set.confirmedAt || set.modelPass) return false;
  return spansForModel(set).refusal === null;
}

