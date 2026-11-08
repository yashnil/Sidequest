import type { ReactNode } from 'react';
import type { BookedPlanItem, BookingResolution, Itinerary, Preflight, RecheckManifest, TravelIntelligence, TravelReadinessProfile } from '@sidequest/core';
import { PrepareChecklist } from '../PreflightView';
import { buildPrepareModel } from '../prepare/prepare-model';
import { ViewHead } from './ViewHead';

/**
 * PREPARE — A PRE-TRIP CHECKLIST ORGANISED AROUND ACTIONS (2026-11).
 *
 * Before you book, one to two weeks before, pack, install, know. The model is
 * a pure view over the readiness packet, the booking needs, the packing list
 * and the persisted ticks (`prepare/prepare-model.ts`); the checklist renders
 * it and writes ticks back through the same server action Preflight always
 * used. Reference material (backups, what to re-check, the evidence) arrives
 * as `children`, folded, from the itinerary that owns it.
 */
export function PrepareView({ preflight, intel, tripId, booked, itinerary, readinessProfile, checks, recheck = null, children }: { preflight: Preflight | null; intel: TravelIntelligence | null; tripId?: string; booked: readonly BookedPlanItem[]; itinerary: Itinerary; honored?: readonly string[]; conflicts?: readonly string[]; resolutions?: readonly BookingResolution[]; readinessProfile: TravelReadinessProfile | null; checks: { packing: readonly string[]; checklist: readonly string[] }; recheck?: RecheckManifest | null; children?: ReactNode }) {
  const model = intel || preflight ? buildPrepareModel({ intel, preflight, checks, recheck, bookedCount: booked.filter((item) => item.status === 'booked').length, canTick: Boolean(tripId) }) : null;
  return (
    <div className="mx-auto max-w-6xl">
      {model ? (
        <div id="preflight" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]">
          <PrepareChecklist model={model} {...(tripId ? { tripId } : {})} startDate={itinerary.startDate} readinessProfile={readinessProfile} drives={intel?.destinationContext.drives ?? false} />
        </div>
      ) : (
        <div data-testid="prepare-top">
          <ViewHead sheet="Before you go" title="Prepare" lede="Nothing on this trip needs arranging right now. The sections below are here when you want them." />
        </div>
      )}
      {children}
    </div>
  );
}
