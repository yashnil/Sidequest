import 'server-only';
import type { CompiledRegion, ImageSubject } from '@sidequest/core';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { readProviderCache, writeProviderCache } from '@/lib/db/compiler-repository';
import { addPlaceWikidataIds } from '@/lib/db/compiled-identity-repository';
import { acceptedImagesFor, imageryCache, unresolvedImagerySubjects } from '@/lib/db/imagery-repository';
import { fixtureScan } from '@/lib/discovery-scan/preflight';
import { providerUserAgent } from '@/lib/net/user-agent';
import { linkWikidataIds, type LinkSubject } from '@/lib/providers/wikidata-link';
import { resolveImageryForSubjects } from '@/lib/providers/wikimedia';
import { compiledRegionFor, resolveTripRegion } from '@/lib/region';
import { fetchWeatherSnapshot, weatherTargetFor, type WeatherFetchOutcome, type WeatherFetchTarget } from '@/lib/weather/refresh';

/**
 * "REFRESH TRIP INFORMATION" — NEW EVIDENCE FOR AN EXISTING TRIP, NEVER A NEW PLAN.
 *
 * Improvements to how a trip's *information* is gathered (photographs keyed by
 * Wikidata item, a fresher forecast) reach a trip that was planned before them
 * only if somebody asks. This is the asking. It does three things, all of them
 * caches or evidence:
 *
 *   1. **Identities.** Places the stored scan holds without a Wikidata item are
 *      linked by name and the item's own coordinate (`wikidata-link.ts`, the
 *      rule new scans use) and the item is written onto the stored place —
 *      `addPlaceWikidataIds`, which may touch that one field and nothing else.
 *   2. **Photographs.** The existing bounded imagery pass, for the trip's places
 *      that now have an identity and that nobody has looked up yet.
 *   3. **Weather.** The existing snapshot fetch, which records its own outcome.
 *
 * The travel-intelligence snapshot needs no step: it is keyed on its inputs and
 * the rules version, and rebuilt on the next load whenever either moved.
 *
 * What it never touches: the itinerary (days, stops, times, bases, legs), the
 * base portfolio, the matrix, booked facts, selections, locks. A better *plan*
 * is a separate, explicit rebuild the traveller presses.
 *
 * Throttled per trip through the provider cache: a second press inside the
 * window answers with the first press's summary and spends nothing.
 */

export const REFRESH_THROTTLE_MS = 10 * 60 * 1000;
/** Photographs per press. The imagery pass spaces its requests; this bounds the wait. */
const IMAGES_PER_REFRESH = 16;

export type WeatherRefreshStatus = 'updated' | 'already_fresh' | 'unavailable' | 'failed' | 'skipped';

export interface RefreshSummary {
  /** Places that gained a Wikidata identity this time. */
  identitiesLinked: number;
  /** Photographs newly accepted this time. */
  photosAdded: number;
  /** Photographs the trip's scheduled stops can show now. */
  photosShown: number;
  weather: WeatherRefreshStatus;
  refreshedAt: string;
  /** True when this answer is the earlier press's, replayed inside the throttle window. */
  throttled: boolean;
  /** One sentence for the traveller. */
  message: string;
}

export type RefreshResult = { ok: true; summary: RefreshSummary } | { ok: false; error: string };

export interface RefreshDeps {
  now?: Date;
  /** Whether outward identity lookups may run. Defaults to off under the fixture switches, as the scan's own linking is. */
  linkIdentities?: boolean;
  linkIds?: (subjects: readonly LinkSubject[]) => Promise<Map<string, string>>;
  resolveImages?: (subjects: readonly ImageSubject[], options: { limit: number; now: Date }) => Promise<{ resolved: number; accepted: number }>;
  fetchWeather?: (target: WeatherFetchTarget) => Promise<WeatherFetchOutcome>;
}

const throttleKey = (tripId: string) => `trip-refresh:v1:${tripId}`;

function scheduledPlaceIds(tripId: string): Set<string> {
  const scheduled = new Set<string>();
  let itinerary;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    itinerary = null;
  }
  for (const day of itinerary?.days ?? []) for (const item of day.items) if (item.placeId) scheduled.add(item.placeId);
  return scheduled;
}

/** Scheduled stops first: they are what the trip page shows. */
function byScheduled<T extends { id: string }>(items: readonly T[], scheduled: ReadonlySet<string>): T[] {
  return [...items].sort((a, b) => Number(scheduled.has(b.id)) - Number(scheduled.has(a.id)));
}

function imageSubjectsFor(region: CompiledRegion, scheduled: ReadonlySet<string>): ImageSubject[] {
  return byScheduled(
    region.places.filter((p) => p.wikidataId !== undefined),
    scheduled,
  ).map((place) => ({
    kind: 'candidate' as const,
    id: place.id,
    name: place.name,
    wikidataId: place.wikidataId!,
    coordinates: place.coordinates,
    hierarchy: [place.locality, region.region.name].filter((part): part is string => Boolean(part)),
  }));
}

export function refreshMessage(summary: Omit<RefreshSummary, 'message'>): string {
  const parts: string[] = [];
  if (summary.photosAdded > 0) parts.push(`${summary.photosAdded} new photo${summary.photosAdded === 1 ? '' : 's'}`);
  else if (summary.identitiesLinked > 0) parts.push(`${summary.identitiesLinked} place${summary.identitiesLinked === 1 ? '' : 's'} identified for photos`);
  if (summary.weather === 'updated') parts.push('weather updated');
  else if (summary.weather === 'already_fresh') parts.push('weather already current');
  const head = parts.length > 0 ? `${parts.join(', ')}.` : 'Everything we can check is already up to date.';
  const capitalised = head.charAt(0).toUpperCase() + head.slice(1);
  const weatherNote = summary.weather === 'failed' ? ' The weather source did not answer just then.' : '';
  return `${capitalised}${weatherNote} Your days, stops and bookings are unchanged.`;
}

export async function refreshTripInformation(tripId: string, deps: RefreshDeps = {}): Promise<RefreshResult> {
  const now = deps.now ?? new Date();
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const recent = readProviderCache<Omit<RefreshSummary, 'throttled'>>(throttleKey(tripId), now);
  if (recent) return { ok: true, summary: { ...recent, throttled: true } };

  const scheduled = scheduledPlaceIds(tripId);
  let identitiesLinked = 0;
  let photosAdded = 0;

  // --- 1. identities ------------------------------------------------------------
  const region = compiledRegionFor(tripId);
  const linkAllowed = deps.linkIdentities ?? !fixtureScan();
  if (region && linkAllowed) {
    const subjects: LinkSubject[] = byScheduled(
      region.places.filter((p) => p.wikidataId === undefined),
      scheduled,
    ).map((p) => ({ key: p.id, name: p.name, coordinates: p.coordinates }));
    if (subjects.length > 0) {
      try {
        const links = await (deps.linkIds ?? ((s) => linkWikidataIds(s, { userAgent: providerUserAgent() })))(subjects);
        identitiesLinked = addPlaceWikidataIds(tripId, region.id, links);
      } catch (error) {
        console.warn('Refresh: Wikidata identities unavailable', { tripId, error: error instanceof Error ? error.name : 'unknown' });
      }
    }
  }

  // --- 2. photographs -------------------------------------------------------------
  const linked = identitiesLinked > 0 ? compiledRegionFor(tripId) : region;
  if (linked) {
    const outstanding = unresolvedImagerySubjects(imageSubjectsFor(linked, scheduled), now);
    if (outstanding.length > 0) {
      try {
        const outcome = await (deps.resolveImages ?? ((s, o) => resolveImageryForSubjects(s, { cache: imageryCache(o.now), limit: o.limit })))(outstanding, { limit: IMAGES_PER_REFRESH, now });
        photosAdded = outcome.accepted;
      } catch (error) {
        console.warn('Refresh: imagery unavailable', { tripId, error: error instanceof Error ? error.name : 'unknown' });
      }
    }
  }
  const shownSubjects = (linked?.places ?? []).filter((p) => scheduled.has(p.id) && p.wikidataId !== undefined).map((p) => ({ kind: 'candidate' as const, id: p.id, wikidataId: p.wikidataId! }));
  const photosShown = Object.keys(acceptedImagesFor(shownSubjects, now)).length;

  // --- 3. weather -------------------------------------------------------------------
  let weather: WeatherRefreshStatus = 'skipped';
  try {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      const target = weatherTargetFor(tripId, resolved.context.compiled, resolved.context.dates, resolved.context.weatherScopeKey);
      const outcome = await (deps.fetchWeather ?? fetchWeatherSnapshot)(target);
      weather = !outcome.ok ? 'failed' : outcome.reason === 'fetched' ? 'updated' : outcome.reason === 'already_fresh' ? 'already_fresh' : 'unavailable';
    }
  } catch (error) {
    console.warn('Refresh: weather unavailable', { tripId, error: error instanceof Error ? error.name : 'unknown' });
    weather = 'failed';
  }

  const base = { identitiesLinked, photosAdded, photosShown, weather, refreshedAt: now.toISOString() };
  const stored = { ...base, message: refreshMessage({ ...base, throttled: false }) };
  writeProviderCache(throttleKey(tripId), 'sidequest-trip-refresh', stored, REFRESH_THROTTLE_MS, now);
  return { ok: true, summary: { ...stored, throttled: false } };
}

