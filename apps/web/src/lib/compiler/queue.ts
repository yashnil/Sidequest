import 'server-only';
import { after } from 'next/server';
import {
  admitQueuedCompilation,
  nextQueuedCompilation,
  occupiedCompilationSlots,
  overdueQueuedCompilations,
  failJob,
  reclaimAbandonedCompilations,
} from '../db/compiler-repository';
import { getTrip } from '../db/repository';
import { maxConcurrentCompilations, queueWaitCeilingMs } from './limits';
import { runCompilation } from './runner';
import { QUEUE_WAIT_DETAIL_PREFIX } from './verdict';
import { compilerIsolationMode, launchCompilationWorker } from './worker/launch';

/**
 * THE BUILD QUEUE: ONE SLOT, A BOUNDED LINE, AND SOMETHING THAT MOVES IT.
 *
 * The deployment builds one region at a time — `limits.ts` says why, and it is
 * a promise made to volunteer-run services rather than a guess about hardware.
 * What was missing was everything on the other side of that ceiling: a second
 * traveller pressing Build while somebody else's build ran was refused outright,
 * with no line, no place, and no automatic retry, on the single most expensive
 * and most important action in the product.
 *
 * ## The model, in the states that already existed
 *
 * A job is `queued` from the instant it is created, as it always was. What is
 * new is `waiting_since`, which separates the two things `queued` was quietly
 * carrying:
 *
 * | `waiting_since` | meaning | holds a slot? | heartbeat means? |
 * | --- | --- | --- | --- |
 * | null | dispatched — a worker is starting or running | yes | liveness |
 * | set | parked — nothing has been dispatched | no | nothing |
 *
 * `running`, `ready`, `partial`, `failed` and `cancelled` are untouched, the
 * unique index that permits one live job per trip is untouched — and because it
 * already spans `queued`, it deduplicates a second press onto a *waiting* job
 * for free.
 *
 * ## What moves it
 *
 * There is no scheduler process and this does not add one. The pump below runs
 * from the three moments the web process already has:
 *
 * 1. **A worker exits** — the parent hears it (`launch.ts` reaps the row there),
 *    so the slot is known free the instant a build completes, fails or is
 *    killed;
 * 2. **A snapshot poll** — the waiting traveller's own page asks every 1.2 s,
 *    which is also what makes the queue move for a build cancelled or reaped in
 *    another process;
 * 3. **A build press** — so an arriving traveller pays for the sweep that may
 *    let them start immediately.
 *
 * None of them is required to be the one that works: the pump is idempotent and
 * every admission is a guarded UPDATE, so several callers racing produce one
 * dispatch and one dispatch only.
 */

/** Dispatches one accepted job. Injectable so the queue's policy can be tested. */
export type CompilationDispatcher = (input: { tripId: string; jobId: string }) => void;

/**
 * Hand one job to a process — a dedicated worker, or this one as the fallback.
 *
 * Lifted out of `startCompilationAction` unchanged in behaviour, because the
 * queue needs the identical thing at a different moment: a job admitted from
 * the line must be started exactly the way a job that never waited is, or the
 * two paths drift and only one of them is ever exercised by hand.
 */
export function dispatchCompilation(input: { tripId: string; jobId: string }): void {
  const isolation = compilerIsolationMode();
  const launched =
    isolation === 'process'
      ? launchCompilationWorker({
          tripId: input.tripId,
          jobId: input.jobId,
          // The slot frees when the worker goes, whatever ended it, so the next
          // build in line starts then rather than when somebody loads a page.
          onExit: () => pumpCompilationQueue(),
        })
      : { launched: false as const, reason: 'inline isolation configured' };

  if (launched.launched) return;

  if (isolation === 'process') {
    // The fallback is a degradation worth a log line: the build still runs, but
    // on this event loop, which is the exact condition the worker exists to end.
    console.error('Compile worker could not be spawned; running inline', {
      tripId: input.tripId,
      jobId: input.jobId,
      reason: launched.reason,
    });
  }

  const trip = getTrip(input.tripId);
  if (!trip) {
    /*
     * The trip was deleted between accepting the job and starting it. Ended
     * rather than left `queued`, because a row nothing will ever run is the
     * thing that holds the queue's promise open for nobody.
     */
    failJob({
      jobId: input.jobId,
      code: 'internal_error',
      detail: 'The trip this build belongs to no longer exists.',
      now: new Date(),
    });
    return;
  }

  after(async () => {
    try {
      await runCompilation({ trip, jobId: input.jobId });
    } catch (error) {
      console.error('Compilation runner failed', {
        tripId: input.tripId,
        jobId: input.jobId,
        error,
      });
    } finally {
      // The inline path has no child to reap, so this is its only chance to
      // hand the slot on.
      pumpCompilationQueue();
    }
  });
}

/**
 * Free what is no longer running, end what has waited too long, and start as
 * many builds from the line as there are slots for.
 *
 * In that order, and the order is the point: a slot held by a corpse must be
 * released before capacity is measured, or the queue waits on a process that
 * ended days ago.
 *
 * Returns how many builds it dispatched, which is what the tests assert on and
 * what a caller may safely ignore.
 */
export function pumpCompilationQueue(
  now = new Date(),
  dispatch: CompilationDispatcher = dispatchCompilation,
): number {
  /*
   * The existing reclaim, asked about the whole deployment rather than about
   * one trip — same threshold, same verdict, same guards. Extended rather than
   * duplicated, because the traveller whose worker died is precisely the one
   * who will not be reloading the page that used to be the only trigger.
   */
  reclaimAbandonedCompilations(now);

  /*
   * A place in line that nobody is waiting for. The heartbeat cannot say this —
   * a parked job has no process to keep one — so the wait ceiling does, and it
   * is derived from the same numbers that justify the queue's depth.
   */
  for (const stale of overdueQueuedCompilations(now, queueWaitCeilingMs())) {
    failJob({
      jobId: stale.id,
      code: 'provider_rate_limited',
      detail: `${QUEUE_WAIT_DETAIL_PREFIX} after waiting for a free build slot.`,
      now,
    });
  }

  let dispatched = 0;
  const ceiling = maxConcurrentCompilations();
  while (occupiedCompilationSlots(now) < ceiling) {
    const next = nextQueuedCompilation();
    if (!next) break;
    /*
     * Losing this is normal, not an error: the pump runs from polls, presses
     * and worker exits, so two callers reaching the same head of the queue
     * within a second is the expected case. The loser dispatches nothing and
     * the loop asks again — the winner's job now occupies the slot, so the next
     * turn either finds the queue empty or finds capacity gone.
     */
    if (!admitQueuedCompilation(next.id, now)) continue;
    dispatch({ tripId: next.tripId, jobId: next.id });
    dispatched += 1;
  }
  return dispatched;
}
