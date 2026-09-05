import { z } from 'zod';
import { bookingItemSchema, bookedPlanItemSchema } from './booking';
import { budgetIntelligenceSchema } from './budget';
import { checklistIntelligenceSchema } from './checklist';
import { sourceClaimSchema } from './claims';
import { planCritiqueSchema } from './critique';
import { foodIntelligenceSchema } from './food';
import { lodgingIntelligenceSchema } from './lodging';
import { packingIntelligenceSchema } from './packing';
import { tripReadinessPacketSchema } from './readiness';
import { dayResilienceSchema, regretIntelligenceSchema } from './resilience';
import { safetyIntelligenceSchema } from './safety';
import { terminalPlanSchema } from './terminal';
import { transportLegSchema, transportOptionSchema } from './transport';
import { accessStateSchemaFull, weatherIntelligenceSchema } from './weather-access';

/**
 * TRAVEL INTELLIGENCE: ONE OBJECT, EVERY ANSWER.
 *
 * The persisted result of `buildTravelIntelligence`. Facts are not scattered
 * across unrelated objects: each subsystem has a slot, and every material
 * claim any slot makes is also registered in `sourceRegistry` so the Verify
 * section and the recheck list read one place.
 */
export const TRAVEL_INTELLIGENCE_VERSION = 1 as const;

export const travelIntelligenceSchema = z.object({
  version: z.literal(TRAVEL_INTELLIGENCE_VERSION),
  tripId: z.string().min(1),
  builtAt: z.string().datetime(),
  /** The fingerprint of the itinerary this was built from; a mismatch means rebuild. */
  itineraryFingerprint: z.string().min(1),
  destinationContext: z.object({
    name: z.string().min(1),
    countryCode: z.string().optional(),
    international: z.enum(['yes', 'no', 'unknown']),
    timeZone: z.string().min(1).optional(),
    tripDays: z.number().int().min(1),
    daysUntilTrip: z.number().int(),
    remote: z.boolean(),
    drives: z.boolean(),
  }),
  verification: z.object({
    anchors: z.number().int().min(0),
    verified: z.number().int().min(0),
    partiallyVerified: z.number().int().min(0),
    unverified: z.number().int().min(0),
    legsMeasured: z.number().int().min(0),
    legsUnmeasured: z.number().int().min(0),
    deadlineReached: z.boolean(),
  }),
  transport: z.object({
    primaryMode: z.string().min(1),
    legs: z.array(transportLegSchema),
    terminal: terminalPlanSchema,
    options: z.array(transportOptionSchema).default([]),
    modeNote: z.string().min(1),
  }),
  lodging: lodgingIntelligenceSchema,
  food: foodIntelligenceSchema,
  bookings: z.object({
    items: z.array(bookingItemSchema),
    booked: z.array(bookedPlanItemSchema),
    honored: z.array(z.string().min(1)).default([]),
    conflicts: z.array(z.string().min(1)).default([]),
  }),
  budget: budgetIntelligenceSchema,
  weather: weatherIntelligenceSchema,
  access: z.array(accessStateSchemaFull),
  readiness: tripReadinessPacketSchema,
  safety: safetyIntelligenceSchema,
  packing: packingIntelligenceSchema,
  backups: z.array(dayResilienceSchema),
  regret: regretIntelligenceSchema,
  checklist: checklistIntelligenceSchema,
  critique: planCritiqueSchema.optional(),
  sourceRegistry: z.array(sourceClaimSchema),
  unresolvedCriticals: z.array(z.string().min(1)).default([]),
  freshness: z.object({
    recheckBeforeDeparture: z.array(z.string().min(1)),
    note: z.string().min(1),
  }),
});
export type TravelIntelligence = z.infer<typeof travelIntelligenceSchema>;

/** Internal counts for tests and dev diagnostics. Never rendered to the traveller. */
export interface IntelligenceDiagnostics {
  composition: { anchors: number; substantiveDays: number; emptyDays: number };
  evidence: { claims: number; confirmed: number; unverified: number; contradicted: number; stale: number; needsInput: number; notApplicable: number };
  transport: { measured: number; scheduled: number; estimated: number; unmeasured: number; trafficLive: number };
  readiness: { blocking: number; mustVerify: number; bookFirst: number };
  bookings: { honored: number; conflicts: number };
  final: { verifiedAnchors: number; silentLoss: number; intentionalRest: number };
}

export function intelligenceDiagnostics(intel: TravelIntelligence, itineraryDays: readonly { items: readonly { kind: string }[] }[]): IntelligenceDiagnostics {
  const byState = (state: string) => intel.sourceRegistry.filter((c) => c.state === state).length;
  const byBasis = (basis: string) => intel.transport.legs.filter((l) => l.durationBasis === basis).length;
  const emptyDays = itineraryDays.filter((d) => d.items.every((i) => i.kind === 'free_time')).length;
  return {
    composition: { anchors: intel.verification.anchors, substantiveDays: itineraryDays.length - emptyDays, emptyDays },
    evidence: { claims: intel.sourceRegistry.length, confirmed: byState('confirmed'), unverified: byState('unverified'), contradicted: byState('contradicted'), stale: byState('stale'), needsInput: byState('needs_input'), notApplicable: byState('not_applicable') },
    transport: { measured: byBasis('measured_static') + byBasis('traffic_aware'), scheduled: byBasis('scheduled_transit'), estimated: byBasis('estimated'), unmeasured: byBasis('unmeasured'), trafficLive: intel.transport.legs.filter((l) => l.trafficState === 'live').length },
    readiness: { blocking: intel.readiness.blockingCount, mustVerify: intel.regret.verifyBeforeLeaving.length, bookFirst: intel.bookings.items.filter((b) => b.priority === 'book_first' && b.status === 'open').length },
    bookings: { honored: intel.bookings.honored.length, conflicts: intel.bookings.conflicts.length },
    final: { verifiedAnchors: intel.verification.verified, silentLoss: 0, intentionalRest: emptyDays },
  };
}
