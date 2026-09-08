import { cx, FOCUS_RING } from '../ui';

/**
 * PROGRESS AS A PATH OF STAGES, NOT A COUNT.
 *
 * The interview is adaptive, so "Question 8 of 14" is a promise it cannot
 * keep. Five stages can be kept: the trip itself, then what you love, your
 * rhythm, logistics, ready.
 *
 * MVP V3 — the first stage is `trip`, and it starts on the very first screen a
 * traveller sees. Setting up a trip and being interviewed about it are one
 * continuous conversation now, so they share one path; a person who is three
 * questions into "where and when" can see that they are at the beginning of
 * something, not filling in a form before the real thing starts.
 *
 * EXPERIENCE V2 — drawn as a route: a thin line with a mark per stage, the
 * current one filled in the route colour and named, the others as points with
 * their names small beside them on a desktop and hidden on a phone (kept for
 * assistive technology). No pills, no aeroplane.
 */
export const STAGES = ['trip', 'love', 'rhythm', 'logistics', 'ready'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  trip: 'The trip',
  love: 'What you love',
  rhythm: 'Your rhythm',
  logistics: 'Logistics',
  ready: 'Ready',
};

const RHYTHM_IDS = new Set(['day_shape', 'day_start', 'effort', 'iconic_crowds', 'famous_vs_hidden', 'hike_appetite', 'walking_tolerance', 'free_time', 'late_nights', 'weather_avoidances']);

export function stageOf(questionId: string | null): Stage {
  if (questionId === null) return 'trip';
  if (questionId === 'review') return 'ready';
  if (questionId === 'priorities' || questionId === 'priority_roles' || questionId.startsWith('priority_role:')) return 'love';
  if (RHYTHM_IDS.has(questionId)) return 'rhythm';
  return 'logistics';
}

export function StagePath({ current, note, onJump }: { current: Stage; note?: string; onJump?: (stage: Stage) => void }) {
  const index = STAGES.indexOf(current);
  return (
    <nav aria-label="Interview progress" className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="stage-path">
      <ol className="flex items-center" role="list">
        {STAGES.map((stage, i) => {
          const done = i < index;
          const now = i === index;
          /*
           * MVP V3, Stage 40 — a finished stage is a way back.
           *
           * Only a *finished* one: a stage the traveller has not reached is not
           * a place they can go, and rendering it as a control that refuses is
           * worse than rendering it as what it is. The label is a real button
           * with a real accessible name, so this works from the keyboard.
           */
          const clickable = done && onJump !== undefined;
          const body = (
            <>
              <span
                aria-hidden="true"
                className={cx(
                  'inline-block shrink-0 rounded-full transition-colors duration-[var(--motion-base)]',
                  now ? 'h-1.5 w-1.5 bg-[var(--color-route-bright)]' : done ? 'h-2 w-2 bg-ink' : 'h-2 w-2 border border-ink-faint bg-paper',
                )}
              />
              <span className={cx('whitespace-nowrap text-[11px] font-medium tracking-wide', now ? 'text-paper' : done ? 'text-ink max-lg:sr-only' : 'text-ink-faint max-lg:sr-only')}>{STAGE_LABELS[stage]}</span>
            </>
          );
          return (
            <li key={stage} className="flex items-center">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onJump(stage)}
                  className={cx('pressable flex min-h-11 items-center gap-1.5 rounded-full px-1 hover:text-accent-strong', FOCUS_RING)}
                  data-testid={`stage-jump-${stage}`}
                >
                  {/* Not the word "Back": the interview already has a Back button, and two controls answering to one name is ambiguous for a screen-reader user reading a control list. */}
                  <span className="sr-only">Go to </span>
                  {body}
                </button>
              ) : (
                <span className={cx('flex items-center gap-1.5', now && 'rounded-full bg-ink px-2.5 py-0.5')} aria-current={now ? 'step' : undefined}>
                  {body}
                </span>
              )}
              {i < STAGES.length - 1 ? <span aria-hidden="true" className={cx('mx-1.5 h-px w-4 sm:w-7', i < index ? 'bg-ink' : 'bg-rule')} /> : null}
            </li>
          );
        })}
      </ol>
      {/*
        The trip so far, as context rather than as a sixth stage.
        Seen on the live Kyrgyzstan run reading as one orphan word at the end
        of the path, indistinguishable from a stage nobody had reached. A rule
        and a quieter weight put it on the other side of the sentence.
      */}
      {note ? (
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className="h-3 w-px bg-rule" />
          <span className="numeral text-xs text-ink-faint">{note}</span>
        </span>
      ) : null}
    </nav>
  );
}
