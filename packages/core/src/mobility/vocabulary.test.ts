import { describe, expect, it } from 'vitest';
import { MODE_CONCEPTS } from '../reality/schema';
import { TRANSPORT_MODES } from '../schemas/access';
import {
  DRAFT_TRANSPORT_MODES,
  EPISODE_MODE_TRAVEL,
  TRAVEL_MODES,
  TRAVEL_MODE_CONCEPTS,
  TRAVEL_MODE_CONCEPT_FAMILY,
  TRAVEL_MODE_LABELS,
  TRAVEL_MODE_ROUTING_PROFILE,
  TRAVEL_MODE_TO_TRANSPORT,
  TRANSPORT_MODE_TO_TRAVEL,
  isRoadRoutable,
  travelModeFromDraft,
  travelModeFromEpisode,
  travelModeFromTransport,
  transportModeOf,
  type TravelMode,
} from './vocabulary';

/**
 * §2 — "No mode should silently fall through to an unrelated default. Add
 * exhaustive mapping tests."
 *
 * The maps are `Record<K, V>` with exhaustive key types, so most of this is
 * enforced by the compiler. What a compiler cannot check is that the *other*
 * vocabularies — the draft's, the episode's — are covered, because those live in
 * the web app and in a nested enum, and a value added there would compile fine
 * and map to `unknown` at runtime. Those are the tests that earn their place.
 */

/**
 * The draft vocabulary, copied from `apps/web/src/lib/planning/trip-draft.ts#DRAFT_TRANSPORTS`.
 *
 * A copy, because `core` may not import upward. The copy is held to the original
 * by `apps/web/src/lib/planning/draft-vocabulary.test.ts`, which imports both —
 * so a value added to the draft without a mapping here fails there rather than
 * mapping silently to `unknown`.
 */
const DRAFT_TRANSPORTS = [
  'walk',
  'metro',
  'rail',
  'bus',
  'car',
  'ferry',
  'boat',
  'flight',
  'private_transfer',
  'four_wheel_drive',
  'guide_or_lodge_transfer',
  'horse',
  'taxi',
  'high_speed_rail',
  'unknown',
] as const;

/** The episode vocabulary, copied from `schemas/itinerary.ts#episodeMode`. */
const EPISODE_MODES = ['boat', 'walk', 'four_wheel_drive', 'rail', 'car', 'bicycle', 'guide_or_lodge_transfer', 'horse', 'none'] as const;

describe('the unified transport vocabulary', () => {
  it('names every way a person moves that the product plans for', () => {
    /* The seventeen §2 asks for, plus `unknown`. A regression here is a deliberate change. */
    expect(TRAVEL_MODES).toHaveLength(18);
    for (const mode of ['walk', 'bike', 'drive', 'taxi', 'private_transfer', 'bus', 'urban_transit', 'rail', 'ferry', 'boat', 'flight', 'shuttle', 'four_wheel_drive', 'horse', 'trail', 'cable_car_or_lift', 'operator_transfer'] as const) {
      expect(TRAVEL_MODES).toContain(mode);
    }
  });

  it('gives every mode a traveller-facing label', () => {
    for (const mode of TRAVEL_MODES) {
      expect(TRAVEL_MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
  });

  it('maps every draft transport the model may write, with nothing falling through', () => {
    for (const draft of DRAFT_TRANSPORTS) {
      expect(DRAFT_TRANSPORT_MODES, `the draft may say "${draft}" and nothing maps it`).toHaveProperty(draft);
      const mapped = travelModeFromDraft(draft);
      /* `unknown` is a legitimate destination for exactly one draft value. */
      if (draft !== 'unknown') expect(mapped, `"${draft}" fell through to unknown`).not.toBe('unknown');
    }
  });

  it('keeps the seven distinctions the old collapse lost', () => {
    /* Each of these was folded into another mode by `reconcile.ts#transportModeFor`. */
    expect(travelModeFromDraft('four_wheel_drive')).toBe('four_wheel_drive');
    expect(travelModeFromDraft('horse')).toBe('horse');
    expect(travelModeFromDraft('guide_or_lodge_transfer')).toBe('operator_transfer');
    expect(travelModeFromDraft('boat')).toBe('boat');
    expect(travelModeFromDraft('metro')).toBe('urban_transit');
    expect(travelModeFromDraft('taxi')).toBe('taxi');
    expect(travelModeFromDraft('flight')).toBe('flight');
    /* And none of them is the mode it used to become. */
    expect(travelModeFromDraft('four_wheel_drive')).not.toBe(travelModeFromDraft('car'));
    expect(travelModeFromDraft('horse')).not.toBe(travelModeFromDraft('private_transfer'));
    expect(travelModeFromDraft('boat')).not.toBe(travelModeFromDraft('ferry'));
  });

  it('maps every episode mode', () => {
    for (const episode of EPISODE_MODES) {
      expect(EPISODE_MODE_TRAVEL, `an episode may move by "${episode}" and nothing maps it`).toHaveProperty(episode);
      if (episode !== 'none') expect(travelModeFromEpisode(episode)).not.toBe('unknown');
    }
  });

  it('reads an unknown or absent word as unknown rather than guessing', () => {
    expect(travelModeFromDraft(undefined)).toBe('unknown');
    expect(travelModeFromDraft('teleport')).toBe('unknown');
    expect(travelModeFromEpisode(null)).toBe('unknown');
  });

  it('maps every persisted transport mode both ways', () => {
    for (const mode of TRANSPORT_MODES) {
      expect(TRANSPORT_MODE_TO_TRAVEL).toHaveProperty(mode);
      expect(travelModeFromTransport(mode)).toBeDefined();
    }
    for (const mode of TRAVEL_MODES) {
      expect(TRAVEL_MODE_TO_TRANSPORT).toHaveProperty(mode);
      expect(TRANSPORT_MODES).toContain(transportModeOf(mode));
    }
  });

  it('round-trips every persisted mode that has a one-to-one reading', () => {
    /*
     * Not every mode round-trips, and the ones that do not are the collapses
     * this vocabulary makes visible rather than hides: `unsupported` reads as
     * `unknown`, and four travel modes share `private_transfer`.
     */
    for (const mode of TRANSPORT_MODES) {
      if (mode === 'unsupported') continue;
      const back = transportModeOf(travelModeFromTransport(mode));
      expect(back, `${mode} did not survive the round trip`).toBe(mode);
    }
  });

  it('names a country concept for every mode that has one, and null where the vocabulary has none', () => {
    for (const mode of TRAVEL_MODES) {
      const concept = TRAVEL_MODE_CONCEPTS[mode];
      if (concept !== null) expect(MODE_CONCEPTS).toContain(concept);
      for (const member of TRAVEL_MODE_CONCEPT_FAMILY[mode]) expect(MODE_CONCEPTS).toContain(member);
    }
    /* Nobody publishes a national status for these three, and inventing one would be a lie. */
    expect(TRAVEL_MODE_CONCEPTS.horse).toBeNull();
    expect(TRAVEL_MODE_CONCEPTS.cable_car_or_lift).toBeNull();
    expect(TRAVEL_MODE_CONCEPTS.unknown).toBeNull();
  });

  it('asks about the whole rail family rather than one concept', () => {
    /* A country whose row names only high-speed rail is still a country with trains. */
    expect(TRAVEL_MODE_CONCEPT_FAMILY.rail).toContain('intercity_train');
    expect(TRAVEL_MODE_CONCEPT_FAMILY.rail).toContain('high_speed_rail');
  });

  it('knows which modes a road router could ever answer', () => {
    for (const mode of TRAVEL_MODES) expect(TRAVEL_MODE_ROUTING_PROFILE).toHaveProperty(mode);
    expect(isRoadRoutable('drive')).toBe(true);
    expect(isRoadRoutable('walk')).toBe(true);
    expect(isRoadRoutable('four_wheel_drive')).toBe(true);
    /* And the ones whose silence means nothing at all. */
    for (const mode of ['ferry', 'boat', 'flight', 'rail', 'urban_transit', 'trail', 'horse', 'cable_car_or_lift'] as TravelMode[]) {
      expect(isRoadRoutable(mode), `${mode} must not be attempted as a road leg`).toBe(false);
    }
  });

  it('never routes a trail through a road profile', () => {
    /* V12.1 §16: a trek stage is not a road journey with a different label on it. */
    expect(TRAVEL_MODE_ROUTING_PROFILE.trail).toBeNull();
    expect(TRAVEL_MODE_ROUTING_PROFILE.horse).toBeNull();
  });
});
