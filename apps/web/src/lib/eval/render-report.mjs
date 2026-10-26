#!/usr/bin/env node
/**
 * Renders the generated half of docs/production-pass/eval/report.md from
 * results.json. The hand-written findings live in
 * docs/production-pass/eval/findings.md and are appended verbatim.
 *
 *   node apps/web/src/lib/eval/render-report.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../../../', import.meta.url).pathname;
const DIR = join(ROOT, 'docs/production-pass/eval');
const data = JSON.parse(readFileSync(join(DIR, 'results.json'), 'utf8'));
const runs = data.runs;

const pct = (xs, p) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (s.length === 0) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
const sec = (ms) => (ms === null || ms === undefined ? '–' : (ms / 1000).toFixed(1));
const rate = (n, d) => (d === 0 ? '–' : `${n}/${d} (${Math.round((100 * n) / d)}%)`);

const complete = runs.filter((r) => r.outcome === 'complete');
const withMetrics = complete.filter((r) => r.metrics);
const lines = [];
lines.push('# Sidequest live evaluation — open-data scan + planner, no model');
lines.push('');
lines.push(`Generated ${data.generatedAt} from \`results.json\` (${runs.length} profiles). Environment: ${Object.entries(data.environment).map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
lines.push('');
lines.push('## Aggregate');
lines.push('');
const scanReady = runs.filter((r) => r.scan?.state === 'ready').length;
const feasible = withMetrics.filter((r) => r.metrics.feasibility === 'feasible').length;
const feasibleCaut = withMetrics.filter((r) => r.metrics.feasibility === 'feasible_with_cautions').length;
const m = (f) => withMetrics.filter(f).length;
const rows = [
  ['Board produced (scan ready)', rate(scanReady, runs.length)],
  ['Itinerary produced', rate(complete.length, runs.length)],
  ['Timeouts', rate(runs.filter((r) => r.outcome === 'timeout').length, runs.length)],
  ['Feasibility: feasible', rate(feasible, withMetrics.length)],
  ['Feasibility: feasible with cautions', rate(feasibleCaut, withMetrics.length)],
  ['Silent anchor loss = 0', rate(m((r) => r.metrics.silentAnchorLoss === 0), withMetrics.length)],
  ['No empty day', rate(m((r) => r.metrics.emptyDays === 0), withMetrics.length)],
  ['No duplicate stop', rate(m((r) => r.metrics.duplicateStops.length === 0), withMetrics.length)],
  ['Every stop in an expected country', rate(m((r) => r.metrics.wrongCountryStops === 0), withMetrics.length)],
  ['No stop beyond scan reach', rate(m((r) => r.metrics.stopsBeyondReach === 0), withMetrics.length)],
  ['No zero-minute leg with distance', rate(m((r) => r.metrics.legs.zeroWithDistance === 0), withMetrics.length)],
  ['Car-free trip with no drive leg', rate(m((r) => r.metrics.carLegsOnCarFreeTrip === 0), withMetrics.length)],
  ['No opening-hours conflict', rate(m((r) => r.metrics.hoursConflicts === 0), withMetrics.length)],
  ['No overpacked day (activities > slots+1)', rate(m((r) => r.metrics.overpackedDays === 0), withMetrics.length)],
  ['No day overrunning its window by >30 min', rate(m((r) => r.metrics.overrunDays === 0), withMetrics.length)],
  ['Lunch on ≥ half the days', rate(m((r) => r.metrics.daysWithLunch * 2 >= r.metrics.days), withMetrics.length)],
  ['Dinner on ≥ half the days', rate(m((r) => r.metrics.daysWithDinner * 2 >= r.metrics.days), withMetrics.length)],
  ['Quality audit: no failed check', rate(m((r) => (r.metrics.qualityAudit?.failed.length ?? 1) === 0), withMetrics.length)],
  ['Budget estimate present', rate(m((r) => r.metrics.budget.present), withMetrics.length)],
];
lines.push('| Check | Pass rate |');
lines.push('| --- | --- |');
for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
lines.push('');
const allLegs = withMetrics.reduce((acc, r) => {
  for (const [k, v] of Object.entries(r.metrics.legs)) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}, {});
lines.push(`Legs across all completed plans: ${Object.entries(allLegs).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
lines.push('');

lines.push('## Latency (seconds)');
lines.push('');
lines.push('Over every run that reached the stage (failures included where the stage ran).');
lines.push('');
lines.push('| Stage | n | p50 | p90 | p95 | max |');
lines.push('| --- | --- | --- | --- | --- | --- |');
for (const key of ['resolve_ms', 'scan_propose_ms', 'scan_place_ms', 'scan_time_ms', 'scan_food_ms', 'scan_assemble_ms', 'scan_total_ms', 'autopick_ms', 'build_ms', 'total_ms']) {
  const xs = runs.map((r) => r.stages[key]).filter((x) => typeof x === 'number');
  lines.push(`| ${key.replace(/_ms$/, '')} | ${xs.length} | ${sec(pct(xs, 50))} | ${sec(pct(xs, 90))} | ${sec(pct(xs, 95))} | ${sec(pct(xs, 100))} |`);
}
const ttp = complete.map((r) => r.stages.total_ms);
lines.push('');
lines.push(`Time to plan (completed trips only, n=${ttp.length}): p50 ${sec(pct(ttp, 50))} s, p90 ${sec(pct(ttp, 90))} s, p95 ${sec(pct(ttp, 95))} s.`);
lines.push('');

lines.push('## Per profile');
lines.push('');
lines.push('| Profile | Outcome | Resolved as | Scan (cands/placed, groups failed) | Feasibility | Days | Stops/day | Max/mean travel min | Legs m/geo/unk | Wrong-country | Max km | Dups | Kinds | Lunch/Dinner days | Overpacked | Audit fails | Total s |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of runs) {
  const mm = r.metrics;
  const res = r.resolution ? `${r.resolution.name ?? '?'} (${r.resolution.scale ?? '?'}, ${r.resolution.countries.join('/') || '?'})` : '–';
  const failedGroups = r.openData?.failedGroups?.length ?? null;
  const scan = r.scan ? `${r.scan.state} ${r.scan.candidates}/${r.scan.placed}${failedGroups !== null ? `, ${failedGroups}/${r.openData.groups} failed` : ''}` : '–';
  const outcome = r.outcome === 'complete' ? 'complete' : `${r.outcome} @${r.failedStage}: ${(r.failureDetail ?? '').split('\n')[0].slice(0, 80)}`;
  lines.push(
    `| ${r.id} | ${outcome} | ${res} | ${scan} | ${mm?.feasibility ?? '–'} | ${mm?.days ?? '–'} | ${mm ? mm.stopsPerDay.join(',') : '–'} | ${mm ? `${mm.maxTravelMinutes}/${mm.meanTravelMinutes}` : '–'} | ${mm ? `${mm.legs.measured}/${mm.legs.geo_estimate}/${mm.legs.unknown}` : '–'} | ${mm ? `${mm.wrongCountryStops}${mm.unknownCountryStops ? ` (+${mm.unknownCountryStops}?)` : ''}` : '–'} | ${mm?.maxKmFromCentre ?? '–'} | ${mm?.duplicateStops.length ?? '–'} | ${mm?.distinctCategories ?? '–'} | ${mm ? `${mm.daysWithLunch}/${mm.daysWithDinner}` : '–'} | ${mm?.overpackedDays ?? '–'} | ${mm?.qualityAudit ? mm.qualityAudit.failed.join(' ') || '0' : '–'} | ${sec(r.stages.total_ms)} |`,
  );
}
lines.push('');
const findings = join(DIR, 'findings.md');
if (existsSync(findings)) lines.push(readFileSync(findings, 'utf8'));
writeFileSync(join(DIR, 'report.md'), `${lines.join('\n')}\n`);
console.warn(`wrote ${join(DIR, 'report.md')}`);
