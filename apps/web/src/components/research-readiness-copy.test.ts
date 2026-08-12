import { describe, expect, it } from 'vitest';
import type { ResearchDimensionReport, ResearchFunnel } from '@sidequest/core';
import { deficitSentence } from './ResearchReadinessPanel';

/**
 * §26 AT THE ONE PANEL THAT KEPT SPEAKING AS THE COMPILER.
 *
 * The three sentences below are verbatim from a live Tokyo board, printed one
 * under another beneath "Worth knowing before you plan". They are the contract's
 * own bad example — a ratio with no consequence attached — and the middle one
 * does not even say what it is counting.
 *
 * The assertions are about *voice*, not about wording: a bare "N of M", a
 * dangling count with no noun, and the words a research engine uses about
 * itself. A rewrite that changed the phrasing but kept the arithmetic would
 * still fail here, which is the point.
 */

function funnel(overrides: Partial<ResearchFunnel> = {}): ResearchFunnel {
  return {
    packRecords: 400,
    visitable: 23,
    anchors: 23,
    discoveries: 0,
    food: 2,
    support: 5,
    gateways: 1,
    anchorDemotions: 0,
    membershipUnverified: 23,
    tripDays: 4,
    ...overrides,
  };
}

function report(
  dimension: ResearchDimensionReport['dimension'],
  detail: string,
  observed?: number,
): ResearchDimensionReport {
  return {
    dimension,
    state: 'partial',
    detail,
    required: false,
    ...(observed === undefined ? {} : { observed }),
  };
}

/** A bare fraction, which is the shape §26 names. */
const RATIO = /\b\d+\s*(?:of|\/)\s*\d+\b/;

describe('the readiness panel speaks to a traveller', () => {
  it('turns "opening times for 0 of 23" into what to do about it', () => {
    const sentence = deficitSentence(
      report('hours_evidence', 'We know the opening times for 0 of 23.', 0),
      funnel(),
    );
    expect(sentence).not.toMatch(RATIO);
    /* It has to say what follows from it, not merely that it is missing. */
    expect(sentence).toMatch(/check|shut|closed/i);
  });

  it('says what "23 to build days around and 0 smaller finds" means for the days', () => {
    const sentence = deficitSentence(
      report('role_diversity', '23 to build days around and 0 smaller finds.', 23),
      funnel(),
    );
    expect(sentence).not.toMatch(RATIO);
    expect(sentence).not.toBe('23 to build days around and 0 smaller finds.');
    expect(sentence).toMatch(/nothing smaller|headline/i);
  });

  it('reads the other way round when the board is all small finds', () => {
    const sentence = deficitSentence(
      report('role_diversity', '0 to build days around and 19 smaller finds.', 19),
      funnel({ anchors: 0, discoveries: 19 }),
    );
    expect(sentence).toMatch(/build a day around/i);
  });

  it('gives "0 quieter finds" a subject', () => {
    const sentence = deficitSentence(report('hidden_gem_coverage', '0 quieter finds.', 0), funnel());
    expect(sentence).not.toMatch(/^\d/);
    expect(sentence.split(' ').length).toBeGreaterThan(4);
  });

  it('leaves a dimension it has no better sentence for exactly as written', () => {
    const detail = 'What we found does not look like the place you asked for.';
    expect(deficitSentence(report('identity_agreement', detail), funnel())).toBe(detail);
  });

  it('uses no research-engine vocabulary in anything it rewrites', () => {
    // §26's list, restricted to the words that could land in this panel.
    const banned =
      /\b(candidate|evidence pack|role diversity|membership|containment|readiness|provider|matrix|inventory|coverage|visitable|anchor|unmeasured|diagnostics)\b/i;
    const rewritten = [
      deficitSentence(report('hours_evidence', 'x', 0), funnel()),
      deficitSentence(report('hours_evidence', 'x', 4), funnel()),
      deficitSentence(report('role_diversity', 'x', 23), funnel()),
      deficitSentence(report('role_diversity', 'x', 19), funnel({ anchors: 0, discoveries: 19 })),
      deficitSentence(report('hidden_gem_coverage', 'x', 0), funnel()),
    ];
    for (const sentence of rewritten) expect(sentence, sentence).not.toMatch(banned);
  });
});
