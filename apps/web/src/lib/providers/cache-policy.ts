/**
 * CACHE BY WHAT THE DATA IS, NOT BY WHO SERVED IT.
 *
 * A place's identity does not change week to week; its opening hours might;
 * traffic changes by the minute; an FX rate is a fact about a date. The TTLs
 * below are the longest a class may be reused. Provider terms that are
 * stricter (Google Places content may not be cached beyond its allowance
 * except place ids and coordinates) are honoured by the adapters, which own
 * their storage.
 */
export const CACHE_CLASSES = ['identity', 'coordinates', 'hours', 'business_status', 'static_route', 'traffic_route', 'transit_route', 'forecast', 'climate', 'fx', 'lodging_discovery', 'food_discovery'] as const;
export type CacheClass = (typeof CACHE_CLASSES)[number];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const CACHE_TTL_MS: Record<CacheClass, number> = {
  identity: 30 * DAY,
  coordinates: 30 * DAY,
  hours: 24 * HOUR,
  business_status: 12 * HOUR,
  static_route: 7 * DAY,
  traffic_route: 10 * 60 * 1000,
  transit_route: 24 * HOUR,
  forecast: HOUR,
  climate: 30 * DAY,
  fx: 24 * HOUR,
  lodging_discovery: 7 * DAY,
  food_discovery: 7 * DAY,
};

/** A key that changes with the thing that makes the answer different. */
export function cacheKeyFor(cls: CacheClass, parts: readonly (string | number)[], extra: { date?: string; departBucket?: string } = {}): string {
  const scoped = [cls, ...parts];
  if (cls === 'fx' || cls === 'forecast') scoped.push(extra.date ?? 'undated');
  if (cls === 'traffic_route' || cls === 'transit_route') scoped.push(extra.departBucket ?? 'no-departure');
  return scoped.join('|');
}

export function isExpired(cls: CacheClass, writtenAt: Date, now: Date): boolean {
  return now.getTime() - writtenAt.getTime() > CACHE_TTL_MS[cls];
}
