/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITIES,
  EXPERIENCES,
  WORLD_REGION_LABELS,
  advisorKm,
  buildAdvisorShortlist,
  emptyComposerAnswers,
  liesWithin,
  originPointFromText,
  overlap,
  parseTravelRequest,
  seasonModelFor,
  type Activity,
  type AdvisorShortlist,
  type Atlas,
  type Destination,
  type Experience,
} from '@sidequest/core';
import { BENCH_REQUESTS, type BenchActivity, type BenchChecks, type BenchRequest, type Box } from '../../core/src/advisor/eval/benchmark/requests';
import { NAMED_DESTINATIONS } from '../../core/src/advisor/eval/benchmark/named-destinations';
import { PRICE_LEVELS } from '../../core/src/intelligence/reference/price-levels';
import { loadAtlas } from './load';

/**
 * THE GLOBAL BENCHMARK: THE OLD RECOMMENDER AND THE NEW ONE ON THE SAME REQUESTS.
 *
 *     npx vitest run --config vitest.harness.config.ts packages/atlas/src/benchmark.harness.ts
 *
 * Every request in `eval/benchmark/requests.ts` is answered by the global
 * recommender and compared with the frozen answers of the 234-destination one
 * (`docs/global-destinations/baseline/baseline-234.json`). Both are judged
 * against the same ground truth, which is the world rather than either
 * system's opinion of itself: where a pick is, what the 1981–2010 normals say
 * the requested activity is like there in the requested months, the country's
 * price level, the distance from the stated origin. (The activity model is the
 * product's own, applied to an activity the *request* names — it is a
 * consistent yardstick for both systems, not an independent oracle, and the
 * report says so.)
 *
 * Real data only: the shipped atlas artifact, no mocks, no network.
 */

const NOW = new Date('2026-11-08T12:00:00Z');
const OUT = process.env.BENCH_OUT ? `${process.env.BENCH_OUT.replace(/\/$/, '')}/` : new URL('../../../docs/global-destinations/benchmark/', import.meta.url).pathname;
const BASELINE = new URL('../../../docs/global-destinations/baseline/baseline-234.json', import.meta.url).pathname;

const ACTIVITY_OF: Record<BenchActivity, Activity> = { hike: 'hike_low', trek_high: 'hike_high', beach: 'beach', dive: 'dive', ski: 'ski', safari: 'safari', city: 'city', rainforest: 'wild', desert: 'desert', road_trip: 'drive', lakes: 'paddle' };
const FEASIBLE = 0.5;

function inBox(point: { lat: number; lng: number }, [minLat, minLng, maxLat, maxLng]: Box): boolean {
  if (point.lat < minLat || point.lat > maxLat) return false;
  return minLng <= maxLng ? point.lng >= minLng && point.lng <= maxLng : point.lng >= minLng || point.lng <= maxLng;
}

interface CheckOutcome {
  check: string;
  pass: boolean;
  detail: string;
}

function evaluate(checks: BenchChecks, picks: Destination[], atlas: Atlas): CheckOutcome[] {
  const out: CheckOutcome[] = [];
  const all = (name: string, test: (pick: Destination) => boolean) => {
    const failing = picks.filter((pick) => !test(pick)).map((pick) => pick.name);
    out.push({ check: name, pass: picks.length > 0 && failing.length === 0, detail: picks.length === 0 ? 'no picks' : failing.length === 0 ? 'all' : `not: ${failing.join(', ')}` });
  };
  const months = checks.months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  if (checks.countries) all('in the named countries', (pick) => pick.countries.some((code) => checks.countries!.includes(code)));
  if (checks.boxes) all('inside the named area', (pick) => checks.boxes!.some((box) => inBox(pick.center, box)));
  if (checks.feasible) {
    all(`feasible (${checks.feasible.join(' or ')}) by climate normals`, (pick) => {
      const model = seasonModelFor(pick);
      return checks.feasible!.some((activity) => months.some((month) => model.fit[ACTIVITY_OF[activity]][month - 1]!.value >= FEASIBLE));
    });
  }
  if (checks.maxPriceLevel !== undefined) {
    all(`price level ≤ ${checks.maxPriceLevel}`, (pick) => {
      const level = pick.countries.map((code) => PRICE_LEVELS[code]?.c ?? PRICE_LEVELS[code]?.g).find((value) => value !== undefined);
      /* A country with no published price level cannot be shown to break the bound. */
      return level === undefined || level <= checks.maxPriceLevel!;
    });
  }
  const highs = (pick: Destination) => months.map((month) => pick.measured?.base.tmax[month - 1] ?? pick.highC[month - 1]!);
  if (checks.minHighC !== undefined) all(`daily highs ≥ ${checks.minHighC} °C`, (pick) => Math.max(...highs(pick)) >= checks.minHighC!);
  if (checks.maxHighC !== undefined) all(`daily highs ≤ ${checks.maxHighC} °C`, (pick) => Math.min(...highs(pick)) <= checks.maxHighC!);
  if (checks.within) {
    const origin = originPointFromText(checks.within.origin);
    all(`within ${checks.within.km} km of ${checks.within.origin}`, (pick) => origin !== null && advisorKm(origin, pick.center) <= checks.within!.km);
  }
  if (checks.kinds) all('of the requested kind', (pick) => checks.kinds!.includes(pick.kind));
  if (checks.offers) all(`offers ${checks.offers.join(' / ')}`, (pick) => checks.offers!.some((experience) => (pick.experiences[experience as Experience] ?? 0) >= 1.5));
  if (checks.littleKnown !== undefined) {
    const count = picks.filter((pick) => pick.familiarity <= 1.25).length;
    out.push({ check: `at least ${checks.littleKnown} little-known`, pass: count >= checks.littleKnown, detail: `${count}` });
  }
  if (checks.notNamed) {
    const named = checks.notNamed.map((name) => atlas.resolveName(name)).filter((entry): entry is Destination => entry !== null);
    all(`not ${checks.notNamed.join(' / ')}`, (pick) => !checks.notNamed!.some((name) => pick.name.toLowerCase().includes(name.toLowerCase())) && !named.some((target) => liesWithin(pick, target)));
  }
  if (checks.carFree) all('doable without a car', (pick) => pick.access.car !== 'essential');
  if (checks.family) all('suits children', (pick) => pick.family === null || pick.family >= 1.5);
  /* A country somebody could not cover in one trip is a vague answer where a region, an island or a park was the useful one. */
  if (checks.specific) all('a specific destination, not a whole country', (pick) => !(pick.kind === 'country' && pick.radiusKm > 150));
  if (checks.minAbsLat !== undefined) all(`at latitude ≥ ${checks.minAbsLat}°`, (pick) => Math.abs(pick.center.lat) >= checks.minAbsLat!);
  return out;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface SystemRun {
  id: string;
  category: string;
  hard: boolean;
  text: string;
  picks: { id: string; name: string; context: string; basis: string; kind?: string; score: number }[];
  alternates: string[];
  checks: CheckOutcome[];
  overlapping: number;
  ms: number | null;
}

function summarise(runs: SystemRun[]) {
  const withChecks = runs.filter((run) => run.checks.length > 0);
  const total = withChecks.reduce((sum, run) => sum + run.checks.length, 0);
  const passed = withChecks.reduce((sum, run) => sum + run.checks.filter((check) => check.pass).length, 0);
  const byCategory: Record<string, { requests: number; checks: number; passed: number; allPass: number }> = {};
  for (const run of withChecks) {
    const slot = (byCategory[run.category] ??= { requests: 0, checks: 0, passed: 0, allPass: 0 });
    slot.requests += 1;
    slot.checks += run.checks.length;
    slot.passed += run.checks.filter((check) => check.pass).length;
    if (run.checks.every((check) => check.pass)) slot.allPass += 1;
  }
  const primaries = runs.flatMap((run) => run.picks);
  return {
    requests: runs.length,
    answeredWithThree: runs.filter((run) => run.picks.length >= 3).length,
    empty: runs.filter((run) => run.picks.length === 0).length,
    checks: total,
    checksPassed: passed,
    checkPassRate: total === 0 ? 0 : Math.round((passed / total) * 1000) / 1000,
    requestsWithChecks: withChecks.length,
    requestsAllChecksPass: withChecks.filter((run) => run.checks.every((check) => check.pass)).length,
    distinctDestinations: new Set(primaries.map((pick) => pick.id)).size,
    overlappingPairs: runs.reduce((sum, run) => sum + run.overlapping, 0),
    byBasis: primaries.reduce<Record<string, number>>((counts, pick) => ({ ...counts, [pick.basis]: (counts[pick.basis] ?? 0) + 1 }), {}),
    byCategory,
  };
}

describe('global benchmark', () => {
  it('answers every request and writes the comparison', () => {
    const loaded = loadAtlas({ now: NOW });
    if (!loaded) throw new Error('the atlas artifact is missing: build it first (packages/atlas/README.md)');
    const { atlas } = loaded;
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { runs: { id: string; picks: { id: string; name: string; context: string; score: number }[]; alternates: { name: string }[]; ms: number }[] };
    const baselineById = new Map(baseline.runs.map((run) => [run.id, run]));

    const answer = (request: BenchRequest, text = request.text): { shortlist: AdvisorShortlist; ms: number; readings: string[] } => {
      const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
      const started = performance.now();
      const parsed = parseTravelRequest(text, base, NOW, atlas);
      const shortlist = buildAdvisorShortlist({ answers: parsed.answers, catalog: atlas, catalogVersion: atlas.version, now: NOW });
      return { shortlist, ms: performance.now() - started, readings: parsed.readings.map((reading) => reading.label) };
    };
    /* Warm the season table and the postings so latency is the steady state, and say what the cold start cost. */
    const coldStarted = performance.now();
    answer(BENCH_REQUESTS[0]!);
    const coldMs = performance.now() - coldStarted;

    const overlapping = (picks: Destination[]) => {
      let pairs = 0;
      for (let a = 0; a < picks.length; a += 1) for (let b = a + 1; b < picks.length; b += 1) if (overlap(picks[a]!, picks[b]!) >= 1) pairs += 1;
      return pairs;
    };

    const after: SystemRun[] = [];
    const before: SystemRun[] = [];
    const readings: Record<string, string[]> = {};
    let deterministic = 0;
    let stable = 0;
    let provenanceComplete = 0;
    let provenanceTotal = 0;
    for (const request of BENCH_REQUESTS) {
      const first = answer(request);
      readings[request.id] = first.readings;
      const destinations = first.shortlist.picks.map((pick) => atlas.byId(pick.id)).filter((entry): entry is Destination => entry !== null);
      after.push({
        id: request.id,
        category: request.category,
        hard: request.hard === true,
        text: request.text,
        picks: first.shortlist.picks.map((pick) => ({ id: pick.id, name: pick.name, context: pick.context, basis: pick.basis, kind: pick.kind, score: pick.score })),
        alternates: first.shortlist.alternates.map((pick) => pick.name),
        checks: evaluate(request.checks, destinations, atlas),
        overlapping: overlapping(destinations),
        ms: Math.round(first.ms * 10) / 10,
      });
      const again = answer(request);
      if (again.shortlist.picks.map((pick) => pick.id).join() === first.shortlist.picks.map((pick) => pick.id).join()) deterministic += 1;
      /* The same request said slightly differently should not be a different trip. */
      const reworded = answer(request, `${request.text} Thanks!`);
      const same = reworded.shortlist.picks.filter((pick) => first.shortlist.picks.some((other) => other.id === pick.id)).length;
      if (same === first.shortlist.picks.length) stable += 1;
      for (const pick of [...first.shortlist.picks, ...first.shortlist.alternates]) {
        if (pick.basis === 'editorial') continue;
        provenanceTotal += 1;
        const complete = pick.references.length > 0 && (pick.seasonNote === null || /usually|all year|no month/.test(pick.seasonNote)) && pick.cost.label.includes('estimated') && pick.unverified.some((line) => line.includes('not checked by an editor'));
        if (complete) provenanceComplete += 1;
      }

      const old = baselineById.get(request.id);
      const oldDestinations = (old?.picks ?? []).map((pick) => atlas.byId(pick.id)).filter((entry): entry is Destination => entry !== null);
      before.push({
        id: request.id,
        category: request.category,
        hard: request.hard === true,
        text: request.text,
        picks: (old?.picks ?? []).map((pick) => ({ id: pick.id, name: pick.name, context: pick.context, basis: 'editorial', score: pick.score })),
        alternates: (old?.alternates ?? []).map((pick) => pick.name),
        checks: evaluate(request.checks, oldDestinations, atlas),
        overlapping: overlapping(oldDestinations),
        ms: old?.ms ?? null,
      });
    }

    /* Coverage: how the world is represented, by region, kind, experience and month. */
    const everything = atlas.all();
    const strongBy: Record<string, Record<string, number>> = {};
    for (const destination of everything) {
      for (const experience of EXPERIENCES) {
        if ((destination.experiences[experience] ?? 0) < 2) continue;
        const slot = (strongBy[experience] ??= {});
        slot[destination.worldRegion] = (slot[destination.worldRegion] ?? 0) + 1;
        slot.total = (slot.total ?? 0) + 1;
      }
    }
    const monthly: Record<string, number[]> = {};
    for (const activity of ACTIVITIES) monthly[activity] = new Array<number>(12).fill(0);
    let withClimate = 0;
    for (const destination of everything) {
      if (!destination.measured) continue;
      withClimate += 1;
      const model = seasonModelFor(destination);
      for (const activity of ACTIVITIES) for (let month = 0; month < 12; month += 1) if (model.fit[activity][month]!.value >= 0.6) monthly[activity]![month]! += 1;
    }

    /* Recall of named destinations: does the atlas hold the place, in the right country? And did the 234 catalog? */
    const curatedNames = atlas.curatedDestinations().map((destination) => ({ name: destination.name.toLowerCase(), countries: destination.countries, aliases: destination.aliases.map((alias) => alias.toLowerCase()) }));
    const fold = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let held = 0;
    let heldByCatalog = 0;
    const missing: string[] = [];
    for (const [name, country] of NAMED_DESTINATIONS) {
      const found = atlas.resolveName(name);
      if (found && (found.countries.length === 0 || found.countries.includes(country))) held += 1;
      else missing.push(`${name} (${country})`);
      if (curatedNames.some((entry) => entry.countries.includes(country) && (fold(entry.name).includes(fold(name)) || entry.aliases.some((alias) => fold(alias) === fold(name))))) heldByCatalog += 1;
    }

    const latency = after.map((run) => run.ms ?? 0);
    const summary = {
      generatedAt: NOW.toISOString(),
      atlas: { version: atlas.version, builtAt: atlas.builtAt, destinations: atlas.size, loadMs: loaded.loadMs, embeddings: loaded.embeddings, coverage: atlas.coverage() },
      before: { system: 'advisor-234 (commit 596ece1)', ...summarise(before), latencyMs: { p50: quantile(before.map((run) => run.ms ?? 0), 0.5), p95: quantile(before.map((run) => run.ms ?? 0), 0.95) } },
      after: { system: `global atlas ${atlas.version}`, ...summarise(after), latencyMs: { cold: Math.round(coldMs), p50: quantile(latency, 0.5), p95: quantile(latency, 0.95), max: Math.max(...latency) } },
      stability: { deterministic: `${deterministic}/${BENCH_REQUESTS.length}`, sameAfterRewording: `${stable}/${BENCH_REQUESTS.length}` },
      provenance: { derivedPicksShown: provenanceTotal, withSourceBasisAndCaveat: provenanceComplete },
      recall: { named: NAMED_DESTINATIONS.length, heldByAtlas: held, heldBy234Catalog: heldByCatalog, missing },
      coverage: { withMeasuredClimate: withClimate, strongByExperience: strongBy, goodMonthsByActivity: monthly },
      modelCalls: 0,
    };

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}results.json`, `${JSON.stringify({ summary, readings, before, after }, null, 1)}\n`);

    /* The side-by-side a person can read. */
    const lines: string[] = [];
    const pct = (value: number, of: number) => (of === 0 ? '—' : `${Math.round((value / of) * 100)}%`);
    lines.push('# Global benchmark — before and after', '', `Generated by \`packages/atlas/src/benchmark.harness.ts\` against atlas ${atlas.version} (${atlas.size.toLocaleString('en-US')} destinations). ${BENCH_REQUESTS.length} requests, no model calls, no network.`, '');
    lines.push('| | 234-destination advisor | Global atlas |', '|---|---|---|');
    lines.push(`| Requests answered with three picks | ${summary.before.answeredWithThree} | ${summary.after.answeredWithThree} |`);
    lines.push(`| Objective checks passed | ${summary.before.checksPassed}/${summary.before.checks} (${pct(summary.before.checksPassed, summary.before.checks)}) | ${summary.after.checksPassed}/${summary.after.checks} (${pct(summary.after.checksPassed, summary.after.checks)}) |`);
    lines.push(`| Requests passing every check | ${summary.before.requestsAllChecksPass}/${summary.before.requestsWithChecks} | ${summary.after.requestsAllChecksPass}/${summary.after.requestsWithChecks} |`);
    lines.push(`| Distinct destinations recommended | ${summary.before.distinctDestinations} | ${summary.after.distinctDestinations} |`);
    lines.push(`| Overlapping pairs among primary picks | ${summary.before.overlappingPairs} | ${summary.after.overlappingPairs} |`);
    lines.push(`| Named-destination recall (${NAMED_DESTINATIONS.length} places) | ${heldByCatalog} | ${held} |`);
    lines.push(`| Latency p50 / p95 (ms, rank only) | ${summary.before.latencyMs.p50} / ${summary.before.latencyMs.p95} | ${summary.after.latencyMs.p50} / ${summary.after.latencyMs.p95} |`, '');
    lines.push('## By trip type', '', '| Category | Requests | Before: checks passed | After: checks passed |', '|---|---|---|---|');
    for (const category of Object.keys(summary.after.byCategory).sort()) {
      const a = summary.after.byCategory[category]!;
      const b = summary.before.byCategory[category] ?? { checks: 0, passed: 0, requests: 0, allPass: 0 };
      lines.push(`| ${category} | ${a.requests} | ${b.passed}/${b.checks} | ${a.passed}/${a.checks} |`);
    }
    lines.push('', '## Every request', '');
    for (let index = 0; index < after.length; index += 1) {
      const a = after[index]!;
      const b = before[index]!;
      const mark = (run: SystemRun) => (run.checks.length === 0 ? '' : ` — ${run.checks.filter((check) => check.pass).length}/${run.checks.length} checks`);
      lines.push(`### ${a.id}${a.hard ? ' (hard)' : ''}`, `> ${a.text}`, '', `Read as: ${readings[a.id]!.join(' · ') || '—'}`, '');
      lines.push(`- **Before**${mark(b)}: ${b.picks.map((pick) => `${pick.name} (${pick.context})`).join(' · ') || '— nothing —'}`);
      lines.push(`- **After**${mark(a)}: ${a.picks.map((pick) => `${pick.name} (${pick.context})${pick.basis === 'editorial' ? '' : ' ◦'}`).join(' · ') || '— nothing —'}`);
      if (a.alternates.length > 0) lines.push(`  - also: ${a.alternates.join(' · ')}`);
      const failed = a.checks.filter((check) => !check.pass);
      if (failed.length > 0) lines.push(`  - after fails: ${failed.map((check) => `${check.check} (${check.detail})`).join('; ')}`);
      const failedBefore = b.checks.filter((check) => !check.pass);
      if (failedBefore.length > 0) lines.push(`  - before fails: ${failedBefore.map((check) => `${check.check} (${check.detail})`).join('; ')}`);
      lines.push('');
    }
    lines.push('◦ = read from open data rather than the curated catalog.', '');
    writeFileSync(`${OUT}comparison.md`, lines.join('\n'));

    const regionRows = Object.entries(summary.atlas.coverage.byWorldRegion).sort((a, b) => b[1] - a[1]).map(([region, count]) => `| ${WORLD_REGION_LABELS[region as keyof typeof WORLD_REGION_LABELS] ?? region} | ${count.toLocaleString('en-US')} |`);
    writeFileSync(`${OUT}coverage.md`, ['# Atlas coverage', '', `${atlas.size.toLocaleString('en-US')} destinations in ${summary.atlas.coverage.countries} countries and territories; ${withClimate.toLocaleString('en-US')} with measured climate.`, '', '| World region | Destinations |', '|---|---|', ...regionRows, '', '| Kind | Destinations |', '|---|---|', ...Object.entries(summary.atlas.coverage.byKind).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `| ${kind} | ${count.toLocaleString('en-US')} |`), '', '## Destinations strong (≥ 2 of 3) on each experience', '', '| Experience | Destinations | World regions with at least one |', '|---|---|---|', ...EXPERIENCES.map((experience) => `| ${experience} | ${(strongBy[experience]?.total ?? 0).toLocaleString('en-US')} | ${Object.keys(strongBy[experience] ?? {}).filter((key) => key !== 'total').length} of 24 |`), '', '## Destinations where an activity is good (≥ 0.6), by month', '', `| Activity | ${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].join(' | ')} |`, `|---|${'---|'.repeat(12)}`, ...ACTIVITIES.map((activity) => `| ${activity} | ${monthly[activity]!.join(' | ')} |`), ''].join('\n'));

    console.log(JSON.stringify({ before: { ...summary.before, byCategory: undefined }, after: { ...summary.after, byCategory: undefined }, stability: summary.stability, provenance: summary.provenance, recall: { ...summary.recall, missing: summary.recall.missing.slice(0, 40) } }, null, 1));
    expect(after.length).toBe(BENCH_REQUESTS.length);
  }, 600_000);
});
