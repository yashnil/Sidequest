import type { Itinerary, ItineraryDay } from '../schemas/itinerary';
import type { TripContract } from '../contract/trip-contract';
import { isGatewayName, isTransferName } from '../intelligence/anchor-kind';

/**
 * STRUCTURAL QUALITY METRICS — MACHINE-AUDITABLE, NEVER ONE SCORE.
 *
 * V6 §55. Every generated trip gets the same numbers, each answering one
 * question a person could check by hand. Deliberately not collapsed into a
 * single quality figure: a trip with zero locked-fact violations and eight
 * unmeasured major transfers is not "82%", it is two facts a reader needs to
 * see separately. Pure; runs on the persisted plan, the audit and the
 * contract, with no provider.
 */

export interface StructuralMetrics {
  version: 1;
  lockedFactViolations: number;
  hardConstraintViolations: number;
  unmeasuredMajorTransfers: number;
  routeDiscontinuities: number;
  timeWindowViolations: number;
  daylightViolations: number;
  partyHardFails: number;
  /** 0–1 across every scheduled activity, when a party was described; null otherwise. */
  averagePartyFit: number | null;
  minimumPartyFit: number | null;
  /** 0–1: distinct activity categories over scheduled activities, tempered by repetition. */
  activityDiversity: number;
  /** Nights with a base change. */
  hotelChurn: number;
  /** Minutes of travel per day on the ground, measured + estimated + allowance. */
  travelBurdenMinutesPerDay: number;
  /** Free minutes per day. */
  freeMinutesPerDay: number;
  /** 0–1 of named signatures present in the days. */
  signatureCoverage: number;
  /** 0–1 of days with at least two meals placed. */
  mealCoverage: number;
  /** 0–1 of booked facts honoured; null when none. */
  bookedFactPreservation: number | null;
  unverifiedCriticalDependencies: number;
  /** Transfers or gateways that reached the days as activities. Must be 0. */
  transfersAsStops: number;
  silentAnchorLoss: number;
}

export interface MetricsInput {
  itinerary: Itinerary;
  contract?: TripContract | null;
  audit?: { checks: readonly { id: string; ok: boolean; detail: string }[] } | null;
  /** Booked facts: how many the plan holds and how many it honoured. */
  booked?: { total: number; honoured: number } | null;
  /** Per-person fit per scheduled activity, when a party was described: values 0–1. */
  partyFit?: readonly number[] | null;
  silentAnchorLoss?: number;
}

const CATEGORY_FAMILIES: Record<string, string> = {
  landmark: 'sights',
  historic: 'sights',
  museum: 'culture',
  neighbourhood: 'streets',
  town: 'streets',
  market: 'food',
  food: 'food',
  nature: 'outdoors',
  hike: 'outdoors',
  viewpoint: 'outdoors',
  water: 'water',
  wildlife: 'wildlife',
  geothermal: 'water',
  scenic_drive: 'roads',
  beach: 'water',
  relaxation: 'rest',
  activity: 'activity',
  other: 'other',
};

function failed(audit: MetricsInput['audit'], id: string): boolean {
  const check = audit?.checks.find((c) => c.id === id);
  return Boolean(check && !check.ok);
}

function countFromDetail(audit: MetricsInput['audit'], id: string): number {
  const check = audit?.checks.find((c) => c.id === id);
  if (!check || check.ok) return 0;
  const named = (check.detail.match(/day \d+/gi) ?? []).length;
  return Math.max(1, named);
}

export function buildStructuralMetrics(input: MetricsInput): StructuralMetrics {
  const { itinerary } = input;
  const days = itinerary.days;
  const activities = days.flatMap((d) => d.items.filter((i) => i.kind === 'activity'));
  const anchors = itinerary.package?.anchors ?? [];
  const scheduled = anchors.filter((a) => !a.disposition.startsWith('rejected') && a.disposition !== 'unscheduled_capacity' && a.disposition !== 'folded_into_meal' && a.disposition !== 'folded_into_transfer' && a.disposition !== 'folded_into_terminal');
  const categories = scheduled.map((a) => CATEGORY_FAMILIES[a.category] ?? a.category);
  const distinct = new Set(categories).size;
  const repetition = categories.length > 0 ? Math.max(...[...new Set(categories)].map((c) => categories.filter((x) => x === c).length)) / categories.length : 0;
  const activityDiversity = categories.length === 0 ? 0 : Math.round(Math.max(0, Math.min(1, (distinct / Math.min(categories.length, 6)) * (1 - Math.max(0, repetition - 0.5)))) * 100) / 100;

  const hotelChurn = days.filter((d, i) => i > 0 && d.baseId !== days[i - 1]!.baseId).length;
  const travelPerDay = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.totals.travelMinutes, 0) / days.length) : 0;
  const freePerDay = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.totals.freeMinutes, 0) / days.length) : 0;
  const signatureCheck = input.audit?.checks.find((c) => c.id === 'signatures_present');
  const signatureCoverage = signatureCheck ? (signatureCheck.ok ? 1 : 0) : 1;
  const mealCoverage = days.length > 0 ? Math.round((days.filter((d) => d.items.filter((i) => i.kind === 'meal').length >= 2).length / days.length) * 100) / 100 : 0;
  const transfersAsStops = activities.filter((a) => isTransferName(a.title) || isGatewayName(a.title)).length;
  const partyFit = input.partyFit && input.partyFit.length > 0 ? input.partyFit : null;

  return {
    version: 1,
    lockedFactViolations: (failed(input.audit, 'locked_dates_preserved') ? 1 : 0) + (failed(input.audit, 'contract_respected') ? 1 : 0) + (failed(input.audit, 'booked_respected') ? 1 : 0),
    hardConstraintViolations: (failed(input.audit, 'drive_cap') ? 1 : 0) + countFromDetail(input.audit, 'party_hard_fails') + (failed(input.audit, 'edges_respected') ? 1 : 0),
    unmeasuredMajorTransfers: days.filter((d: ItineraryDay) => d.totals.unmeasuredMajorTransfer).length,
    routeDiscontinuities: (failed(input.audit, 'base_consistency') ? 1 : 0) + (failed(input.audit, 'base_changes_coherent') ? 1 : 0) + (failed(input.audit, 'stops_follow_transfers') ? 1 : 0),
    timeWindowViolations: countFromDetail(input.audit, 'no_overlaps') + countFromDetail(input.audit, 'no_stop_past_window') + countFromDetail(input.audit, 'time_intent_respected') + countFromDetail(input.audit, 'meals_in_window'),
    daylightViolations: countFromDetail(input.audit, 'daylight_respected'),
    partyHardFails: countFromDetail(input.audit, 'party_hard_fails'),
    averagePartyFit: partyFit ? Math.round((partyFit.reduce((a, b) => a + b, 0) / partyFit.length) * 100) / 100 : null,
    minimumPartyFit: partyFit ? Math.round(Math.min(...partyFit) * 100) / 100 : null,
    activityDiversity,
    hotelChurn,
    travelBurdenMinutesPerDay: travelPerDay,
    freeMinutesPerDay: freePerDay,
    signatureCoverage,
    mealCoverage,
    bookedFactPreservation: input.booked && input.booked.total > 0 ? Math.round((input.booked.honoured / input.booked.total) * 100) / 100 : null,
    unverifiedCriticalDependencies: (itinerary.package?.feasibility?.items ?? []).filter((i) => i.severity === 'dependency').length + itinerary.issues.filter((i) => i.code === 'gateway_unresolved').length,
    transfersAsStops,
    silentAnchorLoss: input.silentAnchorLoss ?? itinerary.package?.preservation?.silentLoss ?? 0,
  };
}
