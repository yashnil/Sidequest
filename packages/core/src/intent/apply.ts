import {
  AVOIDANCE_LABELS,
  INTEREST_LABELS,
  type Avoidance,
  type BudgetStyle,
  type CrowdTolerance,
  type Interest,
  type InterestLevel,
} from '../schemas/common';
import type { QuestionnaireAnswers } from '../schemas/profile';
import type { TripComposerAnswers } from '../schemas/composer';
import {
  activeChips,
  canApplyAsExclusion,
  keyForChipTarget,
  preferenceValenceOf,
  type ChipTarget,
  type InterpretationSet,
  type PreferenceSignal,
  type PreferenceStrength,
} from '../schemas/interpretation';

/**
 * WHERE A CONFIRMED CHIP ACTUALLY LANDS, AND HOW HARD IT LANDS.
 *
 * On `QuestionnaireAnswers`, never on `TravelerProfile`. The answers are the
 * durable artifact and the profile is derived from them — `getProfile` rebuilds
 * it whenever the profile shape has moved — so a chip written into the profile
 * would be silently discarded the next time anybody changed a weight.
 *
 * Three rules, and the third is the one this file got wrong for a whole phase.
 *
 * **Nothing applies until it is confirmed.** `activeChips` returns an empty list
 * for a set with no `confirmedAt`, so an unconfirmed interpretation is
 * indistinguishable from no interpretation at all.
 *
 * **Polarity and magnitude are separate.** Every branch below reads
 * `preferenceValenceOf(chip.strength)` rather than the strength's name. A chip
 * whose strength this build does not recognise has no valence and is skipped —
 * it is not quietly treated as the weakest wish, because "we do not know" and
 * "they barely wanted it" are different facts.
 *
 * **Exclusion is a separate permission from magnitude, and every key goes
 * through it.** The interest branch checked `strength`; the avoidance branch did
 * not look at `strength` at all, so *any* avoidance chip — including a model's
 * reading of "not massively into long walks" — was pushed into
 * `answers.avoidances`, which is a hard blocker list and additionally lowers the
 * effort ceiling in `deriveProfileValues`. `clampModelStrength` existed to stop
 * exactly that and was inert for every `avoidance:*` key, because nothing on the
 * path from a clamped strength to an applied avoidance ever read the strength.
 *
 * Now there is one gate — `canApplyAsExclusion` — and both branches pass through
 * it. A refusal that does not clear it is a ranking signal: it lowers what the
 * board offers without deleting a category and then explaining the deletion in
 * the traveller's name.
 */

/**
 * What each strength is worth as an interest level.
 *
 * Seven strengths into five levels, and the collapse is deliberate rather than
 * accidental: `InterestLevel` is the frequency vocabulary the questionnaire and
 * the scorer already share, and inventing an eighth level here would mean the
 * chip layer and the checkbox layer disagreed about what "a few times" means.
 * The resolution the ladder loses is not lost from the *system* — it is on
 * `ApplyResult.signals` as a normalised magnitude, which is what a ranker should
 * read. See the note on `PreferenceSignal`.
 *
 * `hard_avoid` maps to `avoid`, which is a hard blocker, and it is the only
 * entry here that is reachable only with permission.
 */
const LEVEL_FOR: Record<PreferenceStrength, InterestLevel> = {
  must_have: 'core',
  strong_preference: 'frequent',
  preference: 'frequent',
  low_preference: 'occasional',
  dislike: 'low',
  strong_dislike: 'low',
  hard_avoid: 'avoid',
};

/** The level a refusal falls back to when it may not exclude. Never `avoid`. */
const SOFTENED_REFUSAL_LEVEL: InterestLevel = 'low';

/** Higher wins when two chips touch the same interest. Never lower. */
const LEVEL_RANK: Record<InterestLevel, number> = {
  avoid: 0,
  low: 1,
  occasional: 2,
  frequent: 3,
  core: 4,
};

export interface ApplyResult {
  answers: QuestionnaireAnswers;
  /** What changed, so the screen can show it rather than assert it. */
  applied: { label: string; detail: string }[];
  /**
   * Every confirmed chip as direction + normalised magnitude + permission.
   *
   * Produced for **all** of them, including the ones the answer vocabulary could
   * not express, because a preference nobody has a checkbox for is still
   * something the traveller said. This is the value a ranker, a candidate scorer
   * or a research prioritiser should read; reading `chip.strength` instead means
   * re-implementing the taxonomy, and two copies of a taxonomy drift.
   */
  signals: PreferenceSignal[];
  /**
   * Confirmed chips that changed no answer, and why.
   *
   * Kept apart from `applied` so a screen cannot claim an effect that did not
   * happen. A refusal that was softened, and a preference with no home in the
   * questionnaire vocabulary, both land here rather than being silently dropped.
   */
  noted: { label: string; detail: string }[];
}

/**
 * A SOFT REFUSAL'S ONLY HONEST HOME IN THE ANSWER VOCABULARY.
 *
 * An ordinary dislike must lower what the board offers without removing
 * anything. `answers.avoidances` cannot do that — every consumer reads it as a
 * hard constraint — so a soft refusal is expressed through a *graded* answer
 * instead, and only where a graded answer exists that is provably not a gate.
 *
 * Each entry below was checked against every consumer of the field it writes:
 *
 * - `crowdTolerance` and `avoidTouristTraps` reach `scorePlace` as a lookup
 *   table and a −0.15 adjustment. No blocker reads either.
 * - `budgetStyle` reaches `comfortableCostLevel`, which reaches `budgetFit` as a
 *   score. The `too_expensive` blocker reads `avoidances`, not this.
 * - `dayStart` reaches the planner's day-start window. Nothing gates on it.
 *
 * Three keys have such a home and nine do not, and that is a real finding rather
 * than an omission: effort, road surface, remoteness, altitude, cold water,
 * heat, cold, long drives and long hikes are expressible *only* as hard
 * constraints today. `detourToleranceMinutes` was considered for long drives and
 * rejected — `classifyOutcome` drops a candidate outright past 1.5× tolerance,
 * so writing it would have been an exclusion wearing a preference's clothes.
 * Those nine produce a `PreferenceSignal` and no answer change; see the
 * integration note in `ApplyResult.signals`.
 */
type SoftRefusal = (answers: QuestionnaireAnswers) => { answers: QuestionnaireAnswers; detail: string } | null;

const CROWD_STEP: Record<CrowdTolerance, CrowdTolerance> = {
  dont_mind: 'mild',
  mild: 'avoid_crowds',
  avoid_crowds: 'avoid_crowds',
};

const BUDGET_STEP: Record<BudgetStyle, BudgetStyle> = {
  luxury: 'premium',
  premium: 'midrange',
  midrange: 'budget',
  budget: 'budget',
};

const SOFT_REFUSAL: Record<Avoidance, SoftRefusal | null> = {
  crowds_and_tourist_traps: (answers) => {
    const stepped = CROWD_STEP[answers.crowdTolerance];
    if (stepped === answers.crowdTolerance && answers.avoidTouristTraps) return null;
    return {
      answers: { ...answers, crowdTolerance: stepped, avoidTouristTraps: true },
      detail: 'we will lean quieter, without ruling a busy place out',
    };
  },
  expensive_activities: (answers) => {
    const stepped = BUDGET_STEP[answers.budgetStyle];
    if (stepped === answers.budgetStyle) return null;
    return {
      answers: { ...answers, budgetStyle: stepped },
      detail: 'we will lean cheaper, without ruling a pricier stop out',
    };
  },
  early_mornings: (answers) => {
    if (answers.dayStart === 'relaxed') return null;
    return {
      answers: { ...answers, dayStart: 'relaxed' },
      detail: 'days will start later',
    };
  },
  long_hikes: null,
  strenuous_activity: null,
  long_drives: null,
  rough_or_gravel_roads: null,
  high_altitude_exertion: null,
  remote_areas_without_services: null,
  cold_water: null,
  extreme_heat: null,
  extreme_cold: null,
};

/**
 * Fold confirmed chips into questionnaire answers.
 *
 * Deliberately not a merge of everything a chip could touch: it writes
 * interests, avoidances, pace, day start, budget, crowd tolerance and discovery
 * mix, and it cannot write anything else, because `ChipTarget` has no other
 * members. Mobility, dietary needs and traveller needs are unreachable from here
 * by construction rather than by care.
 */
export function applyInterpretation(
  base: QuestionnaireAnswers,
  set: InterpretationSet | undefined,
): ApplyResult {
  const chips = activeChips(set);
  if (chips.length === 0) return { answers: base, applied: [], signals: [], noted: [] };

  const interests: Record<string, InterestLevel> = { ...base.interests };
  const avoidances = new Set<Avoidance>(base.avoidances);
  const applied: ApplyResult['applied'] = [];
  const noted: ApplyResult['noted'] = [];
  const signals: PreferenceSignal[] = [];
  let next: QuestionnaireAnswers = { ...base };

  for (const chip of chips) {
    const valence = preferenceValenceOf(chip.strength);
    /*
     * No valence, no effect. A strength this build cannot place is not the
     * weakest preference, it is an unknown — and defaulting an unknown to a
     * preference is inventing one.
     */
    if (!valence) continue;

    const mayExclude = canApplyAsExclusion(chip);
    signals.push({
      target: chip.target,
      key: keyForChipTarget(chip.target),
      polarity: valence.polarity,
      magnitude: valence.magnitude,
      /*
       * The permission, not the ambition. `hard_avoid` carries
       * `exclusionary: true` in the taxonomy and still arrives here as `false`
       * unless this particular chip cleared the gate, so a consumer reading a
       * signal can act on it without re-deriving the rule.
       */
      exclusionary: valence.exclusionary && mayExclude,
      source: chip.source,
      quote: chip.quote,
    });

    const label = chipLabel(chip.target);

    switch (chip.target.kind) {
      case 'interest': {
        const wanted = LEVEL_FOR[chip.strength];
        /*
         * A refusal that has not earned exclusion stops at `low`.
         *
         * `avoid` produces "this is entirely museums, which you asked us to
         * skip" and removes the category. `low` means "once, if it is right
         * there". Somebody who wrote "not really into museums" said the second
         * thing; a model that read it as the first has no standing to say so.
         */
        const level = wanted === 'avoid' && !mayExclude ? SOFTENED_REFUSAL_LEVEL : wanted;
        const current = interests[chip.target.value] ?? 'low';
        /*
         * An explicit refusal wins outright; otherwise the stronger wish wins.
         *
         * Without the first half, somebody who wrote "hiking" in one box and
         * "no long hikes" in the other would keep the higher level and lose the
         * refusal — which is the wrong way round, because a refusal is the
         * statement they were more deliberate about.
         */
        const resolved =
          level === 'avoid' || LEVEL_RANK[level] > LEVEL_RANK[current] ? level : current;
        if (resolved !== current) {
          interests[chip.target.value] = resolved;
          if (label) applied.push({ label, detail: `set to “${resolved}” from “${chip.quote}”` });
        } else if (label) {
          noted.push({ label, detail: `already at “${current}”, so nothing changed` });
        }
        break;
      }

      case 'avoidance': {
        /*
         * THE BRANCH THE CLAMP USED TO BYPASS.
         *
         * A hard blocker only for a refusal that a person wrote, in their own
         * characters, with an explicit marker, and then confirmed. Anything
         * softer takes the graded route below, and anything with no graded route
         * is recorded and applied to nothing.
         */
        if (mayExclude) {
          if (!avoidances.has(chip.target.value)) {
            avoidances.add(chip.target.value);
            if (label) applied.push({ label, detail: `left out entirely, from “${chip.quote}”` });
          } else if (label) {
            noted.push({ label, detail: 'you had already ruled this out' });
          }
          break;
        }

        if (avoidances.has(chip.target.value)) {
          // Already a hard constraint by some other route. A softer reading of
          // the same thing must never *loosen* it.
          if (label) noted.push({ label, detail: 'you had already ruled this out' });
          break;
        }

        const soften = SOFT_REFUSAL[chip.target.value];
        const effect = soften ? soften(next) : null;
        if (effect) {
          next = effect.answers;
          if (label) applied.push({ label, detail: `${effect.detail}, from “${chip.quote}”` });
        } else if (label) {
          noted.push({
            label,
            detail: `noted from “${chip.quote}”. We have no way to prefer against this without ruling it out, so we have not.`,
          });
        }
        break;
      }

      case 'pace':
        next = { ...next, pace: chip.target.value };
        applied.push({ label: 'Pace', detail: `${label}, from “${chip.quote}”` });
        break;
      case 'day_start':
        next = { ...next, dayStart: chip.target.value };
        applied.push({ label: 'Day start', detail: `${label}, from “${chip.quote}”` });
        break;
      case 'budget':
        next = { ...next, budgetStyle: chip.target.value };
        applied.push({ label: 'Budget', detail: `${label}, from “${chip.quote}”` });
        break;
      case 'crowd':
        next = { ...next, crowdTolerance: chip.target.value };
        applied.push({ label: 'Crowds', detail: `${label}, from “${chip.quote}”` });
        break;
      case 'discovery_mix':
        next = { ...next, discoveryMix: chip.target.value };
        applied.push({ label: 'Famous vs hidden', detail: `${label}, from “${chip.quote}”` });
        break;
    }
  }

  return {
    answers: {
      ...next,
      interests: interests as QuestionnaireAnswers['interests'],
      avoidances: [...avoidances].sort(),
      /*
       * The vector travels **on the answers**, not only in this return value.
       *
       * `applied` is a report and `signals` is a diagnostic; neither is stored.
       * Everything that ranks a place reads a `TravelerProfile`, which is built
       * from the answers — so a magnitude that stayed in the return value would
       * be a number nobody could act on, and the nine avoidance keys with no
       * graded channel would be silently discarded at exactly the point they
       * were finally expressible.
       *
       * Sorted by key so two runs of one input produce byte-identical answers.
       */
      preferenceSignals: [...signals].sort((a, b) => a.key.localeCompare(b.key)),
    },
    applied,
    signals,
    noted,
  };
}

/**
 * The interpretation stored on a composer, if any.
 *
 * A helper rather than a field access because the composer's `schemaVersion` is
 * a literal `1` and **must stay** one: `getIntent` parses the composer
 * leniently, so bumping the literal would turn every stored composer row into a
 * silent `null` and lose every answer anybody has ever given. The field is
 * optional at version 1 instead, which is the additive change that costs
 * nothing.
 */
export function interpretationOf(answers: TripComposerAnswers | null): InterpretationSet | undefined {
  return answers?.interpretation;
}

/**
 * WHAT A TARGET IS CALLED, FROM THE VOCABULARY THAT OWNS THE WORD.
 *
 * This used to be `value.replace(/_/g, ' ')` for interests, and for avoidances
 * it was not even that — the raw enum identifier was pushed straight into
 * `applied[].label`, so a screen rendering it printed `crowds_and_tourist_traps`
 * or, de-underscored, "crowds and tourist traps" — which reads as English by
 * luck rather than by design, and reads as `public transport` and `hidden gems
 * heavy` when the luck runs out. That is the exact mechanism `stageLabel` was
 * written to refuse.
 *
 * An unmapped value returns the empty string and the caller renders nothing,
 * which is the required behaviour: no line at all beats a line of pseudo-English
 * that looks like a considered label.
 */
export function chipLabel(target: ChipTarget): string {
  switch (target.kind) {
    case 'interest':
      return INTEREST_LABELS[target.value as Interest] ?? '';
    case 'avoidance':
      return AVOIDANCE_LABELS[target.value as Avoidance] ?? '';
    default:
      /*
       * Pace, day start, budget, crowd tolerance and discovery mix are short
       * closed enums whose members already read as English words, and each is
       * rendered beside a fixed label of ours ("Pace", "Budget") that carries
       * the meaning. Underscores are still removed rather than shown.
       */
      return target.value.replace(/_/g, ' ');
  }
}

/** Every confirmed chip as a normalised signal, without applying anything. */
export function preferenceSignals(set: InterpretationSet | undefined): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];
  for (const chip of activeChips(set)) {
    const valence = preferenceValenceOf(chip.strength);
    if (!valence) continue;
    signals.push({
      target: chip.target,
      key: keyForChipTarget(chip.target),
      polarity: valence.polarity,
      magnitude: valence.magnitude,
      exclusionary: valence.exclusionary && canApplyAsExclusion(chip),
      source: chip.source,
      quote: chip.quote,
    });
  }
  return signals;
}

/**
 * THE THEMES SOMEBODY CHOSE, AS INTERESTS THE BOARD CAN RANK ON.
 *
 * Two vocabularies exist for the same question, and they exist for good reasons:
 * `TripTheme` has eight members because a person deciding *where to go* should
 * not be made to grade twelve interests before they have a destination, and
 * `Interest` has twelve because a board ranking places needs the resolution.
 * What was missing is the bridge.
 *
 * The consequence was invisible and complete. A traveller who chose "eating
 * well", "history, museums and architecture" and "city life" in Help Me Decide,
 * adopted a recommendation, and went on to the board got a board ranked on
 * `hiking`, `easy_nature_walks` and `scenic_viewpoints` — the questionnaire's
 * *defaults*. Their themes were preserved perfectly on the composer, carried
 * into the trip untouched, and read by nothing that ranks anything. Found by
 * driving the live journey rather than by any test, because every layer was
 * behaving exactly as written.
 *
 * ---
 *
 * Three rules, and the second is the one that keeps this honest.
 *
 * **A theme raises, never lowers.** It is evidence that somebody wants
 * something, and no evidence at all about the things they did not tick — eight
 * checkboxes cannot express "not this", so reading an unticked box as a refusal
 * would invent a preference out of an absence. Anything not named keeps whatever
 * the answers already had.
 *
 * **A theme is worth `frequent`, not `core`.** `core` is what somebody says when
 * they are shown twelve interests and deliberately push one to the top; a
 * checkbox on a screen offering eight broad categories is a weaker statement
 * than that, and promoting it would let a tick outrank a considered answer.
 *
 * **It never runs over an answer somebody gave.** Applied when the questionnaire
 * is *seeded*, so the moment a traveller edits any of it their own answers win
 * and this is never consulted again.
 */
const INTERESTS_FOR_THEME: Record<string, readonly Interest[]> = {
  outdoors: ['hiking', 'easy_nature_walks'],
  mountains: ['hiking', 'scenic_viewpoints'],
  water: ['lakes_and_rivers'],
  wildlife: ['wildlife'],
  food: ['food_and_towns'],
  culture: ['history_and_culture'],
  cities: ['history_and_culture', 'food_and_towns'],
  quiet: ['stargazing', 'scenic_viewpoints'],
};

export function applyThemes(
  base: QuestionnaireAnswers,
  themes: readonly string[] | undefined,
): QuestionnaireAnswers {
  if (!themes || themes.length === 0) return base;

  const interests: Record<string, InterestLevel> = { ...base.interests };
  let changed = false;
  for (const theme of themes) {
    for (const interest of INTERESTS_FOR_THEME[theme] ?? []) {
      const current = interests[interest] ?? 'low';
      if (LEVEL_RANK['frequent'] <= LEVEL_RANK[current]) continue;
      interests[interest] = 'frequent';
      changed = true;
    }
  }
  if (!changed) return base;
  return { ...base, interests: interests as QuestionnaireAnswers['interests'] };
}
