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
/** Below the bar but worth showing when nothing clears it — never lower than this. */
export const STRETCH_FLOOR = 0.3;
const NAMED_ABOUT = 0.45;
/** A guide can mention a gorilla in a zoo; the place still has to be good at the wider thing. */
const NAMED_MIN_FIT = 0.3;
/** How well a primary must suit the kind of trip, when the kind of trip leads the request (`concept.ts#vacationFit`). */
const VACATION_FLOOR = 0.75;
/**
 * Calibration on the lead (Steck 2018, in miniature): once the traveller has
 * said what the trip must be brilliant at, every *primary* pick has to be good
 * at it. A place that is merely good at everything else may still appear, as
 * an alternate.
 */
export const LEAD_FLOOR = 0.6;
export const LEAD_FLOOR_DERIVED = 0.5;

export function lambdaFor(profile: AdvisorProfile): number {
  const narrowedPlace = profile.regions !== null || profile.countries !== null || profile.within !== null || profile.similarTo !== null;
  const narrowInterest = profile.interests.length <= 1 || (profile.interests[0] && profile.interests[0].weight >= 0.99 && profile.interests.length === 1);
  if (narrowedPlace) return 0.9;
  if (narrowInterest) return 0.8;
  return 0.68;
}

/**
 * Whether two destinations are the same ground.
 *
 * With one record per hand-drawn region this could not happen. With a
 * hierarchy it is the default: the Dolomites, South Tyrol, Val Gardena and
 * Ortisei are four records and one holiday. 1 = one contains the other (by the
 * travel hierarchy, or one centre sits well inside the other's extent), 0.6 =
 * their extents overlap substantially, 0 = separate trips.
 */
export function overlap(a: ScoredDestination['destination'], b: ScoredDestination['destination']): number {
  if (a.id === b.id || a.parents.includes(b.id) || b.parents.includes(a.id)) return 1;
  if (a.wikidataId && a.wikidataId === b.wikidataId) return 1;
  /* Different landmasses are different trips, however their circles overlap: Bali is not Lombok. */
  if (a.landmass && b.landmass && a.landmass !== b.landmass) return 0;
  const km = advisorKm(a.center, b.center);
  const larger = Math.max(a.radiusKm, b.radiusKm);
  if (km < Math.max(12, 0.6 * larger)) return 1;
  if (km < 0.5 * (a.radiusKm + b.radiusKm)) return 0.6;
  return 0;
}

export function similarity(a: ScoredDestination, b: ScoredDestination): number {
  const experience = experienceSimilarity(a.destination, b.destination);
  const km = advisorKm(a.destination.center, b.destination.center);
  const geography = Math.exp(-km / 1500);
  const sameCountry = a.destination.countries.some((code) => b.destination.countries.includes(code)) ? 1 : 0;
  const sameContinent = CONTINENT_OF[a.destination.worldRegion] === CONTINENT_OF[b.destination.worldRegion] ? 1 : 0;
  const base = 0.5 * experience + 0.25 * geography + 0.15 * sameCountry + 0.1 * sameContinent;
  return Math.max(base, overlap(a.destination, b.destination));
}

export interface Selection {
  picks: ScoredDestination[];
  alternates: ScoredDestination[];
  lambda: number;
  /** Candidates as good as the last pick that diversity passed over, for honesty about close calls. */
  closeCalls: ScoredDestination[];
  /** How many primary places had to come from outside the stated lead. */
  leadShort: number;
  /** True when nothing cleared the relevance bar and these are the closest that exist. */
  stretched: boolean;
}

export function selectShortlist(ranked: readonly ScoredDestination[], profile: AdvisorProfile, size = 3, alternates = 3): Selection {
  const lambda = lambdaFor(profile);
  /*
   * A derived reading is already discounted for thin evidence; holding it to the
   * editorial floor as well would count that uncertainty twice and keep a
   * well-matched but little-documented place out of the primaries for good.
   */
  /* A place whose guide is plainly about the request's own words ("tea plantations") serves the request, whatever the structured reading of its lead. */
  const leadOk = (candidate: ScoredDestination) =>
    !profile.leadStated ||
    (candidate.interestFit[0]?.value ?? 0) >= (candidate.destination.origin === 'editorial' ? LEAD_FLOOR : LEAD_FLOOR_DERIVED) ||
    /* Above anything the meaning channel can give on its own: this takes the guide actually using the words. */
    (candidate.destination.mention ?? 0) >= 0.7;
  /*
   * The request named a thing ("gorillas") and enough places are written up for
   * it: the primaries come from those. A place superb at the wider interest is
   * still an alternate, but it does not have what was asked for.
   */
  const about = (candidate: ScoredDestination) => (candidate.destination.namedMention ?? 0) >= NAMED_ABOUT && Math.max(0, ...candidate.interestFit.map((fit) => fit.value)) >= NAMED_MIN_FIT;
  const named = profile.named.length > 0 && ranked.filter(about).filter((candidate, index, list) => !list.slice(0, index).some((other) => overlap(candidate.destination, other.destination) >= 1)).length >= 2;
  /*
   * When the kind of trip is what the request is mostly about (rest, wellness,
   * family, luxury), the primaries must suit it, the way they must serve a
   * stated lead: a city break is not offered as a restful outdoor family trip
   * for being different from the others. Only while enough places qualify.
   */
  const vacationOf = (candidate: ScoredDestination) => {
    const factor = candidate.factors.find((entry) => entry.id === 'vacation');
    return factor && factor.measure.kind === 'measured' ? factor.measure.value : null;
  };
  /* Only when no activity leads: a stated lead ("a family ski week") decides the primaries, and the kind of trip ranks within it. */
  const conceptLed = !profile.leadStated && profile.concept.length > 0 && ranked.slice(0, 40).some((candidate) => (candidate.factors.find((entry) => entry.id === 'vacation')?.weight ?? 0) >= 0.1);
  const conceptOk = (candidate: ScoredDestination) => !conceptLed || (vacationOf(candidate) ?? 1) >= VACATION_FLOOR;
  const conceptCount = conceptLed ? ranked.slice(0, 60).filter(conceptOk).length : 0;
  const servesLead = ranked.filter(leadOk);
  const top = (servesLead[0] ?? ranked[0])?.score ?? 0;
  const floor = Math.max(FLOOR_ABSOLUTE, top - FLOOR_GAP);
  /*
   * Lead-serving places are judged against each other, not against the best
   * place that ignores the lead: a safari at 0.62 outranks a lake district at
   * 0.80 for someone who said the trip must be a safari.
   */
  const pool = [
    ...servesLead.filter((candidate) => candidate.score >= floor).slice(0, 60),
    ...ranked.filter((candidate) => !leadOk(candidate) && candidate.score >= floor).slice(0, 30),
  ];
  /* Named things come in even when the wider interest would have left them under the bar. */
  if (named) for (const candidate of ranked.filter(about).slice(0, 20)) if (candidate.score >= STRETCH_FLOOR && !pool.includes(candidate)) pool.push(candidate);
  /*
   * The gap keeps a much weaker place from getting in for being different; it
   * must not empty a list. When fewer places clear it than the list holds, the
   * next best above the absolute floor fill in, in rank order.
   */
  const distinct = (list: readonly ScoredDestination[]) => {
    const kept: ScoredDestination[] = [];
    for (const candidate of list) if (!kept.some((other) => overlap(candidate.destination, other.destination) >= 1)) kept.push(candidate);
    return kept.length;
  };
  for (const candidate of ranked) {
    if (pool.length >= size + alternates && distinct(pool) >= size + alternates) break;
    if (pool.length >= 120) break;
    if (candidate.score >= FLOOR_ABSOLUTE && !pool.includes(candidate)) pool.push(candidate);
  }
  /*
   * Nothing clears the bar. An empty page helps nobody who asked a hard
   * question ("a beach in Europe in April"); the closest answers do, as long as
   * the page says plainly that they are a stretch and what holds them back.
   */
  let stretched = false;
  if (pool.length === 0) {
    for (const candidate of ranked) {
      if (candidate.score < STRETCH_FLOOR || pool.length >= 30) break;
      pool.push(candidate);
    }
    stretched = pool.length > 0;
  }
  const chosen: ScoredDestination[] = [];
  let remaining = [...pool];
  while (chosen.length < size + alternates && remaining.length > 0) {
    /*
     * The same ground is never offered twice: once a place is chosen, whatever
     * contains it or lies inside it leaves the pool. This is not diversity
     * (which trades relevance for difference) — it is not repeating an answer.
     */
    remaining = remaining.filter((candidate) => !chosen.some((picked) => overlap(candidate.destination, picked.destination) >= 1));
    if (remaining.length === 0) break;
    /* Primaries come from the places that serve the lead while any are left. */
    let eligible = chosen.length < size && remaining.some(leadOk) ? remaining.filter(leadOk) : remaining;
    /* Alternates too, when there are enough that fit: an alternate is still an answer to the same trip. */
    const conceptSlots = conceptCount >= size + alternates ? size + alternates : size;
    if (chosen.length < conceptSlots && conceptCount >= size && eligible.some(conceptOk)) eligible = eligible.filter(conceptOk);
    if (named && chosen.length < size && remaining.some(about)) eligible = remaining.filter(about);
    /* Nothing left serves the lead: the closest to it comes next, and being different is no qualification. */
    if (chosen.length < size && profile.leadStated && !remaining.some(leadOk)) {
      const closest = Math.max(...remaining.map((candidate) => candidate.interestFit[0]?.value ?? 0));
      eligible = remaining.filter((candidate) => (candidate.interestFit[0]?.value ?? 0) >= closest - 0.1);
    }
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
    ? ranked
        .filter((candidate) => !chosen.includes(candidate) && candidate.score >= lastPick.score - 0.01 && !chosen.some((picked) => overlap(candidate.destination, picked.destination) >= 1))
        .slice(0, 3)
    : [];
  const leadShort = profile.leadStated ? Math.max(0, size - picks.filter(leadOk).length) : 0;
  return { picks, alternates: stretched ? [] : chosen.slice(size), lambda, closeCalls: stretched ? [] : closeCalls, leadShort, stretched };
}
