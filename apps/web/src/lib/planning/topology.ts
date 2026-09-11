import { LEG_MODE_LABELS, legModeFromHint, type Itinerary, type ItineraryItem, type TravelSegment } from '@sidequest/core';
import { episodeForDay, episodeIsOffRoad, episodesOf, type DraftEpisode, type TripDraft } from './trip-draft';

/**
 * TRIP TOPOLOGY — THE CHRONOLOGY INVARIANTS A PLAN MUST HOLD BEFORE IT MAY
 * BE "READY".
 *
 * V7 §9. The live Chongqing plan promised a flight home in a day's title and
 * delivered breakfast; drove six hours to a gorge from a ship; changed base
 * without a transfer; and counted "0 internal flights" in a budget while the
 * overview depended on one. None of that was a copy defect. Each is a
 * structural contradiction between what the draft says and what the plan's
 * own legs carry, and each is checkable without a provider.
 *
 * Every check reads the draft (what was promised) and the itinerary (what
 * was built). None deletes; the feasibility report turns a failure into a
 * dependency and the status cannot reach "Ready" past one.
 */
export interface TopologyCheck {
  id: TopologyCheckId;
  ok: boolean;
  severity: 'error' | 'warning';
  detail: string;
}

export const TOPOLOGY_CHECK_IDS = [
  /** Every day that sleeps in a new base carries a structured transfer leg. */
  'base_moves_have_transfers',
  /** A transfer leg leaves the previous night's base and arrives at tonight's. */
  'transfer_endpoints_match',
  /** No road leg inside a boat, trek or rail episode; no episode stop reached by a drive. */
  'episode_modes_respected',
  /** A flight, ferry or train the draft promises on a day is a structured leg of that mode on that day. */
  'promised_transport_is_structured',
  /** A last day that ends away from where the trip leaves from carries the leg that reaches the departure gateway. */
  'last_day_reaches_departure',
] as const;
export type TopologyCheckId = (typeof TOPOLOGY_CHECK_IDS)[number];

const ROAD_MODES = new Set<TravelSegment['mode']>(['drive', 'rideshare', 'shuttle', 'public_bus', 'bicycle']);

function travelItems(itinerary: Itinerary, dayNumber: number): (ItineraryItem & { travel: TravelSegment })[] {
  const day = itinerary.days.find((d) => d.dayNumber === dayNumber);
  return (day?.items ?? []).filter((i): i is ItineraryItem & { travel: TravelSegment } => i.kind === 'travel' && i.travel !== undefined && i.travel.fromId !== i.travel.toId);
}

function transferOf(itinerary: Itinerary, dayNumber: number): (ItineraryItem & { travel: TravelSegment }) | undefined {
  return travelItems(itinerary, dayNumber).find((i) => i.travel.role === 'transfer');
}

/**
 * The leg that moves the traveller off last night's base. A relocation day
 * whose last stop is in the new town has no separate "transfer" leg — the
 * approach from the old base to the first stop IS the move, and the final hop
 * into town is elided because it is the same place. Either shape counts.
 */
function movementOf(itinerary: Itinerary, dayNumber: number): (ItineraryItem & { travel: TravelSegment }) | undefined {
  const explicit = transferOf(itinerary, dayNumber);
  if (explicit) return explicit;
  const yesterday = itinerary.days.find((d) => d.dayNumber === dayNumber - 1);
  if (!yesterday) return undefined;
  return travelItems(itinerary, dayNumber).find((i) => i.travel.fromId === yesterday.baseId || i.travel.fromName === yesterday.baseName);
}

/** The mode a leg actually is, from the draft's own word when it carried one, else the reconciler's. */
function legModeOf(travel: TravelSegment): string {
  const hinted = travel.hint ? legModeFromHint(travel.hint as Parameters<typeof legModeFromHint>[0]) : null;
  return hinted ?? travel.mode;
}

/** Words that promise a mode of transport, in day themes, notes and moves. Generic words only. */
const PROMISED: readonly [RegExp, readonly string[]][] = [
  [/\b(fly|flight|flights|flying|plane|airport transfer)\b/i, ['flight']],
  [/\b(ferry|catamaran|hydrofoil)\b/i, ['ferry', 'boat']],
  [/\b(high[- ]speed (?:rail|train)|bullet train|shinkansen|tgv|ktx|ave|hsr|train to|by train|rail to|sleeper)\b/i, ['rail', 'metro']],
  [/\b(disembark|board(?:ing)? the (?:ship|boat|cruise)|embark)\b/i, ['boat', 'ferry']],
];

export function auditTopology(input: { draft: TripDraft; itinerary: Itinerary }): TopologyCheck[] {
  const { draft, itinerary } = input;
  const checks: TopologyCheck[] = [];
  const add = (id: TopologyCheckId, ok: boolean, severity: TopologyCheck['severity'], detail: string) => checks.push({ id, ok, severity, detail });
  const episodes = episodesOf(draft);
  const days = itinerary.days;
  const draftDay = (n: number) => draft.days.find((d) => d.dayNumber === n);
  const baseChanged = (n: number) => {
    const today = days.find((d) => d.dayNumber === n);
    const yesterday = days.find((d) => d.dayNumber === n - 1);
    return Boolean(today && yesterday && today.baseId !== yesterday.baseId);
  };

  // --- 1. every base change has a transfer leg -----------------------------------------------
  const moveDays = days.filter((d) => baseChanged(d.dayNumber)).map((d) => d.dayNumber);
  const withoutTransfer = moveDays.filter((n) => !movementOf(itinerary, n));
  add('base_moves_have_transfers', withoutTransfer.length === 0, 'error', moveDays.length === 0 ? 'the trip never changes base' : withoutTransfer.length === 0 ? `${moveDays.length} base change(s), each with a transfer leg` : `days ${withoutTransfer.join(', ')} sleep somewhere new with no transfer leg reaching it`);

  // --- 2. a transfer's endpoints are last night's base and tonight's ------------------------------
  const mismatched: string[] = [];
  for (const n of moveDays) {
    const leg = movementOf(itinerary, n);
    if (!leg) continue;
    const today = days.find((d) => d.dayNumber === n)!;
    const yesterday = days.find((d) => d.dayNumber === n - 1)!;
    const legs = travelItems(itinerary, n);
    const departsFromRoute = legs.some((i) => i.travel.fromId === yesterday.baseId || i.travel.fromName === yesterday.baseName);
    /* An explicit transfer must land at tonight's base; an elided one (the last stop is in town) is judged by the day's last leg or its stop. */
    const explicit = leg.travel.role === 'transfer';
    const arrives = explicit ? leg.travel.toId === today.baseId || leg.travel.toName === today.baseName : true;
    if (!departsFromRoute) mismatched.push(`day ${n}: nothing leaves ${yesterday.baseName}, where the previous night was`);
    else if (!arrives) mismatched.push(`day ${n}: the transfer arrives at ${leg.travel.toName}, but the night is in ${today.baseName}`);
  }
  add('transfer_endpoints_match', mismatched.length === 0, 'error', mismatched.length === 0 ? 'every transfer leaves last night’s base and arrives at tonight’s' : mismatched.slice(0, 4).join('; '));

  // --- 3. episode modes: no road leg inside a boat, trek or rail episode ------------------------------
  const violations: string[] = [];
  for (const episode of episodes) {
    if (!episodeIsOffRoad(episode)) continue;
    for (let n = episode.fromDay; n <= episode.toDay; n += 1) {
      const dd = draftDay(n);
      const stopNames = new Set((dd?.anchors ?? []).map((a) => a.name.toLowerCase()));
      for (const item of travelItems(itinerary, n)) {
        const toStop = stopNames.has(item.travel.toName.toLowerCase());
        const road = ROAD_MODES.has(item.travel.mode) && item.travel.episode === undefined;
        /* The approach on the day the episode is entered (to the pier, the trailhead) is ordinary travel; everything after is the episode's. */
        const entryApproach = n === episode.fromDay && item.travel.role === 'approach' && item === travelItems(itinerary, n)[0];
        if (toStop && road && !entryApproach) violations.push(`day ${n}: "${item.title}" is a ${item.travel.mode} leg inside ${episode.name} (${episode.mode})`);
      }
    }
  }
  add('episode_modes_respected', violations.length === 0, 'error', episodes.length === 0 ? 'no multi-day episode' : violations.length === 0 ? `${episodes.length} episode(s) move by their own means` : violations.slice(0, 4).join('; '));

  // --- 4. promised transport is a structured leg ---------------------------------------------------
  const missingPromises: string[] = [];
  for (const dd of draft.days) {
    /*
     * A promise is what the day's TITLE says it does, or what its `move`
     * declares. A note that says "morning flight; nothing scheduled" on a
     * departure day is describing the flight home, which is the terminal
     * plan's, not an internal leg the plan owes.
     */
    const text = dd.theme;
    const isLastDay = dd.dayNumber === draft.days.length;
    const promisedModes = new Set<string>();
    for (const [re, modes] of PROMISED) if (re.test(text)) for (const m of modes) promisedModes.add(m);
    if (isLastDay && !dd.move && !/\bvia\b/i.test(text)) promisedModes.delete('flight');
    if (dd.move) for (const m of [legModeFromHint(dd.move.how as Parameters<typeof legModeFromHint>[0]) ?? dd.move.how]) if (m === 'flight' || m === 'ferry' || m === 'boat' || m === 'rail' || m === 'metro') promisedModes.add(m);
    if (promisedModes.size === 0) continue;
    const legs = travelItems(itinerary, dd.dayNumber);
    const modesPresent = new Set(legs.map((i) => legModeOf(i.travel)));
    const episode = episodeForDay(episodes, dd.dayNumber);
    const wantsFlight = promisedModes.has('flight');
    const wantsBoat = promisedModes.has('ferry') || promisedModes.has('boat');
    const wantsRail = promisedModes.has('rail') || promisedModes.has('metro');
    const hasFlight = modesPresent.has('flight');
    /* "Board the cruise" on the evening before the ship sails is kept by tomorrow's episode; tonight's vessel base keeps it too. */
    const tonightBase = itinerary.package?.bases.find((b) => b.id === days.find((d) => d.dayNumber === dd.dayNumber)?.baseId);
    const hasBoat = modesPresent.has('ferry') || modesPresent.has('boat') || legs.some((i) => i.travel.episodeMode === 'boat') || episode?.mode === 'boat' || episodeForDay(episodes, dd.dayNumber + 1)?.mode === 'boat' || tonightBase?.baseKind === 'vessel';
    const hasRail = modesPresent.has('rail') || modesPresent.has('metro') || legs.some((i) => i.travel.episodeMode === 'rail');
    if (wantsFlight && !hasFlight) missingPromises.push(`day ${dd.dayNumber} promises a flight ("${dd.theme}") and has no flight leg`);
    if (wantsBoat && !hasBoat) missingPromises.push(`day ${dd.dayNumber} promises a boat ("${dd.theme}") and has no boat leg`);
    if (wantsRail && !hasRail && !wantsFlight) missingPromises.push(`day ${dd.dayNumber} promises a train ("${dd.theme}") and has no rail leg`);
  }
  add('promised_transport_is_structured', missingPromises.length === 0, 'error', missingPromises.length === 0 ? 'every flight, boat or train the draft promises is a leg on its day' : missingPromises.slice(0, 4).join('; '));

  // --- 5. the last day reaches the departure gateway -------------------------------------------------
  const last = days[days.length - 1];
  const lastDraft = last ? draftDay(last.dayNumber) : undefined;
  const lastBase = last ? itinerary.package?.bases.find((b) => b.id === last.baseId || b.name === last.baseName) : undefined;
  const endsAway = Boolean(lastBase && (lastBase.baseKind === 'vessel' || lastBase.baseKind === 'trail_camp')) || /\b(fly home|flight home|fly out|via [A-Z][\w-]+|to the airport|to [A-Z][\w-]+ airport)\b/.test(lastDraft?.theme ?? '');
  const lastLegs = last ? travelItems(itinerary, last.dayNumber) : [];
  const reaches = lastLegs.some((i) => i.travel.role === 'transfer' || legModeOf(i.travel) === 'flight' || i.travel.toId.startsWith('gateway:'));
  add('last_day_reaches_departure', !endsAway || reaches, 'error', !last ? 'no days' : !endsAway ? `the trip leaves from ${last.baseName}` : reaches ? `the last day carries the leg to the departure gateway` : `day ${last.dayNumber} ends ${lastBase?.baseKind === 'vessel' ? 'on board' : 'away from the departure point'} ("${lastDraft?.theme ?? ''}") with no leg that reaches it`);

  return checks;
}

/** The episodes whose entry or exit transition the plan does not carry, for the feasibility report. */
export function unresolvedEpisodeTransitions(itinerary: Itinerary): { name: string; which: 'entry' | 'exit'; dayNumber: number }[] {
  const out: { name: string; which: 'entry' | 'exit'; dayNumber: number }[] = [];
  for (const episode of itinerary.package?.episodes ?? []) {
    if (episode.entryLeg === 'missing') out.push({ name: episode.name, which: 'entry', dayNumber: episode.dayNumbers[0] ?? 1 });
    if (episode.exitLeg === 'missing') out.push({ name: episode.name, which: 'exit', dayNumber: episode.dayNumbers[episode.dayNumbers.length - 1] ?? 1 });
  }
  return out;
}

export type { DraftEpisode };
export { LEG_MODE_LABELS };
