import type { ReactNode } from 'react';
import {
  displayNameOf,
  localNameOf,
  type DisplayName,
  type FitBand,
  type PlaceCategory,
} from '@sidequest/core';

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

/**
 * Both sizes clear 44 px, which is what "small" is allowed to mean.
 *
 * `sm` was 28 px tall and `md` 40 px, so every secondary action in the product —
 * "Change my answers", "Fetch it again", the acknowledgement on a removed place —
 * was under WCAG 2.5.5's 44 px minimum target size. On a phone that is the
 * difference between a control and a coin toss, and it is worse here than the
 * numbers suggest, because the small size is used almost exclusively for the
 * actions somebody takes *after* they have already read something and made up
 * their mind.
 *
 * `min-h-11` rather than more padding: the visual weight of a small button is
 * carried by its type size and horizontal padding, both of which are unchanged,
 * so the control looks the same and is twice the target.
 */
const BUTTON_SIZES = {
  sm: 'min-h-11 px-3 py-1.5 text-xs',
  md: 'min-h-11 px-4 py-2.5',
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
  testId,
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
  /**
   * A test hook, named explicitly for the same reason `labelledBy` is.
   *
   * Not spread props. A caller passing `data-testid` to a component that does
   * not forward it gets silence rather than an error — which cost this phase two
   * green-looking tests that were asserting on an element nobody could select.
   * An explicit prop makes the mistake a type error.
   */
  testId?: string;
}) {
  return (
    <Tag
      className={cx(
        'rounded-[var(--radius-card)] border border-rule bg-paper-raised',
        className,
      )}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
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

/**
 * A labelled form control label, at one size.
 *
 * A component rather than a class string because the same three utilities had
 * drifted into four variants across the flow, and a heading that is 11px on one
 * screen and 14px on the next reads as two different products.
 */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {children}
    </label>
  );
}

/**
 * A group of radios or checkboxes rendered as selectable cards.
 *
 * Native inputs throughout, overlaid rather than hidden, so keyboard traversal,
 * grouping and screen-reader announcement are the browser's rather than ours.
 * `columns` is a layout hint, not a breakpoint: two options should not be
 * stretched across four columns on a wide screen.
 */
export function ChoiceGroup({
  legend,
  hint,
  columns = 2,
  className,
  children,
}: {
  legend: string;
  hint?: string;
  columns?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const grid =
    columns === 4
      ? 'sm:grid-cols-4'
      : columns === 3
        ? 'sm:grid-cols-3'
        : 'sm:grid-cols-2';
  return (
    <fieldset className={cx('min-w-0', className)}>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      {hint ? <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">{hint}</p> : null}
      <div className={cx('mt-3 grid gap-2', grid)}>{children}</div>
    </fieldset>
  );
}

export function Choice({
  name,
  value,
  checked,
  onChange,
  label,
  detail,
  type = 'radio',
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  detail?: string;
  type?: 'radio' | 'checkbox';
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        'relative flex min-w-0 flex-col rounded-lg border px-3.5 py-2.5 text-left transition-colors',
        FOCUS_RING,
        disabled
          ? 'cursor-not-allowed border-dashed border-rule opacity-60'
          : checked
            ? 'cursor-pointer border-pine bg-pine-soft'
            : 'cursor-pointer border-rule bg-paper-raised hover:border-ink-faint',
      )}
    >
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className={cx(OVERLAY_INPUT, disabled && 'cursor-not-allowed')}
      />
      <span className={cx('text-sm', checked ? 'font-medium text-pine' : 'text-ink')}>{label}</span>
      {detail ? <span className="mt-0.5 text-xs leading-relaxed text-ink-muted">{detail}</span> : null}
    </label>
  );
}

/**
 * How certain we are about something, as a colour with a word attached.
 *
 * The four states are the same four everywhere they appear — a board card, a
 * compilation phase, a date window — and the word is never dropped in favour of
 * the colour, because a status carried only by hue is one a colour-blind
 * traveller does not have.
 */
export type EvidenceState = 'provisional' | 'verifying' | 'verified' | 'conflicted' | 'unavailable';

const EVIDENCE_STYLE: Record<EvidenceState, { className: string; label: string }> = {
  provisional: { className: 'bg-provisional-soft text-provisional', label: 'Provisional' },
  verifying: { className: 'bg-verifying-soft text-verifying', label: 'Checking' },
  verified: { className: 'bg-verified-soft text-verified', label: 'Verified' },
  conflicted: { className: 'bg-conflicted-soft text-conflicted', label: 'Sources disagree' },
  unavailable: { className: 'border border-rule text-ink-faint', label: 'Not established' },
};

export function EvidenceBadge({ state, children }: { state: EvidenceState; children?: ReactNode }) {
  const style = EVIDENCE_STYLE[state];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight',
        style.className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {children ?? style.label}
    </span>
  );
}

/** A section heading with an eyebrow, used at the top of every flow screen. */
export function PageHeading({
  eyebrow,
  title,
  lede,
  headingRef,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-3 font-display text-3xl leading-tight text-ink outline-none sm:text-4xl"
        >
          {title}
        </h1>
        {lede ? <p className="measure mt-3 leading-relaxed text-ink-muted">{lede}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * A place name, English-first, with the native form beside it.
 *
 * The single component every geographic entity renders through — a suggestion,
 * an interpretation card, a base, a cluster, a board group, a transfer day, an
 * itinerary heading, a line of preparation guidance.
 *
 * It exists because the alternative was each surface deciding for itself, and
 * they did not agree: the destination index resolved English-first while the
 * regional-expansion layer took whatever a geocoder returned — so a traveller
 * who typed "Kyrgyzstan" and picked an English row got a base headed
 * `Бишкек шаары` on every screen afterwards.
 *
 * The local name is rendered in a `<span lang>` when its language is known, so
 * a screen reader switches voice rather than spelling a Cyrillic name out in
 * English phonemes.
 */
export function PlaceName({
  entity,
  className,
  showLocal = true,
}: {
  entity: { name: string; names?: DisplayName };
  className?: string;
  /** Off where space genuinely does not allow it — a dense table cell. */
  showLocal?: boolean;
}) {
  const display = displayNameOf(entity);
  const local = showLocal ? localNameOf(entity) : undefined;
  const language = entity.names?.localLanguage;

  return (
    <span className={className}>
      {display}
      {local ? (
        <span className="ml-1.5 text-ink-faint" {...(language ? { lang: language } : {})}>
          {local}
        </span>
      ) : null}
    </span>
  );
}
