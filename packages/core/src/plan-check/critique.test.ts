import { describe, expect, it } from 'vitest';
import { applyPlanChanges, bestFixedEndsOrder, critiquePlan, defaultAcceptedChanges, estimateFlightMinutes, estimateHighSpeedRailMinutes, estimateMove, type PlanCheckStopInput } from './critique';

/**
 * Synthetic stops: invented labels at chosen coordinates, so every assertion
 * is about geometry, nights and a country code's facts — never about a place
 * the code could know by name.
 */
function stop(label: string, lat: number, lng: number, nights: number | null, extra: Partial<PlanCheckStopInput> = {}): PlanCheckStopInput {
  return { label, point: { lat, lng }, countryCode: 'JP', kind: 'city', nights, nightsBasis: nights === null ? null : 'stated', dayTrip: false, ...extra };
}

describe('estimateMove — the mode comes from the country facts and the distance', () => {
  it('uses high-speed rail where the country row makes it the backbone, and says it is an estimate by construction', () => {
    const move = estimateMove({ point: { lat: 35.68, lng: 139.76 }, countryCode: 'JP' }, { point: { lat: 35.01, lng: 135.77 }, countryCode: 'JP' });
    expect(move.mode).toBe('high_speed_rail');
    expect(move.minutes).toBe(estimateHighSpeedRailMinutes(move.straightKm));
    expect(move.flightSuggested).toBe(false);
  });

  it('uses the road where the country row recommends driving', () => {
    const move = estimateMove({ point: { lat: 47.6, lng: -122.33 }, countryCode: 'US' }, { point: { lat: 46.85, lng: -121.7 }, countryCode: 'US' });
    expect(move.mode).toBe('drive');
  });

  it('falls back to a labelled road estimate when no country facts are bundled', () => {
    const move = estimateMove({ point: { lat: 10, lng: 10 }, countryCode: 'ZZ' }, { point: { lat: 10.5, lng: 10.5 }, countryCode: 'ZZ' });
    expect(move.mode).toBe('drive');
    expect(move.reason).toMatch(/No transport facts/);
  });

  it('makes a jump beyond a day overland a flight, never a drive', () => {
    const move = estimateMove({ point: { lat: -41.13, lng: -71.31 }, countryCode: 'AR' }, { point: { lat: -50.34, lng: -72.27 }, countryCode: 'AR' });
    expect(move.straightKm).toBeGreaterThan(900);
    expect(move.mode).toBe('flight');
    expect(move.minutes).toBe(estimateFlightMinutes(move.straightKm));
  });

  it('offers a flight beside a long ground estimate', () => {
    const move = estimateMove({ point: { lat: 35.68, lng: 139.76 }, countryCode: 'JP' }, { point: { lat: 43.06, lng: 141.35 }, countryCode: 'JP' });
    expect(move.mode).toBe('high_speed_rail');
    expect(move.flightSuggested).toBe(true);
    expect(move.flightMinutes).not.toBeNull();
  });
});

describe('bestFixedEndsOrder', () => {
  it('keeps the ends and finds the shorter middle', () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 3 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
      { lat: 0, lng: 4 },
    ];
    expect(bestFixedEndsOrder(points)).toEqual([0, 2, 3, 1, 4]);
  });
});

describe('critiquePlan — pace', () => {
  it('calls four places in nine nights too much when two are one-night stands, with numbers in every sentence', () => {
    const result = critiquePlan({
      totalNights: 9,
      stops: [stop('Alpha', 35.68, 139.76, 3), stop('Bravo', 35.01, 135.77, 1), stop('Charlie', 34.69, 135.5, 1), stop('Delta', 43.06, 141.35, 4)],
    });
    expect(result.verdict).toBe('too_much');
    expect(result.metrics.hotelMoves).toBe(3);
    expect(result.findings.find((f) => f.id === 'moves')!.sentence).toMatch(/4 places to sleep in 9 nights is 3 hotel moves — about 2\.3 nights per place/);
    expect(result.findings.find((f) => f.id === 'move-share')!.sentence).toMatch(/\(estimate\)/);
    expect(result.findings.some((f) => f.id === 'short-1' && f.severity === 'major')).toBe(true);
    /* Two cities about 40 km apart: the short one becomes a day trip from its neighbour. */
    const merge = result.suggestions.find((s) => s.kind === 'merge')!;
    expect(merge.sentence).toMatch(/day trip from (Bravo|Charlie) — about \d+ (h|min)/);
    expect(merge.sentence).toMatch(/\(estimate\)/);
    expect(result.improved!.stops.filter((s) => !s.dayTrip).length).toBe(3);
    expect(result.improved!.stops.reduce((n, s) => n + s.nights, 0)).toBe(9);
  });

  it('calls two places in ten nights comfortable and offers side trips from the long stay', () => {
    const result = critiquePlan({ totalNights: 10, stops: [stop('Alpha', 35.68, 139.76, 6), stop('Bravo', 35.01, 135.77, 4)] });
    expect(result.verdict).toBe('comfortable');
    expect(result.improved).toBeNull();
    expect(result.suggestions.filter((s) => s.kind === 'side_trip').length).toBe(2);
  });

  it('does not judge the pace without a length, and says what is missing', () => {
    const result = critiquePlan({ totalNights: null, stops: [stop('Alpha', 35.68, 139.76, null), stop('Bravo', 35.01, 135.77, null)] });
    expect(result.verdict).toBe('unknown');
    expect(result.findings.some((f) => f.id === 'no-length')).toBe(true);
    expect(result.moves).toHaveLength(1);
  });

  it('asks a region for more nights than a town', () => {
    const result = critiquePlan({ totalNights: 6, stops: [stop('Alpha', 35.68, 139.76, 4), stop('Bravo Region', 36.5, 138.2, 2, { kind: 'admin_region' })] });
    expect(result.findings.find((f) => f.id === 'short-1')!.sentence).toMatch(/needs about 3/);
  });
});

describe('critiquePlan — route order', () => {
  it('names the backtracking and the shorter order with the first and last stops kept', () => {
    const result = critiquePlan({
      totalNights: 12,
      stops: [stop('Start', 0, 0, 3, { countryCode: 'ZZ' }), stop('Far', 0, 3, 3, { countryCode: 'ZZ' }), stop('Near', 0, 1, 3, { countryCode: 'ZZ' }), stop('End', 0, 4, 3, { countryCode: 'ZZ' })],
    });
    const order = result.findings.find((f) => f.id === 'order')!;
    expect(order.sentence).toMatch(/doubles back/);
    expect(order.sentence).toMatch(/\d+ km/);
    expect(result.suggestions.find((s) => s.kind === 'reorder')!.sentence).toContain('Start → Near → Far → End');
    expect(result.improved!.stops.map((s) => s.label)).toEqual(['Start', 'Near', 'Far', 'End']);
  });

  it('flags returning to a place mid-trip but not a loop back to the start', () => {
    const loop = critiquePlan({ totalNights: 9, stops: [stop('Alpha', 35.68, 139.76, 3), stop('Bravo', 35.01, 135.77, 3), stop('Alpha', 35.68, 139.76, 3)] });
    expect(loop.findings.some((f) => f.id.startsWith('revisit'))).toBe(false);
    const back = critiquePlan({ totalNights: 12, stops: [stop('Alpha', 35.68, 139.76, 3), stop('Bravo', 35.01, 135.77, 3), stop('Alpha', 35.68, 139.76, 3), stop('Delta', 43.06, 141.35, 3)] });
    expect(back.findings.some((f) => f.id.startsWith('revisit'))).toBe(true);
  });
});

describe('critiquePlan — unknown is not false', () => {
  it('keeps an unplaced stop, says it was not checked, and estimates nothing to or from it', () => {
    const result = critiquePlan({ totalNights: 6, stops: [stop('Alpha', 35.68, 139.76, 3), { ...stop('Nowhere', 0, 0, 3), point: null }] });
    expect(result.metrics.unplaced).toEqual(['Nowhere']);
    expect(result.findings.find((f) => f.id === 'unplaced')!.sentence).toMatch(/Not checked/);
    expect(result.moves[0]!.minutes).toBeNull();
    expect(result.moves[0]!.mode).toBeNull();
    expect(result.metrics.routeKm).toBeNull();
  });

  it('says an island move may be a ferry or flight rather than claiming a road', () => {
    const result = critiquePlan({ totalNights: 6, stops: [stop('Alpha', 57.48, -4.22, 3, { countryCode: 'GB' }), stop('Isle', 57.36, -6.3, 3, { countryCode: 'GB', kind: 'island' })] });
    expect(result.findings.some((f) => f.id.startsWith('water') && /ferry or a flight/.test(f.sentence))).toBe(true);
  });

  it('labels every travel figure in a sentence as an estimate', () => {
    const result = critiquePlan({ totalNights: 5, stops: [stop('Alpha', -41.13, -71.31, 2, { countryCode: 'AR' }), stop('Bravo', -50.34, -72.27, 3, { countryCode: 'AR' })] });
    for (const sentence of [...result.findings, ...result.suggestions].map((f) => f.sentence)) {
      if (/\d+ (h|min)\b/.test(sentence)) expect(sentence).toMatch(/estimate/);
    }
  });
});

describe('critiquePlan — the change-aware proposal', () => {
  const rushed = () =>
    critiquePlan({
      totalNights: 6,
      stops: [stop('Alpha', 35.68, 139.76, 2), stop('Bravo', 38.27, 140.87, 1), stop('Charlie', 37.9, 139.02, 1), stop('Delta', 36.65, 138.18, 1), stop('Echo', 36.56, 136.65, 1)],
    });

  it('optimises freely: as many cuts as the pace needs, each its own major change, none applied by default', () => {
    const result = critiquePlan({
      totalNights: 6,
      stops: [0, 2, 4, 6, 8].map((lng, i) => stop(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'][i]!, 0, lng, i === 0 ? 2 : 1, { countryCode: 'ZZ' })),
    });
    expect(result.verdict).toBe('too_much');
    const cuts = result.proposal.changes.filter((c) => c.kind === 'cut');
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    for (const cut of cuts) {
      expect(cut.class).toBe('major');
      expect(cut.touches.join(' ')).toMatch(/removes .+, a place you named/);
    }
    expect(result.proposal.measure.suggested.verdict).not.toBe('too_much');
    const defaults = defaultAcceptedChanges(result.proposal.changes);
    for (const cut of cuts) expect(defaults.has(cut.id)).toBe(false);
    /* Nothing accepted is the plan as written. */
    expect(applyPlanChanges(result.proposal.original, result.proposal.changes, new Set()).map((s) => [s.label, s.nights])).toEqual(result.proposal.original.map((s) => [s.label, s.nights]));
  });

  it('keeps the trip length whatever subset is accepted, and toggling a change back is the exact undo', () => {
    const result = rushed();
    const ids = result.proposal.changes.map((c) => c.id);
    for (let mask = 0; mask < 1 << Math.min(ids.length, 6); mask += 1) {
      const accepted = new Set(ids.filter((_, i) => mask & (1 << i)));
      const version = applyPlanChanges(result.proposal.original, result.proposal.changes, accepted);
      expect(version.reduce((n, s) => n + s.nights, 0)).toBe(6);
    }
    const one = new Set([ids[0]!]);
    const after = applyPlanChanges(result.proposal.original, result.proposal.changes, one);
    one.delete(ids[0]!);
    expect(applyPlanChanges(result.proposal.original, result.proposal.changes, one)).toEqual(applyPlanChanges(result.proposal.original, result.proposal.changes, new Set()));
    expect(after).not.toEqual(result.proposal.original);
  });

  it('classifies a reorder that keeps every stop and night as safe, and one that moves a booked stay as major', () => {
    const stops = [stop('Start', 0, 0, 3, { countryCode: 'ZZ' }), stop('Far', 0, 3, 3, { countryCode: 'ZZ' }), stop('Near', 0, 1, 3, { countryCode: 'ZZ' }), stop('End', 0, 4, 3, { countryCode: 'ZZ' })];
    const safe = critiquePlan({ totalNights: 12, stops }).proposal.changes.find((c) => c.kind === 'reorder')!;
    expect(safe.class).toBe('safe');
    expect(safe.saving.routeKm).toBeGreaterThan(0);
    const booked = critiquePlan({ totalNights: 12, stops: stops.map((s) => (s.label === 'Far' ? { ...s, fixed: true } : s)) }).proposal.changes.find((c) => c.kind === 'reorder')!;
    expect(booked.class).toBe('major');
    expect(booked.touches[0]).toMatch(/booked stay in Far/);
  });

  it('never cuts or merges a booked stay', () => {
    const result = critiquePlan({
      totalNights: 6,
      stops: [stop('Alpha', 35.68, 139.76, 2), stop('Bravo', 38.27, 140.87, 1, { fixed: true }), stop('Charlie', 37.9, 139.02, 1, { fixed: true }), stop('Delta', 36.65, 138.18, 1, { fixed: true }), stop('Echo', 36.56, 136.65, 1)],
    });
    expect(result.proposal.changes.filter((c) => (c.op.kind === 'cut' || c.op.kind === 'day_trip') && ['Bravo', 'Charlie', 'Delta'].includes(c.op.label))).toHaveLength(0);
  });

  it('turns a stated stay into a day trip only as a major change that says it changes their nights', () => {
    const result = critiquePlan({
      totalNights: 9,
      stops: [stop('Alpha', 35.68, 139.76, 3), stop('Bravo', 35.01, 135.77, 1), stop('Charlie', 34.69, 135.5, 1), stop('Delta', 43.06, 141.35, 4)],
    });
    const merge = result.proposal.changes.find((c) => c.kind === 'day_trip')!;
    expect(merge.class).toBe('major');
    expect(merge.touches.join(' ')).toMatch(/changes the 1 night you gave/);
    expect(merge.saving.hotelMoves).toBe(1);
  });

  it('moves a night between two stays Sidequest split as a safe change, never between stated ones', () => {
    const spread = critiquePlan({ totalNights: 6, stops: [stop('Alpha', 35.68, 139.76, 5, { nightsBasis: 'spread' }), stop('Bravo Region', 39.7, 140.1, 1, { kind: 'admin_region', nightsBasis: 'spread' })] });
    const shift = spread.proposal.changes.find((c) => c.kind === 'nights');
    expect(shift?.class).toBe('safe');
    expect(defaultAcceptedChanges(spread.proposal.changes).has(shift!.id)).toBe(true);
    const statedOnes = critiquePlan({ totalNights: 6, stops: [stop('Alpha', 35.68, 139.76, 5), stop('Bravo Region', 39.7, 140.1, 1, { kind: 'admin_region' })] });
    expect(statedOnes.proposal.changes.filter((c) => c.kind === 'nights')).toHaveLength(0);
  });

  it('a flight is safe where they named no way to travel and major where it replaces the train they planned', () => {
    const free = critiquePlan({ totalNights: 8, stops: [stop('Alpha', 35.68, 139.76, 4), stop('Delta', 43.06, 141.35, 4)] });
    expect(free.proposal.changes.find((c) => c.kind === 'transport')?.class).toBe('safe');
    const theirs = critiquePlan({ totalNights: 8, stops: [stop('Alpha', 35.68, 139.76, 4), stop('Delta', 43.06, 141.35, 4, { transportIn: 'rail' })] });
    const fly = theirs.proposal.changes.find((c) => c.kind === 'transport')!;
    expect(fly.class).toBe('major');
    expect(fly.touches[0]).toMatch(/train you planned/);
  });
});
