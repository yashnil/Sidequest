import type { Itinerary, PackageAnchor } from '@sidequest/core';
import type { TripDraft } from './trip-draft';
import { draftAnchorId } from './trip-draft';

/**
 * THE DRAFT PRESERVATION REPORT — SIDEQUEST MUST IMPROVE THE DRAFT, NEVER
 * QUIETLY SHRINK IT.
 *
 * Every anchor the model proposed ends in exactly one category below, and the
 * report says so in numbers a test can assert on: `silentLoss` is the count of
 * draft anchors that reached no disposition at all, and it must be zero on
 * every build. The substantive-day check compares the days the draft filled
 * with the days the final itinerary fills, so a rich draft cannot collapse
 * into a sparse trip without an affirmative reason on the record.
 *
 * Categories map the reconciler's disposition codes onto the traveller-facing
 * vocabulary: preserved / verified / partially verified / retained unverified
 * / moved / substituted / rejected contradiction / rejected hard constraint /
 * capacity conflict. Unknown evidence — provider missing, timeout, hours
 * unknown, unroutable leg — never lands in a rejected bucket; that is what
 * "retained unverified" is for.
 */
export const PRESERVATION_CATEGORIES = [
  'preserved',
  'verified',
  'partially_verified',
  'retained_unverified',
  'moved',
  'substituted',
  'rejected_contradiction',
  'rejected_hard_constraint',
  'capacity_conflict',
  /** PRODUCT RECOVERY V1 — a food anchor folded into the day's meal intent: kept, as a meal. */
  'folded_into_meal',
] as const;
export type PreservationCategory = (typeof PRESERVATION_CATEGORIES)[number];

export interface PreservationEntry {
  anchorId: string;
  name: string;
  draftDay: number;
  finalDay?: number;
  role: PackageAnchor['role'];
  category: PreservationCategory;
  note?: string;
}

export interface DraftPreservationReport {
  version: 1;
  draftAnchors: number;
  counts: Record<PreservationCategory, number>;
  /** Draft anchors that reached no disposition. Must be zero. */
  silentLoss: number;
  silentlyLost: string[];
  /** Anchors the itinerary still carries as scheduled content (preserved, verified, partially verified, retained unverified, moved, substituted). */
  kept: number;
  /** Anchors removed for an affirmative reason (contradiction, hard constraint) or capacity. */
  removed: number;
  draftSubstantiveDays: number;
  finalSubstantiveDays: number;
  /** Days that held a core anchor in the draft and hold no activity in the final itinerary — each with the reasons the record gives. */
  collapsedDays: { dayNumber: number; reasons: string[] }[];
  entries: PreservationEntry[];
}

export function preservationCategoryOf(disposition: PackageAnchor['disposition'], verification: PackageAnchor['verification']): PreservationCategory {
  switch (disposition) {
    case 'preserved':
      return verification === 'verified' ? 'verified' : verification === 'partially_verified' ? 'partially_verified' : 'retained_unverified';
    case 'preserved_with_verified_facts':
      return 'verified';
    case 'retained_unverified':
      return 'retained_unverified';
    case 'moved_same_day':
    case 'moved_other_day':
      return 'moved';
    case 'substituted':
      return 'substituted';
    case 'rejected_contradiction':
      return 'rejected_contradiction';
    case 'rejected_hard_constraint':
      return 'rejected_hard_constraint';
    case 'unscheduled_capacity':
      return 'capacity_conflict';
    case 'folded_into_meal':
      return 'folded_into_meal';
  }
}

const KEPT: ReadonlySet<PreservationCategory> = new Set(['preserved', 'verified', 'partially_verified', 'retained_unverified', 'moved', 'substituted', 'folded_into_meal']);

export function buildPreservationReport(draft: TripDraft, itinerary: Itinerary): DraftPreservationReport {
  const dispositions = itinerary.package?.anchors ?? [];
  const byId = new Map(dispositions.map((anchor) => [anchor.id, anchor] as const));
  const counts = Object.fromEntries(PRESERVATION_CATEGORIES.map((c) => [c, 0])) as Record<PreservationCategory, number>;
  const entries: PreservationEntry[] = [];
  const silentlyLost: string[] = [];

  draft.days.forEach((day) => {
    day.anchors.forEach((anchor, index) => {
      const id = draftAnchorId(day.dayNumber, index, anchor.name);
      const found = byId.get(id) ?? dispositions.find((d) => d.dayNumber === day.dayNumber && d.name === anchor.name);
      if (!found) {
        silentlyLost.push(`${anchor.name} (day ${day.dayNumber})`);
        return;
      }
      const category = preservationCategoryOf(found.disposition, found.verification);
      counts[category] += 1;
      entries.push({
        anchorId: found.id,
        name: found.name,
        draftDay: day.dayNumber,
        ...(found.scheduledDayNumber !== undefined ? { finalDay: found.scheduledDayNumber } : KEPT.has(category) ? { finalDay: day.dayNumber } : {}),
        role: found.role,
        category,
        ...(found.note ? { note: found.note } : {}),
      });
    });
  });

  const draftSubstantive = new Set(draft.days.filter((day) => day.anchors.some((a) => a.role === 'core' || a.role === 'secondary')).map((day) => day.dayNumber));
  const finalSubstantive = new Set(itinerary.days.filter((day) => day.items.some((item) => item.kind === 'activity')).map((day) => day.dayNumber));
  const collapsedDays = [...draftSubstantive]
    .filter((dayNumber) => !finalSubstantive.has(dayNumber))
    .map((dayNumber) => {
      const reasons = entries
        .filter((entry) => entry.draftDay === dayNumber && !KEPT.has(entry.category))
        .map((entry) => `${entry.name}: ${entry.category.replace(/_/g, ' ')}${entry.note ? ` — ${entry.note}` : ''}`);
      const movedAway = entries.filter((entry) => entry.draftDay === dayNumber && entry.category === 'moved' && entry.finalDay !== dayNumber).map((entry) => `${entry.name}: moved to day ${entry.finalDay}`);
      const window = itinerary.days.find((day) => day.dayNumber === dayNumber)?.window.note;
      return { dayNumber, reasons: [...reasons, ...movedAway, ...(window ? [`day window: ${window}`] : [])] };
    });

  return {
    version: 1,
    draftAnchors: entries.length + silentlyLost.length,
    counts,
    silentLoss: silentlyLost.length,
    silentlyLost,
    kept: entries.filter((entry) => KEPT.has(entry.category)).length,
    removed: entries.filter((entry) => !KEPT.has(entry.category)).length,
    draftSubstantiveDays: draftSubstantive.size,
    finalSubstantiveDays: finalSubstantive.size,
    collapsedDays,
    entries,
  };
}

/** One traveller-facing sentence for the Verify section. */
export function describePreservation(report: DraftPreservationReport): string {
  const parts = [`${report.kept} of ${report.draftAnchors} proposed experiences kept`];
  if (report.counts.rejected_contradiction > 0) parts.push(`${report.counts.rejected_contradiction} removed because the evidence contradicted them`);
  if (report.counts.rejected_hard_constraint > 0) parts.push(`${report.counts.rejected_hard_constraint} removed to respect a limit you set`);
  if (report.counts.capacity_conflict > 0) parts.push(`${report.counts.capacity_conflict} left off because the day was full`);
  if (report.counts.folded_into_meal > 0) parts.push(`${report.counts.folded_into_meal} written as a meal rather than a stop`);
  if (report.counts.retained_unverified > 0) parts.push(`${report.counts.retained_unverified} kept without verification`);
  return `${parts.join('; ')}.`;
}
