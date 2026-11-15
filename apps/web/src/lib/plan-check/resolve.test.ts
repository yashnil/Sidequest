import { describe, expect, it } from 'vitest';
import { critiquePlan, parsePlanText, type DestinationIndexEntry } from '@sidequest/core';
import { recordedResolver } from '../destinations/fixtures/recorded-resolver';
import { placePlanStops } from './resolve';
import { composerInputForPlan, destinationPhraseFor } from './to-composer';

/**
 * "I already have a plan", placed and checked against the public geocoder's
 * recorded answers (`destinations/fixtures/nominatim/`, 2026-09-11) — the same
 * replay the destination-semantics corpus uses. No live call is made: a query
 * that was not recorded answers nothing, which the resolver treats as blank.
 */

const NOW = new Date('2026-11-14T12:00:00Z');

async function check(text: string) {
  const log: string[] = [];
  const parsed = parsePlanText(text, NOW);
  const placed = await placePlanStops({ stops: parsed.stops, contextCountries: parsed.contextCountries, resolver: recordedResolver(log), now: NOW });
  const result = critiquePlan({ totalNights: parsed.totalNights, stops: placed.map((p, i) => ({ ...p, nights: parsed.stops[i]!.nights, nightsBasis: parsed.stops[i]!.nightsBasis, dayTrip: parsed.stops[i]!.dayTrip })) });
  return { parsed, placed, result, log };
}

describe('placePlanStops on recorded geocoder rows', () => {
  it('qualifies each stop by the country the plan names and places it through the gate', async () => {
    const { placed, log } = await check('Inverness, Isle of Skye and Fort William, United Kingdom in 7 days');
    expect(log.slice(0, 3)).toEqual(['Inverness, United Kingdom', 'Isle of Skye, United Kingdom', 'Fort William, United Kingdom']);
    expect(placed.every((p) => p.point !== null && p.countryCode === 'GB')).toBe(true);
    /* The island's semantic type sharpens the stop's kind. */
    expect(placed[1]!.kind).toBe('island');
  });

  it('falls back to the bare name when the qualified one is not answered, and keeps it only inside the named country', async () => {
    const { placed, log } = await check('Rome and Florence, Italy in 6 days');
    expect(log).toContain('Rome, Italy');
    expect(log).toContain('Rome');
    expect(placed.map((p) => p.countryCode)).toEqual(['IT', 'IT']);
    expect(placed[1]!.point!.lat).toBeGreaterThan(43);
  });

  it('never lets the country’s own point stand in for a stop it could not find', async () => {
    const { placed, result } = await check('Rome, Somewhere Unrecorded, Italy in 6 days');
    expect(placed[1]!.point).toBeNull();
    expect(result.metrics.unplaced).toEqual(['Somewhere Unrecorded']);
    expect(result.findings.find((f) => f.id === 'unplaced')!.sentence).toMatch(/Not checked/);
  });

  it('places stops across a border without forcing them into one country', async () => {
    const { placed } = await check('Bariloche, El Calafate, Torres del Paine National Park in 10 days');
    expect(placed.map((p) => p.countryCode)).toEqual(['AR', 'AR', 'CL']);
  });

  it('uses an exact index hit before the geocoder', async () => {
    const entry = { displayName: 'Ambervale Town', center: { lat: 46, lng: 8 }, countryCode: 'AA' } as unknown as DestinationIndexEntry;
    const log: string[] = [];
    const placed = await placePlanStops({ stops: parsePlanText('Ambervale Town, Lisbon', NOW).stops, contextCountries: [], resolver: recordedResolver(log), now: NOW, indexLookup: (folded) => (folded === 'ambervale town' ? entry : null) });
    expect(placed[0]).toMatchObject({ source: 'index', point: { lat: 46, lng: 8 } });
    expect(log).not.toContain('Ambervale Town');
  });
});

describe('the critique over recorded places', () => {
  it('calls three beds in three nights too much, from the browser suite’s own plan', async () => {
    const { parsed, result } = await check('Inverness, Isle of Skye and Fort William, United Kingdom in 4 days. Is that too much?');
    expect(parsed.contextCountries).toEqual(['GB']);
    expect(result.headline).toMatch(/^Too much for 3 nights/);
    expect(result.moves.every((m) => m.minutes !== null)).toBe(true);
    expect(result.improved).not.toBeNull();
  });

  it('turns a jump of over 1,000 km into a flight', async () => {
    const { result } = await check('Bariloche 3 nights, El Calafate 3 nights, Torres del Paine National Park 1 night');
    const flight = result.moves.find((m) => m.from === 'Bariloche')!;
    expect(flight.mode).toBe('flight');
    expect(result.findings.some((f) => f.id === `fly-${flight.toIndex}` && /flight/.test(f.sentence))).toBe(true);
  });

  it('flags an order that doubles back, from coordinates alone', async () => {
    const { result } = await check('Seattle, Mount Rainier National Park, Olympic National Park, Portland in 9 days');
    expect(result.findings.some((f) => f.id === 'order')).toBe(true);
    expect(result.improved!.stops[0]!.label).toBe('Seattle');
    expect(result.improved!.stops[result.improved!.stops.length - 1]!.label).toBe('Portland');
  });
});

describe('composerInputForPlan — "Plan this" is an ordinary composer payload', () => {
  const plan = { stops: [{ label: 'Tokyo', nights: 3, dayTrip: false }, { label: 'Nara', nights: 0, dayTrip: true }, { label: 'Kyoto', nights: 3, dayTrip: false }], totalNights: 6, startDate: null, endDate: null, month: null, contextCountries: ['JP'] };

  it('names the beds as the destination, inside the country the plan named', () => {
    expect(destinationPhraseFor(plan)).toBe('Tokyo and Kyoto, Japan');
  });

  it('carries every place, day trips included, as the traveller’s own plan, and asks for the best time when no dates were given', () => {
    const input = composerInputForPlan(plan);
    expect(input.existingPlan).toBe('Tokyo, Nara, Kyoto');
    expect(input.nights).toBe(6);
    expect(input.dateMode).toBe('best_time');
    expect(input.wantsDateRecommendation).toBe(true);
  });

  it('locks typed dates as exact and keeps a named month as a month', () => {
    expect(composerInputForPlan({ ...plan, startDate: '2027-04-02', endDate: '2027-04-08' })).toMatchObject({ dateMode: 'exact', startDate: '2027-04-02', endDate: '2027-04-08' });
    expect(composerInputForPlan({ ...plan, month: 4 })).toMatchObject({ dateMode: 'month', month: 4 });
  });

  it('cuts a long destination at a whole name', () => {
    const long = { ...plan, stops: Array.from({ length: 12 }, (_, i) => ({ label: `A very long place name number ${i}`, nights: 1, dayTrip: false })) };
    const phrase = destinationPhraseFor(long);
    expect(phrase.length).toBeLessThanOrEqual(200);
    expect(phrase.endsWith(', Japan')).toBe(true);
  });
});
