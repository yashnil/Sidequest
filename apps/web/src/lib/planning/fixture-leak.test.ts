import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers, type Trip } from '@sidequest/core';
import { COMPOSITION_INSTRUCTION, buildCompositionTask, compositionUntrustedPayload, type CompositionContext } from './composition';
import { FIXTURE_UNVERIFIABLE_ANCHOR } from './fixture-composer';
import { testCompositionContext } from './testing/context';

/**
 * FIXTURE PLACEHOLDER LANGUAGE NEVER LEAKS INTO A PRODUCTION COMPOSITION.
 *
 * "Harbour City" is a synthetic world and "A Quiet Overlook Nobody Documented"
 * is the fixture composer's deliberately unverifiable stop. Neither may reach
 * the real model's instruction or task for any destination, and the fixture
 * composer itself may only be constructed behind the fixture switch.
 */
const FIXTURE_PHRASES = ['Harbour City', FIXTURE_UNVERIFIABLE_ANCHOR, 'Testland', 'Wide Republic', 'Outer Isles', 'Long Road Country'];

const TRIP: Trip = {
  id: 'trip-leak',
  basics: { mode: 'known_destination', destinationInput: 'Mammoth Lakes', regionId: 'eastern-sierra', startDate: '2026-08-12', endDate: '2026-08-16', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'draft',
  createdAt: '2026-09-04T00:00:00Z',
  updatedAt: '2026-09-04T00:00:00Z',
};

describe('fixture placeholder language stays out of production composition', () => {
  it('the instruction, task and untrusted payload for a real destination carry no fixture phrase', () => {
    const profile = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 5 }), { travelerNeeds: [], tripDays: 5 });
    const context: CompositionContext = testCompositionContext({ trip: TRIP, profile, envelope: { name: 'Mammoth Lakes', center: { lat: 37.65, lng: -118.97 } }, now: new Date('2026-09-04T00:00:00Z') });
    const text = [COMPOSITION_INSTRUCTION, buildCompositionTask(context), JSON.stringify(compositionUntrustedPayload(context))].join('\n');
    for (const phrase of FIXTURE_PHRASES) expect(text, phrase).not.toContain(phrase);
  });

  it('the fixture composer is only ever constructed behind the fixture switch', () => {
    const source = readFileSync(new URL('./production-plan.ts', import.meta.url), 'utf8');
    const constructions = [...source.matchAll(/new FixtureComposer\(/g)].length;
    expect(constructions).toBe(1);
    const guarded = /if \(fixture\) \{\s*model = new FixtureComposer\(/.test(source);
    expect(guarded, 'FixtureComposer must be constructed only inside `if (fixture)`').toBe(true);
    expect(source).toMatch(/const fixture = isFixtureComposer\(\)/);
  });

  /*
   * MVP V3 — the badge follows the SWITCH, not the build.
   *
   * It used to be gated on `NODE_ENV !== 'production'` as well, and that hid it
   * in the one place it was most needed: a production build running the fixture
   * composer, which is exactly how the screenshot walks and the browser suite
   * run. A screenshot walk against such a build then drove the real Build button
   * and bought an Anthropic completion nobody had authorised, with no sign
   * anywhere on the page that fixtures were in play.
   *
   * A production *deployment* with `SIDEQUEST_COMPOSER_PROVIDER=fixture` is a
   * misconfiguration, and a badge saying so is the correct response to it — far
   * better than serving fixture itineraries silently.
   */
  it('the fixture badge follows the fixture switch alone, on both pages', () => {
    for (const page of ['../../app/(product)/trips/[id]/questionnaire/page.tsx', '../../app/(product)/trips/[id]/itinerary/page.tsx']) {
      const source = readFileSync(new URL(page, import.meta.url), 'utf8');
      expect(source, page).toMatch(/fixtureMode=\{isFixtureComposer\(\)\}|isFixtureComposer\(\)/);
      expect(source, `${page} must not hide the fixture badge on a production build`).not.toMatch(/NODE_ENV !== 'production' && isFixtureComposer/);
    }
  });
});
