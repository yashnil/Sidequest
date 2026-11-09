import type { TripComposerAnswers } from '../schemas/composer';
import type { AdvisorShortlist } from './shortlist-schema';

/**
 * WHETHER A SHORTLIST IS WEAK ENOUGH TO BE WORTH ASKING A RESEARCH MODEL.
 *
 * Pure, and deliberately conservative: a common request with three confident
 * picks costs nothing. Wider research (`apps/web/src/lib/atlas/research.ts`,
 * one bounded call that may only *propose* names) is for a thin list, a weak
 * best match, or a request whose own words the travel guides barely mention.
 * It lives here, away from the provider code, because a page render asks this
 * question and a render may never reach a provider module.
 */
export function needsResearch(answers: TripComposerAnswers, shortlist: AdvisorShortlist): boolean {
  const request = answers.discovery?.request?.trim() ?? '';
  if (request.length < 12) return false;
  /* "Somewhere like X" is answered by resemblance, which the atlas measures itself. */
  if (answers.discovery?.similarTo) return false;
  if (shortlist.picks.length < 3) return true;
  const best = shortlist.picks[0]!.score;
  if (best < 0.7) return true;
  const terms = answers.discovery?.terms ?? [];
  const nothingStructured = (answers.discovery?.focus.length ?? 0) === 0;
  return terms.length >= 2 && nothingStructured && best < 0.8;
}
