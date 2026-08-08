import { z } from 'zod';
import { PACKET_GAP_KINDS } from './packet-types';
import type { PacketInputs } from './packet';

/**
 * THE STORED WORLD, PARSED RATHER THAN CAST.
 *
 * The world both arms plan against is bought during the question round, written
 * to the store, and read back in a *later server invocation* once the traveller
 * has answered. That gap is the whole reason this file exists: everywhere else
 * in this arm the packet inputs are a value that never leaves the process, and
 * here they cross a boundary and come back as text.
 *
 * A cast would type-check and be wrong the first time a build changes the shape
 * of a field — a run reading a world written by yesterday's schema would plan
 * against half-`undefined` places and the failure would surface somewhere deep
 * in the packet builder, looking like a defect in the planner. Parsing turns
 * that into a refusal at the door, which the harness already handles: no stored
 * world means the run gathers one.
 *
 * Numbers are bounded rather than left as `z.number()`, for the same reason the
 * measurement schema bounds its own: Zod rejects `NaN` and accepts `Infinity`,
 * `JSON.stringify(Infinity)` is `null`, and a coordinate that arrives as null
 * puts a place at the intersection of the equator and the prime meridian.
 */

const finite = (min: number, max: number) =>
  z.number().min(min).max(max).refine(Number.isFinite, 'Not a finite number');

const latitude = finite(-90, 90);
const longitude = finite(-180, 180);
const minuteOfDay = z.number().int().min(-1_440).max(2_880);

const sourceSchema = z.object({
  host: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  retrievedAt: z.string().nullable(),
});

const hoursSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('always_open') }),
  z.object({
    state: z.literal('known'),
    windows: z.array(
      z.object({ date: z.string(), openMinute: minuteOfDay, closeMinute: minuteOfDay }),
    ),
    closedDates: z.array(z.string()),
    sourceIndex: z.number().int().nullable(),
  }),
]);

const seasonalSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('open_in_season') }),
  z.object({ state: z.literal('closed_in_season'), note: z.string() }),
]);

const accessSchema = z.object({
  requiresCar: z.boolean().nullable(),
  unpavedApproach: z.boolean().nullable(),
  remoteNoServices: z.boolean().nullable(),
  strenuous: z.boolean().nullable(),
  wheelchair: z.enum(['yes', 'limited', 'no', 'unknown']),
  feeStated: z.boolean().nullable(),
});

const foodSchema = z.object({
  servesSlots: z.array(z.enum(['breakfast', 'lunch', 'dinner', 'snack'])),
  dietaryTags: z.array(z.string()),
  cuisine: z.string().nullable(),
  cannotAccommodate: z.array(z.string()),
});

const daylightSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('known'), sunriseMinute: minuteOfDay, sunsetMinute: minuteOfDay }),
  z.object({ state: z.literal('polar_day') }),
  z.object({ state: z.literal('polar_night') }),
]);

const weatherSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({
    state: z.enum(['forecast', 'climate']),
    summary: z.string(),
    highCelsius: finite(-100, 100).nullable(),
    lowCelsius: finite(-100, 100).nullable(),
    precipitationChance: finite(0, 100).nullable(),
    sourceIndex: z.number().int().nullable(),
  }),
]);

export const packetInputsSchema = z.object({
  destination: z.object({
    entityId: z.string(),
    displayName: z.string(),
    countryCode: z.string().nullable(),
    latitude,
    longitude,
    radiusKm: finite(0, 40_000).nullable(),
    scale: z.enum(['local', 'city', 'subregion', 'region', 'country', 'multi_country', 'unknown']),
  }),
  days: z.array(
    z.object({
      dayNumber: z.number().int(),
      date: z.string(),
      daylight: daylightSchema,
      weather: weatherSchema,
      weatherSource: sourceSchema.nullable(),
    }),
  ),
  places: z.array(
    z.object({
      entityId: z.string(),
      name: z.string(),
      latitude,
      longitude,
      kind: z.string(),
      tags: z.array(z.string()),
      typicalDurationMinutes: finite(0, 100_000).nullable(),
      daylightOnly: z.boolean().nullable(),
      hours: hoursSchema,
      seasonal: seasonalSchema,
      access: accessSchema,
      food: foodSchema.nullable(),
      source: sourceSchema.nullable(),
    }),
  ),
  baseCandidates: z.array(
    z.object({
      entityId: z.string().nullable(),
      name: z.string(),
      latitude,
      longitude,
      basis: z.string(),
    }),
  ),
  routeLegs: z.array(
    z.object({
      fromEntityId: z.string(),
      toEntityId: z.string(),
      minutes: finite(0, 100_000),
      km: finite(0, 100_000),
      mode: z.enum(['drive', 'walk', 'transit']),
    }),
  ),
  gaps: z.array(
    z.object({
      kind: z.enum(PACKET_GAP_KINDS),
      subject: z.string(),
      detail: z.string(),
    }),
  ),
  unknowns: z.array(z.string()),
});

/** The stored world, or `null` when it cannot be read back as one. */
export function readStoredWorld(payload: unknown): PacketInputs | null {
  const parsed = packetInputsSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
