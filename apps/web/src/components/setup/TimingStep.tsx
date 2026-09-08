'use client';

import { useEffect, useState, useTransition } from 'react';
import { Glyph, type GlyphId } from '../interview/glyphs';
import { ErrorNote, FOCUS_RING, buttonClass, cx } from '../ui';
import { recommendTimingAction, type TimingResult, type TimingWindowView } from '@/app/(product)/trips/new/timing-actions';
import { nightsBetween, type SetupDraft } from './setup-draft';

/**
 * WHEN — AS A DECISION ABOUT HOW SETTLED YOU ARE, NOT A DATE PICKER.
 *
 * MVP V3, Stages 5, 6 and 46. Four cards, each one carrying what it *means* for
 * the trip rather than a label. The one that matters most is the third: "Tell me
 * when it is best" asks for no date at all and answers with a period, the
 * reasons behind it and what it costs you — from climate records, with the
 * things nobody sourced named out loud.
 *
 * The card that used to be five bland rectangles is now four choices with an
 * implication each, and the sub-question inside "roughly when" is only revealed
 * once that card is chosen — so the screen holds one decision at a time.
 */

type Family = 'exact' | 'roughly' | 'best' | 'undecided';

const FAMILY_CARDS: { value: Family; glyph: GlyphId; title: string; implication: string }[] = [
  { value: 'exact', glyph: 'clock', title: 'I know my dates', implication: 'The plan is built to the day, around your arrival and departure.' },
  { value: 'roughly', glyph: 'compass', title: 'I know roughly when', implication: 'A month, a few months, a season, or a stretch you are free in.' },
  { value: 'best', glyph: 'sunrise', title: 'Tell me when it is best', implication: 'Sidequest compares the months on climate records and picks the window.' },
  { value: 'undecided', glyph: 'quiet', title: 'I have not decided', implication: 'Plan it first, put dates on it later.' },
];

const ROUGHLY_KINDS = [
  { value: 'month', label: 'A month' },
  { value: 'months', label: 'One of a few months' },
  { value: 'season', label: 'A season' },
  { value: 'window', label: 'Free between two dates' },
] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;

function familyOf(mode: SetupDraft['dateMode']): Family {
  if (mode === 'exact' || mode === 'flexible') return 'exact';
  if (mode === 'best_time') return 'best';
  if (mode === 'undecided') return 'undecided';
  return 'roughly';
}

export function TimingStep({
  draft,
  headingRef,
  onChange,
  onContinue,
}: {
  draft: SetupDraft;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onChange: (patch: Partial<SetupDraft>) => void;
  onContinue: () => void;
}) {
  const family = familyOf(draft.dateMode);
  /*
   * The recommendation is stored with the inputs that produced it, and read only
   * while those inputs still hold. Deriving rather than clearing means a slow
   * answer for a month the traveller has already changed can never appear on
   * screen, and there is no reset effect to get wrong.
   */
  const [answered, setAnswered] = useState<{ key: string; result: TimingResult } | null>(null);
  const [shown, setShown] = useState(0);
  const [pending, startTransition] = useTransition();

  /*
   * The recommendation is asked for when — and only when — the traveller has
   * chosen a mode that means "you choose". It is never fetched speculatively:
   * a climate lookup nobody asked for is a provider call nobody authorised.
   */
  const wantsPick = draft.dateMode === 'best_time' || draft.dateMode === 'window' || draft.dateMode === 'months' || draft.dateMode === 'season';
  const key = `${draft.dateMode}:${draft.months.join(',')}:${draft.season}:${draft.earliest}:${draft.latest}:${draft.nights ?? ''}:${draft.destinationEntryId ?? draft.destinationCenter?.lat ?? ''}`;
  useEffect(() => {
    if (!wantsPick) return;
    let cancelled = false;
    startTransition(async () => {
      const outcome = await recommendTimingAction({
        entryId: draft.destinationEntryId,
        lat: draft.destinationCenter?.lat ?? null,
        lng: draft.destinationCenter?.lng ?? null,
        nights: draft.nights ?? 7,
        months: draft.dateMode === 'months' ? draft.months : [],
        season: draft.dateMode === 'season' ? draft.season : null,
        earliest: draft.dateMode === 'window' ? draft.earliest : null,
        latest: draft.dateMode === 'window' ? draft.latest : null,
      });
      if (!cancelled) {
        setAnswered({ key, result: outcome });
        setShown(0);
      }
    });
    return () => {
      cancelled = true;
    };
    // Recomputed only when something the recommendation depends on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantsPick]);

  function setFamily(next: Family) {
    onChange({
      dateMode: next === 'exact' ? 'exact' : next === 'best' ? 'best_time' : next === 'undecided' ? 'undecided' : 'month',
      pick: null,
    });
  }

  const result = answered?.key === key ? answered.result : null;
  const windows: TimingWindowView[] = result?.ok ? [result.pick, ...result.alternatives] : [];
  const current = windows[shown] ?? null;

  return (
    <div className="enter">
      <p className="label text-ink-faint">The trip</p>
      <h1 ref={headingRef} tabIndex={-1} className="type-title mt-1.5 max-w-[24ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
        When can you travel?
      </h1>
      <p className="mt-2 max-w-[60ch] type-body text-ink-muted">
        Season decides more of a trip than almost anything else. You do not have to know your dates.
      </p>

      <div className="mt-7 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How settled your timing is">
        {FAMILY_CARDS.map((card) => {
          const on = family === card.value;
          return (
            <button
              key={card.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setFamily(card.value)}
              className={cx(
                'pressable flex min-h-24 flex-col gap-2 rounded-[var(--radius-card)] border p-4 text-left transition-colors',
                FOCUS_RING,
                on ? 'border-accent bg-accent-soft' : 'border-rule bg-paper-raised hover:border-ink-faint',
              )}
              data-testid={`timing-${card.value}`}
            >
              <Glyph id={card.glyph} className={cx('h-6 w-6', on ? 'text-accent' : 'text-ink-muted')} />
              <span className={cx('font-display text-lg leading-snug', on ? 'text-accent-strong' : 'text-ink')}>{card.title}</span>
              <span className="type-small leading-relaxed text-ink-muted">{card.implication}</span>
            </button>
          );
        })}
      </div>

      {family === 'exact' ? (
        <div className="rise mt-7 max-w-xl">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label text-ink-faint">Arrive</span>
              <input type="date" value={draft.startDate} onChange={(event) => onChange({ startDate: event.target.value })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-start" />
            </label>
            <label className="block">
              <span className="label text-ink-faint">Leave</span>
              <input type="date" value={draft.endDate} onChange={(event) => onChange({ endDate: event.target.value })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-end" />
            </label>
          </div>
          {nightsBetween(draft.startDate, draft.endDate) !== null ? (
            <p className="numeral mt-3 text-sm text-ink-muted">{nightsBetween(draft.startDate, draft.endDate)} nights · {(nightsBetween(draft.startDate, draft.endDate) ?? 0) + 1} days</p>
          ) : (
            <p className="mt-3 type-small text-clay">The second date needs to be after the first.</p>
          )}
          <button
            type="button"
            aria-pressed={draft.dateMode === 'flexible'}
            onClick={() => onChange({ dateMode: draft.dateMode === 'flexible' ? 'exact' : 'flexible' })}
            className={cx('mt-4 inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition-colors', FOCUS_RING, draft.dateMode === 'flexible' ? 'border-accent bg-accent-soft text-accent-strong' : 'border-dashed border-rule text-ink-muted hover:text-ink')}
          >
            These can move by a few days
          </button>
        </div>
      ) : null}

      {family === 'roughly' ? (
        <div className="rise mt-7 max-w-xl">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How roughly">
            {ROUGHLY_KINDS.map((kind) => {
              const on = draft.dateMode === kind.value;
              return (
                <button
                  key={kind.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange({ dateMode: kind.value, pick: null })}
                  className={cx('pressable inline-flex min-h-11 items-center rounded-full border px-4 text-sm transition-colors', FOCUS_RING, on ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper-raised text-ink hover:border-ink-faint')}
                  data-testid={`timing-kind-${kind.value}`}
                >
                  {kind.label}
                </button>
              );
            })}
          </div>

          {draft.dateMode === 'month' ? (
            <div className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {MONTHS.map((name, index) => {
                const on = draft.month === index + 1;
                return (
                  <button key={name} type="button" aria-pressed={on} onClick={() => onChange({ month: index + 1 })} className={cx('pressable min-h-11 rounded-[var(--radius-control)] border px-2 text-sm transition-colors', FOCUS_RING, on ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper-raised text-ink hover:border-ink-faint')}>
                    {name.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          ) : null}

          {draft.dateMode === 'months' ? (
            <div className="mt-5">
              <p className="type-small text-ink-faint">Pick every month that would work. Sidequest chooses between them.</p>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {MONTHS.map((name, index) => {
                  const on = draft.months.includes(index + 1);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ months: on ? draft.months.filter((m) => m !== index + 1) : [...draft.months, index + 1].sort((a, b) => a - b), pick: null })}
                      className={cx('pressable min-h-11 rounded-[var(--radius-control)] border px-2 text-sm transition-colors', FOCUS_RING, on ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper-raised text-ink hover:border-ink-faint')}
                    >
                      {name.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {draft.dateMode === 'season' ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {SEASONS.map((season) => {
                const on = draft.season === season;
                return (
                  <button key={season} type="button" aria-pressed={on} onClick={() => onChange({ season, pick: null })} className={cx('pressable min-h-11 rounded-full border px-4 text-sm capitalize transition-colors', FOCUS_RING, on ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper-raised text-ink hover:border-ink-faint')}>
                    {season}
                  </button>
                );
              })}
            </div>
          ) : null}

          {draft.dateMode === 'window' ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="label text-ink-faint">Free from</span>
                <input type="date" value={draft.earliest} onChange={(event) => onChange({ earliest: event.target.value, pick: null })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-earliest" />
              </label>
              <label className="block">
                <span className="label text-ink-faint">Until</span>
                <input type="date" value={draft.latest} onChange={(event) => onChange({ latest: event.target.value, pick: null })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-latest" />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The recommendation: a period, the reasons, what it costs, and a way to see another. */}
      {wantsPick ? (
        <section className="rise mt-8 max-w-2xl" aria-live="polite" data-testid="timing-pick">
          {pending && !result ? (
            <p className="breathing type-body text-ink-muted">Comparing the months on climate records…</p>
          ) : result?.ok && current ? (
            <div className="rounded-[var(--radius-panel)] border border-accent/40 bg-accent-soft p-5">
              <p className="label text-accent-strong">{shown === 0 ? "Sidequest's pick" : 'Another window'}</p>
              <p className="mt-1 font-display text-3xl leading-tight text-ink">{current.label}</p>
              <p className="numeral mt-1 text-sm text-ink-muted">
                {current.startDate} → {current.endDate}
              </p>
              {current.reasons.length > 0 ? (
                <ul className="mt-4 space-y-1.5 text-sm text-ink">
                  {current.reasons.map((reason) => (
                    <li key={reason} className="flex gap-2">
                      <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {current.tradeoffs.length > 0 ? (
                <ul className="mt-3 space-y-1 type-small text-ink-muted">
                  {current.tradeoffs.map((tradeoff) => (
                    <li key={tradeoff}>Trade-off: {tradeoff}</li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={buttonClass('primary')}
                  onClick={() => {
                    onChange({ pick: { ...current }, nights: nightsBetween(current.startDate, current.endDate) ?? draft.nights });
                    onContinue();
                  }}
                  data-testid="timing-accept"
                >
                  Use this timing
                </button>
                {windows.length > 1 ? (
                  <button type="button" className={buttonClass('ghost')} onClick={() => setShown((shown + 1) % windows.length)} data-testid="timing-another">
                    Show another window
                  </button>
                ) : null}
              </div>
              <details className="mt-4">
                <summary className={cx('cursor-pointer type-small text-ink-faint underline underline-offset-4', FOCUS_RING)}>What this does not tell you</summary>
                <ul className="mt-2 space-y-1 type-small text-ink-muted">
                  {result.unknowns.map((unknown) => (
                    <li key={unknown}>{unknown}</li>
                  ))}
                  <li>
                    {result.attribution} · normals from {result.sampleYears}.
                  </li>
                </ul>
              </details>
            </div>
          ) : result && !result.ok ? (
            <ErrorNote>{result.note}</ErrorNote>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
