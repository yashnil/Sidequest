import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY LABS ACTION ASKS THE GATE, BECAUSE THE URL GATE DOES NOT COVER THEM.
 *
 * `middleware.ts` matches on `/labs/:path*`, which decides what a *navigation*
 * may reach. It decides nothing about a server action: Next resolves an action
 * from its `Next-Action` id against a global manifest and runs it whatever URL
 * the POST was addressed to. A reviewer POSTed a labs-only action id to `/`
 * against the running production build and it executed. The billed presses in
 * this tree therefore each carry their own check.
 *
 * This is the half that survives the *next* action being added. A guard that
 * every current author remembered is not a guard; a guard whose absence fails a
 * test is. Structural rather than behavioural on purpose — running the actions
 * would need a request scope and a benchmark session, and neither would prove
 * the property, which is about what every exported function in the tree starts
 * with.
 */

const LABS_ROOT = new URL('.', import.meta.url).pathname;

/** Every `actions.ts` under `app/labs`, found rather than listed. */
function actionFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...actionFiles(path));
    else if (entry.name === 'actions.ts') found.push(path);
  }
  return found;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Where a declaration's body starts.
 *
 * Not `indexOf('{')`: `seedFixtureComparisonAction` takes an inline object type,
 * so the first brace in its declaration belongs to the parameter list. Walk the
 * parentheses to the end of the signature first, then take the next brace.
 */
function bodyStart(declaration: string): number {
  let depth = 0;
  for (let index = 0; index < declaration.length; index += 1) {
    const character = declaration[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return declaration.indexOf('{', index) + 1;
    }
  }
  return 0;
}

const FILES = actionFiles(LABS_ROOT);

describe('the labs action gate', () => {
  it('finds the labs action files at all', () => {
    // A recursive scan that silently found nothing would pass every assertion
    // below. Six exported actions live in four files today.
    expect(FILES.length).toBeGreaterThanOrEqual(4);
  });

  it.each(FILES.map((file) => [file.slice(LABS_ROOT.length), file] as const))(
    '%s guards every exported action',
    (_name, file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      const exported = [...source.matchAll(/export async function (\w+)\s*\(/g)].map(
        (match) => match[1]!,
      );
      expect(exported.length).toBeGreaterThan(0);
      expect(source).toContain("from '@/lib/labs/access'");

      /*
       * The guard has to be inside each function, not merely imported once at
       * the top of the file. Counting occurrences is the cheapest statement of
       * that: one call per exported action, and an action added without one
       * moves the count.
       */
      const guards = [...source.matchAll(/labsAccessGranted\(\)/g)].length;
      expect(guards, `${exported.join(', ')} must each call labsAccessGranted()`).toBe(
        exported.length,
      );

      /*
       * And it has to be the *first* statement. A check after the work has
       * begun is not a gate — `startBothRunsAction` reclaims a stalled claim
       * and writes run rows before it spends, and an unauthorised caller must
       * not be able to do that either.
       */
      for (const name of exported) {
        const declaration = source.slice(source.indexOf(`export async function ${name}`));
        const firstStatement = declaration
          .slice(bodyStart(declaration))
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        expect(firstStatement, `${name} must gate before it does anything`).toContain(
          'labsAccessGranted()',
        );
      }
    },
  );
});
