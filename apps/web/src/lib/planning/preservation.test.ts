import { describe, expect, it } from 'vitest';
import { boardWorld, draftOf, anchorCount } from './acceptance/harness';
import { reconcileTripDraft } from './reconcile';
import { buildPreservationReport, describePreservation } from './preservation';
import { auditItinerary } from './quality-audit';

/**
 * QUALITY V1 — Sidequest must improve the draft, never quietly shrink it.
 *
 * Every anchor the model proposed ends in exactly one preservation category;
 * silent loss is zero; a rich draft cannot collapse into a sparse trip
 * without an affirmative reason on the record. The structural audit runs on
 * the same fixture and must pass on a well-formed plan.
 */
describe('draft preservation report', () => {
  it('accounts for every draft anchor, with zero silent loss, on a fictional-world reconciliation', async () => {
    const context = boardWorld();
    const draft = draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
      days: [
        { base: 'base', anchors: [{ name: 'Convict Lake' }, { name: 'A Quiet Overlook Nobody Documented', role: 'optional' }] },
        { base: 'base', anchors: [{ name: 'Devils Postpile', role: 'core' }, { name: 'Rainbow Falls', role: 'secondary' }] },
        { base: 'base', anchors: [{ name: 'Mono Lake', role: 'core' }] },
        { base: 'base', anchors: [{ name: 'Hot Creek', role: 'flex' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    const report = buildPreservationReport(draft, result.itinerary);
    expect(report.draftAnchors).toBe(anchorCount(draft));
    expect(report.silentLoss).toBe(0);
    expect(report.entries.length).toBe(anchorCount(draft));
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(anchorCount(draft));
    expect(report.kept + report.removed).toBe(anchorCount(draft));
    // Unknown evidence never removes: the undocumented overlook is retained unverified.
    const overlook = report.entries.find((e) => e.name === 'A Quiet Overlook Nobody Documented');
    expect(overlook?.category).toBe('retained_unverified');
    expect(describePreservation(report)).toMatch(/of \d+ proposed experiences kept/);
    // A four-day draft with content every day cannot come back sparse without a reason.
    expect(report.draftSubstantiveDays).toBe(3);
    for (const collapsed of report.collapsedDays) expect(collapsed.reasons.length).toBeGreaterThan(0);

    const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: context.profile, trip: { id: context.tripId, basics: context.basics, status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, preservation: report });
    expect(audit.checks.map((c) => c.id)).toContain('no_silent_loss');
    expect(audit.checks.find((c) => c.id === 'no_silent_loss')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'all_dates_present')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'nights_sum')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'no_overlaps')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'edges_respected')?.ok).toBe(true);
    expect(audit.errors).toBe(0);
  });

  it('corrects a draft whose nights do not add up, and flags a day emptied without a reason', async () => {
    const context = boardWorld();
    const draft = draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 2 }],
      days: [
        { base: 'base', anchors: [{ name: 'Convict Lake' }] },
        { base: 'base', anchors: [] , theme: 'Open day', intensity: 'moderate' },
        { base: 'base', anchors: [{ name: 'Mono Lake' }] },
        { base: 'base', anchors: [{ name: 'Hot Creek' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: context.profile, trip: { id: context.tripId, basics: context.basics, status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
    // The reconciler rebuilds the stays from the day sequence, so the final plan sleeps the right nights and the audit records the miscount rather than failing on it.
    const nightsCheck = audit.checks.find((c) => c.id === 'nights_sum');
    expect(nightsCheck?.ok).toBe(true);
    expect(nightsCheck?.detail).toMatch(/corrected from the day sequence/);
    expect(audit.checks.find((c) => c.id === 'rest_is_deliberate')?.ok).toBe(false);
    // The emptied day is the real error: content-free, not called rest, unexplained.
    expect(audit.checks.find((c) => c.id === 'no_unexplained_empty_day')?.ok).toBe(false);
    expect(audit.passed).toBe(false);
  });
});

describe('stays follow the day sequence', () => {
  it('a loop that returns to the first base sleeps there on the last night, whatever the declared nights say', async () => {
    const context = boardWorld({ basics: { startDate: '2026-08-12', endDate: '2026-08-19' } });
    const draft = draftOf({
      // Declared: Hobart 2, Freycinet 2, Cradle 2 (= 6) against a 7-night trip whose days return to Hobart.
      bases: [{ id: 'hobart', name: 'Mammoth Lakes', nights: 2 }, { id: 'freycinet', name: 'June Lake', nights: 2 }, { id: 'cradle', name: 'Bishop', nights: 2 }],
      days: [
        { base: 'hobart', anchors: [{ name: 'Convict Lake' }] },
        { base: 'hobart', anchors: [{ name: 'Hot Creek' }] },
        { base: 'freycinet', anchors: [{ name: 'Mono Lake' }], relocation: true },
        { base: 'freycinet', anchors: [{ name: 'Devils Postpile' }] },
        { base: 'cradle', anchors: [{ name: 'Rainbow Falls' }], relocation: true },
        { base: 'cradle', anchors: [{ name: 'Mono Lake' }] },
        { base: 'hobart', anchors: [{ name: 'Convict Lake' }], relocation: true },
        { base: 'hobart', anchors: [] , theme: 'Departure', intensity: 'light' },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    const pkg = result.itinerary.package!;
    expect(pkg.bases.map((b) => `${b.id}:${b.nights}`)).toEqual(['hobart:2', 'freycinet:2', 'cradle:2', 'hobart#2:1']);
    expect(pkg.bases.reduce((s, b) => s + b.nights, 0)).toBe(7);
    expect(pkg.bases.every((b) => !b.insertedBySidequest)).toBe(true);
    expect(result.itinerary.days[6]!.baseName).toBe(result.itinerary.days[0]!.baseName);
    expect(result.deviations.some((d) => d.kind === 'base_stays_corrected_from_days')).toBe(true);
    const audit = auditItinerary({ draft, itinerary: result.itinerary, profile: context.profile, trip: { id: context.tripId, basics: context.basics, status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } });
    expect(audit.checks.find((c) => c.id === 'nights_sum')?.ok).toBe(true);
    expect(audit.checks.find((c) => c.id === 'base_changes_coherent')?.ok).toBe(true);
  });
});
