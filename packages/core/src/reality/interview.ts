import type { DestinationAssumption, DestinationQuestionContext } from '../interview/traits';
import { MODE_CONCEPT_LABELS, type ModeConcept, type TravelReality } from './schema';

/**
 * WHAT THE INTERVIEW MAY ASSUME ONCE THE REALITY IS KNOWN.
 *
 * The screening's assumption comes from the shape of the ground alone, which
 * is how a municipality typed `state` became "a car". The reality layer knows
 * the country's facts; where it has a recommendation, that recommendation is
 * the assumption, its sentence is the one the understanding screen shows, and
 * the transport question's default reads it. Where it has none, the
 * assumption is `undecided` and the interview asks rather than guesses.
 */
export type RealityMovement = DestinationAssumption['movement'] | 'rail_transfers';

export function movementFromReality(reality: TravelReality | null | undefined): RealityMovement | null {
  const rec = reality?.recommendation;
  if (!rec) return null;
  const regional = new Set<ModeConcept>(rec.regional);
  const urban = new Set<ModeConcept>(rec.urban);
  if (regional.has('guided_transfer')) return 'guided';
  if (regional.has('rental_car') || regional.has('self_drive')) return 'car';
  if (regional.has('ferry') && !regional.has('high_speed_rail') && !regional.has('intercity_train')) return 'boat';
  if (regional.has('high_speed_rail') || regional.has('intercity_train') || regional.has('private_driver') || regional.has('flight')) return 'rail_transfers';
  if (urban.size > 0) return 'transit_walk';
  return null;
}

/** The reality's sentence for the understanding screen, or null when it has nothing to stand behind. */
export function assumptionSentenceFromReality(reality: TravelReality | null | undefined, name: string): string | null {
  const rec = reality?.recommendation;
  if (!rec) return null;
  return `${rec.sentence} Sidequest will settle the details when it sees the route through ${name}.`;
}

export function withTravelReality(ctx: DestinationQuestionContext, reality: TravelReality | null): DestinationQuestionContext {
  if (!reality) return ctx;
  const movement = movementFromReality(reality);
  const understanding = [...ctx.understanding];
  if (reality.recommendation) understanding.push(reality.recommendation.sentence);
  else if (reality.destination.coverage === 'none') understanding.push('How to get around here is not something Sidequest has compiled yet, so it will say what it assumes rather than recommend.');
  /*
   * No country compiled: the shape's own assumption is all the evidence there
   * is, and it stands — as an assumption to check, which is how the screening
   * already words it. Only a compiled country with nothing to recommend leaves
   * the mode open.
   */
  if (reality.destination.coverage === 'none') return { ...ctx, understanding, reality };
  const base: DestinationAssumption = ctx.assumption ?? { bases: 'undecided', movement: 'undecided', confidence: 'low', basesConfidence: 'low', sentence: '' };
  const assumption: DestinationAssumption = reality.recommendation
    ? {
        ...base,
        movement: movement ?? base.movement,
        confidence: 'high',
        sentence: assumptionSentenceFromReality(reality, ctx.proseName) ?? base.sentence,
      }
    : {
        ...base,
        movement: 'undecided',
        confidence: 'low',
        sentence: `Sidequest is not assuming how you will get around ${ctx.proseName} yet; it will choose after it sees the route, and the first question asks what you are open to.`,
      };
  return { ...ctx, understanding, assumption, reality };
}

/** A short label for a movement, for the sketch. */
export function movementLabel(movement: RealityMovement): string {
  switch (movement) {
    case 'car':
      return MODE_CONCEPT_LABELS.rental_car;
    case 'transit_walk':
      return 'On foot and by transit';
    case 'guided':
      return MODE_CONCEPT_LABELS.guided_transfer;
    case 'boat':
      return 'Boats between islands';
    case 'rail_transfers':
      return 'Trains and hired transfers';
    case 'mixed':
      return 'A mix, decided by the route';
    default:
      return 'Not decided yet';
  }
}
