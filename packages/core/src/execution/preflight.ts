import { z } from 'zod';
import type { TravelIntelligence } from '../intelligence/model';
import type { BookedPlanItem } from '../intelligence/booking';
import type { TripStateGraph } from './state-graph';

/**
 * V9 §7 — TRIP PREFLIGHT.
 *
 * "Am I ready to actually take this trip?" answered from the state graph, the
 * intelligence, the ticks the traveller made and the booked facts. Three
 * lists — ready, needs attention, can wait — and one verdict. Official and
 * medical facts keep their source and read date; nothing here manufactures
 * certainty a model could not have.
 */
export const PREFLIGHT_CATEGORIES = ['bookings', 'documents', 'transport', 'payments_apps', 'connectivity', 'weather', 'packing', 'health_access', 'local_setup', 'offline'] as const;
export type PreflightCategory = (typeof PREFLIGHT_CATEGORIES)[number];

export const PREFLIGHT_CATEGORY_LABELS: Record<PreflightCategory, string> = {
  bookings: 'Bookings',
  documents: 'Entry and documents',
  transport: 'Getting there and around',
  payments_apps: 'Payments and apps',
  connectivity: 'Staying connected',
  weather: 'Weather-sensitive days',
  packing: 'Packing',
  health_access: 'Health and accessibility',
  local_setup: 'Local set-up',
  offline: 'Offline copy',
};

export const preflightItemSchema = z.object({
  id: z.string().min(1),
  category: z.enum(PREFLIGHT_CATEGORIES),
  title: z.string().min(1),
  detail: z.string().optional(),
  href: z.string().min(1),
  /** ready = done or confirmed; attention = needs the traveller before departure; later = can wait. */
  bucket: z.enum(['ready', 'attention', 'later']),
  sourceName: z.string().optional(),
  readAt: z.string().optional(),
  /** When set, a tick in `trip_checks(list='preflight')` marks this ready. */
  checkId: z.string().optional(),
  /*
   * V11 §2 — WHERE THIS ITEM CAME FROM, SO PREPARE CAN STOP SAYING IT THREE TIMES.
   *
   * A readiness entry used to be rendered three times on one page: here as a
   * bucket card, again in the "Before you go" topic grid with its full body and
   * source link, and a third time under "In order" with the full body again —
   * because `buildChecklist` turns every entry into a checklist item too. Three
   * derived structures over one fact, each restating it rather than indexing it.
   *
   * Preflight is the one of the three that already knows the traveller's ticks
   * and the entry's state, so it owns the list. These two fields are what the
   * other two renderers needed and it lacked: the entry's own kind and state,
   * so the rendered row can still be addressed as that readiness entry, and the
   * phase, so "before you leave" can be told from "closer to the trip" without
   * a second list to hold the timing.
   */
  readinessKind: z.string().min(1).optional(),
  readinessState: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  /** The entry's official links, so the canonical row carries them rather than pointing at a copy. */
  links: z.array(z.object({ name: z.string().min(1), url: z.string().min(1) })).optional(),
});
export type PreflightItem = z.infer<typeof preflightItemSchema>;

export interface Preflight {
  verdict: 'ready' | 'nearly' | 'not_yet';
  headline: string;
  daysUntilTrip: number;
  ready: PreflightItem[];
  attention: PreflightItem[];
  later: PreflightItem[];
}

/**
 * V11 §2 — THE FOUR GROUPS PREPARE SHOWS, AS A PURE FUNCTION OF ONE ITEM.
 *
 * Grouping is a *view* over the canonical list, not a second list. Three
 * buckets said what state a thing was in and nothing about when it is due, so
 * the timing lived in a separate "In order" section that restated every entry
 * to carry it. Splitting `attention` by the entry's own phase puts the timing
 * on the row that already exists.
 *
 * `needs_attention` is what is due now or blocks a booking; `before_you_leave`
 * is the rest of what must happen before departure; `closer_to_the_trip` is
 * what genuinely waits; `ready` is done or confirmed. An item with no phase —
 * a booking, a weather day — is due before departure, which is the honest
 * reading of "we could not say when".
 */
export const PREPARE_GROUPS = ['needs_attention', 'before_you_leave', 'closer_to_the_trip', 'ready'] as const;
export type PrepareGroup = (typeof PREPARE_GROUPS)[number];

export const PREPARE_GROUP_LABELS: Record<PrepareGroup, { title: string; blurb: string }> = {
  needs_attention: { title: 'Needs attention', blurb: 'Now, or before you book.' },
  before_you_leave: { title: 'Before you leave', blurb: 'Ahead of the trip.' },
  closer_to_the_trip: { title: 'Closer to the trip', blurb: 'Nearer the date.' },
  ready: { title: 'Ready', blurb: 'Done or confirmed.' },
};

/** Phases that mean "this is the thing in front of you", rather than something later. */
const NOW_PHASES = new Set(['do_now', 'do_before_booking', 'book_first']);

export function prepareGroupOf(item: Pick<PreflightItem, 'bucket' | 'phase'>): PrepareGroup {
  if (item.bucket === 'ready') return 'ready';
  if (item.bucket === 'later') return 'closer_to_the_trip';
  return item.phase === undefined || NOW_PHASES.has(item.phase) ? 'needs_attention' : 'before_you_leave';
}

/** The canonical list, grouped once. Every item appears in exactly one group. */
export function groupPreflight(preflight: Pick<Preflight, 'ready' | 'attention' | 'later'>): Record<PrepareGroup, PreflightItem[]> {
  const out: Record<PrepareGroup, PreflightItem[]> = { needs_attention: [], before_you_leave: [], closer_to_the_trip: [], ready: [] };
  for (const item of [...preflight.attention, ...preflight.later, ...preflight.ready]) out[prepareGroupOf(item)].push(item);
  return out;
}

export function buildPreflight(input: {
  graph: TripStateGraph;
  intelligence: TravelIntelligence | null;
  booked: readonly BookedPlanItem[];
  checks: { preflight: readonly string[]; packing: readonly string[]; checklist: readonly string[] };
  daysUntilTrip: number;
  /** Whether the browser reported the offline copy as saved (a client fact the server cannot know). */
  offlineSaved?: boolean;
}): Preflight {
  const items: PreflightItem[] = [];
  const intel = input.intelligence;
  const ticked = new Set(input.checks.preflight);
  const put = (item: Omit<PreflightItem, 'bucket'> & { bucket?: PreflightItem['bucket'] }, done: boolean, later = false) => {
    items.push(preflightItemSchema.parse({ ...item, bucket: done || (item.checkId && ticked.has(item.checkId)) ? 'ready' : later ? 'later' : 'attention' }));
  };

  // Bookings: the required needs, by kind ------------------------------------------------------------
  const needs = (intel?.bookings.items ?? []).filter((b) => !b.memberIds);
  const groups: { id: string; title: string; match: (kind: string) => boolean }[] = [
    { id: 'flights', title: 'Flights', match: (k) => k === 'flight' },
    { id: 'lodging', title: 'Lodging', match: (k) => k === 'accommodation' },
    { id: 'car', title: 'Car', match: (k) => k === 'rental_vehicle' },
    { id: 'transport', title: 'Trains, ferries and transfers', match: (k) => k === 'train' || k === 'ferry' || k === 'shuttle' || k === 'internal_transfer' },
    { id: 'experiences', title: 'Major reservations', match: (k) => k === 'permit' || k === 'timed_entry' || k === 'park_entry' || k === 'tour_guide' || k === 'event' || k === 'cruise' || k === 'programme' },
    { id: 'tables', title: 'Restaurant tables', match: (k) => k === 'restaurant' },
  ];
  const bookedFlights = input.booked.filter((b) => b.type === 'flight' && b.status === 'booked');
  for (const group of groups) {
    const inGroup = needs.filter((n) => group.match(n.kind));
    if (group.id === 'flights' && inGroup.length === 0) {
      if (bookedFlights.length > 0) put({ id: 'preflight:flights', category: 'bookings', title: 'Flights', detail: `${bookedFlights.length} booked`, href: '#book-first' }, true);
      continue;
    }
    if (inGroup.length === 0) continue;
    const open = inGroup.filter((n) => n.status === 'open' && (n.necessity === 'required' || n.necessity === 'strongly_recommended'));
    const optionalOpen = inGroup.filter((n) => n.status === 'open' && n.necessity !== 'required' && n.necessity !== 'strongly_recommended');
    const settled = inGroup.filter((n) => n.status !== 'open').length;
    if (open.length === 0) {
      put({ id: `preflight:${group.id}`, category: 'bookings', title: group.title, detail: settled > 0 ? `${settled} of ${inGroup.length} arranged` : 'Nothing required', href: '#book-first' }, true, optionalOpen.length > 0);
    } else {
      put({ id: `preflight:${group.id}`, category: 'bookings', title: `${group.title}: ${open.length === 1 ? open[0]!.title : `${open.length} still to book`}`, detail: open[0]!.reason, href: '#book-first', ...(open[0]!.deadline ? { readAt: open[0]!.deadline } : {}) }, false, group.id === 'tables' || open.every((n) => n.priority === 'can_wait' || n.priority === 'keep_flexible'));
    }
  }

  // Documents, health, local set-up, connectivity from the readiness packet ------------------------------
  for (const entry of intel?.readiness.entries ?? []) {
    if (entry.state === 'not_applicable') continue;
    const category: PreflightCategory = entry.kind === 'local_setup' ? 'local_setup' : /health|vaccin|medic|access|mobility/i.test(entry.kind) ? 'health_access' : /sim|esim|roaming|connect/i.test(`${entry.kind} ${entry.title}`) ? 'connectivity' : /pay|cash|card|app/i.test(`${entry.kind} ${entry.title}`) ? 'payments_apps' : /driv|licence|permit|transit/i.test(entry.kind) ? 'transport' : 'documents';
    const done = entry.state === 'confirmed';
    const link = entry.links[0];
    put(
      {
        id: `preflight:readiness:${entry.kind}`,
        category,
        title: entry.action ?? entry.title,
        detail: entry.summary,
        href: '#before-you-go',
        ...(link ? { sourceName: link.name } : {}),
        ...(entry.facts?.find((f) => /compiled|as of|read on|checked/i.test(f)) ? { readAt: entry.facts.find((f) => /compiled|as of|read on|checked/i.test(f))! } : {}),
        checkId: `readiness:${entry.kind}`,
        readinessKind: entry.kind,
        readinessState: entry.state,
        phase: entry.phase,
        links: entry.links.map((l) => ({ name: l.name, url: l.url })),
      },
      done || input.checks.checklist.includes(`readiness:${entry.kind}`),
      entry.tier === 'more' && !entry.blocking && entry.state !== 'problem',
    );
  }

  // Weather-sensitive days -------------------------------------------------------------------------------
  const sensitive = intel?.weather.days.filter((d) => d.kind !== 'unavailable' && d.sensitiveItems.some((item) => item.sensitivity === 'high')) ?? [];
  if (sensitive.length > 0) {
    const listed = sensitive.slice(0, 3).map((d) => `Day ${d.dayNumber}`).join(', ');
    put({ id: 'preflight:weather', category: 'weather', title: `${listed}${sensitive.length > 3 ? ` and ${sensitive.length - 3} more` : ''} ${sensitive.length === 1 ? 'is' : 'are'} weather-sensitive`, detail: input.daysUntilTrip > 2 ? 'Re-check the forecast 48 hours before; a backup already sits on each of these days.' : 'Read the latest forecast; a backup already sits on each of these days.', href: '#backups' }, false, input.daysUntilTrip > 2);
  }

  // Packing ---------------------------------------------------------------------------------------------
  const packingTotal = intel?.packing.items.length ?? 0;
  if (packingTotal > 0) {
    const packed = input.checks.packing.length;
    put({ id: 'preflight:packing', category: 'packing', title: packed >= packingTotal ? 'Packed' : `Pack: ${packed} of ${packingTotal} ticked`, detail: intel?.packing.basisNote, href: '#pack' }, packed >= packingTotal, input.daysUntilTrip > 3);
  }

  // Offline copy ------------------------------------------------------------------------------------------
  put({ id: 'preflight:offline', category: 'offline', title: 'Save the offline trip on your phone', detail: 'Today, the days and your bookings open without signal once saved.', href: '#pack', checkId: 'offline' }, Boolean(input.offlineSaved), input.daysUntilTrip > 7);

  // Open dependencies from the graph, when any remain -----------------------------------------------------
  const decisions = input.graph.nodes.filter((n) => n.state === 'needs_decision' && n.kind === 'dependency');
  for (const node of decisions.slice(0, 4)) put({ id: `preflight:${node.id}`, category: 'transport', title: node.label, detail: node.detail, href: node.href }, false);

  const ready = items.filter((i) => i.bucket === 'ready');
  const attention = items.filter((i) => i.bucket === 'attention');
  const later = items.filter((i) => i.bucket === 'later');
  const verdict: Preflight['verdict'] = attention.length === 0 ? 'ready' : attention.length <= 2 && decisions.length === 0 ? 'nearly' : 'not_yet';
  const headline = verdict === 'ready' ? 'Ready for departure' : verdict === 'nearly' ? 'Nearly ready' : `${attention.length} thing${attention.length === 1 ? '' : 's'} before you go`;
  return { verdict, headline, daysUntilTrip: input.daysUntilTrip, ready, attention, later };
}
