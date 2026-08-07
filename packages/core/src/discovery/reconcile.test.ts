import { describe, expect, it } from 'vitest';
import { reconcileBoard } from './reconcile';
import {
  RECONCILE_OUTCOMES,
  RECONCILE_OUTCOME_COPY,
  RECONCILE_REASON_COPY,
  STAGE_FOR_OUTCOME,
  UNNAMED_ENTRY_COPY,
  boardReconciliationSchema,
  detailExplains,
  isLoss,
  isRemoval,
  pinnedRemovals,
  hasChanges,
  unacknowledged,
  type BoardAcknowledgements,
  type ReconciliationBasis,
} from '../schemas/reconciliation';
import {
  PROVISIONAL_BOARD_VERSION,
  type ProvisionalBoard,
  type ProvisionalCard,
  type ProvisionalIntent,
  type ProvisionalSelection,
} from '../schemas/provisional';

const NOW = new Date('2026-08-03T00:00:00Z');

function card(id: string, overrides: Partial<ProvisionalCard> = {}): ProvisionalCard {
  return {
    placeId: id,
    name: `Place ${id}`,
    locality: 'Somewhere',
    category: 'museum',
    role: 'attraction',
    sourceCategory: 'museum',
    coordinates: { lat: 40, lng: 10 },
    clusterId: 'area-1',
    clusterName: 'Area One',
    nearestBaseId: 'base-1',
    nearestBaseName: 'Base One',
    preliminaryFit: 0.6,
    matchedInterests: [],
    matchedPreferences: [],
    presence: 'single_source',
    sources: ['test'],
    mergedFromCount: 0,
    group: 'nearby_side_quests',
    pending: ['travel_time'],
    evidence: 'provisional',
    ...overrides,
  };
}

function board(cards: ProvisionalCard[], version = 1): ProvisionalBoard {
  return {
    schemaVersion: PROVISIONAL_BOARD_VERSION,
    id: `board-${version}`,
    tripId: 'trip-1',
    jobId: 'job-1',
    scopeFingerprint: 'fp',
    version,
    cards,
    clusters: [
      { id: 'area-1', name: 'Area One', baseId: 'base-1', baseName: 'Base One', cardCount: cards.length },
    ],
    counts: {
      discovered: cards.length,
      deduped: cards.length,
      shortlisted: cards.length,
      retained: cards.length,
      droppedThin: 0,
      droppedNoAccessRule: 0,
      droppedUtilityRole: 0,
    },
    byRole: [{ role: 'attraction', count: cards.length }],
    estimated: true,
    verifiedClaimCount: 0,
    travelTimesMeasured: false,
    builtAt: NOW.toISOString(),
  };
}

function picks(entries: [string, ProvisionalIntent][]): ProvisionalSelection[] {
  return entries.map(([placeId, intent]) => ({
    placeId,
    intent,
    updatedAt: NOW.toISOString(),
  }));
}

function basis(overrides: Partial<ReconciliationBasis> = {}): ReconciliationBasis {
  return { removals: [], duplicates: [], changedPlaceIds: [], ...overrides };
}

describe('reconciling a provisional board', () => {
  /**
   * The defect this exists to prevent, stated as a test.
   *
   * `resolveCandidates` iterates the *board* and looks each selection up inside
   * it, so a selection whose place left the board is never visited — it appears
   * in neither the scheduled list nor the rejected one, despite that function's
   * own comment promising there is no such third outcome.
   */
  it('accounts for every selection, including the ones that vanished', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b'), card('c')]),
      selections: picks([
        ['a', 'interested'],
        ['b', 'pinned'],
        ['c', 'interested'],
      ]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries).toHaveLength(3);
    expect(new Set(result.entries.map((entry) => entry.placeId))).toEqual(new Set(['a', 'b', 'c']));
    expect(result.entries.find((entry) => entry.placeId === 'a')!.outcome).toBe('retained');
    expect(isRemoval(result.entries.find((entry) => entry.placeId === 'b')!.outcome)).toBe(true);
  });

  it('carries the traveller’s own intent through untouched', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'not_interested'],
      ]),
      finalPlaceIds: new Set(['a', 'b']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries.find((entry) => entry.placeId === 'a')!.intent).toBe('pinned');
    expect(result.entries.find((entry) => entry.placeId === 'b')!.intent).toBe('not_interested');
  });

  /**
   * Offered, never applied. Choosing a replacement while somebody is not looking
   * is how a plan comes to hold a place they never agreed to.
   */
  it('suggests an alternative for a pinned removal, and only for a pinned one', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b', { preliminaryFit: 0.9 }), card('c', { preliminaryFit: 0.4 })]),
      selections: picks([
        ['a', 'pinned'],
        ['c', 'interested'],
      ]),
      finalPlaceIds: new Set(['b']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const pinned = result.entries.find((entry) => entry.placeId === 'a')!;
    expect(pinned.suggestedPlaceId).toBe('b');
    expect(pinned.suggestedName).toBe('Place b');

    const merelyInterested = result.entries.find((entry) => entry.placeId === 'c')!;
    expect(merelyInterested.suggestedPlaceId).toBeUndefined();
  });

  it('never suggests something from another area or another role', () => {
    const result = reconcileBoard({
      board: board([
        card('a', { role: 'outdoor' }),
        card('elsewhere', { clusterId: 'area-2', preliminaryFit: 1 }),
        card('wrong-role', { role: 'food', preliminaryFit: 1 }),
      ]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(['elsewhere', 'wrong-role']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries[0]!.suggestedPlaceId).toBeUndefined();
  });

  it('reports what arrived as well as what left', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['a', 'interested']]),
      finalPlaceIds: new Set(['a', 'new-one']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.addedPlaceIds).toEqual(['new-one']);
  });

  it('is deterministic, and puts removals where somebody will read them', () => {
    const input = {
      board: board([card('a'), card('b'), card('c')]),
      selections: picks([
        ['a', 'interested'] as [string, ProvisionalIntent],
        ['b', 'pinned'] as [string, ProvisionalIntent],
        ['c', 'pinned'] as [string, ProvisionalIntent],
      ]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    };
    const first = reconcileBoard(input);
    expect(reconcileBoard(input)).toEqual(first);
    expect(isRemoval(first.entries[0]!.outcome)).toBe(true);
    expect(first.entries[first.entries.length - 1]!.outcome).toBe('retained');
  });

  it('says plainly when nothing changed', () => {
    const unchanged = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['a', 'interested']]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    });
    expect(hasChanges(unchanged)).toBe(false);
    expect(pinnedRemovals(unchanged)).toEqual([]);
  });

  it('surfaces the pinned removals separately, because they cost the most', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'interested'],
      ]),
      finalPlaceIds: new Set(),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(pinnedRemovals(result).map((entry) => entry.placeId)).toEqual(['a']);
    expect(hasChanges(result)).toBe(true);
  });

  /**
   * THE REGRESSION TEST. It fails against the behaviour this replaced.
   *
   * `reconcileBoard` used to `continue` past a selection whose card was not on
   * the board — "there is nothing truthful to say about a card nobody can be
   * shown". That reasoning is wrong twice over. A board is superseded on every
   * rebuild, so the case is routine rather than exotic; and the traveller is not
   * asking to be shown a card, they are asking what became of a decision they
   * made. "We no longer have a record of it" is a truthful answer. Silence is
   * not, and silence is exactly the defect the whole module exists to prevent.
   */
  it('reports a choice about a card this board no longer holds, rather than dropping it', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([
        ['a', 'interested'],
        ['from-an-older-board', 'pinned'],
      ]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries).toHaveLength(2);
    const lost = result.entries.find((entry) => entry.placeId === 'from-an-older-board')!;
    expect(lost.outcome).toBe('disappeared_unexpectedly');
    expect(lost.reasonCode).toBe('not_present_on_this_board');
    expect(lost.intent).toBe('pinned');
    expect(lost.acknowledgementRequired).toBe(true);
    expect(lost.explanation.length).toBeGreaterThan(0);
  });

  /**
   * The second half of the same silent loss. `interested`, `hidden` and
   * `not_interested` are decisions too, and a "not for me" that was quietly
   * forgotten is how somebody ends up being offered the same place twice.
   */
  it('keeps every kind of decision in the history, not only the ones it kept', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b'), card('c'), card('d')]),
      selections: picks([
        ['a', 'interested'],
        ['b', 'pinned'],
        ['c', 'not_interested'],
        ['d', 'hidden'],
      ]),
      finalPlaceIds: new Set(['a', 'b']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries.map((entry) => entry.placeId).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.entries.find((entry) => entry.placeId === 'c')!.intent).toBe('not_interested');
    expect(result.entries.find((entry) => entry.placeId === 'd')!.outcome).toBe(
      'removed_insufficient_support',
    );
  });

  it('names the identity that actually reached the plan, and only a real one', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b'), card('c')]),
      selections: picks([
        ['a', 'interested'],
        ['b', 'interested'],
        ['c', 'interested'],
      ]),
      finalPlaceIds: new Set(['a', 'b']),
      basis: basis({ duplicates: [{ placeId: 'b', survivorPlaceId: 'a' }] }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries.find((entry) => entry.placeId === 'a')!.finalPlaceId).toBe('a');
    // The duplicate's surviving identity, not its own.
    expect(result.entries.find((entry) => entry.placeId === 'b')!.finalPlaceId).toBe('a');
    // A loss carries none rather than echoing back the id that did not make it.
    expect(result.entries.find((entry) => entry.placeId === 'c')!.finalPlaceId).toBeUndefined();
  });

  /**
   * Acknowledgement is demanded for a pinned loss and nothing else. Demanding it
   * everywhere would make it furniture, and a checkbox nobody reads converts "we
   * told them" from a fact into a formality.
   */
  it('requires acknowledgement for a pinned loss and for nothing else', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b'), card('c')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'interested'],
        ['c', 'pinned'],
      ]),
      finalPlaceIds: new Set(['c']),
      basis: basis({ removals: [{ placeId: 'a', outcome: 'removed_closed' }] }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const required = result.entries.filter((entry) => entry.acknowledgementRequired);
    expect(required.map((entry) => entry.placeId)).toEqual(['a']);

    expect(unacknowledged(result, null)).toHaveLength(1);

    const acknowledged: BoardAcknowledgements = {
      tripId: 'trip-1',
      compiledRegionId: 'region-1',
      entries: [{ placeId: 'a', outcome: 'removed_closed', acknowledgedAt: NOW.toISOString() }],
    };
    expect(unacknowledged(result, acknowledged)).toHaveLength(0);

    /*
     * An acknowledgement from a previous compilation does not carry forward.
     * Otherwise a rebuild could suppress its own bad news.
     */
    expect(
      unacknowledged(result, { ...acknowledged, compiledRegionId: 'region-0' }),
    ).toHaveLength(1);
  });

  it('offers alternatives with a stated basis, capped, never applied', () => {
    const result = reconcileBoard({
      board: board([
        card('a'),
        card('b', { preliminaryFit: 0.9 }),
        card('c', { preliminaryFit: 0.8 }),
        card('d', { preliminaryFit: 0.7 }),
        card('e', { preliminaryFit: 0.6 }),
      ]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(['b', 'c', 'd', 'e']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const pinned = result.entries[0]!;
    expect(pinned.alternatives.map((entry) => entry.placeId)).toEqual(['b', 'c', 'd']);
    expect(pinned.alternatives.every((entry) => entry.basis === 'same_area_same_role')).toBe(true);
    // Offered, not applied: nothing about the entry claims a replacement.
    expect(pinned.replacedByPlaceId).toBeUndefined();
    expect(pinned.finalPlaceId).toBeUndefined();
  });

  it('produces something the stored schema will accept', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'hidden'],
      ]),
      finalPlaceIds: new Set(['b']),
      basis: basis({
        removals: [
          {
            placeId: 'a',
            outcome: 'unresolved_verification_failed',
            detail: 'Two sources disagree.',
            detailStage: 'evidence',
          },
        ],
      }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(boardReconciliationSchema.parse(result)).toEqual(result);
    expect(result.provisionalBoardVersion).toBe(1);
    expect(result.entries[0]!.detail).toBe('Two sources disagree.');
  });
});

// ---------------------------------------------------------------------------
// B-2 — the board version is a fact about the mark, not about the check
// ---------------------------------------------------------------------------

describe('which board a choice was made on', () => {
  /**
   * The exact failure the field was added to prevent, and the one the first two
   * slices shipped: `provisionalBoardVersion` was stamped from `board.version` —
   * the board being reconciled *against* — so a mark made on v2 was recorded as
   * a mark on v3 and its removal was blamed on a board the traveller never saw.
   */
  it('records the version the mark was made on, not the version it was checked against', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')], 3),
      selections: [
        { placeId: 'a', intent: 'pinned', updatedAt: NOW.toISOString(), boardId: 'board-2', boardVersion: 2 },
        { placeId: 'b', intent: 'interested', updatedAt: NOW.toISOString(), boardId: 'board-3', boardVersion: 3 },
      ],
      finalPlaceIds: new Set(['a', 'b']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const madeOnTwo = result.entries.find((entry) => entry.placeId === 'a')!;
    expect(madeOnTwo.provisionalBoardVersion).toBe(2);
    expect(madeOnTwo.provisionalBoardId).toBe('board-2');

    const madeOnThree = result.entries.find((entry) => entry.placeId === 'b')!;
    expect(madeOnThree.provisionalBoardVersion).toBe(3);

    // The account as a whole still names the board it was checked against.
    expect(result.provisionalBoardVersion).toBe(3);
    expect(result.provisionalBoardId).toBe('board-3');
  });

  /**
   * A mark recorded before board identity was carried has no board. Filling in
   * "1" would assert it was made on the first board, which nobody knows — and
   * inventing the field is precisely what the field exists to stop.
   */
  it('leaves the board absent rather than guessing version 1', () => {
    const result = reconcileBoard({
      board: board([card('a')], 4),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries[0]!.provisionalBoardVersion).toBeUndefined();
    expect(result.entries[0]!.provisionalBoardId).toBeUndefined();
    expect(boardReconciliationSchema.parse(result)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// B-4 — a safety block is not a closure
// ---------------------------------------------------------------------------

describe('the outcome vocabulary', () => {
  /**
   * The evidence layer blocks a subject for a closure *or* for a safety notice,
   * and both used to arrive as `removed_closed` — "an official source says it is
   * shut on your dates". For a flood warning that is a false statement about the
   * world, and the traveller who acts on it goes back next week to a place that
   * was open the whole time.
   */
  it('gives a blocking safety advisory its own outcome, reason and sentence', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'pinned'],
      ]),
      finalPlaceIds: new Set(),
      basis: basis({
        removals: [
          { placeId: 'a', outcome: 'removed_closed' },
          { placeId: 'b', outcome: 'removed_safety_blocked' },
        ],
      }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const closed = result.entries.find((entry) => entry.placeId === 'a')!;
    const unsafe = result.entries.find((entry) => entry.placeId === 'b')!;

    expect(closed.reasonCode).toBe('closed_on_trip_dates');
    expect(unsafe.reasonCode).toBe('safety_advisory_blocks');
    expect(unsafe.explanation).not.toBe(closed.explanation);
    // It says the opposite of the sentence it used to be given.
    expect(closed.explanation).toMatch(/shut on your dates/i);
    expect(unsafe.explanation).toMatch(/not shut/i);
    expect(RECONCILE_REASON_COPY[unsafe.reasonCode]).not.toBe(
      RECONCILE_REASON_COPY[closed.reasonCode],
    );
    expect(isLoss(unsafe.outcome)).toBe(true);
  });

  it('has copy and a cause for every outcome, so a new one cannot ship silently', () => {
    for (const outcome of RECONCILE_OUTCOMES) {
      expect(RECONCILE_OUTCOME_COPY[outcome]?.length ?? 0).toBeGreaterThan(0);
      expect(outcome in STAGE_FOR_OUTCOME).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// B-5 — the outcome sentence is never displaced, and a detail must be earned
// ---------------------------------------------------------------------------

describe('the sentence a traveller reads', () => {
  /**
   * `explanation` was `detail ?? outcomeCopy`, so a compiler sentence replaced
   * the statement of what happened. Somebody whose pinned lake was unreachable
   * could be shown "we could not establish what it costs" with nothing anywhere
   * saying the place had been dropped.
   */
  it('always carries the outcome sentence, with the stage’s sentence beside it', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(),
      basis: basis({
        removals: [
          {
            placeId: 'a',
            outcome: 'removed_closed',
            detail: 'The road is gated until June.',
            detailStage: 'availability',
          },
        ],
      }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const entry = result.entries[0]!;
    expect(entry.explanation).toBe(RECONCILE_OUTCOME_COPY.removed_closed);
    expect(entry.detail).toBe('The road is gated until June.');
    expect(entry.detailStage).toBe('availability');
  });

  /**
   * The compiler records a gap per subject per stage. Attaching one from the
   * evidence stage to a routing removal is a specific claim about the wrong
   * cause — more convincing than the generic sentence, and false.
   */
  it('refuses a sentence from a stage that did not cause the removal', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(),
      basis: basis({
        removals: [
          {
            placeId: 'a',
            outcome: 'removed_unreachable',
            detail: 'We could not establish what it costs.',
            detailStage: 'evidence',
          },
        ],
      }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const entry = result.entries[0]!;
    expect(entry.detail).toBeUndefined();
    expect(entry.explanation).toBe(RECONCILE_OUTCOME_COPY.removed_unreachable);
  });

  it('refuses a sentence with no stage attached at all', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(),
      basis: basis({
        removals: [{ placeId: 'a', outcome: 'removed_unreachable', detail: 'Something happened.' }],
      }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries[0]!.detail).toBeUndefined();
  });

  it('is explicit about which stage explains which outcome', () => {
    expect(detailExplains('removed_closed', 'availability')).toBe(true);
    expect(detailExplains('removed_closed', 'routing')).toBe(false);
    expect(detailExplains('removed_closed', undefined)).toBe(false);
    expect(detailExplains('removed_safety_blocked', 'safety')).toBe(true);
    expect(detailExplains('retained', 'evidence')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B-6 — changed cards, and never a raw identity where a name goes
// ---------------------------------------------------------------------------

describe('what a card is called and whether it moved', () => {
  it('says so when something survived with its details changed', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([
        ['a', 'pinned'],
        ['b', 'pinned'],
      ]),
      finalPlaceIds: new Set(['a', 'b']),
      basis: basis({ changedPlaceIds: ['b'] }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries.find((entry) => entry.placeId === 'a')!.outcome).toBe('retained');
    const changed = result.entries.find((entry) => entry.placeId === 'b')!;
    expect(changed.outcome).toBe('retained_with_changes');
    expect(changed.reasonCode).toBe('details_changed');
    expect(changed.acknowledgementRequired).toBe(false);
  });

  it('takes a name from the final board when this board version has none', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([['superseded-card', 'pinned']]),
      finalPlaceIds: new Set(['a']),
      namesById: new Map([['superseded-card', 'The Old Lighthouse']]),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries.find((entry) => entry.placeId === 'superseded-card')!.name).toBe(
      'The Old Lighthouse',
    );
  });

  /**
   * `place/osm/way/128374` rendered where a name goes is not a fallback, it is a
   * leak. It tells the traveller nothing and it looks like a bug in the one
   * panel whose whole job is to be believed.
   */
  it('never renders a raw identity as a name', () => {
    const result = reconcileBoard({
      board: board([card('a')]),
      selections: picks([
        ['a', 'interested'],
        ['place/osm/way/128374', 'pinned'],
      ]),
      finalPlaceIds: new Set(['a']),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    for (const entry of result.entries) {
      expect(entry.name).not.toBe(entry.placeId);
    }
    expect(result.entries.find((entry) => entry.placeId === 'place/osm/way/128374')!.name).toBe(
      UNNAMED_ENTRY_COPY,
    );
  });
});

// ---------------------------------------------------------------------------
// B-8 — a named survivor has to have survived
// ---------------------------------------------------------------------------

describe('duplicates', () => {
  it('names a duplicate’s survivor when that survivor reached the plan', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([['a', 'interested']]),
      finalPlaceIds: new Set(['b']),
      basis: basis({ duplicates: [{ placeId: 'a', survivorPlaceId: 'b' }] }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    expect(result.entries[0]!.outcome).toBe('replaced_duplicate');
    expect(result.entries[0]!.replacedByPlaceId).toBe('b');
    expect(result.entries[0]!.replacedByName).toBe('Place b');
  });

  /**
   * THE INVERTED ASSERTION. Two tests used to pin the wrong behaviour: a
   * duplicate mapping alone produced `replaced_duplicate` and a `replacedByName`
   * regardless of whether the survivor was on the final board. Vacuous while
   * deduplication runs before the cut — and a lie the day it does not, or the
   * day the survivor is itself removed for being shut.
   */
  it('does not claim a survivor that is not on the final board', () => {
    const result = reconcileBoard({
      board: board([card('a'), card('b')]),
      selections: picks([['a', 'pinned']]),
      finalPlaceIds: new Set(),
      basis: basis({ duplicates: [{ placeId: 'a', survivorPlaceId: 'b' }] }),
      compiledRegionId: 'region-1',
      now: NOW,
    });

    const entry = result.entries[0]!;
    expect(entry.outcome).toBe('removed_duplicate_survivor_lost');
    expect(entry.reasonCode).toBe('duplicate_survivor_lost');
    expect(entry.replacedByPlaceId).toBeUndefined();
    expect(entry.replacedByName).toBeUndefined();
    expect(entry.finalPlaceId).toBeUndefined();
    expect(isLoss(entry.outcome)).toBe(true);
    // A pinned loss, so it demands acknowledgement like every other one.
    expect(entry.acknowledgementRequired).toBe(true);
    expect(RECONCILE_REASON_COPY[entry.reasonCode].length).toBeGreaterThan(0);
  });
});
