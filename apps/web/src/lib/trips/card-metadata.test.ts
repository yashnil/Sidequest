import { describe, expect, it } from 'vitest';
import { composeCardMeta, type CardFacts } from './card-metadata';

/**
 * The two lines a trip card composes from a row. Pure, so the assertions are
 * about words: the figure is the dates, the nights and party follow it, the
 * readiness line prefers a finished plan's own verdict but never over a build
 * that is still running, and the route preview folds a long base list.
 */
const BASE: CardFacts = {
  title: 'Kenya and Tanzania',
  destination: 'Kenya and Tanzania',
  dates: 'Apr 13–20, 2027',
  timing: 'fixed',
  nights: 7,
  party: '4 adults',
  itineraryStatus: null,
  progressState: 'not_started',
  progressLabel: 'Not planned yet',
  progressTone: 'neutral',
  bookedCount: 0,
  bases: [],
};

describe('composeCardMeta', () => {
  it('sets the dates as the figure and follows them with nights and party', () => {
    const meta = composeCardMeta(BASE);
    expect(meta.when).toEqual({ figure: 'Apr 13–20, 2027', open: null, rest: ['7 nights', '4 adults'], note: null });
  });

  it('says the timing is open instead of printing a placeholder date', () => {
    const meta = composeCardMeta({ ...BASE, timing: 'open', nights: 0 });
    expect(meta.when.figure).toBeNull();
    expect(meta.when.open).toBe('Timing still open');
    expect(meta.when.rest).toEqual(['4 adults']);
  });

  it('footnotes dates Sidequest chose', () => {
    expect(composeCardMeta({ ...BASE, timing: 'chosen' }).when.note).toBe('Dates chosen for you');
  });

  it('reads readiness from the progress label when there is no plan', () => {
    expect(composeCardMeta(BASE).readiness).toEqual({ label: 'Not planned yet', tone: 'neutral' });
  });

  it('lets a finished plan speak for itself, cautions included', () => {
    expect(composeCardMeta({ ...BASE, itineraryStatus: 'ready', progressLabel: 'Plan ready', progressTone: 'pine' }).readiness).toEqual({ label: 'Plan ready', tone: 'pine' });
    expect(composeCardMeta({ ...BASE, itineraryStatus: 'ready_with_cautions' }).readiness).toEqual({ label: 'Ready, with cautions', tone: 'amber' });
    expect(composeCardMeta({ ...BASE, itineraryStatus: 'needs_decision' }).readiness).toEqual({ label: 'Needs a decision', tone: 'amber' });
  });

  it('never lets an old plan outrank a build that is running', () => {
    const meta = composeCardMeta({ ...BASE, itineraryStatus: 'ready', progressState: 'building', progressLabel: 'Building now', progressTone: 'blue' });
    expect(meta.readiness).toEqual({ label: 'Building now', tone: 'blue' });
  });

  it('counts bookings and says so when there are none', () => {
    expect(composeCardMeta(BASE).booking).toEqual({ label: 'Nothing booked yet', booked: false });
    expect(composeCardMeta({ ...BASE, bookedCount: 2 }).booking).toEqual({ label: '2 booked', booked: true });
  });

  it('previews at most four bases and counts the rest', () => {
    const meta = composeCardMeta({ ...BASE, bases: ['Nairobi', 'Naivasha', 'Arusha', 'Karatu', 'Zanzibar', 'Stone Town'] });
    expect(meta.route).toEqual({ names: ['Nairobi', 'Naivasha', 'Arusha', 'Karatu'], more: 2 });
    expect(composeCardMeta(BASE).route).toEqual({ names: [], more: 0 });
  });

  it('hides a single base that only restates the title or destination', () => {
    expect(composeCardMeta({ ...BASE, bases: ['Kenya and Tanzania'] }).route).toEqual({ names: [], more: 0 });
    expect(composeCardMeta({ ...BASE, bases: ['  kenya AND tanzania '] }).route).toEqual({ names: [], more: 0 });
    expect(composeCardMeta({ ...BASE, title: 'Safari with Mum', bases: ['Kenya and Tanzania'] }).route).toEqual({ names: [], more: 0 });
  });

  it('keeps a single base that names somewhere of its own, and any route of two or more', () => {
    expect(composeCardMeta({ ...BASE, bases: ['Nairobi'] }).route).toEqual({ names: ['Nairobi'], more: 0 });
    expect(composeCardMeta({ ...BASE, bases: ['Kenya and Tanzania', 'Zanzibar'] }).route).toEqual({ names: ['Kenya and Tanzania', 'Zanzibar'], more: 0 });
  });
});

/**
 * V9 §21 — the two facts a card adds: the booking state from the engine's
 * progress, and where the primary action goes. A trip under way opens Today;
 * a hub anchor from the next-action engine opens the hub at that anchor.
 */
describe('bookingStateLabel', () => {
  it('says "N of M major items booked" and nothing when the plan needs nothing major', async () => {
    const { bookingStateLabel } = await import('./card-metadata');
    expect(bookingStateLabel({ arranged: 6, critical: 8 })).toBe('6 of 8 major items booked');
    expect(bookingStateLabel({ arranged: 1, critical: 1 })).toBe('1 of 1 major item booked');
    expect(bookingStateLabel({ arranged: 0, critical: 0 })).toBeNull();
    expect(bookingStateLabel(null)).toBeNull();
  });
});

describe('primaryHrefFor', () => {
  it('sends a traveling trip to Today, whatever else is open', async () => {
    const { primaryHrefFor } = await import('./card-metadata');
    expect(primaryHrefFor({ tripId: 't1', lifecycle: 'traveling', progressHref: '/trips/t1/itinerary', nextHref: '#book-first' })).toBe('/trips/t1/today');
  });
  it('opens the hub at the engine’s anchor, and falls back to the progress path', async () => {
    const { primaryHrefFor } = await import('./card-metadata');
    expect(primaryHrefFor({ tripId: 't1', lifecycle: 'booked', progressHref: '/trips/t1/itinerary', nextHref: '#book-first' })).toBe('/trips/t1/itinerary#book-first');
    expect(primaryHrefFor({ tripId: 't1', lifecycle: 'planning', progressHref: '/trips/t1/plan', nextHref: null })).toBe('/trips/t1/plan');
  });
});
