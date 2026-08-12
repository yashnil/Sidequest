import { describe, expect, it } from 'vitest';
import {
  geographicScopeSchema,
  type GeographicScope,
  type OperatingCalendar,
  type Place,
  type SourceRecord,
} from '@sidequest/core';
import { toCandidate } from './backbone/inventory';
import { classifySourceCategory } from './backbone/taxonomy';
import { buildHours } from './compile';

/**
 * HOURS SEMANTICS BY KIND OF PLACE — §8.5, at the one function that stamps
 * the fallback.
 *
 * The audited failure: `buildHours` wrote `unknown` plus "Check its hours.
 * Nobody publishes opening hours…" onto every place without a calendar, which
 * on a compiled metro meant every river, slope and hill carried a
 * business-hours warning. A warning that fires on things that cannot have the
 * property teaches the traveller to ignore the one that matters. Open ground
 * now gets `always_open` — the calendar kind that has existed for exactly this
 * ("a roadside viewpoint, an unlocked trailhead") since the schema was written
 * — and everything gated keeps the cautious `unknown`.
 */

function scopeFor(): GeographicScope {
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
  });
}

function placeOf(id: string, overrides: Partial<Place> = {}): Place {
  return {
    id,
    regionId: 'compiled-test',
    name: id,
    locality: 'Testville',
    shortDescription: 'A place, used to exercise the hours fallback.',
    coordinates: { lat: 40.7, lng: -74 },
    tags: [],
    source: { name: 'Test', kind: 'curated', confidence: 0.9, lastVerified: '2026-01-01' },
    relationship: 'satellite',
    category: 'museum',
    interests: ['history_and_culture'],
    typicalDurationMinutes: 60,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.5,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'indoor',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: true,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'easy',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 4, driveMinutes: 10, driveIsScenic: false },
    ...overrides,
  };
}

describe('the hours fallback matches the kind of place', () => {
  const scope = scopeFor();

  it('gives open ground always_open, never a business-hours warning', () => {
    const river = placeOf('river', { category: 'lake', hoursExpectation: 'open_ground' });
    const dataset = buildHours(scope, [river], []);
    const calendar = dataset.calendars[0]!;
    expect(calendar.kind).toBe('always_open');
    expect(calendar.note).toContain('Open ground');
    expect(calendar.note).not.toContain('Check');
  });

  it('keeps the cautious unknown for gated kinds', () => {
    const museum = placeOf('museum', { hoursExpectation: 'gated' });
    const dataset = buildHours(scope, [museum], []);
    expect(dataset.calendars[0]!.kind).toBe('unknown');
    expect(dataset.calendars[0]!.provenance.recheckNote).toContain('Check before you go');
  });

  it('treats an unclassified place as gated — the cautious direction', () => {
    /* Every place stored before `hoursExpectation` existed lands here. */
    const stored = placeOf('stored');
    const dataset = buildHours(scope, [stored], []);
    expect(dataset.calendars[0]!.kind).toBe('unknown');
  });

  it('never overrides a calendar somebody actually supplied', () => {
    const river = placeOf('river', { category: 'lake', hoursExpectation: 'open_ground' });
    const supplied: OperatingCalendar = {
      kind: 'scheduled',
      placeId: 'river',
      admission: {
        reservationRequired: false,
        timedEntry: false,
        permitRequired: false,
        walkInAllowed: true,
        capacityLimited: false,
      },
      daylightOnly: false,
      periods: [
        {
          label: 'All year',
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          windows: [{ openMinute: 480, closeMinute: 1020 }],
        },
      ],
      closedAnnualDates: [],
      provenance: {
        kind: 'official',
        sourceName: 'Park authority',
        lastVerified: '2026-08-01',
        confidence: 0.9,
        volatility: 'stable',
      },
    };
    const dataset = buildHours(scope, [river], [supplied]);
    expect(dataset.calendars[0]!.kind).toBe('scheduled');
  });
});

/**
 * THE OTHER HALF OF §8.5 — WHO GETS STAMPED `gated` IN THE FIRST PLACE.
 *
 * Everything above hands `buildHours` a stamp and checks it is honoured. That
 * proves nothing about the stamp, and the stamp is where the absurdity comes
 * from: §30's mutation class 8 makes `hoursExpectation` `gated` for every
 * record, and the whole of this file stayed green while every river, ridge and
 * stretch of water in a compiled region collected "Check before you go" — the
 * exact §4 regression the fallback was written to end.
 *
 * So the stamp is asserted against the world rather than against the branch
 * that computes it: a thing with no door cannot have opening hours, whatever a
 * catalogue filled in about it. Swept over the kinds rather than pinned to one
 * fixture, because one fixture is precisely what let a universal regression
 * through.
 */
describe('which kinds of place can be gated at all', () => {
  const scope = scopeFor();

  function candidateFor(sourceCategory: string, attributes: SourceRecord['attributes'] = {}) {
    const taxonomy = classifySourceCategory({ category: sourceCategory });
    return toCandidate({
      record: {
        id: `places:${sourceCategory}`,
        layerId: 'places',
        sourceId: sourceCategory,
        name: `The ${sourceCategory}`,
        alternateNames: [],
        coordinates: { lat: 40.7, lng: -74 },
        sourceCategory,
        sourceCategoryPath: [],
        planningRole: taxonomy.role,
        websiteCandidates: [],
        containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
        attributes,
        sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
        cellId: 'g-0-0',
      },
      scope,
      crossLayerCorroborated: false,
      role: taxonomy.role,
      inclusion: 'inside_scope',
    });
  }

  /** Landforms and water. There is no door, so there is no hour to check. */
  const OPEN_GROUND = [
    'river',
    'stream',
    'canal',
    'lake',
    'pond',
    'bay',
    'beach',
    'waterfall',
    'peak',
    'summit',
    'ridge',
    'hill',
    'valley',
    'mountain_range',
    'glacier',
    'viewpoint',
    'scenic_lookout',
    'forest',
    'dune',
  ];

  /** Kinds somebody unlocks in the morning and locks again at night. */
  const GATED = ['museum', 'art_gallery', 'aquarium', 'castle', 'theatre'];

  it('never gates a landform or a stretch of water', () => {
    const wrongly = OPEN_GROUND.filter(
      (kind) => candidateFor(kind).place.hoursExpectation !== 'open_ground',
    );
    expect(wrongly).toEqual([]);
  });

  it('still gates the kinds somebody unlocks — the distinction cuts both ways', () => {
    const wrongly = GATED.filter((kind) => candidateFor(kind).place.hoursExpectation !== 'gated');
    expect(wrongly).toEqual([]);
  });

  /* An admission charge is a gate whatever the landform says: a paid garden is gated. */
  it('gates open ground that charges admission', () => {
    expect(candidateFor('garden', { fee: 'yes' }).place.hoursExpectation).toBe('gated');
    expect(candidateFor('garden').place.hoursExpectation).toBe('open_ground');
  });

  it('carries the distinction all the way to the sentence the traveller reads', () => {
    const places = [...OPEN_GROUND, ...GATED].map((kind) => candidateFor(kind).place);
    const dataset = buildHours(scope, places, []);
    const warned = dataset.calendars
      .filter((calendar) => calendar.provenance.recheckNote?.includes('Check before you go'))
      .map((calendar) => calendar.placeId);
    /*
     * Stated as the identity of what was warned about, not as a count: a count
     * would still pass if the warning moved from the museums onto the rivers.
     */
    expect(warned.sort()).toEqual(GATED.map((kind) => `places:${kind}`).sort());
  });
});
