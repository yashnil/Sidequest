import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessConstraintSetSchema, type AccessConstraint } from '@sidequest/core';

/**
 * V10 §9 — OPERATIONAL ACCESS FACTS, LOADED AS DATA AT THE SERVER BOUNDARY.
 *
 * The rules live in `@sidequest/core`'s `access/constraints.ts` and know nothing
 * about any place. The *claims* live here as JSON, one file per ISO country code,
 * each row carrying its own official source, the date it was checked and the
 * window it is valid in.
 *
 * Two things this deliberately is not:
 *
 * - **Not a branch.** There is no `if (destination === …)` anywhere in the
 *   planner, and there cannot be: the planner asks "what is known about reaching
 *   this place on these dates?" and gets rows or gets nothing. Adding a country
 *   is adding a file.
 * - **Not authoritative by being here.** Every row states its own authority, and
 *   only `official_current` and `operator` rows may establish a status
 *   (`CONFIRMING_ACCESS_AUTHORITY`). A row from a weaker source raises the
 *   question and is shown to the traveller without changing the plan.
 *
 * The eventual live implementation is a provider behind this same function
 * signature — a park service's own bulletins feed, a road authority's closures
 * API — and nothing above here changes when it arrives.
 */

const FIXTURE_DIRS = ['src/lib/providers/fixtures/access', 'apps/web/src/lib/providers/fixtures/access'];

const cache = new Map<string, readonly AccessConstraint[]>();

/** Every recorded access claim for one country, or an empty list when nothing is recorded. */
export function accessConstraintsForCountry(countryCode: string): readonly AccessConstraint[] {
  const code = countryCode.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return [];
  const cached = cache.get(code);
  if (cached) return cached;
  for (const dir of FIXTURE_DIRS) {
    try {
      /* `turbopackIgnore`: a computed path over two candidate roots; tracing it traced the project. The app runs `next start` from the tree, so the files are on disk. */
      const raw = readFileSync(join(/* turbopackIgnore: true */ process.cwd(), dir, `${code}.json`), 'utf8');
      const parsed = accessConstraintSetSchema.parse({ version: 1, constraints: (JSON.parse(raw) as { constraints: unknown[] }).constraints });
      cache.set(code, parsed.constraints);
      return parsed.constraints;
    } catch {
      /* Try the next root; a country with no file has no recorded claims, which is an honest answer. */
    }
  }
  cache.set(code, []);
  return [];
}

/** The claims relevant to a trip: every country the destination spans. */
export function accessConstraintsFor(countryCodes: readonly string[]): readonly AccessConstraint[] {
  const out: AccessConstraint[] = [];
  const seen = new Set<string>();
  for (const code of countryCodes) {
    for (const constraint of accessConstraintsForCountry(code)) {
      if (seen.has(constraint.id)) continue;
      seen.add(constraint.id);
      out.push(constraint);
    }
  }
  return out;
}

/** Reset between tests. Never called by the product. */
export function resetAccessConstraintCache(): void {
  cache.clear();
}
