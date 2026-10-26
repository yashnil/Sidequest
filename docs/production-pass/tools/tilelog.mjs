import { chromium } from '@playwright/test';
const [url, secs = '30'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const stats = {};
const key = (u) => u.includes('elevation-tiles') ? 'dem' : u.includes('openfreemap') ? 'ofm' : null;
const starts = new Map();
p.on('request', (r) => { const k = key(r.url()); if (k) starts.set(r, Date.now()); });
p.on('requestfinished', async (r) => { const k = key(r.url()); if (!k) return; const s = (stats[k] ??= { ok: 0, fail: 0, ms: [] }); s.ok++; s.ms.push(Date.now() - starts.get(r)); });
p.on('requestfailed', (r) => { const k = key(r.url()); if (!k) return; const s = (stats[k] ??= { ok: 0, fail: 0, ms: [] }); s.fail++; });
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 200)); });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(+secs * 1000);
for (const [k, s] of Object.entries(stats)) { s.ms.sort((a, b) => a - b); console.log(k, 'ok', s.ok, 'fail', s.fail, 'p50', s.ms[s.ms.length >> 1], 'p90', s.ms[Math.floor(s.ms.length * 0.9)]); }
await b.close();
