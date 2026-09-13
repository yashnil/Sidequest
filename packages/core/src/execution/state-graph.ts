import { z } from 'zod';
import type { Itinerary } from '../schemas/itinerary';
import type { TravelIntelligence } from '../intelligence/model';
import type { BookedPlanItem, BookingItem } from '../intelligence/booking';
import type { BookingResolution } from '../intelligence/booking-derive';
import type { RecheckManifest } from '../intelligence/recheck';
import type { FactObservation } from './freshness';
import type { TripDecision } from './decisions';
import { isTravellerDecided } from '../contract/trip-contract';

/**
 * V9 §1 — THE TRIP STATE GRAPH.
 *
 * The canonical representation of what Sidequest suggested, what the
 * traveller accepted, what is still undecided, what needs a booking, what is
 * booked, what needs verifying, what is verified, what changed, what is
 * blocked and what is optional — one vocabulary for every V9 surface.
 *
 * Not another model graph. Deterministic and derived on every load from the
 * applied itinerary, the intelligence snapshot, the booked facts and the
 * traveller's own recorded acts; nothing about it is stored. Unknown ≠ false
 * throughout: missing evidence yields `needs_verification`, never
 * `unavailable`; only affirmative evidence marks something unavailable.
 */
export const TRIP_NODE_STATES = ['suggested', 'accepted', 'needs_decision', 'needs_booking', 'booked', 'needs_verification', 'verified', 'changed', 'unavailable', 'cancelled', 'optional'] as const;
export const tripNodeStateSchema = z.enum(TRIP_NODE_STATES);
export type TripNodeState = z.infer<typeof tripNodeStateSchema>;

export const TRIP_NODE_KINDS = ['trip', 'timing', 'route', 'transport', 'base', 'day', 'experience', 'booking', 'dependency', 'preparation'] as const;
export const tripNodeKindSchema = z.enum(TRIP_NODE_KINDS);
export type TripNodeKind = z.infer<typeof tripNodeKindSchema>;

/** Traveller words for each state. Colour is always redundant with the word. */
export const TRIP_NODE_STATE_COPY: Record<TripNodeState, { label: string; tone: 'neutral' | 'pine' | 'amber' | 'blue' | 'clay' }> = {
  suggested: { label: 'Suggested', tone: 'neutral' },
  accepted: { label: 'Decided', tone: 'pine' },
  needs_decision: { label: 'We still need this', tone: 'clay' },
  needs_booking: { label: 'Needs booking', tone: 'amber' },
  booked: { label: 'Booked', tone: 'pine' },
  needs_verification: { label: 'Check before relying', tone: 'amber' },
  verified: { label: 'Confirmed from source', tone: 'pine' },
  changed: { label: 'Changed since planned', tone: 'clay' },
  unavailable: { label: 'Not available', tone: 'clay' },
  cancelled: { label: 'Skipped', tone: 'neutral' },
  optional: { label: 'Optional', tone: 'neutral' },
};

export const tripStateNodeSchema = z.object({
  id: z.string().min(1),
  kind: tripNodeKindSchema,
  label: z.string().min(1),
  state: tripNodeStateSchema,
  source: z.enum(['traveller', 'booking', 'sidequest', 'model', 'provider']),
  /**
   * V11 §39 — whose move it is. `traveller` is a real preference or choice;
   * `sidequest` is our own unfinished work, which surfaces as the trip's
   * confidence and never as something to do. Defaults to `traveller`, so a node
   * has to opt in to being ours.
   */
  owner: z.enum(['traveller', 'sidequest']).optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  impact: z.enum(['trip', 'days', 'day', 'item']),
  scope: z.object({ dayNumbers: z.array(z.number().int().min(1)).default([]), baseIds: z.array(z.string().min(1)).default([]) }),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** A real date (YYYY-MM-DD) something is due by, when one exists. Never invented. */
  due: z.string().optional(),
  recheckAt: z.string().optional(),
  fallback: z.string().optional(),
  detail: z.string().optional(),
  /** A hub anchor (`#book-first`, `#day-3`) so every surface can send the traveller to the thing. */
  href: z.string().min(1),
  /** Only for booking nodes: the underlying need or fact. */
  bookingItemId: z.string().optional(),
  bookedItemId: z.string().optional(),
  necessity: z.enum(['required', 'strongly_recommended', 'optional', 'unknown']).optional(),
  scarce: z.boolean().optional(),
});
export type TripStateNode = z.infer<typeof tripStateNodeSchema>;

export interface TripStateGraph {
  version: 1;
  nodes: TripStateNode[];
  counts: Record<TripNodeState, number>;
  /** How many nodes depend on each node id, for ranking. */
  dependents: Record<string, number>;
  summary: string;
}

export interface StateGraphInput {
  itinerary: Itinerary;
  intelligence: TravelIntelligence | null;
  booked: readonly BookedPlanItem[];
  decisions?: readonly TripDecision[];
  resolutions?: readonly BookingResolution[];
  observations?: readonly FactObservation[];
  recheck?: RecheckManifest | null;
  now: Date;
}

const NODE_HREF = {
  bookings: '#book-first',
  days: (n: number) => `#day-${n}`,
  prepare: '#before-you-go',
  route: '#overview',
  transport: '#getting-around',
  stays: '#stays',
} as const;

export function buildTripStateGraph(input: StateGraphInput): TripStateGraph {
  const { itinerary, intelligence } = input;
  const pkg = itinerary.package;
  const nodes: TripStateNode[] = [];
  const push = (node: Omit<TripStateNode, 'scope' | 'dependsOn'> & { scope?: Partial<TripStateNode['scope']>; dependsOn?: string[] }) => {
    nodes.push(tripStateNodeSchema.parse({ ...node, scope: { dayNumbers: node.scope?.dayNumbers ?? [], baseIds: node.scope?.baseIds ?? [] }, dependsOn: node.dependsOn ?? [] }));
  };
  const allDays = itinerary.days.map((d) => d.dayNumber);
  const decisionsByKey = new Map((input.decisions ?? []).map((d) => [d.key, d] as const));
  const observations = (input.observations ?? []).filter((o) => o.changed && !o.acknowledgedAt);
  const changedDays = new Set(observations.flatMap((o) => o.dayNumbers));
  const feasibility = pkg?.feasibility?.items ?? [];
  const bookingItems: readonly BookingItem[] = intelligence?.bookings.items ?? [];
  const resolutions = new Map((input.resolutions ?? []).map((r) => [r.bookingItemId, r] as const));

  // --- trip, timing, route, transport -------------------------------------------------------------------
  push({ id: 'trip', kind: 'trip', label: itinerary.baseName, state: 'accepted', source: 'traveller', confidence: 'high', impact: 'trip', href: NODE_HREF.route, scope: { dayNumbers: allDays } });

  const timing = decisionsByKey.get('timing');
  push({
    id: 'timing',
    kind: 'timing',
    label: `${itinerary.startDate} to ${itinerary.endDate}`,
    state: timing && (isTravellerDecided(timing.lock) || timing.decidedBy !== 'model') ? 'accepted' : 'suggested',
    source: timing?.decidedBy === 'traveller' ? 'traveller' : timing?.decidedBy === 'sidequest' ? 'sidequest' : 'model',
    confidence: 'high',
    impact: 'trip',
    href: NODE_HREF.route,
    dependsOn: ['trip'],
    scope: { dayNumbers: allDays },
  });

  /* §39 — a route the traveller has to decide about, not one Sidequest has yet to finish placing. */
  const routeDependency = feasibility.find((f) => f.area === 'bases' && f.severity !== 'caution' && f.owner !== 'sidequest');
  const route = decisionsByKey.get('route');
  push({
    id: 'route',
    kind: 'route',
    label: (pkg?.bases ?? []).map((b) => b.displayName ?? b.name).join(' → ') || itinerary.baseName,
    state: routeDependency ? 'needs_decision' : route && route.decidedBy !== 'model' ? 'accepted' : 'suggested',
    source: route && route.decidedBy === 'traveller' ? 'traveller' : 'model',
    confidence: routeDependency ? 'low' : 'medium',
    impact: 'trip',
    href: NODE_HREF.route,
    dependsOn: ['timing'],
    scope: { dayNumbers: allDays, baseIds: (pkg?.bases ?? []).map((b) => b.id) },
    ...(routeDependency ? { detail: routeDependency.detail } : {}),
  });

  const gateway = itinerary.issues.find((i) => i.code === 'gateway_unresolved');
  const transportDependency = feasibility.find((f) => f.area === 'transport' && f.severity === 'dependency' && !f.dayNumber && f.owner !== 'sidequest');
  const transport = decisionsByKey.get('transport');
  push({
    id: 'transport',
    kind: 'transport',
    label: itinerary.transportStrategy.headline,
    state: gateway || transportDependency ? 'needs_decision' : transport && transport.decidedBy !== 'model' ? 'accepted' : 'suggested',
    source: transport && transport.decidedBy === 'traveller' ? 'traveller' : 'model',
    confidence: gateway || transportDependency ? 'low' : 'medium',
    impact: 'trip',
    href: NODE_HREF.transport,
    dependsOn: ['route'],
    scope: { dayNumbers: allDays },
    ...(gateway ? { detail: gateway.message } : transportDependency ? { detail: transportDependency.detail } : {}),
  });

  // --- bases -----------------------------------------------------------------------------------------------
  const bookedLodging = input.booked.filter((b) => b.type === 'lodging' && b.status !== 'idea');
  for (const base of pkg?.bases ?? []) {
    if (base.baseKind === 'vessel' || base.baseKind === 'trail_camp') continue;
    const need = bookingItems.find((b) => b.kind === 'accommodation' && b.baseId === base.id);
    const dayNumbers = itinerary.days.filter((d) => d.baseId === base.id).map((d) => d.dayNumber);
    const fact = need?.bookedItemId ? input.booked.find((b) => b.id === need.bookedItemId) : bookedLodging.find((b) => b.baseId === base.id);
    const resolution = need ? resolutions.get(need.id) : undefined;
    const state: TripNodeState = fact && fact.status === 'booked' ? 'booked' : resolution ? 'cancelled' : need && need.status === 'open' ? 'needs_booking' : need?.status === 'soft_hold' ? 'needs_booking' : base.nights === 0 ? 'optional' : 'suggested';
    push({
      id: `base:${base.id}`,
      kind: 'base',
      label: `${base.nights} night${base.nights === 1 ? '' : 's'} in ${base.displayName ?? base.name}`,
      state,
      source: fact ? 'booking' : 'model',
      confidence: fact ? 'high' : base.verification === 'verified' ? 'medium' : 'low',
      impact: 'days',
      href: NODE_HREF.stays,
      dependsOn: ['route'],
      scope: { dayNumbers, baseIds: [base.id] },
      ...(need ? { bookingItemId: need.id, necessity: need.necessity, scarce: need.capacityEvidence === 'limited' } : {}),
      ...(fact ? { bookedItemId: fact.id } : {}),
      ...(need?.deadline ? { due: need.deadline } : {}),
      ...(need?.ifUnavailable ? { fallback: need.ifUnavailable } : {}),
    });
  }

  // --- days ------------------------------------------------------------------------------------------------
  const unverifiedNamed = new Map<number, number>();
  for (const anchor of pkg?.anchors ?? []) {
    if ((anchor.anchorKind ?? 'named_place') !== 'named_place' || anchor.verification !== 'unverified' || anchor.disposition.startsWith('rejected') || anchor.disposition === 'unscheduled_capacity') continue;
    const day = anchor.scheduledDayNumber ?? anchor.dayNumber;
    unverifiedNamed.set(day, (unverifiedNamed.get(day) ?? 0) + 1);
  }
  for (const day of itinerary.days) {
    const dependency = feasibility.find((f) => f.dayNumber === day.dayNumber && f.severity !== 'caution');
    const bookedToday = input.booked.some((b) => b.status === 'booked' && (b.date === day.date || (b.type === 'lodging' && b.date && b.endDate && b.date <= day.date && day.date <= b.endDate)));
    const state: TripNodeState = dependency ? 'needs_decision' : changedDays.has(day.dayNumber) ? 'changed' : day.totals.unmeasuredMajorTransfer || (unverifiedNamed.get(day.dayNumber) ?? 0) > 0 ? 'needs_verification' : bookedToday ? 'accepted' : 'suggested';
    push({
      id: `day:${day.dayNumber}`,
      kind: 'day',
      /* A theme that already starts with its day number is not prefixed twice. */
      label: new RegExp(`^day ${day.dayNumber}\\b`, 'i').test(day.theme) ? day.theme : `Day ${day.dayNumber} · ${day.theme}`,
      state,
      source: bookedToday ? 'booking' : 'model',
      confidence: dependency ? 'low' : day.timing?.precision === 'band' ? 'low' : day.timing?.precision === 'estimated' ? 'medium' : 'high',
      impact: 'day',
      href: NODE_HREF.days(day.dayNumber),
      dependsOn: [`base:${day.baseId}`, 'transport'],
      scope: { dayNumbers: [day.dayNumber], baseIds: [day.baseId] },
      ...(dependency ? { detail: dependency.detail } : day.totals.unmeasuredMajorTransfer ? { detail: 'The main transfer into this day has not been timed.' } : {}),
    });
  }

  // --- experiences ----------------------------------------------------------------------------------------
  const itemById = new Map<string, { dayNumber: number; operational?: NonNullable<Itinerary['days'][number]['items'][number]['operational']> }>();
  for (const day of itinerary.days) for (const item of day.items) itemById.set(item.id, { dayNumber: day.dayNumber, ...(item.operational ? { operational: item.operational } : {}) });
  for (const anchor of pkg?.anchors ?? []) {
    if (anchor.disposition.startsWith('rejected') || anchor.disposition === 'unscheduled_capacity' || anchor.disposition === 'folded_into_meal' || anchor.disposition === 'folded_into_transfer' || anchor.disposition === 'folded_into_terminal') continue;
    const dayNumber = anchor.scheduledDayNumber ?? anchor.dayNumber;
    const item = itemById.get(anchor.id);
    const need = bookingItems.find((b) => !b.memberIds && ((b.placeId && b.placeId === anchor.placeId) || b.id === `booking:guided:${anchor.id}` || b.id.endsWith(`:${anchor.id}`)));
    const fact = need?.bookedItemId ? input.booked.find((b) => b.id === need.bookedItemId) : input.booked.find((b) => b.status === 'booked' && anchor.placeId && b.placeId === anchor.placeId);
    const outcome = item?.operational?.outcome;
    const state: TripNodeState =
      outcome === 'closed_permanently' || outcome === 'closed_on_date'
        ? 'unavailable'
        : fact
          ? 'booked'
          : need && need.status === 'open' && (need.necessity === 'required' || need.necessity === 'strongly_recommended')
            ? 'needs_booking'
            : need && resolutions.has(need.id)
              ? 'cancelled'
              : anchor.role === 'optional' || anchor.role === 'flex'
                ? 'optional'
                : (anchor.anchorKind ?? 'named_place') === 'named_place' && anchor.verification === 'unverified'
                  ? 'needs_verification'
                  : anchor.verification === 'verified'
                    ? 'verified'
                    : 'suggested';
    push({
      id: `experience:${anchor.id}`,
      kind: 'experience',
      label: anchor.name,
      state,
      source: fact ? 'booking' : anchor.verification === 'verified' ? 'provider' : 'model',
      confidence: anchor.verification === 'verified' ? 'high' : anchor.verification === 'partially_verified' ? 'medium' : 'low',
      impact: anchor.role === 'core' ? 'day' : 'item',
      href: NODE_HREF.days(dayNumber),
      dependsOn: [`day:${dayNumber}`, ...(need ? [`booking:${need.id}`] : [])],
      scope: { dayNumbers: [dayNumber] },
      ...(need ? { bookingItemId: need.id, necessity: need.necessity } : {}),
      ...(fact ? { bookedItemId: fact.id } : {}),
      ...(item?.operational?.note && state === 'unavailable' ? { detail: item.operational.note } : {}),
    });
  }

  // --- bookings -------------------------------------------------------------------------------------------
  for (const need of bookingItems) {
    if (need.memberIds) continue;
    const resolution = resolutions.get(need.id);
    const fact = need.bookedItemId ? input.booked.find((b) => b.id === need.bookedItemId) : undefined;
    const state: TripNodeState = need.status === 'booked' ? 'booked' : resolution?.resolution === 'skipped' ? 'cancelled' : need.status === 'not_needed' ? 'cancelled' : need.priority === 'keep_flexible' || need.necessity === 'optional' ? 'optional' : need.verifyRequirement ? 'needs_verification' : 'needs_booking';
    const dayNumbers = need.dayNumber ? [need.dayNumber] : need.group === 'stays' && need.baseId ? itinerary.days.filter((d) => d.baseId === need.baseId).map((d) => d.dayNumber) : [];
    push({
      id: `booking:${need.id}`,
      kind: 'booking',
      label: need.title,
      state,
      source: fact ? 'booking' : need.authority === 'official_current' ? 'provider' : 'model',
      confidence: need.authority === 'official_current' || need.authority === 'authoritative_structured' ? 'high' : need.verifyRequirement ? 'low' : 'medium',
      impact: need.necessity === 'required' ? (need.group === 'stays' || need.kind === 'cruise' || need.kind === 'programme' || need.kind === 'rental_vehicle' ? 'trip' : 'day') : 'item',
      href: NODE_HREF.bookings,
      dependsOn: need.baseId ? [`base:${need.baseId}`] : need.dayNumber ? [`day:${need.dayNumber}`] : ['route'],
      scope: { dayNumbers, ...(need.baseId ? { baseIds: [need.baseId] } : {}) },
      bookingItemId: need.id,
      necessity: need.necessity,
      scarce: need.capacityEvidence === 'limited',
      ...(fact ? { bookedItemId: fact.id } : {}),
      ...(need.deadline ? { due: need.deadline } : need.onSaleDate ? { recheckAt: need.onSaleDate } : {}),
      ...(need.ifUnavailable ? { fallback: need.ifUnavailable } : {}),
      detail: need.reason,
    });
  }

  // --- dependencies: feasibility items and due rechecks --------------------------------------------------
  feasibility
    .filter((f) => f.severity !== 'caution')
    .forEach((f, index) => {
      push({
        id: `dependency:${f.area}:${index}`,
        kind: 'dependency',
        label: f.detail,
        state: 'needs_decision',
        source: 'sidequest',
        confidence: 'high',
        impact: f.severity === 'blocker' ? 'trip' : f.dayNumber ? 'day' : 'days',
        href: f.dayNumber ? NODE_HREF.days(f.dayNumber) : NODE_HREF.prepare,
        dependsOn: f.dayNumber ? [`day:${f.dayNumber}`] : ['route'],
        scope: { dayNumbers: f.dayNumber ? [f.dayNumber] : [] },
        /*
         * V11 §39 — Sidequest's own unfinished work says so, and never claims
         * the plan is waiting on the traveller. "Still checking this" is the
         * honest sentence for a geocoder that did not answer.
         */
        owner: f.owner ?? 'traveller',
        detail: f.severity === 'blocker' ? 'Something you locked is contradicted.' : f.owner === 'sidequest' ? 'Sidequest is still working this out; nothing for you to do yet.' : 'The plan cannot do without this.',
      });
    });
  for (const item of input.recheck?.items ?? []) {
    if (item.state !== 'due') continue;
    push({
      id: `recheck:${item.id}`,
      kind: 'dependency',
      label: item.title,
      state: 'needs_verification',
      source: 'sidequest',
      confidence: 'medium',
      impact: 'days',
      href: '#verify',
      dependsOn: ['trip'],
      scope: { dayNumbers: [] },
      detail: item.why,
    });
  }

  // --- preparation: readiness entries that need the traveller --------------------------------------------
  for (const entry of intelligence?.readiness.entries ?? []) {
    if (entry.state === 'not_applicable' || entry.state === 'confirmed') continue;
    if (entry.tier === 'more' && entry.state !== 'problem' && !entry.blocking) continue;
    push({
      id: `preparation:${entry.kind}`,
      kind: 'preparation',
      label: entry.title,
      state: entry.state === 'needs_input' || entry.state === 'problem' ? 'needs_decision' : 'needs_verification',
      source: entry.state === 'unverified' ? 'model' : 'sidequest',
      confidence: entry.state === 'problem' ? 'high' : 'medium',
      impact: entry.blocking ? 'trip' : 'item',
      href: NODE_HREF.prepare,
      dependsOn: ['trip'],
      scope: { dayNumbers: [] },
      detail: entry.summary,
    });
  }

  // --- changed facts ---------------------------------------------------------------------------------------
  for (const observation of observations) {
    push({
      id: `changed:${observation.id}`,
      kind: 'dependency',
      label: observation.summary,
      state: 'changed',
      source: 'provider',
      confidence: 'high',
      impact: observation.dayNumbers.length > 0 ? 'day' : 'days',
      href: observation.dayNumbers[0] ? NODE_HREF.days(observation.dayNumbers[0]) : '#overview',
      dependsOn: observation.dayNumbers.map((n) => `day:${n}`),
      scope: { dayNumbers: [...observation.dayNumbers] },
    });
  }

  // --- counts, dependents, summary --------------------------------------------------------------------------
  const counts = Object.fromEntries(TRIP_NODE_STATES.map((s) => [s, 0])) as Record<TripNodeState, number>;
  for (const node of nodes) counts[node.state] += 1;
  const dependents: Record<string, number> = {};
  for (const node of nodes) for (const dep of node.dependsOn) dependents[dep] = (dependents[dep] ?? 0) + 1;
  const open = counts.needs_decision + counts.needs_booking + counts.needs_verification + counts.changed;
  const summary =
    counts.needs_decision > 0
      ? `${counts.needs_decision} thing${counts.needs_decision === 1 ? '' : 's'} still need${counts.needs_decision === 1 ? 's' : ''} a decision.`
      : counts.changed > 0
        ? `${counts.changed} thing${counts.changed === 1 ? '' : 's'} changed since this trip was planned.`
        : counts.needs_booking > 0
          ? `${counts.needs_booking} thing${counts.needs_booking === 1 ? '' : 's'} still need${counts.needs_booking === 1 ? 's' : ''} booking.`
          : open === 0
            ? 'Everything the trip depends on is settled.'
            : `${open} thing${open === 1 ? '' : 's'} to check before you rely on the plan.`;
  return { version: 1, nodes, counts, dependents, summary };
}

/** The nodes in the traveller's way, most consequential first. */
export function openNodes(graph: TripStateGraph): TripStateNode[] {
  const rank: Record<TripNodeState, number> = { needs_decision: 0, changed: 1, needs_booking: 2, needs_verification: 3, unavailable: 4, suggested: 5, optional: 6, accepted: 7, verified: 7, booked: 7, cancelled: 8 };
  return graph.nodes.filter((n) => rank[n.state] <= 4).sort((a, b) => rank[a.state] - rank[b.state] || (graph.dependents[b.id] ?? 0) - (graph.dependents[a.id] ?? 0));
}

/** A compact per-day reading for the Days view and Today. */
export function dayState(graph: TripStateGraph, dayNumber: number): { state: TripNodeState; open: TripStateNode[] } {
  const day = graph.nodes.find((n) => n.id === `day:${dayNumber}`);
  const open = graph.nodes.filter((n) => n.id !== day?.id && n.scope.dayNumbers.includes(dayNumber) && (n.state === 'needs_decision' || n.state === 'needs_booking' || n.state === 'needs_verification' || n.state === 'changed' || n.state === 'unavailable'));
  return { state: day?.state ?? 'suggested', open };
}
