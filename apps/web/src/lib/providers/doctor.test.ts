import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { TravelCapability } from '@sidequest/core';

/**
 * THE DOCTOR IS ONLY WORTH HAVING IF IT AGREES WITH THE APP.
 *
 * `scripts/doctor.mjs` deliberately imports nothing — it has to answer before
 * there is a build, a database or a server, which is the whole reason it exists.
 * The cost of that is duplicated predicates, and duplicated predicates rot.
 *
 * So this runs the real script as a real process, under environments chosen to
 * be exactly the ones that have caused trouble, and asserts three things a
 * comment cannot: that it agrees with `switches.ts` about whether a build can
 * compile, that it exits non-zero when it cannot, and — the one that matters
 * most — that **no secret value ever appears in its output**.
 */

const SCRIPT = new URL('../../../scripts/doctor.mjs', import.meta.url).pathname;

/** A credential shaped like a real one, so a leak would be unmistakable. */
const SECRET = 'sk-ant-doctor-must-never-print-this-0123456789';

function runDoctor(
  env: Record<string, string>,
  args: string[] = ['--sidequest-env-file=none'],
): { code: number; out: string } {
  /*
   * A clean environment rather than an inherited one. A developer with real
   * switches set in their shell would otherwise get different results from CI,
   * which is the failure mode a configuration test exists to prevent —
   * `--sidequest-env-file=none` keeps the developer's real `.env.local` out for the same
   * reason, and the env-file tests below pass their own file instead.
   */
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, out: failure.stdout ?? '' };
  }
}

/**
 * The capabilities whose verdict both implementations must agree on.
 *
 * Deliberately the three this pass made load-bearing plus the two that were
 * already: a capability the doctor prints and the registry does not model, or
 * the reverse, is the divergence being guarded against.
 */
const COMPARED: readonly { capability: TravelCapability; heading: string }[] = [
  { capability: 'route_transit', heading: 'Public transit routing' },
  { capability: 'civil_time_zone', heading: 'Real local time zone' },
  { capability: 'climate_normals', heading: 'Historical climate' },
  { capability: 'official_web_research', heading: 'Bounded web research' },
];

/** Every switch the matrix sets, cleared between cases so one cannot leak. */
const TOGGLES = [
  'SIDEQUEST_COMPILER_PROVIDER',
  'SIDEQUEST_GEOCODER_PROVIDER',
  'SIDEQUEST_PLACE_BACKBONE',
  'SIDEQUEST_POI_PROVIDER',
  'SIDEQUEST_ROUTES_PROVIDER',
  'SIDEQUEST_RESEARCH_PROVIDER',
  'SIDEQUEST_TRANSIT_PROVIDER',
  'SIDEQUEST_TIMEZONE_PROVIDER',
  'SIDEQUEST_CLIMATE_PROVIDER',
  'ANTHROPIC_API_KEY',
] as const;

const FULLY_CONFIGURED = {
  SIDEQUEST_COMPILER_PROVIDER: 'open',
  SIDEQUEST_GEOCODER_PROVIDER: 'nominatim',
  SIDEQUEST_PLACE_BACKBONE: 'overture',
  SIDEQUEST_ROUTES_PROVIDER: 'valhalla',
  SIDEQUEST_RESEARCH_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: SECRET,
};

describe('the configuration doctor', () => {
  it('refuses, and exits non-zero, when nothing is configured', () => {
    const { code, out } = runDoctor({});
    expect(code).toBe(1);
    expect(out).toContain('cannot research a new destination');
    expect(out).toContain('Compilation mode: off');
  });

  it('reports success and exits zero when the open stack is fully configured', () => {
    const { code, out } = runDoctor(FULLY_CONFIGURED);
    expect(code).toBe(0);
    expect(out).toContain('Compilation mode: open');
    expect(out).toContain('yes, through the open map stack');
  });

  it('names the missing credential rather than reporting an empty list', () => {
    /*
     * The exact defect: `openProvidersEnabled` required the key and
     * `missingProviderSwitches` did not report it, so a build with every switch
     * set and no credential rendered the sentence "This build is missing: .".
     */
    const { ANTHROPIC_API_KEY: _omitted, ...withoutKey } = FULLY_CONFIGURED;
    const { code, out } = runDoctor(withoutKey);
    expect(code).toBe(1);
    expect(out).toContain('ANTHROPIC_API_KEY');
    expect(out).not.toMatch(/Still needed, by name:\s*\n\s*\n/);
  });

  it('never prints any part of a credential', () => {
    const { out } = runDoctor(FULLY_CONFIGURED);
    expect(out).not.toContain(SECRET);
    /* Not even a prefix long enough to be worth guessing from. */
    expect(out).not.toContain(SECRET.slice(0, 12));
    /* And nothing that looks like a key at all. */
    expect(out).not.toMatch(/sk-[A-Za-z0-9-]{8,}/);
  });

  it('says a fixture build plans synthetic worlds rather than claiming it is live', () => {
    const { code, out } = runDoctor({ SIDEQUEST_COMPILER_PROVIDER: 'fixture' });
    expect(code).toBe(0);
    expect(out).toContain('fixture worlds only');
  });

  /**
   * THE AGREEMENT THIS FILE'S OWN DOCSTRING CLAIMED AND DID NOT HAVE.
   *
   * The previous version of the transit test asserted `out` contained the string
   * `'not available'` — a hard-coded literal pinned against a hard-coded
   * `mark(false, …)`. It could not fail, and while it sat there passing, the
   * switches and the capability registry grew the ability to enable transit and
   * the doctor did not. A deployment with a transit-capable router was told it
   * had none, by a test written to prevent exactly that.
   *
   * So the assertion is now a *comparison*. The script is run under a matrix of
   * environments, and each capability verdict is checked against
   * `capabilityRegistry()` evaluated in this process under the same environment.
   * The two implementations stay two — the zero-import property is what lets the
   * doctor answer before there is a build — but they can no longer disagree
   * quietly, which is the only property the duplication ever needed.
   */
  it.each([
    { label: 'nothing configured', env: {} },
    { label: 'the open stack', env: FULLY_CONFIGURED },
    {
      label: 'transit enabled',
      env: { ...FULLY_CONFIGURED, SIDEQUEST_TRANSIT_PROVIDER: 'valhalla' },
    },
    {
      label: 'transit named as something else',
      env: { ...FULLY_CONFIGURED, SIDEQUEST_TRANSIT_PROVIDER: 'yes' },
    },
    {
      label: 'time zones switched off',
      env: { ...FULLY_CONFIGURED, SIDEQUEST_TIMEZONE_PROVIDER: 'off' },
    },
  ])('agrees with the capability registry about $label', async ({ env }) => {
    const { out } = runDoctor(env);

    /*
     * The registry read in this process, under the same environment the script
     * saw. Imported dynamically *after* the environment is set, because the
     * switch predicates read `process.env` at call time and a module graph
     * loaded earlier would answer for the developer's shell instead.
     */
    const previous = { ...process.env };
    try {
      for (const key of TOGGLES) delete process.env[key];
      Object.assign(process.env, env);
      const { capabilityRegistry } = await import('../capabilities');
      const registry = capabilityRegistry();

      for (const { capability, heading } of COMPARED) {
        const available = registry.assess(capability).available;
        const line = out
          .split('\n')
          .find((entry) => entry.includes(heading) && entry.includes('—'));
        expect(line, `the doctor never mentions ${heading}`).toBeDefined();
        /*
         * `✓` is the doctor's own affirmative mark. Comparing the mark rather
         * than the prose is deliberate: the sentence is allowed to change, the
         * verdict is not.
         */
        expect(
          line!.trimStart().startsWith('✓'),
          `${heading}: the doctor says ${line!.trimStart().slice(0, 1)} and the registry says ${available}`,
        ).toBe(available);
      }
    } finally {
      for (const key of TOGGLES) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it('reports the time-zone database its offsets are computed against', () => {
    /*
     * Not decoration. Every opening hour and daylight window is derived from an
     * IANA identifier through this runtime's own copy of the database, and a
     * runtime lagging the published release is wrong about a rule change that
     * has already happened — undetectably, from inside the process.
     */
    const { out } = runDoctor(FULLY_CONFIGURED);
    expect(out).toContain('Time-zone database');
    expect(out).toContain('offsets are computed, never stored');
  });

  it('does not imply it has checked that any endpoint answers', () => {
    /*
     * A doctor that reported a fully-ready build with three endpoints pointed at
     * a closed port is a doctor that reassures rather than diagnoses. It still
     * cannot reach them — that would make a configuration check into a network
     * call — so the requirement is that it says so.
     */
    const { out } = runDoctor(FULLY_CONFIGURED);
    expect(out).toContain('SIDEQUEST_ROUTES_URL');
    expect(out).toContain('This is a configuration report, not a reachability check.');
  });

  it('warns when the internal surface is billable without a token', () => {
    const { out } = runDoctor({
      ...FULLY_CONFIGURED,
      SIDEQUEST_BENCHMARK_MODE: 'live',
      SIDEQUEST_BENCHMARK_BUDGET_USD: '15',
    });
    expect(out).toContain('BILLABLE PROVIDERS WITH NO TOKEN');
  });

  it('warns about /labs for an open compiler even in fixture benchmark mode', () => {
    /*
     * Mirrors the middleware: the benchmark's sidequest arm compiles real
     * regions whenever the compiler is open, so "fixture mode, nothing
     * billable" was false for exactly the deployments it mattered to.
     */
    const { out } = runDoctor({ ...FULLY_CONFIGURED, SIDEQUEST_BENCHMARK_MODE: 'fixture' });
    expect(out).toContain('BILLABLE PROVIDERS WITH NO TOKEN');

    const withToken = runDoctor({ ...FULLY_CONFIGURED, SIDEQUEST_LABS_TOKEN: 'a-secret' });
    expect(withToken.out).toContain('token required');
  });

  it('names the imagery mode the app would actually run, under every environment', async () => {
    /*
     * The exact honesty gap this began as: `(default)` looked identical for
     * weather (default ON) and imagery, so an operator could not see which of
     * their lines meant "this does nothing".
     *
     * Then this test rotted the same way the transit line did, and for the same
     * reason — it pinned the *prose* (`off .*opt-in`). When the candidate
     * imagery pass landed and `imageryMode()`'s default flipped to Wikimedia,
     * the doctor went on reporting `off` and this test went on passing. A
     * duplicated predicate is allowed to exist here; it is not allowed to
     * disagree quietly.
     *
     * So it is a comparison now, against `imageryMode()` evaluated in this
     * process under the same environment the script saw — imported after the
     * environment is set, because the predicate reads `process.env` at call
     * time.
     */
    const environments: Record<string, string>[] = [
      FULLY_CONFIGURED,
      { SIDEQUEST_COMPILER_PROVIDER: 'fixture' },
      { ...FULLY_CONFIGURED, SIDEQUEST_IMAGERY_PROVIDER: 'wikimedia' },
      { ...FULLY_CONFIGURED, SIDEQUEST_IMAGERY_PROVIDER: 'off' },
      { ...FULLY_CONFIGURED, SIDEQUEST_IMAGERY_PROVIDER: 'fixture' },
      {},
    ];

    const previous = { ...process.env };
    try {
      for (const env of environments) {
        const { out } = runDoctor(env);

        for (const key of TOGGLES) delete process.env[key];
        delete process.env.SIDEQUEST_IMAGERY_PROVIDER;
        Object.assign(process.env, env);
        const { imageryMode } = await import('./wikimedia');
        const mode = imageryMode();

        const line = out.split('\n').find((entry) => entry.includes('Imagery provider'));
        expect(line, 'the doctor never mentions imagery').toBeDefined();
        expect(
          line,
          `imagery: the doctor prints "${line?.trim()}" and the app would run "${mode}"`,
        ).toContain(`Imagery provider — ${mode}`);
      }
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('names the weather provider the app would actually run, under every environment', async () => {
    /**
     * The third copy of the same lesson, applied where it had not been.
     *
     * This assertion used to read `/Weather provider — openmeteo \(default/`:
     * a pin on the script's own prose, with nothing comparing it to the
     * predicate that decides. An adversary flipped `weatherProviderChoice()`'s
     * default from `openmeteo` to `off` — every day in the product then says
     * weather was not considered — and this test went on passing while the
     * doctor went on telling the operator their deployment had live weather.
     * That is exactly the rot the imagery test above documents, and PR-PROV-01
     * ("the doctor truthfully reflects actual runtime capability") is a release
     * blocker.
     *
     * So it is a comparison, against `weatherProviderChoice()` evaluated in
     * this process under the same environment the script saw — imported after
     * the environment is set, because the predicate reads `process.env` at
     * call time.
     */
    const environments: Record<string, string>[] = [
      FULLY_CONFIGURED,
      { SIDEQUEST_COMPILER_PROVIDER: 'fixture' },
      { ...FULLY_CONFIGURED, SIDEQUEST_WEATHER_PROVIDER: 'openmeteo' },
      { ...FULLY_CONFIGURED, SIDEQUEST_WEATHER_PROVIDER: 'fixture' },
      { ...FULLY_CONFIGURED, SIDEQUEST_WEATHER_PROVIDER: 'off' },
      /* Garbage, which both sides must resolve the same way rather than each guessing. */
      { ...FULLY_CONFIGURED, SIDEQUEST_WEATHER_PROVIDER: 'open-meteo' },
      {},
    ];

    const previous = { ...process.env };
    try {
      for (const env of environments) {
        const { out } = runDoctor(env);

        for (const key of TOGGLES) delete process.env[key];
        delete process.env.SIDEQUEST_WEATHER_PROVIDER;
        Object.assign(process.env, env);
        const { weatherProviderChoice } = await import('../weather');
        const choice = weatherProviderChoice();

        const line = out.split('\n').find((entry) => entry.includes('Weather provider'));
        expect(line, 'the doctor never mentions weather').toBeDefined();
        expect(
          line,
          `weather: the doctor prints "${line?.trim()}" and the app would run "${choice}"`,
        ).toContain(`Weather provider — ${choice}`);
      }
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('resolves the food default to what actually runs', () => {
    /*
     * Not the parity shape above, and the reason is worth writing down: the
     * operative food predicate is an inline expression inside `region.ts`
     * rather than a named function, so there is nothing to import and compare
     * against. Pinned as behaviour instead — on by default, off when asked —
     * with the divergence risk recorded rather than hidden.
     */
    const { out } = runDoctor(FULLY_CONFIGURED);
    expect(out).toMatch(/Food provider — on/);

    const foodOff = runDoctor({ ...FULLY_CONFIGURED, SIDEQUEST_FOOD_PROVIDER: 'off' });
    expect(foodOff.out).toMatch(/Food provider — off/);
  });

  it('reads the app’s env file when asked, values never printed, and says which file', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sidequest-doctor-env-'));
    const file = join(dir, '.env.local');
    try {
      writeFileSync(
        file,
        [
          '# a comment',
          'SIDEQUEST_GEOCODER_PROVIDER=nominatim',
          'SIDEQUEST_PLACE_BACKBONE="overture"',
          'SIDEQUEST_ROUTES_PROVIDER=valhalla',
          'SIDEQUEST_RESEARCH_PROVIDER=anthropic',
          `ANTHROPIC_API_KEY=${SECRET}`,
          '',
        ].join('\n'),
      );
      const { code, out } = runDoctor({}, [`--sidequest-env-file=${file}`]);
      // The verdicts must match what the app itself would see at runtime.
      expect(code).toBe(0);
      expect(out).toContain('Compilation mode: open');
      expect(out).toContain(`Environment file: ${file}`);
      // The file's values inform verdicts and never appear.
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(SECRET.slice(0, 12));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the real environment beat the env file, exactly as dotenv does', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sidequest-doctor-env-'));
    const file = join(dir, '.env.local');
    try {
      writeFileSync(file, 'SIDEQUEST_COMPILER_PROVIDER=open\n');
      const { out } = runDoctor({ SIDEQUEST_COMPILER_PROVIDER: 'fixture' }, [
        `--sidequest-env-file=${file}`,
      ]);
      expect(out).toContain('Compilation mode: fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the missing env file rather than silently answering for a bare shell', () => {
    const { out } = runDoctor({}, ['--sidequest-env-file=/nonexistent/.env.local']);
    expect(out).toContain('not found — shell environment only');
  });
});
