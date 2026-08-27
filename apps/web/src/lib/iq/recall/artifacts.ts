import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  geographicScopeSchema,
  partitionBoardPlaces,
  placeSchema,
  regionPackSchema,
  REGION_PACK_VERSION,
  type GeographicScope,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import type { CompiledView } from './stages';

/**
 * READING REAL ARTIFACTS, OFFLINE, WITHOUT TOUCHING THEM.
 *
 * The recall report has to be runnable against reality or it is a test of a
 * fixture. The repository's development database holds real region packs and
 * real compiled regions from live compilations, so the reality arm reads those
 * — **read-only**, on a separate connection, with no schema migration and no
 * write path. `getDb()` is deliberately not used: it opens read-write, runs
 * migrations and caches a global handle, all of which are the wrong shape for a
 * measurement instrument.
 *
 * The database is gitignored. Every function here returns `null` when it is
 * absent, so CI runs the fixture arm and a developer with live artifacts runs
 * both without a flag.
 */

/**
 * Where the development database lives, resolved from this file rather than
 * from a working directory, so the report gives the same answer whether it is
 * run from the repository root, from `apps/web`, or from an editor.
 * `SIDEQUEST_DB_PATH` overrides it, matching the app's own convention.
 */
export const DEFAULT_ARTIFACT_DB =
  process.env.SIDEQUEST_DB_PATH ??
  fileURLToPath(new URL('../../../../data/sidequest.db', import.meta.url));

export interface StoredPack {
  pack: RegionPack;
  /** The version the row was written at, which may predate the current schema. */
  storedSchemaVersion: number;
  /**
   * True when the row only parsed after its version literal was relabelled.
   *
   * Surfaced rather than hidden. A pack written by an older compiler is still a
   * real live build and is the only offline evidence there is, so refusing to
   * read it would mean measuring nothing; pretending it is current would mean
   * attributing an old build's numbers to today's code. The report prints the
   * stored version beside every figure so a reader can weigh it.
   */
  relabelled: boolean;
}

/**
 * One destination's measurable artifact chain: the newest parseable compiled
 * region and the very pack that region records it was built from.
 */
export interface StoredChain {
  /** Stages 1–4 are measured over this pack — the one the region embeds. */
  stored: StoredPack;
  /**
   * Stages 5–6, when anything compiled parses. Same-build with `stored` by
   * construction whenever the region embeds a content hash, because the pack
   * is resolved FROM the region and never the other way around. Null when no
   * compiled region parses at all: the pack then stands alone and the later
   * stages are unmeasured rather than mismeasured.
   */
  compiled: { scope: GeographicScope; view: CompiledView } | null;
}

export interface ArtifactStore {
  /**
   * The artifact chain the floors should grade for one destination.
   *
   * Selection is region-first: the newest parseable compiled region wins, and
   * its own pack is what acquisition is measured over. See the invariant note
   * at the selection site in `openArtifactStore`.
   */
  chainFor(destinationCandidateId: string): StoredChain | null;
  close(): void;
}

/**
 * What the later stages need out of a stored compiled region.
 *
 * Read through a narrow schema of its own rather than `compiledRegionSchema`,
 * and the reason is measurement hygiene: a stored row written by an older
 * compiler must still be *readable* by the instrument that judges it. Parsing
 * the whole artifact strictly would mean a schema bump silently turning "the
 * board lost every landmark" into "no artifact available".
 */
const compiledViewSchema = z.object({
  scope: z.unknown(),
  places: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        coordinates: z.object({ lat: z.number(), lng: z.number() }),
        category: z.string().optional(),
        tags: z.array(z.string()).default([]),
        names: z.object({ display: z.string().optional() }).partial().optional(),
      }),
    )
    .default([]),
  regionPack: z
    .object({ contentHash: z.string().optional(), packId: z.string().optional() })
    .partial()
    .optional(),
});

type CompiledPlace = z.infer<typeof compiledViewSchema>['places'][number];

/**
 * THE SEAT LIST THE DISCOVER PAGE RENDERS, RECOVERED FROM THE ARTIFACT.
 *
 * The discover page does not render `compiled.places` raw: `buildDiscoveryBoard`
 * runs the role gate first (`partitionBoardPlaces`), and only the admitted
 * places become cards — a gateway or a utility stop is stored in the artifact
 * and shown to nobody. Stage 6 asks "did the traveller ever see it", so the
 * funnel must count over the admitted list, not the stored one.
 *
 * Which places are admitted is decided by each place's own role tag —
 * profile-independent — so the product's own gate can be run here without
 * inventing a traveller. It needs fully-parsed places; artifacts written
 * before the current place schema fall back to the ungated view, marked
 * `renderedSeatList: false`, because measuring an old artifact loosely and
 * saying so beats measuring nothing.
 */
const storedPlacesSchema = z.array(placeSchema);

function seatListView(
  rawPlaces: unknown,
  narrow: readonly CompiledPlace[],
): { places: SourceRecord[]; renderedSeatList: boolean } {
  const full = storedPlacesSchema.safeParse(rawPlaces);
  if (full.success) {
    return {
      places: partitionBoardPlaces(full.data).admitted.map(recordViewOfPlace),
      renderedSeatList: true,
    };
  }
  return { places: narrow.map(recordViewOfPlace), renderedSeatList: false };
}

/**
 * A compiled `Place`, in the shape the subject matcher reads.
 *
 * Not a cast and not a lie: every field below is recovered from something the
 * place actually carries. The source category comes back out of the `<layer>=<category>`
 * tag the inventory writes, which is why the matcher can apply the *same*
 * taxonomy test to a board place as to a pack record — without which stage 6
 * would be matching on names alone and would score `Hoàng cung Tokyo` a miss.
 */
export function recordViewOfPlace(place: CompiledPlace): SourceRecord {
  const layerTag = place.tags.find((tag) => /^[a-z_]+=/.test(tag));
  const [layerId, sourceCategory] = layerTag ? layerTag.split('=') : [undefined, undefined];
  return {
    id: place.id,
    layerId: layerId ?? 'places',
    sourceId: place.id,
    name: place.names?.display ?? place.name,
    alternateNames: [],
    coordinates: place.coordinates,
    sourceCategory: sourceCategory ?? place.category ?? '',
    sourceCategoryPath: [],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [],
    cellId: 'compiled',
  } as unknown as SourceRecord;
}

/**
 * A full scope for a pack that has none.
 *
 * A pack stores only a reduced identity, on purpose — it is shared ground. The
 * inventory needs a whole `GeographicScope`, so when no compiled region supplies
 * one, this builds the most neutral scope the pack's own bounds support:
 * bounds-shaped, no included or excluded areas, no traveller. Anything else
 * would be this file expressing an opinion about a trip nobody took.
 */
export function neutralScopeFor(pack: RegionPack): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: pack.scope.destinationCandidateId,
    destinationName: pack.scope.destinationName,
    destinationEntityType: pack.scope.breadth === 'country' ? 'country' : 'city',
    breadth: pack.scope.breadth,
    center: pack.scope.center,
    bounds: pack.scope.bounds,
    timeZones: ['UTC'],
    shape: { kind: 'bounds', bounds: pack.scope.bounds },
    transport: {
      primaryMode: 'walk',
      allowedModes: ['walk'],
      carAvailable: false,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Neutral scope built for measurement only.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'Recall measurement over a stored pack.',
    confidence: { level: 'low', signals: [], note: 'Measurement scope, not a trip.' },
    confirmedByUser: false,
  });
}

export function openArtifactStore(path: string = DEFAULT_ARTIFACT_DB): ArtifactStore | null {
  if (!existsSync(path)) return null;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  const packRowsFor = (destinationCandidateId: string): { payload_json: string }[] =>
    db
      .prepare<[string], { payload_json: string }>(
        `select payload_json from region_packs
         where scope_hash like ? order by created_at desc`,
      )
      .all(`%${destinationCandidateId}%`);

  const parseStoredPack = (payload: string): StoredPack | null => {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return null;
    }
    const strict = regionPackSchema.safeParse(raw);
    if (strict.success) {
      return { pack: strict.data, storedSchemaVersion: REGION_PACK_VERSION, relabelled: false };
    }
    const stored = (raw as { schemaVersion?: unknown }).schemaVersion;
    const relabelled = regionPackSchema.safeParse({
      ...(raw as object),
      schemaVersion: REGION_PACK_VERSION,
    });
    if (relabelled.success && typeof stored === 'number') {
      return { pack: relabelled.data, storedSchemaVersion: stored, relabelled: true };
    }
    /* Genuinely unreadable: treated as absent, exactly as production does. */
    return null;
  };

  /** The newest parseable pack: the stand-alone fallback when nothing compiled. */
  const newestPack = (destinationCandidateId: string): StoredPack | null => {
    for (const row of packRowsFor(destinationCandidateId)) {
      const stored = parseStoredPack(row.payload_json);
      if (stored) return stored;
    }
    return null;
  };

  /**
   * The pack a compiled region records it was built from.
   *
   * Resolved by the embedded content hash when the region carries one — the
   * only identity that proves the same build, since pack rows are rewritten in
   * place under a stable id. The pack-id path exists for regions written
   * before the hash was embedded; a chain resolved that way does not claim the
   * same-build content hash, so the report's provenance footnote stays honest.
   */
  const packOfRegion = (
    destinationCandidateId: string,
    embedded: { contentHash?: string; packId?: string } | undefined,
  ): StoredPack | null => {
    if (embedded?.contentHash === undefined && embedded?.packId === undefined) return null;
    for (const row of packRowsFor(destinationCandidateId)) {
      const stored = parseStoredPack(row.payload_json);
      if (!stored) continue;
      if (embedded.contentHash !== undefined) {
        if (stored.pack.contentHash === embedded.contentHash) return stored;
      } else if (stored.pack.id === embedded.packId) {
        return stored;
      }
    }
    return null;
  };

  return {
    chainFor(destinationCandidateId) {
      /*
       * REGION-FIRST, BY INVARIANT: the floors grade the newest artifact chain
       * the product actually delivered for this destination — the newest
       * parseable compiled region, measured against the pack that region
       * itself records it was built from. Selecting the newest PACK and then
       * looking for its region conflated destination class with whichever
       * traveller profile compiled last: two legitimate pack scopes can
       * coexist for one destination (a road-trip radius and a walkable city
       * box), and a road-scope pack must never stand in for a city build that
       * never used it. A region whose recorded pack no longer resolves is not
       * a measurable chain, so the next older complete chain stands. Only when
       * nothing compiled parses at all does the newest parseable pack stand
       * alone, leaving stages 5–6 unmeasured rather than mismeasured.
       */
      const rows = db
        .prepare<[string], { payload_json: string }>(
          `select payload_json from compiled_regions
           where scope_fingerprint like ? order by created_at desc`,
        )
        .all(`%${destinationCandidateId}%`);
      for (const row of rows) {
        let raw: unknown;
        try {
          raw = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        const parsed = compiledViewSchema.safeParse(raw);
        if (!parsed.success) continue;
        const scope = geographicScopeSchema.safeParse(parsed.data.scope);
        if (!scope.success) continue;
        const stored = packOfRegion(destinationCandidateId, parsed.data.regionPack);
        if (!stored) continue;
        const seats = seatListView((raw as { places?: unknown }).places, parsed.data.places);
        return {
          stored,
          compiled: {
            scope: scope.data,
            view: {
              places: seats.places,
              renderedSeatList: seats.renderedSeatList,
              ...(parsed.data.regionPack?.contentHash
                ? { packContentHash: parsed.data.regionPack.contentHash }
                : {}),
            },
          },
        };
      }
      const stored = newestPack(destinationCandidateId);
      return stored ? { stored, compiled: null } : null;
    },

    close() {
      db.close();
    },
  };
}
