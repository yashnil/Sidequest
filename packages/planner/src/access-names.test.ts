import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  DISPLAY_NAME_VERSION,
  type Place,
  type QuestionnaireContext,
  type TravelerProfile,
} from '@sidequest/core';
import {
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_PLACES,
  easternSierraTravelMatrix,
} from '@sidequest/core/data';
import { buildAccessUnits, resolveAccess } from './access';
import type { PlanningCandidate } from './types';

/**
 * §8.6 REACHES THE ACCESS LAYER TOO.
 *
 * `display-name.test.ts` beside this proves the *itinerary* never prints a raw
 * local name. It could not see this file, because the five sentences access
 * builds — the refusal for a date nothing gets you there on, the "no travel data
 * for the way in" refusal, the two walk legs either side of a shuttle drop-off,
 * and the heading of a unit with no gateway of its own — are produced before a
 * day exists, and the Eastern Sierra golden scenario reaches none of them.
 *
 * They read `place.name`, which is whatever the source published: on a Tokyo
 * pack, the local script. So a traveller who picked "Sumida River" off the board
 * got 隅田川 back inside an English sentence explaining why they could not go.
 *
 * The fixture renames three Eastern Sierra places to a local form with a
 * resolved English display name over it, then asserts the local form appears in
 * none of the four paths — and that the display form appears in all of them, so
 * the test cannot pass by the paths going quiet.
 */

const LOCAL = 'Kolonna del Diavolo';
const DISPLAY = 'Devils Postpile (resolved)';
const RENAMED = new Set(['devils-postpile', 'rainbow-falls', 'convict-lake']);
/** The Reds Meadow gateway's matrix id — the one the "no travel data" path needs gone. */
const GATEWAY_ROUTING_ID = 'panorama-gondola';

function renamed(place: Place): Place {
  if (!RENAMED.has(place.id)) return place;
  const local = `${LOCAL} — ${place.id}`;
  return {
    ...place,
    name: local,
    names: {
      schemaVersion: DISPLAY_NAME_VERSION,
      display: `${DISPLAY} — ${place.id}`,
      displayLanguage: 'en',
      local,
      canonical: local,
      sources: ['fixture'],
    },
  };
}

function profileFor(): TravelerProfile {
  const context: QuestionnaireContext = { travelerNeeds: [], tripDays: 4 };
  return buildTravelerProfile(defaultAnswers(context), context);
}

function candidatesFor(ids: readonly string[]): PlanningCandidate[] {
  return EASTERN_SIERRA_PLACES.filter((place) => ids.includes(place.id)).map((place) => ({
    place: renamed(place),
    priority: 1,
    manual: false,
    selectionStatus: 'included' as const,
    fitScore: 0.8,
    matchedInterests: [],
    durationMinutes: 90,
    travelMinutesFromBase: 30,
    travelModeFromBase: 'drive' as const,
  }));
}

interface Resolution {
  /** Everything a traveller could read, flattened. */
  readable: string;
}

/**
 * The matrix with the shuttle's gateway removed.
 *
 * That is the exact state behind "we have no travel data for the way in": the
 * access dataset names a gateway the travel matrix has never heard of.
 */
function matrixWithoutGateways(): ReturnType<typeof easternSierraTravelMatrix> {
  const full = easternSierraTravelMatrix();
  const keep = full.ids
    .map((id, index) => ({ id, index }))
    .filter((entry) => entry.id !== GATEWAY_ROUTING_ID);
  return {
    ...full,
    ids: keep.map((entry) => entry.id),
    minutes: keep.map((row) => keep.map((column) => full.minutes[row.index]![column.index]!)),
    km: keep.map((row) => keep.map((column) => full.km[row.index]![column.index]!)),
  };
}

function resolveOn(
  ids: readonly string[],
  dates: readonly string[],
  matrix = easternSierraTravelMatrix(),
): Resolution {
  const candidates = candidatesFor(ids);
  const units = buildAccessUnits(candidates, EASTERN_SIERRA_ACCESS, 'Mammoth Lakes');
  const resolved = resolveAccess({
    units,
    dates,
    dataset: EASTERN_SIERRA_ACCESS,
    profile: profileFor(),
    matrix,
  });
  const readable = JSON.stringify({
    units: units.map((unit) => unit.gatewayName),
    resolved: [...resolved.values()].map((entry) =>
      entry.available
        ? {
            gatewayName: entry.option.gatewayName,
            entry: entry.option.entryLegs.map((leg) => [leg.fromName, leg.toName]),
            exit: entry.option.exitLegs.map((leg) => [leg.fromName, leg.toName]),
            notes: entry.option.notes,
          }
        : { blockers: entry.blockers.map((blocker) => blocker.message) },
    ),
  });
  return { readable };
}

/** In the shuttle's months, and outside them. */
const IN_SEASON = ['2026-08-12'];
const OUT_OF_SEASON = ['2026-02-12'];

describe('access sentences use the name the traveller picked', () => {
  it('names the walk either side of a shuttle drop-off by its display name', () => {
    /* The Reds Meadow rule: a gateway, a shuttle, and a ten-minute walk in. */
    const { readable } = resolveOn(['devils-postpile', 'rainbow-falls'], IN_SEASON);
    expect(readable, 'the shuttle unit resolved to nothing at all').toContain(
      'Reds Meadow Valley shuttle stops',
    );
    expect(readable, 'neither walk leg names the place at all').toContain(DISPLAY);
    expect(
      readable.includes(LOCAL),
      `an access leg or note still carries the local name "${LOCAL}"`,
    ).toBe(false);
  });

  it('names a unit with no gateway of its own by its display name', () => {
    /*
     * A drive-up place forms a unit of one whose heading is the place itself —
     * `buildAccessUnits`' last fallback, and the one a board group inherits.
     */
    const { readable } = resolveOn(['convict-lake'], IN_SEASON);
    expect(readable).toContain(DISPLAY);
    expect(readable.includes(LOCAL), `the unit heading is still "${LOCAL}"`).toBe(false);
  });

  it('names the place in the refusal for a way in nothing can time', () => {
    const { readable } = resolveOn(
      ['devils-postpile', 'rainbow-falls'],
      IN_SEASON,
      matrixWithoutGateways(),
    );
    expect(
      readable,
      'the gateway is still in the matrix, so this path was never reached',
    ).toContain('We have no travel data for the way in to');
    expect(readable).toContain(DISPLAY);
    expect(readable.includes(LOCAL), `the refusal still reads "${LOCAL}"`).toBe(false);
  });

  it('names the place in the refusal for a date nothing reaches it on', () => {
    /* February: the Reds Meadow rule runs June to October, so nothing applies. */
    const { readable } = resolveOn(['devils-postpile'], OUT_OF_SEASON);
    expect(readable, 'the out-of-season date no longer refuses, so it proves nothing').toContain(
      'Nothing we have on record gets you to',
    );
    expect(readable).toContain(DISPLAY);
    expect(readable.includes(LOCAL), `the refusal still reads "${LOCAL}"`).toBe(false);
  });
});
