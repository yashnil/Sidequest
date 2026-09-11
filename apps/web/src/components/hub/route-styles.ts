import type { MapConnectorStyle } from '../InteractiveMap';

/**
 * V8 — ONE LINE PER WAY OF MOVING, AND THE LEGEND SAYS WHICH.
 *
 * The map draws a leg by how it moves and by what is known about it: a road
 * leg is solid, a rail leg long-dashed, a boat leg short-dashed on a wave, a
 * flight an arc, a trail dotted. Colour carries the second axis — the
 * cartographic teal for a journey somebody timed or an operator publishes,
 * umber for Sidequest's own estimate from map distance, faint ink for a
 * straight connector nobody could time. Every entry carries the sentence the
 * legend prints for it, so the drawing and its key cannot drift apart.
 */
export type LegShape = 'straight' | 'arc' | 'wave';

export interface LegLineStyle {
  stroke: string;
  dash?: string;
  width: number;
  opacity: number;
  shape: LegShape;
  /** What the legend says beside a sample of this line. */
  legend: string;
  /** Measured / estimated / operator-timed / not timed — the honesty axis, for the legend's grouping. */
  basis: 'measured' | 'estimated' | 'operator' | 'untimed' | 'conceptual';
}

export const LEG_LINE_STYLE: Record<MapConnectorStyle, LegLineStyle> = {
  measured_drive: { stroke: 'var(--color-map-route)', width: 3, opacity: 0.95, shape: 'straight', legend: 'By road — timed', basis: 'measured' },
  measured_transit: { stroke: 'var(--color-map-route)', dash: '9 5', width: 3, opacity: 0.95, shape: 'straight', legend: 'By bus or shuttle — timed', basis: 'measured' },
  measured_walk: { stroke: 'var(--color-pine)', dash: '1 5', width: 2.5, opacity: 0.9, shape: 'straight', legend: 'On foot — timed', basis: 'measured' },
  estimated: { stroke: 'var(--color-map-secondary)', dash: '6 5', width: 2.25, opacity: 0.85, shape: 'straight', legend: 'Estimated from map distance, not timed', basis: 'estimated' },
  unmeasured: { stroke: 'var(--color-ink-faint)', dash: '3 4', width: 1.5, opacity: 0.7, shape: 'straight', legend: 'Straight connector, not a route — nobody timed it', basis: 'untimed' },
  sightline: { stroke: 'var(--color-pine)', dash: '3 4', width: 1.5, opacity: 0.55, shape: 'straight', legend: 'A sightline from your base, not a route', basis: 'untimed' },
  conceptual: { stroke: 'var(--color-map-route)', dash: '7 6', width: 2, opacity: 0.65, shape: 'straight', legend: 'An idea, not a route — nothing is placed until the plan is built', basis: 'conceptual' },
  boat: { stroke: 'var(--color-map-route)', dash: '5 5', width: 3, opacity: 0.9, shape: 'wave', legend: 'By boat — on the operator’s timing', basis: 'operator' },
  rail: { stroke: 'var(--color-ink)', dash: '16 7', width: 2.5, opacity: 0.85, shape: 'straight', legend: 'By train — on the timetable', basis: 'operator' },
  flight: { stroke: 'var(--color-ink-faint)', dash: '2 6', width: 2, opacity: 0.8, shape: 'arc', legend: 'A flight — drawn as an arc, point to point', basis: 'operator' },
  trail: { stroke: 'var(--color-pine)', dash: '1 4', width: 2.5, opacity: 0.9, shape: 'straight', legend: 'On the trail — on the guide’s timing', basis: 'operator' },
};

/** The legend order: what was timed first, then what was estimated, then what nobody timed. */
const LEGEND_ORDER: MapConnectorStyle[] = ['measured_drive', 'measured_transit', 'measured_walk', 'rail', 'boat', 'flight', 'trail', 'estimated', 'unmeasured', 'sightline', 'conceptual'];

/** The legend entries for exactly the styles on the drawing, in a fixed order, once each. */
export function legendFor(styles: readonly MapConnectorStyle[]): { style: MapConnectorStyle; legend: string; basis: LegLineStyle['basis'] }[] {
  const present = new Set(styles);
  return LEGEND_ORDER.filter((style) => present.has(style)).map((style) => ({ style, legend: LEG_LINE_STYLE[style].legend, basis: LEG_LINE_STYLE[style].basis }));
}

interface Pixel {
  x: number;
  y: number;
}

/**
 * A flight as an arc: a quadratic curve whose control point sits off the
 * midpoint, perpendicular to the leg, by a fraction of its length. The bulge is
 * always to the same side of the direction of travel, so two flights that
 * cross never draw the same curve.
 */
export function arcPath(from: Pixel, to: Pixel, bulge = 0.18): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return `M${from.x.toFixed(1)} ${from.y.toFixed(1)}`;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const cx = mx - (dy / length) * length * bulge;
  const cy = my + (dx / length) * length * bulge;
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

/**
 * A boat leg as a wave: a polyline along the segment with a small sine offset
 * perpendicular to it. Amplitude and wavelength are in pixels and fixed, so a
 * short crossing and a long one read as the same kind of line.
 */
export function wavePath(from: Pixel, to: Pixel, amplitude = 2.5, wavelength = 14): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < wavelength) return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} L${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
  const ux = dx / length;
  const uy = dy / length;
  const steps = Math.max(8, Math.round((length / wavelength) * 6));
  const parts: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const along = t * length;
    const offset = index === 0 || index === steps ? 0 : Math.sin((along / wavelength) * Math.PI * 2) * amplitude;
    const x = from.x + ux * along - uy * offset;
    const y = from.y + uy * along + ux * offset;
    parts.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return parts.join(' ');
}

/** The SVG path for a straight leg drawn in the style's shape. */
export function legPath(style: MapConnectorStyle, from: Pixel, to: Pixel): string {
  const shape = LEG_LINE_STYLE[style].shape;
  if (shape === 'arc') return arcPath(from, to);
  if (shape === 'wave') return wavePath(from, to);
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} L${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}
