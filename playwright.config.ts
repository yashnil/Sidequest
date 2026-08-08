import { readFileSync, rmSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { VIEWPORTS } from './e2e/support/viewports';

/**
 * The viewports, taken from the spec that walks them rather than restated here.
 *
 * One list, imported by both, so "the config says 1440x900 and the responsive
 * spec sets 1400x900" is not a thing that can happen.
 */
function viewport(name: (typeof VIEWPORTS)[number]['name']): { width: number; height: number } {
  const found = VIEWPORTS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No viewport named ${name} in e2e/support/viewports.ts.`);
  return { width: found.width, height: found.height };
}

const DESKTOP = viewport('desktop');
const TABLET = viewport('tablet');
const MOBILE = viewport('mobile');

/**
 * The specs that walk every viewport themselves, named once because two projects
 * need to agree about them: `tablet` runs them, everything else ignores them.
 *
 * A list rather than a single glob since the benchmark gained its own responsive
 * sweep. Left off it, that spec ran three times — once in each full project,
 * each overriding the viewport it was written to probe — and never once at the
 * tablet width, which is the width it exists for.
 */
const RESPONSIVE_SPEC = ['**/viewports.spec.ts', '**/benchmark-viewports.spec.ts'];

/**
 * The port is not defined here. `config.port` in the root package.json is the one
 * canonical value; the root `dev` and `start` scripts export it as PORT, Next
 * honours PORT, and this config reads the same field so an end-to-end run can
 * never drift onto a different port from the app.
 */
const rootPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { config?: { port?: string } };

const PORT = Number(process.env.PORT ?? rootPackage.config?.port);
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error('No usable port: set PORT, or config.port in the root package.json.');
}

const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * The end-to-end database, relative to the workspace the server runs in.
 *
 * Named once, here, because two things need it: the server command below, and
 * the removal that keeps a run independent of the runs before it.
 */
const DATABASE = 'apps/web/data/e2e.db';
const DATABASE_PATH = new URL(`./${DATABASE}`, import.meta.url).pathname;

/**
 * ONE RUN, ONE DATABASE.
 *
 * Nothing used to remove this file, so run two inherited run one's trips,
 * regions, claims and shared evidence, and run three inherited both. It grew by
 * about 40 MB and three hundred trips per run, for ever, and — worse than the
 * size — it made a run's behaviour depend on how many times the suite had been
 * run before. "It passes twice and fails the third time" is exactly the shape of
 * question that becomes unanswerable when the third run is not the same
 * experiment as the first.
 *
 * Deleted rather than capped, because a browser suite has no state worth
 * carrying between runs: every spec creates the trip it needs. The measured cost
 * of starting cold is nil — a clean run and a run against a doubled database
 * both took 12.3 minutes.
 *
 * Deliberately narrow: this removes the file this config names and its
 * write-ahead siblings, and nothing else. It is never the development database,
 * which lives under a different name in the same directory.
 *
 * Done here rather than in global setup because global setup runs *after* the
 * web server has opened the file, and unlinking a database out from under an
 * open handle leaves the server writing to an inode nothing else can see. This
 * module is evaluated before anything starts. The guard is for the commands that
 * load the config without running anything — listing tests or opening a report
 * must not empty a database somebody is about to read.
 */
function emptyTheEndToEndDatabase(): void {
  /*
   * NEVER FROM VITEST.
   *
   * `playwright.config.test.ts` imports this module to assert on its shape, and
   * importing a module runs it. Without this line, `npm run test` — a unit-test
   * command that touches no browser and starts no server — would silently delete
   * the developer's end-to-end database as a side effect of *reading* the config.
   * Vitest sets VITEST in every process it runs test files in, so this is the
   * narrowest available statement of "we are being inspected, not run".
   *
   * The same guard could be spelled as an argv check like the one below, but
   * argv under vitest is the vitest CLI's, which a config file has no business
   * knowing the shape of.
   */
  if (process.env.VITEST) return;
  /*
   * Only the process that starts the run.
   *
   * Playwright evaluates this file in the runner *and* again in every worker it
   * spawns, and a worker loads it after the server has the database open —
   * so without this guard the file is unlinked mid-run. Everything keeps working,
   * because the server holds the open inode, which is exactly what makes it the
   * kind of bug nobody notices until they go looking for the file.
   */
  if (process.env.TEST_WORKER_INDEX !== undefined) return;
  const inspecting = process.argv.some(
    (argument) => argument === '--list' || argument === 'show-report' || argument === 'show-trace',
  );
  if (inspecting) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(new URL(`./${DATABASE}${suffix}`, import.meta.url), { force: true });
  }
}
emptyTheEndToEndDatabase();

export default defineConfig({
  testDir: './e2e',
  /**
   * Only `.spec.ts`, and stated rather than inherited.
   *
   * Playwright's default `testMatch` also matches `**\/*.test.ts`. That was
   * harmless while nothing under `e2e/` ended in `.test.ts`, and stopped being
   * harmless the moment an offline vitest file landed there: Playwright loaded
   * it, threw inside `@vitest/runner`, and collapsed collection from 369 tests
   * to **zero** — a whole browser suite silently not running, reported as a
   * clean exit.
   *
   * `e2e/live/**` belongs to the live-evaluation harness and to vitest. This
   * line is what keeps the two runners out of each other's files.
   */
  testMatch: '**/*.spec.ts',
  /**
   * Prove the app can start before deciding that a locator timing out is the
   * app's fault. `webServer.url` only proves something answered on the port.
   */
  globalSetup: './e2e/support/readiness.ts',
  globalTeardown: './e2e/support/build-identity.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    /**
     * THREE VIEWPORTS, DECLARED RATHER THAN INHERITED.
     *
     * `VIEWPORTS` is the single statement of which sizes the product is tested
     * at; every `viewport` below is read from it, and `playwright.config.test.ts`
     * fails if a size stops being covered.
     *
     * Written out because the inherited values were not what anyone thought they
     * were. `devices['Desktop Chrome']` is 1280x720, and it was here twice —
     * `desktop` and `desktop-dark` differ only in colour scheme, so the suite had
     * two viewport sizes, one of them run twice, while the notes claimed three.
     * And `devices['iPhone 13'].viewport` is 390x664: the 844 everyone quoted is
     * the device's *screen* height, which is not the box a layout is laid out in.
     * Naming the sizes here also means a Playwright release that retunes a device
     * descriptor cannot quietly move the widths the product is verified at.
     *
     * Colour scheme is not a viewport. `desktop-dark` earns its place — it is the
     * only thing asserting the dark palette renders — but it is a third pass at
     * 1440x900, not a third size.
     */
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP, colorScheme: 'light' },
      testIgnore: RESPONSIVE_SPEC,
    },
    {
      name: 'desktop-dark',
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP, colorScheme: 'dark' },
      testIgnore: RESPONSIVE_SPEC,
    },
    {
      // Chromium at an iPhone viewport. This verifies responsive layout and touch
      // targets, not WebKit engine behaviour — running real WebKit would mean
      // pulling a second browser for no extra signal at this stage.
      // The touch flags and scale factor come from the descriptor; only the
      // viewport is stated, for the reason above.
      name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: MOBILE },
      testIgnore: RESPONSIVE_SPEC,
    },
    /**
     * The tablet width, and only the responsive spec at it.
     *
     * A fourth *full* project would add ~131 tests to a ~393-test, ~12-minute run
     * for the sake of one width, and the acceptance bar here is three consecutive
     * full passing runs — so the cost is paid three times over. What 1024x768
     * actually buys is layout signal: it is the width where a two-column design is
     * most likely to be caught between its breakpoints. So this project runs the
     * one spec that is about layout, and `testIgnore` above keeps that spec from
     * being run a redundant three more times by projects whose viewport it
     * overrides anyway.
     */
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: TABLET, colorScheme: 'light' },
      testMatch: RESPONSIVE_SPEC,
    },
  ],
  webServer: {
    // Its own database file, named absolutely from `DATABASE` above so the path
    // the server writes and the path the run empties cannot drift apart. Its own
    // file so an end-to-end run never touches development data.
    // The app and the tests now share one port, so stop `npm run dev` first —
    // reusing a running dev server here would silently test a different build
    // against the development database.
    // The fixture weather provider, so a browser test asserts against weather it
    // chose rather than against whatever the sky was doing that morning — and so
    // an end-to-end run never depends on an external service being reachable.
    // The fixture compiler provider, for the same reason and a sharper one: the
    // live stack reaches volunteer-run map services, and a test suite that hits
    // those on every run is precisely the abuse their policies complain about.
    // Climate off, for the third time and the same reason: the composer's date
    // guidance reads a real archive service, and a browser suite that depended
    // on it would fail whenever somebody else's server was slow.
    // A synthetic destination index, so "where should I go" can be tested for
    // what it *does* rather than only for how honestly it fails without one.
    // Five invented countries; see `lib/destinations/seed` for why they are
    // invented rather than real.
    // The preference reader off, for the fourth time and for a sharper reason
    // than the other three: the free-text fallback is the one paid operation a
    // *traveller* can trigger from a button, so a developer shell that happens
    // to carry a research credential would make every browser run spend real
    // money. Blanked here rather than trusted to be absent.
    // And the benchmark in fixture mode, for the fifth time and a reason of its
    // own: the internal comparison surface is the one place in the build that
    // can spend money on a *reviewer's* click rather than on a compile, and its
    // budget switch is read from the environment. Pinned here as well as
    // defaulted in code, so that a future change to the default cannot make a
    // browser run reach a model.
    command: `SIDEQUEST_DB_PATH=${DATABASE_PATH} ANTHROPIC_API_KEY= SIDEQUEST_WEATHER_PROVIDER=fixture SIDEQUEST_COMPILER_PROVIDER=fixture SIDEQUEST_CLIMATE_PROVIDER=off SIDEQUEST_BENCHMARK_MODE=fixture SIDEQUEST_BENCHMARK_BUDGET_USD= SIDEQUEST_DESTINATION_INDEX_SEED=../../e2e/support/destination-index.ndjson PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
