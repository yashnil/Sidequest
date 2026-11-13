import type { TransportIntent } from '../schemas/composer';

/**
 * HOW THE TRAVELLER SAID THEY WILL MOVE, WHEN THEY SAID IT IN THE DESTINATION.
 *
 * "Tokyo and Kyoto by train" was planned with a rental car for the whole trip
 * and a five-hour drive between the cities: the destination door handed the
 * whole phrase to the place resolver and nothing read the last two words. The
 * Help-me-choose parser has always read them (`advisor/parse.ts`); this is the
 * same reading for a typed destination, stricter on purpose — a place name can
 * itself contain "road" or "drive", so only an explicit clause about the
 * traveller's own movement counts:
 *
 * - "by train", "by rail", "by public transport", "by bus", "on a rail pass",
 *   "without a car", "car-free", "no car" → public transport;
 * - "by car", "road trip", "self-drive", "with a car", "in a campervan" → drive.
 *
 * Both together, or neither, is no reading. The answer is the composer's own
 * transport intent, so it reaches the interview as a carried answer the
 * traveller sees and can change, never as a hidden override. Never patch a
 * destination by name: nothing here knows a place.
 */
const TRANSIT =
  /\b(?:by (?:train|trains|rail|the shinkansen|bullet train|public transport(?:ation)?|public transit|transit|bus|buses|coach)|on (?:a |the )?(?:rail pass|trains?)|using (?:trains|public transport)|without (?:a |any )?car|car[- ]free|no car)\b/i;
const DRIVE = /\b(?:by car|road ?trip|self[- ]drive|with (?:a|our|my) (?:car|rental car|hire car)|in (?:a )?(?:campervan|camper van|rental car|hire car)|driving)\b/i;

/**
 * The phrase with its "how we'll move" clause taken out, for splitting into
 * places. "Tokyo and Kyoto by train" split into "Tokyo" and "Kyoto by train",
 * and the second part was then asked for as a place — so Kyoto never became a
 * part the stays had to cover. Only the "by …" / "without a car" / "car-free"
 * clauses go; "road trip" and "driving" stay, because route-shape reading
 * (`route-shape.ts`) depends on them. The traveller's own label is unchanged.
 */
const MODE_CLAUSE = /\s*,?\s*\b(?:by (?:train|trains|rail|the shinkansen|bullet train|public transport(?:ation)?|public transit|transit|bus|buses|coach|car)|on (?:a |the )?rail pass|using (?:trains|public transport)|without (?:a |any )?car)\b\s*/gi;
const CAR_FREE_PREFIX = /^\s*car[- ]free\s+/i;

/**
 * A trailing word that says what kind of trip it is, not where: "Tanzania
 * safari", "Kyrgyzstan adventure", "Dolomites hiking". Eval v2 found "Tanzania
 * safari" read as a town-scale place — a small circle around one point — so
 * every park on the northern circuit was refused as outside the trip and a
 * lodge was placed in the capital. Only at the end of the phrase, only when a
 * place is left, and never the route words ("road trip", "ring road") that
 * route-shape reading depends on.
 */
const TRIP_KIND_SUFFIX = /\s+(?:safari|safaris|hiking|hike|hikes|trekking|trek|treks|adventure|adventures|holiday|holidays|vacation|getaway|honeymoon|ski(?:ing)?(?: trip| holiday)?|beach holiday|city break|break|tour|retreat|trip)$/i;

export function withoutModeClause(text: string): string {
  let stripped = text.replace(CAR_FREE_PREFIX, '').replace(MODE_CLAUSE, ' ').replace(/\s+/g, ' ').trim();
  if (!/\broad ?trip$/i.test(stripped)) {
    for (let guard = 0; guard < 3; guard += 1) {
      const next = stripped.replace(TRIP_KIND_SUFFIX, '').trim();
      if (next === stripped || next.length === 0) break;
      stripped = next;
    }
  }
  return stripped.length > 0 ? stripped : text.trim();
}

export function statedTravelMode(text: string | null | undefined): Extract<TransportIntent, 'drive' | 'public_transport'> | null {
  const phrase = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!phrase) return null;
  const transit = TRANSIT.test(phrase);
  const drive = DRIVE.test(phrase);
  if (transit === drive) return null;
  return transit ? 'public_transport' : 'drive';
}
