import { describe, expect, it } from 'vitest';
import {
  ANCHORS_PER_DAY,
  AVAILABILITY_AFTER,
  COMPILATION_PHASES,
  COMPILATION_STAGES,
  STAGE_PHASE,
  assessSupply,
  estimateRemaining,
  groupStages,
  supplyAllowsResearch,
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

describe('every stage belongs to exactly one phase', () => {
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
});

describe('grouping the build log into something readable', () => {
  it('collapses twenty-six stages into at most five rows', () => {
    const stages = COMPILATION_STAGES.map((name) => stage(name, { status: 'waiting' }));
    const phases = groupStages(stages, NOW);
    expect(phases.length).toBeLessThanOrEqual(5);
    expect(phases.reduce((total, phase) => total + phase.total, 0)).toBe(stages.length);
  });

  it('a phase is running while any of its stages is', () => {
    const phases = groupStages(
      [
        stage('building_region_pack', { status: 'done', outcome: '412 records' }),
        stage('linking_sources', { status: 'running' }),
        stage('expanding_region', { status: 'waiting' }),
      ],
      NOW,
    );
    const shaping = phases.find((phase) => phase.phase === 'shaping')!;
    expect(shaping.status).toBe('running');
    expect(shaping.currentWork).toBe('Matching records across sources');
    expect(shaping.done).toBe(1);
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

describe('the remaining estimate refuses to guess', () => {
  it('says nothing until there is something to extrapolate from', () => {
    const phases = groupStages(
      [stage('building_region_pack', { status: 'running', startedAt: NOW.toISOString() })],
      NOW,
    );
    expect(estimateRemaining(phases, NOW)).toBeNull();
  });

  it('returns a range rather than a single confident number', () => {
    const finished = ['resolving_source_release', 'partitioning_scope', 'building_region_pack', 'linking_sources'] as const;
    const stages: StageRecord[] = finished.map((name, index) =>
      stage(name, {
        startedAt: new Date(NOW.getTime() - (10 - index) * 1000).toISOString(),
        finishedAt: new Date(NOW.getTime() - (9 - index) * 1000).toISOString(),
      }),
    );
    stages.push(stage('expanding_region', { status: 'waiting' }));

    const estimate = estimateRemaining(groupStages(stages, NOW), NOW);
    expect(estimate).not.toBeNull();
    expect(estimate!.highSeconds).toBeGreaterThanOrEqual(estimate!.lowSeconds);
  });

  it('says nothing when there is nothing left', () => {
    const stages = COMPILATION_STAGES.slice(0, 6).map((name, index) =>
      stage(name, {
        startedAt: new Date(NOW.getTime() - (10 - index) * 1000).toISOString(),
        finishedAt: new Date(NOW.getTime() - (9 - index) * 1000).toISOString(),
      }),
    );
    expect(estimateRemaining(groupStages(stages, NOW), NOW)).toBeNull();
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
