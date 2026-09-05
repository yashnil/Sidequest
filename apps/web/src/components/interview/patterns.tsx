'use client';

import { useState, type ReactNode } from 'react';
import {
  INTEREST_LABELS,
  hardConstraintOffer,
  type HardConstraint,
  type Interest,
  type InterviewContext,
  type InterviewOption,
  type QuestionnaireAnswers,
} from '@sidequest/core';
import { cx, FOCUS_RING, OVERLAY_INPUT } from '../ui';
import { Glyph, INTEREST_CONTEXT, INTEREST_GLYPH, INTEREST_HUE, type GlyphId } from './glyphs';

/**
 * THE INTERVIEW'S QUESTION PATTERNS.
 *
 * One component per cognitive task rather than one rectangle for everything:
 * a grid of interest plates, a four-step role meter, transport mode cards
 * with their consequence, a day drawn as blocks for pace, an elevation
 * profile for effort, a range map whose ring grows with the answer, an axis
 * for spend, a serious list for hard rules, and a calm page for writing.
 * Every pattern is a real fieldset of real inputs; the visual is on top of
 * the control, never instead of it.
 */

// ---------------------------------------------------------------------------
// Shared selection surface
// ---------------------------------------------------------------------------

const CARD = 'relative flex min-h-11 cursor-pointer rounded-[var(--radius-card)] border text-left transition-[border-color,background-color,transform] duration-[var(--motion-fast)] ease-[var(--ease-out)]';
const CARD_IDLE = 'border-rule bg-paper-raised hover:border-ink-faint';
const CARD_ON = 'border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent)]';

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'absolute top-2.5 right-2.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] transition-[opacity,transform] duration-[var(--motion-fast)]',
        on ? 'scale-100 border-accent bg-accent text-paper opacity-100' : 'scale-75 border-rule opacity-0',
      )}
    >
      ✓
    </span>
  );
}

// ---------------------------------------------------------------------------
// Scenario / option cards
// ---------------------------------------------------------------------------

export const OPTION_GLYPHS: Record<string, Record<string, GlyphId>> = {
  iconic_crowds: { see_it_anyway: 'crowd', go_at_odd_hours: 'sunrise', quieter_alternative: 'quiet' },
  food_tradeoff: { convenient: 'food', exceptional: 'gem', fuel: 'market' },
  base_moves: { move_once: 'bed', stay_put: 'home', move_if_it_saves_time: 'compass', move_freely: 'road' },
  convenience_spend: { save_money: 'coin', balance: 'coins', pay_to_reduce_hassle: 'gem' },
  coverage_strategy: { depth: 'home', breadth: 'road', best_subset: 'compass' },
  guide_willingness: { prefer: 'guide', sometimes: 'compass', avoid: 'walk' },
  private_transfers: { fine: 'boat', if_needed: 'compass', avoid: 'lock' },
  remote_comfort: { fine: 'signal-off', prefer_not: 'neighbourhood', cannot: 'lock' },
  boats_ferries: { fine: 'boat', prefer_not: 'compass', cannot: 'lock' },
  internal_flights: { fine: 'plane', prefer_not: 'compass', cannot: 'lock' },
  altitude_comfort: { fine: 'altitude', take_it_slow: 'clock', avoid_high: 'lock' },
  road_comfort: { paved: 'road', mountain: 'altitude', gravel: 'gravel' },
  daily_driving: { '90': 'clock', '150': 'car', '240': 'road', '360': 'drive' },
  everyone_every_day: { yes: 'group', no: 'compass' },
  day_start: { early: 'sunrise', normal: 'clock', relaxed: 'bed' },
  famous_vs_hidden: { mostly_classics: 'landmark', balanced: 'compass', mostly_hidden: 'gem', deep_cuts: 'quiet' },
  late_nights: { fine: 'stars', sometimes: 'clock', no: 'bed' },
  stairs_hills: { fine: 'hike', prefer_not: 'walk', cannot: 'lock' },
  rustic_lodging: { yes: 'tent', no: 'bed' },
  pack_lunch: { yes: 'market', no: 'food' },
  free_time: { packed: 'clock', balanced: 'compass', lots: 'quiet' },
  transit_comfort: { cheapest: 'transit', best_value: 'compass', least_stressful: 'taxi' },
  lodging_style: { hostel: 'group', basic_hotel: 'bed', boutique_hotel: 'gem', apartment: 'home', resort: 'beach', luxury_hotel: 'coins', nature_lodge: 'tent', no_preference: 'compass' },
  breakfast: { skip: 'clock', coffee_light: 'food', full: 'plate', depends: 'compass' },
  special_meals: { none: 'market', one: 'plate', a_few: 'food', often: 'gem' },
};

export function OptionCards({
  name,
  options,
  value,
  onChange,
  glyphs,
  lettered = false,
  columns = 2,
}: {
  name: string;
  options: readonly InterviewOption[];
  value: string | undefined;
  onChange: (value: string) => void;
  glyphs?: Record<string, GlyphId>;
  lettered?: boolean;
  columns?: 1 | 2 | 3;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Choose one</legend>
      <div className={cx('grid gap-3', columns === 1 ? '' : columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        {options.map((option, index) => {
          const on = value === option.value;
          const glyph = glyphs?.[option.value];
          return (
            <label key={option.value} className={cx(CARD, 'flex-col gap-3 p-4 pr-10', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span className="flex items-center gap-3">
                {lettered ? (
                  <span aria-hidden="true" className={cx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-display text-sm', on ? 'border-accent bg-accent text-paper' : 'border-rule text-ink-muted')}>
                    {String.fromCharCode(65 + index)}
                  </span>
                ) : null}
                {glyph ? <Glyph id={glyph} className={cx('h-7 w-7', on ? 'text-accent' : 'text-ink-muted')} /> : null}
              </span>
              <span className="min-w-0">
                <span className={cx('block font-display text-lg leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
                {option.detail ? <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{option.detail}</span> : null}
              </span>
              <Check on={on} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Interests: plates in a grid
// ---------------------------------------------------------------------------

export function InterestGrid({ context, offered, value, onChange }: { context: InterviewContext; offered: readonly InterviewOption[]; value: Interest[]; onChange: (value: Interest[]) => void }) {
  const [more, setMore] = useState(false);
  const all = context.traveller.offeredInterests;
  const visible: Interest[] = more
    ? [...all]
    : [...offered.map((o) => o.value as Interest), ...value.filter((interest) => !offered.some((o) => o.value === interest))];
  return (
    <div>
      <fieldset className="min-w-0">
        <legend className="sr-only">Choose one or more</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((interest) => {
            const on = value.includes(interest);
            const hue = INTEREST_HUE[interest];
            return (
              <label
                key={interest}
                className={cx(CARD, 'flex-col overflow-hidden', FOCUS_RING, on ? 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'border-rule hover:border-ink-faint')}
                style={{ '--plate-hue': hue } as React.CSSProperties}
              >
                <input
                  type="checkbox"
                  name="priorities"
                  value={interest}
                  aria-label={INTEREST_LABELS[interest]}
                  checked={on}
                  onChange={(event) => onChange(event.target.checked ? [...value, interest] : value.filter((entry) => entry !== interest))}
                  className={OVERLAY_INPUT}
                />
                <span className={cx('plate flex h-16 items-end px-3 pb-2 transition-[filter] duration-[var(--motion-fast)]', on ? 'brightness-[0.97]' : '')} aria-hidden="true">
                  <Glyph id={INTEREST_GLYPH[interest]} className={cx('h-7 w-7', on ? 'text-accent-strong' : 'text-ink')} />
                </span>
                <span className={cx('flex flex-1 flex-col px-3 py-2.5', on ? 'bg-accent-soft' : 'bg-paper-raised')}>
                  <span className={cx('font-display text-base leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{INTEREST_LABELS[interest]}</span>
                  <span className="mt-0.5 text-xs leading-snug text-ink-muted">{INTEREST_CONTEXT[interest]}</span>
                </span>
                <Check on={on} />
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
        <span>
          {value.length === 0 ? 'Pick what matters most.' : `${value.length} chosen — we ask how big a role each plays next.`}
        </span>
        {!more && all.length > offered.length ? (
          <button type="button" onClick={() => setMore(true)} className={cx('text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-more-interests">
            See more interests
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role meter: how big a role one interest plays
// ---------------------------------------------------------------------------

export function RoleMeter({ name, options, value, onChange, interest }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void; interest?: Interest }) {
  const index = options.findIndex((o) => o.value === value);
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How big a role</legend>
      {interest ? (
        <div className="mb-4 flex items-center gap-3" aria-hidden="true">
          <span className="plate inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-card)]" style={{ '--plate-hue': INTEREST_HUE[interest] } as React.CSSProperties}>
            <Glyph id={INTEREST_GLYPH[interest]} className="h-6 w-6 text-ink" />
          </span>
          <span className="font-display text-xl text-ink">{INTEREST_LABELS[interest]}</span>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-4">
        {options.map((option, i) => {
          const on = value === option.value;
          const reached = index >= 0 && i <= index;
          return (
            <label key={option.value} className={cx(CARD, 'flex-col p-3.5 pr-9', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span className="flex gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map((step) => (
                  <span key={step} className={cx('h-1.5 flex-1 rounded-full transition-colors duration-[var(--motion-base)]', step <= i && reached ? 'bg-accent' : step <= i ? 'bg-ink-faint/50' : 'bg-rule')} />
                ))}
              </span>
              <span className={cx('mt-3 block font-display text-base leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
              {option.detail ? <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{option.detail}</span> : null}
              <Check on={on} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Transport: mode cards with the consequence stated
// ---------------------------------------------------------------------------

const TRANSPORT_GLYPH: Record<string, GlyphId> = {
  rent_car: 'car',
  self_drive: 'car',
  no_car: 'taxi',
  transit_walk: 'transit',
  taxis: 'taxi',
  guided: 'guide',
  boats_transfers: 'boat',
  mixed: 'compass',
};

export function TransportChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How you get around</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => {
          const on = value === option.value;
          return (
            <label key={option.value} className={cx(CARD, 'flex-col items-start p-4 pr-9', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span className={cx('inline-flex h-12 w-12 items-center justify-center rounded-full border', on ? 'border-accent bg-paper-raised text-accent' : 'border-rule bg-paper-sunk text-ink')} aria-hidden="true">
                <Glyph id={TRANSPORT_GLYPH[option.value] ?? 'compass'} className="h-6 w-6" />
              </span>
              <span className={cx('mt-3 block font-display text-lg leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
              {option.detail ? <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{option.detail}</span> : null}
              <Check on={on} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Rhythm: a day drawn as blocks
// ---------------------------------------------------------------------------

const RHYTHM: Record<string, { blocks: number[]; gaps: number }> = {
  one_big: { blocks: [42, 14], gaps: 10 },
  two_three: { blocks: [24, 20, 18], gaps: 6 },
  cover: { blocks: [14, 12, 14, 12, 14], gaps: 3 },
};

function DayStrip({ value, on }: { value: string; on: boolean }) {
  const shape = RHYTHM[value] ?? RHYTHM.two_three!;
  const starts = shape.blocks.reduce<number[]>((acc, width, index) => [...acc, index === 0 ? 0 : acc[index - 1]! + shape.blocks[index - 1]! + shape.gaps], []);
  return (
    <svg viewBox="0 0 100 14" className="h-3.5 w-full" aria-hidden="true" preserveAspectRatio="none">
      <line x1={0} y1={7} x2={100} y2={7} stroke="var(--color-rule)" strokeWidth={1} />
      {shape.blocks.map((width, index) => (
        <rect key={index} x={starts[index]} y={2} width={width} height={10} rx={2} fill={on ? 'var(--color-accent)' : 'var(--color-ink-faint)'} opacity={on ? 0.9 : 0.6} />
      ))}
    </svg>
  );
}

export function RhythmChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Which day</legend>
      <div className="grid gap-3">
        {options.map((option, index) => {
          const on = value === option.value;
          return (
            <label key={option.value} className={cx(CARD, 'items-start gap-4 p-4 pr-10', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className={cx('mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-display text-sm', on ? 'border-accent bg-accent text-paper' : 'border-rule text-ink-muted')}>
                {String.fromCharCode(65 + index)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block font-display text-lg leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
                {option.detail ? <span className="mt-0.5 block text-sm text-ink-muted">{option.detail}</span> : null}
                <span className="mt-3 block max-w-xs">
                  <DayStrip value={option.value} on={on} />
                  <span className="mt-1 flex justify-between text-[10px] uppercase tracking-[0.14em] text-ink-faint" aria-hidden="true">
                    <span>morning</span>
                    <span>evening</span>
                  </span>
                </span>
              </span>
              <Check on={on} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Spectrum: effort with an elevation profile
// ---------------------------------------------------------------------------

function ProfileLine({ level, on }: { level: number; on: boolean }) {
  const relief = [3, 8, 14, 20][Math.min(3, level)] ?? 8;
  const d = `M0 24 C 15 ${24 - relief * 0.4} 25 ${24 - relief} 40 ${24 - relief * 0.7} S 65 ${24 - relief * 1.1} 80 ${24 - relief * 0.5} S 95 ${24 - relief * 0.2} 100 24`;
  return (
    <svg viewBox="0 0 100 26" className="h-8 w-full" aria-hidden="true" preserveAspectRatio="none">
      <path d={`${d} L100 26 L0 26 Z`} fill={on ? 'var(--color-accent)' : 'var(--color-ink-faint)'} opacity={0.18} />
      <path d={d} fill="none" stroke={on ? 'var(--color-accent)' : 'var(--color-ink-muted)'} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

const SPECTRUM_LEVEL: Record<string, number> = { light: 0, moderate: 1, intense: 3, little: 0, lots: 3, none: 0, short: 1, half_day: 2, full_day: 3 };

export function SpectrumChoice({ name, options, value, onChange }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">How much</legend>
      <div className={cx('grid gap-3', options.length >= 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
        {options.map((option, index) => {
          const on = value === option.value;
          const level = SPECTRUM_LEVEL[option.value] ?? index;
          return (
            <label key={option.value} className={cx(CARD, 'flex-col p-4 pr-9', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
              <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
              <ProfileLine level={level} on={on} />
              <span className={cx('mt-2 block font-display text-lg leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
              {option.detail ? <span className="mt-1 block text-sm leading-relaxed text-ink-muted">{option.detail}</span> : null}
              <Check on={on} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Range map: the ring grows with the answer
// ---------------------------------------------------------------------------

const RANGE_RADIUS: Record<string, number> = {
  destination_only: 14,
  nearby_30: 30,
  nearby_60: 48,
  nearby_120: 70,
  best_regional: 92,
  stay_in_city: 14,
  one_day_trip: 48,
  several: 78,
};

export function RangeMapChoice({ name, options, value, onChange, baseName }: { name: string; options: readonly InterviewOption[]; value: string | undefined; onChange: (value: string) => void; baseName: string }) {
  const selected = value ? (RANGE_RADIUS[value] ?? 40) : 0;
  const hovered = selected;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      <div className="plate relative overflow-hidden rounded-[var(--radius-plate)] border border-rule" style={{ '--plate-hue': 150, '--plate-x': '50%', '--plate-y': '50%' } as React.CSSProperties} aria-hidden="true">
        <svg viewBox="0 0 240 200" className="h-auto w-full">
          {options.map((option) => {
            const r = RANGE_RADIUS[option.value] ?? 40;
            const on = value === option.value;
            return <circle key={option.value} cx={120} cy={100} r={r} fill="none" stroke={on ? 'var(--color-accent)' : 'var(--color-ink)'} strokeWidth={on ? 2 : 1} strokeDasharray={on ? undefined : '3 5'} opacity={on ? 0.9 : 0.35} />;
          })}
          <circle className="ring-live" cx={120} cy={100} r={hovered} fill="var(--color-accent)" opacity={0.12} />
          {[[150, 70], [88, 128], [172, 140], [60, 60], [200, 92]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={3} fill={Math.hypot(x! - 120, y! - 100) <= selected ? 'var(--color-accent)' : 'var(--color-ink-faint)'} className="transition-[fill] duration-[var(--motion-base)]" />
          ))}
          <rect x={115} y={95} width={10} height={10} rx={2} fill="var(--color-ink)" />
          <text x={120} y={122} textAnchor="middle" fontSize={10} fill="var(--color-ink)" fontFamily="var(--font-display)">
            {baseName}
          </text>
          <text x={12} y={190} fontSize={8} fill="var(--color-ink-muted)" letterSpacing={1}>
            SCHEMATIC · NOT TO SCALE
          </text>
        </svg>
      </div>
      <fieldset className="min-w-0">
        <legend className="sr-only">How far</legend>
        <div className="grid gap-2">
          {options.map((option) => {
            const on = value === option.value;
            return (
              <label key={option.value} className={cx(CARD, 'items-center gap-3 px-4 py-3 pr-10', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
                <input type="radio" name={name} value={option.value} checked={on} onChange={() => onChange(option.value)} className={OVERLAY_INPUT} />
                <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center">
                  <svg viewBox="0 0 32 32" className="h-8 w-8">
                    <circle cx={16} cy={16} r={Math.max(3, (RANGE_RADIUS[option.value] ?? 40) / 7)} fill="none" stroke={on ? 'var(--color-accent)' : 'var(--color-ink-faint)'} strokeWidth={1.5} />
                    <rect x={14.5} y={14.5} width={3} height={3} fill="var(--color-ink)" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className={cx('block font-display text-base leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
                  {option.detail ? <span className="block text-xs text-ink-muted">{option.detail}</span> : null}
                </span>
                <Check on={on} />
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget: an axis, then an optional envelope
// ---------------------------------------------------------------------------

const BUDGET_COINS: Record<string, number> = { cheap: 1, value: 2, midrange: 3, premium: 4, luxury: 5, dont_know: 0 };

export function BudgetAxis({ options, value, onChange }: { options: readonly InterviewOption[]; value: { style?: string; envelope: { amount?: number; basis?: string; currency?: string } | null }; onChange: (value: { style?: string; envelope: { amount?: number; basis?: string; currency?: string } | null }) => void }) {
  const [showEnvelope, setShowEnvelope] = useState(Boolean(value.envelope));
  const axis = options.filter((o) => o.value !== 'dont_know');
  const unsure = options.find((o) => o.value === 'dont_know');
  return (
    <div className="space-y-4">
      <fieldset className="min-w-0">
        <legend className="sr-only">Spending style</legend>
        <div className="grid gap-2 sm:grid-cols-5">
          {axis.map((option) => {
            const on = value.style === option.value;
            const coins = BUDGET_COINS[option.value] ?? 3;
            return (
              <label key={option.value} className={cx(CARD, 'flex-col items-start p-3.5 pr-8', FOCUS_RING, on ? CARD_ON : CARD_IDLE)}>
                <input type="radio" name="budget" value={option.value} checked={on} onChange={() => onChange({ ...value, style: option.value })} className={OVERLAY_INPUT} />
                <span className="flex gap-0.5" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((step) => (
                    <span key={step} className={cx('h-2 w-2 rounded-full', step <= coins ? (on ? 'bg-accent' : 'bg-ink-muted') : 'bg-rule')} />
                  ))}
                </span>
                <span className={cx('mt-2.5 block font-display text-base leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
                {option.detail ? <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{option.detail}</span> : null}
                <Check on={on} />
              </label>
            );
          })}
        </div>
        {unsure ? (
          <label className={cx(CARD, 'mt-3 items-center gap-3 px-4 py-3 pr-10', FOCUS_RING, value.style === 'dont_know' ? CARD_ON : 'border-dashed border-rule bg-transparent hover:border-ink-faint')}>
            <input type="radio" name="budget" value="dont_know" checked={value.style === 'dont_know'} onChange={() => onChange({ ...value, style: 'dont_know' })} className={OVERLAY_INPUT} />
            <Glyph id="compass" className={cx('h-6 w-6', value.style === 'dont_know' ? 'text-accent' : 'text-ink-muted')} />
            <span>
              <span className={cx('block text-sm font-medium', value.style === 'dont_know' ? 'text-accent-strong' : 'text-ink')}>{unsure.label}</span>
              {unsure.detail ? <span className="block text-xs text-ink-muted">{unsure.detail}</span> : null}
            </span>
            <Check on={value.style === 'dont_know'} />
          </label>
        ) : null}
      </fieldset>
      {!showEnvelope ? (
        <button type="button" onClick={() => setShowEnvelope(true)} className={cx('text-sm text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-budget-envelope">
          Add a rough envelope (optional)
        </button>
      ) : (
        <fieldset className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4">
          <legend className="px-1 text-sm font-medium text-ink">A rough envelope, excluding flights</legend>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm text-ink">
              <span className="label block text-ink-faint">Amount</span>
              <input type="number" min={1} max={1000000} inputMode="numeric" value={value.envelope?.amount ?? ''} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), amount: Number(event.target.value) || undefined, basis: value.envelope?.basis ?? 'per_person_per_day', currency: value.envelope?.currency ?? 'USD' } })} className="numeral mt-1 w-32 rounded-[var(--radius-control)] border border-rule bg-paper px-2.5 py-2 text-base" />
            </label>
            <label className="text-sm text-ink">
              <span className="label block text-ink-faint">Currency</span>
              <input type="text" maxLength={3} value={value.envelope?.currency ?? 'USD'} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), currency: event.target.value.toUpperCase(), basis: value.envelope?.basis ?? 'per_person_per_day' } })} className="mt-1 w-20 rounded-[var(--radius-control)] border border-rule bg-paper px-2.5 py-2 text-base uppercase" />
            </label>
            <label className="text-sm text-ink">
              <span className="label block text-ink-faint">Per</span>
              <select value={value.envelope?.basis ?? 'per_person_per_day'} onChange={(event) => onChange({ ...value, envelope: { ...(value.envelope ?? {}), basis: event.target.value, currency: value.envelope?.currency ?? 'USD' } })} className="mt-1 rounded-[var(--radius-control)] border border-rule bg-paper px-2.5 py-2 text-base">
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
// Chips (multi) and dietary
// ---------------------------------------------------------------------------

export function ChipGroup({ name, options, value, onChange, tone = 'accent' }: { name: string; options: readonly InterviewOption[]; value: string[]; onChange: (value: string[]) => void; tone?: 'accent' | 'clay' }) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Choose any</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = value.includes(option.value);
          return (
            <label
              key={option.value}
              className={cx(
                'relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-4 py-2 text-sm transition-colors duration-[var(--motion-fast)]',
                FOCUS_RING,
                on ? (tone === 'clay' ? 'border-clay bg-clay-soft text-clay' : 'border-accent bg-accent-soft text-accent-strong') : 'border-rule bg-paper-raised text-ink hover:border-ink-faint',
              )}
              title={option.detail}
            >
              <input type="checkbox" name={name} value={option.value} checked={on} onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((entry) => entry !== option.value))} className={OVERLAY_INPUT} />
              <span aria-hidden="true" className={cx('text-xs', on ? 'opacity-100' : 'opacity-0')}>
                ✓
              </span>
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function DietaryControl({ options, value, onChange }: { options: readonly InterviewOption[]; value: { needs: string[]; strict: boolean }; onChange: (value: { needs: string[]; strict: boolean }) => void }) {
  return (
    <div className="space-y-4">
      <ChipGroup name="dietary" options={options} value={value.needs} onChange={(needs) => onChange({ ...value, needs })} />
      {value.needs.length > 0 ? (
        <SeriousToggle label="These are requirements, not preferences" detail="Say yes and we stop treating “nobody has confirmed it” as good enough." checked={value.strict} onChange={(strict) => onChange({ ...value, strict })} />
      ) : null}
    </div>
  );
}

export function SeriousToggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={cx('flex cursor-pointer gap-3 rounded-[var(--radius-card)] border-l-4 p-4 transition-colors', checked ? 'border-clay bg-clay-soft' : 'border-rule bg-paper-raised')}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-clay)]" />
      <span>
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <Glyph id="lock" className="h-4 w-4 text-clay" />
          {label}
        </span>
        <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Hard limits: a serious list
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
    <div className="space-y-6">
      <fieldset className="min-w-0">
        <legend className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
          <Glyph id="lock" className="h-4 w-4 text-clay" />
          Rules, not wishes. Tick only what must hold.
        </legend>
        <ul className="divide-y divide-rule overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-raised">
          {offer.map((entry) => {
            const on = has(entry.code);
            return (
              <li key={entry.code} className={cx('transition-colors', on ? 'bg-clay-soft' : '')}>
                <label className={cx('flex cursor-pointer items-start gap-3 px-4 py-3', FOCUS_RING)}>
                  <input type="checkbox" checked={on} onChange={(event) => toggle(entry.code, event.target.checked, entry.values?.[1]?.value ?? entry.values?.[0]?.value)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-clay)]" />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-sm font-medium', on ? 'text-clay' : 'text-ink')}>{entry.label}</span>
                    <span className="block text-sm leading-relaxed text-ink-muted">{entry.detail}</span>
                  </span>
                  {on && entry.values ? (
                    <select value={valueOf(entry.code) ?? entry.values[0]!.value} onChange={(event) => setValue(entry.code, Number(event.target.value))} onClick={(event) => event.stopPropagation()} className="numeral shrink-0 rounded-[var(--radius-control)] border border-clay/40 bg-paper px-2 py-1.5 text-sm" aria-label={`${entry.label} value`}>
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
        <label htmlFor="hardNotes" className="flex items-center gap-2 text-sm font-medium text-ink">
          <Glyph id="pen" className="h-4 w-4 text-ink-muted" />
          Anything else, in your own words? (optional)
        </label>
        <textarea id="hardNotes" rows={3} maxLength={500} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} className="mt-2 w-full rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3 text-base leading-relaxed text-ink placeholder:text-ink-faint" placeholder="Altitude, knees, someone who hates heights…" aria-describedby="hardNotes-hint" />
        <p id="hardNotes-hint" className="mt-2 text-sm text-ink-muted">
          Read when the days are composed. A sentence stays a preference unless you tick the box below.
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
      <textarea id={id} rows={5} maxLength={500} value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-[var(--radius-card)] border border-rule bg-paper-raised px-5 py-4 font-display text-lg leading-relaxed text-ink placeholder:text-ink-faint" placeholder={placeholder} />
    </label>
  );
}

export function NamesSpace({ value, onChange }: { value: { include: string[]; avoid: string[] }; onChange: (value: { include: string[]; avoid: string[] }) => void }) {
  const split = (text: string) => text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 10);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block">
        <span className="label block text-pine">Must include</span>
        <textarea rows={5} value={value.include.join('\n')} onChange={(event) => onChange({ ...value, include: split(event.target.value) })} className="mt-2 w-full rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3 font-display text-lg leading-relaxed text-ink placeholder:text-ink-faint" placeholder="One per line" />
      </label>
      <label className="block">
        <span className="label block text-clay">Must avoid</span>
        <textarea rows={5} value={value.avoid.join('\n')} onChange={(event) => onChange({ ...value, avoid: split(event.target.value) })} className="mt-2 w-full rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3 font-display text-lg leading-relaxed text-ink placeholder:text-ink-faint" placeholder="One per line" />
      </label>
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-ink-muted">{children}</p>;
}
