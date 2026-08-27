import 'server-only';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '@sidequest/core';
import { failJob, getJob } from '../../db/compiler-repository';

/**
 * LAUNCHING THE COMPILE WORKER — THE WEB PROCESS'S ONLY PART IN A BUILD.
 *
 * The event-loop freeze this exists to end: a compilation running in the
 * request-serving process held every route hostage for the length of the
 * build. After this, the web process's involvement in a compilation is one
 * `spawn`, one exit listener, and then reads of the job row like any other
 * request.
 *
 * **Detached, and unrefed.** The worker must survive the web process where the
 * platform allows it — a dev-server restart mid-build should cost nothing,
 * because the job's truth is in SQLite and the worker holds its own handle to
 * it. Where the platform kills children with the parent anyway, the orphan
 * reclaim flips the silent job to an honest, retryable terminal state; either
 * way nobody watches a `running` row forever.
 *
 * **The exit is reaped.** Detached does not mean disowned: the parent still
 * hears the child exit, and a child that exited while its job row was not yet
 * terminal died without the chance to write — SIGKILL, the OOM killer, a
 * crashed bootstrap. Before this listener existed, that death was invisible
 * until `HEARTBEAT_TIMEOUT_MS` of silence *plus* a snapshot poll — five
 * minutes of a live-looking "compiling" over a process that no longer
 * existed, and forever if nobody had the page open to poll. The parent knows
 * the moment it happens, so it says so the moment it happens; the heartbeat
 * reclaim remains the backstop for the one death this cannot see, the parent
 * and child dying together.
 *
 * **stdio goes to a per-job log file**, not to 'inherit' and not to the void:
 * the worker's console is the only place its crash reports exist, and a
 * diagnosis that requires reproducing the crash is the thing the observability
 * workstream forbids. Counts and states still live on the job row; the log
 * carries stack traces, never page bodies.
 */

export type CompilerIsolation = 'process' | 'inline';

/**
 * `process` is the default and the production shape. `inline` exists for
 * environments that cannot spawn — and as the automatic fallback when the
 * spawn itself fails, because a traveller whose build cannot be isolated
 * should still get a build rather than an error naming our architecture.
 */
export function compilerIsolationMode(): CompilerIsolation {
  return process.env.SIDEQUEST_COMPILER_ISOLATION?.trim().toLowerCase() === 'inline'
    ? 'inline'
    : 'process';
}

/**
 * The bootstrap's path on disk, found rather than imported — importing it
 * would bundle it, and the whole point is a file plain `node` can run.
 * Two candidates because the dev server's cwd is `apps/web` while scripts and
 * tests run from the repository root.
 */
export function workerEntryPath(cwd = process.cwd()): string | null {
  const candidates = [
    join(cwd, 'src/lib/compiler/worker/compile-worker.mjs'),
    join(cwd, 'apps/web/src/lib/compiler/worker/compile-worker.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export type LaunchOutcome = { launched: true } | { launched: false; reason: string };

export function launchCompilationWorker(input: {
  tripId: string;
  jobId: string;
  /**
   * Called in this process once the worker is gone, whatever ended it.
   *
   * The build slot this worker held is free from that instant, and the queue
   * behind it should move then rather than when somebody next happens to load a
   * page. The exit event is the only moment the web process learns about a
   * finished build for free, so it is the natural place to pump the queue.
   *
   * A callback rather than an import, because the pump has to dispatch — and a
   * launcher that imported its own dispatcher would be a cycle. Never allowed
   * to throw here; see `reapDeadWorker` for why nothing on this path may take a
   * route down.
   */
  onExit?: () => void;
}): LaunchOutcome {
  const entry = workerEntryPath();
  if (!entry) {
    return { launched: false, reason: 'the worker bootstrap is not on disk from this cwd' };
  }

  try {
    const logDir = join(process.cwd(), 'data', 'compile-logs');
    mkdirSync(logDir, { recursive: true });
    const log = openSync(join(logDir, `${input.jobId}.log`), 'a');

    /*
     * The parent's loader hooks stay with the parent. `NODE_OPTIONS` is how a
     * test runner or a debugger injects `--require`/`--import` hooks into its
     * own process, and a spawned worker that re-applies them is no longer the
     * plain Node process the bootstrap was written for — vitest's hooks, for
     * one, expect an IPC channel this child does not have. Every configuration
     * variable the worker actually needs travels as itself.
     */
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const key of Object.keys(env)) {
      if (key.startsWith('VITEST')) delete env[key];
    }

    try {
      const child = spawn(
        process.execPath,
        [entry, `--trip=${input.tripId}`, `--job=${input.jobId}`],
        {
          cwd: process.cwd(),
          env,
          detached: true,
          stdio: ['ignore', log, log],
        },
      );
      child.unref();
      /*
       * The reap. `unref` only stops the child holding this event loop open;
       * the exit event still arrives while the parent lives. A healthy worker
       * writes its terminal row before it exits — synchronously, through the
       * same SQLite handle every write uses — so any exit that leaves the row
       * non-terminal is a death, whatever the exit code claims.
       */
      child.once('exit', (code, signal) => {
        reapDeadWorker(input.jobId, signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
        notifyExit(input.onExit);
      });
      child.once('error', (error) => {
        reapDeadWorker(input.jobId, error instanceof Error ? error.message : 'spawn error');
        notifyExit(input.onExit);
      });
    } finally {
      // The child holds its own duplicate of the descriptor; keeping ours open
      // would leak one per build for the life of the dev server.
      closeSync(log);
    }

    return { launched: true };
  } catch (error) {
    return {
      launched: false,
      reason: error instanceof Error ? error.message : 'spawn failed',
    };
  }
}

/**
 * Tell the caller the worker is gone, and never let that cost a route.
 *
 * Runs on the web process's event loop from a child-exit event, where an
 * uncaught throw has no request to fail and takes the server with it — the same
 * rule `reapDeadWorker` states below, applied to the hook it now sits beside.
 * The reap has already written the job's truth by this point, so a pump that
 * fails costs the queue one cycle and nothing else: the next poll or press
 * pumps again.
 */
function notifyExit(onExit: (() => void) | undefined): void {
  if (!onExit) return;
  try {
    onExit();
  } catch (error) {
    console.error('Could not advance the build queue after a worker exit', { error });
  }
}

/**
 * Convert a dead worker's job to the honest terminal verdict, now rather than
 * five minutes from now.
 *
 * Guarded twice, and both guards carry weight. The terminal check here makes
 * the healthy path a no-op — a worker that finished wrote `ready`, `partial`,
 * `failed` or `cancelled` before it exited, and this must not argue with any
 * of them. And `failJob` itself refuses over a terminal state inside its own
 * transaction, which closes the remaining race: whatever this saw, the write
 * cannot relabel a job that ended between the read and the write.
 *
 * `compilation_interrupted` is the honest code, exactly as the orphan reclaim
 * uses: nothing about the *build* is known to be wrong, its process died, and
 * a retry re-reads the shared evidence store rather than re-buying it.
 *
 * Never throws. This runs on the web process's event loop from a child-exit
 * event, and a diagnostic write must not be able to take a route down.
 */
function reapDeadWorker(jobId: string, how: string): void {
  try {
    const job = getJob(jobId);
    if (!job || isTerminal(job.state)) return;
    console.error('Compile worker died without writing a terminal state; reaping its job', {
      jobId,
      how,
    });
    failJob({
      jobId,
      code: 'compilation_interrupted',
      detail: `The compile worker process died without finishing (${how}).`,
      now: new Date(),
    });
  } catch (error) {
    console.error('Could not reap a dead compile worker’s job', { jobId, error });
  }
}
