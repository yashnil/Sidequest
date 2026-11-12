/* eslint-disable no-console -- a measurement script. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { it } from 'vitest';
import { buildAdvisorShortlist, emptyAdvisorAnswers, emptyComposerAnswers, parseTravelRequest, type TripComposerAnswers } from '@sidequest/core';
import { advisorWorld } from '@/lib/atlas/world';

/**
 * HELP-ME-CHOOSE ON THE OWNER'S OWN REQUESTS, WRITTEN TO A FILE.
 *
 *   ADVISOR_REQUESTS_OUT=docs/experience-transformation/baseline/advisor-after.json \
 *     npx vitest run -c vitest.harness.config.ts apps/web/src/lib/destinations/advisor-requests.harness.ts
 *
 * The shipped atlas, no model, no network. `advisor-before.json` beside it was
 * written by the same requests on the code before the trip-concept pass.
 */
const OUT = resolve(process.cwd(), process.env.ADVISOR_REQUESTS_OUT ?? 'docs/experience-transformation/baseline/advisor-latest.json');
const REQUESTS = [
  'I want to go on a trip with my family over spring, March 19-29. Preferably a nice retreat. I want to feel good because life has been stressful recently. Outdoors stuff.',
  'Two weeks of trekking in July, anywhere in the world, moderate budget.',
  'A gentle week of nature with my parents, no car.',
  'Warm beaches and snorkelling over Christmas, from London, with the kids.',
  'Ten days in October, culture and food, I love walking cities.',
];

it('baseline', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const { world, version } = advisorWorld();
  const out: unknown[] = [];
  for (const text of REQUESTS) {
    const base: TripComposerAnswers = { ...emptyComposerAnswers('help_me_decide', now), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
    const { answers } = parseTravelRequest(text, base, now, advisorWorld().atlas ?? undefined);
    const s = buildAdvisorShortlist({ answers, catalog: world, catalogVersion: version, now, previous: null, assumptions: [] });
    out.push({ text, discovery: answers.discovery, readout: s.readout, picks: s.picks.map((p) => ({ name: p.name, why: p.why, feel: p.feel, length: p.length, nights: p.nights, match: p.match, tradeoffs: p.tradeoffs })), alternates: s.alternates.map((p) => p.name) });
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
}, 120_000);
