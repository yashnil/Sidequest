/*
 * No `server-only` marker, deliberately: `instrumentation.ts` warms this cache
 * at server start, and the instrumentation layer is not compiled with the
 * react-server condition that makes `server-only` importable. Nothing here is
 * secret-bearing beyond what `probes.mjs` reads from the environment at call
 * time, and no client component imports it.
 */
import { PROBES, type ProbeId, type ProbeVerdict } from './probes.mjs';

/**
 * V1 CONVERGENCE — PROBE VERDICTS, CACHED IN THE PROCESS.
 *
 * A probe is cheap and free, and it is still never run on every request: each
 * verdict is believed for its TTL (`PROBES[id].ttlMs`, 60–300 s), and a probe
 * already in flight is shared by everybody who asks while it runs. The cache
 * lives on `globalThis` so a dev-server module reload does not throw away a
 * verdict and pay for it again.
 *
 * Two readers:
 *
 * - `/api/readiness` awaits `probeCapability` for every probe (each ≤ 3 s, all
 *   in parallel, mostly answered from the cache);
 * - the build reads `cachedProbe` **synchronously** and never starts one — so
 *   the routing composite can skip a router the probe already found dead
 *   instead of paying that router's timeout on the first leg, and the preflight
 *   can refuse a build whose key the vendor has already rejected. A cold cache
 *   answers "unknown", and unknown is not false.
 */

interface Entry {
  verdict: ProbeVerdict;
  at: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const store = globalThis as unknown as { sidequestProbeCache?: Map<ProbeId, Entry>; sidequestProbeInflight?: Map<ProbeId, Promise<ProbeVerdict>> };
const cache = (store.sidequestProbeCache ??= new Map());
const inflight = (store.sidequestProbeInflight ??= new Map());

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** A fresh-enough verdict, or null. Never starts anything. */
export function cachedProbe(id: ProbeId, now: number = Date.now()): ProbeVerdict | null {
  const entry = cache.get(id);
  if (!entry) return null;
  return now - entry.at <= PROBES[id].ttlMs ? entry.verdict : null;
}

/** The verdict for `id`: from the cache while it is fresh, otherwise one probe, shared by concurrent askers. */
export async function probeCapability(id: ProbeId, options: ProbeOptions = {}): Promise<ProbeVerdict> {
  const now = options.now ?? Date.now;
  const fresh = cachedProbe(id, now());
  if (fresh) return fresh;
  const running = inflight.get(id);
  if (running) return running;
  const work = (async () => {
    let verdict: ProbeVerdict;
    try {
      verdict = await PROBES[id].run(options.env ?? process.env, options.fetchImpl ?? fetch);
    } catch (error) {
      /* The probes never throw by contract; this is the belt to that brace. */
      verdict = { state: 'failing', reason: `The probe itself failed (${error instanceof Error ? error.name : 'error'}).` };
    }
    cache.set(id, { verdict, at: now() });
    return verdict;
  })();
  inflight.set(id, work);
  try {
    return await work;
  } finally {
    inflight.delete(id);
  }
}

/** Start a probe without waiting for it, unless a fresh verdict or a running probe already exists. */
export function warmProbe(id: ProbeId, options: ProbeOptions = {}): void {
  if (cachedProbe(id, (options.now ?? Date.now)()) || inflight.has(id)) return;
  void probeCapability(id, options).catch(() => undefined);
}

/**
 * Whether the local router is known dead right now — from a fresh cached
 * verdict only, and without starting anything: a build never makes a request
 * it did not ask for (a test that counts fetches, or a zero-call measurement,
 * must see exactly the build's own traffic). The cache is warmed at server
 * start (`instrumentation.ts`) and by `/api/readiness`. A cold cache answers
 * false: not knowing is not evidence that it is down.
 */
export function localRouterKnownUnreachable(now: number = Date.now()): boolean {
  const verdict = cachedProbe('routing.local', now);
  return verdict !== null && verdict.state === 'failing' && verdict.unreachable === true;
}

/** Whether the composition key is known rejected right now — cached verdict only, same rule as above. */
export function composerKnownRejected(now: number = Date.now()): boolean {
  const verdict = cachedProbe('composition', now);
  return verdict !== null && verdict.state === 'failing' && verdict.authRejected === true;
}

/** Test seam: forget every verdict. */
export function resetProbeCache(): void {
  cache.clear();
  inflight.clear();
}
