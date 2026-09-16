import { describe, expect, it } from 'vitest';
import { deriveAffordances } from '../destinations/affordances';
import type { DestinationQuestionContext, DestinationTrait } from '../interview/traits';
import type { ModeWorldInput } from '../operating/mode-consistency';
import type { ModeStatus, TravelReality } from '../reality/schema';
import { PATTERN_MODES, screenModeAgainstGeography, screenModeAgainstWorld, screenProposedMode, selectModes } from './screening';
import type { TravelMode } from './vocabulary';

/**
 * V12.1 §7 §45 — THE PHANTOM-TRANSPORT CORPUS.
 *
 * Every case here is either a defect a live build actually produced, or its
 * mirror image — the over-correction that would be worse. They are kept
 * together deliberately: the failure mode of a screen like this is to fix the
 * first by committing the second, and V12 §17 did exactly that once before a
 * city-state acceptance caught it.
 *
 * Nothing names a destination in the *code*. The tests name places because a
 * test has to be about something, and each one builds its world from screened
 * traits and a country row, which is all the screen ever sees.
 */

function world(traits: DestinationTrait[], modes: Partial<Record<string, ModeStatus>> = {}, extra: Partial<ModeWorldInput> = {}): ModeWorldInput {
  const basis = Object.fromEntries(traits.map((trait) => [trait, `Screened: ${trait}.`])) as DestinationQuestionContext['basis'];
  const reality =
    Object.keys(modes).length > 0
      ? ({
          version: 1,
          countryCode: 'ZZ',
          modes: Object.entries(modes).map(([mode, status]) => ({ mode, status, scope: 'all', authority: 'compiled', asOf: '2026-01-01' })),
        } as unknown as TravelReality)
      : null;
  return {
    affordances: deriveAffordances({ destination: { traits, basis }, reality }),
    reality,
    ...extra,
  };
}

/** A world nobody could screen at all. Must refuse nothing. */
const UNSCREENED: ModeWorldInput = { affordances: deriveAffordances({ destination: { traits: [], basis: {} as DestinationQuestionContext['basis'] } }), reality: null };

describe('phantom transport', () => {
  it('refuses a ferry in a screened mountain road-trip region', () => {
    /* The Canadian Rockies defect: three ferry legs, one between a lake and its own shore. */
    const rockies = world(['mountain', 'road_trip_region', 'car_dependent']);
    const verdict = screenModeAgainstWorld('ferry', rockies);
    expect(verdict.ok).toBe(false);
    expect(verdict.refusedBy).toBe('world');
    expect(verdict.refusal).toMatch(/water/i);
  });

  it('keeps the ferry where the ground depends on crossing water', () => {
    const atolls = world(['archipelago', 'beach', 'water_transfer']);
    expect(screenModeAgainstWorld('ferry', atolls).ok).toBe(true);
    expect(screenModeAgainstWorld('boat', atolls).ok).toBe(true);
  });

  it('keeps the ferry where nothing was screened at all', () => {
    /* Silence is not a verdict. A city nobody screened keeps its legitimate crossing. */
    expect(screenModeAgainstWorld('ferry', UNSCREENED).ok).toBe(true);
    expect(screenModeAgainstWorld('rail', UNSCREENED).ok).toBe(true);
  });

  it('refuses a train in a screened region with no rail evidence', () => {
    /* A mountain country whose row says nothing about trains and whose ground is roads. */
    const highSteppe = world(['mountain', 'remote', 'car_dependent'], { private_driver: 'recommended', rental_car: 'friction' });
    expect(screenModeAgainstWorld('rail', highSteppe).ok).toBe(false);
  });

  it('keeps the train where the country runs them', () => {
    const railCountry = world(['dense_urban', 'transit_rich'], { high_speed_rail: 'recommended', intercity_train: 'recommended' });
    const verdict = screenModeAgainstWorld('rail', railCountry);
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.length).toBeGreaterThan(0);
  });

  it('keeps the train where only high-speed rail is on the row', () => {
    /* Asking one concept rather than the family would call this a country without trains. */
    expect(screenModeAgainstWorld('rail', world(['dense_urban'], { high_speed_rail: 'recommended' })).ok).toBe(true);
  });

  it('refuses a mode the country affirmatively calls unavailable', () => {
    const noFerries = world(['dense_urban', 'transit_rich'], { ferry: 'unavailable', cruise: 'unavailable' });
    expect(screenModeAgainstWorld('ferry', noFerries).ok).toBe(false);
  });

  it('treats discouraged and unknown as silence, not as a refusal', () => {
    expect(screenModeAgainstWorld('ferry', world(['beach', 'water_transfer'], { ferry: 'discouraged' })).ok).toBe(true);
    expect(screenModeAgainstWorld('drive', world(['road_trip_region'], { rental_car: 'unknown' })).ok).toBe(true);
  });

  it('never asks the world to justify an arrangement', () => {
    /* A hired car, a taxi, a guide's vehicle or a walk needs no evidence anywhere. */
    const anywhere = world(['dense_urban']);
    for (const mode of ['drive', 'taxi', 'private_transfer', 'operator_transfer', 'walk', 'shuttle', 'horse', 'trail'] as TravelMode[]) {
      expect(screenModeAgainstWorld(mode, anywhere).ok, `${mode} was refused`).toBe(true);
    }
  });

  it('lets a day that says it crosses water keep its ferry even in a dry screening', () => {
    const stated = world(['mountain', 'road_trip_region'], {}, { dayMoveModes: ['ferry'] });
    expect(screenModeAgainstWorld('ferry', stated).ok).toBe(true);
  });

  it('lets an episode that moves by boat keep its boat', () => {
    const cruise = world(['dense_urban'], {}, { episodeModes: ['boat'] });
    expect(screenModeAgainstWorld('boat', cruise).ok).toBe(true);
  });
});

describe('geography', () => {
  it('refuses a ninety-kilometre walk', () => {
    const verdict = screenModeAgainstGeography('walk', 90);
    expect(verdict.ok).toBe(false);
    expect(verdict.refusedBy).toBe('geography');
  });

  it('refuses a four-kilometre flight', () => {
    expect(screenModeAgainstGeography('flight', 4).ok).toBe(false);
  });

  it('allows an ordinary walk, an ordinary drive and a long flight', () => {
    expect(screenModeAgainstGeography('walk', 1.4).ok).toBe(true);
    expect(screenModeAgainstGeography('drive', 400).ok).toBe(true);
    expect(screenModeAgainstGeography('flight', 900).ok).toBe(true);
  });

  it('has no opinion without a distance', () => {
    expect(screenModeAgainstGeography('walk', null).ok).toBe(true);
    expect(screenModeAgainstGeography('walk', undefined).ok).toBe(true);
  });

  it('lets a trail stage be long, because they are', () => {
    expect(screenModeAgainstGeography('trail', 18).ok).toBe(true);
  });
});

describe('the selection pipeline', () => {
  it('will not give a walking city trip a rental car it never asked for', () => {
    const city = world(['dense_urban', 'transit_rich', 'walk_heavy'], { metro: 'recommended', intercity_train: 'recommended' });
    const selection = selectModes({ policy: { mobilityPattern: 'walk_and_transit' }, world: city, straightLineKm: 3 });
    expect(selection.candidates).toContain('walk');
    expect(selection.candidates).toContain('urban_transit');
    /* Driving is not among what this kind of trip travels by — the policy never proposes it. */
    expect(selection.candidates).not.toContain('drive');
  });

  it('still honours a drive the plan itself proposed in a walking city', () => {
    /* A taxi to the airport is not a policy violation, and a screen that refused it would be wrong. */
    const city = world(['dense_urban', 'transit_rich'], { metro: 'recommended' });
    const selection = selectModes({ proposed: 'taxi', policy: { mobilityPattern: 'walk_and_transit' }, world: city, straightLineKm: 22 });
    expect(selection.candidates[0]).toBe('taxi');
  });

  it('drops a mode the traveller said they would not use', () => {
    const anywhere = world(['road_trip_region']);
    const accepted = new Set<TravelMode>(['walk', 'bus', 'rail', 'taxi']);
    const selection = selectModes({ accepted, policy: { mobilityPattern: 'mixed' }, world: anywhere, straightLineKm: 30 });
    expect(selection.candidates).not.toContain('drive');
    expect(selection.refused.find((entry) => entry.mode === 'drive')?.refusedBy).toBe('traveler');
  });

  it('gives each operating family a coherent set of ways to move', () => {
    for (const [pattern, modes] of Object.entries(PATTERN_MODES)) {
      expect(modes.length, `${pattern} has no modes`).toBeGreaterThan(0);
      expect(new Set(modes).size, `${pattern} repeats a mode`).toBe(modes.length);
    }
    /* A trek moves on foot; a self-drive trip drives; and neither is the other. */
    expect(PATTERN_MODES.trail).toContain('trail');
    expect(PATTERN_MODES.trail).not.toContain('rail');
    expect(PATTERN_MODES.self_drive).toContain('drive');
    expect(PATTERN_MODES.walk_and_transit).not.toContain('drive');
  });

  it('screens one proposal without needing a whole selection', () => {
    const rockies = world(['mountain', 'road_trip_region', 'car_dependent']);
    expect(screenProposedMode('ferry', { world: rockies }).ok).toBe(false);
    expect(screenProposedMode('drive', { world: rockies }).ok).toBe(true);
  });
});

/**
 * V12.1 §45 — the two cases the corpus names that the rest of this file does
 * not reach: a boat that is an activity rather than a journey, and two names
 * for one place.
 */
describe('the failure corpus’s remaining cases', () => {
  it('does not turn a lagoon boat trip into transport between two stops', () => {
    /*
     * The distinction §13 draws. A tour boat is an *experience* — it leaves from
     * a place and returns to it — and the shape that gives it away is that its
     * two endpoints are the same. A journey between a place and itself is not a
     * journey, and the reconciler already drops a pair under 150 m; this states
     * the rule where the mode screen can see it, because "a boat leg with
     * identical endpoints" is exactly what a tour looks like to a leg builder.
     */
    const lagoon = world(['archipelago', 'beach', 'water_transfer']);
    /* The world permits the mode — this is a place people move by boat. */
    expect(screenModeAgainstWorld('boat', lagoon).ok).toBe(true);
    /* And the geometry refuses it as a *journey*: nobody crosses 200 m of water to arrive where they started. */
    expect(screenModeAgainstGeography('boat', 0.2).ok).toBe(false);
  });

  it('refuses a crossing between two names for the same place', () => {
    /* The Lake Louise / Lake Louise Lakeshore shape, stated as geometry rather than as a name. */
    expect(screenModeAgainstGeography('ferry', 0.1).ok).toBe(false);
    expect(screenModeAgainstGeography('flight', 0.4).ok).toBe(false);
  });

  it('keeps a real crossing of the same kind', () => {
    /* And the mirror image, so the rule above is a floor rather than a ban. */
    expect(screenModeAgainstGeography('ferry', 35).ok).toBe(true);
    expect(screenModeAgainstGeography('boat', 12).ok).toBe(true);
  });
});
