import { describe, expect, it } from 'vitest';
import type { Itinerary, TravelIntelligence } from '@sidequest/core';
import { dateRangeLabel, suggestedBookings } from './booking-links';

function itinerary(patch: { mode?: string; bases?: { id: string; name: string; nights: number; baseKind?: string }[] } = {}): Itinerary {
  return {
    startDate: '2027-03-19',
    endDate: '2027-03-27',
    transportStrategy: { primaryMode: patch.mode ?? 'drive' },
    package: { bases: patch.bases ?? [{ id: 'b1', name: 'Puerto de la Cruz', nights: 5 }, { id: 'b2', name: 'Los Cristianos', nights: 3 }] },
  } as unknown as Itinerary;
}

function intel(items: Record<string, unknown>[]): TravelIntelligence {
  return { bookings: { items } } as unknown as TravelIntelligence;
}

describe('booking links', () => {
  it('gives every stay its own dates, in order, with the party in every link', () => {
    const rows = suggestedBookings({ itinerary: itinerary(), intel: null, adults: 2, children: 1, regionHint: 'Tenerife, Spain' });
    const stays = rows.filter((r) => r.kind === 'stay');
    expect(stays.map((s) => s.detail)).toEqual(['19–24 Mar · 5 nights · 2 adults, 1 child', '24–27 Mar · 3 nights · 2 adults, 1 child']);
    const booking = stays[0]!.links.find((l) => l.label === 'Booking.com')!.href;
    expect(booking).toContain('checkin=2027-03-19');
    expect(booking).toContain('checkout=2027-03-24');
    expect(booking).toContain('group_adults=2');
    expect(booking).toContain('group_children=1');
    expect(decodeURIComponent(booking)).toContain('Puerto de la Cruz, Tenerife, Spain');
    expect(stays[1]!.links[0]!.href).toContain('checkin=2027-03-24');
  });

  it('offers a car on a driving trip and transfers between stays on a car-free one', () => {
    expect(suggestedBookings({ itinerary: itinerary(), intel: null, adults: 2, children: 0 }).some((r) => r.kind === 'car')).toBe(true);
    const carFree = suggestedBookings({ itinerary: itinerary({ mode: 'train' }), intel: null, adults: 2, children: 0 });
    expect(carFree.some((r) => r.kind === 'car')).toBe(false);
    expect(carFree.filter((r) => r.kind === 'transfer').map((r) => r.title)).toEqual(['Puerto de la Cruz to Los Cristianos']);
  });

  it('never sends a traveller to book a night an operator provides, and marks what is booked', () => {
    const rows = suggestedBookings({
      itinerary: itinerary({ bases: [{ id: 'b1', name: 'Town', nights: 2 }, { id: 'v', name: 'The boat', nights: 3, baseKind: 'vessel' }] }),
      intel: intel([{ id: 'a', kind: 'accommodation', baseId: 'b1', status: 'booked', priority: 'book_first', reason: 'x' }]),
      adults: 2,
      children: 0,
    });
    const stays = rows.filter((r) => r.kind === 'stay');
    expect(stays).toHaveLength(1);
    expect(stays[0]!.status).toBe('booked');
  });

  it('links a ticket to its official page first, and otherwise to a search', () => {
    const rows = suggestedBookings({
      itinerary: itinerary(),
      intel: intel([
        { id: 't1', kind: 'timed_entry', title: 'Teide cable car', status: 'open', priority: 'book_soon', reason: 'Sells out', officialSourceUrl: 'https://www.volcanoteide.com/', officialSourceName: 'Volcano Teide' },
        { id: 't2', kind: 'permit', title: 'Pico del Teide summit permit', status: 'open', priority: 'book_first', reason: 'Required', dayNumber: 3 },
      ]),
      adults: 2,
      children: 0,
    });
    const [cable, permit] = rows.filter((r) => r.kind === 'ticket');
    expect(cable!.links[0]).toMatchObject({ href: 'https://www.volcanoteide.com/', official: true });
    expect(permit!.links[0]!.href).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
    expect(permit!.detail).toBe('Day 3');
  });

  it('labels ranges across months', () => {
    expect(dateRangeLabel('2027-03-30', '2027-04-02')).toBe('30 Mar – 2 Apr');
  });

  it('picks the car up where the traveller arrives, and dates every car link', () => {
    const plan = itinerary();
    (plan.package as unknown as Record<string, unknown>).gateway = { arrival: { name: 'Tenerife North Airport', unresolved: false } };
    const car = suggestedBookings({ itinerary: plan, intel: null, adults: 2, children: 0 }).find((r) => r.kind === 'car')!;
    expect(car.detail).toContain('pick up at Tenerife North Airport');
    expect(decodeURIComponent(car.links[0]!.href)).toContain('/cars/Tenerife North Airport/2027-03-19/2027-03-27');
    expect(car.links[1]!.href).toContain('date1=03%2F19%2F2027');
    (plan.package as unknown as Record<string, unknown>).gateway = { arrival: { name: 'Calgary or Edmonton', unresolved: true } };
    const fallback = suggestedBookings({ itinerary: plan, intel: null, adults: 2, children: 0 }).find((r) => r.kind === 'car')!;
    expect(fallback.detail).toContain('near Puerto de la Cruz');
  });

  it('encodes names safely and never links an official page that is not https', () => {
    const rows = suggestedBookings({
      itinerary: itinerary({ bases: [{ id: 'b1', name: 'Saint-Émilion & "Pomerol" #1', nights: 2 }] }),
      intel: intel([{ id: 't', kind: 'timed_entry', title: 'Cellar tour', status: 'open', priority: 'book_soon', reason: 'x', officialSourceUrl: 'javascript:alert(1)' }]),
      adults: 2,
      children: 0,
    });
    for (const link of rows.flatMap((r) => r.links)) {
      expect(link.href).toMatch(/^https:\/\//);
      expect(link.href).not.toMatch(/[ "#&]Pomerol|\s/);
    }
    expect(rows.find((r) => r.kind === 'ticket')!.links.every((l) => !l.official)).toBe(true);
    const google = rows.find((r) => r.kind === 'stay')!.links.find((l) => l.label === 'Google Hotels')!.href;
    expect(decodeURIComponent(google)).toContain('Mar 19 2027 to Mar 21 2027');
  });

  it('stay dates add up to the nights the trip has, with no gap and no overlap', () => {
    const rows = suggestedBookings({ itinerary: itinerary({ bases: [{ id: 'a', name: 'A', nights: 3 }, { id: 'b', name: 'B', nights: 0 }, { id: 'c', name: 'C', nights: 5 }] }), intel: null, adults: 1, children: 0 });
    const stays = rows.filter((r) => r.kind === 'stay');
    const ranges = stays.map((s) => new URL(s.links[0]!.href).searchParams);
    expect(ranges.map((r) => [r.get('checkin'), r.get('checkout')])).toEqual([
      ['2027-03-19', '2027-03-22'],
      ['2027-03-22', '2027-03-27'],
    ]);
    expect(stays[0]!.detail).toContain('1 adult');
  });
});
