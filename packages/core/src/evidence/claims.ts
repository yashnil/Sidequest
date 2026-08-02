import type { EvidenceClaimRecord } from '../schemas/evidence-store';
import type { FactPath } from '../schemas/source-fact';
import { stableHash } from './identity';

/**
 * CLAIM IDENTITY, AND WHAT MAY BE RESOLVED ONCE FOR EVERYBODY.
 *
 * Two decisions live here, and both are about *not* doing work twice.
 *
 * **A claim's identity is what it says, not when it was said.** The id is a hash
 * of the subject, the question, the bytes it came from, the contract that read
 * them, and the normalised answer. Read the same unchanged page again under the
 * same parser and prompt and you get the same id — so the store sees an existing
 * row and moves `lastSeenAt`, rather than accumulating a new "version" of an
 * identical fact every time somebody plans a trip.
 *
 * **A resolved fact may be shared only when its answer does not depend on the
 * traveller's calendar.** Where a museum's official site is, what it charges,
 * whether it needs booking — those are the same answer for everybody. Whether it
 * is open on the fourteenth is not, and a shared cache that answered it would be
 * the single most dangerous thing this store could hold.
 */

/** Bumped when the resolution rules change in a way that alters an answer. */
export const RESOLVER_VERSION = 'resolve/2026-08-02.1';

/**
 * Fact paths whose resolved answer is the same for every traveller and every
 * date.
 *
 * Deliberately a **closed allow-list** rather than a deny-list of the dated
 * ones. A new fact path added later is date-dependent until somebody argues
 * otherwise, which is the safe direction to be wrong in: the cost of
 * re-resolving a shareable fact is microseconds, and the cost of sharing a dated
 * one is telling somebody a place is open when it is shut.
 */
export const CONTEXT_INDEPENDENT_PATHS: readonly FactPath[] = [
  'identity.officialSite',
  'identity.bookingUrl',
  'access.method',
  'access.permit',
  'booking.required',
  'booking.timedEntry',
  'booking.leadTime',
  'cost.admission',
  'cost.parking',
  'duration.typical',
  'safety.requirement',
  'food.price',
  'food.dietary',
  'food.reservation',
];

const CONTEXT_INDEPENDENT = new Set<FactPath>(CONTEXT_INDEPENDENT_PATHS);

/**
 * Whether a resolved answer for this path may be shared across trips.
 *
 * Everything not on the list is recomputed per trip against the traveller's own
 * dates: opening hours, seasonal windows, last admission, closures, transport
 * fares that change with a season, serving hours, and any safety notice with a
 * date on it.
 */
export function isContextIndependent(path: FactPath): boolean {
  return CONTEXT_INDEPENDENT.has(path);
}

export interface ClaimIdentityInput {
  subjectKey: string;
  factPath: FactPath;
  contentDigest: string;
  /** The contract that read the bytes: parser, or prompt + schema + model. */
  contract: string;
  /** The answer itself, normalised. Two phrasings of one answer are one claim. */
  normalizedValue: string;
}

/**
 * A claim's id: deterministic, and derived from everything that makes it *that*
 * claim.
 *
 * The consequence worth stating: re-reading an unchanged page under an unchanged
 * contract produces the same id, so the store recognises the row it already has
 * instead of writing a second identical one. That is what stops "shared claims"
 * turning into an append-only log that grows once per compilation forever.
 */
export function claimIdFor(input: ClaimIdentityInput): string {
  return `clm-${stableHash(
    [
      'claim/1',
      input.subjectKey,
      input.factPath,
      input.contentDigest,
      input.contract,
      input.normalizedValue,
    ].join('\n'),
  )}`;
}

/**
 * The answer, reduced to what two records of the same fact would agree on.
 *
 * The payload leads, because a typed payload *is* the answer for every path that
 * has one — two pages phrasing the same opening hours differently are one claim,
 * and treating them as two would manufacture a conflict out of prose. Where
 * there is no payload the statement is the answer, normalised the same way the
 * resolver's own conflict check normalises it.
 */
export function normalizeClaimValue(payload: unknown, statement: string): string {
  if (payload !== undefined && payload !== null) {
    const encoded = stableStringify(payload);
    if (encoded !== null) return encoded;
  }
  return statement
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9:.-]+/g, ' ')
    .trim();
}

/**
 * JSON with its object keys sorted, recursively.
 *
 * Written out rather than reached for via `JSON.stringify`'s replacer argument,
 * which was the first attempt and was silently catastrophic: an **array**
 * replacer is a recursive property allow-list, so passing the top-level keys
 * erased everything nested under them. Two completely different opening
 * calendars normalised to the same string, which meant a changed answer neither
 * minted a new claim nor superseded the old one — the store would have gone on
 * serving last season's hours forever, and nothing would have looked wrong.
 *
 * Returns null rather than throwing on anything unserialisable, so the caller
 * falls back to the statement and the function stays total.
 */
function stableStringify(value: unknown, seen: Set<object> = new Set()): string | null {
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? null;
    } catch {
      return null;
    }
  }
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    const parts = value.map((entry) => stableStringify(entry, seen));
    return parts.some((part) => part === null) ? null : `[${parts.join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: string[] = [];
  for (const [key, entry] of entries) {
    const encoded = stableStringify(entry, seen);
    if (encoded === null) return null;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

/** The contract string a model extraction was produced under. */
export function extractionContract(input: {
  promptVersion: string;
  schemaVersion: string;
  modelId: string;
  parserVersion: string;
}): string {
  return `model:${input.promptVersion}|${input.schemaVersion}|${input.modelId}|${input.parserVersion}`;
}

/** The contract string a deterministic parse was produced under. */
export function parseContract(parserVersion: string): string {
  return `parse:${parserVersion}`;
}

export interface FactSetKeyInput {
  subjectKey: string;
  factPath: FactPath;
  /** Every claim that went into the answer. Sorted, so order cannot fork a key. */
  claimIds: readonly string[];
  resolverVersion: string;
}

/**
 * The key a shared resolved answer is stored under.
 *
 * Keyed on the **claim set** rather than on a timestamp, so a new claim about
 * the same question produces a new key automatically and a stale answer can
 * never be served for a set that has since grown. There is no trip and no
 * traveller in it, and `architecture.test.ts` fails the build if one appears.
 *
 * Deliberately has no date parameter: a path that needs one is not shareable,
 * and `isContextIndependent` is the gate that keeps it out of here.
 */
export function factSetKeyFor(input: FactSetKeyInput): string {
  return `fs-${stableHash(
    [
      'factset/1',
      input.subjectKey,
      input.factPath,
      [...input.claimIds].sort().join(','),
      input.resolverVersion,
    ].join('\n'),
  )}`;
}

/**
 * Claims grouped by the question they answer, newest observation first.
 *
 * Superseded rows are dropped here rather than at the database, because the
 * database keeps them on purpose — an artifact compiled last month quotes them.
 */
export function liveClaimsByPath(
  claims: readonly EvidenceClaimRecord[],
): Map<FactPath, EvidenceClaimRecord[]> {
  const byPath = new Map<FactPath, EvidenceClaimRecord[]>();
  for (const claim of claims) {
    if (claim.superseded) continue;
    const bucket = byPath.get(claim.factPath) ?? [];
    bucket.push(claim);
    byPath.set(claim.factPath, bucket);
  }
  for (const bucket of byPath.values()) {
    bucket.sort((a, b) => b.contentObservedAt.localeCompare(a.contentObservedAt) || a.id.localeCompare(b.id));
  }
  return byPath;
}

/**
 * Which claims a *newer* observation of the same page and question replaces.
 *
 * The rule is narrow on purpose: a claim is superseded only by one about the
 * same subject and question **from the same source**, with a different answer,
 * observed later. Two different publishers disagreeing is a conflict for the
 * resolver to surface, not a replacement — and collapsing the two would let the
 * most recently-read page silently win an argument it should have had in the
 * open.
 */
export function supersededBy(
  incoming: EvidenceClaimRecord,
  existing: readonly EvidenceClaimRecord[],
): EvidenceClaimRecord[] {
  return existing.filter(
    (claim) =>
      !claim.superseded &&
      claim.id !== incoming.id &&
      claim.subjectKey === incoming.subjectKey &&
      claim.factPath === incoming.factPath &&
      claim.sourceId === incoming.sourceId &&
      claim.contentObservedAt <= incoming.contentObservedAt,
  );
}
