/**
 * IMPORTED FIRST BY A CONFIG THAT RUNS ITS OWN SERVER BESIDE ANOTHER RUN.
 *
 * `playwright.config.ts` empties `apps/web/data/e2e.db` as a side effect of being
 * evaluated, and every derived config imports it. That is right for the run that
 * owns that file and wrong for a second run started next to it: the first run's
 * server keeps writing to an inode nothing else can see (see the note on
 * `emptyTheEndToEndDatabase`). The base config already declines to empty the file
 * under VITEST, "being inspected, not run", which is exactly what a derived
 * config is doing when it reads the base for its shape.
 *
 * So: set the flag for the duration of the base config's evaluation (this module
 * is evaluated before it, as an earlier import), and `releaseIsolation()` takes
 * it back off afterwards so neither the web server nor the workers inherit it.
 * A port of its own is defaulted here too, before the base reads `PORT`.
 */
const ISOLATED_PORT = '4340';

const hadVitest = process.env.VITEST !== undefined;
if (!hadVitest) process.env.VITEST = 'isolated-config';
if (!process.env.PORT) process.env.PORT = ISOLATED_PORT;

export function releaseIsolation(): void {
  if (!hadVitest && process.env.VITEST === 'isolated-config') delete process.env.VITEST;
}
