/**
 * THE PRINTED PACKET'S TWO DOORS, NAMED ONCE.
 *
 * `HubShell` opens the print dialog on `?print=1` and adds the evidence
 * appendix on `?appendix=1`. The itinerary's overflow menu linked to
 * `?appendix=1` alone, so "Print with evidence appendix" reloaded the page
 * and printed nothing — while the Pack's identical link carried both. Both
 * now come from here.
 */
export function printPacketHref(tripId: string): string {
  return `/trips/${tripId}/itinerary?print=1`;
}

export function printWithAppendixHref(tripId: string): string {
  return `/trips/${tripId}/itinerary?print=1&appendix=1`;
}
