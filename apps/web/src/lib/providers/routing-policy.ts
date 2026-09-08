import type { CapabilityRegistry } from './capabilities.mjs';
import { trafficIsMeaningful } from './google-routes';

/**
 * WHICH PROVIDER TIMES WHICH LEG.
 *
 * Valhalla is the controlled backbone for road modes. Google Routes is used
 * only for what Valhalla cannot give here: timetabled transit when no transit
 * tiles are configured, traffic for a near-term high-value drive, or road
 * routing when Valhalla is not configured at all. Air, water and guided
 * transfers are never road-routed.
 */
export const REQUESTED_MODES = ['drive', 'walk', 'transit', 'bicycle', 'two_wheeler', 'flight', 'boat', 'ferry', 'private_transfer', 'guide_transfer', 'lodge_transfer'] as const;
export type RequestedMode = (typeof REQUESTED_MODES)[number];

export type RouteProviderChoice = 'valhalla' | 'valhalla-multimodal' | 'google-routes' | 'fixture' | 'schedule_or_estimate' | 'none';

export interface RoutingDecision {
  provider: RouteProviderChoice;
  traffic: boolean;
  wantsGeometry: boolean;
  reason: string;
}

export function draftHintToRequestedMode(hint: string | undefined, fallback: RequestedMode = 'drive'): RequestedMode {
  switch (hint) {
    case 'walk':
      return 'walk';
    case 'metro':
    case 'rail':
    case 'bus':
      return 'transit';
    case 'car':
    case 'four_wheel_drive':
      return 'drive';
    case 'ferry':
      return 'ferry';
    case 'boat':
      return 'boat';
    case 'flight':
      return 'flight';
    case 'private_transfer':
      return 'private_transfer';
    case 'guide_or_lodge_transfer':
      return 'guide_transfer';
    /* Nobody routes a horse. It is a guided transfer for policy, and unmeasured for timing. */
    case 'horse':
      return 'guide_transfer';
    default:
      return fallback;
  }
}

export function decideRouting(input: {
  mode: RequestedMode;
  registry: CapabilityRegistry;
  departAt?: Date | null;
  now: Date;
  highValue?: boolean;
  needGeometry?: boolean;
}): RoutingDecision {
  const { registry } = input;
  const drive = registry.byId['routing.drive'];
  const walk = registry.byId['routing.walk'];
  const transit = registry.byId['routing.transit'];
  const traffic = registry.byId['routing.traffic'];
  const bicycle = registry.byId['routing.bicycle'];
  const fixture = Boolean(drive?.fixture);
  const nonRoad: RequestedMode[] = ['flight', 'boat', 'ferry', 'private_transfer', 'guide_transfer', 'lodge_transfer'];
  if (nonRoad.includes(input.mode)) return { provider: 'schedule_or_estimate', traffic: false, wantsGeometry: false, reason: `${input.mode.replace(/_/g, ' ')} is not a road question; it is timed from a schedule or estimated.` };
  if (fixture) return { provider: 'fixture', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Fixture routing.' };

  if (input.mode === 'transit') {
    if (transit?.provider === 'valhalla-multimodal') return { provider: 'valhalla-multimodal', traffic: false, wantsGeometry: false, reason: 'Transit tiles are configured on Valhalla.' };
    if (transit?.provider === 'google-routes') return { provider: 'google-routes', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Google Routes carries timetabled transit; Valhalla has no transit tiles here.' };
    return { provider: 'schedule_or_estimate', traffic: false, wantsGeometry: false, reason: 'No transit provider; the journey stays an unverified schedule.' };
  }
  if (input.mode === 'walk') {
    if (walk?.provider === 'valhalla') return { provider: 'valhalla', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Valhalla pedestrian.' };
    if (walk?.provider === 'google-routes') return { provider: 'google-routes', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Google Routes WALK; Valhalla is not configured.' };
    return { provider: 'none', traffic: false, wantsGeometry: false, reason: 'No walking router configured.' };
  }
  if (input.mode === 'bicycle' || input.mode === 'two_wheeler') {
    if (bicycle?.provider === 'valhalla') return { provider: 'valhalla', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Valhalla bicycle.' };
    if (bicycle?.provider === 'google-routes') return { provider: 'google-routes', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Google Routes BICYCLE (preview).' };
    return { provider: 'none', traffic: false, wantsGeometry: false, reason: 'No cycle router configured.' };
  }
  // drive
  const trafficWanted = Boolean(input.highValue) && Boolean(traffic?.configured) && trafficIsMeaningful(input.departAt ?? null, input.now);
  if (trafficWanted) return { provider: 'google-routes', traffic: true, wantsGeometry: Boolean(input.needGeometry), reason: 'A high-value drive inside the traffic horizon; Google Routes TRAFFIC_AWARE, static figure kept alongside.' };
  if (drive?.provider === 'valhalla') return { provider: 'valhalla', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Valhalla is the driving backbone.' };
  if (drive?.provider === 'google-routes') return { provider: 'google-routes', traffic: false, wantsGeometry: Boolean(input.needGeometry), reason: 'Google Routes DRIVE (TRAFFIC_UNAWARE); Valhalla is not configured.' };
  return { provider: 'none', traffic: false, wantsGeometry: false, reason: 'No road router configured; the leg stays unmeasured.' };
}

/** What the traveller reads under a duration. Static is never called live. */
export function durationLabel(basis: 'static' | 'traffic_aware' | 'scheduled' | 'estimated' | undefined, provenance: string): string {
  if (provenance === 'unmeasured') return 'not measured';
  switch (basis) {
    case 'traffic_aware':
      return 'with traffic for that time';
    case 'scheduled':
      return 'from a published timetable';
    case 'estimated':
      return 'estimated';
    default:
      return 'measured, no traffic';
  }
}
