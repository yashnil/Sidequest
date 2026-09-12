import { z } from 'zod';
import type { Itinerary } from '../schemas/itinerary';
import type { TravelIntelligence } from '../intelligence/model';
import { LOCK_LEVELS, type LockLevel } from '../contract/trip-contract';

/**
 * V9 §3 — DECISIONS ARE RECORDS, NOT PROSE.
 *
 * A trip is a handful of decisions the days hang off: the route, how it
 * moves, when it happens, the operated episodes it stands on. Sidequest
 * remembers each one as an object — what was chosen, what else was on the
 * table, why this won, which traveller facts drove it, the measurable
 * tradeoffs, the lock level and the scope — so "Why this?" is answerable from
 * facts and a controlled alternative knows exactly what it would move.
 *
 * Derived from the persisted plan (route rationale, omissions, transport
 * strategy, contract, structural metrics) and overlaid with the traveller's
 * own rows (`trip_decisions`). Pure; no provider, no model.
 */
export const DECISION_KEYS = ['route', 'transport', 'timing'] as const;

export const tripDecisionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  chosen: z.string().min(1),
  alternatives: z.array(z.object({ label: z.string().min(1), why: z.string().min(1).optional() })).default([]),
  why: z.string().min(1),
  travellerFacts: z.array(z.string().min(1)).default([]),
  tradeoffs: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).default([]),
  lock: z.enum(LOCK_LEVELS),
  scope: z.object({ dayNumbers: z.array(z.number().int().min(1)).default([]), baseIds: z.array(z.string().min(1)).default([]) }),
  decidedBy: z.enum(['traveller', 'sidequest', 'model']),
  decidedAt: z.string().min(1).optional(),
});
export type TripDecision = z.infer<typeof tripDecisionSchema>;

/** A row the traveller (or an applied refinement) wrote — the only persisted part. */
export interface PersistedDecision {
  key: string;
  chosen: string;
  why?: string;
  alternativesSeen?: readonly string[];
  lock: LockLevel;
  decidedBy: 'traveller' | 'sidequest';
  decidedAt: string;
  scope?: { dayNumbers?: readonly number[]; baseIds?: readonly string[] };
}

/**
 * Controlled alternatives, each a refinement request in the traveller's own
 * words. They go through Ask Sidequest — one bounded call, a proposal, a
 * deterministic delta, Apply or Cancel — and never regenerate the trip.
 */
export const ALTERNATIVE_REQUESTS: readonly { id: string; label: string; request: string; touches: 'route' | 'transport' | 'pace' | 'budget' }[] = [
  { id: 'less_driving', label: 'Less driving', request: 'Reduce the driving: shorten or drop the single longest drive and keep the signature stops. Make the smallest change that does it.', touches: 'route' },
  { id: 'fewer_hotel_changes', label: 'Fewer hotel changes', request: 'Remove one hotel change: merge the shortest stay into a neighbouring base and keep the signature stops reachable. Make the smallest change that does it.', touches: 'route' },
  { id: 'more_adventurous', label: 'More adventurous', request: 'Make the trip more adventurous: swap the tamer stops for more active or remote experiences that fit the same days.', touches: 'pace' },
  { id: 'more_iconic', label: 'More iconic', request: 'Include more of the iconic, well-known sights, replacing lesser-known stops where a day allows.', touches: 'pace' },
  { id: 'cheaper', label: 'Cheaper', request: 'Make the trip cheaper: prefer lower-cost stays and activities and fewer paid experiences without dropping the signature stops.', touches: 'budget' },
  { id: 'slower', label: 'Slower', request: 'Slow the pace: fewer stops per day, more free time, and no day that ends late.', touches: 'pace' },
];

function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h} h${m > 0 ? ` ${m} min` : ''}` : `${m} min`;
}

export function deriveDecisions(input: {
  itinerary: Itinerary;
  intelligence: TravelIntelligence | null;
  persisted?: readonly PersistedDecision[];
  travellerFacts?: readonly string[];
}): TripDecision[] {
  const { itinerary } = input;
  const pkg = itinerary.package;
  const decisions: TripDecision[] = [];
  const metrics = pkg?.metrics ?? {};
  const persisted = new Map((input.persisted ?? []).map((row) => [row.key, row] as const));
  const facts = [...(input.travellerFacts ?? [])];

  // Route ---------------------------------------------------------------------------------
  const bases = pkg?.bases ?? [];
  if (bases.length > 0) {
    const chosen = bases.map((b) => `${b.displayName ?? b.name} (${b.nights} night${b.nights === 1 ? '' : 's'})`).join(' → ');
    const alternatives = (pkg?.omissions ?? []).slice(0, 6).map((o) => ({ label: o.name, why: o.reason }));
    const tradeoffs: TripDecision['tradeoffs'] = [];
    if (typeof metrics.hotelChurn === 'number') tradeoffs.push({ label: 'Hotel changes', value: String(metrics.hotelChurn) });
    if (typeof metrics.travelBurdenMinutesPerDay === 'number') tradeoffs.push({ label: 'Travel per day', value: minutesLabel(metrics.travelBurdenMinutesPerDay) });
    if (itinerary.transportStrategy.totals.driveKm > 0) tradeoffs.push({ label: 'Driven', value: `${Math.round(itinerary.transportStrategy.totals.driveKm)} km` });
    if (typeof metrics.unmeasuredMajorTransfers === 'number' && metrics.unmeasuredMajorTransfers > 0) tradeoffs.push({ label: 'Transfers not yet timed', value: String(metrics.unmeasuredMajorTransfers) });
    decisions.push(
      tripDecisionSchema.parse({
        key: 'route',
        title: bases.length === 1 ? 'One base for the whole trip' : `${bases.length} bases, in this order`,
        chosen,
        alternatives,
        why: pkg?.routeRationale ?? 'The route the plan was composed around.',
        travellerFacts: facts,
        tradeoffs,
        lock: 'model_proposed',
        scope: { dayNumbers: itinerary.days.map((d) => d.dayNumber), baseIds: bases.map((b) => b.id) },
        decidedBy: 'model',
      }),
    );
  }

  // Transport -----------------------------------------------------------------------------
  const strategy = itinerary.transportStrategy;
  const modeWord = (mode: string) => mode.replace(/_/g, ' ');
  const alternatives: TripDecision['alternatives'] = [];
  if (strategy.secondaryMode) alternatives.push({ label: modeWord(strategy.secondaryMode), why: strategy.withoutPrimary });
  for (const option of input.intelligence?.transport.options ?? []) {
    if (option.recommended) continue;
    const label = `${modeWord(option.mode)} for ${option.legLabel}`;
    if (!alternatives.some((a) => a.label === label)) alternatives.push({ label, why: option.why });
  }
  decisions.push(
    tripDecisionSchema.parse({
      key: 'transport',
      title: `Getting around by ${modeWord(strategy.primaryMode)}`,
      chosen: strategy.headline,
      alternatives: alternatives.slice(0, 5),
      why: strategy.rationale[0] ?? strategy.headline,
      travellerFacts: facts,
      tradeoffs: [
        { label: 'Stress', value: strategy.stress },
        { label: 'Convenience', value: strategy.convenience },
        ...(strategy.totals.driveMinutes > 0 ? [{ label: 'Driving', value: minutesLabel(strategy.totals.driveMinutes) }] : []),
        ...(strategy.totals.transitMinutes > 0 ? [{ label: 'On transit', value: minutesLabel(strategy.totals.transitMinutes) }] : []),
        ...strategy.tradeoffs.slice(0, 2).map((t) => ({ label: 'Costs you', value: t })),
      ],
      lock: 'model_proposed',
      scope: { dayNumbers: itinerary.days.map((d) => d.dayNumber), baseIds: [] },
      decidedBy: 'model',
    }),
  );

  // Timing --------------------------------------------------------------------------------
  const decidedBy = pkg?.contract?.timingDecidedBy;
  decisions.push(
    tripDecisionSchema.parse({
      key: 'timing',
      title: 'When the trip happens',
      chosen: `${itinerary.startDate} to ${itinerary.endDate}`,
      alternatives: [],
      why: pkg?.timingRationale ?? (decidedBy === 'traveller' ? 'You chose these dates.' : decidedBy === 'sidequest' ? 'Sidequest chose the window from climate and crowds and you accepted it.' : 'The dates the plan was built for.'),
      travellerFacts: facts,
      tradeoffs: [],
      lock: decidedBy === 'traveller' ? 'user_explicit' : decidedBy === 'sidequest' ? 'sidequest_inferred' : 'model_proposed',
      scope: { dayNumbers: itinerary.days.map((d) => d.dayNumber), baseIds: [] },
      decidedBy: decidedBy === 'traveller' ? 'traveller' : decidedBy === 'sidequest' ? 'sidequest' : 'model',
    }),
  );

  // Episodes -----------------------------------------------------------------------------
  for (const episode of pkg?.episodes ?? []) {
    decisions.push(
      tripDecisionSchema.parse({
        key: `episode:${episode.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title: episode.name,
        chosen: `${episode.kind.replace(/_/g, ' ')} over days ${episode.dayNumbers[0]}–${episode.dayNumbers[episode.dayNumbers.length - 1]}`,
        alternatives: [],
        why: episode.timing === 'operator' ? 'An operated experience with its own timetable; the days inside it are the operator’s.' : 'Part of the route as composed.',
        travellerFacts: facts,
        tradeoffs: [],
        lock: 'model_proposed',
        scope: { dayNumbers: [...episode.dayNumbers], baseIds: [] },
        decidedBy: 'model',
      }),
    );
  }

  // The traveller's own rows overlay what was derived, and add what only they could say. ----
  const overlaid = decisions.map((decision) => {
    const row = persisted.get(decision.key);
    if (!row) return decision;
    return tripDecisionSchema.parse({
      ...decision,
      chosen: row.chosen,
      ...(row.why ? { why: row.why } : {}),
      lock: row.lock,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      ...(row.scope ? { scope: { dayNumbers: [...(row.scope.dayNumbers ?? decision.scope.dayNumbers)], baseIds: [...(row.scope.baseIds ?? decision.scope.baseIds)] } } : {}),
    });
  });
  for (const row of input.persisted ?? []) {
    if (overlaid.some((d) => d.key === row.key)) continue;
    overlaid.push(
      tripDecisionSchema.parse({
        key: row.key,
        title: row.key.startsWith('refinement:') ? 'A change you asked for' : row.key,
        chosen: row.chosen,
        alternatives: (row.alternativesSeen ?? []).map((label) => ({ label })),
        why: row.why ?? 'Decided by you.',
        travellerFacts: [],
        tradeoffs: [],
        lock: row.lock,
        scope: { dayNumbers: [...(row.scope?.dayNumbers ?? [])], baseIds: [...(row.scope?.baseIds ?? [])] },
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt,
      }),
    );
  }
  return overlaid;
}
