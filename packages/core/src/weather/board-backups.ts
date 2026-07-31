import type { DiscoveryCandidate } from '../discovery/board';
import type { WeatherEvidenceKind } from '../schemas/weather';
import { isLessWeatherSensitive } from './conditions';

/**
 * WHAT TO HAVE IN RESERVE, WORKED OUT BEFORE ANYTHING IS BUILT.
 *
 * The Discovery Board already has a "Low-effort & bad-weather backups" group,
 * and it has never done this job. `groupFor` decides a card's primary group in a
 * fixed order — hidden gem, then popular, then scenic, then backup — so five of
 * the seven places that genuinely are bad-weather options never reach the backup
 * branch. Hot Creek is a hidden gem, Mono Lake is a classic, June Lake is a
 * scenic drive; all three are excellent things to do in the rain and none of
 * them appears anywhere near the group that says so.
 *
 * The obvious fix — reorder `groupFor` — is the wrong one. That ordering is an
 * editorial hierarchy about what a place fundamentally *is*, and demoting Mono
 * Lake from "must-see classic" to "backup" would be a worse board on every dry
 * day of the year. A place's primary category is not a function of this week's
 * forecast.
 *
 * So this is derived instead: a trip-specific view over the same cards, computed
 * from the same weather the planner will use, that appears only when the weather
 * makes it worth appearing. Nothing here mutates a place, changes a group, or
 * touches what the planner will select — the section is a reading of the board,
 * not a change to it.
 */

export interface BoardWeatherBackup {
  placeId: string;
  name: string;
  /** Why this one copes, in one clause. */
  why: string;
  driveMinutes: number;
  /** What its own primary group is, so the section is legible as a cross-cut. */
  category: string;
}

export interface BoardWeatherBackups {
  /**
   * Which kind of knowledge prompted this. It decides the whole register: a
   * forecast means "your dates look wet", a pattern means "this time of year
   * often is", and those are different sentences with different obligations.
   */
  evidence: Extract<WeatherEvidenceKind, 'forecast' | 'historical_pattern'>;
  /** The stops the weather is working against. Named, so the copy can be specific. */
  atRisk: { placeId: string; name: string }[];
  suggestions: BoardWeatherBackup[];
}

/**
 * How far a reserve option may be before it stops being one.
 *
 * The same reasoning as the planner's ceiling, and deliberately the same number:
 * a backup is taken on a morning somebody has already lost their plan, and
 * seventy-five minutes each way is two and a half hours of driving before
 * anything happens.
 */
export const MAX_BOARD_BACKUP_DRIVE_MINUTES = 75;

/** More than this is a list to shop from rather than an answer. */
export const MAX_BOARD_BACKUPS = 4;

export function boardWeatherBackups(
  candidates: readonly DiscoveryCandidate[],
): BoardWeatherBackups | null {
  // Only places the traveller could actually do. A blocked card is not a
  // fallback, and it is not at risk either — it is simply not on this trip.
  const workable = candidates.filter((candidate) => candidate.fit.band !== 'not_workable');

  /**
   * At risk means *no good day anywhere in the trip*, not "one of your four days
   * is wet".
   *
   * The looser reading was the first version and it flagged fourteen of twenty
   * cards on an ordinary fixture week — a section announcing that the forecast
   * is against almost everything, which is a weather report rather than advice.
   * A stop with one poor day and three workable ones is not in trouble: day
   * assignment will move it, and that is the whole point of the layer above.
   */
  const atRisk = workable.filter(
    (candidate) =>
      candidate.weather.best === 'poor' || candidate.weather.best === 'incompatible',
  );
  if (atRisk.length === 0) return null;

  // The evidence behind the *risk*, not behind the trip. A trip that straddles
  // the horizon can have its wet days on either side of it, and the sentence has
  // to match the days that prompted it.
  const evidence = atRisk.some((candidate) => candidate.weather.evidence.includes('forecast'))
    ? ('forecast' as const)
    : atRisk.some((candidate) => candidate.weather.evidence.includes('historical_pattern'))
      ? ('historical_pattern' as const)
      : null;
  if (!evidence) return null;

  const riskCodes = [
    ...new Set(atRisk.flatMap((candidate) => candidate.weather.riskReasonCodes)),
  ];
  const atRiskIds = new Set(atRisk.map((candidate) => candidate.place.id));

  const suggestions = workable
    .filter((candidate) => {
      // Never something that is itself in trouble on these dates.
      if (atRiskIds.has(candidate.place.id)) return false;
      // Reachable and open, on this traveller's dates and answers. Weather does
      // not get to relax either, here any more than in the planner.
      if (candidate.access.status === 'blocked') return false;
      if (candidate.operating.status === 'closed_throughout') return false;
      // `unknown` hours are schedulable in the main plan with a caution; a
      // fallback is offered precisely when there is no slack left to absorb a
      // locked door, so unverified hours do not qualify here either.
      if (candidate.operating.status === 'unknown') return false;
      if (candidate.driveMinutes > MAX_BOARD_BACKUP_DRIVE_MINUTES) return false;
      // And genuinely better against the thing that is going wrong — the one
      // shared rule, so a card can never offer what the planner would refuse.
      return isLessWeatherSensitive({
        profile: candidate.place.weather,
        riskReasonCodes: riskCodes,
      });
    })
    // Nearest first: a fallback's value is almost entirely in how little it
    // costs to take. `place.id` breaks ties so the section never reshuffles.
    .sort(
      (a, b) => a.driveMinutes - b.driveMinutes || a.place.id.localeCompare(b.place.id),
    )
    .slice(0, MAX_BOARD_BACKUPS)
    .map((candidate) => ({
      placeId: candidate.place.id,
      name: candidate.place.name,
      why: whyFor(candidate),
      driveMinutes: candidate.driveMinutes,
      category: candidate.group,
    }));

  return {
    evidence,
    atRisk: atRisk.map((candidate) => ({
      placeId: candidate.place.id,
      name: candidate.place.name,
    })),
    suggestions,
  };
}

function whyFor(candidate: DiscoveryCandidate): string {
  const profile = candidate.place.weather;
  if (profile.exposure === 'indoor') return 'Indoors, and open whatever the day does.';
  if (profile.exposure === 'sheltered_outdoor') {
    return 'Sheltered, and short enough to be worth swapping in.';
  }
  return 'Holds up in weather that would spoil the rest of the day.';
}
