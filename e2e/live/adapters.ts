import Database from 'better-sqlite3';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  measured,
  notMeasured,
  type CountableKind,
  type JourneyDriver,
  type JourneyStore,
  type Measured,
  type PanelKind,
  type PersistedBoard,
  type PersistedJob,
  type RouteVisit,
  type SpendLedger,
  type TripSpec,
} from '../support/live-journey.ts';

/**
 * THE REAL ENDS OF THE PORTS.
 *
 * `e2e/support/live-journey.ts` holds the journey and knows nothing about
 * sqlite, Playwright or this product's markup. This file holds all three, and
 * nothing else. The split is what lets the journey be tested offline against
 * fakes while these adapters stay thin enough to read.
 *
 * Three rules run through everything here:
 *
 *   1. **A driver that cannot answer says so in the type.** Every observation is
 *      a `Measured<T>`, and the `not_measured` arm has no value slot, so
 *      `.catch(() => 0)` — the mechanism that turned "the count failed" into
 *      "the product produced nothing" on two ten-minute compiles — does not
 *      compile any more. `measured(0)` is still available and still correct; it
 *      is a claim, and it has to be made deliberately.
 *   2. **Nothing is counted outside the container it lives in.** Every countable
 *      names the panel that must be on the page for a count of zero to mean
 *      anything. Without that, `locator.count()` answers `0` on a page that
 *      never rendered the board, and the zero is indistinguishable from an
 *      empty one. Two of the three countables had no container.
 *   3. **Selectors live here, semantics live in the journey.** The previous
 *      harness counted `getByRole('article')` on the provisional board, which
 *      has never rendered one — the cards are `data-testid="provisional-card"`
 *      panels. Putting the mapping in one table makes that kind of drift a
 *      one-line fix rather than a silent zero.
 */

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface Row {
  [column: string]: unknown;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * The database, read-only.
 *
 * Read-only on purpose: an evaluation that can write to the artifact it is
 * measuring is not measuring it. Every method swallows nothing — a query that
 * throws propagates, and `awaitMilestone` counts it as a probe error and names
 * it in the reason, which is strictly more informative than a `null` that means
 * either "not yet" or "the file is not there".
 */
export class SqliteJourneyStore implements JourneyStore {
  private readonly db: Database.Database;
  /** ISO instant the run began, so stage observations can be scoped to it. */
  private readonly since: string;

  /*
   * Fields assigned in the body rather than declared as constructor parameter
   * properties. This file is executed by `node --experimental-strip-types`, which
   * is strip-only: it removes type annotations and runs the rest, so a parameter
   * property — the one TypeScript feature that *emits* code — throws
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` before a single line runs. The harness
   * has to be runnable by the command its own header documents.
   */
  constructor(path: string, since: string) {
    this.db = new Database(path, { readonly: true });
    this.since = since;
  }

  latestJob(tripId: string): PersistedJob | null {
    const row = this.db
      .prepare(
        `SELECT id, state, stage, started_at, finished_at, error_code
           FROM compilation_jobs WHERE trip_id = ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(tripId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      state: String(row.state),
      stage: String(row.stage),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    };
  }

  /**
   * The provisional board as stored, with its card count read from the payload.
   *
   * This is the artifact the whole progressive-compilation slice exists to
   * produce, and it is written at the cut — before the expensive work. Asking
   * the row rather than the page is what makes it observable independently of
   * the compile finishing, of the browser being on the right screen, and of the
   * watcher context still being open.
   */
  provisionalBoard(tripId: string): PersistedBoard | null {
    const row = this.db
      .prepare(
        `SELECT id, version, payload_json, created_at
           FROM provisional_boards WHERE trip_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(tripId) as Row | undefined;
    if (!row) return null;
    const payload = JSON.parse(String(row.payload_json)) as { cards?: unknown[] };
    return {
      boardId: String(row.id),
      version: asNumber(row.version),
      cardCount: Array.isArray(payload.cards) ? payload.cards.length : 0,
      createdAt: String(row.created_at),
    };
  }

  reconciliation(tripId: string): { version: number; pendingActions: number } | null {
    const current = this.db
      .prepare(
        `SELECT MAX(reconciliation_version) AS version
           FROM board_reconciliation_history WHERE trip_id = ?`,
      )
      .get(tripId) as Row | undefined;
    if (!current || current.version === null || current.version === undefined) return null;
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM provisional_actions
          WHERE trip_id = ? AND reconciliation_state = 'pending'`,
      )
      .get(tripId) as Row | undefined;
    return { version: asNumber(current.version), pendingActions: asNumber(pending?.n) };
  }

  weatherSnapshot(tripId: string): { status: string; fetchedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT status, fetched_at FROM weather_snapshots WHERE trip_id = ?
          ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(tripId) as Row | undefined;
    return row ? { status: String(row.status), fetchedAt: String(row.fetched_at) } : null;
  }

  itinerary(tripId: string): { id: string; days: number } | null {
    const row = this.db
      .prepare(`SELECT trip_id, version FROM itineraries WHERE trip_id = ?`)
      .get(tripId) as Row | undefined;
    if (!row) return null;
    const days = this.db
      .prepare(`SELECT COUNT(*) AS n FROM itinerary_days WHERE trip_id = ?`)
      .get(tripId) as Row | undefined;
    return { id: `${String(row.trip_id)}@${asNumber(row.version)}`, days: asNumber(days?.n) };
  }

  /**
   * WHAT THE RUN COST, FROM BOTH LEDGERS.
   *
   * `compilation_jobs.operational_json` began life as a flat map of counter
   * names to numbers and later gained a wrapper — `{schemaVersion, counters,
   * compiler}` — so a reader that assumes the flat shape reports a cost of
   * nothing for every recent run. Both shapes are read here.
   *
   * `model_operations` is the second half and the one that carries actual money:
   * calls, tokens and `cost_micro_usd`, summed for the trip. Reading only the
   * counters would report provider volume beside a blank where the spend goes.
   */
  spend(tripId: string): SpendLedger | null {
    const sources: string[] = [];
    let counters: Record<string, number> = {};

    const job = this.db
      .prepare(
        `SELECT operational_json FROM compilation_jobs
          WHERE trip_id = ? AND operational_json IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(tripId) as Row | undefined;
    if (job?.operational_json) {
      const parsed: unknown = JSON.parse(String(job.operational_json));
      const wrapped =
        parsed !== null &&
        typeof parsed === 'object' &&
        'counters' in parsed &&
        typeof (parsed as { counters: unknown }).counters === 'object'
          ? (parsed as { counters: Record<string, number> }).counters
          : (parsed as Record<string, number> | null);
      /*
       * Both halves, because the product's own reader reads both.
       *
       * `getOperationalDiagnostics` merges `stored.counters` with
       * `flattenOperationalCounters(stored.compiler)` — the compiler's own
       * ledger. Reading only the first published a partial cost while `sources`
       * claimed the ledger had answered, which is a confident under-report of
       * exactly the number this evaluation exists to establish.
       */
      const compilerHalf =
        parsed !== null && typeof parsed === 'object' && 'compiler' in parsed
          ? flattenNumbers((parsed as { compiler: unknown }).compiler)
          : {};
      counters = { ...(wrapped ?? {}), ...compilerHalf };
      sources.push('compilation_jobs.operational_json');
    }

    const model = this.db
      .prepare(
        `SELECT COALESCE(SUM(calls),0) AS calls,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(cost_micro_usd),0) AS cost_micro_usd,
                COUNT(*) AS rows_seen
           FROM model_operations WHERE trip_id = ?`,
      )
      .get(tripId) as Row | undefined;
    if (model && asNumber(model.rows_seen) > 0) sources.push('model_operations');

    if (sources.length === 0) return null;
    return {
      sources,
      counters,
      modelCalls: asNumber(model?.calls),
      inputTokens: asNumber(model?.input_tokens),
      outputTokens: asNumber(model?.output_tokens),
      costMicroUsd: asNumber(model?.cost_micro_usd),
    };
  }

  stageObservations(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM stage_observations WHERE observed_at >= ?`)
      .get(this.since) as Row | undefined;
    return asNumber(row?.n);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * The one place selectors live — and every countable names its container.
 *
 * `board_card` is a role because the discovery board's `PlaceCard` renders a
 * `Panel as="article"`; `provisional_card` is a test id because the provisional
 * board's card does not, and reading one with the other's selector is exactly
 * the defect that reported `provisionalCards: 0` beside a screenshot of 45.
 *
 * `within` is now **required**, which is the second half of that fix. It was
 * optional, and the two countables that omitted it were counted against the
 * whole document: `page.locator('[data-testid="provisional-card"]').count()`
 * answers `0` on the questionnaire, on an error page, and on `about:blank`, and
 * that `0` was published beside the ones that had been checked properly. A count
 * of zero is only a measurement if the thing that would hold the items is on the
 * page — so the container is checked first, every time, for every kind.
 */
export const COUNTABLE_SELECTORS: Record<
  CountableKind,
  { readonly within: string; readonly item: string }
> = {
  provisional_card: {
    within: '[data-testid="provisional-board"]',
    item: '[data-testid="provisional-card"]',
  },
  board_card: { within: '[data-testid="discovery-board"]', item: 'article' },
  pinned_removal: {
    within: '[data-testid="reconciliation-panel"]',
    item: '[data-testid="pinned-removal"]',
  },
};

const PANELS: Record<PanelKind, string> = {
  provisional_board: 'provisional-board',
  discovery_board: 'discovery-board',
  board_summary: 'board-summary',
  reconciliation_panel: 'reconciliation-panel',
  weather_snapshot: 'weather-snapshot',
};

/** The panel that must be on screen before its cards mean anything. */
const PROVISIONAL_BOARD = '[data-testid="provisional-board"]';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PlaywrightDriverOptions {
  readonly baseUrl: string;
  readonly outDir: string;
  readonly slug: string;
  readonly strategyTimeoutMs: number;
  readonly transport: string;
}

export class PlaywrightJourneyDriver implements JourneyDriver {
  private readonly errors: string[] = [];
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly options: PlaywrightDriverOptions;

  /* Assigned in the body — see the note in `SqliteJourneyStore`. */
  constructor(context: BrowserContext, page: Page, options: PlaywrightDriverOptions) {
    this.context = context;
    this.page = page;
    this.options = options;
    page.on('console', (message) => {
      if (message.type() === 'error') this.errors.push(message.text());
    });
    page.on('pageerror', (error) => this.errors.push(error.message));
  }

  async createTrip(
    spec: TripSpec,
  ): Promise<{ tripId: Measured<string>; indexSuggestion: Measured<boolean> }> {
    await this.page.goto(`${this.options.baseUrl}/trips/new`);
    const field = this.page.getByLabel('Destination');
    /*
     * Wait for React to own the control before typing into it.
     *
     * Playwright's actionability checks pass on server-rendered markup, so a
     * `fill` that lands before hydration sets the DOM value, is observed by no
     * handler, and is unrecoverable. That lost keystroke is PW-1 in the closure
     * matrix, and it presented as a sixty-second timeout on the next field.
     */
    await field
      .evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber$')))
      .catch(() => false);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const owned = await field
        .evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber$')))
        .catch(() => false);
      if (owned) break;
      await this.page.waitForTimeout(500);
    }

    await field.fill(spec.destination);
    const option = this.page.getByRole('option').first();
    const suggested = await option
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (suggested) await option.click();

    await this.page.getByLabel('Arrive').fill(spec.start);
    await this.page.getByLabel('Leave').fill(spec.end);

    for (const theme of spec.themes) {
      await this.page
        .getByRole('checkbox', { name: theme })
        .check()
        .catch(() => undefined);
    }
    /*
     * Transport, answered explicitly, because leaving it blank is not neutral:
     * an unanswered transport question leaves the trip walking, and a walking
     * matrix over a city boundary legitimately fails most of its legs. Two live
     * runs came back `route_matrix_incomplete` for that reason.
     */
    await this.page
      .getByRole('radio', { name: spec.transport, exact: true })
      .check()
      .catch(() => undefined);

    await this.page.getByRole('button', { name: /See what we make of it/i }).click();
    const arrived = await this.page
      .waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!arrived) {
      return {
        tripId: notMeasured(
          'navigation_failed',
          'the composer never navigated to a trip route within 60 s, so no trip id was produced',
        ),
        indexSuggestion: measured(suggested),
      };
    }
    const id = /\/trips\/([^/]+)\//.exec(this.page.url())?.[1];
    return {
      tripId:
        id === undefined
          ? notMeasured(
              'markup_absent',
              `landed on ${this.page.url()}, which carries no /trips/<id>/ segment to read`,
            )
          : measured(id),
      indexSuggestion: measured(suggested),
    };
  }

  async reachScope(
    strategy: string,
  ): Promise<{ reached: Measured<boolean>; preflightMs: Measured<number> }> {
    const started = Date.now();
    const choice = this.page.getByRole('radio', { name: strategy });
    const offered = await choice
      .waitFor({ timeout: this.options.strategyTimeoutMs })
      .then(() => true)
      .catch(() => false);
    /*
     * A preflight that never rendered has no render time. The elapsed wait is
     * the deadline this harness set, and publishing it as `timeToPreflightMs`
     * would be publishing our own constant as the product's speed.
     */
    const preflightMs = offered
      ? measured(Date.now() - started)
      : notMeasured(
          'deadline_expired',
          `the strategy choice "${strategy}" never appeared within ${Math.round(
            this.options.strategyTimeoutMs / 1000,
          )}s — that is this harness's deadline, not a preflight duration`,
        );
    await this.screenshot(`${this.options.slug}-preflight`);
    if (offered) {
      await choice.check();
      await this.page.getByRole('button', { name: /Go and research this/i }).click();
    }

    /*
     * Whatever clarifications this destination produced, answered until the
     * scope screen appears. A loop rather than one pass: a country can ask more
     * than one question, and answering once then waiting for a screen two
     * questions away reads as "the scope never arrived".
     */
    const build = this.page.getByRole('button', { name: 'Build the region' });
    for (let round = 0; round < 12; round += 1) {
      if (await build.isVisible({ timeout: 5_000 }).catch(() => false)) break;
      await this.answerEveryGroup();
      const proceed = this.page.getByRole('button', { name: /^Continue$/ });
      if (await proceed.isVisible().catch(() => false)) {
        await proceed.click();
        continue;
      }
      await this.page.waitForTimeout(2_000);
    }
    await this.screenshot(`${this.options.slug}-scope`);
    const reached = await build
      .waitFor({ timeout: this.options.strategyTimeoutMs })
      .then(() => true)
      .catch(() => false);
    return { reached: measured(reached), preflightMs };
  }

  async startCompilation(): Promise<Measured<boolean>> {
    const build = this.page.getByRole('button', { name: 'Build the region' });
    // "The button was not there" is a real observation of the build not
    // starting; a click that throws is not, and the two are separated.
    if (!(await build.isVisible().catch(() => false))) return measured(false);
    try {
      await build.click();
      return measured(true);
    } catch (error) {
      return notMeasured(
        'probe_threw',
        `the build button was on screen and the click raised: ${describe(error)} — whether the build started is unknown`,
      );
    }
  }

  /**
   * THE QUESTIONNAIRE, COMPLETED — THE STEP WHOSE ABSENCE COST A DESTINATION.
   *
   * `/discover` redirects to `/questionnaire` for a trip with no profile, so a
   * harness that skips this measures the redirect and reports it as a board.
   *
   * The step sequence is the one `e2e/support/trip.ts::completeQuestionnaire`
   * walks, re-expressed rather than imported: that module is a Playwright-test
   * helper built on `expect`, this runs outside a test, and the browser suite it
   * belongs to must not change. The interest answers are chosen by *level*
   * suffix rather than by interest name, because which interests the first step
   * offers depends on the destination — the canonical hiking/lakes/viewpoints
   * traveller does not exist on a city board.
   */
  async completeProfile(): Promise<Measured<boolean>> {
    const review = this.page.getByRole('heading', { name: 'Your trip personality' });
    const build = this.page.getByRole('button', { name: 'Build my discovery board' });

    for (let step = 0; step < 16; step += 1) {
      if (await review.isVisible().catch(() => false)) break;
      if (await build.isVisible().catch(() => false)) break;

      /*
       * Positive answers first. "Answer every group with its first option" walks
       * into a screen that will not advance, because the first option of an
       * interest row is "Skip" and the questionnaire refuses to continue from an
       * empty profile.
       */
      const positive = this.page.getByRole('radio', { name: /: (A few times|Core)$/ });
      const positiveCount = await positive.count().catch(() => 0);
      for (let index = 0; index < Math.min(positiveCount, 4); index += 1) {
        await positive
          .nth(index)
          .check()
          .catch(() => undefined);
      }
      if (positiveCount === 0) await this.answerEveryGroup();

      const next = this.page.getByRole('button', { name: /^Continue$/ });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        await this.page.waitForTimeout(300);
        continue;
      }
      await this.page.waitForTimeout(500);
    }

    if (await build.isVisible().catch(() => false)) {
      await build.click();
      /*
       * The button navigates to /discover. Waiting for it here means the profile
       * is stored *before* the journey opens that route, which is the ordering
       * the redirect assertion depends on.
       */
      await this.page.waitForURL(/\/discover$/, { timeout: 60_000 }).catch(() => undefined);
      return measured(true);
    }
    return measured(await review.isVisible().catch(() => false));
  }

  /**
   * NAVIGATE, AND REPORT WHICH OF THE THREE THINGS HAPPENED.
   *
   * `response.status()` is the status of the final document, so a redirect
   * answers 200 and is invisible from the status alone. The path comparison is
   * the only thing that catches it.
   *
   * The third case is the one that leaked. `goto(...).catch(() => null)` folded
   * a navigation that *never completed* into the same shape as one that did:
   * `finalPath` was then read off whatever the browser still had open — the
   * previous page, or `about:blank` — and `redirected` came out `true` because
   * that path is not the requested one. The journey published that as
   * `provisionalRouteRedirected: observed true`. Nothing had been observed at
   * all. A failed navigation is now its own arm, and the field it feeds becomes
   * `not_measured (the browser never completed the navigation)`.
   */
  async visit(path: string): Promise<RouteVisit> {
    const url = `${this.options.baseUrl}${path}`;
    let response: Awaited<ReturnType<Page['goto']>>;
    try {
      response = await this.page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    } catch (error) {
      return { outcome: 'navigation_failed', requested: path, detail: describe(error) };
    }

    let finalPath: string;
    try {
      finalPath = new URL(this.page.url()).pathname;
    } catch {
      finalPath = this.page.url();
    }
    return {
      outcome: 'navigated',
      requested: path,
      finalPath,
      /*
       * `?? -1` lived downstream of this. A same-document navigation genuinely
       * has no document response, and the honest report of that is an absence
       * with a code — not a sentinel integer that survives every integrity walk
       * because it is, technically, a number.
       */
      status:
        response === null
          ? notMeasured(
              'response_absent',
              `${path} completed as a same-document navigation, so no HTTP status was produced`,
            )
          : measured(response.status()),
      redirected: finalPath !== path,
    };
  }

  /**
   * Count, inside the container that has to exist for a zero to mean anything.
   *
   * Both halves are reported separately on purpose: no container is
   * `markup_absent` — we were on the wrong page, or the board did not render —
   * while a container holding nothing is `measured(0)`, a real and interesting
   * product result.
   */
  async count(kind: CountableKind): Promise<Measured<number>> {
    const spec = COUNTABLE_SELECTORS[kind];
    try {
      const container = this.page.locator(spec.within);
      if ((await container.count()) === 0) {
        return notMeasured(
          'markup_absent',
          `no ${spec.within} on ${this.page.url()} — ${kind} was not counted, which is not the same as counting none`,
        );
      }
      return measured(await container.locator(spec.item).count());
    } catch (error) {
      return notMeasured('probe_threw', `counting ${kind} raised: ${describe(error)}`);
    }
  }

  /**
   * Whether a panel is on the page.
   *
   * `measured(false)` here is honest — the journey only asks once it has
   * asserted the route did not redirect, so "the reconciliation panel is not on
   * the discovery board" is a finding about the board. A locator that raises is
   * not a finding about anything.
   */
  async present(kind: PanelKind): Promise<Measured<boolean>> {
    try {
      return measured((await this.page.locator(`[data-testid="${PANELS[kind]}"]`).count()) > 0);
    } catch (error) {
      return notMeasured(
        'probe_threw',
        `looking for the ${kind} panel raised: ${describe(error)}`,
      );
    }
  }

  async text(kind: PanelKind): Promise<Measured<string>> {
    const locator: Locator = this.page.locator(`[data-testid="${PANELS[kind]}"]`).first();
    try {
      if ((await locator.count()) === 0) {
        return notMeasured(
          'markup_absent',
          `no [data-testid="${PANELS[kind]}"] on ${this.page.url()}, so there was no text to read`,
        );
      }
      return measured((await locator.innerText()).slice(0, 600));
    } catch (error) {
      return notMeasured('probe_threw', `reading the ${kind} panel raised: ${describe(error)}`);
    }
  }

  async boardVersion(kind: PanelKind): Promise<Measured<number>> {
    const locator: Locator = this.page.locator(`[data-testid="${PANELS[kind]}"]`).first();
    try {
      if ((await locator.count()) === 0) {
        return notMeasured(
          'markup_absent',
          `no [data-testid="${PANELS[kind]}"] on ${this.page.url()} to carry a board-version stamp`,
        );
      }
      const raw = await locator.getAttribute('data-board-version');
      if (raw === null) {
        return notMeasured(
          'markup_absent',
          `the ${kind} panel rendered with no data-board-version attribute`,
        );
      }
      const parsed = Number(raw);
      return Number.isFinite(parsed)
        ? measured(parsed)
        : notMeasured(
            'markup_absent',
            `the ${kind} panel stamped data-board-version="${raw}", which is not a number`,
          );
    } catch (error) {
      return notMeasured('probe_threw', `reading the ${kind} version raised: ${describe(error)}`);
    }
  }

  /**
   * THE TEST INTERACTION, AND THE THREE DIFFERENT ZEROS IT USED TO PUBLISH.
   *
   * `if (total === 0) return 0` carried the comment "a real count of a rendered
   * board with no cards" — and it was not, because nothing above it had checked
   * that a board was rendered at all. On the questionnaire, on a 500, on
   * `about:blank`, `total` is also `0`, and all three were published as "we
   * applied no marks to a board that had no cards". Then a fourth zero: if the
   * cards were there and none carried a "Must do" control, the loop simply never
   * fired and `applied` fell out as `0` — an interaction that could not be
   * attempted, reported as an interaction that was attempted and did nothing.
   *
   * Now the board must be on the page before any of it counts, an empty rendered
   * board is a genuine `measured(0)`, and cards with no control to click are
   * `markup_absent` with the numbers in the sentence.
   */
  async markProvisionalCards(limit: number): Promise<Measured<number>> {
    try {
      if ((await this.page.locator(PROVISIONAL_BOARD).count()) === 0) {
        return notMeasured(
          'markup_absent',
          `no provisional board on ${this.page.url()} — no interaction was attempted, so none was applied is not something this run can claim`,
        );
      }

      const cards = this.page.locator(`${PROVISIONAL_BOARD} [data-testid="provisional-card"]`);
      const total = await cards.count();
      // A board that rendered with nothing on it: nothing to mark, honestly zero.
      if (total === 0) return measured(0);

      let offered = 0;
      let applied = 0;
      let lastClickError: string | null = null;
      for (let index = 0; index < Math.min(limit, total); index += 1) {
        const button = cards.nth(index).getByRole('button', { name: 'Must do' });
        if (!(await button.isVisible().catch(() => false))) continue;
        offered += 1;
        try {
          await button.click();
          await this.page.waitForTimeout(400);
          applied += 1;
        } catch (error) {
          lastClickError = describe(error);
        }
      }

      if (offered === 0) {
        return notMeasured(
          'markup_absent',
          `${total} provisional card(s) rendered and none of the first ${Math.min(
            limit,
            total,
          )} carried a "Must do" control, so no interaction could be attempted`,
        );
      }
      if (applied === 0) {
        return notMeasured(
          'probe_threw',
          `${offered} "Must do" control(s) were on screen and every click raised; last: ${
            lastClickError ?? 'unknown'
          }`,
        );
      }
      return measured(applied);
    } catch (error) {
      return notMeasured('probe_threw', `marking provisional cards raised: ${describe(error)}`);
    }
  }

  async screenshot(name: string): Promise<void> {
    await this.page
      .screenshot({ path: `${this.options.outDir}/${name}.png`, fullPage: true })
      .catch(() => undefined);
  }

  consoleErrors(): readonly string[] {
    return this.errors;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }

  /** Check the first radio of every group on screen, whatever the groups are. */
  private async answerEveryGroup(): Promise<void> {
    const radios = this.page.locator('input[type=radio]');
    const seen = new Set<string>();
    const count = await radios.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const name = await radios.nth(index).getAttribute('name');
      if (name && !seen.has(name)) {
        seen.add(name);
        await radios
          .nth(index)
          .check()
          .catch(() => undefined);
      }
    }
  }
}


/**
 * Every number reachable in a nested diagnostics object, flattened.
 *
 * Mirrors `flattenOperationalCounters` in the repository rather than importing
 * it: this file must stay runnable by `node --experimental-strip-types`, which
 * means no dependency on the app's server-only module graph. Prefixed keys keep
 * a compiler counter from silently overwriting a runner counter of the same
 * name.
 */
function flattenNumbers(value: unknown, prefix = 'compiler'): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[`${prefix}.${key}`] = entry;
    else if (entry !== null && typeof entry === 'object') {
      Object.assign(out, flattenNumbers(entry, `${prefix}.${key}`));
    }
  }
  return out;
}
