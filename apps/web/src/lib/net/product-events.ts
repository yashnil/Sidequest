import 'server-only';

/**
 * PRIVATE ALPHA — PRODUCT COUNTERS IN THE SERVER LOG.
 *
 * No analytics provider: one JSON line per event on stdout, which Railway's log
 * keeps and `railway logs --json | grep sidequest_event` counts. What an event
 * may carry is closed: the event name, a short trip reference (the first eight
 * characters of the id, enough to join a trip's events, not to open it), and a
 * few enumerated or numeric facts. Never a destination, a name, a note, a
 * profile answer or anything a traveller typed.
 */
export type ProductEventName =
  | 'trip_created'
  | 'interview_completed'
  | 'discovery_completed'
  | 'discovery_failed'
  | 'auto_pick_used'
  | 'build_completed'
  | 'build_failed'
  | 'itinerary_opened'
  | 'regenerate_used'
  | 'export_used'
  | 'share_created'
  | 'feedback_submitted';

export type ProductEventFacts = Record<string, string | number | boolean | null>;

export function productEvent(name: ProductEventName, tripId: string | null, facts: ProductEventFacts = {}): void {
  try {
    const safe: ProductEventFacts = {};
    for (const [key, value] of Object.entries(facts)) {
      if (typeof value === 'string') safe[key] = value.slice(0, 40);
      else safe[key] = value;
    }
    process.stdout.write(`${JSON.stringify({ sidequest_event: name, trip: tripId ? tripId.slice(0, 8) : null, at: new Date().toISOString(), ...safe })}\n`);
  } catch {
    /* A counter must never break the request it counts. */
  }
}
