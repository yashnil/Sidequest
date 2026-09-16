import { z } from 'zod';
import type { ModeConcept } from '../reality/schema';
import type { TransportMode } from '../schemas/access';

/**
 * V12.1 §2 — ONE TRAVELLER-FACING WAY OF MOVING, AND EXPLICIT MAPS TO THE REST.
 *
 * ── WHY THIS IS NOT A COLLAPSE ──────────────────────────────────────────────
 *
 * The repository holds seven partially-overlapping mode vocabularies, and §2 is
 * right that they are not all the same question:
 *
 *   `DRAFT_TRANSPORTS`   what the composing model said        (17)
 *   `TravelMode` (here)  how a person actually moves          (18)
 *   `TRANSPORT_MODES`    what a persisted leg is labelled     (10)
 *   `ModeConcept`        what a *country* supports            (16)
 *   `TravelDurationState` how well a duration is known         (5)
 *   `MobilityPattern`    how a *trip* moves, as policy         (7)
 *   provider costings    what a router will accept             (3–5)
 *
 * Collapsing them would lose real distinctions — a country's `ferry` status is
 * not a leg's `ferry` mode, and neither is a router's `auto` profile. What was
 * missing is not one enum but the **total functions between them**, and their
 * absence is what let seven of the model's seventeen words vanish at
 * `reconcile.ts`'s `transportModeFor` and what let a hintless stop fall through
 * a `default:` branch onto whatever mode the matrix happened to be.
 *
 * So every map below is total over its domain — written as a `Record` with an
 * exhaustive key type rather than a `switch` with a `default`, because a
 * `default` is exactly the silent fall-through §2 forbids and a `Record` stops
 * compiling when somebody adds a value.
 *
 * ── WHY `unknown` IS A MODE AND `unsupported` IS NOT ────────────────────────
 *
 * `TRANSPORT_MODES` ends with `'unsupported'`, which is a statement about
 * *Sidequest* wearing the costume of a statement about the journey: a flight
 * and a modelling gap became the same value. Here, `unknown` means the journey's
 * mode was never stated — an honest gap in the input — and there is no value
 * meaning "we do not model this", because a mode we cannot measure is still a
 * mode somebody travels.
 */

/**
 * How a person moves between two points.
 *
 * Ordered roughly from self-powered to arranged, which is also the order
 * `MODE_LABELS` reads in. Every value here is something a traveller does; none
 * of them is a statement about what Sidequest can measure.
 */
export const TRAVEL_MODES = [
  'walk',
  'bike',
  'drive',
  'taxi',
  'private_transfer',
  'bus',
  'urban_transit',
  'rail',
  'ferry',
  'boat',
  'flight',
  'shuttle',
  'four_wheel_drive',
  'horse',
  'trail',
  'cable_car_or_lift',
  'operator_transfer',
  /** The journey's mode was never stated. Not "we do not model this". */
  'unknown',
] as const;
export const travelModeSchema = z.enum(TRAVEL_MODES);
export type TravelMode = z.infer<typeof travelModeSchema>;

/**
 * What a traveller reads. Sentence-case fragments, so they compose into a row
 * ("Ferry · timetable to confirm") without a second casing rule.
 */
export const TRAVEL_MODE_LABELS: Record<TravelMode, string> = {
  walk: 'Walk',
  bike: 'Bike',
  drive: 'Drive',
  taxi: 'Taxi',
  private_transfer: 'Private transfer',
  bus: 'Bus',
  urban_transit: 'Metro or bus',
  rail: 'Train',
  ferry: 'Ferry',
  boat: 'Boat',
  flight: 'Flight',
  shuttle: 'Shuttle',
  four_wheel_drive: '4x4',
  horse: 'On horseback',
  trail: 'Trail',
  cable_car_or_lift: 'Cable car',
  operator_transfer: 'Transfer',
  unknown: 'Travel',
};

/* ────────────────────────────────────────────────────────────────────────────
 * THE DRAFT'S OWN WORD → HOW SOMEBODY MOVES
 *
 * This is the map that was losing information. `reconcile.ts`'s
 * `transportModeFor` folded `four_wheel_drive` into `drive`, `horse` and
 * `guide_or_lodge_transfer` into `private_transfer`, `boat` into `ferry`,
 * `high_speed_rail` and `metro` into `rail`, and `flight` into `unsupported` —
 * seven distinctions gone before anything downstream could read them.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Keyed by the draft vocabulary's values as strings rather than by
 * `DraftTransport`, because that type lives in the web app and `core` may not
 * import upward. `mobility.test.ts` holds this table to `DRAFT_TRANSPORTS`, so
 * a value added there without a mapping here fails the suite rather than
 * falling through.
 */
export const DRAFT_TRANSPORT_MODES: Record<string, TravelMode> = {
  walk: 'walk',
  car: 'drive',
  taxi: 'taxi',
  bus: 'bus',
  metro: 'urban_transit',
  rail: 'rail',
  high_speed_rail: 'rail',
  ferry: 'ferry',
  boat: 'boat',
  flight: 'flight',
  private_transfer: 'private_transfer',
  four_wheel_drive: 'four_wheel_drive',
  guide_or_lodge_transfer: 'operator_transfer',
  horse: 'horse',
  bicycle: 'bike',
  shuttle: 'shuttle',
  unknown: 'unknown',
};

/** The draft's word for how somebody moves, or `unknown` when it said nothing legible. */
export function travelModeFromDraft(hint: string | undefined | null): TravelMode {
  if (!hint) return 'unknown';
  return DRAFT_TRANSPORT_MODES[hint] ?? 'unknown';
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PERSISTED LEG ↔ HOW SOMEBODY MOVES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The persisted leg's label, read as a way of moving.
 *
 * Lossy in one direction only, and knowably so: `TRANSPORT_MODES` has ten
 * values where this has eighteen, so a leg stored as `private_transfer` could
 * have been a hired car, a guide's vehicle or a horse. That is why
 * `journeyFromSegment` reads the `hint` and the `episodeMode` **before** it
 * falls back to this.
 */
export const TRANSPORT_MODE_TO_TRAVEL: Record<TransportMode, TravelMode> = {
  drive: 'drive',
  walk: 'walk',
  shuttle: 'shuttle',
  public_bus: 'bus',
  rail: 'rail',
  ferry: 'ferry',
  rideshare: 'taxi',
  private_transfer: 'private_transfer',
  bicycle: 'bike',
  /*
   * The one value that is not a way of moving. It reads as `unknown` rather
   * than as a mode, which is the honest translation: the stored leg says
   * Sidequest had no vocabulary for this, not that the traveller stayed put.
   */
  unsupported: 'unknown',
};

export function travelModeFromTransport(mode: TransportMode): TravelMode {
  return TRANSPORT_MODE_TO_TRAVEL[mode];
}

/**
 * How a way of moving is written on a persisted leg.
 *
 * The projection back into the ten-value vocabulary every stored itinerary,
 * every migration and every existing consumer already speaks. Total, and
 * deliberately explicit about each collapse rather than letting one happen.
 */
export const TRAVEL_MODE_TO_TRANSPORT: Record<TravelMode, TransportMode> = {
  walk: 'walk',
  bike: 'bicycle',
  drive: 'drive',
  taxi: 'rideshare',
  private_transfer: 'private_transfer',
  bus: 'public_bus',
  urban_transit: 'rail',
  rail: 'rail',
  ferry: 'ferry',
  boat: 'ferry',
  /* No persisted value means "flight". It stays `unsupported` so no old reader changes behaviour; the Journey carries the truth. */
  flight: 'unsupported',
  shuttle: 'shuttle',
  four_wheel_drive: 'drive',
  horse: 'private_transfer',
  /* A trail stage is walked. The Journey says it is a trail; the leg says it is on foot, which is true. */
  trail: 'walk',
  cable_car_or_lift: 'shuttle',
  operator_transfer: 'private_transfer',
  unknown: 'unsupported',
};

export function transportModeOf(mode: TravelMode): TransportMode {
  return TRAVEL_MODE_TO_TRANSPORT[mode];
}

/* ────────────────────────────────────────────────────────────────────────────
 * HOW SOMEBODY MOVES → WHAT A COUNTRY SUPPORTS
 *
 * `null` where the country vocabulary genuinely has no concept for it: nobody
 * publishes a national status for trails, horses or cable cars, and inventing
 * one would make `modeStatusFor` answer a question it was never asked.
 * ──────────────────────────────────────────────────────────────────────────── */

export const TRAVEL_MODE_CONCEPTS: Record<TravelMode, ModeConcept | null> = {
  walk: 'walking',
  bike: 'cycling',
  drive: 'rental_car',
  taxi: 'taxi',
  private_transfer: 'private_driver',
  bus: 'bus',
  urban_transit: 'metro',
  rail: 'intercity_train',
  ferry: 'ferry',
  boat: 'ferry',
  flight: 'flight',
  shuttle: 'shuttle',
  four_wheel_drive: 'rental_car',
  horse: null,
  trail: 'walking',
  cable_car_or_lift: null,
  operator_transfer: 'guided_transfer',
  unknown: null,
};

/**
 * Every country concept worth consulting for a mode, strongest first.
 *
 * A list rather than the single value above, because "does this country do
 * rail?" is answered by `intercity_train` *or* `high_speed_rail` *or* `metro`,
 * and asking only the first would call Japan a country without trains if its
 * row happened to name only the shinkansen.
 */
export const TRAVEL_MODE_CONCEPT_FAMILY: Record<TravelMode, readonly ModeConcept[]> = {
  walk: ['walking'],
  bike: ['cycling'],
  drive: ['rental_car', 'self_drive'],
  taxi: ['taxi', 'rideshare'],
  private_transfer: ['private_driver', 'guided_transfer'],
  bus: ['bus'],
  urban_transit: ['metro', 'bus'],
  rail: ['intercity_train', 'high_speed_rail', 'metro'],
  ferry: ['ferry', 'cruise'],
  boat: ['ferry', 'cruise'],
  flight: ['flight'],
  shuttle: ['shuttle', 'guided_transfer'],
  four_wheel_drive: ['rental_car', 'self_drive', 'private_driver'],
  horse: [],
  trail: ['walking'],
  cable_car_or_lift: [],
  operator_transfer: ['guided_transfer', 'private_driver'],
  unknown: [],
};

/* ────────────────────────────────────────────────────────────────────────────
 * AN EPISODE'S OWN MOVEMENT → HOW SOMEBODY MOVES
 * ──────────────────────────────────────────────────────────────────────────── */

export const EPISODE_MODE_TRAVEL: Record<string, TravelMode> = {
  boat: 'boat',
  walk: 'trail',
  four_wheel_drive: 'four_wheel_drive',
  rail: 'rail',
  car: 'drive',
  bicycle: 'bike',
  guide_or_lodge_transfer: 'operator_transfer',
  horse: 'horse',
  none: 'unknown',
};

export function travelModeFromEpisode(episodeMode: string | undefined | null): TravelMode {
  if (!episodeMode) return 'unknown';
  return EPISODE_MODE_TRAVEL[episodeMode] ?? 'unknown';
}

/* ────────────────────────────────────────────────────────────────────────────
 * WHAT A ROUTER WILL ACCEPT
 * ──────────────────────────────────────────────────────────────────────────── */

/** The routing profile family a mode belongs to, or `null` where no road-style router applies. */
export const TRAVEL_MODE_ROUTING_PROFILE: Record<TravelMode, 'road' | 'pedestrian' | 'bike' | 'transit' | null> = {
  walk: 'pedestrian',
  bike: 'bike',
  drive: 'road',
  taxi: 'road',
  private_transfer: 'road',
  bus: 'road',
  urban_transit: 'transit',
  rail: 'transit',
  ferry: null,
  boat: null,
  flight: null,
  shuttle: 'road',
  four_wheel_drive: 'road',
  horse: null,
  trail: null,
  cable_car_or_lift: null,
  /*
   * A guide's or a lodge's vehicle drives on roads, and a road measurement is
   * still not the journey: the operator decides when it leaves and how long it
   * takes, and V7 settled that a transfer somebody else runs is operator-timed
   * rather than road-timed. `null` keeps a router from being asked a question
   * whose answer would be presented as the operator's.
   */
  operator_transfer: null,
  unknown: null,
};

/**
 * Whether a road-style router could ever have answered this pair.
 *
 * The honest version of `reconcile.ts`'s `roadRoutable`, which enumerated draft
 * hints and therefore had to be edited every time the vocabulary grew. A `false`
 * here is a fact about the instrument, never about the journey: §11's rule that
 * five of the six causes of "not timed" are Sidequest's own gaps starts here.
 */
export function isRoadRoutable(mode: TravelMode): boolean {
  const profile = TRAVEL_MODE_ROUTING_PROFILE[mode];
  return profile === 'road' || profile === 'pedestrian' || profile === 'bike';
}

/** Modes that move over water. Used by the phantom-mode screen, never by a renderer. */
export function isWaterMode(mode: TravelMode): boolean {
  return mode === 'ferry' || mode === 'boat';
}

/** Modes that ride a fixed network somebody else owns. */
export function isNetworkMode(mode: TravelMode): boolean {
  return mode === 'rail' || mode === 'urban_transit' || mode === 'bus' || mode === 'ferry';
}

/** Modes a traveller cannot arrange for themselves on the day. */
export function isOperatorMode(mode: TravelMode): boolean {
  return mode === 'operator_transfer' || mode === 'private_transfer' || mode === 'horse' || mode === 'shuttle';
}
