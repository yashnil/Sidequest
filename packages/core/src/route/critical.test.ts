import { describe, expect, it } from 'vitest';
import { LADDER_LIMITS, describeUnplaced, placementBlocksReady, splitAlternatives, stripTrailingDescriptor, placementQueries, placementReportSchema, routeCriticalRate, stripHedgeWords, unplacedCritical } from './critical';

/**
 * V10 §5 — the three bases the founder's Iceland trip failed to place, asked the
 * way V10 asks them.
 */
describe('the placement query ladder', () => {
  it('qualifies an ambiguous town with its country instead of asking bare', () => {
    const queries = placementQueries({ name: 'Selfoss', locality: 'Selfoss', regionName: 'Iceland', countryName: 'Iceland' });
    expect(queries[0]).toBe('Selfoss, Iceland');
    /* The bare form is still tried, last: it is a fallback, not the first thing asked. */
    expect(queries[queries.length - 1]).toBe('Selfoss');
  });

  it("strips the draft's own hedge word, which defeats an exact match", () => {
    expect(stripHedgeWords('Höfn area')).toBe('Höfn');
    expect(stripHedgeWords('Greater Reykjavík')).toBe('Reykjavík');
    expect(stripHedgeWords('Jasper')).toBeNull();
    /*
     * And the words that are hedge-shaped but are part of real names stay:
     * stripping them would turn a lake district into a lake.
     */
    expect(stripHedgeWords('Lake District')).toBeNull();
    expect(stripHedgeWords('District of Columbia')).toBeNull();
    expect(stripHedgeWords('Central Park')).toBeNull();
    /* And a name that is only a hedge is left alone rather than emptied. */
    expect(stripHedgeWords('Area')).toBeNull();
  });

  it('tries the hedge-stripped form with full context before the bare hedged name', () => {
    const queries = placementQueries({ name: 'Höfn area', locality: 'Höfn area', regionName: 'Iceland', countryName: 'Iceland' });
    expect(queries).toContain('Höfn, Iceland');
    expect(queries.indexOf('Höfn, Iceland')).toBeLessThan(queries.indexOf('Höfn area'));
  });

  it('uses the province as well as the country where one is known', () => {
    const queries = placementQueries({ name: 'Jasper', regionName: 'the Canadian Rockies', countryName: 'Canada', divisions: ['Alberta'] });
    expect(queries[0]).toBe('Jasper, Alberta, Canada');
    expect(queries).toContain('Jasper, Canada');
  });

  it('does not repeat context the name already carries', () => {
    expect(placementQueries({ name: 'Vík í Mýrdal, Iceland', countryName: 'Iceland' })).toEqual(['Vík í Mýrdal, Iceland']);
    expect(placementQueries({ name: 'Jasper, Alberta', countryName: 'Canada', divisions: ['Alberta'] })[0]).toBe('Jasper, Alberta, Canada');
  });

  it('falls back to the bare name when no context exists at all', () => {
    expect(placementQueries({ name: 'Vík' })).toEqual(['Vík']);
  });

  it('never asks the same thing twice and stays inside eight queries', () => {
    const queries = placementQueries({ name: 'Selfoss area', locality: 'Selfoss', regionName: 'Iceland', countryName: 'Iceland', divisions: ['Suðurland'] });
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.length).toBeLessThanOrEqual(8);
  });

  /*
   * V10 §5 — the three names a live composition wrote that placed nothing. Every
   * one is a real place with something a traveller finds useful appended, and no
   * map source holds the phrase.
   */
  it("asks for each side of a base that names a choice", () => {
    expect(splitAlternatives('Hof / Jokulsarlon area')).toEqual(['Hof', 'Jokulsarlon area']);
    expect(splitAlternatives('Calgary or Edmonton')).toEqual(['Calgary', 'Edmonton']);
    /* A name with no alternation is not split, and a fragment too short to be a name is refused. */
    expect(splitAlternatives('Reykjavík')).toEqual([]);
    /* A real place name can be three letters, so the floor is two — and a single letter is not a name. */
    expect(splitAlternatives('A / B')).toEqual([]);
    expect(splitAlternatives('Hof / Vik')).toEqual(['Hof', 'Vik']);
    const queries = placementQueries({ name: 'Hof / Jokulsarlon area', regionName: 'Iceland', countryName: 'Iceland' });
    expect(queries[0]).toBe('Hof / Jokulsarlon area, Iceland');
    expect(queries).toContain('Hof, Iceland');
    expect(queries).toContain('Jokulsarlon, Iceland');
  });

  it('asks again without the descriptor a draft appended, and never first', () => {
    expect(stripTrailingDescriptor('Skaftafell hiking trails')).toBe('Skaftafell');
    expect(stripTrailingDescriptor('Fjadrargljufur canyon')).toBe('Fjadrargljufur');
    expect(stripTrailingDescriptor('Solheimajokull glacier walk')).toBe('Solheimajokull');
    expect(stripTrailingDescriptor('Vatnajokull National Park roadside views')).toBe('Vatnajokull National Park');

    /* And the names where the descriptor IS the name keep it — asked for as themselves, first. */
    expect(stripTrailingDescriptor('Skógafoss')).toBeNull();
    expect(stripTrailingDescriptor('Dyrholaey')).toBeNull();
    const beach = placementQueries({ name: 'Diamond Beach', regionName: 'Iceland', countryName: 'Iceland' });
    expect(beach[0]).toBe('Diamond Beach, Iceland');
    /* "Lake District" survives whole: "district" is not a descriptor and four letters is not a name. */
    expect(stripTrailingDescriptor('Lake District')).toBeNull();
    expect(stripTrailingDescriptor('Cape Town')).toBeNull();

    const queries = placementQueries({ name: 'Skaftafell hiking trails', regionName: 'Iceland', countryName: 'Iceland' });
    expect(queries[0]).toBe('Skaftafell hiking trails, Iceland');
    expect(queries.indexOf('Skaftafell, Iceland')).toBeGreaterThan(0);
  });
});

describe('what a ladder may cost', () => {
  it('spends three queries on a base and two on a stop, because a silent provider walks the whole ladder', () => {
    const full = placementQueries({ name: 'Selfoss area', locality: 'Selfoss', regionName: 'Iceland', countryName: 'Iceland', divisions: ['Suðurland'] });
    expect(full.length).toBeGreaterThan(LADDER_LIMITS.base);
    expect(LADDER_LIMITS.base).toBe(4);
    expect(LADDER_LIMITS.route_defining_stop).toBe(3);
    expect(LADDER_LIMITS.gateway).toBe(2);
    /* The most-qualified form is always inside the cap, which is the point of ordering it first. */
    expect(full.slice(0, LADDER_LIMITS.route_defining_stop)[0]).toBe(full[0]);
  });
});

describe('the placement report', () => {
  const report = placementReportSchema.parse({
    version: 1,
    placements: [
      { id: 'base:reykjavik', name: 'Reykjavík', kind: 'base', outcome: 'placed', coordinates: { lat: 64.146, lng: -21.942 }, attempts: [{ query: 'Reykjavík, Iceland', outcome: 'placed', candidates: 3 }] },
      { id: 'base:vik', name: 'Vík', kind: 'base', outcome: 'no_acceptable_candidate', attempts: [{ query: 'Vík, Iceland', outcome: 'no_acceptable_candidate', candidates: 0 }, { query: 'Vík', outcome: 'no_acceptable_candidate', candidates: 4 }] },
      { id: 'base:hofn', name: 'Höfn area', kind: 'base', outcome: 'ambiguous', attempts: [{ query: 'Höfn, Iceland', outcome: 'ambiguous', candidates: 2 }] },
      { id: 'stop:gullfoss', name: 'Gullfoss', kind: 'route_defining_stop', outcome: 'placed', coordinates: { lat: 64.327, lng: -20.12 }, attempts: [] },
    ],
    providerCalls: 6,
    elapsedMs: 1800,
  });

  it('measures the rate over the critical names only', () => {
    expect(routeCriticalRate(report)).toBe(0.5);
    expect(unplacedCritical(report).map((p) => p.id)).toEqual(['base:vik', 'base:hofn']);
  });

  it('refuses to call a trip ready with an unplaced base', () => {
    expect(placementBlocksReady(report)).toBe(true);
  });

  it('does not block ready on a decorative stop', () => {
    const decorative = placementReportSchema.parse({ version: 1, placements: [{ id: 's', name: 'A viewpoint', kind: 'route_defining_stop', outcome: 'no_acceptable_candidate', attempts: [] }] });
    expect(placementBlocksReady(decorative)).toBe(false);
    expect(routeCriticalRate(decorative)).toBe(0);
  });

  it('reports a perfect rate when nothing critical needed placing', () => {
    expect(routeCriticalRate(placementReportSchema.parse({ version: 1 }))).toBe(1);
  });

  it('records every query it tried, which is the diagnostic that was missing', () => {
    const vik = report.placements.find((p) => p.id === 'base:vik')!;
    expect(vik.attempts.map((a) => a.query)).toEqual(['Vík, Iceland', 'Vík']);
  });

  it('says what happened without naming a provider or a field', () => {
    for (const placement of unplacedCritical(report)) {
      const sentence = describeUnplaced(placement);
      expect(sentence).not.toMatch(/nominatim|geocoder|outcome|provider_unavailable|placement/i);
      expect(sentence).toContain(placement.name);
    }
    expect(describeUnplaced(report.placements[2]!)).toContain('will not guess');
  });
});
