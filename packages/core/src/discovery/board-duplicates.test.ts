import { describe, expect, it } from 'vitest';
import type { Place } from '../schemas/place';
import { buildDiscoveryBoard } from './board';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '../testing/fixtures';

/**
 * THE SAME SUBJECT, ARRIVING TWICE, ON THE PRIMARY DISCOVERY SURFACE.
 *
 * A live Tokyo board carried four cards for two places:
 *
 *   東京ディズニーシー                    "An amusement park in 浦安市."
 *   東京ディズニーシー                    "A water park in 浦安市."
 *   東京ディズニーランド                  "An amusement park in 浦安市."
 *   東京ディズニーランド/Tokyo Disney Land "An amusement park in 浦安市."
 *
 * — all four in one group, with the integrity block above them reporting
 * `offered: 24, admitted: 24, refused: []`. A large site is mapped as several
 * features a kilometre or so apart, and the compiler's `dedupeCandidates` is
 * deliberately conservative (same name within 120 m) because *it* merges
 * records and a wrong merge deletes a place.
 *
 * The board had its own, non-destructive answer all along and never used it:
 * `duplicate` produces the `redundant` quality outcome, which the admission
 * gate already excludes, and the board passed it a hardcoded `false`.
 *
 * Driven through the real `buildDiscoveryBoard` over the authored region with
 * repeats spliced into its place list, so what is under test is the board's own
 * admission and not a helper.
 */

function boardOver(extra: readonly Place[]) {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ travelerNeeds: [], tripDays: 4 }));
  const base = boardContext(AUGUST_DATES);
  return buildDiscoveryBoard({
    ...base,
    places: [...base.places, ...extra],
    profile: built,
    travelerNeeds: [],
  });
}

/** A copy of a real place from the fixture, under a new id. */
function copyOf(source: Place, id: string, overrides: Partial<Place> = {}): Place {
  return { ...source, id, ...overrides };
}

const ORIGINAL = boardContext(AUGUST_DATES).places[0]!;

function names(board: ReturnType<typeof boardOver>): string[] {
  return board.candidates.map((candidate) => candidate.place.name);
}

describe('a board asked to show one place twice', () => {
  it('shows the fixture place exactly once to begin with', () => {
    /* The witness: without this the counts below prove nothing. */
    const board = boardOver([]);
    expect(names(board).filter((name) => name === ORIGINAL.name)).toHaveLength(1);
  });

  it('admits one card when a second record carries the same name', () => {
    const board = boardOver([
      copyOf(ORIGINAL, 'duplicate-same-name', {
        shortDescription: 'A second record for the same subject, from another sweep.',
        coordinates: { lat: ORIGINAL.coordinates.lat + 0.01, lng: ORIGINAL.coordinates.lng + 0.01 },
      }),
    ]);
    expect(names(board).filter((name) => name === ORIGINAL.name)).toHaveLength(1);
  });

  it('recognises the Local/English form as the same subject', () => {
    /*
     * The pair the exact-name rule missed: one catalogue carries both readings
     * of a name in one field, separated by a slash.
     */
    const board = boardOver([
      copyOf(ORIGINAL, 'duplicate-bilingual', {
        name: `${ORIGINAL.name}/${ORIGINAL.name} in English`,
        shortDescription: 'The same subject again, carrying both readings of its name.',
      }),
    ]);
    const shown = names(board).filter((name) => name.startsWith(ORIGINAL.name));
    expect(shown).toHaveLength(1);
  });

  it('says so in the integrity block rather than silently shrinking', () => {
    /*
     * The block above the cards reported `offered: 24, admitted: 24,
     * refused: []` over a board holding four cards for two places. A refusal
     * nobody records is indistinguishable from a board that never saw the
     * record.
     */
    const board = boardOver([
      copyOf(ORIGINAL, 'duplicate-counted', {
        shortDescription: 'A second record for the same subject, from another sweep.',
      }),
    ]);
    const refusal = board.integrity.refused.find((entry) => entry.refusal === 'duplicate_subject');
    expect(refusal?.count).toBe(1);
    expect(board.integrity.offered).toBeGreaterThan(board.integrity.admitted);
  });

  it('leaves two genuinely different places alone', () => {
    /*
     * The control, and the thing this must not spend. A near-identical record
     * under a different name is a different place and keeps its card.
     */
    const board = boardOver([
      copyOf(ORIGINAL, 'not-a-duplicate', {
        name: `${ORIGINAL.name} Overlook`,
        shortDescription: 'A different subject that happens to sit beside the first.',
      }),
    ]);
    expect(names(board)).toContain(ORIGINAL.name);
    expect(names(board)).toContain(`${ORIGINAL.name} Overlook`);
  });
});
