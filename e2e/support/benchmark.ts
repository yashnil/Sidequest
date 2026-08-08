import { expect, test, type Page } from '@playwright/test';
import { COMPILATION_STAGES, STAGE_REGISTRY } from '../../packages/core/src/schemas/stages';
import { waitUntilInteractive } from './trip';

/**
 * DRIVING THE BLIND COMPARISON FROM A BROWSER.
 *
 * Two things live here: the helpers every benchmark spec walks the interface
 * through, and a mirror of the banned vocabulary.
 *
 * THE MIRROR, AND WHY IT IS A MIRROR.
 *
 * The canonical list is `apps/web/src/lib/benchmark/vocabulary.ts`, and this
 * runner cannot import it: that module imports `@sidequest/core` by package
 * name, and Playwright's loader will not link a TypeScript entry point reached
 * through a workspace symlink. The stage names below *are* imported, by relative
 * path, because that path works — so only the curated words are copied.
 *
 * A copied list rots, so it is not left to vigilance. `neutrality.test.ts` reads
 * this file as text and fails if any banned word is missing from it, which means
 * adding a word to the canonical list and forgetting this file breaks the
 * offline suite in one second rather than the browser suite in thirteen minutes
 * — or worse, breaking nothing and quietly narrowing the check.
 *
 * The reason the browser check is worth this trouble at all: the source scan
 * sees what we wrote, and `page.content()` sees what was *sent* — the rendered
 * markup, every attribute, and the serialised payload handed to every client
 * component. That payload is where a leak would actually live.
 */

/** Mirrored from `vocabulary.ts`. Kept honest by an offline text comparison. */
const CURATED = [
  'sidequest',
  'claude',
  'anthropic',
  'opus',
  'sonnet',
  'haiku',
  'openai',
  'gpt',
  'gemini',
  'deterministic',
  'ai-generated',
  'ai generated',
  'artificial intelligence',
  'large language model',
  'language model',
  'prompt',
  'token',
  'scheduler',
  'optimiser',
  'optimizer',
  'compiler',
  'compilation',
  'baseline',
  'planner engine',
  'pipeline',
  'adapter',
  'algorithm',
  'automatically generated',
  'discovery board',
  'provisional board',
  'provisional',
  'shortlist',
  'help me decide',
  'fit meter',
  'fit band',
  'hidden gem',
  'worth a detour',
  'region searched',
  'base portfolio',
  'candidate portfolio',
  'trip personality',
  'compiled region',
  'region pack',
  'evidence store',
  'evidence claim',
  'scope fingerprint',
  'planner readiness',
  'sources disagree',
  'not established',
];

/** Mirrored too: short words that would otherwise match inside longer ones. */
const WORD_BOUNDARY_TOKENS = new Set([
  'gpt',
  'token',
  'prompt',
  'model',
  'provisional',
  'shortlist',
]);

export const FORBIDDEN_TOKENS: readonly string[] = [
  ...CURATED,
  ...COMPILATION_STAGES,
  ...STAGE_REGISTRY.map((stage) => stage.label),
].map((token) => token.toLowerCase());

export function forbiddenTokensIn(text: string): string[] {
  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (token.length === 0) continue;
    if (WORD_BOUNDARY_TOKENS.has(token) || token.length < 6) {
      if (new RegExp(`\\b${escapeForRegExp(token)}\\b`, 'i').test(haystack)) found.push(token);
    } else if (haystack.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



/**
 * Nothing identifying in what was rendered, and nothing at all in what was sent.
 *
 * Two passes, because they catch different things. The first is the document
 * with its scripts removed: markup, attributes, hidden text — everything a
 * person can see or inspect in the elements panel. The second is the flight
 * payload, which is where a value handed to a client component travels whether
 * or not any element renders it, and which is the leak nobody sees in a browser.
 *
 * The second pass carried one named allowance for a while, and no longer does.
 * Next attaches a layout's `not-found` boundary to the payload of every response
 * beneath it, and the product's 404 used to be mounted where that meant *every*
 * route — so the wordmark travelled in the payload of a screen designed not to
 * name it. The fix was to stop mounting the product chrome at a level the root
 * boundary could reach; the chrome now belongs to `trips` and `decide`, and this
 * assertion is unconditional again.
 *
 * That is worth a sentence because an allowance in a check like this decays. It
 * starts as one named token with a reason and becomes the place a second one is
 * quietly added.
 */
export async function expectNothingIdentifying(page: Page, where: string): Promise<void> {
  const rendered = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script').forEach((node) => node.remove());
    return clone.outerHTML;
  });
  const inMarkup = [...new Set(forbiddenTokensIn(rendered))];
  expect(inMarkup, `${where} renders identifying words: ${inMarkup.join(', ')}`).toEqual([]);

  const payload = await page.evaluate(() =>
    [...document.querySelectorAll('script')].map((node) => node.textContent ?? '').join('\n'),
  );
  const inPayload = [...new Set(forbiddenTokensIn(payload))];
  expect(
    inPayload,
    `${where} sends identifying words in its payload: ${inPayload.join(', ')}`,
  ).toEqual([]);
}

/* ------------------------------------------------------------------ *
 * Walking the interface
 * ------------------------------------------------------------------ */

export const DEFAULT_CASE = 'city-transit-tokyo';

/**
 * Start a real comparison from a library traveller.
 *
 * Goes through the composer a person would use, so this exercises the request
 * validation, the session write and the assignment draw. It lands on the
 * progress screen, because that is what happens: nothing has been built yet.
 */
export async function createBenchmarkSessionFromCase(
  page: Page,
  caseId: string = DEFAULT_CASE,
): Promise<string> {
  await page.goto('/labs/benchmark/new');
  const select = page.getByTestId('case-select');
  await waitUntilInteractive(select);
  await select.selectOption(caseId);
  await page.getByTestId('composer-submit-saved').click();
  await page.waitForURL(/\/labs\/benchmark\/[^/]+\/run/);
  return sessionIdFrom(page.url());
}

/**
 * Write a whole comparison from the checked-in examples.
 *
 * The fixture seam, and named as one. The two planner arms are being built
 * alongside this interface, so a spec that waited for a real plan would be
 * waiting on somebody else's unmerged branch; this writes both plans, both
 * metric sets and both validation reports directly and lands on the review.
 * The rows it makes are marked `seeded` and no aggregate mixes them with real
 * ones.
 */
export async function seedReviewableSession(
  page: Page,
  options: {
    caseId?: string;
    seed: string;
    shape?: 'both_complete' | 'partial_and_failed' | 'awaiting_answers';
  },
): Promise<string> {
  await page.goto('/labs/benchmark/new');
  const seedField = page.getByTestId('fixture-seed');
  await waitUntilInteractive(seedField);
  await page.getByTestId('fixture-case').selectOption(options.caseId ?? DEFAULT_CASE);
  /*
   * THE SEED IS SCOPED TO THE PROJECT, AND IT HAS TO BE.
   *
   * The fixture write is idempotent on its own content: the same seed and case
   * resolve to the same session rather than minting a second one. That is a
   * deliberate property — it is what stops two reviewers who start the same
   * comparison in the same moment from silently getting two different blind
   * assignments — and it is why the seeds in the specs are fixed strings.
   *
   * But the four browser projects share one database, and a spec that runs in
   * three of them therefore asked for the same session three times. The first
   * project locked and revealed it; the second arrived at a review that was
   * already over and timed out waiting for a control that renders only while a
   * review is open. Three tests failed in each later project, with a message —
   * "the page did not hydrate" — that points at rendering and not at state,
   * which is what made it look like flake.
   *
   * Appending the project name keeps idempotency where the specs rely on it,
   * within a project, and separates the runs that were never meant to share.
   */
  await seedField.fill(`${options.seed}-${test.info().project.name}`);
  await page.getByTestId('fixture-shape').selectOption(options.shape ?? 'both_complete');
  await page.getByTestId('fixture-write').click();
  await page.waitForURL(
    options.shape === 'awaiting_answers'
      ? /\/labs\/benchmark\/[^/]+\/run/
      : /\/labs\/benchmark\/[^/]+\/review/,
    { timeout: 30_000 },
  );
  return sessionIdFrom(page.url());
}

/**
 * A comparison stopped at the question round, with nothing answered.
 *
 * The state every viewport and accessibility sweep was missing: the pooled
 * question list, its answer controls, and the second press. Seeded rather than
 * run, because nothing in the browser suite may reach a provider.
 */
export async function seedQuestionRound(page: Page, seed: string): Promise<string> {
  return seedReviewableSession(page, { seed, shape: 'awaiting_answers' });
}

export async function reachReview(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/labs/benchmark/${sessionId}/review`);
  const reviewer = page.getByLabel('Who is reviewing');
  await waitUntilInteractive(reviewer);
  /*
   * Present rather than visible. Which panel is drawn first was drawn once and
   * stored, so it is genuinely a coin toss — and below 1280 only one of the two
   * is on screen at a time.
   */
  await expect(page.getByTestId('panel-A')).toHaveCount(1);
  await expect(page.getByTestId('panel-B')).toHaveCount(1);
}

/**
 * Bring one panel on screen, whatever the width.
 *
 * Above 1280 both are already there and the switcher is not rendered, so this
 * does nothing. Below it, the panels stack behind a segmented control and the
 * hidden one has no box a test can click.
 */
export async function showPanel(page: Page, label: 'A' | 'B'): Promise<void> {
  const switcher = page.getByTestId(`switch-${label}`);
  if (await switcher.isVisible().catch(() => false)) await switcher.click();
  await expect(page.getByTestId(`panel-${label}`)).toBeVisible();
}

/**
 * Answer everything the review asks, so the lock can be reached.
 *
 * Every rating group is answered by name rather than by position, and the same
 * score is given to both panels: the point of these specs is the machinery, and
 * a spec that expressed a preference would make its own assertions about who won
 * harder to read.
 */
export async function completeReview(
  page: Page,
  options: { reviewer?: string; choice?: 'A' | 'B' | 'tie' | 'cannot_judge'; score?: number } = {},
): Promise<void> {
  const choice = options.choice ?? 'A';
  const score = options.score ?? 5;

  await page.getByLabel('Who is reviewing').fill(options.reviewer ?? 'e2e');

  /*
   * Panel by panel, bringing each on screen first. Below 1280 the second one is
   * behind a switcher and its radios have no box to click — and a review with
   * fifteen of thirty scales answered cannot be locked, which is how a spec that
   * skipped this would fail three steps later with an unhelpful message.
   */
  for (const label of ['A', 'B'] as const) {
    await showPanel(page, label);
    const radios = page.locator(
      `[data-testid^="rating-${label}-"] input[type=radio][value="${score}"]`,
    );
    const count = await radios.count();
    for (let index = 0; index < count; index += 1) {
      const radio = radios.nth(index);
      if (await radio.isVisible().catch(() => false)) await radio.check();
    }
  }

  const choiceGroups = await page
    .locator('input[type=radio][name^="choice-"]')
    .evaluateAll((nodes) => [
      ...new Set(nodes.map((node) => (node as HTMLInputElement).name)),
    ]);
  for (const name of choiceGroups) {
    await page.locator(`input[name="${name}"][value="${choice}"]`).check();
  }

  await page
    .getByLabel('Why did you choose that?')
    .fill('It reads as the more workable of the two across every day.');
}

/** Fill in, confirm and lock. Lands on the report screen. */
export async function lockAndReveal(page: Page, sessionId: string): Promise<void> {
  await page.getByTestId('lock-open').click();
  await expect(page.getByTestId('lock-confirm-panel')).toBeVisible();
  await page.getByTestId('lock-confirm').click();
  await page.waitForURL(new RegExp(`/labs/benchmark/${escapeForRegExp(sessionId)}/results`));
  await page.getByTestId('reveal').click();
  await expect(page.getByTestId('identities')).toBeVisible({ timeout: 15_000 });
}

function sessionIdFrom(url: string): string {
  const id = /\/labs\/benchmark\/([^/]+)\//.exec(url)?.[1];
  expect(id, 'a session id should be in the URL').toBeTruthy();
  return decodeURIComponent(id!);
}
