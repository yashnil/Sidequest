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
 * the tidiness. What changed is that `doctor.test.ts` now runs this script under
 * a matrix of environments and compares every capability verdict against
 * `capabilityRegistry()` evaluated in-process under the *same* environment. The
 * two are still two implementations; they can no longer disagree quietly.
 *
 * **It reports what it cannot verify, as unverified.** Every check here is
 * configuration, not reachability: a build with a real-looking key and three
 * endpoints pointed at a closed port passes every line below. Saying so is the
 * difference between a diagnostic and a reassurance.
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
/* Mirrors `isTimeZoneResolverEnabled`: on unless explicitly switched off. */
const timeZone = !equals('SIDEQUEST_TIMEZONE_PROVIDER', 'off');
/* Mirrors `transitProviderName`: named, never merely non-empty. */
const transit = equals('SIDEQUEST_TRANSIT_PROVIDER', 'valhalla');
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

say('Endpoints');
/*
 * Named, never reached. Each of these silently defaults to a public
 * volunteer-run service, and a deployment pointed at a dead host reported itself
 * fully ready — because nothing here had ever mentioned them. Listing them does
 * not verify them, and the line below says so rather than implying otherwise.
 */
for (const [label, name] of [
  ['Geocoder', 'SIDEQUEST_GEOCODER_URL'],
  ['Routing', 'SIDEQUEST_ROUTES_URL'],
  ['Place fallback', 'SIDEQUEST_POI_URL'],
  ['Place catalogue', 'SIDEQUEST_PLACE_CATALOG_URL'],
]) {
  say(`  · ${label} — ${isSet(name) ? `${name} set` : `${name} not set, using the public default`}`);
}
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
