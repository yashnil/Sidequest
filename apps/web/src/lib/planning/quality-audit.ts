import { episodesOf } from './trip-draft';
import { STRENUOUS_BLOCKERS, dayStrain, describeEdgeTime, isGatewayName, isTransferName, tripDates, type ContractConflict, type Itinerary, type TravelerProfile, type Trip, type TripContract } from '@sidequest/core';
import { impliesSelfDriving, type TripDraft } from './trip-draft';
import { buildPreservationReport, type DraftPreservationReport } from './preservation';
import { auditTopology } from './topology';
import { modeStatusFor, type TravelReality } from '@sidequest/core';

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
  /* PRODUCT RECOVERY V1 — temporal plausibility, provider or no provider. */
  'no_zero_minute_travel',
  'mode_plausible',
  'meals_in_window',
  'stops_follow_transfers',
  'bases_are_places_to_sleep',
  /*
   * PRODUCTION LOCK V5 §53 — the checks the founder's own two trips would have
   * failed. Every one is structural: it reads the draft and the itinerary and
   * asks a question with a definite answer. None of them is a taste oracle, and
   * none of them deletes anything.
   */
  /** §9 — the trip names what it is built around, and the days contain it. */
  'signatures_present',
  /** §13 — a sunset viewpoint is not scheduled at eleven in the morning. */
  'time_intent_respected',
  /** §10 — a multi-day experience occupies consecutive days and one continuous stay run. */
  'multi_day_continuous',
  /** §15 — a private driver produces no rental, permit or parking advice. */
  'transport_arrangement_consistent',
  /** §11 — lodging is not the same sentence on every night of a trip that moves. */
  'lodging_has_character',
  /** §22 — a food-led trip does not get five "meal near base" placeholders. */
  'meals_are_decisions',
  /** §25 — a backup belongs to a day it could actually be used on. */
  'backups_are_local',
  /** §7 — nothing states an arrival or departure time the traveller never gave. */
  'edge_times_not_invented',
  /*
   * V6 — the contract. Structural, like everything above: the itinerary's
   * dates against the dates the traveller locked, and every recorded conflict
   * between the composition and a locked fact.
   */
  /** V6 §2 — the itinerary is dated to the contract's window, never to a model window or a placeholder. */
  'locked_dates_preserved',
  /** V6 §2 — every contradiction of a locked fact was refused and recorded, none adopted. */
  'contract_respected',
  /** V6 §11 — no transfer or gateway is a scheduled stop, a signature or a core experience. */
  'transfers_not_experiences',
  /** V6 §12 — a daylight-only outdoor stop is not scheduled after sunset when the sunset is known. */
  'daylight_respected',
  /** V6 §5 — a strenuous day with a party member who cannot do it offers that member something else. */
  'party_hard_fails',
  /*
   * V7 §9 — topology. Read from `topology.ts`; every one is a contradiction
   * between what the draft promises and what the plan's own legs carry.
   */
  'base_moves_have_transfers',
  'transfer_endpoints_match',
  'episode_modes_respected',
  'promised_transport_is_structured',
  'last_day_reaches_departure',
  /** V7 §6 — the timing rationale does not contradict the climate the plan's own days carry. */
  'timing_rationale_consistent',
  /** V7 §7 — the plan's driving arrangement is not one the destination's compiled reality calls discouraged or unavailable. */
  'transport_reality_respected',
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
  /** V6 — the contract the build ran under, and what the enforcement recorded. */
  contract?: TripContract;
  contractConflicts?: readonly ContractConflict[];
  /** V6 — functional needs across the party (the contract's union), by key or label. */
  partyNeeds?: readonly string[];
  /** V7 §3 — the travel reality the build ran under, for the transport check. */
  reality?: TravelReality | null;
}): QualityAudit {
  const { draft, itinerary, profile, trip } = input;
  const checks: QualityCheck[] = [];
  const add = (id: QualityCheckId, ok: boolean, severity: QualityCheck['severity'], detail: string) => checks.push({ id, ok, severity, detail });

  // --- V6: the contract ------------------------------------------------------------
  if (input.contract) {
    const c = input.contract.timing;
    if (!c.open && c.startDate.value && c.endDate.value) {
      const first = itinerary.days[0]?.date;
      const last = itinerary.days[itinerary.days.length - 1]?.date;
      const held = first === c.startDate.value && last === c.endDate.value && itinerary.startDate === c.startDate.value && itinerary.endDate === c.endDate.value;
      add('locked_dates_preserved', held, 'error', held ? `dated ${c.startDate.value} to ${c.endDate.value}, as ${c.decidedBy === 'traveller' ? 'the traveller chose' : 'decided'}` : `the contract holds ${c.startDate.value} to ${c.endDate.value} (${c.lock}) but the itinerary runs ${first ?? '?'} to ${last ?? '?'}`);
    } else {
      add('locked_dates_preserved', true, 'error', 'the window was open; the composition chose it');
    }
    const conflicts = input.contractConflicts ?? [];
    const adopted = conflicts.filter((k) => k.resolution !== 'field_rejected' && k.resolution !== 'contract_kept');
    add('contract_respected', adopted.length === 0, 'error', conflicts.length === 0 ? 'nothing contradicted a locked fact' : adopted.length === 0 ? `${conflicts.length} contradiction(s) refused: ${conflicts.map((k) => k.field).join(', ')}` : `${adopted.length} contradiction(s) adopted: ${adopted.map((k) => k.field).join(', ')}`);
  }

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
  /*
   * §7 — the audit describes the edges at the precision they are known. It used
   * to quote `15:00` / `11:00`, which for an unknown edge is Sidequest's own
   * allowance and not a fact about a flight; an audit detail is read by an
   * operator diagnosing a real trip, so it has to say which of the two it is.
   */
  const edgeOk = beforeArrival.length === 0 && afterDeparture.length === 0;
  add('edges_respected', edgeOk, 'error', edgeOk ? `nothing before arrival (${describeEdgeTime(trip.basics.arrivalPrecision, trip.basics.arrivalTime)}, planned as ${trip.basics.arrivalTime}) or after departure (${describeEdgeTime(trip.basics.departurePrecision, trip.basics.departureTime)}, planned as ${trip.basics.departureTime})` : `${beforeArrival.length} item(s) before arrival, ${afterDeparture.length} after departure`);

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
  /* V7 §8 — the same reserve on every day of a safari, the same river on every day of a cruise, is the episode, not a repeat. */
  const repeatEpisodes = new Set(['safari', 'cruise', 'trek', 'resort_stay', 'expedition_boat', 'hut_to_hut']);
  const episodeDays = new Set(episodesOf(draft).filter((e) => repeatEpisodes.has(e.kind)).flatMap((e) => Array.from({ length: e.toDay - e.fromDay + 1 }, (_, i) => e.fromDay + i)));
  const scheduledTitles = itinerary.days.filter((day) => !episodeDays.has(day.dayNumber)).flatMap((day) => day.items.filter((item) => item.kind === 'activity').map((item) => item.title.trim().toLowerCase()));
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
  /*
   * V1 — what this check measures, stated: hotel moves against the nights and
   * against the traveller's own switching tolerance. It used to gate on a
   * breadth regex over an always-empty string, so only the "more than three
   * bases" half ever ran.
   */
  const tolerance = profile.interview.baseMoveTolerance;
  const allowedBases = tolerance === 'stay_put' ? 1 : tolerance === 'move_once' ? 2 : Number.POSITIVE_INFINITY;
  const moving = draft.bases.length > 1;
  const disciplined = (!moving || nightsPerBase >= 1.5 || tolerance === 'move_freely') && draft.bases.length <= allowedBases;
  add('scope_disciplined', disciplined, 'warning', `${draft.bases.length} base(s) over ${nights} nights (${nightsPerBase.toFixed(1)} nights per base); you said ${tolerance.replace(/_/g, ' ')}`);

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

  // --- temporal plausibility -------------------------------------------------------------
  /*
   * PRODUCT RECOVERY V1 — the checks the Ireland build would have failed. They
   * run whatever providers answered: a schedule that moves 90 km in zero
   * minutes, walks between counties, eats dinner at 11:15 or starts a stop
   * before its transfer could finish is structurally impossible, and no real
   * trip may persist that way. Like every check here, they never delete.
   */
  const legs = itinerary.days.flatMap((day) => day.items.filter((i) => i.kind === 'travel' && i.travel).map((i) => ({ day, item: i, travel: i.travel! })));
  const zeroLegs = legs.filter(({ item, travel }) => item.durationMinutes === 0 && travel.fromId !== travel.toId);
  add('no_zero_minute_travel', zeroLegs.length === 0, 'error', zeroLegs.length === 0 ? `${legs.length} travel legs all hold time` : `${zeroLegs.length} leg(s) between different places take zero minutes: ${zeroLegs.slice(0, 3).map(({ day, travel }) => `day ${day.dayNumber} ${travel.fromName} → ${travel.toName}`).join('; ')}`);
  const implausibleWalks = legs.filter(({ travel }) => travel.mode === 'walk' && ((travel.km ?? 0) > 4 || (travel.estimate?.straightLineKm ?? 0) > 3));
  add('mode_plausible', implausibleWalks.length === 0, 'error', implausibleWalks.length === 0 ? 'no walk covers more ground than a walk can' : `${implausibleWalks.length} walking leg(s) over 3 km: ${implausibleWalks.slice(0, 3).map(({ day, travel }) => `day ${day.dayNumber} ${travel.fromName} → ${travel.toName}`).join('; ')}`);
  const mealsOutOfWindow = itinerary.days.flatMap((day) => day.items.filter((i) => (i.kind === 'meal' && ((/^dinner/i.test(i.title) && i.startMinute < 17 * 60) || (/^lunch/i.test(i.title) && (i.startMinute < 11 * 60 || i.startMinute > 15 * 60 + 30)) || (/^breakfast/i.test(i.title) && i.startMinute > 11 * 60))) || (i.kind === 'activity' && /\b(dinner|supper)\b/i.test(i.title) && i.startMinute < 17 * 60)).map((i) => `day ${day.dayNumber}: ${i.title} at ${String(Math.floor(i.startMinute / 60)).padStart(2, '0')}:${String(i.startMinute % 60).padStart(2, '0')}`));
  add('meals_in_window', mealsOutOfWindow.length === 0, 'error', mealsOutOfWindow.length === 0 ? 'every meal sits at a mealtime' : mealsOutOfWindow.slice(0, 4).join('; '));
  const earlyStops = itinerary.days.flatMap((day) => {
    const ordered = [...day.items].filter((i) => i.kind !== 'free_time').sort((a, b) => a.startMinute - b.startMinute || (a.kind === 'travel' ? -1 : 1));
    const found: string[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]!;
      const cur = ordered[i]!;
      if (prev.kind === 'travel' && cur.startMinute < prev.endMinute) found.push(`day ${day.dayNumber}: ${cur.title} starts before ${prev.title} ends`);
    }
    return found;
  });
  add('stops_follow_transfers', earlyStops.length === 0, 'error', earlyStops.length === 0 ? 'no stop starts before the leg that reaches it ends' : earlyStops.slice(0, 4).join('; '));
  const landmarkBases = (itinerary.package?.bases ?? []).filter((b) => /\b(college|university|distillery|brewery|museum|castle|cathedral|church|abbey|airport|station|shop|store|gallery)\b/i.test(b.name) && b.baseKind !== 'lodging_property' && b.baseKind !== 'lodge' && b.baseKind !== 'camp');
  add('bases_are_places_to_sleep', landmarkBases.length === 0, 'error', landmarkBases.length === 0 ? 'every base is a town, area or lodging' : `base(s) named for a landmark: ${landmarkBases.map((b) => b.name).join(', ')}`);

  // --- PRODUCTION LOCK V5 -----------------------------------------------------------------
  auditV5({ draft, itinerary, profile, trip, add, ...(input.partyNeeds ? { partyNeeds: input.partyNeeds } : {}) });

  // --- V7 §9: topology ---------------------------------------------------------------------
  for (const check of auditTopology({ draft, itinerary })) add(check.id, check.ok, check.severity, check.detail);

  // --- V7 §6: the timing rationale against the days' own climate ---------------------------
  {
    const rationale = draft.timingRationale ?? '';
    const withWeather = itinerary.days.filter((day) => day.weather.precipitationProbabilityPercent !== undefined || day.weather.precipitationMm !== undefined || day.weather.temperatureMaxC !== undefined);
    const wetDays = withWeather.filter((day) => (day.weather.precipitationProbabilityPercent ?? 0) >= 50 || (day.weather.precipitationMm ?? 0) >= 4).length;
    const hotDays = withWeather.filter((day) => (day.weather.temperatureMaxC ?? 0) >= 33).length;
    const coldDays = withWeather.filter((day) => (day.weather.temperatureMinC ?? 99) <= 0).length;
    const contradictions: string[] = [];
    if (rationale && withWeather.length >= 3) {
      if (/\b(dry|driest|little rain|rain-free|mostly dry|dry season)\b/i.test(rationale) && wetDays * 2 >= withWeather.length) contradictions.push(`says dry while ${wetDays} of ${withWeather.length} days carry rain on the record`);
      if (/\b(mild|comfortable|pleasant|cool)\b/i.test(rationale) && hotDays * 2 >= withWeather.length) contradictions.push(`says ${/\bcool\b/i.test(rationale) ? 'cool' : 'comfortable'} while ${hotDays} of ${withWeather.length} days reach 33 °C or more`);
      if (/\b(warm|hot|sunny)\b/i.test(rationale) && !/\b(cold|cool|chilly)\b/i.test(rationale) && coldDays * 2 >= withWeather.length) contradictions.push(`says warm while ${coldDays} of ${withWeather.length} days freeze overnight`);
    }
    add('timing_rationale_consistent', contradictions.length === 0, 'warning', !rationale ? 'no timing rationale to check' : withWeather.length < 3 ? 'too little weather on the days to check the rationale against' : contradictions.length === 0 ? 'the timing rationale agrees with the climate on the days' : contradictions.join('; '));
  }

  // --- V7 §7: the driving arrangement against the compiled reality ---------------------------
  {
    const reality = input.reality ?? null;
    const selfDrive = impliesSelfDriving(draft.driving);
    const status = reality ? modeStatusFor(reality, 'self_drive') : 'unknown';
    const bad = selfDrive && (status === 'discouraged' || status === 'unavailable');
    const friction = selfDrive && status === 'friction';
    add('transport_reality_respected', !bad, 'error', !reality ? 'no compiled reality for this destination' : !selfDrive ? `nobody drives themselves; self-drive here is ${status}` : bad ? `the plan has the traveller driving where the compiled reality calls self-drive ${status}: ${reality.modes.find((m) => m.mode === 'self_drive')?.reason ?? ''}` : friction ? `self-drive is possible with friction here: ${reality.modes.find((m) => m.mode === 'self_drive')?.reason ?? ''}` : `self-drive is ${status} here`);
  }

  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;
  return { version: 1, passed: errors === 0, errors, warnings, checks };
}

/** Text a planner would recognise as "I did not decide anything here". */
const GENERIC_MEAL = /^(?:a\s+)?(?:breakfast|lunch|dinner|brunch|meal|food|eat|dine|supper|snack)?\s*(?:near|at|by|around|in)?\s*(?:the\s+)?(?:base|hotel|accommodation|stay|lodging|town|somewhere|anywhere|local|locally|as you like|your own|tbd|flexible|optional)?[.\s]*$/i;

/** The words that only make sense if the traveller is responsible for a car. */
const SELF_DRIVE_ADVICE = /\b(?:rental|rent a car|hire car|car hire|rental desk|rental excess|excess insurance|international driving permit|IDP|parking|park the car|fuel|petrol|gasoline|toll)\b/gi;

/**
 * The V5 structural checks, kept in their own function so `auditItinerary` stays
 * readable and so each check can say precisely what it looked at.
 *
 * Every one is a warning unless it describes something that cannot be executed
 * or that states a falsehood to the traveller. The audit's job is to be loud,
 * not to re-plan: `passed` gates persistence only on errors.
 */
function auditV5(input: {
  draft: TripDraft;
  itinerary: Itinerary;
  profile: TravelerProfile;
  trip: Trip;
  add: (id: QualityCheckId, ok: boolean, severity: QualityCheck['severity'], detail: string) => void;
  partyNeeds?: readonly string[];
}): void {
  const { draft, itinerary, profile, trip, add } = input;
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dayText = draft.days.map((day) => norm([day.theme, day.note ?? '', day.whyItFits ?? '', day.partOf ?? '', ...day.anchors.map((a) => `${a.name} ${a.why}`)].join(' ')));

  /* §9 — signatures. A trip that names none is not an error; a trip that names one and never delivers it is. */
  const signatures = draft.signatures ?? [];
  /**
   * A signature is delivered when a day carries the substance of it.
   *
   * The first version required one string to contain the other, and a live Hong
   * Kong build showed why that is the wrong test. The model named its signatures
   * as *descriptions* — "Dim sum and wet market crawl through Sheung Wan and
   * Central" — and delivered them as activities called "Dim sum crawl", "Graham
   * Street Market" and "Sheung Wan dried seafood streets". Every one was
   * present; no substring matched; the audit reported all three as absent. An
   * error that fires on a trip which plainly did the thing is worse than no
   * check, because it teaches a reader to skip the whole audit.
   *
   * So the test is **distinctive-word overlap**: at least half of a signature's
   * meaningful words (ignoring the joining words every travel phrase contains)
   * must appear somewhere in the days. Substring containment in either direction
   * still counts, which is what catches the short-name case — a signature called
   * "Ala-Kul" delivered by an "Ala-Kul Pass Descent".
   */
  const JOINING_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'then', 'through', 'to', 'up', 'via', 'with', 'day', 'days', 'trip']);
  const meaningfulWords = (value: string) => norm(value).split(' ').filter((word) => word.length > 2 && !JOINING_WORDS.has(word));
  const allDayText = dayText.join(' ');
  const undelivered = signatures.filter((name) => {
    const wanted = norm(name);
    if (wanted.length < 3) return false;
    const partOfNames = draft.days.map((day) => norm(day.partOf ?? '')).filter((value) => value.length >= 3);
    if (dayText.some((text) => text.includes(wanted))) return false;
    if (partOfNames.some((partOf) => partOf.includes(wanted) || wanted.includes(partOf))) return false;
    const words = meaningfulWords(name);
    if (words.length === 0) return false;
    const present = words.filter((word) => allDayText.includes(word)).length;
    return present * 2 < words.length;
  });
  add(
    'signatures_present',
    undelivered.length === 0,
    'error',
    signatures.length === 0
      ? 'the draft names no signature experience'
      : undelivered.length === 0
        ? `${signatures.length} signature experience(s), all present in the days: ${signatures.join('; ')}`
        : `named as central but absent from every day: ${undelivered.join('; ')}`,
  );

  /*
   * §13 — time intent. Checked against the scheduled minute, because that is the
   * thing a traveller acts on. The windows are generous on purpose: this catches
   * a sunset viewpoint at 11:00 and a night market in the afternoon, not a
   * twenty-minute difference of opinion about when evening starts.
   */
  const WINDOW: Record<string, [number, number]> = {
    sunrise: [4 * 60, 9 * 60],
    morning: [5 * 60, 12 * 60],
    midday: [10 * 60 + 30, 15 * 60],
    afternoon: [11 * 60, 18 * 60 + 30],
    sunset: [15 * 60, 22 * 60],
    evening: [16 * 60, 24 * 60],
    night: [17 * 60, 24 * 60 + 6 * 60],
  };
  const timeBreaches: string[] = [];
  for (const day of draft.days) {
    const scheduled = itinerary.days.find((d) => d.dayNumber === day.dayNumber);
    if (!scheduled) continue;
    /*
     * An edge day's window is cut by the flight, not by the plan.
     *
     * A "morning" stop that lands at 13:45 because the traveller arrives at
     * 10:00 is the arrival doing that, and flagging it would make this check
     * fire on almost every trip's first and last day. The hour-critical
     * intents are still checked everywhere: nothing about a 10:00 arrival
     * excuses a night market in the early afternoon.
     */
    const edgeDay = day.dayNumber === 1 || day.dayNumber === draft.days.length;
    const HARD_INTENTS = new Set(['sunrise', 'sunset', 'evening', 'night']);
    for (const anchor of day.anchors) {
      const intent = anchor.timeOfDay;
      if (!intent || intent === 'any') continue;
      if (edgeDay && !HARD_INTENTS.has(intent)) continue;
      const window = WINDOW[intent];
      if (!window) continue;
      const item = scheduled.items.find((i) => i.kind === 'activity' && norm(i.title) === norm(anchor.name));
      if (!item) continue;
      if (item.startMinute < window[0] || item.startMinute > window[1]) {
        timeBreaches.push(`day ${day.dayNumber}: ${anchor.name} wants ${intent} but sits at ${String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}`);
      }
    }
  }
  const withIntent = draft.days.reduce((n, d) => n + d.anchors.filter((a) => a.timeOfDay && a.timeOfDay !== 'any').length, 0);
  add('time_intent_respected', timeBreaches.length === 0, 'error', timeBreaches.length === 0 ? `${withIntent} time-dependent experience(s) sit in their part of the day` : timeBreaches.slice(0, 4).join('; '));

  /*
   * V6 §11 — TRANSPORT IS NOT A POI.
   *
   * "Drive Bhopal to Bandhavgarh" was a core anchor, a signature and a "Don't
   * miss" on a live trip. The reconciler now folds transfers and gateways
   * into the legs and the terminal plan; this check says whether any escaped:
   * a scheduled activity whose title is a transfer, or a signature that names
   * one.
   */
  const scheduledTransfers = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'activity' && (isTransferName(item.title) || isGatewayName(item.title))).map((item) => `day ${day.dayNumber}: ${item.title}`));
  const transferSignatures = signatures.filter((name) => isTransferName(name) || isGatewayName(name));
  add(
    'transfers_not_experiences',
    scheduledTransfers.length === 0 && transferSignatures.length === 0,
    'error',
    scheduledTransfers.length === 0 && transferSignatures.length === 0
      ? 'no transfer or gateway is scheduled as an experience'
      : [...scheduledTransfers.map((t) => `${t} is scheduled as a stop`), ...transferSignatures.map((t) => `"${t}" is named as a signature`)].slice(0, 4).join('; '),
  );

  /*
   * V6 §12 — DAYLIGHT. Only where the sunset is known for the day, and only
   * for stops the plan itself marked daylight-only or that are outdoor by
   * category. A missing sunset produces no finding: unknown ≠ false.
   */
  const daylightBreaches: string[] = [];
  for (const day of itinerary.days) {
    const sunset = day.weather.sunsetMinute;
    if (sunset === undefined) continue;
    for (const item of day.items) {
      if (item.kind !== 'activity') continue;
      const outdoor = item.daylightOnly === true || /\b(hike|trail|viewpoint|summit|lookout|falls|glacier|beach|lake|gorge|canyon|trek|pass)\b/i.test(item.title);
      if (!outdoor) continue;
      if (/\b(night|stargaz|aurora|northern lights|sunset|dusk|evening)\b/i.test(item.title)) continue;
      if (item.startMinute > sunset - 30) daylightBreaches.push(`day ${day.dayNumber}: ${item.title} starts at ${String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}, after sunset (${String(Math.floor(sunset / 60)).padStart(2, '0')}:${String(sunset % 60).padStart(2, '0')})`);
    }
  }
  add('daylight_respected', daylightBreaches.length === 0, 'warning', daylightBreaches.length === 0 ? 'no daylight-only stop is scheduled after a known sunset' : daylightBreaches.slice(0, 4).join('; '));

  /*
   * V6 §5 — PARTY HARD FAILS. A day that goes up or down steep ground is not
   * a preference problem for someone who cannot do steep ground; it is a day
   * they cannot do. It fails only on affirmative evidence — a stop that names
   * a hike, a descent, a climb (`dayStrain`) — and passes when the day offers
   * that person something else. A day the model merely called "intense" is
   * not evidence: a live jeep-safari day was declared contradicted for a
   * grandmother who avoids descents, when nothing in it went downhill. It
   * says nothing when nobody in the party has such a need.
   */
  const strenuousBlockers = (input.partyNeeds ?? []).filter((need: string) => (STRENUOUS_BLOCKERS as readonly string[]).includes(need) || /steep|limited walking|step-free|wheelchair|cannot stand|pregnan/i.test(need));
  const hardFailDays = strenuousBlockers.length === 0
    ? []
    : itinerary.days.filter((day) => { const strain = dayStrain(day); return strain.demanding.length > 0 && !strain.accommodated; }).map((day) => day.dayNumber);
  add('party_hard_fails', hardFailDays.length === 0, 'error', strenuousBlockers.length === 0 ? 'no party member has a need that rules out steep or long ground' : hardFailDays.length === 0 ? `no day puts steep or long ground in front of someone who needs "${strenuousBlockers[0]}" without an easier option` : `days ${hardFailDays.join(', ')} hold steep or long ground with no easier option for someone who needs "${strenuousBlockers[0]}"`);

  /*
   * §10 — a multi-day experience is one thing. Two properties: its days are
   * consecutive (a trek cannot pause for a day in a city and resume), and it is
   * not split across a stay it never returns to.
   */
  const runs = new Map<string, number[]>();
  for (const day of draft.days) {
    const name = day.partOf?.trim();
    if (!name) continue;
    const list = runs.get(name) ?? [];
    list.push(day.dayNumber);
    runs.set(name, list);
  }
  const broken = [...runs.entries()].filter(([, days]) => days.some((dayNumber, index) => index > 0 && dayNumber !== days[index - 1]! + 1));
  add(
    'multi_day_continuous',
    broken.length === 0,
    'error',
    runs.size === 0 ? 'the draft holds no multi-day experience' : broken.length === 0 ? `${runs.size} multi-day experience(s) run on consecutive days` : `interrupted: ${broken.map(([name, days]) => `${name} on days ${days.join(', ')}`).join('; ')}`,
  );

  /*
   * §15 — transport arrangement. The invariant with teeth: a trip whose driving
   * is arranged for the traveller must not hand them advice about a car they will
   * never touch. Checked against everything the traveller reads — the transport
   * strategy, the notes, before-you-go and packing.
   */
  const driving = draft.driving;
  const advisoryText = [draft.package.transport.summary, ...draft.package.transport.notes, ...draft.package.beforeYouGo, ...draft.package.packing].join(' \n ');
  const selfDriveWords = [...advisoryText.matchAll(SELF_DRIVE_ADVICE)].map((match) => match[0]);
  const drivenFor = driving === 'private_driver' || driving === 'operator_transfer' || driving === 'none';
  add(
    'transport_arrangement_consistent',
    !drivenFor || selfDriveWords.length === 0,
    'error',
    driving === undefined
      ? 'the draft states no driving arrangement, so no rental advice can be checked against one'
      : !drivenFor
        ? `driving is ${driving}, so self-drive advice is warranted`
        : selfDriveWords.length === 0
          ? `driving is ${driving} and nothing mentions rentals, permits or parking`
          : `driving is ${driving} but the traveller is told about: ${[...new Set(selfDriveWords.map((w) => w.toLowerCase()))].join(', ')}`,
  );

  /*
   * §11 — lodging character. Only meaningful for a trip that moves: one base for
   * one week has one kind of lodging by definition. A warning, never an error —
   * "every night is a guesthouse" can be exactly right for a city trip on a
   * budget, and only a person can say.
   */
  const lodgingLines = draft.bases.map((base) => norm(`${base.lodgingStyle ?? ''} ${base.overnight ?? ''}`)).filter((line) => line.length > 0);
  const distinctLodging = new Set(lodgingLines).size;
  const movingTrip = draft.bases.length >= 3;
  add(
    'lodging_has_character',
    !movingTrip || lodgingLines.length === 0 || distinctLodging > 1,
    'warning',
    lodgingLines.length === 0
      ? 'no stay says what kind of place it is'
      : !movingTrip
        ? `${draft.bases.length} base(s): one kind of lodging is expected`
        : distinctLodging > 1
          ? `${distinctLodging} distinct kinds of lodging across ${draft.bases.length} bases`
          : `all ${draft.bases.length} bases describe the same lodging: "${draft.bases[0]?.lodgingStyle ?? draft.bases[0]?.overnight ?? ''}"`,
  );

  /*
   * §22 — meals are decisions. Scaled to how much the traveller said food
   * matters: an error when food is the heart of the trip and the meals are
   * placeholders, a warning otherwise. "Lunch near base" is the exact string
   * that motivated this.
   */
  const writtenMeals = draft.days.flatMap((day) => [day.meals?.breakfast, day.meals?.lunch, day.meals?.dinner].filter((meal): meal is string => typeof meal === 'string' && meal.trim().length > 0));
  const genericMeals = writtenMeals.filter((meal) => GENERIC_MEAL.test(meal.trim()));
  const foodLevel = profile.interests.food_and_towns ?? 'low';
  const foodLed = foodLevel === 'core' || foodLevel === 'frequent' || (profile.interests.markets_and_street_food ?? 'low') === 'core';
  const mealsOk = writtenMeals.length === 0 || genericMeals.length * 2 <= writtenMeals.length;
  add(
    'meals_are_decisions',
    mealsOk,
    foodLed ? 'error' : 'warning',
    writtenMeals.length === 0
      ? 'the draft writes no meal intent'
      : mealsOk
        ? `${writtenMeals.length - genericMeals.length} of ${writtenMeals.length} meals name a real intent`
        : `${genericMeals.length} of ${writtenMeals.length} meals say nothing a traveller could act on: ${[...new Set(genericMeals)].slice(0, 3).map((m) => `"${m}"`).join(', ')}`,
  );

  /*
   * §25 — a backup belongs to a day. Two things are checked and they are
   * different: a backup scoped to a day outside the trip is nonsense, and a
   * backup scoped to the departure day is useless because there is nothing left
   * to fall back from.
   */
  const lastDay = draft.days.length;
  const misplaced = draft.package.backups
    .map((backup, index) => ({ backup, index }))
    .filter(({ backup }) => backup.day !== undefined && (backup.day < 1 || backup.day > lastDay || (backup.day === lastDay && lastDay > 1)));
  const scoped = draft.package.backups.filter((backup) => backup.day !== undefined).length;
  add(
    'backups_are_local',
    misplaced.length === 0,
    'warning',
    draft.package.backups.length === 0
      ? 'the draft offers no backup'
      : misplaced.length === 0
        ? `${scoped} of ${draft.package.backups.length} backup(s) name the day they cover`
        : `backup(s) on a day they cannot help: ${misplaced.map(({ backup }) => `day ${backup.day} — ${backup.trigger}`).join('; ')}`,
  );

  /*
   * §7 — no invented edge time reaches a traveller. This reads the itinerary's
   * own prose rather than the trip row, because the row's times are a legitimate
   * planning allowance and the defect was always in what got *printed*.
   */
  const spoken = [
    ...itinerary.days.flatMap((day) => [day.window.note ?? '', ...day.warnings]),
    ...itinerary.unscheduled.map((entry) => entry.reason ?? ''),
  ].join(' \n ');
  const arrivalSpoken = trip.basics.arrivalPrecision !== 'exact' && spoken.includes(`at ${trip.basics.arrivalTime}`);
  const departureSpoken = trip.basics.departurePrecision !== 'exact' && spoken.includes(`at ${trip.basics.departureTime}`);
  add(
    'edge_times_not_invented',
    !arrivalSpoken && !departureSpoken,
    'error',
    !arrivalSpoken && !departureSpoken
      ? `arrival ${describeEdgeTime(trip.basics.arrivalPrecision, trip.basics.arrivalTime)}, departure ${describeEdgeTime(trip.basics.departurePrecision, trip.basics.departureTime)} — nothing states a time the traveller did not give`
      : `a planning allowance is stated as a fact: ${[arrivalSpoken ? `arrival ${trip.basics.arrivalTime}` : '', departureSpoken ? `departure ${trip.basics.departureTime}` : ''].filter(Boolean).join(', ')}`,
  );
}

function isRelocation(draft: TripDraft, dayNumber: number): boolean {
  const day = draft.days.find((d) => d.dayNumber === dayNumber);
  if (!day) return false;
  if (day.relocation) return true;
  const previous = draft.days.find((d) => d.dayNumber === dayNumber - 1);
  return previous !== undefined && previous.baseId !== day.baseId;
}
