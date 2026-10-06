import 'server-only';
import { capabilityRegistry } from '../providers/capabilities.mjs';
import { getDb } from '../db/client';
import { destinationIndexRelease, destinationIndexSize } from '../db/destination-index-repository';
import { probeCapability, type ProbeOptions } from './probe-cache';
import type { ProbeState, ProbeVerdict } from './probes.mjs';

/**
 * V1 CONVERGENCE — WHAT THIS DEPLOYMENT CAN DO, SEPARATED FROM WHAT IT IS SET UP TO DO.
 *
 * `/api/readiness` used to report a capability `ready` the moment its switch
 * was set — routing was "ready" on a deployment pointing at a localhost
 * Valhalla nothing was listening on. Every row now carries one of five states:
 *
 * - `working` — a probe asked the thing itself, within its TTL, and it answered;
 * - `degraded` — it answered, but not well (rate-limited, 5xx, a fixture in a
 *   production server that opted in to fixtures);
 * - `configured_unverified` — set up, and deliberately not asked (a metered
 *   API, a volunteer service, a fixture): a true statement, never a pass;
 * - `not_configured` — not set up; the reason names what would provide it;
 * - `failing` — set up, asked, and it did not work.
 *
 * `ready` still answers one question only: can the primary flow run — keep a
 * trip (database), compose one (composition), and not hand a traveller test
 * data (fixtures). Everything else is enrichment and never makes the
 * deployment "not ready", but a failing enrichment is now visible instead of
 * green.
 *
 * Probes are cached in-process for 60–300 s (`probe-cache.ts`) and each is
 * bounded at three seconds, so this route costs, at most, four small GETs per
 * TTL — and none of them is ever a paid call, a generation or a volunteer
 * geocoder.
 */

export interface ReadinessRow {
  capability: string;
  state: ProbeState;
  provider: string | null;
  configured: boolean;
  /** Operator words: why this state. Never a value, never a secret. */
  reason?: string;
  /**
   * PRIVATE ALPHA — the practical answer, for an operator who asks "can this
   * deployment serve a traveller right now?": `ready`, `degraded` (the trip
   * still works, with the consequence below) or `broken` (it does not).
   */
  verdict?: 'ready' | 'degraded' | 'broken';
  /** What a traveller experiences because of this row, when it is not ready. */
  consequence?: string;
}

export interface ReadinessReport {
  ready: boolean;
  mode: string;
  /** Hard configuration problems (fixture data in production, a relative database path), from the capability registry. */
  problems: string[];
  database: { class: string; indexEntries: number };
  capabilities: ReadinessRow[];
  blocking: string[];
  degraded: string[];
}

export async function readinessReport(options: ProbeOptions = {}): Promise<ReadinessReport> {
  const env = options.env ?? process.env;
  const registry = capabilityRegistry(env);
  const byId = registry.byId;
  const rows: ReadinessRow[] = [];

  // --- Probes, in parallel, from the cache when fresh ---
  const [composerProbe, routingProbe, weatherProbe, climateProbe] = await Promise.all([
    probeCapability('composition', options),
    probeCapability('routing.local', options),
    probeCapability('weather', options),
    probeCapability('climate', options),
  ]);

  // --- Database: SELECT 1, and where the file lives ---
  const configuredPath = (env.SIDEQUEST_DB_PATH ?? '').trim();
  const absolute = configuredPath.startsWith('/');
  const pathClass = configuredPath === '' ? 'default (inside the working directory)' : absolute ? 'absolute path' : 'relative to the working directory';
  let database: ReadinessRow = { capability: 'database', state: 'failing', provider: 'sqlite', configured: true, reason: 'The database could not be opened. Check that the volume is mounted and SIDEQUEST_DB_PATH points into it.' };
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    /* A write lock proves the file is writable (a read-only or full volume fails here) without writing anything. */
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    database = absolute
      ? { capability: 'database', state: 'working', provider: 'sqlite', configured: true }
      : { capability: 'database', state: 'degraded', provider: 'sqlite', configured: true, reason: 'The database is not on an absolute path, so a redeploy may discard it. Set SIDEQUEST_DB_PATH to a file on a mounted volume.' };
  } catch {
    /* already the failing row */
  }
  rows.push(database);

  // --- Fixture guard ---
  const guard = registry.fixtureGuard;
  if (guard.switches.length > 0) {
    rows.push({
      capability: 'fixtures',
      state: guard.refused ? 'failing' : guard.production ? 'degraded' : 'configured_unverified',
      provider: 'fixture',
      configured: true,
      reason: guard.refused
        ? `Fixture data in production without SIDEQUEST_FIXTURES=allow (${guard.switches.join(', ')}): builds and research are refused.`
        : `Fixture data in use (${guard.switches.join(', ')})${guard.production ? ' on a production server that opted in with SIDEQUEST_FIXTURES=allow' : ''}.`,
    });
  }

  // --- Composition ---
  const composition = byId['composition.model'];
  if (registry.composition === 'fixture') {
    rows.push({ capability: 'composition', state: guard.production ? 'degraded' : 'configured_unverified', provider: 'fixture', configured: true, reason: 'The fixture composer is on: travellers receive a saved draft. Unset SIDEQUEST_COMPOSER_PROVIDER for real trips.' });
  } else if (registry.composition === 'off') {
    rows.push({ capability: 'composition', state: guard.refused && composition?.provider === 'fixture' ? 'failing' : 'not_configured', provider: composition?.provider ?? null, configured: false, reason: composition?.limitations[0] ?? 'No ANTHROPIC_API_KEY: a trip cannot be composed.' });
  } else {
    rows.push(fromProbe('composition', composition?.provider ?? 'anthropic', composerProbe));
  }

  // --- Destination resolution and suggestions ---
  const resolution = byId['destinations.resolution'];
  rows.push({
    capability: 'destination_resolution',
    state: resolution && resolution.limitations.length === 0 ? 'configured_unverified' : 'degraded',
    provider: resolution?.provider ?? null,
    configured: true,
    reason: resolution && resolution.limitations.length > 0 ? resolution.limitations[0]! : 'The bundled country reference answers offline; the geocoder is not polled (a volunteer service).',
  });
  let indexed = false;
  try {
    indexed = Boolean(destinationIndexRelease());
  } catch {
    /* An unreadable index is the same experience as an absent one. */
  }
  rows.push(
    indexed
      ? { capability: 'destination_suggestions', state: 'working', provider: 'local-index', configured: true }
      : { capability: 'destination_suggestions', state: 'not_configured', provider: null, configured: false, reason: 'No destination index on this deployment: the field takes free text, which every step supports. Countries still place from the bundled reference.' },
  );

  // --- Routing: the local router is probed; the global one is not (no free status call on the hosted API) ---
  const drive = byId['routing.drive'];
  const localValhalla = (env.SIDEQUEST_ROUTES_PROVIDER ?? '').trim().toLowerCase() === 'valhalla';
  if (drive?.fixture) {
    rows.push({ capability: 'routing', state: 'configured_unverified', provider: drive.provider, configured: true, reason: 'Fixture routing.' });
  } else if (localValhalla) {
    rows.push(fromProbe('routing', 'valhalla', routingProbe));
  } else {
    rows.push(configuredOnly('routing', drive));
  }
  const global = byId['routing.global'];
  rows.push(global?.configured ? { capability: 'routing_global', state: 'configured_unverified', provider: global.provider, configured: true, reason: global.fixture ? 'Recorded openrouteservice responses.' : 'openrouteservice has no free status call; it is not polled.' } : configuredOnly('routing_global', global));

  // --- Weather and climate: free, keyless, probed ---
  rows.push(fromProbe('weather', byId['weather.forecast']?.provider ?? null, weatherProbe));
  rows.push(fromProbe('climate', byId['weather.climate']?.provider ?? null, climateProbe));

  // --- Enrichment that is never polled ---
  for (const [capability, id, why] of [
    ['map', 'maps.tiles', 'Tiles are fetched by the browser; the server does not poll them.'],
    ['places', 'places.identity', 'Place lookups are metered or volunteer-run; they are not polled.'],
    ['place_hours', 'places.hours', 'Metered; not polled.'],
    ['photos', 'places.photos', 'Not polled.'],
  ] as const) {
    rows.push(configuredOnly(capability, byId[id], why));
  }

  // --- Private alpha: the rows a deployment owner asked for that were missing ---
  const scanFood = (env.SIDEQUEST_POI_PROVIDER ?? '').trim().toLowerCase() === 'overpass';
  rows.push(
    scanFood
      ? { capability: 'food_grounding', state: 'configured_unverified', provider: 'overpass', configured: true, reason: (env.SIDEQUEST_POI_URL ?? '').trim() ? 'Own Overpass endpoint; not polled.' : 'Public Overpass (a volunteer service); not polled.' }
      : { capability: 'food_grounding', state: 'not_configured', provider: null, configured: false, reason: 'SIDEQUEST_POI_PROVIDER is not overpass: discovery scans name no restaurants.' },
  );
  const fx = (env.SIDEQUEST_FX_PROVIDER ?? '').trim().toLowerCase();
  rows.push(fx === 'off' ? { capability: 'fx', state: 'not_configured', provider: null, configured: false, reason: 'SIDEQUEST_FX_PROVIDER=off.' } : { capability: 'fx', state: 'configured_unverified', provider: fx === 'fixture' ? 'fixture' : 'frankfurter', configured: true, reason: 'ECB reference rates via Frankfurter, fetched when a budget needs them; not polled.' });
  const baseUrl = (env.SIDEQUEST_BASE_URL ?? '').trim();
  const baseOk = /^https:\/\//.test(baseUrl) && !/localhost|127\.0\.0\.1|\.internal\b/.test(baseUrl);
  rows.push(baseOk ? { capability: 'base_url', state: 'working', provider: null, configured: true } : { capability: 'base_url', state: baseUrl ? 'degraded' : 'not_configured', provider: null, configured: Boolean(baseUrl), reason: 'SIDEQUEST_BASE_URL is not a public https URL.' });

  // --- Accounts: configured, or not — never a half-state reported as either ---
  const halfGoogle = Boolean((env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim()) !== Boolean((env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim()) || (Boolean((env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim()) && !(env.SIDEQUEST_BASE_URL ?? '').trim());
  const auth = byId['auth.sign_in'];
  rows.push(
    halfGoogle
      ? { capability: 'auth', state: 'failing', provider: 'google', configured: false, reason: 'Google sign-in is half-configured: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and SIDEQUEST_BASE_URL must all be set, or none.' }
      : auth?.configured
        ? { capability: 'auth', state: 'configured_unverified', provider: auth.provider, configured: true, ...(auth.fixture ? { reason: 'Fixture sign-in (email only), for the browser suite.' } : {}) }
        : { capability: 'auth', state: 'not_configured', provider: null, configured: false, reason: 'No sign-in door: trips belong to the browser that made them.' },
  );

  // --- Refinement tables ---
  let refinement = false;
  try {
    refinement = Boolean(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'refinement_versions'").get());
  } catch {
    /* Already reported by the database row. */
  }
  rows.push(refinement ? { capability: 'refinement', state: 'working', provider: 'sqlite', configured: true } : { capability: 'refinement', state: 'failing', provider: null, configured: false, reason: 'The refinement tables are missing; they are created on first connection.' });

  const PRIMARY = new Set(['database', 'composition', 'fixtures']);
  const blocking = rows.filter((row) => PRIMARY.has(row.capability) && (row.state === 'failing' || row.state === 'not_configured' || (row.capability === 'database' && row.state === 'degraded')));
  const degraded = rows.filter((row) => !blocking.includes(row) && (row.state === 'degraded' || row.state === 'failing'));

  for (const row of rows) {
    const blocked = blocking.includes(row);
    const notReady = row.state === 'failing' || row.state === 'degraded' || row.state === 'not_configured';
    row.verdict = blocked ? 'broken' : notReady && CONSEQUENCE[row.capability] !== null ? 'degraded' : 'ready';
    const consequence = CONSEQUENCE[row.capability];
    if (row.verdict !== 'ready' && consequence) row.consequence = consequence;
  }

  return {
    ready: blocking.length === 0,
    mode: registry.mode,
    problems: registry.problems,
    database: { class: pathClass, indexEntries: indexed ? safeIndexSize() : 0 },
    capabilities: rows,
    blocking: blocking.map((row) => row.capability),
    degraded: degraded.map((row) => row.capability),
  };
}

/**
 * What a traveller experiences when a capability is not ready, in their terms.
 * `null`: an absent optional capability with no effect worth reporting.
 */
const CONSEQUENCE: Record<string, string | null> = {
  database: 'Trips cannot be saved or reopened.',
  fixtures: 'Travellers would receive saved sample data instead of real trips.',
  composition: 'Discovery scans and trips without a board cannot be generated.',
  destination_resolution: 'Destinations place from the bundled country reference only; towns and regions may not place.',
  destination_suggestions: null,
  routing: 'Travel times use labelled distance estimates instead of measured routes.',
  routing_global: 'Travel times outside the local router use labelled distance estimates.',
  weather: 'Days are planned without a forecast; weather is marked unavailable.',
  climate: 'Best-time advice and typical-weather notes are unavailable.',
  map: 'Maps may not draw; the itinerary itself is unaffected.',
  places: 'Proposed places are placed by the open geocoder only; some named places may not place.',
  place_hours: null,
  photos: null,
  food_grounding: 'Meals give area-level advice instead of named venues.',
  fx: 'Budgets stay in US dollars without a local-currency figure.',
  base_url: 'Share links, calendar feeds and sign-in callbacks may point somewhere a traveller cannot reach.',
  auth: 'Trips belong to the browser that made them; there is no sign-in to carry them across devices.',
  refinement: 'Ask Sidequest refinements cannot be saved.',
};

function fromProbe(capability: string, provider: string | null, verdict: ProbeVerdict): ReadinessRow {
  return { capability, state: verdict.state, provider, configured: verdict.state !== 'not_configured', reason: verdict.reason };
}

function configuredOnly(capability: string, found: { configured: boolean; provider: string | null; fixture: boolean; limitations: string[] } | undefined, why?: string): ReadinessRow {
  if (!found?.configured) return { capability, state: 'not_configured', provider: found?.provider ?? null, configured: false, ...(found?.limitations[0] ? { reason: found.limitations[0] } : {}) };
  return { capability, state: 'configured_unverified', provider: found.provider, configured: true, reason: found.fixture ? 'Fixture data.' : (why ?? 'Configured; not polled.') };
}

function safeIndexSize(): number {
  try {
    return destinationIndexSize();
  } catch {
    return 0;
  }
}
