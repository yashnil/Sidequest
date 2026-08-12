import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers, type Place } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import {
  bindingInterestOf,
  chargeFrequencyCost,
  frequencyCostOf,
  withinFrequencyCaps,
} from './frequency';

/**
 * ONE LEDGER FOR "HOW MANY OF THESE DID YOU ASK FOR".
 *
 * Three layers spend against `derived.frequencyCaps` — the board's auto-pick,
 * the planner's packer, and the validator — and they were computing the cost of
 * a stop three different ways. The board charged `fit.primaryInterest` at one
 * unit and each matched secondary at a half; the planner and the validator each
 * charged `place.interests[0]` at one unit, independently. Two of those readers
 * live here, and they now read one function; the third is a handoff, and this
 * file is the definition it has to converge on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const PROFILE = buildTravelerProfile(
  {
    ...defaultAnswers({ travelerNeeds: [], tripDays: 4 }),
    interests: { hiking: 'frequent', lakes_and_rivers: 'occasional' },
  },
  { travelerNeeds: [], tripDays: 4 },
);

/** A real record, with its interests replaced, so nothing else about it drifts. */
function placeWith(interests: Place['interests']): Place {
  return { ...EASTERN_SIERRA_PLACES[0]!, interests };
}

describe('what one stop costs against a frequency ceiling', () => {
  const caps = PROFILE.derived.frequencyCaps;

  it('charges a whole unit of the place’s own primary interest', () => {
    expect(frequencyCostOf(placeWith(['hiking', 'lakes_and_rivers']), caps)).toEqual([
      ['hiking', 1],
    ]);
  });

  it('charges nothing for an interest the traveller was never graded on', () => {
    /*
     * An interest with no cap is not "a cap of zero" — it is a question this
     * traveller was never asked, and charging it would refuse stops against a
     * limit nobody set.
     */
    const uncapped = Object.keys(caps).length > 0 ? 'nightlife' : 'hiking';
    expect(frequencyCostOf(placeWith([uncapped as never]), caps)).toEqual([]);
    expect(withinFrequencyCaps(placeWith([uncapped as never]), caps, new Map())).toBe(true);
  });

  it('refuses the stop that would take the ledger past the cap, and names that cap', () => {
    const place = placeWith(['hiking']);
    const spent = new Map<string, number>([['hiking', caps.hiking!]]);
    expect(withinFrequencyCaps(place, caps, spent)).toBe(false);
    expect(bindingInterestOf(place, caps, spent)).toBe('hiking');
  });

  it('lets the last one inside the cap through', () => {
    const place = placeWith(['hiking']);
    const spent = new Map<string, number>([['hiking', caps.hiking! - 1]]);
    expect(withinFrequencyCaps(place, caps, spent)).toBe(true);
  });

  it('adds to a ledger the way both readers read it', () => {
    const spend = new Map<string, number>();
    chargeFrequencyCost(placeWith(['hiking']), caps, spend);
    chargeFrequencyCost(placeWith(['hiking']), caps, spend);
    expect(spend.get('hiking')).toBe(2);
  });

  /**
   * The drift guard, and the reason this module exists rather than a comment.
   *
   * The packer and the validator each used to reach into `place.interests[0]`
   * and keep their own tally, so the two could be changed apart — and a product
   * that refuses a stop against one limit and then cautions about a different
   * one cannot explain either. Grep-based on purpose: the failure this catches
   * is somebody adding a *second* tally beside the shared one, which an
   * import-graph check would not see.
   */
  it('is the only place either reader decides against a cap', () => {
    for (const file of ['plan.ts', 'validate.ts']) {
      const source = readFileSync(join(HERE, file), 'utf8');
      expect(source, `${file} stopped reading the shared definition`).toContain(
        "from './frequency'",
      );
      /*
       * Reading a cap to *print* it is fine — "you asked for 4 of these" needs
       * the number. Comparing against one is the decision, and the decision has
       * exactly one home.
       */
      expect(
        source,
        `${file} compares against a frequency cap itself — that decision lives in frequency.ts`,
      ).not.toMatch(/frequencyCaps\[[^\]]*\]!?\s*(?:<=?|>=?)/);
    }
  });
});
