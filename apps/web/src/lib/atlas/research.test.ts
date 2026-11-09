import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAdvisorShortlist, emptyComposerAnswers, needsResearch, parseTravelRequest, type Atlas, type TripComposerAnswers } from '@sidequest/core';
import { loadAtlas, resetAtlasForTests } from '@sidequest/atlas';
import { researchSuggestions, resolveSuggestions, setResearchFixturesForTests } from './research';


/* These load the real atlas artifact; the budget is for a loaded machine, not a performance claim. */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * AI-assisted discovery, against the real atlas: a model's suggestion is a
 * name to look up, and everything that follows — whether it exists, whether it
 * fits, where it ranks — is the atlas's and the scorer's.
 */
const NOW = new Date('2026-11-08T12:00:00Z');
let atlas: Atlas;

function answersFor(text: string): TripComposerAnswers {
  const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
  return parseTravelRequest(text, base, NOW, atlas).answers;
}
const shortlistFor = (answers: TripComposerAnswers, research: Parameters<typeof buildAdvisorShortlist>[0]['research'] = null) =>
  buildAdvisorShortlist({ answers, catalog: atlas, catalogVersion: atlas.version, now: NOW, research });

beforeAll(() => {
  resetAtlasForTests();
  atlas = loadAtlas({ now: NOW })!.atlas;
});

afterEach(() => {
  vi.unstubAllEnvs();
  setResearchFixturesForTests({});
});

describe('resolving what a research model proposes', () => {
  it('keeps a real place in the right country and drops everything else', () => {
    const ids = resolveSuggestions(
      {
        suggestions: [
          { name: 'Hunza Valley', country: 'Pakistan' },
          { name: 'Svaneti', country: 'Georgia' },
          /* Invented: no such destination. */
          { name: 'Vale of Glimmerhold', country: 'Norway' },
          /* A real name in the wrong country is a different place. */
          { name: 'Hunza Valley', country: 'Peru' },
        ],
      },
      atlas,
    );
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => atlas.byId(id)?.countries[0])).toEqual(['PK', 'GE']);
  });
});

describe('when research is asked for', () => {
  it('is not asked for a request the atlas answers confidently', async () => {
    const answers = answersFor('Hiking in the Alps in late September, somewhere quieter than Chamonix and Zermatt.');
    const shortlist = shortlistFor(answers);
    expect(needsResearch(answers, shortlist)).toBe(false);
    vi.stubEnv('SIDEQUEST_ADVISOR_RESEARCH', 'fixture');
    const outcome = await researchSuggestions({ answers, shortlist, atlas });
    expect(outcome).toMatchObject({ source: 'not_needed', modelCalls: 0, ids: [] });
  });

  it('does nothing when switched off, whatever the list looks like', async () => {
    const answers = answersFor('Old trading ports with crumbling merchant houses, in March.');
    const shortlist = { ...shortlistFor(answers), picks: [] };
    vi.stubEnv('SIDEQUEST_ADVISOR_RESEARCH', 'off');
    expect(await researchSuggestions({ answers, shortlist, atlas })).toMatchObject({ source: 'off', modelCalls: 0, ids: [] });
  });

  it('does nothing without the atlas to verify against', async () => {
    const answers = answersFor('Old trading ports with crumbling merchant houses, in March.');
    vi.stubEnv('SIDEQUEST_ADVISOR_RESEARCH', 'fixture');
    expect(await researchSuggestions({ answers, shortlist: { ...shortlistFor(answers), picks: [] }, atlas: null })).toMatchObject({ source: 'off', ids: [] });
  });
});

describe('a proposed place is a candidate, never a recommendation', () => {
  const request = 'Old trading ports with crumbling merchant houses, in March.';

  it('ranks a suggestion with the same scorer and says it was suggested', async () => {
    const answers = answersFor(request);
    const before = { ...shortlistFor(answers), picks: [] };
    vi.stubEnv('SIDEQUEST_ADVISOR_RESEARCH', 'fixture');
    setResearchFixturesForTests({ [request.toLowerCase()]: { suggestions: [{ name: 'Zanzibar', country: 'Tanzania' }, { name: 'Galle', country: 'Sri Lanka' }, { name: 'Nowhere-on-Sea', country: 'Atlantis' }] } });
    const outcome = await researchSuggestions({ answers, shortlist: before, atlas });
    expect(outcome.source).toBe('fixture');
    expect(outcome.proposed).toBe(3);
    expect(outcome.ids.length).toBe(2);
    expect(outcome.modelCalls).toBe(0);

    const widened = shortlistFor(answers, { ids: outcome.ids, proposed: outcome.proposed, note: outcome.note });
    expect(widened.stats.research).toMatchObject({ proposed: 3, resolved: 2 });
    /* Whatever reached the list from the suggestions is marked; nothing else is. */
    for (const pick of [...widened.picks, ...widened.alternates]) expect(pick.suggested).toBe(outcome.ids.includes(pick.id));
    expect(widened.stats.research!.shown).toBe([...widened.picks, ...widened.alternates].filter((pick) => pick.suggested).length);
  });

  it('cannot push a place past a hard constraint', () => {
    /* Proposed for a request scoped to Indonesia: a place in another country is simply not a candidate. */
    const answers = answersFor('Tropical islands in Indonesia in July, snorkelling and quiet beaches, not Bali.');
    const elsewhere = atlas.resolveName('Maui')!;
    const ruledOut = atlas.resolveName('Ubud')!;
    const widened = shortlistFor(answers, { ids: [elsewhere.id, ruledOut.id], proposed: 2, note: 'test' });
    const shown = [...widened.picks, ...widened.alternates].map((pick) => pick.id);
    expect(shown).not.toContain(elsewhere.id);
    expect(shown).not.toContain(ruledOut.id);
  });
});
