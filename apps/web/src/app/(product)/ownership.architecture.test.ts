import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * V6 §50 — EVERY TRIP-SCOPED SERVER ACTION ASKS THE OWNERSHIP SEAM.
 *
 * Ship V1 enumerated 72 actions by hand. This holds the convention in code:
 * every `export async function` in an `actions.ts` under a trip-scoped route
 * must reach one of the guards — `tripAccessRefusal`, `ownedTrip`, the
 * itinerary slice's `editContext` / `reconciledContext` seams (which call it),
 * or `guardAction` for the pre-trip doors that have no trip to own yet — or
 * be listed here as deliberately unguarded with the reason.
 */

const ROOT = join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/actions\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const GUARDS = /tripAccessRefusal\(|ownedTrip\(|editContext\(|reconciledContext\(|guardAction\(|rateGuard\(|labsAccessGranted\(|decisionAccessRefusal\(|currentUser\(\)|currentUserId\(\)/;

/**
 * Actions with no trip and no billable provider (reading a session, signing
 * out), and one form wrapper that delegates to the guarded action beside it.
 */
const DELIBERATELY_UNGUARDED = new Set(['signOutAction', 'unclaimedTripCountAction', 'refreshWeatherFormAction']);

describe('server action ownership', () => {
  const files = walk(ROOT);
  it('finds the action files', () => {
    expect(files.length).toBeGreaterThan(8);
  });
  for (const file of files) {
    it(`${file.replace(ROOT, '')} guards every exported action`, () => {
      const source = readFileSync(file, 'utf8');
      const actions = [...source.matchAll(/export async function (\w+)\s*\(([\s\S]*?)\n\}\n/g)];
      for (const match of actions) {
        const name = match[1]!;
        if (DELIBERATELY_UNGUARDED.has(name)) continue;
        const body = match[0];
        expect(GUARDS.test(body), `${name} in ${file.replace(ROOT, '')} reaches no ownership or rate guard`).toBe(true);
      }
    });
  }
});
