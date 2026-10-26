import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/app/(product)/actions', () => ({ deleteTripAction: async () => ({ ok: true }) }));
vi.mock('@/app/(product)/trips/dashboard-actions', () => ({
  archiveTripAction: async () => ({ ok: true }),
  duplicateTripAction: async () => ({ ok: true }),
  renameTripAction: async () => ({ ok: true }),
  setLifecycleAction: async () => ({ ok: true }),
}));

const { TripCard } = await import('@/app/(product)/trips/TripCard');
const { featureLayout } = await import('./CollectionDashboard');
type Row = Parameters<typeof TripCard>[0]['row'];

const ROW: Row = {
  id: 'trip-iceland',
  title: 'Iceland',
  destination: 'Iceland',
  dates: 'Jul 10–22, 2027',
  timing: 'fixed',
  nights: 12,
  party: '2 adults, 1 child',
  lifecycle: 'planning',
  lifecycleBasis: 'inferred',
  bases: ['Reykjavík', 'Vík', 'Höfn'],
  itineraryStatus: 'needs_decision',
  feasibilitySummary: null,
  bookedCount: 0,
  nextAction: 'Open the plan',
  href: '/trips/trip-iceland/itinerary',
  next: { kind: 'decide', title: 'Choose a base for night 4', why: 'Two options', href: '/trips/trip-iceland/itinerary#decide' },
  bookingState: '0 of 6 major items booked',
  progressTone: 'blue',
  progressState: 'planned',
  progressLabel: 'Planned',
  progressRank: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  startDate: '2027-07-10',
  image: null,
  fallback: { kind: 'regional_graphic', label: 'Iceland', hue: 200, horizon: 0.5, drift: 0.5, marks: 1, description: 'A generated graphic' },
  claimed: false,
  updatedLabel: 'Updated today',
  shape: {
    center: { lat: 64.9, lng: -18.6 },
    bases: [
      { name: 'Reykjavík', lat: 64.147, lng: -21.943 },
      { name: 'Vík', lat: 63.419, lng: -19.006 },
      { name: 'Höfn', lat: 64.254, lng: -15.208 },
    ],
    stops: [{ lat: 63.53, lng: -19.51, day: 2 }],
  },
} as unknown as Row;

const IMAGE = {
  schemaVersion: 1,
  fileTitle: 'File:Somewhere.jpg',
  filePageUrl: 'https://commons.wikimedia.org/wiki/File:Somewhere.jpg',
  thumbnailUrl: 'https://upload.wikimedia.org/somewhere.jpg',
  width: 800,
  height: 600,
  mediaType: 'image/jpeg',
  subject: { kind: 'destination', id: 'Q189' },
  matchBasis: 'entity_image',
  subjectConfidence: 'strong',
  attributionText: 'Photo by A. Photographer, CC BY-SA 4.0',
  licenceId: 'CC-BY-SA-4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  creatorUrl: 'https://commons.wikimedia.org/wiki/User:APhotographer',
} as unknown as NonNullable<Row['image']>;

const render = (row: Row, variant: 'lead' | 'standard' | 'wide' | 'index') => renderToStaticMarkup(createElement(TripCard, { row, onError: () => {}, controls: { kind: 'menu' }, catalogue: 13, variant, today: '2026-10-25' }));

const IDS = ['trip-card', 'trip-card-title', 'trip-card-dates', 'trip-card-standing', 'trip-card-booking-state', 'trip-card-next-action', 'trip-card-action', 'trip-card-menu'];

describe('every layout of a trip carries every handle the suite drives', () => {
  for (const variant of ['lead', 'standard', 'wide', 'index'] as const) {
    it(`${variant}: all test ids, once each`, () => {
      const html = render(ROW, variant);
      for (const id of IDS) expect((html.match(new RegExp(`data-testid="${id}"`, 'g')) ?? []).length, id).toBe(1);
      expect(html).toContain(`data-variant="${variant}"`);
      expect(html).toContain('aria-label="Open Iceland"');
    });
  }
});

describe('the plate', () => {
  it('plots a trip with coordinates, with a plain scale and the order said, once, to be no road', () => {
    const html = render(ROW, 'lead');
    expect(html).toContain('data-plate="route"');
    expect(html).toMatch(/\d km</);
    expect(html).toContain('lines show order, not roads');
    expect(html).not.toMatch(/\d+\.\d{4}° [NSEW]/);
    expect(html).toContain('Reykjavík');
  });

  it('marks a trip with nothing placed from what is known, and says so', () => {
    const html = render({ ...ROW, shape: { center: null, bases: [], stops: [] } }, 'standard');
    expect(html).toContain('data-plate="ledger"');
    expect(html).toContain('>Ic<');
    expect(html).toContain('Not on the map yet');
    expect(html).not.toContain('<polyline');
  });

  it('lays a stored photograph on the plate whole — never cropped — and credits it', () => {
    const html = render({ ...ROW, image: IMAGE }, 'lead');
    expect(html).toContain('print-frame');
    expect(html).toContain('object-contain');
    expect(html).not.toContain('object-cover');
    expect(html).toContain('A. Photographer');
  });

  it('counts down in words for a trip ahead', () => {
    expect(render(ROW, 'lead')).toContain('days to go');
    expect(render(ROW, 'standard')).toMatch(/In \d+ days/);
  });
});

describe('the collection’s rhythm is mixed sizes, never a hole', () => {
  it('alternates seven and five, and lays a trip left alone wide', () => {
    expect(featureLayout(0, 1).variant).toBe('wide');
    expect([0, 1, 2, 3].map((i) => featureLayout(i, 4).variant)).toEqual(['lead', 'standard', 'standard', 'lead']);
    expect(featureLayout(2, 3).variant).toBe('wide');
  });
});
