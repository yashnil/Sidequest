/**
 * WHAT THE COMPILE WORKER ACTUALLY DOES, ONCE THE BOOTSTRAP HAS LOADED IT.
 *
 * Deliberately thin: parse two ids, load the trip, run the same
 * `runCompilation` the inline path runs, exit. Every durable effect — stages,
 * heartbeats, diagnostics, the artifact, the terminal state — is a database
 * write the runner already makes; this file adds only the two things a
 * dedicated process can add and an in-process call cannot:
 *
 * - **`haltOnCancel`**: the pulse may stop this process the moment the job row
 *   says cancelled, because the process exists for exactly this job;
 * - **the hard deadline**: a build stuck *inside* a stage can never reach the
 *   compiler's own between-stage wall-clock check, so a timer here ends it at
 *   the deadline plus a grace period, with an honest terminal verdict, rather
 *   than letting a wedged build spend until somebody notices.
 *
 * No `import 'server-only'` — this is not a server component, it is a worker
 * process, and the bootstrap aliases that guard away exactly as Vitest does.
 */
import { formatCompilationDuration } from '@sidequest/core';
import { failJob, getJob } from '../../db/compiler-repository';
import { getTrip } from '../../db/repository';
import { runCompilation } from '../runner';
import { compileDeadlineMs, DEADLINE_GRACE_MS } from '../limits';
import { TIME_CEILING_DETAIL_PREFIX } from '../verdict';

function argValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((entry) => entry.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export async function workerMain(argv: readonly string[]): Promise<number> {
  const tripId = argValue(argv, 'trip');
  const jobId = argValue(argv, 'job');
  if (!tripId || !jobId) {
    console.error('compile-worker: expected --trip=<id> and --job=<id>');
    return 1;
  }

  const trip = getTrip(tripId);
  if (!trip) {
    // The trip vanished between the action and the spawn — a deletion racing a
    // build. End the job honestly rather than leaving it for the reclaim.
    failJob({
      jobId,
      code: 'internal_error',
      detail: 'The trip this build belonged to no longer exists.',
      now: new Date(),
    });
    return 1;
  }

  /**
   * The hard stop. The compiler's own `maxDurationMs` — threaded from the same
   * `compileDeadlineMs()` — fires first at every between-stage check and
   * degrades to an honest partial region. This timer only ever fires when that
   * check was unreachable for a whole grace period, which means the build is
   * wedged inside a stage; killing it then is not lost value, because a stage
   * that cannot end produces nothing either way.
   *
   * `unref`ed so a finished build never waits on it.
   */
  const deadline = compileDeadlineMs();
  const killer = setTimeout(() => {
    try {
      /*
       * The detail leads with `TIME_CEILING_DETAIL_PREFIX` on purpose: it is
       * how the verdict layer tells a clock-killed build apart from a genuinely
       * exhausted lookup ledger, which share this error code. The first is
       * transient — a warm retry usually finishes — and the traveller copy and
       * the retry offer both hang on the distinction. See `../verdict.ts`.
       */
      failJob({
        jobId,
        code: 'budget_exhausted',
        detail: `${TIME_CEILING_DETAIL_PREFIX}: the build ran past ${formatCompilationDuration(
          Math.round(deadline / 1000),
        )} and its grace period without reaching a checkpoint.`,
        now: new Date(),
      });
    } finally {
      process.exit(1);
    }
  }, deadline + DEADLINE_GRACE_MS);
  killer.unref?.();

  try {
    const result = await runCompilation({ trip, jobId, haltOnCancel: true });
    clearTimeout(killer);
    if (result === null) {
      // The runner already wrote the failure to the job row; the exit code is
      // only for the log file.
      return 1;
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    clearTimeout(killer);
    // `runCompilation` catches the compiler's own throws; reaching here means
    // something outside that failed. The job row must still end.
    console.error('compile-worker: the runner itself threw', error);
    const job = getJob(jobId);
    if (job) {
      failJob({
        jobId,
        code: 'internal_error',
        detail: error instanceof Error ? error.message.slice(0, 300) : undefined,
        now: new Date(),
      });
    }
    return 1;
  }
}
