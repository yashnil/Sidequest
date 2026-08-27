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
 * a stop three different ways. All three now read the one definition, which
 * lives in `@sidequest/core` (`scoring/frequency.ts`) and charges every
 * interest the traveller asked for that a stop serves; this seam re-exports it
 * for the planner's two readers. The §29 G evaluation is why the cost model
 * charges matched secondaries: one-interest-per-stop ledgers let a fifth stop
 * matching a four-cap interest through whenever its spend was filed under a
 * different primary, and which stop that was depended on candidate order.
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

  it('charges a whole unit of every interest the traveller asked for that the stop serves', () => {
    /*
     * The lakeside hike, the §29 G case exactly: charging only `hiking` let a
     * traveller's lake allowance be spent by stops the ledger never filed
     * under it, and which stops slipped through depended on candidate order.
     */
    expect(frequencyCostOf(placeWith(['hiking', 'lakes_and_rivers']), PROFILE)).toEqual([
      ['hiking', 1],
      ['lakes_and_rivers', 1],
    ]);
  });

  it('charges the primary interest whatever its grade, and a low-graded secondary not at all', () => {
    /*
     * "A little of this, if it is right there" is not an allowance a stop
     * should drain because it lists the interest third; the stop's own primary
     * is what the stop *is* and always spends against whatever cap exists.
     */
    expect(frequencyCostOf(placeWith(['history_and_culture', 'wildlife']), PROFILE)).toEqual([
      ['history_and_culture', 1],
    ]);
  });

  it('charges nothing for an interest the traveller was never graded on', () => {
    /*
     * An interest with no cap is not "a cap of zero" — it is a question this
     * traveller was never asked, and charging it would refuse stops against a
     * limit nobody set.
     */
    const uncapped = Object.keys(caps).length > 0 ? 'nightlife' : 'hiking';
    expect(frequencyCostOf(placeWith([uncapped as never]), PROFILE)).toEqual([]);
    expect(withinFrequencyCaps(placeWith([uncapped as never]), PROFILE, new Map())).toBe(true);
  });

  it('refuses the stop that would take the ledger past the cap, and names that cap', () => {
    const place = placeWith(['hiking']);
    const spent = new Map<string, number>([['hiking', caps.hiking!]]);
    expect(withinFrequencyCaps(place, PROFILE, spent)).toBe(false);
    expect(bindingInterestOf(place, PROFILE, spent)).toBe('hiking');
  });

  it('refuses against a matched secondary ceiling too, so no ordering can overspend it', () => {
    const place = placeWith(['hiking', 'lakes_and_rivers']);
    const spent = new Map<string, number>([['lakes_and_rivers', caps.lakes_and_rivers!]]);
    expect(withinFrequencyCaps(place, PROFILE, spent)).toBe(false);
    expect(bindingInterestOf(place, PROFILE, spent)).toBe('lakes_and_rivers');
  });

  it('lets the last one inside the cap through', () => {
    const place = placeWith(['hiking']);
    const spent = new Map<string, number>([['hiking', caps.hiking! - 1]]);
    expect(withinFrequencyCaps(place, PROFILE, spent)).toBe(true);
  });

  it('adds to a ledger the way both readers read it', () => {
    const spend = new Map<string, number>();
    chargeFrequencyCost(placeWith(['hiking']), PROFILE, spend);
    chargeFrequencyCost(placeWith(['hiking', 'lakes_and_rivers']), PROFILE, spend);
    expect(spend.get('hiking')).toBe(2);
    expect(spend.get('lakes_and_rivers')).toBe(1);
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
