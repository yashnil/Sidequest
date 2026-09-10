import {
  DIETARY_NEED_KIND,
  DIETARY_NEED_LABELS,
  type DietaryNeed,
  type DietaryNeedKind,
} from '../schemas/food';

/**
 * DIET AS A LIST OF REQUIREMENTS, NOT A LIST PLUS A LOOSE BOOLEAN.
 *
 * PRODUCTION LOCK V5, §4. The full questionnaire crashed on Build for a
 * traveller whose diet was "no beef, no pork". The immediate cause was a
 * vocabulary narrowing on the production path (see
 * `PRODUCTION-LOCK-V5-ERROR-INVENTORY.md` E1), but the shape underneath it is
 * what made the crash *possible*: diet was stored as `dietaryNeeds: string[]`
 * beside `dietaryStrict: boolean`, two fields that can disagree. Filter the
 * list and the boolean is orphaned — strictness with nothing to be strict
 * about — and any schema that (correctly) refuses that pair throws.
 *
 * A `DietaryRequirement` cannot be orphaned. Each one carries its own
 * strictness, so there is no global flag to leave dangling, and free text is a
 * requirement in its own right rather than a note attached to an empty list.
 *
 * The negative rule from `dietary.test.ts` still holds with full force and is
 * worth restating because this file is where it would be easiest to break:
 * **nothing here derives a religious diet from an ingredient exclusion, or an
 * ingredient exclusion from a religious diet.** `halal` does not expand into
 * `no_pork` and `no_alcohol`; `no_beef` does not become a religion. Every
 * requirement below traces to something the traveller actually ticked or typed.
 */

/** How hard one requirement binds. `strict` is "I cannot", `preference` is "I would rather". */
export const DIETARY_STRICTNESSES = ['preference', 'strict'] as const;
export type DietaryStrictness = (typeof DIETARY_STRICTNESSES)[number];

export interface DietaryRequirement {
  /** A need the traveller ticked, or `free_text` for a requirement they only wrote. */
  type: DietaryNeed | 'free_text';
  /** `diet`, `exclusion`, `allergy`, or `stated` for free text nobody classified. */
  kind: DietaryNeedKind | 'stated';
  /** How it binds. */
  strictness: DietaryStrictness;
  /** A sentence a planner and a traveller can both read. */
  label: string;
  /** The traveller's own words, for a `free_text` requirement or a note beside a ticked one. */
  originalText?: string;
}

/**
 * Build the requirement list from what the interview stored.
 *
 * The one invariant: a requirement exists for every ticked need and for
 * non-empty free text, and for nothing else. `strict` with no needs and no
 * notes produces an **empty list** — which is the honest reading of "somebody
 * ticked a box that qualifies nothing" — rather than a requirement with no
 * content or a boolean floating free of one.
 */
export function dietaryRequirementsOf(input: {
  needs: readonly DietaryNeed[];
  strict: boolean;
  notes?: string;
}): DietaryRequirement[] {
  const strictness: DietaryStrictness = input.strict ? 'strict' : 'preference';
  const requirements: DietaryRequirement[] = [];
  const seen = new Set<DietaryNeed>();
  for (const need of input.needs) {
    if (seen.has(need)) continue;
    seen.add(need);
    requirements.push({
      type: need,
      kind: DIETARY_NEED_KIND[need],
      /*
       * An allergy is strict whatever the box said. Not an inference about the
       * traveller — an allergy *is* the statement "I cannot", and a kitchen has
       * to be asked either way. Nothing else is upgraded.
       */
      strictness: DIETARY_NEED_KIND[need] === 'allergy' ? 'strict' : strictness,
      label: DIETARY_NEED_LABELS[need],
    });
  }
  const notes = (input.notes ?? '').trim();
  if (notes.length > 0) {
    requirements.push({ type: 'free_text', kind: 'stated', strictness, label: notes, originalText: notes });
  }
  return requirements;
}

/** True when at least one requirement is a "cannot". */
export function hasStrictDietaryRequirement(requirements: readonly DietaryRequirement[]): boolean {
  return requirements.some((requirement) => requirement.strictness === 'strict');
}

/**
 * One line per group, for the brief and for any traveller-facing summary.
 *
 * Strict requirements first and named as absolute, because that is the
 * difference that changes a plan.
 */
export function describeDietaryRequirements(requirements: readonly DietaryRequirement[]): string[] {
  const strict = requirements.filter((r) => r.strictness === 'strict');
  const soft = requirements.filter((r) => r.strictness === 'preference');
  const lines: string[] = [];
  if (strict.length > 0) lines.push(`Cannot eat (absolute): ${strict.map((r) => r.label).join('; ')}`);
  if (soft.length > 0) lines.push(`Would rather avoid: ${soft.map((r) => r.label).join('; ')}`);
  return lines;
}
