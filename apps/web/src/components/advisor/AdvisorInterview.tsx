'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  answerAdvisorQuestion,
  advisorQuestionById,
  destinationCatalog,
  nextQuestion,
  profileChips,
  skipAdvisorQuestion,
  type FocusKey,
  type QuestionId,
  type TripComposerAnswers,
} from '@sidequest/core';
import { buildAdvisorShortlistAction, saveAdvisorAnswersAction } from '@/app/(product)/decide/advisor-actions';
import { buttonClass, cx, ErrorNote } from '@/components/ui';
import { Glyph, type GlyphId } from '@/components/interview/glyphs';
import { WorldDots } from './WorldDots';

/**
 * THE DESTINATION INTERVIEW, IN THE BROWSER.
 *
 * The policy (`@sidequest/core` → `advisor/questions`) is a pure function of
 * the answers and the catalog, so it runs here: each tap re-ranks the world in
 * a few milliseconds, the next question is the one expected to move the list
 * most, and the "taking shape" panel shows the provisional list changing as it
 * happens. Every answer is saved as it is given; the server re-ranks from the
 * stored answers when the shortlist is built, so nothing the browser computes
 * is trusted beyond what it shows.
 */

const FOCUS_GLYPHS: Record<FocusKey, GlyphId> = {
  mountains: 'altitude',
  hiking: 'hike',
  wildlife: 'wildlife',
  lakes: 'lake',
  beaches: 'beach',
  rainforest: 'tent',
  road_trips: 'drive',
  desert: 'sunrise',
  volcanoes: 'geology',
  snow: 'stars',
  culture_food: 'food',
  cities: 'neighbourhood',
};

function impactWords(value: number): string {
  if (value >= 0.5) return 'Your answer could reshape most of the list.';
  if (value >= 0.3) return 'Your answer could swap several places.';
  return 'Your answer could change a place or two.';
}

export function AdvisorInterview({
  sessionId,
  initial,
  understood,
  startAt,
}: {
  sessionId: string;
  initial: TripComposerAnswers;
  /** Chips read from what they typed, shown once at the top. */
  understood: string[];
  /** Re-ask one question (from "change" on the shortlist). */
  startAt?: QuestionId | null;
}) {
  const router = useRouter();
  const catalog = useMemo(() => destinationCatalog(), []);
  const [answers, setAnswers] = useState(initial);
  const [forced, setForced] = useState<QuestionId | null>(startAt ?? null);
  const [error, setError] = useState<string | null>(null);
  /* Questions put on this screen — not the ones the typed request already settled. */
  const [shown, setShown] = useState(1);
  const [building, startBuilding] = useTransition();
  const built = useRef(false);

  const step = useMemo(() => nextQuestion(answers, catalog), [answers, catalog]);
  const question = forced ? advisorQuestionById(forced) : step.question;
  const value = question ? step.values.find((entry) => entry.id === question.id)?.value : undefined;
  const chips = useMemo(() => profileChips(answers), [answers]);
  const byId = useMemo(() => new Map(catalog.map((entry) => [entry.id, entry])), [catalog]);
  const leaning = step.current.map((id) => byId.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const points = useMemo(() => catalog.map((entry) => ({ id: entry.id, lat: entry.center.lat, lng: entry.center.lng })), [catalog]);
  const asked = answers.discovery?.asked.length ?? 0;

  /*
   * Saves run one after another. Two quick taps fired as independent requests
   * can land out of order, and the older answer would then overwrite the newer
   * one on the server while the screen showed the newer.
   */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const save = (next: TripComposerAnswers) => {
    const queued = saving.current.then(() => saveAdvisorAnswersAction(sessionId, next));
    saving.current = queued.catch(() => undefined);
    return queued;
  };

  const commit = (next: TripComposerAnswers) => {
    setAnswers(next);
    setShown((count) => count + 1);
    setForced(null);
    setError(null);
    void save(next).then((result) => {
      if (!result.ok) setError(result.error ?? 'We could not save that answer.');
    });
  };

  const build = (from: TripComposerAnswers) => {
    if (built.current) return;
    built.current = true;
    startBuilding(async () => {
      const saved = await save(from);
      if (!saved.ok) {
        built.current = false;
        setError(saved.error ?? 'We could not save your answers.');
        return;
      }
      const result = await buildAdvisorShortlistAction(sessionId);
      if (!result.ok) {
        built.current = false;
        setError(result.error ?? 'We could not build the list.');
        return;
      }
      /* Back to the plain URL: from `?edit=1` a refresh would reopen the interview and build again. */
      router.replace(`/decide/${sessionId}`);
      router.refresh();
    });
  };

  /* The interview decided it has enough: build without asking for another press. */
  useEffect(() => {
    if (!question && step.ready && !building && !built.current) build(answers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, step.ready]);

  const answerOne = (optionId: string) => {
    if (!question) return;
    commit(answerAdvisorQuestion(answers, question.id, [optionId]));
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-14">
      <section aria-live="polite" aria-labelledby="advisor-question" className="min-w-0">
        {understood.length > 0 && asked <= 2 ? (
          <div className="mb-8">
            <p className="sheet-label text-ink-muted">What we took from that</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {understood.map((label) => (
                <li key={label} className="rounded-full bg-paper-sunk px-3 py-1 text-sm text-ink">
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {question && !building ? (
          <div key={question.id} className="fade-up" data-testid={`advisor-question-${question.id}`}>
            <p className="sheet-label inline-flex items-center gap-2 text-accent">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
              {question.essential ? 'To start' : `Question ${shown}`}
            </p>
            <h2 id="advisor-question" className="mt-3 max-w-[24ch] font-display text-[clamp(2rem,1.4rem+2.2vw,3.25rem)] leading-[1.02] font-[340] tracking-[-0.025em] text-balance text-ink">
              {question.prompt}
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">{question.why}</p>
            {value !== undefined && !question.essential ? <p className="type-meta mt-2 text-ink-faint">{impactWords(value)}</p> : null}

            {question.select === 'many' ? (
              <FocusPicker
                prompt={question.prompt}
                options={question.options(answers).map((option) => ({ id: option.id, label: option.label }))}
                initial={answers.discovery?.focus ?? []}
                onDone={(picked) => commit(answerAdvisorQuestion(answers, 'focus', picked))}
              />
            ) : (
              <div role="radiogroup" aria-labelledby="advisor-question" className="mt-8 grid gap-2 sm:grid-cols-2">
                {question.options(answers).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={false}
                    onClick={() => answerOne(option.id)}
                    className="group flex min-h-16 items-center justify-between gap-4 rounded-[var(--radius-card)] border border-ink/15 bg-paper-raised px-4 py-3.5 text-left transition-[border-color,transform,background-color] duration-[var(--motion-fast)] hover:-translate-y-0.5 hover:border-ink focus-visible:ring-2 focus-visible:ring-flare focus-visible:outline-none"
                  >
                    <span className="min-w-0">
                      <span className="block text-base font-medium text-ink">{option.label}</span>
                      {option.hint ? <span className="mt-0.5 block text-sm text-ink-muted">{option.hint}</span> : null}
                    </span>
                    <span aria-hidden="true" className="text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink">
                      →
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-ink/10 pt-5">
              {!question.essential ? (
                <button type="button" onClick={() => commit(skipAdvisorQuestion(answers, question.id))} className="min-h-11 text-sm text-ink-muted underline underline-offset-4 hover:text-ink">
                  Skip this one
                </button>
              ) : null}
              {step.ready ? (
                <button type="button" onClick={() => build(answers)} className={buttonClass('secondary', 'md')}>
                  Show me places now
                </button>
              ) : (
                <span className="type-small text-ink-faint">Two quick ones and we can start showing places.</span>
              )}
            </div>
          </div>
        ) : (
          <div className="fade-up" role="status">
            <p className="sheet-label text-accent">Enough to go on</p>
            <h2 id="advisor-question" className="mt-3 font-display text-[clamp(2rem,1.4rem+2.2vw,3.25rem)] leading-[1.02] font-[340] tracking-[-0.025em] text-ink">
              Comparing {catalog.length} destinations against what you said…
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">
              {step.stopReason === 'low_value'
                ? 'Another question would barely change the list, so we stopped asking.'
                : 'Ranking the world, choosing three different answers and checking their weather against twenty years of records.'}
            </p>
            <div className="mt-6 h-1 w-full max-w-md overflow-hidden rounded-full bg-paper-sunk" aria-hidden="true">
              <div className="h-full w-1/3 animate-[advisor-sweep_1.4s_ease-in-out_infinite] rounded-full bg-flare" />
            </div>
          </div>
        )}

        {error ? (
          <div className="mt-6">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
      </section>

      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Your shortlist taking shape">
        <div className="survey-night rounded-[var(--radius-card)] p-4 text-bone">
          <p className="sheet-label text-bone/70">{step.ready ? 'Leaning towards' : 'Every place we know'}</p>
          <WorldDots
            points={points}
            highlighted={step.ready ? leaning.slice(0, 6).map((entry) => entry.id) : []}
            tone="night"
            className="mt-3 h-auto w-full"
            label={step.ready ? `A world map with the ${Math.min(6, leaning.length)} destinations currently leading` : `A world map of the ${catalog.length} destinations in our catalog`}
          />
          {step.ready ? (
            <ol className="mt-3 space-y-1.5">
              {leaning.slice(0, 6).map((entry, index) => (
                <li key={entry.id} className="flex items-baseline gap-2 text-sm">
                  <span className="font-mono text-[0.7rem] text-flare">{index + 1}</span>
                  <span className="min-w-0 truncate text-bone">{entry.name}</span>
                  <span className="ml-auto shrink-0 truncate text-[0.75rem] text-bone/55">{entry.context}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-bone/70">{catalog.length} destinations on every continent. Answer the first two and the leaders light up.</p>
          )}
          <p className="mt-3 border-t border-bone/10 pt-2 text-[0.72rem] text-bone/50">Provisional — it changes as you answer.</p>
        </div>

        {chips.length > 0 ? (
          <div className="mt-5">
            <p className="sheet-label text-ink-muted">What we know so far</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <li key={`${chip.question}-${chip.label}`}>
                  <button
                    type="button"
                    onClick={() => setForced(chip.question)}
                    className="min-h-9 rounded-full border border-ink/15 px-3 py-1 text-left text-sm text-ink hover:border-ink"
                    aria-label={`Change: ${chip.label}`}
                  >
                    {chip.label}
                    {chip.assumed ? <span className="ml-1.5 text-[0.7rem] text-ink-faint">assumed</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/** The one multi-select: its own state, seeded once from the stored answers, remounted per question. */
function FocusPicker({
  prompt,
  options,
  initial,
  onDone,
}: {
  prompt: string;
  options: { id: string; label: string }[];
  initial: readonly string[];
  onDone: (picked: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([...initial]);
  return (
    <fieldset className="mt-8">
      <legend className="sr-only">{prompt} Choose any that apply.</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const on = picked.includes(option.id);
          return (
            <label
              key={option.id}
              className={cx(
                'relative flex min-h-[5.5rem] cursor-pointer flex-col justify-between gap-3 rounded-[var(--radius-card)] border p-3.5 transition-[border-color,background-color,transform] duration-[var(--motion-fast)] focus-within:ring-2 focus-within:ring-flare',
                on ? 'border-ink bg-ink text-bone' : 'border-ink/15 bg-paper-raised text-ink hover:-translate-y-0.5 hover:border-ink/50',
              )}
            >
              <input
                type="checkbox"
                className="absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0"
                checked={on}
                onChange={() => setPicked((current) => (on ? current.filter((id) => id !== option.id) : [...current, option.id]))}
              />
              <Glyph id={FOCUS_GLYPHS[option.id as FocusKey] ?? 'compass'} className={cx('h-6 w-6', on ? 'text-flare' : 'text-ink-muted')} />
              <span className="text-[0.95rem] leading-tight font-medium">{option.label}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button type="button" disabled={picked.length === 0} onClick={() => onDone(picked)} className={buttonClass('accent', 'lg')}>
          {picked.length === 0 ? 'Pick at least one' : `Continue with ${picked.length}`}
        </button>
        <span className="type-small text-ink-muted">Choose everything that appeals — we’ll ask what leads next.</span>
      </div>
    </fieldset>
  );
}
