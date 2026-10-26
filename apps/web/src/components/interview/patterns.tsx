'use client';

import { useState, type ReactNode } from 'react';
import {
  DIETARY_NEED_KINDS,
  DIETARY_NEED_KIND_LABELS,
  INTEREST_LABELS,
  hardConstraintOffer,
  recommendedInterests,
  type DietaryNeedKind,
  type HardConstraint,
  type Interest,
  type InterviewContext,
  type InterviewOption,
  type QuestionnaireAnswers,
} from '@sidequest/core';
import { cx, FOCUS_RING, OVERLAY_INPUT } from '../ui';
import { INTEREST_CONTEXT } from './glyphs';

/**
 * THE INTERVIEW'S QUESTION PATTERNS — SURVEY ATLAS.
 *
 * One drawing per cognitive task, and none of them a grid of cards:
 *
 * - interests are a **word index** — large serif words that take a flare
 *   underline and an order number when chosen;
 * - "how big a role" and pace, effort and reach are a **segmented scale**,
 *   cells sharing one border, the chosen cell set in ink; pace's cells each
 *   preview the day they describe;
 * - a choice between a few distinct answers is a set of **ruled lettered rows**
 *   (A / B / C, the answer, the one-line consequence at the right);
 * - spend is an **axis** with stops; hard rules are a serious ruled list;
 *   writing happens on ruled lines.
 *
 * Every pattern is a real fieldset of native inputs (radios keep arrow-key
 * movement, checkboxes keep Space). The paint is on top of the control, never
 * instead of it.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The destination's recommendation, attached to the row it recommends.
 *
 * One quiet line rather than a banner; the reason is the screening's own
 * sentence about this place, and it is never a pre-tick.
 */
export function RecommendedNote({ reason }: { reason?: string | undefined }) {
  return (
    <span className="mt-1.5 flex items-start gap-2 text-sm leading-snug text-pine-strong" data-testid="interview-recommendation">
      <span aria-hidden="true" className="mt-[0.42em] inline-block h-1.5 w-1.5 shrink-0 bg-pine" />
      <span>
        <span className="font-semibold" data-testid="option-recommended">
          Sidequest recommends this here.
        </span>
        {reason ? <> {reason}</> : null}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ruled lettered rows (single choice, scenarios)
// ---------------------------------------------------------------------------

export function OptionCards({
  name,
  options,
  value,
  onChange,
  recommended = null,
  recommendedReason,
  specimen,
}: {
  name: string;
  options: readonly InterviewOption[];
  value: string | undefined;
  onChange: (value: string) => void;
  /** Kept for callers that still pass them; the ruled rows letter every option. */
  glyphs?: unknown;
  lettered?: boolean;
  columns?: 1 | 2 | 3;
  /** MVP V3 — marked because of what this destination is, never as a pre-tick. */
  recommended?: string | null;
  /** The screening's sentence about why, shown on the recommended row. */
  recommendedReason?: string | undefined;
  /** A small drawing at the right of a row (transport draws the line it will put on the map). */
  specimen?: (value: string, on: boolean) => ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Choose one</legend>
      <div className="ob-rows">
        {options.map((option, index) => {
          const on = value === option.value;
          return (
            <label key={option.value} className="ob-row" data-on={on ? 'true' : 'false'}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className="ob-letter">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="ob-row-label min-w-0">{option.label}</span>
              {option.detail || specimen ? (
                <span className="ob-row-why flex items-center gap-3 md:justify-end">
                  {specimen ? <span aria-hidden="true" className="shrink-0">{specimen(option.value, on)}</span> : null}
                  {option.detail ? <span className="min-w-0">{option.detail}</span> : null}
                </span>
              ) : null}
              {recommended === option.value ? (
                <span className="ob-row-extra">
                  <RecommendedNote reason={recommendedReason} />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Interests: a typographic word index
// ---------------------------------------------------------------------------

export function InterestGrid({ context, offered, value, onChange }: { context: InterviewContext; offered: readonly InterviewOption[]; value: Interest[]; onChange: (value: Interest[]) => void }) {
  const [more, setMore] = useState(false);
  const all = context.traveller.offeredInterests;
  /*
   * PRODUCTION PASS — RECOMMENDED FOR THIS TRIP.
   *
   * Three interests chosen for this destination, season, length and party,
   * each with the one reason that put it there (`recommendedInterests`). They
   * lead the index and carry a flare dot; they are never pre-ticked —
   * "Decide for me" applies exactly these.
   */
  const recommended = recommendedInterests(context);
  const reasonFor = new Map(recommended.map((r) => [r.interest, r.reason]));
  const base: Interest[] = more
    ? [...all]
    : [...offered.map((o) => o.value as Interest), ...value.filter((interest) => !offered.some((o) => o.value === interest))];
  const visible: Interest[] = [...recommended.map((r) => r.interest).filter((i) => base.includes(i)), ...base.filter((i) => !reasonFor.has(i))];
  const shownReasons = recommended.filter((r) => visible.includes(r.interest));
  return (
    <div>
      <fieldset className="min-w-0">
        <legend className="sr-only">Choose one or more</legend>
        <div className="ob-index">
          {visible.map((interest) => {
            const on = value.includes(interest);
            const order = value.indexOf(interest);
            const why = reasonFor.get(interest);
            return (
              <label key={interest} className="ob-word" data-on={on ? 'true' : 'false'} data-recommended={why ? 'true' : undefined} title={INTEREST_CONTEXT[interest]}>
                <input
                  type="checkbox"
                  name="priorities"
                  value={interest}
                  aria-label={INTEREST_LABELS[interest]}
                  checked={on}
                  onChange={(event) => onChange(event.target.checked ? [...value, interest] : value.filter((entry) => entry !== interest))}
                  className={OVERLAY_INPUT}
                />
                <span aria-hidden="true">{INTEREST_LABELS[interest]}</span>
                {on ? (
                  <span aria-hidden="true" className="ob-word-n">
                    {pad(order + 1)}
                  </span>
                ) : why ? (
                  <span aria-hidden="true" className="ob-word-dot" />
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-6 border-t border-ink/15 pt-3">
        {shownReasons.length > 0 ? (
          <ul className="space-y-1">
            {shownReasons.map((r) => (
              <li key={r.interest} className="flex items-baseline gap-2.5 text-sm text-ink-muted">
                <span aria-hidden="true" className="ob-word-dot mt-0 shrink-0 translate-y-[-1px]" />
                <span>
                  <span className="text-ink">{INTEREST_LABELS[r.interest]}</span> — <span data-testid="interest-recommended-reason">{r.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="sheet-label text-ink-muted" aria-live="polite">
            {value.length === 0 ? 'Pick what matters most' : `${pad(value.length)} chosen · in the order you picked`}
          </span>
          {!more && all.length > offered.length ? (
            <button type="button" onClick={() => setMore(true)} className={cx('inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-more-interests">
              See more interests
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role: how big a role one interest plays, as a four-step scale
// ---------------------------------------------------------------------------

/** Four rising ticks, filled up to the step: the role drawn as weight rather than as a word. */
function RoleTicks({ step, on }: { step: number; on: boolean }) {
  return (
    <span className="flex items-end gap-[3px]" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cx('w-[5px]', i <= step ? (on ? 'bg-flare' : 'bg-ink') : on ? 'bg-paper/25' : 'bg-ink/15')} style={{ height: 6 + i * 4 }} />
      ))}
    </span>
  );
}

export function RoleMeter({ name, options, value, onChange, interest }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void; interest?: Interest }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How big a role</legend>
      {interest ? <p className="mb-4 font-display text-3xl text-ink" aria-hidden="true">{INTEREST_LABELS[interest]}</p> : null}
      <div className="ob-scale ob-scale-stack">
        {options.map((option, i) => {
          const on = value === option.value;
          return (
            <label key={option.value} className="ob-cell" data-on={on ? 'true' : 'false'}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <RoleTicks step={i} on={on} />
              <span className="ob-cell-title">{option.label}</span>
              {option.detail ? <span className="ob-cell-detail">{option.detail}</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * PRODUCT RECOVERY V1 — one screen for every chosen interest: a ruled row per
 * interest, the same four-step scale across, radio semantics per row so the
 * keyboard walks it naturally.
 */
export function RoleMatrix({ name, options, value, onChange, interests }: { name: string; options: readonly InterviewOption[]; value: Record<string, string>; onChange: (value: Record<string, string>) => void; interests: readonly Interest[] }) {
  return (
    <div className="min-w-0" role="group" aria-label="What should lead the trip">
      <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-6 pb-2 md:grid" aria-hidden="true">
        <span />
        <span className="grid grid-cols-4">
          {options.map((option) => (
            <span key={option.value} className="sheet-label px-2 text-[10px] leading-snug text-ink-muted">
              {option.label}
            </span>
          ))}
        </span>
      </div>
      <div className="ob-rows">
        {interests.map((interest, row) => {
          const current = value[interest];
          return (
            <fieldset key={interest} className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] md:items-center md:gap-6">
              <legend className="sr-only">{INTEREST_LABELS[interest]}</legend>
              <div className="flex items-baseline gap-3" aria-hidden="true">
                <span className="sheet-label text-ink-muted">{pad(row + 1)}</span>
                <span className="font-display text-2xl leading-tight text-ink">{INTEREST_LABELS[interest]}</span>
              </div>
              <div className="ob-scale">
                {options.map((option, i) => {
                  const on = current === option.value;
                  return (
                    <label key={option.value} className="ob-cell min-h-12 items-start px-2.5 py-2" data-on={on ? 'true' : 'false'} title={option.detail}>
                      <input type="radio" name={`${name}:${interest}`} value={option.value} checked={on} onChange={() => onChange({ ...value, [interest]: option.value })} className={OVERLAY_INPUT} />
                      <RoleTicks step={i} on={on} />
                      <span className="text-[11px] leading-tight md:sr-only">{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transport: ruled rows, each showing the line it will draw on the map
// ---------------------------------------------------------------------------

/** The line a mode puts on the context map, drawn small: the same dash, the same colour. */
export function LineSpecimen({ mode, on }: { mode: string; on: boolean }) {
  const style = TRANSPORT_LINE[mode] ?? TRANSPORT_LINE.mixed!;
  return (
    <svg viewBox="0 0 48 10" className="h-2.5 w-12" aria-hidden="true">
      <line x1={1} y1={5} x2={47} y2={5} stroke={style.color} strokeWidth={on ? 3 : 2} strokeDasharray={style.dash} strokeLinecap="round" opacity={on ? 1 : 0.7} />
    </svg>
  );
}

export const TRANSPORT_LINE: Record<string, { color: string; dash: string | undefined }> = {
  rent_car: { color: 'var(--color-flare)', dash: '6 3' },
  self_drive: { color: 'var(--color-flare)', dash: '6 3' },
  mixed: { color: 'var(--color-flare)', dash: '6 3 1 3' },
  no_car: { color: 'var(--color-glacier)', dash: '4 3' },
  transit_walk: { color: 'var(--color-glacier)', dash: '4 3' },
  rail_transfers: { color: 'var(--color-glacier)', dash: '4 3' },
  taxis: { color: 'var(--color-ink)', dash: '1 3' },
  guided: { color: 'var(--color-ink)', dash: '5 2 1 2' },
  boats_transfers: { color: 'var(--color-glacier)', dash: '8 3' },
};

export function TransportChoice({ name, options, value, onChange, recommended = null, recommendedReason }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void; recommended?: string | null; recommendedReason?: string | undefined }) {
  return <OptionCards name={name} options={options} value={value} onChange={onChange} recommended={recommended} recommendedReason={recommendedReason} specimen={(mode, on) => <LineSpecimen mode={mode} on={on} />} />;
}

// ---------------------------------------------------------------------------
// Rhythm: a segmented scale whose cells preview the day
// ---------------------------------------------------------------------------

const RHYTHM: Record<string, { blocks: number[]; gaps: number }> = {
  one_big: { blocks: [46, 12], gaps: 12 },
  two_three: { blocks: [24, 20, 18], gaps: 7 },
  cover: { blocks: [14, 12, 14, 12, 14], gaps: 3.5 },
};

function DayStrip({ value, on }: { value: string; on: boolean }) {
  const shape = RHYTHM[value] ?? RHYTHM.two_three!;
  const starts = shape.blocks.reduce<number[]>((acc, _width, index) => [...acc, index === 0 ? 0 : acc[index - 1]! + shape.blocks[index - 1]! + shape.gaps], []);
  return (
    <svg viewBox="0 0 100 16" className="h-4 w-full" aria-hidden="true" preserveAspectRatio="none">
      <line x1={0} y1={8} x2={100} y2={8} stroke="currentColor" strokeWidth={0.6} opacity={0.4} />
      {shape.blocks.map((width, index) => (
        <rect key={index} x={starts[index]} y={2} width={width} height={12} fill={on ? 'var(--color-flare)' : 'currentColor'} opacity={on ? 1 : 0.75} />
      ))}
    </svg>
  );
}

export function RhythmChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Which day</legend>
      <div className="ob-scale ob-scale-stack">
        {options.map((option) => {
          const on = value === option.value;
          return (
            <label key={option.value} className="ob-cell gap-3 py-5 sm:min-h-44 sm:justify-between" data-on={on ? 'true' : 'false'}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span className="block">
                <DayStrip value={option.value} on={on} />
                <span className="coordbar mt-1.5 flex justify-between opacity-70" aria-hidden="true">
                  <span>08:00</span>
                  <span>20:00</span>
                </span>
              </span>
              <span className="block">
                <span className="ob-cell-title block text-xl">{option.label}</span>
                {option.detail ? <span className="ob-cell-detail mt-1 block">{option.detail}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Spectrum: effort as a scale whose cells carry a relief line
// ---------------------------------------------------------------------------

function ProfileLine({ level, on }: { level: number; on: boolean }) {
  const relief = [3, 8, 14, 20][Math.min(3, level)] ?? 8;
  const d = `M0 24 C 15 ${24 - relief * 0.4} 25 ${24 - relief} 40 ${24 - relief * 0.7} S 65 ${24 - relief * 1.1} 80 ${24 - relief * 0.5} S 95 ${24 - relief * 0.2} 100 24`;
  return (
    <svg viewBox="0 0 100 26" className="h-7 w-full" aria-hidden="true" preserveAspectRatio="none">
      <path d={`${d} L100 26 L0 26 Z`} fill={on ? 'var(--color-flare)' : 'currentColor'} opacity={on ? 0.35 : 0.1} />
      <path d={d} fill="none" stroke={on ? 'var(--color-flare)' : 'currentColor'} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

const SPECTRUM_LEVEL: Record<string, number> = { light: 0, moderate: 1, intense: 3, little: 0, lots: 3, none: 0, short: 1, half_day: 2, full_day: 3 };

export function SpectrumChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How much</legend>
      <div className="ob-scale ob-scale-stack">
        {options.map((option, index) => {
          const on = value === option.value;
          return (
            <label key={option.value} className="ob-cell gap-2 py-4 sm:min-h-36 sm:justify-between" data-on={on ? 'true' : 'false'}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <ProfileLine level={SPECTRUM_LEVEL[option.value] ?? index} on={on} />
              <span className="block">
                <span className="ob-cell-title block">{option.label}</span>
                {option.detail ? <span className="ob-cell-detail mt-1 block">{option.detail}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Reach: a segmented scale; the ring is drawn on the context map
// ---------------------------------------------------------------------------

/** The short mark a reach cell is set in: minutes or a word, never a distance nobody measured. */
const RANGE_MARK: Record<string, string> = {
  destination_only: 'Here',
  nearby_30: '30′',
  nearby_60: '1 h',
  nearby_120: '2 h',
  best_regional: 'Any',
  stay_in_city: 'City',
  one_day_trip: '1 day',
  several: 'Several',
};

export function RangeMapChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void; baseName?: string }) {
  const chosen = options.find((o) => o.value === value) ?? null;
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How far</legend>
      <div className="ob-scale">
        {options.map((option) => {
          const on = value === option.value;
          return (
            <label key={option.value} className="ob-cell min-h-20 items-center px-1.5 text-center sm:min-h-24" data-on={on ? 'true' : 'false'} title={option.detail}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className="ob-cell-big">
                {RANGE_MARK[option.value] ?? option.label}
              </span>
              <span className="ob-cell-detail text-[12px] max-md:sr-only">{option.label}</span>
            </label>
          );
        })}
      </div>
      <div className="ob-scale-ends sheet-label text-ink-muted" aria-hidden="true">
        <span>Stay close</span>
        <span>Go far</span>
      </div>
      <p className="mt-4 min-h-12 max-w-[52ch] text-base leading-snug text-ink" aria-live="polite">
        {chosen ? (
          <>
            <span className="font-display text-xl">{chosen.label}</span>
            {chosen.detail ? <span className="block text-sm text-ink-muted">{chosen.detail}</span> : null}
          </>
        ) : (
          <span className="text-ink-muted">Pick a reach and the ring draws on the map.</span>
        )}
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Budget: an axis, then an optional envelope
// ---------------------------------------------------------------------------

export function BudgetAxis({ options, value, onChange }: { options: readonly InterviewOption[]; value: { style?: string; envelope: { amount?: number; basis?: string; currency?: string } | null }; onChange: (value: { style?: string; envelope: { amount?: number; basis?: string; currency?: string } | null }) => void }) {
  const [showEnvelope, setShowEnvelope] = useState(Boolean(value.envelope));
  const axis = options.filter((o) => o.value !== 'dont_know');
  const unsure = options.find((o) => o.value === 'dont_know');
  const at = axis.findIndex((o) => o.value === value.style);
  const chosen = at >= 0 ? axis[at]! : null;
  /* The fill runs from the first stop's centre to the chosen one's: 10% … 90% of the axis. */
  const fill = at <= 0 || axis.length < 2 ? 0 : (at / (axis.length - 1)) * 80;
  return (
    <div className="space-y-6">
      <fieldset className="min-w-0">
        <legend className="sr-only">Spending style</legend>
        <div className="ob-axis">
          <span aria-hidden="true" className="ob-axis-fill" style={{ width: `${fill}%` }} />
          {axis.map((option, index) => {
            const on = value.style === option.value;
            return (
              <label key={option.value} className="ob-stop" data-on={on ? 'true' : 'false'} data-reached={at >= 0 && index < at ? 'true' : 'false'} title={option.detail}>
                <input type="radio" name="budget" value={option.value} checked={on} onChange={() => onChange({ ...value, style: option.value })} className={OVERLAY_INPUT} />
                <span aria-hidden="true" className="ob-stop-tick" />
                <span className="ob-stop-label">{option.label}</span>
              </label>
            );
          })}
        </div>
        <p className="mt-3 min-h-6 text-center text-sm text-ink-muted" aria-live="polite">
          {chosen?.detail ?? ''}
        </p>
        {unsure ? (
          <div className="ob-rows mt-5">
            <label className="ob-row" data-on={value.style === 'dont_know' ? 'true' : 'false'}>
              <input type="radio" name="budget" value="dont_know" checked={value.style === 'dont_know'} onChange={() => onChange({ ...value, style: 'dont_know' })} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className="ob-letter">?</span>
              <span className="ob-row-label min-w-0 text-lg">{unsure.label}</span>
              {unsure.detail ? <span className="ob-row-why">{unsure.detail}</span> : null}
            </label>
          </div>
        ) : null}
      </fieldset>
      {!showEnvelope ? (
        <button type="button" onClick={() => setShowEnvelope(true)} className={cx('inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-budget-envelope">
          Add a rough envelope (optional)
        </button>
      ) : (
        <fieldset className="border-t border-ink/20 pt-4">
          <legend className="sheet-label pr-2 text-ink-muted">A rough envelope, excluding flights</legend>
          <div className="mt-3 flex flex-wrap items-end gap-5">
            <label className="text-sm text-ink">
              <span className="sheet-label block text-ink-muted">Amount</span>
              <input type="number" min={1} max={1000000} inputMode="numeric" value={value.envelope?.amount ?? ''} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), amount: Number(event.target.value) || undefined, basis: value.envelope?.basis ?? 'per_person_per_day', currency: value.envelope?.currency ?? 'USD' } })} className="ob-underline type-figure w-36" />
            </label>
            <label className="text-sm text-ink">
              <span className="sheet-label block text-ink-muted">Currency</span>
              <input type="text" maxLength={3} value={value.envelope?.currency ?? 'USD'} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), currency: event.target.value.toUpperCase(), basis: value.envelope?.basis ?? 'per_person_per_day' } })} className="ob-underline w-20 uppercase" />
            </label>
            <label className="text-sm text-ink">
              <span className="sheet-label block text-ink-muted">Per</span>
              <select value={value.envelope?.basis ?? 'per_person_per_day'} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), basis: event.target.value, currency: value.envelope?.currency ?? 'USD' } })} className="ob-underline text-lg">
                <option value="per_person_per_day">person, per day</option>
                <option value="per_person_trip">person, whole trip</option>
                <option value="group_trip">whole group, whole trip</option>
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-ink-faint">Used to judge splurges, never to build a spreadsheet.</p>
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Square toggles (multi) and dietary
// ---------------------------------------------------------------------------

export function ChipGroup({ name, options, value, onChange, tone = 'accent' }: { name: string; options: readonly InterviewOption[]; value: string[]; onChange: (value: string[]) => void; tone?: 'accent' | 'clay' }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Choose any</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = value.includes(option.value);
          return (
            <label key={option.value} className="ob-tag" data-on={on ? 'true' : 'false'} data-tone={tone} title={option.detail}>
              <input type="checkbox" name={name} value={option.value} checked={on} onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((entry) => entry !== option.value))} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className="ob-tag-box" />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * DIET: A WAY OF EATING, THINGS YOU AVOID, AND YOUR OWN WORDS.
 *
 * MVP V3, Stage 16. Grouped because the three are different kinds of statement.
 * The free-text box is where "vegetarian, but I eat eggs" lives; it survives
 * verbatim into the brief and nothing parses it into the toggles above.
 */
export function DietaryControl({
  options,
  value,
  onChange,
}: {
  options: readonly InterviewOption[];
  value: { needs: string[]; strict: boolean; notes?: string };
  onChange: (value: { needs: string[]; strict: boolean; notes: string }) => void;
}) {
  const notes = value.notes ?? '';
  const set = (patch: Partial<{ needs: string[]; strict: boolean; notes: string }>) => onChange({ needs: value.needs, strict: value.strict, notes, ...patch });
  const group = (kind: DietaryNeedKind) => options.filter((option) => option.detail === kind);
  return (
    <div className="space-y-6">
      {DIETARY_NEED_KINDS.map((kind, index) => {
        const inGroup = group(kind);
        if (inGroup.length === 0) return null;
        return (
          <fieldset key={kind} className="border-t border-ink/20 pt-3">
            <legend className="sheet-label float-left mb-3 w-full text-ink-muted">
              {pad(index + 1)} · {DIETARY_NEED_KIND_LABELS[kind]}
            </legend>
            <div className="clear-both">
              <ChipGroup name={`dietary-${kind}`} options={inGroup.map((option) => ({ value: option.value, label: option.label }))} value={value.needs} onChange={(needs) => set({ needs: [...new Set([...value.needs.filter((entry) => !inGroup.some((option) => option.value === entry)), ...needs.filter((entry) => inGroup.some((option) => option.value === entry))])] })} tone={kind === 'allergy' ? 'clay' : 'accent'} />
            </div>
          </fieldset>
        );
      })}
      <div>
        <label htmlFor="dietary-notes" className="sheet-label block text-ink-muted">
          Anything else, in your words
        </label>
        <textarea id="dietary-notes" rows={2} maxLength={300} value={notes} onChange={(event) => set({ notes: event.target.value })} placeholder="Vegetarian but I eat eggs · no alcohol at dinner" className="ob-lines mt-2" data-testid="dietary-notes" />
      </div>
      {value.needs.length > 0 || notes.trim().length > 0 ? (
        <SeriousToggle label="These are requirements, not preferences" detail="Say yes and we stop treating “nobody has confirmed it” as good enough." checked={value.strict} onChange={(strict) => set({ strict })} />
      ) : null}
    </div>
  );
}

export function SeriousToggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={cx('flex min-h-11 cursor-pointer gap-3 border-l-[3px] py-2 pl-4 transition-colors', checked ? 'border-l-clay' : 'border-l-ink/20')}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-clay)]" />
      <span>
        <span className={cx('block text-sm font-semibold', checked ? 'text-clay' : 'text-ink')}>{label}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Hard limits: a serious ruled list
// ---------------------------------------------------------------------------

export function HardLimitsControl({ context, answers, value, onChange }: { context: InterviewContext; answers: QuestionnaireAnswers; value: { constraints: HardConstraint[]; notes: string; notesAreHard: boolean }; onChange: (value: { constraints: HardConstraint[]; notes: string; notesAreHard: boolean }) => void }) {
  const offer = hardConstraintOffer(context, answers);
  const has = (code: string) => value.constraints.some((c) => c.code === code);
  const valueOf = (code: string) => value.constraints.find((c) => c.code === code)?.value;
  function toggle(code: HardConstraint['code'], checked: boolean, defaultValue?: number) {
    const rest = value.constraints.filter((c) => c.code !== code);
    onChange({ ...value, constraints: checked ? [...rest, { code, ...(defaultValue !== undefined ? { value: defaultValue } : {}) }] : rest });
  }
  function setValue(code: HardConstraint['code'], next: number) {
    onChange({ ...value, constraints: value.constraints.map((c) => (c.code === code ? { ...c, value: next } : c)) });
  }
  return (
    <div className="space-y-8">
      <fieldset className="min-w-0">
        <legend className="sheet-label mb-3 text-clay">Rules, not wishes · tick only what must hold</legend>
        <ul className="ob-rows">
          {offer.map((entry, index) => {
            const on = has(entry.code);
            return (
              <li key={entry.code}>
                <label className={cx('grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1 py-3.5 md:grid-cols-[1.5rem_minmax(0,1fr)_auto]', FOCUS_RING)}>
                  <input type="checkbox" checked={on} onChange={(event) => toggle(entry.code, event.target.checked, entry.values?.[1]?.value ?? entry.values?.[0]?.value)} className="mt-1.5 h-5 w-5 shrink-0 accent-[var(--color-clay)]" />
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-3">
                      <span aria-hidden="true" className="sheet-label text-ink-faint">{pad(index + 1)}</span>
                      <span className={cx('font-display text-xl leading-snug', on ? 'text-clay' : 'text-ink')}>{entry.label}</span>
                    </span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{entry.detail}</span>
                  </span>
                  {on && entry.values ? (
                    <select value={valueOf(entry.code) ?? entry.values[0]!.value} onChange={(event) => setValue(entry.code, Number(event.target.value))} onClick={(event) => event.stopPropagation()} className="type-figure col-start-2 min-h-11 shrink-0 border border-clay/50 bg-paper px-2 py-1.5 text-sm md:col-start-3" aria-label={`${entry.label} value`}>
                      {entry.values.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div>
        <label htmlFor="hardNotes" className="sheet-label block text-ink-muted">
          Anything else, in your own words (optional)
        </label>
        <textarea id="hardNotes" rows={2} maxLength={500} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} className="ob-lines mt-2" placeholder="Altitude, knees, someone who hates heights…" aria-describedby="hardNotes-hint" />
        <p id="hardNotes-hint" className="mt-2 text-sm text-ink-muted">
          A sentence stays a preference unless you tick the box below.
        </p>
        {value.notes.trim().length > 0 ? (
          <div className="mt-3">
            <SeriousToggle label="This is a hard requirement" detail="Treat the note above as a rule the plan must not cross." checked={value.notesAreHard} onChange={(notesAreHard) => onChange({ ...value, notesAreHard })} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function WritingSpace({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label htmlFor={id} className="block">
      <span className="sr-only">Your answer</span>
      <textarea id={id} rows={4} maxLength={500} value={value} onChange={(event) => onChange(event.target.value)} className="ob-lines" placeholder={placeholder} />
    </label>
  );
}

export function NamesSpace({ value, onChange }: { value: { include: string[]; avoid: string[] }; onChange: (value: { include: string[]; avoid: string[] }) => void }) {
  const split = (text: string) => text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 10);
  return (
    <div className="grid gap-8 sm:grid-cols-2">
      <label className="block">
        <span className="sheet-label block text-pine">Must include</span>
        <textarea rows={5} value={value.include.join('\n')} onChange={(event) => onChange({ ...value, include: split(event.target.value) })} className="ob-lines mt-2" placeholder="One per line" />
      </label>
      <label className="block">
        <span className="sheet-label block text-clay">Must avoid</span>
        <textarea rows={5} value={value.avoid.join('\n')} onChange={(event) => onChange({ ...value, avoid: split(event.target.value) })} className="ob-lines mt-2" placeholder="One per line" />
      </label>
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-ink-muted">{children}</p>;
}
