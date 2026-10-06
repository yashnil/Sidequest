/**
 * V1 CONVERGENCE — WHAT AN OPERATOR MUST HEAR WHEN THE SERVER STARTS.
 *
 * Runs once per server instance (Next's `register` hook). Two things, both
 * cheap, neither able to stop the server from booting:
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
 * Imports nothing at module level, so the render-purity audit (which walks
 * this file) sees no provider; the Node-only work is loaded inside the
 * Node.js runtime branch.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { deploymentProblems } = await import('./lib/providers/capabilities.mjs');
    for (const problem of deploymentProblems(process.env)) console.warn(`[sidequest] DEPLOYMENT PROBLEM — ${problem}`);
  } catch (error) {
    console.warn('[sidequest] could not check the deployment configuration at start', { name: error instanceof Error ? error.name : 'Error' });
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
