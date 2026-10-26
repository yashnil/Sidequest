import { projectShape } from '../collection/stamp-geometry';
import { ATLAS_TOURS, type AtlasTourStop } from './atlas-tours';

/**
 * THE FRONT PAGE'S "HOW IT WORKS", AS A SEQUENCE — pure, so the frames can be
 * asserted without a browser.
 *
 * Six steps over one stage: a destination is typed, one question is answered,
 * the scan's candidates arrive as numbered pins, some are chosen, the order
 * draws between them, and a day appears. All of it is the Iceland *example
 * shape* the globe already flies (`atlas-tours.ts`): real towns at their real
 * positions, nothing researched, timed or verified. The lines are straight
 * lines between towns, drawn dotted — the maps' stroke for "order, not a
 * road" — and the one distance is computed here and labelled straight-line.
 *
 * `stageAt(1)` is the whole picture at once. It is what the server renders,
 * what a visitor without JavaScript sees, and what reduced motion keeps: the
 * sequence must be complete and legible standing still.
 */

export const HOW_TOUR = ATLAS_TOURS.find((t) => t.id === 'iceland') ?? ATLAS_TOURS[0]!;

export interface HowStep {
  n: string;
  title: string;
  caption: string;
  /** What the demo is doing during this step, in a few plain words, for the stage's header. */
  doing: string;
}

export const HOW_STEPS: readonly HowStep[] = [
  { n: '01', title: 'Name a place', caption: 'A city, a national park, a whole country — whatever you have in mind.', doing: 'Typing a destination' },
  { n: '02', title: 'Answer a few questions', caption: 'Your pace, your budget, what you love. Asked once, never again.', doing: 'Answering a question' },
  { n: '03', title: 'See what’s out there', caption: 'Famous sights and hidden gems, each placed on a real map.', doing: 'Finding places' },
  { n: '04', title: 'Pick what’s in', caption: 'Tick the ones you want — or let Sidequest choose for you.', doing: 'Picking favourites' },
  { n: '05', title: 'Get a route', caption: 'Stops in an order you can actually travel, with a bed where each day ends.', doing: 'Drawing the route' },
  { n: '06', title: 'Get your days', caption: 'Every day planned, with honest travel times — never a made-up zero.', doing: 'Your day is ready' },
];

/** Which example towns the "choose" step ticks. The last one is left out — not ticked, nothing more is claimed. */
export const CHOSEN = [0, 1, 2, 3, 4] as const;
export const BASE_INDEX = 0;

export const STAGE_W = 600;
export const STAGE_H = 320;

export interface StagePin extends AtlasTourStop {
  index: number;
  x: number;
  y: number;
  /** The name goes above the pin when another pin sits just below it, so no label lands on a pin. */
  labelAbove: boolean;
}

export function stagePins(): StagePin[] {
  const projected = projectShape({ center: null, bases: HOW_TOUR.stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })), stops: [] }, { width: STAGE_W, height: STAGE_H, pad: 58 });
  return projected.bases.map((b, i) => ({
    ...HOW_TOUR.stops[i]!,
    index: i,
    x: b.x,
    y: b.y,
    labelAbove: projected.bases.some((o, j) => j !== i && Math.abs(o.x - b.x) < 70 && o.y - b.y > 0 && o.y - b.y < 48),
  }));
}

/** The real extent of the example, for the stage's corner figures — the frame the scan works inside. */
export function stageExtent(): { north: number; south: number; east: number; west: number } {
  const lats = HOW_TOUR.stops.map((s) => s.lat);
  const lngs = HOW_TOUR.stops.map((s) => s.lng);
  return { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) };
}

export function straightLineKm(a: AtlasTourStop, b: AtlasTourStop): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

export interface StageFrame {
  /** The step being read, 0–5. */
  step: number;
  /** Characters of the typed destination shown. */
  chars: number;
  question: boolean;
  /** The pace answer is pressed. */
  answered: boolean;
  /** How many candidate pins have arrived. */
  pins: number;
  /** The scan is under way (its ring sweeps and its counter counts). */
  scanning: boolean;
  /** Chosen / base / left-out states are applied. */
  chosen: boolean;
  /** How much of the order line is drawn, 0–1. */
  route: number;
  day: boolean;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The stage at a scroll progress `p` through the steps (0 = the first step
 * reaches the reading line, 1 = the last one leaves it). Monotonic: nothing
 * that has appeared disappears while reading forward.
 */
export function stageAt(p: number): StageFrame {
  const steps = HOW_STEPS.length;
  const f = clamp(p) * steps;
  const step = Math.min(steps - 1, Math.floor(f));
  const typed = HOW_TOUR.prompt.length;
  return {
    step,
    chars: f >= 1 ? typed : Math.round(typed * clamp(f / 0.7)),
    question: f >= 1,
    answered: f >= 1.45,
    pins: f >= 3 ? HOW_TOUR.stops.length : f < 2 ? 0 : Math.ceil(HOW_TOUR.stops.length * clamp((f - 2) / 0.75)),
    scanning: f >= 2 && f < 3,
    chosen: f >= 3.3,
    route: clamp((f - 4) / 0.8),
    day: f >= 5.15,
  };
}

/** The complete picture: server render, no JavaScript, reduced motion. */
export const STILL: StageFrame = { ...stageAt(1), step: -1, scanning: false };

/*
 * PACING. Scrolling the stage frame-for-frame made the typing a function of
 * the scroll wheel: a letter only appeared while the page moved, so it
 * stuttered and stalled. Scroll now only says *which step is being read*;
 * the stage then plays up to the end of that step at its own steady pace,
 * like the product would, and catches up (faster) after a quick scroll.
 */

/** Seconds a single step takes to play when the reader arrives at it. */
export const STEP_SECONDS = 1.2;

/** Where the stage should end up for a scroll progress: the end of the step being read, or empty before the first. */
export function targetFor(scroll: number): number {
  if (scroll <= 0) return 0;
  const steps = HOW_STEPS.length;
  return Math.min(steps, Math.floor(clamp(scroll) * steps) + 1) / steps;
}

/** One animation tick: move `shown` toward `target` at one step per `STEP_SECONDS`, faster when far behind. */
export function advance(shown: number, target: number, dtSeconds: number): number {
  const gap = target - shown;
  if (gap === 0) return target;
  const base = 1 / HOW_STEPS.length / STEP_SECONDS;
  const rate = Math.max(base, Math.abs(gap) / STEP_SECONDS);
  const move = Math.min(Math.abs(gap), rate * Math.max(0, dtSeconds));
  return shown + Math.sign(gap) * move;
}
