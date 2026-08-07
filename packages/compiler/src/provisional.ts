import {
  admitToBoard,
  isVisitableRole,
  planningRoleOfPlace,
  PROVISIONAL_BOARD_VERSION,
  type PendingFact,
  type PlanningRole,
  type ProvisionalBoard,
  type ProvisionalCard,
  type TravelerProfile,
} from '@sidequest/core';
import type { DiscoveredCandidate } from './providers';
import { assignToClusters } from './routing';
import type { BaseCandidate } from '@sidequest/core';
import { classifySourceCategory } from './backbone/taxonomy';

/**
 * THE BOARD AT THE CUT.
 *
 * Called once, from one place: immediately after `discovering_food` and before
 * `enriching_priority_candidates`. Everything above that line is deterministic
 * or map-derived; `discovering_sources` below it is the first call anybody pays
 * for. So this is the last moment a board can be shown having spent nothing, and
 * the last moment at which nothing on it has been verified.
 *
 * Pure and synchronous. A compilation must not become slower, or able to fail,
 * because somebody is watching it.
 *
 * ---
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: **no `Place` crosses this boundary.**
 *
 * It would be far easier to hand out the `Place` objects that are already in
 * scope. It would also be wrong, and not only for the obvious reason. A `Place`
 * built by the inventory carries a set of *defensible defaults* that are
 * indistinguishable from facts once they are on a card:
 *
 * | Field | Value at the cut | What a card would claim |
 * | --- | --- | --- |
 * | `travelFromBase` | `{0, 0}` | it is next door |
 * | `seasonalAccess.openMonths` | `[1…12]` | it is open all year |
 * | `access.roadSurface` | `'paved'` | the road is sealed |
 * | `access.remoteNoServices` | `false` | there is fuel nearby |
 * | `source.confidence` | `0.7` | somebody measured our confidence |
 * | `hiddenGemScore` | `1 − popularity` | two independent scores, from one input |
 *
 * Not one of those was measured. The zero is the dangerous one — every
 * comparison against it passes, so a day built from it satisfies every drive
 * limit and every daylight check silently — but all six are the same mistake at
 * different volumes.
 *
 * So the projection is field by field, never a spread, and the card type has
 * nowhere to put any of them.
 */

/** Categories whose enjoyment turns on weather, season and light. */
const OUTDOOR_CATEGORIES = new Set([
  'viewpoint',
  'day_hike',
  'easy_walk',
  'lake',
  'scenic_drive',
  'geothermal',
  'hot_spring',
  'wildlife_area',
]);

export interface BuildProvisionalInput {
  boardId: string;
  tripId: string;
  jobId: string;
  scopeFingerprint: string;
  version: number;
  supersedesBoardId?: string;
  /** Post-quality, post-access-rule. The candidates that could still be planned. */
  candidates: readonly DiscoveredCandidate[];
  bases: readonly BaseCandidate[];
  profile?: TravelerProfile;
  /** Which subjects the map data already produced an opening calendar for. */
  calendarSubjectIds: ReadonlySet<string>;
  /** Confirmed free-text preferences, by the interest they map to. */
  confirmedPreferences?: ReadonlyMap<string, string>;
  counts: Omit<ProvisionalBoard['counts'], 'droppedUtilityRole'>;
  /** Injected, so two runs of one input produce byte-identical boards. */
  now: Date;
}

export function buildProvisionalBoard(input: BuildProvisionalInput): ProvisionalBoard {
  /*
   * THE SAME GATE THE FINAL BOARD USES, AND FOR THE SAME REASON.
   *
   * A card that cannot be a final attraction must never be a provisional one.
   * Two boards with different admission rules would be worse than one board
   * built late: the traveller would see an airport at the cut, watch it vanish
   * from the finished plan, and have no way to tell a fix from a loss.
   *
   * `admitToBoard` is the shared rule rather than a second copy of it. This
   * layer adds nothing to the decision — it only counts what the rule refused,
   * so a short provisional board can say why it is short.
   */
  const admissions = input.candidates.map((candidate) => ({
    candidate,
    admission: admitToBoard(candidate.place),
  }));
  const admitted = admissions
    .filter((entry) => entry.admission.admitted)
    .map((entry) => entry.candidate);

  /*
   * Areas from pure geometry. `assignToClusters` reads only coordinates and
   * needs no router — which is exactly why it can run here. What comes out is a
   * *grouping*, and it travels as a label and a count. Never as a distance:
   * the straight line that decided the grouping may not be sold as a road.
   */
  const assignment = assignToClusters({
    bases: input.bases,
    places: admitted.map((candidate) => candidate.place),
    food: [],
  });
  const areaOfPlace = new Map<string, { id: string; name: string; baseId: string; baseName: string }>();
  for (const cluster of assignment) {
    for (const placeId of cluster.placeIds) {
      areaOfPlace.set(placeId, {
        id: cluster.id,
        name: cluster.name,
        baseId: cluster.base.id,
        baseName: cluster.base.name,
      });
    }
  }

  const cards: ProvisionalCard[] = [];
  for (const candidate of admitted) {
    const place = candidate.place;
    const area = areaOfPlace.get(place.id);
    if (!area) continue;

    const taxonomy = classifySourceCategory({
      category: sourceCategoryOf(place.tags),
      path: [],
    });

    const role = roleOf(place, taxonomy.role);
    /*
     * The last line of defence, and it should never fire.
     *
     * `admitToBoard` has already refused every non-visitable role above. This
     * repeats the check against the role the card is actually about to *claim*,
     * because the two are derived differently — one from the stamped tag, one
     * from the category the card displays — and a card whose displayed role is
     * not visitable is exactly the bug, whichever derivation produced it.
     */
    if (!isVisitableRole(role)) continue;

    const matched = matchedInterests(place.interests, input.profile);
    const independentSources = new Set(candidate.providerRefs.map((ref) => ref.provider));
    cards.push({
      placeId: place.id,
      name: place.name,
      locality: place.locality,
      category: place.category,
      role,
      sourceCategory: sourceCategoryOf(place.tags),
      coordinates: place.coordinates,

      clusterId: area.id,
      clusterName: area.name,
      nearestBaseId: area.baseId,
      nearestBaseName: area.baseName,

      preliminaryFit: preliminaryFit(place.interests, input.profile),
      matchedInterests: matched,
      matchedPreferences: matched
        .map((interest) => input.confirmedPreferences?.get(interest))
        .filter((label): label is string => typeof label === 'string'),

      /*
       * Counted here, not inherited.
       *
       * `confidenceSignals` already carries `multiple_providers_agree`, earned
       * upstream by an actual cross-layer link. Reading it would have been
       * shorter and would have been a claim this file could not substantiate —
       * so the distinct provider names are counted where the card is built, and
       * the architecture guard that caught the shortcut is doing its job.
       *
       * Distinct, because a conflated record can list one dataset twice and
       * counting that as two would make conflation look like corroboration.
       */
      presence: independentSources.size >= 2 ? 'multiple_sources' : 'single_source',
      sources: [...independentSources].sort(),
      mergedFromCount: Math.max(0, independentSources.size - 1),

      group: 'nearby_side_quests',
      pending: pendingFor(place.category, input.calendarSubjectIds.has(place.id)),
      evidence: 'provisional',
    });
  }

  /*
   * Highest preliminary fit first, with the id as a stable tiebreak so the board
   * never reshuffles between two renders of the same compilation.
   */
  cards.sort(
    (a, b) => b.preliminaryFit - a.preliminaryFit || a.placeId.localeCompare(b.placeId),
  );

  const byRole = new Map<PlanningRole, number>();
  for (const card of cards) byRole.set(card.role, (byRole.get(card.role) ?? 0) + 1);

  return {
    schemaVersion: PROVISIONAL_BOARD_VERSION,
    id: input.boardId,
    tripId: input.tripId,
    jobId: input.jobId,
    scopeFingerprint: input.scopeFingerprint,
    version: input.version,
    ...(input.supersedesBoardId ? { supersedesBoardId: input.supersedesBoardId } : {}),
    cards,
    clusters: assignment
      .map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        baseId: cluster.base.id,
        baseName: cluster.base.name,
        cardCount: cards.filter((card) => card.clusterId === cluster.id).length,
      }))
      .filter((cluster) => cluster.cardCount > 0)
      .sort((a, b) => b.cardCount - a.cardCount || a.id.localeCompare(b.id)),
    counts: {
      ...input.counts,
      /*
       * Counted here rather than passed in, because this is the only layer that
       * runs the board's own admission rule and therefore the only one that
       * knows how many cards it refused as transport, services or
       * infrastructure. A short board can now say which kind of short it is.
       */
      droppedUtilityRole: admissions.filter((entry) => !entry.admission.admitted).length,
    },
    byRole: [...byRole.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
    estimated: true,
    verifiedClaimCount: 0,
    travelTimesMeasured: false,
    builtAt: input.now.toISOString(),
  };
}

/**
 * The source's own leaf category, recovered from the tag the inventory wrote.
 *
 * `tags[0]` is `` `${layerId}=${sourceCategory}` `` by construction. Read rather
 * than re-derived because the pack is not in scope here and the tag is the only
 * carrier of the source's own word for what this is.
 */
function sourceCategoryOf(tags: readonly string[]): string {
  const first = tags[0] ?? '';
  const at = first.indexOf('=');
  return at >= 0 ? first.slice(at + 1) : (first || 'unknown');
}

/**
 * The planning role, from the place itself where it carries one.
 *
 * The stamped tag wins, because it is the decision the admission layer actually
 * made — role, scope membership and eligibility resolved together — and a card
 * that displayed a *different* role from the one that admitted it would put the
 * two boards back out of step, which is the failure this file just closed.
 *
 * The taxonomy remains the fallback rather than the source of truth. A pack
 * built before the role split stored everything as `attraction`, and classifying
 * at read time is what lets those packs gain the split without being rebuilt.
 * The outdoor override applies only to that fallback: it exists because the
 * *category* sometimes knows more than the source category string does, and it
 * has no business overruling a role that was decided from both.
 */
function roleOf(place: { category: string; tags: readonly string[] }, taxonomyRole: PlanningRole): PlanningRole {
  const stamped = planningRoleOfPlace(place);
  if (stamped) return stamped;
  if (OUTDOOR_CATEGORIES.has(place.category)) return 'outdoor';
  return taxonomyRole;
}

/**
 * A preliminary fit, and nothing more.
 *
 * Arithmetic over two lists: what this place is for, and what the traveller said
 * they came for. Deliberately *not* `scorePlace` — that needs an access
 * assessment, an hours assessment and a weather assessment, none of which exist
 * at the cut, and inventing them to get a number would make the number
 * meaningless.
 *
 * The floor of 0.2 is the same rule the research prioritiser uses: a place that
 * matches nothing is not worthless, and zeroing it would make the funnel spend
 * only on confirmations of what somebody already said.
 */
function preliminaryFit(
  interests: readonly string[],
  profile: TravelerProfile | undefined,
): number {
  if (!profile) return 0.5;
  const levels = profile.interests as Partial<Record<string, string>>;
  let best = 0;
  for (const interest of interests) {
    const level = levels[interest];
    const value =
      level === 'core' ? 1 : level === 'frequent' ? 0.8 : level === 'occasional' ? 0.5 : level === 'low' ? 0.25 : 0;
    if (value > best) best = value;
  }
  return Math.max(0.2, best);
}

function matchedInterests(
  interests: readonly string[],
  profile: TravelerProfile | undefined,
): string[] {
  if (!profile) return [];
  const levels = profile.interests as Partial<Record<string, string>>;
  return interests
    .filter((interest) => {
      const level = levels[interest];
      return level === 'core' || level === 'frequent' || level === 'occasional';
    })
    .sort();
}

/**
 * What still has to be established, named rather than left blank.
 *
 * `travel_time` is unconditional — the matrix does not exist yet, and that is
 * the whole reason this board is a different type. Everything else is present
 * because nobody has looked, except opening hours, which the map data sometimes
 * carries and which is therefore the one item that can genuinely be absent from
 * this list.
 */
function pendingFor(category: string, hasMapCalendar: boolean): PendingFact[] {
  const pending: PendingFact[] = ['travel_time'];
  if (!hasMapCalendar) pending.push('opening_hours');
  pending.push('admission_cost', 'booking_requirement');
  if (OUTDOOR_CATEGORIES.has(category)) {
    pending.push('seasonal_access', 'safety_and_preparation');
  }
  return pending;
}
