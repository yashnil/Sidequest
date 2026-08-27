import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RESEARCH_READINESS_COPY,
  type CoverageReport,
  type ResearchDimensionReport,
  type ResearchFunnel,
} from '@sidequest/core';
import { coverageStoppedEarly, deficitSentence, readinessBlurb } from './ResearchReadinessPanel';

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
    const detail =
      'Every one of the 210 places we could pin down is published in a different country or region from the destination you asked for.';
    expect(deficitSentence(report('identity_agreement', detail), funnel())).toBe(detail);
  });

  it('owns a budget stop instead of blaming the world for it', () => {
    /*
     * A live dense-city build carried "There genuinely is not much published
     * about this place" on the same page whose build report said "we stopped
     * early because this trip ran out of lookups". Both cannot be true, and
     * the one the banner picked was false: the scarcity was self-imposed.
     * A `thin` reading on a budget-stopped build must attribute the thinness
     * to the stop, and must not assert anything about what the world
     * publishes.
     */
    const sentence = readinessBlurb('thin', true);
    expect(sentence).toMatch(/stopped before reading|ran out of lookups/i);
    expect(sentence).not.toMatch(/not much published/i);
    // The claim itself is not weakened: it still says there is less here.
    expect(sentence).toMatch(/less of it/i);
  });

  it('keeps the world-thin sentence for ground that is genuinely quiet', () => {
    /*
     * The control: on a build that read everything it set out to read, "the
     * world publishes little" is the honest reading and must survive intact —
     * a branch that softened it everywhere would be the opposite defect.
     */
    expect(readinessBlurb('thin', false)).toBe(RESEARCH_READINESS_COPY.thin.blurb);
  });

  it('leaves every non-thin level alone whatever the build did', () => {
    for (const level of ['ready', 'recoverable', 'blocked'] as const) {
      expect(readinessBlurb(level, true)).toBe(RESEARCH_READINESS_COPY[level].blurb);
      expect(readinessBlurb(level, false)).toBe(RESEARCH_READINESS_COPY[level].blurb);
    }
  });

  it('reads the budget stop off the artifact’s own coverage report', () => {
    const stopped: Pick<CoverageReport, 'dimensions'> = {
      dimensions: [
        {
          dimension: 'operating_hours',
          level: 'weak',
          reasons: ['budget_exhausted', 'no_official_source_found'],
          detail: 'x',
        },
      ] as CoverageReport['dimensions'],
    };
    const clean: Pick<CoverageReport, 'dimensions'> = {
      dimensions: [
        {
          dimension: 'operating_hours',
          level: 'high',
          reasons: ['fully_covered'],
          detail: 'x',
        },
      ] as CoverageReport['dimensions'],
    };
    expect(coverageStoppedEarly(stopped)).toBe(true);
    expect(coverageStoppedEarly(clean)).toBe(false);
    // No artifact is not a budget stop — an absence must not colour the banner.
    expect(coverageStoppedEarly(null)).toBe(false);
  });

  it('is wired on both screens that render the panel, not merely exported', () => {
    /*
     * The branch above is a pure function, and a pure function nobody calls
     * with a true argument is a fix that did not ship — precisely how the
     * readiness reading itself once sat computed and rendered nowhere. So the
     * two render sites are held to passing the fact through, in the pattern
     * `actions.architecture.test.ts` uses: asserted against the source with
     * comments stripped, because the property is about wiring rather than
     * output.
     */
    const strip = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const planFlow = strip(
      readFileSync(new URL('./PlanFlow.tsx', import.meta.url).pathname, 'utf8'),
    );
    const discover = strip(
      readFileSync(
        new URL('../app/(product)/trips/[id]/discover/page.tsx', import.meta.url).pathname,
        'utf8',
      ),
    );
    for (const [name, source] of [
      ['PlanFlow', planFlow],
      ['discover page', discover],
    ] as const) {
      expect(source, `${name} must hand the panel the stopped-early fact`).toMatch(
        /buildStoppedEarly=\{/,
      );
      expect(source, `${name} must derive it from the artifact's coverage`).toContain(
        'coverageStoppedEarly(',
      );
    }
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
