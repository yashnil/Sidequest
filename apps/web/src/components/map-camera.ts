import type { GeoPoint } from './map-projection';

/**
 * V11 §10 §11 §12 — WHAT THE MAP LOOKS AT, AND WHAT IT LABELS.
 *
 * `fitMercator` was never the problem: it fits the points it is handed. The
 * problem was that each surface assembled its own list, so a "Banff townsite
 * orientation" day framed a meaningless patch of Echo Creek — the only stop that
 * happened to carry a coordinate — and a day whose base had not been placed
 * framed whatever was left.
 *
 * So the decision moves here, once, with a stated priority and a stated reason,
 * and three modes that genuinely differ:
 *
 *   overview   understand the trip in seconds — gateways, bases, signatures, route
 *   day        understand today — today's base and today's stops, everything else faded
 *   explore    discover alternatives — richer, and the only mode where density is wanted
 *
 * Two rules that between them fix the founder screenshot:
 *
 * - **A missing point is absent, never fatal.** Every input is filtered for a
 *   real coordinate before anything else happens, so one unplaced stop cannot
 *   move the frame or empty it.
 * - **A thin frame borrows context rather than zooming into nothing.** One
 *   placed point is not a map; it is a pin on an empty field. The frame widens
 *   to the next-best set — the chapter, then the route — and failing that raises
 *   the minimum ground span so the surroundings are visible.
 */

export const MAP_MODES = ['overview', 'day', 'explore'] as const;
export type MapMode = (typeof MAP_MODES)[number];

/** What a point is for. Decides both camera priority and label priority. */
export const MAP_MARKER_KINDS = ['gateway', 'base', 'signature', 'stop', 'overnight_experience', 'unresolved'] as const;
export type MapMarkerKind = (typeof MAP_MARKER_KINDS)[number];

export interface MapMarker {
  id: string;
  label: string;
  kind: MapMarkerKind;
  /** Absent when nothing placed it. Such a marker is never drawn and never framed. */
  point?: GeoPoint | undefined;
  /** The day this belongs to, for the day mode. */
  dayNumber?: number | undefined;
  /** The chapter this belongs to, for widening a thin day. */
  chapterId?: string | undefined;
}

export interface CameraFrame {
  /** The points to fit. Never empty when `ok` is true. */
  points: GeoPoint[];
  /** The smallest ground span the frame may represent. Raised when context has to be borrowed. */
  minSpanKm: number;
  /** Which rule produced this frame. Rendered in no UI; read by tests and by anyone debugging a bad frame. */
  basis: 'day_stops' | 'day_widened_to_chapter' | 'day_widened_to_route' | 'single_point_with_context' | 'route_extent' | 'everything';
  ok: true;
}

export interface NoFrame {
  ok: false;
  /** Why there is nothing to draw. The caller says "Locating…" rather than drawing the ocean at 0,0. */
  reason: 'nothing_placed';
}

/** Below this many points a frame is a pin on an empty field rather than a map. */
const THIN_FRAME = 2;

/**
 * The minimum ground span, by mode.
 *
 * A day is a day's worth of ground; an overview is a trip's worth. The single-
 * point figure is the one that matters: 12 km around one stop shows the town it
 * is in and the valley it sits in, which is the context the founder screenshot
 * was missing, while 2 km showed a creek.
 */
const MIN_SPAN_KM: Record<MapMode, number> = { overview: 40, day: 6, explore: 6 };
const SINGLE_POINT_SPAN_KM = 12;

function placed(markers: readonly MapMarker[]): { marker: MapMarker; point: GeoPoint }[] {
  return markers.flatMap((marker) => (marker.point ? [{ marker, point: marker.point }] : []));
}

export interface CameraInput {
  mode: MapMode;
  markers: readonly MapMarker[];
  /** The day in focus, for `mode: 'day'`. */
  dayNumber?: number | undefined;
  /** The chapter in focus, used to widen a thin day before falling back to the whole route. */
  chapterId?: string | undefined;
}

/**
 * What the camera should frame.
 *
 * Deterministic, pure, and unit-testable without a browser — which is the point:
 * a bad camera was previously only visible in a screenshot somebody had to look
 * at.
 */
export function cameraFrameFor(input: CameraInput): CameraFrame | NoFrame {
  const all = placed(input.markers);
  if (all.length === 0) return { ok: false, reason: 'nothing_placed' };

  if (input.mode === 'explore') {
    return { ok: true, points: all.map((entry) => entry.point), minSpanKm: MIN_SPAN_KM.explore, basis: 'everything' };
  }

  if (input.mode === 'overview') {
    /*
     * The shape of the trip: where you arrive, where you sleep, and what the
     * trip is for. Ordinary stops are deliberately excluded — they are what
     * turns an overview into a cloud — but only while something else remains.
     */
    const spine = all.filter((entry) => entry.marker.kind === 'gateway' || entry.marker.kind === 'base' || entry.marker.kind === 'signature' || entry.marker.kind === 'overnight_experience');
    const points = (spine.length > 0 ? spine : all).map((entry) => entry.point);
    return { ok: true, points, minSpanKm: MIN_SPAN_KM.overview, basis: 'route_extent' };
  }

  /* --- day ------------------------------------------------------------- */
  const today = all.filter((entry) => entry.marker.dayNumber === input.dayNumber);
  if (today.length >= THIN_FRAME) {
    return { ok: true, points: today.map((entry) => entry.point), minSpanKm: MIN_SPAN_KM.day, basis: 'day_stops' };
  }

  /*
   * A thin day. Widen rather than zoom into nothing — first to the chapter this
   * day belongs to, which is the smallest honest context, then to the whole
   * route. The day's own points stay in the set, so the frame still contains
   * what the day is about.
   */
  const chapter = input.chapterId ? all.filter((entry) => entry.marker.chapterId === input.chapterId) : [];
  if (chapter.length >= THIN_FRAME) {
    const points = [...new Set([...today, ...chapter])].map((entry) => entry.point);
    return { ok: true, points, minSpanKm: MIN_SPAN_KM.day, basis: 'day_widened_to_chapter' };
  }

  const spine = all.filter((entry) => entry.marker.kind === 'base' || entry.marker.kind === 'gateway');
  if (spine.length >= THIN_FRAME) {
    const points = [...new Set([...today, ...spine])].map((entry) => entry.point);
    return { ok: true, points, minSpanKm: MIN_SPAN_KM.day, basis: 'day_widened_to_route' };
  }

  /*
   * One placed point in the whole trip. Show it with enough ground around it to
   * mean something, rather than filling the frame with the nearest creek.
   */
  const points = (today.length > 0 ? today : all).map((entry) => entry.point);
  return { ok: true, points, minSpanKm: SINGLE_POINT_SPAN_KM, basis: 'single_point_with_context' };
}

// ---------------------------------------------------------------------------
// V11 §12 — labels
// ---------------------------------------------------------------------------

/**
 * Which markers get a label.
 *
 * The Kyrgyzstan generation screenshot printed every point's name at once and
 * they collided into "Osh BazaarSquare" around Bishkek. Four rules, in this
 * order of authority:
 *
 * 1. **The selected marker always keeps its label.** Whatever else happens.
 * 2. **Priority by kind.** A base outranks a signature outranks a stop. An
 *    unresolved marker is never labelled — it has no position worth naming.
 * 3. **A cap.** Beyond a certain count labels are noise however well placed.
 * 4. **Collision.** A label whose box overlaps one already placed is dropped,
 *    lowest priority first, because the alternative is two unreadable names.
 */
const LABEL_PRIORITY: Record<MapMarkerKind, number> = {
  base: 0,
  gateway: 1,
  overnight_experience: 2,
  signature: 3,
  stop: 4,
  unresolved: 99,
};

export interface LabelCandidate {
  id: string;
  label: string;
  kind: MapMarkerKind;
  /** Where the label's anchor sits, in pixels. */
  x: number;
  y: number;
  /**
   * V11 §N — the drawn radius of this candidate's own mark.
   *
   * A label is drawn beside its mark, not on it, and the marks are the other
   * thing on the drawing a label can land on top of. Without this the selection
   * reasoned about points and the renderer drew chips, so a chip could sit
   * squarely over a neighbouring dot while the collision count said zero — which
   * is exactly what a four-width read of the Mammoth overview showed around the
   * base. Defaulted so a caller that has no radius to give still gets the old
   * behaviour with a conservative mark size.
   */
  radius?: number;
}

export interface LabelSelection {
  id: string;
  /** The text to draw — abbreviated when the full name would not fit its lane. */
  text: string;
  x: number;
  y: number;
  /**
   * Which side of its mark this chip was placed on.
   *
   * The decision is made here, once, and the renderer draws where it is told:
   * a chip tries the right of its mark, then the left, and is dropped only if
   * neither side is clear. Two independent flip rules — one in the selection
   * and one in the drawing — is how a chip ends up judged in one place and
   * drawn in another.
   */
  side: 'left' | 'right';
}

/** Rough label box, from the text length. A real text measurement is not available before paint. */
const CHAR_WIDTH = 6.6;
const LABEL_HEIGHT = 16;
/** The gap the renderer leaves between a mark's edge and the chip beside it. */
const LABEL_GAP = 6;
/** The radius assumed for a mark whose caller did not state one. */
const DEFAULT_MARKER_RADIUS = 6;

function overlaps(a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }): boolean {
  return Math.abs(a.y - b.y) < LABEL_HEIGHT && a.x < b.x + b.w && b.x < a.x + a.w;
}

/**
 * Where the chip for this candidate is actually drawn.
 *
 * The renderer puts it to the right of the mark and flips it to the left when
 * the right-hand position would run off the frame. Both halves of that rule are
 * repeated here rather than guessed at, because a selection that reasons about
 * a position the renderer does not use is not a collision test — it is a second
 * opinion about a different drawing.
 */
function chipBox(candidate: LabelCandidate, textLength: number, side: 'left' | 'right'): { x: number; y: number; w: number } {
  const radius = candidate.radius ?? DEFAULT_MARKER_RADIUS;
  const w = textLength * CHAR_WIDTH;
  const offset = radius + LABEL_GAP;
  return { x: side === 'left' ? candidate.x - offset - w : candidate.x + offset, y: candidate.y, w };
}

/** Whether a chip on this side would run off the frame. Unknown width means it never does. */
function fitsInFrame(box: { x: number; w: number }, width: number | undefined): boolean {
  if (width === undefined) return true;
  return box.x >= 4 && box.x + box.w <= width - 4;
}

/** A mark's own footprint, as a box the same shape as a label box so one test covers both. */
function markBox(candidate: LabelCandidate): { x: number; y: number; w: number } {
  const radius = candidate.radius ?? DEFAULT_MARKER_RADIUS;
  return { x: candidate.x - radius, y: candidate.y, w: radius * 2 };
}

/**
 * Abbreviate a long name rather than dropping it.
 *
 * A parenthetical is the first thing to go — "Skazka Canyon (Fairy Tale
 * Canyon)" is one place and the second half is a gloss. After that the name is
 * truncated on a word boundary, because a name cut mid-word reads as a bug.
 */
export function abbreviateLabel(label: string, maxChars: number): string {
  const withoutGloss = label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
  if (withoutGloss.length <= maxChars) return withoutGloss;
  const words = withoutGloss.split(/\s+/);
  let out = '';
  for (const word of words) {
    if (out.length > 0 && `${out} ${word}`.length > maxChars) break;
    out = out.length === 0 ? word : `${out} ${word}`;
  }
  return (out.length > 0 ? out : withoutGloss.slice(0, maxChars)).replace(/[\s,;:–-]+$/, '') + '…';
}

export interface LabelOptions {
  /** How many labels this frame may carry. Zoomed out means fewer. */
  max: number;
  /** The marker the traveller has selected, which always keeps its label. */
  selectedId?: string | undefined;
  /** Longest label, in characters, before abbreviation. */
  maxChars?: number;
  /**
   * The drawn width of the frame, in pixels.
   *
   * Only used to know which side of its mark a chip ends up on, which the
   * renderer decides by the same rule. Omit it and every chip is assumed to sit
   * to the right, as it did before the frame width was available here.
   */
  width?: number;
  /**
   * Marks that are drawn but carry no label of their own.
   *
   * The trip's base square is one: it is painted from the frame's own `base`,
   * not from the marker list, so the selection could not see it and a chip was
   * placed squarely underneath it — the Mammoth explore view drew a name that
   * read "h Lakes". Anything on the drawing that a chip must not cover belongs
   * here.
   */
  obstacles?: readonly { x: number; y: number; radius: number }[];
}

export function selectLabels(candidates: readonly LabelCandidate[], options: LabelOptions): LabelSelection[] {
  const maxChars = options.maxChars ?? 22;
  const ordered = [...candidates]
    .filter((candidate) => candidate.kind !== 'unresolved' || candidate.id === options.selectedId)
    .sort((a, b) => {
      if (a.id === options.selectedId) return -1;
      if (b.id === options.selectedId) return 1;
      return LABEL_PRIORITY[a.kind] - LABEL_PRIORITY[b.kind] || a.label.localeCompare(b.label);
    });

  /*
   * The marks are obstacles too, not only the labels already placed.
   *
   * Every candidate's own mark is on the drawing whether or not it gets a
   * label, so a chip that clears every other chip and lands on a neighbouring
   * dot is still a collision — and it was the one the metric could not see.
   */
  const marks = [
    ...ordered.map((candidate) => ({ id: candidate.id, box: markBox(candidate) })),
    ...(options.obstacles ?? []).map((obstacle, index) => ({
      id: `obstacle:${index}`,
      box: { x: obstacle.x - obstacle.radius, y: obstacle.y, w: obstacle.radius * 2 },
    })),
  ];
  const placedBoxes: { x: number; y: number; w: number }[] = [];
  /*
   * ONE NAME PER BLOB.
   *
   * Two marks closer together than the gap a chip needs are one point on the
   * screen, and a name either side of one point does not say which dot it
   * belongs to — it says both, which is the smear the Bishkek screenshot
   * showed. So a mark that is already inside a labelled mark's personal space
   * yields entirely rather than taking the other side; priority decides which
   * of them that is.
   */
  const placedMarks: LabelCandidate[] = [];
  const sameBlob = (a: LabelCandidate, b: LabelCandidate): boolean =>
    Math.abs(a.y - b.y) < LABEL_HEIGHT &&
    Math.abs(a.x - b.x) < (a.radius ?? DEFAULT_MARKER_RADIUS) + (b.radius ?? DEFAULT_MARKER_RADIUS) + LABEL_GAP * 2;
  const out: LabelSelection[] = [];
  for (const candidate of ordered) {
    if (out.length >= options.max && candidate.id !== options.selectedId) break;
    const text = abbreviateLabel(candidate.label, maxChars);
    const selected = candidate.id === options.selectedId;
    if (!selected && placedMarks.some((placed) => sameBlob(placed, candidate))) continue;
    const clear = (box: { x: number; y: number; w: number }): boolean =>
      fitsInFrame(box, options.width) &&
      !placedBoxes.some((other) => overlaps(box, other)) &&
      !marks.some((mark) => mark.id !== candidate.id && overlaps(box, mark.box));

    /* Right first — the reading order — then left, and only then not at all. */
    const right = chipBox(candidate, text.length, 'right');
    const left = chipBox(candidate, text.length, 'left');
    const side: 'left' | 'right' | null = clear(right) ? 'right' : clear(left) ? 'left' : null;
    /* The selected label is drawn whatever it overlaps; everything else yields to what is already there. */
    if (side === null && !selected) continue;
    const chosen = side ?? (fitsInFrame(right, options.width) ? 'right' : 'left');
    placedBoxes.push(chipBox(candidate, text.length, chosen));
    placedMarks.push(candidate);
    out.push({ id: candidate.id, text, x: candidate.x, y: candidate.y, side: chosen });
  }
  return out;
}

/** How many labels a frame of this size and mode should carry. Fewer when zoomed out; fewer on a phone. */
export function labelBudget(input: { mode: MapMode; widthPx: number }): number {
  const base = input.mode === 'day' ? 8 : input.mode === 'overview' ? 7 : 12;
  if (input.widthPx < 420) return Math.max(3, Math.round(base * 0.5));
  if (input.widthPx < 720) return Math.max(4, Math.round(base * 0.75));
  return base;
}
