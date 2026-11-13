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

export function statedTravelMode(text: string | null | undefined): Extract<TransportIntent, 'drive' | 'public_transport'> | null {
  const phrase = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!phrase) return null;
  const transit = TRANSIT.test(phrase);
  const drive = DRIVE.test(phrase);
  if (transit === drive) return null;
  return transit ? 'public_transport' : 'drive';
}
