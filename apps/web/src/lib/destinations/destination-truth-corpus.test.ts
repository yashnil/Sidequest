import { describe, expect, it } from 'vitest';
import {
  centreIsStandIn,
  degradedToCountry,
  diagonalKm,
  framingIsUnsafe,
  jurisdictionPhrase,
  parseDestinationIntent,
  phraseSemanticType,
  type GeographicScale,
  type GeographicSemanticType,
} from '@sidequest/core';
import { resolveDestinationPhrase, type CachedConcept } from './intent-resolution';
import { fixtureInterpreter } from './interpretation';
import { recordedResolver } from './fixtures/recorded-resolver';

/**
 * V10 §2 §18 — A DESTINATION REGION MAY NEVER BECOME ITS CONTAINING COUNTRY.
 *
 * The V8.1 corpus is the reason "the Canadian Rockies" no longer resolves to a
 * shop in Calgary, and it is green. It also never exercised the path the founder
 * actually hit: **the geocoder answering nothing at all.** One swallowed throw
 * (`catch { return null }` in `resolveIntentGraph`'s `ask`), which a public
 * Nominatim instance produces routinely under load, left every part unresolved,
 * and the loop that fills an unresolved part from its containing country then
 * produced `type: country`, `scale: country`, `confidence: high`, centred on
 * Canada's published point — 2,700 km from the destination, in Ontario.
 *
 * So this corpus drives every phrase down **three** paths and asserts the same
 * invariants on all of them:
 *
 *   recorded    the geocoder answers, as V8.1 already covers
 *   silent      the geocoder throws on every query (429, timeout, outage)
 *   no provider no geocoder is configured at all
 *
 * And it separates the two country cases that look identical and are not:
 *
 *   country **named** in the phrase   "rural Japan", "the steppes of Kyrgyzstan"
 *                                     — the country is the frame the traveller
 *                                     asked for, so its point is honest
 *   country **inferred** from a demonym  "the Canadian Rockies", "the Scottish
 *                                     Highlands" — the country is Sidequest's
 *                                     reading, so its point is a stand-in and
 *                                     the map must say "still locating"
 */

const NOW = new Date('2026-09-11T12:00:00Z');
const throwingResolver = { name: 'throwing', resolve: async () => { throw new Error('429 Too Many Requests'); } } as never;

interface Expectation {
  /** What the phrase means, which no provider outage may change. */
  type: GeographicSemanticType | GeographicSemanticType[];
  /** The widest scale that is ever acceptable. `country` only where the phrase IS a country. */
  maxScale: GeographicScale;
  countries?: string[];
  /** True when the country is named in the phrase, so its point is an honest anchor rather than a stand-in. */
  countryNamed: boolean;
  /** The jurisdictions the product must talk about instead of the destination. */
  jurisdiction?: string;
}

/**
 * §18's corpus shapes: a city, a whole country, a multi-country trip, a natural
 * region, a coast, an island chain, a safari circuit, a mountain road trip, a
 * rail trip and remote wilderness — plus the two demonym phrases that produced
 * the production defect.
 */
const CORPUS: Record<string, Expectation> = {
  'the Canadian Rockies': { type: 'mountain_region', maxScale: 'region', countries: ['CA'], countryNamed: false, jurisdiction: 'Canada' },
  'the Scottish Highlands': { type: 'mountain_region', maxScale: 'region', countries: ['GB'], countryNamed: false, jurisdiction: 'United Kingdom' },
  'the Dolomites': { type: 'mountain_region', maxScale: 'region', countryNamed: false },
  'the Alps': { type: 'mountain_region', maxScale: 'continental', countryNamed: false },
  Patagonia: { type: ['informal_region', 'natural_region', 'unknown'], maxScale: 'continental', countryNamed: false },
  'the Sahara': { type: ['natural_region', 'unknown'], maxScale: 'continental', countryNamed: false },
  'the Okavango Delta': { type: ['natural_region', 'unknown'], maxScale: 'region', countryNamed: false },
  'the Amalfi Coast': { type: ['coast', 'unknown'], maxScale: 'region', countryNamed: false },
  'the Pacific Northwest': { type: ['informal_region', 'unknown'], maxScale: 'continental', countryNamed: false },
  'rural Japan': { type: 'informal_region', maxScale: 'region', countries: ['JP'], countryNamed: true, jurisdiction: 'Japan' },
  'the steppes of Kyrgyzstan': { type: ['natural_region', 'unknown'], maxScale: 'region', countries: ['KG'], countryNamed: true, jurisdiction: 'Kyrgyzstan' },
  Iceland: { type: 'country', maxScale: 'country', countries: ['IS'], countryNamed: true, jurisdiction: 'Iceland' },
  'Kenya and Tanzania': { type: ['multi_country', 'informal_region'], maxScale: 'country', countries: ['KE', 'TZ'], countryNamed: true },
  'New York City': { type: ['settlement', 'unknown'], maxScale: 'district', countryNamed: false },
  Chongqing: { type: ['city_region', 'settlement', 'unknown'], maxScale: 'region', countryNamed: false },
};

const SCALE_ORDER: GeographicScale[] = ['point', 'neighbourhood', 'settlement', 'district', 'subregion', 'region', 'country', 'continental'];

const PATHS = [
  { name: 'recorded geocoder', resolver: () => recordedResolver() },
  { name: 'geocoder silent (429/timeout)', resolver: () => throwingResolver },
  { name: 'no geocoder configured', resolver: () => null },
] as const;

describe('V10 destination truth: a region never becomes its country', () => {
  for (const path of PATHS) {
    describe(path.name, () => {
      for (const [phrase, want] of Object.entries(CORPUS)) {
        it(phrase, async () => {
          const { semantics } = await resolveDestinationPhrase({ text: phrase, resolver: path.resolver(), now: NOW, interpreter: fixtureInterpreter() });
          const phraseType = phraseSemanticType(parseDestinationIntent(phrase).children);

          /* The invariant this corpus exists for. */
          expect(degradedToCountry({ phraseType, type: semantics.type, scale: semantics.scale, centerBasis: semantics.centerBasis }), `${phrase} degraded to ${semantics.type}/${semantics.scale} on a ${semantics.centerBasis} centre`).toBe(false);

          /* The kind of thing is the phrase's own, whatever a provider did or did not do. */
          const types = Array.isArray(want.type) ? want.type : [want.type];
          expect(types, `${phrase} read as ${semantics.type}`).toContain(semantics.type);
          expect(SCALE_ORDER.indexOf(semantics.scale), `${phrase} framed at ${semantics.scale}`).toBeLessThanOrEqual(SCALE_ORDER.indexOf(want.maxScale));

          /* The traveller's words survive. */
          expect(semantics.rawText).toBe(phrase);

          /*
           * The centre is either real evidence or an admitted stand-in, and a
           * stand-in with no extent never gets framed.
           */
          if (centreIsStandIn(semantics.centerBasis)) {
            expect(semantics.confidence, `${phrase} stood in at ${semantics.confidence} confidence`).toBe('low');
            expect(semantics.extent, `${phrase} framed a stand-in`).toBeUndefined();
          }
          if (semantics.extent) {
            expect(framingIsUnsafe(semantics)).toBe(false);
            expect(diagonalKm(semantics.extent.bounds)).toBeGreaterThan(0);
          }

          /* A named country is an honest anchor; an inferred one is a stand-in. */
          if (want.countries && semantics.center) {
            const basis = semantics.centerBasis;
            if (basis === 'country_reference') expect(want.countryNamed, `${phrase} treated an inferred country as honest`).toBe(false);
            if (basis === 'country_qualified') expect(want.countryNamed, `${phrase} treated a named country as a stand-in`).toBe(true);
          }

          /* Jurisdiction is separate from destination and is what the product talks about. */
          if (want.jurisdiction) {
            expect(semantics.jurisdictions.filter((j) => j.level === 'country').map((j) => j.name)).toContain(want.jurisdiction);
            expect(jurisdictionPhrase(semantics.jurisdictions)).toContain(want.jurisdiction);
            if (semantics.type !== 'country') {
              expect(jurisdictionPhrase(semantics.jurisdictions).toLowerCase()).not.toBe(semantics.label.toLowerCase());
            }
          }
        });
      }
    });
  }

  it('the two demonym phrases defer framing when nothing places them, rather than drawing their country', async () => {
    for (const phrase of ['the Canadian Rockies', 'the Scottish Highlands']) {
      const { semantics } = await resolveDestinationPhrase({ text: phrase, resolver: throwingResolver, now: NOW, interpreter: fixtureInterpreter() });
      expect(semantics.type).toBe('mountain_region');
      expect(semantics.centerBasis).toBe('country_reference');
      expect(framingIsUnsafe(semantics), `${phrase} would have been framed`).toBe(true);
      expect(semantics.evidence.some((e) => /Nothing has placed/.test(e.note))).toBe(true);
    }
  });

  it('a named country is framed at its own scale, which is not a degradation', async () => {
    const { semantics } = await resolveDestinationPhrase({ text: 'Iceland', resolver: throwingResolver, now: NOW, interpreter: fixtureInterpreter() });
    expect(semantics.type).toBe('country');
    expect(semantics.scale).toBe('country');
    expect(framingIsUnsafe(semantics)).toBe(false);
    expect(centreIsStandIn(semantics.centerBasis)).toBe(false);
  });

  it('names the provinces a mountain region spans, and never lets one stand for the destination', async () => {
    const { semantics } = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(), now: NOW, interpreter: fixtureInterpreter() });
    const subnational = semantics.jurisdictions.filter((j) => j.level === 'subnational').map((j) => j.name);
    expect(subnational).toEqual(expect.arrayContaining(['Alberta', 'British Columbia']));
    expect(semantics.label).toBe('the Canadian Rockies');
    for (const name of subnational) expect(semantics.label.toLowerCase()).not.toBe(name.toLowerCase());
    /* And the currency sentence belongs to the country, not to the region. */
    expect(jurisdictionPhrase(semantics.jurisdictions)).toBe('Canada');
  });

  it('records where the wait went on every resolution', async () => {
    const { outcome } = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(), now: NOW, interpreter: fixtureInterpreter() });
    expect(outcome.timings.geocoderCalls).toBeGreaterThan(0);
    expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timings.cacheHit).toBe(false);
  });

  it('serves a cached concept AND its resolution without asking anything, and refuses to cache a stand-in', async () => {
    const store = new Map<string, CachedConcept>();
    const cache = { read: (k: string) => store.get(k) ?? null, write: (k: string, v: CachedConcept) => void store.set(k, v) };
    const log: string[] = [];
    const first = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(log), now: NOW, interpreter: fixtureInterpreter(), cache });
    expect(log.length).toBeGreaterThan(0);
    expect(store.size).toBe(1);
    const asked = log.length;
    const second = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(log), now: NOW, interpreter: fixtureInterpreter(), cache });
    expect(log.length).toBe(asked);
    expect(second.outcome.timings.cacheHit).toBe(true);
    expect(second.semantics.center).toEqual(first.semantics.center);
    expect(second.semantics.jurisdictions).toEqual(first.semantics.jurisdictions);

    /*
     * And the resolution comes back whole. A first draft of this cache rebuilt the
     * resolution from the concept alone, so a hit had no candidates and no
     * `unambiguousCandidateId` — which silently stopped the plan door recording a
     * selected destination and stalled the setup flow on the screen before the
     * interview. The browser suite caught it; this pins it.
     */
    expect(second.resolution.candidates.map((c) => c.id)).toEqual(first.resolution.candidates.map((c) => c.id));
    expect(second.resolution.unambiguousCandidateId).toBe(first.resolution.unambiguousCandidateId);
    expect(second.resolution.query).toBe(first.resolution.query);
    expect(second.resolution.ambiguityReasons).toEqual(first.resolution.ambiguityReasons);

    /* A stand-in is never cached: caching it would freeze the production failure for thirty days. */
    const cold = new Map<string, CachedConcept>();
    const coldCache = { read: (k: string) => cold.get(k) ?? null, write: (k: string, v: CachedConcept) => void cold.set(k, v) };
    await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: throwingResolver, now: NOW, interpreter: fixtureInterpreter(), cache: coldCache });
    expect(cold.size).toBe(0);
  });
});
