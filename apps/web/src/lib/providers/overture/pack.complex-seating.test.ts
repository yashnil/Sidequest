import { describe, expect, it, vi } from 'vitest';
import { geographicScopeSchema, type RegionPack, type SourceRecord } from '@sidequest/core';
import {
  COMPLEX_MEMBER_RADIUS_METRES,
  GroundNamesakeLedger,
  complexSeatLiftsFor,
  createOverturePackProvider,
  groundAttestationKeysOf,
  type NamesakeSite,
} from './pack';
import type { scanFile } from './scan';

/**
 * CONTAINER SEATING — WHERE A FEATURE COMPLEX'S SEAT-CLAIM LANDS.
 *
 * The measured failure class, seen on two live dense metropolises: the ground
 * attests a feature *complex* loudly — a dozen records carry its name, the
 * knowledge base knows it — while the one record that IS the complex either
 * sits at the bottom of an evidence-blind tie tier (its sprawling-site source
 * confidence reads lower than a storefront's) or was never held at all (a
 * weight-zero service kind, evicted by the residual pen before the drain). The
 * pack then keeps the complex's moat, its reservoir and a patch of scrub, and
 * no record a traveller could recognise.
 *
 * Two channels close it, and both are pinned here because neither had a test:
 *
 * - the *target* channel reaches a surviving named subject through its joined
 *   renderings (a primary of the shape `<name> (<other rendering>)` is a key
 *   no namesake can embed whole);
 * - the *site* channel (`complexSeatLiftsFor`) lands the claim of a subject
 *   whose record could not be held on the strongest surviving record standing
 *   inside the complex — geometry and naming only, never a place name.
 */

function packRecord(overrides: Partial<SourceRecord> & { id: string }): SourceRecord {
  return {
    layerId: 'places',
    sourceId: overrides.id,
    name: overrides.id,
    alternateNames: [],
    coordinates: { lat: 40.701, lng: -74.021 },
    sourceCategory: 'temple',
    sourceCategoryPath: ['cultural_and_historic', 'temple'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.9 }],
    cellId: 'g-1-1',
    ...overrides,
  };
}

/** Metres north of the reference point, as a latitude offset. */
const north = (metres: number): number => 40.701 + metres / 111_320;

describe('a complex’s seat-claim lands where it can still be carried', () => {
  const site: NamesakeSite = {
    id: 'ghost-subject',
    key: 'ironholdbeacon',
    lat: 40.701,
    lng: -74.021,
    nearWitnesses: 3,
  };

  it('lands on the strongest surviving member when the named subject’s record is gone', () => {
    /* The traveller-visitable face of the complex: rated, inside the block. */
    const deck = packRecord({
      id: 'deck',
      coordinates: { lat: north(100), lng: -74.021 },
      sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.6 }],
    });
    /*
     * The contained fragment the live pack kept instead: nearer than the deck,
     * more confident, and a weaker kind of experience — a moat is not the
     * castle. It must lose to the strongest member, never win on proximity.
     */
    const fragment = packRecord({
      id: 'fragment',
      sourceCategory: 'lake',
      sourceCategoryPath: ['geographic_entities', 'water_feature', 'lake'],
      planningRole: 'outdoor',
      coordinates: { lat: north(40), lng: -74.021 },
      sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 }],
    });
    /* A patch of scrub: rank zero, seats nothing however close it stands. */
    const scrub = packRecord({
      id: 'scrub',
      sourceCategory: 'moat',
      sourceCategoryPath: [],
      planningRole: 'excluded',
      coordinates: { lat: north(30), lng: -74.021 },
    });
    /* A stranger across the street: stronger than the deck, outside the block. */
    const stranger = packRecord({
      id: 'stranger',
      coordinates: { lat: north(COMPLEX_MEMBER_RADIUS_METRES + 250), lng: -74.021 },
      sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 }],
    });

    const lifted = complexSeatLiftsFor({
      collected: [deck, fragment, scrub, stranger],
      attested: new Set<string>(),
      namesakeSites: [site],
    });
    expect([...lifted.keys()]).toEqual(['deck']);
    /* The lift carries the site's own witness count, for the tie ordering. */
    expect(lifted.get('deck')).toBe(site.nearWitnesses);
  });

  it('prefers the named subject’s own surviving record, at the donor floor, over any member', () => {
    /* The subject survives to the drain as a weight-zero service kind. */
    const own = packRecord({
      id: 'ghost-subject',
      sourceCategory: 'atm',
      sourceCategoryPath: ['financial_service', 'atm'],
      planningRole: 'excluded',
    });
    const deck = packRecord({ id: 'deck', coordinates: { lat: north(100), lng: -74.021 } });

    const lifted = complexSeatLiftsFor({
      collected: [own, deck],
      attested: new Set<string>(),
      namesakeSites: [site],
    });
    /* Donor evidence, never a synthetic experience — and never the neighbour. */
    expect([...lifted.keys()]).toEqual(['ghost-subject']);
    expect(lifted.get('ghost-subject')).toBe(site.nearWitnesses);
  });

  it('adds nothing for a rated named subject — the target channel already carries it', () => {
    const own = packRecord({ id: 'ghost-subject' });
    const deck = packRecord({ id: 'deck', coordinates: { lat: north(100), lng: -74.021 } });
    const lifted = complexSeatLiftsFor({
      collected: [own, deck],
      attested: new Set(['already-attested']),
      namesakeSites: [site],
    });
    expect([...lifted.keys()]).toEqual(['already-attested']);
  });

  it('breaks a dead tie deterministically, so the pack hash cannot depend on arrival order', () => {
    const twinA = packRecord({ id: 'aaa-twin', coordinates: { lat: north(90), lng: -74.021 } });
    const twinB = packRecord({ id: 'bbb-twin', coordinates: { lat: north(80), lng: -74.021 } });
    const lifted = complexSeatLiftsFor({
      collected: [twinB, twinA],
      attested: new Set<string>(),
      namesakeSites: [site],
    });
    expect([...lifted.keys()]).toEqual(['aaa-twin']);
  });
});

describe('the ledger reports the name-giver sites the pens could not keep', () => {
  const beacon = packRecord({
    id: 'beacon',
    name: 'Ironhold Beacon',
    sourceCategory: 'atm',
    sourceCategoryPath: ['financial_service', 'atm'],
    planningRole: 'excluded',
    sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.55 }],
  });
  const witnesses = ['Gate', 'Kiosk', 'Tram Stop'].map((suffix, index) =>
    packRecord({
      id: `witness-${index}`,
      name: `Ironhold Beacon ${suffix}`,
      planningRole: 'support',
      coordinates: { lat: north(60 + index * 10), lng: -74.021 },
    }),
  );

  it('reports the site of a record no pen could hold, so the claim outlives the record', () => {
    const ledger = new GroundNamesakeLedger();
    for (const record of [beacon, ...witnesses]) ledger.note(record);
    /* The subject's record is gone by the drain: it is not among the records. */
    const verdict = ledger.attestations([]);
    expect(verdict.attested).toEqual(new Set());
    expect(verdict.namesakeSites).toEqual([
      { id: 'beacon', key: 'ironholdbeacon', lat: 40.701, lng: -74.021, nearWitnesses: 3 },
    ]);
  });

  it('refuses a brand: entries wearing one key apart from each other found no complex', () => {
    const branch = packRecord({
      id: 'branch',
      name: 'Ironhold Beacon',
      sourceCategory: 'atm',
      sourceCategoryPath: ['financial_service', 'atm'],
      planningRole: 'excluded',
      /* The same name again, roughly 700 m away: a chain, not a place. */
      coordinates: { lat: north(700), lng: -74.021 },
    });
    const ledger = new GroundNamesakeLedger();
    for (const record of [beacon, branch, ...witnesses]) ledger.note(record);
    expect(ledger.attestations([]).namesakeSites).toEqual([]);
  });

  it('never lets a way to reach somewhere found a complex', () => {
    const station = packRecord({
      id: 'station',
      name: 'Ironhold Beacon',
      sourceCategory: 'railway_station',
      sourceCategoryPath: ['travel_and_transportation', 'railway_station'],
      planningRole: 'gateway',
    });
    const ledger = new GroundNamesakeLedger();
    for (const record of [station, ...witnesses]) ledger.note(record);
    expect(ledger.attestations([]).namesakeSites).toEqual([]);
  });
});

describe('a parenthesised joined primary attests through either rendering', () => {
  /*
   * The second measured metropolis's shape: the destination's most famous
   * complex publishes its own record as `<name> (<other rendering>)` — a
   * single key neither the namesakes inside its walls nor the guard's
   * arithmetic can ever embed whole. Both renderings must be audible keys.
   */
  const joined = packRecord({
    id: 'joined-subject',
    name: 'Basalt Redoubt (Reducto de Basalto)',
    sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.6 }],
  });

  it('yields each rendering as a key of its own', () => {
    const keys = groundAttestationKeysOf(joined);
    expect(keys).toContain('basaltredoubt');
    expect(keys).toContain('reductodebasalto');
  });

  it('lets the ground attest the record through one rendering alone', () => {
    const ledger = new GroundNamesakeLedger();
    const witnesses = ['North Gate', 'Kiosk'].map((suffix, index) =>
      packRecord({
        id: `paren-witness-${index}`,
        name: `Basalt Redoubt ${suffix}`,
        planningRole: 'support',
        coordinates: { lat: north(50 + index * 10), lng: -74.021 },
      }),
    );
    for (const record of [joined, ...witnesses]) ledger.note(record);
    expect(ledger.attestedAmong([joined])).toEqual(new Set(['joined-subject']));
  });
});

/**
 * THE WIRING, THROUGH THE WHOLE PROVIDER.
 *
 * The unit tests above cannot fail if the drain never calls the lift — the
 * exact way this mechanism was originally lost. So the provider is driven end
 * to end: the subject arrives as a weight-zero service kind at the bottom of a
 * residual pen deep enough to evict it, the ground names it from three sides,
 * and the complex's one rated member sits at the bottom of a visitable tie
 * tier a retention squeeze will flush. Only the site channel can seat the
 * member; a twin with identical evidence and no complex around it is the
 * control that proves the squeeze is real.
 */
describe('container seating, wired through the built pack', () => {
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

  it('seats the complex’s surviving member when the named subject could never be held', async () => {
    const RESIDUAL_CROWD = 3_600;
    const VISITABLE_CROWD = 300;
    const complexScan = (async (request: Parameters<typeof scanFile>[0]) => {
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
      const ATM = { primary: 'atm', hierarchy: ['financial_service', 'atm'] };
      const TEMPLE = { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] };

      /*
       * The named subject: a weight-zero service kind at the lowest confidence
       * of a residual pen that holds thousands — gone before the drain, its
       * name and position surviving only in the ledger.
       */
      place('subject-1', 'Ironhold Beacon', ATM, 0.55, 40.701, -74.021);
      for (let index = 0; index < RESIDUAL_CROWD; index += 1) {
        /* Zero-padded names: no crowd name embeds another, so nothing here
         * can attest anything by accident. */
        const label = String(index).padStart(4, '0');
        place(`crowd-r-${label}`, `Cash Point ${label}`, ATM, 0.99, 40.7005 + (index % 7) * 0.0001, -74.0215);
      }
      /* The ground's testimony: three commodity rows wearing the subject's name. */
      for (const [index, suffix] of ['North Gate', 'Kiosk', 'Tram Stop'].entries()) {
        place(`witness-${index}`, `Ironhold Beacon ${suffix}`, ATM, 0.9, 40.7012 + index * 0.0001, -74.0211);
      }
      /*
       * The complex's rated member, 100 m inside the block, and its twin with
       * identical evidence standing among the visitable crowd a kilometre
       * away. Both sit at the bottom of the same tie tier; only one of them
       * stands inside a complex the ground attests.
       *
       * The crowd shares the member's retention quadrant deliberately: a
       * quieter quadrant would seat the member through the spatial-spread
       * pass and this test would stop testing the lift at all.
       */
      place('member-1', 'Cloudreach Deck', TEMPLE, 0.6, 40.7019, -74.021);
      place('twin-1', 'Duskwatch Deck', TEMPLE, 0.6, 40.7099, -74.0216);
      for (let index = 0; index < VISITABLE_CROWD; index += 1) {
        const label = String(index).padStart(4, '0');
        place(`crowd-v-${label}`, `Wayside Shrine ${label}`, TEMPLE, 0.99, 40.71 + (index % 7) * 0.0001, -74.0215);
      }
      return { rows: [], counters: request.counters, stoppedBecause: 'complete' as const };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl: complexScan,
      /* A squeeze, so a seat has to be won rather than left over. */
      budget: { maxFeaturesRetained: 200 },
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
    expect(outcome.kind === 'ready' || outcome.kind === 'partial').toBe(true);
    const pack = (outcome as { pack: RegionPack }).pack;
    const places = pack.layers.find((layer) => layer.id === 'places')!;
    const names = places.records.map((record) => record.name);

    /* The squeeze is real: most of the crowd is not kept... */
    expect(places.records.length).toBeLessThan(VISITABLE_CROWD);
    /* ...the subject's own record genuinely could not be held... */
    expect(names).not.toContain('Ironhold Beacon');
    /* ...its twin-without-a-complex loses exactly as the tie tier dictates... */
    expect(names).not.toContain('Duskwatch Deck');
    /* ...and the complex's member seats, carried by the site channel alone. */
    expect(names).toContain('Cloudreach Deck');
  }, 30_000);
});
