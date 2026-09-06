import { describe, expect, it } from 'vitest';
import { answerQuestion, defaultAnswers, interestOfferFromEntityType, questionById, screenDestination, withScreening, type InterviewContext, type ScreeningSignals } from '@sidequest/core';
import { sketchFor } from './TripSketch';

/**
 * DESTINATION-AWARE INTERVIEW GLOBALITY — THE SIDEBAR SAYS ONLY WHAT IT KNOWS.
 *
 * The founder's screenshot stacked three unsupported assumptions: "one base,
 * days out from it — assumed", "a car — assumed", "about an hour out —
 * assumed", for a city nothing had screened. The sketch now distinguishes an
 * answer, a confident destination read (marked as Sidequest's read) and an
 * open question ("Not decided yet"), and it draws a range ring only for a
 * reach somebody chose or decided.
 */
const NOW = new Date('2026-09-06T10:00:00Z');

function contextFor(signals: Partial<ScreeningSignals> & { name: string; tripDays: number }): InterviewContext {
  const destination = screenDestination({ ...signals });
  return { destination, traveller: { travelerNeeds: [], tripDays: signals.tripDays, adults: 2, children: 0, offeredInterests: interestOfferFromEntityType(signals.entityType ?? 'unknown').interests, carried: [] } };
}
const fresh = (ctx: InterviewContext) => withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays }), ctx.destination);

const denseCity = () => contextFor({ name: 'Harbour Metropolis', tripDays: 6, entityType: 'city', breadth: 'city', featureType: 'city', population: 7_534_200, center: { lat: 22.28, lng: 114.16 } });
const unknown = () => contextFor({ name: 'Somewhere', tripDays: 6 });
const mountain = () => contextFor({ name: 'Alpine Basin', tripDays: 5, entityType: 'subregion', breadth: 'subregion', seededClass: 'mountain' });

describe('sketchFor', () => {
  it('an unscreened destination shows nothing as assumed: transport, shape and range are open, and no ring is drawn', () => {
    const sketch = sketchFor(unknown(), fresh(unknown()));
    expect(sketch.transport).toMatchObject({ label: 'Not decided yet', assumed: false, open: true });
    expect(sketch.shapeLabel).toBe('Not decided yet');
    expect(sketch.shapeOpen).toBe(true);
    expect(sketch.rangeLabel).toBe('Not decided yet');
    expect(sketch.rangeOpen).toBe(true);
    expect(sketch.rangeKm).toBeNull();
    // The regression: a default of `willDrive: true` in the answers must never surface as "A car — assumed".
    expect(sketch.transport.label).not.toMatch(/car/i);
  });

  it('a dense city shows a confident transit read as Sidequest’s read, one base in the city, and a day-trip question instead of a radius', () => {
    const ctx = denseCity();
    const sketch = sketchFor(ctx, fresh(ctx));
    expect(sketch.transport).toMatchObject({ glyph: 'transit', label: 'On foot and by transit', assumed: true, open: false });
    expect(sketch.shapeLabel).toBe('One base, the city on foot');
    expect(sketch.shapeAssumed).toBe(true);
    expect(sketch.rangeOpen).toBe(true);
    expect(sketch.rangeKm).toBeNull();
  });

  it('answering transport and day trips settles the rows and gives the map a ring to draw', () => {
    const ctx = denseCity();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, value: 'taxis', now: NOW });
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'day_trips')!, value: 'one_day_trip', now: NOW });
    const sketch = sketchFor(ctx, answers);
    expect(sketch.transport).toMatchObject({ glyph: 'taxi', label: 'Taxis and rideshare', assumed: false, open: false });
    expect(sketch.rangeLabel).toBe('One day out of the city');
    expect(sketch.rangeAssumed).toBe(false);
    expect(sketch.rangeKm).toBe(50);
  });

  it('a car-dependent mountain region reads as a car with confidence, and its reach stays a question until asked', () => {
    const ctx = mountain();
    const sketch = sketchFor(ctx, fresh(ctx));
    expect(sketch.transport).toMatchObject({ glyph: 'car', label: 'A car', assumed: true, open: false });
    expect(sketch.rangeOpen).toBe(true);
    expect(sketch.rangeKm).toBeNull();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'scenic_reach')!, value: 'nearby_120', now: NOW });
    const after = sketchFor(ctx, answers);
    expect(after.rangeLabel).toBe('Up to two hours out');
    expect(after.rangeKm).toBe(100);
  });

  it('a mixed answer is named as a mix, not as "a car"', () => {
    const ctx = unknown();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, value: 'mixed', now: NOW });
    expect(sketchFor(ctx, answers).transport.label).toBe('A car where it helps, local transport in town');
  });
});
