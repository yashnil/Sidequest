import type { AdvisorShortlist } from '@sidequest/core';
import type { MediaSubject } from '@/lib/media/select';

/*
 * Kept apart from `advisor.ts` for the same reason as `advisor-images.ts`: the
 * shortlist page imports it, and a render may not reach a provider.
 */

const SETTLEMENT = /city|town|village|municipality|island_town/i;

/** Media subjects for the destinations on screen: picks first, then alternates; only entries with a Wikidata item. */
export function advisorMediaSubjects(shortlist: AdvisorShortlist): MediaSubject[] {
  return [...shortlist.picks, ...shortlist.alternates].flatMap((pick): MediaSubject[] =>
    pick.wikidataId && /^Q\d+$/.test(pick.wikidataId)
      ? [
          {
            wikidataId: pick.wikidataId,
            name: pick.name,
            center: pick.center,
            radiusKm: pick.radiusKm,
            scale: SETTLEMENT.test(String(pick.kind)) ? 'place' : 'region',
          },
        ]
      : [],
  );
}
