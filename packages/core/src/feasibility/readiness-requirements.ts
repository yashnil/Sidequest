import type { TripArchetype } from '../schemas/itinerary';

/**
 * V11 §4 — "READY" HAS TO MEAN SOMETHING.
 *
 * The founder's Canadian Rockies trip headed itself **"Ready, with cautions"**
 * while printing, in its own words:
 *
 *   14 of 37 travel legs were measured
 *   12 named places could not be confirmed yet
 *   8 days (1, 3, 4, 6, 7, 8, 9, 10) hold travel nobody could time
 *
 * and while one of its three signature experiences — Bow Falls, the thing the
 * page said the trip was built around — had no position on the map at all.
 *
 * The mechanism was that `feasibility/report.ts` raises a *dependency* only for
 * an unmeasured **base transfer**. Both of that trip's base transfers were
 * measured (from a base placed 200 km away, but measured), so everything else
 * fell into `caution`, and `caution` reads as Ready.
 *
 * ## What this adds
 *
 * A completeness summary and, per archetype, what has to be true of it before
 * the trip may call itself Ready. It is deliberately **not** a percentage gate:
 * §4 is explicit that "optional POI placement may degrade", and a trip is not
 * unready because a museum could not be geocoded. What must hold is the
 * route-critical set — the things the shape of the trip rests on.
 *
 * Nothing here invents a requirement a trip cannot meet. An operator-led trek's
 * internal trail legs are *not* required to be road-measured, because no router
 * can measure them and demanding it would make every honest expedition unready
 * forever.
 */

export interface RouteCompleteness {
  /** Bases with a resolved position, out of all of them. */
  basesPlaced: number;
  basesTotal: number;
  /** Route-critical names (bases, gateways, route-defining stops) a provider answered usably for. */
  routeCriticalPlaced: number;
  routeCriticalTotal: number;
  /** Base-to-base transfers with a duration from a router or an operator. */
  baseTransfersTimed: number;
  baseTransfersTotal: number;
  /** Signature experiences with a resolved position. */
  signaturesPlaced: number;
  signaturesTotal: number;
  /** Any day whose stop order could not be judged, or was judged and contradicts the ground. */
  orderContradictions: number;
  /** Provider measurements refused as implausible on this build. */
  implausibleMeasurements: number;
  /** Required access modes the plan does not represent (a shuttle-only road driven to). */
  unrepresentedAccessRequirements: number;
  /** Every travel leg with a duration from any source, out of all of them. Reported, never gated on. */
  legsTimed: number;
  legsTotal: number;
}

export interface ReadinessShortfall {
  requirement: string;
  /** One sentence, traveller-safe, about what is not finished. */
  detail: string;
}

/**
 * Whether this archetype's trip is carried by a road route the traveller drives
 * themselves or is driven along. For these, an untimed base transfer is a hole
 * in the plan; for an operator-led one it is the operator's timetable.
 */
function isRoadCarried(archetype: TripArchetype | undefined): boolean {
  switch (archetype) {
    case 'road_trip':
    case 'fly_drive':
    case 'loop':
    case 'moving_route':
    case 'multi_region':
    case 'hub_and_spoke':
    case 'lodge_circuit':
      return true;
    default:
      return false;
  }
}

/**
 * What is not finished, for this archetype, out of what Ready requires.
 *
 * An empty array means every route-critical requirement is met — which is not
 * the same as "nothing is uncertain", and the caller still has its cautions.
 */
export function readinessShortfalls(input: { archetype: TripArchetype | undefined; completeness: RouteCompleteness }): ReadinessShortfall[] {
  const c = input.completeness;
  const shortfalls: ReadinessShortfall[] = [];

  const unplacedBases = c.basesTotal - c.basesPlaced;
  if (unplacedBases > 0) {
    shortfalls.push({
      requirement: 'bases_placed',
      detail: `${unplacedBases} of ${c.basesTotal} place${c.basesTotal === 1 ? '' : 's'} you sleep ${unplacedBases === 1 ? 'has' : 'have'} not been located yet, so the travel around ${unplacedBases === 1 ? 'it' : 'them'} cannot be timed.`,
    });
  }

  const unplacedCritical = c.routeCriticalTotal - c.routeCriticalPlaced - unplacedBases;
  if (unplacedCritical > 0) {
    shortfalls.push({
      requirement: 'route_critical_placed',
      detail: `${unplacedCritical} place${unplacedCritical === 1 ? '' : 's'} the route is built around ${unplacedCritical === 1 ? 'has' : 'have'} not been located yet.`,
    });
  }

  const unplacedSignatures = c.signaturesTotal - c.signaturesPlaced;
  if (unplacedSignatures > 0) {
    shortfalls.push({
      requirement: 'signatures_placed',
      /* A trip cannot be ready when the thing it says it is built around has no position. */
      detail: `${unplacedSignatures} of the ${c.signaturesTotal} experience${c.signaturesTotal === 1 ? '' : 's'} this trip is built around ${unplacedSignatures === 1 ? 'has' : 'have'} not been located yet.`,
    });
  }

  if (isRoadCarried(input.archetype)) {
    const untimedTransfers = c.baseTransfersTotal - c.baseTransfersTimed;
    if (untimedTransfers > 0) {
      shortfalls.push({
        requirement: 'base_transfers_timed',
        detail: `${untimedTransfers} of the ${c.baseTransfersTotal} move${c.baseTransfersTotal === 1 ? '' : 's'} between places you sleep ${untimedTransfers === 1 ? 'has' : 'have'} no journey time yet.`,
      });
    }
  }

  if (c.orderContradictions > 0) {
    shortfalls.push({
      requirement: 'route_order',
      detail: `${c.orderContradictions} day${c.orderContradictions === 1 ? '' : 's'} ${c.orderContradictions === 1 ? 'runs' : 'run'} its stops in an order the ground does not support.`,
    });
  }

  if (c.implausibleMeasurements > 0) {
    shortfalls.push({
      requirement: 'plausible_measurements',
      detail: `${c.implausibleMeasurements} journey time${c.implausibleMeasurements === 1 ? '' : 's'} came back in a shape Sidequest would not schedule a day from, so ${c.implausibleMeasurements === 1 ? 'it is' : 'they are'} being checked again.`,
    });
  }

  if (c.unrepresentedAccessRequirements > 0) {
    shortfalls.push({
      requirement: 'access_requirements',
      detail: `${c.unrepresentedAccessRequirements} stop${c.unrepresentedAccessRequirements === 1 ? '' : 's'} can only be reached a particular way, and the plan does not yet say how.`,
    });
  }

  return shortfalls;
}

/** A short, honest sentence about how complete the route is. Never a score. */
export function completenessSummary(c: RouteCompleteness): string {
  if (c.legsTotal === 0) return 'Nothing on this trip needs a journey time.';
  return `${c.legsTimed} of ${c.legsTotal} journeys are timed; ${c.routeCriticalPlaced} of ${c.routeCriticalTotal} of the places the route depends on are located.`;
}
