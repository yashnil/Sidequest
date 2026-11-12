// End-to-end tests for the renderer: the real server and real headless Chromium,
// printing a tiny page from a local origin.  node --test services/pdf-renderer/server.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'test-secret-0123456789';
let site;
let siteOrigin;
let renderer;
const RENDERER_PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${RENDERER_PORT}`;

before(async () => {
  site = createServer((req, res) => {
    if (req.url === '/guide') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Guide</title><style>@page{size:A4;margin:12mm}</style><h1>熊野古道 Kumano Kodo</h1><p>Day 1 · Hongū</p>');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteOrigin = `http://127.0.0.1:${site.address().port}`;
  renderer = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(RENDERER_PORT), RENDERER_SECRET: SECRET, RENDERER_ALLOWED_ORIGINS: siteOrigin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer did not start')), 15_000);
    renderer.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    renderer.on('exit', (code) => reject(new Error(`renderer exited ${code}`)));
  });
});

after(async () => {
  renderer?.kill('SIGTERM');
  await new Promise((resolve) => site.close(resolve));
});

const render = (body, secret = SECRET) => fetch(`${base}/render`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-renderer-secret': secret }, body: JSON.stringify(body) });

test('answers its health check', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
});

test('refuses a request without the shared secret', async () => {
  assert.equal((await render({ url: `${siteOrigin}/guide` }, 'wrong')).status, 401);
  assert.equal((await render({ url: `${siteOrigin}/guide` }, '')).status, 401);
});

test('refuses to print anything but the allowed origin', async () => {
  const response = await render({ url: 'https://example.com/' });
  assert.equal(response.status, 400);
});

test('reports a source page that does not answer, rather than printing an error page', async () => {
  const response = await render({ url: `${siteOrigin}/missing` });
  assert.equal(response.status, 502);
});

test('prints the guide to a real PDF, in the trip time zone', { timeout: 60_000 }, async () => {
  const response = await render({ url: `${siteOrigin}/guide`, timezone: 'Asia/Tokyo', locale: 'ja-JP' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 2000);
});
