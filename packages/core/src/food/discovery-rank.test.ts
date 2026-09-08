import { describe, expect, it } from 'vitest';
import { formatCount, rankVenues, ratingScore, type RankableVenue, type VenueFit } from './discovery-rank';

/**
 * The property that matters: a famous place does not win by being famous.
 */

const FIT: VenueFit = { priceBand: 'moderate', reachKm: 1.5, foodStyle: 'local_casual' };

const trap: RankableVenue = { name: 'The Famous One', priceLevel: 'expensive', rating: 4.8, ratingCount: 12_400, types: ['restaurant'], distanceKm: 4.2 };
const local: RankableVenue = { name: 'Corner Kitchen', priceLevel: 'moderate', rating: 4.3, ratingCount: 210, types: ['restaurant'], distanceKm: 0.3 };

describe('venues are ranked on fit, not on rating', () => {
  it('a nearer, cheaper, slightly lower-rated place beats a famous one across town', () => {
    const ranked = rankVenues([trap, local], FIT);
    expect(ranked[0]!.venue.name).toBe('Corner Kitchen');
  });

  it('the famous one still wins when it is the one that actually fits', () => {
    const ranked = rankVenues([{ ...trap, distanceKm: 0.4, priceLevel: 'moderate' }, { ...local, distanceKm: 2.9 }], FIT);
    expect(ranked[0]!.venue.name).toBe('The Famous One');
  });

  it('says why each place is where it is', () => {
    const ranked = rankVenues([trap, local], FIT);
    expect(ranked[0]!.why).toMatch(/km away|price range|reviews|kind of place/);
  });

  it('an unrated place is not treated as a bad one', () => {
    expect(ratingScore(undefined, undefined)).toBeGreaterThan(ratingScore(3.4, 800));
  });

  it('a handful of reviews counts for less than a few hundred', () => {
    expect(ratingScore(4.6, 6)).toBeLessThan(ratingScore(4.6, 600));
  });

  it('never reorders around a dietary need — it cautions instead', () => {
    const ranked = rankVenues([trap, local], { ...FIT, strictDietary: true });
    for (const entry of ranked) {
      expect(entry.caution).toMatch(/Nobody has confirmed/);
      expect(entry.caution).not.toMatch(/safe|suitable|guaranteed/i);
    }
  });

  it('is deterministic', () => {
    expect(rankVenues([trap, local], FIT).map((entry) => entry.venue.name)).toEqual(rankVenues([local, trap], FIT).map((entry) => entry.venue.name));
  });
});

describe('review counts read like counts', () => {
  it('shortens the big ones', () => {
    expect(formatCount(12_400)).toBe('12k');
    expect(formatCount(1_250)).toBe('1.3k');
    expect(formatCount(210)).toBe('210');
  });
});
