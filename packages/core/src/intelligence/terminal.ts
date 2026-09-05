import { z } from 'zod';
import type { ItineraryDay } from '../schemas/itinerary';
import type { BookedPlanItem } from './booking';

/**
 * AIRPORT / STATION / PORT LOGISTICS.
 *
 * The reconciler already keeps the first and last day inside the hours the
 * traveller is actually there. This layer says *why* those hours are what they
 * are — immigration, bags, the transfer, the rental desk, check-in — with every
 * buffer labelled an estimate, and it checks the invariant a traveller cares
 * about most: nothing scheduled after the moment they have to leave for the
 * airport, nothing before they can realistically have arrived.
 */

export const EDGE_BASES = ['booked', 'stated', 'band', 'unknown'] as const;

export const terminalEdgeSchema = z.object({
  /** Minutes from midnight, destination-local, or null when nobody said. */
  terminalMinute: z.number().int().min(0).max(1440).nullable(),
  basis: z.enum(EDGE_BASES),
  bufferMinutes: z.number().int().min(0),
  bufferLabel: z.string().min(1),
  transferMinutes: z.number().int().min(0).nullable(),
  transferLabel: z.string().min(1),
  vehicleMinutes: z.number().int().min(0),
  vehicleLabel: z.string().min(1).optional(),
  /** Arrival: earliest the traveller is usable at base. Departure: latest they can leave base. */
  boundaryMinute: z.number().int().min(0).max(1440).nullable(),
  note: z.string().min(1),
});
export type TerminalEdge = z.infer<typeof terminalEdgeSchema>;

export const terminalPlanSchema = z.object({
  arrival: terminalEdgeSchema,
  departure: terminalEdgeSchema,
  arrivalRespected: z.boolean(),
  departureRespected: z.boolean(),
  violations: z.array(z.string().min(1)).default([]),
  timeZone: z.string().min(1).optional(),
});
export type TerminalPlan = z.infer<typeof terminalPlanSchema>;

export interface TerminalInput {
  international: 'yes' | 'no' | 'unknown';
  arrivalTime: string;
  departureTime: string;
  arrivalPrecision?: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown' | 'not_booked';
  departurePrecision?: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown' | 'not_booked';
  drives: boolean;
  firstDay: ItineraryDay;
  lastDay: ItineraryDay;
  booked: readonly BookedPlanItem[];
  timeZone?: string;
}

/** Estimates, named as such. Sidequest has no airport-specific data for these. */
export const TERMINAL_BUFFERS = {
  immigrationInternational: 90,
  immigrationDomestic: 45,
  immigrationUnknown: 60,
  checkInInternational: 180,
  checkInDomestic: 120,
  checkInUnknown: 150,
  transferEstimate: 45,
  rentalPickup: 30,
  rentalReturn: 30,
  stationBuffer: 30,
} as const;

export function minuteOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function bookedEdge(booked: readonly BookedPlanItem[], date: string, edge: 'arrival' | 'departure'): { minute: number; kind: 'flight' | 'train' | 'ferry' } | null {
  const candidates = booked.filter((b) => (b.type === 'flight' || b.type === 'train' || b.type === 'ferry') && b.status === 'booked' && b.date === date);
  const item = candidates.find((b) => (edge === 'arrival' ? b.endTime ?? b.startTime : b.startTime));
  if (!item) return null;
  const time = edge === 'arrival' ? (item.endTime ?? item.startTime) : item.startTime;
  return time ? { minute: minuteOf(time), kind: item.type as 'flight' | 'train' | 'ferry' } : null;
}

export function buildTerminalPlan(input: TerminalInput): TerminalPlan {
  const intl = input.international;
  const arrivalBooked = bookedEdge(input.booked, input.firstDay.date, 'arrival');
  const departureBooked = bookedEdge(input.booked, input.lastDay.date, 'departure');

  const arrivalMinute = arrivalBooked?.minute ?? (input.arrivalPrecision === 'unknown' || input.arrivalPrecision === 'not_booked' ? null : minuteOf(input.arrivalTime));
  const departureMinute = departureBooked?.minute ?? (input.departurePrecision === 'unknown' || input.departurePrecision === 'not_booked' ? null : minuteOf(input.departureTime));

  const isTrain = arrivalBooked?.kind === 'train' || arrivalBooked?.kind === 'ferry';
  const arrivalBuffer = isTrain ? 10 : intl === 'yes' ? TERMINAL_BUFFERS.immigrationInternational : intl === 'no' ? TERMINAL_BUFFERS.immigrationDomestic : TERMINAL_BUFFERS.immigrationUnknown;
  const arrivalVehicle = input.drives ? TERMINAL_BUFFERS.rentalPickup : 0;
  const arrivalTransfer = TERMINAL_BUFFERS.transferEstimate;
  const availableFrom = arrivalMinute === null ? null : Math.min(1440, arrivalMinute + arrivalBuffer + arrivalVehicle + arrivalTransfer);

  const depTrain = departureBooked?.kind === 'train' || departureBooked?.kind === 'ferry';
  const departureBuffer = depTrain ? TERMINAL_BUFFERS.stationBuffer : intl === 'yes' ? TERMINAL_BUFFERS.checkInInternational : intl === 'no' ? TERMINAL_BUFFERS.checkInDomestic : TERMINAL_BUFFERS.checkInUnknown;
  const departureVehicle = input.drives ? TERMINAL_BUFFERS.rentalReturn : 0;
  const leaveBy = departureMinute === null ? null : Math.max(0, departureMinute - departureBuffer - departureVehicle - TERMINAL_BUFFERS.transferEstimate);

  /*
   * The invariant is checked against what is *known*: a booked flight or train
   * is a fact, and anything scheduled past its leave-by time is a violation.
   * A stated or banded time was already enforced by the reconciler's hard day
   * windows, so the boundary is reported as the reconciler's own edge and the
   * buffers above are shown as the reasoning behind it, not re-litigated.
   */
  const departureBoundary = departureBooked ? leaveBy : departureMinute === null ? null : input.lastDay.window.endMinute;
  const arrivalBoundary = arrivalBooked ? availableFrom : arrivalMinute === null ? null : input.firstDay.window.startMinute;

  const arrival: TerminalEdge = {
    terminalMinute: arrivalMinute,
    basis: arrivalBooked ? 'booked' : arrivalMinute === null ? 'unknown' : input.arrivalPrecision === 'exact' || input.arrivalPrecision === undefined ? 'stated' : 'band',
    bufferMinutes: arrivalBuffer,
    bufferLabel: isTrain ? 'Off the train' : intl === 'yes' ? 'Immigration and bags (estimate)' : intl === 'no' ? 'Bags (estimate)' : 'Bags, immigration if international (estimate)',
    transferMinutes: null,
    transferLabel: `Transfer to base — not measured; ${TERMINAL_BUFFERS.transferEstimate} min assumed`,
    vehicleMinutes: arrivalVehicle,
    ...(input.drives ? { vehicleLabel: 'Rental desk and pickup (estimate)' } : {}),
    boundaryMinute: arrivalBoundary,
    note: arrivalBoundary === null ? 'No arrival time is known, so the first day is planned as a quiet evening.' : `Realistically at base and usable from ${clock(arrivalBoundary)}.`,
  };
  const departure: TerminalEdge = {
    terminalMinute: departureMinute,
    basis: departureBooked ? 'booked' : departureMinute === null ? 'unknown' : input.departurePrecision === 'exact' || input.departurePrecision === undefined ? 'stated' : 'band',
    bufferMinutes: departureBuffer,
    bufferLabel: depTrain ? 'At the station before departure' : intl === 'yes' ? 'International check-in (estimate)' : intl === 'no' ? 'Domestic check-in (estimate)' : 'Check-in (estimate)',
    transferMinutes: null,
    transferLabel: `Transfer from base — not measured; ${TERMINAL_BUFFERS.transferEstimate} min assumed`,
    vehicleMinutes: departureVehicle,
    ...(input.drives ? { vehicleLabel: 'Return the car and refuel (estimate)' } : {}),
    boundaryMinute: departureBoundary,
    note: departureBoundary === null ? 'No departure time is known, so the last day ends early by default.' : `Leave base by ${clock(departureBoundary)}.`,
  };

  const violations: string[] = [];
  const scheduled = (day: ItineraryDay) => day.items.filter((item) => item.kind === 'activity' || (item.kind === 'travel' && item.durationMinutes > 0));
  const lastReal = scheduled(input.lastDay);
  const departureRespected = departureBoundary === null || lastReal.every((item) => item.endMinute <= departureBoundary);
  if (!departureRespected) violations.push(`Day ${input.lastDay.dayNumber} still has something scheduled after the ${clock(departureBoundary!)} leave-by time.`);
  const firstReal = scheduled(input.firstDay);
  const arrivalRespected = arrivalBoundary === null || firstReal.every((item) => item.startMinute >= arrivalBoundary);
  if (!arrivalRespected) violations.push(`Day ${input.firstDay.dayNumber} schedules something before you can realistically be at base (${clock(arrivalBoundary!)}).`);

  return terminalPlanSchema.parse({ arrival, departure, arrivalRespected, departureRespected, violations, ...(input.timeZone ? { timeZone: input.timeZone } : {}) });
}

export function clock(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
