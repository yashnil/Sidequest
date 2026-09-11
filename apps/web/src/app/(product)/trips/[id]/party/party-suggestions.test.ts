import { describe, expect, it } from 'vitest';
import type { Traveler } from '@sidequest/core';
import { PARTY_NOTE_SUGGESTIONS, appendPhrase, hasPhrase, personFacts } from './party-suggestions';

describe('appendPhrase', () => {
  it('starts the notes with the phrase when they are empty', () => {
    expect(appendPhrase('', 'Needs frequent seated breaks')).toBe('Needs frequent seated breaks');
    expect(appendPhrase(undefined, 'Avoids steep descents')).toBe('Avoids steep descents');
  });

  it('adds the phrase as its own sentence after existing words', () => {
    expect(appendPhrase('Knee is fine on the flat', 'Avoids steep descents')).toBe('Knee is fine on the flat. Avoids steep descents');
    expect(appendPhrase('Knee is fine on the flat.', 'Avoids steep descents')).toBe('Knee is fine on the flat. Avoids steep descents');
  });

  it('never adds a phrase twice', () => {
    const once = appendPhrase('', 'Severe peanut allergy');
    expect(appendPhrase(once, 'severe peanut allergy')).toBe(once);
    expect(hasPhrase(once, 'Severe peanut allergy')).toBe(true);
    expect(hasPhrase('nothing here', 'Severe peanut allergy')).toBe(false);
  });

  it('every suggestion is a planning consequence in plain words, never a diagnosis', () => {
    expect(PARTY_NOTE_SUGGESTIONS.length).toBeGreaterThanOrEqual(6);
    for (const phrase of PARTY_NOTE_SUGGESTIONS) expect(phrase).not.toMatch(/surgery|diagnos|disease|disorder|syndrome/i);
  });
});

describe('personFacts', () => {
  const base: Pick<Traveler, 'diet' | 'needs' | 'needsNotes' | 'profile'> = { diet: { needs: [], strict: false, allergyCrossContamination: false }, needs: [], profile: { interests: {}, transportComfort: [], lodgingNeeds: [] } };

  it('a strict diet and an allergy are hard; a soft diet is a preference', () => {
    const facts = personFacts({ ...base, diet: { ...base.diet, needs: ['vegetarian', 'nut_allergy'] } }, { preferencesApply: true, constraintsApply: true });
    expect(facts.hard).toEqual(['Nut allergy']);
    expect(facts.preferences).toContain('Vegetarian');
    const strict = personFacts({ ...base, diet: { ...base.diet, needs: ['vegetarian'], strict: true } }, { preferencesApply: true, constraintsApply: true });
    expect(strict.hard).toEqual(['Vegetarian']);
  });

  it('a functional need binds the plan unless the person said it does not, and is never dropped either way', () => {
    const binds = personFacts({ ...base, needs: ['limited_walking'] }, { preferencesApply: true, constraintsApply: true });
    expect(binds.hard).toEqual(['Difficulty walking long distances']);
    const noted = personFacts({ ...base, needs: ['limited_walking'] }, { preferencesApply: true, constraintsApply: false });
    expect(noted.hard).toEqual([]);
    expect(noted.preferences[0]).toMatch(/Difficulty walking long distances/);
  });

  it('notes are private and kept verbatim', () => {
    const facts = personFacts({ ...base, needsNotes: 'Cannot walk more than about 2 km at a time', diet: { ...base.diet, notes: 'eats eggs' } }, { preferencesApply: true, constraintsApply: true });
    expect(facts.privateNotes).toEqual(['eats eggs', 'Cannot walk more than about 2 km at a time']);
  });

  it('capacity, mornings and driving are preferences in words', () => {
    const facts = personFacts({ ...base, profile: { ...base.profile, physicalCapability: 'low', sleepRhythm: 'early', transportComfort: ['drives'] } }, { preferencesApply: false, constraintsApply: true });
    expect(facts.preferences).toEqual(['Takes it easy', 'Early riser', 'Can drive on this trip', 'Tastes do not shape the plan']);
  });
});
