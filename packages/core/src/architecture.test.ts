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

/**
 * Code that must work for any destination on earth.
 *
 * The web app is on this list, and it was not. That omission is exactly the
 * failure this file's header describes, happening one convenience at a time and
 * one layer below where anybody was looking: the shell was cleaned of the seed
 * region in Phase 11 and the *components* kept five sentences of it, including
 * the loading state every trip in the world saw — "Expanding Mammoth Lakes into
 * the Eastern Sierra" — and a hard-coded Californian time zone printing the
 * wrong hour on every itinerary outside California.
 *
 * Every one of those was user-facing. None was caught, because the suite that
 * exists to catch them was pointed at four directories and the product is in a
 * fifth.
 */
const GENERIC_ROOTS = [
  'packages/core/src',
  'packages/geo/src',
  'packages/planner/src',
  'packages/compiler/src',
];

/**
 * The product surface a traveller reads.
 *
 * Checked for the seed region separately from the engine, because the engine
 * rules below it — no network in the planner, geo imports nothing, providers
 * cannot assert confidence — are written about library code and do not describe
 * an app. What the app shares is the one rule that matters most here: **no
 * screen may name one destination.**
 */
const PRODUCT_ROOTS = ['apps/web/src/app', 'apps/web/src/components'];

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
 * The one file on the product surface allowed to reach the seed region.
 *
 * The authored region still exists and still has to be servable, so exactly one
 * bridge is permitted — and naming it here is the point: a second file reaching
 * for the fixture is a decision somebody has to come and write down rather than
 * something that happens. It imports `resolveRegion` to match a typed
 * destination against the authored region before the open-world path is taken,
 * and it may not name that region in anything a traveller reads.
 */
const SEED_BRIDGE = ['apps/web/src/app/(product)/trips/new/actions.ts'];

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

    /*
     * The readiness rule moved out of the live stack and into an import-free
     * switch module, so that a page asking "is compiling switched on" no longer
     * pulls four provider clients into its render graph. The property being
     * asserted is unchanged and so is its wording: the fallback exists, and it
     * is never the only thing that can satisfy the requirement.
     */
    const switches = readFileSync(
      join(ROOT, 'apps/web/src/lib/providers/switches.ts'),
      'utf8',
    );
    expect(switches).toMatch(/isPoiProviderEnabled/);
    expect(switches).toMatch(/isPlaceBackboneEnabled\(\)\s*\|\|\s*isPoiProviderEnabled\(\)/);
    // And the live stack still names it, so the fallback branch is really there.
    const live = readFileSync(join(ROOT, 'apps/web/src/lib/providers/live.ts'), 'utf8');
    expect(live).toMatch(/isPoiProviderEnabled/);
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

  /**
   * THE RULE ABOVE, RUN IN THE OTHER DIRECTION.
   *
   * The evidence tables must not be keyed on a trip. The tables that hold *one
   * person's words, marks and paid operations* must — and asserting only the
   * first half leaves the dangerous direction unguarded, because the failure it
   * would catch is the one that actually matters: a reading of somebody's
   * sentence, or the lease on the model call that produced it, escaping into a
   * cache another traveller reads.
   *
   * `model_operations` is the newest and the sharpest. It carries the result of a
   * paid classification of one person's free text, and it exists to stop two
   * concurrent requests both buying that call. Keyed on the operation alone, it
   * would coalesce two *different travellers* onto one answer.
   */
  it('always keys traveller-specific state on a trip, and cascades it', () => {
    const schema = readFileSync(join(ROOT, 'apps/web/src/lib/db/schema.ts'), 'utf8');
    const TRAVELLER_TABLES = [
      'interpretation_cache',
      'model_operations',
      'provisional_boards',
      'provisional_selections',
      'provisional_actions',
      'board_reconciliations',
      'board_reconciliation_history',
      'weather_snapshots',
    ];

    const offenders: string[] = [];
    for (const table of TRAVELLER_TABLES) {
      const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
      const start = schema.indexOf(marker);
      if (start === -1) {
        offenders.push(`${table} is missing from the schema`);
        continue;
      }
      const body = schema.slice(start, schema.indexOf(');', start));
      if (!/trip_id/.test(body)) offenders.push(`${table} is not keyed on a trip`);
      if (!/REFERENCES trips\(id\) ON DELETE CASCADE/.test(body)) {
        offenders.push(`${table} does not cascade from its trip`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never treats a partition cell or a bounding box as membership', () => {
    /**
     * THE DEFECT THIS FREEZES.
     *
     * A five-night New York trip drew a 168 km reach circle (driving, from
     * `RADIUS_KM_BY_MODE`), the partitioner gridded the circle's bounding box,
     * and `rowInBox` accepted every Overture row whose own box intersected it.
     * Berks County, Pennsylvania is 166.0 km from Manhattan — two kilometres
     * inside — so twenty-three of its records became the traveller's New York
     * board: an auto parts store, a township historical society, a community
     * library.
     *
     * Nothing was broken. Every layer did what it said. The failure was that no
     * layer's job was to decide *belonging*, and reach was standing in for it.
     *
     * So: exactly one module may answer that question, and a partition cell, a
     * row group, a tile, a geohash and an intersecting bounding box are all
     * statements about where we looked rather than about where something is.
     */
    const rowInBoxUsers = [
      ...walk(join(ROOT, 'apps/web/src')),
      ...walk(join(ROOT, 'packages')),
    ].filter((path) => {
      if (/scan\.ts$/.test(path)) return false; // its author
      if (/\.test\.ts$/.test(path)) return false;
      return /\browInBox\s*\(/.test(stripComments(readFileSync(path, 'utf8')));
    });
    expect(
      rowInBoxUsers.map(relative),
      'rowInBox is a pruning filter and must not be used as a membership test',
    ).toEqual([]);

    /*
     * And the positive half, restated after the pack/overlay split.
     *
     * The read path used to consult containment and drop what it refused, and
     * this assertion checked that it kept administrative records anyway. It now
     * keeps **everything**, which is the stronger property: a pack is
     * traveller-independent ground, a verdict about one traveller's destination
     * has no business deciding what is in it, and a record dropped at pack build
     * is a record nothing downstream can recover.
     *
     * So the assertion inverts. The pack read path must not reach for a
     * membership verdict at all.
     */
    const packSource = stripComments(
      readFileSync(join(ROOT, 'apps/web/src/lib/providers/overture/pack.ts'), 'utf8'),
    );
    expect(packSource, 'the pack read path decides membership').not.toMatch(
      /assessScopeMembership|decideContainment|retainsInPack|scopeContainmentContext/,
    );

    const normaliseSource = stripComments(
      readFileSync(join(ROOT, 'apps/web/src/lib/providers/overture/normalize.ts'), 'utf8'),
    );
    expect(normaliseSource, 'the normaliser decides membership').not.toMatch(
      /assessScopeMembership|decideContainment/,
    );
    /* What it must do instead: attach typed, levelled, traveller-independent evidence. */
    expect(normaliseSource, 'the normaliser attaches no geographic evidence').toMatch(
      /typedEvidenceFrom/,
    );
  });

  it('routes every candidate-producing path through the one containment gate', () => {
    /**
     * THE GATE, AS AN ARCHITECTURAL PROPERTY.
     *
     * A live New York build put twenty-three Berks County, Pennsylvania records
     * on a traveller's board. The scope was right. What was wrong is that two
     * candidate-producing paths never reached containment at all — the fallback
     * map service built candidates straight from a reach box, and
     * regional-expansion bases were geocoded by name with no scope check — and
     * a third baked a verdict into a shared cache at pack build.
     *
     * The rule: **no adapter, fallback, source family or branch may grant board
     * eligibility directly.** There is exactly one function that computes
     * eligibility, it lives in `@sidequest/core`, and everything that produces a
     * candidate resolves through the overlay that calls it.
     */
    const eligibilitySource = stripComments(
      readFileSync(join(ROOT, 'packages/core/src/schemas/containment.ts'), 'utf8'),
    );
    expect(eligibilitySource).toMatch(/export function eligibilityFor\(/);

    /*
     * One author. Anything else that constructs the four eligibility booleans
     * is a second gate, and a second gate is how the first one gets bypassed.
     */
    const authors = [...walk(join(ROOT, 'apps/web/src')), ...walk(join(ROOT, 'packages'))].filter(
      (path) => {
        if (/schemas\/containment\.ts$/.test(path)) return false; // its author
        if (/\.test\.ts$/.test(path)) return false;
        const code = stripComments(readFileSync(path, 'utf8'));
        return /finalBoardEligible\s*:/.test(code) && /plannerEligible\s*:/.test(code);
      },
    );
    expect(
      authors.map(relative),
      'eligibility is computed somewhere other than the containment contract',
    ).toEqual([]);

    /*
     * And every consumer reads it rather than re-deriving it. `buildInventory`
     * is the single door between a pack and anything a traveller sees, and it
     * builds the overlay itself when a caller does not supply one — so a caller
     * that forgets cannot skip the gate, it can only fail to tell the gate about
     * its regional expansion.
     */
    /*
     * And both factors of the conjunction reach it.
     *
     * `eligibilityFor` takes a relationship *and* a role permission, and the
     * containment layer defaults the role factor to `true` so that a caller
     * asking only "where is this" gets a usable answer. That default is a hole
     * the moment a *product* path forgets the factor: every decision then comes
     * back claiming `roleEligible: true`, and the one production reader of
     * `provisionalBoardEligible` admits on a boolean no role has ever narrowed.
     *
     * It happened. All three overlay call sites in the adapter layer omitted it,
     * and the compiler was unharmed only because `buildInventory` re-checks role
     * eligibility itself.
     */
    for (const path of walk(join(ROOT, 'apps/web/src'))) {
      if (/\.test\.ts$/.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      let index = code.indexOf('buildTripScopeOverlay({');
      while (index >= 0) {
        const call = code.slice(index, code.indexOf('});', index));
        expect(
          call,
          `${relative(path)} builds a trip-scope overlay without the role factor`,
        ).toMatch(/roleEligible/);
        index = code.indexOf('buildTripScopeOverlay({', index + 1);
      }
    }

    const inventorySource = stripComments(
      readFileSync(join(ROOT, 'packages/compiler/src/backbone/inventory.ts'), 'utf8'),
    );
    expect(inventorySource, 'the inventory does not build a trip-scope overlay').toMatch(
      /buildTripScopeOverlay\(/,
    );
    expect(inventorySource, 'the inventory does not resolve decisions through the overlay').toMatch(
      /decisionFor\(/,
    );
  });

  it('keeps operational counters out of the semantic artifact', () => {
    /**
     * The rule: a semantic artifact must not change because one run had a cache
     * hit and another had a miss, because a worker made fewer calls, because a
     * provider retried, or because one machine was slower.
     *
     * `determinism.test.ts` proves it behaviourally, over one shared evidence
     * store compiled cold and then warm. This catches the regression at its
     * source, where it is one line: the artifact literal reading the ledger
     * again.
     */
    const code = stripComments(
      readFileSync(join(ROOT, 'packages/compiler/src/compile.ts'), 'utf8'),
    );
    const start = code.indexOf('const candidate: CompiledRegion = {');
    expect(
      start,
      'the artifact literal was renamed; this test needs its new name',
    ).toBeGreaterThan(-1);
    const end = code.indexOf('createdAt: finishedAt,', start);
    expect(end, 'the artifact literal no longer ends with createdAt').toBeGreaterThan(start);
    const literal = code.slice(start, end);

    for (const forbidden of [
      'ledger.',
      'timings',
      'stageCount',
      'stageTimings',
      'budget:',
      'heldClaims',
      'claimCounters',
      'claimsHeld',
      'sharedResolutionsReused',
      'extraction.records',
      'pages,',
    ]) {
      expect(
        literal,
        `the compiled artifact reads ${forbidden}, which changes with cache warmth`,
      ).not.toContain(forbidden);
    }

    // And the runner does not put them back after the compiler has returned.
    const runner = stripComments(
      readFileSync(join(ROOT, 'apps/web/src/lib/compiler/runner.ts'), 'utf8'),
    );
    expect(runner, 'the runner folds counters onto the artifact again').not.toMatch(
      /withProviderCounters|withEvidenceCounters|withSharedEvidenceCounters/,
    );
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

/**
 * THE PRODUCT SURFACE NAMES NO DESTINATION.
 *
 * Its own suite, because the rule it enforces is the one thing the engine
 * guarantees and the app had quietly stopped honouring. Phase 11 cleaned the
 * shell — the wordmark, the footer, the landing copy — and five sentences one
 * layer down survived, including the loading state that every trip in the world
 * saw and a hard-coded Californian time zone printing the wrong hour on every
 * itinerary outside California.
 *
 * None of that was subtle. It was simply never looked at, because the suite that
 * exists to look was pointed at four package directories and the product is in a
 * fifth.
 */
describe('the product surface names no destination', () => {
  function productFiles(): string[] {
    return PRODUCT_ROOTS.flatMap((root) => walk(join(ROOT, root))).filter(
      (path) => !/\.test\.tsx?$/.test(relative(path)),
    );
  }

  it('has files to check', () => {
    expect(productFiles().length).toBeGreaterThan(15);
  });

  it('never names the seed region on a screen', () => {
    const offenders: string[] = [];
    for (const path of productFiles()) {
      const code = stripComments(readFileSync(path, 'utf8'));
      /*
       * The bridge imports the region by its exported symbol, which necessarily
       * contains its name. What it may not do is put that name in front of a
       * traveller, so the check skips the import line and nothing else — a
       * sentence naming the region anywhere in that file still fails.
       */
      const scanned = SEED_BRIDGE.includes(relative(path))
        ? code.replace(/^.*@sidequest\/core\/data.*$/gm, ' ')
        : code;
      for (const identifier of FIXTURE_IDENTIFIERS) {
        /*
         * Whole words, not substrings.
         *
         * A plain `includes` reads "Bodie" out of `weightBodies` and reports a
         * screen for naming a Californian ghost town it has never heard of. One
         * false positive is enough to teach somebody to rename an innocent
         * variable to appease the check, and the next person reads the rename as
         * evidence the rule is arbitrary. `\b` on both sides keeps the rule
         * exactly as strict about the thing it cares about — a sentence, an
         * identifier or a string that actually names the seed region still fails,
         * in any casing — while no longer catching a word that merely contains
         * one.
         */
        const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (pattern.test(scanned)) {
          offenders.push(`${relative(path)} mentions "${identifier}"`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * A component that knows an IANA zone knows which half of the world it is in.
   *
   * `America/Los_Angeles` was hard coded in the itinerary's timestamp formatter
   * and printed the wrong hour for every traveller outside California, with
   * nothing on screen looking wrong. A zone must arrive as data, from the base
   * the trip was compiled for.
   */
  it('never hard-codes a time zone', () => {
    const offenders: string[] = [];
    for (const path of productFiles()) {
      const code = stripComments(readFileSync(path, 'utf8'));
      const found = code.match(/'(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+'/g);
      if (found) offenders.push(`${relative(path)} hard-codes ${found.join(', ')}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * Nothing on the product surface renders provider-authored markup.
   *
   * There is no `dangerouslySetInnerHTML` in this repository and there must not
   * be one: Phase 12 introduces the first provider-authored *HTML* — image
   * attribution from a wiki anybody can edit — and the rule that keeps it safe
   * is that markup never crosses the adapter boundary at all.
   */
  it('never renders raw HTML', () => {
    const offenders: string[] = [];
    for (const path of productFiles()) {
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(readFileSync(path, 'utf8'))) {
        offenders.push(relative(path));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
