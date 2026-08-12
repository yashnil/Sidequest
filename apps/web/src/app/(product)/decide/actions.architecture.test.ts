import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE RANKING MUST NOT WAIT FOR THE PHOTOGRAPHS.
 *
 * A live run recorded the shortlist written to the database at 18:01:33 and the
 * screen still reading "Working out where you should go" more than twenty-five
 * seconds later, through a reload. Nothing was slow about the ranking: it had
 * finished. `buildShortlistAction` went on to `await resolveShortlistImagery` —
 * eight sequential requests to a volunteer-run image service, deliberately not
 * parallelised out of API etiquette — before returning, and the client only
 * refreshes once the action resolves.
 *
 * This is asserted against the source rather than by running the action,
 * because the action reaches a database and a network and this property is
 * about *order*, not about output. Two things make it a real guard: the
 * imagery call must appear in its own exported action, and the ranking action
 * must return before it.
 *
 * The obvious regression is somebody tidying the two actions back into one.
 */

/**
 * Comments stripped first, because this file is about what the code does.
 *
 * Without it the first assertion fails on the docblock of the *next* function,
 * which names the call it is explaining — a test that reports a defect because
 * somebody wrote down why the defect was fixed.
 */
const SOURCE = readFileSync(new URL('./actions.ts', import.meta.url).pathname, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The body of a named exported action, up to the next top-level declaration. */
function actionBody(name: string): string {
  const start = SOURCE.indexOf(`export async function ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(start + 1);
  const next = rest.indexOf('\nexport ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('a shortlist is returned the moment it exists', () => {
  it('does not resolve imagery inside the ranking action', () => {
    expect(actionBody('buildShortlistAction')).not.toContain('resolveShortlistImagery(');
  });

  it('keeps imagery reachable as its own action', () => {
    const imagery = actionBody('resolveShortlistImageryAction');
    expect(imagery).toContain('resolveShortlistImagery(');
    // It reads the stored shortlist rather than taking one from the browser:
    // a client must not be able to name the subjects a lookup runs for.
    expect(imagery).toContain('getDecisionSession(');
  });

  it('tells the page to re-read as soon as the ranking is stored', () => {
    const build = actionBody('buildShortlistAction');
    expect(build).toContain('saveDecisionShortlist(');
    expect(build).toContain('revalidatePath(');
  });
});
