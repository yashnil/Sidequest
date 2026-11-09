import 'server-only';
import { buildAdvisorShortlist, checkPickClimate, type AdvisorPick, type AdvisorShortlist, type DestinationWorld, type TripComposerAnswers } from '@sidequest/core';
import { climateWithReason } from './preflight';
import { isClimateEnabled } from '../providers/switches';
import { advisorWorld } from '../atlas/world';
import { researchSuggestions, type ResearchOutcome } from '../atlas/research';

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

export async function checkClimates(picks: readonly AdvisorPick[], now: Date, world: DestinationWorld): Promise<{ picks: AdvisorPick[]; checked: number; verified: number }> {
  if (!isClimateEnabled() || picks.length === 0) return { picks: [...picks], checked: 0, verified: 0 };
  const results = await Promise.all(
    picks.map(async (pick) => {
      const answer = await withDeadline(climateWithReason(pick.center, now).catch(() => ({ profile: null, reason: 'provider_unavailable' as const })), CLIMATE_DEADLINE_MS);
      if (answer === 'timeout') return { ...pick, climate: { status: 'unavailable' as const, note: 'Our climate records were slow to answer, so the weather here is our own reading, unchecked.' } };
      /* The reading being checked is the world's own: an editorial high for a curated place, a 1981–2010 normal for a derived one. */
      return { ...pick, climate: checkPickClimate(pick, answer.profile, answer.profile === null, world.byId(pick.id)) };
    }),
  );
  return {
    picks: results,
    checked: results.filter((pick) => pick.climate.status === 'verified' || pick.climate.status === 'differs').length,
    verified: results.filter((pick) => pick.climate.status === 'verified').length,
  };
}

export interface AdviseOptions {
  /** Places a research model proposed for this request, already resolved to atlas ids. */
  research?: ResearchOutcome | null;
}

/**
 * The shortlist for a set of answers: the atlas narrows the world, the scorer
 * reads the candidates, and the six places on screen are checked against live
 * climate records inside a deadline. No model decides anything here; when a
 * research outcome is passed, its places are extra candidates and nothing more.
 */
export async function adviseFor(answers: TripComposerAnswers, now: Date, previous: AdvisorShortlist | null, options: AdviseOptions = {}): Promise<AdvisorShortlist> {
  const started = Date.now();
  const { world, version, degraded } = advisorWorld();
  const research = options.research && options.research.source !== 'not_needed' && options.research.source !== 'off' ? options.research : null;
  const shortlist = buildAdvisorShortlist({
    answers,
    catalog: world,
    catalogVersion: version,
    now,
    previous,
    assumptions: degraded ? ['Our world atlas could not be loaded, so this list comes from our curated destinations only.'] : [],
    research: research ? { ids: research.ids, proposed: research.proposed, note: research.note } : null,
  });
  const all = [...shortlist.picks, ...shortlist.alternates];
  const checked = await checkClimates(all, now, world);
  return {
    ...shortlist,
    picks: checked.picks.slice(0, shortlist.picks.length),
    alternates: checked.picks.slice(shortlist.picks.length),
    elapsedMs: Date.now() - started,
    stats: { ...shortlist.stats, climateChecked: checked.checked, climateVerified: checked.verified },
  };
}

/**
 * Widen a stored shortlist with a research model's suggestions, when the
 * deterministic list was weak enough to warrant asking (`needsResearch`). The
 * caller shows the deterministic list first and calls this afterwards, so a
 * slow or failed model never delays or changes what the atlas already answered.
 */
export async function widenWithResearch(answers: TripComposerAnswers, shortlist: AdvisorShortlist, now: Date, caller?: string | null): Promise<{ shortlist: AdvisorShortlist; outcome: ResearchOutcome }> {
  const { atlas } = advisorWorld();
  const outcome = await researchSuggestions({ answers, shortlist, atlas, caller });
  if (outcome.source === 'not_needed' || outcome.source === 'off') return { shortlist, outcome };
  if (outcome.ids.length === 0) {
    /* Asked and nothing usable came back: the list stands, and it says research was tried. */
    return { shortlist: { ...shortlist, stats: { ...shortlist.stats, research: { proposed: outcome.proposed, resolved: 0, shown: 0, note: outcome.note } } }, outcome };
  }
  return { shortlist: await adviseFor(answers, now, shortlist, { research: outcome }), outcome };
}
