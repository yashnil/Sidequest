import { z } from 'zod';
import { scoreExperienceValue, type ExperienceValueInput } from './value';

/**
 * V11 §7 — WHAT THE TRIP IS BUILT AROUND.
 *
 * Both founder trips answered that question with their first three days.
 *
 *   Canadian Rockies — Bow Falls, Lake Louise, Moraine Lake
 *   Kyrgyzstan       — Osh Bazaar, Issyk-Kul north shore, Karakol market
 *
 * Because the selection was `anchors.filter(core).slice(0, 3)` over an array in
 * day order. "The trip is built around" meant "whatever happens first". For four
 * fit travellers who asked for intense hiking, the trip was built around a
 * bazaar, a comfort stop on a drive, and a market — while the plan's own prose
 * called Ala-Kul Pass *"the signature high crossing of the trip"* and Song-Kol
 * Lake *"the second signature landscape"* on days five and eight.
 *
 * ## What this scores, and what it refuses to
 *
 * §7 lists eleven dimensions. Some of them — rarity, cultural significance,
 * emotional value — are not things this repository can measure, and a weight
 * multiplied by a guess is a guess with a number on it. So they are represented
 * only through signals the plan genuinely states about itself:
 *
 * | §7 dimension | The signal actually used |
 * | --- | --- |
 * | traveller fit | the interest scorer already in `experience/value.ts` |
 * | trip architecture importance | belongs to a multi-day experience; is a route-defining stop |
 * | duration / commitment | the scheduled minutes the plan gives it |
 * | effort / reward | the physical intensity the plan recorded, **against what this traveller wants** — a strenuous stop is not a signature for somebody whose trip is about food |
 * | destination uniqueness | the draft's own word, plus the value scorer's `uniqueness` |
 * | geographic centrality | route-critical, from the placement report |
 * | seasonality | an access or season constraint the plan carries |
 * | redundancy penalty | a second experience sharing a category with one already chosen |
 *
 * **Markets and orientation walks are not penalised for being markets.** §7 is
 * explicit that they can be wonderful. What is penalised is an anchor the plan
 * itself treats as filler — a short stop on an arrival or departure day, put
 * there to occupy the hours after landing — and being the second of its kind.
 * A food-led trip whose traveller ranked markets highly will still rank one
 * first, because the fit term will carry it. No destination, place or category
 * name appears anywhere in this file.
 */

export const SIGNATURE_SIGNALS = ['statedByPlan', 'travellerFit', 'architecture', 'commitment', 'effort', 'uniqueness', 'seasonAccess'] as const;
export type SignatureSignal = (typeof SIGNATURE_SIGNALS)[number];

/**
 * Weights. `statedByPlan` leads because the composing model has read the whole
 * brief and said, in the same answer, which experiences the trip exists for —
 * and the product was throwing that away. `architecture` is next because an
 * experience that occupies three days of an eleven-day trip is what the trip
 * is, whatever else scores well.
 */
export const SIGNATURE_WEIGHTS: Record<SignatureSignal, number> = {
  statedByPlan: 0.26,
  architecture: 0.22,
  travellerFit: 0.2,
  commitment: 0.12,
  effort: 0.08,
  uniqueness: 0.08,
  seasonAccess: 0.04,
};

export interface SignatureCandidate {
  id: string;
  name: string;
  dayNumber: number;
  /** The draft's own category for it. Used only for the redundancy penalty. */
  category?: string | undefined;
  role?: 'core' | 'secondary' | 'optional' | 'flex' | undefined;
  /** Scheduled minutes at the stop, when the plan gave it any. */
  minutes?: number | undefined;
  physicalIntensity?: 'none' | 'easy' | 'moderate' | 'strenuous' | undefined;
  /** The multi-day experience this anchor sits inside, when it does. */
  withinExperience?: string | undefined;
  /** Whether the placement report treated this as route-critical. */
  routeCritical?: boolean | undefined;
  /** Whether the plan carries an access or seasonal constraint for it — something that has to line up. */
  constrained?: boolean | undefined;
  verification?: ExperienceValueInput['verification'] | undefined;
  /** Whether this stop sits on the arrival or departure day. */
  onEdgeDay?: boolean | undefined;
  why?: string | undefined;
}

export interface SignatureSelection {
  id: string;
  name: string;
  dayNumber: number;
  score: number;
  /** Every signal that lifted this above the rest, strongest first. Traveller-safe prose is NOT built here. */
  reasons: SignatureSignal[];
  why?: string | undefined;
}

export const signatureSelectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  dayNumber: z.number().int().min(1),
  score: z.number().min(0).max(1),
  reasons: z.array(z.enum(SIGNATURE_SIGNALS)).max(SIGNATURE_SIGNALS.length),
  why: z.string().min(1).max(400).optional(),
});

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Whether the plan named this experience as one of the things the trip is for.
 *
 * Matched loosely in both directions because the draft writes a phrase ("the
 * Ala-Kul pass crossing") and the anchor carries a name ("Ala-Kul Pass"), and
 * requiring them to be identical would throw the signal away exactly when it
 * matters most.
 */
function statedByPlan(name: string, stated: readonly string[]): boolean {
  const target = normalize(name);
  if (!target) return false;
  return stated.some((entry) => {
    const other = normalize(entry);
    return other.length > 0 && (other === target || other.includes(target) || target.includes(other));
  });
}

export interface SignatureSelectionInput {
  candidates: readonly SignatureCandidate[];
  /** What the draft itself said the trip is built around. */
  statedSignatures?: readonly string[] | undefined;
  /** The traveller's ranked interests, strongest first. */
  travellerInterests?: readonly string[] | undefined;
  /**
   * Whether this traveller wants demanding days. Undefined means nobody said,
   * and effort then discriminates between nothing — a strenuous stop is not
   * inherently more of a signature than an easy one, and treating it as one
   * would answer "a long walk" for a traveller whose trip is about food.
   */
  travellerWantsEffort?: boolean | undefined;
  avoidances?: readonly string[] | undefined;
  limit?: number;
}

/**
 * The experiences the trip is built around, best first.
 *
 * Selection is greedy over the score with a redundancy penalty applied *as it
 * goes*, so a second experience of a kind already chosen has to be clearly
 * better than the alternatives to displace something different — which is how
 * "market, lake view, market" stops being an answer without markets being
 * penalised for existing.
 */
export function selectSignatureExperiences(input: SignatureSelectionInput): SignatureSelection[] {
  const stated = input.statedSignatures ?? [];
  const interests = input.travellerInterests ?? [];
  const limit = input.limit ?? 3;

  const scored = input.candidates.map((candidate) => {
    const value = scoreExperienceValue({
      name: candidate.name,
      tags: candidate.category ? [candidate.category] : [],
      travellerInterests: interests,
      ...(input.avoidances ? { avoidances: input.avoidances } : {}),
      ...(candidate.minutes !== undefined ? { minutes: candidate.minutes } : {}),
      ...(candidate.verification ? { verification: candidate.verification } : {}),
    });

    const signals: Record<SignatureSignal, number> = {
      statedByPlan: statedByPlan(candidate.name, stated) ? 1 : 0,
      /*
       * An experience that owns days of the trip IS the trip's architecture. A
       * route-defining stop is the next strongest thing: the route bends for it.
       */
      architecture: candidate.withinExperience ? 1 : candidate.routeCritical ? 0.6 : 0.15,
      travellerFit: clamp01(value.signals.travellerFit),
      /*
       * How much of the day the plan gives it. An hour is a stop; four hours is
       * a decision about what the day is for. An edge-day filler is discounted
       * outright, because the plan put it there to occupy time rather than
       * because the trip is about it.
       */
      commitment: candidate.onEdgeDay && (candidate.minutes ?? 0) < 150 ? 0.05 : candidate.minutes === undefined ? 0.4 : clamp01((candidate.minutes - 30) / 270),
      effort:
        input.travellerWantsEffort === undefined
          ? 0.5
          : input.travellerWantsEffort
            ? candidate.physicalIntensity === 'strenuous'
              ? 1
              : candidate.physicalIntensity === 'moderate'
                ? 0.6
                : 0.25
            : candidate.physicalIntensity === 'strenuous'
              ? 0.25
              : candidate.physicalIntensity === 'moderate'
                ? 0.6
                : 1,
      uniqueness: clamp01(value.signals.uniqueness),
      seasonAccess: candidate.constrained ? 1 : 0.4,
    };

    let score = 0;
    for (const signal of SIGNATURE_SIGNALS) score += signals[signal] * SIGNATURE_WEIGHTS[signal];
    /* The reasons are the signals that actually carried it, by weighted contribution. */
    const reasons = [...SIGNATURE_SIGNALS]
      .filter((signal) => signals[signal] * SIGNATURE_WEIGHTS[signal] >= 0.06)
      .sort((a, b) => signals[b] * SIGNATURE_WEIGHTS[b] - signals[a] * SIGNATURE_WEIGHTS[a]);
    return { candidate, score, reasons };
  });

  const picked: SignatureSelection[] = [];
  const takenCategories = new Set<string>();
  const takenExperiences = new Set<string>();
  const remaining = [...scored];
  while (picked.length < limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestAdjusted = -1;
    remaining.forEach((entry, index) => {
      const category = normalize(entry.candidate.category ?? '');
      /*
       * Redundancy, applied twice over. A second experience of a category
       * already chosen is discounted; a second anchor from an experience already
       * represented is discounted harder, because listing two stops of one trek
       * as two of the three things the trip is built around says less than
       * naming a different chapter.
       */
      const categoryPenalty = category && takenCategories.has(category) ? 0.45 : 1;
      const experiencePenalty = entry.candidate.withinExperience && takenExperiences.has(entry.candidate.withinExperience) ? 0.3 : 1;
      const adjusted = entry.score * categoryPenalty * experiencePenalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    if (!chosen) break;
    const category = normalize(chosen.candidate.category ?? '');
    if (category) takenCategories.add(category);
    if (chosen.candidate.withinExperience) takenExperiences.add(chosen.candidate.withinExperience);
    picked.push({
      id: chosen.candidate.id,
      name: chosen.candidate.name,
      dayNumber: chosen.candidate.dayNumber,
      score: Math.round(chosen.score * 1000) / 1000,
      reasons: chosen.reasons,
      ...(chosen.candidate.why ? { why: chosen.candidate.why } : {}),
    });
  }
  /* Presented in the order they happen: a list of three things out of trip order reads as a ranking, which it is not. */
  return picked.sort((a, b) => a.dayNumber - b.dayNumber);
}
