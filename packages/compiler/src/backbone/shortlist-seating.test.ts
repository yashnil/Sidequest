import { describe, expect, it } from 'vitest';
import {
  geographicScopeSchema,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import { balanceAcrossAreas } from './balance';
import {
  buildInventory,
  carryMembershipToCollapseSurvivors,
  groundNamesakeAttestations,
  UNWITNESSED_KIND_SEATS,
  WITNESS_CHANNEL_SILENT_TAG,
} from './inventory';
import { buildTripScopeOverlay, decisionFor } from './overlay';
import { partitionScope } from './partition';

/**
 * THE SHORTLIST MUST KEEP THE CANON IT ADMITS.
 *
 * Three seating defects measured on stored dense-metro packs, each of which
 * flushed eligible canonical anchors at the shortlist cut while records with
 * strictly weaker claims held seats:
 *
 * 1. **The fold electing a corpse.** `foldAdjacentFragments` ran over every
 *    record including the ones the linker collapse had already superseded, and
 *    where the better-evidenced fragment of a pair *was* the superseded twin,
 *    the fold kept the corpse and refused the survivor — so the entity was
 *    deleted twice over and nothing of it reached any pool. Measured on three
 *    separate landmarks across two stored §29-A packs.
 *
 * 2. **The degraded tier's seats decided by id.** Records held for the
 *    witness-outage admission are all evidence-starved by construction, so
 *    they tie at the kind prior and the per-kind seats went to whichever
 *    records carried lexically low UUIDs. The ground's own namesakes — other
 *    records named after the place, the one channel that separates a landmark
 *    from six hundred neighbourhood twins — were audible at retention
 *    (`GroundNamesakeLedger`) and inaudible at seat time.
 *
 * 3. **Article-tie obscura beating locally-named landmarks.** In the witnessed
 *    pools an encyclopaedic article is the common case (it is the only channel
 *    the catalogue populates at scale), so canon and obscura tie and the cut
 *    below the tie band was again a UUID lottery.
 *
 * The repair is one channel and one exclusion, both destination-agnostic:
 * ground-namesake attestation is computed over the pack's own records at seat
 * time and feeds the existing `region_namesake` channel (which raises a
 * standing and can never open the witness gate), and the fold no longer
 * considers records the collapse has already superseded.
 */

function scopeFor(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return geographicScopeSchema.parse({
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
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
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
    decidedBy: [],
    confirmedByUser: true,
    ...overrides,
  });
}

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'places:a',
    layerId: 'places',
    sourceId: 'a',
    name: 'Harbour Museum',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  return assemblePack({
    id: 'pack-test',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      {
        id: 'places',
        kind: 'primary_places',
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0',
        records: records.filter((entry) => entry.layerId === 'places'),
        featuresRead: records.length,
        featuresRetained: records.filter((entry) => entry.layerId === 'places').length,
        failedCellIds: [],
      },
      {
        id: 'land',
        kind: 'supplemental_geography',
        catalog: 'test',
        datasetPath: 'base/land',
        licenceId: 'ODbL-1.0',
        records: records.filter((entry) => entry.layerId === 'land'),
        featuresRead: records.length,
        featuresRetained: records.filter((entry) => entry.layerId === 'land').length,
        failedCellIds: [],
      },
    ],
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 1,
      rowGroupsRead: 1,
      bytesTransferred: 1,
      durationMs: 1,
      budgetsExhausted: [],
      layerTimings: [],
    },
    now: new Date('2026-08-11T00:00:00Z'),
  });
}

function inventoryOf(records: SourceRecord[], limits?: Parameters<typeof buildInventory>[0]['limits']) {
  return buildInventory({
    pack: packWith(records),
    scope: scopeFor(),
    ...(limits ? { limits } : {}),
  });
}

/** A place-layer worship building with nothing but its own listing. */
function worshipPlace(suffix: string, lat: number): SourceRecord {
  return record({
    id: `places:worship-${suffix}`,
    sourceId: `worship-${suffix}`,
    name: `Old Quarter Hall ${suffix}`,
    sourceCategory: 'buddhist_place_of_worship',
    sourceCategoryPath: ['cultural_and_historic', 'place_of_worship', 'buddhist_place_of_worship'],
    websiteCandidates: ['https://example.org/hall'],
    coordinates: { lat, lng: -74.0 },
  });
}

/** A supplemental-layer record proving the knowledge-base channel is alive. */
function answeringLandmark(): SourceRecord {
  return record({
    id: 'land:harbour-park',
    layerId: 'land',
    sourceId: 'harbour-park',
    name: 'Harbour Point Park',
    sourceCategory: 'park',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    wikidataId: 'Q7777',
    attributes: { wikipedia: 'aa:Harbour Point Park', leisure: 'park' },
    coordinates: { lat: 40.75, lng: -74.05 },
  });
}

describe('the fold must not elect a record the collapse already superseded', () => {
  /**
   * The measured shape: a place-catalogue record and its supplemental-layer
   * twin — same name, same kind, adjacent — are linked `same_entity` by the
   * pack's own linker. The twin carries the knowledge-base identity; the
   * place record carries the website, the containment and the provenance, so
   * the collapse keeps the place record and the evidence carry hands it the
   * twin's identity. The adjacent-fragment fold then re-ran the same
   * comparison blind to the collapse, elected the (superseded) twin as the
   * better-evidenced fragment, and refused the survivor — so *nothing* of the
   * entity reached any pool: the twin died as a duplicate and the survivor
   * died as a fold. Three canonical landmarks on two stored packs died in
   * exactly this intersection.
   */
  it('seats the collapse survivor of an evidence-carrying adjacent twin', () => {
    const survivor = record({
      id: 'places:riverside-gardens',
      sourceId: 'riverside-gardens',
      name: 'Riverside Gardens',
      sourceCategory: 'park',
      sourceCategoryPath: ['attractions_and_activities', 'park'],
      planningRole: 'outdoor',
      websiteCandidates: ['https://example.org/riverside'],
      coordinates: { lat: 40.71, lng: -74.0 },
      sources: [
        { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'secondary', licenceId: 'CDLA-Permissive-2.0' },
      ],
    });
    const twin = record({
      id: 'land:riverside-gardens-poly',
      layerId: 'land',
      sourceId: 'riverside-gardens-poly',
      name: 'Riverside Gardens',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q4242',
      /*
       * The twin carries the posted hours as well as the identity: since the
       * commonplace-notice bound, a park's encyclopaedic notice alone no
       * longer buys rank, and operational visit evidence is an entity fact
       * the collapse must carry to the survivor exactly as the identity is.
       * This fixture proves both transfers at once.
       */
      attributes: {
        wikipedia: 'aa:Riverside Gardens',
        leisure: 'park',
        opening_hours: '09:00-17:00',
      },
      containment: { divisionIds: [] },
      coordinates: { lat: 40.7105, lng: -74.0 },
    });

    const inventory = inventoryOf([survivor, twin]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Riverside Gardens',
    );
    /* The entity must survive: one of its records holds a seat. */
    expect(seated).toBeDefined();
    expect(seated!.place.id).toBe('places:riverside-gardens');
    /* And it carries the identity the collapse established, not kind-only. */
    expect(seated!.place.experienceSignificance).toBeGreaterThan(0.3);
  });
});

describe('ground-namesake attestation orders the seats evidence cannot', () => {
  /** Two nearby records wearing the hall's name inside their own. */
  function namesakeWitnessesFor(suffix: string, lat: number): SourceRecord[] {
    return [
      record({
        id: `places:witness-${suffix}-gate`,
        sourceId: `witness-${suffix}-gate`,
        name: `Old Quarter Hall ${suffix} Gatehouse`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: lat + 0.001, lng: -74.0 },
      }),
      record({
        id: `places:witness-${suffix}-tea`,
        sourceId: `witness-${suffix}-tea`,
        name: `Old Quarter Hall ${suffix} Tea House`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: lat - 0.001, lng: -74.0 },
      }),
    ];
  }

  it('gives a degraded seat to the hall the ground names, not to the lowest id', () => {
    /*
     * Five evidence-starved halls in a witness-silent layer: without the
     * ground channel the per-kind seats go to `a`, `b`, `c` — the id order —
     * and the one hall the surrounding ground is named after ties with the
     * rest and loses. That is the seat lottery the stored-pack funnels
     * measured: the canon at ranks 31, 78 and 80 of 94 inside its own kind.
     */
    const halls = ['a', 'b', 'c', 'd', 'e'].map((suffix, index) =>
      worshipPlace(suffix, 40.7 + index * 0.02),
    );
    const inventory = inventoryOf([
      ...halls,
      ...namesakeWitnessesFor('e', 40.78),
      answeringLandmark(),
    ]);
    const admitted = inventory.candidates
      .map((candidate) => candidate.place.name)
      .filter((name) => /^Old Quarter Hall [a-e]$/.test(name));
    /* The bounded unattested seats, plus the attested hall beside them. */
    expect(admitted).toHaveLength(UNWITNESSED_KIND_SEATS + 1);
    expect(admitted).toContain('Old Quarter Hall e');

    const attested = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Old Quarter Hall e',
    )!;
    /* Still a degraded admission — the namesake channel may never open the witness gate. */
    expect(attested.place.tags).toContain(WITNESS_CHANNEL_SILENT_TAG);
    /* But the ordering heard the ground: the attested hall outranks its tie tier. */
    const unattested = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Old Quarter Hall a',
    )!;
    expect(attested.place.experienceSignificance!).toBeGreaterThan(
      unattested.place.experienceSignificance!,
    );
  });

  it('lets a locally-named landmark beat article-only obscura at the quota cut', () => {
    /*
     * The witnessed pools' tie band: an encyclopaedic article is the one
     * channel the catalogue populates at scale, so article-carrying records
     * tie exactly and the cut under the band is an id lottery. The park the
     * ground itself names must outrank the ones it does not — its id is
     * deliberately lexically last so that only the channel can seat it.
     */
    const articlePark = (suffix: string, lat: number): SourceRecord =>
      record({
        id: `land:park-${suffix}`,
        layerId: 'land',
        sourceId: `park-${suffix}`,
        name: `Quadrant Green ${suffix}`,
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        wikidataId: `Q${suffix.charCodeAt(0)}00`,
        attributes: { wikipedia: `aa:Quadrant Green ${suffix}` },
        coordinates: { lat, lng: -74.0 },
      });
    const named = record({
      id: 'land:zz-named-park',
      layerId: 'land',
      sourceId: 'zz-named-park',
      name: 'Windmill Commons',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q9990',
      attributes: { wikipedia: 'aa:Windmill Commons' },
      coordinates: { lat: 40.78, lng: -74.0 },
    });
    const witnesses = [
      record({
        id: 'places:commons-bandstand',
        sourceId: 'commons-bandstand',
        name: 'Windmill Commons Bandstand',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: 40.7805, lng: -74.0 },
      }),
      record({
        id: 'places:commons-boathouse',
        sourceId: 'commons-boathouse',
        name: 'Windmill Commons Boathouse',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: 40.7795, lng: -74.0 },
      }),
    ];
    const parks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(
      (suffix, index) => articlePark(suffix, 40.61 + index * 0.012),
    );
    /*
     * Thirteen tied parks against a ten-seat ceiling: the cut has to flush
     * three, and under the id lottery the ground-named one — lexically last —
     * is always among them.
     */
    const inventory = inventoryOf([...parks, named, ...witnesses], { maxAttractions: 10 });
    const keptParks = inventory.candidates
      .map((candidate) => candidate.place.name)
      .filter((name) => name === 'Windmill Commons' || name.startsWith('Quadrant Green'));
    expect(keptParks.length).toBeLessThanOrEqual(10);
    expect(keptParks.length).toBeLessThan(13);
    expect(keptParks).toContain('Windmill Commons');
  });
});

describe('a segment-fanned identity may not order seats', () => {
  it('keeps the park with its own article over segments wearing a shared one', () => {
    /*
     * A mapping convention stamps a linear feature's article across every
     * constituent way. The witness gate already refuses such an identity —
     * the article attests the line, not any one segment — but the seat
     * ordering still heard it at full weight, so under a binding quota the
     * segments' tie band flushed the one park with an article of its own.
     * The ordering must be exactly as deaf to a fanned identity as the gate.
     */
    const segment = (suffix: string, lat: number): SourceRecord =>
      record({
        id: `land:segment-${suffix}`,
        layerId: 'land',
        sourceId: `segment-${suffix}`,
        name: `Towpath Reach ${suffix}`,
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        wikidataId: `Q31${suffix.charCodeAt(0)}`,
        attributes: { wikipedia: 'aa:Old Canal Line' },
        coordinates: { lat, lng: -74.0 },
      });
    const ownArticle = record({
      id: 'land:zz-alder-meadow',
      layerId: 'land',
      sourceId: 'zz-alder-meadow',
      name: 'Alder Meadow',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q59595',
      attributes: { wikipedia: 'aa:Alder Meadow' },
      coordinates: { lat: 40.7, lng: -73.98 },
    });
    /*
     * Twelve segments against a ten-seat ceiling, so the cut binds through
     * the redistribution too: if the ordering hears the fanned article the
     * segments tie with the park at 0.61 and the id lottery flushes it.
     */
    /* All in one partition cell, so the cut is decided by rank alone. */
    const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(
      (suffix, index) => segment(suffix, 40.675 + index * 0.004),
    );
    const inventory = inventoryOf([...segments, ownArticle], { maxAttractions: 10 });
    const keptNames = inventory.candidates.map((candidate) => candidate.place.name);
    expect(keptNames).toContain('Alder Meadow');
    const alder = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Alder Meadow',
    )!;
    const reach = inventory.candidates.find((candidate) =>
      candidate.place.name.startsWith('Towpath Reach'),
    );
    /* Any surviving segment ranks strictly under the own-article park. */
    if (reach) {
      expect(reach.place.experienceSignificance!).toBeLessThan(
        alder.place.experienceSignificance!,
      );
    }
  });
});

describe('the attestation channel refuses what the retention channel refuses', () => {
  it('never attests a record named after its own containment geography', () => {
    /* The public-housing lesson: a record wearing its locality's name took that
     * name *from* the geography, and two neighbours embedding the same
     * locality name are statements about the locality, not about it. */
    const namedAfterLocality = record({
      id: 'places:locality-block',
      sourceId: 'locality-block',
      name: 'Testville',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
      containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    });
    const neighbours = [
      record({
        id: 'places:tv-bakery',
        sourceId: 'tv-bakery',
        name: 'Testville Bakery',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: 40.7005, lng: -74.0 },
      }),
      record({
        id: 'places:tv-hall',
        sourceId: 'tv-hall',
        name: 'Testville Assembly Rooms',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: 40.6995, lng: -74.0 },
      }),
    ];
    const attested = groundNamesakeAttestations([namedAfterLocality, ...neighbours]);
    expect(attested.has('places:locality-block')).toBe(false);
  });

  it('hears one on-complex member, two precinct namesakes, and no lone distant echo', () => {
    const target = record({
      id: 'places:lone-hall',
      sourceId: 'lone-hall',
      name: 'Cormorant Boathouse',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    /*
     * One record standing ON the ground, wearing the name — the sacred-tree /
     * own-cemetery class, measured at 56–142 m on stored packs. A single
     * member of the complex is a member, not a coincidence.
     */
    const member = record({
      id: 'places:one-witness',
      sourceId: 'one-witness',
      name: 'Cormorant Boathouse Slipway',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      coordinates: { lat: 40.7005, lng: -74.0 },
    });
    expect(groundNamesakeAttestations([target, member]).has('places:lone-hall')).toBe(true);

    /*
     * One namesake at precinct distance is an echo, not a member: ~890 m with
     * no published extent reaching back. It attests nothing alone…
     */
    const precinct = record({
      id: 'places:precinct-witness',
      sourceId: 'precinct-witness',
      name: 'Cormorant Boathouse Rowing Pavilion',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      coordinates: { lat: 40.708, lng: -74.0 },
    });
    expect(groundNamesakeAttestations([target, precinct]).has('places:lone-hall')).toBe(false);

    /* …and two distinct precinct namesakes are a named precinct, which does. */
    const secondPrecinct = record({
      id: 'places:second-witness',
      sourceId: 'second-witness',
      name: 'Cormorant Boathouse Terrace',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      coordinates: { lat: 40.692, lng: -74.0 },
    });
    expect(
      groundNamesakeAttestations([target, precinct, secondPrecinct]).has('places:lone-hall'),
    ).toBe(true);

    /* Beyond the twin transfer's own outer bound, a namesake is out of reach. */
    const distant = record({
      id: 'places:distant-witness',
      sourceId: 'distant-witness',
      name: 'Cormorant Boathouse Annex',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      coordinates: { lat: 40.73, lng: -74.0 },
    });
    expect(
      groundNamesakeAttestations([target, precinct, distant]).has('places:lone-hall'),
    ).toBe(false);
  });

  it('reads a wide witness through its own published boundary, as the twin transfer does', () => {
    /* An inner garden's polygon is recorded at its centroid, hundreds of
     * metres from the point record of the thing it belongs to; its published
     * extent is what closes the gap — never an assumed radius. */
    const shrine = record({
      id: 'places:grove-shrine',
      sourceId: 'grove-shrine',
      name: 'Heron Grove Sanctuary',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const innerGarden = record({
      id: 'land:grove-garden',
      layerId: 'land',
      sourceId: 'grove-garden',
      name: 'Heron Grove Sanctuary Inner Garden',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.703, lng: -74.0 },
      bounds: {
        southWest: { lat: 40.7005, lng: -74.003 },
        northEast: { lat: 40.7055, lng: -73.997 },
      },
    });
    expect(
      groundNamesakeAttestations([shrine, innerGarden]).has('places:grove-shrine'),
    ).toBe(true);
  });

  it('hears a witness under every rendering it publishes, one vote per witness', () => {
    /**
     * THE SCRIPT SPLIT, measured on the stored second-§29-A pack: the
     * destination's headline castle is retained under its catalogue's
     * Latin-only primary while every retained namesake — its park, garden,
     * stadium, moat — names the complex in the local script. The one retained
     * record bridging the renderings is the castle's own park polygon,
     * standing on the complex and carrying the Latin rendering *as a published
     * alternate name*. A witness scan that reads only the primary is deaf to
     * it, so the one record the ground names six times composed at its bare
     * kind prior and lost the anchor band to a tie-band UUID lottery.
     *
     * Synthetic ground, same shape: a target whose in-pack neighbour embeds
     * its name only through an alternate rendering, against a twin of the
     * same kind with no witnesses at all. The twin is the control — the fix
     * widens what can be heard, never what is believed.
     */
    const keep = record({
      id: 'places:harbour-keep',
      sourceId: 'harbour-keep',
      name: 'Harbour Keep',
      sourceCategory: 'castle',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site', 'castle'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const parkAroundIt = record({
      id: 'land:keep-park',
      layerId: 'land',
      sourceId: 'keep-park',
      /* The local-script primary shares nothing with the target's key… */
      name: '泊塁公園',
      /* …and the published alternate is the rendering the target is named in. */
      alternateNames: ['Harbour Keep Park'],
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7012, lng: -74.0 },
      bounds: {
        southWest: { lat: 40.699, lng: -74.004 },
        northEast: { lat: 40.7035, lng: -73.996 },
      },
    });
    const witnesslessTwin = record({
      id: 'places:quiet-keep',
      sourceId: 'quiet-keep',
      name: 'Quietwater Keep',
      sourceCategory: 'castle',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site', 'castle'],
      coordinates: { lat: 40.75, lng: -74.05 },
    });
    const attested = groundNamesakeAttestations([keep, parkAroundIt, witnesslessTwin]);
    expect(attested.has('places:harbour-keep')).toBe(true);
    expect(attested.has('places:quiet-keep')).toBe(false);

    /*
     * ONE WITNESS, HOWEVER MANY RENDERINGS. A precinct namesake carrying two
     * alternates that both embed the key is still one witness — a mapper must
     * not be able to manufacture the second precinct witness by translating
     * their own listing again. Two distinct records remain the precinct bar.
     */
    const polyglotNamesake = record({
      id: 'places:polyglot-witness',
      sourceId: 'polyglot-witness',
      name: 'Harbour Keep Rowing Pavilion',
      alternateNames: ['Harbour Keep Boat Pavilion', 'Harbour Keep Pavillon'],
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      coordinates: { lat: 40.708, lng: -74.0 },
    });
    expect(
      groundNamesakeAttestations([keep, polyglotNamesake]).has('places:harbour-keep'),
    ).toBe(false);
  });

  it('refuses a brand: one key worn by targets standing apart attests none of them', () => {
    const branch = (suffix: string, lat: number): SourceRecord =>
      record({
        id: `places:roasters-${suffix}`,
        sourceId: `roasters-${suffix}`,
        name: 'Harbour Coffee Roasters',
        sourceCategory: 'historic_site',
        sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
        coordinates: { lat, lng: -74.0 },
      });
    const kiosk = (suffix: string, lat: number): SourceRecord =>
      record({
        id: `places:kiosk-${suffix}`,
        sourceId: `kiosk-${suffix}`,
        name: `Harbour Coffee Roasters Kiosk ${suffix}`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        coordinates: { lat: lat + 0.0005, lng: -74.0 },
      });
    /* Two same-named records 8 km apart, each with an embedding neighbour. */
    const records = [branch('north', 40.76), kiosk('n', 40.76), branch('south', 40.688), kiosk('s', 40.688)];
    const attested = groundNamesakeAttestations(records);
    expect(attested.has('places:roasters-north')).toBe(false);
    expect(attested.has('places:roasters-south')).toBe(false);
  });

  it('hears a joined rendering: either script segment of a slashed or parenthesised name attests', () => {
    /* The measured shape: a landmark publishes `<local script> (<Latin name>)`
     * as one string, a key no namesake can embed whole — while a segment alone
     * is embedded by the shops at its base. */
    const joined = record({
      id: 'places:joined-name',
      sourceId: 'joined-name',
      name: '燕子樓 (Swallow Pavilion)',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const witnesses = [
      record({
        id: 'places:pavilion-teashop',
        sourceId: 'pavilion-teashop',
        name: 'Swallow Pavilion Teashop',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        coordinates: { lat: 40.7004, lng: -74.0 },
      }),
      record({
        id: 'places:pavilion-pier',
        sourceId: 'pavilion-pier',
        name: 'Swallow Pavilion Pier',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        coordinates: { lat: 40.6996, lng: -74.0 },
      }),
    ];
    /* Two witnesses on one segment: the joined whole embeds in neither. */
    expect(groundNamesakeAttestations([joined, ...witnesses]).has('places:joined-name')).toBe(true);
  });

  it('treats a generic short ASCII name as no key at all', () => {
    const generic = record({
      id: 'places:generic-park',
      sourceId: 'generic-park',
      name: 'Gardens',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const neighbours = ['a', 'b'].map((suffix, index) =>
      record({
        id: `places:generic-${suffix}`,
        sourceId: `generic-${suffix}`,
        name: `Gardens Cafe ${suffix}`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        coordinates: { lat: 40.7 + (index + 1) * 0.0005, lng: -74.0 },
      }),
    );
    expect(groundNamesakeAttestations([generic, ...neighbours]).has('places:generic-park')).toBe(
      false,
    );
  });
});

describe('a district name is not a place name', () => {
  it('never attests a record wearing the name of an administrative division', () => {
    /*
     * The measured junk class: rows classified as historic sites whose name is
     * a district's — a station area, a landfill wearing a ward name — were
     * attested by every shop and station named after the *district*, and took
     * degraded seats from the records the ground genuinely names. Which way
     * the naming ran is not in the record, so a key any division publishes
     * attests nothing (the seat layer's public-housing lesson, one guard up).
     */
    const division = record({
      id: 'divisions:eastport',
      layerId: 'divisions',
      sourceId: 'eastport',
      name: 'Eastport Quarter',
      sourceCategory: 'neighborhood',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const districtRow = record({
      id: 'places:eastport-row',
      sourceId: 'eastport-row',
      name: 'Eastport Quarter',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const shops = ['a', 'b'].map((suffix, index) =>
      record({
        id: `places:eastport-shop-${suffix}`,
        sourceId: `eastport-shop-${suffix}`,
        name: `Eastport Quarter Provisions ${suffix}`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        coordinates: { lat: 40.7 + (index + 1) * 0.0005, lng: -74.0 },
      }),
    );
    const attested = groundNamesakeAttestations([division, districtRow, ...shops]);
    expect(attested.has('places:eastport-row')).toBe(false);
    /* And a division is never itself a target. */
    expect(attested.has('divisions:eastport')).toBe(false);
  });
});

describe('ground-attested records do not spend the outage seats', () => {
  it('admits every attested hall beside the bounded unattested ones', () => {
    /*
     * The seat bound exists so a class nobody can verify cannot colonise a
     * pool on the strength of a channel outage. A record the region's own
     * ground names is not "nobody can verify": the bound stays for the
     * unattested, and the attested are admitted beside them — still marked,
     * still barred from classic seats, their number already bounded by the
     * attestation guards.
     */
    const halls = ['a', 'b', 'c', 'd', 'e', 'f'].map((suffix, index) =>
      worshipPlace(suffix, 40.7 + index * 0.015),
    );
    const witnesses = ['e', 'f'].flatMap((suffix) => {
      const lat = 40.7 + (suffix === 'e' ? 4 : 5) * 0.015;
      return [
        record({
          id: `places:witness-${suffix}-gate`,
          sourceId: `witness-${suffix}-gate`,
          name: `Old Quarter Hall ${suffix} Gatehouse`,
          sourceCategory: 'cafe',
          sourceCategoryPath: ['eat_and_drink', 'cafe'],
          planningRole: 'food',
          coordinates: { lat: lat + 0.0008, lng: -74.0 },
        }),
      ];
    });
    const inventory = inventoryOf([...halls, ...witnesses, answeringLandmark()]);
    const admitted = inventory.candidates
      .map((candidate) => candidate.place.name)
      .filter((name) => /^Old Quarter Hall [a-f]$/.test(name))
      .sort();
    /* Three unattested by the bound, plus both attested halls. */
    expect(admitted).toEqual([
      'Old Quarter Hall a',
      'Old Quarter Hall b',
      'Old Quarter Hall c',
      'Old Quarter Hall e',
      'Old Quarter Hall f',
    ]);
    expect(inventory.portfolio.unwitnessedAdmissions).toBe(UNWITNESSED_KIND_SEATS + 2);
    /* Attested or not, a degraded admission stays marked. */
    for (const name of ['Old Quarter Hall e', 'Old Quarter Hall a']) {
      const hall = inventory.candidates.find((candidate) => candidate.place.name === name)!;
      expect(hall.place.tags).toContain(WITNESS_CHANNEL_SILENT_TAG);
    }
  });
});

describe('the category cap holds back the weakest of a category, never the unluckily placed best', () => {
  it('keeps the globally best of a capped category across areas', () => {
    /*
     * The measured failure: a destination's second-ranked record of its whole
     * visitable pool was flushed by the category cap because its harbour cell
     * is served after the dense centre, whose weaker records of the same
     * category had already spent the cap. A cap is density control; which
     * members survive it must be decided by rank, not by serving order.
     */
    type Item = { id: string; rank: number; area: string; category: string };
    const items: Item[] = [
      /* The globally best two of category x live in the small area. */
      { id: 'x1', rank: 1, area: 'harbour', category: 'x' },
      { id: 'x2', rank: 2, area: 'harbour', category: 'x' },
      /* The dense centre holds ten weaker x's and four y's. */
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `cx${index}`,
        rank: 3 + index,
        area: 'centre',
        category: 'x',
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `cy${index}`,
        rank: 13 + index,
        area: 'centre',
        category: 'y',
      })),
    ];
    const ranked = [...items].sort((a, b) => a.rank - b.rank);
    const result = balanceAcrossAreas({
      ranked,
      areaOf: (item) => item.area,
      categoryOf: (item) => item.category,
      limits: { quota: 6, maxPerCategory: 3, maxAreaShare: 0.9 },
    });
    const keptIds = result.kept.map((item) => item.id);
    /* The cap's three x seats belong to the three best x's, wherever they stand. */
    expect(keptIds).toContain('x1');
    expect(keptIds).toContain('x2');
    expect(keptIds.filter((id) => id.startsWith('cx')).length).toBeLessThanOrEqual(1);
  });
});

describe('membership carries across a linker collapse', () => {
  it('hands a survivor its superseded twin’s division membership', () => {
    /*
     * The measured shape: a landmark's collapse survivor publishes an address
     * with no division evidence, while the superseded twin the linker proved
     * is the same entity carries the division chain — so the survivor fell to
     * `membership_unknown`, was demoted out of the anchor slot, and starved
     * with the discovery pool. The linker asserted these records are one
     * thing; where the entity stands is a statement about the entity, on the
     * exact precedent of `namesFromCollapsedTwins`.
     */
    const survivor = record({
      id: 'places:tower-survivor',
      sourceId: 'tower-survivor',
      name: 'Lantern Tower',
      sourceCategory: 'observatory',
      sourceCategoryPath: ['attractions_and_activities', 'observatory'],
      containment: { divisionIds: [] },
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const twin = record({
      id: 'land:tower-twin',
      layerId: 'land',
      sourceId: 'tower-twin',
      name: 'Lantern Tower',
      sourceCategory: 'viewpoint',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      containment: {
        divisionIds: ['division/1', 'division/2'],
        localityName: 'Testville',
        countryCode: 'AA',
      },
      coordinates: { lat: 40.7001, lng: -74.0 },
    });
    const links = [
      {
        recordIds: ['land:tower-twin', 'places:tower-survivor'] as [string, string],
        kind: 'same_entity' as const,
        evidence: ['name_and_category_and_proximity' as const],
        separationMetres: 12,
      },
    ];
    const patched = carryMembershipToCollapseSurvivors(
      [survivor, twin],
      links,
      new Set(['land:tower-twin']),
    );
    const carried = patched.find((entry) => entry.id === 'places:tower-survivor')!;
    expect(carried.containment.divisionIds).toEqual(['division/1', 'division/2']);
    expect(carried.containment.localityName).toBe('Testville');
    /* Never a downgrade: a survivor with its own evidence keeps it. */
    const alreadyPlaced = { ...survivor, containment: { divisionIds: ['division/9'] } };
    const kept = carryMembershipToCollapseSurvivors(
      [alreadyPlaced, twin],
      links,
      new Set(['land:tower-twin']),
    ).find((entry) => entry.id === 'places:tower-survivor')!;
    expect(kept.containment.divisionIds).toEqual(['division/9']);
  });
});

describe('unclaimed quota goes to the strongest admitted record, not the earliest role', () => {
  it('seats a demoted high-significance record ahead of a weaker role’s spare', () => {
    /*
     * The measured failure: a destination's landmark observation tower —
     * `membership_unknown`, demoted out of the anchor slot — could never be
     * seated, because its own role's anchor pool filled the role quota (the
     * demoted-discovery pool is skipped once `remaining` hits zero) and the
     * redistribution then offered the whole remainder role-by-role, so a
     * flood of weak spare in an earlier role spent every unclaimed seat
     * before the stronger record's role was reached. Unclaimed seats must go
     * to the strongest admitted records, whatever role they carry.
     */
    const museums = Array.from({ length: 10 }, (_, index) =>
      record({
        id: `places:gallery-${String(index).padStart(2, '0')}`,
        sourceId: `gallery-${index}`,
        name: `Quayside Gallery ${index}`,
        sourceCategory: 'art_gallery',
        sourceCategoryPath: ['arts_and_entertainment', 'art_gallery'],
        coordinates: { lat: 40.62 + index * 0.012, lng: -74.0 },
      }),
    );
    const parks = ['a', 'b', 'c'].map((suffix, index) =>
      record({
        id: `land:anchor-park-${suffix}`,
        layerId: 'land',
        sourceId: `anchor-park-${suffix}`,
        name: `Fenwick Green ${suffix}`,
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        wikidataId: `Q88${index}`,
        attributes: { wikipedia: `aa:Fenwick Green ${suffix}` },
        coordinates: { lat: 40.76 + index * 0.01, lng: -74.0 },
      }),
    );
    const tower = record({
      id: 'land:zz-signal-tower-park',
      layerId: 'land',
      sourceId: 'zz-signal-tower-park',
      name: 'Signal Tower Gardens',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q9999',
      /* An admission charge: the operational statement that keeps a park's
       * evidence unbounded under the commonplace-notice grading, so this
       * record is genuinely high-significance rather than article-only. */
      attributes: { wikipedia: 'aa:Signal Tower Gardens', fee: 'yes' },
      coordinates: { lat: 40.7, lng: -73.95 },
    });

    const scope = scopeFor();
    const all = [...museums, ...parks, tower];
    const pack = packWith(all);
    const overlay = buildTripScopeOverlay({
      scope,
      records: pack.layers.flatMap((layer) => layer.records),
      roleEligible: () => true,
    });
    /* The fail-closed decision, stamped onto the tower: membership unknown. */
    const unknown = { ...decisionFor(overlay, 'no-such-record'), candidateId: tower.id };
    const patched = {
      ...overlay,
      decisions: new Map([...overlay.decisions, [tower.id, unknown]]),
    };
    const inventory = buildInventory({
      pack,
      scope,
      overlay: patched,
      limits: { maxAttractions: 10 },
    });
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('Signal Tower Gardens');
  });
});
