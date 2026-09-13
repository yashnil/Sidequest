import { describe, expect, it, vi } from 'vitest';
import { QUALITY_COMPILER_CHECKS, buildTravelerProfile, defaultAnswers, placementReportSchema, type Trip } from '@sidequest/core';
import { compileQuality, compileQualitySafely } from './quality-compiler';
import { reconcileTripDraft } from './reconcile';
import { boardWorld, draftOf } from './acceptance/harness';
import { tripDraftSchema } from './trip-draft';

/**
 * V10 §16 — A DIAGNOSTIC MAY NOT BREAK A PLAN.
 *
 * The defect this pins is the worst kind the quality compiler could have: one
 * findings sentence longer than its schema cap threw out of
 * `qualityCompilerReportSchema.parse`, the throw propagated out of the
 * orchestrator, and the traveller was shown "Sidequest couldn't finish this
 * build" for a trip that had already been composed, verified and reconciled. The
 * compiler exists to protect a plan; it destroyed one.
 *
 * Two guarantees, both tested: the prose is clipped rather than refused, and a
 * compiler that fails for any reason at all leaves the plan alone.
 */
const NOW = new Date('2026-09-12T12:00:00Z');

async function plan() {
  const context = boardWorld({ basics: { startDate: '2026-08-12', endDate: '2026-08-15' } });
  const draft = tripDraftSchema.parse(draftOf({
    bases: [{ id: 'town', name: 'Mammoth Lakes', nights: 3 }],
    days: [
      { base: 'town', anchors: [{ name: 'Convict Lake', category: 'water', minutes: 90 }] },
      { base: 'town', anchors: [{ name: 'Mammoth Lakes Basin', category: 'water', minutes: 90 }] },
      { base: 'town', anchors: [] },
      { base: 'town', anchors: [] },
    ],
  }));
  const result = await reconcileTripDraft({ draft, context });
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 4 });
  const trip: Trip = { id: 'resilience', basics: context.basics, status: 'planned', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  return { result, draft, trip, profile };
}

describe('the quality compiler cannot break a build', () => {
  it('clips an over-long finding instead of refusing the whole report', async () => {
    const { result, draft, trip, profile } = await plan();
    /*
     * A placement report with a great many unplaced names produces one finding
     * that lists them all — which is exactly how the cap was exceeded live.
     */
    const placement = placementReportSchema.parse({
      version: 1,
      placements: Array.from({ length: 40 }, (_, i) => ({
        id: `base:${i}`,
        name: `A base with a deliberately long name so the joined detail runs past four hundred characters ${i}`,
        kind: 'base' as const,
        outcome: 'no_acceptable_candidate' as const,
        attempts: [],
      })),
    });
    const { report } = compileQuality({ itinerary: result.itinerary, draft, trip, profile, placement, dayOrders: result.dayOrders });
    const finding = report.issues.find((i) => i.check === 'route_critical_placed')!;
    expect(finding.detail.length).toBeLessThanOrEqual(400);
    expect(finding.detail.endsWith('…')).toBe(true);
    /* And the report is a report, not a throw. */
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('keeps a traveller note inside its own cap too', async () => {
    const { result, draft, trip, profile } = await plan();
    const placement = placementReportSchema.parse({
      version: 1,
      placements: Array.from({ length: 6 }, (_, i) => ({
        id: `base:${i}`,
        name: `A base name long enough that two traveller notes about it exceed two hundred and forty characters together ${i}`,
        kind: 'base' as const,
        outcome: 'ambiguous' as const,
        attempts: [],
        travellerNote: `There is more than one place with this name, and Sidequest will not guess which one you mean — number ${i}.`,
      })),
    });
    const { report } = compileQuality({ itinerary: result.itinerary, draft, trip, profile, placement, dayOrders: result.dayOrders });
    for (const issue of report.issues) if (issue.travellerNote) expect(issue.travellerNote.length).toBeLessThanOrEqual(240);
  });

  it('leaves the plan alone when the compiler fails for any reason at all', async () => {
    const { result, draft, trip, profile } = await plan();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    /* A shape the compiler cannot read at all: the failure mode nobody predicts. */
    const { report, corrections } = compileQualitySafely({ itinerary: null as never, draft, trip, profile, dayOrders: result.dayOrders });
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    /*
     * An unrun check is not a failed check, so the plan is not condemned — and it
     * is not silently green either: every check is recorded as skipped with the
     * reason, which is the rule the compiler holds itself to everywhere else.
     */
    expect(report.passed).toBe(true);
    expect(report.clean).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.skipped.map((s) => s.check).sort()).toEqual([...QUALITY_COMPILER_CHECKS].sort());
    for (const skip of report.skipped) expect(skip.reason).toContain('could not run');
    expect(corrections).toEqual({});
  });

  it('passes a normal build straight through the safe wrapper', async () => {
    const { result, draft, trip, profile } = await plan();
    const safe = compileQualitySafely({ itinerary: result.itinerary, draft, trip, profile, placement: result.placement, dayOrders: result.dayOrders });
    const direct = compileQuality({ itinerary: result.itinerary, draft, trip, profile, placement: result.placement, dayOrders: result.dayOrders });
    expect(safe.report).toEqual(direct.report);
    expect(safe.corrections).toEqual(direct.corrections);
  });
});
