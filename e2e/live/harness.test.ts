import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  EXPECTED_FIELDS,
  NOT_MEASURED_PHRASES,
  awaitMilestone,
  budgetViolations,
  measured,
  notMeasured,
  provisionalDeadline,
  redirection,
  renderMeasurement,
  renderMeasurements,
  renderReport,
  runLiveJourney,
  serialise,
  type Clock,
  type CountableKind,
  type EvaluationBudget,
  type FinalReport,
  type JourneyDriver,
  type JourneyStore,
  type Measured,
  type PanelKind,
  type PersistedBoard,
  type PersistedJob,
  type RouteVisit,
  type SerialisedMeasurement,
  type SpendLedger,
  type TripSpec,
} from '../support/live-journey';

/**
 * THE HARNESS, TESTED OFFLINE, AGAINST A JOURNEY THAT RUNS LONGER THAN THE
 * WINDOW THAT MISSED IT.
 *
 * Every defect this file guards was found in production of the *evaluation*,
 * not of the product, and each one produced a number that looked like a product
 * failure:
 *
 *   - a provisional board emitted at 10 min 40 s, watched by a 10 min window;
 *   - `/discover` redirecting to the questionnaire and being scored as a board;
 *   - `0` and `false` standing in for measurements nobody took;
 *   - a navigation that never completed, published as an *observed* redirect;
 *   - counts taken against markup that was never rendered;
 *   - the database deleted before the assertions finished.
 *
 * No server, no browser, no network, no real time, and no model call — the whole
 * file is fakes and a virtual clock, so a 45-minute evaluation deadline executes
 * in microseconds and the test asserts on durations rather than waiting for
 * them.
 *
 *   npx vitest run e2e/live/harness.test.ts
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Virtual time. `sleep` advances it and resolves on the microtask queue. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface Timeline {
  /** ms after the build starts, or `null` for "no board is ever written". */
  readonly boardAfterMs: number | null;
  readonly boardCards: number;
  readonly boardVersion: number;
  readonly terminalAfterMs: number;
  readonly terminalState: string;
  readonly errorCode?: string | null;
  readonly reconciliationVersion?: number | null;
  readonly weatherStatus?: string | null;
  readonly itineraryDays?: number | null;
  readonly spend?: SpendLedger | null;
  readonly stageObservations?: number;
}

const LEDGER: SpendLedger = {
  sources: ['compilation_jobs.operational_json', 'model_operations'],
  counters: { overture_rows: 118_402, valhalla_matrix_pairs: 625 },
  modelCalls: 4,
  inputTokens: 9_311,
  outputTokens: 2_004,
  costMicroUsd: 526_009,
};

class FakeStore implements JourneyStore {
  buildStartedAt: number | null = null;
  closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly timeline: Timeline,
  ) {}

  private since(): number | null {
    return this.buildStartedAt === null ? null : this.clock.now() - this.buildStartedAt;
  }

  latestJob(): PersistedJob | null {
    const elapsed = this.since();
    if (elapsed === null) return null;
    const terminal = elapsed >= this.timeline.terminalAfterMs;
    return {
      id: 'job-1',
      state: terminal ? this.timeline.terminalState : 'running',
      stage: terminal ? 'done' : 'reading_sources',
      startedAt: '2026-08-06T00:00:00.000Z',
      finishedAt: terminal ? '2026-08-06T00:10:25.000Z' : null,
      errorCode: terminal ? (this.timeline.errorCode ?? null) : null,
    };
  }

  provisionalBoard(): PersistedBoard | null {
    const elapsed = this.since();
    if (elapsed === null || this.timeline.boardAfterMs === null) return null;
    if (elapsed < this.timeline.boardAfterMs) return null;
    return {
      boardId: 'board-1',
      version: this.timeline.boardVersion,
      cardCount: this.timeline.boardCards,
      createdAt: '2026-08-06T00:10:40.000Z',
    };
  }

  reconciliation(): { version: number; pendingActions: number } | null {
    const version = this.timeline.reconciliationVersion ?? null;
    return version === null ? null : { version, pendingActions: 0 };
  }

  weatherSnapshot(): { status: string; fetchedAt: string } | null {
    const status = this.timeline.weatherStatus ?? null;
    return status === null ? null : { status, fetchedAt: '2026-08-06T00:12:00.000Z' };
  }

  itinerary(): { id: string; days: number } | null {
    const days = this.timeline.itineraryDays ?? null;
    return days === null ? null : { id: 'itin-1', days };
  }

  spend(): SpendLedger | null {
    return this.timeline.spend === undefined ? LEDGER : this.timeline.spend;
  }

  stageObservations(): number {
    return this.timeline.stageObservations ?? 26;
  }

  close(): void {
    this.closed = true;
  }
}

interface DriverScript {
  readonly tripId?: Measured<string>;
  readonly indexSuggestion?: boolean;
  readonly reachScope?: boolean;
  readonly startCompilation?: Measured<boolean>;
  readonly completeProfile?: Measured<boolean>;
  /** Requested path → the path the browser actually landed on. */
  readonly redirects?: Record<string, string>;
  readonly statuses?: Record<string, number>;
  /** Requested path → why the navigation never completed at all. */
  readonly navigationFailures?: Record<string, string>;
  readonly counts?: Partial<Record<CountableKind, Measured<number>>>;
  readonly boardVersions?: Partial<Record<PanelKind, Measured<number>>>;
  readonly present?: Partial<Record<PanelKind, Measured<boolean>>>;
  readonly text?: Partial<Record<PanelKind, Measured<string>>>;
  readonly marks?: Measured<number>;
}

class FakeDriver implements JourneyDriver {
  readonly visits: string[] = [];
  readonly screenshots: string[] = [];
  closedAt: number | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly store: FakeStore,
    private readonly script: DriverScript = {},
  ) {}

  async createTrip(
    _spec: TripSpec,
  ): Promise<{ tripId: Measured<string>; indexSuggestion: Measured<boolean> }> {
    await this.clock.sleep(5_000);
    return {
      tripId: this.script.tripId ?? measured('trip-1'),
      indexSuggestion: measured(this.script.indexSuggestion ?? true),
    };
  }

  async reachScope(
    _strategy: string,
  ): Promise<{ reached: Measured<boolean>; preflightMs: Measured<number> }> {
    await this.clock.sleep(30_000);
    return { reached: measured(this.script.reachScope ?? true), preflightMs: measured(28_400) };
  }

  async startCompilation(): Promise<Measured<boolean>> {
    const outcome = this.script.startCompilation ?? measured(true);
    if (outcome.state === 'measured' && outcome.value) this.store.buildStartedAt = this.clock.now();
    return outcome;
  }

  async completeProfile(): Promise<Measured<boolean>> {
    await this.clock.sleep(20_000);
    return this.script.completeProfile ?? measured(true);
  }

  async visit(path: string): Promise<RouteVisit> {
    this.visits.push(path);
    await this.clock.sleep(1_000);
    const failure = this.script.navigationFailures?.[path];
    if (failure !== undefined) {
      return { outcome: 'navigation_failed', requested: path, detail: failure };
    }
    const finalPath = this.script.redirects?.[path] ?? path;
    return {
      outcome: 'navigated',
      requested: path,
      finalPath,
      status: measured(this.script.statuses?.[path] ?? 200),
      redirected: finalPath !== path,
    };
  }

  async count(kind: CountableKind): Promise<Measured<number>> {
    const scripted = this.script.counts?.[kind];
    if (scripted !== undefined) return scripted;
    if (kind === 'provisional_card') {
      const board = this.store.provisionalBoard();
      return board === null
        ? notMeasured('markup_absent', 'no provisional board on the page')
        : measured(board.cardCount);
    }
    if (kind === 'board_card') return measured(23);
    return measured(0);
  }

  async present(kind: PanelKind): Promise<Measured<boolean>> {
    return this.script.present?.[kind] ?? measured(true);
  }

  async text(kind: PanelKind): Promise<Measured<string>> {
    const scripted = this.script.text?.[kind];
    if (scripted !== undefined) return scripted;
    return measured(kind === 'weather_snapshot' ? 'Not fetched yet' : '23 in · we suggested 20');
  }

  async boardVersion(kind: PanelKind): Promise<Measured<number>> {
    const scripted = this.script.boardVersions?.[kind];
    if (scripted !== undefined) return scripted;
    if (kind === 'provisional_board') {
      const board = this.store.provisionalBoard();
      return board === null
        ? notMeasured('markup_absent', 'no provisional board on the page')
        : measured(board.version);
    }
    return measured(1);
  }

  async markProvisionalCards(limit: number): Promise<Measured<number>> {
    return this.script.marks ?? measured(limit);
  }

  async screenshot(name: string): Promise<void> {
    this.screenshots.push(name);
  }

  consoleErrors(): readonly string[] {
    return [];
  }

  async close(): Promise<void> {
    this.closedAt = this.clock.now();
  }
}

const OPTIONS = {
  destination: 'New York',
  slug: 'ny',
  start: '2027-05-10',
  end: '2027-05-14',
  strategy: 'One base',
  transport: 'Public transport',
  themes: ['City life'],
  marks: 3,
  budget: DEFAULT_BUDGET,
};

/** The window the previous harness had: 300 attempts at 2 s, and no more. */
const OLD_WINDOW_BUDGET: EvaluationBudget = {
  ...DEFAULT_BUDGET,
  compileMs: 580_000,
  provisionalGraceMs: 20_000,
};

interface Harness {
  report: FinalReport;
  published: boolean;
  teardownPerformed: boolean;
  order: readonly string[];
  store: FakeStore;
  driver: FakeDriver;
  writes: FinalReport[];
  teardowns: number[];
}

async function run(
  timeline: Timeline,
  script: DriverScript = {},
  overrides: Partial<typeof OPTIONS> = {},
  publish?: (report: FinalReport) => void,
): Promise<Harness> {
  const clock = fakeClock();
  const store = new FakeStore(clock, timeline);
  const driver = new FakeDriver(clock, store, script);
  const writes: FinalReport[] = [];
  const teardowns: number[] = [];

  const result = await runLiveJourney(
    {
      clock,
      store,
      driver,
      publish: (report) => {
        writes.push(report);
        if (publish) publish(report);
      },
      teardown: () => {
        // Recorded rather than performed: the property under test is *when* this
        // runs relative to publication, and a fake that deletes nothing can
        // still prove the ordering.
        teardowns.push(writes.length);
        store.close();
      },
    },
    { ...OPTIONS, ...overrides },
  );

  return { ...result, store, driver, writes, teardowns };
}

const HEALTHY: Timeline = {
  // 10 min 40 s — past the 10-minute window that reported `null` against a real
  // New York compile whose board had in fact been persisted at version 1.
  boardAfterMs: 640_000,
  boardCards: 45,
  boardVersion: 1,
  terminalAfterMs: 900_000,
  terminalState: 'ready',
  reconciliationVersion: 3,
  weatherStatus: 'not_fetched',
  itineraryDays: null,
};

/** The value a field carries, or `undefined` when it was not measured. */
function valueIn(entry: SerialisedMeasurement | undefined): unknown {
  return entry !== undefined && entry.state === 'measured' ? entry.value : undefined;
}

// ---------------------------------------------------------------------------

describe('the fake journey that runs longer than the old poll window', () => {
  it('still observes the provisional board, with its version and its card count', async () => {
    const { report } = await run(HEALTHY);

    const time = report.measurements['timeToProvisionalBoardMs']!;
    expect(time.state).toBe('measured');
    // Build start is stamped at `startCompilation`; the board lands 640 s later
    // and is seen on the next poll, so at most one interval late.
    expect(valueIn(time) as number).toBeGreaterThanOrEqual(640_000);
    expect(valueIn(time) as number).toBeLessThan(640_000 + DEFAULT_BUDGET.pollIntervalMs * 2);

    expect(report.measurements['provisionalBoardVersion']).toEqual({
      state: 'measured',
      value: 1,
    });
    expect(report.measurements['provisionalBoardCardsPersisted']).toEqual({
      state: 'measured',
      value: 45,
    });
    expect(report.milestones['provisional_board_persisted']?.endedBy).toBe('observed');
  });

  it('detects the board independently of the compile finishing', async () => {
    const { report } = await run(HEALTHY);
    // The board is seen at ~640 s; the job does not go terminal until 900 s.
    const board = valueIn(report.measurements['timeToProvisionalBoardMs']) as number;
    const compile = valueIn(report.measurements['compileMs']) as number;
    expect(board).toBeLessThan(compile);
    expect(report.measurements['compileState']).toEqual({ state: 'measured', value: 'ready' });
  });

  it('opens the provisional route, asserts the version and counts real cards', async () => {
    const { report, driver } = await run(HEALTHY);
    expect(driver.visits).toContain('/trips/trip-1/provisional');
    expect(report.measurements['provisionalRouteRedirected']).toEqual({
      state: 'measured',
      value: false,
    });
    expect(report.measurements['provisionalBoardVersionAgrees']).toEqual({
      state: 'measured',
      value: true,
    });
    expect(report.measurements['provisionalCardsRendered']).toEqual({
      state: 'measured',
      value: 45,
    });
    expect(report.measurements['provisionalMarksApplied']).toEqual({ state: 'measured', value: 3 });
  });

  it('would have missed exactly this board under the old ten-minute window, and says so', async () => {
    const { report } = await run(HEALTHY, {}, { budget: OLD_WINDOW_BUDGET });

    expect(provisionalDeadline(OLD_WINDOW_BUDGET)).toBe(600_000);
    const time = report.measurements['timeToProvisionalBoardMs']!;
    expect(time.state).toBe('not_measured');
    expect(time).not.toHaveProperty('value');
    expect(time.state === 'not_measured' ? time.because.code : null).toBe('deadline_expired');
    expect(time.state === 'not_measured' ? time.because.detail : '').toMatch(
      /600s evaluation deadline/,
    );

    // The point of the whole exercise: the card count is an absence, never 0.
    const cards = report.measurements['provisionalBoardCardsPersisted']!;
    expect(cards.state).toBe('not_measured');
    expect(valueIn(cards)).toBeUndefined();
    expect(report.measurements['provisionalCardsRendered']!.state).toBe('not_measured');
    expect(report.ok).toBe(false);
  });

  it('separates "the compile ended with no board" from "we ran out of time"', async () => {
    const { report } = await run({
      ...HEALTHY,
      boardAfterMs: null,
      terminalAfterMs: 300_000,
      terminalState: 'partial',
    });
    const time = report.measurements['timeToProvisionalBoardMs']!;
    expect(time.state).toBe('not_measured');
    expect(time.state === 'not_measured' ? time.because.code : null).toBe('precondition_failed');
    expect(time.state === 'not_measured' ? time.because.detail : '').toMatch(
      /terminal state "partial" with no provisional board/,
    );
    expect(report.milestones['provisional_board_persisted']?.endedBy).toBe('aborted');
    // A partial compile is a terminal state and is reported as one.
    expect(report.measurements['compileState']).toEqual({ state: 'measured', value: 'partial' });
  });
});

describe('"not measured" is not zero', () => {
  it('serialises a measured zero as a zero and an absent measurement with no value at all', async () => {
    const { report } = await run(
      { ...HEALTHY, boardCards: 0 },
      {
        counts: {
          provisional_card: measured(0),
          board_card: measured(0),
          pinned_removal: measured(0),
        },
        marks: measured(0),
      },
    );

    expect(report.measurements['boardCards']).toEqual({ state: 'measured', value: 0 });
    expect(report.measurements['provisionalCardsRendered']).toEqual({
      state: 'measured',
      value: 0,
    });
    expect(report.measurements['provisionalMarksApplied']).toEqual({ state: 'measured', value: 0 });

    // Nothing built an itinerary, so the day count is an absence with a code —
    // not a day count of zero.
    const days = report.measurements['itineraryDays']!;
    expect(days.state).toBe('not_measured');
    expect(days).not.toHaveProperty('value');
    expect(days.state === 'not_measured' ? days.because.detail : '').toMatch(
      /absence of a step, not a day count of zero/,
    );
  });

  it('gives every manifest field a value or a reason, and never both and never neither', async () => {
    const { report } = await run(HEALTHY);
    for (const entry of EXPECTED_FIELDS) {
      const field = entry[0];
      const measurement = report.measurements[field];
      expect(measurement, `${field} is missing from the report`).toBeDefined();
      if (measurement!.state === 'measured') {
        expect(measurement!.value, `${field} is measured but null`).not.toBeNull();
        expect(measurement!).not.toHaveProperty('because');
      } else {
        expect(measurement!, `${field} is not measured but carries a value`).not.toHaveProperty(
          'value',
        );
        expect(
          measurement!.state === 'not_measured' ? measurement!.because.detail.length : 0,
          `${field} has no detail`,
        ).toBeGreaterThan(0);
      }
    }
    expect(report.integrity).toEqual([]);
  });

  it('lists every absent field with a typed code and a sentence', async () => {
    const { report } = await run(HEALTHY);
    const fields = report.notMeasured.map((entry) => entry.field);
    expect(fields).toContain('itineraryDays');
    for (const entry of report.notMeasured) {
      expect(NOT_MEASURED_PHRASES[entry.because.code]).toBeTruthy();
      expect(entry.because.detail.length).toBeGreaterThan(20);
      expect(entry.reads).toMatch(/^not measured \(/);
    }
  });

  it('refuses to construct an unexplained absence, or to measure nothing', () => {
    expect(() => notMeasured('markup_absent', '')).toThrow(/requires a detail/);
    expect(() => notMeasured('markup_absent', '   ')).toThrow(/requires a detail/);
    // The mirror image, and the one that matters: `measured(null)` is the
    // sentence "I measured nothing", and it is unsayable.
    expect(() => measured(null)).toThrow(/refuses null\/undefined/);
    expect(() => measured(undefined)).toThrow(/refuses null\/undefined/);
    // A measured zero, by contrast, is a claim the harness is allowed to make.
    expect(measured(0)).toEqual({ state: 'measured', value: 0 });
    expect(measured(false)).toEqual({ state: 'measured', value: false });
  });
});

// ---------------------------------------------------------------------------
// CS-13: the four leaks, one describe each
// ---------------------------------------------------------------------------

describe('leak 1 — a failed navigation is not an observed redirect', () => {
  it('reports the redirect field as not measured, never as true', async () => {
    const { report } = await run(HEALTHY, {
      navigationFailures: { '/trips/trip-1/provisional': 'net::ERR_CONNECTION_REFUSED' },
    });

    const redirected = report.measurements['provisionalRouteRedirected']!;
    /*
     * The old shape published `{observed: true, value: true}` here — from a
     * navigation that never completed, via a `finalPath` read off whatever the
     * browser still had open. Whether that route redirects is unknown.
     */
    expect(redirected.state).toBe('not_measured');
    expect(redirected).not.toHaveProperty('value');
    expect(redirected.state === 'not_measured' ? redirected.because.code : null).toBe(
      'navigation_failed',
    );
    expect(redirected.state === 'not_measured' ? redirected.because.detail : '').toMatch(
      /neither true nor false/,
    );
  });

  it('blocks every field behind it with the navigation reason, and no count', async () => {
    const { report } = await run(HEALTHY, {
      navigationFailures: { '/trips/trip-1/provisional': 'net::ERR_CONNECTION_REFUSED' },
    });
    for (const field of [
      'provisionalCardsRendered',
      'provisionalBoardVersionAgrees',
      'provisionalMarksApplied',
    ]) {
      const measurement = report.measurements[field]!;
      expect(measurement.state, `${field} should not have been measured`).toBe('not_measured');
      expect(measurement).not.toHaveProperty('value');
      expect(measurement.state === 'not_measured' ? measurement.because.code : null).toBe(
        'navigation_failed',
      );
    }
    const failure = report.harnessFailures.find((entry) => entry.kind === 'navigation_failed');
    expect(failure?.route?.outcome).toBe('navigation_failed');
    expect(report.ok).toBe(false);
  });

  it('distinguishes a failed navigation from a completed redirect, field by field', async () => {
    const failed = await run(HEALTHY, {
      navigationFailures: { '/trips/trip-1/discover': 'net::ERR_ABORTED' },
    });
    const redirected = await run(HEALTHY, {
      redirects: { '/trips/trip-1/discover': '/trips/trip-1/questionnaire' },
    });

    const a = failed.report.measurements['discoverRouteRedirected']!;
    const b = redirected.report.measurements['discoverRouteRedirected']!;
    expect(a.state).toBe('not_measured');
    expect(b).toEqual({ state: 'measured', value: true });
    expect(a).not.toEqual(b);
  });

  it('says the same thing about the itinerary status rather than inventing -1', async () => {
    const { report } = await run(HEALTHY, {
      navigationFailures: { '/trips/trip-1/itinerary': 'net::ERR_TIMED_OUT' },
    });
    const status = report.measurements['itineraryRouteStatus']!;
    expect(status.state).toBe('not_measured');
    expect(status).not.toHaveProperty('value');
    expect(JSON.stringify(status)).not.toContain('-1');
  });

  it('has a redirection() that cannot answer a failed navigation', () => {
    const failed = redirection({
      outcome: 'navigation_failed',
      requested: '/x',
      detail: 'boom',
    });
    const landed = redirection({
      outcome: 'navigated',
      requested: '/x',
      finalPath: '/x',
      status: measured(200),
      redirected: false,
    });
    const bounced = redirection({
      outcome: 'navigated',
      requested: '/x',
      finalPath: '/y',
      status: measured(200),
      redirected: true,
    });
    expect(failed.state).toBe('not_measured');
    expect(landed).toEqual({ state: 'measured', value: false });
    expect(bounced).toEqual({ state: 'measured', value: true });
  });
});

describe('leak 2 — markProvisionalCards', () => {
  it('reports an unrendered board as not measured rather than as no marks applied', async () => {
    const { report } = await run(HEALTHY, {
      marks: notMeasured(
        'markup_absent',
        'no provisional board on http://localhost:4200/trips/trip-1/questionnaire — no interaction was attempted',
      ),
    });
    const marks = report.measurements['provisionalMarksApplied']!;
    expect(marks.state).toBe('not_measured');
    expect(marks).not.toHaveProperty('value');
    expect(marks.state === 'not_measured' ? marks.because.code : null).toBe('markup_absent');
  });

  it('reports a rendered board with nothing to mark as a genuine zero', async () => {
    const { report } = await run(HEALTHY, { marks: measured(0) });
    expect(report.measurements['provisionalMarksApplied']).toEqual({
      state: 'measured',
      value: 0,
    });
  });

  it('keeps the two apart in the serialised report', async () => {
    const absent = await run(HEALTHY, {
      marks: notMeasured('markup_absent', 'the provisional board was not on the page'),
    });
    const zero = await run(HEALTHY, { marks: measured(0) });
    const a = JSON.stringify(absent.report.measurements['provisionalMarksApplied']);
    const b = JSON.stringify(zero.report.measurements['provisionalMarksApplied']);
    expect(a).not.toEqual(b);
    expect(a).not.toMatch(/"value"/);
    expect(b).toMatch(/"value":0/);
  });
});

describe('leak 3 — counts taken against markup that was never rendered', () => {
  it('records an absent container as not measured, with the markup reason', async () => {
    const { report } = await run(HEALTHY, {
      counts: {
        board_card: notMeasured(
          'markup_absent',
          'no [data-testid="discovery-board"] on the page — board_card was not counted',
        ),
        pinned_removal: notMeasured(
          'markup_absent',
          'no [data-testid="reconciliation-panel"] on the page — pinned_removal was not counted',
        ),
      },
    });
    for (const field of ['boardCards', 'pinnedRemovals']) {
      const measurement = report.measurements[field]!;
      expect(measurement.state, field).toBe('not_measured');
      expect(measurement).not.toHaveProperty('value');
      expect(measurement.state === 'not_measured' ? measurement.because.code : null).toBe(
        'markup_absent',
      );
    }
  });

  it('records a present container holding nothing as a measured zero', async () => {
    const { report } = await run(HEALTHY, {
      counts: { board_card: measured(0), pinned_removal: measured(0) },
    });
    expect(report.measurements['boardCards']).toEqual({ state: 'measured', value: 0 });
    expect(report.measurements['pinnedRemovals']).toEqual({ state: 'measured', value: 0 });
  });

  it('gives every countable kind a container in the adapter selector table', async () => {
    /*
     * The table itself, asserted from the adapter module. `within` was optional
     * and two of the three kinds omitted it, so they were counted against the
     * whole document and answered `0` on any page at all. Importing the module
     * pulls in Playwright and better-sqlite3 types only — no browser is
     * launched and no database is opened by the import.
     */
    const module = await import('./adapters.ts');
    expect(typeof module.PlaywrightJourneyDriver).toBe('function');
    for (const [kind, spec] of Object.entries(module.COUNTABLE_SELECTORS)) {
      expect(spec.within, `${kind} has no container`).toMatch(/^\[data-testid=/);
      expect(spec.item.length, `${kind} has no item selector`).toBeGreaterThan(0);
    }
  });
});

describe('leak 4 — a count taken after the surface failed to appear', () => {
  /*
   * `decide.eval.ts` is a script rather than a module, so the property is
   * asserted here as the rule it now follows: `locator.count()` does not throw
   * on a list that is not there — it answers `0` — so a `.catch(() => null)`
   * around it catches nothing, and the guard has to be the presence of the
   * container. This is the same shape as leak 3 and it is proved the same way.
   */
  it('cannot report a shortlist of zero from a shortlist that never rendered', () => {
    const deadline = notMeasured(
      'deadline_expired',
      'the shortlist list never appeared within 120s, so its items were never counted — this is not a shortlist of zero destinations',
    );
    const empty = measured(0);

    expect(serialise(deadline)).not.toHaveProperty('value');
    expect(serialise(empty)).toEqual({ state: 'measured', value: 0 });
    expect(renderMeasurement('shortlistCount', deadline)).toMatch(
      /^shortlistCount: not measured \(the wait window expired/,
    );
    expect(renderMeasurement('shortlistCount', empty)).toBe('shortlistCount: 0');
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('the reporting path renders both kinds distinctly', () => {
  it('renders a measured zero as a number and an absence as a sentence', () => {
    expect(renderMeasurement('provisionalCards', measured(0))).toBe('provisionalCards: 0');
    expect(
      renderMeasurement(
        'provisionalCards',
        notMeasured('redirected_away', 'requested /discover, landed on /questionnaire'),
      ),
    ).toBe(
      'provisionalCards: not measured (redirected away from the surface under test) — requested /discover, landed on /questionnaire',
    );
  });

  it('never renders an absence as a number, a null, a false or an empty string', () => {
    for (const code of Object.keys(NOT_MEASURED_PHRASES) as (keyof typeof NOT_MEASURED_PHRASES)[]) {
      const line = renderMeasurement('field', notMeasured(code, 'because of a thing'));
      expect(line).toMatch(/^field: not measured \(/);
      expect(line).not.toMatch(/^field: (0|null|false|)$/);
    }
  });

  it('serialises an absence with no value key, so JSON cannot be misread as data', async () => {
    const { report } = await run(HEALTHY, {}, { budget: OLD_WINDOW_BUDGET });
    const json = JSON.stringify(report.measurements['provisionalBoardCardsPersisted']);
    expect(json).not.toMatch(/"value"/);
    expect(json).toMatch(/"state":"not_measured"/);
    expect(json).toMatch(/"reads":"not measured \(/);
    // And the parsed object has no property a numeric reader could pick up.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['because', 'reads', 'state']);
  });

  it('prints every field of a whole report, measured and absent, on distinguishable lines', async () => {
    const { report } = await run(HEALTHY, {
      redirects: { '/trips/trip-1/discover': '/trips/trip-1/questionnaire' },
    });
    const lines = renderMeasurements(report.measurements);
    const boardLine = lines.find((line) => line.startsWith('boardCards:'))!;
    const cardsLine = lines.find((line) => line.startsWith('provisionalBoardCardsPersisted:'))!;

    expect(boardLine).toMatch(/^boardCards: not measured \(/);
    expect(cardsLine).toBe('provisionalBoardCardsPersisted: 45');
    // Nothing in the printed report reads as a bare zero it did not measure.
    expect(lines).not.toContain('boardCards: 0');

    const whole = renderReport(report).join('\n');
    expect(whole).toContain('not measured: ');
    expect(whole).toContain(`harness ${report.harnessVersion}`);
  });
});

describe('a redirect is a harness failure, not a score', () => {
  it('records the status and the final URL and blocks only the fields behind it', async () => {
    const { report } = await run(HEALTHY, {
      redirects: { '/trips/trip-1/discover': '/trips/trip-1/questionnaire' },
    });

    const failure = report.harnessFailures.find((entry) => entry.kind === 'unexpected_redirect');
    expect(failure).toBeDefined();
    const route = failure!.route!;
    expect(route.outcome).toBe('navigated');
    expect(route.requested).toBe('/trips/trip-1/discover');
    expect(route.outcome === 'navigated' ? route.finalPath : null).toBe(
      '/trips/trip-1/questionnaire',
    );
    expect(route.outcome === 'navigated' ? valueIn(serialise(route.status)) : null).toBe(200);
    expect(route.outcome === 'navigated' ? route.redirected : null).toBe(true);
    expect(report.measurements['discoverRouteRedirected']).toEqual({
      state: 'measured',
      value: true,
    });

    for (const field of ['boardCards', 'reconciliationShown', 'weatherState']) {
      const measurement = report.measurements[field]!;
      expect(measurement.state, `${field} should not have been measured`).toBe('not_measured');
      expect(measurement).not.toHaveProperty('value');
    }
    // The exact shape of the old report — 0 cards, reconciliation false — is
    // now impossible to produce from a redirect.
    expect(valueIn(report.measurements['boardCards'])).not.toBe(0);
    expect(valueIn(report.measurements['reconciliationShown'])).not.toBe(false);
    expect(report.ok).toBe(false);
  });

  it('keeps every compile metric a redirect at the end cannot touch', async () => {
    const { report } = await run(HEALTHY, {
      redirects: { '/trips/trip-1/discover': '/trips/trip-1/questionnaire' },
    });
    expect(report.measurements['compileMs']!.state).toBe('measured');
    expect(report.measurements['compileState']).toEqual({ state: 'measured', value: 'ready' });
    expect(report.measurements['provisionalBoardCardsPersisted']).toEqual({
      state: 'measured',
      value: 45,
    });
    expect(report.measurements['spend']!.state).toBe('measured');
  });

  it('never opens /discover without a profile, and says that is why the board is unmeasured', async () => {
    const { report, driver } = await run(HEALTHY, { completeProfile: measured(false) });
    expect(driver.visits).not.toContain('/trips/trip-1/discover');
    expect(report.measurements['profileCompleted']).toEqual({ state: 'measured', value: false });
    const board = report.measurements['boardCards']!;
    expect(board.state).toBe('not_measured');
    expect(board.state === 'not_measured' ? board.because.detail : '').toMatch(
      /redirects to the questionnaire/,
    );
  });

  it('records both halves — the persisted state stands when the browser check does not', async () => {
    const { report } = await run(HEALTHY, {
      redirects: { '/trips/trip-1/discover': '/trips/trip-1/questionnaire' },
    });
    expect(report.measurements['reconciliationShown']!.state).toBe('not_measured');
    expect(report.measurements['reconciliationVersion']).toEqual({ state: 'measured', value: 3 });
    expect(report.measurements['weatherSnapshotStatus']).toEqual({
      state: 'measured',
      value: 'not_fetched',
    });
  });
});

describe('teardown ordering', () => {
  it('publishes the report before anything is destroyed', async () => {
    const { order, published, teardownPerformed, teardowns, store } = await run(HEALTHY);
    expect(published).toBe(true);
    expect(teardownPerformed).toBe(true);
    expect(order.indexOf('publish_report')).toBeLessThan(order.indexOf('teardown'));
    // The teardown ran with exactly one report already written.
    expect(teardowns).toEqual([1]);
    expect(store.closed).toBe(true);
  });

  it('leaves the database alone when the report could not be written', async () => {
    const { order, published, teardownPerformed, report, store } = await run(
      HEALTHY,
      {},
      {},
      () => {
        throw new Error('disk full');
      },
    );
    expect(published).toBe(false);
    expect(teardownPerformed).toBe(false);
    expect(store.closed).toBe(false);
    expect(order).toContain('teardown_skipped');
    expect(order).not.toContain('teardown');
    expect(
      report.harnessFailures.some(
        (entry) => entry.kind === 'publication_failed' && /disk full/.test(entry.detail),
      ),
    ).toBe(true);
  });
});

describe('spend', () => {
  it('is recorded on a failed compile', async () => {
    const { report } = await run({
      ...HEALTHY,
      boardAfterMs: null,
      terminalAfterMs: 120_000,
      terminalState: 'failed',
      errorCode: 'route_matrix_incomplete',
    });
    expect(report.measurements['compileState']).toEqual({ state: 'measured', value: 'failed' });
    expect(report.measurements['compileErrorCode']).toEqual({
      state: 'measured',
      value: 'route_matrix_incomplete',
    });
    const spend = report.measurements['spend']!;
    expect(spend.state).toBe('measured');
    expect((valueIn(spend) as SpendLedger).costMicroUsd).toBe(526_009);
  });

  it('is recorded on a partial compile', async () => {
    const { report } = await run({ ...HEALTHY, terminalState: 'partial' });
    expect(report.measurements['compileState']).toEqual({ state: 'measured', value: 'partial' });
    expect(report.measurements['spend']!.state).toBe('measured');
  });

  it('says so plainly when the ledger cannot be read, rather than reporting no cost', async () => {
    const { report } = await run({ ...HEALTHY, spend: null });
    const spend = report.measurements['spend']!;
    expect(spend.state).toBe('not_measured');
    expect(spend).not.toHaveProperty('value');
    expect(spend.state === 'not_measured' ? spend.because.detail : '').toMatch(
      /may have cost money that is not recorded here/,
    );
  });

  it('still produces a whole report when the composer never made a trip', async () => {
    const { report } = await run(HEALTHY, {
      tripId: notMeasured('navigation_failed', 'the composer never navigated to a trip route'),
    });
    expect(report.measurements['tripId']!.state).toBe('not_measured');
    for (const entry of EXPECTED_FIELDS) {
      expect(report.measurements[entry[0]]).toBeDefined();
    }
    expect(report.measurements['boardCards']).not.toHaveProperty('value');
    const spend = report.measurements['spend']!;
    expect(spend.state === 'not_measured' ? spend.because.detail : '').toMatch(/no trip id/);
  });
});

describe('the evaluation budget', () => {
  it('cannot have a provisional watch shorter than the compile it contains', () => {
    expect(provisionalDeadline(DEFAULT_BUDGET)).toBeGreaterThan(DEFAULT_BUDGET.compileMs);
    expect(budgetViolations(DEFAULT_BUDGET)).toEqual([]);
  });

  it('is bounded, explicit, and comfortably longer than the longest live compile', () => {
    // 625 s (New York) and 617 s (Bali) are the measured worst cases.
    expect(DEFAULT_BUDGET.compileMs).toBeGreaterThan(4 * 625_000);
    expect(Number.isFinite(DEFAULT_BUDGET.compileMs)).toBe(true);
  });

  it('reports a nonsensical budget rather than running with it', () => {
    const violations = budgetViolations({ ...DEFAULT_BUDGET, compileMs: 0, pollIntervalMs: -1 });
    expect(violations).toContain('compileMs must be a positive number');
    expect(violations).toContain('pollIntervalMs must be a positive number');
  });
});

describe('milestone polling', () => {
  it('counts probe errors and names the last one rather than reporting nothing found', async () => {
    const clock = fakeClock();
    const outcome = await awaitMilestone<number>(clock, {
      name: 'flaky',
      deadlineMs: 10_000,
      intervalMs: 1_000,
      probe: () => {
        throw new Error('database is locked');
      },
    });
    expect(outcome.measured.state).toBe('not_measured');
    expect(outcome.probeErrors).toBeGreaterThan(5);
    expect(
      outcome.measured.state === 'not_measured' ? outcome.measured.because.detail : '',
    ).toMatch(/database is locked/);
  });

  it('measures against the clock rather than against an attempt count', async () => {
    const clock = fakeClock();
    let calls = 0;
    const outcome = await awaitMilestone<string>(clock, {
      name: 'slow',
      deadlineMs: 60_000,
      intervalMs: 1_000,
      probe: () => {
        calls += 1;
        // Each probe itself takes ten seconds of wall time.
        clock.advance(10_000);
        return calls >= 4 ? 'here' : null;
      },
    });
    expect(outcome.measured.state).toBe('measured');
    // Four probes, but 44 s of elapsed time — an attempt budget would have been
    // a duration only by accident.
    expect(outcome.attempts).toBe(4);
    expect(outcome.elapsedMs).toBeGreaterThan(40_000);
  });
});

// ---------------------------------------------------------------------------
// THE TYPE ITSELF
// ---------------------------------------------------------------------------

describe('an adapter cannot express a substituted default', () => {
  /*
   * These assertions are compile-time. Vitest does not typecheck, so each one is
   * also a `@ts-expect-error`, which *fails the build* if the expression it
   * guards ever becomes legal — which is exactly the regression to catch. The
   * runtime half of the same property is asserted in "refuses to construct an
   * unexplained absence, or to measure nothing" above.
   */
  it('rejects a bare 0, null, -1 or false where a measurement belongs', () => {
    // @ts-expect-error a bare zero is not a measurement
    const zero: Measured<number> = 0;
    // @ts-expect-error null is not a measurement
    const nothing: Measured<number> = null;
    // @ts-expect-error a sentinel is not a measurement
    const sentinel: Measured<number> = -1;
    // @ts-expect-error false is not a measurement
    const no: Measured<boolean> = false;
    expect([zero, nothing, sentinel, no]).toHaveLength(4);
  });

  it('rejects an absence that smuggles a value alongside its reason', () => {
    const absence: Measured<number> = {
      state: 'not_measured',
      because: { code: 'markup_absent', detail: 'nothing rendered' },
      // @ts-expect-error the not_measured arm has no value slot at all
      value: 0,
    };
    expect(absence.state).toBe('not_measured');
  });

  it('rejects a driver whose observations are bare scalars', () => {
    const leaky: Pick<JourneyDriver, 'count' | 'markProvisionalCards'> = {
      // @ts-expect-error count() must answer Measured<number>, not number
      count: async () => 0,
      // @ts-expect-error markProvisionalCards() must answer Measured<number>
      markProvisionalCards: async () => 0,
    };
    expect(typeof leaky.count).toBe('function');
  });

  it('rejects a route visit that reports a status it never had', () => {
    const failed: RouteVisit = {
      outcome: 'navigation_failed',
      requested: '/trips/x/discover',
      detail: 'net::ERR_CONNECTION_REFUSED',
    };
    // @ts-expect-error the failed arm carries no finalPath to compare against
    const path: string = failed.finalPath;
    // @ts-expect-error nor a status, so `?? -1` has nothing to fall back from
    const status: number = failed.status;
    expect([path, status]).toHaveLength(2);
  });

  it('has an exhaustive runtime guard over the whole reason vocabulary', () => {
    /*
     * The honest runtime half: every code in the vocabulary has a phrase, and a
     * code with no phrase would render `undefined` into a report. The `never`
     * assignment makes adding a code without a phrase a compile error too.
     */
    for (const code of Object.keys(NOT_MEASURED_PHRASES)) {
      const phrase = NOT_MEASURED_PHRASES[code as keyof typeof NOT_MEASURED_PHRASES];
      expect(phrase, code).toBeTruthy();
      expect(phrase).not.toMatch(/undefined/);
    }
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('navigation_failed');
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('redirected_away');
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('deadline_expired');
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('markup_absent');
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('provider_disabled');
    expect(Object.keys(NOT_MEASURED_PHRASES)).toContain('precondition_failed');
  });
});
