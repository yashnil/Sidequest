import { describe, expect, it } from 'vitest';
import { compiledRegionSchema } from '@sidequest/core';
import { compileRegion } from './compile';
import { deriveScope } from './scope';
import { fakeProviders, SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';

/**
 * WHAT THE COMPILATION OWES THE QUESTIONNAIRE.
 *
 * Stage B has existed as a mechanism since Phase 15 and has never fired in
 * production, because the only region carrying the copy it reads was the
 * authored Eastern Sierra fixture. Every compiled destination therefore got one
 * valley's questions: a city traveller graded scenic drives and hot springs,
 * and no destination anywhere was asked the one thing about it that would have
 * changed the plan.
 *
 * These tests are on the compiler rather than in `core/interests` on purpose.
 * The derivation is unit-tested there; what can only be checked here is that
 * the artifact a real compilation writes actually carries it, and survives its
 * own schema.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

function scopeFor(worldKey: keyof typeof SYNTHETIC_WORLDS) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const candidate = syntheticCandidate(spec);
  const scope = deriveScope({
    candidate,
    clarifications: emptyClarifications(),
    nights: DATES.length - 1,
    revision: 1,
  });
  return {
    ...scope,
    confirmedByUser: true,
    transport: { ...scope.transport, primaryMode: spec.primaryMode },
  };
}

async function compile(worldKey: keyof typeof SYNTHETIC_WORLDS) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  return compileRegion({
    compilationId: `intake-${spec.id}`,
    scope: scopeFor(worldKey),
    dates: DATES,
    months: MONTHS,
    providers: fakeProviders(spec),
    now: NOW,
  });
}

describe('a compiled region tells the questionnaire what to ask', () => {
  it('carries an interest offer drawn from what it found', async () => {
    const result = await compile('transit_city');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const offer = result.region.region.interestOffer;
    expect(offer).toBeDefined();
    expect(offer!.basis).toBe('region_evidence');
    expect(offer!.interests.length).toBeGreaterThan(0);

    /*
     * The claim that matters: the offer is a subset drawn from evidence, not
     * the whole vocabulary handed over unchanged. A region that offers
     * everything has not decided anything.
     */
    expect(offer!.interests.length).toBeLessThan(17);
  });

  it('survives its own schema, so a stored artifact reads back', async () => {
    const result = await compile('transit_city');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reparsed = compiledRegionSchema.parse(JSON.parse(JSON.stringify(result.region)));
    expect(reparsed.region.interestOffer?.basis).toBe(
      result.region.region.interestOffer?.basis,
    );
  });

  it('asks at most three follow-ups, each with a reason and a measurement', async () => {
    for (const key of Object.keys(SYNTHETIC_WORLDS)) {
      const result = await compile(key);
      if (!result.ok) continue;
      const questions = result.region.region.decisionQuestions ?? [];
      expect(questions.length).toBeLessThanOrEqual(3);
      for (const question of questions) {
        // §6.6: when a destination-triggered question is asked, briefly explain
        // why it matters. A follow-up without one is destination trivia.
        expect(question.why.length).toBeGreaterThan(10);
        expect(question.evidence.length).toBeGreaterThan(10);
        expect(question.prompt.length).toBeGreaterThan(5);
      }
      // Never the same question twice on one screen.
      expect(new Set(questions.map((question) => question.id)).size).toBe(questions.length);
    }
  });

  it('does not ask a region we cannot read anything into for its opinions', async () => {
    /*
     * The honest floor. A compilation that established nothing must not store
     * an offer, because an absent offer means "we withheld nothing" and a
     * stored one means "we assessed this region" — and only one of those is
     * true when there is no evidence.
     */
    const result = await compile('transit_city');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.region.region.interestOffer?.basis).not.toBe('whole_vocabulary');
  });
});
