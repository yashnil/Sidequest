import type { BenchmarkPlan, PlanBlock, PlanDay } from './schemas/plan';

/**
 * THE STRUCTURAL FINGERPRINT.
 *
 * A canonical string over what a plan *does* — which day, which place, at what
 * time, by what means, inside which claimed window — and deliberately not over
 * how it says it.
 *
 * Two jobs.
 *
 * It defines "structurally equivalent" for the neutrality test. The strongest
 * available evidence that the validators are not biased toward either system is
 * to build one plan in each system's idiom that differ in every non-structural
 * way — different prose, different block ids, different optional fields present,
 * different array order before canonicalisation — and prove the findings come
 * out identical. Without a fingerprint, "equivalent" would be a judgement call,
 * and a judgement call is exactly what the test exists to remove.
 *
 * And it is the immutability check for stored plans. A plan read back and
 * re-rendered must fingerprint the same; a correction round must produce a
 * different one, or nothing happened.
 *
 * Prose is excluded because a system that phrases a note differently has not
 * made a different plan. `note`, `summary`, `theme` and `why` never enter.
 */

export function planFingerprint(plan: BenchmarkPlan): string {
  const header = [
    plan.schemaVersion,
    plan.generationState,
    plan.failureKind ?? '-',
    plan.destination.entityId ?? plan.destination.name,
    plan.startDate,
    plan.endDate,
  ].join('|');

  const bases = plan.bases
    .map((base) =>
      [
        base.id,
        base.place.entityId ?? base.place.name,
        base.nights,
        base.fromDate ?? '-',
        base.toDate ?? '-',
      ].join(':'),
    )
    .join('+');

  const days = plan.days.map(dayFingerprint).join('\n');

  // Exclusions and unknowns are structure: a plan that admits it could not fit
  // something has made a different commitment from one that stays silent, and a
  // reviewer would read them differently.
  const exclusions = plan.exclusions
    .map((exclusion) => exclusion.place.entityId ?? exclusion.place.name)
    .sort()
    .join(',');
  const unknowns = String(plan.unknowns.length);

  return `${header}\n[${bases}]\n${days}\n{${exclusions}}(${unknowns})`;
}

function dayFingerprint(day: PlanDay): string {
  const blocks = day.blocks.map(blockFingerprint).join('|');
  const alternatives = day.alternatives
    .map((alternative) => alternative.place.entityId ?? alternative.place.name)
    .join('+');
  return `${day.dayNumber}@${day.date}<${day.baseId ?? '-'}>(${alternatives})[${blocks}]`;
}

function blockFingerprint(block: PlanBlock): string {
  return [
    block.kind,
    block.place ? (block.place.entityId ?? block.place.name) : '-',
    block.startMinute ?? '-',
    block.endMinute ?? '-',
    // The travel *decision*: a mode change or a re-measured leg is a different
    // plan. The kilometres are not — two systems rounding a distance differently
    // have not moved anybody.
    block.travel
      ? [
          block.travel.mode,
          block.travel.provenance,
          block.travel.from?.entityId ?? block.travel.from?.name ?? '-',
          block.travel.to?.entityId ?? block.travel.to?.name ?? '-',
          block.travel.minutes ?? '-',
        ].join('/')
      : '-',
    // The meal decision: which slot, what kind of stop, where. Not the prose
    // about why the traveller might enjoy it.
    block.meal
      ? [
          block.meal.slot,
          block.meal.stopKind,
          block.meal.venue?.entityId ?? block.meal.venue?.name ?? '-',
          block.meal.detourMinutes ?? '-',
        ].join('/')
      : '-',
    block.opening
      ? `${block.opening.openMinute}-${block.opening.closeMinute}/${block.opening.lastAdmissionMinute ?? '-'}`
      : '-',
    // Whether the plan flagged uncertainty here is structure — it changes what
    // the traveller is being asked to accept — but the wording of the flag is
    // not.
    block.uncertainty.length > 0 ? `?${block.uncertainty.length}` : '-',
  ].join(':');
}
