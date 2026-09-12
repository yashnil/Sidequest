import 'server-only';
import { GEOGRAPHIC_SCALES, mergeClimateProfiles, regionalSamplePoints, regionalUncertaintyNote, type ClimateProfile, type ClimateUnavailableReason, type GeoBounds, type GeographicScale } from '@sidequest/core';
import { climateWithReason } from '../destinations/preflight';

/**
 * V8.1 — CLIMATE FOR A DESTINATION THAT IS AN AREA, NOT A POINT.
 *
 * One `climateWithReason` per sample point (each cached like every other
 * climate lookup), the answers merged month by month, and the spread between
 * them turned into a sentence. A point that does not answer is dropped, not
 * fatal: two points are a better read than none. When no point answers, the
 * reason class of the first failure comes back, exactly as the single-point
 * lookup reported it.
 */
export interface RegionalClimate {
  profile: ClimateProfile | null;
  reason: ClimateUnavailableReason | null;
  /** How many points actually answered. */
  sampled: number;
  /** The traveller sentence about what the average hides, or null when there is nothing to hedge. */
  note: string | null;
}

export function geographicScaleOf(value: string | null | undefined): GeographicScale | null {
  return value && (GEOGRAPHIC_SCALES as readonly string[]).includes(value) ? (value as GeographicScale) : null;
}

export async function regionalClimate(
  input: { center: { lat: number; lng: number }; bounds?: GeoBounds | null | undefined; scale: GeographicScale | null | undefined },
  now: Date,
  lookup: (center: { lat: number; lng: number }, now: Date) => ReturnType<typeof climateWithReason> = climateWithReason,
): Promise<RegionalClimate> {
  const scale: GeographicScale = input.scale ?? 'settlement';
  const points = regionalSamplePoints({ center: input.center, bounds: input.bounds ?? null, scale });
  const profiles: ClimateProfile[] = [];
  let reason: ClimateUnavailableReason | null = null;
  for (const point of points) {
    const answer = await lookup({ lat: point.lat, lng: point.lng }, now).catch(() => ({ profile: null, reason: 'provider_unavailable' as const }));
    if (answer.profile) profiles.push(answer.profile);
    else if (!reason) reason = answer.reason;
  }
  if (profiles.length === 0) return { profile: null, reason: reason ?? 'provider_unavailable', sampled: 0, note: null };
  const merged = mergeClimateProfiles(profiles);
  return { profile: merged.profile, reason: null, sampled: merged.sampled, note: regionalUncertaintyNote(merged.spread, merged.sampled, scale) };
}
