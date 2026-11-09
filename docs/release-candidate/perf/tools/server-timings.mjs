#!/usr/bin/env node
/**
 * SERVER TIME, COLD AND WARM, MEASURED SEPARATELY.
 *
 *   node server-timings.mjs --seed seed.json --out timings.json [--map openfreemap|off] [--db path]
 *
 * "Cold" is the first request a fresh process answers for that route; "warm" is
 * the tenth. They are different numbers with different causes (module
 * evaluation, the atlas artifact being read and decoded, SQLite opening and
 * migrating, lazily built tables), and averaging them describes neither.
 *
 * So each target gets ITS OWN process: start `serve.sh`, wait until the port
 * accepts a TCP connection — never an HTTP request, which would be the warm-up
 * this script exists to observe — then send the target ten times. The process
 * this script starts is the only one it stops.
 *
 * No browser: these are the server's own response times over loopback
 * (time to first byte and time to last byte), with the owner's cookie where
 * the page is private. Nothing here says anything about a network.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs), []),
);
const PORT = Number(process.env.PORT ?? 4420);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const seed = JSON.parse(readFileSync(args.seed, 'utf8'));
const cookie = (seed.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
const REPEATS = Number(args.repeats ?? 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function startServer() {
  if (await portOpen()) throw new Error(`Port ${PORT} is already in use; stop that server first.`);
  const started = performance.now();
  const child = spawn(join(here, 'serve.sh'), [args.map ?? 'openfreemap', ...(args.db ? [args.db] : [])], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  for (let i = 0; i < 400; i += 1) {
    if (await portOpen()) return { child, bootMs: Math.round(performance.now() - started), log: () => log };
    if (child.exitCode !== null) throw new Error(`The server exited before listening:\n${log}`);
    await sleep(25);
  }
  child.kill('SIGTERM');
  throw new Error(`The server did not listen within 10 s:\n${log}`);
}

async function stopServer(server) {
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  for (let i = 0; i < 100 && (await portOpen()); i += 1) await sleep(50);
}

function rssMb(pid) {
  try {
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024);
  } catch {
    return null;
  }
}

async function hit(target) {
  const started = performance.now();
  const response = await fetch(`${ORIGIN}${target.path}`, {
    method: target.method ?? 'GET',
    headers: { ...(target.owned && cookie ? { cookie } : {}), ...(target.headers ?? {}) },
    ...(target.body !== undefined ? { body: target.body } : {}),
    redirect: 'manual',
  });
  const ttfb = performance.now() - started;
  const body = await response.arrayBuffer();
  return { status: response.status, ttfbMs: Number(ttfb.toFixed(1)), totalMs: Number((performance.now() - started).toFixed(1)), bytes: body.byteLength };
}

const TARGETS = [
  { name: 'health', path: '/api/health' },
  { name: 'landing', path: '/' },
  { name: 'decide', path: '/decide' },
  { name: 'tripNew', path: '/trips/new' },
  ...(seed.stepReplay ? [{ name: 'interviewStep', path: seed.stepReplay.path, method: 'POST', headers: seed.stepReplay.headers, body: seed.stepReplay.body, owned: true }] : []),
  ...(seed.decisionId ? [{ name: 'shortlist', path: `/decide/${seed.decisionId}`, owned: true }] : []),
  ...(seed.tripId ? [{ name: 'trip', path: `/trips/${seed.tripId}/itinerary`, owned: true }] : []),
];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const result = { at: new Date().toISOString(), map: args.map ?? 'openfreemap', repeats: REPEATS, note: 'One fresh process per target. cold = request 1, warm = request 10; loopback, no browser.', targets: {} };
const only = args.targets ? args.targets.split(',') : null;

for (const target of TARGETS) {
  if (only && !only.includes(target.name)) continue;
  const server = await startServer();
  try {
    /* `--ready health` waits for the platform's health check before the first sample, which is when a host would route a traveller. */
    let healthMs = null;
    if (args.ready === 'health') {
      const waited = performance.now();
      for (let i = 0; i < 300; i += 1) {
        const ok = await fetch(`${ORIGIN}/api/health`).then((r) => r.ok, () => false);
        if (ok) break;
        await sleep(100);
      }
      healthMs = Math.round(performance.now() - waited);
    }
    const rssAtBoot = rssMb(server.child.pid);
    const samples = [];
    for (let i = 0; i < REPEATS; i += 1) samples.push(await hit(target));
    /* The atlas builds its lazy tables after the first request that touches it; give that a moment, then read memory. */
    await sleep(1500);
    const afterIdle = await hit(target);
    result.targets[target.name] = {
      status: samples[0].status,
      bytes: samples[0].bytes,
      bootToListenMs: server.bootMs,
      firstHealthAnswerMs: healthMs,
      coldMs: samples[0].totalMs,
      coldTtfbMs: samples[0].ttfbMs,
      secondMs: samples[1]?.totalMs ?? null,
      warmMs: samples[REPEATS - 1].totalMs,
      warmTtfbMs: samples[REPEATS - 1].ttfbMs,
      warmMedianMs: Number(median(samples.slice(Math.max(1, REPEATS - 5)).map((s) => s.totalMs)).toFixed(1)),
      afterIdleMs: afterIdle.totalMs,
      allMs: samples.map((s) => s.totalMs),
      rssAtBootMb: rssAtBoot,
      rssAfterMb: rssMb(server.child.pid),
    };
    const t = result.targets[target.name];
    console.log(`${target.name.padEnd(14)} ${String(t.status).padEnd(4)} cold ${String(t.coldMs).padStart(8)} ms   2nd ${String(t.secondMs).padStart(7)}   warm(10th) ${String(t.warmMs).padStart(7)}   rss ${t.rssAtBootMb} -> ${t.rssAfterMb} MB`);
  } finally {
    await stopServer(server);
  }
}

/* One more process, everything warmed: what the server holds in memory once it has served each kind of page. */
{
  const server = await startServer();
  try {
    const rssAtBoot = rssMb(server.child.pid);
    for (const target of TARGETS) for (let i = 0; i < REPEATS; i += 1) await hit(target);
    await sleep(3000);
    result.warmProcess = { rssAtBootMb: rssAtBoot, rssAfterAllTargetsMb: rssMb(server.child.pid) };
    console.log(`all targets warm: rss ${rssAtBoot} -> ${result.warmProcess.rssAfterAllTargetsMb} MB`);
  } finally {
    await stopServer(server);
  }
}

if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
