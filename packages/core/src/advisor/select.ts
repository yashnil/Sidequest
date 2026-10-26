import { CONTINENT_OF } from './catalog/schema';
import type { AdvisorProfile } from './profile';
import { advisorKm } from './origin';
import { experienceSimilarity, type ScoredDestination } from './score';

/**
 * FROM A RANKING TO A SHORTLIST: MAXIMAL MARGINAL RELEVANCE, WITH A FLOOR.
 *
 * The top three raw scores of a broad request are usually three versions of one
 * idea — three alpine regions, or three provinces of one country, which is how
 * the old list came to read as "south-eastern Europe". MMR (Carbonell &
 * Goldstein 1998) picks greedily by
 *
 *     λ · relevance − (1 − λ) · max similarity to what is already picked
 *
 * where similarity mixes the experience profile, geography and country. Two
 * guards from the review (`docs/destination-discovery/research.md`):
 *
 * - **A relevance floor.** Nothing gets in for being different: a candidate
 *   must score within `FLOOR_GAP` of the best and above `FLOOR_ABSOLUTE`.
 * - **λ follows the request.** A worldwide, many-interest request is hedged
 *   (λ low); a request already narrowed to a region or one interest is not
 *   pushed apart for the sake of it (λ high). Diversity is a quality, not a quota.
 *
 * Deterministic: the same ranking always gives the same shortlist.
 */

export const FLOOR_GAP = 0.14;
export const FLOOR_ABSOLUTE = 0.5;
/**
 * Calibration on the lead (Steck 2018, in miniature): once the traveller has
 * said what the trip must be brilliant at, every *primary* pick has to be good
 * at it. A place that is merely good at everything else may still appear, as
 * an alternate.
 */
export const LEAD_FLOOR = 0.6;

export function lambdaFor(profile: AdvisorProfile): number {
  const narrowedPlace = profile.regions !== null || profile.countries !== null || profile.similarTo !== null;
  const narrowInterest = profile.interests.length <= 1 || (profile.interests[0] && profile.interests[0].weight >= 0.99 && profile.interests.length === 1);
  if (narrowedPlace) return 0.9;
  if (narrowInterest) return 0.8;
  return 0.68;
}

export function similarity(a: ScoredDestination, b: ScoredDestination): number {
  const experience = experienceSimilarity(a.destination, b.destination);
  const km = advisorKm(a.destination.center, b.destination.center);
  const geography = Math.exp(-km / 1500);
  const sameCountry = a.destination.countries.some((code) => b.destination.countries.includes(code)) ? 1 : 0;
  const sameContinent = CONTINENT_OF[a.destination.worldRegion] === CONTINENT_OF[b.destination.worldRegion] ? 1 : 0;
  return 0.5 * experience + 0.25 * geography + 0.15 * sameCountry + 0.1 * sameContinent;
}

export interface Selection {
  picks: ScoredDestination[];
  alternates: ScoredDestination[];
  lambda: number;
  /** Candidates as good as the last pick that diversity passed over, for honesty about close calls. */
  closeCalls: ScoredDestination[];
  /** How many primary places had to come from outside the stated lead. */
  leadShort: number;
}

export function selectShortlist(ranked: readonly ScoredDestination[], profile: AdvisorProfile, size = 3, alternates = 3): Selection {
  const lambda = lambdaFor(profile);
  const leadOk = (candidate: ScoredDestination) => !profile.leadStated || (candidate.interestFit[0]?.value ?? 0) >= LEAD_FLOOR;
  const servesLead = ranked.filter(leadOk);
  const top = (servesLead[0] ?? ranked[0])?.score ?? 0;
  const floor = Math.max(FLOOR_ABSOLUTE, top - FLOOR_GAP);
  /*
   * Lead-serving places are judged against each other, not against the best
   * place that ignores the lead: a safari at 0.62 outranks a lake district at
   * 0.80 for someone who said the trip must be a safari.
   */
  const pool = [
    ...servesLead.filter((candidate) => candidate.score >= floor).slice(0, 30),
    ...ranked.filter((candidate) => !leadOk(candidate) && candidate.score >= floor).slice(0, 20),
  ];
  /*
   * The gap keeps a much weaker place from getting in for being different; it
   * must not empty a list. When fewer places clear it than the list holds, the
   * next best above the absolute floor fill in, in rank order.
   */
  for (const candidate of ranked) {
    if (pool.length >= size + alternates) break;
    if (candidate.score >= FLOOR_ABSOLUTE && !pool.includes(candidate)) pool.push(candidate);
  }
  const chosen: ScoredDestination[] = [];
  const remaining = [...pool];
  while (chosen.length < size + alternates && remaining.length > 0) {
    /* Primaries come from the places that serve the lead while any are left. */
    const eligible = chosen.length < size && remaining.some(leadOk) ? remaining.filter(leadOk) : remaining;
    let bestIndex = 0;
    let bestValue = -Infinity;
    eligible.forEach((candidate) => {
      const index = remaining.indexOf(candidate);
      const penalty = chosen.length === 0 ? 0 : Math.max(...chosen.map((picked) => similarity(candidate, picked)));
      const value = lambda * candidate.score - (1 - lambda) * penalty;
      if (value > bestValue + 1e-9) {
        bestValue = value;
        bestIndex = index;
      }
    });
    chosen.push(remaining.splice(bestIndex, 1)[0]!);
  }
  const picks = chosen.slice(0, size);
  const lastPick = picks[picks.length - 1];
  const closeCalls = lastPick
    ? ranked.filter((candidate) => !chosen.includes(candidate) && candidate.score >= lastPick.score - 0.01).slice(0, 3)
    : [];
  const leadShort = profile.leadStated ? Math.max(0, size - picks.filter(leadOk).length) : 0;
  return { picks, alternates: chosen.slice(size), lambda, closeCalls, leadShort };
}
