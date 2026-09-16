import { TRAVEL_MODE_LABELS, type TravelMode } from './vocabulary';

/**
 * V12.1 §9 — WHAT THE DEPLOYED PROVIDERS CAN DO, ASKED IN ONE PLACE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * "Valhalla supports drive", "openrouteservice is global", "Google Routes can do
 * transit but we may not store it" are three facts scattered across three
 * adapters, one `.mjs` registry and several comments. Nothing could answer the
 * one question readiness actually needs:
 *
 *     Could anything in this deployment have timed a ferry between these two
 *     points — and if not, is that because no provider does ferries at all, or
 *     because this one's tiles stop at the coast?
 *
 * Those are different answers with different consequences. `no_provider` is a
 * permanent gap in Sidequest that a traveller can do nothing about and must
 * never be shown as a task (V11 §`owner`). `outside_coverage` is a deployment
 * fact. Neither is "there is no ferry".
 *
 * ── THE MEASUREMENT THAT MADE THIS URGENT ───────────────────────────────────
 *
 * Probed in this pass: the deployed Valhalla's tile build is **Iceland**.
 * Tokyo→Kyoto, Paris→Paris, Athens→Mykonos and Canmore→Lake Louise all return
 * `error_code 171`. The capability registry reported `routing.drive: available`
 * for every one of them, because it reads the environment and the environment
 * says a router is configured. A registry that cannot express "configured and
 * useless here" is how a Rockies build reported one measured leg in twenty-seven
 * with nothing upstream noticing.
 *
 * So coverage is part of a capability, not a footnote about one.
 *
 * Pure. This module holds no environment, makes no request, and knows no
 * provider by name — the deployment builds the entries and hands them in.
 */

export interface CapabilityBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Where a provider can answer.
 *
 * `global` is a claim about the provider's graph, not about its quota.
 * `declared` carries boxes an operator stated. `unknown` is the honest state for
 * a router whose coverage nobody declared — and it must behave as "might work",
 * never as "does not", because refusing to ask would turn our ignorance into the
 * world's.
 */
export type CapabilityCoverage =
  | { kind: 'global' }
  | { kind: 'declared'; boxes: readonly CapabilityBox[]; label: string }
  | { kind: 'unknown' };

export interface ProviderCapability {
  provider: string;
  mode: TravelMode;
  coverage: CapabilityCoverage;
  /** Can it return a journey time at all? */
  supportsDuration: boolean;
  /** Can it return the shape of the route, for the map? */
  supportsShape: boolean;
  /** Can it return published departures rather than a duration? */
  supportsTimetable: boolean;
  /** Can it answer for a date in the future, rather than for now? */
  supportsFutureDate: boolean;
  /** Can it say how often the service runs? */
  supportsFrequency: boolean;
  /**
   * Whether an answer from this provider may be *kept*.
   *
   * Google Routes is the reason this field exists. It genuinely supports
   * transit, with real timetables, and `BLOCKER-google-terms.md` finds no clause
   * permitting Sidequest to persist its durations or polylines. A Journey is
   * stored on `itinerary.package` and outlives its request by weeks, so a
   * provider that cannot be persisted cannot supply journey evidence however
   * good its answer is. A capability that is `false` here is reported as
   * unusable rather than as absent, because the distinction is real and an
   * operator who has settled the terms question can flip it.
   */
  persistable: boolean;
}

export interface MobilityCapabilities {
  entries: readonly ProviderCapability[];
}

export const EMPTY_MOBILITY_CAPABILITIES: MobilityCapabilities = { entries: [] };

function covers(coverage: CapabilityCoverage, point: { lat: number; lng: number } | undefined): boolean {
  if (!point) return true;
  switch (coverage.kind) {
    case 'global':
      return true;
    case 'unknown':
      /* Nobody declared it, so nobody may rule it out. The request is worth making. */
      return true;
    case 'declared':
      return coverage.boxes.some((box) => point.lat >= box.south && point.lat <= box.north && point.lng >= box.west && point.lng <= box.east);
  }
}

/**
 * Whether anything here could time this mode on this ground.
 *
 * Three answers, in the order a caller cares about them.
 */
export type MeasurementAvailability =
  /** A provider does this mode and reaches this ground. */
  | 'measurable'
  /** A provider does this mode; its coverage stops short of here. */
  | 'outside_coverage'
  /** A provider does this mode and its answers may not be kept. */
  | 'unusable_terms'
  /** Nothing in this deployment measures this mode anywhere. */
  | 'no_provider';

export function measurementAvailability(capabilities: MobilityCapabilities, mode: TravelMode, where?: { lat: number; lng: number } | undefined): MeasurementAvailability {
  const forMode = capabilities.entries.filter((entry) => entry.mode === mode && entry.supportsDuration);
  if (forMode.length === 0) return 'no_provider';
  const usable = forMode.filter((entry) => entry.persistable);
  if (usable.length === 0) return 'unusable_terms';
  return usable.some((entry) => covers(entry.coverage, where)) ? 'measurable' : 'outside_coverage';
}

/** Whether anything here could read a timetable for this mode. */
export function timetableAvailability(capabilities: MobilityCapabilities, mode: TravelMode, where?: { lat: number; lng: number } | undefined): MeasurementAvailability {
  const forMode = capabilities.entries.filter((entry) => entry.mode === mode && entry.supportsTimetable);
  if (forMode.length === 0) return 'no_provider';
  const usable = forMode.filter((entry) => entry.persistable);
  if (usable.length === 0) return 'unusable_terms';
  return usable.some((entry) => covers(entry.coverage, where)) ? 'measurable' : 'outside_coverage';
}

/** Every mode this deployment can time anywhere. Used by the doctor and by the audit, never by a renderer. */
export function measurableModes(capabilities: MobilityCapabilities): TravelMode[] {
  const seen = new Set<TravelMode>();
  for (const entry of capabilities.entries) {
    if (entry.supportsDuration && entry.persistable) seen.add(entry.mode);
  }
  return [...seen].sort();
}

/**
 * One sentence about why a mode could not be timed, addressed to the operator
 * rather than to the traveller.
 *
 * Kept on the Journey's disclosure and in the print appendix. §19 forbids any
 * of this reaching a headline, which is why it returns operator language
 * plainly rather than trying to be gentle about it.
 */
export function unavailabilityNote(availability: MeasurementAvailability, mode: TravelMode): string | null {
  const label = TRAVEL_MODE_LABELS[mode].toLowerCase();
  switch (availability) {
    case 'measurable':
      return null;
    case 'outside_coverage':
      return `A router that handles ${label} is configured, but its coverage does not reach this ground.`;
    case 'unusable_terms':
      return `A provider can answer for ${label}, and its terms do not allow Sidequest to keep the answer, so nothing is stored.`;
    case 'no_provider':
      return `No provider configured in this deployment measures ${label}.`;
  }
}
