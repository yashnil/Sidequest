import 'server-only';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LAUNCHING THE COMPILE WORKER — THE WEB PROCESS'S ONLY PART IN A BUILD.
 *
 * The event-loop freeze this exists to end: a compilation running in the
 * request-serving process held every route hostage for the length of the
 * build. After this, the web process's involvement in a compilation is one
 * `spawn` and then reads of the job row like any other request.
 *
 * **Detached, and unrefed.** The worker must survive the web process where the
 * platform allows it — a dev-server restart mid-build should cost nothing,
 * because the job's truth is in SQLite and the worker holds its own handle to
 * it. Where the platform kills children with the parent anyway, the orphan
 * reclaim flips the silent job to an honest, retryable terminal state; either
 * way nobody watches a `running` row forever.
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
