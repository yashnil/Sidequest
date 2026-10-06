// V1 CONVERGENCE — "CONFIGURED" IS NOT "WORKING". THE PROBES THAT TELL THEM APART.
//
// `/api/readiness` reported routing "ready" for a deployment whose Valhalla was
// `http://127.0.0.1:8002` with nothing listening — because it read the
// environment and nothing else. These are the cheapest questions that can tell
// a configured capability from a working one:
//
//   routing.local   Valhalla `GET /status` (free, on the router itself)
//   composition     Anthropic `GET /v1/models` (free; validates the key; never a generation)
//   weather         Open-Meteo forecast for one point, one day (free, keyless)
//   climate         Open-Meteo archive for one point, one day (free, keyless)
//
// and deliberately NOT asked:
//
//   geocoder        public Nominatim is volunteer-run; a health poll is abuse
//   routing.global  openrouteservice has no free status call on the hosted API
//   places          every Google call is metered
//
// those report `configured_unverified`, which is a true statement.
//
// Plain ESM with no imports, like `providers/capabilities.mjs`, so the app (via
// `probe-cache.ts`) and `scripts/doctor.mjs --probe` run the same code. Every
// probe takes its `fetch` as an argument (tests inject one), has a hard timeout
// of at most three seconds, and never throws: an exception is a `failing`
// verdict with a reason. A reason is operator text — never a secret, never a
// response body.

/** @typedef {'working'|'degraded'|'configured_unverified'|'not_configured'|'failing'} ProbeState */
/** @typedef {{ state: ProbeState; reason: string; status?: number; unreachable?: boolean; authRejected?: boolean; ms?: number }} ProbeVerdict */

export const PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_VALHALLA_ENDPOINT = 'https://valhalla1.openstreetmap.de';
export const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';

const read = (env, name) => (env[name] ?? '').trim();

/**
 * Whether a URL points at this machine. A loopback router is only real if
 * something runs beside the app — which is the case the doctor used to call
 * "a production endpoint".
 * @param {string} url
 */
export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.') || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * One GET with a hard timeout. Never throws.
 * @returns {Promise<{ ok: true; status: number; ms: number } | { ok: false; error: string; timeout: boolean; ms: number }>}
 */
async function timedGet(fetchImpl, url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, PROBE_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, { ...init, method: 'GET', signal: controller.signal, cache: 'no-store' });
    /* The body is never read beyond what releases the socket. */
    try {
      await response.body?.cancel?.();
    } catch {
      /* nothing to release */
    }
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error';
    return { ok: false, error: name, timeout: name === 'AbortError' || name === 'TimeoutError', ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The local road router.
 * @param {Record<string, string|undefined>} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<ProbeVerdict>}
 */
export async function probeValhalla(env, fetchImpl = fetch) {
  if (read(env, 'SIDEQUEST_ROUTES_PROVIDER').toLowerCase() !== 'valhalla') return { state: 'not_configured', reason: 'SIDEQUEST_ROUTES_PROVIDER is not valhalla.' };
  const base = (read(env, 'SIDEQUEST_ROUTES_URL') || DEFAULT_VALHALLA_ENDPOINT).replace(/\/+$/, '');
  const where = isLoopbackUrl(base) ? 'the loopback router' : base === DEFAULT_VALHALLA_ENDPOINT ? 'the public demo router' : 'the configured router';
  const answer = await timedGet(fetchImpl, `${base}/status`);
  if (!answer.ok) {
    return {
      state: 'failing',
      unreachable: true,
      ms: answer.ms,
      reason: answer.timeout
        ? `${where} did not answer /status within ${PROBE_TIMEOUT_MS / 1000}s; every leg would be estimated or sent to the global router.`
        : `${where} could not be reached (${answer.error}); every leg would be estimated or sent to the global router.${isLoopbackUrl(base) ? ' Nothing is listening on this machine at SIDEQUEST_ROUTES_URL.' : ''}`,
    };
  }
  if (answer.status >= 500) return { state: 'failing', unreachable: true, status: answer.status, ms: answer.ms, reason: `${where} answered /status with ${answer.status}.` };
  if (answer.status >= 400) return { state: 'degraded', status: answer.status, ms: answer.ms, reason: `${where} answered /status with ${answer.status}; routing requests may still work.` };
  return { state: 'working', status: answer.status, ms: answer.ms, reason: `${where} answered /status in ${answer.ms} ms.` };
}

/**
 * The composition model. `GET /v1/models` is free and validates the key; it is
 * never a generation and never spends a token.
 * @returns {Promise<ProbeVerdict>}
 */
export async function probeAnthropic(env, fetchImpl = fetch) {
  if (read(env, 'SIDEQUEST_COMPOSER_PROVIDER').toLowerCase() === 'fixture') return { state: 'configured_unverified', reason: 'The fixture composer is on; no model is asked.' };
  const key = read(env, 'ANTHROPIC_API_KEY');
  if (!key) return { state: 'not_configured', reason: 'ANTHROPIC_API_KEY is not set: no trip can be composed.' };
  const base = (read(env, 'ANTHROPIC_BASE_URL') || DEFAULT_ANTHROPIC_BASE).replace(/\/+$/, '');
  const answer = await timedGet(fetchImpl, `${base}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
  if (!answer.ok) {
    return { state: 'failing', unreachable: true, ms: answer.ms, reason: answer.timeout ? `The model API did not answer within ${PROBE_TIMEOUT_MS / 1000}s.` : `The model API could not be reached (${answer.error}).` };
  }
  if (answer.status === 401 || answer.status === 403) return { state: 'failing', authRejected: true, status: answer.status, ms: answer.ms, reason: `The model API rejected ANTHROPIC_API_KEY (${answer.status}). Every build will fail until the key is replaced.` };
  if (answer.status === 429) return { state: 'degraded', status: answer.status, ms: answer.ms, reason: 'The model API is rate-limiting this key (429).' };
  if (answer.status >= 500) return { state: 'degraded', status: answer.status, ms: answer.ms, reason: `The model API answered ${answer.status}; builds may fail until it recovers.` };
  if (answer.status >= 400) return { state: 'degraded', status: answer.status, ms: answer.ms, reason: `The model API answered the models list with ${answer.status}.` };
  return { state: 'working', status: answer.status, ms: answer.ms, reason: `The model API accepted the key in ${answer.ms} ms.` };
}

async function probeKeyless(label, url, fetchImpl) {
  const answer = await timedGet(fetchImpl, url);
  if (!answer.ok) return { state: 'failing', unreachable: true, ms: answer.ms, reason: answer.timeout ? `${label} did not answer within ${PROBE_TIMEOUT_MS / 1000}s.` : `${label} could not be reached (${answer.error}).` };
  if (answer.status === 429) return { state: 'degraded', status: answer.status, ms: answer.ms, reason: `${label} is rate-limiting this deployment (429).` };
  if (answer.status >= 400) return { state: 'failing', status: answer.status, ms: answer.ms, reason: `${label} answered ${answer.status}.` };
  return { state: 'working', status: answer.status, ms: answer.ms, reason: `${label} answered in ${answer.ms} ms.` };
}

/** @returns {Promise<ProbeVerdict>} */
export async function probeWeather(env, fetchImpl = fetch) {
  const choice = read(env, 'SIDEQUEST_WEATHER_PROVIDER').toLowerCase() || 'openmeteo';
  if (choice === 'off') return { state: 'not_configured', reason: 'Weather is switched off.' };
  if (choice === 'fixture') return { state: 'configured_unverified', reason: 'Fixture weather; nothing is asked.' };
  return probeKeyless('Open-Meteo forecast', 'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m&forecast_days=1', fetchImpl);
}

/** @returns {Promise<ProbeVerdict>} */
export async function probeClimate(env, fetchImpl = fetch) {
  if (read(env, 'SIDEQUEST_CLIMATE_PROVIDER').toLowerCase() === 'off') return { state: 'not_configured', reason: 'Climate is switched off; far-future days show no weather.' };
  if (read(env, 'SIDEQUEST_CLIMATE_PROVIDER').toLowerCase() === 'fixture') return { state: 'configured_unverified', reason: 'Fixture climate; nothing is asked.' };
  return probeKeyless('Open-Meteo archive', 'https://archive-api.open-meteo.com/v1/archive?latitude=0&longitude=0&start_date=2024-01-01&end_date=2024-01-01&daily=temperature_2m_max', fetchImpl);
}

/** The probes that may be run, by id, with how long a verdict is believed. */
export const PROBES = {
  'routing.local': { run: probeValhalla, ttlMs: 60_000 },
  composition: { run: probeAnthropic, ttlMs: 300_000 },
  weather: { run: probeWeather, ttlMs: 300_000 },
  climate: { run: probeClimate, ttlMs: 300_000 },
};
