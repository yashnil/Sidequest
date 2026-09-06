import type { ReactNode } from 'react';
import {
  displayNameOf,
  isEnglish,
  localNameOf,
  type DisplayName,
  type FitBand,
  type PlaceCategory,
} from '@sidequest/core';

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

/**
 * The focus treatment is stated here as well as in `globals.css`.
 *
 * The base layer's `:focus-visible` rule sets an offset ring, and a button that
 * later grows a `focus:` or `focus-visible:outline-*` utility — or sits inside a
 * surface that resets outlines — silently loses it. Stating the ring *and* its
 * offset on the component means the offset cannot be dropped by a utility that
 * only meant to change the colour: without the offset the ring is drawn on the
 * button's own edge, which on a filled primary button is invisible.
 */
const BUTTON_BASE =
  'pressable inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] text-sm font-medium transition-[background-color,border-color,color,transform] duration-[var(--motion-fast)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

const BUTTON_VARIANTS = {
  primary: 'bg-ink text-paper hover:bg-ink-muted',
  secondary: 'border border-rule bg-paper-raised text-ink hover:border-ink-faint',
  /*
   * `text-ink-muted` here was the product's quiet *action* colour sitting at the
   * same weight as its quiet *prose* colour — 8.1:1 is a fine ratio and a bad
   * signal, because on cream a ghost button then reads as a caption rather than
   * as something you can press. Ghost actions are still secondary; they are made
   * secondary by having no ground, not by being faded.
   */
  ghost: 'text-ink hover:text-pine hover:bg-paper-sunk',
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
  lg: 'min-h-12 px-6 py-3 text-base',
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
 *
 * The dashes used to be `aria-hidden` with no replacement, which was right when
 * the word beside them said everything. It stopped being right once the board
 * put seventeen of these on one screen: sighted readers use the dashes to
 * *compare* cards at a glance, and a screen-reader user had no equivalent — they
 * got six repetitions of "Strong fit" with nothing ordering them. `role="img"`
 * with a count restores the comparison without reading a gradient aloud.
 *
 * The key for what the dashes mean is the badge beside them. There used to be a
 * separate `FitMeterLegend` under the board explaining the scale; the rebuilt
 * board moved the calibrated label onto the meter itself, which says the same
 * thing in the place the reader is already looking, and left the legend with no
 * call site anywhere. §37: it is deleted rather than left exported, because an
 * unrendered component is a design decision nobody can see.
 */
export function FitMeter({ band, label, meter }: { band: FitBand; label: string; meter: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span
        className="flex gap-[3px]"
        role="img"
        aria-label={`How well this fits you: ${meter} out of 5`}
      >
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

/**
 * THE PLATE'S HUE IS A CATEGORY, NOT A HASH.
 *
 * This used to pick one of six saturated palettes from a hash of the place id,
 * which meant a row of three lakes read orange, purple and green. Every card on
 * the board carried a strong colour that encoded *nothing* — the eye reads a
 * colour difference as a meaning difference, so the board was making a claim on
 * every card and the claim was noise. Worse, the palettes were the same weight
 * as the product's semantic colours (pine confirms, amber cautions, clay
 * blocks), so decoration and status competed.
 *
 * Five families, each a single hue, deliberately close together and deliberately
 * quiet: water, high ground, volcanic ground, built places, and open country. A
 * lake looks like a lake wherever it appears, and two lakes look like each
 * other. `PLATE_HUE` is exported so `DestinationImage`'s generated graphic can
 * share it rather than invent a second system.
 */
export const PLATE_HUE: Record<PlaceCategory, number> = {
  lake: 199,
  hot_spring: 190,
  viewpoint: 158,
  day_hike: 150,
  easy_walk: 145,
  gondola_or_tram: 164,
  geothermal: 22,
  national_monument: 28,
  scenic_drive: 38,
  historic_site: 216,
  museum: 222,
  town_and_food: 228,
  wildlife_area: 96,
};

/**
 * Saturation and lightness are constants, not variables.
 *
 * Holding both fixed is what makes the hue the only thing that differs, and
 * therefore the only thing that means anything. 22% is low enough that the plate
 * sits behind the card's type rather than shouting over it.
 */
function plateGradient(category: PlaceCategory): string {
  const hue = PLATE_HUE[category];
  return `linear-gradient(145deg, hsl(${hue} 22% 40%), hsl(${hue} 18% 62%))`;
}

/**
 * WHAT MAKES ONE PLATE DIFFER FROM THE NEXT — AND WHY IT IS NOT DECORATION.
 *
 * A fresh designer looked at a compiled Tokyo board and reported four
 * consecutive cards carrying "the same flat green gradient with the same white
 * squiggle". They were right, and the cause was that the plate encoded exactly
 * one fact — the category — so eleven easy walks were eleven identical objects.
 *
 * The obvious repair is to vary the plate by a hash of the id, and it is the
 * wrong one: this file already argues, at `PLATE_HUE`, that the eye reads a
 * visible difference as a meaningful one, so a difference that means nothing is
 * a claim the board cannot support. The coordinate-derived graphic
 * (`imageryFallbackFor`) has the same problem from the other end — its horizon
 * and drift come off *global* latitude and longitude, which within one city vary
 * by four ten-thousandths of the frame.
 *
 * So the plate draws three facts the card is already asking the traveller to
 * decide on, and nothing else:
 *
 *   - **effort** sets the terrain. A `none` place is a flat horizon; a
 *     `strenuous` one is a steep ridge. This is the axis somebody scanning a
 *     board of walks is actually sorting by.
 *   - **how long you would be there** sets how many crests there are, so a
 *     forty-minute stop and a half-day are different shapes.
 *   - **how known it is** sets the surface: a well-trodden place is drawn solid,
 *     a quiet find is drawn as a broken line — the "hidden gem" fact, rendered
 *     rather than only badged.
 *
 * Hue is still the category and only the category. Same place, same plate, every
 * render; two places that differ on any of the three look different.
 */
export interface PlateSignature {
  intensity: 'none' | 'easy' | 'moderate' | 'strenuous';
  /** How long a visit runs, in minutes. Sets the number of crests. */
  minutes: number;
  /** 0–1. Above 0.6 the line is drawn broken rather than solid. */
  hiddenGemScore: number;
}

/** Ridge height per effort band, as a fraction of the frame. */
const PLATE_RELIEF: Record<PlateSignature['intensity'], number> = {
  none: 0.06,
  easy: 0.16,
  moderate: 0.3,
  strenuous: 0.46,
};

/**
 * The ridge, as an SVG path across a 100×60 frame.
 *
 * Deterministic by construction rather than by seeded randomness: the crest
 * count and the height both come off the signature, so the drawing is a function
 * of the facts and re-deriving it anywhere would produce the same line.
 */
function ridgePath(signature: PlateSignature, drop = 0): string {
  const relief = PLATE_RELIEF[signature.intensity] * 60;
  // Two crests for a short stop, up to five for a long one. `minutes` is the
  // visit length the card prints, so the shape and the number agree.
  const crests = Math.max(2, Math.min(5, Math.round(signature.minutes / 60) + 1));
  const step = 100 / crests;
  /*
   * The skyline sits high enough that the ground below it is the larger part of
   * the frame. A ridge drawn near the bottom edge leaves most of a card's plate
   * as flat colour, which on the full-width lead card is a hundred and eighty
   * pixels of nothing — the emptiness a first screenshot of this showed.
   */
  const base = 26 - relief + drop;
  let path = `M0 ${(base + relief).toFixed(1)}`;
  for (let index = 0; index < crests; index += 1) {
    const peak = base + (index % 2 === 0 ? 0 : relief * 0.45);
    path += ` Q${(step * (index + 0.5)).toFixed(1)} ${peak.toFixed(1)} ${(step * (index + 1)).toFixed(1)} ${(base + relief * (index % 2 === 0 ? 1 : 0.7)).toFixed(1)}`;
  }
  return path;
}

export function PlacePlate({
  category,
  className,
  signature,
}: {
  category: PlaceCategory;
  className?: string;
  /**
   * Optional, because a caller that has only a category — a legend, a
   * placeholder — should not have to invent effort and duration to draw one.
   * Absent, the plate is the flat category mark it has always been.
   */
  signature?: PlateSignature;
}) {
  const hue = PLATE_HUE[category];
  return (
    <div
      className={cx('relative overflow-hidden', className)}
      style={{ background: plateGradient(category) }}
      aria-hidden="true"
    >
      {signature ? (
        <svg
          viewBox="0 0 100 60"
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
        >
          {/*
            The ground under the ridge, so the line reads as terrain rather than
            as a graph. One hue, two lightnesses — the same restraint
            `FallbackGraphic` states.
          */}
          {/*
            A second ridge behind the first, at a fixed offset. Two lines read as
            depth rather than as a chart, and the offset is a constant so the
            *difference* between two plates still comes only from the facts.
          */}
          <path
            d={`${ridgePath(signature, 9)} L100 60 L0 60 Z`}
            fill={`hsl(${hue} 24% 46%)`}
            opacity={0.35}
          />
          <path
            d={`${ridgePath(signature)} L100 60 L0 60 Z`}
            fill={`hsl(${hue} 26% 34%)`}
            opacity={0.45}
          />
          <path
            d={ridgePath(signature)}
            fill="none"
            stroke="#fff"
            strokeWidth={1.2}
            strokeLinecap="round"
            opacity={0.55}
            /*
              A broken line for a quiet find. Redundant with the "Quiet find"
              chip on purpose: a chip is read once, a texture is read while
              scanning, and this is the surface somebody scans.
            */
            {...(signature.hiddenGemScore >= 0.6 ? { strokeDasharray: '5 4' } : {})}
          />
        </svg>
      ) : null}

      {/*
        The category glyph, small and cornered once there is terrain behind it.
        Centred and large it *was* the plate, which is how eleven walks came to
        look like one walk.
      */}
      <svg
        viewBox="0 0 24 24"
        className={cx(
          'absolute',
          signature ? 'top-2 left-2 h-8 w-8 opacity-45' : 'inset-0 h-full w-full opacity-30',
        )}
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
        'relative flex min-w-0 flex-col rounded-[var(--radius-card)] border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-[var(--motion-fast)]',
        FOCUS_RING,
        disabled
          ? 'cursor-not-allowed border-dashed border-rule opacity-60'
          : checked
            ? /*
               * A CHOSEN OPTION HAS TO LOOK CHOSEN.
               *
               * Three redundant signals rather than a darker tint alone: the
               * ochre ground that the whole product reserves for the
               * traveller's own choices, a doubled border in the same ochre,
               * and a check badge. The badge is `aria-hidden` — the input's
               * own checked state is what assistive technology reads, and a
               * tick inside the label would be spoken as part of the option's
               * name and would land in every `getByRole(..., { name })`.
               */
              'cursor-pointer border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent)]'
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
      <span
        className={cx(
          'flex items-start gap-2 pr-6 text-sm',
          checked ? 'font-medium text-accent-strong' : 'text-ink',
        )}
      >
        <span className="min-w-0">{label}</span>
      </span>
      {detail ? (
        <span className={cx('mt-0.5 pr-6 text-xs leading-relaxed', checked ? 'text-accent-strong/80' : 'text-ink-muted')}>
          {detail}
        </span>
      ) : null}
      {checked ? (
        <span
          aria-hidden="true"
          className="absolute top-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] text-paper"
        >
          ✓
        </span>
      ) : null}
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
  /**
   * THE NAME THAT LEADS IS NOT ALWAYS ENGLISH, AND IT WAS NEVER TAGGED.
   *
   * The local name beside it has carried `lang` since the naming work landed.
   * The *display* name never did — and it is not always English: when nothing
   * publishes an English alternate, `displayNameOf` correctly falls back to the
   * native form, so `東京都` and `Бишкек шаары` led the page inside a document
   * declaring `lang="en"`. WCAG 3.1.2 is about exactly that: a screen reader
   * reads it with English phonemes and produces noise.
   *
   * Tagged only when a source actually said which language it is, and only when
   * that is not a variety of English — a redundant `lang="en"` inside an
   * English document is noise of a different kind.
   */
  const displayLanguage =
    entity.names?.displayLanguage && !isEnglish(entity.names.displayLanguage)
      ? entity.names.displayLanguage
      : undefined;

  return (
    <span className={className}>
      <span {...(displayLanguage ? { lang: displayLanguage } : {})}>{display}</span>
      {local ? (
        <span className="ml-1.5 text-ink-faint" {...(language ? { lang: language } : {})}>
          {local}
        </span>
      ) : null}
    </span>
  );
}
