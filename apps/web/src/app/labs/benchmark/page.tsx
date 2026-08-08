import Link from 'next/link';
import { caseById } from '@sidequest/bench/cases';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY, redactForbidden } from '@/components/benchmark/copy';
import { Badge, Panel, buttonClass, cx } from '@/components/ui';
import {
  getRuns,
  headPlanForRun,
  listBenchmarkSessions,
  listQuestions,
} from '@/lib/db/benchmark-repository';
import { listCorrections } from '@/lib/db/benchmark-review-repository';

export const dynamic = 'force-dynamic';

/**
 * EVERY COMPARISON, AND WHAT EACH IS WAITING FOR.
 *
 * The one screen that may name a session's *state*, because a state is a fact
 * about the session rather than about either system. What it must not do — and
 * the reason the counts below are pooled rather than listed per arm — is say
 * that one plan has three versions and the other has one, which on a session
 * about to be reviewed would be a fingerprint the reviewer carries into the
 * review.
 *
 * Nothing here is fetched. Every number is a count of rows.
 */
export default async function BenchmarkIndexPage() {
  const sessions = listBenchmarkSessions(100).map((session) => {
    const runs = getRuns(session.id);
    const library = session.caseId === null ? null : caseById(session.caseId);
    return {
      id: session.id,
      state: session.state,
      createdAt: session.createdAt,
      title: redactForbidden(library?.title ?? session.request.destination.text),
      questions: listQuestions(session.id).length,
      plans: runs.filter((run) => headPlanForRun(run.id) !== null).length,
      rounds: listCorrections(session.id).length,
      href: nextStepFor(session.id, session.state),
    };
  });

  return (
    <div className="mx-auto max-w-5xl px-3 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
          <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
            {NEUTRAL_COPY.suiteName}
          </h1>
          <p className="measure mt-3 leading-relaxed text-ink-muted">{LABS_COPY.indexLede}</p>
        </div>
        {/*
          No `shrink-0` here.

          "Totals across every comparison" is a long label, and a row that
          refuses to shrink pushed the document 29 pixels sideways at 390 —
          which is the one responsive failure a screenshot cannot show, because
          a full-page capture is as wide as the content rather than the window.
        */}
        <div className="flex min-w-0 flex-wrap gap-2">
          <Link href="/labs/benchmark/results" className={buttonClass('secondary')}>
            {LABS_COPY.dashboardLink}
          </Link>
          <Link href="/labs/benchmark/new" className={buttonClass('primary')}>
            {LABS_COPY.startOne}
          </Link>
        </div>
      </div>

      {sessions.length === 0 ? (
        <Panel className="mt-8 p-5">
          <p className="text-sm text-ink-muted">{LABS_COPY.noneYet}</p>
        </Panel>
      ) : (
        <ul className="mt-8 grid gap-3" data-testid="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Panel className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{session.title}</p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {LABS_COPY.createdAt} {session.createdAt.slice(0, 10)}
                    </p>
                  </div>
                  <Badge tone="neutral">{LABS_COPY.sessionStates[session.state]}</Badge>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
                  <Count label={LABS_COPY.countQuestions} value={session.questions} />
                  <Count label={LABS_COPY.countPlans} value={session.plans} />
                  <Count label={LABS_COPY.countRounds} value={session.rounds} />
                </dl>

                <Link
                  href={session.href}
                  className={cx(buttonClass('secondary', 'sm'), 'mt-3')}
                  data-testid="session-open"
                >
                  {LABS_COPY.openLabel}
                </Link>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="font-medium text-ink tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Where a session in this state wants the reviewer to go.
 *
 * Derived from the stored state rather than remembered by whoever last visited,
 * for the same reason the trip flow derives its step that way: reload, back
 * button and a link somebody bookmarked all have to land in the same place.
 */
function nextStepFor(sessionId: string, state: string): string {
  const base = `/labs/benchmark/${sessionId}`;
  if (
    state === 'created' ||
    state === 'preparing' ||
    state === 'awaiting_answers' ||
    state === 'running'
  ) {
    return `${base}/run`;
  }
  if (state === 'ready_for_review') return `${base}/review`;
  return `${base}/results`;
}
