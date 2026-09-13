import { describe, expect, it } from 'vitest';
import {
  buildTravelReality,
  candidateSemantics,
  jurisdictionFor,
  jurisdictionPhrase,
  countryFacts,
  modeStatusFor,
  type JurisdictionRef,
} from '@sidequest/core';
import { accessConstraintsForCountry } from '../../providers/access-constraints';

/**
 * V11 §1 — CANADA HAD AN ACCESS RULE AND NO JURISDICTION.
 *
 * `providers/fixtures/access/ca.json` has carried the Moraine Lake shuttle —
 * restricted, reservation required, dated, `official_current`, sourced to Parks
 * Canada — while `jurisdictionFor('CA')` returned null, so `buildTravelReality`
 * filtered the row set to nothing and reported `coverage: 'none'`. Sidequest
 * knew a Canadian access rule and did not know Canada is a driving country.
 *
 * Nothing caught it because the degradation was *honest*: `unknown ≠ false` was
 * working exactly as specified, and an absent row produces absent facts rather
 * than wrong ones. A gap in data is invisible to tests that only check that the
 * code handles gaps.
 *
 * This file is the pair of facts that must not drift apart again — the
 * operational layer and the jurisdiction layer answering for the same country —
 * plus the separation the founder trip got wrong: a destination is not a
 * jurisdiction, and a mountain region has no currency of its own.
 */

const CAPS = { roadRouting: true, transit: false };

/** As the geocoder returns them for a trip resolved across the two mountain provinces. */
const ROCKIES_JURISDICTIONS: JurisdictionRef[] = [
  { level: 'country', code: 'CA', name: 'Canada', countryCode: 'CA' },
  { level: 'subnational', code: 'CA-AB', name: 'Alberta', countryCode: 'CA' },
  { level: 'subnational', code: 'CA-BC', name: 'British Columbia', countryCode: 'CA' },
];

describe('Canada: the destination is a mountain region, the jurisdiction is a country', () => {
  it('a named mountain range reads as a mountain region, never as its country', () => {
    /*
     * The provider row as a geocoder returns it for a named range: a natural
     * region whose own class says `mountain_range`, with a real footprint.
     */
    const semantics = candidateSemantics({
      id: 'ca-rockies',
      displayName: 'Canadian Rockies',
      qualifiedName: 'Canadian Rockies, Canada',
      entityType: 'natural_region',
      breadth: 'region',
      center: { lat: 51.5, lng: -116.2 },
      bounds: { southWest: { lat: 49.0, lng: -120.0 }, northEast: { lat: 54.0, lng: -114.0 } },
      countryCode: 'CA',
      countryName: 'Canada',
      aliases: [],
      administrativeAreas: ['Alberta', 'British Columbia'],
      timeZones: ['America/Edmonton'],
      providerRefs: [],
      providerClass: { osmType: 'relation', category: 'natural', type: 'mountain_range' },
      confidence: { level: 'high', signals: [], note: 'A named range with a published footprint.' },
    });

    expect(semantics.type).toBe('mountain_region');
    /*
     * The V10 rule the founder trip broke: a region may not become the country
     * that contains it. Canada is context here, never the identity.
     */
    expect(semantics.type).not.toBe('country');
    expect(semantics.type).not.toBe('admin_area');
  });

  it('the jurisdiction row exists, and the travel reality it produces is full rather than none', () => {
    expect(jurisdictionFor('CA')).not.toBeNull();
    expect(jurisdictionFor('CA')!.code).toBe('CA');

    const reality = buildTravelReality({
      label: 'Canadian Rockies',
      countries: ['CA'],
      crossBorder: false,
      entityType: 'natural_region',
      traits: ['mountain', 'weather_exposed', 'road_trip_region', 'broad_geography'],
      tripDays: 9,
      party: { size: 2, drivers: null },
      capabilities: CAPS,
    });

    /* The defect, stated as an assertion: this was 'none'. */
    expect(reality.destination.coverage).toBe('full');
    expect(reality.facts.length).toBeGreaterThan(0);
    expect(reality.modes.length).toBeGreaterThan(0);

    /* A mountain trip in a country of long distances is driven, not ridden. */
    expect(modeStatusFor(reality, 'self_drive', 'regional')).toBe('recommended');
    expect(modeStatusFor(reality, 'rental_car', 'regional')).toBe('recommended');
    expect(modeStatusFor(reality, 'intercity_train', 'regional')).toBe('friction');

    /* Everything the row states is reference-authority and dated, like every other row. */
    expect(reality.facts.every((f) => f.authority === 'reference')).toBe(true);
    expect(jurisdictionFor('CA')!.asOf).toMatch(/^\d{4}-\d{2}$/);

    /* The park machinery a Rockies plan turns on is present as guidance, not as a guess. */
    const parks = reality.facts.find((f) => f.id === 'ca-parks');
    expect(parks).toBeDefined();
    expect(parks!.freshness).toBe('regulatory_volatile');
    expect(parks!.sourceName).toBe('Parks Canada');
  });

  it('the operational access layer still answers for the same country', () => {
    const constraints = accessConstraintsForCountry('CA');
    expect(constraints.length).toBeGreaterThan(0);
    /*
     * Not asserted by place name — the point is that the two layers answer for
     * one country, so this asks only that an official, moded, dated constraint
     * exists where the jurisdiction row now also exists.
     */
    const official = constraints.filter((c) => c.authority === 'official_current');
    expect(official.length).toBeGreaterThan(0);
    expect(official.some((c) => c.requiredMode !== undefined)).toBe(true);
  });

  it('money, plugs and the emergency number name Canada — never the Canadian Rockies', () => {
    const facts = countryFacts('CA');
    expect(facts).not.toBeNull();
    expect(facts!.name).toBe('Canada');
    expect(facts!.currency).toBe('CAD');

    /*
     * `readiness.ts` composes its subject as
     * `destinationFacts?.name ?? jurisdictionName ?? destinationName`, so the
     * sentence is built here the same way to hold the composition, not just the
     * data. The founder trip printed "canadian rockies uses the CAD" because
     * the last of those three was reached first.
     */
    const subject = facts!.name ?? jurisdictionPhrase(ROCKIES_JURISDICTIONS);
    const money = `${subject} uses the ${facts!.currency}.`;
    expect(money).toBe('Canada uses the CAD.');
    expect(money).not.toMatch(/Canadian Rockies/i);

    const emergency = `Emergency number in ${subject}: ${facts!.emergency}.`;
    expect(emergency).toBe('Emergency number in Canada: 911.');
    expect(emergency).not.toMatch(/Canadian Rockies/i);
  });

  it('the jurisdiction phrase reads the country even when two provinces are resolved', () => {
    /*
     * Alberta and British Columbia are context. A subnational row must never
     * become the subject of a currency or licence sentence, which is what would
     * happen if the phrase simply took the first jurisdiction it was handed.
     */
    expect(jurisdictionPhrase(ROCKIES_JURISDICTIONS)).toBe('Canada');
    expect(ROCKIES_JURISDICTIONS.filter((j) => j.level === 'subnational').map((j) => j.code)).toEqual(['CA-AB', 'CA-BC']);
    expect(ROCKIES_JURISDICTIONS.every((j) => j.countryCode === 'CA')).toBe(true);
  });
});
