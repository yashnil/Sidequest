import { z } from 'zod';
import {
  AVOIDANCES,
  BUDGET_STYLES,
  CROWD_TOLERANCES,
  DAY_STARTS,
  DISCOVERY_MIXES,
  INTERESTS,
  PACES,
  avoidanceSchema,
  budgetStyleSchema,
  crowdToleranceSchema,
  dayStartSchema,
  discoveryMixSchema,
  interestSchema,
  paceSchema,
  type Avoidance,
  type BudgetStyle,
  type CrowdTolerance,
  type DayStart,
  type DiscoveryMix,
  type Interest,
  type Pace,
} from './common';

/**
 * WHAT WE UNDERSTOOD SOMEBODY TO MEAN, KEPT APART FROM WHAT THEY SAID.
 *
 * The composer has captured "anything you would regret missing" and "anything
 * you would rather not do" since Phase 11, and until now precisely nothing read
 * either one. That was deliberate — the brief requires confirmation before a
 * derived preference is applied, and capturing the text without acting on it was
 * the honest half to ship first.
 *
 * This is the other half, and it is built around four rules:
 *
 * 1. **The verbatim text is the record.** A chip is derived, quotes the
 *    traveller's own characters back, and never replaces what they wrote. An
 *    interpretation somebody did not accept must not become the account of what
 *    they said.
 * 2. **Nothing applies without confirmation.** `confirmedAt` absent means zero
 *    effect on anything, anywhere.
 * 3. **A chip cannot name a place.** There is no field in this schema a
 *    destination, a URL, a coordinate or a fact could be written into. That is
 *    structural rather than a convention: the composer runs before any geocoder,
 *    so a name invented here would have nothing downstream to check it.
 * 4. **A casual preference is never a safety constraint.** See
 *    `chipTargetSchema` — mobility, dietary needs and traveller needs are
 *    absent from the target union by construction, so no amount of confident
 *    phrasing can produce one. Text that sounds like one raises a *question*
 *    instead, which is the only safe thing to do with "my knee is bad".
 */

/**
 * WHICH WAY THE TRAVELLER IS POINTING.
 *
 * Two values, and deliberately only two: polarity answers "asking for it, or
 * refusing it?" and answers nothing else. How *firmly* is `PreferenceStrength`,
 * and the two are kept apart because a signed scale collapses them — which is
 * how a small refusal ("not massively into long walks") and a total one ("no
 * long walks") both arrived as merely "negative" and were then treated alike.
 *
 * It is also the only half a model may set. A model that could set strength
 * could turn a mild dislike into a hard blocker, and the sentence the board
 * then prints — "this is entirely museums, which you asked us to skip" — would
 * be words nobody wrote.
 */
export const PREFERENCE_POLARITIES = ['affirms', 'refuses'] as const;
export const preferencePolaritySchema = z.enum(PREFERENCE_POLARITIES);
export type PreferencePolarity = z.infer<typeof preferencePolaritySchema>;

/**
 * THE CONTROLLED PREFERENCE TAXONOMY.
 *
 * Seven members, and the reason there are seven rather than two is that the
 * damage lives in the gaps. "We came here for the hot springs", "we'd love a hot
 * spring", "hot springs sound nice", "a hot spring if it's on the way", "we're
 * not big hot-spring people", "we hate hot springs" and "no hot springs" are
 * seven different sentences, and collapsing any adjacent pair means the board
 * either deletes something somebody wanted or keeps something they refused.
 *
 * **Polarity and magnitude are separate concepts.** A strength is not a number
 * on a line from "no" to "yes"; it is a *direction* (is the traveller asking for
 * this or refusing it?) and a *size* (how firmly?). Reading them as one signed
 * scale is what let "not massively into long walks" — direction: refuses, size:
 * small — arrive at the same place as "no long walks", because both were merely
 * "negative". `PREFERENCE_VALENCE` below keeps them apart, and every consumer
 * reads the pair rather than the enum member's position in a list.
 *
 * **Exclusion is a third, independent property.** Magnitude does not buy it. A
 * `strong_dislike` is the largest refusal the taxonomy has that is still only a
 * ranking signal; `hard_avoid` is the only member that may remove something, and
 * even then only through `canApplyAsExclusion`, which additionally requires that
 * a person said so themselves and then confirmed it.
 *
 * The four original members keep their names and their meanings, so every chip
 * already stored at `schemaVersion: 1` still parses and still means what it
 * meant. The three new ones sit between them.
 */
export const PREFERENCE_STRENGTHS = [
  'must_have',
  'strong_preference',
  'preference',
  'low_preference',
  'dislike',
  'strong_dislike',
  'hard_avoid',
] as const;
export const preferenceStrengthSchema = z.enum(PREFERENCE_STRENGTHS);
export type PreferenceStrength = z.infer<typeof preferenceStrengthSchema>;

export const PREFERENCE_STRENGTH_LABELS: Record<PreferenceStrength, string> = {
  must_have: 'Must happen',
  strong_preference: 'Really want',
  preference: 'Would like',
  low_preference: 'If it fits',
  dislike: 'Rather not',
  strong_dislike: 'Really rather not',
  hard_avoid: 'Leave it out',
};

/**
 * Bumping this re-derives every reading and invalidates every cached one.
 *
 * Separate from `LEXICON_VERSION`, which versions the *phrases*: the taxonomy
 * can gain a level without the table gaining a word, and a reading produced
 * under a taxonomy with four levels means something different under one with
 * seven.
 */
export const PREFERENCE_TAXONOMY_VERSION = 'preferences/2026-08-03.2';

/**
 * THE NORMALISED MAGNITUDE RANGE, STATED ONCE.
 *
 * `0` means "no force at all" and `1` means "the most this taxonomy can express".
 * It is a closed interval of finite numbers: nothing outside it is a magnitude,
 * and `normalizePreferenceMagnitude` is the only way a number becomes one.
 *
 * Chosen as 0–1 rather than 0–100 or -1–1 because every other normalised scale
 * in the engine already is: `FitFactor.score`, `hiddenGemScore`, `popularityScore`
 * and `hiddenGemTarget` are all 0–1, and a second convention would be a silent
 * factor-of-a-hundred waiting to happen at a boundary. **Negative numbers are
 * deliberately not part of the range**: a refusal is not a negative wish, it is
 * a wish pointing the other way, and that direction is `polarity`.
 */
export const PREFERENCE_MAGNITUDE_MIN = 0;
export const PREFERENCE_MAGNITUDE_MAX = 1;

/**
 * A magnitude, or nothing.
 *
 * Total over `unknown`. `NaN`, `Infinity`, `-Infinity`, a string, `null` and
 * `undefined` all return `null` — **not** zero, because zero is a magnitude and
 * "we do not know" is not. Finite numbers outside the range are clamped into it
 * rather than rejected, because an out-of-range finite number is a scaling
 * mistake with an obvious intent, whereas a non-finite one is not a number.
 */
export function normalizePreferenceMagnitude(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < PREFERENCE_MAGNITUDE_MIN) return PREFERENCE_MAGNITUDE_MIN;
  if (value > PREFERENCE_MAGNITUDE_MAX) return PREFERENCE_MAGNITUDE_MAX;
  return value;
}

/**
 * What one strength is worth, decomposed.
 *
 * `polarity` — which way the traveller is pointing.
 * `magnitude` — how firmly, on the documented 0–1 range.
 * `exclusionary` — whether this may remove a candidate outright, as opposed to
 *   ranking it lower. Exactly one member has it, and having it is still not
 *   sufficient on its own; see `canApplyAsExclusion`.
 */
export interface PreferenceValence {
  polarity: PreferencePolarity;
  magnitude: number;
  exclusionary: boolean;
}

/**
 * The one table. Every consumer reads this rather than pattern-matching names.
 *
 * The two ladders are deliberately not mirror images. The affirming side runs
 * 0.25 / 0.5 / 0.75 / 1.0 because wanting more of something is safe — the worst
 * case is a day that leans the wrong way. The refusing side stops at 0.6 before
 * the jump to 1.0, because the gap between "really rather not" and "leave it
 * out" is the gap between a lower rank and a deleted category, and a ladder with
 * an even step there invites somebody to treat 0.8 as nearly-exclusion.
 */
export const PREFERENCE_VALENCE: Record<PreferenceStrength, PreferenceValence> = {
  must_have: { polarity: 'affirms', magnitude: 1, exclusionary: false },
  strong_preference: { polarity: 'affirms', magnitude: 0.75, exclusionary: false },
  preference: { polarity: 'affirms', magnitude: 0.5, exclusionary: false },
  low_preference: { polarity: 'affirms', magnitude: 0.25, exclusionary: false },
  dislike: { polarity: 'refuses', magnitude: 0.25, exclusionary: false },
  strong_dislike: { polarity: 'refuses', magnitude: 0.6, exclusionary: false },
  hard_avoid: { polarity: 'refuses', magnitude: 1, exclusionary: true },
};

/**
 * The valence of a strength, or nothing at all.
 *
 * Total over `unknown` on purpose, and the `null` is the point: **unknown and
 * unresolved are not `low_preference`.** A span nobody could read, a stored chip
 * whose strength this build does not recognise and a strength somebody
 * fabricated all return `null`, and a caller that treats `null` as "the weakest
 * wish" is inventing a preference out of an absence. `applyInterpretation`
 * ignores a chip with no valence rather than defaulting it.
 */
export function preferenceValenceOf(strength: unknown): PreferenceValence | null {
  if (typeof strength !== 'string') return null;
  const valence = (PREFERENCE_VALENCE as Record<string, PreferenceValence | undefined>)[strength];
  if (!valence) return null;
  const magnitude = normalizePreferenceMagnitude(valence.magnitude);
  if (magnitude === null) return null;
  return { polarity: valence.polarity, magnitude, exclusionary: valence.exclusionary };
}

/**
 * THE CEILING ON WHAT A READING MAY BE WORTH, PER DIRECTION.
 *
 * Stated as a pair rather than as a single "half strength", because the two
 * directions have different worst cases. An over-read wish costs a mediocre
 * suggestion; an over-read refusal deletes something. So a model reading may
 * reach an ordinary `preference` when it affirms and only an ordinary `dislike`
 * when it refuses — one step up the affirming ladder, two steps down the
 * refusing one.
 *
 * `clampModelStrength` in `intent/fallback.ts` is the single enforcement point,
 * and `intent/apply.ts` re-checks the resulting valence against these before it
 * writes anything, because a clamp that is bypassed is a clamp that is inert —
 * which is precisely how an avoidance chip came to skip it.
 */
export const MODEL_STRENGTH_CEILING: Record<PreferencePolarity, PreferenceStrength> = {
  affirms: 'preference',
  refuses: 'dislike',
};

/** The largest magnitude a model-sourced chip may carry, in either direction. */
export const MODEL_MAX_MAGNITUDE = Math.max(
  PREFERENCE_VALENCE[MODEL_STRENGTH_CEILING.affirms].magnitude,
  PREFERENCE_VALENCE[MODEL_STRENGTH_CEILING.refuses].magnitude,
);

export const INTERPRETATION_SOURCES = ['deterministic', 'model'] as const;
export const interpretationSourceSchema = z.enum(INTERPRETATION_SOURCES);
export type InterpretationSource = z.infer<typeof interpretationSourceSchema>;

export const CHIP_STATUSES = ['proposed', 'confirmed', 'rejected'] as const;
export const chipStatusSchema = z.enum(CHIP_STATUSES);
export type ChipStatus = z.infer<typeof chipStatusSchema>;

/**
 * How sure *we* are — never how sure the model said it was.
 *
 * The same rule the research fence already enforces on `assessConfidence`: a
 * model reports observable things and a pure function turns those into a level.
 * A model asked "how confident are you?" answers the question it was asked
 * rather than the one we care about, and it answers it fluently whether or not
 * it has any basis, so the field simply does not exist in
 * `modelPreferenceProposalSchema`. `deriveConfidence` in `intent/fallback.ts` is
 * the only thing that can write this, out of schema validity, span alignment,
 * ambiguity, contradiction and parser overlap.
 */
export const INTERPRETATION_CONFIDENCES = ['high', 'medium', 'low'] as const;
export const interpretationConfidenceSchema = z.enum(INTERPRETATION_CONFIDENCES);
export type InterpretationConfidence = z.infer<typeof interpretationConfidenceSchema>;

/**
 * Where a chip may land, and nowhere else.
 *
 * A closed union over vocabularies that already exist. Deliberately absent:
 * `travelerNeeds`, `mobilityLimited`, `dietaryNeeds`, `dietaryStrict`,
 * `accessibilityNotes`. A wrong casual preference costs one mediocre
 * suggestion; a wrong safety constraint either strands somebody or gives them
 * false assurance, and neither is recoverable from a chip in a row.
 */
export const chipTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interest'), value: interestSchema }),
  z.object({ kind: z.literal('avoidance'), value: avoidanceSchema }),
  z.object({ kind: z.literal('pace'), value: paceSchema }),
  z.object({ kind: z.literal('day_start'), value: dayStartSchema }),
  z.object({ kind: z.literal('budget'), value: budgetStyleSchema }),
  z.object({ kind: z.literal('crowd'), value: crowdToleranceSchema }),
  z.object({ kind: z.literal('discovery_mix'), value: discoveryMixSchema }),
]);
export type ChipTarget = z.infer<typeof chipTargetSchema>;

export const interpretedChipSchema = z.object({
  /**
   * Stable across re-runs of the same text and the same lexicon.
   *
   * Derived from the field, the target and the span, so a chip somebody rejected
   * stays rejected when the parser runs again — and so a rejection is not
   * resurrected by an unrelated edit elsewhere in the box.
   */
  id: z.string().min(1),
  field: z.enum(['mustDo', 'avoid']),
  /** `[start, end)` into the traveller's own stored string. */
  span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  /** Sliced from that string. Never authored, never paraphrased. */
  quote: z.string().min(1).max(200),
  strength: preferenceStrengthSchema,
  target: chipTargetSchema,
  source: interpretationSourceSchema,
  status: chipStatusSchema,
  /**
   * Present on `source: 'model'` chips, absent on deterministic ones.
   *
   * Optional rather than required because a phrase-table match has no
   * uncertainty to report — the table either contains the phrase or it does not
   * — and because making it required would change the shape of every chip
   * already stored on a composer at `schemaVersion: 1`, which parses leniently
   * and would silently drop the lot.
   */
  confidence: interpretationConfidenceSchema.optional(),
});
export type InterpretedChip = z.infer<typeof interpretedChipSchema>;

/**
 * THE ONE GATE A HARD EXCLUSION HAS TO PASS.
 *
 * A hard avoidance deletes a category and then explains the deletion in the
 * traveller's name. Three things must all be true before that is allowed, and
 * they are independent:
 *
 * 1. **The strength is the one exclusionary member.** Magnitude alone never buys
 *    it: `strong_dislike` carries 0.6 and still cannot remove anything.
 * 2. **A person wrote the marker.** `source: 'deterministic'` means the phrase
 *    table found an explicit refusal — "no", "never", "skip", "without" — in the
 *    traveller's own characters. A model reading reached a model precisely
 *    because we could not read the sentence, so it has no standing to assert
 *    that somebody refused something. This is the check the avoidance branch
 *    used to skip entirely, which made `clampModelStrength` inert.
 * 3. **They then confirmed it.** `status: 'confirmed'`, on a set with a
 *    `confirmedAt`. Pressing the button is the explicit traveller action; the
 *    parse on its own is a proposal.
 *
 * Everything else is a ranking signal. There is no fourth route to exclusion
 * from this layer — the other one, the questionnaire's own avoidance
 * checkboxes, is a different explicit action on a different screen.
 */
export function canApplyAsExclusion(chip: {
  strength: PreferenceStrength;
  source: InterpretationSource;
  status: ChipStatus;
}): boolean {
  const valence = preferenceValenceOf(chip.strength);
  if (!valence || !valence.exclusionary) return false;
  if (chip.source !== 'deterministic') return false;
  return chip.status === 'confirmed';
}

/**
 * ONE CHIP AS THE NUMBER EVERY RANKER SHOULD READ.
 *
 * The reason this type exists rather than each consumer reading `chip.strength`:
 * a consumer that pattern-matches enum names re-implements the taxonomy, and the
 * two copies drift the first time a member is added. A `PreferenceSignal` is the
 * taxonomy already applied — direction, size on the documented range, and
 * whether it is permitted to remove rather than merely to rank.
 *
 * `applyInterpretation` returns one of these per confirmed chip, **including the
 * ones that changed no answer**, because a preference the answer vocabulary
 * cannot express is still something the traveller said. Nothing may read a
 * signal it did not get from here, and nothing may promote one: `exclusionary`
 * is the only licence to remove, and it is already false unless the chip passed
 * `canApplyAsExclusion`.
 */
export interface PreferenceSignal {
  target: ChipTarget;
  key: ControlledPreferenceKey;
  polarity: PreferencePolarity;
  /** 0–1, inclusive, finite. See `PREFERENCE_MAGNITUDE_MIN`/`MAX`. */
  magnitude: number;
  /** True only for a chip that passed `canApplyAsExclusion`. */
  exclusionary: boolean;
  source: InterpretationSource;
  /** The traveller's own characters, for a sentence that quotes rather than asserts. */
  quote: string;
}

/**
 * The same thing, validated, so it can be stored on a traveller's answers.
 *
 * Needed because the five-member `InterestLevel` ladder and the boolean
 * `avoidances` list cannot between them express "really rather not, but do not
 * delete it" — nine of the twelve avoidance keys have no graded channel at all.
 * `applyInterpretation` writes what those two *can* carry and puts the rest here,
 * so the resolution the taxonomy went to the trouble of preserving survives the
 * trip to the ranker instead of being flattened on the way.
 *
 * `magnitude` is bounded by the schema as well as by `normalizePreferenceMagnitude`,
 * because a stored row is a second way in: a hand-edited or corrupted value that
 * skipped the normaliser must fail to parse rather than reach a score.
 *
 * `exclusionary` is a permission that has **already been checked** by
 * `canApplyAsExclusion`. Nothing downstream may promote a signal; a reader that
 * treats a magnitude of 1 as a licence to remove has re-implemented the gate.
 */
export const preferenceSignalSchema = z.object({
  target: chipTargetSchema,
  key: z.string().min(1),
  polarity: preferencePolaritySchema,
  magnitude: z.number().min(PREFERENCE_MAGNITUDE_MIN).max(PREFERENCE_MAGNITUDE_MAX),
  exclusionary: z.boolean(),
  source: interpretationSourceSchema,
  quote: z.string(),
});

/**
 * Text that sounds like a constraint we are not allowed to derive.
 *
 * The escape hatch for "my knee is bad", "gluten free please", "my mother uses a
 * stick". None of these may become a chip; all of them deserve to be noticed.
 * So they become a *question* with no apply action — the same asymmetry the
 * clarification layer already enforces, where a model-suggested question may
 * never be a required one.
 */
export const SUGGESTED_QUESTION_TOPICS = ['mobility', 'dietary', 'group_needs'] as const;
export const suggestedQuestionTopicSchema = z.enum(SUGGESTED_QUESTION_TOPICS);
export type SuggestedQuestionTopic = z.infer<typeof suggestedQuestionTopicSchema>;

export const SUGGESTED_QUESTION_COPY: Record<SuggestedQuestionTopic, string> = {
  mobility:
    'You mentioned something about how far or how hard anybody can walk. We will not read that out of a sentence — tell us properly and it will cap what we offer.',
  dietary:
    'You mentioned food you cannot eat. We will not infer an allergy from a sentence; set it in your profile and the food layer will treat it as a real constraint.',
  group_needs:
    'You mentioned somebody in the group with particular needs. Tell us who is coming and we will plan the days around it.',
};

export const suggestedQuestionSchema = z.object({
  topic: suggestedQuestionTopicSchema,
  quote: z.string().min(1).max(200),
});
export type SuggestedQuestion = z.infer<typeof suggestedQuestionSchema>;

// ---------------------------------------------------------------------------
// THE BOUNDED MODEL FALLBACK
// ---------------------------------------------------------------------------

/**
 * WHAT A MODEL IS ALLOWED TO SAY ABOUT SOMEBODY'S SENTENCE.
 *
 * The deterministic parser resolves ordinary traveller phrasing. What it cannot
 * resolve — an idiom the table does not hold, a way of saying "no early starts"
 * nobody wrote down — is currently shown as unresolved, which is honest and is
 * also the end of the road. This is the other half: **the unresolved spans, and
 * nothing else, go to one bounded structured call.**
 *
 * The fence is structural rather than instructional, because a prompt is a
 * request and a schema is a wall. Four rules, and each is a property of the type
 * rather than a sentence in a system prompt:
 *
 * 1. **There is no string field at any depth.** Every field below is a number
 *    bounded by the input, a boolean, or a member of a closed enum. A
 *    destination, a place, a URL, a coordinate, a factual claim, a provider
 *    instruction and a piece of prose have nowhere to be written. This is the
 *    same argument `chipTargetSchema` makes about safety constraints, applied to
 *    a channel where the text on the other side is adversarial by default:
 *    traveller free text is the one place in this product where somebody can
 *    address a model directly.
 * 2. **A span is an index, never a quotation.** `spanIndex` points into the
 *    numbered list *we* supplied. The model cannot return characters, so it
 *    cannot return characters we did not send — which is what stops "quote the
 *    span" from becoming a free-text field wearing a span's clothes. The quote
 *    on the resulting chip is sliced from the traveller's stored string by us.
 * 3. **A preference is one member of a closed key set.** `CONTROLLED_PREFERENCE_KEYS`
 *    is derived from the vocabularies that already exist, so the model chooses
 *    among the same values the phrase table can produce and no others. It is
 *    flat rather than a discriminated union because a union with a `value`
 *    string is exactly the hole this schema exists to not have.
 * 4. **Sensitive readings are impossible, not discouraged.** Mobility, dietary,
 *    medical, allergy, immigration, financial and safety vocabularies are absent
 *    from the key set by construction — `chipTargetSchema` never admitted them
 *    and this is derived from it. Text that sounds like one can only come back
 *    as `needsClarification`, which becomes a *question* through the existing
 *    `SUGGESTED_QUESTION_TOPICS` mechanism and never an applied constraint.
 */

/** The vocabularies a chip may land in, as one flat key space. */
export type ControlledPreferenceKey =
  | `interest:${Interest}`
  | `avoidance:${Avoidance}`
  | `pace:${Pace}`
  | `day_start:${DayStart}`
  | `budget:${BudgetStyle}`
  | `crowd:${CrowdTolerance}`
  | `discovery_mix:${DiscoveryMix}`;

/**
 * Derived from the enums rather than written out.
 *
 * A hand-maintained list would drift the first time somebody adds an interest,
 * and the drift would be silent: the model would be offered a vocabulary the
 * scorer no longer matches. Deriving it means the taxonomy the model sees and
 * the taxonomy the board reads are the same object.
 */
export const CONTROLLED_PREFERENCE_KEYS: readonly ControlledPreferenceKey[] = [
  ...INTERESTS.map((value) => `interest:${value}` as const),
  ...AVOIDANCES.map((value) => `avoidance:${value}` as const),
  ...PACES.map((value) => `pace:${value}` as const),
  ...DAY_STARTS.map((value) => `day_start:${value}` as const),
  ...BUDGET_STYLES.map((value) => `budget:${value}` as const),
  ...CROWD_TOLERANCES.map((value) => `crowd:${value}` as const),
  ...DISCOVERY_MIXES.map((value) => `discovery_mix:${value}` as const),
];

export const controlledPreferenceKeySchema = z.enum(
  CONTROLLED_PREFERENCE_KEYS as [ControlledPreferenceKey, ...ControlledPreferenceKey[]],
);

/** Total: an unknown key is impossible through the schema, and null if forced. */
export function chipTargetForKey(key: string): ChipTarget | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  const candidate = { kind, value } as unknown;
  const parsed = chipTargetSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function keyForChipTarget(target: ChipTarget): ControlledPreferenceKey {
  return `${target.kind}:${target.value}` as ControlledPreferenceKey;
}

/**
 * Why something should stay a question instead of becoming a chip.
 *
 * A closed enum rather than a free-text reason, for the same reason everything
 * else here is: a reason field is a prose field, and a prose field is where a
 * fabricated fact, an injected instruction or a place name arrives. The screen
 * renders our copy keyed on the enum member, so what a traveller reads is
 * always something we wrote.
 */
export const INTERPRETATION_CLARIFICATION_REASONS = [
  'ambiguous_between_preferences',
  'reads_like_a_place_or_a_thing',
  'contradicts_another_part_of_the_text',
  'outside_the_controlled_vocabulary',
  /**
   * We only read one language, and this was not it.
   *
   * A distinct reason because `outside_the_controlled_vocabulary` names the
   * wrong cause: it says "we have no setting that means this", which tells a
   * French speaker their preference does not exist rather than that our reader
   * does not speak French. The first sentence is false and discouraging; the
   * second is true and is a limit we can state.
   */
  'outside_the_locale_we_read',
  'for_the_traveller_to_state_themselves',
  'not_a_preference',
] as const;
export const interpretationClarificationReasonSchema = z.enum(INTERPRETATION_CLARIFICATION_REASONS);
export type InterpretationClarificationReason = z.infer<typeof interpretationClarificationReasonSchema>;

export const INTERPRETATION_CLARIFICATION_COPY: Record<InterpretationClarificationReason, string> = {
  ambiguous_between_preferences: 'This could mean more than one thing, so we left it alone.',
  reads_like_a_place_or_a_thing: 'This reads like somewhere or something specific. We noted it and did not look it up.',
  contradicts_another_part_of_the_text: 'This pulls against something else you wrote, so we did not pick a side.',
  outside_the_controlled_vocabulary: 'We have no setting that means this, so there was nothing to change.',
  outside_the_locale_we_read:
    'Our reader only works in one language, and this is not written in it. That is our limit, not yours — it is saved exactly as you wrote it.',
  for_the_traveller_to_state_themselves: 'This is the kind of thing we will not read out of a sentence. Set it properly and it will count.',
  not_a_preference: 'This did not read as a preference, so we left it as you wrote it.',
};

/** How many unresolved spans one call may carry. Beyond this we do not call. */
export const MAX_UNRESOLVED_SPANS_PER_CALL = 8;
/** Total characters across those spans. A composer box is capped at 600 each. */
export const MAX_UNRESOLVED_CHARS_PER_CALL = 900;
/** At most one proposal per span, plus room for a second reading of each. */
export const MAX_MODEL_PROPOSALS = 16;

/**
 * Bumping this invalidates every cached reading.
 *
 * 2 — the clarification reasons gained `outside_the_locale_we_read`, which is a
 * member of the response enum and therefore a change to the contract a stored
 * reading was produced under.
 */
export const MODEL_INTERPRETATION_SCHEMA_VERSION = 2 as const;

/**
 * One reading of one span. Five fields, none of them a string.
 *
 * `spanIndex` — which of the spans we numbered.
 * `key`       — one member of the controlled key set.
 * `polarity`  — asking for it, or refusing it.
 * `needsClarification` — true means "do not apply this, ask instead".
 * `clarificationReason` — which of our sentences to show when it does.
 */
export const modelPreferenceProposalSchema = z.object({
  spanIndex: z.number().int().min(0).max(MAX_UNRESOLVED_SPANS_PER_CALL - 1),
  key: controlledPreferenceKeySchema,
  polarity: preferencePolaritySchema,
  needsClarification: z.boolean(),
  clarificationReason: interpretationClarificationReasonSchema.optional(),
});
export type ModelPreferenceProposal = z.infer<typeof modelPreferenceProposalSchema>;

export const modelInterpretationResponseSchema = z.object({
  proposals: z.array(modelPreferenceProposalSchema).max(MAX_MODEL_PROPOSALS),
});
export type ModelInterpretationResponse = z.infer<typeof modelInterpretationResponseSchema>;

/**
 * What happened when we asked, recorded whether or not it worked.
 *
 * Every failure mode is a named outcome rather than an absence, because the
 * requirement on failure is that the traveller's own text survives verbatim and
 * the screen says something true. "We could not read the rest just then" and
 * "there was nothing left to read" are different sentences, and a nullable field
 * cannot tell them apart.
 */
export const MODEL_FALLBACK_OUTCOMES = [
  'not_attempted',
  'not_configured',
  'nothing_unresolved',
  'oversized_input',
  'budget_exhausted',
  'provider_unavailable',
  'invalid_response',
  'no_proposals',
  'proposed',
] as const;
export const modelFallbackOutcomeSchema = z.enum(MODEL_FALLBACK_OUTCOMES);
export type ModelFallbackOutcome = z.infer<typeof modelFallbackOutcomeSchema>;

export const MODEL_FALLBACK_OUTCOME_COPY: Record<ModelFallbackOutcome, string> = {
  not_attempted: 'We have not asked the reader about the rest of this yet.',
  not_configured: 'The reader is switched off in this build, so the rest stays exactly as you wrote it.',
  nothing_unresolved: 'There was nothing left over to read.',
  oversized_input: 'There was too much left over to read in one go. It is saved exactly as you wrote it.',
  budget_exhausted: 'This trip has used its one reading. Your words are saved exactly as you wrote them.',
  provider_unavailable: 'The reader did not answer. Nothing was lost — your words are saved exactly as you wrote them.',
  invalid_response: 'The reader answered with something we could not use, so we ignored it.',
  no_proposals: 'The reader could not make anything of the rest either.',
  proposed: 'Here is what the reader made of the rest. Nothing applies until you accept it.',
};

/**
 * The record of the one call, on the interpretation itself.
 *
 * `calls` is capped at one by the schema, which is the cheapest possible place
 * to state "at most one model call per interpretation" — a second call would
 * have nowhere to be recorded, and an unrecorded call is the kind that becomes
 * a loop.
 */
export const modelFallbackPassSchema = z.object({
  outcome: modelFallbackOutcomeSchema,
  attemptedAt: z.string().min(1),
  calls: z.number().int().min(0).max(1),
  /** Ours, never the model's. Versioned so a bad reading is traceable. */
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  spansOffered: z.number().int().min(0),
  proposalsReceived: z.number().int().min(0),
  chipsAccepted: z.number().int().min(0),
});
export type ModelFallbackPass = z.infer<typeof modelFallbackPassSchema>;

export const INTERPRETATION_VERSION = 1 as const;
/** Bumping this re-derives every chip. Stated as a version so a change is visible. */
export const LEXICON_VERSION = 'phrases-en/2026-08-03.1';

export const interpretationSetSchema = z.object({
  schemaVersion: z.literal(INTERPRETATION_VERSION),
  lexiconVersion: z.string().min(1),
  /**
   * Which language the lexicon covers.
   *
   * Named rather than assumed, because it is English-only and pretending
   * otherwise would make "a French sentence produced no chips" look like the
   * traveller having said nothing. It is a limit, and it is on the record.
   */
  lexiconLocale: z.string().min(2),
  chips: z.array(interpretedChipSchema).max(24).default([]),
  /**
   * Text that matched nothing, quoted back.
   *
   * Shown rather than dropped. "We could not make anything of this" is a real
   * answer and the only honest one; silently discarding it teaches somebody that
   * the box does something it does not.
   */
  unresolved: z
    .array(
      z.object({
        span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
        quote: z.string().min(1).max(200),
        /** True for capitalised runs. Flagged, never resolved. */
        looksLikeAName: z.boolean(),
        /** Which box it came from. Optional so stored rows keep parsing. */
        field: z.enum(['mustDo', 'avoid']).optional(),
        /**
         * Why the bounded reader left it alone, when it was asked and left it
         * alone. Absent means nobody has looked at it beyond the phrase table.
         */
        clarificationReason: interpretationClarificationReasonSchema.optional(),
      }),
    )
    .max(24)
    .default([]),
  suggestedQuestions: z.array(suggestedQuestionSchema).max(4).default([]),
  /** Absent means nothing here has been applied to anything. */
  confirmedAt: z.string().min(1).optional(),
  /** Absent means the bounded reader has never been asked about this text. */
  modelPass: modelFallbackPassSchema.optional(),
});
export type InterpretationSet = z.infer<typeof interpretationSetSchema>;

/** The chips that actually affect anything: confirmed, and not rejected. */
export function activeChips(set: InterpretationSet | undefined): InterpretedChip[] {
  if (!set?.confirmedAt) return [];
  return set.chips.filter((chip) => chip.status === 'confirmed');
}
