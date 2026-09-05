import { EXPANSION_CEILING_MINUTES, REGIONAL_EXPANSIONS, type QuestionnaireAnswers, type RegionalExpansion } from '@sidequest/core';

/**
 * CONTRADICTORY MOBILITY ANSWERS ARE A QUESTION, NEVER A SILENT CLAMP.
 *
 * A live Iceland trip carried "up to 5 hr at the wheel a day" beside "nothing
 * further than about an hour from base". The profile maths takes the stricter
 * of the two (`effectiveDetourMinutes` is a `min`), so the board quietly marked
 * the destination's headline waterfalls and glacier "Probably skip — past how
 * far you said you would go". Neither answer is wrong; together they cannot
 * both bind, and the traveller is the only one entitled to say which they meant.
 *
 * Fires only when the gap is unmistakable: the stated daily wheel time has to
 * exceed a full out-and-back to the range limit by more than an hour.
 */
const RECONCILE_SLACK_MINUTES = 60;

export interface MobilityReconciliation {
  wheelMinutes: number;
  rangeMinutes: number;
  widenedDetourMinutes: number;
  widenedExpansion: RegionalExpansion;
}

export function mobilityReconciliation(answers: QuestionnaireAnswers): MobilityReconciliation | null {
  if (!answers.willDrive) return null;
  if (answers.detourToleranceMinutes <= 0) return null;
  const rangeMinutes = Math.min(answers.detourToleranceMinutes, EXPANSION_CEILING_MINUTES[answers.regionalExpansion]);
  if (answers.maxDailyTravelMinutes <= rangeMinutes * 2 + RECONCILE_SLACK_MINUTES) return null;

  const halfDay = Math.floor(answers.maxDailyTravelMinutes / 2 / 15) * 15;
  const widenedDetourMinutes = Math.min(180, Math.max(halfDay, answers.detourToleranceMinutes));
  if (widenedDetourMinutes <= rangeMinutes) return null;
  const widenedExpansion = REGIONAL_EXPANSIONS.find((value) => EXPANSION_CEILING_MINUTES[value] >= widenedDetourMinutes) ?? 'best_regional';

  return { wheelMinutes: answers.maxDailyTravelMinutes, rangeMinutes, widenedDetourMinutes, widenedExpansion };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
