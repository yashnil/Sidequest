import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * THE SPENDING NUMBERS THE DOCTOR PRINTS, AGAINST THE CODE THAT ENFORCES THEM.
 *
 * `doctor.test.ts` compares the doctor's *capability verdicts* with the
 * capability registry, and its own header explains at length why a duplicated
 * predicate has to be held to a comparison rather than to a pinned string. The
 * "Spending guards" block was never given the same treatment: it prints four
 * defaults — model calls per compilation, the compile wall clock, and the two
 * daily ceilings — as literal digits, and nothing anywhere compared them to
 * `lib/compiler/limits.ts` or `lib/compiler/daily-ceiling.ts`.
 *
 * That is the same rot with worse consequences than the transit line that
 * started this: an operator reads "defaults to 12" and sizes a bill against it
 * while the transport enforces something else. Two of these numbers have
 * already been through one reconciliation this phase (the compiler's own
 * `DEFAULT_COMPILER_BUDGET` said 20 while the web layer enforced 12), which is
 * precisely the drift a printed literal cannot notice.
 *
 * So: run the real script as a real process with nothing set, and compare each
 * printed default against the function the runner actually calls.
 */

const SCRIPT = new URL('../../../scripts/doctor.mjs', import.meta.url).pathname;

/**
 * A bare environment, and the app's own env file explicitly skipped.
 *
 * `--sidequest-env-file=none` is the same flag `doctor.test.ts` uses and for the
 * same reason: a developer with a real `.env.local` must not get a different
 * answer from CI, and this file must never read a credential.
 */
function doctorWithNothingSet(): string {
  /*
   * A build with nothing configured cannot compile, so the doctor exits 1 by
   * design and `execFileSync` throws. The report is still on stdout and is the
   * thing under test — the exit code is `doctor.test.ts`'s business.
   */
  try {
    return execFileSync(process.execPath, [SCRIPT, '--sidequest-env-file=none'], {
      env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
  } catch (error) {
    const failure = error as { stdout?: string };
    return failure.stdout ?? '';
  }
}

describe('the doctor prints the ceilings the code enforces', () => {
  it('agrees with limits.ts and daily-ceiling.ts about every default', async () => {
    const out = doctorWithNothingSet();

    /*
     * Imported after the process above has run, and read with the switches
     * unset, because every one of these functions reads `process.env` at call
     * time. A module graph loaded with a developer's shell in it would be
     * answering a different question from the one the script answered.
     */
    const previous = { ...process.env };
    const KEYS = [
      'SIDEQUEST_COMPILER_MAX_AI_CALLS',
      'SIDEQUEST_COMPILER_DEADLINE_MS',
      'SIDEQUEST_DAILY_LIVE_COMPILATIONS',
      'SIDEQUEST_DAILY_MODEL_CALLS',
    ];
    try {
      for (const key of KEYS) delete process.env[key];
      const { compileDeadlineMs, modelCallCeiling } = await import('../compiler/limits');
      const { dailyLiveCompilationCeiling, dailyModelCallCeiling } = await import(
        '../compiler/daily-ceiling'
      );

      const expectations: { heading: string; value: number }[] = [
        { heading: 'Model calls per compilation', value: modelCallCeiling() },
        { heading: 'Wall clock per compilation', value: compileDeadlineMs() },
        { heading: 'SIDEQUEST_DAILY_LIVE_COMPILATIONS', value: dailyLiveCompilationCeiling() },
        { heading: 'SIDEQUEST_DAILY_MODEL_CALLS', value: dailyModelCallCeiling() },
      ];

      for (const { heading, value } of expectations) {
        const line = out.split('\n').find((entry) => entry.includes(heading));
        expect(line, `the doctor never mentions ${heading}`).toBeDefined();
        /*
         * The number that follows the word "defaults to" on that heading's own
         * line. Matching the number rather than the whole sentence is
         * deliberate, and it is the same call `doctor.test.ts` makes about the
         * tick: the prose is allowed to change, the figure is not.
         */
        const printed = new RegExp(`${heading}[^\\n]*?defaults to (\\d+)`).exec(line!);
        expect(printed, `no "defaults to <number>" on the ${heading} line: ${line}`).not.toBeNull();
        expect(
          Number(printed![1]),
          `${heading}: the doctor prints ${printed![1]} and the code enforces ${value}`,
        ).toBe(value);
      }
    } finally {
      for (const key of KEYS) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });
});
