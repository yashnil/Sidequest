import type { z } from 'zod';
import { REFINEMENT_INTENTS } from './state';

/**
 * V9.1 §1 — THE DETERMINISTIC REPAIR THE REFINEMENT NEVER SUPPLIED.
 *
 * `ResearchModel.structured` takes an optional `normalize` hook that runs
 * before its canonical schema parse, and its own comment explains why one is
 * needed at all: `zodOutputFormat`'s converter folds `maxLength`, `pattern`
 * and `minItems` into *descriptive text* inside each field's JSON Schema
 * `description` rather than compiling them into the grammar. Dumping the
 * grammar this path actually sends confirms it — 9,697 bytes containing not a
 * single `enum` or `const` keyword, with `intent` travelling as
 * `{"type":"string","description":"{enum: [...]}"}`. **Nothing in the
 * refinement wire is enforced by the provider except object shape and JSON
 * type.** Every cap, every literal and every enum in `tripPatchSchema` is
 * checked only afterwards, by zod, where a violation throws away the whole
 * answer — which is what a live structural call did after answering correctly
 * in 19.8 s.
 *
 * The classification below is the one `normalizeBaselineGeneration` already
 * settled for the other schema in this codebase that supplies a hook, applied
 * to this one. It is deliberately narrow.
 *
 * SOFT — free explanatory prose whose exact wording carries no planning
 * decision and which nothing looks up: `why`, `reason`, `theme`, `rationale`,
 * `purpose`, `routeRationale`, `summary`, `notes[]`, `explanation`, and the
 * traveller-facing `changed[]` / `kept[]` lines. A few characters past a
 * cosmetic cap is a presentation defect, not a different trip.
 *
 * HARD — everything else, untouched, always throws:
 * - every enum and every `op` literal: there is no safe guess at which
 *   operation the model meant, and `intent` is the field this pass exists to
 *   get right;
 * - every identifier (`id`, `baseId`) and every name matched by value
 *   (`name`, `partOf`, `signatures`, `meals.*`, `lodgingArea`,
 *   `lodgingStyle`) — `partOf` is looked up against signatures and episodes,
 *   so clipping one silently breaks the match;
 * - every number with planning meaning (`nights`, `day`, `toDay`, `mins`) —
 *   clamping a night count is inventing a different trip;
 * - every array length — dropping an entry to fit a cap deletes part of the
 *   answer, which is a content decision;
 * - `needsClarification` in full: its `options` are choices put to the
 *   traveller, and a clipped choice is a different question.
 *
 * The repair is driven by zod's own issues rather than a second copy of the
 * caps, so it cannot drift from the schema: only a `too_big` on a string at a
 * soft path is touched, and it is clipped to the maximum zod itself reported.
 * There is no pattern on any of these fields — `shortProse` is
 * `z.string().max(n)` and nothing more — so, unlike the baseline's case, a
 * clip cannot launder a forbidden substring sitting past the cap.
 *
 * This can only turn a "no" into a "yes" for the fields named above. It can
 * never turn a "no" into a "yes" for anything else, and never a "yes" into a
 * "no": a value that already parses is returned untouched.
 */
const SOFT_PROSE_KEYS = new Set([
  'why',
  'reason',
  'theme',
  'rationale',
  'purpose',
  'routeRationale',
  'summary',
  'explanation',
]);

/** Soft arrays of prose: the issue path ends in an index, so the key sits one segment back. */
const SOFT_PROSE_ARRAYS = new Set(['notes', 'changed', 'kept']);

/** `needsClarification` is hard in full; nothing beneath it is ever clipped. */
const HARD_SUBTREES = ['needsClarification'];

function isSoftProsePath(path: readonly (string | number)[]): boolean {
  if (path.length === 0) return false;
  if (path.some((segment) => HARD_SUBTREES.includes(String(segment)))) return false;
  const last = path[path.length - 1];
  if (typeof last === 'string') return SOFT_PROSE_KEYS.has(last);
  /* An array element: the key is the segment before the index. */
  const parent = path[path.length - 2];
  return typeof parent === 'string' && SOFT_PROSE_ARRAYS.has(parent);
}

function readAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[segment as never];
  }
  return node;
}

/** Writes a clipped string back, cloning only the objects on the way to it. */
function writeAt(root: unknown, path: readonly (string | number)[], value: string): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[head as number] = writeAt(copy[head as number], rest, value);
    return copy;
  }
  if (root !== null && typeof root === 'object') {
    const copy = { ...(root as Record<string, unknown>) };
    copy[String(head)] = writeAt(copy[String(head)], rest, value);
    return copy;
  }
  return root;
}

/**
 * The `normalize` hook for the refinement wire. Returns the value unchanged
 * unless a soft prose field is purely over its cap, in which case that field
 * is trimmed and, if still long, clipped to the maximum zod reported.
 */
export function normalizeRefinementWire(schema: z.ZodType, raw: unknown): { value: unknown; normalizedFields: readonly string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, normalizedFields: [] };
  const first = schema.safeParse(raw);
  if (first.success) return { value: raw, normalizedFields: [] };

  const touched: string[] = [];
  let value: unknown = raw;
  for (const issue of first.error.issues) {
    if (issue.code !== 'too_big') continue;
    /* zod types a path as `PropertyKey[]`; a symbol cannot appear in parsed JSON, and a soft path must be reachable. */
    const path = issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol');
    if (path.length !== issue.path.length) continue;
    if (!isSoftProsePath(path)) continue;
    const current = readAt(value, path);
    if (typeof current !== 'string') continue;
    const maximum = typeof issue.maximum === 'number' ? issue.maximum : Number(issue.maximum);
    if (!Number.isFinite(maximum) || maximum <= 0) continue;
    const trimmed = current.trim();
    const repaired = trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum).trimEnd();
    if (repaired === current) continue;
    value = writeAt(value, path, repaired);
    touched.push(path.join('.'));
  }
  return { value, normalizedFields: touched };
}

/**
 * What a refusal was, in words a reviewer can act on, carrying no fragment of
 * what the model wrote.
 *
 * The throw site in `anthropic.ts` keeps zod's own `message` inside the
 * private diagnostic because it can echo the offending value. A path, a code
 * and — where the field is a closed vocabulary of ours — the list of values we
 * would have accepted say what went wrong without repeating anything the model
 * produced.
 */
export function describeRefinementRefusal(issues: readonly { path: string; code: string }[] | null | undefined): string | null {
  const first = issues?.[0];
  if (!first) return null;
  if (first.path === 'intent') {
    return `the answer's "intent" was not one of the values the contract allows (${REFINEMENT_INTENTS.join(', ')})`;
  }
  const where = first.path ? `"${first.path}"` : 'the answer itself';
  if (first.code === 'too_big') return `${where} was longer than the contract allows, and is not a field Sidequest may shorten on the model's behalf`;
  if (first.code === 'invalid_type') return `${where} was the wrong type`;
  if (first.code === 'invalid_value' || first.code === 'invalid_union') return `${where} was not one of the values the contract allows`;
  return `${where} did not match the contract (${first.code})`;
}
