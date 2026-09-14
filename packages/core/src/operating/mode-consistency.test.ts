import { describe, expect, it } from 'vitest';
import { deriveAffordances } from '../destinations/affordances';
import type { DestinationTrait } from '../interview/traits';
import type { TravelReality } from '../reality/schema';
import { assessModeConsistency, modeNeedsWorldEvidence, railEvidence, waterEvidence } from './mode-consistency';

const ground = (traits: DestinationTrait[]) =>
  deriveAffordances({ destination: { traits, basis: Object.fromEntries(traits.map((t) => [t, `screened as ${t}`])) } });

const reality = (modes: { mode: string; status: string }[]) =>
  ({ version: 1, countryCode: 'XX', modes: modes.map((m) => ({ ...m, scope: 'all', reason: '', authority: 'reference', freshness: 'stable', asOf: '2026-01-01' })), facts: [] }) as unknown as TravelReality;

/** The live V11 §S shape: a landlocked mountain region reached by car. */
const ROCKIES: DestinationTrait[] = ['mountain', 'road_trip_region', 'car_dependent', 'weather_exposed'];
/** An archipelago people move around by boat. */
const ISLANDS: DestinationTrait[] = ['beach', 'island', 'archipelago', 'water_transfer'];

describe('V12 §17 — a ferry needs water, not a willing traveller', () => {
  it('refuses a boat leg in a landlocked mountain region, which is what shipped', () => {
    const verdict = assessModeConsistency('ferry', { affordances: ground(ROCKIES) });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusal).toMatch(/crosses water/);
    /* And it says so in a sentence a traveller could read, with no field names in it. */
    expect(verdict.refusal).not.toMatch(/[a-z]+[A-Z]|_/);
  });

  it('allows one where the ground itself moves by boat', () => {
    const verdict = assessModeConsistency('ferry', { affordances: ground(ISLANDS) });
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.map((e) => e.kind)).toContain('destination_trait');
  });

  it('allows one where the trip itself says a day crosses by boat', () => {
    /* The Greek-islands shape: the ground was never screened, but the plan declared the crossing. */
    const verdict = assessModeConsistency('ferry', { dayMoveModes: ['ferry'] });
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.map((e) => e.kind)).toEqual(['day_move']);
  });

  it('allows one inside an experience that moves by boat', () => {
    const verdict = assessModeConsistency('ferry', { affordances: ground(ROCKIES), episodeModes: ['boat'] });
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.map((e) => e.kind)).toEqual(['episode']);
  });

  it('reads a country that says nothing as neither yes nor no', () => {
    /* Silence removes nothing and establishes nothing — the rule V9.1 applies to routing. */
    expect(waterEvidence({ reality: reality([]) })).toHaveLength(0);
    expect(waterEvidence({ reality: reality([{ mode: 'ferry', status: 'unknown' }]) })).toHaveLength(0);
    expect(waterEvidence({ reality: reality([{ mode: 'ferry', status: 'viable' }]) }).length).toBeGreaterThan(0);
  });
});

describe('V12 §17 — rail is the other mode the world has to supply', () => {
  it('refuses a train where the ground was screened and has none', () => {
    expect(assessModeConsistency('rail', { affordances: ground(ROCKIES) }).ok).toBe(false);
  });

  it('allows one where the country runs them, or where the plan says so', () => {
    expect(assessModeConsistency('rail', { reality: reality([{ mode: 'intercity_train', status: 'recommended' }]) }).ok).toBe(true);
    expect(assessModeConsistency('rail', { dayMoveModes: ['rail'] }).ok).toBe(true);
    expect(railEvidence({ affordances: ground(['dense_urban', 'transit_rich']) }).length).toBeGreaterThan(0);
  });
});

describe('V12 §17 — everything arrangeable stays arrangeable', () => {
  it('never refuses a mode somebody can simply organise', () => {
    for (const mode of ['drive', 'walk', 'private_transfer', 'shuttle', 'rideshare', 'public_bus', 'bicycle'] as const) {
      expect(modeNeedsWorldEvidence(mode), mode).toBe(false);
      expect(assessModeConsistency(mode, {}).ok, mode).toBe(true);
    }
  });

  it('refuses nothing when the world was never consulted, because silence is not a verdict', () => {
    /*
     * The rule this module exists to enforce, applied to itself: a destination
     * nobody screened and a country nobody asked say nothing, and a plan keeps
     * its own hint until something contradicts it. Only a *consulted* world that
     * came back without water may take a boat leg away.
     */
    expect(assessModeConsistency('drive', {}).ok).toBe(true);
    expect(assessModeConsistency('ferry', {}).ok).toBe(true);
    expect(assessModeConsistency('rail', {}).ok).toBe(true);
    expect(assessModeConsistency('ferry', { affordances: ground([]) }).ok).toBe(true);
  });
});
