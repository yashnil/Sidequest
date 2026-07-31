import type { ReactNode } from 'react';
import type { FitBand, PlaceCategory } from '@sidequest/core';

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS = {
  primary: 'bg-ink text-paper hover:bg-ink-muted',
  secondary: 'border border-rule bg-paper-raised text-ink hover:border-ink-faint',
  ghost: 'text-ink-muted hover:text-ink hover:bg-paper-sunk',
} as const;

const BUTTON_SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5',
} as const;

export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = 'primary',
  size: keyof typeof BUTTON_SIZES = 'md',
): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

/**
 * A radio or checkbox that fills its label instead of being clipped away.
 *
 * `sr-only` inputs look identical but are not pointer targets — the label paints
 * over them — so the control has to be a transparent overlay. Keyboard and
 * screen-reader behaviour stay native; only the paint is borrowed by the label.
 */
export const OVERLAY_INPUT =
  'absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-[inherit] opacity-0';

/** Pairs with OVERLAY_INPUT: the label shows the focus ring the input cannot. */
export const FOCUS_RING =
  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-pine has-[:focus-visible]:outline-offset-2';

export function Panel({
  children,
  className,
  as: Tag = 'div',
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'aside';
  /**
   * The id of the heading that names this panel. Named explicitly rather than
   * spreading arbitrary props: a `Panel as="section"` with no accessible name is
   * not a landmark, and a screen reader announces it as an unlabelled region.
   */
  labelledBy?: string;
}) {
  return (
    <Tag
      className={cx(
        'rounded-[var(--radius-card)] border border-rule bg-paper-raised',
        className,
      )}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
    >
      {children}
    </Tag>
  );
}

const BADGE_TONES = {
  neutral: 'border-rule text-ink-muted',
  pine: 'border-transparent bg-pine-soft text-pine',
  amber: 'border-transparent bg-amber-soft text-amber',
  blue: 'border-transparent bg-slate-blue-soft text-slate-blue',
  clay: 'border-transparent bg-clay-soft text-clay',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const BAND_TONE: Record<FitBand, BadgeTone> = {
  top_pick: 'pine',
  strong: 'pine',
  good: 'blue',
  optional: 'neutral',
  weak: 'neutral',
  not_workable: 'clay',
};

/**
 * Five coarse steps and a word. The underlying score is a weighted heuristic, not
 * a measurement, so showing "83.4% match" would be a lie told with a decimal
 * point.
 */
export function FitMeter({ band, label, meter }: { band: FitBand; label: string; meter: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="flex gap-[3px]" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((step) => (
          <span
            key={step}
            className={cx(
              'h-1.5 w-4 rounded-full',
              step <= meter
                ? band === 'not_workable'
                  ? 'bg-clay'
                  : 'bg-pine'
                : 'bg-rule',
            )}
          />
        ))}
      </span>
      <Badge tone={BAND_TONE[band]}>{label}</Badge>
    </span>
  );
}

/**
 * No external image APIs are wired up yet, so rather than ship broken thumbnails
 * or grey rectangles this draws a deterministic plate per place: a colour pair
 * derived from the id and a mark for the category. Same place, same plate, every
 * render.
 */
const CATEGORY_MARK: Record<PlaceCategory, string> = {
  viewpoint: 'M2 20 L9 8 L14 15 L18 10 L23 20 Z',
  day_hike: 'M2 21 L8 9 L12 15 L16 6 L23 21 Z',
  easy_walk: 'M3 18 Q8 10 12 14 T22 9',
  lake: 'M2 15 Q7 11 12 15 T22 15 M2 19 Q7 15 12 19 T22 19',
  scenic_drive: 'M8 22 L11 4 M16 22 L13 4 M11.5 9 h1 M11.5 15 h1',
  geothermal: 'M8 20 Q6 14 9 11 Q10 15 12 12 Q14 8 13 5 Q19 10 17 16 Q16 19 14 20 Z',
  hot_spring: 'M4 18 Q12 12 20 18 M9 10 q2 -3 0 -6 M15 10 q2 -3 0 -6',
  historic_site: 'M4 21 V9 l8 -5 l8 5 v12 Z M10 21 v-6 h4 v6',
  museum: 'M3 20 h18 M5 20 V10 M10 20 V10 M14 20 V10 M19 20 V10 M2 9 L12 3 L22 9 Z',
  town_and_food: 'M5 21 V8 h6 v13 M13 21 V4 h6 v17 M7 11 h2 M7 15 h2 M15 8 h2 M15 12 h2',
  gondola_or_tram: 'M3 5 L21 11 M9 8.5 V12 M7 12 h10 v6 H7 Z',
  national_monument: 'M4 21 V10 l3 -4 l3 4 v11 M12 21 V7 l3 -4 l3 4 v14',
  wildlife_area: 'M6 20 q0 -8 6 -8 t6 8 M9 9 q-2 -4 0 -6 M15 9 q2 -4 0 -6',
};

const PLATE_PALETTES = [
  ['#2f5d50', '#7f9e8f'],
  ['#3c5a77', '#8fa9bf'],
  ['#a85c22', '#d3a172'],
  ['#5a5340', '#9c9480'],
  ['#4a3f55', '#9b8fa6'],
  ['#1f4b4a', '#79a3a0'],
];

function hashId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function PlacePlate({
  placeId,
  category,
  className,
}: {
  placeId: string;
  category: PlaceCategory;
  className?: string;
}) {
  const hash = hashId(placeId);
  const palette = PLATE_PALETTES[hash % PLATE_PALETTES.length] ?? PLATE_PALETTES[0]!;
  const [from, to] = palette;
  const angle = 120 + (hash % 5) * 15;

  return (
    <div
      className={cx('relative overflow-hidden', className)}
      style={{ background: `linear-gradient(${angle}deg, ${from}, ${to})` }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        className="absolute inset-0 h-full w-full opacity-30"
        fill="none"
        stroke="#fff"
        strokeWidth="0.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        preserveAspectRatio="xMidYMid meet"
      >
        <path d={CATEGORY_MARK[category]} />
      </svg>
    </div>
  );
}

export function Fieldset({
  legend,
  hint,
  children,
  className,
}: {
  legend: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx('min-w-0', className)}>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      {hint ? <p className="mt-1 text-sm text-ink-muted">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </fieldset>
  );
}

export function ErrorNote({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="mt-2 flex gap-2 text-sm text-clay">
      <span aria-hidden="true">▲</span>
      <span>{children}</span>
    </p>
  );
}
