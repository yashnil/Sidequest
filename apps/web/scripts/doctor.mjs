#!/usr/bin/env node
/**
 * WHAT THIS BUILD CAN ACTUALLY DO — ANSWERED BEFORE ANYBODY STARTS A TRIP.
 *
 * The founder test this exists to prevent went like this: answer a composer,
 * answer a questionnaire, wait, and only then read "compiling new destinations
 * is switched off in this build". The information was available at process
 * start and was reachable only by finishing the product.
 *
 * Three rules shape it, and all three are about trust:
 *
 * **Names, never values.** Every check below reports `set` or `not set` and the
 * variable's name. Nothing here reads a secret's contents, compares one,
 * interpolates one, or returns anything derived from one beyond whether
 * somebody set it. A diagnostic that could leak a key is a worse problem than
 * the one it solves.
 *
 * **It exits non-zero when the configured mode cannot run.** A doctor that
 * always succeeds is a log line. This one is usable in a deploy check.
 *
 * **It imports nothing from the app.** Plain Node reading `process.env`, so it
 * runs without a build, without a database and without starting a server —
 * which is the only way it can answer *before* the thing it is diagnosing.
 *
 * That last rule has a cost, and the cost came due. The predicates are
 * duplicated from `lib/providers/switches.ts`, this file's own comment claimed
 * `doctor.test.ts` asserted the two agree, and **it never did** — the test
 * pinned a hard-coded output string instead. The duplication rotted exactly as
 * predicted: transit was reported unavailable by a literal `false` while the
 * switches and the capability registry had grown the ability to enable it, so a
 * deployment with a transit-capable router was told it had none.
 *
 * The duplication stays, because the zero-import property is worth more than
 * the tidiness. What changed is that `doctor.test.ts` runs this script under a
 * matrix of environments and compares its verdict against `capabilityRegistry()`
 * evaluated in-process under the *same* environment.
 *
 * That sentence used to end "compares **every** capability verdict", and a
 * reviewer checked. `COMPARED` in `doctor.test.ts` holds four —
 * `route_transit`, `civil_time_zone`, `climate_normals`,
 * `official_web_research` — out of the six capabilities printed below. The
 * weather and imagery lines are compared against their own predicates
 * (`weatherProviderChoice()`, `imageryMode()`) in separate tests, and "Plan an
 * arbitrary destination" is compared against nothing: it is this script's own
 * `openReady` arithmetic and no second implementation checks it. A comment that
 * claims a guard which does not exist is how a reviewer concludes the code is
 * safer than it is, so it says what is true.
 *
 * **It reports what it cannot verify, as unverified.** Every check here is
 * configuration, not reachability: a build with a real-looking key and three
 * endpoints pointed at a closed port passes every line below. Saying so is the
 * difference between a diagnostic and a reassurance. The same rule now governs
 * the wording of the capability lines themselves — see "Bounded web research".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/**
 * THE ENV FILE THE APP READS, READ HERE TOO — OR THE REPORT LIES.
 *
 * `npm run doctor` runs from the repository root, and Next loads
 * `apps/web/.env.local` itself — so the doctor answered for a bare shell while
 * the app ran fully configured, and an operator comparing the two saw a
 * contradiction with no cause. The file is parsed with a plain dotenv-style
 * reader (no dependency, values never printed, real environment always wins),
 * and the report names which file it read so the basis of every verdict below
 * is stated rather than assumed.
 *
 * `--sidequest-env-file=<path>` points elsewhere; `--sidequest-env-file=none` skips loading, which
 * is what the doctor's own tests use to stay hermetic.
 */
const envFileArg = process.argv
  .find((entry) => entry.startsWith('--sidequest-env-file='))
  ?.slice('--sidequest-env-file='.length);

let envFileNote;
if (envFileArg === 'none') {
  envFileNote = 'none (skipped with --sidequest-env-file=none)';
} else {
  const path = envFileArg
    ? resolve(process.cwd(), envFileArg)
    : fileURLToPath(new URL('../.env.local', import.meta.url));
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    let applied = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // The real environment wins, exactly as dotenv behaves: a shell override
      // must override.
      if (process.env[match[1]] === undefined) {
        process.env[match[1]] = value;
        applied += 1;
      }
    }
    envFileNote = `${path} (${applied} value${applied === 1 ? '' : 's'} applied where the shell had none)`;
  } catch {
    envFileNote = `${path} (not found — shell environment only)`;
  }
}

const env = (name) => process.env[name]?.trim() ?? '';
const isSet = (name) => env(name).length > 0;
const equals = (name, value) => env(name).toLowerCase() === value;

const geocoder = equals('SIDEQUEST_GEOCODER_PROVIDER', 'nominatim');
const backbone = equals('SIDEQUEST_PLACE_BACKBONE', 'overture');
const poi = equals('SIDEQUEST_POI_PROVIDER', 'overpass');
const routes = equals('SIDEQUEST_ROUTES_PROVIDER', 'valhalla');
/**
 * WHICH OF FOUR ROUTING STATES THIS BUILD IS ACTUALLY IN.
 *
 * `routes` alone only ever answered "is the switch on" — it could not tell a
 * deployment pointed at the shared public demo instance (rate-limited,
 * unversioned, offered as a courtesy — see `valhalla.ts`'s own header) apart
 * from one pointed at an operator-controlled endpoint, and a live Iceland
 * validation measured what that gap costs in practice: individual matrix
 * requests against the public demo running 140s and 198s. Mirrors
 * `valhalla.ts`'s own `DEFAULT_ENDPOINT` by value rather than by import, for
 * the same zero-import reason every other predicate here is duplicated.
 */
const ROUTES_DEMO_ENDPOINT = 'https://valhalla1.openstreetmap.de';
const routesUrl = env('SIDEQUEST_ROUTES_URL');
const routesState = !routes
  ? 'off'
  : routesUrl === '' || routesUrl.replace(/\/+$/, '') === ROUTES_DEMO_ENDPOINT
    ? 'demo'
    : 'production';
const researchModel = isSet('ANTHROPIC_API_KEY');
const researchProvider = equals('SIDEQUEST_RESEARCH_PROVIDER', 'anthropic');
const climate = !equals('SIDEQUEST_CLIMATE_PROVIDER', 'off');
/* Mirrors `isTimeZoneResolverEnabled`: on unless explicitly switched off. */
const timeZone = !equals('SIDEQUEST_TIMEZONE_PROVIDER', 'off');
/* Mirrors `transitProviderName`: named, never merely non-empty. */
const transit = equals('SIDEQUEST_TRANSIT_PROVIDER', 'valhalla');

const openReady = geocoder && (backbone || poi) && routes && researchModel && researchProvider;

const configured = env('SIDEQUEST_COMPILER_PROVIDER').toLowerCase();
const choice =
  configured === 'fixture' || configured === 'off' || configured === 'open'
    ? configured
    : openReady
      ? 'open'
      : 'off';
const inferred = configured === '' || !['fixture', 'off', 'open'].includes(configured);

/**
 * The RESOLVED verdicts for the defaulting providers, not the raw variables.
 *
 * `(default)` was printed for weather, imagery and food alike, and it hid
 * three different answers: weather defaults *on* (open-meteo), imagery
 * follows the compiler (fixtures when the compiler is on fixtures, otherwise
 * live Wikimedia), and food follows the compiled region unless switched off.
 * An operator read three identical lines and two of them meant "this does
 * nothing". Each mirrors its own predicate: `weatherProviderChoice()`,
 * `imageryMode()`, and the `SIDEQUEST_FOOD_PROVIDER === 'off'` check in
 * `region.ts`.
 *
 * The imagery default moved once already — it was opt-in while the candidate
 * pass that consumes it did not exist, and this file went on reporting `off`
 * for two hours after that pass landed and the default flipped. That is the
 * exact failure the zero-import rule costs us and the reason `doctor.test.ts`
 * evaluates the real predicate under a matrix of environments and compares:
 * a duplicated predicate is allowed to exist here, it is not allowed to
 * disagree quietly.
 */
const weatherRaw = env('SIDEQUEST_WEATHER_PROVIDER').toLowerCase();
const weather = ['openmeteo', 'fixture', 'off'].includes(weatherRaw) ? weatherRaw : 'openmeteo';
const imageryRaw = env('SIDEQUEST_IMAGERY_PROVIDER').toLowerCase();
const imagery = ['wikimedia', 'fixture', 'off'].includes(imageryRaw)
  ? imageryRaw
  : configured === 'fixture'
    ? 'fixture'
    : 'wikimedia';
const food = process.env.SIDEQUEST_FOOD_PROVIDER === 'off' ? 'off' : 'on';

const missing = [];
if (!geocoder) missing.push('SIDEQUEST_GEOCODER_PROVIDER=nominatim');
if (!backbone && !poi) missing.push('SIDEQUEST_PLACE_BACKBONE=overture');
if (!routes) missing.push('SIDEQUEST_ROUTES_PROVIDER=valhalla');
if (!researchProvider) missing.push('SIDEQUEST_RESEARCH_PROVIDER=anthropic');
if (!researchModel) missing.push('ANTHROPIC_API_KEY');

const lines = [];
const say = (text) => lines.push(text);
const mark = (ok, label, detail) => say(`  ${ok ? '✓' : '·'} ${label}${detail ? ` — ${detail}` : ''}`);

say('');
say('Sidequest — what this build can do');
say('');
say(`Environment file: ${envFileNote}`);
say(`Compilation mode: ${choice}${inferred ? ' (inferred from the switches below)' : ' (set explicitly)'}`);
say('');

say('Adapters');
/*
 * STAGING PARITY §8 — THE FIRST LINE IS THE ONE THAT FAILED IN PRODUCTION.
 *
 * A traveller typed "Japan" on a fresh deployment and was shown the empty-world
 * map, and this report had nothing to say about it: the geocoder line below
 * describes an *adapter*, and what broke was the question "can a typed name
 * become a place at all". That question has two independent answers — the bundled
 * country reference, which is always there, and the geocoder, which is not — and
 * neither was reported. It leads now, because it is the first thing that has to
 * be true.
 */
mark(
  true,
  'Placing a typed destination',
  geocoder
    ? 'bundled country reference (offline, any country) then the geocoder for cities, regions and parks'
    : 'bundled country reference only — a country places offline; a city, region or park typed as free text is not placed until the trip is created. SIDEQUEST_GEOCODER_PROVIDER=nominatim is keyless and fixes it',
);
mark(geocoder, 'Destination geocoder', geocoder ? 'nominatim' : 'SIDEQUEST_GEOCODER_PROVIDER not set');
mark(backbone, 'Place backbone', backbone ? 'overture' : 'SIDEQUEST_PLACE_BACKBONE not set');
mark(poi, 'Place fallback', poi ? 'overpass' : 'SIDEQUEST_POI_PROVIDER not set (optional)');
mark(
  routes,
  'Travel-time routing',
  routesState === 'off'
    ? 'SIDEQUEST_ROUTES_PROVIDER not set'
    : routesState === 'demo'
      ? 'valhalla, DEVELOPMENT/DEMO endpoint — the shared public instance is rate-limited and unversioned; not suitable for production traffic (see SIDEQUEST_ROUTES_URL below)'
      : 'valhalla, production endpoint configured (SIDEQUEST_ROUTES_URL set to something other than the public demo host)',
);
/*
 * PRODUCT RECOVERY V1 — the routing hierarchy as one line: what the local
 * router covers (declared by the operator, checked before every request), and
 * whether a global router stands behind it. Google Routes stays an explicit
 * opt-in under the project's terms review and is reported by the generic
 * capability loop below, never here.
 */
{
  const coverage = process.env.SIDEQUEST_ROUTES_COVERAGE?.trim() || '';
  const orsChosen = (process.env.SIDEQUEST_ROUTES_GLOBAL_PROVIDER ?? '').trim().toLowerCase() === 'openrouteservice';
  const orsReady = orsChosen && ((process.env.OPENROUTESERVICE_API_KEY ?? '').length > 0 || (process.env.SIDEQUEST_ROUTES_FIXTURE ?? '').length > 0);
  say(
    `  · Routing hierarchy — Valhalla ${routesState === 'off' ? 'off' : `configured, coverage ${coverage || 'not declared (every leg attempted)'}`} / openrouteservice ${orsReady ? `configured${process.env.SIDEQUEST_ROUTES_FIXTURE ? ' (recorded fixture)' : ''}` : orsChosen ? 'chosen but no OPENROUTESERVICE_API_KEY' : 'off'} / Google Routes — adapter, request-time opt-in only`,
  );
}
/*
 * QUALITY V1 — two different things share one credential. Composition (the
 * one model call that writes the trip) needs only ANTHROPIC_API_KEY, or the
 * fixture composer. Research (compiling a destination for the optional
 * Discovery Board) additionally needs SIDEQUEST_RESEARCH_PROVIDER=anthropic
 * and the open map stack. The normal "Build my trip" never consults the
 * research switch.
 */
const fixtureComposer = equals('SIDEQUEST_COMPOSER_PROVIDER', 'fixture');
mark(
  fixtureComposer || researchModel,
  'Trip composition (the one model call)',
  fixtureComposer
    ? 'fixture composer — saved drafts, no model call'
    : researchModel
      ? 'anthropic, credential present — presence only; whether the provider accepts it is learned from the first live generation'
      : 'ANTHROPIC_API_KEY not set — nothing can compose a trip',
);
mark(
  researchProvider && researchModel,
  'Research model (optional, "Explore experiences first")',
  researchProvider
    ? researchModel
      ? 'anthropic, credential present — presence only; the "Last live build" section below reads the newest compile log for a recorded rejection'
      : 'anthropic selected, ANTHROPIC_API_KEY not set'
    : 'SIDEQUEST_RESEARCH_PROVIDER not set — the interview and Build my trip still work; only the Discovery Board research is off',
);
mark(climate, 'Climate archive', climate ? 'on (keyless)' : 'off');
mark(
  timeZone,
  'Civil time zone',
  timeZone
    ? 'open-meteo (keyless)'
    : 'off — every destination falls back to a solar approximation, and says so',
);
mark(
  transit,
  'Public transport routing',
  transit
    ? 'valhalla multimodal — requires an instance built with timetable data'
    : 'SIDEQUEST_TRANSIT_PROVIDER not set',
);
say(
  `  · Weather provider — ${weather}${weatherRaw ? ' (set explicitly)' : ' (default: live open-meteo, keyless)'}`,
);
say(
  `  · Imagery provider — ${imagery}${
    imageryRaw
      ? ' (set explicitly)'
      : imagery === 'fixture'
        ? ' (default: follows the fixture compiler)'
        : ' (default: live Wikimedia, keyless — licence-gated with attribution)'
  }`,
);
say(
  `  · Food provider — ${
    food === 'off'
      ? 'off — every meal becomes held time rather than somewhere named'
      : 'on (meals come from the compiled region’s food data)'
  }${isSet('SIDEQUEST_FOOD_PROVIDER') ? ' (set explicitly)' : ' (default)'}`,
);
say('');

say('Capabilities');
mark(
  fixtureComposer || researchModel,
  'Plan an arbitrary destination (Build my trip)',
  fixtureComposer
    ? 'yes — fixture composer; verification through fixture worlds or whichever open adapters are switched on'
    : researchModel
      ? `yes — one composition call, verified through ${[geocoder && 'the geocoder', routes && 'the router'].filter(Boolean).join(' and ') || 'no provider (every place stays unverified)'}`
      : 'no — no composer credential',
);
mark(
  choice === 'open' ? openReady : choice === 'fixture',
  'Explore experiences first (optional Discovery Board research)',
  choice === 'fixture'
    ? 'fixture worlds only — a typed name resolves to synthetic data'
    : choice === 'off'
      ? 'off — the interview offers no research step; regions already held still open a board'
      : openReady
        ? 'yes, through the open map stack'
        : 'off — configuration missing (see below)',
);
mark(
  transit,
  'Public transit routing',
  transit
    ? 'yes — journeys are measured against timetables, and a reply with no transit leg in it is refused rather than reported as a walk'
    : 'not available — no transit provider is configured, so scheduled modes stay unmeasured and are reported as a readiness deficit rather than substituted with walking',
);
mark(
  timeZone,
  'Real local time zone',
  timeZone
    ? 'yes — resolved from coordinates; a fixed offset is refused rather than accepted'
    : 'no — a solar approximation is used and is labelled as one',
);
/*
 * THE RUNG, NOT A TICK.
 *
 * This line read "Bounded web research — yes". It is derived from
 * `isResearchModelConfigured()`, which is a length check on `ANTHROPIC_API_KEY`
 * and nothing else — so "yes" meant "somebody set a variable". A reviewer went
 * looking for the other end of it: `sourceSearches` and `modelWebSearches` are
 * **0 across every compilation this deployment has ever recorded**, against
 * per-job limits of 15, 18 and 22. The search tier has never fired once, and an
 * operator reading a tick had no way to know.
 *
 * The mark stays `✓` because the capability registry says `available` from the
 * same predicate and the two are held to agreeing; what changes is the sentence
 * beside it, which is the part that was making a claim the mark does not.
 * §7's ladder is implemented → configured → invokable → live-smoke verified →
 * production-normal-path, and this is *configured*.
 */
mark(
  researchProvider && researchModel,
  'Bounded web research',
  researchProvider && researchModel
    ? 'credential set — configured only; nothing here observes whether the search tier has ever fired'
    : 'no — the research model is not configured',
);
mark(climate, 'Historical climate', climate ? 'yes' : 'no — switched off');
mark(
  weather !== 'fixture' && weather !== 'off',
  'Live weather',
  weather === 'fixture' ? 'fixture generator' : weather === 'off' ? 'off' : 'yes',
);
say('');

say('Endpoints');
/*
 * Named, never reached. Each of these silently defaults to a public
 * volunteer-run service, and a deployment pointed at a dead host reported itself
 * fully ready — because nothing here had ever mentioned them. Listing them does
 * not verify them, and the line below says so rather than implying otherwise.
 */
for (const [label, name] of [
  ['Geocoder', 'SIDEQUEST_GEOCODER_URL'],
  ['Place fallback', 'SIDEQUEST_POI_URL'],
  ['Place catalogue', 'SIDEQUEST_PLACE_CATALOG_URL'],
]) {
  say(`  · ${label} — ${isSet(name) ? `${name} set` : `${name} not set, using the public default`}`);
}
/*
 * Routing gets its own line rather than the generic loop above: unlike the
 * others, this deployment's own live Iceland validation measured exactly
 * what "using the public default" costs for this one endpoint — individual
 * matrix requests running 140s and 198s — so an operator reading this line
 * needs to know demo-vs-production, not just set-vs-unset.
 */
say(
  `  · Routing — ${
    routesState === 'off'
      ? 'SIDEQUEST_ROUTES_URL not applicable (SIDEQUEST_ROUTES_PROVIDER not set)'
      : routesState === 'demo'
        ? `SIDEQUEST_ROUTES_URL not set — using the public demo default (${ROUTES_DEMO_ENDPOINT}), suitable for development only`
        : `SIDEQUEST_ROUTES_URL set to a production endpoint`
  }`,
);
say('  · Not contacted. This is a configuration report, not a reachability check.');
say('');

say('Runtime');
/*
 * The timezone database this process computes offsets against.
 *
 * Every opening hour, sunrise and daylight window in the product is derived from
 * an IANA identifier through this runtime's own copy of the database, and a
 * runtime lagging the published release is wrong about a rule change that has
 * already happened — with nothing inside the process able to detect it. Node
 * 22.21 ships 2025b; releases through 2026 moved Morocco, British Columbia and
 * Alberta onto permanent standard time. Printed so the basis of a stored plan's
 * daylight numbers is knowable rather than assumed.
 */
say(`  · Node ${process.version}`);
say(`  · Time-zone database ${process.versions.tz ?? 'unknown'} (offsets are computed, never stored)`);
say('');

say('Spending guards');
mark(
  isSet('SIDEQUEST_COMPILER_MAX_AI_CALLS'),
  'Model calls per compilation',
  isSet('SIDEQUEST_COMPILER_MAX_AI_CALLS') ? 'set' : 'not set — defaults to 12',
);
/*
 * The wall clock is a spending guard too, and it was the only one missing.
 *
 * `compileDeadlineMs()` bounds how long one build may hold the open stack open;
 * a deployment that raised it without knowing has raised its worst-case bill per
 * compilation with it. Mirrors `lib/compiler/limits.ts`, like the line above
 * mirrors `modelCallCeiling()`.
 */
say(
  `  · Wall clock per compilation — SIDEQUEST_COMPILER_DEADLINE_MS ${
    isSet('SIDEQUEST_COMPILER_DEADLINE_MS') ? 'set' : 'not set, defaults to 720000 (12 minutes)'
  }`,
);
say(
  `  · Daily ceilings — SIDEQUEST_DAILY_LIVE_COMPILATIONS ${
    isSet('SIDEQUEST_DAILY_LIVE_COMPILATIONS') ? 'set' : 'not set, defaults to 60'
  }; SIDEQUEST_DAILY_MODEL_CALLS ${
    isSet('SIDEQUEST_DAILY_MODEL_CALLS') ? 'set' : 'not set, defaults to 800'
  }`,
);
/*
 * Mirrors `billableSurfaceConfigured()` in `middleware.ts`: the door is locked
 * when live benchmark spending is configured OR the compiler is on the open
 * stack — the benchmark's sidequest arm compiles real regions whenever the
 * compiler is open, whatever the benchmark mode says.
 */
{
  const liveBenchmark =
    equals('SIDEQUEST_BENCHMARK_MODE', 'live') && isSet('SIDEQUEST_BENCHMARK_BUDGET_USD');
  const billable = liveBenchmark || choice === 'open';
  mark(
    isSet('SIDEQUEST_LABS_TOKEN') || !billable,
    'Internal /labs surface',
    billable
      ? isSet('SIDEQUEST_LABS_TOKEN')
        ? `billable providers configured (${liveBenchmark ? 'live benchmark' : 'open compiler'}), token required`
        : 'BILLABLE PROVIDERS WITH NO TOKEN — /labs is refused outright until SIDEQUEST_LABS_TOKEN is set'
      : 'nothing billable is configured, surface open',
  );
}
say('');

/**
 * WHAT THE LAST LIVE BUILD SAID ABOUT THE CREDENTIAL.
 *
 * Every check above is configuration; this is the one recorded observation.
 * Twelve consecutive live builds once ran against a rejected key, every
 * research call 401'd, and nothing an operator would read said so — the
 * evidence sat verbatim in per-job log files nobody was watching. The doctor
 * cannot make a live call (it must answer without a network or a bill), but it
 * can read what the last build wrote: the transport logs `Research model
 * credentials rejected` on a 401/403, and the newest log either carries that
 * line or it does not.
 *
 * Only the newest log, deliberately: after the key is fixed, one healthy build
 * clears the warning, and a month of old 401s must not shout for ever. Reading
 * a log is not reading a secret — the transport never writes the key, and
 * nothing from the log is printed here beyond the file's name.
 *
 * `--sidequest-compile-logs=<dir>` points elsewhere; `=none` skips the read,
 * which is what keeps the doctor's own tests hermetic.
 */
const logsArg = process.argv
  .find((entry) => entry.startsWith('--sidequest-compile-logs='))
  ?.slice('--sidequest-compile-logs='.length);
if (logsArg !== 'none') {
  const logDir = logsArg
    ? resolve(process.cwd(), logsArg)
    : fileURLToPath(new URL('../data/compile-logs', import.meta.url));
  let newest = null;
  try {
    for (const name of readdirSync(logDir)) {
      if (!name.endsWith('.log')) continue;
      const mtimeMs = statSync(join(logDir, name)).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs };
    }
  } catch {
    newest = null; // No log directory: nothing has built here. Not a failure.
  }
  say('Last live build');
  if (!newest) {
    say('  · No compile logs on disk — no live build has run here, so nothing is observable yet.');
  } else {
    let rejected = false;
    try {
      const log = readFileSync(join(logDir, newest.name), 'utf8');
      rejected =
        log.includes('Research model credentials rejected') ||
        // The line the transport wrote before rejections had their own log
        // sentence — today's live logs still carry it.
        log.includes("type: 'authentication_error'") ||
        log.includes('authentication_error');
    } catch {
      // A log that cannot be read is reported as nothing rather than guessed at.
    }
    mark(
      !rejected,
      'Research credential, as the newest compile log recorded it',
      rejected
        ? `REJECTED by the provider (${newest.name}). The key is present but dead: every research call fails, builds fail as provider configuration, and nothing will improve until whoever runs this deployment replaces the key.`
        : `no rejection recorded (${newest.name}) — the last build's research calls were not refused as unauthenticated`,
    );
  }
  say('');
}

const blocked = choice === 'off' || (choice === 'open' && !openReady);
if (blocked) {
  say('Optional research ("Explore experiences first") is off on this build.');
  say('  Build my trip does not need it: a typed destination goes to the interview and composes normally.');
  if (choice === 'off') {
    say('  To enable the Discovery Board research, set SIDEQUEST_COMPILER_PROVIDER=open (or =fixture for synthetic worlds).');
  }
  if (missing.length > 0) {
    say('  Still needed for research, by name:');
    for (const name of missing) say(`    ${name}`);
  }
  say('');
}
if (!fixtureComposer && !researchModel) {
  say('This build cannot compose a trip: set ANTHROPIC_API_KEY (or SIDEQUEST_COMPOSER_PROVIDER=fixture for saved drafts).');
  say('');
}

/*
 * LIVE WORLD V1 — the capability registry, read from the same module the
 * app reads (`src/lib/providers/capabilities.mjs`). The zero-import rule
 * above still holds in spirit: that module imports nothing from the app
 * either — it is plain `process.env` reading, shared so this script and the
 * running product can never disagree about what is real and what is fixture.
 */
try {
  const { capabilityRegistry, modeLabel, modeExplanation } = await import('../src/lib/providers/capabilities.mjs');
  const registry = capabilityRegistry(process.env);
  say(`Capabilities — ${modeLabel(registry.mode)}: ${modeExplanation(registry)}`);
  const groups = [...new Set(registry.capabilities.map((c) => c.group))];
  for (const group of groups) {
    say(`  ${group}`);
    for (const c of registry.capabilities.filter((x) => x.group === group)) {
      /*
       * Three words, kept apart: "usable" means the canonical trip path reaches this capability now;
       * "adapter only" means code exists but nothing on the product path consumes it; "off" means not configured.
       */
      const state = c.adapterOnly || (c.configured && !c.consumer) ? 'ADAPTER ONLY — not usable by the canonical trip' : !c.configured ? 'off' : c.fixture ? 'usable (FIXTURE)' : 'usable';
      const cost = c.configured && !c.fixture ? ` · ${c.costClass}` : '';
      const mark = c.adapterOnly || (c.configured && !c.consumer) ? '!' : c.configured ? (c.fixture ? '~' : '✓') : '·';
      say(`    ${mark} ${c.id} — ${state}${c.provider ? ` (${c.provider})` : ''}${cost}${c.consumer ? ` → ${c.consumer}` : ''}${c.limitations?.length ? ` — ${c.limitations[0]}` : ''}`);
    }
  }
  const lodgingDiscovery = registry.byId['lodging.discovery'];
  if (lodgingDiscovery?.configured) say('  ! Hotel discovery configured; live room price/availability is NOT configured — nothing will show a rate or a room.');
  if (registry.byId['routing.drive']?.provider === 'google-routes') say('  ! Google Routes is the driving provider: see .claude-private/BLOCKER-google-terms.md on persisting durations and polylines before shipping.');
  say('');
} catch (error) {
  say(`Capabilities — could not read the registry: ${error instanceof Error ? error.message : String(error)}`);
  say('');
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(blocked ? 1 : 0);
