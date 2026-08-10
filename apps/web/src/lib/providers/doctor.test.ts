import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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

function runDoctor(env: Record<string, string>): { code: number; out: string } {
  /*
   * A clean environment rather than an inherited one. A developer with real
   * switches set in their shell would otherwise get different results from CI,
   * which is the failure mode a configuration test exists to prevent.
   */
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, out: failure.stdout ?? '' };
  }
}

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

  it('does not claim transit routing it cannot do', () => {
    const { out } = runDoctor(FULLY_CONFIGURED);
    /*
     * The one capability the product must never overstate. Walking is not
     * transit, and a road matrix is not a timetable — the honest answer while
     * no transit provider exists is that scheduled modes stay unmeasured.
     */
    expect(out).toContain('Public transit routing');
    expect(out).toContain('not available');
  });

  it('warns when the internal surface is live without a token', () => {
    const { out } = runDoctor({ ...FULLY_CONFIGURED, SIDEQUEST_BENCHMARK_MODE: 'live' });
    expect(out).toContain('LIVE MODE WITH NO TOKEN');
  });
});
