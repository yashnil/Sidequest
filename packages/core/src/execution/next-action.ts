import { z } from 'zod';
import type { TripLifecycle } from '../schemas/trip';
import type { TodayView } from '../intelligence/today';
import { type TripStateGraph, type TripStateNode } from './state-graph';

/**
 * V9 §2 — NEXT BEST ACTION.
 *
 * A traveller should never have to read the whole trip to learn what to do
 * now. This computes the one to three actions that matter most, from the
 * state graph, the lifecycle and the calendar — with a transparent score,
 * never a model. Urgency is never invented: a deadline term applies only when
 * a real date exists, scarcity only when evidence says capacity is limited.
 */
export const NEXT_ACTION_KINDS = ['decide', 'book', 'verify', 'prepare', 'recheck', 'travel'] as const;
export const nextActionKindSchema = z.enum(NEXT_ACTION_KINDS);
export type NextActionKind = z.infer<typeof nextActionKindSchema>;

export const nextActionSchema = z.object({
  id: z.string().min(1),
  kind: nextActionKindSchema,
  title: z.string().min(1),
  why: z.string().min(1),
  href: z.string().min(1),
  due: z.string().optional(),
  nodeId: z.string().min(1),
  score: z.number(),
});
export type NextAction = z.infer<typeof nextActionSchema>;

export const TRIP_PHASES = ['plan', 'book', 'prepare', 'travel', 'past'] as const;
export type TripPhase = (typeof TRIP_PHASES)[number];

export interface NextActions {
  phase: TripPhase;
  actions: NextAction[];
  /** How many further open things the surfaces may list below the top three. */
  remaining: number;
}

export function phaseFor(lifecycle: TripLifecycle, daysUntilTrip: number, graph: TripStateGraph): TripPhase {
  if (lifecycle === 'past' || lifecycle === 'archived') return 'past';
  if (lifecycle === 'traveling') return 'travel';
  if (daysUntilTrip <= 14) return 'prepare';
  if (graph.counts.needs_decision > 0) return 'plan';
  if (graph.counts.needs_booking > 0 || lifecycle === 'ready') return 'book';
  if (lifecycle === 'booked') return 'prepare';
  return 'plan';
}

function daysUntil(date: string | undefined, now: Date): number | null {
  if (!date) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.round((then - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
}

const KIND_WORD: Record<NextActionKind, string> = { decide: 'Decide', book: 'Book', verify: 'Check', prepare: 'Prepare', recheck: 'Re-check', travel: 'Now' };
export const NEXT_ACTION_KIND_WORD = KIND_WORD;

function actionFor(node: TripStateNode, graph: TripStateGraph, input: { now: Date; daysUntilTrip: number }): NextAction | null {
  let kind: NextActionKind;
  let title: string;
  let why: string;
  switch (node.state) {
    case 'needs_decision':
      kind = 'decide';
      /* A day that needs a decision says the dependency's own sentence, so it and the dependency node collapse into one action. */
      title = node.kind === 'preparation' || node.kind === 'dependency' ? node.label : node.kind === 'day' && node.detail ? node.detail : `Settle ${node.kind === 'route' ? 'the route' : node.kind === 'transport' ? 'how you get around' : node.label}`;
      why = node.kind === 'day' && node.detail ? 'The plan cannot do without this.' : (node.detail ?? 'The plan cannot do without this.');
      break;
    case 'needs_booking':
      kind = 'book';
      title = node.kind === 'base' ? `Book somewhere to sleep: ${node.label.replace(/^\d+ nights? in /, '')}` : `Book ${node.label}`;
      why = node.detail ?? (node.kind === 'base' ? 'The nights at this base depend on it.' : 'The day depends on it.');
      break;
    case 'changed':
      kind = 'recheck';
      title = node.label;
      why = 'Something the plan relied on has changed. Look, then decide.';
      break;
    case 'unavailable':
      kind = 'decide';
      title = `Replace ${node.label}`;
      why = node.detail ?? 'Evidence says this is not available.';
      break;
    case 'needs_verification':
      kind = node.kind === 'dependency' ? 'recheck' : 'verify';
      title = node.kind === 'dependency' ? node.label : `Check ${node.label}`;
      why = node.detail ?? 'Nothing could confirm this yet; check it before relying on it.';
      break;
    default:
      return null;
  }
  if (node.kind === 'preparation') kind = 'prepare';
  const dependents = graph.dependents[node.id] ?? 0;
  /* A decision outranks a booking that would depend on it; a required booking outranks verification; preparation is last. */
  const impact = node.state === 'needs_decision' && node.impact === 'trip' ? 100 : node.state === 'needs_decision' ? (node.kind === 'preparation' ? 45 : 90) : node.state === 'changed' ? 70 : node.state === 'unavailable' ? 75 : node.state === 'needs_booking' ? (node.necessity === 'required' ? 60 : 40) : node.kind === 'preparation' ? 20 : 30;
  const dueIn = daysUntil(node.due, input.now);
  const deadline = dueIn === null ? 0 : dueIn <= 7 ? 40 : dueIn <= 30 ? 20 : 5;
  const proximity = input.daysUntilTrip <= 14 && (kind === 'book' || kind === 'prepare' || kind === 'recheck') ? 25 : 0;
  const scarcity = node.scarce ? 15 : 0;
  const confidence = node.confidence === 'low' && node.state !== 'needs_decision' ? -10 : 0;
  const score = impact + dependents * 10 + deadline + proximity + scarcity + confidence;
  return nextActionSchema.parse({ id: `action:${node.id}`, kind, title, why, href: node.href, ...(node.due ? { due: node.due } : {}), nodeId: node.id, score });
}

export function buildNextActions(input: { graph: TripStateGraph; lifecycle: TripLifecycle; daysUntilTrip: number; now: Date; today?: TodayView | null; limit?: number }): NextActions {
  const limit = input.limit ?? 3;
  const phase = phaseFor(input.lifecycle, input.daysUntilTrip, input.graph);
  const candidates = input.graph.nodes.map((node) => actionFor(node, input.graph, input)).filter((a): a is NextAction => a !== null);
  /* A base needing a bed and the stays roll-up would otherwise say the same thing twice. */
  const dedupe = new Map<string, NextAction>();
  for (const action of candidates.sort((a, b) => b.score - a.score)) {
    const key = action.title.toLowerCase();
    if (!dedupe.has(key)) dedupe.set(key, action);
  }
  let ranked = [...dedupe.values()];

  if (phase === 'travel' && input.today?.active) {
    const today = input.today;
    const travel: NextAction[] = [];
    if (today.next) {
      travel.push(nextActionSchema.parse({ id: 'action:today:next', kind: 'travel', title: today.leaveBy ? `Leave by ${today.leaveBy.time} for ${today.next.title}` : `Next: ${today.next.title}`, why: today.leaveBy ? today.leaveBy.basisNote : 'The next thing on today’s plan.', href: `#day-${today.dayNumber}`, nodeId: `day:${today.dayNumber}`, score: 1000 }));
    }
    const todayOpen = ranked.filter((a) => input.graph.nodes.find((n) => n.id === a.nodeId)?.scope.dayNumbers.includes(today.dayNumber ?? -1));
    ranked = [...travel, ...todayOpen, ...ranked.filter((a) => !todayOpen.includes(a))];
  } else if (phase === 'past') {
    ranked = [];
  }
  const actions = ranked.slice(0, limit);
  return { phase, actions, remaining: Math.max(0, ranked.length - actions.length) };
}
