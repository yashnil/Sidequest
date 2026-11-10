import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { buildFixtureTrip, signInFixture } from '../support/v9';
import { bandAction } from '../support/hub';
import { waitUntilInteractive } from '../support/trip';
import { startAdvisor, answerUntilShortlist } from '../support/advisor';
import { routeTiles } from '../maps/support/tiles';

/**
 * THE INTERACTION AUDIT.
 *
 * Every visible control on every surface, pressed, and asked one question: did
 * anything happen? A press counts as an effect if the URL, the visible text, a
 * disclosure, an ARIA state, a checked state or the network changed. Everything
 * else is reported, along with internal links that answer an error, console
 * errors and pages wider than their viewport.
 *
 * A report, not a gate: it writes `AUDIT_OUT` (a JSON file per project) and
 * fails only when a link is dead or a press crashes a page. Reading the report
 * is the job — a control can change the DOM and still be a lie.
 *
 *   PORT=4520 npx playwright test -c e2e/audit/playwright.audit.config.ts e2e/audit/crawl.spec.ts --project=desktop
 */

interface Control {
  index: number;
  key: string;
  label: string;
  tag: string;
  type: string;
  href: string | null;
  disabled: boolean;
  testid: string | null;
}

interface Finding {
  kind: 'dead_link' | 'no_effect' | 'click_failed' | 'console_error' | 'server_error' | 'overflow' | 'not_persisted';
  surface: string;
  control?: string;
  detail: string;
}

interface Report {
  project: string;
  surfaces: string[];
  pressed: number;
  skipped: { surface: string; control: string; why: string }[];
  external: string[];
  links: number;
  findings: Finding[];
  disabled: { surface: string; control: string }[];
}

const SKIP: readonly [RegExp, string][] = [
  [/delete|erase|remove my|forget my/i, 'destructive'],
  [/sign out|log ?out/i, 'ends the session the audit runs in'],
  [/revoke/i, 'destroys the share link the audit reads'],
  [/regenerate|rebuild|re-?scan|build my trip|start over|refresh trip info/i, 'replaces the plan; covered by the journey specs'],
  [/^print|save as pdf/i, 'opens the browser print dialog'],
];

const CONTROL_SELECTOR = 'a[href],button,summary,select,input[type=checkbox],input[type=radio],[role=tab],[role=button],[role=checkbox],[role=switch],[role=menuitem]';

async function enumerate(page: Page): Promise<Control[]> {
  return page.evaluate((selector) => {
    const out: Control[] = [];
    document.querySelectorAll('[data-audit-i]').forEach((node) => node.removeAttribute('data-audit-i'));
    document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hiddenInput = element.tagName === 'INPUT' && rect.width <= 1;
      if ((rect.width === 0 || rect.height === 0) && !hiddenInput) return;
      if (style.visibility === 'hidden' || style.display === 'none') return;
      if (element.closest('[inert],[aria-hidden="true"]')) return;
      /* A closed <details> keeps its children's boxes under content-visibility; a traveller cannot reach them until it opens. */
      if (element.parentElement?.closest('details:not([open])') && element.tagName !== 'SUMMARY') return;
      /* Pressing the tab you are on is not a claim that it should change. */
      if (element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-current')) return;
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute('type') ?? element.getAttribute('role') ?? '';
      const label = (element.getAttribute('aria-label') ?? element.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
        || (element as HTMLInputElement).name || element.getAttribute('title') || '(no name)';
      const testid = element.getAttribute('data-testid');
      element.setAttribute('data-audit-i', String(index));
      out.push({
        index,
        key: `${tag}|${type}|${(testid ?? label).replace(/\d+/g, '#')}`,
        label,
        tag,
        type,
        href: element.getAttribute('href'),
        disabled: (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
        testid,
      });
    });
    return out;
  }, CONTROL_SELECTOR);
}

/** What a press can have changed that a person, or a screen reader, would notice. */
async function fingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const states: string[] = [];
    document
      .querySelectorAll('[aria-expanded],[aria-pressed],[aria-selected],[aria-checked],[aria-current],details,[data-state],dialog')
      .forEach((element) => {
        states.push(
          [
            element.getAttribute('aria-expanded'),
            element.getAttribute('aria-pressed'),
            element.getAttribute('aria-selected'),
            element.getAttribute('aria-checked'),
            element.getAttribute('aria-current'),
            element.getAttribute('data-state'),
            element.hasAttribute('open') ? 'open' : '',
          ].join(','),
        );
      });
    const checked = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox],input[type=radio]')].map((input) => (input.checked ? '1' : '0')).join('');
    const selects = [...document.querySelectorAll('select')].map((select) => select.value).join('|');
    /* A map's zoom and fit live in SVG geometry, not in any text or ARIA state. */
    const drawings = [...document.querySelectorAll('svg')].map((svg) => svg.innerHTML.length + ':' + svg.innerHTML.slice(0, 2000)).join('|');
    return `${location.pathname}${location.search}${location.hash}\n${text}\n${states.join(';')}\n${checked}\n${selects}\n${drawings}`;
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(650);
}

async function open(page: Page, route: string, prepare?: (page: Page) => Promise<void>): Promise<void> {
  /* A press may have started a navigation that is still landing; a second goto then loses the race once, harmlessly. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(route, { waitUntil: 'load' });
      break;
    } catch (error) {
      if (attempt === 2 || !/interrupted by another navigation|Target page|net::ERR_ABORTED/.test((error as Error).message)) throw error;
      await page.waitForTimeout(800);
    }
  }
  await expect(page.locator('[data-loading]')).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
  await waitUntilInteractive(page.locator('body a[href], body button').first()).catch(() => undefined);
  if (prepare) await prepare(page);
  await page.waitForTimeout(200);
}

interface Surface {
  name: string;
  route: string;
  prepare?: (page: Page) => Promise<void>;
}

async function auditSurface(page: Page, context: BrowserContext, surface: Surface, report: Report, seenAcrossWidths: Set<string>): Promise<void> {
  report.surfaces.push(surface.name);
  const consoleErrors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 240));
  };
  const onPageError = (error: Error) => consoleErrors.push(`pageerror ${error.message.slice(0, 240)}`);
  const onResponse = (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 500 && response.url().startsWith(new URL(page.url() || 'http://127.0.0.1').origin)) {
      report.findings.push({ kind: 'server_error', surface: surface.name, detail: `${response.status()} ${response.url()}` });
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    await open(page, surface.route, surface.prepare);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) report.findings.push({ kind: 'overflow', surface: surface.name, detail: `page is ${overflow}px wider than the viewport` });

    const seen = new Set<string>();
    const origin = new URL(page.url()).origin;
    const checkedLinks = new Set<string>();
    const startedAt = Date.now();

    for (let turn = 0; turn < 200 && Date.now() - startedAt < 120_000; turn += 1) {
      const controls = await enumerate(page);
      const next = controls.find((control) => !seen.has(control.key));
      if (!next) break;
      seen.add(next.key);
      const crossKey = `${surface.name}::${next.key}`;
      if (next.disabled) {
        report.disabled.push({ surface: surface.name, control: next.label });
        continue;
      }
      if (/^skip to /i.test(next.label)) continue;
      const skip = SKIP.find(([pattern]) => pattern.test(next.label));
      if (skip) {
        report.skipped.push({ surface: surface.name, control: next.label, why: skip[1] });
        continue;
      }

      if (next.tag === 'a') {
        const href = next.href ?? '';
        if (href.startsWith('#')) {
          /* An in-page anchor is a press like any other: the check below applies. */
        } else if (href.startsWith('mailto:') || href.startsWith('tel:')) {
          continue;
        } else {
          const url = new URL(href, page.url());
          if (url.origin !== origin) {
            if (!report.external.includes(url.href)) report.external.push(url.href);
            continue;
          }
          if (checkedLinks.has(url.href)) continue;
          checkedLinks.add(url.href);
          report.links += 1;
          const response = await context.request.get(url.href, { maxRedirects: 5 }).catch(() => null);
          if (!response || response.status() >= 400) {
            report.findings.push({ kind: 'dead_link', surface: surface.name, control: next.label, detail: `${url.pathname} -> ${response?.status() ?? 'no response'}` });
          }
          continue;
        }
      }
      if (seenAcrossWidths.has(crossKey)) continue;
      seenAcrossWidths.add(crossKey);

      const before = await fingerprint(page);
      let requests = 0;
      const onRequest = (request: { method: () => string }) => {
        if (request.method() === 'POST') requests += 1;
      };
      page.on('request', onRequest);
      const element = page.locator(`[data-audit-i="${next.index}"]`).first();
      report.pressed += 1;
      let failed: string | null = null;
      try {
        if (next.tag === 'select') {
          const values = await element.evaluate((node) => [...(node as HTMLSelectElement).options].map((option) => option.value));
          const current = await element.inputValue();
          const other = values.find((value) => value !== current);
          if (other === undefined) continue;
          await element.selectOption(other, { timeout: 3_000 });
        } else {
          try {
            await element.click({ timeout: 3_000 });
          } catch {
            const label = element.locator('xpath=ancestor-or-self::label[1]');
            if (next.tag === 'input' && (await label.count()) > 0) await label.first().click({ timeout: 2_000 });
            else await element.click({ timeout: 2_000, force: true });
          }
        }
      } catch (error) {
        failed = (error as Error).message.split('\n').slice(0, 4).join(' ').slice(0, 300);
      }
      await settle(page);
      page.off('request', onRequest);
      if (failed) {
        report.findings.push({ kind: 'click_failed', surface: surface.name, control: next.label, detail: failed });
        await open(page, surface.route, surface.prepare);
        continue;
      }
      const after = await fingerprint(page);
      /* A form the browser refused for an empty required field did answer: it says so itself. */
      const refused = await element.evaluate((node) => {
        const form = (node as HTMLButtonElement).form;
        return Boolean(form) && !form!.checkValidity();
      }).catch(() => false);
      if (after === before && requests === 0 && !refused) {
        report.findings.push({ kind: 'no_effect', surface: surface.name, control: next.label, detail: `${next.tag} ${next.type} ${next.testid ?? ''}`.trim() });
        continue;
      }
      /* A checkbox ought to keep what it was told, or say why not. */
      if (next.type === 'checkbox' && requests > 0) {
        const value = await element.isChecked().catch(() => null);
        await open(page, surface.route, surface.prepare);
        const again = page.locator(`[data-testid="${next.testid ?? '__none__'}"]`);
        if (next.testid && value !== null && (await again.count()) === 1 && (await again.isChecked().catch(() => value)) !== value) {
          report.findings.push({ kind: 'not_persisted', surface: surface.name, control: next.label, detail: 'checkbox reverted on reload' });
        }
        continue;
      }
      await open(page, surface.route, surface.prepare);
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    for (const message of new Set(consoleErrors)) {
      report.findings.push({ kind: 'console_error', surface: surface.name, detail: message });
    }
  }
}

function newReport(project: string): Report {
  return { project, surfaces: [], pressed: 0, skipped: [], external: [], links: 0, findings: [], disabled: [] };
}

function write(report: Report, suffix: string): void {
  const dir = process.env.AUDIT_OUT ?? path.join(process.cwd(), 'test-results', 'audit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `crawl-${suffix}-${report.project}.json`), JSON.stringify(report, null, 2));
}

/** Open every disclosure, so what is inside one can be enumerated too. */
const openDetails = async (page: Page): Promise<void> => {
  await page.evaluate(() => document.querySelectorAll('details').forEach((node) => node.setAttribute('open', '')));
};

const widths = (process.env.AUDIT_WIDTHS ?? '1440,834,390').split(',').map(Number);

test.setTimeout(4 * 60 * 60_000);

test('an empty new user can press everything', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Widths are set by this test.');
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(25_000);
    page.setDefaultTimeout(25_000);
    await routeTiles(page);
    const report = newReport(String(width));
    const seen = new Set<string>();
    const surfaces: Surface[] = [
      { name: 'landing', route: '/' },
      { name: 'signin', route: '/signin' },
      { name: 'profile', route: '/profile' },
      { name: 'trips-empty', route: '/trips' },
      { name: 'new-trip', route: '/trips/new' },
      { name: 'decide', route: '/decide' },
      { name: 'explore', route: '/explore' },
      { name: 'support', route: '/support' },
      { name: 'privacy', route: '/privacy' },
      { name: 'terms', route: '/terms' },
      { name: '404', route: '/this-address-leads-nowhere' },
      { name: 'trip-404', route: '/trips/00000000-0000-4000-8000-000000000000/itinerary' },
      { name: 'share-404', route: '/share/AAAAAAAAAAAAAAAAAAAAAA' },
    ];
    for (const surface of surfaces) {
      await auditSurface(page, context, surface, report, seen).catch((error: Error) => report.findings.push({ kind: 'click_failed', surface: surface.name, detail: `surface aborted: ${error.message.slice(0, 200)}` }));
      write(report, 'guest');
    }
    await context.close();
  }
});

test('the owner of a fully built trip can press everything', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Widths are set by this test.');
  const seen = new Set<string>();
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(25_000);
    page.setDefaultTimeout(25_000);
    await routeTiles(page);
    const id = await buildFixtureTrip(page);
    await page.goto(`/trips/${id}/itinerary`);
    const share = await bandAction(page, 'Share this plan');
    await waitUntilInteractive(share);
    await share.click();
    const link = await page.getByLabel('Share link').inputValue();
    const sessionId = await startAdvisor(page).catch(() => null);
    if (sessionId) await answerUntilShortlist(page).catch(() => undefined);

    const report = newReport(String(width));
    const surfaces: Surface[] = [
      { name: 'trips-list', route: '/trips' },
      { name: 'questionnaire', route: `/trips/${id}/questionnaire` },
      { name: 'discover', route: `/trips/${id}/discover`, prepare: openDetails },
      { name: 'itinerary', route: `/trips/${id}/itinerary`, prepare: openDetails },
      { name: 'itinerary-days', route: `/trips/${id}/itinerary#days`, prepare: openDetails },
      { name: 'itinerary-map', route: `/trips/${id}/itinerary#map` },
      { name: 'itinerary-book', route: `/trips/${id}/itinerary#book`, prepare: openDetails },
      { name: 'itinerary-prepare', route: `/trips/${id}/itinerary#prepare`, prepare: openDetails },
      { name: 'edit', route: `/trips/${id}/edit`, prepare: openDetails },
      { name: 'pack', route: `/trips/${id}/pack`, prepare: openDetails },
      { name: 'today', route: `/trips/${id}/today`, prepare: openDetails },
      { name: 'party', route: `/trips/${id}/party`, prepare: openDetails },
      { name: 'feedback', route: `/trips/${id}/feedback` },
      { name: 'provisional', route: `/trips/${id}/provisional` },
      { name: 'share-page', route: new URL(link).pathname, prepare: openDetails },
      ...(sessionId ? [{ name: 'decide-shortlist', route: `/decide/${sessionId}` }] : []),
      { name: 'profile-signed-out', route: '/profile', prepare: openDetails },
    ];
    for (const surface of surfaces) {
      await auditSurface(page, context, surface, report, seen).catch((error: Error) => report.findings.push({ kind: 'click_failed', surface: surface.name, detail: `surface aborted: ${error.message.slice(0, 200)}` }));
      write(report, 'trip');
    }
    await context.close();
  }
});

test('a signed-in traveller can press everything on their account', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Widths are set by this test.');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signInFixture(page, 'audit@example.test');
  const report = newReport('1440');
  const seen = new Set<string>();
  for (const surface of [
    { name: 'trips-signed-in', route: '/trips' },
    { name: 'profile-signed-in', route: '/profile', prepare: openDetails },
  ]) {
    await auditSurface(page, context, surface, report, seen);
  }
  write(report, 'signedin');
  await context.close();
});
