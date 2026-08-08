import { describe, expect, it } from 'vitest';
import { benchmarkPlanSchema } from '@sidequest/bench';
import { UNKNOWN_PLACE_NAME, failedPlan, toBenchmarkPlan } from './convert';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import { buildResearchPacket } from './packet';

/**
 * CONVERSION LOSES NOTHING AND INVENTS NOTHING.
 *
 * The conversion is where a mistake would be cheapest to hide. A block whose
 * place index addresses nothing is the model being wrong; dropping it would make
 * the plan score better than it deserves, and throwing would lose the six good
 * days around it. Both are worse than admitting the reference is unresolvable,
 * which the neutral plan schema has an exact representation for.
 */

const PACKET = buildResearchPacket(fixturePacketInputs());

function convert(output = fixtureGeneration()) {
  return toBenchmarkPlan({
    planId: 'plan-1',
    requestId: 'req-1',
    output,
    packet: PACKET,
    startDate: '2026-09-01',
    endDate: '2026-09-02',
    generationState: 'complete',
    failureKind: null,
    failureDetail: null,
  });
}

describe('converting a generation into a neutral plan', () => {
  it('parses under the shared plan schema', () => {
    const { plan } = convert();
    expect(benchmarkPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.producedBy).toBe('baseline');
  });

  it('resolves every place index back to the shared inventory identity', () => {
    const { plan } = convert();
    const museum = plan.days[0]?.blocks[0];
    expect(museum?.place?.entityId).toBe('node/1003');
    expect(museum?.place?.name).toBe('Ardenholt Museum');
  });

  it('covers every date the trip has, in order, even where the plan said nothing', () => {
    const { plan } = convert(
      fixtureGeneration({ days: [fixtureGeneration().days[0]!] }),
    );
    expect(plan.days.map((day) => day.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(plan.days[1]?.blocks).toEqual([]);
    expect(plan.days[1]?.warnings).toContain('The plan did not cover this day.');
  });

  describe('when an index addresses nothing', () => {
    const base = fixtureGeneration();
    const broken = fixtureGeneration({
      days: [
        {
          ...base.days[0]!,
          blocks: [
            { ...base.days[0]!.blocks[0]!, placeIndex: 400, opening: null, sourceIndex: 999 },
            base.days[0]!.blocks[1]!,
          ],
        },
        base.days[1]!,
      ],
      exclusions: [{ placeIndex: 999, reason: 'Out of range on purpose.' }],
    });
    const { plan, danglingReferences } = convert(broken);

    it('does not crash', () => {
      expect(benchmarkPlanSchema.safeParse(plan).success).toBe(true);
    });

    it('does not silently drop the block', () => {
      expect(plan.days[0]?.blocks).toHaveLength(2);
    });

    it('degrades the reference to an honest unknown', () => {
      const block = plan.days[0]?.blocks[0];
      expect(block?.place?.entityId).toBeNull();
      expect(block?.place?.name).toBe(UNKNOWN_PLACE_NAME);
      expect(block?.place?.latitude).toBeNull();
    });

    it('says so, on the block and in the plan’s unknowns', () => {
      expect(plan.days[0]?.blocks[0]?.uncertainty.join(' ')).toContain('not in the research packet');
      expect(plan.unknowns.join(' ')).toContain('research packet does not hold');
      expect(danglingReferences).toBeGreaterThanOrEqual(2);
    });

    it('drops an evidence pointer into nothing rather than passing it on', () => {
      expect(plan.days[0]?.blocks[0]?.evidence).toEqual([]);
    });
  });

  /**
   * A stated number with `unknown` provenance is a guess wearing a
   * measurement's clothes, and it is exactly what the neutral checks look for.
   * The honest conversion keeps the provenance and drops the number.
   */
  it('refuses to carry a travel time the plan did not claim was measured', () => {
    const base = fixtureGeneration();
    const invented = fixtureGeneration({
      days: [
        base.days[0]!,
        {
          ...base.days[1]!,
          blocks: [
            {
              ...base.days[1]!.blocks[0]!,
              travel: {
                mode: 'drive',
                fromPlaceIndex: 0,
                toPlaceIndex: 1,
                minutes: 45,
                provenance: 'unknown',
              },
            },
            base.days[1]!.blocks[1]!,
          ],
        },
      ],
    });
    const { plan } = convert(invented);
    const travel = plan.days[1]?.blocks[0]?.travel;
    expect(travel?.provenance).toBe('unknown');
    expect(travel?.minutes).toBeNull();
  });

  it('keeps a measured time exactly as stated', () => {
    const { plan } = convert();
    const travel = plan.days[1]?.blocks[0]?.travel;
    expect(travel?.provenance).toBe('measured');
    expect(travel?.minutes).toBe(28);
  });

  /**
   * `statedTotals` exists so a validator can catch a plan that contradicts its
   * own timeline. Deriving them here from the blocks would make the two agree by
   * construction and the check would pass for ever without examining anything —
   * so what the plan claimed is what the plan is graded on, wrong or right.
   */
  it('carries the totals the plan stated, exactly as stated', () => {
    const { plan } = convert();
    expect(plan.days[0]?.statedTotals).toEqual({
      // Stated by the model, never summed from the blocks — which is what makes
      // the contradiction check able to fail for this arm at all.
      derived: false,
      travelMinutes: 0,
      driveMinutes: 0,
      freeMinutes: null,
    });
    expect(plan.days[1]?.statedTotals).toEqual({
      derived: false,
      travelMinutes: 28,
      driveMinutes: 28,
      freeMinutes: null,
    });
  });

  /**
   * The half that matters more: a total that disagrees with the blocks survives
   * the conversion. A converter that quietly corrected it would hide the one
   * defect this field exists to expose.
   */
  it('does not correct a total that contradicts the plan’s own timeline', () => {
    const base = fixtureGeneration();
    const { plan } = convert(
      fixtureGeneration({
        days: [
          base.days[0]!,
          {
            ...base.days[1]!,
            statedTotals: { travelMinutes: 5, driveMinutes: 5, freeMinutes: null },
          },
        ],
      }),
    );
    expect(plan.days[1]?.statedTotals.travelMinutes).toBe(5);
    expect(plan.days[1]?.blocks[0]?.travel?.minutes).toBe(28);
  });

  /**
   * The two fields the neutral schema has and this arm did not: a last
   * admission, and a journey time a timetable states rather than a routing
   * engine. Both are carried; the second is carried with a caveat, because the
   * packet holds no timetable to check it against.
   */
  it('carries a last admission and a timetabled journey, and flags what it cannot check', () => {
    const base = fixtureGeneration();
    const { plan } = convert(
      fixtureGeneration({
        days: [
          {
            ...base.days[0]!,
            blocks: [
              {
                ...base.days[0]!.blocks[0]!,
                opening: {
                  openMinute: 600,
                  closeMinute: 1020,
                  lastAdmissionMinute: 960,
                  sourceIndex: 2,
                },
              },
            ],
          },
          {
            ...base.days[1]!,
            blocks: [
              {
                ...base.days[1]!.blocks[0]!,
                sourceIndex: null,
                travel: {
                  mode: 'ferry' as const,
                  fromPlaceIndex: 0,
                  toPlaceIndex: 1,
                  minutes: 40,
                  provenance: 'published_timetable' as const,
                },
              },
            ],
          },
        ],
      }),
    );

    expect(plan.days[0]?.blocks[0]?.opening?.lastAdmissionMinute).toBe(960);
    const travel = plan.days[1]?.blocks[0]?.travel;
    expect(travel?.provenance).toBe('published_timetable');
    expect(travel?.minutes).toBe(40);
    expect(plan.days[1]?.blocks[0]?.uncertainty.join(' ')).toContain(
      'timetable the research packet does not hold',
    );
  });

  it('records a day the plan invented outside the trip rather than accepting it', () => {
    const base = fixtureGeneration();
    const { plan } = convert(
      fixtureGeneration({ days: [...base.days, { ...base.days[0]!, dayNumber: 9 }] }),
    );
    expect(plan.days).toHaveLength(2);
    expect(plan.warnings.join(' ')).toContain('not part of this trip');
  });
});

describe('a run that produced nothing', () => {
  it('still yields a plan row the store and the validators can read', () => {
    const plan = failedPlan({
      planId: 'plan-2',
      requestId: 'req-1',
      destination: { entityId: null, name: 'Somewhere', latitude: null, longitude: null },
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      failureKind: 'provider_unavailable',
      failureDetail: 'The place service did not answer.',
    });
    expect(benchmarkPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.generationState).toBe('failed');
    expect(plan.days).toEqual([]);
    // The failure is named, in words that identify no provider and no model.
    expect(plan.failureDetail).toBeTruthy();
    expect(plan.failureDetail?.toLowerCase()).not.toContain('anthropic');
    expect(plan.failureDetail?.toLowerCase()).not.toContain('claude');
  });
});
