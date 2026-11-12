/**
 * BOOKING SEARCH LINKS — ONE BUILDER, SO THE PARAMETERS LIVE IN ONE PLACE.
 *
 * A plain link to a booking site's search needs no agreement and carries what
 * Sidequest already knows: the words to search for, the nights and the party.
 * The parameter names (`ss`, `checkin`, `checkout`, `group_adults`,
 * `group_children`, `no_rooms`) come from third-party documentation, not an
 * official reference (`docs/experience-transformation/research.md` §2), so they
 * are written exactly once, here, where a change is one edit.
 *
 * A link is never a price or an availability: it opens the site's own search.
 */

export interface BookingSearchInput {
  /** What to search for: a property name with its town, or a place. */
  query: string;
  /** ISO dates, check-out exclusive. */
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
}

export function bookingComSearchUrl(input: BookingSearchInput): string {
  const params = [
    `ss=${encodeURIComponent(input.query)}`,
    `checkin=${input.checkIn}`,
    `checkout=${input.checkOut}`,
    `group_adults=${Math.max(1, Math.round(input.adults))}`,
    ...(input.children > 0 ? [`group_children=${Math.round(input.children)}`] : []),
    'no_rooms=1',
  ];
  return `https://www.booking.com/searchresults.html?${params.join('&')}`;
}

/**
 * A neutral map link at the property's own recorded position. It is a link,
 * not stored content, and it points at the coordinates the source gave, so the
 * traveller sees exactly where Sidequest believes the place is.
 */
export function propertyMapUrl(point: { lat: number; lng: number }, osmElement?: string): string {
  if (osmElement && /^(node|way|relation)\/\d+$/.test(osmElement)) return `https://www.openstreetmap.org/${osmElement}`;
  const lat = point.lat.toFixed(5);
  const lng = point.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
}
