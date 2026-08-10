import { DAY_REACH_KM, type PreflightPortfolio } from '@sidequest/core';
import { formatMinutes } from '@/lib/format';
import {
  chooseScaleBar,
  fitMercator,
  geodesicRing,
  type GeoPoint,
  type MapViewport,
  type Pixel,
  type ScaleBar,
} from './map-projection';

/**
 * WHAT THE REGION FIGURE IS, WORKED OUT BEFORE ANY OF IT IS DRAWN.
 *
 * Everything geometric about the figure lives here, as a pure function of a
 * portfolio, so that the component beside it is only markup. Two reasons, and
 * neither is tidiness:
 *
 *   1. **Label collision is an algorithm, not a style.** The previous figure
 *      alternated labels above and below the mark and said so in a comment that
 *      admitted it was "not a general solution ... it is the cheap one that
 *      fixes the case that actually occurs, which is two or three marks in a
 *      cluster". The product now draws bases *and* their day-trip satellites
 *      *and* the areas left out — six to twelve marks, routinely clustered —
 *      and alternating produces exactly the overprinted mush it was introduced
 *      to prevent. What replaces it is candidate placement against a set of
 *      occupied boxes, which can be asserted rather than eyeballed.
 *   2. **The text alternative has to be built from the same decision as the
 *      picture.** A hand-written `aria-label` drifts from the drawing the first
 *      time either changes. Both come out of this function, so a mark that is
 *      not drawn cannot be described and a mark that is drawn cannot be missing
 *      from the description.
 *
 * WHAT IS AND IS NOT DRAWN. Every mark is one indexed source coordinate carried
 * on `PreflightCluster.center`. Every ring is a true ground distance walked out
 * from a real coordinate. There is no coastline, no border, no road and no
 * landmass anywhere in the output, because we have not read one — §32 forbids a
 * fake map visual labelled as a real one, and the honest form of that
 * prohibition is a figure whose every stroke can be traced to a number we hold.
 */

/** Kept small: this is an aside panel, not a page. */
export const FIGURE_WIDTH = 320;
export const FIGURE_HEIGHT = 250;

/**
 * Room around the marks for their labels, and a strip at the bottom for the
 * scale bar. Asymmetric on purpose — the scale bar and the projection note live
 * below the frame, and a mark drawn into that band would collide with them.
 */
const INSETS = { top: 26, right: 30, bottom: 46, left: 30 };

/** The floor on the ground a frame may represent. See `fitMercator`. */
const MIN_SPAN_KM = 2;

const BASE_RADIUS = 6.5;
const SATELLITE_RADIUS = 3.6;
const EXCLUDED_RADIUS = 3;

const LABEL_FONT = 9.5;
const LABEL_LINE = 10;
/**
 * Mean glyph advance as a fraction of font size, for the UI sans stack.
 *
 * An estimate, and it only has to be an over-estimate: a label box that is
 * modelled slightly too wide gets pushed to its next candidate position, which
 * costs a little space. One modelled too narrow overlaps its neighbour, which is
 * the failure being fixed.
 */
const CHAR_WIDTH = 0.58;
const MAX_LABEL_CHARS = 18;

export type MarkRole = 'base' | 'satellite' | 'excluded';

export interface FigureLabel {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  lines: string[];
  fontSize: number;
}

export interface FigureMark {
  id: string;
  role: MarkRole;
  name: string;
  at: Pixel;
  radius: number;
  /** 1-based place in the route. Bases only. */
  order: number | null;
  /** Nights the base holds, or minutes out and back for a satellite. */
  nights: number | null;
  transferMinutes: number | null;
  /** Why this is a base, or why it was left out. Traveller-facing prose. */
  note: string | null;
  /** The base a satellite hangs off. */
  baseId: string | null;
  label: FigureLabel | null;
}

export interface FigureEdge {
  id: string;
  kind: 'transfer' | 'day_trip';
  from: Pixel;
  to: Pixel;
  minutes: number;
  label: FigureLabel | null;
}

export interface FigureRing {
  id: string;
  kind: 'day_reach' | 'region_reach';
  radiusKm: number;
  path: string;
}

export interface RegionFigure {
  width: number;
  height: number;
  viewport: MapViewport;
  marks: FigureMark[];
  edges: FigureEdge[];
  rings: FigureRing[];
  scale: ScaleBar & { x: number; y: number };
  /** The latitude the scale bar is exact at. Mercator varies across a frame. */
  scaleLatitude: number;
  /** One sentence naming the structure. The figure's accessible name. */
  summary: string;
  dayReachKm: number;
  /** How far the structure reaches overall. Stated even when it is not drawn. */
  regionReachKm: number | null;
  /** Whether that reach fitted inside the frame. A legend must not point at nothing. */
  regionRingDrawn: boolean;
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function overlaps(a: Box, b: Box): boolean {
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

function truncate(name: string): string {
  return name.length <= MAX_LABEL_CHARS ? name : `${name.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function labelBox(label: FigureLabel): Box {
  const width =
    Math.max(...label.lines.map((line) => line.length)) * label.fontSize * CHAR_WIDTH;
  const x1 =
    label.anchor === 'start'
      ? label.x
      : label.anchor === 'end'
        ? label.x - width
        : label.x - width / 2;
  return {
    x1,
    x2: x1 + width,
    y1: label.y - label.fontSize * 0.85,
    y2: label.y + (label.lines.length - 1) * LABEL_LINE + label.fontSize * 0.3,
  };
}

/**
 * Place a label near a mark, or refuse.
 *
 * Eight candidate positions in preference order — under, over, beside, then the
 * diagonals — and the first that is both inside the frame and clear of
 * everything already placed wins. Refusing is a real outcome and a deliberate
 * one: a name printed across another name is worse than no name, because it
 * reads as one corrupted word rather than as an omission, and every mark is
 * named in the text alternative regardless.
 */
function placeLabel(
  at: Pixel,
  radius: number,
  lines: string[],
  fontSize: number,
  occupied: Box[],
  frame: Box,
): FigureLabel | null {
  /*
   * Two rings of eight positions, near ones first.
   *
   * One ring was not enough, and the case that proved it is in the tests: two
   * bases projecting eight pixels apart: the first label takes the good spot,
   * and the second has nowhere within touching distance that is not already
   * occupied — so a *base*, the thing the whole screen is deciding about, lost
   * its name. A second ring gives it somewhere to go, sixteen pixels further
   * out, which is close enough that proximity still attributes it and the
   * `Base n` line on the label settles any remaining doubt. A leader hairline
   * was built for this and then removed: at these offsets it never once fired,
   * and a stroke that no data reaches is a stroke nobody can check.
   */
  const candidates: Omit<FigureLabel, 'lines' | 'fontSize'>[] = [];
  for (const extra of [0, 16]) {
    const out = radius + extra;
    candidates.push(
      { x: at.x, y: at.y + out + fontSize + 1, anchor: 'middle' },
      { x: at.x, y: at.y - out - 4, anchor: 'middle' },
      { x: at.x + out + 4, y: at.y + fontSize * 0.35, anchor: 'start' },
      { x: at.x - out - 4, y: at.y + fontSize * 0.35, anchor: 'end' },
      { x: at.x + out + 2, y: at.y + out + fontSize + 1, anchor: 'start' },
      { x: at.x - out - 2, y: at.y + out + fontSize + 1, anchor: 'end' },
      { x: at.x + out + 2, y: at.y - out - 4, anchor: 'start' },
      { x: at.x - out - 2, y: at.y - out - 4, anchor: 'end' },
    );
  }

  for (const candidate of candidates) {
    const label: FigureLabel = { ...candidate, lines, fontSize };
    const box = labelBox(label);
    if (box.x1 < frame.x1 || box.x2 > frame.x2 || box.y1 < frame.y1 || box.y2 > frame.y2) continue;
    if (occupied.some((other) => overlaps(box, other))) continue;
    occupied.push(box);
    return label;
  }
  return null;
}

/**
 * Place a label somewhere along a leg.
 *
 * A leg's label has something a mark's label does not: freedom to slide. Trying
 * only the midpoint lost the transfer time whenever two base labels happened to
 * meet in the middle of the line between them — which is exactly where two base
 * labels tend to meet. Sliding along the leg keeps the number attached to the
 * thing it describes while giving it five chances instead of one.
 */
function placeAlong(
  from: Pixel,
  to: Pixel,
  lines: string[],
  fontSize: number,
  occupied: Box[],
  frame: Box,
): FigureLabel | null {
  for (const t of [0.5, 0.38, 0.62, 0.28, 0.72]) {
    const at = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    const placed = placeLabel(at, 3, lines, fontSize, occupied, frame);
    if (placed) return placed;
  }
  return null;
}

/**
 * A travel time that carries its own uncertainty.
 *
 * The `≈` is not decoration. `transferMinutes` is a straight-line distance over
 * an assumed door-to-door speed — the schema says so twice — and a bare "2 hr 15
 * min" on a picture is read as a routed time. The wording is shared with the
 * rest of the product via `formatMinutes` so the figure and the panel beside it
 * cannot describe the same leg two different ways.
 */
export function estimatedTravel(minutes: number): string {
  return `≈${formatMinutes(Math.round(minutes))}`;
}

function ringPath(viewport: MapViewport, centre: GeoPoint, radiusKm: number): string {
  const points = geodesicRing(centre, radiusKm, 72).map((point) => viewport.project(point));
  return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')} Z`;
}

/**
 * Turn a portfolio into everything the figure draws and everything it says.
 */
export function buildRegionFigure(portfolio: PreflightPortfolio, title: string): RegionFigure | null {
  if (portfolio.route.length === 0) return null;

  const dayReachKm = DAY_REACH_KM[portfolio.mode];
  const anchor = portfolio.route[0]!;
  /*
   * `reachRadiusKm` is the *structure's* reach from the first base — the
   * furthest thing it holds plus a day's reach — not a day's reach itself. Drawn
   * as one ring round the anchor it answers "what does Sidequest think this
   * region is"; drawn round every base it would be a much larger claim than the
   * schema makes. The per-base rings use `DAY_REACH_KM`, which is the same
   * constant `chooseBaseStructure` decided with, imported rather than restated
   * so the picture and the decision cannot drift.
   */
  const regionReachKm =
    portfolio.reachRadiusKm && portfolio.reachRadiusKm > dayReachKm + 1
      ? portfolio.reachRadiusKm
      : null;

  const centres: GeoPoint[] = [
    ...portfolio.route.map((cluster) => cluster.center),
    ...portfolio.satellites.map((entry) => entry.cluster.center),
    ...portfolio.excluded.map((entry) => entry.cluster.center),
  ];

  /*
   * The day-reach rings are part of the extent, not decoration on top of it.
   * Fitting to the marks alone clipped every ring at the frame edge, which turns
   * a statement about distance into an arc of unexplained dashes.
   *
   * The *structure* reach deliberately does not get a vote. A first capture had
   * a 228 km region radius around bases sixty kilometres apart: everything the
   * traveller was being asked to decide about collapsed into a knot in the
   * middle of a mostly empty circle. The picture is about the structure, so the
   * structure sets the frame and the wider claim fits inside it or is not drawn.
   */
  const extent: GeoPoint[] = [...centres];
  for (const cluster of portfolio.route) {
    extent.push(...geodesicRing(cluster.center, dayReachKm, 8));
  }

  const viewport = fitMercator({
    points: extent,
    width: FIGURE_WIDTH,
    height: FIGURE_HEIGHT,
    insets: INSETS,
    minSpanKm: MIN_SPAN_KM,
  });

  const rings: FigureRing[] = [];
  /*
   * Drawn only when the whole ring is on the canvas. A circle that leaves the
   * frame entirely is a legend entry pointing at nothing, and a circle that
   * grazes one corner is read as a border rather than as a radius — both worse
   * than saying the number in words, which the caller still does.
   */
  const regionRingFits =
    regionReachKm !== null &&
    geodesicRing(anchor.center, regionReachKm, 16)
      .map((point) => viewport.project(point))
      .every(
        (at) => at.x >= 0 && at.x <= FIGURE_WIDTH && at.y >= 0 && at.y <= FIGURE_HEIGHT,
      );
  if (regionReachKm !== null && regionRingFits) {
    rings.push({
      id: 'region',
      kind: 'region_reach',
      radiusKm: regionReachKm,
      path: ringPath(viewport, anchor.center, regionReachKm),
    });
  }
  for (const cluster of portfolio.route) {
    rings.push({
      id: `day:${cluster.id}`,
      kind: 'day_reach',
      radiusKm: dayReachKm,
      path: ringPath(viewport, cluster.center, dayReachKm),
    });
  }

  const reasonById = new Map(portfolio.baseReasons.map((entry) => [entry.clusterId, entry]));
  const projected = new Map(portfolio.route.map((cluster) => [cluster.id, viewport.project(cluster.center)]));

  /*
   * The frame the labels must stay inside, and the fixtures they must stay off.
   *
   * The scale bar and the north indicator are drawn last but reserved first,
   * because a label placed into the space they will occupy is a collision that
   * only appears in the rendered picture.
   */
  const frame: Box = { x1: 2, y1: 2, x2: FIGURE_WIDTH - 2, y2: FIGURE_HEIGHT - 2 };
  const occupied: Box[] = [
    { x1: 4, y1: FIGURE_HEIGHT - 30, x2: 150, y2: FIGURE_HEIGHT - 2 },
    { x1: FIGURE_WIDTH - 30, y1: 2, x2: FIGURE_WIDTH - 2, y2: 34 },
  ];

  // Every mark occupies its own disc, so no label may be printed over one.
  const discs: { at: Pixel; radius: number }[] = [
    ...portfolio.route.map((cluster) => ({ at: viewport.project(cluster.center), radius: BASE_RADIUS })),
    ...portfolio.satellites.map((entry) => ({
      at: viewport.project(entry.cluster.center),
      radius: SATELLITE_RADIUS,
    })),
    ...portfolio.excluded.map((entry) => ({
      at: viewport.project(entry.cluster.center),
      radius: EXCLUDED_RADIUS,
    })),
  ];
  for (const disc of discs) {
    occupied.push({
      x1: disc.at.x - disc.radius - 1,
      y1: disc.at.y - disc.radius - 1,
      x2: disc.at.x + disc.radius + 1,
      y2: disc.at.y + disc.radius + 1,
    });
  }

  /*
   * Placement order is importance order, because the first label placed gets the
   * best position and the last may get none. A base is the decision the screen
   * is about; an excluded area is a footnote with a full sentence of its own in
   * the text alternative.
   */
  const marks: FigureMark[] = [];

  portfolio.route.forEach((cluster, index) => {
    const at = projected.get(cluster.id)!;
    const reason = reasonById.get(cluster.id);
    marks.push({
      id: cluster.id,
      role: 'base',
      name: cluster.name,
      at,
      radius: BASE_RADIUS,
      order: index + 1,
      nights: reason?.nights ?? null,
      transferMinutes: index === 0 ? null : (reason?.transferMinutes ?? null),
      note: reason?.reason ?? null,
      baseId: null,
      label: placeLabel(
        at,
        BASE_RADIUS,
        /*
         * THE SECOND LINE NAMES THE MARK, NOT ONLY THE NIGHTS.
         *
         * From a capture: two bases projected eight pixels apart, one label
         * placed left and one right, and nothing on either of them said which
         * disc it belonged to. Repeating the numeral that is drawn inside the
         * disc costs six characters and removes the ambiguity wherever the
         * label ends up — which a leader line does not, because every candidate
         * position is already touching its mark.
         */
        [
          truncate(cluster.name),
          reason && reason.nights > 0
            ? `Base ${index + 1} · ${reason.nights} night${reason.nights === 1 ? '' : 's'}`
            : `Base ${index + 1}`,
        ],
        LABEL_FONT,
        occupied,
        frame,
      ),
    });
  });

  /*
   * The legs come next, ahead of the satellites, and the order is the finding
   * from a live capture rather than a preference: placed last, every transfer
   * label lost its space to a satellite name and the picture showed a plan with
   * two bases and no statement of what moving between them costs — which is one
   * of the six questions §19.2 puts to this preview.
   */
  const edges: FigureEdge[] = [];
  portfolio.route.forEach((cluster, index) => {
    if (index === 0) return;
    const previous = portfolio.route[index - 1]!;
    const from = projected.get(previous.id)!;
    const to = projected.get(cluster.id)!;
    const minutes = reasonById.get(cluster.id)?.transferMinutes ?? 0;
    edges.push({
      id: `${previous.id}->${cluster.id}`,
      kind: 'transfer',
      from,
      to,
      minutes,
      label:
        minutes > 0
          ? placeAlong(from, to, [estimatedTravel(minutes)], LABEL_FONT - 1, occupied, frame)
          : null,
    });
  });

  for (const entry of portfolio.satellites) {
    const at = viewport.project(entry.cluster.center);
    marks.push({
      id: entry.cluster.id,
      role: 'satellite',
      name: entry.cluster.name,
      at,
      radius: SATELLITE_RADIUS,
      order: null,
      nights: null,
      transferMinutes: entry.transferMinutes,
      note: null,
      baseId: entry.baseId,
      label: placeLabel(
        at,
        SATELLITE_RADIUS,
        [truncate(entry.cluster.name), estimatedTravel(entry.transferMinutes)],
        LABEL_FONT - 0.5,
        occupied,
        frame,
      ),
    });
  }

  for (const entry of portfolio.excluded) {
    const at = viewport.project(entry.cluster.center);
    marks.push({
      id: entry.cluster.id,
      role: 'excluded',
      name: entry.cluster.name,
      at,
      radius: EXCLUDED_RADIUS,
      order: null,
      nights: null,
      transferMinutes: entry.cluster.transferMinutesFromGateway,
      note: entry.reason,
      baseId: null,
      label: placeLabel(
        at,
        EXCLUDED_RADIUS,
        [truncate(entry.cluster.name)],
        LABEL_FONT - 1,
        occupied,
        frame,
      ),
    });
  }

  for (const entry of portfolio.satellites) {
    const from = projected.get(entry.baseId);
    if (!from) continue;
    edges.push({
      id: `${entry.baseId}~${entry.cluster.id}`,
      kind: 'day_trip',
      from,
      to: viewport.project(entry.cluster.center),
      minutes: entry.transferMinutes,
      // Named on the satellite's own label; a second copy on the spoke would be
      // the same number twice in a picture that has little room for one.
      label: null,
    });
  }

  const scaleBar = chooseScaleBar(
    viewport.kmPerPixelAt(viewport.centreLatitude),
    (FIGURE_WIDTH - INSETS.left - INSETS.right) * 0.45,
  );

  return {
    width: FIGURE_WIDTH,
    height: FIGURE_HEIGHT,
    viewport,
    marks,
    edges,
    rings,
    scale: { ...scaleBar, x: 8, y: FIGURE_HEIGHT - 18 },
    scaleLatitude: viewport.centreLatitude,
    summary: summarise(portfolio, title),
    dayReachKm,
    regionReachKm,
    regionRingDrawn: regionReachKm !== null && regionRingFits,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The figure's accessible name.
 *
 * Deliberately the structure rather than the drawing: "four marks and a dashed
 * line" describes the image, and nobody needs a description of an image. What a
 * traveller who cannot see this needs is the same conclusion a sighted traveller
 * takes from it — how many bases, how much is reachable without moving, and how
 * much was left out. The full per-area detail follows in a real list.
 */
function summarise(portfolio: PreflightPortfolio, title: string): string {
  const parts = [
    plural(portfolio.route.length, 'base', 'bases'),
    plural(portfolio.satellites.length, 'area reachable in a day', 'areas reachable in a day'),
  ];
  if (portfolio.excluded.length > 0) {
    parts.push(plural(portfolio.excluded.length, 'area left out', 'areas left out'));
  }
  return `${title}: ${parts.join(', ')}. North is up; distances are straight-line estimates.`;
}
