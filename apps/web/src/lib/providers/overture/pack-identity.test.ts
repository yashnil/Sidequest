import { describe, expect, it, vi } from 'vitest';
import { geographicScopeSchema, type RegionPack, type SourceRecord } from '@sidequest/core';
import {
  createOverturePackProvider,
  destinationDivisionRecordIds,
  recallPriorityOf,
  retainAcrossCells,
} from './pack';
import type { ScanCounters, scanFile } from './scan';

/**
 * THE ONE RECORD A RETENTION BUDGET MAY NOT SPEND.
 *
 * Everything in `retainAcrossCells` is about which of many comparable records
 * deserve a scarce seat, and it does that job well. What it had no concept of is
 * a record that is not comparable to anything: the division that **is** the
 * destination, from which every membership verdict in the pack is decided.
 *
 * Measured on the Tokyo pack stored on this machine: the divisions layer read
 * 800 features and kept its cap of 320 — 269 neighbourhoods, 47 microhoods, 3
 * counties and one locality. The scan read the destination's own division record
 * sitting at the exact scope centre; retention ranked it on the same
 * significance model every place is ranked on and dropped it. Nothing downstream
 * could recover it.
 */

function division(overrides: Partial<SourceRecord> & { id: string }): SourceRecord {
  return {
    layerId: 'divisions',
    sourceId: overrides.id,
    name: overrides.id,
    alternateNames: [],
    coordinates: { lat: 35.6768, lng: 139.7638 },
    sourceCategory: 'neighborhood',
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: { subtype: 'neighborhood' },
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
    cellId: 'g-0-0',
    ...overrides,
    id: `divisions:${overrides.id}`,
  };
}

/** Tokyo's own chain, verbatim: country → region → county → ward → Tokyo. */
const TOKYO_CHAIN = ['country-jp', 'region-tokyo', 'county-chiyoda', 'ward-chiyoda', 'tokyo'];

const destination = division({
  id: 'tokyo',
  name: '東京都',
  alternateNames: ['Tokyo'],
  sourceCategory: 'locality',
  attributes: { subtype: 'locality' },
  containment: { countryCode: 'JP', regionName: 'JP-13', localityName: '東京都', divisionIds: TOKYO_CHAIN },
});

const ward = division({
  id: 'ward-chiyoda',
  name: '千代田区',
  sourceCategory: 'locality',
  attributes: { subtype: 'locality' },
  containment: { divisionIds: ['country-jp', 'region-tokyo', 'county-chiyoda', 'ward-chiyoda'] },
});

/** Ordinary retention fodder: leaf polygons, of which a dense city has hundreds. */
const neighbourhoods = Array.from({ length: 6 }, (_, index) =>
  division({ id: `hood-${index}`, containment: { divisionIds: ['country-jp', 'region-tokyo', `hood-${index}`] } }),
);

describe('the destination’s own administrative records', () => {
  it('finds the destination and the ancestry it is recognised through', () => {
    const found = destinationDivisionRecordIds(
      [...neighbourhoods, ward, destination],
      new Set(['tokyo']),
    );
    /*
     * The ward is pinned because the destination's *own published chain* names
     * it — a division is recognised through the chain it publishes, so the
     * records in that chain are the evidence, not neighbours that happen to be
     * close.
     */
    expect([...found].sort()).toEqual(['divisions:tokyo', 'divisions:ward-chiyoda']);
  });

  it('pins nothing when the scope never established a division identity', () => {
    /* A geocoded destination. Retention behaves exactly as it did before. */
    expect(destinationDivisionRecordIds([...neighbourhoods, destination], new Set())).toEqual(
      new Set(),
    );
  });

  it('pins nothing when the destination’s own record was never read', () => {
    /*
     * Without the destination itself there is no published chain to read, so
     * nothing is promoted on the strength of a shared ancestor id — which would
     * otherwise pin every ward of the city.
     */
    expect(destinationDivisionRecordIds(neighbourhoods, new Set(['tokyo']))).toEqual(new Set());
  });
});

describe('retention', () => {
  it('drops the destination’s own division record when it is ranked like a candidate', () => {
    /**
     * The live failure, in miniature and deliberately honest about its cause:
     * the destination's record does not out-rank a neighbourhood polygon on a
     * significance model, because significance is not what it is for.
     */
    expect(recallPriorityOf(destination)).toBeLessThanOrEqual(recallPriorityOf(neighbourhoods[0]!));

    const { kept } = retainAcrossCells({
      records: [...neighbourhoods, destination],
      retentionCap: 4,
      perCellCap: 4,
    });
    expect(kept).toHaveLength(4);
    expect(kept.map((record) => record.id)).not.toContain('divisions:tokyo');
  });

  it('keeps it when the scope says which division the destination is', () => {
    const { kept } = retainAcrossCells({
      records: [...neighbourhoods, destination],
      retentionCap: 4,
      perCellCap: 4,
      pinned: destinationDivisionRecordIds([...neighbourhoods, destination], new Set(['tokyo'])),
    });
    expect(kept.map((record) => record.id)).toContain('divisions:tokyo');
  });

  it('does not make room for it by evicting something a traveller would have seen', () => {
    /*
     * A pin is an exemption, not a priority boost. Spending the cap on the
     * destination would trade a membership answer for a place on the board, and
     * a pack is meant to hold both.
     */
    const contested = retainAcrossCells({
      records: neighbourhoods,
      retentionCap: 4,
      perCellCap: 4,
    });
    const withPin = retainAcrossCells({
      records: [...neighbourhoods, destination],
      retentionCap: 4,
      perCellCap: 4,
      pinned: destinationDivisionRecordIds([...neighbourhoods, destination], new Set(['tokyo'])),
    });
    for (const record of contested.kept) {
      expect(withPin.kept.map((kept) => kept.id)).toContain(record.id);
    }
    expect(withPin.kept).toHaveLength(contested.kept.length + 1);
  });
});

/**
 * THE SAME PROPERTY, THROUGH THE BUILD RATHER THAN THROUGH THE HELPER.
 *
 * `retainAcrossCells` taking a pinned set is worth nothing if the extraction
 * never assembles one, and that wiring has no other test: `extractLayer` is not
 * exported and the only way at it is a whole pack build. So this drives the
 * provider with an injected catalogue and an injected scan — no network, no
 * parquet — over a divisions layer dense enough that the destination's own
 * record loses its seat exactly as it did on the live Tokyo build.
 */
describe('the pack build', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ROOT = {
    type: 'Catalog',
    latest: '2026-07-22.0',
    links: [
      { rel: 'root', href: './catalog.json' },
      { rel: 'child', href: './2026-07-22.0/catalog.json', latest: true },
    ],
  };
  const RELEASE = {
    id: '2026-07-22.0',
    'release:version': '2026-07-22.0',
    'schema:version': null,
    links: [{ rel: 'child', href: './divisions/catalog.json' }],
  };

  const catalogueFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
    if (url.endsWith('/catalog.json')) return jsonResponse(ROOT);
    if (url.endsWith('collection.json')) {
      return jsonResponse({ links: [{ rel: 'item', href: './00000/00000.json' }] });
    }
    return jsonResponse({
      bbox: [-74.2, 40.5, -73.8, 40.9],
      properties: { 'table:row_count': 1_000_000 },
      assets: {
        data: {
          href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/part-0.zstd.parquet',
          type: 'application/vnd.apache.parquet',
        },
      },
    });
  });

  function scopeWith(divisionIds: readonly string[]) {
    return geographicScopeSchema.parse({
      schemaVersion: 1,
      revision: 1,
      destinationCandidateId: 'overture:the-city',
      destinationName: 'Testville',
      destinationEntityType: 'city',
      breadth: 'city',
      center: { lat: 40.7, lng: -74 },
      administrative: { countryCode: 'US', aliases: [], hierarchy: [], divisionIds },
      timeZones: ['UTC'],
      shape: {
        kind: 'bounds',
        bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
      },
      transport: {
        primaryMode: 'drive',
        allowedModes: ['drive', 'walk'],
        carAvailable: true,
        acceptsWaterOrAirTransfers: true,
        basis: 'default',
        note: 'Test transport.',
      },
      maxBaseChanges: 0,
      nights: 4,
      rationale: 'A test scope.',
      confidence: { level: 'high', signals: [], note: 'Test.' },
      confirmedByUser: true,
    });
  }

  /**
   * A divisions layer with far more leaves than the cap, and the destination
   * among them.
   *
   * The destination is emitted last, which is the live shape: the record sitting
   * at the scope centre is one row of eight hundred, and no ordering the reader
   * applies puts it first.
   */
  function denseDivisionsScan(): typeof scanFile {
    const GROUPS = 12;
    const ROWS_PER_GROUP = 120;
    return (async <T,>(request: {
      budget: { maxRowGroups: number; maxFeaturesRetained: number };
      counters: ScanCounters;
      accept: (row: Record<string, unknown>) => T | null;
    }) => {
      const rows: T[] = [];
      const emit = (row: Record<string, unknown>): void => {
        const accepted = request.accept(row);
        if (accepted !== null) rows.push(accepted);
      };
      for (let group = 0; group < GROUPS; group += 1) {
        if (request.counters.rowGroupsRead >= request.budget.maxRowGroups) break;
        request.counters.rowGroupsRead += 1;
        request.counters.featuresRead += ROWS_PER_GROUP;
        const lat = 40.61 + Math.floor(group / 4) * 0.05;
        for (let index = 0; index < ROWS_PER_GROUP; index += 1) {
          emit({
            id: `hood-${group}-${index}`,
            names: { primary: `Neighbourhood ${group}-${index}` },
            subtype: 'neighborhood',
            country: 'US',
            hierarchies: [[{ division_id: 'the-region', subtype: 'region', name: 'Test Region' }]],
            sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0', record_id: `h${group}-${index}` }],
            bbox: {
              xmin: -74.05 + (index % 20) * 0.004,
              xmax: -74.05 + (index % 20) * 0.004,
              ymin: lat,
              ymax: lat,
            },
          });
        }
      }
      /*
       * The destination's own division record — read last, in the same corner
       * as the leaves, and worth everything.
       *
       * Sharing their cell is the whole point: retention distributes seats per
       * cell before it ranks, so a destination alone in a quiet cell would be
       * kept by the distribution rather than by anything under test here.
       */
      emit({
        id: 'the-city',
        names: { primary: 'Testville' },
        subtype: 'locality',
        country: 'US',
        hierarchies: [
          [
            { division_id: 'the-region', subtype: 'region', name: 'Test Region' },
            { division_id: 'the-city', subtype: 'locality', name: 'Testville' },
          ],
        ],
        sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0', record_id: 'city' }],
        bbox: { xmin: -74.05, xmax: -74.05, ymin: 40.61, ymax: 40.61 },
      });
      return { rows, counters: request.counters, stoppedBecause: 'complete' };
    }) as unknown as typeof scanFile;
  }

  async function divisionsOf(divisionIds: readonly string[]): Promise<string[]> {
    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl: denseDivisionsScan(),
      /*
       * A budget the divisions layer genuinely exhausts, which is the live
       * condition: the Tokyo build read 800 division features and kept its cap.
       * With a cap this layer never reaches, retention is not the thing under
       * test and the assertion below would pass for the wrong reason.
       */
      budget: { maxFeaturesRetained: 900 },
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const outcome = await provider.getPack({
      scope: scopeWith(divisionIds),
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const pack = (outcome as { pack: RegionPack }).pack;
    return pack.layers.find((layer) => layer.id === 'divisions')!.records.map((record) => record.id);
  }

  it('loses the destination’s own division record to the cap when nobody says which it is', async () => {
    const kept = await divisionsOf([]);
    /* The cap was reached, so a seat really was contested. */
    expect(kept.length).toBe(72);
    expect(kept).not.toContain('divisions:the-city');
  });

  it('keeps it once the scope declares which division the destination is', async () => {
    const kept = await divisionsOf(['the-city']);
    expect(kept).toContain('divisions:the-city');
  });
});
