import { tripDates, type Itinerary, type TravelerProfile, type Trip } from '@sidequest/core';
import type { TripDraft } from './trip-draft';
import { buildPreservationReport, type DraftPreservationReport } from './preservation';

/**
 * THE DETERMINISTIC QUALITY AUDIT — STRUCTURE, NEVER TASTE.
 *
 * No model. A pure function of the draft, the reconciled itinerary, the
 * profile and the trip that answers the questions a careful planner checks
 * before handing a plan over: are all the dates there, is any day empty
 * without a reason, did anything land past a hard edge, do the nights add
 * up, do the bases line up with the days, do the stops overlap, did the drive
 * cap hold, was anything lost silently, does the stated frequency show, is
 * the scope of a broad destination disciplined, is rest deliberate.
 *
 * A failed check is loud in tests and shown as a verification note in the
 * product. It never deletes content: the audit protects structural quality,
 * it does not re-plan.
 */
export const QUALITY_CHECK_IDS = [
  'all_dates_present',
  'no_unexplained_empty_day',
  'edges_respected',
  'no_stop_past_window',
  'nights_sum',
  'base_consistency',
  'booked_respected',
  'no_duplicate_anchors',
  'no_overlaps',
  'drive_cap',
  'no_silent_loss',
  'frequency_honoured',
  'meals_present',
  'scope_disciplined',
  'base_changes_coherent',
  'rest_is_deliberate',
] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

export interface QualityCheck {
  id: QualityCheckId;
  ok: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

export interface QualityAudit {
  version: 1;
  passed: boolean;
  errors: number;
  warnings: number;
  checks: QualityCheck[];
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const FREQUENCY_KEYWORDS: Record<string, string[]> = {
  hiking: ['hike', 'trail', 'walk', 'trek', 'summit', 'ridge'],
  easy_nature_walks: ['walk', 'trail', 'garden', 'park', 'path'],
  wildlife: ['wildlife', 'safari', 'game', 'bird', 'whale', 'seal', 'puffin', 'reserve', 'sanctuary'],
  beaches_and_swimming: ['beach', 'swim', 'snorkel', 'bay', 'lagoon'],
  museums_and_galleries: ['museum', 'gallery'],
  markets_and_street_food: ['market', 'street food', 'hawker', 'food hall'],
  food_and_towns: ['restaurant', 'food', 'tasting', 'town', 'village', 'market'],
  history_and_culture: ['temple', 'castle', 'cathedral', 'church', 'palace', 'historic', 'heritage', 'old town', 'ruins', 'museum', 'shrine', 'mosque', 'fort'],
  scenic_viewpoints: ['view', 'lookout', 'overlook', 'summit', 'peak', 'vista'],
  scenic_drives: ['drive', 'road', 'pass', 'loop', 'coast road'],
};

export function auditItinerary(input: {
  draft: TripDraft;
  itinerary: Itinerary;
  profile: TravelerProfile;
  trip: Trip;
  bookedConflicts?: readonly string[];
  preservation?: DraftPreservationReport;
}): QualityAudit {
  const { draft, itinerary, profile, trip } = input;
  const checks: QualityCheck[] = [];
  const add = (id: QualityCheckId, ok: boolean, severity: QualityCheck['severity'], detail: string) => checks.push({ id, ok, severity, detail });

  // --- dates ------------------------------------------------------------------------
  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const dayDates = itinerary.days.map((day) => day.date);
  const missing = dates.filter((date) => !dayDates.includes(date));
  add('all_dates_present', missing.length === 0 && itinerary.days.length === dates.length, 'error', missing.length === 0 ? `${itinerary.days.length} days cover ${dates[0]} to ${dates[dates.length - 1]}` : `missing ${missing.join(', ')}`);

  // --- empty days ------------------------------------------------------------------
  const preservation = input.preservation ?? buildPreservationReport(draft, itinerary);
  const unexplained = itinerary.days.filter((day) => {
    const hasActivity = day.items.some((item) => item.kind === 'activity');
    if (hasActivity) return false;
    const draftDay = draft.days.find((d) => d.dayNumber === day.dayNumber);
    const draftHadContent = (draftDay?.anchors.length ?? 0) > 0;
    const explained = day.window.note !== undefined || day.warnings.length > 0 || preservation.collapsedDays.some((c) => c.dayNumber === day.dayNumber && c.reasons.length > 0);
    const deliberateRest = draftDay !== undefined && !draftHadContent && (draftDay.intensity === 'light' || /rest|free|relax|recover|slow|beach|pool/i.test(`${draftDay.theme} ${draftDay.note ?? ''}`));
    return draftHadContent ? !explained : !deliberateRest && !explained;
  });
  add('no_unexplained_empty_day', unexplained.length === 0, 'error', unexplained.length === 0 ? 'every day holds activity, or says why it does not' : `days ${unexplained.map((d) => d.dayNumber).join(', ')} are empty with no stated reason`);

  // --- edges ------------------------------------------------------------------------
  const first = itinerary.days[0];
  const last = itinerary.days[itinerary.days.length - 1];
  const arrival = minutes(trip.basics.arrivalTime);
  const departure = minutes(trip.basics.departureTime);
  const beforeArrival = first?.items.filter((item) => item.kind !== 'travel' && item.startMinute < arrival) ?? [];
  const afterDeparture = last?.items.filter((item) => item.kind !== 'travel' && item.endMinute > departure) ?? [];
  add('edges_respected', beforeArrival.length === 0 && afterDeparture.length === 0, 'error', beforeArrival.length === 0 && afterDeparture.length === 0 ? `nothing before arrival ${trip.basics.arrivalTime} or after departure ${trip.basics.departureTime}` : `${beforeArrival.length} item(s) before arrival, ${afterDeparture.length} after departure`);

  // --- window ------------------------------------------------------------------------
  const pastWindow = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind !== 'travel' && item.endMinute > day.window.endMinute + 30).map((item) => `day ${day.dayNumber}: ${item.title}`));
  add('no_stop_past_window', pastWindow.length === 0, 'warning', pastWindow.length === 0 ? 'every stop ends inside its day' : pastWindow.slice(0, 4).join('; '));

  // --- nights ------------------------------------------------------------------------
  const nights = dates.length - 1;
  const draftNights = draft.bases.reduce((sum, base) => sum + base.nights, 0);
  const pkgNights = itinerary.package?.bases.reduce((sum, base) => sum + base.nights, 0) ?? draftNights;
  // The final plan must sleep the right number of nights; a draft miscount that the reconciler corrected from the day sequence is noted, not failed.
  add('nights_sum', pkgNights === nights, 'error', `draft ${draftNights}, final ${pkgNights}, trip ${nights}${draftNights !== nights ? ' (draft miscount corrected from the day sequence)' : ''}`);

  // --- base consistency ------------------------------------------------------------
  const baseIds = new Set((itinerary.package?.bases ?? []).map((base) => base.id));
  const dayBaseMismatch = itinerary.days.filter((day) => baseIds.size > 0 && !baseIds.has(day.baseId) && !itinerary.package?.bases.some((base) => base.name === day.baseName));
  add('base_consistency', dayBaseMismatch.length === 0, 'error', dayBaseMismatch.length === 0 ? 'every day sleeps at a base the package names' : `days ${dayBaseMismatch.map((d) => d.dayNumber).join(', ')} name a base the package does not`);

  // --- booked ------------------------------------------------------------------------
  const conflicts = input.bookedConflicts ?? [];
  add('booked_respected', conflicts.length === 0, 'error', conflicts.length === 0 ? 'no booked fact is contradicted' : conflicts.slice(0, 3).join(' '));

  // --- duplicates ----------------------------------------------------------------------
  const scheduledTitles = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'activity').map((item) => item.title.trim().toLowerCase()));
  const duplicates = scheduledTitles.filter((title, index) => scheduledTitles.indexOf(title) !== index);
  add('no_duplicate_anchors', duplicates.length === 0, 'warning', duplicates.length === 0 ? 'no activity appears twice' : `repeated: ${[...new Set(duplicates)].slice(0, 4).join(', ')}`);

  // --- overlaps ------------------------------------------------------------------------
  const overlaps = itinerary.days.flatMap((day) => {
    const sorted = [...day.items].filter((item) => item.kind !== 'travel').sort((a, b) => a.startMinute - b.startMinute);
    const found: string[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.startMinute < sorted[i - 1]!.endMinute) found.push(`day ${day.dayNumber}: ${sorted[i - 1]!.title} / ${sorted[i]!.title}`);
    }
    return found;
  });
  add('no_overlaps', overlaps.length === 0, 'error', overlaps.length === 0 ? 'no two stops overlap' : overlaps.slice(0, 4).join('; '));

  // --- drive cap ---------------------------------------------------------------------
  const cap = profile.transport.willDrive ? profile.transport.maxDailyDriveMinutes : null;
  const overCap = cap === null ? [] : itinerary.days.filter((day) => !isRelocation(draft, day.dayNumber) && day.totals.driveMinutes > cap);
  add('drive_cap', overCap.length === 0, 'error', cap === null ? 'no driving cap applies' : overCap.length === 0 ? `every ordinary day drives at most ${cap} minutes` : `days ${overCap.map((d) => `${d.dayNumber} (${d.totals.driveMinutes} min)`).join(', ')} exceed ${cap} minutes`);

  // --- silent loss ---------------------------------------------------------------------
  add('no_silent_loss', preservation.silentLoss === 0, 'error', preservation.silentLoss === 0 ? `all ${preservation.draftAnchors} proposed experiences have a disposition` : `${preservation.silentLoss} lost: ${preservation.silentlyLost.join(', ')}`);

  // --- frequency -----------------------------------------------------------------------
  const coreInterests = Object.entries(profile.interests).filter(([, level]) => level === 'core').map(([interest]) => interest);
  const text = draft.days.map((day) => `${day.theme} ${day.anchors.map((a) => `${a.name} ${a.category} ${a.why}`).join(' ')}`.toLowerCase());
  const underServed = coreInterests.filter((interest) => {
    const keywords = FREQUENCY_KEYWORDS[interest] ?? [interest.replace(/_/g, ' ')];
    const hits = text.filter((dayText) => keywords.some((k) => dayText.includes(k))).length;
    return hits < Math.max(2, Math.floor(draft.days.length / 3));
  });
  add('frequency_honoured', underServed.length === 0, 'warning', coreInterests.length === 0 ? 'no core theme stated' : underServed.length === 0 ? `core themes (${coreInterests.join(', ')}) appear across the trip` : `core theme(s) ${underServed.join(', ')} appear on too few days`);

  // --- meals ---------------------------------------------------------------------------
  const daysWithoutMeal = itinerary.days.filter((day) => !day.items.some((item) => item.kind === 'meal') && day.items.some((item) => item.kind === 'activity'));
  add('meals_present', daysWithoutMeal.length === 0, 'warning', daysWithoutMeal.length === 0 ? 'every active day has meal intent' : `days ${daysWithoutMeal.map((d) => d.dayNumber).join(', ')} have no meal`);

  // --- scope ---------------------------------------------------------------------------
  const nightsPerBase = draft.bases.length > 0 ? nights / draft.bases.length : nights;
  const broad = /country|multi_country|region/.test(String(trip.basics.regionId === 'dynamic' ? '' : '')) || draft.bases.length > 3;
  add('scope_disciplined', !broad || nightsPerBase >= 1.5 || profile.interview.baseMoveTolerance === 'move_freely', 'warning', `${draft.bases.length} base(s) over ${nights} nights (${nightsPerBase.toFixed(1)} nights per base)`);

  // --- base changes ----------------------------------------------------------------------
  const order: string[] = [];
  for (const day of draft.days) if (order[order.length - 1] !== day.baseId) order.push(day.baseId);
  // A loop closes where it opened: a final return to the first base is the shape, not a zig-zag.
  const closesLoop = order.length > 2 && order[order.length - 1] === order[0];
  const revisits = order.filter((id, index) => order.indexOf(id) !== index && !(closesLoop && index === order.length - 1));
  const declaredBases = draft.bases.map((b) => b.id);
  const undeclared = order.filter((id) => !declaredBases.includes(id));
  add('base_changes_coherent', revisits.length === 0 && undeclared.length === 0, 'warning', revisits.length === 0 && undeclared.length === 0 ? `route ${order.join(' → ')}` : `${revisits.length > 0 ? `returns to ${[...new Set(revisits)].join(', ')}` : ''}${undeclared.length > 0 ? ` undeclared base ${undeclared.join(', ')}` : ''}`.trim());

  // --- rest --------------------------------------------------------------------------------
  const restDays = draft.days.filter((day) => day.anchors.length === 0);
  const unlabelledRest = restDays.filter((day) => !(day.intensity === 'light' || /rest|free|relax|recover|slow|beach|pool|at leisure/i.test(`${day.theme} ${day.note ?? ''}`)));
  add('rest_is_deliberate', unlabelledRest.length === 0, 'warning', restDays.length === 0 ? 'no empty draft day' : unlabelledRest.length === 0 ? `${restDays.length} deliberate rest day(s)` : `days ${unlabelledRest.map((d) => d.dayNumber).join(', ')} are empty without being called rest`);

  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;
  return { version: 1, passed: errors === 0, errors, warnings, checks };
}

function isRelocation(draft: TripDraft, dayNumber: number): boolean {
  const day = draft.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return false;
  if (day.relocation) return true;
  const previous = draft.days.find((d) => d.dayNumber === dayNumber - 1);
  return previous !== undefined && previous.baseId !== day.baseId;
}
