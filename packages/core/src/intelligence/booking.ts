import { z } from 'zod';
import { isKnownTimeZone } from '../time/zone';

/**
 * BOOKING INTELLIGENCE AND BOOKED REALITY.
 *
 * Two shapes, deliberately separate. A `BookingItem` is something the trip
 * *depends on* that somebody has to arrange — with a priority that comes from
 * dependency, importance, fixed timing, lead time, alternatives and the
 * consequence of missing it. A `BookedPlanItem` is something the traveller
 * *has* arranged — a fact stronger than any model preference, which the planner
 * must never move.
 */
export const BOOKING_ITEM_KINDS = [
  'accommodation',
  'flight',
  'train',
  'ferry',
  'park_entry',
  'timed_entry',
  'permit',
  'tour_guide',
  'restaurant',
  'event',
  'rental_vehicle',
  'shuttle',
  'internal_transfer',
  /** V7 §14 — a multi-day operated experience booked as one thing: a cruise, a trek with an operator, a safari programme. */
  'cruise',
  'programme',
] as const;
export const bookingItemKindSchema = z.enum(BOOKING_ITEM_KINDS);
export type BookingItemKind = z.infer<typeof bookingItemKindSchema>;

export const BOOKING_ITEM_KIND_LABELS: Record<BookingItemKind, string> = {
  accommodation: 'Somewhere to sleep',
  flight: 'Flight',
  train: 'Train',
  ferry: 'Ferry',
  park_entry: 'Park entry',
  timed_entry: 'Timed entry',
  permit: 'Permit',
  tour_guide: 'Tour or guide',
  restaurant: 'Restaurant',
  event: 'Event',
  rental_vehicle: 'Rental vehicle',
  shuttle: 'Shuttle',
  internal_transfer: 'Transfer',
  cruise: 'Cruise',
  programme: 'Multi-day programme',
};

export const BOOKING_NECESSITIES = ['required', 'strongly_recommended', 'optional', 'unknown'] as const;
export const bookingNecessitySchema = z.enum(BOOKING_NECESSITIES);
export type BookingNecessity = z.infer<typeof bookingNecessitySchema>;

export const BOOKING_PRIORITIES = ['book_first', 'book_soon', 'can_wait', 'keep_flexible'] as const;
export const bookingPrioritySchema = z.enum(BOOKING_PRIORITIES);
export type BookingPriority = z.infer<typeof bookingPrioritySchema>;

export const BOOKING_PRIORITY_COPY: Record<BookingPriority, { title: string; blurb: string }> = {
  book_first: { title: 'Book first', blurb: 'The trip depends on these and they have fixed dates, limited capacity or long lead times.' },
  book_soon: { title: 'Book soon', blurb: 'Not urgent, but the good options go.' },
  can_wait: { title: 'Can wait', blurb: 'Bookable close to the day, or from the destination.' },
  keep_flexible: { title: 'Keep flexible', blurb: 'Weather, energy or crowds decide these. Do not lock them in early.' },
};

export const bookingItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: bookingItemKindSchema,
  /**
   * PRODUCT RECOVERY V1 — stays are one planning dependency, not seven blocking
   * rows. Each per-base item carries `group: 'stays'`; one summary item
   * (`id: booking:stays`, `memberIds` = the base items) carries the Book-first
   * priority and answers "what could break this trip if I don't arrange it".
   */
  group: z.enum(['stays']).optional(),
  memberIds: z.array(z.string().min(1)).optional(),
  /** Set when the requirement itself is unconfirmed ("if timed tickets apply"): a thing to verify, not yet a thing to book. */
  verifyRequirement: z.boolean().optional(),
  necessity: bookingNecessitySchema,
  priority: bookingPrioritySchema,
  reason: z.string().min(1),
  /** The day this is for, when it is for a day. */
  dayNumber: z.number().int().min(1).optional(),
  date: z.string().optional(),
  timeLabel: z.string().min(1).optional(),
  placeId: z.string().min(1).optional(),
  baseId: z.string().min(1).optional(),
  officialSourceName: z.string().min(1).optional(),
  officialSourceUrl: z.string().url().optional(),
  bookingWindow: z.string().min(1).optional(),
  onSaleDate: z.string().optional(),
  deadline: z.string().optional(),
  cancellation: z.string().min(1).optional(),
  /** Only set from evidence. Absent means Sidequest has no evidence about capacity, not that there is plenty. */
  capacityEvidence: z.enum(['limited', 'unknown']).default('unknown'),
  status: z.enum(['open', 'booked', 'soft_hold', 'not_needed']).default('open'),
  bookedItemId: z.string().min(1).optional(),
  travelerAction: z.string().min(1),
  /**
   * MVP V3, Stage 48 — WHAT HAPPENS IF THIS IS GONE.
   *
   * The fourth question a booking list has to answer, after what, why and
   * when. It is derived from what the plan already holds — a backup for that
   * day, an alternative venue the food section carries, a leg the router could
   * not measure — and is absent when the plan holds nothing. Absent means
   * "Sidequest has no fallback for this", never "there isn't one": inventing a
   * plausible-sounding alternative for a sold-out permit is exactly the kind of
   * confident guess the rest of this product refuses.
   */
  ifUnavailable: z.string().min(1).optional(),
  authority: z.enum(['official_current', 'authoritative_structured', 'open_structured', 'trusted_reference', 'model_proposal']),
});
export type BookingItem = z.infer<typeof bookingItemSchema>;

export const BOOKED_ITEM_TYPES = ['flight', 'lodging', 'train', 'ferry', 'rental_car', 'transfer', 'activity', 'restaurant', 'event', 'custom'] as const;
export const bookedItemTypeSchema = z.enum(BOOKED_ITEM_TYPES);
export type BookedItemType = z.infer<typeof bookedItemTypeSchema>;

export const BOOKED_ITEM_TYPE_LABELS: Record<BookedItemType, string> = {
  flight: 'Flight',
  lodging: 'Hotel or lodging',
  train: 'Train',
  ferry: 'Ferry',
  rental_car: 'Rental car',
  transfer: 'Transfer',
  activity: 'Activity or ticket',
  restaurant: 'Restaurant',
  event: 'Event',
  custom: 'Something else',
};

export const BOOKED_STATUSES = ['booked', 'soft_hold', 'idea'] as const;
export const bookedStatusSchema = z.enum(BOOKED_STATUSES);
export type BookedStatus = z.infer<typeof bookedStatusSchema>;

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const bookedPlanItemSchema = z.object({
  id: z.string().min(1),
  tripId: z.string().min(1),
  type: bookedItemTypeSchema,
  title: z.string().min(1).max(160),
  /** The date this happens, or for lodging the check-in date. */
  date: dateSchema.optional(),
  /** For lodging, the check-out date. */
  endDate: dateSchema.optional(),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  timeZone: z.string().min(1).optional(),
  location: z.string().max(160).optional(),
  placeId: z.string().min(1).optional(),
  baseId: z.string().min(1).optional(),
  /** Optional, never logged, never rendered in exports beyond the traveller's own hub. */
  confirmationRef: z.string().max(80).optional(),
  url: z.string().url().optional(),
  notes: z.string().max(500).optional(),
  cancellationDeadline: dateSchema.optional(),
  cost: z.object({ amount: z.number().min(0), currency: z.string().min(1).max(8) }).optional(),
  status: bookedStatusSchema.default('booked'),
  locked: z.boolean().default(true),
  /** V6 §26 — who it was arranged with ("ANA", "Booking.com", "the lodge directly"). */
  provider: z.string().max(80).optional(),
  /** V6 §26 — which party members it covers; empty means everyone. */
  travelerIds: z.array(z.string().min(1)).max(12).optional(),
  /**
   * V9 §5 — A BOOKING IS AN OBJECT THAT KNOWS WHAT IT SATISFIES.
   *
   * `bookingItemId` links the fact to the need it answers (a `BookingItem`
   * id), so "Mark booked" on a need settles that need and nothing else has to
   * guess by title. `paid` and `refundable` are only ever what the traveller
   * said; absent means unknown, never "unpaid" or "refundable". `source`
   * records how the fact arrived; `replaces` names the suggestion it displaced.
   */
  bookingItemId: z.string().min(1).optional(),
  paid: z.enum(['paid', 'deposit', 'unpaid']).optional(),
  refundable: z.enum(['refundable', 'non_refundable', 'unknown']).optional(),
  source: z.enum(['typed', 'marked', 'imported']).optional(),
  replaces: z.string().max(160).optional(),
  createdAt: z.string().datetime(),
});
export type BookedPlanItem = z.infer<typeof bookedPlanItemSchema>;

/**
 * RELEASE PASS — WHAT MAY BE *WRITTEN* IS NARROWER THAN WHAT MAY BE *READ*.
 *
 * `bookedPlanItemSchema` above reads stored rows, and a row that fails it is
 * dropped from the list — so it stays as loose as it ever was: tightening it
 * would silently delete bookings travellers already have. The input is where
 * the limits belong, and it had almost none. A date was any ten characters of
 * the right shape (`9999-99-99`), and the calendar sized a loop from it. A zone
 * was any non-empty string, and one the runtime does not know failed every
 * calendar built for the trip. Ids had no length. A link could carry any
 * scheme.
 *
 * - A date is a real calendar date in 2000–2100, the range trip dates take.
 * - A zone the runtime does not recognise is **dropped, not refused**: the
 *   traveller (or a model reading their confirmation e-mail) wrote "Pacific time", and
 *   the honest reading of that is "no zone recorded", which falls back to the
 *   zone of the day. Refusing the whole booking over it would be worse.
 * - A link is http(s) with no embedded credentials (`httpUrlSchema`'s rule).
 */
const realDateSchema = dateSchema.refine((value) => {
  const at = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 2100;
}, 'Not a real date between 2000 and 2100');
const clockTimeSchema = timeSchema.refine((value) => Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59, 'Not a real 24-hour time');
const referenceIdSchema = z.string().min(1).max(200);
const knownZoneSchema = z
  .string()
  .transform((value) => (isKnownTimeZone(value) ? value : undefined))
  .optional();
const webLinkSchema = z
  .string()
  .max(2000)
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === '';
    } catch {
      return false;
    }
  }, 'Only http(s) links are allowed');

/** What a traveller types to add a booking; the server fills id, tripId and createdAt. */
export const bookedPlanItemInputSchema = bookedPlanItemSchema.omit({ id: true, tripId: true, createdAt: true }).extend({
  date: realDateSchema.optional(),
  endDate: realDateSchema.optional(),
  cancellationDeadline: realDateSchema.optional(),
  startTime: clockTimeSchema.optional(),
  endTime: clockTimeSchema.optional(),
  timeZone: knownZoneSchema,
  placeId: referenceIdSchema.optional(),
  baseId: referenceIdSchema.optional(),
  bookingItemId: referenceIdSchema.optional(),
  travelerIds: z.array(z.string().min(1).max(80)).max(12).optional(),
  url: webLinkSchema.optional(),
});
export type BookedPlanItemInput = z.infer<typeof bookedPlanItemInputSchema>;

/**
 * RELEASE PASS — A PATCH CHANGES WHAT IT NAMES AND NOTHING ELSE.
 *
 * The edit door parsed a patch with `bookedPlanItemInputSchema.partial()`, and
 * `.partial()` keeps a field's `.default()`: a patch of `{ cost }` came back as
 * `{ cost, status: 'booked', locked: true }`. Setting a price on something a
 * traveller had saved as an *idea* silently made it a locked, booked fact — one
 * the planner will not move and the calendar exports as CONFIRMED. Here the two
 * defaulted fields are plainly optional, so an absent field is an absent field.
 */
export const bookedPlanItemPatchSchema = bookedPlanItemInputSchema
  .extend({ status: bookedStatusSchema.optional(), locked: z.boolean().optional() })
  .partial();
export type BookedPlanItemPatch = z.infer<typeof bookedPlanItemPatchSchema>;

/** A booked fact is stronger than a model preference; a soft hold is a plan; an idea is a note. */
export function bookedItemBinds(item: Pick<BookedPlanItem, 'status' | 'locked'>): boolean {
  return item.status === 'booked' && item.locked;
}

/**
 * PRIORITY WITHOUT FAKE URGENCY.
 *
 * Reads the facts the caller has, and nothing it does not have. Capacity is
 * never assumed limited; a fixed time on a required thing is what makes it
 * first, and weather-sensitivity is what keeps it flexible.
 */
export function bookingPriorityFor(input: {
  necessity: BookingNecessity;
  hardDependency: boolean;
  fixedDateTime: boolean;
  limitedCapacity: boolean;
  fewAlternatives: boolean;
  longLeadTime: boolean;
  weatherSensitive: boolean;
  importance: 'core' | 'secondary' | 'optional' | 'flex';
}): BookingPriority {
  if (input.weatherSensitive && !input.fixedDateTime && input.necessity !== 'required') return 'keep_flexible';
  if (input.necessity === 'required' && (input.hardDependency || input.fixedDateTime || input.limitedCapacity || input.longLeadTime)) return 'book_first';
  if (input.necessity === 'required') return 'book_soon';
  if (input.necessity === 'strongly_recommended' && (input.importance === 'core' || input.fewAlternatives || input.limitedCapacity)) return 'book_soon';
  if (input.necessity === 'strongly_recommended') return 'can_wait';
  return input.weatherSensitive ? 'keep_flexible' : 'can_wait';
}
