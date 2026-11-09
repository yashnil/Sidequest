/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
import { describe, it } from 'vitest';
import { buildAdvisorShortlist, emptyComposerAnswers, parseTravelRequest } from '@sidequest/core';
import { loadAtlas } from './load';

/**
 * A look at what the atlas answers, for a developer.
 *
 *     ATLAS_Q="Budget trekking in the Karakoram in July|Diving." npx vitest run --config vitest.harness.config.ts packages/atlas/src/explore.harness.ts
 */
const NOW = new Date('2026-11-08T12:00:00Z');

describe('atlas explorer', () => {
  it('prints shortlists', () => {
    const loaded = loadAtlas({ now: NOW });
    if (!loaded) throw new Error('no atlas');
    const { atlas } = loaded;
    console.log(`atlas ${atlas.version}: ${atlas.size} destinations, loaded in ${loaded.loadMs} ms`);
    for (const text of (process.env.ATLAS_Q ?? 'Budget trekking in the Karakoram in July').split('|')) {
      if (process.env.ATLAS_ROLES) console.log(`  places: ${atlas.findPlaces(text).map((mention) => `${mention.role}:${mention.name}[${mention.id}]`).join(' | ')}`);
      const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
      const parsed = parseTravelRequest(text, base, NOW, atlas);
      const started = performance.now();
      const shortlist = buildAdvisorShortlist({ answers: parsed.answers, catalog: atlas, catalogVersion: atlas.version, now: NOW });
      const ms = performance.now() - started;
      console.log(`\n▶ ${text}\n  read: ${parsed.readings.map((reading) => reading.label).join(' · ')}${parsed.answers.discovery?.terms?.length ? ` · terms: ${parsed.answers.discovery.terms.join(',')}` : ''}`);
      console.log(`  ${shortlist.stats.considered} considered → ${shortlist.stats.eligible} eligible, ${ms.toFixed(0)} ms${shortlist.readout.relaxation ? ` · ${shortlist.readout.relaxation}` : ''}`);
      for (const pick of [...shortlist.picks, ...shortlist.alternates]) {
        console.log(`  ${pick.role === 'primary' ? '●' : '○'} ${pick.name} — ${pick.context} [${pick.kind}/${pick.basis} ${pick.score} conf ${pick.confidence}] ${pick.window.label} · ${pick.seasonNote ?? ''}`);
        if (process.env.ATLAS_VERBOSE) console.log(`      ${pick.why} | ${pick.factors.filter((f) => f.value !== null).map((f) => `${f.id}=${f.value}`).join(' ')}\n      ${pick.experiences.join(' · ')}`);
      }
    }
  }, 300_000);
});
