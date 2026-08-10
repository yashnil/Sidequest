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
 * which is the only way it can answer *before* the thing it is diagnosing. The
 * predicates are deliberately duplicated from `lib/providers/switches.ts`
 * rather than imported, and `doctor.test.ts` asserts the two agree, so the
 * duplication cannot rot silently.
 */

const env = (name) => process.env[name]?.trim() ?? '';
const isSet = (name) => env(name).length > 0;
const equals = (name, value) => env(name).toLowerCase() === value;

const geocoder = equals('SIDEQUEST_GEOCODER_PROVIDER', 'nominatim');
const backbone = equals('SIDEQUEST_PLACE_BACKBONE', 'overture');
const poi = equals('SIDEQUEST_POI_PROVIDER', 'overpass');
const routes = equals('SIDEQUEST_ROUTES_PROVIDER', 'valhalla');
const researchModel = isSet('ANTHROPIC_API_KEY');
const researchProvider = equals('SIDEQUEST_RESEARCH_PROVIDER', 'anthropic');
const climate = !equals('SIDEQUEST_CLIMATE_PROVIDER', 'off');
const weather = env('SIDEQUEST_WEATHER_PROVIDER') || '(default)';
const imagery = env('SIDEQUEST_IMAGERY_PROVIDER') || '(default)';
const food = env('SIDEQUEST_FOOD_PROVIDER') || '(default)';

const openReady = geocoder && (backbone || poi) && routes && researchModel && researchProvider;

const configured = env('SIDEQUEST_COMPILER_PROVIDER').toLowerCase();
const choice =
  configured === 'fixture' || configured === 'off' || configured === 'open'
    ? configured
    : openReady
      ? 'open'
      : 'off';
const inferred = configured === '' || !['fixture', 'off', 'open'].includes(configured);

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
say(`Compilation mode: ${choice}${inferred ? ' (inferred from the switches below)' : ' (set explicitly)'}`);
say('');

say('Adapters');
mark(geocoder, 'Destination geocoder', geocoder ? 'nominatim' : 'SIDEQUEST_GEOCODER_PROVIDER not set');
mark(backbone, 'Place backbone', backbone ? 'overture' : 'SIDEQUEST_PLACE_BACKBONE not set');
mark(poi, 'Place fallback', poi ? 'overpass' : 'SIDEQUEST_POI_PROVIDER not set (optional)');
mark(routes, 'Travel-time routing', routes ? 'valhalla' : 'SIDEQUEST_ROUTES_PROVIDER not set');
mark(
  researchProvider && researchModel,
  'Research model',
  researchProvider
    ? researchModel
      ? 'anthropic, credential set'
      : 'anthropic selected, ANTHROPIC_API_KEY not set'
    : 'SIDEQUEST_RESEARCH_PROVIDER not set',
);
mark(climate, 'Climate archive', climate ? 'on (keyless)' : 'off');
say(`  · Weather provider — ${weather}`);
say(`  · Imagery provider — ${imagery}`);
say(`  · Food provider — ${food}`);
say('');

say('Capabilities');
mark(
  choice === 'open' ? openReady : choice === 'fixture',
  'Plan an arbitrary destination',
  choice === 'fixture'
    ? 'fixture worlds only — a typed name resolves to synthetic data'
    : choice === 'off'
      ? 'no — only regions already held can be planned'
      : openReady
        ? 'yes, through the open map stack'
        : 'no — configuration missing (see below)',
);
mark(
  false,
  'Public transit routing',
  'not available — no transit provider is configured, so scheduled modes stay unmeasured and are reported as a readiness deficit rather than substituted with walking',
);
mark(
  researchProvider && researchModel,
  'Bounded web research',
  researchProvider && researchModel ? 'yes' : 'no — the research model is not configured',
);
mark(climate, 'Historical climate', climate ? 'yes' : 'no — switched off');
mark(
  weather !== 'fixture' && weather !== 'off',
  'Live weather',
  weather === 'fixture' ? 'fixture generator' : weather === 'off' ? 'off' : 'yes',
);
say('');

say('Spending guards');
mark(
  isSet('SIDEQUEST_COMPILER_MAX_AI_CALLS'),
  'Model calls per compilation',
  isSet('SIDEQUEST_COMPILER_MAX_AI_CALLS') ? 'set' : 'not set — defaults to 12',
);
mark(
  isSet('SIDEQUEST_LABS_TOKEN') || !equals('SIDEQUEST_BENCHMARK_MODE', 'live'),
  'Internal /labs surface',
  equals('SIDEQUEST_BENCHMARK_MODE', 'live')
    ? isSet('SIDEQUEST_LABS_TOKEN')
      ? 'live mode, token required'
      : 'LIVE MODE WITH NO TOKEN — anybody who finds the URL can spend money'
    : 'fixture mode, nothing billable',
);
say('');

const blocked = choice === 'off' || (choice === 'open' && !openReady);
if (blocked) {
  say('This build cannot research a new destination.');
  if (choice === 'off') {
    say('  Set SIDEQUEST_COMPILER_PROVIDER=open (or =fixture for synthetic worlds).');
  }
  if (missing.length > 0) {
    say('  Still needed, by name:');
    for (const name of missing) say(`    ${name}`);
  }
  say('');
  say('  A traveller reaching the plan screen on this build is told so up front,');
  say('  and offered a destination this deployment can plan instead.');
  say('');
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(blocked ? 1 : 0);
