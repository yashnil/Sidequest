import { describe, expect, it, vi } from 'vitest';
import type { GeographicEvidence, SourceRecord } from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles } from './catalog';
import { LAYERS, cleanText, layerById, mapLicence, readWebsites } from './normalize';
import { boundsOf, overlappingRowGroups, pointOf, rowInBox, rowPointInBox } from './scan';
import type { FileMetaData } from 'hyparquet';

/**
 * THE PLACE-DATA ADAPTER, OFFLINE.
 *
 * Every catalogue document here is a fixture and every fetch is injected, so
 * these run with no network and assert the two things the adapter is actually
 * responsible for: reading somebody else's documents without trusting them, and
 * turning their rows into records without inventing anything.
 *
 * The security cases are not decoration. A STAC catalogue is a graph of links
 * written by somebody else; following one is a server-side request forgery with
 * extra steps, and a `websites` array is attacker-controlled text in a public
 * database.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const ROOT = {
  type: 'Catalog',
  id: 'Overture Releases',
  latest: '2026-07-22.0',
  links: [
    { rel: 'root', href: './catalog.json' },
    { rel: 'child', href: './2026-07-22.0/catalog.json', latest: true },
    { rel: 'child', href: './2026-06-17.0/catalog.json' },
  ],
};

const RELEASE = {
  id: '2026-07-22.0',
  'release:version': '2026-07-22.0',
  'schema:version': null,
  links: [{ rel: 'child', href: './places/catalog.json' }],
};

describe('release discovery', () => {
  it('pins the release the catalogue calls latest', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
      return jsonResponse(ROOT);
    });

    const release = await latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(release.catalog).toBe('overture');
    expect(release.releaseId).toBe('2026-07-22.0');
    // A release that publishes no schema version does not get an invented one.
    expect(release.schemaVersion).toBeUndefined();
  });

  it('falls back to the flagged child when the root does not name a latest', async () => {
    const withoutLatest = { ...ROOT, latest: undefined };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
      return jsonResponse(withoutLatest);
    });
    const release = await latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(release.releaseId).toBe('2026-07-22.0');
  });

  it('refuses a catalogue document that names no release', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: 'Catalog', links: [] }));
    await expect(
      latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(CatalogError);
  });

  it('reports an unreachable catalogue rather than throwing something opaque', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('catalogue link handling', () => {
  const collection = {
    links: [
      { rel: 'item', href: './00000/00000.json' },
      { rel: 'item', href: './00001/00001.json' },
    ],
  };

  function itemWith(assets: Record<string, unknown>) {
    return {
      bbox: [-74.1, 40.6, -73.9, 40.8],
      assets,
      properties: { 'table:row_count': 1000 },
    };
  }

  it('reads only assets on hosts we know, and only parquet', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('collection.json')) return jsonResponse(collection);
      if (url.includes('00000')) {
        return jsonResponse(
          itemWith({
            // A hostile mirror, a non-parquet asset, then the real one.
            evil: { href: 'https://attacker.example/steal.parquet', type: 'application/vnd.apache.parquet' },
            tiles: {
              href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/x/y.pmtiles',
              type: 'application/vnd.pmtiles',
            },
            data: {
              href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/x/part-0.zstd.parquet',
              type: 'application/vnd.apache.parquet',
              alternate: { s3: { href: 's3://overturemaps-us-west-2/release/x/part-0.zstd.parquet' } },
            },
          }),
        );
      }
      return jsonResponse(itemWith({}));
    });

    const files = await themeFiles({
      release: {
        catalog: 'overture',
        releaseId: '2026-07-22.0',
        resolvedAt: '2026-08-01T00:00:00Z',
        catalogUrl: 'https://stac.overturemaps.org/catalog.json',
      },
      theme: 'places',
      type: 'place',
      options: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.url).toContain('overturemaps-us-west-2');
    expect(files[0]!.url.endsWith('.parquet')).toBe(true);
    // The `s3://` alternate is unreadable by an anonymous HTTP client and is
    // never chosen; the attacker host is never chosen at all.
    expect(files.some((file) => file.url.includes('attacker.example'))).toBe(false);
  });

  it('refuses to follow a link that leaves the allowlist', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ links: [{ rel: 'item', href: 'https://attacker.example/item.json' }] }),
    );
    await expect(
      themeFiles({
        release: {
          catalog: 'overture',
          releaseId: '2026-07-22.0',
          resolvedAt: '2026-08-01T00:00:00Z',
          catalogUrl: 'https://stac.overturemaps.org/catalog.json',
        },
        theme: 'places',
        type: 'place',
        options: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ code: 'rejected_host' });
  });

  it('prunes files by their published bounding box', () => {
    const file = { url: 'https://x/y.parquet', bbox: [-180, -85, -75, 27] as [number, number, number, number] };
    expect(fileIntersects(file, { west: -74.1, south: 40.6, east: -73.9, north: 40.8 })).toBe(false);
    expect(fileIntersects(file, { west: -100, south: 10, east: -95, north: 15 })).toBe(true);
  });
});

describe('row-group pruning', () => {
  function metadata(groups: { xmin: number; xmax: number; ymin: number; ymax: number; rows: number }[]): FileMetaData {
    return {
      row_groups: groups.map((group) => ({
        num_rows: BigInt(group.rows),
        total_byte_size: BigInt(1),
        columns: (
          [
            ['bbox.xmin', group.xmin, group.xmax],
            ['bbox.xmax', group.xmin, group.xmax],
            ['bbox.ymin', group.ymin, group.ymax],
            ['bbox.ymax', group.ymin, group.ymax],
          ] as const
        ).map(([path, min, max]) => ({
          meta_data: {
            path_in_schema: path.split('.'),
            statistics: { min_value: min, max_value: max },
          },
        })),
      })),
      schema: [],
    } as unknown as FileMetaData;
  }

  it('keeps only the groups whose statistics overlap the box', () => {
    const meta = metadata([
      { xmin: -180, xmax: -100, ymin: -80, ymax: 20, rows: 100 },
      { xmin: -75, xmax: -73, ymin: 40, ymax: 41, rows: 200 },
      { xmin: 100, xmax: 120, ymin: -10, ymax: 0, rows: 300 },
    ]);
    const ranges = overlappingRowGroups(meta, { west: -74.1, south: 40.6, east: -73.9, north: 40.8 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ index: 1, start: 100, end: 300 });
  });

  it('considers every group when the statistics are missing, rather than none', () => {
    const meta = {
      row_groups: [{ num_rows: 10n, total_byte_size: 1n, columns: [] }],
      schema: [],
    } as unknown as FileMetaData;
    expect(overlappingRowGroups(meta, { west: 0, south: 0, east: 1, north: 1 })).toHaveLength(1);
  });
});

describe('row geometry', () => {
  it('refuses NaN and out-of-range coordinates', () => {
    expect(pointOf({ bbox: { xmin: Number.NaN, xmax: 1, ymin: 1, ymax: 1 } })).toBeNull();
    expect(pointOf({ bbox: { xmin: 1, xmax: 1, ymin: 200, ymax: 200 } })).toBeNull();
    expect(pointOf({ bbox: { xmin: Infinity, xmax: 1, ymin: 1, ymax: 1 } })).toBeNull();
    expect(pointOf({})).toBeNull();
  });

  it('returns the centre of the box the record itself publishes', () => {
    expect(pointOf({ bbox: { xmin: -74, xmax: -73, ymin: 40, ymax: 42 } })).toEqual({
      lat: 41,
      lng: -73.5,
    });
  });

  it('only reports bounds for a real area, never a degenerate point', () => {
    expect(boundsOf({ bbox: { xmin: -74, xmax: -74, ymin: 40, ymax: 40 } })).toBeUndefined();
    expect(boundsOf({ bbox: { xmin: -74, xmax: -73, ymin: 40, ymax: 41 } })).toEqual({
      southWest: { lat: 40, lng: -74 },
      northEast: { lat: 41, lng: -73 },
    });
  });

  it('keeps the per-row check, because row-group pruning is coarse', () => {
    const box = { west: -74.1, south: 40.6, east: -73.9, north: 40.8 };
    expect(rowInBox({ bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 } }, box)).toBe(true);
    expect(rowInBox({ bbox: { xmin: -120, xmax: -120, ymin: 35, ymax: 35 } }, box)).toBe(false);
  });
});

describe('normalisation', () => {
  it('maps each declared licence, and falls back to the theme rather than to none', () => {
    expect(mapLicence('CDLA-Permissive-2.0', 'ODbL-1.0')).toBe('CDLA-Permissive-2.0');
    expect(mapLicence('Apache-2.0', 'ODbL-1.0')).toBe('Apache-2.0');
    expect(mapLicence('CC0-1.0', 'ODbL-1.0')).toBe('CC0-1.0');
    expect(mapLicence('ODbL-1.0', 'CDLA-Permissive-2.0')).toBe('ODbL-1.0');
    // Unreadable is not unencumbered.
    expect(mapLicence('something-new-2.0', 'ODbL-1.0')).toBe('ODbL-1.0');
    expect(mapLicence(undefined, 'ODbL-1.0')).toBe('ODbL-1.0');
  });

  it('keeps only http(s) website candidates with no embedded credentials', () => {
    expect(
      readWebsites([
        'javascript:alert(1)',
        'data:text/html,<script>x</script>',
        'http://user:pass@10.0.0.1/',
        'file:///etc/passwd',
        'not a url',
        'https://museum.example/visit',
      ]),
    ).toEqual(['https://museum.example/visit']);
  });

  it('strips control characters and bidirectional overrides from names', () => {
    const hostile = cleanText('Museum\u0000 of‮ gnitniaP');
    expect(hostile).not.toContain('‮');
    expect(hostile).not.toContain('\u0000');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('x'.repeat(500))?.length).toBe(180);
  });

  it('declares one layer per dataset, each with a licence and required columns', () => {
    expect(LAYERS.length).toBeGreaterThanOrEqual(5);
    for (const layer of LAYERS) {
      expect(layer.requiredColumns.length).toBeGreaterThan(0);
      expect(layer.columns).toContain('bbox');
      expect(layerById(layer.id)).toBe(layer);
    }
    // Exactly one primary place layer, and the geography kept separate from it —
    // which is what keeps a share-alike source out of a permissive one.
    expect(LAYERS.filter((layer) => layer.kind === 'primary_places')).toHaveLength(1);
    expect(LAYERS.find((layer) => layer.id === 'places')?.defaultLicenceId).toBe(
      'CDLA-Permissive-2.0',
    );
    for (const layer of LAYERS.filter((entry) => entry.kind !== 'primary_places')) {
      expect(layer.defaultLicenceId).toBe('ODbL-1.0');
    }
  });

  it('normalises a place row into a record without inventing anything', () => {
    const layer = layerById('places')!;
    const record = layer.normalize(
      {
        id: 'gers-1',
        names: { primary: 'Harbour Museum', common: { es: 'Museo del Puerto' } },
        taxonomy: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
        operating_status: 'open',
        websites: ['https://harbourmuseum.example/'],
        addresses: [{ locality: 'Harbour City', region: 'HC', country: 'tl' }],
        sources: [
          {
            dataset: 'meta',
            license: 'CDLA-Permissive-2.0',
            record_id: '123',
            update_time: '2026-07-02T00:00:00.000Z',
            confidence: 0.87,
          },
        ],
        bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );

    expect(record).not.toBeNull();
    expect(record!.id).toBe('places:gers-1');
    expect(record!.name).toBe('Harbour Museum');
    expect(record!.alternateNames).toContain('Museo del Puerto');
    expect(record!.planningRole).toBe('attraction');
    expect(record!.operatingStatus).toBe('open');
    expect(record!.containment.countryCode).toBe('TL');
    expect(record!.sources[0]?.existenceConfidence).toBe(0.87);
    // Contact details are not planning facts and are not retained.
    expect(Object.keys(record!.attributes)).not.toContain('phone');
  });

  it('marks a permanently closed record excluded rather than dropping it silently', () => {
    const layer = layerById('places')!;
    const record = layer.normalize(
      {
        id: 'gers-2',
        names: { primary: 'Former Gallery' },
        taxonomy: { primary: 'art_gallery', hierarchy: ['arts_and_entertainment', 'art_gallery'] },
        operating_status: 'permanently_closed',
        sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0' }],
        bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    expect(record?.operatingStatus).toBe('closed');
    expect(record?.planningRole).toBe('excluded');
  });

  it('builds an upstream link from the record id, never from a supplied URL', () => {
    const layer = layerById('land')!;
    const record = layer.normalize(
      {
        id: 'gers-3',
        names: { primary: 'Test Peak' },
        subtype: 'physical',
        class: 'peak',
        elevation: 1832,
        source_tags: { website: 'https://park.example/peak', operator: 'Park Service', ele: '1832' },
        sources: [
          {
            dataset: 'OpenStreetMap',
            license: 'ODbL-1.0',
            record_id: 'w652289958@1',
            update_time: '2018-12-04T11:56:32.000Z',
          },
        ],
        bbox: { xmin: -151.2, xmax: -151.1, ymin: 63.44, ymax: 63.46 },
      },
      {
        layerId: 'land',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ countryCode: 'US', divisionIds: [] }),
      },
    );

    expect(record?.sourceUrl).toBe('https://www.openstreetmap.org/way/652289958');
    expect(record?.attributes.operator).toBe('Park Service');
    expect(record?.attributes.ele).toBe('1832');
    expect(record?.websiteCandidates).toEqual(['https://park.example/peak']);
    expect(record?.bounds).toBeDefined();
  });

  it('drops a row with no name, no id or no position rather than defaulting one', () => {
    const layer = layerById('places')!;
    const context = {
      layerId: 'places',
      cellId: 'g-0-0',
      defaultLicenceId: 'CDLA-Permissive-2.0' as const,
      containmentFor: () => ({ divisionIds: [] }),
    };
    expect(layer.normalize({ id: 'x', bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } }, context)).toBeNull();
    expect(
      layer.normalize({ names: { primary: 'Anonymous' }, bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } }, context),
    ).toBeNull();
    expect(layer.normalize({ id: 'x', names: { primary: 'No position' } }, context)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope membership
// ---------------------------------------------------------------------------

/**
 * THE ADAPTER'S HALF OF "DOES THIS BELONG HERE".
 *
 * The compiler owns the decision; this file owns the two places it has to be
 * applied. The regression: a metropolitan build returned twenty-three places and
 * every one of them was in a first-level division the destination is not in. The
 * read was correct, the pruning was correct, the normalisation was correct, and
 * no layer had ever been given the job of asking whether the thing belonged.
 *
 * The scope below carries no boundary, because no city in the index has one.
 */
function placeRow(input: {
  id: string;
  name: string;
  lat: number;
  region: string;
  locality: string;
  country?: string;
  category?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    names: { primary: input.name },
    taxonomy: {
      primary: input.category ?? 'museum',
      hierarchy: ['arts_and_entertainment', input.category ?? 'museum'],
    },
    operating_status: 'open',
    addresses: [{ locality: input.locality, region: input.region, country: input.country ?? 'AA' }],
    sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: input.id }],
    bbox: { xmin: 20, xmax: 20, ymin: input.lat, ymax: input.lat },
  };
}

describe('geographic evidence at the adapter boundary', () => {
  /*
   * WHAT THIS BOUNDARY IS RESPONSIBLE FOR, AFTER THE PACK/OVERLAY SPLIT.
   *
   * It used to decide membership here, and these tests asserted the verdicts. The
   * verdicts were right; the *layer* was wrong. A pack is cached on the
   * destination and the bounds and shared between every traveller going there,
   * and a membership verdict needs the traveller's scope, their regional
   * expansion and their base strategy — one of which (`includedAreas`) is in the
   * pack's own cache key. So the adapter now produces **evidence**, which is
   * traveller-independent and genuinely cacheable, and the trip-scope overlay
   * produces verdicts.
   *
   * These tests were re-reasoned rather than renamed, per the migration record:
   * each one keeps the invariant it actually protected — an address is read at
   * its own level, an ISO code is not a name, and no record leaves without
   * evidence — and drops the assertion that a *verdict* is attached, because that
   * assertion pinned the layering the closure removes.
   */

  function normalisePlace(row: Record<string, unknown>) {
    return layerById('places')!.normalize(row, {
      layerId: 'places',
      cellId: 'g-0-0',
      defaultLicenceId: 'CDLA-Permissive-2.0',
      containmentFor: () => ({ divisionIds: [] }),
    });
  }

  it('filters on the record’s own position, not on a bounding box that merely overlaps', () => {
    const box = { west: 19.9, south: 9.9, east: 20.1, north: 10.1 };
    // A first-level division's own record: it clips the box by a corner and sits
    // hundreds of kilometres away. Overlap admits it; position does not.
    const sprawling = { bbox: { xmin: 15, xmax: 20, ymin: 5, ymax: 10 } };
    expect(rowInBox(sprawling, box)).toBe(true);
    expect(rowPointInBox(sprawling, box)).toBe(false);
    // And a real record inside the box is still kept by both.
    const inside = { bbox: { xmin: 20, xmax: 20, ymin: 10, ymax: 10 } };
    expect(rowInBox(inside, box)).toBe(true);
    expect(rowPointInBox(inside, box)).toBe(true);
  });

  it('attaches typed geographic evidence to every normalised record', () => {
    const record = normalisePlace(
      placeRow({
        id: 'in-1',
        name: 'Harbour Museum',
        lat: 10.05,
        region: 'Selected Region',
        locality: 'Selected City',
      }),
    );
    const evidence = geographyOf(record!);
    expect(evidence).toBeDefined();
    expect(evidence!.countryCode).toBe('AA');
    expect(evidence!.regionNames).toEqual(['Selected Region']);
    expect(evidence!.localityNames).toEqual(['Selected City']);
    /* A printed subdivision name is a name, and is not put in the code field. */
    expect(evidence!.regionCode).toBeUndefined();
  });

  it('routes an ISO 3166-2 subdivision code to the code field, not the name set', () => {
    /*
     * The bridge CS-11 turns on. The divisions layer publishes `AA-AR` into the
     * same field the address path publishes `Adjacent Region` into, and comparing
     * one against the other was reported as a border rather than as two
     * vocabularies that do not meet.
     */
    const record = normalisePlace(
      placeRow({
        id: 'coded',
        name: 'Coded Museum',
        lat: 10.05,
        region: 'AA-AR',
        locality: 'Adjacent Township',
      }),
    );
    const evidence = geographyOf(record!)!;
    expect(evidence.regionCode).toBe('AA-AR');
    expect(evidence.regionNames).toEqual([]);
  });

  it('keeps a record whose address files it somewhere else, and says where', () => {
    /*
     * The adapter no longer refuses anything for not belonging, and that is the
     * correction: a record dropped at pack build is a record nothing downstream
     * can recover, and the same ground is read again for the next traveller. What
     * it does is record the address faithfully — which is what the overlay then
     * excludes it on, per trip.
     */
    const record = normalisePlace(
      placeRow({
        id: 'out-1',
        name: 'Township Auto Parts',
        lat: 11.44,
        region: 'Adjacent Region',
        locality: 'Adjacent Township',
        category: 'automotive_parts',
      }),
    );
    expect(record).not.toBeNull();
    expect(geographyOf(record!)!.regionNames).toEqual(['Adjacent Region']);
  });

  it('keeps an administrative record with its parent chain, because it is the evidence', () => {
    const division = layerById('divisions')!.normalize(
      {
        id: 'div-adjacent',
        names: { primary: 'Adjacent Region' },
        subtype: 'region',
        country: 'AA',
        region: 'AA-AR',
        sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0' }],
        bbox: { xmin: 19.5, xmax: 20.5, ymin: 11, ymax: 12 },
      },
      {
        layerId: 'divisions',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    expect(division).not.toBeNull();
    expect(division!.planningRole).toBe('administrative');
    expect(geographyOf(division!)!.regionCode).toBe('AA-AR');
  });

  it('leaves evidence empty rather than inventing it when the source published none', () => {
    const record = layerById('places')!.normalize(
      {
        id: 'bare',
        names: { primary: 'Unplaced Viewpoint' },
        taxonomy: { primary: 'viewpoint', hierarchy: ['geographic_entities', 'viewpoint'] },
        sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: 'bare' }],
        bbox: { xmin: 20, xmax: 20, ymin: 10.05, ymax: 10.05 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    const evidence = geographyOf(record!)!;
    expect(evidence.countryCode).toBeUndefined();
    expect(evidence.localityNames).toEqual([]);
    expect(evidence.divisionIds).toEqual([]);
  });
});

function geographyOf(record: SourceRecord): GeographicEvidence | undefined {
  return (record as SourceRecord & { geography?: GeographicEvidence }).geography;
}
