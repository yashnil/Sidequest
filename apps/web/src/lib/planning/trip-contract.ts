import 'server-only';
import {
  contractFact,
  countLockedFacts,
  windowConflict,
  type ContractConflict,
  type ContractEnforcementRecord,
  type ContractFact,
  type ContractPartyMember,
  type LockLevel,
  type Trip,
  type TripContract,
  CONTRACT_VERSION,
  INTEREST_LABELS,
} from '@sidequest/core';
import type { CanonicalTripBuildInput, TravelerFact } from './canonical-input';
import type { TripDraft } from './trip-draft';

/**
 * ASSEMBLING THE TRIP CONTRACT FROM REAL PRODUCT STATE.
 *
 * V6 §2. One authoritative record, built once per generation from the
 * canonical build input (which already carries lineage for every planning
 * value), the trip row (which carries the durable timing lock), the booked
 * items and the party. Nothing here is a second reading of the traveller:
 * every lock level is a function of a lineage the input already holds.
 *
 *   explicit / accepted_recommendation  → user_explicit
 *   sidequest_chosen                     → sidequest_inferred (closed, attributed)
 *   smart_default / derived              → sidequest_inferred
 *   unknown                              → model_proposed (the model may decide)
 *   a booked fact                        → booked_lock
 *   a hard rule (diet, accessibility, a
 *   stated refusal)                      → hard_lock
 */

function lockFor<T>(fact: TravelerFact<T>): LockLevel {
  switch (fact.source) {
    case 'explicit':
    case 'accepted_recommendation':
      return 'user_explicit';
    case 'sidequest_chosen':
    case 'smart_default':
    case 'derived':
      return 'sidequest_inferred';
    default:
      return 'model_proposed';
  }
}

function sourceFor<T>(fact: TravelerFact<T>): ContractFact<T>['source'] {
  switch (fact.source) {
    case 'explicit':
      return 'traveller';
    case 'accepted_recommendation':
      return 'accepted_recommendation';
    case 'sidequest_chosen':
      return 'model';
    case 'smart_default':
      return 'sidequest_default';
    case 'derived':
      return 'sidequest_derived';
    default:
      return 'unknown';
  }
}

function fromLineage<T>(fact: TravelerFact<T>, at: string, precision?: ContractFact<T>['precision']): ContractFact<T> {
  return contractFact<T>({
    value: fact.value,
    source: sourceFor(fact),
    lock: lockFor(fact),
    decidedAt: fact.updatedAt || at,
    ...(precision ? { precision } : {}),
    ...(fact.reason ? { reason: fact.reason } : {}),
  });
}

export function buildTripContract(input: {
  trip: Trip;
  input: CanonicalTripBuildInput;
  bookedFacts: readonly string[];
  members?: readonly ContractPartyMember[];
  now: Date;
}): TripContract {
  const at = input.now.toISOString();
  const b = input.input;
  const timing = b.timing;

  /*
   * The row's lock is authoritative for who decided. When the row says
   * `traveler` the dates are `user_explicit` whatever the composer blob says;
   * when it says `sidequest` they are closed but Sidequest's; when it says
   * nothing and the input says open, the model decides.
   */
  const rowLock = input.trip.basics.timingLock;
  const open = timing.sidequestChooses;
  const timingLock: LockLevel = open ? 'model_proposed' : rowLock === 'traveler' ? 'user_explicit' : rowLock === 'sidequest' ? 'sidequest_inferred' : lockFor(timing.startDate);
  const decidedBy: TripContract['timing']['decidedBy'] = open ? 'nobody' : rowLock === 'sidequest' || timing.startDate.source === 'sidequest_chosen' ? 'sidequest' : 'traveller';
  const dateFact = (fact: TravelerFact<string>): ContractFact<string> =>
    contractFact<string>({
      value: fact.value,
      source: open ? 'unknown' : decidedBy === 'sidequest' ? 'model' : sourceFor(fact) === 'unknown' ? 'traveller' : sourceFor(fact),
      lock: timingLock,
      decidedAt: fact.updatedAt || at,
      precision: fact.value ? 'day' : 'unstated',
      ...(fact.reason ? { reason: fact.reason } : {}),
    });

  const members = input.members ?? [];
  const dietaryFromInput = b.party.dietary.filter((r) => r.strictness === 'strict').map((r) => r.label);
  const dietaryHard = [...new Set([...dietaryFromInput, ...members.flatMap((m) => (m.constraintsApply ? m.dietary : []))])];
  const needs = [...new Set([...(b.party.mobilityLimited ? ['limited_walking'] : []), ...(b.party.altitudeSensitive ? ['altitude_sensitive'] : []), ...members.flatMap((m) => (m.constraintsApply ? m.needs : []))])];

  const hardConstraints: ContractFact<string>[] = [];
  const hard = (value: string, lock: LockLevel = 'hard_lock', reason?: string) => hardConstraints.push(contractFact<string>({ value, source: 'traveller', lock, decidedAt: at, ...(reason ? { reason } : {}) }));
  if (dietaryHard.length > 0) hard(`Dietary rules are absolute for the whole party: ${dietaryHard.join(', ')}.`);
  if (b.party.mobilityLimited) hard('Someone in the party has limited mobility; nothing strenuous or step-heavy is assumed to be fine.');
  if (b.party.altitudeSensitive) hard('Someone in the party is sensitive to altitude; high-elevation days need easing and a way out.');
  if (b.party.mobilityNotes.trim()) hard(`In their words about mobility: "${b.party.mobilityNotes.trim()}"`);
  for (const member of members) {
    if (!member.constraintsApply) continue;
    for (const need of member.needs) hard(`${member.displayName}: ${need.replace(/_/g, ' ')}.`, 'hard_lock', `Stated for ${member.displayName}.`);
    for (const rule of member.dietary) hard(`${member.displayName} cannot eat: ${rule}.`, 'hard_lock', `Stated for ${member.displayName}.`);
  }

  /*
   * A prohibition is a lock only when the traveller said it. A default or a
   * derived preference travels as `sidequest_inferred`, which the model may
   * override and the feasibility report does not treat as a contradiction.
   */
  const prohibitions: ContractFact<string>[] = [];
  const stated = b.movement.preferenceExplicit;
  if (!b.movement.carAvailable && b.movement.preference === 'public_transport') prohibitions.push(contractFact({ value: 'No self-driving: the traveller will not be at the wheel.', source: stated ? 'traveller' : 'sidequest_default', lock: stated ? 'user_explicit' : 'sidequest_inferred', decidedAt: at }));
  if (!b.movement.willUseShuttlesAndFerries && b.profile.interview.boatsAndFerries === 'cannot') prohibitions.push(contractFact({ value: 'No ferries or boats as a required leg.', source: 'traveller', lock: 'user_explicit', decidedAt: at }));
  if (!b.movement.comfortableMountainRoads && b.movement.carAvailable) prohibitions.push(contractFact({ value: 'No mountain-pass driving with the traveller at the wheel.', source: 'traveller', lock: 'user_soft', decidedAt: at }));
  if (!b.movement.comfortableUnpavedRoads && b.movement.carAvailable) prohibitions.push(contractFact({ value: 'No unpaved or gravel driving with the traveller at the wheel.', source: 'traveller', lock: 'user_soft', decidedAt: at }));

  const priorities = b.priorities.map((p) => ({ theme: INTEREST_LABELS[p.interest] ?? p.interest, level: p.level, lock: (p.explicit ? 'user_explicit' : 'sidequest_inferred') as LockLevel }));
  const avoided = (Object.entries(b.profile.interests) as [string, string][]).filter(([, level]) => level === 'avoid').map(([interest]) => ({ theme: INTEREST_LABELS[interest as keyof typeof INTEREST_LABELS] ?? interest, level: 'avoid', lock: 'user_explicit' as LockLevel }));

  const assumptions: string[] = [];
  if (timing.sidequestChooses) assumptions.push('The window is open; the composition chooses it.');
  if (b.movement.maxDailyDriveMinutes.source === 'smart_default') assumptions.push(`Daily driving ceiling of ${b.movement.maxDailyDriveMinutes.value} minutes is Sidequest's default.`);
  if (b.movement.desiredBaseCount.source === 'smart_default') assumptions.push(`About ${b.movement.desiredBaseCount.value} base(s) is Sidequest's read of the trip length.`);

  return {
    version: CONTRACT_VERSION,
    tripId: input.trip.id,
    assembledAt: at,
    destination: contractFact({ value: b.destinationPhrase || input.trip.basics.destinationInput, source: 'traveller', lock: 'user_explicit', decidedAt: at, precision: 'unstated' }),
    timing: {
      mode: timing.mode,
      open,
      startDate: dateFact(timing.startDate),
      endDate: dateFact(timing.endDate),
      nights: fromLineage(b.nights, at, 'exact'),
      lock: timingLock,
      decidedBy,
    },
    party: {
      adults: contractFact({ value: b.party.adults, source: 'traveller', lock: 'user_explicit', decidedAt: at }),
      children: contractFact({ value: b.party.children, source: 'traveller', lock: 'user_explicit', decidedAt: at }),
      members,
      dietaryHard,
      needs,
    },
    transport: {
      preference: contractFact({ value: b.movement.preference, source: b.movement.preference === 'no_preference' ? 'unknown' : 'traveller', lock: b.movement.preference === 'no_preference' ? 'model_proposed' : 'user_explicit', decidedAt: at }),
      prohibitions,
      maxDailyDriveMinutes: fromLineage(b.movement.maxDailyDriveMinutes, at, 'band'),
      maxDailyTravelMinutes: fromLineage(b.movement.maxDailyTravelMinutes, at, 'band'),
    },
    hardConstraints,
    booked: input.bookedFacts.map((line) => contractFact({ value: line, source: 'booking', lock: 'booked_lock', decidedAt: at })),
    priorities: [...priorities, ...avoided],
    assumptions,
  };
}

/**
 * ENFORCE THE CONTRACT ON A DRAFT, BEFORE ANYTHING ADOPTS IT.
 *
 * Deterministic and lossless: the only field this touches is `window`, which
 * is a proposal the model was told not to make when the dates are locked. A
 * locked contract with a differing window drops the window and, when the
 * timing rationale names a different month, the rationale too — prose about a
 * decision that did not take effect is strictly worse than no prose. Every
 * removal is a recorded conflict; nothing is ever resolved in the model's
 * favour.
 */
export function enforceContractOnDraft(contract: TripContract, draft: TripDraft, now: Date): { draft: TripDraft; conflicts: ContractConflict[] } {
  const at = now.toISOString();
  const conflicts: ContractConflict[] = [];
  let next = draft;
  const conflict = windowConflict(contract, draft.window, at);
  if (conflict) {
    conflicts.push(conflict);
    const { window: _dropped, timingRationale, ...rest } = next;
    void _dropped;
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const contractMonth = contract.timing.startDate.value ? monthNames[Number(contract.timing.startDate.value.slice(5, 7)) - 1] : null;
    const rationaleNamesOtherMonth = timingRationale ? monthNames.some((m) => m !== contractMonth && new RegExp(`\\b${m}\\b`, 'i').test(timingRationale)) : false;
    next = { ...rest, ...(timingRationale && !rationaleNamesOtherMonth ? { timingRationale } : {}) } as TripDraft;
    if (timingRationale && rationaleNamesOtherMonth) {
      conflicts.push({
        field: 'timingRationale',
        lock: contract.timing.lock,
        contractValue: `${contract.timing.startDate.value} → ${contract.timing.endDate.value}`,
        proposedValue: timingRationale.slice(0, 120),
        resolution: 'field_rejected',
        detail: 'The composition explained a window the trip is not in; that explanation was set aside with the window.',
        at,
      });
    }
  }
  const nights = contract.timing.nights.value;
  if (nights !== null && draft.days.length !== nights + 1) {
    conflicts.push({
      field: 'days.length',
      lock: contract.timing.nights.lock,
      contractValue: `${nights + 1} days`,
      proposedValue: `${draft.days.length} days`,
      resolution: 'contract_kept',
      detail: `The trip is ${nights} nights; the composition wrote ${draft.days.length} day(s). The structural repair below keeps the trip's length.`,
      at,
    });
  }
  return { draft: next, conflicts };
}

export function contractEnforcementRecord(contract: TripContract, conflicts: readonly ContractConflict[]): ContractEnforcementRecord {
  return {
    version: 1,
    contractVersion: contract.version,
    timingLock: contract.timing.lock,
    timingDecidedBy: contract.timing.decidedBy,
    conflicts: [...conflicts],
    lockedFacts: countLockedFacts(contract),
  };
}
