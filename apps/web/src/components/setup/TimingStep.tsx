'use client';

import { useEffect, useState, useTransition } from 'react';
import { Glyph, type GlyphId } from '../interview/glyphs';
import { ErrorNote, FOCUS_RING, buttonClass, cx, selectableCardClass } from '../ui';
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
  onContinue: (extra?: Partial<SetupDraft>) => void;
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
  /*
   * V7 §7 — BEST_TIME V4: "TELL ME WHEN IT IS BEST" RECORDS THE MODE, NOT THE DATES.
   *
   * The window for that answer is chosen on the review, once the interview
   * knows what the trip is for and who is going, and scored with crowds and
   * closures as well as climate. Only a traveller who has already narrowed —
   * a month, a season, a free stretch — is shown a comparison here, because
   * for them it is a check on their own answer rather than a decision made
   * before the questions.
   */
  const wantsPick = draft.dateMode === 'window' || draft.dateMode === 'months' || draft.dateMode === 'season';
  const deferredToReview = draft.dateMode === 'best_time';
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
    <div>
      <p className="label">The trip</p>
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
              className={selectableCardClass(on, cx('pressable flex min-h-28 flex-col gap-2 p-4 pr-10 text-left', FOCUS_RING))}
              data-testid={`timing-${card.value}`}
            >
              <Glyph id={card.glyph} className={cx('h-7 w-7', on ? 'text-accent' : 'text-ink-muted')} />
              <span className={cx('font-display text-xl leading-snug', on ? 'font-semibold text-accent-strong' : 'text-ink')}>{card.title}</span>
              <span className={cx('type-small leading-relaxed', on ? 'text-ink' : 'text-ink-muted')}>{card.implication}</span>
              {/* The chosen card says so three ways: ground, doubled edge, and a mark. */}
              {on ? (
                <span aria-hidden="true" className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-paper">
                  <Glyph id="check" className="h-3 w-3" strokeWidth={2.5} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {family === 'exact' ? (
        <div className="rise mt-7 max-w-xl">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">Arrive</span>
              <input type="date" value={draft.startDate} onChange={(event) => onChange({ startDate: event.target.value })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-start" />
            </label>
            <label className="block">
              <span className="label">Leave</span>
              <input type="date" value={draft.endDate} onChange={(event) => onChange({ endDate: event.target.value })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-end" />
            </label>
          </div>
          {nightsBetween(draft.startDate, draft.endDate) !== null ? (
            <p className="type-figure mt-3 text-sm text-ink-muted">{nightsBetween(draft.startDate, draft.endDate)} nights · {(nightsBetween(draft.startDate, draft.endDate) ?? 0) + 1} days</p>
          ) : draft.startDate && draft.endDate ? (
            <p className="mt-3 type-small text-clay">The second date needs to be after the first.</p>
          ) : (
            <p className="mt-3 type-small text-ink-faint">Pick the day you arrive and the day you leave.</p>
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
                <span className="label">Free from</span>
                <input type="date" value={draft.earliest} onChange={(event) => onChange({ earliest: event.target.value, pick: null })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-earliest" />
              </label>
              <label className="block">
                <span className="label">Until</span>
                <input type="date" value={draft.latest} onChange={(event) => onChange({ latest: event.target.value, pick: null })} className={cx('mt-1.5 h-12 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)} data-testid="timing-latest" />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {deferredToReview ? (
        <section className="rise mt-8 max-w-2xl" aria-live="polite" data-testid="timing-pick">
          <p className="flex gap-3 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 type-body text-ink-muted" data-testid="timing-deferred">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
            <span className="min-w-0">Sidequest will choose the best window once it understands the trip — who is going, what it is for, and which weeks are busy where you are headed. You will see the pick, with its reasons, before anything is built.</span>
          </p>
        </section>
      ) : null}

      {/* The recommendation: a period, the reasons, what it costs, and a way to see another. */}
      {wantsPick ? (
        <section className="rise mt-8 max-w-2xl" aria-live="polite" data-testid="timing-pick">
          {pending && !result ? (
            <p className="breathing type-body text-ink-muted">Comparing the months on climate records…</p>
          ) : result?.ok && current ? (
            <div className="card-raised overflow-hidden rounded-[var(--radius-panel)] border-accent/40 bg-accent-soft">
              <div className="p-5 sm:p-6">
                <p className="label text-accent-strong">{shown === 0 ? 'Sidequest’s pick' : 'Another window'}</p>
                <p className="mt-1.5 font-display text-4xl leading-none text-ink">{current.label}</p>
                {/*
                  The exact days, kept as ISO. Small, tabular, and never removed:
                  `timing-lock.spec.ts` reads the window straight out of this
                  block to prove the accepted dates reach the trip.
                */}
                <p className="type-figure mt-2 text-sm text-ink-muted">
                  {current.startDate} → {current.endDate}
                </p>

                {/*
                  THE YEAR, WITH THE WINDOW ON IT.

                  A month range is a fact about a calendar, so it is drawn on
                  one: twelve blocks, the chosen months filled. It is derived
                  from the two dates above and asserts nothing they do not —
                  which is the whole rule for a picture in this product.
                */}
                <YearStrip startDate={current.startDate} endDate={current.endDate} />

                {current.reasons.length > 0 ? (
                  <ul className="mt-5 space-y-2 text-sm leading-relaxed text-ink">
                    {current.reasons.map((reason) => (
                      <li key={reason} className="flex gap-2.5">
                        <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                        <span className="min-w-0">{reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {/*
                  Trade-offs are part of the offer, not a warning about it. Same
                  list, same type size as the reasons, with a hollow mark instead
                  of a filled one — the difference between "and" and "but",
                  drawn rather than boxed in amber.
                */}
                {current.tradeoffs.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
                    {current.tradeoffs.map((tradeoff) => (
                      <li key={tradeoff} className="flex gap-2.5">
                        <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-accent" />
                        <span className="min-w-0">{tradeoff}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={buttonClass('accent')}
                  onClick={() => {
                    /* V6 — the pick travels WITH the advance; see `SetupFlow#advance`. */
                    onContinue({ pick: { ...current }, nights: nightsBetween(current.startDate, current.endDate) ?? draft.nights });
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
              </div>
              <details className="border-t border-accent/30 px-5 py-3 sm:px-6">
                <summary className={cx('inline-flex min-h-11 cursor-pointer items-center type-small text-ink-muted underline underline-offset-4', FOCUS_RING)}>
                  What this does not tell you
                </summary>
                <ul className="mt-2 space-y-1 pb-1 type-small text-ink-muted">
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
            /*
              §5 — "later" is not an error.
              A deferred answer means the traveller's chosen planning mode stands
              and Sidequest will pick the window with the plan. Rendering that in
              the error tone told them something had gone wrong and, worse, the old
              copy told them to go and pick dates instead — which is the one thing
              they had just said they did not want to do.
            */
            result.deferred ? (
              <p className="flex gap-3 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 type-body text-ink-muted" data-testid="timing-deferred">
                <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
                <span className="min-w-0">{result.note}</span>
              </p>
            ) : (
              <ErrorNote>{result.note}</ErrorNote>
            )
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * TWELVE MONTHS, WITH THE CHOSEN WINDOW FILLED IN.
 *
 * A calendar year drawn as twelve blocks, the months the window touches in the
 * accent, the rest as rule. The only inputs are the two ISO dates already on
 * screen, so the picture cannot say anything the text does not — and a window
 * that wraps the new year (December into January) fills both ends, which is what
 * a year drawn as a row honestly looks like.
 *
 * `role="img"` with a full label, because the shape is the information for a
 * sighted reader and the label is the same information for everybody else.
 */
const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function YearStrip({ startDate, endDate }: { startDate: string; endDate: string }) {
  const first = Number(startDate.slice(5, 7)) - 1;
  const last = Number(endDate.slice(5, 7)) - 1;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < 0 || first > 11 || last > 11) return null;
  const inWindow = (index: number) => (first <= last ? index >= first && index <= last : index >= first || index <= last);
  const label = first === last ? `${MONTHS[first]}` : `${MONTHS[first]} to ${MONTHS[last]}`;
  return (
    <div className="mt-4 flex gap-1" role="img" aria-label={`The window covers ${label}.`}>
      {MONTH_INITIALS.map((initial, index) => {
        const on = inWindow(index);
        return (
          <span
            key={`${initial}-${index}`}
            className={cx(
              'type-figure flex h-7 flex-1 items-center justify-center rounded-[0.25rem] text-xs',
              on ? 'bg-accent text-paper' : 'bg-paper-raised text-ink-faint',
            )}
          >
            {initial}
          </span>
        );
      })}
    </div>
  );
}
