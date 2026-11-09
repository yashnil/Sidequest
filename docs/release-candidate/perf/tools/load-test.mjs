#!/usr/bin/env node
/**
 * A MODEST LOCAL CONCURRENCY TEST, WITH THE SERVER'S CPU AND MEMORY BESIDE IT.
 *
 *   PERF_TOOLS=<dir with node_modules/autocannon> node load-test.mjs \
 *     --seed seed.json --pid <server pid> --out load.json [--connections 30] [--duration 30]
 *
 * autocannon against the already-running fixture server: the landing page, the
 * owner's trip page and the "Help me choose" interview step, one after
 * another, each for `duration` seconds on `connections` keep-alive
 * connections. While each runs, the server process's CPU and resident memory
 * are sampled once a second with `ps`.
 *
 * WHAT THIS IS NOT. The load generator and the server share one laptop and its
 * cores; there is no network, no TLS, no proxy, one browser identity, a
 * database with a handful of rows, and fixture providers that answer
 * instantly. It finds the server's own per-request CPU cost and how the single
 * event loop behaves when requests queue. It does not predict production
 * throughput.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs), []),
);
const tools = process.env.PERF_TOOLS;
if (!tools) throw new Error('Set PERF_TOOLS to a directory where `npm i autocannon` was run.');
const autocannon = createRequire(join(tools, 'package.json'))('autocannon');

const PORT = Number(process.env.PORT ?? 4420);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const seed = JSON.parse(readFileSync(args.seed, 'utf8'));
const cookie = (seed.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
const connections = Number(args.connections ?? 30);
const duration = Number(args.duration ?? 30);
const pid = args.pid ? Number(args.pid) : null;

const TARGETS = [
  { name: 'landing', path: '/', headers: {} },
  ...(seed.tripId ? [{ name: 'trip', path: `/trips/${seed.tripId}/itinerary`, headers: { cookie } }] : []),
  ...(seed.stepReplay ? [{ name: 'interviewStep', path: seed.stepReplay.path, method: 'POST', headers: { ...seed.stepReplay.headers, cookie }, body: seed.stepReplay.body }] : []),
  ...(args.extra === 'true' ? [{ name: 'decide', path: '/decide', headers: {} }, ...(seed.decisionId ? [{ name: 'shortlist', path: `/decide/${seed.decisionId}`, headers: { cookie } }] : [])] : []),
];
const only = args.targets ? args.targets.split(',') : null;

function sample() {
  if (!pid) return null;
  try {
    const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)]).toString().trim().split(/\s+/).map(Number);
    return { cpu, rssMb: Math.round(rss / 1024) };
  } catch {
    return null;
  }
}

const result = { at: new Date().toISOString(), connections, durationSeconds: duration, note: 'Generator and server on one machine, loopback, HTTP/1.1 keep-alive, fixture providers. Not a production forecast.', targets: {} };

for (const target of TARGETS) {
  if (only && !only.includes(target.name)) continue;
  const before = sample();
  const samples = [];
  const timer = setInterval(() => {
    const s = sample();
    if (s) samples.push(s);
  }, 1000);
  const run = await autocannon({ url: `${ORIGIN}${target.path}`, method: target.method ?? 'GET', headers: target.headers, ...(target.body !== undefined ? { body: target.body } : {}), connections, duration, timeout: 30 });
  clearInterval(timer);
  const cpus = samples.map((s) => s.cpu).sort((a, b) => a - b);
  result.targets[target.name] = {
    requests: run.requests.total,
    requestsPerSecond: Number(run.requests.average.toFixed(1)),
    latencyMs: { p50: run.latency.p50, p90: run.latency.p90, p97_5: run.latency.p97_5, p99: run.latency.p99, max: run.latency.max, mean: Number(run.latency.average.toFixed(1)) },
    status: { ok2xx: run['2xx'], redirects3xx: run['3xx'], client4xx: run['4xx'], server5xx: run['5xx'] },
    errors: run.errors,
    timeouts: run.timeouts,
    megabytesPerSecond: Number((run.throughput.average / 1e6).toFixed(2)),
    serverCpuPercent: cpus.length ? { median: cpus[Math.floor(cpus.length / 2)], max: cpus[cpus.length - 1] } : null,
    serverRssMb: { before: before?.rssMb ?? null, peak: samples.length ? Math.max(...samples.map((s) => s.rssMb)) : null, after: sample()?.rssMb ?? null },
  };
  const t = result.targets[target.name];
  console.log(`${target.name.padEnd(14)} ${String(t.requestsPerSecond).padStart(8)} req/s  p50 ${t.latencyMs.p50}  p97.5 ${t.latencyMs.p97_5}  p99 ${t.latencyMs.p99}  max ${t.latencyMs.max} ms  2xx ${t.status.ok2xx}  non-2xx ${t.status.redirects3xx + t.status.client4xx + t.status.server5xx}  errors ${t.errors}  timeouts ${t.timeouts}  cpu ${t.serverCpuPercent?.median}%  rss ${t.serverRssMb.before}→${t.serverRssMb.peak} MB`);
  /* Let the event loop drain and the collector run before the next target. */
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
