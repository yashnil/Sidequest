/**
 * THE COLLECTION'S PLATES — pure arithmetic for the two marks a trip can carry.
 *
 * 1. **A route plate**, when the plan persisted coordinates: the shape is
 *    `projectShape`'s, and the only addition here is a scale bar. It is a
 *    *straight-line* scale (degrees of latitude × 111.32 km), because the
 *    plate draws the order bases are slept in, not roads — so the bar says
 *    "straight line" and never implies a driving distance.
 *
 * 2. **A ledger mark**, when nothing is placed yet. Twelve trips without
 *    coordinates used to get twelve identical empty stamps. What *is* known
 *    still tells them apart honestly: the letterforms of the name, the months
 *    the dates fall in (or that they are still open), how many nights, who is
 *    going, and where the trip is in its life. Nothing here draws a place, a
 *    route or a map.
 *
 * Import-free so the tests read it directly.
 */

const KM_PER_DEGREE_LAT = 111.32;
const NICE_KM = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

/**
 * The longest round distance whose bar fits in `maxUnits` drawing units, given
 * `pxPerDegree` from `projectShape`. Null when the shape is one place (there
 * is no scale to state) or the round figure would be under a fifth of the room.
 */
export function scaleBar(pxPerDegree: number, maxUnits: number): { km: number; units: number; label: string } | null {
  if (!(pxPerDegree > 0) || !(maxUnits > 0)) return null;
  const unitsPerKm = pxPerDegree / KM_PER_DEGREE_LAT;
  let best: number | null = null;
  for (const km of NICE_KM) if (km * unitsPerKm <= maxUnits) best = km;
  if (best === null) return null;
  const units = Math.round(best * unitsPerKm * 10) / 10;
  if (units < maxUnits * 0.2) return null;
  /* Just the distance: the plate's caption already says its lines are not roads, once, in words. */
  return { km: best, units, label: best < 1 ? `${best * 1000} m` : `${best.toLocaleString('en-GB')} km` };
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'in', 'to', 'a', 'an', 'de', 'la', 'le', 'el', 'y', 'et', 'und', 'da', 'do', 'di']);

/**
 * The letterforms a name is set in on its mark: the initials of its first two
 * significant words ("Mammoth Lakes" → "ML", "Hong Kong" → "HK"), or the
 * first two letters of a one-word name, set as a cipher ("Tasmania" → "Ta",
 * so Ireland and Iceland are "Ir" and "Ic", not two identical capitals).
 * Letters, not glyphs of a place.
 */
export function monogram(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[\s,/–—-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0);
  const significant = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  const use = significant.length > 0 ? significant : words;
  if (use.length === 0) return '·';
  const letter = (w: string) => Array.from(w)[0]!.toLocaleUpperCase();
  if (use.length > 1) return `${letter(use[0]!)}${letter(use[1]!)}`;
  const chars = Array.from(use[0]!);
  return chars.length > 1 ? `${chars[0]!.toLocaleUpperCase()}${chars[1]!.toLocaleLowerCase()}` : chars[0]!.toLocaleUpperCase();
}

export interface LedgerFacts {
  id: string;
  destination: string;
  startDate: string;
  nights: number;
  party: string;
  timing: 'fixed' | 'chosen' | 'open';
  lifecycle: string;
}

export interface LedgerMark {
  letters: string;
  /** Twelve months, January first; `true` where the trip's days fall. All false when the dates are open. */
  months: boolean[];
  datesOpen: boolean;
  year: string | null;
  /** One tick per night, capped for drawing; `more` is what the cap left out. */
  nights: { drawn: number; more: number };
  adults: number;
  children: number;
  /** The mark's frame: solid for a trip with days, dashed for an idea, faded for one that is over. */
  frame: 'solid' | 'dashed' | 'faded';
}

const MAX_TICKS = 21;

/** "2 adults, 1 child" → { adults: 2, children: 1 }. Unknown words read as nobody, never as a guess. */
export function partyCounts(party: string): { adults: number; children: number } {
  const adults = Number(/(\d+)\s*adult/i.exec(party)?.[1] ?? 0);
  const children = Number(/(\d+)\s*child/i.exec(party)?.[1] ?? 0);
  return { adults: Number.isFinite(adults) ? adults : 0, children: Number.isFinite(children) ? children : 0 };
}

export function ledgerMark(facts: LedgerFacts): LedgerMark {
  const datesOpen = facts.timing === 'open' || !/^\d{4}-\d{2}-\d{2}/.test(facts.startDate);
  const months = Array.from({ length: 12 }, () => false);
  let year: string | null = null;
  if (!datesOpen) {
    const start = Date.parse(`${facts.startDate.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(start)) {
      year = facts.startDate.slice(0, 4);
      const days = Math.max(0, Math.min(400, facts.nights));
      for (let d = 0; d <= days; d++) months[new Date(start + d * 86_400_000).getUTCMonth()] = true;
    }
  }
  const nights = Math.max(0, Math.round(facts.nights));
  const { adults, children } = partyCounts(facts.party);
  const frame = facts.lifecycle === 'past' || facts.lifecycle === 'archived' ? 'faded' : facts.lifecycle === 'idea' ? 'dashed' : 'solid';
  return {
    letters: monogram(facts.destination),
    months,
    datesOpen: datesOpen || year === null,
    year,
    nights: { drawn: Math.min(nights, MAX_TICKS), more: Math.max(0, nights - MAX_TICKS) },
    adults,
    children,
    frame,
  };
}

/** The mark in words, for the caption beside it and for anyone not looking at it. */
export function ledgerWords(mark: LedgerMark): string {
  const parts = ['Not on the map yet'];
  if (mark.datesOpen) parts.push('dates open');
  const n = mark.nights.drawn + mark.nights.more;
  if (n > 0) parts.push(`${n} night${n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
