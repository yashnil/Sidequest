import {
  MUST_DO_OBSTACLE_COPY,
  MUST_DO_VERSION,
  foldForMatch,
  foldedTokens,
  mustDoDecisionFor,
  type MustDoCoverage,
  type MustDoDecision,
  type MustDoMatch,
  type MustDoObstacle,
  type MustDoRequest,
  type MustDoResolution,
  type Place,
  type ReconcileOutcome,
} from '@sidequest/core';

/**
 * LOOKING UP WHAT SOMEBODY NAMED, WITHOUT INVENTING A MATCH.
 *
 * Pure. No clock, no I/O, no provider, no model — the same inputs produce the
 * same resolutions byte for byte, which is what lets the artifact carry them.
 *
 * The hard part is not finding a match. It is *refusing* one. A permissive
 * comparison over four hundred records always finds something: "the old harbour
 * canteen" will match "Harbour Museum" at almost any similarity threshold, and
 * the traveller then arrives at a museum believing we understood them.
 *
 * So two of the three rules are plain equality over a *folded* string — the same
 * fold the destination index and the display-name resolver already match on. The
 * third, `named_within_request`, requires the candidate's **whole name** to
 * appear as a contiguous run of words inside what the traveller wrote. That is
 * already strict: "one long afternoon in a big art museum" does not contain the
 * run "harbour museum", so no multi-word name is reachable by coincidence.
 *
 * The remaining hole is a record whose entire published name *is* a category
 * noun — a place called "Museum" in a region with a dozen of them — so a
 * **one-word** name additionally has to be rare among the names this destination
 * published. That last condition is why there is no word list here. "Museum" is
 * not a distinguishing word in a capital and is a perfectly distinguishing one on
 * an island with a single museum, and the only honest way to know which is to
 * count how often it occurs in the data. A hard-coded list of generic nouns would
 * be English-only, destination-specific and wrong in both directions.
 */

/** Everything the resolver may look a request up against. */
export interface MustDoSearchSpace {
  /** Things a plan can actually use. A match here is the good outcome. */
  plannable: readonly Place[];
  /**
   * Places we found and then dropped, with the stage's own reason.
   *
   * Kept separate from `plannable` rather than merged, because "we could not
   * find it" and "we found it and it is shut while you are here" are different
   * sentences and the second is the more useful one.
   */
  removed?: readonly { place: Place; outcome: ReconcileOutcome }[];
  /** Named areas the trip includes: bases and the regional expansion's subregions. */
  areas?: readonly { id: string; name: string }[];
  /**
   * Records the ground layer read that never became candidates.
   *
   * The widest honest search space: everything a source published about this
   * area, including records the inventory refused. A match here is why "we could
   * not find it" and "we found it and could not confirm enough about it" are
   * different sentences.
   */
  groundRecords?: readonly {
    id: string;
    name: string;
    alternateNames?: readonly string[];
  }[];
  /**
   * Whether the containment layer placed a ground record positively *outside*
   * the destination.
   *
   * A callback rather than a field, and the laziness is load-bearing: answering
   * it means building the trip-scope overlay over every record in the pack, and
   * the overwhelming majority of trips name nothing at all. Called only for the
   * handful of records a request actually matched, so a compilation with no
   * must-dos does no extra work whatsoever.
   *
   * A *typed verdict*, never a distance. See `schemas/containment.ts` for why
   * that distinction is the whole contract.
   */
  isOutsideDestination?: (recordId: string) => boolean;
}

export interface ResolveMustDoInput {
  requests: readonly MustDoRequest[];
  space: MustDoSearchSpace;
  decisions?: readonly MustDoDecision[];
}

/** One thing a request can land on, with the names it answers to. */
interface Subject {
  target: MustDoMatch['target'];
  id: string;
  name: string;
  /** Folded forms: the record's own name first, then any published alias. */
  folded: string[];
}

/**
 * How the removal stage's reason reads as an obstacle a traveller can act on.
 *
 * Partial over `ReconcileOutcome` on purpose. That vocabulary has nineteen
 * members and most of them are not removals at all; the four here are the ones
 * the compiler's own removal branch can produce, and anything else falls back to
 * "we could not confirm enough about it", which is the weakest true statement
 * rather than a guess at a stronger one.
 */
const OBSTACLE_FOR_REMOVAL: Partial<Record<ReconcileOutcome, MustDoObstacle>> = {
  removed_closed: 'closed_on_your_dates',
  removed_safety_blocked: 'safety_advisory',
  removed_insufficient_support: 'nothing_confirmed_about_it',
  removed_unreachable: 'no_measurable_journey',
  removed_access_conflict: 'no_measurable_journey',
};

/**
 * How rare a word has to be, among the names this destination published, before
 * it may identify one place on its own.
 *
 * Two rather than one, so a destination that genuinely has two records for the
 * same landmark — which happens constantly across catalogues — does not lose the
 * ability to be named. Three would start admitting category nouns in a thin
 * region.
 */
const DISTINCTIVE_MAX_OCCURRENCES = 2;

function subjectsFrom(space: MustDoSearchSpace): {
  plannable: Subject[];
  removed: Map<string, ReconcileOutcome>;
  removedSubjects: Subject[];
  areas: Subject[];
  ground: Subject[];
  isOutside: (recordId: string) => boolean;
} {
  const asSubject = (
    target: MustDoMatch['target'],
    id: string,
    name: string,
    aliases: readonly string[] = [],
  ): Subject => ({
    target,
    id,
    name,
    folded: [...new Set([name, ...aliases].map(foldForMatch).filter((value) => value.length > 0))],
  });

  const removed = new Map<string, ReconcileOutcome>();
  for (const entry of space.removed ?? []) removed.set(entry.place.id, entry.outcome);

  return {
    plannable: space.plannable.map((place) => asSubject('place', place.id, place.name)),
    removed,
    removedSubjects: (space.removed ?? []).map((entry) =>
      asSubject('place', entry.place.id, entry.place.name),
    ),
    areas: (space.areas ?? []).map((area) => asSubject('area', area.id, area.name)),
    ground: (space.groundRecords ?? []).map((record) =>
      asSubject('place', record.id, record.name, record.alternateNames ?? []),
    ),
    isOutside: space.isOutsideDestination ?? (() => false),
  };
}

/**
 * Words that occur at most `DISTINCTIVE_MAX_OCCURRENCES` times across every name
 * this destination published.
 *
 * Counted over *all* subjects rather than over the ones being searched, so the
 * answer does not change depending on which list a request happens to reach
 * first. A word appearing once in the plannable set and forty times in the
 * ground is not distinctive, and a rule that only looked at the plannable set
 * would think it was.
 */
function distinctiveWords(all: readonly Subject[]): Set<string> {
  const counts = new Map<string, number>();
  for (const subject of all) {
    // Per subject, not per folded form: an alias repeating the same word does
    // not make it commoner, it makes it the same place said twice.
    const words = new Set(subject.folded.flatMap((value) => value.split(' ')));
    for (const word of words) {
      if (word.length < 2) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const distinctive = new Set<string>();
  for (const [word, count] of counts) {
    if (count <= DISTINCTIVE_MAX_OCCURRENCES) distinctive.add(word);
  }
  return distinctive;
}

/** Whether `needle` appears as a contiguous run of words inside `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

interface Hit {
  subject: Subject;
  method: MustDoMatch['method'];
}

/**
 * Every subject a request matches, by the strongest rule that fires.
 *
 * Stronger rules shadow weaker ones entirely: if anything matches by exact name,
 * nothing that merely appears inside the sentence is considered. Without that,
 * a request naming one place precisely would come back ambiguous because a
 * second, longer name happened to contain it.
 */
function hitsFor(
  request: MustDoRequest,
  subjects: readonly Subject[],
  distinctive: ReadonlySet<string>,
): Hit[] {
  const folded = foldForMatch(request.quote);
  if (folded.length === 0) return [];
  const words = foldedTokens(request.quote);

  const exact: Hit[] = [];
  const alias: Hit[] = [];
  const within: Hit[] = [];

  for (const subject of subjects) {
    const [own, ...aliases] = subject.folded;
    if (own === folded) {
      exact.push({ subject, method: 'exact_name' });
      continue;
    }
    if (aliases.includes(folded)) {
      alias.push({ subject, method: 'published_alias' });
      continue;
    }
    for (const form of subject.folded) {
      const formWords = form.split(' ').filter((word) => word.length > 0);
      if (formWords.length === 0) continue;
      /*
       * A one-word name may only match on a word that identifies one place.
       *
       * The whole-name run requirement already does most of the work: "one long
       * afternoon in a big art museum" does not contain the run "harbour
       * museum", so no two-word name can be reached by it. What it cannot stop is
       * a record whose entire published name *is* a category noun — a place
       * called "Museum" in a region with a dozen of them — and matching that
       * would hand somebody the wrong attraction with a straight face. So a
       * single word has to be rare enough here to pick out one place, counted
       * over the names this destination actually published rather than against a
       * hard-coded list of generic nouns, which would be English-only and wrong
       * in both directions.
       */
      if (formWords.length < 2 && !formWords.some((word) => distinctive.has(word))) continue;
      if (!containsRun(words, formWords)) continue;
      within.push({ subject, method: 'named_within_request' });
      break;
    }
  }

  const strongest = exact.length > 0 ? exact : alias.length > 0 ? alias : within;
  // One subject may match twice through two forms; a set of ids keeps the count
  // honest, because "two matches" and "the same place found twice" are different
  // answers and only the first is ambiguous.
  const seen = new Set<string>();
  return strongest.filter((hit) => (seen.has(hit.subject.id) ? false : (seen.add(hit.subject.id), true)));
}

function matchOf(hit: Hit): MustDoMatch {
  return { target: hit.subject.target, id: hit.subject.id, name: hit.subject.name, method: hit.method };
}

/**
 * Resolve every request against what the compilation actually holds.
 *
 * The order of the search space is the order of usefulness, and it is
 * deliberate: something a plan can use beats something we dropped, which beats
 * something we merely read about, which beats nothing. A request is never
 * reported against a weaker source when a stronger one answers it.
 */
export function resolveMustDos(input: ResolveMustDoInput): MustDoResolution[] {
  const space = subjectsFrom(input.space);
  const all = [...space.plannable, ...space.removedSubjects, ...space.areas, ...space.ground];
  const distinctive = distinctiveWords(all);

  const resolutions: MustDoResolution[] = [];

  for (const request of input.requests) {
    const decision = mustDoDecisionFor(input.decisions, request.id);

    if (decision?.kind === 'withdrawn') {
      resolutions.push({
        request,
        status: 'withdrawn',
        candidates: [],
        detail: 'You told us to leave this one out.',
      });
      continue;
    }

    if (decision?.kind === 'chose' && decision.chosenId) {
      const chosen = all.find((subject) => subject.id === decision.chosenId);
      if (chosen) {
        resolutions.push({
          request,
          status: 'replaced',
          match: { target: chosen.target, id: chosen.id, name: chosen.name, method: 'traveller_chose' },
          candidates: [],
          detail: `You picked ${chosen.name}.`,
        });
        continue;
      }
      /*
       * A choice pointing at something this build no longer holds is not a
       * choice any more, and honouring it would be planning around an identifier
       * with nothing behind it. Falling through re-resolves the request, which
       * puts the traveller back in front of the decision rather than silently
       * dropping what they asked for.
       */
    }

    if (request.kind === 'experience') {
      resolutions.push(resolveExperience(request, input.space.plannable));
      continue;
    }

    const resolution = resolveNamedSubject(request, space, distinctive);
    /*
     * A phrase nobody named is dropped rather than reported as a shortfall.
     *
     * "Somewhere we can potter about with no fixed plan" is a real sentence in
     * the must-do box and is not a request anything can look up. Reporting it as
     * "we could not find this" would put an unfixable deficit on a large share
     * of trips and teach travellers to ignore the panel. It is still resolved
     * first — if it happens to match a real place, that is a finding and it is
     * kept.
     */
    if (!request.namedExplicitly && !resolution.match && resolution.candidates.length === 0) {
      continue;
    }
    resolutions.push(resolution);
  }

  return resolutions;
}

function resolveExperience(request: MustDoRequest, plannable: readonly Place[]): MustDoResolution {
  const interest = request.interest;
  if (!interest) {
    return {
      request,
      status: 'not_found',
      candidates: [],
      detail: 'We could not tell what kind of thing this was.',
    };
  }
  const matching = plannable.filter((place) => place.interests.includes(interest));
  if (matching.length === 0) {
    return {
      request,
      status: 'not_found',
      candidates: [],
      detail: 'We found nothing here of the kind you said this trip was for.',
    };
  }
  /*
   * No `match`, deliberately, even though one could be named.
   *
   * A kind of thing is satisfied by any of its members, so singling out
   * `matching[0]` would print "Found and included — Harbour Museum" beside a
   * request that never named a museum. It would also be the record the rest of
   * the pipeline then treats as hand-picked, which is a place the traveller
   * chose by accident. What is true is the count, and that is what is said.
   */
  return {
    request,
    status: 'covered',
    candidates: matching.slice(0, 6).map((place) => ({
      target: 'place' as const,
      id: place.id,
      name: place.name,
      method: 'interest_tag' as const,
    })),
    detail: `${matching.length} ${matching.length === 1 ? 'place' : 'places'} here answer to that.`,
  };
}

function resolveNamedSubject(
  request: MustDoRequest,
  space: ReturnType<typeof subjectsFrom>,
  distinctive: ReadonlySet<string>,
): MustDoResolution {
  const usable = hitsFor(request, space.plannable, distinctive);
  if (usable.length === 1) {
    const match = matchOf(usable[0]!);
    return { request, status: 'covered', match, candidates: [], detail: `We found ${match.name}.` };
  }
  if (usable.length > 1) {
    return ambiguous(request, usable);
  }

  const areaHits = hitsFor(request, space.areas, distinctive);
  if (areaHits.length === 1) {
    const match = matchOf(areaHits[0]!);
    return {
      request,
      status: 'covered',
      match,
      candidates: [],
      detail: `${match.name} is part of this trip.`,
    };
  }
  if (areaHits.length > 1) return ambiguous(request, areaHits);

  const removedHits = hitsFor(request, space.removedSubjects, distinctive);
  if (removedHits.length >= 1) {
    const hit = removedHits[0]!;
    const outcome = space.removed.get(hit.subject.id);
    const obstacle =
      (outcome ? OBSTACLE_FOR_REMOVAL[outcome] : undefined) ?? 'nothing_confirmed_about_it';
    return {
      request,
      status: 'unusable',
      match: matchOf(hit),
      candidates: [],
      obstacle,
      detail: `We found ${hit.subject.name}. ${MUST_DO_OBSTACLE_COPY[obstacle]}`,
    };
  }

  const groundHits = hitsFor(request, space.ground, distinctive);
  const outsideHit = groundHits.find((hit) => space.isOutside(hit.subject.id));
  if (outsideHit) {
    return {
      request,
      status: 'outside_area',
      match: matchOf(outsideHit),
      candidates: [],
      detail: `${outsideHit.subject.name} is outside the area this trip covers.`,
    };
  }
  if (groundHits.length === 1) {
    const hit = groundHits[0]!;
    return {
      request,
      status: 'unusable',
      match: matchOf(hit),
      candidates: [],
      obstacle: 'nothing_confirmed_about_it',
      detail: `We found ${hit.subject.name} on the map. ${MUST_DO_OBSTACLE_COPY.nothing_confirmed_about_it}`,
    };
  }
  if (groundHits.length > 1) return ambiguous(request, groundHits);

  return {
    request,
    status: 'not_found',
    candidates: [],
    detail: 'Nothing we found here answers to that name.',
  };
}

function ambiguous(request: MustDoRequest, hits: readonly Hit[]): MustDoResolution {
  const candidates = hits.slice(0, 6).map(matchOf);
  return {
    request,
    status: 'ambiguous',
    candidates,
    detail: `${hits.length} places here answer to that name.`,
  };
}

/** The artifact-shaped value, or nothing when nobody named anything. */
export function mustDoCoverageFrom(
  resolutions: readonly MustDoResolution[],
): MustDoCoverage | undefined {
  if (resolutions.length === 0) return undefined;
  return { schemaVersion: MUST_DO_VERSION, resolutions: resolutions.slice(0, 24) };
}
