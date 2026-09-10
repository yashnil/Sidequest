/**
 * THE TRIP CONTRACT — WHAT IS DECIDED, BY WHOM, AND WHAT THE MODEL MAY NOT
 * OVERRIDE.
 *
 * V6, Traveler Intelligence OS §2. Before Production Lock V5 every planning
 * value carried a *lineage* (`TravelerFact`: explicit, accepted
 * recommendation, smart default, derived, unknown). Lineage says where a value
 * came from. It never said whether the composition call was allowed to
 * replace it — and two real production trips lost their accepted dates on
 * exactly that gap: a "tell me when it is best" window the traveller had
 * pressed *Use this timing* on was composed for another month, because
 * nothing between the press and the model call held the word "locked".
 *
 * The contract is the one place that word lives. Every meaningful input has a
 * value, a source, a confidence, a precision, a lock level, a scope and a
 * timestamp. The lock order is fixed:
 *
 *   BOOKED_LOCK > HARD_LOCK > USER_EXPLICIT > USER_SOFT > SIDEQUEST_INFERRED > MODEL_PROPOSED
 *
 * and the model may never override anything at `user_explicit` or above.
 * When model output contradicts such a fact, the contradicting field is
 * dropped (normalised only when that is deterministic and lossless) and a
 * `ContractConflict` is recorded, so the audit can say what happened. Never
 * the model's value, never silently.
 *
 * This module is pure: types, the lock order, the conflict record and the one
 * deterministic check the composition path needs. Assembly from real product
 * state lives in `apps/web/src/lib/planning/trip-contract.ts`, because that is
 * where the composer answers, the trip row, the profile, the party and the
 * bookings are.
 */

export const CONTRACT_VERSION = 'sidequest-trip-contract/1' as const;

export const LOCK_LEVELS = ['booked_lock', 'hard_lock', 'user_explicit', 'user_soft', 'sidequest_inferred', 'model_proposed'] as const;
export type LockLevel = (typeof LOCK_LEVELS)[number];

/** Higher wins. `booked_lock` is 5, `model_proposed` is 0. */
export function lockRank(level: LockLevel): number {
  return LOCK_LEVELS.length - 1 - LOCK_LEVELS.indexOf(level);
}

/** True when a model proposal may replace a fact held at this level. */
export function modelMayOverride(level: LockLevel): boolean {
  return level === 'sidequest_inferred' || level === 'model_proposed';
}

/** True when the traveller, or their bookings, decided this. Statable as theirs. */
export function isTravellerDecided(level: LockLevel): boolean {
  return level === 'booked_lock' || level === 'hard_lock' || level === 'user_explicit' || level === 'user_soft';
}

export const CONTRACT_SOURCES = ['traveller', 'booking', 'accepted_recommendation', 'sidequest_default', 'sidequest_derived', 'model', 'unknown'] as const;
export type ContractSource = (typeof CONTRACT_SOURCES)[number];

export const CONTRACT_PRECISIONS = ['exact', 'day', 'month', 'season', 'band', 'unstated'] as const;
export type ContractPrecision = (typeof CONTRACT_PRECISIONS)[number];

/** `trip`, `traveler:<id>`, `day:<n>`. */
export type ContractScope = 'trip' | `traveler:${string}` | `day:${number}`;

export interface ContractFact<T> {
  /** Null only when the source is `unknown`. */
  value: T | null;
  source: ContractSource;
  /** 0–1. */
  confidence: number;
  precision: ContractPrecision;
  lock: LockLevel;
  scope: ContractScope;
  /** ISO instant the value was last decided. */
  decidedAt: string;
  /** The contract version the fact was written under. */
  version: typeof CONTRACT_VERSION;
  /** One sentence for everything but a traveller's own explicit answer. */
  reason?: string;
}

export function contractFact<T>(input: {
  value: T | null;
  source: ContractSource;
  lock: LockLevel;
  decidedAt: string;
  precision?: ContractPrecision;
  scope?: ContractScope;
  confidence?: number;
  reason?: string;
}): ContractFact<T> {
  const defaultConfidence =
    input.value === null || input.source === 'unknown'
      ? 0
      : input.source === 'traveller' || input.source === 'booking'
        ? 1
        : input.source === 'accepted_recommendation'
          ? 0.9
          : input.source === 'sidequest_derived'
            ? 0.8
            : input.source === 'model'
              ? 0.5
              : 0.4;
  return {
    value: input.value,
    source: input.source,
    confidence: input.confidence ?? defaultConfidence,
    precision: input.precision ?? (input.value === null ? 'unstated' : 'exact'),
    lock: input.lock,
    scope: input.scope ?? 'trip',
    decidedAt: input.decidedAt,
    version: CONTRACT_VERSION,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

export type TimingMode = 'exact' | 'flexible' | 'month' | 'months' | 'season' | 'window' | 'best_time' | 'undecided';

export interface ContractTiming {
  mode: TimingMode;
  /** True when nobody has decided the window and the composition call is asked to. */
  open: boolean;
  startDate: ContractFact<string>;
  endDate: ContractFact<string>;
  nights: ContractFact<number>;
  /** The lock the two dates share. `model_proposed` only while `open`. */
  lock: LockLevel;
  /** "you chose", "Sidequest chose with the plan", "still open" — always safe to print. */
  decidedBy: 'traveller' | 'sidequest' | 'nobody';
}

export interface ContractPartyMember {
  id: string;
  /** "Me", "Mum", "Ravi" — never a legal name requirement. */
  displayName: string;
  /** Free label such as adult, child, senior; never an inferred demographic. */
  ageGroup?: string;
  /** Per-person dietary requirements, hard. */
  dietary: readonly string[];
  /** Per-person functional needs (the planning-relevant vocabulary in `party/needs.ts`). */
  needs: readonly string[];
  /** The member's own preferences apply to the plan. */
  preferencesApply: boolean;
  /** The member's constraints apply to the plan. */
  constraintsApply: boolean;
}

export interface ContractParty {
  adults: ContractFact<number>;
  children: ContractFact<number>;
  /** Every named member, when the traveller described people rather than counts. */
  members: readonly ContractPartyMember[];
  /** The union of every member's hard dietary rules — the group's kitchen rule. */
  dietaryHard: readonly string[];
  /** The union of every member's functional needs — the group's planning envelope. */
  needs: readonly string[];
}

export interface ContractTransport {
  /** drive / public_transport / mixed / guided_or_transfers / no_preference. */
  preference: ContractFact<string>;
  /** Explicit refusals: "no driving", "no ferries", "no internal flights". */
  prohibitions: readonly ContractFact<string>[];
  maxDailyDriveMinutes: ContractFact<number>;
  maxDailyTravelMinutes: ContractFact<number>;
}

export interface ContractPriority {
  theme: string;
  /** avoid / low / occasional / frequent / core. */
  level: string;
  lock: LockLevel;
}

export interface TripContract {
  version: typeof CONTRACT_VERSION;
  tripId: string;
  assembledAt: string;
  destination: ContractFact<string>;
  timing: ContractTiming;
  party: ContractParty;
  transport: ContractTransport;
  /** Rules the model may not trade away, one sentence each, already in the traveller's words where they gave them. */
  hardConstraints: readonly ContractFact<string>[];
  /** Booked facts, one line each, `booked_lock`. */
  booked: readonly ContractFact<string>[];
  priorities: readonly ContractPriority[];
  /** Everything Sidequest decided on the traveller's behalf, so a screen can say so. */
  assumptions: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Conflicts
 * ------------------------------------------------------------------ */

export const CONTRACT_CONFLICT_RESOLUTIONS = ['contract_kept', 'normalised', 'field_rejected'] as const;
export type ContractConflictResolution = (typeof CONTRACT_CONFLICT_RESOLUTIONS)[number];

/**
 * One audit event: the model (or a later edit) said something a locked fact
 * forbids. Always recorded, never silently resolved in the model's favour.
 */
export interface ContractConflict {
  field: string;
  lock: LockLevel;
  contractValue: string;
  proposedValue: string;
  resolution: ContractConflictResolution;
  /** One sentence a traveller could read. */
  detail: string;
  at: string;
}

export interface ContractEnforcementRecord {
  version: 1;
  contractVersion: typeof CONTRACT_VERSION;
  timingLock: LockLevel;
  timingDecidedBy: ContractTiming['decidedBy'];
  conflicts: ContractConflict[];
  /** How many facts at `user_explicit` or above the contract held. */
  lockedFacts: number;
}

/**
 * THE ONE CHECK THE COMPOSITION PATH NEEDS: A WINDOW THE MODEL RETURNED
 * AGAINST DATES THE TRAVELLER LOCKED.
 *
 * Returns the conflict when the contract holds the dates at `user_explicit`
 * or above and the draft carries a different window. The caller drops the
 * field. A window equal to the contract is not a conflict (the model repeated
 * the dates back, which is harmless), and an open contract has nothing to
 * conflict with.
 */
export function windowConflict(contract: TripContract, window: { startDate: string; endDate: string } | undefined, at: string): ContractConflict | null {
  if (!window) return null;
  const timing = contract.timing;
  if (timing.open || modelMayOverride(timing.lock)) return null;
  const start = timing.startDate.value;
  const end = timing.endDate.value;
  if (!start || !end) return null;
  if (window.startDate === start && window.endDate === end) return null;
  return {
    field: 'timing.window',
    lock: timing.lock,
    contractValue: `${start} → ${end}`,
    proposedValue: `${window.startDate} → ${window.endDate}`,
    resolution: 'field_rejected',
    detail: `The dates were ${timing.decidedBy === 'traveller' ? 'chosen by the traveller' : 'already decided'} (${start} to ${end}); the composition proposed ${window.startDate} to ${window.endDate} and that proposal was set aside.`,
    at,
  };
}

/** Count the facts the model may not override — the audit's "locked facts" figure. */
export function countLockedFacts(contract: TripContract): number {
  const facts: LockLevel[] = [
    contract.destination.lock,
    ...(contract.timing.open ? [] : [contract.timing.lock]),
    contract.party.adults.lock,
    contract.party.children.lock,
    contract.transport.preference.lock,
    contract.transport.maxDailyDriveMinutes.lock,
    ...contract.transport.prohibitions.map((p) => p.lock),
    ...contract.hardConstraints.map((c) => c.lock),
    ...contract.booked.map((b) => b.lock),
  ];
  return facts.filter((lock) => !modelMayOverride(lock)).length;
}

/**
 * The contract in the four bands the composition prompt speaks: MUST KEEP,
 * MUST AVOID, MAY DECIDE, SIDEQUEST WILL VERIFY. Plain sentences, no field
 * names, so the model reads a brief rather than a schema. Rendered once, by
 * `composition.ts`.
 */
export function contractBands(contract: TripContract): { mustKeep: string[]; mustAvoid: string[]; mayDecide: string[]; willVerify: string[] } {
  const mustKeep: string[] = [];
  const mustAvoid: string[] = [];
  const mayDecide: string[] = [];
  const willVerify: string[] = [];

  const t = contract.timing;
  if (!t.open && t.startDate.value && t.endDate.value) {
    mustKeep.push(`The dates: ${t.startDate.value} to ${t.endDate.value} (${t.nights.value ?? '?'} nights), ${t.decidedBy === 'traveller' ? 'chosen by the traveller' : 'already settled'}. Do not return a different window.`);
  } else {
    mayDecide.push('The window: the traveller asked Sidequest to choose when, so choose it with the route (see the timing instructions).');
  }
  const adults = contract.party.adults.value ?? 0;
  const children = contract.party.children.value ?? 0;
  mustKeep.push(`The party: ${adults} adult${adults === 1 ? '' : 's'}${children > 0 ? `, ${children} child${children === 1 ? '' : 'ren'}` : ''}${contract.party.members.length > 0 ? ` — ${contract.party.members.map((m) => m.displayName).join(', ')}` : ''}. Plan for everyone named.`);
  for (const rule of contract.hardConstraints) if (rule.value) mustKeep.push(rule.value);
  for (const fact of contract.booked) if (fact.value) mustKeep.push(`Booked: ${fact.value}`);
  for (const p of contract.transport.prohibitions) if (p.value) mustAvoid.push(p.value);
  if (contract.party.dietaryHard.length > 0) mustAvoid.push(`Any meal that cannot honour: ${contract.party.dietaryHard.join(', ')}.`);
  const drive = contract.transport.maxDailyDriveMinutes;
  if (drive.value !== null && !modelMayOverride(drive.lock)) mustAvoid.push(`More than ${drive.value} minutes at the wheel in a day.`);
  else if (drive.value !== null) mayDecide.push(`Daily driving up to about ${drive.value} minutes is Sidequest's assumption, not the traveller's rule.`);
  for (const p of contract.priorities) {
    if (p.level === 'avoid') mustAvoid.push(`${p.theme} — the traveller asked to avoid it.`);
  }
  mayDecide.push('Route, bases, the order of days, which named experiences, meals and the overnight character — within everything above.');
  willVerify.push('Every named place (identity and coordinates), every road, walk and transit leg (measured where a router covers it), opening hours where published, weather and daylight, and every booked fact against the plan.');
  return { mustKeep, mustAvoid, mayDecide, willVerify };
}
