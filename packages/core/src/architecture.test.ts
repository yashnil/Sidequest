import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARDRAILS THAT KEEP THE ENGINE GENERIC.
 *
 * Sidequest has one authored region and is meant to have any number. The failure
 * mode is not dramatic — nobody sets out to hard-code Mammoth Lakes into a
 * scoring function. It happens one convenience at a time: a barrel export here, a
 * magic tag there, a sentence of copy that names a highway. Each is defensible
 * alone and together they are a product that only works in one valley.
 *
 * So the rules are enforced rather than agreed. Every check below has a named
 * exception list, and adding to one is a decision somebody has to write down.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Packages that must work for any destination on earth. */
const GENERIC_ROOTS = [
  'packages/core/src',
  'packages/geo/src',
  'packages/planner/src',
  'packages/compiler/src',
];

/**
 * Where region-specific material is allowed to live.
 *
 * `data/` is the seed region itself. `testing/` holds the harnesses that build
 * scenarios from it. Test files may name anything they assert on — a regression
 * test for the golden fixture that could not say "Mammoth" would be useless.
 */
const ALLOWED_PATTERNS = [
  /packages\/core\/src\/data\//,
  /packages\/core\/src\/testing\//,
  /packages\/planner\/src\/testing\//,
  /\.test\.ts$/,
];

/**
 * Identifiers from the one authored region.
 *
 * Matched case-insensitively against **code**, with comments stripped first: a
 * comment explaining that "the Eastern Sierra is a corridor and Tokyo is not" is
 * exactly the kind of reasoning this repository wants written down, and banning
 * the word from prose would delete it.
 */
const FIXTURE_IDENTIFIERS = [
  'mammoth',
  'eastern sierra',
  'eastern-sierra',
  'easternSierra',
  'EASTERN_SIERRA',
  'june lake',
  'mono lake',
  'convict lake',
  'hot creek',
  'reds meadow',
  'devils postpile',
  'rainbow falls',
  'minaret',
  'manzanar',
  'obsidian dome',
  'wild willy',
  'inyo',
  'bishop',
  'bodie',
  'us-395',
  'highway 395',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function relative(path: string): string {
  return path.slice(ROOT.length).replace(/^\/+/, '');
}

/**
 * Code with comments and string-free of prose removed.
 *
 * Block and line comments go; string literals stay, because a hard-coded region
 * name in a user-facing sentence is precisely the thing being looked for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function genericFiles(): string[] {
  return GENERIC_ROOTS.flatMap((root) => walk(join(ROOT, root))).filter(
    (path) => !ALLOWED_PATTERNS.some((pattern) => pattern.test(relative(path))),
  );
}

describe('the generic engine stays generic', () => {
  it('has files to check, so a broken path cannot make this suite vacuous', () => {
    // Without this, a renamed directory turns every check below into a
    // green tick over an empty list.
    expect(genericFiles().length).toBeGreaterThan(40);
  });

  it('never mentions the seed region in runtime code', () => {
    const offenders: string[] = [];
    for (const path of genericFiles()) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const identifier of FIXTURE_IDENTIFIERS) {
        if (code.toLowerCase().includes(identifier.toLowerCase())) {
          offenders.push(`${relative(path)} mentions "${identifier}"`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never imports the seed data from generic code', () => {
    const offenders: string[] = [];
    for (const path of genericFiles()) {
      const source = readFileSync(path, 'utf8');
      // Both spellings: the package subpath, and a relative hop into `data/`.
      if (/from\s+'@sidequest\/core\/data'/.test(source)) {
        offenders.push(`${relative(path)} imports @sidequest/core/data`);
      }
      if (/from\s+'\.\.?\/(\.\.\/)*data\//.test(source)) {
        offenders.push(`${relative(path)} imports a data/ module`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('does not re-export the seed region from the engine package root', () => {
    const barrel = readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8');
    expect(stripComments(barrel)).not.toMatch(/from\s+'\.\/data/);
  });

  it('keeps geo free of every other package', () => {
    for (const path of walk(join(ROOT, 'packages/geo/src'))) {
      const source = readFileSync(path, 'utf8');
      expect(source, relative(path)).not.toMatch(/from\s+'@sidequest\//);
    }
  });

  it('keeps the planner free of provider and network code', () => {
    for (const path of walk(join(ROOT, 'packages/planner/src'))) {
      if (/\.test\.ts$/.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${relative(path)} performs I/O`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${relative(path)} reads the environment`).not.toMatch(/process\.env/);
    }
  });

  it('never lets a provider assert a verification state or a confidence number', () => {
    /**
     * The rule the whole evidence layer rests on: authority, corroboration and
     * freshness are computed from observable properties by `evidence/resolve.ts`,
     * and nothing else may write a `FactVerificationState`.
     *
     * A provider that could stamp `verified` on its own output would make the
     * badge on a card mean "a model felt sure", which is the exact claim this
     * product exists not to make. Checked structurally rather than agreed,
     * because the convenient version of this mistake is one line long.
     */
    const offenders: string[] = [];
    const allowed = [
      /packages\/core\/src\/evidence\/resolve\.ts$/,
      /packages\/core\/src\/schemas\//,
      /\.test\.ts$/,
    ];
    for (const path of genericFiles()) {
      const relativePath = relative(path);
      if (allowed.some((pattern) => pattern.test(relativePath))) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      // Assigning a state literal outside the resolver, e.g. `state: 'verified'`.
      if (/\bstate:\s*'(verified|corroborated)'/.test(code)) {
        offenders.push(`${relativePath} assigns a verification state directly`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never claims corroboration without counting independent sources', () => {
    /**
     * `multiple_providers_agree` was once emitted because a model agreed a string
     * looked place-like, which pushed single-source results to high confidence
     * and skipped the screen where a traveller would have caught them. The signal
     * is legitimate; asserting it without a second source is not.
     */
    const offenders: string[] = [];
    /**
     * Test harnesses are exempt from the *structural* check and not from the
     * rule: `testing/fakes.ts` emits the signal beside two real provider refs,
     * which is what earns it. A regex cannot see that, and weakening the regex
     * until it could would exempt the runtime code this exists to police.
     */
    const harness = /packages\/compiler\/src\/testing\//;
    for (const path of genericFiles()) {
      if (harness.test(relative(path))) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      if (!/multiple_providers_agree/.test(code)) continue;
      // The only defensible emission is one guarded by a count of distinct sources.
      if (!/(length|size)\s*(>=?\s*2|>\s*1)|independentSources/.test(code)) {
        offenders.push(`${relative(path)} claims corroboration without counting sources`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the evidence layer free of I/O, so a compiled artifact is reproducible', () => {
    for (const path of walk(join(ROOT, 'packages/core/src/evidence'))) {
      if (/\.test\.ts$/.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${relative(path)} performs I/O`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${relative(path)} reads a clock`).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    }
  });

  it('never lets a URL field accept a javascript: or data: scheme', () => {
    /**
     * `z.string().url()` accepts `javascript:alert(1)`. Every URL in the product
     * is a hand-written constant today, so that has never mattered — and the
     * moment a compiled region can author a `sourceUrl` from somebody else's
     * page, each of those fields is an `href` an attacker controls, stored in
     * the database and rendered back.
     */
    const offenders: string[] = [];
    for (const path of walk(join(ROOT, 'packages/core/src/schemas'))) {
      const code = stripComments(readFileSync(path, 'utf8'));
      if (path.endsWith('common.ts')) continue;
      if (/z\.string\(\)\.url\(\)/.test(code)) {
        offenders.push(`${relative(path)} uses z.string().url() instead of httpUrlSchema`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the place backbone free of network and clock, so a pack is reproducible', () => {
    /**
     * The backbone decides what a region contains. If it could fetch, two runs of
     * one input would disagree; if it could read a clock, a pack's content hash
     * would wobble and nothing could be reused. Both belong in the adapter, on
     * the other side of the provider boundary.
     */
    for (const path of walk(join(ROOT, 'packages/compiler/src/backbone'))) {
      if (/\.test\.ts$/.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${relative(path)} performs I/O`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${relative(path)} reads a clock`).not.toMatch(/Date\.now\(\)|new Date\(\)/);
      expect(code, `${relative(path)} uses randomness`).not.toMatch(/Math\.random\(\)/);
    }
  });

  it('does not require a shared query service on the default discovery path', () => {
    /**
     * The defect this exists to prevent, stated as a rule.
     *
     * Public Overpass is a volunteer-run, best-effort service, and depending on
     * it turned two of four live destinations into "this place is empty". It
     * remains available as a *fallback* — the live provider names it in that
     * branch — but nothing in the engine packages may reach for it, and the
     * switch that used to be required must stay optional.
     */
    for (const root of GENERIC_ROOTS) {
      for (const path of walk(join(ROOT, root))) {
        if (/\.test\.ts$/.test(path)) continue;
        const code = stripComments(readFileSync(path, 'utf8'));
        expect(code, `${relative(path)} reaches a shared query service`).not.toMatch(
          /overpass/i,
        );
      }
    }

    const live = readFileSync(join(ROOT, 'apps/web/src/lib/providers/live.ts'), 'utf8');
    // Present, so the fallback exists; and never on its own, so it is not required.
    expect(live).toMatch(/isPoiProviderEnabled/);
    expect(live).toMatch(/isPlaceBackboneEnabled\(\)\s*\|\|\s*isPoiProviderEnabled\(\)/);
  });

  it('never turns a source existence confidence into a Sidequest signal', () => {
    /**
     * A place catalogue publishes a number saying an entity probably exists. It
     * is not traveller fit, travel importance, corroboration, verification,
     * safety confidence or a ranking score, and the difference between those is
     * the whole product. So the field travels as provenance and is read nowhere
     * else.
     */
    const offenders: string[] = [];
    for (const root of ['packages/compiler/src/backbone', 'packages/core/src/quality']) {
      for (const path of walk(join(ROOT, root))) {
        if (/\.test\.ts$/.test(path)) continue;
        const code = stripComments(readFileSync(path, 'utf8'));
        // Reading it anywhere other than to write it onto a provenance row.
        const reads = code.match(/existenceConfidence/g) ?? [];
        const writes = code.match(/existenceConfidence:/g) ?? [];
        if (reads.length > writes.length) {
          offenders.push(`${relative(path)} reads a source existence confidence`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
  /**
   * THE OWNERSHIP BOUNDARY OF THE SHARED EVIDENCE STORE.
   *
   * A fact about a museum is universal; a fact about a trip is not. If a
   * traveller field ever reaches a shared cache key or a shared cached value,
   * one person's preferences become another person's evidence — which is the
   * worst bug this product could have, and the one nothing about the code's
   * shape would make obvious.
   *
   * This is a lint rather than a proof, and it is honest about that. What it
   * does catch is the exact regression: somebody adding `profile` or `tripId` to
   * a key input because it was convenient.
   */
  it('keeps travellers out of universal evidence', () => {
    const TRAVELLER_TOKENS = [
      'tripId',
      'travelerProfile',
      'travellerProfile',
      'fitScore',
      'selection',
      'itinerary',
      'budgetLevel',
      'pace',
      'interests',
      'travelDates',
    ];

    /**
     * The three files that define what a shared row *is*. A traveller field in
     * any of them would be shared by construction, whatever the callers do.
     */
    const universal = [
      'packages/core/src/schemas/evidence-store.ts',
      'packages/core/src/evidence/identity.ts',
      'apps/web/src/lib/db/evidence-repository.ts',
    ];

    const offenders: string[] = [];
    for (const file of universal) {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      for (const token of TRAVELLER_TOKENS) {
        if (new RegExp(`\\b${token}\\b`).test(code)) {
          offenders.push(`${file} names a traveller field: ${token}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never keys shared evidence on a trip', () => {
    /**
     * The database half of the same rule. Every other table in the schema is
     * trip-scoped and cascades from `trips`; the evidence tables must not be,
     * because a pack outliving its trip is the entire economic argument for
     * having them.
     */
    const schema = readFileSync(join(ROOT, 'apps/web/src/lib/db/schema.ts'), 'utf8');
    const evidenceTables = schema
      .split(/CREATE TABLE IF NOT EXISTS /)
      .filter((block) => block.startsWith('evidence_'));
    expect(evidenceTables.length).toBeGreaterThanOrEqual(6);
    for (const block of evidenceTables) {
      const name = block.slice(0, block.indexOf(' '));
      const body = block.slice(0, block.indexOf(');'));
      expect(body, `${name} is keyed on a trip`).not.toMatch(/trip_id/);
      expect(body, `${name} cascades from a trip`).not.toMatch(/REFERENCES trips/);
    }
  });

  it('never lets a cache decide what a fact is worth', () => {
    /**
     * Reuse may make a run cheap. It may not make anything more certain.
     *
     * So the layer that decides what to reuse is forbidden from naming the
     * vocabulary that decides what a fact is worth — verification states,
     * coverage levels, confidence. A cache that could write one of those could
     * quietly upgrade a stale single source into a verified fact by the act of
     * remembering it.
     */
    const code = stripComments(
      readFileSync(join(ROOT, 'packages/compiler/src/evidence-store.ts'), 'utf8'),
    );
    for (const forbidden of [
      'corroborated',
      'verified',
      'assessConfidence',
      'coverageLevel',
      'single_source',
    ]) {
      expect(code, `the evidence layer writes ${forbidden}`).not.toContain(forbidden);
    }
  });
  it('keeps travellers out of durable claims and shared answers', () => {
    /**
     * The same rule as the evidence store above, applied to the layer that now
     * carries the *facts* rather than the pages. A claim that quietly learned a
     * traveller's preferences, or a shared answer keyed by their dates, would
     * serve one person's trip as another person's evidence — and nothing about
     * the code's shape would make it obvious.
     */
    const TRAVELLER_TOKENS = [
      'tripId',
      'travelerProfile',
      'travellerProfile',
      'fitScore',
      'selection',
      'itinerary',
      'budgetLevel',
      'pace',
      'travelDates',
      'boardRank',
      'detour',
    ];

    const shared = ['packages/core/src/evidence/claims.ts', 'packages/compiler/src/claims.ts'];
    const offenders: string[] = [];
    for (const file of shared) {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      for (const token of TRAVELLER_TOKENS) {
        if (new RegExp(`\\b${token}\\b`).test(code)) {
          offenders.push(`${file} names a traveller field: ${token}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('gives a shared resolved answer no way to depend on a date', () => {
    /**
     * A structural guarantee rather than a promise. `factSetKeyFor` has no
     * parameter a date could go in, so "the shared answer was for different
     * dates" is not a bug that can be written — and the allow-list of paths that
     * may be shared is closed, so a new dated path is excluded by default rather
     * than by somebody remembering.
     */
    const code = stripComments(
      readFileSync(join(ROOT, 'packages/core/src/evidence/claims.ts'), 'utf8'),
    );
    const signature = /export interface FactSetKeyInput \{([\s\S]*?)\}/.exec(code)?.[1] ?? '';
    expect(signature).not.toMatch(/date|now|month|season|when/i);

    // The dated paths, named, so adding one to the allow-list breaks this test.
    for (const dated of ['hours.weekly', 'hours.closure', 'hours.seasonal', 'safety.caution', 'food.hours']) {
      expect(
        code.includes(`'${dated}'`),
        `${dated} must not be shareable across dates`,
      ).toBe(false);
    }
  });

  it('never lets the claim tables be keyed on a trip', () => {
    const schema = readFileSync(join(ROOT, 'apps/web/src/lib/db/schema.ts'), 'utf8');
    for (const table of ['evidence_claims', 'evidence_fact_sets']) {
      const block = schema.split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1] ?? '';
      const body = block.slice(0, block.indexOf(');'));
      expect(body, `${table} is keyed on a trip`).not.toMatch(/trip_id/);
      expect(body, `${table} cascades from a trip`).not.toMatch(/REFERENCES trips/);
    }
  });
});
