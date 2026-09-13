import { describe, expect, it } from 'vitest';
import { assuranceForNodeState, assuranceForTravel, assuranceForVerification, assuranceSummary, ASSURANCE_TIERS, weakestAssurance } from './assurance';
import { TRIP_NODE_STATES } from './state-graph';
import { TRAVEL_DURATION_STATES } from '../travel/estimate';
import { VERIFICATION_STATES } from '../schemas/itinerary';

describe('V11 §21 — four traveller words, and only four', () => {
  it('folds every state-graph state into one of the four', () => {
    for (const state of TRIP_NODE_STATES) expect(ASSURANCE_TIERS).toContain(assuranceForNodeState(state));
  });

  it('folds every verification state into one of the four', () => {
    for (const state of VERIFICATION_STATES) expect(ASSURANCE_TIERS).toContain(assuranceForVerification(state));
  });

  it('folds every travel-duration state into one of the four', () => {
    for (const state of TRAVEL_DURATION_STATES) expect(ASSURANCE_TIERS).toContain(assuranceForTravel(state));
  });

  it('separates the traveller’s decision from Sidequest’s own unfinished work', () => {
    expect(assuranceForNodeState('needs_decision', 'traveller')).toBe('check');
    expect(assuranceForNodeState('needs_decision', 'sidequest')).toBe('unresolved');
  });

  it('does not badge the state almost every stop is in', () => {
    /* "A real place at this name was confirmed; hours and access have not been" was on nearly every row of both founder trips. */
    expect(assuranceForVerification('partially_verified')).toBe('planned');
  });

  it('treats an operator’s own timetable as a plan, not as a gap', () => {
    expect(assuranceForTravel('scheduled')).toBe('confirmed');
    expect(assuranceForTravel('geo_estimate')).toBe('planned');
    expect(assuranceForTravel('unknown')).toBe('unresolved');
  });

  it('takes the weakest tier for a day made of several things', () => {
    expect(weakestAssurance(['confirmed', 'planned', 'check'])).toBe('check');
    expect(weakestAssurance(['confirmed', 'confirmed'])).toBe('confirmed');
    expect(weakestAssurance([])).toBe('confirmed');
  });
});

describe('V11 §21 — one sentence for a day instead of a badge on every row', () => {
  it('says nothing when there is nothing to say', () => {
    expect(assuranceSummary({ unresolvedLegs: 0, unresolvedPlaces: 0, toCheck: 0 })).toBeNull();
  });

  it('aggregates rather than repeating', () => {
    expect(assuranceSummary({ unresolvedLegs: 2, unresolvedPlaces: 0, toCheck: 0 })).toBe('2 journey times still being worked out');
  });

  it('joins several kinds into one readable sentence', () => {
    expect(assuranceSummary({ unresolvedLegs: 2, unresolvedPlaces: 1, toCheck: 3 })).toBe('2 journey times still being worked out, 1 place still being located and 3 things to check before you rely on them');
  });

  it('gets the singular right', () => {
    expect(assuranceSummary({ unresolvedLegs: 1, unresolvedPlaces: 0, toCheck: 1 })).toBe('1 journey time still being worked out and 1 thing to check before you rely on it');
  });
});
