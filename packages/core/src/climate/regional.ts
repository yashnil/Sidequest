import type { ClimateNormal, ClimateProfile } from '../schemas/climate';
import type { GeoBounds } from '../schemas/geography';
import { scaleRank, type GeographicScale } from '../destinations/semantics';

/**
 * V8.1 — A REGION HAS SEVERAL CLIMATES; ONE COORDINATE IS NOT ITS SEASON.
 *
 * "Tell me when it is best" for a mountain region used to read the normals of
 * whatever single point the resolver happened to return — for "the Canadian
 * Rockies" a business in central Calgary. A `ClimateProfile` is honest about
 * this: it describes one point and says so on its `coordinates` field. So a
 * destination whose evidence is a *box* is sampled at several points inside
 * that box and the months are compared on the mean, with the spread between
 * the points reported as a sentence the traveller can read rather than hidden
 * in the average.
 *
 * Rules:
 * - Every sample point is derived from a published or evidence-derived box;
 *   nothing here invents a coordinate for a place with no extent.
 * - At most three points. Climate normals are a provider call each; a region
 *   the size of a continent is still three points, and the sentence says the
 *   comparison is coarse.
 * - Below regional scale the centre alone is the right sample, and no
 *   sentence is written: there is nothing to hedge.
 */

export interface RegionalSamplePoint {
  lat: number;
  lng: number;
  /** Where in the box this sits, for logs and captions: "centre", "north-west third"… */
  label: string;
}

export const MAX_REGIONAL_SAMPLES = 3;

/** How far in from the box edge the two outer samples sit: a quarter of the long axis from each end. */
const OUTER_FRACTION = 0.25;

function regionalScale(scale: GeographicScale): boolean {
  return scaleRank(scale) >= scaleRank('subregion');
}

/**
 * The points to read climate normals at.
 *
 * The centre always; for a regional-scale destination with a box, two more at
 * a quarter and three-quarters of the way along the box's longer axis, so a
 * long range or a coast is read at both ends rather than at its middle.
 */
export function regionalSamplePoints(input: { center: { lat: number; lng: number }; bounds?: GeoBounds | null | undefined; scale: GeographicScale }): RegionalSamplePoint[] {
  const centre: RegionalSamplePoint = { lat: input.center.lat, lng: input.center.lng, label: 'centre' };
  const b = input.bounds;
  if (!b || !regionalScale(input.scale)) return [centre];
  const latSpan = b.northEast.lat - b.southWest.lat;
  const lngSpan = b.northEast.lng - b.southWest.lng;
  if (!(latSpan > 0) || !(lngSpan > 0)) return [centre];
  const midLat = (b.northEast.lat + b.southWest.lat) / 2;
  const midLng = (b.northEast.lng + b.southWest.lng) / 2;
  /* Compare the axes in kilometres, not degrees: a degree of longitude shrinks towards the poles. */
  const lngSpanKm = lngSpan * 111 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const latSpanKm = latSpan * 111;
  const alongLat = latSpanKm >= lngSpanKm;
  const first: RegionalSamplePoint = alongLat
    ? { lat: b.southWest.lat + latSpan * OUTER_FRACTION, lng: midLng, label: 'southern part' }
    : { lat: midLat, lng: b.southWest.lng + lngSpan * OUTER_FRACTION, label: 'western part' };
  const second: RegionalSamplePoint = alongLat
    ? { lat: b.southWest.lat + latSpan * (1 - OUTER_FRACTION), lng: midLng, label: 'northern part' }
    : { lat: midLat, lng: b.southWest.lng + lngSpan * (1 - OUTER_FRACTION), label: 'eastern part' };
  return [centre, first, second].slice(0, MAX_REGIONAL_SAMPLES);
}

export interface ClimateSpread {
  /** The largest difference in typical daily high between any two sample points, in any month. */
  maxHighDeltaC: number;
  maxLowDeltaC: number;
  maxPrecipDeltaMm: number;
}

export interface MergedClimate {
  profile: ClimateProfile;
  spread: ClimateSpread;
  sampled: number;
}

const NUMERIC_NORMALS = ['precipitationMm', 'wetDays', 'snowDays', 'daylightHours', 'hotDays', 'freezeDays'] as const;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * One profile from several: the month-wise mean of every normal, and the
 * spread between the points so the caller can say how much the average hides.
 * The result's `coordinates` are the first point's — it is still a profile
 * about somewhere — and the caller is expected to describe the sampling.
 */
export function mergeClimateProfiles(profiles: readonly ClimateProfile[]): MergedClimate {
  if (profiles.length === 0) throw new Error('mergeClimateProfiles needs at least one profile');
  const first = profiles[0]!;
  if (profiles.length === 1) return { profile: first, spread: { maxHighDeltaC: 0, maxLowDeltaC: 0, maxPrecipDeltaMm: 0 }, sampled: 1 };

  let maxHighDeltaC = 0;
  let maxLowDeltaC = 0;
  let maxPrecipDeltaMm = 0;
  const months: ClimateNormal[] = [];
  for (let index = 0; index < 12; index += 1) {
    const normals = profiles.map((profile) => profile.months.find((m) => m.month === index + 1) ?? profile.months[index]!);
    const highs = normals.map((n) => n.temperature.high);
    const lows = normals.map((n) => n.temperature.low);
    const precip = normals.map((n) => n.precipitationMm);
    maxHighDeltaC = Math.max(maxHighDeltaC, Math.max(...highs) - Math.min(...highs));
    maxLowDeltaC = Math.max(maxLowDeltaC, Math.max(...lows) - Math.min(...lows));
    maxPrecipDeltaMm = Math.max(maxPrecipDeltaMm, Math.max(...precip) - Math.min(...precip));
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const merged: ClimateNormal = {
      month: index + 1,
      temperature: { low: round1(mean(lows)), high: round1(mean(highs)) },
      precipitationMm: Math.round(mean(precip)),
      wetDays: round1(mean(normals.map((n) => n.wetDays))),
      snowDays: round1(mean(normals.map((n) => n.snowDays))),
      daylightHours: round1(mean(normals.map((n) => n.daylightHours))),
      hotDays: round1(mean(normals.map((n) => n.hotDays))),
      freezeDays: round1(mean(normals.map((n) => n.freezeDays))),
    };
    for (const key of NUMERIC_NORMALS) {
      /* Bounds the schema enforces: days in a month never exceed 31, hours 24. */
      if (key === 'daylightHours') merged[key] = Math.min(24, Math.max(0, merged[key]));
      else if (key !== 'precipitationMm') merged[key] = Math.min(31, Math.max(0, merged[key]));
    }
    months.push(merged);
  }
  const profile: ClimateProfile = {
    ...first,
    months,
    sampleYearFrom: Math.min(...profiles.map((p) => p.sampleYearFrom)),
    sampleYearTo: Math.max(...profiles.map((p) => p.sampleYearTo)),
    retrievedAt: profiles.map((p) => p.retrievedAt).sort().at(-1) ?? first.retrievedAt,
  };
  return { profile, spread: { maxHighDeltaC: round1(maxHighDeltaC), maxLowDeltaC: round1(maxLowDeltaC), maxPrecipDeltaMm: Math.round(maxPrecipDeltaMm) }, sampled: profiles.length };
}

const SCALE_WORD: Partial<Record<GeographicScale, string>> = {
  subregion: 'the region',
  region: 'the region',
  country: 'an area the size of a country',
  continental: 'an area spanning several countries',
};

/**
 * The sentence that travels with a regional comparison. Null when there is
 * nothing to hedge: one point for a place that is one place.
 */
export function regionalUncertaintyNote(spread: ClimateSpread, sampled: number, scale: GeographicScale): string | null {
  if (sampled <= 1 && !regionalScale(scale)) return null;
  const where = SCALE_WORD[scale] ?? 'the region';
  if (sampled <= 1) {
    return `Compared at one point only, although this is ${where}: conditions elsewhere in it will differ, especially with altitude.`;
  }
  const differences: string[] = [];
  if (spread.maxHighDeltaC >= 2) differences.push(`typical highs differ by up to ${Math.round(spread.maxHighDeltaC)}°C between them`);
  if (spread.maxPrecipDeltaMm >= 20) differences.push(`monthly rain by up to ${Math.round(spread.maxPrecipDeltaMm)} mm`);
  const tail = differences.length > 0 ? `; ${differences.join(', and ')}, so conditions vary by valley and altitude.` : '; they agree closely, but a valley or a summit can still differ.';
  const coarse = scale === 'country' || scale === 'continental' ? ' Three points is a coarse read of somewhere this large.' : '';
  return `Compared ${sampled} points across ${where}${tail}${coarse}`;
}
