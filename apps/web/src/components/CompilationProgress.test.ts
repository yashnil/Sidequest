import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StageRecord } from '@sidequest/core';
import { CompilationProgress } from './CompilationProgress';

/**
 * THE ZOMBIE, ASSERTED.
 *
 * A live trip rendered this, on 2026-08-11, for a build whose last heartbeat was
 * on 2026-08-03:
 *
 * ```text
 * Shaping the region                                    12458m 52s
 * [ Working ] Shaping the region                 5/6 · 12458m 52s
 * [ Working ] Finding the strongest places       6/7 · 12458m 52s
 * ...
 * You can close this page. The build carries on and picks up where it left off.
 * ```
 *
 * Four separate lies in one card — a present-tense stage label, a "Working"
 * badge, a duration in minutes that was eight and a half days, and a promise
 * that the build was still going. All four came from the same missing input:
 * nothing on this screen knew whether a process was still alive.
 *
 * Every assertion below fails against the version that shipped.
 */

function stage(
  name: StageRecord['stage'],
  status: StageRecord['status'],
  extra: Partial<StageRecord> = {},
): StageRecord {
  return { stage: name, status, ...extra } as StageRecord;
}

/** Eight days before the fixed "now" the render is compared against. */
const STARTED = '2026-08-03T06:31:00.000Z';

const STAGES: StageRecord[] = [
  stage('partitioning_scope', 'done', { outcome: '4 candidate bases across 7 areas' }),
  stage('expanding_region', 'running', {
    note: '18 outlying areas are beyond what one build reads.',
  }),
];

function render(live: boolean): string {
  return renderToStaticMarkup(
    createElement(CompilationProgress, {
      stages: STAGES,
      failed: false,
      live,
      startedAt: STARTED,
      estimate: null,
    }),
  );
}

describe('a build nobody is running is not described in the present tense', () => {
  it('does not say "Working" once the process is gone', () => {
    const markup = render(false);
    expect(markup).not.toContain('>Working<');
    expect(markup).toContain('Stopped part-way');
  });

  it('does not promise a dead build is carrying on', () => {
    expect(render(false)).not.toMatch(/The build carries on/);
    // And still says it while one genuinely is.
    expect(render(true)).toMatch(/The build carries on/);
  });

  it('reports when it stopped rather than counting since it started', () => {
    const markup = render(false);
    // The defect's own string, in the unit it was rendered in.
    expect(markup).not.toMatch(/\d{3,}m \d+s/);
    expect(markup).toMatch(/ago/);
  });

  it('does not animate a phase that is not moving', () => {
    // `breathing` is the pulse applied to the running stage. On a dead build it
    // is the most visible of the four lies.
    expect(render(false)).not.toContain('breathing');
    expect(render(true)).toContain('breathing');
  });

  it('does not put the compiler’s nouns on the card a traveller reads', () => {
    // §26 lists "candidate" first. The count and the claim have to survive the
    // substitution — a rewrite that dropped the number would be a worse defect
    // than the word.
    //
    // Scoped to the primary card: the technical disclosure below it is the
    // operator's surface and deliberately quotes the stage verbatim, which is
    // why the whole-markup form of this assertion would be wrong.
    const card = render(false).split('data-testid="technical-stages"')[0]!;
    expect(card).not.toMatch(/\bcandidate/i);
    expect(card).toContain('4 possible bases across 7 areas');
  });

  it('moves stage notes out of the phase card and says where they went', () => {
    const markup = render(true);
    // Counted on the card…
    expect(markup).toContain('1 note about how this build read the data');
    // …and rendered exactly once, inside the technical disclosure.
    const note = '18 outlying areas are beyond what one build reads.';
    expect(markup.split(note).length - 1).toBe(1);
    expect(markup).toContain('Technical details');
  });
});

/**
 * THE BUILD SCREEN DESCRIBING SOMETHING A SEQUENTIAL BUILD CANNOT BE DOING.
 *
 * A fresh reviewer opened a live build and found three of four phase cards
 * reading "Working" at once, each carrying a bare fraction and "9 days" — on a
 * build that had been running for minutes — over a line reading "Already held,
 * so nothing was bought for it: 0 of 8 already answered, 0 facts reused".
 *
 * Four separate claims, none of which the page had any business making. Each one
 * below fails against the version that shipped.
 */
describe('a sequential build is narrated one step at a time', () => {
  /** A build whose earlier phase left a stage open and moved on. */
  const STRAGGLERS: StageRecord[] = [
    stage('partitioning_scope', 'done', { outcome: '4 candidate bases across 7 areas' }),
    // Started, never closed: the compiler has moved past it.
    stage('building_region_pack', 'running'),
    stage('discovering_candidates', 'running'),
  ];

  function markup(stages: StageRecord[]): string {
    return renderToStaticMarkup(
      createElement(CompilationProgress, {
        stages,
        failed: false,
        live: true,
        startedAt: new Date().toISOString(),
        estimate: null,
      }),
    );
  }

  it('badges exactly one phase as working, however many stages are open', () => {
    const working = markup(STRAGGLERS).match(/>Working</g) ?? [];
    expect(
      working.length,
      'two phases of a sequential build cannot both be the one happening now',
    ).toBe(1);
  });

  it('names what the count is counting rather than printing a bare fraction', () => {
    const html = markup(STRAGGLERS);
    expect(html).toMatch(/\d+ of \d+ steps/);
    // The shipped form, which nobody outside the team can read.
    expect(html).not.toMatch(/>\s*\d+\/\d+/);
  });

  it('never reports a phase as having taken longer than the whole build', () => {
    /*
     * Stage timestamps survive a resumed or abandoned attempt, so a *part* of a
     * two-minute build claimed nine days. A part cannot be longer than the
     * whole, and that is a check this page can make for itself.
     */
    const started = '2026-08-03T06:31:00.000Z';
    const html = renderToStaticMarkup(
      createElement(CompilationProgress, {
        stages: [
          stage('partitioning_scope', 'done', {
            observedStartedAt: started,
            observedFinishedAt: '2026-08-11T06:31:00.000Z',
            outcome: '4 candidate bases across 7 areas',
          }),
        ],
        failed: false,
        live: true,
        /*
         * The build itself started a minute ago; the stage rows are eight days
         * old. Fixed rather than `new Date()` so the whole document — including
         * the version hash the panel stamps on itself — is the same on every
         * run: an assertion over a random hash is an assertion that fails one
         * time in a hundred for a reason nobody can reproduce.
         */
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        estimate: null,
      }),
    );
    /*
     * The phase row is the only place a per-phase elapsed can appear, so the
     * assertion reads that row rather than the whole document.
     */
    const row = html.slice(html.indexOf('steps') - 40, html.indexOf('steps') + 40);
    expect(row).toContain('1 of 1 steps');
    expect(row, 'a part of the build claims to have taken longer than the build').not.toMatch(
      /steps\s*·/,
    );
  });

  it('keeps cache accounting out of the primary card', () => {
    /*
     * "Already held, so nothing was bought for it: 0 of 8 already answered, 0
     * facts reused" led a live build screen — compiler accounting, in the
     * compiler's nouns, stated as a saving made entirely of noughts, to somebody
     * waiting for a holiday. §26 puts that vocabulary out of primary UI. It is
     * genuinely useful to an operator, so it moves rather than disappearing.
     */
    const html = renderToStaticMarkup(
      createElement(CompilationProgress, {
        stages: [
          stage('partitioning_scope', 'done', { outcome: '4 candidate bases across 7 areas' }),
        ],
        failed: false,
        live: true,
        startedAt: new Date().toISOString(),
        estimate: null,
        reusedSummary: '0 of 8 already answered, 0 facts reused',
      }),
    );
    const primary = html.slice(0, html.indexOf('technical-stages'));
    expect(primary).not.toContain('Already held');
    expect(primary).not.toContain('facts reused');
    // Moved, not deleted: an operator still has it.
    expect(html).toContain('0 of 8 already answered, 0 facts reused');
  });
});
