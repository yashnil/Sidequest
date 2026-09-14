import { countryFacts, type BookedPlanItem, type BookingResolution, type Itinerary, type TravelIntelligence } from '@sidequest/core';
import { coordinatePair, placeNavigationLinks } from '@/lib/navigation-links';

/**
 * V9 §14 — WHAT PAPER NEEDS THAT THE SCREEN DOES NOT.
 *
 * A printed packet is read where there is no signal and no tap: at a check-in
 * desk, in a hire car, on a trail. So the appendix carries, as plain text,
 * the things a link on screen stands in for — the booking status of every
 * need and every stay, the address of everything booked, the coordinates and
 * plain map URLs of every stop with a confirmed position, the emergency
 * number and the driving side from the bundled reference facts, and which
 * pages are saved offline. The confirmation reference is never printed: a
 * packet left on a café table must not be a way into somebody's booking.
 *
 * Print-only (`hidden print:block`); a server component with no state, so it
 * costs the screen nothing.
 */
type NeedStatus = 'Booked' | 'Held' | 'Need to book' | 'Skipped' | 'Replaced' | 'Not needed';

function needStatus(item: TravelIntelligence['bookings']['items'][number], resolutions: readonly BookingResolution[]): NeedStatus {
  const resolution = resolutions.find((r) => r.bookingItemId === item.id)?.resolution;
  if (resolution === 'skipped') return 'Skipped';
  if (resolution === 'replaced') return 'Replaced';
  if (resolution === 'not_needed') return 'Not needed';
  if (item.status === 'booked') return 'Booked';
  if (item.status === 'soft_hold') return 'Held';
  if (item.status === 'not_needed') return 'Not needed';
  return 'Need to book';
}

interface Stay {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  nights: number;
}

function staysOf(itinerary: Itinerary): Stay[] {
  const bases = new Map((itinerary.package?.bases ?? []).map((base) => [base.id, base] as const));
  const stays: Stay[] = [];
  for (const day of itinerary.days) {
    const last = stays[stays.length - 1];
    if (last && last.id === day.baseId) {
      last.lastDate = day.date;
      last.nights += 1;
      continue;
    }
    const base = bases.get(day.baseId);
    stays.push({ id: day.baseId, name: base?.displayName ?? base?.name ?? day.baseName, firstDate: day.date, lastDate: day.date, nights: 1 });
  }
  if (stays.length > 0) stays[stays.length - 1]!.nights = Math.max(0, stays[stays.length - 1]!.nights - 1);
  return stays.filter((stay) => stay.nights > 0);
}

function lodgingFor(stay: Stay, booked: readonly BookedPlanItem[]): BookedPlanItem | undefined {
  return booked.find((item) => {
    if (item.type !== 'lodging' || item.status !== 'booked') return false;
    if (item.baseId && item.baseId === stay.id) return true;
    if (!item.date) return false;
    const end = item.endDate ?? item.date;
    return item.date <= stay.lastDate && end >= stay.firstDate;
  });
}

export function PrintAppendix({
  itinerary,
  booked,
  intelligence,
  coordinates,
  resolutions = [],
  tripId,
  sharePath,
}: {
  /** The itinerary with booked facts applied. */
  itinerary: Itinerary;
  booked: readonly BookedPlanItem[];
  intelligence: TravelIntelligence | null;
  coordinates: Record<string, { lat: number; lng: number }>;
  resolutions?: readonly BookingResolution[];
  /** Absent on the shared, read-only copy: no offline list, no booking status. */
  tripId?: string;
  sharePath?: string | null;
}) {
  const needs = (intelligence?.bookings.items ?? []).filter((item) => !item.memberIds);
  const stays = staysOf(itinerary);
  const anchors = itinerary.package?.anchors ?? [];
  const facts = countryFacts(intelligence?.destinationContext.countryCode);
  const positioned = itinerary.days.map((day) => ({
    day,
    stops: day.items
      .filter((item) => item.kind === 'activity' && item.placeId && coordinates[item.placeId])
      .filter((item) => {
        const anchor = anchors.find((a) => a.id === item.id) ?? anchors.find((a) => a.placeId !== undefined && a.placeId === item.placeId);
        return !anchor || anchor.verification !== 'unverified';
      })
      .map((item) => ({ title: item.title, point: coordinates[item.placeId!]! })),
  }));
  const bookedWithAddress = booked.filter((item) => item.status !== 'idea' && item.location);

  return (
    <section className="hidden print:block" data-testid="print-appendix" aria-labelledby="print-appendix-heading">
      <h2 id="print-appendix-heading" className="type-title text-ink">
        On paper: bookings, addresses and positions
      </h2>

      {tripId ? (
        <>
          <h3 className="mt-4 type-section text-ink">Booking status</h3>
          {needs.length > 0 ? (
            <ul className="mt-2 type-small" data-testid="print-booking-status">
              {needs.map((item) => (
                <li key={item.id} data-status={needStatus(item, resolutions)}>
                  <strong>{needStatus(item, resolutions)}</strong> — {item.title}
                  {item.date ? ` (${item.date})` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 type-small text-ink-muted">Nothing on this plan needs booking ahead, as far as Sidequest can tell.</p>
          )}
          {stays.length > 0 ? (
            <ul className="mt-2 type-small" data-testid="print-stay-status">
              {stays.map((stay) => {
                const lodging = lodgingFor(stay, booked);
                return (
                  <li key={`${stay.id}-${stay.firstDate}`} data-status={lodging ? 'Booked' : 'Need to book'}>
                    <strong>{lodging ? 'Booked' : 'Need to book'}</strong> — {stay.name}, {stay.nights} {stay.nights === 1 ? 'night' : 'nights'} from {stay.firstDate}
                    {lodging ? `: ${lodging.title}${lodging.location ? `, ${lodging.location}` : ''}` : ''}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}

      {bookedWithAddress.length > 0 ? (
        <>
          <h3 className="mt-4 type-section text-ink">Addresses of what is booked</h3>
          <ul className="mt-2 type-small" data-testid="print-addresses">
            {bookedWithAddress.map((item) => (
              <li key={item.id}>
                {item.title}
                {item.date ? ` · ${item.date}${item.endDate && item.endDate !== item.date ? ` – ${item.endDate}` : ''}` : ''} · {item.location}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="mt-4 type-section text-ink">Positions and map addresses</h3>
      <p className="mt-1 type-meta">Coordinates for every stop with a confirmed position, and the plain web address that opens it in a map app. Type either into the search box.</p>
      {positioned.some((entry) => entry.stops.length > 0) ? (
        <ol className="mt-2 type-small" data-testid="print-positions">
          {positioned
            .filter((entry) => entry.stops.length > 0)
            .map(({ day, stops }) => (
              <li key={day.dayNumber} className="mt-2">
                <strong>
                  Day {day.dayNumber} · {day.date}
                </strong>
                <ul>
                  {stops.map((stop, index) => {
                    const links = placeNavigationLinks({ ...stop.point, name: stop.title });
                    return (
                      <li key={`${day.dayNumber}-${index}`}>
                        {stop.title} — {coordinatePair(stop.point)}
                        <br />
                        <span className="break-all text-ink-muted">{links.google}</span>
                        <br />
                        <span className="break-all text-ink-muted">{links.apple}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
        </ol>
      ) : (
        <p className="mt-2 type-small text-ink-muted">No stop on this plan has a confirmed position yet.</p>
      )}

      <h3 className="mt-4 type-section text-ink">If something goes wrong</h3>
      {facts ? (
        <p className="mt-1 type-small" data-testid="print-emergency">
          Emergency number in {facts.name}: <strong>{facts.emergency}</strong>
          {facts.emergencyNotes ? ` (${facts.emergencyNotes})` : ''}. Traffic drives on the {facts.drivingSide}. Reference facts compiled by Sidequest; confirm locally.
        </p>
      ) : (
        <p className="mt-1 type-small text-ink-muted" data-testid="print-emergency">
          Save the local emergency number and the address of where you are sleeping each night before you go; Sidequest has no reference facts for this destination.
        </p>
      )}

      {tripId ? (
        <>
          <h3 className="mt-4 type-section text-ink">Saved on your phone</h3>
          <p className="mt-1 type-small" data-testid="print-offline">
            These pages open without signal once they have been opened while online: {`/trips/${tripId}/itinerary`}, {`/trips/${tripId}/today`}, {`/trips/${tripId}/pack`}
            {sharePath ? `. The read-only copy for companions: ${sharePath}` : ''}.
          </p>
        </>
      ) : null}
    </section>
  );
}
