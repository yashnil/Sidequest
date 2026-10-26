import 'server-only';
import {
  buildAdvisorShortlist,
  checkPickClimate,
  destinationCatalog,
  DESTINATION_CATALOG_VERSION,
  type AdvisorPick,
  type AdvisorShortlist,
  type TripComposerAnswers,
} from '@sidequest/core';
import { climateWithReason } from './preflight';
import { isClimateEnabled } from '../providers/switches';

/**
 * THE DESTINATION ADVISOR'S ONE REACH OUTWARD: CHECKING THE WEATHER.
 *
 * Everything that decides the list is local and pure (`@sidequest/core` →
 * `advisor`). This adds the climate check of the six destinations on screen,
 * in parallel and inside a deadline, against the same cached twenty-year
 * archive the rest of the product uses. A check that does not answer in time is
 * reported as unchecked, never waited for and never turned into a verdict.
 */

/** How long the shortlist waits for the climate archive before showing what it has. */
export const CLIMATE_DEADLINE_MS = 9000;

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkClimates(picks: readonly AdvisorPick[], now: Date): Promise<{ picks: AdvisorPick[]; checked: number; verified: number }> {
  if (!isClimateEnabled() || picks.length === 0) return { picks: [...picks], checked: 0, verified: 0 };
  const results = await Promise.all(
    picks.map(async (pick) => {
      const answer = await withDeadline(climateWithReason(pick.center, now).catch(() => ({ profile: null, reason: 'provider_unavailable' as const })), CLIMATE_DEADLINE_MS);
      if (answer === 'timeout') return { ...pick, climate: { status: 'unavailable' as const, note: 'Our climate records were slow to answer, so the weather here is our own reading, unchecked.' } };
      return { ...pick, climate: checkPickClimate(pick, answer.profile, answer.profile === null) };
    }),
  );
  return {
    picks: results,
    checked: results.filter((pick) => pick.climate.status === 'verified' || pick.climate.status === 'differs').length,
    verified: results.filter((pick) => pick.climate.status === 'verified').length,
  };
}

export async function adviseFor(answers: TripComposerAnswers, now: Date, previous: AdvisorShortlist | null): Promise<AdvisorShortlist> {
  const started = Date.now();
  const shortlist = buildAdvisorShortlist({
    answers,
    catalog: destinationCatalog(),
    catalogVersion: DESTINATION_CATALOG_VERSION,
    now,
    previous,
  });
  const all = [...shortlist.picks, ...shortlist.alternates];
  const checked = await checkClimates(all, now);
  return {
    ...shortlist,
    picks: checked.picks.slice(0, shortlist.picks.length),
    alternates: checked.picks.slice(shortlist.picks.length),
    elapsedMs: Date.now() - started,
    stats: { ...shortlist.stats, climateChecked: checked.checked, climateVerified: checked.verified },
  };
}
