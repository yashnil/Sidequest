import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PACKING_CATEGORY_LABELS, type PackingCategory } from '@sidequest/core';
import { OfflineSnapshot } from '@/components/OfflineSnapshot';
import { CopyButton } from '@/components/CopyButton';
import { PrintAppendix } from '@/components/PrintAppendix';
import { Panel, buttonClass, cx } from '@/components/ui';
import { getDb } from '@/lib/db/client';
import { activeCalendarFeed } from '@/lib/db/execution-repository';
import { getItinerary, StaleItineraryError } from '@/lib/db/repository';
import { formatDateRange } from '@/lib/format';
import { dayRouteLinks, mapModeFor, type MapStop } from '@/lib/maps';
import { copyable, placeNavigationLinks } from '@/lib/navigation-links';
import { ownedTrip } from '@/lib/net/trip-access';
import { ShareControl } from '../itinerary/share-controls';
import { itineraryViewModel } from '../itinerary/view-model';
import { CalendarSubscription } from './TripPack';

export const dynamic = 'force-dynamic';

/**
 * V9 §11 — THE TRIP PACK: "TAKE IT WITH YOU", ON ONE PAGE.
 *
 * Every way a finished plan leaves Sidequest, gathered where a traveller
 * looks for them the week before departure: the printed packet, the calendar
 * file and the subscription, a map handoff per day, the offline copy, the
 * share link, the pictures and the packing list. Owner-gated like the plan;
 * render-pure like every V9 surface — opening it reads rows and derives, and
 * asks no provider and no model.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return { title: trip ? `${trip.basics.destinationInput} — Take it with you — Sidequest` : 'Take it with you — Sidequest' };
}

/** The share path when a link has been made, read without minting one. */
function currentSharePath(tripId: string): string | null {
  const row = getDb().prepare('SELECT share_token FROM trips WHERE id = ?').get(tripId) as { share_token: string | null } | undefined;
  return row?.share_token ? `/share/${row.share_token}` : null;
}

const PACKING_ORDER: readonly PackingCategory[] = ['essential_documents', 'clothing', 'footwear', 'outdoor', 'weather', 'electronics', 'health_toiletries', 'transport', 'activity_specific', 'remote_travel', 'optional'];

export default async function TripPackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  let itinerary;
  try {
    itinerary = getItinerary(id);
  } catch (error) {
    const stale = error instanceof StaleItineraryError;
    return (
      <NoPack
        tripId={id}
        title={stale ? 'This plan needs one rebuild before it can travel with you' : 'That saved plan is no longer readable'}
        body={stale ? 'It was built by an earlier version of Sidequest. Open the trip and press Rebuild — every choice you made is kept.' : 'The stored plan does not match the current format, so nothing here would be trustworthy. Rebuild it from the trip.'}
      />
    );
  }
  if (!itinerary) {
    return <NoPack tripId={id} title="No trip built yet" body="Build the trip first; everything here is made from the finished plan." />;
  }

  const model = await itineraryViewModel(trip, itinerary);
  const plan = model.appliedItinerary;
  const feed = activeCalendarFeed(id);
  const sharePath = currentSharePath(id);
  const dateLabel = formatDateRange(plan.startDate, plan.endDate);
  const verdictLabel = model.preflight.verdict === 'ready' ? 'Ready' : model.preflight.verdict === 'nearly' ? 'Nearly ready' : 'Not ready yet';

  /* Each day's positioned stops, in the order the plan visits them. */
  const dayMaps = plan.days.map((day) => {
    const stops: MapStop[] = day.items
      .filter((item) => item.kind === 'activity' && item.placeId !== undefined && model.coordinates[item.placeId] !== undefined)
      .map((item) => ({ id: item.placeId!, name: model.rationale[item.placeId!]?.name ?? item.title, ...model.coordinates[item.placeId!]! }));
    const mode = day.totals.unverifiedMinutes > 0 ? 'transit' : mapModeFor(day.transport.modes);
    return { day, stops, links: dayRouteLinks(stops, mode), single: stops.length === 1 ? placeNavigationLinks({ lat: stops[0]!.lat, lng: stops[0]!.lng, name: stops[0]!.name }) : null };
  });

  const packing = model.intelligence.packing;
  const packingByCategory = PACKING_ORDER.map((category) => ({ category, items: packing.items.filter((item) => item.category === category) })).filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8" data-testid="trip-pack">
      <p className="type-meta">
        <Link href={`/trips/${id}/itinerary`} className="underline underline-offset-4">
          ← Back to the trip
        </Link>
      </p>
      <h1 className="display-lg mt-3 text-ink">Take it with you</h1>
      <p className="mt-2 type-body text-ink-muted">
        {trip.basics.destinationInput} · {dateLabel} · {plan.days.length} {plan.days.length === 1 ? 'day' : 'days'}
      </p>
      <p className="mt-1 type-small text-ink" data-testid="pack-readiness" data-verdict={model.preflight.verdict}>
        <strong>{verdictLabel}.</strong> {model.preflight.headline}
      </p>

      <section className="card mt-8 p-5" aria-labelledby="pack-paper">
        <h2 id="pack-paper" className="type-section text-ink">
          On paper
        </h2>
        <p className="mt-1 type-small text-ink-muted">
          The packet prints from the trip itself: the route, the days, stays, getting around, what to book first, before-you-go, packing and the day backups — plus a last page of addresses, positions and the emergency number.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" data-print="never">
          <Link href={`/trips/${id}/itinerary?print=1`} className={buttonClass('secondary', 'sm')} data-testid="pack-pdf">
            Print or save as PDF
          </Link>
          <Link href={`/trips/${id}/itinerary?print=1&appendix=1`} className={buttonClass('ghost', 'sm')}>
            Print with the evidence appendix
          </Link>
        </div>
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-calendar">
        <h2 id="pack-calendar" className="type-section text-ink">
          In your calendar
        </h2>
        <p className="mt-1 type-small text-ink-muted">
          Booked things arrive confirmed; the plan&apos;s suggestions arrive tentative. Times are the destination&apos;s own. Nothing private — no references, notes or costs — travels with them.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" data-print="never">
          <a href={`/trips/${id}/itinerary/calendar`} download className={buttonClass('secondary', 'sm')} data-testid="pack-calendar-file">
            Download the calendar file (.ics)
          </a>
        </div>
        <h3 className="mt-5 type-title text-ink">Subscribe, so edits reach every device</h3>
        <CalendarSubscription tripId={id} feed={feed} />
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-maps">
        <h2 id="pack-maps" className="type-section text-ink">
          Maps, day by day
        </h2>
        <p className="mt-1 type-small text-ink-muted">
          Each day&apos;s stops, in order, handed to the map app you already use. Only stops with a confirmed position are in a link; the count says when one is left out.
        </p>
        <ol className="mt-3 divide-y divide-rule">
          {dayMaps.map(({ day, stops, links, single }) => (
            <li key={day.dayNumber} className="py-3" data-testid={`pack-map-day-row-${day.dayNumber}`}>
              <p className="type-small text-ink">
                <strong>Day {day.dayNumber}</strong> · {day.theme}
                <span className="text-ink-muted">
                  {' '}
                  · {stops.length} {stops.length === 1 ? 'stop' : 'stops'} with a position
                  {links && links.omitted > 0 ? ` (${links.omitted} more than a link can hold)` : ''}
                </span>
              </p>
              {links ? (
                <div className="mt-2 flex flex-wrap items-center gap-2" data-print="never">
                  <a href={links.google} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid={`pack-map-day-${day.dayNumber}`}>
                    Google Maps
                  </a>
                  <a href={links.appleUnified} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid={`pack-map-apple-${day.dayNumber}`}>
                    Apple Maps
                  </a>
                  <a href={links.apple} target="_blank" rel="noreferrer noopener" className={cx(buttonClass('ghost', 'sm'), 'type-meta')}>
                    Apple Maps, older phones (last leg)
                  </a>
                  <CopyButton text={stops.map((stop) => copyable(stop, stop.name)).join('\n')} label="Copy coordinates" testId={`pack-map-copy-${day.dayNumber}`} variant="ghost" />
                </div>
              ) : single ? (
                <div className="mt-2 flex flex-wrap items-center gap-2" data-print="never">
                  <a href={single.google} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid={`pack-map-day-${day.dayNumber}`}>
                    Google Maps
                  </a>
                  <a href={single.apple} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid={`pack-map-apple-${day.dayNumber}`}>
                    Apple Maps
                  </a>
                  <CopyButton text={copyable(stops[0]!, stops[0]!.name)} label="Copy coordinates" testId={`pack-map-copy-${day.dayNumber}`} variant="ghost" />
                </div>
              ) : (
                <p className="mt-1 type-meta">No stop on this day has a confirmed position, so there is nothing to hand to a map yet.</p>
              )}
              {stops.length > 0 ? <p className="mt-1 hidden type-meta print:block">{stops.map((stop) => copyable(stop, stop.name)).join(' · ')}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-offline-heading">
        <h2 id="pack-offline-heading" className="type-section text-ink">
          Without signal
        </h2>
        <p className="mt-1 type-small text-ink-muted">
          The trip, Today and this page are kept on this device once opened, and open again with no connection. Signing out forgets them.
        </p>
        <p className="mt-2 type-small">
          <OfflineSnapshot paths={[`/trips/${id}/itinerary`, `/trips/${id}/today`, `/trips/${id}/pack`]} tripId={id} testId="pack-offline" className="type-small text-ink" />
        </p>
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-share">
        <h2 id="pack-share" className="type-section text-ink">
          Share a read-only copy
        </h2>
        <p className="mt-1 type-small text-ink-muted">Companions see the plan and nothing private: no references, notes, costs or documents. Revoke the link and it opens nothing from that moment.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="pack-share-link" data-print="never">
          <ShareControl tripId={id} initialPath={sharePath} />
        </div>
        {sharePath ? <p className="mt-1 hidden type-meta print:block">{sharePath}</p> : null}
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-pictures">
        <h2 id="pack-pictures" className="type-section text-ink">
          Pictures to send
        </h2>
        <p className="mt-1 type-small text-ink-muted">An overview card for the group chat and one card per day. They carry the route and the days — never a booking, a price or a name.</p>
        <div className="mt-3 flex flex-wrap gap-2" data-print="never">
          <a href={`/trips/${id}/card`} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid="pack-card-image">
            Overview card (PNG)
          </a>
          {plan.days.map((day) => (
            <a key={day.dayNumber} href={`/trips/${id}/days/${day.dayNumber}/card`} target="_blank" rel="noreferrer noopener" className={buttonClass('ghost', 'sm')} data-testid={`pack-day-image-${day.dayNumber}`}>
              Day {day.dayNumber}
            </a>
          ))}
        </div>
      </section>

      <section className="card mt-5 p-5" aria-labelledby="pack-packing-heading">
        <h2 id="pack-packing-heading" className="type-section text-ink">
          Packing
        </h2>
        <p className="mt-1 type-small text-ink-muted">{packing.basisNote}</p>
        {packingByCategory.length > 0 ? (
          <div className="mt-3 columns-1 gap-6 sm:columns-2" data-testid="pack-packing">
            {packingByCategory.map((group) => (
              <div key={group.category} className="mb-4 break-inside-avoid">
                <h3 className="label">{PACKING_CATEGORY_LABELS[group.category]}</h3>
                <ul className="mt-1 type-small text-ink">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      {item.label}
                      {item.optional ? <span className="text-ink-muted"> (optional)</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {packing.modelSuggestions.length > 0 ? (
              <div className="mb-4 break-inside-avoid">
                <h3 className="label">Also suggested for this trip</h3>
                <ul className="mt-1 type-small text-ink">
                  {packing.modelSuggestions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 type-small text-ink-muted" data-testid="pack-packing">
            No packing list yet.
          </p>
        )}
        <p className="mt-3 type-meta" data-print="never">
          Tick items off on the trip&apos;s Prepare view; ticks are kept there.
        </p>
      </section>

      <PrintAppendix itinerary={plan} booked={model.booked} intelligence={model.intelligence} coordinates={model.coordinates} resolutions={model.resolutions} tripId={id} sharePath={sharePath} />
    </div>
  );
}

function NoPack({ tripId, title, body }: { tripId: string; title: string; body: string }) {
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8" data-testid="trip-pack">
      <Panel className="p-8">
        <h1 className="font-display text-2xl text-ink">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{body}</p>
        <Link href={`/trips/${tripId}/itinerary`} className={`${buttonClass('primary')} mt-6`} data-testid="pack-back">
          Open the trip
        </Link>
      </Panel>
    </div>
  );
}
