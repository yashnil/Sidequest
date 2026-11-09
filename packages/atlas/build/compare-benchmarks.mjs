#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its results are its output. */
/**
 * TWO RUNS OF THE GLOBAL BENCHMARK, REQUEST BY REQUEST.
 *
 *   node packages/atlas/build/compare-benchmarks.mjs <before>/results.json <after>/results.json [--md out.md]
 *
 * Both files come from `packages/atlas/src/benchmark.harness.ts` (its `after`
 * section: the global recommender's answers) on the same request list. A
 * request is better when more of its world-property checks pass, worse when
 * fewer do; every regression is listed with the check that broke, because an
 * aggregate that improves can hide a request that got worse.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const mdAt = process.argv.indexOf('--md');
const before = JSON.parse(readFileSync(beforePath, 'utf8')).after;
const after = JSON.parse(readFileSync(afterPath, 'utf8')).after;
const byId = new Map(before.map((run) => [run.id, run]));
const passed = (run) => run.checks.filter((check) => check.pass).length;
const rows = [];
for (const run of after) {
  const old = byId.get(run.id);
  if (!old) continue;
  rows.push({ id: run.id, category: run.category, since: run.id.startsWith('rc-') ? 'rc' : 'global', text: run.text, checks: run.checks.length, before: passed(old), after: passed(run), oldPicks: old.picks.map((pick) => pick.name), newPicks: run.picks.map((pick) => pick.name), countriesBefore: old.picks.filter((pick) => pick.kind === 'country').length, countriesAfter: run.picks.filter((pick) => pick.kind === 'country').length, broke: run.checks.filter((check) => !check.pass && old.checks.find((other) => other.check === check.check)?.pass).map((check) => `${check.check} (${check.detail})`), same: old.picks.map((pick) => pick.id).join('|') === run.picks.map((pick) => pick.id).join('|') });
}
const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
const table = (label, list) => {
  const withChecks = list.filter((row) => row.checks > 0);
  return `| ${label} | ${list.length} | ${sum(withChecks, 'before')}/${sum(withChecks, 'checks')} | ${sum(withChecks, 'after')}/${sum(withChecks, 'checks')} | ${withChecks.filter((row) => row.before === row.checks).length} → ${withChecks.filter((row) => row.after === row.checks).length} of ${withChecks.length} | ${list.filter((row) => row.after > row.before).length} | ${list.filter((row) => row.after < row.before).length} | ${list.filter((row) => row.same).length} |`;
};
const lines = ['| Set | Requests | Checks before | Checks after | All checks pass | Better | Worse | Identical picks |', '|---|---|---|---|---|---|---|---|', table('All', rows), table('First global pass (147)', rows.filter((row) => row.since === 'global')), table('Release-candidate additions', rows.filter((row) => row.since === 'rc'))];
const categories = [...new Set(rows.map((row) => row.category))].sort();
lines.push('', '| Category | Requests | Checks before | Checks after | Better | Worse |', '|---|---|---|---|---|---|');
for (const category of categories) {
  const list = rows.filter((row) => row.category === category);
  lines.push(`| ${category} | ${list.length} | ${sum(list, 'before')}/${sum(list, 'checks')} | ${sum(list, 'after')}/${sum(list, 'checks')} | ${list.filter((row) => row.after > row.before).length} | ${list.filter((row) => row.after < row.before).length} |`);
}
lines.push('', `Whole countries among primary picks: ${sum(rows, 'countriesBefore')} → ${sum(rows, 'countriesAfter')}`, '', '## Regressions (fewer checks pass than before)', '');
for (const row of rows.filter((entry) => entry.after < entry.before)) lines.push(`- **${row.id}** — ${row.text}`, `  - before: ${row.oldPicks.join(' · ')}`, `  - after: ${row.newPicks.join(' · ')}`, `  - broke: ${row.broke.join('; ')}`);
lines.push('', '## Still failing a check', '');
const failing = after.filter((run) => run.checks.some((check) => !check.pass));
for (const run of failing) lines.push(`- **${run.id}** — ${run.picks.map((pick) => pick.name).join(' · ') || '(no picks)'} — ${run.checks.filter((check) => !check.pass).map((check) => `${check.check}: ${check.detail}`).join('; ')}`);
const text = lines.join('\n');
if (mdAt > 0) writeFileSync(process.argv[mdAt + 1], `${text}\n`);
console.log(text);
