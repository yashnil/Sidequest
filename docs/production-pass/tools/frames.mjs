import { chromium } from '@playwright/test';
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await p.goto(url, { waitUntil: 'load' });
for (let i = 0; i < 16; i++) { await p.waitForTimeout(3000); await p.screenshot({ path: `${out}-${String(i).padStart(2,'0')}.png`, clip: { x: 640, y: 57, width: 800, height: 843 } }); }
await b.close();
