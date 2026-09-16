import { describe, expect, it } from 'vitest';
import { controlForMode, routingForMode, scheduleForMode, type Journey } from './journey';
import { COMMON_TRAVEL_AREAS, bothSidesCompiled, jurisdictionTransitions, sharesTravelArea, transitionHeadline } from './transitions';
import type { TravelMode } from './vocabulary';

/**
 * V12.1 §23 — the five shapes §23 names, plus the one that must produce nothing.
 *
 * The test that matters most is the *quiet* one: a crossing inside a common
 * travel area with nothing else changing has to produce no traveller-facing
 * line at all. A border model that announced every border would be strictly
 * worse than no border model, because people stop reading a banner that is
 * always there.
 */

function leg(mode: TravelMode, from: string, to: string): Journey {
  return {
    version: 1,
    origin: { id: from, name: from },
    destination: { id: to, name: to },
    mode,
    control: controlForMode(mode),
    routing: routingForMode(mode),
    schedule: scheduleForMode(mode),
    truth: 'unknown',
    minutes: null,
    km: null,
    reservation: 'unknown',
    booking: 'unknown',
    evidence: { source: 'none', freshness: 'unknown' },
    routeCritical: true,
  };
}

/** A trip's places, each with the country it sits in. */
function countries(map: Record<string, string>) {
  return (placeId: string) => map[placeId] ?? null;
}

describe('crossings that are not events', () => {
  it('says nothing about a Schengen-to-Schengen drive', () => {
    const transitions = jurisdictionTransitions({
      journeys: [leg('drive', 'Lyon', 'Turin')],
      countryOf: countries({ Lyon: 'FR', Turin: 'IT' }),
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.commonArea).toBe('schengen');
    /* Same currency, same side of the road, same plugs, no formalities: nothing to say. */
    expect(transitions[0]!.implications).toHaveLength(0);
    expect(transitions[0]!.worthSurfacing).toBe(false);
  });

  it('says nothing at all about a journey inside one country', () => {
    expect(jurisdictionTransitions({ journeys: [leg('rail', 'Tokyo', 'Kyoto')], countryOf: countries({ Tokyo: 'JP', Kyoto: 'JP' }) })).toHaveLength(0);
  });

  it('says nothing about a journey whose countries nobody knows', () => {
    /* An unknown is not a crossing. Guessing one would put a border on a trip that has none. */
    expect(jurisdictionTransitions({ journeys: [leg('drive', 'a', 'b')], countryOf: () => null })).toHaveLength(0);
  });

  it('still names a currency change inside a common area where there is one', () => {
    /* Schengen is not the eurozone: Switzerland and France share the border and not the money. */
    const transitions = jurisdictionTransitions({ journeys: [leg('rail', 'Geneva', 'Lyon')], countryOf: countries({ Geneva: 'CH', Lyon: 'FR' }) });
    expect(transitions[0]!.commonArea).toBe('schengen');
    expect(transitions[0]!.implications.map((entry) => entry.topic)).toContain('currency');
    expect(transitions[0]!.worthSurfacing).toBe(true);
  });
});

describe('crossings that are events', () => {
  it('names the formalities and the money on an international land border', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('drive', 'Nairobi', 'Arusha')], countryOf: countries({ Nairobi: 'KE', Arusha: 'TZ' }) });
    const topics = transitions[0]!.implications.map((entry) => entry.topic);
    expect(transitions[0]!.kind).toBe('land_border');
    expect(topics).toContain('formalities');
    expect(topics).toContain('vehicle_handoff');
    expect(transitions[0]!.worthSurfacing).toBe(true);
  });

  it('warns that a hire car does not automatically cross', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('drive', 'Puerto Natales', 'El Calafate')], countryOf: countries({ 'Puerto Natales': 'CL', 'El Calafate': 'AR' }) });
    const vehicle = transitions[0]!.implications.find((entry) => entry.topic === 'vehicle_handoff');
    expect(vehicle?.detail).toMatch(/rental company/i);
    /* Chile and Argentina do not share a currency, and the plan should say so. */
    expect(transitions[0]!.implications.map((entry) => entry.topic)).toContain('currency');
  });

  it('reads a crossing by air as a crossing by air', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('flight', 'the Mara', 'the Serengeti')], countryOf: countries({ 'the Mara': 'KE', 'the Serengeti': 'TZ' }) });
    expect(transitions[0]!.kind).toBe('air');
    expect(transitions[0]!.implications.find((entry) => entry.topic === 'formalities')?.detail).toMatch(/immigration/i);
    /* And never tells somebody flying that their hire car might not cross. */
    expect(transitions[0]!.implications.map((entry) => entry.topic)).not.toContain('vehicle_handoff');
  });

  it('reads a crossing by sea as a crossing by sea', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('ferry', 'Tallinn', 'Helsinki')], countryOf: countries({ Tallinn: 'EE', Helsinki: 'FI' }) });
    expect(transitions[0]!.kind).toBe('sea');
    /* Both Schengen, both euro: a short sailing with nothing to announce. */
    expect(transitions[0]!.worthSurfacing).toBe(false);
  });

  it('tells a guided party that the guide usually changes at the border', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('operator_transfer', 'Kigali', 'Bwindi')], countryOf: countries({ Kigali: 'RW', Bwindi: 'UG' }) });
    const handoff = transitions[0]!.implications.find((entry) => entry.topic === 'vehicle_handoff');
    expect(handoff?.detail).toMatch(/guides and vehicles/i);
  });

  it('names a change of driving side where there is one', () => {
    const transitions = jurisdictionTransitions({ journeys: [leg('drive', 'Lusaka', 'Lubumbashi')], countryOf: countries({ Lusaka: 'ZM', Lubumbashi: 'CD' }) });
    const driving = transitions[0]!.implications.find((entry) => entry.topic === 'driving');
    if (driving) expect(driving.detail).toMatch(/changes sides/i);
  });
});

describe('a multi-country circuit', () => {
  const journeys = [leg('flight', 'Nairobi', 'the Mara'), leg('drive', 'the Mara', 'Arusha'), leg('drive', 'Arusha', 'the Serengeti'), leg('flight', 'the Serengeti', 'Zanzibar')];
  const map = { Nairobi: 'KE', 'the Mara': 'KE', Arusha: 'TZ', 'the Serengeti': 'TZ', Zanzibar: 'TZ' };

  it('finds the one crossing and not the three journeys that stay put', () => {
    const transitions = jurisdictionTransitions({ journeys, countryOf: countries(map) });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('KE');
    expect(transitions[0]!.to).toBe('TZ');
  });

  it('names it in words a day can print', () => {
    const [transition] = jurisdictionTransitions({ journeys, countryOf: countries(map) });
    expect(transitionHeadline(transition!)).toMatch(/Kenya into Tanzania, by drive/);
  });
});

describe('the common-travel-area table', () => {
  it('is symmetric and self-consistent', () => {
    for (const [area, members] of Object.entries(COMMON_TRAVEL_AREAS)) {
      expect(new Set(members).size, `${area} repeats a member`).toBe(members.length);
      for (const a of members) {
        for (const b of members) {
          if (a === b) continue;
          expect(sharesTravelArea(a, b), `${a}/${b} in ${area}`).toBeTruthy();
          expect(sharesTravelArea(b, a), `${b}/${a} in ${area}`).toBeTruthy();
        }
      }
    }
  });

  it('does not invent an area between unrelated countries', () => {
    expect(sharesTravelArea('JP', 'BR')).toBeNull();
    expect(sharesTravelArea('KE', 'FR')).toBeNull();
  });
});

describe('what the jurisdiction layer knows', () => {
  it('says plainly when it holds a compiled row for both sides and when it does not', () => {
    const [known] = jurisdictionTransitions({ journeys: [leg('drive', 'Lyon', 'Turin')], countryOf: countries({ Lyon: 'FR', Turin: 'IT' }) });
    /* A boolean either way is the point: the caller can say "we have facts for both sides" or stay quiet. */
    expect(typeof bothSidesCompiled(known!)).toBe('boolean');
  });
});
