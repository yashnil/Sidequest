import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport, travelerProfileSchema } from '@sidequest/core';
import { IRELAND_TRIP, irelandContext, irelandDraft } from './acceptance/ireland-replay.test';
import { reconcileTripDraft } from './reconcile';
import { auditItinerary } from './quality-audit';
import { buildPreservationReport } from './preservation';
import type { TripDraft } from './trip-draft';

/**
 * V6 §11/§12 — TRANSPORT IS NOT A POI, AND AN UNDECIDED GATEWAY IS A DEPENDENCY.
 *
 * Replayed on the recorded Ireland draft with two anchors injected in the shape
 * the Madhya Pradesh and Hokkaido production trips produced: a drive written
 * as a core stop, and an "X or Y Airport" written as the first stop of day one.
 */

const profile = travelerProfileSchema.parse(JSON.parse(readFileSync(new URL('./acceptance/fixtures/ireland/profile.json', import.meta.url), 'utf8')));

function draftWithLogistics(): TripDraft {
  const draft = irelandDraft();
  const days = draft.days.map((day, index) => {
    if (index === 0) return { ...day, anchors: [{ name: 'Dublin or Shannon Airport', category: 'other' as const, role: 'core' as const, why: 'Land here.' }, ...day.anchors] };
    if (index === 3) return { ...day, anchors: [{ name: 'Drive Killarney to Dingle', category: 'scenic_drive' as const, role: 'core' as const, estimatedDurationMinutes: 90, transport: 'car' as const, why: 'The move west.' }, ...day.anchors] };
    return day;
  });
  return { ...draft, days, signatures: [...(draft.signatures ?? []).slice(0, 2), 'Drive Killarney to Dingle'] };
}

describe('transfers and gateways in the reconciler', () => {
  it('folds a transfer into the travel leg and a gateway into the terminal plan, with no silent loss and no scheduled stop', async () => {
    const draft = draftWithLogistics();
    const { context } = irelandContext();
    const { itinerary, dispositions } = await reconcileTripDraft({ draft, context });
    const transfer = itinerary.package!.anchors.find((a) => a.name === 'Drive Killarney to Dingle')!;
    const gateway = itinerary.package!.anchors.find((a) => a.name === 'Dublin or Shannon Airport')!;
    expect(transfer.disposition).toBe('folded_into_transfer');
    expect(transfer.anchorKind).toBe('transfer');
    expect(gateway.disposition).toBe('folded_into_terminal');
    expect(gateway.anchorKind).toBe('gateway');
    expect(dispositions.length).toBeGreaterThan(0);
    for (const day of itinerary.days) {
      expect(day.items.some((i) => i.kind === 'activity' && /Drive Killarney to Dingle|Airport/.test(i.title))).toBe(false);
    }
    expect(itinerary.issues.some((i) => i.code === 'gateway_unresolved' && i.dayNumber === 1)).toBe(true);
    const preservation = buildPreservationReport(draft, itinerary);
    expect(preservation.silentLoss).toBe(0);
    expect(preservation.counts.folded_into_logistics).toBe(2);
  });

  it('the audit refuses a transfer as a signature, and the feasibility report holds the day for the gateway decision', async () => {
    const draft = draftWithLogistics();
    const { context } = irelandContext();
    const { itinerary } = await reconcileTripDraft({ draft, context });
    const audit = auditItinerary({ draft, itinerary, profile, trip: IRELAND_TRIP });
    const check = audit.checks.find((c) => c.id === 'transfers_not_experiences')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/named as a signature/);
    const report = buildFeasibilityReport({ itinerary, audit });
    expect(report.verdict).toBe('unresolved_major_dependency');
    expect(report.items.some((i) => i.area === 'transport' && i.severity === 'dependency' && /arrive through/.test(i.detail))).toBe(true);
  });

  it('a clean draft passes both checks and is ready with cautions rather than needing a decision', async () => {
    const draft = irelandDraft();
    const { context } = irelandContext();
    const { itinerary } = await reconcileTripDraft({ draft, context });
    const audit = auditItinerary({ draft, itinerary, profile, trip: IRELAND_TRIP });
    expect(audit.checks.find((c) => c.id === 'transfers_not_experiences')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'daylight_respected')?.ok).toBe(true);
    const report = buildFeasibilityReport({ itinerary, audit });
    expect(['feasible', 'feasible_with_cautions']).toContain(report.verdict);
  });
});
