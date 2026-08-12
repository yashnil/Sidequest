import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * STATEMENTS AGAINST `trips` LIVE IN THE REPOSITORY, NOT IN THE ACTION.
 *
 * `deleteTripAction` was written with `getDb().prepare('DELETE FROM trips …')`
 * inline, with a comment saying it belonged in the repository and had been left
 * here because the slice that wrote it did not own that file. That is a real
 * cost rather than a tidiness complaint: the delete depends on every table that
 * references `trips(id)` declaring `ON DELETE CASCADE`, and a schema change has
 * to be chased to every place that knows about the table. One of those places
 * being a server action in the route tree is exactly how such a place gets
 * missed.
 *
 * Asserted against the source rather than by running the action, because the
 * property is about *where* the statement is written. Running it proves nothing:
 * the inline version and the repository version delete the same row, which is
 * why this needs a structural test or no test at all.
 *
 * Comments are stripped first — the docblock above `deleteTripAction` names the
 * thing it no longer does, and a test that failed on an explanation of the fix
 * would be reporting its own documentation as the defect.
 */
const SOURCE = readFileSync(new URL('./actions.ts', import.meta.url).pathname, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the trip delete goes through the repository', () => {
  it('runs no SQL of its own', () => {
    expect(SOURCE).not.toContain('getDb(');
    expect(SOURCE).not.toMatch(/DELETE\s+FROM/i);
  });

  it('calls the repository statement instead', () => {
    expect(SOURCE).toContain("from '@/lib/db/repository'");
    expect(SOURCE).toContain('deleteTrip(tripId)');
  });

  /**
   * The half that must stay in the action.
   *
   * Whether a trip *may* be removed is policy, and policy belongs with the
   * caller: a compilation holds the job row open and writes stages against this
   * trip id, so deleting underneath it leaves a background worker inserting rows
   * whose foreign key no longer resolves. Moving the statement out must not take
   * the refusal with it.
   */
  it('still refuses while a compilation is writing to the trip', () => {
    expect(SOURCE).toContain('getActiveJob(tripId)');
  });
});
