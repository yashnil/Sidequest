import { describe, expect, it, vi } from 'vitest';
import { geographicScopeSchema, type RegionPack, type SourceRecord } from '@sidequest/core';
import {
  GroundNamesakeLedger,
  complexSeatLiftsFor,
  createOverturePackProvider,
  recallPriorityOf,
  type NamesakeSite,
} from './pack';
import type { scanFile } from './scan';

/**
 * GRADED GROUND NAMESAKES — THE ORDERING INSIDE A SIGNIFICANCE TIE TIER.
 *
 * The measured failure class, from a live dense-metro build on a fresh source
 * release: the significance model ties a cell's canon-grade records with
 * hundreds of same-kind neighbours — same weight, same absent evidence — and
 * the order inside the tier fell straight to per-provider source confidence,
 * which reads *lower* for a sprawling landmark than for the storefronts
 * around it. The ground itself publishes a graded signal the pipeline was
 * flattening to one bit at two witnesses: the city's headline temple had
 * eight distinct records embedding its name inside the radius and lost its
 * seat to two-witness neighbours; the national museum's single guard-passing
 * witness rounded down to nothing and it lost a forty-record confidence
 * lottery to a small gallery at 0.99.
 *
 * These tests pin the graded read end to end: the count orders the tier, one
 * witness is already ordering evidence (below the attestation gate, which
 * still protects the *score*), and a donor-floor name-giver is carried by the
 * site channel with the site's own strength.
 */

const scope = geographicScopeSchema.parse({
  schemaVersion: 1,
  revision: 1,
  destinationCandidateId: 'relation/1',
  destinationName: 'Testville',
  destinationEntityType: 'city',
  breadth: 'city',
  center: { lat: 40.7, lng: -74 },
  bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
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

const ROOT = {
  type: 'Catalog',
  id: 'Test Releases',
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
  links: [{ rel: 'child', href: './places/catalog.json' }],
};
const catalogueFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.endsWith('collection.json')
    ? { links: [{ rel: 'item', href: './00000/00000.json' }] }
    : url.endsWith('/catalog.json') && url.includes('2026-07-22.0')
      ? RELEASE
      : url.endsWith('/catalog.json')
        ? ROOT
        : {
            bbox: [-74.2, 40.5, -73.8, 40.9],
            properties: { 'table:row_count': 1_000_000 },
            assets: {
              data: {
                href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/part-0.zstd.parquet',
                type: 'application/vnd.apache.parquet',
              },
            },
          };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

describe('a tie tier orders on the ground’s graded namesake count, above source confidence', () => {
  /**
   * The national-museum shape, in synthetic geography. One cell, one kind,
   * forty-one records the significance model scores identically. The subject
   * has one nearby record wearing its name — below the attestation gate, so
   * its *score* is not lifted — and the lowest source confidence of the tier.
   * The crowd has no namesakes and confidence 0.99. Under a retention squeeze
   * the crowd fills every rank-ordered seat, so only the graded count can
   * seat the subject; its twin with identical confidence and no namesake is
   * the control that proves the count decided, not something else.
   */
  it('seats the one record of the tier the ground names, and not its unnamed twin', async () => {
    const MUSEUM = { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] };
    const CAFE = { primary: 'cafe', hierarchy: ['eat_and_drink', 'cafe'] };
    const gradedScan = (async (request: Parameters<typeof scanFile>[0]) => {
      const feed = (row: Record<string, unknown>): void => {
        const accepted = request.accept(row);
        if (accepted !== null) request.sink?.add(accepted as SourceRecord);
      };
      const place = (
        id: string,
        name: string,
        taxonomy: { primary: string; hierarchy: string[] },
        confidence: number,
        lat: number,
        lng: number,
      ): void =>
        feed({
          id,
          names: { primary: name },
          taxonomy,
          operating_status: 'open',
          sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: id, confidence }],
          bbox: { xmin: lng, xmax: lng, ymin: lat, ymax: lat },
        });

      /* The subject: bottom of the tier on confidence, named once by the ground. */
      place('subject-1', 'Grand Archive', MUSEUM, 0.84, 40.701, -74.021);
      /* One commodity record wearing its name, ~100 m away: 1 < the gate of 2. */
      place('witness-1', 'Grand Archive Cafe', CAFE, 0.9, 40.7019, -74.021);
      /* The control: identical evidence, no namesake anywhere. */
      place('twin-1', 'Plain Annex', MUSEUM, 0.84, 40.7011, -74.0212);
      /*
       * The tier: same kind, same score, higher confidence, no namesakes —
       * and in the same retention quadrant as the subject, so the
       * spatial-spread pass cannot seat the subject by accident.
       */
      for (let index = 0; index < 39; index += 1) {
        const label = String(index).padStart(4, '0');
        place(`crowd-${label}`, `Vault Gallery ${label}`, MUSEUM, 0.99, 40.7012 + (index % 7) * 0.0001, -74.0215);
      }
      return { rows: [], counters: request.counters, stoppedBecause: 'complete' as const };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl: gradedScan,
      /* A squeeze: 20 places seats for a 41-record tier, so seats are won. */
      budget: { maxFeaturesRetained: 44 },
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
    expect(outcome.kind === 'ready' || outcome.kind === 'partial').toBe(true);
    const pack = (outcome as { pack: RegionPack }).pack;
    const places = pack.layers.find((layer) => layer.id === 'places')!;
    const names = places.records.map((record) => record.name);

    /* The squeeze is real: most of the tier is not kept... */
    expect(names.filter((name) => name.startsWith('Vault Gallery')).length).toBeLessThan(39);
    /* ...the control twin loses exactly as the confidence order dictates... */
    expect(names).not.toContain('Plain Annex');
    /* ...and the one record the ground names holds a seat. */
    expect(names).toContain('Grand Archive');
  });
});

describe('the verdict reports the graded count, gate untouched', () => {
  it('counts one guard-passing witness without attesting on it', () => {
    const record = (overrides: Partial<SourceRecord> & { id: string }): SourceRecord => ({
      layerId: 'places',
      sourceId: overrides.id,
      name: overrides.id,
      alternateNames: [],
      coordinates: { lat: 40.701, lng: -74.021 },
      sourceCategory: 'museum',
      sourceCategoryPath: ['arts_and_entertainment', 'museum'],
      planningRole: 'attraction',
      websiteCandidates: [],
      containment: { divisionIds: [] },
      attributes: {},
      sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.9 }],
      cellId: 'g-1-1',
      ...overrides,
    });
    const subject = record({ id: 'subject', name: 'Grand Archive' });
    const witness = record({
      id: 'witness',
      name: 'Grand Archive Cafe',
      planningRole: 'food',
      coordinates: { lat: 40.7019, lng: -74.021 },
    });
    const ledger = new GroundNamesakeLedger();
    ledger.note(subject);
    ledger.note(witness);
    const verdict = ledger.attestations([subject]);
    /* One witness orders; it never lifts the score. */
    expect(verdict.witnessesByTarget.get('subject')).toBe(1);
    expect(verdict.attested).toEqual(new Set());
  });
});

describe('a donor-floor name-giver is carried by the site channel', () => {
  /**
   * The second measured shape: a destination's most recognisable structure
   * arrives under a kind the model rates zero, holds a knowledge-base entry —
   * so it ranks at the donor floor, *above* zero — and the old `<= 0` test
   * read that floor as a rating and gave the nine-witness site claim to
   * nobody. A donor-floor rank is retention's own bookkeeping, not a rating.
   */
  it('lands the site claim on a knowledge-base donor at the floor, with the site’s strength', () => {
    const own: SourceRecord = {
      layerId: 'infrastructure',
      sourceId: 'beacon',
      id: 'beacon',
      name: 'Ironhold Beacon',
      alternateNames: [],
      coordinates: { lat: 40.701, lng: -74.021 },
      sourceCategory: 'utility_pole',
      sourceCategoryPath: [],
      planningRole: 'infrastructure',
      websiteCandidates: [],
      wikidataId: 'Q99999',
      containment: { divisionIds: [] },
      attributes: {},
      sources: [{ dataset: 'osm', licenceId: 'ODbL-1.0' }],
      cellId: 'g-1-1',
    };
    /* The floor, not a rating: the model scores the kind zero. */
    expect(recallPriorityOf(own)).toBeGreaterThan(0);
    expect(recallPriorityOf(own)).toBeLessThan(0.01);

    const site: NamesakeSite = {
      id: 'beacon',
      key: 'ironholdbeacon',
      lat: 40.701,
      lng: -74.021,
      nearWitnesses: 9,
    };
    const lifted = complexSeatLiftsFor({
      collected: [own],
      attested: new Set<string>(),
      namesakeSites: [site],
    });
    expect(lifted.has('beacon')).toBe(true);
    expect(lifted.get('beacon')).toBe(9);
  });
});
