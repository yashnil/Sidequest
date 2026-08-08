import { notFound } from 'next/navigation';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY } from '@/components/benchmark/copy';
import { RunMonitor } from '@/components/benchmark/RunMonitor';
import { getBenchmarkSession } from '@/lib/db/benchmark-repository';
import { sessionIdFromParam } from '../session-id';
import {
  answerPooledQuestionAction,
  planBothRunsAction,
  runSnapshotAction,
  startBothRunsAction,
} from './actions';
import { buildRunSnapshot } from './snapshot';

export const dynamic = 'force-dynamic';

/**
 * BOTH PLANS BEING BUILT, WITH NOTHING SAYING WHICH IS WHICH.
 *
 * The page builds the snapshot itself rather than calling the poll action,
 * because invoking a server action while producing a response is a fetch during
 * render wearing a server action's clothes — and this repository has an
 * architecture test that says so. The two share `buildRunSnapshot`, so the first
 * paint and every poll after it are the same projection.
 *
 * The four actions below are *referenced* and handed to the client component.
 * That is the supported shape: they run in the browser, after the page is on
 * screen, because somebody pressed something or a timer fired.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const sessionId = sessionIdFromParam((await params).sessionId);
  const session = getBenchmarkSession(sessionId);
  if (!session) notFound();

  const snapshot = buildRunSnapshot(sessionId, new Date());
  if (snapshot === null) notFound();

  return (
    <div className="mx-auto max-w-4xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {LABS_COPY.runTitle}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">{LABS_COPY.runLede}</p>

      <div className="mt-8">
        <RunMonitor
          sessionId={sessionId}
          initial={snapshot}
          refresh={runSnapshotAction}
          start={startBothRunsAction.bind(null, sessionId)}
          plan={planBothRunsAction.bind(null, sessionId)}
          answer={answerPooledQuestionAction}
        />
      </div>
    </div>
  );
}
