import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANCHORS_PER_DAY,
  AVAILABILITY_AFTER,
  COMPILATION_PHASES,
  COMPILATION_STAGES,
  COMPILATION_STAGE_LABELS,
  JOB_STAGES,
  MAX_PLAUSIBLE_BUILD_MS,
  MEASURE_BANDS,
  MEASURE_BAND_LABELS,
  MIN_REPORTABLE_BUILD_MS,
  PHASE_ORDER,
  PROVISIONAL_INTENTS,
  SELECTION_STATUSES,
  STAGE_PHASE,
  STAGE_REGISTRY,
  WORK_PLAN_DECISION_LABELS,
  assessSupply,
  classifyObservedSpan,
  groupStages,
  measureBand,
  observedDurationMs,
  stageLabel,
  summariseSelections,
  summaryVersion,
  supplyAllowsResearch,
  type CompilationStage,
  type StageRecord,
  type SupplyFunnel,
} from '../index';

const NOW = new Date('2026-08-02T12:00:00.000Z');

function stage(
  name: (typeof COMPILATION_STAGES)[number],
  over: Partial<StageRecord> = {},
): StageRecord {
  return { stage: name, status: 'done', ...over };
}

describe('one registry, and everything derived from it', () => {
  it('has no unclassified stage', () => {
    for (const name of COMPILATION_STAGES) {
      expect(STAGE_PHASE[name], `${name} has no phase`).toBeTruthy();
      expect(COMPILATION_PHASES).toContain(STAGE_PHASE[name]);
    }
  });

  it('uses every phase, so none is dead vocabulary', () => {
    const used = new Set(Object.values(STAGE_PHASE));
    for (const phase of COMPILATION_PHASES) expect(used.has(phase)).toBe(true);
  });

  it('derives the enum, the labels and the phase map from the same array', () => {
    expect(COMPILATION_STAGES.length).toBe(STAGE_REGISTRY.length);
    for (const [index, definition] of STAGE_REGISTRY.entries()) {
      expect(COMPILATION_STAGES[index]).toBe(definition.id);
      expect(COMPILATION_STAGE_LABELS[definition.id]).toBe(definition.label);
      expect(STAGE_PHASE[definition.id]).toBe(definition.phase);
      expect(definition.order).toBe(index + 1);
    }
  });

  /**
   * THE DEFECT THIS ASSERTS AGAINST, VERBATIM.
   *
   * `reusing_shared_claims` reached a traveller's screen as `reusing shared
   * claims` — the identifier with its underscores taken out — because a second,
   * hand-keyed label map did not have the stage and the fallback tidied the raw
   * string instead of refusing it. A phrase that looks like English and is not is
   * worse than a missing label, because nobody reviewing a screenshot notices it.
   */
  it('renders no raw identifier for any stage the product knows', () => {
    const identifier = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
    const deUnderscored = /^[a-z0-9]+(?: [a-z0-9]+)+$/;

    for (const definition of STAGE_REGISTRY) {
      expect(definition.label.length, `${definition.id} has no label`).toBeGreaterThan(0);
      expect(identifier.test(definition.label), `${definition.id} renders as an identifier`).toBe(
        false,
      );
      expect(
        deUnderscored.test(definition.label),
        `${definition.id} renders as its identifier with the underscores removed`,
      ).toBe(false);
      expect(definition.label).not.toBe(definition.id.replaceAll('_', ' '));
      expect(stageLabel(definition.id)).toBe(definition.label);
    }
  });

  it('answers nothing rather than tidying up an identifier it does not know', () => {
    // `null` is the whole point: a caller that gets it has to choose a sentence,
    // which is a decision somebody makes on purpose.
    expect(stageLabel('reusing_shared_claims_v2')).toBeNull();
    expect(stageLabel('some_future_stage')).toBeNull();
    expect(stageLabel('')).toBeNull();
  });

  it('lists only the stages a job runs, from the registry rather than a hard-coded trio', () => {
    expect(JOB_STAGES).not.toContain('resolving_destination');
    expect(JOB_STAGES).not.toContain('awaiting_clarification');
    expect(JOB_STAGES).not.toContain('confirming_scope');
    expect(JOB_STAGES.length).toBe(STAGE_REGISTRY.filter((entry) => entry.runsInJob).length);
  });
});

/**
 * THE ORDERING DEFECT, ASSERTED AGAINST THE COMPILER ITSELF.
 *
 * `researching_official_constraints` and `discovering_food` were mapped to the
 * `verifying` phase and execute *before* `enriching_priority_candidates`, which
 * was mapped to `finding`. The visible consequence was a phase card going from
 * Done back to Working while somebody watched it.
 *
 * The execution order is read out of `compile.ts` rather than written down here,
 * because a list copied into a test drifts from the code it describes and this is
 * exactly the kind of drift that caused the defect. Reading a source file is
 * offline, is what `architecture.test.ts` already does across packages, and makes
 * the assertion impossible to satisfy by editing the test.
 */
function executionOrderFromCompiler(): CompilationStage[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../../compiler/src/compile.ts', import.meta.url)),
    'utf8',
  );
  const found: CompilationStage[] = [];
  const call = /runStage(?:<[^>]*>)?\(\s*'([a-z_]+)'/g;
  let match: RegExpExecArray | null = call.exec(source);
  while (match !== null) {
    const id = match[1] as CompilationStage;
    if (!found.includes(id)) found.push(id);
    match = call.exec(source);
  }
  return found;
}

describe('phases are monotonic in the order the compiler actually runs stages', () => {
  const executed = executionOrderFromCompiler();

  it('found the compiler s stages, so the assertions below are about something', () => {
    expect(executed.length).toBeGreaterThan(20);
    for (const id of executed) expect(STAGE_PHASE[id], `${id} is not in the registry`).toBeTruthy();
  });

  it('never goes back to an earlier phase', () => {
    let highest = -1;
    for (const id of executed) {
      const rank = PHASE_ORDER[STAGE_PHASE[id]];
      expect(
        rank,
        `${id} runs in phase ${STAGE_PHASE[id]}, which is behind a phase that has already started`,
      ).toBeGreaterThanOrEqual(highest);
      highest = Math.max(highest, rank);
    }
  });

  it('puts the finding/verifying boundary at the cut, where nothing has been bought yet', () => {
    // Everything above `enriching_priority_candidates` is deterministic or
    // map-derived; `discovering_sources` below it is the first call anybody pays
    // for. `researching_official_constraints` reads what the map data already
    // carries — no search, no fetch, no model — which is why it is *finding*.
    expect(STAGE_PHASE.researching_official_constraints).toBe('finding');
    expect(STAGE_PHASE.discovering_food).toBe('finding');
    expect(STAGE_PHASE.enriching_priority_candidates).toBe('verifying');

    const cut = executed.indexOf('enriching_priority_candidates');
    expect(cut).toBeGreaterThan(executed.indexOf('researching_official_constraints'));
    expect(cut).toBeGreaterThan(executed.indexOf('discovering_food'));
  });

  it('never sends a finished phase back to running as the build progresses', () => {
    /*
     * The defect exactly as a traveller met it, and the replay has to be
     * *incremental* to see it.
     *
     * `groupStages` is handed the records a job has written so far, so a phase's
     * `total` grows as its stages arrive. Under the old mapping `finding` reached
     * four-of-four and reported Done; `verifying` then reported Done at
     * two-of-two; and then `enriching_priority_candidates` — mapped to `finding`
     * while executing after both — arrived and sent `finding` back to Working.
     *
     * Replaying against a pre-padded list of every stage cannot reproduce this,
     * because with a fixed denominator a phase can never re-open. That is the
     * shape the first version of this test had, and it passed against the defect.
     */
    const terminal = new Set(['done', 'partial']);
    const settled = new Set<string>();
    const written: StageRecord[] = [];

    for (const id of executed) {
      written.push(stage(id, { status: 'running' }));

      for (const pass of [0, 1]) {
        if (pass === 1) written[written.length - 1] = stage(id, { status: 'done', outcome: '3 x' });
        const phases = groupStages(written, NOW);
        /*
         * A phase legitimately re-opens while it is still the newest one — its
         * own next stage has simply arrived and its denominator grew. What is
         * never legitimate is an *earlier* phase re-opening after a later one has
         * started, because that is a stage executing behind a phase boundary it
         * is on the wrong side of. That is the defect, and this is the line that
         * distinguishes it from ordinary growth.
         */
        const newest = phases[phases.length - 1]?.phase;
        for (const phase of phases) {
          if (settled.has(phase.phase) && phase.phase !== newest) {
            expect(
              terminal.has(phase.status),
              `${phase.phase} un-finished when ${id} arrived, after ${newest} had started`,
            ).toBe(true);
          }
          if (terminal.has(phase.status)) settled.add(phase.phase);
          else settled.delete(phase.phase);
        }
      }
    }
  });
});

describe('grouping the build log into something readable', () => {
  it('collapses the whole build log into at most five rows', () => {
    const stages = COMPILATION_STAGES.map((name) => stage(name, { status: 'waiting' }));
    const phases = groupStages(stages, NOW);
    expect(phases.length).toBeLessThanOrEqual(5);
    expect(phases.reduce((total, phase) => total + phase.total, 0)).toBe(stages.length);
  });

  it('a phase is running while any of its stages is', () => {
    const phases = groupStages(
      [
        stage('partitioning_scope', { status: 'done', outcome: '6 areas to read' }),
        stage('building_region_pack', { status: 'running' }),
        stage('expanding_region', { status: 'waiting' }),
      ],
      NOW,
    );
    const shaping = phases.find((phase) => phase.phase === 'shaping')!;
    expect(shaping.status).toBe('running');
    expect(shaping.currentWork).toBe('Preparing regional place data');
    expect(shaping.done).toBe(1);
  });

  it('a technical-only stage never becomes the sentence a traveller reads', () => {
    /*
     * "Matching records across sources" is true, useful to an operator, and not
     * what somebody waiting four minutes for a trip should be reading as the
     * headline of the phase they are watching. The registry marks it
     * `technicalOnly`, the phase falls back to its own detail line, and the stage
     * is still in the disclosure where an operator can find it.
     */
    const phases = groupStages(
      [
        stage('partitioning_scope', { status: 'done', outcome: '6 areas to read' }),
        stage('linking_sources', { status: 'running' }),
      ],
      NOW,
    );
    const shaping = phases.find((phase) => phase.phase === 'shaping')!;
    expect(shaping.status).toBe('running');
    expect(shaping.currentWork).toBeUndefined();
    expect(shaping.stages.some((record) => record.stage === 'linking_sources')).toBe(true);
  });

  it('a plumbing count never headlines what a phase achieved', () => {
    /*
     * `linking_sources` finishes last in *shaping* and is not what the shaping
     * card should claim it did. The traveller's sentence is one row further back,
     * and `exposesResult` on the registry is what finds it.
     */
    const phases = groupStages(
      [
        stage('expanding_region', { status: 'done', outcome: '4 bases across 3 areas' }),
        stage('linking_sources', { status: 'done', outcome: '412 records matched across sources' }),
      ],
      NOW,
    );
    expect(phases.find((phase) => phase.phase === 'shaping')!.latestOutcome).toBe(
      '4 bases across 3 areas',
    );
  });

  it('a skipped stage makes its phase partial rather than done', () => {
    const phases = groupStages(
      [
        stage('discovering_candidates', { status: 'done' }),
        stage('deduplicating', { status: 'skipped', note: 'nothing to merge' }),
      ],
      NOW,
    );
    const finding = phases.find((phase) => phase.phase === 'finding')!;
    expect(finding.status).toBe('partial');
    expect(finding.notes).toContain('nothing to merge');
  });

  it('a failure is never hidden by the stages around it', () => {
    const phases = groupStages(
      [
        stage('retrieving_pages', { status: 'done' }),
        stage('extracting_facts', { status: 'failed', note: 'the model refused' }),
      ],
      NOW,
    );
    expect(phases.find((phase) => phase.phase === 'verifying')!.status).toBe('failed');
  });

  it('surfaces the last real outcome rather than a stage name', () => {
    const phases = groupStages(
      [
        stage('discovering_candidates', { status: 'done', outcome: '96 candidates from 6 searches' }),
        stage('deduplicating', { status: 'done', outcome: '81 distinct places' }),
      ],
      NOW,
    );
    expect(phases[0]!.latestOutcome).toBe('81 distinct places');
  });

  it('measures elapsed time from the stage timestamps, not a client clock', () => {
    const phases = groupStages(
      [
        stage('building_region_pack', {
          status: 'done',
          startedAt: '2026-08-02T11:59:00.000Z',
          finishedAt: '2026-08-02T11:59:30.000Z',
        }),
      ],
      NOW,
    );
    expect(phases[0]!.elapsedSeconds).toBe(30);
  });

  it('names what is already inspectable after each phase', () => {
    expect(AVAILABILITY_AFTER.finding).toMatch(/provisional/i);
    expect(AVAILABILITY_AFTER.finding).toMatch(/nothing on it is verified/i);
  });
});

describe('a measured stage duration, or none at all', () => {
  it('reads only the observed pair, never the compiler s injected clock', () => {
    /*
     * The injected pair advances one step per stage so that two runs of the same
     * inputs produce byte-identical artifacts. Reading it as a duration is what
     * had every stage claiming a millisecond and the screen offering
     * "roughly 0s-0s to go".
     */
    expect(
      observedDurationMs(
        stage('retrieving_pages', {
          startedAt: '2026-08-02T11:59:00.000Z',
          finishedAt: '2026-08-02T11:59:00.001Z',
        }),
      ),
    ).toBeNull();

    expect(
      observedDurationMs(
        stage('retrieving_pages', {
          startedAt: '2026-08-02T11:59:00.000Z',
          finishedAt: '2026-08-02T11:59:00.001Z',
          observedStartedAt: '2026-08-02T11:59:00.000Z',
          observedFinishedAt: '2026-08-02T11:59:42.000Z',
        }),
      ),
    ).toBe(42_000);
  });

  it('refuses a clock that went backwards rather than rendering a negative', () => {
    // An NTP correction or a container resumed on another host. `-4s` on a
    // progress row looks like a far worse bug than a missing figure.
    expect(
      observedDurationMs(
        stage('retrieving_pages', {
          observedStartedAt: '2026-08-02T11:59:42.000Z',
          observedFinishedAt: '2026-08-02T11:59:00.000Z',
        }),
      ),
    ).toBeNull();
  });

  it('refuses an unparseable or absurd span', () => {
    expect(
      observedDurationMs(
        stage('retrieving_pages', {
          observedStartedAt: 'not a date',
          observedFinishedAt: '2026-08-02T11:59:00.000Z',
        }),
      ),
    ).toBeNull();
    expect(
      observedDurationMs(
        stage('retrieving_pages', {
          observedStartedAt: '2026-08-02T00:00:00.000Z',
          observedFinishedAt: '2026-08-03T00:00:00.000Z',
        }),
      ),
    ).toBeNull();
  });
});

/**
 * THE ESTIMATOR THAT WAS REMOVED, AND WHY THESE TESTS WENT WITH IT.
 *
 * These asserted that `estimateRemaining` refused without evidence and returned
 * a range when it had some. Both passed, and the thing they were guarding was
 * broken anyway: the durations it extrapolated from were one millisecond each,
 * because the compiler's clock advances a fixed step per stage rather than
 * measuring. It rendered "roughly 0s–0s to go", which the tests could not see
 * because they asserted on the shape of the answer rather than its size.
 *
 * The model was also wrong independently of the clock — multiplying a *count*
 * of remaining stages by a global median treats `partitioning_scope`, which is
 * arithmetic, as the same kind of thing as `retrieving_pages`, which fetches
 * ninety pages over somebody else's network.
 *
 * The replacement is `estimateRemainingFrom` in `schemas/timing.ts`: per-stage
 * percentiles over bucketed history, refusing below a stated sample size. Its
 * tests live beside it, and they assert on the numbers rather than the shape.
 */

// ---------------------------------------------------------------------------
// Version-keyed summaries
// ---------------------------------------------------------------------------

/**
 * THE STALE COUNT, AND EVERY SHAPE IT TOOK.
 *
 * A board is versioned and immutable; the marks a traveller makes on it are
 * neither. Every count on both boards was derived from the mark map — which
 * outlives the board it was made on, is deliberately shared across board
 * versions, and grows every time somebody marks a card that a later build
 * removes. So the number beside a rebuilt board described the board before it,
 * and there is nothing about a number that looks stale.
 */
describe('a count describes the board in front of the traveller, and nothing else', () => {
  const statuses = SELECTION_STATUSES;

  it('counts only cards that are on the displayed board', () => {
    const summary = summariseSelections({
      boardVersion: 'v2',
      cardIds: ['a', 'b', 'c'],
      statuses,
      selections: { a: 'included', b: 'maybe', gone: 'included', also_gone: 'included' },
    });

    expect(summary.counts.included).toBe(1);
    expect(summary.counts.maybe).toBe(1);
    expect(summary.counts.excluded).toBe(0);
    expect(summary.decided).toBe(2);
    expect(summary.onBoard).toBe(3);
  });

  it('keeps marks about places the board no longer holds, apart from the totals', () => {
    /*
     * `gone` was a real decision somebody made. It is not a fact about the board
     * they are looking at, and folding it in is exactly what made "5 in" render
     * beside a board with three cards on it.
     */
    const summary = summariseSelections({
      boardVersion: 'v2',
      cardIds: ['a'],
      statuses,
      selections: { a: 'included', gone: 'included', also_gone: 'maybe' },
    });
    expect(summary.counts.included).toBe(1);
    expect(summary.carriedOver).toBe(2);
  });

  it('gives two board versions different answers from one mark map', () => {
    const selections = { a: 'included', b: 'included', c: 'included' } as const;
    const before = summariseSelections({
      boardVersion: 'v1',
      cardIds: ['a', 'b', 'c'],
      statuses,
      selections,
    });
    const after = summariseSelections({
      boardVersion: 'v2',
      cardIds: ['a'],
      statuses,
      selections,
    });

    expect(before.counts.included).toBe(3);
    expect(after.counts.included).toBe(1);
    expect(before.boardVersion).not.toBe(after.boardVersion);
  });

  it('reports zero for an emptied board rather than the previous board s figure', () => {
    const summary = summariseSelections({
      boardVersion: 'v3',
      cardIds: [],
      statuses,
      selections: { a: 'included', b: 'included' },
    });
    expect(summary.counts.included).toBe(0);
    expect(summary.decided).toBe(0);
    expect(summary.carriedOver).toBe(2);
  });

  it('reports every status in the vocabulary, so an absent one reads as zero', () => {
    const summary = summariseSelections({
      boardVersion: 'v1',
      cardIds: ['a'],
      statuses: PROVISIONAL_INTENTS,
      selections: { a: 'pinned' },
    });
    expect(summary.counts).toEqual({ pinned: 1, interested: 0, not_interested: 0, hidden: 0 });
  });

  it('ignores a status outside the board s own vocabulary', () => {
    // The two boards speak different decision vocabularies over one shape. A
    // provisional intent must not be counted into a discovery-board total.
    const summary = summariseSelections({
      boardVersion: 'v1',
      cardIds: ['a', 'b'],
      statuses,
      selections: { a: 'included', b: 'pinned' as unknown as (typeof statuses)[number] },
    });
    expect(summary.counts.included).toBe(1);
    expect(summary.decided).toBe(1);
  });

  it('carries the version it describes on the same object as the numbers', () => {
    const summary = summariseSelections({
      boardVersion: summaryVersion(['board-7', 2]),
      cardIds: ['a'],
      statuses,
      selections: {},
    });
    expect(summary.boardVersion).toBe(summaryVersion(['board-7', 2]));
  });
});

describe('the identity a summary is keyed to', () => {
  it('is stable, so a refresh reproduces the same pairing', () => {
    expect(summaryVersion(['board-1', 3])).toBe(summaryVersion(['board-1', 3]));
  });

  it('changes when the board changes', () => {
    expect(summaryVersion(['board-1', 3])).not.toBe(summaryVersion(['board-1', 4]));
    expect(summaryVersion(['board-1', 3])).not.toBe(summaryVersion(['board-2', 3]));
  });

  it('cannot be confused by a separator inside an identifier', () => {
    // Length-prefixed rather than joined: `['ab','c']` and `['a','bc']` are two
    // boards, and a delimiter join would give them one version.
    expect(summaryVersion(['ab', 'c'])).not.toBe(summaryVersion(['a', 'bc']));
    expect(summaryVersion(['a|b'])).not.toBe(summaryVersion(['a', 'b']));
  });

  it('distinguishes an absent part from an empty one, and both from nothing', () => {
    expect(summaryVersion([])).not.toBe(summaryVersion(['']));
    expect(summaryVersion([undefined, 'a'])).toBe(summaryVersion(['', 'a']));
  });
});

// ---------------------------------------------------------------------------
// A build span
// ---------------------------------------------------------------------------

describe('what a build s observed span may be presented as', () => {
  it('renders an ordinary build as a measurement', () => {
    expect(classifyObservedSpan(184_000)).toEqual({ kind: 'measured', ms: 184_000 });
  });

  it('refuses to call a reclaimed job s clock a measurement', () => {
    /*
     * "312m in total, measured" reached a screen from a job whose start stamp
     * and finish stamp were hours apart because the process had been reclaimed.
     * The damage is in the word `measured`: it invites somebody to conclude the
     * pipeline is five hours slow.
     */
    const span = 312 * 60_000;
    expect(span).toBeGreaterThan(MAX_PLAUSIBLE_BUILD_MS);
    expect(classifyObservedSpan(span)).toEqual({ kind: 'not_a_measurement', ms: span });
  });

  it('reads a sub-second build as words rather than as 0s', () => {
    // A synthetic world compiles in under a second, and `Math.round(ms / 1000)`
    // turns that into "0s in total, measured" — the same family of sentence as
    // "roughly 0s–0s to go".
    expect(classifyObservedSpan(400)).toEqual({ kind: 'under_a_second' });
    expect(classifyObservedSpan(0)).toEqual({ kind: 'under_a_second' });
    expect(MIN_REPORTABLE_BUILD_MS).toBe(1_000);
    expect(classifyObservedSpan(MIN_REPORTABLE_BUILD_MS)).toEqual({
      kind: 'measured',
      ms: MIN_REPORTABLE_BUILD_MS,
    });
  });

  it('says nothing at all when there was no observed pair', () => {
    expect(classifyObservedSpan(null)).toEqual({ kind: 'unmeasured' });
    expect(classifyObservedSpan(undefined)).toEqual({ kind: 'unmeasured' });
    expect(classifyObservedSpan(Number.NaN)).toEqual({ kind: 'unmeasured' });
    expect(classifyObservedSpan(Number.POSITIVE_INFINITY)).toEqual({ kind: 'unmeasured' });
    expect(classifyObservedSpan(-1)).toEqual({ kind: 'unmeasured' });
  });

  it('holds the build ceiling above the stage ceiling, and both bounded', () => {
    expect(MAX_PLAUSIBLE_BUILD_MS).toBeGreaterThan(0);
    expect(classifyObservedSpan(MAX_PLAUSIBLE_BUILD_MS).kind).toBe('measured');
    expect(classifyObservedSpan(MAX_PLAUSIBLE_BUILD_MS + 1).kind).toBe('not_a_measurement');
  });
});

// ---------------------------------------------------------------------------
// A 0–1 heuristic
// ---------------------------------------------------------------------------

describe('a weighted heuristic is a band, never a bare integer', () => {
  it('maps the whole range onto the four bands, monotonically', () => {
    expect(measureBand(0.92)).toBe('strong');
    expect(measureBand(0.6)).toBe('good');
    expect(measureBand(0.4)).toBe('middling');
    expect(measureBand(0.1)).toBe('weak');
  });

  it('clamps rather than inventing a fifth band', () => {
    expect(measureBand(2)).toBe('strong');
    expect(measureBand(-1)).toBe('weak');
    expect(measureBand(Number.NaN)).toBe('weak');
  });

  it('has a written label for every band, and none of them is a number', () => {
    for (const band of MEASURE_BANDS) {
      const label = MEASURE_BAND_LABELS[band];
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/\d/);
      expect(label).not.toBe(band);
    }
  });
});

// ---------------------------------------------------------------------------
// The registry, as every surface must consume it
// ---------------------------------------------------------------------------

/**
 * NO IDENTIFIER MAY REACH A SCREEN AS PSEUDO-ENGLISH.
 *
 * The stage vocabulary is guarded above. This guards the *other* hand-keyed maps
 * a build's technical panel renders — the work-plan decisions — because
 * `PlanFlow` fell back to the raw decision string for anything the map had
 * missed, which is the same defect `stageLabel` was written to refuse.
 */
describe('every vocabulary a build panel renders is written English', () => {
  const identifier = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
  const deUnderscored = /^[a-z0-9]+(?: [a-z0-9]+)+$/;

  it('gives every work-plan decision a phrase somebody wrote', () => {
    for (const [decision, label] of Object.entries(WORK_PLAN_DECISION_LABELS)) {
      expect(label.length, `${decision} has no label`).toBeGreaterThan(0);
      expect(identifier.test(label), `${decision} renders as an identifier`).toBe(false);
      expect(
        deUnderscored.test(label),
        `${decision} renders as its identifier with the underscores removed`,
      ).toBe(false);
      expect(label).not.toBe(decision.replaceAll('_', ' '));
    }
  });

  it('gives every stage a phrase somebody wrote, through one registry', () => {
    for (const id of COMPILATION_STAGES) {
      const label = stageLabel(id);
      expect(label, `${id} has no registry label`).toBeTruthy();
      expect(identifier.test(label!)).toBe(false);
      expect(deUnderscored.test(label!)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

function funnel(over: Partial<SupplyFunnel> = {}): SupplyFunnel {
  return {
    sourceRecords: 200,
    candidates: 90,
    categories: 7,
    clusters: 4,
    anchors: 40,
    supportStops: 20,
    baseCandidates: 4,
    tripDays: 5,
    ...over,
  };
}

describe('judging supply before anything is bought', () => {
  it('calls a rich region strong and lets research proceed', () => {
    const assessment = assessSupply({ funnel: funnel(), now: NOW });
    expect(assessment.level).toBe('strong');
    expect(supplyAllowsResearch(assessment)).toBe(true);
    expect(assessment.summary).toMatch(/\d+/);
  });

  it('reproduces the live failure this gate exists for, and stops it early', () => {
    /*
     * The measured Kyrgyzstan run: 35 source records, 13 candidates, 8 retained
     * — reported as "not enough to plan on" after minutes of paid research. The
     * same numbers reach a verdict here in microseconds, with actions attached.
     */
    const assessment = assessSupply({
      funnel: funnel({
        sourceRecords: 35,
        candidates: 13,
        categories: 2,
        clusters: 1,
        anchors: 8,
        baseCandidates: 1,
        tripDays: 12,
      }),
      now: NOW,
    });
    expect(assessment.level).toBe('thin_repairable');
    expect(supplyAllowsResearch(assessment)).toBe(false);
    expect(assessment.actions).toContain('narrow_destination');
    expect(assessment.actions).toContain('allow_more_driving');
    expect(assessment.shortfalls.join(' ')).toMatch(/against the 24/);
  });

  it('only gives up after a repair has been tried', () => {
    const thin = funnel({ candidates: 2, categories: 1, clusters: 0, anchors: 1, baseCandidates: 0 });
    expect(assessSupply({ funnel: thin, now: NOW }).level).toBe('thin_repairable');
    expect(assessSupply({ funnel: thin, alreadyRepaired: true, now: NOW }).level).toBe('insufficient');
  });

  it('keeps a provider outage separate from an empty destination', () => {
    const assessment = assessSupply({
      funnel: funnel({ sourceRecords: 0, candidates: 0, categories: 0, clusters: 0, anchors: 0, baseCandidates: 0 }),
      infrastructureFailed: true,
      now: NOW,
    });
    expect(assessment.level).toBe('infrastructure_failure');
    expect(assessment.shortfalls.join(' ')).toMatch(/about our sources, not about the destination/i);
    expect(assessment.actions).toEqual(['retry']);
  });

  it('scales what it needs with the length of the trip', () => {
    const anchors = 10;
    const short = assessSupply({ funnel: funnel({ anchors, tripDays: 3 }), now: NOW });
    const long = assessSupply({ funnel: funnel({ anchors, tripDays: 14 }), now: NOW });
    expect(short.level).not.toBe('thin_repairable');
    expect(long.shortfalls.length).toBeGreaterThan(0);
    expect(ANCHORS_PER_DAY).toBe(2);
  });

  it('every recovery action is something the traveller can act on', () => {
    const assessment = assessSupply({
      funnel: funnel({ candidates: 3, categories: 1, anchors: 2, clusters: 1, baseCandidates: 0 }),
      now: NOW,
    });
    // Never "try a different search" — that is our job, and it has already run.
    expect(assessment.actions).not.toContain('retry');
    expect(assessment.actions).toContain('choose_gateway');
  });
});
