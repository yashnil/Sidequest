import { describe, expect, it } from 'vitest';
import { planStructure, scoreStructure, type StructurePlan, type StructurePlannerInput } from './structure-planner';
import { benchTrips, largeBenchTrip } from './testing/planner-bench';

/**
 * THE PLANNER BENCH — greedy construction vs greedy + the improvement phase.
 *
 * A measurement, so it runs under `npm run test:perf` on an otherwise idle
 * machine, never inside `npm run test` (V9.1: a timing taken while hundreds of
 * suites fight for the same cores measures the contention, not the code).
 *
 * For each bench trip it prints the objective and its parts for both plans,
 * plus the stops, travel minutes, district switches, high-fit drops and the
 * empty ordinary days, and times the improved plan (p50/p95 over repeated
 * runs after a warm-up). The gate is the product budget for the planner on
 * the largest realistic board — sixty candidates over fourteen days and three
 * bases, with a forecast that triggers the weather-blind counterfactual run:
 * well under half a second.
 */

const RUNS = 15;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summary(input: StructurePlannerInput, plan: StructurePlan) {
  const z = scoreStructure(input, plan);
  const scheduled = new Set(plan.days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
  return {
    score: Math.round(z.score * 10) / 10,
    value: Math.round(z.parts.value * 10) / 10,
    stops: z.stops,
    travel: z.parts.travelMinutes,
    zoneSwitches: z.parts.zoneSwitches,
    highFitDrops: plan.dropped.filter((d) => d.candidate.fit >= 70 && (d.reason === 'capacity' || d.reason === 'too_far') && !scheduled.has(d.candidate.id)).length,
    emptyDays: z.parts.emptyDays,
    mustConflicts: plan.mustConflicts.length,
  };
}

describe('planner bench (perf)', () => {
  it('reports greedy vs improved on every bench trip and keeps the largest board under budget', () => {
    const rows: Record<string, unknown>[] = [];
    for (const trip of [...benchTrips(), largeBenchTrip()]) {
      const greedy = planStructure({ ...trip.input, improve: false });
      planStructure(trip.input); // warm-up
      const times: number[] = [];
      let improved: StructurePlan | null = null;
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        improved = planStructure(trip.input);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const g = summary(trip.input, greedy);
      const s = summary(trip.input, improved!);
      rows.push({ trip: trip.key, plan: 'greedy', ...g, p50ms: '', p95ms: '' });
      rows.push({ trip: trip.key, plan: 'improved', ...s, p50ms: percentile(times, 50).toFixed(1), p95ms: percentile(times, 95).toFixed(1) });
      expect(s.score).toBeGreaterThanOrEqual(g.score);
      if (trip.key === 'norway-large') expect(percentile(times, 50)).toBeLessThan(500);
    }
    const columns = Object.keys(rows[0]!);
    const width = (k: string) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
    const line = (cells: string[]) => cells.map((v, i) => v.padEnd(width(columns[i]!))).join('  ');
    console.warn(['', line(columns), ...rows.map((r) => line(columns.map((k) => String(r[k]))))].join('\n'));
  }, 120_000);
});
