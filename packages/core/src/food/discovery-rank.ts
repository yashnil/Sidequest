import type { PriceBand } from '../schemas/food';

/**
 * WHICH OF THESE PLACES SUITS THIS TRAVELLER — NOT WHICH HAS THE BEST SCORE.
 *
 * MVP V3, Stages 34 and 35. A places provider returns what it thinks is most
 * relevant, which in practice means most-reviewed, which in practice means the
 * place every visitor already goes to. A four-point-eight with twelve thousand
 * reviews four kilometres away is not a better lunch than a four-point-three
 * around the corner that takes the traveller's diet seriously and costs what
 * they said they wanted to spend. Presenting it as one is the "high-rated
 * tourist trap wins" failure the founder named.
 *
 * So the rating is **one signal among several**, and the ranking is a transparent
 * weighted sum that can say why each place is where it is. The weights are the
 * claim; they are here to be argued with rather than buried in a sort comparator.
 *
 * ## What is deliberately not modelled
 *
 * - **Dietary safety.** A venue's own published statement is the only evidence
 *   Sidequest will act on (`DIETARY_EVIDENCE_LEVELS`), and a discovery result
 *   carries none. A traveller with a strict need therefore gets a *warning*
 *   rather than a reordering: pretending a ranking makes a kitchen safe is the
 *   one thing this file must never do.
 * - **Anything about crowds, queues or whether it is "touristy".** Nothing here
 *   sources that, and inventing a proxy for it out of review counts would be a
 *   guess wearing a number's clothes.
 */

export interface RankableVenue {
  name: string;
  priceLevel?: string;
  rating?: number;
  ratingCount?: number;
  types: readonly string[];
  distanceKm: number;
}

export interface VenueFit {
  /** Traveller's ordinary price ceiling for a meal. */
  priceBand: PriceBand;
  /** How far they are willing to go for one, in km. From their walking tolerance and transport. */
  reachKm: number;
  /** `destination` — happy to cross town for a meal. `budget` — food is fuel. */
  foodStyle: 'budget' | 'local_casual' | 'balanced' | 'destination';
  /** Set when the traveller marked their dietary needs absolute; produces a caution, never a reorder. */
  strictDietary?: boolean;
}

export interface RankedVenue<T extends RankableVenue> {
  venue: T;
  /** 0–1, deterministic. */
  score: number;
  /** The one clause that explains this position, in the traveller's register. */
  why: string;
  /** Shown beside a strict dietary need. Never a reassurance. */
  caution?: string;
}

/** The traveller's own band vocabulary (`PRICE_BANDS`), mapped onto the provider's four levels. */
const BAND_RANK: Record<PriceBand, number> = { budget: 1, moderate: 2, upscale: 3, special: 4 };
const PRICE_LEVEL_RANK: Record<string, number> = { inexpensive: 1, moderate: 2, expensive: 3, very_expensive: 4, free: 1 };

/** Types that read as a local, everyday place rather than a destination restaurant. */
const EVERYDAY_TYPES = ['bakery', 'cafe', 'coffee_shop', 'meal_takeaway', 'market', 'deli', 'sandwich_shop'];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Near is better, and "near" is what the traveller said their reach was. */
export function proximityScore(distanceKm: number, reachKm: number): number {
  if (reachKm <= 0) return 0.5;
  return clamp01(1 - distanceKm / (reachKm * 1.5));
}

/**
 * Price fit: at or under the band is right; above it costs more the further it goes.
 * An unknown price level is neutral, never a penalty — silence is not expensive.
 */
export function priceScore(priceLevel: string | undefined, band: PriceBand): number {
  if (!priceLevel) return 0.6;
  const level = PRICE_LEVEL_RANK[priceLevel];
  const ceiling: number | undefined = BAND_RANK[band];
  if (level === undefined || ceiling === undefined) return 0.6;
  if (level <= ceiling) return 1;
  return clamp01(1 - (level - ceiling) * 0.35);
}

/**
 * The rating, as a signal rather than an oracle.
 *
 * Compressed deliberately: the difference between 4.3 and 4.7 is small, and the
 * difference between "eighty people" and "twelve thousand people" says more
 * about how famous a place is than how good it is. A venue with no rating scores
 * mid, because unknown is not bad.
 */
export function ratingScore(rating: number | undefined, ratingCount: number | undefined): number {
  if (rating === undefined) return 0.55;
  const quality = clamp01((rating - 3.5) / 1.3);
  // A handful of reviews is thin evidence; past a couple of hundred it says nothing more.
  const confidence = ratingCount === undefined ? 0.6 : clamp01(Math.log10(Math.max(1, ratingCount)) / 2.3);
  return clamp01(quality * (0.55 + 0.45 * confidence));
}

/** An everyday local place, for somebody who eats local and casual. */
export function characterScore(types: readonly string[], foodStyle: VenueFit['foodStyle']): number {
  const everyday = types.some((type) => EVERYDAY_TYPES.includes(type));
  if (foodStyle === 'destination') return everyday ? 0.45 : 0.75;
  if (foodStyle === 'budget') return everyday ? 0.9 : 0.5;
  return everyday ? 0.75 : 0.65;
}

/**
 * The weights, stated.
 *
 * Proximity leads because a meal that costs a bus ride is a meal that does not
 * happen; the rating is worth less than either of the two things the traveller
 * actually told us.
 */
export const VENUE_WEIGHTS = { proximity: 0.34, price: 0.26, rating: 0.22, character: 0.18 } as const;

export function rankVenues<T extends RankableVenue>(venues: readonly T[], fit: VenueFit): RankedVenue<T>[] {
  return venues
    .map((venue) => {
      const parts = {
        proximity: proximityScore(venue.distanceKm, fit.reachKm),
        price: priceScore(venue.priceLevel, fit.priceBand),
        rating: ratingScore(venue.rating, venue.ratingCount),
        character: characterScore(venue.types, fit.foodStyle),
      };
      const score = clamp01(
        parts.proximity * VENUE_WEIGHTS.proximity + parts.price * VENUE_WEIGHTS.price + parts.rating * VENUE_WEIGHTS.rating + parts.character * VENUE_WEIGHTS.character,
      );
      const best = (Object.entries(parts) as [keyof typeof parts, number][]).sort((a, b) => b[1] - a[1])[0]![0];
      const why =
        best === 'proximity'
          ? `${venue.distanceKm} km away`
          : best === 'price'
            ? 'in the price range you said'
            : best === 'rating'
              ? venue.ratingCount !== undefined && venue.ratingCount > 0
                ? `${venue.rating?.toFixed(1)} from ${formatCount(venue.ratingCount)} reviews`
                : 'well reviewed'
              : fit.foodStyle === 'budget'
                ? 'the everyday kind of place you asked for'
                : 'the kind of place that suits this trip';
      return {
        venue,
        score: Math.round(score * 1000) / 1000,
        why,
        ...(fit.strictDietary ? { caution: 'Nobody has confirmed this kitchen can meet your requirement — ask before you rely on it.' } : {}),
      };
    })
    .sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name));
}

/** "12k reviews" reads; "12043 reviews" is a number nobody needed. */
export function formatCount(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(count);
}
