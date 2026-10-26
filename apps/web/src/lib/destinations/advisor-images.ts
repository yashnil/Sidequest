import type { AdvisorShortlist, ImageSubject } from '@sidequest/core';

/*
 * Kept apart from `advisor.ts` on purpose: the shortlist page imports this, and
 * a render may not reach any module that can call a provider
 * (`render-purity.architecture.test.ts`). `advisor.ts` reaches the climate
 * archive.
 */

/** Image subjects for the destinations on screen. Keyed `advisor:<id>`; only an entry with a verified Wikidata item is asked about. */
export function advisorImageSubjects(shortlist: AdvisorShortlist): ImageSubject[] {
  return [...shortlist.picks, ...shortlist.alternates].flatMap((pick): ImageSubject[] =>
    pick.wikidataId
      ? [
          {
            kind: 'destination',
            id: `advisor:${pick.id}`,
            name: pick.name,
            wikidataId: pick.wikidataId,
            coordinates: pick.center,
            hierarchy: [pick.context],
          },
        ]
      : [],
  );
}
