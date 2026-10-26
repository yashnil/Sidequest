/**
 * V1 CONVERGENCE — WHAT AN OPERATOR MUST HEAR WHEN THE SERVER STARTS.
 *
 * Runs once per server instance (Next's `register` hook). Three things, all
 * cheap; only the third can stop the server from booting:
 *
 * 1. **Loud configuration problems** — fixture data switched on in production,
 *    a database that is not on an absolute path — printed from the same
 *    `deploymentProblems` the capability registry, `/api/readiness` and
 *    `npm run doctor` read. A warning, never a refusal: `next start` is also
 *    how the browser suite runs, and that server sets its own database path
 *    and opts into fixtures explicitly.
 * 2. **Warm the two probes a build reads** (`readiness/probe-cache.ts`): the
 *    local router's `/status` and the model API's free models list. A build
 *    never starts a probe itself, so without this the first build after a
 *    deploy would pay a dead router's timeout to learn what one GET knows.
 *    Production only; a switched-off capability is answered without a request.
 *
 * 3. **Required configuration on a hosting platform** (`requiredConfigProblems`)
 *    — a database off the volume, no session secret, a base URL a traveller
 *    cannot reach — refuses to start, so the platform keeps the last good deploy.
 *
 * Imports nothing at module level, so the render-purity audit (which walks
 * this file) sees no provider; the Node-only work is loaded inside the
 * Node.js runtime branch.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { deploymentProblems, requiredConfigProblems } = await import('./lib/providers/capabilities.mjs');
  try {
    for (const problem of deploymentProblems(process.env)) console.warn(`[sidequest] DEPLOYMENT PROBLEM — ${problem}`);
  } catch (error) {
    console.warn('[sidequest] could not check the deployment configuration at start', { name: error instanceof Error ? error.name : 'Error' });
  }
  /* Private alpha — on a hosting platform, missing required configuration is a refusal to start, never a warning (see `requiredConfigProblems`). */
  const required = requiredConfigProblems(process.env);
  if (required.length > 0) {
    for (const problem of required) console.error(`[sidequest] REFUSING TO START — ${problem}`);
    throw new Error(`Sidequest refused to start: ${required.length} required configuration problem(s); see the lines above.`);
  }
  if (process.env.NODE_ENV !== 'production') return;
  try {
    const { warmProbe } = await import('./lib/readiness/probe-cache');
    warmProbe('routing.local');
    warmProbe('composition');
  } catch {
    /* A probe that cannot be warmed is a probe the readiness route will run on its first request. */
  }
}

/**
 * PRODUCTION PASS — ONE STRUCTURED LINE PER SERVER ERROR.
 *
 * Next calls this for every error it captures in a render, a route handler, a
 * server action or the proxy. It writes a single JSON line (Railway indexes
 * JSON logs) with the request id the proxy minted, the edge's own id, the
 * route *pattern* (`/trips/[id]/plan`, never the concrete path with its trip
 * id or query string), the method, the context and the error's name, digest
 * and a clipped message. Never headers, cookies, bodies or the query string:
 * a log line is not a place for a session cookie or a traveller's notes.
 */
export function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: { [key: string]: string | string[] | undefined } },
  context: { routerKind: string; routePath: string; routeType: string; renderSource?: string; revalidateReason?: string },
): void {
  try {
    console.error(JSON.stringify(requestErrorRecord(error, request, context)));
  } catch {
    /* Logging must never be the second failure. */
  }
}

/** The record `onRequestError` logs. Exported for the test; pure. */
export function requestErrorRecord(
  error: unknown,
  request: { path: string; method: string; headers: { [key: string]: string | string[] | undefined } },
  context: { routerKind: string; routePath: string; routeType: string; renderSource?: string },
): Record<string, unknown> {
  const SANE = /^[A-Za-z0-9._:-]{6,80}$/;
  const header = (name: string): string | null => {
    const raw = request.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && SANE.test(value) ? value : null;
  };
  const err = error instanceof Error ? error : null;
  const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest).slice(0, 64) : null;
  /* Secrets are never in a message on purpose, but a provider's error text can echo a URL; strip anything key- or token-shaped. */
  const message = (err?.message ?? String(error))
    .replace(/(key|token|secret|authorization|password)=?[:\s]*[^\s&]+/gi, '$1=[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .slice(0, 300);
  return {
    event: 'sidequest_request_error',
    at: new Date().toISOString(),
    requestId: header('x-request-id'),
    edgeRequestId: header('x-railway-request-id'),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    ...(context.renderSource ? { renderSource: context.renderSource } : {}),
    name: err?.name ?? typeof error,
    digest,
    message,
  };
}
