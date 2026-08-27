import { describe, expect, it } from 'vitest';
import type { PackLayer, SourceRecord } from '../schemas/region-pack';
import { SCHEDULED_STOP_OBSERVATION_VERSION } from '../schemas/compiled-region';
import { SCHEDULED_STOP_KINDS, countScheduledStops, scheduledNetworkFrom } from './scheduled-stops';

/**
 * THE KIND-AWARE SCHEDULED-STOP COUNT, AS A UNIT.
 *
 * The defect this module exists to end: the compiled artifact carried one
 * kinds-blind gateway number, so a destination whose ground held a hundred rail
 * stations and a destination whose gateways were two airports and a harbour
 * were indistinguishable to everything downstream — and the transit-blind
 * verdict (`transitBlindWalk`) had no persisted observation to read on the live
 * path. The observation it needs is "the destination evidence itself records
 * scheduled-transport stops", which is a *kind* question, never a headcount of
 * ways in and out.
 *
 * Every fixture name here is a category word from a source vocabulary, never a
 * place.
 */

let sequence = 0;

function record(
  sourceCategory: string,
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  sequence += 1;
  return {
    id: `places:fixture-${sequence}`,
    layerId: 'places',
    sourceId: `fixture-${sequence}`,
    name: `Fixture ${sequence}`,
    alternateNames: [],
    coordinates: { lat: 0.01 * sequence, lng: 0.01 * sequence },
    sourceCategory,
    sourceCategoryPath: [],
    planningRole: 'gateway',
    websiteCandidates: [],
    containment: { countryCode: 'TL', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'fixture-catalogue', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

function layer(records: SourceRecord[], id = 'places'): PackLayer {
  return {
    id,
    kind: id === 'land' ? 'supplemental_geography' : 'primary_places',
    catalog: 'synthetic',
    datasetPath: `${id}/${id}`,
    licenceId: 'CDLA-Permissive-2.0',
    records,
    featuresRead: records.length,
    featuresRetained: records.length,
    failedCellIds: [],
  };
}

describe('countScheduledStops', () => {
  it('counts stops by their own kind, across layers, never as one blind number', () => {
    const observation = countScheduledStops([
      layer([
        record('train_station'),
        record('bus_station'),
        record('ferry_terminal'),
      ]),
      layer(
        [record('railway_station'), record('railway_station')],
        'land',
      ),
    ]);

    expect(observation.version).toBe(SCHEDULED_STOP_OBSERVATION_VERSION);
    expect(observation.byKind).toEqual({
      bus_station: 1,
      ferry_terminal: 1,
      railway_station: 2,
      train_station: 1,
    });
    expect(observation.total).toBe(5);
  });

  it('does not count a gateway or amenity that is not a scheduled stop', () => {
    /*
     * Each of these is a real word from the source vocabulary that sits next
     * door to a scheduled stop and must never be one: an airport is scheduled
     * but not the ground network this observation describes, a harbour and a
     * marina are water gateways with no timetable implied, a fuel stop merely
     * contains the word, a roadside pole (`bus_stop`) is street furniture whose
     * counting would make a single bus route read as a network, and a line
     * (`subway_line`) is infrastructure rather than somewhere a person boards.
     */
    const observation = countScheduledStops([
      layer([
        record('airport'),
        record('international_airport'),
        record('harbor'),
        record('marina'),
        record('gas_station'),
        record('bus_stop'),
        record('subway_line'),
        record('tram_line'),
        record('taxi_stand'),
        record('museum'),
        record('substation'),
      ]),
    ]);

    expect(observation.byKind).toEqual({});
    expect(observation.total).toBe(0);
  });

  it('reads a kind through the source spelling it actually arrives in', () => {
    const observation = countScheduledStops([
      layer([record('Railway Station'), record('  train_station  ')]),
    ]);
    expect(observation.byKind).toEqual({ railway_station: 1, train_station: 1 });
  });

  it('reads a kind from the category path when the leaf alone says nothing', () => {
    /*
     * Mirrors the taxonomy's own resolution order: leaf first, then the path
     * walked innermost-first. A record filed under an unrecognised local leaf
     * whose published path names a station kind is that kind's record.
     */
    const observation = countScheduledStops([
      layer([
        record('central_concourse', {
          sourceCategoryPath: ['travel_and_transportation', 'train_station'],
        }),
      ]),
    ]);
    expect(observation.byKind).toEqual({ train_station: 1 });
  });

  it('does not count a stop the source itself records as closed', () => {
    const observation = countScheduledStops([
      layer([record('railway_station', { operatingStatus: 'closed' })]),
    ]);
    expect(observation.total).toBe(0);
  });

  it('persists an honest zero for ground with no scheduled stop at all', () => {
    const observation = countScheduledStops([layer([record('viewpoint'), record('lake')])]);
    expect(observation).toEqual({
      version: SCHEDULED_STOP_OBSERVATION_VERSION,
      byKind: {},
      total: 0,
    });
  });

  it('writes kinds in a stable order, whatever order the records arrived in', () => {
    const forward = countScheduledStops([
      layer([record('train_station'), record('bus_station')]),
    ]);
    const backward = countScheduledStops([
      layer([record('bus_station'), record('train_station')]),
    ]);
    expect(Object.keys(forward.byKind)).toEqual(Object.keys(backward.byKind));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });
});

describe('scheduledNetworkFrom', () => {
  it('reads an absent observation as nobody-said, never as an answer', () => {
    expect(scheduledNetworkFrom(undefined)).toBeNull();
    expect(scheduledNetworkFrom(null)).toBeNull();
  });

  it('reads a counted zero as not-observed — evidence was read and records none', () => {
    expect(
      scheduledNetworkFrom({ version: SCHEDULED_STOP_OBSERVATION_VERSION, byKind: {}, total: 0 }),
    ).toBe('not_observed');
  });

  it('reads any counted stop as observed', () => {
    expect(
      scheduledNetworkFrom({
        version: SCHEDULED_STOP_OBSERVATION_VERSION,
        byKind: { railway_station: 1 },
        total: 1,
      }),
    ).toBe('observed');
  });

  it('refuses to read a count written under a rule it does not know', () => {
    /*
     * A future artifact whose counting rule changed is a different claim, and
     * misreading it under this rule would be exactly the substitution the
     * version field exists to prevent. Nobody-said is the honest fallback.
     */
    expect(
      scheduledNetworkFrom({
        version: SCHEDULED_STOP_OBSERVATION_VERSION + 1,
        byKind: { railway_station: 12 },
        total: 12,
      }),
    ).toBeNull();
  });
});

describe('the enumerated kinds', () => {
  it('are already in normalised spelling, so counting and enumeration agree', () => {
    for (const kind of SCHEDULED_STOP_KINDS) {
      expect(kind).toBe(kind.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    }
  });
});
