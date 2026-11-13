import { EXPERIENCE_LABELS } from './catalog/schema';
import type { ConceptKey } from './concept';
import { builtAround, builtAroundSentence, ownWishes, phraseFor } from './concept';
import type { Destination } from './destination';
import type { AdvisorProfile } from './profile';

/**
 * WHEN A PLACE CANNOT BE THE ANSWER TO THIS TRIP, HOWEVER WELL IT SCORES.
 *
 * A blind evaluation caught the advisor ranking a trekking region first for "a
 * nice retreat … I want to feel good … outdoors stuff" while the same card said
 * "it is built around multi-day trekking, which is not what a restful trip is
 * for". The card was right and the ranking was not: the conflict was one
 * weighted factor among twelve, and a superb mountain reading outvoted it.
 *
 * A *severe* incompatibility with the traveller's primary intent is therefore
 * not a score — it is a disqualifier from the first places on the list. The
 * place stays in the ranking and may still be shown lower, as an alternate,
 * where its card says plainly why (`advise.ts#tradeoffsFor` puts the sentence
 * first). Every disqualifier is derived from fields of the destination record
 * (what it is built around, its challenge, family and access readings) and the
 * traveller's stated profile, never from a name, and each carries the sentence
 * the card shows, so the card and the ranking read one value.
 *
 * Unknown ≠ false: a missing reading (no family score, unknown car access)
 * never disqualifies.
 */

export type PrimaryConflictCode = 'strenuous_core' | 'hard_with_children' | 'needs_a_car';

export interface PrimaryConflict {
  code: PrimaryConflictCode;
  /** The full sentence the card shows, first among its trade-offs. */
  sentence: string;
}

/** Kinds of trip whose whole point is ease: rest, wellness, a beach holiday. */
const RESTFUL: ReadonlySet<ConceptKey> = new Set(['restoration', 'wellness', 'beach_resort']);

/**
 * How much of the concept must be restful for rest to be the primary intent.
 * The owner's request reads restoration 0.41, family 0.31, nature 0.28; a
 * request that merely mentions relaxing beside an active plan ("a hiking trip,
 * relaxing evenings") reads well under this.
 */
export const RESTFUL_PRIMARY_SHARE = 0.35;

/**
 * A high-altitude, demanding place: high mountains at least this strong (0–3)
 * together with a typical day at least this hard (0 gentle … 3 expedition).
 * The same reading the group factor uses for altitude sensitivity.
 */
const ALTITUDE_MOUNTAINS = 2.5;
const ALTITUDE_TYPICAL_EFFORT = 2.5;

/**
 * Below this family reading (0–3) a place is hard going with children. Two is
 * "good with children" in the group factor; under one is the bottom third.
 */
export const CHILDREN_FAMILY_FLOOR = 1;

/**
 * Whether the traveller asked for the strenuous thing themselves: multi-day
 * trekking is one of their own wishes (`concept.ts#ownWishes` — "hut-to-hut",
 * "high and wild", or a trek named in the request), or they asked for a
 * rugged or expedition-level trip. Plain "mountains" and plain "hiking" do
 * not: there the restful reading says which version was meant.
 */
function askedForStrenuous(profile: AdvisorProfile): boolean {
  if (profile.adventure !== null && profile.adventure >= 2) return true;
  return ownWishes(profile.interests, profile.concept).has('multi_day_trekking');
}

function restfulShare(profile: Pick<AdvisorProfile, 'concept'>): number {
  return profile.concept.reduce((sum, entry) => sum + (RESTFUL.has(entry.key) ? entry.weight : 0), 0);
}

/** Rest is the traveller's primary intent: the restful kinds of trip carry at least `RESTFUL_PRIMARY_SHARE` of the concept. */
export function restfulPrimary(profile: Pick<AdvisorProfile, 'concept'>): boolean {
  return restfulShare(profile) >= RESTFUL_PRIMARY_SHARE;
}

/** The disqualifiers this place carries for this traveller, most important first. Pure. */
export function primaryConflicts(destination: Destination, profile: AdvisorProfile): PrimaryConflict[] {
  const out: PrimaryConflict[] = [];
  const restful = restfulPrimary(profile);

  /* Built around strenuous walking or high altitude, for a restful trip or with children, unless they asked for it. */
  if ((restful || profile.kids) && !askedForStrenuous(profile)) {
    const trip = restful ? phraseFor(profile.concept.filter((entry) => RESTFUL.has(entry.key))) : 'a trip with children';
    const trekking = builtAround(destination).includes('multi_day_trekking');
    const altitude = (destination.experiences.high_mountains ?? 0) >= ALTITUDE_MOUNTAINS && destination.challenge.typical >= ALTITUDE_TYPICAL_EFFORT;
    if (trekking) out.push({ code: 'strenuous_core', sentence: builtAroundSentence('multi_day_trekking', trip) });
    else if (altitude) out.push({ code: 'strenuous_core', sentence: `Its typical days are high and demanding (${EXPERIENCE_LABELS.high_mountains.toLowerCase()}), which is not what ${trip} is for.` });
  }

  if (profile.kids && destination.family !== null && destination.family < CHILDREN_FAMILY_FLOOR) {
    /* The same words `vacationFit` uses for a weak family reading, so the card never says it twice. */
    out.push({ code: 'hard_with_children', sentence: 'Not an easy place to travel with children.' });
  }

  /* Somebody who will not drive is not offered first a place that only works by car. Unknown access is not "essential". */
  if (profile.car === 'no_car' && destination.access.car === 'essential') {
    out.push({ code: 'needs_a_car', sentence: 'It really needs a car, and you would rather not drive.' });
  }
  return out;
}
