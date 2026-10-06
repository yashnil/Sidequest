/**
 * WHAT THE SETUP CANVAS SAYS WHEN A TYPED DESTINATION COULD NOT BE PLACED.
 *
 * `placeDestinationAction` tells the client *why* nothing was placed, and the
 * setup flow used to throw that away: a geocoder that was down, absent or
 * rate-limited read exactly like a phrase nobody could find ("Sidequest will
 * place this as the plan comes together"), so a traveller had no way to know
 * the map was the thing that failed and not their answer.
 *
 * A failure on our side gets its own calm sentence — the flow stays usable,
 * nothing is required of them, and nothing names a provider. A phrase the
 * sources genuinely could not settle keeps the original line.
 */
export type PlacementReason = 'too_short' | 'unresolved' | 'no_resolver' | 'provider_failed' | 'rate_limited' | 'locating' | 'request_failed';

export const PLACEMENT_UNAVAILABLE_NOTE = 'We couldn’t place this on the map right now — you can continue; we’ll resolve it when we plan.';

export function placementNote(reason: PlacementReason | null | undefined): string | null {
  switch (reason) {
    case 'no_resolver':
    case 'provider_failed':
    case 'rate_limited':
    case 'request_failed':
      return PLACEMENT_UNAVAILABLE_NOTE;
    default:
      /* `unresolved`, `locating` and `too_short` keep the canvas's own wording. */
      return null;
  }
}
