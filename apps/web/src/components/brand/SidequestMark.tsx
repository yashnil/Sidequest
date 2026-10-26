/**
 * THE SIDEQUEST MARK — "First Light" (2026-10).
 *
 * A flare sun rising behind a ridge, on a horizon line: the start of a day
 * outdoors, which is what a plan is for. Chosen by the owner from six
 * concepts (the S-route, a detour arch, contour rings, a pin, a compass star
 * and this one), compared at home-screen sizes and in every iOS and Android
 * mask.
 *
 * Geometry lives here once, on a 100-unit tile; the favicon, the app icons
 * and the manifest images are generated from the same shapes
 * (`app/icon.tsx`, `app/apple-icon.tsx`). Inline, the ridge and horizon take
 * `currentColor` — ink on bone, bone on night — and the sun is flare in
 * both. The dotted trail up the ridge is drawn only on the icon tile, where
 * the ground colour is known and the mark is large enough to carry it.
 */
export const MARK_SUN = { cx: 60, cy: 43, r: 14.5 } as const;
export const MARK_RIDGE_PATH = 'M17 72 L38 45 L47.5 55.5 L58 41 L83 72 Z';
export const MARK_TRAIL_PATH = 'M31 72 L42 61 L49 65 L56 54';
export const MARK_HORIZON_PATH = 'M17 77.5 H83';

export function SidequestMark({
  size = 24,
  className,
  waypoint = 'var(--color-flare)',
  title,
}: {
  size?: number;
  className?: string;
  /** The sun's colour (named for the old mark's waypoint, which callers already pass). */
  waypoint?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="12 22 76 62"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <circle cx={MARK_SUN.cx} cy={MARK_SUN.cy} r={MARK_SUN.r} fill={waypoint} />
      <path d={MARK_RIDGE_PATH} fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d={MARK_HORIZON_PATH} fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" />
    </svg>
  );
}

/** Mark + name, set in the display face with SOFT on. The name is real text, so it scales and reads to assistive tech. */
export function Wordmark({ className = '', markSize = 26 }: { className?: string; markSize?: number }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <SidequestMark size={markSize} />
      <span className="font-display font-semibold tracking-[-0.025em]">Sidequest</span>
    </span>
  );
}
