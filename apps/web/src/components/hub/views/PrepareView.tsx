import type { ReactNode } from 'react';
import type { BookedPlanItem, BookingResolution, Itinerary, Preflight, TravelIntelligence, TravelReadinessProfile } from '@sidequest/core';
import { PreflightView } from '../PreflightView';
import { BeforeYouGoSection, BookFirstSection, PackSection } from '../TripHub';
import { ViewHead } from './ViewHead';

/**
 * PREPARE — A READINESS SHEET.
 *
 * The verdict first (Preflight's head: the answer, how far away, the four
 * sections as counts), then the checklist on one rail — what needs attention,
 * what to do before you leave, what can wait, what is done — then the bookings
 * the trip depends on, the documents and the order of things, the packing
 * register. Reference material (apps, backups, what to re-check, the evidence)
 * arrives as `children`, folded, from the itinerary that owns it.
 */
export function PrepareView({ preflight, intel, tripId, booked, itinerary, honored, conflicts, resolutions, readinessProfile, checks, children }: { preflight: Preflight | null; intel: TravelIntelligence | null; tripId?: string; booked: readonly BookedPlanItem[]; itinerary: Itinerary; honored: readonly string[]; conflicts: readonly string[]; resolutions: readonly BookingResolution[]; readinessProfile: TravelReadinessProfile | null; checks: { packing: readonly string[]; checklist: readonly string[] }; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      {/* V9 §7 — Preflight leads: the verdict, how far away, and ready / needs attention / can wait. */}
      {preflight ? (
        <div id="preflight" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]">
          {/* Book first is rendered below on this view, with the actions; see `bookingsListedBelow`. */}
          <PreflightView preflight={preflight} bookingsListedBelow {...(tripId ? { tripId } : {})} />
        </div>
      ) : (
        <div data-testid="prepare-top">
          <ViewHead sheet="Sheet R · Ready to go?" title="Prepare" lede="Nothing on this trip needs arranging right now. The sections below are here when you want them." />
        </div>
      )}
      {intel ? <BookFirstSection intel={intel} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={honored} conflicts={conflicts} resolutions={resolutions} view="book-first" /> : null}
      {intel ? <BeforeYouGoSection intel={intel} {...(tripId ? { tripId } : {})} readinessProfile={readinessProfile} checks={checks.checklist} bookingsListedAbove /> : null}
      {intel ? <PackSection intel={intel} {...(tripId ? { tripId } : {})} checks={checks.packing} /> : null}
      {children}
    </div>
  );
}
