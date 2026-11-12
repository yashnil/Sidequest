import 'server-only';
import type { LodgingPropertyCandidate } from '@sidequest/core';
import { capability } from '../registry';
import { fetchLodgingPois, type OverpassResult } from '../overpass';
import { cacheFor, TTL } from '../open-verification';
import { fetchOvertureLodging, type OvertureLodgingDeps } from './overture-lodging';
import { osmLodgingFromElements } from './osm-lodging';
import type { BoundingBox } from '../overture/scan';

/**
 * NAMED PLACES TO STAY AROUND ONE BASE — ON REQUEST, NEVER ON RENDER.
 *
 * A traveller presses "Show places to stay" on a stay in Bookings; this reads
 * lodging candidates around that base from two open sources, each on its own:
 *
 * - **Overture** place files (keyless, always on unless switched off): the
 *   names a booking site would know, with websites. Cached a week per box.
 * - **OpenStreetMap** through the shared Overpass client, only where the POI
 *   provider is switched on (`SIDEQUEST_POI_PROVIDER=overpass`), with its
 *   process-wide cooldown and its own cache entry. Mapped amenities: onsen,
 *   parking, wheelchair, stars.
 *
 * The two answers are returned side by side, never merged. Nothing here is a
 * price or an availability, and the result says so (`noLivePricing`). The
 * answer is for display; the plan never reads it.
 */

export type LodgingSourceStatus = 'ok' | 'empty' | 'failed' | 'off';

export interface LodgingDiscovery {
  available: boolean;
  provider: 'open-data' | 'fixture' | null;
  sources: { source: 'overture' | 'osm'; status: LodgingSourceStatus; count: number; cacheHit?: boolean }[];
  candidates: LodgingPropertyCandidate[];
  attribution: string[];
  reason?: string;
  /** Always true; nothing here quotes a price or a room. */
  noLivePricing: true;
}

export interface LodgingDiscoveryDeps {
  overture?: OvertureLodgingDeps;
  overpass?: (box: BoundingBox) => Promise<OverpassResult>;
}

export function boxAround(near: { lat: number; lng: number }, radiusKm: number): BoundingBox {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.15, Math.cos((near.lat * Math.PI) / 180)));
  /* Snapped to ~100 m so two presses on one base share a cache entry. */
  const snap = (v: number) => Math.round(v * 1000) / 1000;
  return { south: snap(near.lat - dLat), north: snap(near.lat + dLat), west: snap(near.lng - dLng), east: snap(near.lng + dLng) };
}

const FIXTURE: Omit<LodgingPropertyCandidate, 'coordinates'>[] = [
  { source: 'osm', sourceId: 'osm:node/1', name: 'Riverside Hot Spring Inn', type: 'inn', typeBasis: 'category', amenities: [{ kind: 'onsen', value: 'yes', basis: 'mapped' }, { kind: 'parking', value: 'yes', basis: 'mapped' }], website: 'https://example.org/riverside', licence: 'ODbL-1.0', attribution: 'Fixture data' },
  { source: 'overture', sourceId: 'overture:fixture-2', name: 'Station Hotel', type: 'hotel', typeBasis: 'category', amenities: [], website: 'https://example.org/station', confidence: 0.97, licence: 'CDLA-Permissive-2.0', attribution: 'Fixture data' },
  { source: 'overture', sourceId: 'overture:fixture-3', name: 'Trailhead Guesthouse', type: 'guesthouse', typeBasis: 'category', amenities: [], confidence: 0.9, licence: 'CDLA-Permissive-2.0', attribution: 'Fixture data' },
  { source: 'osm', sourceId: 'osm:node/4', name: 'Valley Motel', type: 'motel', typeBasis: 'category', amenities: [{ kind: 'parking', value: 'yes', basis: 'mapped' }], licence: 'ODbL-1.0', attribution: 'Fixture data' },
];

export async function discoverLodgingNear(
  input: { near: { lat: number; lng: number }; radiusKm: number },
  env: Record<string, string | undefined> = process.env,
  deps: LodgingDiscoveryDeps = {},
): Promise<LodgingDiscovery> {
  const cap = capability('lodging.named', env);
  if (cap?.fixture) {
    const candidates = FIXTURE.map((c, i) => ({ ...c, coordinates: { lat: input.near.lat + 0.002 * (i + 1), lng: input.near.lng - 0.0015 * (i + 1) } }));
    return { available: true, provider: 'fixture', sources: [{ source: 'overture', status: 'ok', count: 2 }, { source: 'osm', status: 'ok', count: 2 }], candidates, attribution: ['Fixture data'], noLivePricing: true };
  }
  const radiusKm = Math.min(20, Math.max(0.5, input.radiusKm));
  const box = boxAround(input.near, radiusKm);
  const useOverture = Boolean(cap?.configured);
  const useOsm = useOverture && (deps.overpass !== undefined || cap?.provider === 'overture+overpass');

  const overtureRead = useOverture
    ? fetchOvertureLodging(box, deps.overture).then(
        (r) => ({ ok: true as const, ...r }),
        (error: unknown) => {
          console.warn('Lodging: Overture box not read', error instanceof Error ? error.message : error);
          return { ok: false as const };
        },
      )
    : Promise.resolve(null);
  const osmRead = useOsm
    ? (deps.overpass ?? ((b: BoundingBox) => fetchLodgingPois(b, { limit: 240, retries: 0, requestTimeoutMs: 25_000, deadlineMs: Date.now() + 35_000, cache: cacheFor<OverpassResult>('overpass-lodging', TTL.poi) })))(box).then(
        (r) => ({ ok: true as const, candidates: osmLodgingFromElements(r.elements), cacheHit: r.cacheHit }),
        (error: unknown) => {
          console.warn('Lodging: Overpass not read', error instanceof Error ? error.message : error);
          return { ok: false as const };
        },
      )
    : Promise.resolve(null);
  const [overture, osm] = await Promise.all([overtureRead, osmRead]);

  const sources: LodgingDiscovery['sources'] = [];
  const candidates: LodgingPropertyCandidate[] = [];
  for (const [source, read] of [['overture', overture], ['osm', osm]] as const) {
    if (read === null) sources.push({ source, status: 'off', count: 0 });
    else if (!read.ok) sources.push({ source, status: 'failed', count: 0 });
    else {
      sources.push({ source, status: read.candidates.length > 0 ? 'ok' : 'empty', count: read.candidates.length, cacheHit: read.cacheHit });
      candidates.push(...read.candidates);
    }
  }
  const attribution = [
    ...(candidates.some((c) => c.source === 'overture') ? ['Overture Maps Foundation (CDLA-Permissive-2.0; Apache-2.0 parts include Foursquare data)'] : []),
    ...(candidates.some((c) => c.source === 'osm') ? ['© OpenStreetMap contributors (ODbL)'] : []),
  ];
  const anyRead = sources.some((s) => s.status === 'ok' || s.status === 'empty');
  return {
    available: anyRead,
    provider: anyRead ? 'open-data' : null,
    sources,
    candidates,
    attribution,
    ...(anyRead ? {} : { reason: sources.every((s) => s.status === 'off') ? 'Named places to stay are switched off here.' : 'The open place data did not answer just now. Nothing was guessed instead; the searches above still work.' }),
    noLivePricing: true,
  };
}
