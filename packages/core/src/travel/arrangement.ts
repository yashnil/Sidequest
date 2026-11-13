/**
 * HOW THE TRIP GETS AROUND — ONE DECIDED THING.
 *
 * An independent read of a generated Tanzania safari found a plan whose own
 * transport summary said "a single operator driver-guide runs the overland legs
 * in a 4x4, with one internal flight", and a Bookings page that asked the
 * traveller to hire a rental car for the whole trip; day titles that said "fly"
 * over a 309 km road leg; and in-trip legs that alternated between drive, 4x4,
 * shuttle and walk. Each surface had answered "does the traveller drive?" on its
 * own, from a different scrap of evidence.
 *
 * This is the one answer. It is a pure function of what the plan itself says —
 * the draft's `driving` word, its own transport prose, its multi-day episodes,
 * the transport hints on its days and the modes on its legs, and the traveller's
 * own "I will drive" as the last resort. It never guesses from a destination,
 * and it never invents a mode the trip does not use (V11 §10).
 *
 * The order is the order of authority: a stated arrangement decides; where none
 * is stated, the plan's own description of how it moves (a sentence written for
 * the traveller) comes before the episodes, which come before the per-stop
 * hints, which come before the measured leg modes, which come before the
 * profile. Every answer records which of those it came from.
 */

export const TRIP_ARRANGEMENT_PRIMARIES = ['operator', 'private_driver', 'transfers', 'self_drive', 'public_transport', 'mixed'] as const;
export type TripArrangementPrimary = (typeof TRIP_ARRANGEMENT_PRIMARIES)[number];

/** Where the answer came from, most authoritative first. `default` means nothing in the plan said. */
export type TripArrangementEvidence = 'stated' | 'text' | 'episodes' | 'hints' | 'legs' | 'profile' | 'default';

export interface TripArrangement {
  primary: TripArrangementPrimary;
  /** True when the traveller is at the wheel of a car they are responsible for on at least one day. The only fact a rental, a permit or parking advice may key off. */
  selfDrive: boolean;
  /** The days a self-drive car is actually used — every day outside the operator's days on a self-drive trip, the non-operator days on a mixed one. */
  selfDriveDays: number[];
  /** The days an operator (a safari programme, a guided overland, a trek outfit) moves the traveller. */
  operatorDays: number[];
  /** Days that carry a structured flight leg or a declared flight move. */
  flightDays: number[];
  /**
   * Days whose own title promises a flight that the plan states elsewhere (its
   * transport prose) but carries no flight leg for, and whose day is not a road
   * relocation. The flight is real enough to book; it is not a leg yet.
   */
  statedFlightDays: number[];
  /** Any flight is part of the plan, stated or structured. */
  flights: boolean;
  /** The draft word for the vehicle the trip's road legs are driven in, for one consistent wording. Null when nobody drives the traveller anywhere. */
  vehicle: 'car' | 'four_wheel_drive' | 'private_transfer' | null;
  evidence: TripArrangementEvidence;
  /** One sentence, developer- and audit-facing: why this answer. */
  basis: string;
  /** Places where the plan's own words disagree with the answer. Reported, never acted on. */
  conflicts: string[];
}

export interface TripArrangementDay {
  dayNumber: number;
  /** The day's title as the traveller reads it. */
  theme?: string | undefined;
  /** Draft transport words on the day: each stop's `transport`, the day's `move.how`, each leg's `hint`. */
  hints: readonly string[];
  /** The persisted leg modes (`TransportMode`) on the day, when an itinerary exists. */
  legModes?: readonly string[];
  /** True when the day's relocation (base-to-base) leg is a road leg. */
  roadTransfer?: boolean;
}

export interface TripArrangementInput {
  /** The draft's `driving` word, when it stated one. */
  driving?: string | undefined;
  /** The traveller's own answer about driving. */
  willDrive?: boolean | undefined;
  /** The plan's own transport summary and notes. */
  transportText?: readonly string[];
  days: readonly TripArrangementDay[];
  episodes?: readonly { dayNumbers: readonly number[]; kind: string; mode: string; timing?: string | undefined }[];
  /** The itinerary's primary mode, when there is one; read like a leg mode. */
  primaryMode?: string | undefined;
}

/* The plan's own sentences. Each phrase is a statement about who drives, never about a place. */
const OPERATOR_TEXT = /\b(?:(?:safari|tour|trek(?:king)?|ground|overland|single|one) operator|operator(?:'s|’s)? (?:driver|vehicle|4x4|jeep|transfers?|drives|runs)|driver[- ]guides?|tour company|outfitter|ground handler|safari (?:vehicles?|compan(?:y|ies)|outfits?)|guided (?:tour|safari|overland|circuit))\b/i;
const DRIVER_TEXT = /\b(?:(?:private|hired|personal) (?:car and )?driver|private (?:road |car )?transfers?|chauffeur(?:ed)?|car (?:and|with) (?:a )?driver)\b/i;
const SELF_TEXT = /\b(?:self[- ]driv\w*|rental car|rent(?:ing)? a car|hire car|car hire|hired car|drive yourselves?|you(?:'ll| will)? drive|pick up the car|collect the car)\b/i;
const FOUR_BY_FOUR_TEXT = /\b(?:4x4|4×4|4wd|four[- ]wheel[- ]drive|land cruiser|jeep)\b/i;
const FLIGHT_TEXT = /\b(?:(?:internal|domestic|regional|bush|charter|light[- ]aircraft|scheduled|short|inter-?island) flights?|fl(?:y|ies|ying) (?:from|back|to|between|into|out of|over)|flights? (?:from|to|between|back))\b/i;
/** A day title that promises a flight. */
export const FLY_WORDS = /\b(?:fly|flies|flying|flight|flights|fly-in)\b/i;
/** The flight home is the terminal plan's, not an internal leg. */
const FLY_HOME = /\b(?:fly home|flight home|fly out|flying home|flights? out)\b/i;

const ROAD_HINTS = new Set(['car', 'four_wheel_drive', 'private_transfer', 'guide_or_lodge_transfer', 'taxi']);
const TRANSIT_HINTS = new Set(['metro', 'rail', 'bus', 'high_speed_rail']);
/** Episode kinds a traveller drives themselves through or does not move in. */
const SELF_RUN_EPISODES = new Set(['road_trip_segment', 'resort_stay', 'bike_tour']);

function isOperatorEpisode(episode: { kind: string; mode: string; timing?: string | undefined }): boolean {
  if (episode.timing === 'self') return false;
  if (episode.timing === 'operator') return true;
  return !SELF_RUN_EPISODES.has(episode.kind);
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** The trip's arrangement, from the plan's own evidence. Pure and deterministic. */
export function decideTripArrangement(input: TripArrangementInput): TripArrangement {
  const days = [...input.days].sort((a, b) => a.dayNumber - b.dayNumber);
  const allDays = days.length > 0 ? days.map((d) => d.dayNumber) : range(1);
  const text = (input.transportText ?? []).join(' \n ');
  const episodes = input.episodes ?? [];
  const operatorEpisodes = episodes.filter(isOperatorEpisode);
  const operatorDaySet = new Set(operatorEpisodes.flatMap((e) => [...e.dayNumbers]));
  const operatorDays = [...operatorDaySet].sort((a, b) => a - b);
  const outsideOperator = days.filter((d) => !operatorDaySet.has(d.dayNumber));

  /* Flights: structured first; a stated one is still a flight, but not yet a leg. */
  const flightDays = days.filter((d) => d.hints.includes('flight')).map((d) => d.dayNumber);
  const flightStated = FLIGHT_TEXT.test(text) || flightDays.length > 0;
  const lastDay = allDays[allDays.length - 1];
  const statedFlightDays = flightStated
    ? days
        .filter((d) => !flightDays.includes(d.dayNumber) && !d.roadTransfer && FLY_WORDS.test(d.theme ?? '') && !FLY_HOME.test(d.theme ?? '') && (d.dayNumber !== lastDay || /\bvia\b/i.test(d.theme ?? '')))
        .map((d) => d.dayNumber)
    : [];

  const conflicts: string[] = [];
  const saysOperator = OPERATOR_TEXT.test(text);
  const saysDriver = DRIVER_TEXT.test(text);
  const saysSelf = SELF_TEXT.test(text);
  const fourByFour = FOUR_BY_FOUR_TEXT.test(text) || operatorEpisodes.some((e) => e.mode === 'four_wheel_drive') || days.some((d) => operatorDaySet.has(d.dayNumber) && d.hints.includes('four_wheel_drive'));

  const finish = (primary: TripArrangementPrimary, evidence: TripArrangementEvidence, basis: string, selfDriveDays?: number[]): TripArrangement => {
    const selfDays =
      primary === 'self_drive'
        ? (selfDriveDays ?? (outsideOperator.length > 0 ? outsideOperator.map((d) => d.dayNumber) : allDays))
        : primary === 'mixed'
          ? (selfDriveDays ?? outsideOperator.map((d) => d.dayNumber))
          : [];
    const vehicle: TripArrangement['vehicle'] =
      primary === 'self_drive' ? 'car' : primary === 'operator' ? (fourByFour ? 'four_wheel_drive' : 'private_transfer') : primary === 'private_driver' ? 'private_transfer' : primary === 'mixed' ? 'car' : null;
    return {
      primary,
      selfDrive: primary === 'self_drive' || (primary === 'mixed' && selfDays.length > 0),
      selfDriveDays: [...selfDays].sort((a, b) => a - b),
      operatorDays,
      flightDays,
      statedFlightDays,
      flights: flightStated,
      vehicle,
      evidence,
      basis,
      conflicts,
    };
  };

  // 1. A stated arrangement decides. -------------------------------------------------------------
  if (input.driving) {
    if ((input.driving === 'rental_self_drive' || input.driving === 'owned_self_drive') && (saysOperator || saysDriver) && !saysSelf) conflicts.push(`the plan states ${input.driving} but its transport summary describes ${saysOperator ? 'an operator' : 'a hired driver'}`);
    if ((input.driving === 'private_driver' || input.driving === 'operator_transfer' || input.driving === 'none') && saysSelf) conflicts.push(`the plan states ${input.driving} but its transport summary describes self-driving`);
    switch (input.driving) {
      case 'rental_self_drive':
      case 'owned_self_drive':
        return finish('self_drive', 'stated', `the plan states ${input.driving}`);
      case 'private_driver':
        return finish('private_driver', 'stated', 'the plan states a private driver');
      case 'operator_transfer':
        return finish('operator', 'stated', 'the plan states operator transfers');
      case 'taxi_rideshare':
        return finish('transfers', 'stated', 'the plan states taxis and ride-hailing');
      case 'none':
        return finish('public_transport', 'stated', 'the plan states no road vehicle the traveller is responsible for');
      default:
        break;
    }
  }

  // 2. The plan's own description of how it moves. ------------------------------------------------
  if (saysSelf && (saysOperator || saysDriver)) {
    /* A guided day on a self-drive trip is a tour, not the ground arrangement; only operator-run episodes split the trip. */
    if (operatorEpisodes.length === 0) return finish('self_drive', 'text', 'the transport summary describes self-driving, with some guided or driven extras');
    const selfDays = outsideOperator.map((d) => d.dayNumber);
    return finish(selfDays.length > 0 ? 'mixed' : 'operator', 'text', `the transport summary describes both self-driving and ${saysOperator ? 'an operator' : 'a hired driver'}`, selfDays);
  }
  if (saysOperator) return finish('operator', 'text', 'the transport summary describes an operator moving the traveller');
  if (saysDriver) return finish('private_driver', 'text', 'the transport summary describes a hired driver');
  if (saysSelf) return finish('self_drive', 'text', 'the transport summary describes self-driving');

  // 3. The episodes: an operator-run programme with no self-driven road travel outside it. -----------
  const roadHintOutside = outsideOperator.filter((d) => d.hints.some((h) => h === 'car' || h === 'four_wheel_drive'));
  if (operatorEpisodes.length > 0 && roadHintOutside.length === 0 && operatorEpisodes.some((e) => e.mode === 'four_wheel_drive' || e.mode === 'guide_or_lodge_transfer' || e.mode === 'car')) {
    return finish('operator', 'episodes', `operator-run ${operatorEpisodes.map((e) => e.kind).join(', ')} carr${operatorEpisodes.length === 1 ? 'ies' : 'y'} the road travel`);
  }

  // 4. The per-stop hints. ----------------------------------------------------------------------------
  const hintsOutside = new Set(outsideOperator.flatMap((d) => [...d.hints]));
  const allHints = new Set(days.flatMap((d) => [...d.hints]));
  if (hintsOutside.has('car') || hintsOutside.has('four_wheel_drive')) {
    if (input.willDrive === false) return finish('transfers', 'hints', 'the days name road legs and the traveller does not drive');
    return operatorEpisodes.length > 0 ? finish('mixed', 'hints', 'the days name a car outside the operator-run days', roadHintOutside.map((d) => d.dayNumber)) : finish('self_drive', 'hints', 'the days name a car');
  }
  if (allHints.has('private_transfer')) return finish('private_driver', 'hints', 'the days name private transfers');
  if (allHints.has('guide_or_lodge_transfer')) return finish(operatorEpisodes.length > 0 ? 'operator' : 'private_driver', 'hints', 'the days name guide or lodge transfers');
  if ([...allHints].some((h) => TRANSIT_HINTS.has(h))) return finish('public_transport', 'hints', 'the days name trains, metro or buses');
  if (allHints.has('taxi')) return finish('transfers', 'hints', 'the days name taxis');

  // 5. The legs as measured. -----------------------------------------------------------------------------
  const legModes = new Set([...days.flatMap((d) => [...(d.legModes ?? [])]), ...(input.primaryMode ? [input.primaryMode] : [])]);
  if (legModes.has('drive')) return input.willDrive === false ? finish('transfers', 'legs', 'the legs are road legs and the traveller does not drive') : finish('self_drive', 'legs', 'the legs are driven');
  if (legModes.has('private_transfer')) return finish('private_driver', 'legs', 'the legs are private transfers');
  if (legModes.has('rail') || legModes.has('public_bus') || legModes.has('shuttle')) return finish('public_transport', 'legs', 'the legs ride public transport');
  if (legModes.has('rideshare')) return finish('transfers', 'legs', 'the legs are taxi rides');

  // 6. Nothing in the plan said. --------------------------------------------------------------------------
  if (input.willDrive === true) return finish('self_drive', 'profile', 'nothing in the plan says how it moves; the traveller drives');
  return finish('public_transport', 'default', 'nothing in the plan says how it moves');
}

/** Whether a draft transport word is a road vehicle somebody drives. */
export function isRoadVehicleHint(hint: string | undefined): boolean {
  return hint !== undefined && ROAD_HINTS.has(hint);
}

/**
 * A day title that promises a flight over a day whose relocation is a road leg
 * says "drive" instead. Only the flight words change; nothing else in the title
 * is touched, and a title with no road relocation is returned unchanged (a
 * flight the plan states but carries no leg for is a dependency, not a lie).
 */
export function themeForLegs(theme: string, day: { hasFlightLeg: boolean; roadTransfer: boolean }): string {
  if (day.hasFlightLeg || !day.roadTransfer || !FLY_WORDS.test(theme)) return theme;
  const swap = (word: string): string => {
    const lower = word.toLowerCase();
    const replacement = lower === 'flying' ? 'driving' : lower === 'flies' ? 'drives' : lower === 'flights' ? 'drives' : lower === 'fly-in' ? 'drive-in' : 'drive';
    return word[0] === word[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
  };
  return theme.replace(/\b(?:fly-in|flying|flies|flights|flight|fly)\b/gi, swap);
}

/**
 * What the traveller-facing surfaces say against the arrangement. Pure; reports
 * only. Each input is optional so a caller checks what it has.
 */
export function arrangementDisagreements(
  arrangement: Pick<TripArrangement, 'primary' | 'selfDrive' | 'flightDays' | 'statedFlightDays'>,
  surfaces: {
    bookings?: readonly { kind: string; title: string; dayNumber?: number | undefined; status?: string }[];
    budgetCategories?: readonly string[];
    readinessKinds?: readonly string[];
    advice?: readonly string[];
    days?: readonly { dayNumber: number; theme: string; hasFlightLeg: boolean; roadTransfer: boolean }[];
  },
): string[] {
  const out: string[] = [];
  const who = arrangement.primary.replace(/_/g, ' ');
  if (!arrangement.selfDrive) {
    for (const booking of surfaces.bookings ?? []) if (booking.kind === 'rental_vehicle' && booking.status !== 'not_needed') out.push(`a ${who} trip asks the traveller to book "${booking.title}"`);
    if ((surfaces.budgetCategories ?? []).includes('car_fuel_tolls_parking')) out.push(`a ${who} trip is budgeted a rental car and fuel`);
    if ((surfaces.readinessKinds ?? []).includes('driving_document')) out.push(`a ${who} trip tells the traveller to sort a driving licence or permit`);
    const words = (surfaces.advice ?? []).join(' \n ').match(/\b(?:rental car|rent a car|hire car|car hire|rental desk|international driving permit)\b/gi);
    if (words) out.push(`a ${who} trip's advice mentions ${[...new Set(words.map((w) => w.toLowerCase()))].join(', ')}`);
  }
  for (const day of surfaces.days ?? []) if (FLY_WORDS.test(day.theme) && !day.hasFlightLeg && day.roadTransfer) out.push(`day ${day.dayNumber} says "${day.theme}" over a road leg`);
  const flightNeeded = [...arrangement.flightDays, ...arrangement.statedFlightDays];
  if (surfaces.bookings) for (const n of flightNeeded) if (!surfaces.bookings.some((b) => b.kind === 'flight' && b.dayNumber === n)) out.push(`day ${n} flies and nothing asks the traveller to book the flight`);
  return out;
}
