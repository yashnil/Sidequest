import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { ItineraryView } from '@/components/ItineraryView';
import { reconcileTripDraft } from '../reconcile';
import { IRELAND_TRIP, irelandContext, irelandDraft } from './ireland-replay.test';

/**
 * PRODUCT RECOVERY V1 — THE IRELAND TRAVELLER PACKET, RENDERED.
 *
 * The founder's Ireland print ran to 43 pages with 87 evidence rows. This
 * renders the repaired Ireland hub to static HTML (owner mode, every view in
 * the document as the print stylesheet sees it) and writes it beside the
 * artifacts, where `print-packet.mjs` lays it out on A4 with the built
 * stylesheet and counts the pages. The assertions here are the ones that need
 * no browser: no evidence row prints by default, no "not verified" paragraph
 * repeats under every row, no zero-minute leg, and the bases read as towns.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  RegenerateButton: () => null,
  StopEditMenu: () => null,
}));
vi.mock('@/app/(product)/trips/[id]/itinerary/share-controls', () => ({ ShareControl: () => null }));
vi.mock('@/app/(product)/trips/[id]/itinerary/live-controls', () => ({
  AddStopForm: () => null,
  FixDayButton: () => null,
  StopDayControls: () => null,
  DiscoverButton: () => null,
  BookedStatusControl: () => null,
}));
vi.mock('@/components/PrintButton', () => ({ PrintButton: () => null }));

const OUT = resolve(process.cwd(), '.claude-private/artifacts/production-ui-v1/packet');

describe('the Ireland traveller packet', () => {
  it('renders every hub view without evidence walls, repeated caveats or zero-minute legs, and writes the HTML for the A4 page count', async () => {
    const draft = irelandDraft();
    const { context } = irelandContext();
    const result = await reconcileTripDraft({ draft, context });
    const itinerary = result.itinerary;
    const now = new Date('2026-09-05T19:25:00Z');
    const intelligence = buildTravelIntelligence({ tripId: context.tripId, itinerary, draft, profile: context.profile, basics: context.basics, destination: { name: 'Ireland', countryCode: 'IE', timeZone: 'Europe/Dublin' }, booked: [], readinessProfile: null, now });
    const coordinates: Record<string, { lat: number; lng: number }> = {};
    for (const anchor of itinerary.package?.anchors ?? []) if (anchor.identity && anchor.placeId) coordinates[anchor.placeId] = anchor.identity.coordinates;
    for (const base of itinerary.package?.bases ?? []) if (base.coordinates && base.placeId) coordinates[base.placeId] = base.coordinates;
    const html = renderToStaticMarkup(
      createElement(ItineraryView, {
        itinerary,
        intelligence,
        preparation: [],
        tripId: IRELAND_TRIP.id,
        dateLabel: '11–20 May 2027',
        renderedAt: now.getTime(),
        destinationName: 'Ireland',
        coordinates,
        timeZone: 'Europe/Dublin',
        attributions: ['© OpenStreetMap contributors (ODbL)'],
        checks: { packing: [], checklist: [] },
      }),
    );
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'ireland-packet.html'), html);

    // No evidence wall in the default document: the provenance list is behind a closed, appendix-only disclosure.
    const claimRows = (html.match(/data-testid="hub-claim"/g) ?? []).length;
    expect(claimRows).toBeGreaterThan(0); // present for the appendix…
    expect(html).toMatch(/data-testid="hub-sources" data-print="appendix"/); // …but never in the packet by default
    // The founder's repeated caveat paragraph is gone from the rows; the chip carries the state.
    expect((html.match(/could not be independently confirmed as a specific place/g) ?? []).length).toBe(0);
    expect((html.match(/Check before relying/g) ?? []).length).toBeGreaterThan(0); // V6: the traveller-facing state word
    // No zero-minute travel row, no "0 km".
    expect(html).not.toMatch(/>0 min</);
    expect(html).not.toMatch(/about 0 km/);
    // Bases read as towns.
    expect(html).not.toMatch(/Trinity College Dublin|Dingle Distillery|Kinsale Urban/);
    // Backups are day-local: the Kerry alternative appears once per Kerry day, not on every day.
    const kerryBackups = (html.match(/Ladies View and Kerry Cliffs early/g) ?? []).length;
    expect(kerryBackups).toBeLessThanOrEqual(2);
    // Stays are one grouped dependency in Book first.
    expect(html).toMatch(/Stays: 7 bases, 9 nights/);
    // Readiness never offers a translation pack for Ireland.
    expect(html).not.toMatch(/translation pack/);
  });
});
