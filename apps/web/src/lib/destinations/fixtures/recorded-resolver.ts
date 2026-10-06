import { DESTINATION_RESOLUTION_VERSION, normalizeDestinationQuery, type DestinationCandidate, type DestinationResolution } from '@sidequest/core';
import type { DestinationResolver } from '@sidequest/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promoteMunicipalityInPlace, toCandidate } from '@/lib/providers/open-verification';
import type { NominatimPlace } from '@/lib/providers/nominatim';

/**
 * V8.1 — THE PUBLIC GEOCODER'S ANSWERS, RECORDED ONCE, REPLAYED OFFLINE.
 *
 * `nominatim/index.json` maps every query the resolver issues for the
 * regression corpus (the phrases, their map-form fallbacks, and the areas and
 * gateways the interpreter fixture names) to the response the public
 * instance gave on 2026-09-11. The corpus test and the browser suite's
 * fixture resolver replay them through the same `toCandidate` the product
 * uses, so what is asserted is the product's reading of real rows — a shop
 * named after a mountain range, a village in Arizona, a path in Broken Hill
 * — and not a synthetic world built to pass.
 *
 * Never read by the product path. A query that was not recorded answers
 * "nothing", which the resolver treats as a blank, not a refusal.
 */

const FIXTURE_DIRS = ['src/lib/destinations/fixtures/nominatim', 'apps/web/src/lib/destinations/fixtures/nominatim'];

let table: { dir: string; queries: Record<string, string> } | null = null;

function load(): { dir: string; queries: Record<string, string> } {
  if (table) return table;
  for (const dir of FIXTURE_DIRS) {
    try {
      const raw = readFileSync(join(/* turbopackIgnore: true */ process.cwd(), dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw) as { queries: Record<string, string> };
      table = { dir: join(/* turbopackIgnore: true */ process.cwd(), dir), queries: parsed.queries };
      return table;
    } catch {
      /* try the next root */
    }
  }
  table = { dir: '', queries: {} };
  return table;
}

/** The recorded rows for a query, or null when it was never recorded. */
export function recordedPlaces(query: string): NominatimPlace[] | null {
  const { dir, queries } = load();
  const file = queries[normalizeDestinationQuery(query)];
  if (!file || !dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8')) as NominatimPlace[];
  } catch {
    return null;
  }
}

export function recordedQueries(): string[] {
  return Object.keys(load().queries);
}

/** A resolver that answers from the recordings and logs what it was asked. */
export function recordedResolver(log: string[] = []): DestinationResolver {
  return {
    name: 'nominatim-recorded',
    async resolve({ query, now }): Promise<DestinationResolution> {
      log.push(query);
      const places = recordedPlaces(query) ?? [];
      const candidates = places.map((place) => toCandidate(place, query)).filter((c): c is DestinationCandidate => c !== null);
      promoteMunicipalityInPlace(candidates, query);
      const ambiguityReasons: DestinationResolution['ambiguityReasons'] = [];
      if (candidates.length === 0) ambiguityReasons.push('no_match');
      if (candidates.length > 1) ambiguityReasons.push('multiple_matching_places');
      const leading = candidates[0];
      if (leading?.breadth === 'country' || leading?.breadth === 'multi_country') ambiguityReasons.push('administrative_area_needs_subset');
      if (leading && !leading.bounds) ambiguityReasons.push('no_boundary_available');
      return {
        schemaVersion: DESTINATION_RESOLUTION_VERSION,
        query,
        normalizedQuery: normalizeDestinationQuery(query),
        candidates,
        ambiguityReasons,
        ...(candidates.length === 1 && ambiguityReasons.length === 0 ? { unambiguousCandidateId: candidates[0]!.id } : {}),
        providersConsulted: ['nominatim-recorded'],
        resolvedAt: now.toISOString(),
      };
    },
  };
}
