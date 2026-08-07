import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * IS THE APP ACTUALLY RUNNABLE, AND IS IT STILL THE SAME ONE AT THE END.
 *
 * `webServer.url` proves that something answered on the port. It does not prove
 * that the thing it answered with can run in a browser, and the difference is
 * not academic: a page whose scripts return 500 renders its server markup
 * perfectly, never hydrates, and then swallows every keystroke. What a test
 * reports in that state is a sixty-second timeout on whichever locator it
 * happened to reach first — in one observed case `getByLabel('Arrive')`, a field
 * that is *supposed* to be absent until the form above it is answered. Hours of
 * a suite's runtime, and a symptom that names nothing.
 *
 * So the readiness condition is widened from "the server responds" to "the app
 * the server serves can start", and the run is bracketed by an identity check on
 * the build it tested.
 *
 * Neither of these is a retry, a wait or a tolerance. They are the difference
 * between a suite that says what went wrong and one that times out.
 */

const BUILD_ID_PATH = join(process.cwd(), 'apps', 'web', '.next', 'BUILD_ID');

/**
 * Which build the suite started against.
 *
 * An environment variable rather than a module-level value: Playwright loads
 * global setup and global teardown as separate module graphs, so anything held
 * in a variable here is gone by the time the comparison happens.
 */
const BUILD_ID_ENV = 'SIDEQUEST_E2E_BUILD_ID';

export function buildId(): string | null {
  try {
    return readFileSync(BUILD_ID_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function baseURLOf(config: FullConfig): string {
  const fromProject = config.projects[0]?.use?.baseURL;
  if (typeof fromProject === 'string' && fromProject.length > 0) return fromProject;
  throw new Error('No baseURL is configured, so readiness cannot be established.');
}

/**
 * Every asset the first page of the journey needs, fetched before any test runs.
 *
 * The composer is used because it is where every journey starts and because it
 * is a client component: if its scripts are missing, nothing downstream can
 * work, and saying so here costs one request each.
 */
async function assertAssetsAreServable(baseURL: string): Promise<void> {
  const url = new URL('/trips/new', baseURL);
  const page = await fetch(url);
  if (!page.ok) {
    throw new Error(
      `The app answered ${page.status} for ${url.pathname}. The suite has nothing to test against.`,
    );
  }
  const html = await page.text();

  const references = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (match[1]) references.add(match[1]);
  }
  for (const match of html.matchAll(/<link[^>]+href="(\/_next\/[^"]+)"/g)) {
    if (match[1]) references.add(match[1]);
  }

  const broken: string[] = [];
  await Promise.all(
    [...references].map(async (reference) => {
      const asset = new URL(reference, baseURL);
      try {
        const response = await fetch(asset);
        if (!response.ok) broken.push(`${response.status} ${reference}`);
      } catch (error) {
        broken.push(`unreachable ${reference} (${String(error)})`);
      }
    }),
  );

  if (broken.length > 0) {
    throw new Error(
      [
        'The app is being served but cannot start in a browser: its own scripts and',
        'stylesheets are not being served. Every test would render server markup,',
        'never hydrate, and time out on an unrelated locator.',
        '',
        ...broken.map((line) => `  ${line}`),
        '',
        'The usual cause is a build replacing `.next` under a server that is already',
        'running: the running process still names the chunks of the build it started',
        'with, and those files are gone. Stop the server, rebuild, run again.',
      ].join('\n'),
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const id = buildId();
  if (id) process.env[BUILD_ID_ENV] = id;
  await assertAssetsAreServable(baseURLOf(config));
}

/** What the run started against, for the teardown to compare with. */
export function recordedBuildId(): string | undefined {
  return process.env[BUILD_ID_ENV];
}
