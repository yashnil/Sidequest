'use client';

import { onRadioGroupKeys, rovingTabIndex } from './radio-keys';
import { FOCUS_RING, cx } from '../ui';

/**
 * WHO IS GOING — ONE QUESTION, USED BY EVERY DOOR.
 *
 * The composer's "who" step, lifted out so the advisor's "Plan this" and the
 * plan check ask the same question the same way. `later` is "skip — decide
 * later": the party then travels as Sidequest's assumption (two adults) with
 * `partyBasis: 'assumed'`, which every screen that shows it labels.
 */

export type PartyShapeChoice = 'solo' | 'couple' | 'friends' | 'family' | 'other' | 'later';

export const PARTY_SHAPES = [
  { value: 'solo', label: 'Just me', adults: 1, children: 0 },
  { value: 'couple', label: 'Two of us', adults: 2, children: 0 },
  { value: 'friends', label: 'A group of friends', adults: 4, children: 0 },
  { value: 'family', label: 'Family with children', adults: 2, children: 2 },
  { value: 'other', label: 'Something else', adults: 2, children: 0 },
] as const;

export const PARTY_LATER = { value: 'later', label: 'Skip — decide later', adults: 2, children: 0 } as const;

export function describeCounts(adults: number, children: number, assumed = false): string {
  const a = `${adults} adult${adults === 1 ? '' : 's'}`;
  const counts = children > 0 ? `${a}, ${children} child${children === 1 ? '' : 'ren'}` : a;
  return assumed ? `${counts} (assumed)` : counts;
}

export function PartyChoice({
  shape,
  adults,
  children,
  onChange,
  allowLater = true,
  label = 'Who is going',
}: {
  shape: PartyShapeChoice | null;
  adults: number;
  children: number;
  onChange: (next: { shape: PartyShapeChoice; adults: number; children: number }) => void;
  allowLater?: boolean;
  label?: string;
}) {
  const options = allowLater ? [...PARTY_SHAPES, PARTY_LATER] : [...PARTY_SHAPES];
  return (
    <div>
      <div className="ob-rows" role="radiogroup" aria-label={label} onKeyDown={onRadioGroupKeys}>
        {options.map((option, index) => {
          const on = shape === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={rovingTabIndex(on, index, Boolean(shape))}
              onClick={() => onChange({ shape: option.value, adults: option.adults, children: option.children })}
              className="ob-row w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
              data-on={on ? 'true' : 'false'}
              data-testid={`party-${option.value}`}
            >
              <span aria-hidden="true" className="ob-letter">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="ob-row-label">{option.label}</span>
              <span className="ob-row-why type-figure">
                {option.value === 'other' ? 'set the counts' : option.value === 'later' ? 'we plan for 2 adults and say so' : `${option.adults} ${option.adults === 1 ? 'adult' : 'adults'}${option.children ? ` · ${option.children} children` : ''}`}
              </span>
            </button>
          );
        })}
      </div>
      {shape && shape !== 'later' ? (
        <div className="rise mt-8 flex flex-wrap items-end gap-8">
          <Counter label="Adults" min={1} value={adults} onChange={(next) => onChange({ shape, adults: next, children })} />
          <Counter label="Children" min={0} value={children} onChange={(next) => onChange({ shape, adults, children: next })} />
          <p className="coordbar pb-3 text-ink-muted">{describeCounts(adults, children)}</p>
        </div>
      ) : shape === 'later' ? (
        <p className="mt-4 type-small text-ink-muted" data-testid="party-assumed-note">
          We’ll plan for {describeCounts(adults, children)} and label it as assumed. You can set who is going any time from the trip.
        </p>
      ) : null}
    </div>
  );
}

export function Counter({ label, min, value, onChange }: { label: string; min: number; value: number; onChange: (value: number) => void }) {
  const clamp = (next: number) => Math.max(min, Math.min(12, next));
  return (
    <div>
      <p className="sheet-label text-ink-muted">{label}</p>
      <div className="mt-1.5 flex items-stretch border-[1.5px] border-ink">
        <button type="button" aria-label={`One fewer ${label.toLowerCase().replace(/s$/, '')}`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} className={cx('flex h-12 w-12 items-center justify-center text-xl text-ink hover:bg-ink/5 disabled:opacity-35', FOCUS_RING)}>
          −
        </button>
        <span className="ob-cell-big type-figure flex w-14 items-center justify-center border-x border-ink/35 text-ink" aria-live="polite" data-testid={`count-${label.toLowerCase()}`}>
          {value}
        </span>
        <button type="button" aria-label={`One more ${label.toLowerCase().replace(/s$/, '')}`} disabled={value >= 12} onClick={() => onChange(clamp(value + 1))} className={cx('flex h-12 w-12 items-center justify-center text-xl text-ink hover:bg-ink/5 disabled:opacity-35', FOCUS_RING)}>
          +
        </button>
      </div>
    </div>
  );
}
