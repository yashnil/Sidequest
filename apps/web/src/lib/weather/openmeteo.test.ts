import { describe, expect, it } from 'vitest';
import { mergeBands } from './openmeteo';

/**
 * The banding arithmetic, checked at the two places it was wrong.
 *
 * A review found both: nearby trip dates were each issuing their own archive
 * request (a fortnight's trip meant a hundred and forty), and a band straddling
 * New Year had its year restamped on pre-shifted bounds, producing
 * `start_date=2017-12-28&end_date=2017-01-07` — which the provider rejects, so
 * every New Year trip silently lost all of its history.
 */
describe('historical sample bands', () => {
  it('collapses a run of consecutive dates into one span', () => {
    const spans = mergeBands(
      ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
      5,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]!.anchorStart).toBe('2026-08-01');
    expect(spans[0]!.anchorEnd).toBe('2026-08-04');
    expect(spans[0]!.dates).toHaveLength(4);
  });

  it('keeps genuinely separate periods apart', () => {
    const spans = mergeBands(['2026-08-01', '2026-11-20'], 5);
    expect(spans).toHaveLength(2);
  });

  it('anchors on trip dates, so the year can be stamped before the offset', () => {
    // The New Year case: the anchors are 2 and 3 January, and the ±5 day window
    // is applied afterwards — which is what keeps the range in order.
    const spans = mergeBands(['2028-01-02', '2028-01-03'], 5);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.anchorStart).toBe('2028-01-02');
    expect(spans[0]!.anchorEnd).toBe('2028-01-03');
  });

  it('is order-independent and deduplicates', () => {
    expect(mergeBands(['2026-08-03', '2026-08-01', '2026-08-03'], 5)).toEqual(
      mergeBands(['2026-08-01', '2026-08-03'], 5),
    );
  });
});
