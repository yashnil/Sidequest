import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A DROPPED CONNECTION ON AN EDIT IS A SENTENCE, NEVER THE ERROR PAGE.
 *
 * A server action that rejects inside `startTransition(async …)` reaches the
 * nearest error boundary in React 19: pressing Remove on a flaky connection
 * replaced the whole trip page with "Your plan did not load" while the plan
 * itself was fine. `callAction` is the only safe way to make the call, so the
 * surfaces a traveller edits on are named here and held to it.
 */
const root = join(__dirname, '..', '..');
const SURFACES = [
  'app/(product)/trips/[id]/itinerary/edit-controls.tsx',
  'app/(product)/trips/[id]/itinerary/live-controls.tsx',
  'components/DiscoveryBoardView.tsx',
];

/** `await someAction(` not wrapped in `callAction(() => …)`. */
const BARE_ACTION_CALL = /await\s+(?!callAction)[a-zA-Z]+Action\(/;

describe('edit surfaces guard the wire', () => {
  for (const relative of SURFACES) {
    it(`${relative} calls no server action bare`, () => {
      const source = readFileSync(join(root, relative), 'utf8');
      /* The discovery buttons are one bounded lookup and answer in place; everything else goes through callAction. */
      const bare = source.split('\n').filter((line) => BARE_ACTION_CALL.test(line) && !/discover(Stays|Food)Action/.test(line));
      expect(bare).toEqual([]);
    });
  }
});
