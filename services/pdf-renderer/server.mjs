// Sidequest PDF renderer: POST /render {url, timezone, locale} -> application/pdf.
// One long-lived headless Chromium, a fresh context per job, a small concurrency cap.
// Auth: the shared secret in `x-renderer-secret`. Only URLs on RENDERER_ALLOWED_ORIGINS are printed.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.RENDERER_SECRET || '';
const ALLOWED = (process.env.RENDERER_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(process.env.RENDERER_CONCURRENCY || 2));
const JOB_TIMEOUT_MS = Number(process.env.RENDERER_JOB_TIMEOUT_MS || 60_000);

if (!SECRET || ALLOWED.length === 0) {
  console.error('RENDERER_SECRET and RENDERER_ALLOWED_ORIGINS are required.');
  process.exit(1);
}

let browserPromise = null;
function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--disable-dev-shm-usage', '--font-render-hinting=none'] }).then((b) => {
      b.on('disconnected', () => (browserPromise = null));
      return b;
    });
  }
  return browserPromise;
}

let active = 0;
const waiting = [];
async function slot() {
  if (active < CONCURRENCY) return void (active += 1);
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  waiting.shift()?.();
}

function authorised(header) {
  const given = Buffer.from(String(header || ''));
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

async function render({ url, timezone, locale }) {
  const context = await (await browser()).newContext({
    timezoneId: validZone(timezone) ? timezone : 'UTC',
    locale: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale || '') ? locale : 'en-GB',
    viewport: { width: 1240, height: 1754 },
  });
  try {
    const page = await context.newPage();
    // Only the app's own origin (plus the photo hosts the page itself references) may be requested.
    await page.route('**/*', (route) => {
      const target = new URL(route.request().url());
      const ok = ALLOWED.includes(target.origin) || /(^|\.)wikimedia\.org$/.test(target.hostname) || target.protocol === 'data:';
      return ok ? route.continue() : route.abort();
    });
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: JOB_TIMEOUT_MS });
    if (!response || !response.ok()) throw Object.assign(new Error(`source answered ${response?.status() ?? 'nothing'}`), { status: 502 });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null))));
    });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true, timeout: JOB_TIMEOUT_MS });
  } finally {
    await context.close().catch(() => {});
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_384) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/render') return void res.writeHead(404).end();
  if (!authorised(req.headers['x-renderer-secret'])) return void res.writeHead(401).end();
  const started = Date.now();
  try {
    const job = await readJson(req);
    const target = new URL(String(job.url || ''));
    if (!ALLOWED.includes(target.origin)) throw Object.assign(new Error('origin not allowed'), { status: 400 });
    await slot();
    let pdf;
    try {
      pdf = await render({ url: target.toString(), timezone: job.timezone, locale: job.locale });
    } finally {
      release();
    }
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'cache-control': 'no-store' }).end(pdf);
    process.stdout.write(`${JSON.stringify({ event: 'rendered', path: target.pathname, ms: Date.now() - started, bytes: pdf.length })}\n`);
  } catch (error) {
    const status = error.status || 500;
    console.error(JSON.stringify({ event: 'render_failed', status, message: error.message, ms: Date.now() - started }));
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 500 ? 'render failed' : error.message);
  }
});

server.listen(PORT, () => process.stdout.write(`pdf-renderer listening on ${PORT}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    server.close();
    if (browserPromise) await (await browserPromise).close().catch(() => {});
    process.exit(0);
  });
}
