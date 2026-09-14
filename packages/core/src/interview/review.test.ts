import { describe, expect, it } from 'vitest';
import { reviewGlance, reviewShapers, type ReviewEntry, type ReviewLedger } from './review';


/**
 * V11 §H — the review screen states what will shape the route, not the interview.
 */
describe('V11 §H — what will shape the route', () => {
  function ledgerOf(entries: { questionId: string; label: string; value: string; source: 'explicit' | 'inferred' }[]): ReviewLedger {
    const told = entries.filter((entry) => entry.source === 'explicit').map((entry) => ({ ...entry, reason: 'you said so' }) as ReviewEntry);
    const assumed = entries.filter((entry) => entry.source !== 'explicit').map((entry) => ({ ...entry, reason: 'Sidequest chose this' }) as ReviewEntry);
    return { told, assumed, hard: [], unasked: 0 };
  }

  it('cards the groups the traveller answered and counts the ones Sidequest decided', () => {
    const shapers = reviewShapers(
      ledgerOf([
        { questionId: 'priorities', label: 'Priorities', value: 'Hiking, wildlife', source: 'explicit' },
        { questionId: 'day_shape', label: 'Pace', value: 'Packed', source: 'inferred' },
        { questionId: 'lodging_style', label: 'Lodging', value: 'Simple', source: 'inferred' },
      ]),
    );
    expect(shapers.groups.map((group) => group.id)).toEqual(['priorities']);
    expect(shapers.decidedForYou).toEqual(['How it should feel', 'Where you sleep']);
  });

  it('never loses a group — every one is either carded or counted', () => {
    const ledger = ledgerOf([
      { questionId: 'transport_mode', label: 'Transport', value: 'Driving', source: 'explicit' },
      { questionId: 'food_tradeoff', label: 'Food', value: 'Eating well matters', source: 'inferred' },
      { questionId: 'iconic_crowds', label: 'Crowds', value: 'Avoid them', source: 'explicit' },
    ]);
    const shapers = reviewShapers(ledger);
    expect(shapers.groups.length + shapers.decidedForYou.length).toBe(reviewGlance(ledger).length);
  });

  it('says nothing at all when the traveller answered everything', () => {
    const shapers = reviewShapers(
      ledgerOf([{ questionId: 'priorities', label: 'Priorities', value: 'Food', source: 'explicit' }]),
    );
    expect(shapers.decidedForYou).toEqual([]);
  });
});
