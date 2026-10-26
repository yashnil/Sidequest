import type { BookedPlanItem, BookingResolution, Itinerary, TravelIntelligence, TripLedger } from '@sidequest/core';
import type { BookedAffectedScope } from '@/lib/intelligence/booked-reconcile';
import type { BookingImport } from '@/lib/db/execution-repository';
import { BookView } from '../BookView';
import { BookFirstSection } from '../TripHub';
import { ViewHead } from './ViewHead';

/**
 * BOOK — the view's three states in one place: the full Book view (needs on a
 * deadline rail, what is booked, imports, money), the needs alone where there
 * is no ledger yet, and an honest empty sheet where nothing was identified.
 */
export function BookViewLayout({ tripId, intel, booked, itinerary, honored, conflicts, resolutions, ledger, affected, pendingImports }: { tripId?: string; intel: TravelIntelligence | null; booked: readonly BookedPlanItem[]; itinerary: Itinerary; honored: readonly string[]; conflicts: readonly string[]; resolutions: readonly BookingResolution[]; ledger: TripLedger | null; affected: BookedAffectedScope | null; pendingImports: readonly BookingImport[] }) {
  if (intel && ledger && affected) {
    return <BookView {...(tripId ? { tripId } : {})} intel={intel} booked={booked} itinerary={itinerary} honored={honored} conflicts={conflicts} resolutions={resolutions} ledger={ledger} affected={affected} pendingImports={pendingImports} />;
  }
  return (
    <section className="mx-auto max-w-6xl" data-testid="hub-book">
      <ViewHead sheet="Sheet B · What to arrange" title="Book" />
      {intel ? (
        <BookFirstSection intel={intel} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={honored} conflicts={conflicts} resolutions={resolutions} view="book-first" />
      ) : (
        <p className="mt-8 type-body text-ink-muted">Nothing to book was identified for this plan.</p>
      )}
    </section>
  );
}
