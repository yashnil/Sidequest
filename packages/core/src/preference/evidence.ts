import { z } from 'zod';

/**
 * THE PREFERENCE EVIDENCE LEDGER — WHAT THE TRAVELLER SAID AND DID, AS SIGNALS.
 *
 * V6 §18/§19/§31. Every explicit choice and every behaviour that carries
 * taste is one row: a feature (an interest, a category, a pace, a place
 * kind), a polarity, a strength, a source, a scope (this trip or the account)
 * and a timestamp. Nothing here is ever a hard constraint: allergies,
 * medical needs, religion and accessibility are never learned from clicks,
 * and the ledger refuses features in that vocabulary at the door.
 *
 * Stage A/B (this pass): deterministic weights, then per-user weights
 * aggregated from the ledger with recency decay and source weighting. Stages
 * C and D (learning-to-rank, contextual bandits) are designed for — every
 * recommendation decision is recordable with its context — and not built,
 * because there is not yet the data to evaluate them offline.
 */

export const EVIDENCE_SIGNALS = [
  'interest_selected',
  'interest_frequency',
  'avoid_selected',
  'must_do_named',
  'free_text_preference',
  'place_included',
  'place_rejected',
  'too_touristy',
  'too_intense',
  'too_expensive',
  'recommendation_accepted',
  'day_edited',
  'experience_removed',
  'refinement_requested',
  'refinement_undone',
  'item_booked',
  'trip_duplicated',
  'trip_completed',
  'post_trip_loved',
  'post_trip_skip',
  'post_trip_pace',
] as const;
export const evidenceSignalSchema = z.enum(EVIDENCE_SIGNALS);
export type EvidenceSignal = z.infer<typeof evidenceSignalSchema>;

export const EVIDENCE_SOURCES = ['explicit', 'behaviour', 'post_trip'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const EVIDENCE_SCOPES = ['trip', 'account'] as const;
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number];

/** Features that are never learned. A row naming one is refused. */
const FORBIDDEN_FEATURES = /allerg|halal|kosher|jain|vegan|vegetarian|gluten|dairy|wheelchair|step[- ]free|mobility|medic|pregnan|religio|diagnos|disab/i;

export interface PreferenceEvidenceRow {
  id: string;
  userId: string | null;
  ownerToken: string | null;
  travelerId: string | null;
  tripId: string | null;
  scope: EvidenceScope;
  signal: EvidenceSignal;
  /** `interest:hiking`, `category:market`, `pace:slow`, `place_kind:viewpoint`, `theme:temples`. */
  feature: string;
  /** +1 towards, −1 away. */
  polarity: 1 | -1;
  /** 0–1. */
  strength: number;
  source: EvidenceSource;
  context: Record<string, unknown>;
  createdAt: string;
}

export function featureIsLearnable(feature: string): boolean {
  return feature.length > 0 && feature.length <= 80 && !FORBIDDEN_FEATURES.test(feature);
}

/** Default strengths: an explicit answer outweighs a click; a post-trip verdict outweighs both. */
export const SIGNAL_STRENGTH: Record<EvidenceSignal, number> = {
  interest_selected: 0.8,
  interest_frequency: 0.9,
  avoid_selected: 0.9,
  must_do_named: 0.9,
  free_text_preference: 0.6,
  place_included: 0.4,
  place_rejected: 0.4,
  too_touristy: 0.5,
  too_intense: 0.5,
  too_expensive: 0.5,
  recommendation_accepted: 0.3,
  day_edited: 0.2,
  experience_removed: 0.4,
  refinement_requested: 0.5,
  refinement_undone: 0.3,
  item_booked: 0.3,
  trip_duplicated: 0.2,
  trip_completed: 0.2,
  post_trip_loved: 1,
  post_trip_skip: 1,
  post_trip_pace: 0.9,
};

export const SOURCE_WEIGHT: Record<EvidenceSource, number> = { explicit: 1, behaviour: 0.5, post_trip: 1.2 };

export interface LearnedPreference {
  feature: string;
  /** −1…1, the net lean. */
  weight: number;
  /** 0–1: how much evidence stands behind it. */
  confidence: number;
  rows: number;
  /** `low` below three rows or a weak lean; `medium` otherwise; `high` only with post-trip or repeated explicit evidence. */
  band: 'low' | 'medium' | 'high';
}

/** Half-life for behaviour, in days. Explicit and post-trip evidence decays at a third of the rate. */
const BEHAVIOUR_HALF_LIFE_DAYS = 180;

function decay(row: Pick<PreferenceEvidenceRow, 'createdAt' | 'source'>, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(row.createdAt)) / 86_400_000);
  const halfLife = row.source === 'behaviour' ? BEHAVIOUR_HALF_LIFE_DAYS : BEHAVIOUR_HALF_LIFE_DAYS * 3;
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * Stage B — per-feature weights from the ledger. Deterministic, explainable,
 * and honest about how little it knows: three behaviour rows never produce
 * `high`, and a single explicit answer is `low` until repeated.
 */
export function learnPreferences(rows: readonly PreferenceEvidenceRow[], now: Date = new Date()): LearnedPreference[] {
  const byFeature = new Map<string, PreferenceEvidenceRow[]>();
  for (const row of rows) {
    if (!featureIsLearnable(row.feature)) continue;
    const list = byFeature.get(row.feature) ?? [];
    list.push(row);
    byFeature.set(row.feature, list);
  }
  const learned: LearnedPreference[] = [];
  for (const [feature, list] of byFeature) {
    let sum = 0;
    let mass = 0;
    let explicitCount = 0;
    let postTrip = 0;
    for (const row of list) {
      const w = row.strength * SOURCE_WEIGHT[row.source] * decay(row, now);
      sum += row.polarity * w;
      mass += w;
      if (row.source === 'explicit') explicitCount += 1;
      if (row.source === 'post_trip') postTrip += 1;
    }
    if (mass === 0) continue;
    const weight = Math.max(-1, Math.min(1, sum / mass));
    const confidence = Math.min(1, mass / 3);
    const band: LearnedPreference['band'] = postTrip > 0 || explicitCount >= 2 ? (Math.abs(weight) >= 0.5 && confidence >= 0.6 ? 'high' : 'medium') : list.length >= 3 && Math.abs(weight) >= 0.4 ? 'medium' : 'low';
    learned.push({ feature, weight: Math.round(weight * 100) / 100, confidence: Math.round(confidence * 100) / 100, rows: list.length, band });
  }
  return learned.sort((a, b) => Math.abs(b.weight) * b.confidence - Math.abs(a.weight) * a.confidence);
}

/**
 * The brief's learned hints: only medium and high, phrased as leanings, never
 * as rules. The composition may trade them away.
 */
export function learnedHints(learned: readonly LearnedPreference[], limit = 6): string[] {
  return learned
    .filter((p) => p.band !== 'low')
    .slice(0, limit)
    .map((p) => {
      const [kind, ...rest] = p.feature.split(':');
      const name = rest.join(':').replace(/_/g, ' ');
      const lean = p.weight > 0 ? 'leans towards' : 'leans away from';
      return `${lean} ${name}${kind && kind !== 'interest' ? ` (${kind.replace(/_/g, ' ')})` : ''} — from ${p.rows} earlier signal${p.rows === 1 ? '' : 's'}, ${p.band} confidence`;
    });
}

/**
 * Stage C/D seam — a recommendation decision as it will be needed for
 * offline evaluation later: what was shown, in what context, and what the
 * traveller did. Recorded now so future ranking can be judged against real
 * outcomes rather than trained on nothing.
 */
export interface RecommendationDecision {
  tripId: string;
  surface: 'discovery' | 'itinerary' | 'refinement';
  candidateFeatures: Record<string, number>;
  shownRank: number;
  outcome: 'included' | 'rejected' | 'ignored' | null;
  at: string;
}
