import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unavailableWeatherDataset, weatherDatasetSchema } from '@sidequest/core';

/**
 * RENDERING A PAGE STARTS NO EXTERNAL WORK.
 *
 * The rule, and the specific failure it prevents. `/discover` resolved its
 * region during render; resolving a region called `resolveTripWeather`; that
 * called a forecast provider. So every page load made an outbound request —
 * every refresh, every back button, every navigation in the browser suite, every
 * crawler. Three consequences, all of them visible in the product:
 *
 *   1. A provider having a bad afternoon became a *slow page*. The traveller
 *      could not read the board they already had because we were asking about
 *      the sky.
 *   2. Pressing reload spent money. Nothing in the interface suggested reload
 *      was an action with a cost, because nothing suggested it was an action.
 *   3. The numbers under a stored plan moved without anybody asking. A page
 *      rendered twice showed two different forecasts and the itinerary above
 *      them was built against neither.
 *
 * A comment saying "do not fetch during render" is worth something. Making the
 * module that *can* fetch unreachable from every render module is worth more,
 * because the next person to add a provider call will add it somewhere that
 * looks reasonable in isolation.
 *
 * ---
 *
 * WHAT THIS TEST ACTUALLY DOES.
 *
 * Two passes over the complete product render surface — every `page`, `layout`,
 * `loading`, `not-found`, `error`, `template`, `default` and `route` module
 * under `apps/web/src/app`, which covers the composer, Help Me Decide, the
 * shortlist, the comparison, progress, the provisional board, the final
 * Discovery Board, the itinerary, preparation guidance, reconciliation and image
 * rendering, because each of those is one of those modules or is imported by
 * one:
 *
 *   1. **Reachability.** The transitive local import closure of each render
 *      module must not contain any module that can call a provider.
 *   2. **First-party purity.** No module in that closure may itself open a
 *      socket — no `fetch(`, no absolute URL, no provider SDK.
 *
 * `actions.ts` modules are excluded from the traversal, deliberately and with
 * the reason written down: a server action is an *explicit operation* with its
 * own entry point, invoked because somebody pressed something. It is where the
 * refresh lives, and it is allowed to reach a provider. Excluding it is not a
 * loophole for the original bug — the original bug was in `lib/region.ts`, which
 * a page imports directly and which this test walks straight into.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..');
const APP = join(WEB_SRC, 'app');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function relative(file: string): string {
  return file.slice(WEB_SRC.length + 1);
}

/**
 * Source with its comments removed.
 *
 * The rule the other architecture tests in this repository already follow, and
 * for the same reason: a comment explaining that this file *used to* call a
 * forecast provider, and why that was wrong, is exactly the reasoning worth
 * keeping. Banning the words from prose would delete the explanation along with
 * the bug.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every Next.js module that runs as part of producing a response body.
 *
 * The metadata routes are here for a reason that is easy to miss: `sitemap.ts`,
 * `robots.ts`, `opengraph-image.tsx` and `icon.tsx` are not pages, and a reviewer
 * scanning this list for "pages" will not think of them — but Next executes every
 * one of them on the server to produce a response, and a crawler hits
 * `/sitemap.xml` and `/robots.txt` far more often than a person hits `/discover`.
 * A forecast fetch in a sitemap generator would be the original defect with a
 * higher request rate and nobody watching.
 *
 * None of them exists today. That is the point: the ban applies the moment one
 * lands, rather than being remembered by whoever adds it.
 */
const RENDER_MODULE =
  /\/(page|layout|loading|not-found|error|global-error|template|default|route|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.tsx?$/;

/**
 * Two modules that run on every request and live *outside* `app/`.
 *
 * `middleware.ts` runs before the route does, for every matched request, and
 * `instrumentation.ts` runs once at server start. Walking only `app/` meant
 * neither was ever examined — so the one module in this codebase that could make
 * an outbound call on literally every request was the one module the render-
 * purity test could not see. Neither exists yet; both are checked by path so the
 * rule is in force before the file is.
 */
const ROOT_RUNTIME_MODULES = [
  join(WEB_SRC, 'middleware.ts'),
  join(WEB_SRC, 'instrumentation.ts'),
  join(WEB_SRC, '..', 'middleware.ts'),
  join(WEB_SRC, '..', 'instrumentation.ts'),
].filter((file) => existsSync(file));

const RENDER_MODULES = [
  ...walk(APP).filter((file) => RENDER_MODULE.test(file)),
  ...ROOT_RUNTIME_MODULES,
];

/**
 * Modules that can reach the outside world. Each one is a leaf of the ban.
 *
 * Named individually rather than matched by directory, because the point is that
 * adding one is a decision. A file that appears here and does not exist yet —
 * another agent's imagery adapter, say — is simply never matched, which is the
 * correct behaviour: the ban starts applying the moment the file lands.
 */
const PROVIDER_MODULES = [
  // The open map stack: geocoder, place backbone, routing, research model.
  'lib/providers/live.ts',
  'lib/providers/anthropic.ts',
  'lib/providers/nominatim.ts',
  'lib/providers/overpass.ts',
  'lib/providers/valhalla.ts',
  'lib/providers/wikidata.ts',
  'lib/providers/google.ts',
  'lib/providers/wikimedia.ts',
  'lib/providers/overture/scan.ts',
  'lib/providers/overture/catalog.ts',
  // Forecast and climate.
  'lib/weather/openmeteo.ts',
  'lib/weather/index.ts',
  /*
   * The only module that buys weather. Banned here rather than trusted to be
   * used carefully, because it is the natural place for somebody to reach when
   * a page needs a forecast and the snapshot is empty — which is exactly the
   * bug this file exists to stop coming back in a new shape.
   * `lib/weather/snapshot-repository.ts` is deliberately *not* on this list: it
   * reads and writes rows and imports no provider, which is what makes a pure
   * render path able to show a forecast at all.
   */
  'lib/weather/refresh.ts',
  'lib/climate/openmeteo.ts',
  // Compilation: source discovery, page retrieval, extraction, enrichment.
  'lib/compiler/runner.ts',
  'lib/compiler/providers.ts',
  // The shared HTTP client every one of the above goes through.
  'lib/net/safe-fetch.ts',
  'lib/net/structured.ts',
].map((path) => join(WEB_SRC, path));

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // A package. Covered by the architecture tests in that package.

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  const source = code(file);
  while ((match = pattern.exec(source))) specs.push(match[1]!);
  return specs;
}

/**
 * A server action is an explicit operation, not a render path.
 *
 * It has its own entry point, it runs because somebody pressed something, and it
 * is where the weather refresh lives. Walking into one would ban the very thing
 * the fix depends on. What it does *not* do is give the original bug anywhere to
 * hide: that lived in `lib/region.ts`, which pages import directly.
 */
const IS_SERVER_ACTION = /\/actions\.tsx?$/;

/**
 * Every local module reachable from one render module, minus server actions.
 *
 * Traversal stops *at* a banned module rather than through it, so what comes
 * back is the root cause rather than a cascade. Walking into `live.ts` would
 * report a dozen paths that all say the same thing — that one page imports one
 * module it should not — and a failure message nobody reads is a failure message
 * that gets suppressed.
 */
function closureOf(entry: string): Map<string, string[]> {
  const paths = new Map<string, string[]>([[entry, [entry]]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const path = paths.get(file)!;
    if (PROVIDER_MODULES.includes(file)) continue;
    for (const spec of importsOf(file)) {
      const target = resolveImport(spec, file);
      if (!target || IS_SERVER_ACTION.test(target) || paths.has(target)) continue;
      paths.set(target, [...path, target]);
      stack.push(target);
    }
  }
  return paths;
}

/**
 * The same walk, but *through* server actions.
 *
 * Used only to answer "if this action were called during render, what would it
 * reach", which is the question the exclusion above quietly stopped anybody
 * asking.
 */
function closureThroughActions(entry: string): Map<string, string[]> {
  const paths = new Map<string, string[]>([[entry, [entry]]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const path = paths.get(file)!;
    if (PROVIDER_MODULES.includes(file)) continue;
    for (const spec of importsOf(file)) {
      const target = resolveImport(spec, file);
      if (!target || paths.has(target)) continue;
      paths.set(target, [...path, target]);
      stack.push(target);
    }
  }
  return paths;
}

/**
 * The named bindings a module imports from a server-action module.
 *
 * Handles the three forms that appear in this codebase: a named list, an aliased
 * named import, and a namespace import. A default import is not matched because
 * a server-action module cannot have one — `'use server'` requires every export
 * to be an async function, and Next rejects a default-exported action.
 */
function actionBindingsImportedBy(file: string): { name: string; from: string }[] {
  const source = code(file);
  const bindings: { name: string; from: string }[] = [];
  const pattern = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const clause = match[1]!;
    const spec = match[2]!;
    const target = resolveImport(spec, file);
    if (!target || !IS_SERVER_ACTION.test(target)) continue;

    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause.trim());
    if (namespace) {
      bindings.push({ name: namespace[1]!, from: target });
      continue;
    }
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (!named) continue;
    for (const entry of named[1]!.split(',')) {
      const local = entry.includes(' as ') ? entry.split(' as ')[1] : entry;
      const name = (local ?? '').replace(/\btype\b/g, '').trim();
      if (name) bindings.push({ name, from: target });
    }
  }
  return bindings;
}

/**
 * The body of a module with its import statements removed.
 *
 * So that `import { refreshWeatherAction } from './actions'` is not itself read
 * as a call to `refreshWeatherAction`.
 */
function bodyOf(file: string): string {
  return code(file).replace(/import\s+[\s\S]*?\s+from\s*['"][^'"]+['"];?/g, '');
}

/**
 * The violations that exist today, in files this slice does not own.
 *
 * Both are *reachability* rather than live calls — `providerReadiness()` and
 * `isClimateEnabled()` read environment variables and nothing else — but the
 * module they live in imports one that dials out, which is one careless edit
 * away from the original defect. Each is filed as an integration request against
 * the owning agent, and each has a one-line fix: move the env-only predicate
 * into a module of its own.
 *
 * Listed rather than tolerated. The assertion below is an exact-set comparison,
 * so a *new* impurity fails the suite even while these two remain, and removing
 * one without deleting its line here also fails. The list is designed to be
 * annoying enough to shrink.
 */
/**
 * Empty, and it stays empty.
 *
 * It was not empty when this test was written: three render paths reached a
 * provider module because they wanted to ask whether that provider was switched
 * on. Nothing was ever *called* — but "nothing is called today" is a property of
 * the current control flow rather than of the build, and it was one refactor
 * from being false.
 *
 * The fix was to make the question answerable without the import.
 * `lib/providers/switches.ts` and `lib/compiler/readiness.ts` read environment
 * variables and import nothing, and the provider modules re-export from them so
 * no existing caller changed.
 *
 * The list is kept rather than deleted because an exact-set assertion against an
 * empty array is the strongest form of this test: a new impurity fails, and so
 * does an entry added here to silence one.
 */
const KNOWN_PENDING_INTEGRATION: string[] = [];

describe('the product render surface', () => {
  it('is not empty, so a broken walk cannot pass by finding nothing', () => {
    expect(RENDER_MODULES.length).toBeGreaterThan(10);
    // The routes this slice is actually about, named so a rename is loud.
    const names = RENDER_MODULES.map(relative);
    expect(names).toContain('app/trips/[id]/discover/page.tsx');
    expect(names).toContain('app/trips/[id]/itinerary/page.tsx');
    expect(names).toContain('app/trips/[id]/provisional/page.tsx');
    expect(names).toContain('app/decide/[id]/page.tsx');
  });

  it('reaches no module that can call a provider', () => {
    const violations: string[] = [];
    for (const entry of RENDER_MODULES) {
      const closure = closureOf(entry);
      for (const banned of PROVIDER_MODULES) {
        const path = closure.get(banned);
        if (path) violations.push(path.map(relative).join(' -> '));
      }
    }
    expect([...new Set(violations)].sort()).toEqual(KNOWN_PENDING_INTEGRATION);
  });

  /**
   * THE HOLE IN THE RULE ABOVE, CLOSED.
   *
   * The traversal steps over `actions.ts`, and the reason is sound: a server
   * action is an explicit operation with its own entry point, and walking into
   * one would ban the very module the weather fix depends on. But the exclusion
   * was doing more than it claimed. `/discover/page.tsx` *value-imports* its
   * actions module — it has to, to bind a form action — so `weather/refresh.ts`
   * is genuinely in that page's server graph. Nothing calls it during render
   * today. One line would, and the suite would stay green, which is the exact
   * property this file exists to deny.
   *
   * So the rule becomes: a render module may **reference** an imported action —
   * bind it to a form, pass it to a client component, put it in a prop — and may
   * not **invoke** it in its own body. Referencing hands the operation to the
   * browser, where somebody presses it. Invoking runs it while the page is being
   * produced, which is a fetch during render wearing a server action's clothes.
   *
   * The distinction is visible in the source: `refreshWeatherFormAction.bind(...)`
   * is a method call on the binding and passes; `await refreshWeatherAction(id)`
   * is a call of the binding and fails.
   */
  it('never invokes a server action while producing a page', () => {
    const violations: string[] = [];

    for (const entry of RENDER_MODULES) {
      // Every module that runs during this render, including its local helpers,
      // but still not the actions themselves.
      for (const file of closureOf(entry).keys()) {
        /*
         * `'use client'` modules are exempt, and only they.
         *
         * Calling a server action from a client component is the *supported* way
         * to run one: the call sits in an event handler, it happens in the
         * browser after the page is on screen, and it happens because somebody
         * pressed something. That is the shape this whole file is arguing for.
         * A server component has no event handlers, so a call in one runs while
         * the response is being produced — which is the thing being banned.
         *
         * Same exemption, same boundary and same reasoning as the `fetch` rule
         * further down.
         */
        if (/^\s*['"]use client['"]/m.test(readFileSync(file, 'utf8'))) continue;

        const body = bodyOf(file);
        for (const binding of actionBindingsImportedBy(file)) {
          const invoked = new RegExp(
            `(?<![.\\w$])${binding.name}\\s*(?:\\?\\.)?\\s*\\(`,
          );
          if (!invoked.test(body)) continue;
          violations.push(
            `${relative(file)} invokes ${binding.name} from ${relative(binding.from)}`,
          );
        }
      }
    }

    expect([...new Set(violations)].sort()).toEqual([]);
  });

  /**
   * And the reason the rule above is worth having, made explicit.
   *
   * At least one action module really does reach a provider. If none did, the
   * invocation ban would be a rule about nothing, and a rule about nothing passes
   * for ever without telling anybody it stopped applying.
   */
  it('is guarding something: an action module does reach a provider', () => {
    const reaching = new Set<string>();
    for (const file of walk(APP).filter((candidate) => IS_SERVER_ACTION.test(candidate))) {
      for (const banned of PROVIDER_MODULES) {
        if (closureThroughActions(file).has(banned)) reaching.add(relative(file));
      }
    }
    expect(reaching.size).toBeGreaterThan(0);
  });

  /**
   * The specific regression, asserted by name as well as by graph.
   *
   * `lib/region.ts` is resolved by four routes. It is the single module whose
   * impurity cost the most, and naming it means a reintroduction fails with a
   * message somebody can act on rather than with a path dump.
   */
  it('resolves a region without asking anybody about the weather', () => {
    const region = code(join(WEB_SRC, 'lib/region.ts'));
    for (const banned of [/resolveTripWeather/, /weatherProviderFor/, /from '\.\/weather'/, /\bfetch\s*\(/]) {
      expect(banned.test(region), `lib/region.ts matches ${banned}`).toBe(false);
    }
    // And the positive half: it reads a stored snapshot instead.
    expect(region).toMatch(/getWeatherSnapshot/);
    expect(region).toMatch(/unavailableWeatherDataset/);
  });

  /**
   * The stored-snapshot reader is the one weather module a render path may
   * touch, so it has to be provably incapable of fetching.
   */
  it('reads the weather snapshot without a socket anywhere near it', () => {
    const repository = code(join(WEB_SRC, 'lib/weather/snapshot-repository.ts'));
    for (const banned of [/\bfetch\s*\(/, /https?:\/\//, /openmeteo/i, /\bprovider\s*\.\s*getWeather/]) {
      expect(banned.test(repository), `snapshot-repository matches ${banned}`).toBe(false);
    }
  });

  /**
   * The second pass: nothing in the closure opens a socket itself.
   *
   * Two signals, and the list is short on purpose. An earlier version also
   * banned any absolute URL and any provider's name, and both produced noise
   * rather than findings: `overture/normalize.ts` builds an OpenStreetMap
   * permalink out of an id, and `providers/names.ts` has a function called
   * `candidatesFromNominatim` that transforms a record somebody else already
   * fetched. Neither opens anything. A rule that flags pure string construction
   * teaches people to add exceptions, which is how a guard stops guarding.
   *
   * So: a call to `fetch`, and the research SDK. Everything else that dials out
   * in this app does it through the modules in `PROVIDER_MODULES`, which the
   * reachability rule above already covers.
   *
   * `'use client'` modules are exempt from the `fetch` half, and only that half.
   * A browser fetch to this app's own API route is not render-time provider
   * work — it runs after the page is on screen, from the user's machine, in
   * response to typing. `DestinationCombobox` does exactly that against
   * `/api/destinations/suggest`, which is the whole reason the local suggestion
   * index exists. The SDK ban still applies to them, because a client component
   * importing a model SDK would be shipping a credential to a browser.
   */
  it('renders nothing that opens a socket of its own', () => {
    const seen = new Set<string>();
    const violations: string[] = [];

    for (const entry of RENDER_MODULES) {
      for (const file of closureOf(entry).keys()) {
        if (seen.has(file)) continue;
        seen.add(file);
        if (PROVIDER_MODULES.includes(file)) continue; // Covered by the reachability rule.

        const raw = readFileSync(file, 'utf8');
        const isClientModule = /^\s*['"]use client['"]/m.test(raw);
        const source = code(file);

        if (!isClientModule && /\bfetch\s*\(/.test(source)) {
          violations.push(`${relative(file)} calls fetch during render`);
        }
        if (/@anthropic-ai/.test(source) || /\bnew\s+Anthropic\b/.test(source)) {
          violations.push(`${relative(file)} reaches a model SDK`);
        }
      }
    }

    expect(violations.sort()).toEqual([]);
  });
});

/**
 * A refresh is somebody pressing something, and it says what happened.
 *
 * The counterpart to the rule above: taking the fetch out of the render path is
 * only honest if there is a way to ask for it, and only complete if a failed ask
 * leaves a trace. A refresh that fails silently is a button that appears not to
 * work.
 */
describe('the weather refresh is an explicit operation', () => {
  const actions = code(join(WEB_SRC, 'app/trips/[id]/discover/actions.ts'));
  /*
   * The fetch itself lives one module down, and deliberately.
   *
   * `snapshot-repository.ts` reads and writes rows and imports no provider —
   * which is what lets `lib/region.ts`, and therefore four render paths, read a
   * snapshot with no socket anywhere in the closure. `weather/refresh.ts` is the
   * only module that buys data, and nothing that renders may import it.
   *
   * So the assertions below read both files: the action is the thing somebody
   * presses, and the refresh module is the thing that spends.
   */
  const refresh = code(join(WEB_SRC, 'lib/weather/refresh.ts'));

  it('lives in a server action rather than on a page', () => {
    expect(actions).toMatch(/'use server'/);
    expect(actions).toMatch(/export async function refreshWeatherAction/);
    expect(refresh).toMatch(/resolveTripWeather/);
  });

  it('persists every outcome, including the failure and the empty answer', () => {
    expect(refresh).toMatch(/status: 'in_progress'/);
    expect(refresh).toMatch(/'succeeded'/);
    expect(refresh).toMatch(/status: 'failed'/);
    /*
     * The third outcome, and it is not decoration.
     *
     * With the forecast provider switched off, `resolveTripWeather` throws
     * nothing — it returns a complete dataset in which every day is
     * `unavailable`. The absence of an exception was being read as success, so
     * the panel said "Weather: fetched · Fetched recently enough to rely on"
     * above a dataset containing no weather at all.
     */
    expect(refresh).toMatch(/'returned_nothing'/);
    expect(refresh).toMatch(/weatherCoverageOf/);
  });

  /**
   * The property that stops a refresh becoming a re-plan. A newer forecast is a
   * reason to look again, never a licence to edit somebody's trip while they are
   * reading it.
   */
  it('does not rewrite the itinerary or the compiled region', () => {
    for (const banned of [/saveItinerary/, /planTrip/, /saveCompiledRegion/, /compileRegion/]) {
      expect(banned.test(actions), `the refresh action matches ${banned}`).toBe(false);
      expect(banned.test(refresh), `the refresh module matches ${banned}`).toBe(false);
    }
  });

  /**
   * And the other half of the asymmetry: *planning* is allowed to buy weather.
   *
   * Taking the fetch off the render path is correct. Letting the planner inherit
   * that absence is not — it reads weather to place outdoor days, hold back a
   * daylight-only site and choose a backup, so a traveller who pressed "build my
   * trip" without noticing a fetch button would have received a weather-blind
   * itinerary with nothing on screen saying so.
   */
  it('is bought before planning, because building a plan is an explicit act', () => {
    const planning = code(join(WEB_SRC, 'app/trips/[id]/itinerary/actions.ts'));
    expect(planning).toMatch(/ensureWeatherForPlanning/);
    expect(refresh).toMatch(/export async function ensureWeatherForPlanning/);
    // And the render path still never reaches it.
    expect(code(join(WEB_SRC, 'lib/region.ts'))).not.toMatch(/weather\/refresh/);
  });
});

/**
 * A FINISHED ARTIFACT STILL RENDERS WITH EVERY PROVIDER SWITCHED OFF.
 *
 * The acceptance property, exercised at the level it actually lives: a stored
 * compiled region plus no weather snapshot plus no provider anywhere must still
 * produce a dataset every downstream surface can read. If that were not true,
 * taking the fetch out of the render path would have traded a slow page for a
 * broken one.
 *
 * The switches this stands in for, all of which can be set to `off` or left
 * unset: `SIDEQUEST_WEATHER_PROVIDER`, `SIDEQUEST_FOOD_PROVIDER`,
 * `SIDEQUEST_COMPILER_PROVIDER`, `SIDEQUEST_CLIMATE_PROVIDER`,
 * `SIDEQUEST_GEOCODER_PROVIDER`, `SIDEQUEST_PLACE_BACKBONE`,
 * `SIDEQUEST_POI_PROVIDER`, `SIDEQUEST_ROUTES_PROVIDER`,
 * `SIDEQUEST_RESEARCH_PROVIDER`, `SIDEQUEST_IMAGERY_PROVIDER`.
 *
 * Asserted here rather than in the browser because the browser suite would need
 * a live server to prove a property about a pure function, and this is the pure
 * function the render path calls when there is nothing to read.
 */
describe('with every provider switched off', () => {
  const locations = [
    {
      id: 'valley',
      label: 'Valley floor',
      coordinates: { lat: 37.6, lng: -118.9 },
      elevationMetres: 2400,
      timeZone: 'UTC',
      placeIds: ['place-a', 'place-b'],
      limitation: 'One point speaks for the whole valley.',
    },
  ];
  const dates = ['2026-08-12', '2026-08-13'];

  const dataset = unavailableWeatherDataset({
    regionId: 'region-1',
    locations,
    dates,
    now: new Date('2026-08-03T00:00:00.000Z'),
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });

  it('produces a dataset the schema accepts, with a row for every date', () => {
    expect(weatherDatasetSchema.parse(dataset)).toEqual(dataset);
    expect(dataset.days).toHaveLength(dates.length);
  });

  it('states an absence rather than inventing a fair day', () => {
    for (const day of dataset.days) {
      expect(day.kind).toBe('unavailable');
    }
    // The one property that matters most: there is no step anywhere in this
    // path where missing weather becomes good weather.
    expect(JSON.stringify(dataset)).not.toMatch(/"kind":"forecast"/);
  });

  /**
   * The sun is not a prediction and does not come from a provider, so switching
   * everything off must not take the daylight with it — a daylight-only site
   * still has to be scheduled inside the light whether or not anybody knows what
   * the sky is doing.
   */
  it('keeps the daylight', () => {
    expect(dataset.solar).toHaveLength(dates.length);
    for (const entry of dataset.solar) {
      expect(entry.sunsetMinute).toBeGreaterThan(entry.sunriseMinute);
    }
  });

  it('does not claim it looked in a cache it never had', () => {
    for (const day of dataset.days) {
      if (day.kind !== 'unavailable') continue;
      expect(day.consideredCache).toBe(false);
      expect(day.reason).toBe('not_configured');
    }
  });
});

/**
 * NO DESTINATION NAMES IN GENERIC UI.
 *
 * `/discover` carried "Snow closes most of this region for months at a time" —
 * a claim about one mountain range, on a page that now compiles anywhere on
 * earth. It read as a fact rather than as a leftover, which is what made it
 * worth a test rather than a fix.
 */
describe('the discovery board describes no particular place', () => {
  const PLACE_ASSUMPTIONS = [
    /\bsnow\b(?![a-z])/i,
    /eastern\s*sierra/i,
    /mammoth/i,
    /highway\s*395/i,
    /\bdesert\b/i,
    /\bmonsoon\b/i,
  ];

  it.each([
    'app/trips/[id]/discover/page.tsx',
    'components/ReconciliationPanel.tsx',
  ])('%s assumes nothing about the climate', (file) => {
    const source = code(join(WEB_SRC, file));
    for (const pattern of PLACE_ASSUMPTIONS) {
      expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
    }
  });
});
