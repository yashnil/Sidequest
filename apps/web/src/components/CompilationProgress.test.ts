import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StageRecord } from '@sidequest/core';
import {
  CompilationProgress,
  StageDisclosure,
  lastRecordedInstant,
  stageStatusLabel,
} from './CompilationProgress';

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

/*
 * The component reads the wall clock, and the fixture is dated: without a
 * pinned "now" the eight-day-old build reads "last month" once the calendar
 * passes 2 September 2026 and every relative-time assertion below drifts.
 */
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-08-11T09:00:00.000Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

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

  it('resolves every stage row once nothing is running: no row is left "waiting"', () => {
    /*
     * A live trip's build report rendered `waiting — Going back over what we
     * found` between rows marked done, on a job whose ledger row had recorded
     * a finish hours earlier — directly under a banner saying the research
     * "stopped short of the end". A terminal build has nothing left to wait
     * for, so a queued stage resolves to "not reached" and an open one to
     * "stopped"; and the same rows keep their honest present tense while a
     * process genuinely is running.
     */
    const mixed: StageRecord[] = [
      stage('partitioning_scope', 'done'),
      stage('building_region_pack', 'running'),
      stage('discovering_candidates', 'waiting'),
    ];
    const dead = renderToStaticMarkup(
      createElement(StageDisclosure, { stages: mixed, live: false }),
    );
    expect(dead).not.toContain('>waiting<');
    expect(dead).not.toContain('>running<');
    expect(dead).toContain('not reached');
    expect(dead).toContain('stopped');

    // The control: a build that is genuinely running keeps its queue.
    const alive = renderToStaticMarkup(
      createElement(StageDisclosure, { stages: mixed, live: true }),
    );
    expect(alive).toContain('>waiting<');
    expect(alive).toContain('>running<');
  });

  it('maps only the two open statuses; finished rows keep their own words', () => {
    expect(stageStatusLabel('waiting', false)).toBe('not reached');
    expect(stageStatusLabel('running', false)).toBe('stopped');
    for (const status of ['done', 'skipped', 'failed'] as const) {
      expect(stageStatusLabel(status, false)).toBe(status);
      expect(stageStatusLabel(status, true)).toBe(status);
    }
    expect(stageStatusLabel('waiting', true)).toBe('waiting');
    expect(stageStatusLabel('running', true)).toBe('running');
  });

  it('freezes a dead build’s phase durations at what the build spent, never ticking against now', () => {
    /*
     * The live defect, reproduced: job cb08dd94 ran 04:58–05:12 — under
     * fourteen minutes — and, viewed around 14:30, its stopped stage panel
     * read "Finding the strongest places · 9h 15m". The phase's elapsed was
     * computed against the viewer's clock because the phase never finished, so
     * a terminal build's duration grew for as long as nobody looked at it.
     *
     * A terminal build is measured against the last instant it demonstrably
     * wrote. Here the build started at 04:58, its last stage record landed at
     * 05:05, and the render happens hours later: the finding phase must claim
     * the seven minutes it actually spanned, and nothing on the panel may
     * carry an hours-scale figure.
     */
    const html = renderToStaticMarkup(
      createElement(CompilationProgress, {
        stages: [
          stage('discovering_candidates', 'done', {
            observedStartedAt: '2026-08-25T04:58:59.000Z',
            observedFinishedAt: '2026-08-25T05:05:00.000Z',
            outcome: '158 candidates from 6 searches',
          }),
          // Started, never finished: the stage the process died inside.
          stage('deduplicating', 'running', {
            observedStartedAt: '2026-08-25T05:05:00.000Z',
          }),
        ],
        failed: false,
        live: false,
        startedAt: '2026-08-25T04:58:59.000Z',
        estimate: null,
      }),
    );
    // The frozen figure: the span the build actually wrote, roughly 6 minutes.
    expect(html).toContain('6m 1s');
    // Never the wall-clock-since figure, in any unit it could render in.
    expect(html, 'a dead build must not tick against the viewer’s clock').not.toMatch(/\d+h \d+m/);
    expect(html).not.toMatch(/\d{3,}m/);
  });

  it('measures the freeze point from the last thing the build wrote', () => {
    expect(
      lastRecordedInstant(
        [
          stage('discovering_candidates', 'done', {
            observedStartedAt: '2026-08-25T04:58:59.000Z',
            observedFinishedAt: '2026-08-25T05:05:00.000Z',
          }),
          stage('deduplicating', 'running', { observedStartedAt: '2026-08-25T05:06:30.000Z' }),
        ],
        '2026-08-25T04:58:59.000Z',
      )?.toISOString(),
    ).toBe('2026-08-25T05:06:30.000Z');
    // No timestamps anywhere: nothing honest to measure against.
    expect(lastRecordedInstant([stage('deduplicating', 'waiting')])).toBeNull();
    // A build that died before any stage reported still freezes at its start.
    expect(
      lastRecordedInstant([], '2026-08-25T04:58:59.000Z')?.toISOString(),
    ).toBe('2026-08-25T04:58:59.000Z');
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
