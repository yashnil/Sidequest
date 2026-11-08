import 'server-only';
import { compiledRegionSchema } from '@sidequest/core';
import { getDb } from './client';

/**
 * ADDING A WIKIDATA IDENTITY TO A STORED PLACE — AND NOTHING ELSE.
 *
 * Compiled regions are treated as immutable: a recompile writes a new row, so
 * an itinerary keeps pointing at exactly the evidence it was built from. This
 * is the one, narrow exception, and it holds that promise by what it may touch:
 *
 *   - only `places[].wikidataId`, and only where the place has none — an
 *     identity already held is never replaced;
 *   - never a verdict, a coordinate, a base, a portfolio, a matrix or an hour;
 *   - a QID already worn by another place in the same region is refused, so two
 *     stops can never share one photograph;
 *   - the rewritten payload must still parse under the current schema, or the
 *     row is left exactly as it was.
 *
 * The payload is edited as raw JSON rather than round-tripped through the
 * schema, so defaults and field order in the stored bytes do not drift. An
 * identity is evidence about which thing a stop *is*; adding one changes which
 * photograph can be shown and nothing the plan rests on.
 */
export function addPlaceWikidataIds(tripId: string, regionId: string, links: ReadonlyMap<string, string>): number {
  if (links.size === 0) return 0;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT payload_json FROM compiled_regions WHERE id = ? AND trip_id = ?').get(regionId, tripId) as { payload_json: string } | undefined;
    if (!row) return 0;
    let payload: { places?: { id?: unknown; wikidataId?: unknown }[] };
    try {
      payload = JSON.parse(row.payload_json) as typeof payload;
    } catch {
      return 0;
    }
    if (!Array.isArray(payload.places)) return 0;
    const worn = new Set(payload.places.map((p) => p.wikidataId).filter((q): q is string => typeof q === 'string'));
    let added = 0;
    for (const place of payload.places) {
      if (typeof place.id !== 'string' || place.wikidataId !== undefined) continue;
      const qid = links.get(place.id);
      if (!qid || !/^Q\d+$/.test(qid) || worn.has(qid)) continue;
      place.wikidataId = qid;
      worn.add(qid);
      added += 1;
    }
    if (added === 0) return 0;
    if (!compiledRegionSchema.safeParse(payload).success) return 0;
    db.prepare('UPDATE compiled_regions SET payload_json = ? WHERE id = ? AND trip_id = ?').run(JSON.stringify(payload), regionId, tripId);
    return added;
  })();
}
