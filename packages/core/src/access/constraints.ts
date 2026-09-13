import { z } from 'zod';

/**
 * V10 §9 — OPERATIONAL FACTS, EFFECTIVE-DATED AND SOURCED.
 *
 * A plan that schedules a closed canyon or drives a private car to a
 * shuttle-only lake is not a plan with a warning on it; it is wrong. The
 * founder's Canadian Rockies trip did both, and it could not have done
 * otherwise: the only operational evidence the canonical path had was a Google
 * Places *business status*, which cannot express a dated seasonal closure of a
 * public site, cannot express "the only way in is the shuttle", and carries no
 * authority or freshness.
 *
 * An `AccessConstraint` is one claim about one place:
 *
 * - **effective-dated** — `validFrom`/`validUntil`, so "closed for the 2026
 *   season" is a fact about 2026 and not about the place;
 * - **sourced** — who says so, with a URL and the date it was checked;
 * - **statused** — `closed`, `restricted`, `reservation_required`,
 *   `seasonal_closure`, `open`, or `unknown`, and **`unknown` is not `open`**;
 * - **moded** — when a required mode exists (`shuttle`, `ferry`, `guided`,
 *   `permit`), it is a dependency, never a parking note (§22).
 *
 * ## Authority (§9)
 *
 * Only an official park, transport, government or tourism-authority source may
 * *establish* a closure or an access restriction. A crowd or commercial source
 * may raise the question — which is worth doing, because it is usually first —
 * but it produces `unknown` with a note, never a verdict. This mirrors
 * `intelligence/claims.ts#CONFIRMING_AUTHORITY` for entry and visa facts, for
 * exactly the same reason: a plan changed on a bad source is a plan changed
 * wrongly.
 *
 * Nothing here is keyed to a place name. The architecture is generic; the
 * fixtures that carry Moraine Lake and Maligne Canyon are *data*, loaded at the
 * server boundary and passed in.
 */

export const ACCESS_STATUSES = [
  /** Reachable as any traveller would expect. */
  'open',
  /** Not reachable at all in the validity window. A plan may not schedule it. */
  'closed',
  /** Closed for a season, with the window stated. Same consequence inside the window. */
  'seasonal_closure',
  /** Reachable, but not in the obvious way: a required mode, a permit, a quota, a time band. */
  'restricted',
  /** Reachable, and a booking must exist first. */
  'reservation_required',
  /**
   * Somebody raised it and nobody authoritative has answered. Never `open`:
   * it lowers confidence and is said out loud, and it never removes content.
   */
  'unknown',
] as const;
export const accessStatusSchema = z.enum(ACCESS_STATUSES);
export type AccessStatus = z.infer<typeof accessStatusSchema>;

/** Statuses that stop a place being scheduled as an ordinary stop. */
export const BLOCKING_STATUSES: ReadonlySet<AccessStatus> = new Set<AccessStatus>(['closed', 'seasonal_closure']);

export const REQUIRED_ACCESS_MODES = ['shuttle', 'ferry', 'boat', 'guided', 'permit', 'transit', 'foot_only', 'four_wheel_drive'] as const;
export const requiredAccessModeSchema = z.enum(REQUIRED_ACCESS_MODES);
export type RequiredAccessMode = z.infer<typeof requiredAccessModeSchema>;

/**
 * Who is allowed to establish an access claim.
 *
 * `official_current` is a park service, transport operator, government or
 * national tourism authority publishing about its own ground, checked recently.
 * Everything below it may flag, never confirm.
 */
export const ACCESS_SOURCE_AUTHORITIES = ['official_current', 'official_archived', 'operator', 'reference', 'crowd', 'model_knowledge'] as const;
export const accessSourceAuthoritySchema = z.enum(ACCESS_SOURCE_AUTHORITIES);
export type AccessSourceAuthority = z.infer<typeof accessSourceAuthoritySchema>;

/** The only authorities that may establish a closure or a restriction. */
export const CONFIRMING_ACCESS_AUTHORITY: ReadonlySet<AccessSourceAuthority> = new Set<AccessSourceAuthority>(['official_current', 'operator']);

export const accessConstraintSchema = z.object({
  id: z.string().min(1).max(96),
  /** The place this is about, as the traveller or the plan names it. Matched by the caller, never by this module. */
  placeName: z.string().min(1).max(120),
  /** A provider reference for the same place, when one is known, so matching does not have to be by name. */
  placeRef: z.string().min(1).max(160).optional(),
  status: accessStatusSchema,
  /** The only legal way in, when the status is `restricted` and a mode is what restricts it. */
  requiredMode: requiredAccessModeSchema.optional(),
  reservationRequired: z.boolean().default(false),
  /** Inclusive `YYYY-MM-DD`. Absent means "as far as this source says, always". */
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  authority: accessSourceAuthoritySchema,
  sourceName: z.string().min(1).max(160),
  sourceUrl: z.string().url().optional(),
  /** When the claim was last checked against its source. */
  checkedAt: z.string().min(10),
  /** One traveller-readable sentence. No vocabulary, no field names (§19). */
  travellerNote: z.string().min(1).max(240),
  /** What to do instead, when the source says so. */
  alternative: z.string().max(240).optional(),
});
export type AccessConstraint = z.infer<typeof accessConstraintSchema>;

export const ACCESS_DATASET_VERSION = 1 as const;

export const accessConstraintSetSchema = z.object({
  version: z.literal(ACCESS_DATASET_VERSION),
  constraints: z.array(accessConstraintSchema).max(200).default([]),
});
export type AccessConstraintSet = z.infer<typeof accessConstraintSetSchema>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface AccessVerdict {
  status: AccessStatus;
  /** True when the plan may not schedule this place as an ordinary stop on these dates. */
  blocking: boolean;
  /** True when a required mode or reservation makes this a dependency rather than a note. */
  dependency: boolean;
  requiredMode?: RequiredAccessMode;
  reservationRequired: boolean;
  /** The constraints that decided it, strongest authority first. */
  basis: readonly AccessConstraint[];
  /** The sentence a traveller reads. Never a field name. */
  travellerNote: string | null;
  alternative?: string;
}

function overlaps(constraint: AccessConstraint, dates: readonly string[]): boolean {
  if (dates.length === 0) return true;
  const from = constraint.validFrom ?? '0000-01-01';
  const until = constraint.validUntil ?? '9999-12-31';
  return dates.some((date) => date >= from && date <= until);
}

const STATUS_WEIGHT: Record<AccessStatus, number> = {
  closed: 5,
  seasonal_closure: 5,
  restricted: 4,
  reservation_required: 3,
  unknown: 2,
  open: 1,
};

/**
 * What the evidence says about reaching this place on these dates.
 *
 * Two rules do the work. **Authority gates the verdict**: a `crowd` or
 * `model_knowledge` claim of a closure produces `unknown` with the note
 * preserved, because the plan must not be rearranged on it — but the traveller
 * is still told somebody says so. **Unknown is never open**: a place with no
 * constraint at all comes back `unknown` with no note, which callers read as
 * "nothing is known", and a place somebody unofficial flagged comes back
 * `unknown` *with* a note.
 */
export function evaluateAccess(input: {
  constraints: readonly AccessConstraint[];
  placeName: string;
  placeRef?: string | undefined;
  dates: readonly string[];
}): AccessVerdict {
  const key = input.placeName.trim().toLowerCase();
  const matching = input.constraints.filter((c) => {
    if (input.placeRef && c.placeRef && c.placeRef === input.placeRef) return overlaps(c, input.dates);
    const name = c.placeName.trim().toLowerCase();
    if (name !== key && !key.includes(name) && !name.includes(key)) return false;
    return overlaps(c, input.dates);
  });
  if (matching.length === 0) {
    return { status: 'unknown', blocking: false, dependency: false, reservationRequired: false, basis: [], travellerNote: null };
  }
  const sorted = [...matching].sort((a, b) => {
    const authority = Number(CONFIRMING_ACCESS_AUTHORITY.has(b.authority)) - Number(CONFIRMING_ACCESS_AUTHORITY.has(a.authority));
    return authority !== 0 ? authority : STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status];
  });
  const confirming = sorted.filter((c) => CONFIRMING_ACCESS_AUTHORITY.has(c.authority));
  /* Only a confirming source may establish a status. Everything else flags. */
  const decided = confirming.length > 0 ? confirming.reduce((best, c) => (STATUS_WEIGHT[c.status] > STATUS_WEIGHT[best.status] ? c : best)) : null;
  const status: AccessStatus = decided ? decided.status : 'unknown';
  const requiredMode = decided?.requiredMode;
  const reservationRequired = Boolean(decided?.reservationRequired) || Boolean(decided?.requiredMode && decided.status === 'reservation_required');
  const note = decided?.travellerNote ?? sorted[0]!.travellerNote;
  return {
    status,
    blocking: BLOCKING_STATUSES.has(status),
    dependency: Boolean(requiredMode) || reservationRequired || status === 'reservation_required',
    ...(requiredMode ? { requiredMode } : {}),
    reservationRequired,
    basis: sorted,
    travellerNote: note,
    ...(decided?.alternative ? { alternative: decided.alternative } : {}),
  };
}

/**
 * V10 §19 — the sentence, without the machinery.
 *
 * "Moraine Lake requires a shuttle — reserve this", never
 * `access_constraint mode=shuttle`.
 */
export function describeAccess(place: string, verdict: AccessVerdict): string | null {
  if (verdict.status === 'unknown' && !verdict.travellerNote) return null;
  if (verdict.blocking) return `${place} is closed${verdict.alternative ? ` — ${verdict.alternative}` : ''}.`;
  if (verdict.requiredMode) {
    const mode =
      verdict.requiredMode === 'shuttle'
        ? 'requires a shuttle'
        : verdict.requiredMode === 'ferry'
          ? 'is reached by ferry'
          : verdict.requiredMode === 'boat'
            ? 'is reached by boat'
            : verdict.requiredMode === 'guided'
              ? 'has to be visited with a guide'
              : verdict.requiredMode === 'permit'
                ? 'needs a permit'
                : verdict.requiredMode === 'transit'
                  ? 'is reached on public transport'
                  : verdict.requiredMode === 'foot_only'
                    ? 'is reached on foot'
                    : 'needs a high-clearance vehicle';
    return `${place} ${mode}${verdict.reservationRequired ? ' — reserve this' : ''}.`;
  }
  if (verdict.reservationRequired) return `${place} has to be reserved in advance.`;
  return verdict.travellerNote;
}
