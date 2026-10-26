import { describe, expect, it } from 'vitest';
import { destinationCatalog } from '../catalog/index';
import { SCENARIOS } from './scenarios';
import { runScenario } from './run';

/**
 * The advisor against thirty-plus travellers. Every check is a property of the
 * catalog entries the shortlist chose — never a destination name — so passing
 * cannot be bought by naming the right places.
 */
const catalog = destinationCatalog();
const runs = SCENARIOS.map((scenario) => runScenario(scenario, catalog));

describe('destination advisor evaluation', () => {
  it('has at least thirty scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30);
  });

  for (const run of runs) {
    it(`${run.scenario.id}: ${run.scenario.title}`, () => {
      const failed = run.checks.filter((result) => !result.pass);
      expect(
        failed.map((result) => `${result.check.kind}: ${result.detail}`),
        `picks: ${run.shortlist.picks.map((pick) => pick.id).join(', ')} · asked: ${run.asked.join(', ')}`,
      ).toEqual([]);
      expect(run.shortlist.picks.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('never asks a question the traveller already answered in their own words', () => {
    const redundant = runs.flatMap((run) => run.redundant.map((id) => `${run.scenario.id}:${id}`));
    expect(redundant).toEqual([]);
  });

  it('asks at most seven questions in any scenario (two essentials plus five follow-ups)', () => {
    for (const run of runs) expect(run.asked.length, run.scenario.id).toBeLessThanOrEqual(7);
  });

  it('never ties the whole shortlist (the old ranker scored eight places at 100)', () => {
    const allTied = runs.filter((run) => run.shortlist.picks.length === 3 && new Set(run.shortlist.picks.map((pick) => pick.score)).size === 1);
    expect(allTied.map((run) => run.scenario.id)).toEqual([]);
  });

  it('is deterministic: the same input gives the same shortlist', () => {
    for (const scenario of SCENARIOS.slice(0, 8)) {
      const again = runScenario(scenario, catalog);
      const first = runs.find((run) => run.scenario.id === scenario.id)!;
      expect(again.shortlist.picks.map((pick) => pick.id)).toEqual(first.shortlist.picks.map((pick) => pick.id));
    }
  });

  it('spreads broad worldwide requests across the world', () => {
    const broad = runs.filter((run) => !run.answers.discovery?.regions?.length && run.answers.tripScope !== 'domestic' && !run.answers.flightTolerance?.match(/short/));
    const spread = broad.filter((run) => run.regions >= 2).length / broad.length;
    expect(spread).toBeGreaterThanOrEqual(0.8);
  });
});
