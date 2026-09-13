import { z } from 'zod';

/**
 * V10 §12 — EXPERIENCE VALUE, WITHOUT REDUCING TRAVEL TO POPULARITY.
 *
 * The founder's trip opened on a city church, a harbour walk, a museum and a
 * spa for an adventurous traveller who had asked for glaciers and landscape,
 * and `signatureCoverage` reported **1.0** — because the metric asked "did the
 * plan deliver the signatures the model named?" and never "were those
 * signatures worth naming?".
 *
 * This scores the second question, and three things about how it does so matter
 * more than the numbers:
 *
 * 1. **It does not author.** The model remains the composer. This produces a
 *    *signal* the quality compiler reads to say "the defining set looks weak for
 *    this traveller" — never a candidate list, never a replacement, never a veto.
 *    Reviving the retired candidate-selection universe is explicitly out (§11).
 * 2. **Popularity is not in it.** Uniqueness-to-destination is: whether you
 *    could have this experience somewhere else. A city church is not weak
 *    because it is popular; it is weak *for this trip* because a church is not
 *    what the Icelandic landscape is for, and the traveller said so.
 * 3. **Every signal is separate and stays separate.** They are reported as a
 *    vector with a headline, and a low score always names which signal was low.
 *    One opaque number is what made `signatureCoverage: 1.0` useless.
 */

export const VALUE_SIGNALS = [
  /** Could you have this experience somewhere else, or is it this destination? */
  'uniqueness',
  /** How well it matches what this traveller ranked. */
  'travellerFit',
  /** Reward for the effort it costs: a hard thing that pays, not a hard thing. */
  'effortReward',
  /** Whether the season it falls in is the season for it. */
  'seasonality',
  /** What it costs the route in travel: a detour that earns itself, or one that does not. */
  'routeCost',
  /** Whether the trip already contains three of these. */
  'distinctiveness',
  /** Crowds, as a burden on the experience rather than a measure of its quality. */
  'crowdBurden',
  /** How well anything is actually known about it. Unknown lowers the score; it never raises it. */
  'evidence',
] as const;
export const valueSignalSchema = z.enum(VALUE_SIGNALS);
export type ValueSignal = z.infer<typeof valueSignalSchema>;

export type ValueVector = Record<ValueSignal, number>;

export const VALUE_WEIGHTS: ValueVector = {
  uniqueness: 0.22,
  travellerFit: 0.24,
  effortReward: 0.12,
  seasonality: 0.12,
  routeCost: 0.1,
  distinctiveness: 0.1,
  crowdBurden: 0.05,
  evidence: 0.05,
};

export interface ExperienceValueInput {
  name: string;
  /** The interest tags the experience satisfies, as the interview names them. */
  tags: readonly string[];
  /** What the traveller ranked, strongest first. */
  travellerInterests: readonly string[];
  /** Interests the traveller said to avoid. */
  avoidances?: readonly string[];
  /**
   * How specific to this destination the experience is. Supplied by the caller
   * from the landscape and the semantic type — never from a name lookup.
   */
  destinationTypical?: boolean;
  /** True for something a traveller could do in most cities: a cathedral, an aquarium, a mall. */
  genericAnywhere?: boolean;
  /** Minutes it costs, including access. */
  minutes?: number | undefined;
  /** Detour kilometres it adds to the route beyond the day's own line. */
  detourKm?: number | undefined;
  /** True when the season the plan falls in is the one this is worth doing in. Unknown stays undefined. */
  inSeason?: boolean | undefined;
  /** How many other experiences in the plan share its primary tag. */
  siblingsWithSameTag?: number;
  /** True when a crowd period the destination's reality knows about touches the plan's dates. */
  crowded?: boolean;
  /** Whether the place was placed and confirmed. */
  verification?: 'verified' | 'partially_verified' | 'unverified';
}

export interface ExperienceValue {
  name: string;
  signals: ValueVector;
  /** The weighted headline, 0–1. Never shown alone. */
  score: number;
  /** The signals that dragged it down, worst first, with a sentence each. */
  weakest: readonly { signal: ValueSignal; value: number; why: string }[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * How well this experience matches what the traveller ranked — and, just as
 * importantly, when that question cannot be answered.
 *
 * A live build scored a glacier walk, a glacier hike and a black-sand beach as a
 * *weak* set for a traveller who had asked for exactly glaciers and coast. The
 * cause was not the plan: the only tag those experiences carried was the draft's
 * own coarse category (`nature`, `viewpoint`), and the traveller's interests are
 * interview keys (`hiking`, `scenic_drives`). Nothing overlapped, every fit
 * scored zero, and the compiler called a good set weak.
 *
 * A vocabulary that does not meet is **unknown**, not zero. Zero is reserved for
 * the one thing that genuinely means it: a tag the traveller said to avoid.
 */
function fitOf(input: ExperienceValueInput): number {
  const interests = input.travellerInterests.map((i) => i.toLowerCase());
  const avoid = new Set((input.avoidances ?? []).map((a) => a.toLowerCase()));
  if (input.tags.some((t) => avoid.has(t.toLowerCase()))) return 0;
  if (interests.length === 0 || input.tags.length === 0) return 0.5;
  let best = 0;
  let comparable = false;
  for (const tag of input.tags) {
    const index = interests.indexOf(tag.toLowerCase());
    if (index < 0) continue;
    comparable = true;
    /* Rank matters: the first thing somebody ranked is what the trip is for. */
    best = Math.max(best, 1 - index / Math.max(interests.length, 1) * 0.6);
  }
  /* Nothing in common between the two vocabularies is a gap in the evidence, not a verdict about the trip. */
  return comparable ? best : 0.5;
}

export function scoreExperienceValue(input: ExperienceValueInput): ExperienceValue {
  const signals: ValueVector = {
    uniqueness: input.genericAnywhere ? 0.15 : input.destinationTypical ? 1 : 0.55,
    travellerFit: fitOf(input),
    effortReward:
      input.minutes === undefined
        ? 0.5
        : /* Up to three hours is cheap; a full day has to be worth a full day, which only a defining thing is. */
          input.minutes <= 180
          ? 0.9
          : input.minutes <= 360
            ? 0.7
            : input.destinationTypical
              ? 0.6
              : 0.3,
    seasonality: input.inSeason === undefined ? 0.5 : input.inSeason ? 1 : 0.1,
    routeCost: input.detourKm === undefined ? 0.6 : input.detourKm <= 15 ? 1 : input.detourKm <= 60 ? 0.7 : input.detourKm <= 150 ? 0.4 : 0.15,
    distinctiveness: (input.siblingsWithSameTag ?? 0) <= 1 ? 1 : (input.siblingsWithSameTag ?? 0) <= 2 ? 0.7 : 0.35,
    crowdBurden: input.crowded ? 0.4 : 0.85,
    evidence: input.verification === 'verified' ? 1 : input.verification === 'partially_verified' ? 0.7 : 0.35,
  };
  let score = 0;
  for (const signal of VALUE_SIGNALS) score += clamp01(signals[signal]) * VALUE_WEIGHTS[signal];

  const why: Record<ValueSignal, string> = {
    uniqueness: input.genericAnywhere ? `${input.name} is the kind of thing most cities have` : `${input.name} is not especially particular to this destination`,
    travellerFit: `${input.name} does not match much of what you ranked`,
    effortReward: `${input.name} costs a lot of the day for what it is`,
    seasonality: `${input.name} is not at its best in this season`,
    routeCost: `${input.name} pulls the route a long way off its line`,
    distinctiveness: `the trip already holds several experiences like ${input.name}`,
    crowdBurden: `${input.name} falls in a busy period`,
    evidence: `little is confirmed about ${input.name} yet`,
  };
  const weakest = VALUE_SIGNALS.filter((s) => signals[s] < 0.4)
    .sort((a, b) => signals[a] - signals[b])
    .map((signal) => ({ signal, value: Math.round(signals[signal] * 100) / 100, why: why[signal] }));

  return { name: input.name, signals, score: Math.round(clamp01(score) * 100) / 100, weakest };
}

/**
 * V10 §11 §12 — is the set of experiences the plan is built around weak?
 *
 * Deliberately a question about the *set*, because that is what the founder saw:
 * every individual stop was fine and the set was a city break. A set is weak
 * when its best member is mediocre, or when most of its members would be
 * available anywhere.
 */
export function definingSetIsWeak(input: { values: readonly ExperienceValue[]; threshold?: number }): { weak: boolean; detail: string } {
  const values = input.values;
  if (values.length === 0) return { weak: true, detail: 'The plan does not say what it is built around.' };
  /*
   * A set nothing is known about is not a weak set. Where every member scored
   * `travellerFit` and `uniqueness` at the neutral value, the scorer had nothing
   * to work with — and saying "this looks weak" on no evidence is the same
   * mistake `signatureCoverage: 1.0` made in the other direction.
   */
  if (values.every((v) => v.signals.travellerFit === 0.5 && v.signals.uniqueness === 0.55)) {
    return { weak: false, detail: 'Not enough is known about these to judge them against what you asked for.' };
  }
  const threshold = input.threshold ?? 0.55;
  const best = values.reduce((a, b) => (b.score > a.score ? b : a));
  const mean = values.reduce((sum, v) => sum + v.score, 0) / values.length;
  const generic = values.filter((v) => v.signals.uniqueness < 0.3);
  if (best.score < threshold) {
    return { weak: true, detail: `The strongest thing the plan is built around is ${best.name}, and ${best.weakest[0]?.why ?? 'it is a modest highlight for this trip'}.` };
  }
  if (generic.length > values.length / 2) {
    return { weak: true, detail: `${generic.length} of the ${values.length} experiences the plan is built around (${generic.slice(0, 3).map((g) => g.name).join(', ')}) are the kind of thing most destinations have.` };
  }
  if (mean < threshold - 0.1) {
    return { weak: true, detail: `The experiences the plan is built around average ${Math.round(mean * 100)} out of 100 against what you asked for.` };
  }
  return { weak: false, detail: `${best.name} leads a defining set that matches what you asked for.` };
}
