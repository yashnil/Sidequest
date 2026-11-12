/**
 * THE SHAPES A PHOTOGRAPH IS SHOWN IN, AND THE ARITHMETIC OF FITTING ONE.
 *
 * Import-free on purpose: the server-side selector (`select.ts`) and the
 * client component (`components/MediaImage.tsx`) read the same table, so the
 * gate that admitted a file for a "hero" and the frame that draws the hero can
 * never disagree about what a hero is.
 *
 * Four visual contexts:
 *
 * - `hero`  — the large, top-of-page frame. 16:9, drawn up to ~1440 CSS px.
 * - `card`  — a recommendation or board card. 3:2, up to ~640 CSS px.
 * - `thumb` — a small square-ish tile. 1:1, up to ~200 CSS px.
 * - `strip` — a wide banner. 7:2, the shape a Wikivoyage page banner was cut for.
 *
 * Every number about a source file here is about the ORIGINAL file, never a
 * thumbnail of it: a 960 px thumbnail of a 6000 px photograph is not a small
 * photograph, and a 960 px original is not a large one.
 */

export const MEDIA_CONTEXTS = ['hero', 'card', 'thumb', 'strip'] as const;
export type MediaContext = (typeof MEDIA_CONTEXTS)[number];

export interface MediaContextSpec {
  /** The frame's width / height. */
  aspect: number;
  /** The same, as a CSS `aspect-ratio` value. */
  cssAspect: string;
  /** The smallest original width that can fill this frame at its usual size on a dense screen. */
  minSourceWidth: number;
  /** The smallest original short edge, for frames that are not much wider than tall. */
  minSourceShortEdge: number;
  /** Original width / height outside this range is the wrong shape for this frame. */
  sourceAspect: readonly [number, number];
  /** The widest CSS width this frame is drawn at; the srcset never needs more than twice this. */
  displayWidth: number;
}

export const MEDIA_CONTEXT_SPECS: Record<MediaContext, MediaContextSpec> = {
  /*
   * The research gate (docs/experience-transformation/research.md §1): original
   * ≥ 1920 wide and 1.3–2.5. A 4:3 file loses a quarter of its height to a
   * 16:9 frame, which a focal point makes acceptable; a portrait would lose
   * two-thirds and is refused.
   */
  hero: { aspect: 16 / 9, cssAspect: '16 / 9', minSourceWidth: 1920, minSourceShortEdge: 1000, sourceAspect: [1.3, 2.5], displayWidth: 1440 },
  card: { aspect: 3 / 2, cssAspect: '3 / 2', minSourceWidth: 1280, minSourceShortEdge: 720, sourceAspect: [1.2, 2.4], displayWidth: 640 },
  thumb: { aspect: 1, cssAspect: '1 / 1', minSourceWidth: 500, minSourceShortEdge: 330, sourceAspect: [0.75, 2.0], displayWidth: 200 },
  /*
   * A strip is where the Wikivoyage banner (P948, cut at 7:1 for exactly this
   * use) belongs. An ordinary landscape is admitted too, cropped by its focal
   * point, but it has to be wide enough that the strip is not a blur.
   */
  strip: { aspect: 7 / 2, cssAspect: '7 / 2', minSourceWidth: 1920, minSourceShortEdge: 270, sourceAspect: [1.3, 8], displayWidth: 1440 },
};

/**
 * The only widths Wikimedia renders thumbnails at. Anything else is refused at
 * the edge with a 429/400 (mediawiki.org/wiki/Common_thumbnail_sizes).
 */
export const COMMONS_STANDARD_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840] as const;

/** The largest standard width at or below `limit`, or null when even 20 px is too wide. */
export function standardWidthAtMost(limit: number): number | null {
  let best: number | null = null;
  for (const width of COMMONS_STANDARD_WIDTHS) if (width <= limit) best = width;
  return best;
}

/**
 * Standard widths a frame of this context could use, never wider than the
 * original (Wikimedia does not upscale, and neither do we) and never more than
 * twice the frame's widest drawing.
 */
export function srcsetWidthsFor(context: MediaContext, originalWidth: number): number[] {
  const ceiling = Math.min(originalWidth, MEDIA_CONTEXT_SPECS[context].displayWidth * 2);
  const floor = Math.min(330, ceiling);
  return COMMONS_STANDARD_WIDTHS.filter((width) => width >= floor && width <= ceiling);
}

/**
 * What fraction of the image a cover crop into this frame throws away.
 * 0 when the shapes agree; 0.25 for a 4:3 photograph in a 16:9 frame.
 */
export function cropLoss(imageAspect: number, frameAspect: number): number {
  if (!(imageAspect > 0) || !(frameAspect > 0)) return 1;
  return imageAspect > frameAspect ? 1 - frameAspect / imageAspect : 1 - imageAspect / frameAspect;
}

export interface FocalPoint {
  /** 0 = left edge, 1 = right edge, of the whole original. */
  x: number;
  /** 0 = top edge, 1 = bottom edge. */
  y: number;
}

export const CENTRE: FocalPoint = { x: 0.5, y: 0.5 };

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

/**
 * The CSS `object-position` that keeps a focal point in view.
 *
 * With `object-fit: cover`, a percentage position `p` aligns the point `p` of
 * the image with the point `p` of the frame — so the visible window starts at
 * `p × (1 − visible)`. Solving for a window centred on the focal point, then
 * clamping it inside the image, gives the percentage. Computed for any frame
 * shape, so one stored focal point serves every context.
 */
export function objectPositionFor(focal: FocalPoint, imageAspect: number, frameAspect: number): string {
  const fx = clamp01(focal.x);
  const fy = clamp01(focal.y);
  let px = 50;
  let py = 50;
  if (imageAspect > frameAspect && imageAspect > 0) {
    const visible = frameAspect / imageAspect;
    const left = Math.min(1 - visible, Math.max(0, fx - visible / 2));
    px = visible >= 1 ? 50 : (left / (1 - visible)) * 100;
  } else if (imageAspect < frameAspect && frameAspect > 0) {
    const visible = imageAspect / frameAspect;
    const top = Math.min(1 - visible, Math.max(0, fy - visible / 2));
    py = visible >= 1 ? 50 : (top / (1 - visible)) * 100;
  }
  const round = (value: number): number => Math.round(value * 10) / 10;
  return `${round(px)}% ${round(py)}%`;
}

/**
 * The focal point a sharp `attention` crop implies.
 *
 * sharp reports where it cut (`cropOffsetLeft/Top`) a `cropWidth × cropHeight`
 * window out of a `width × height` image; the centre of that window is the
 * subject it found.
 */
export function focalFromCrop(input: { width: number; height: number; cropWidth: number; cropHeight: number; left: number; top: number }): FocalPoint {
  if (!(input.width > 0) || !(input.height > 0)) return CENTRE;
  return {
    x: clamp01((input.left + input.cropWidth / 2) / input.width),
    y: clamp01((input.top + input.cropHeight / 2) / input.height),
  };
}
