/**
 * V8 §9 — WHAT A TRIP CARD SAYS UNDER ITS TITLE, AS TWO LINES.
 *
 * The dashboard card used to print five stacked facts — dates, the destination
 * again, "Nothing booked yet", a feasibility sentence, "Updated today" — each
 * in its own grey line, which is what made a card read as a database row. This
 * composes the same facts into two lines a person scans:
 *
 *   1. **when and who** — the dates set as a figure, the nights, the party;
 *   2. **where it stands** — the readiness of the plan, then what is booked.
 *
 * Pure and import-free so it can be tested without a database, and shared by
 * the home strip and the dashboard so the two cannot describe the same trip
 * differently. Nothing here invents a fact: every word is derived from what
 * the server already computed for the row.
 */

export type CardTone = 'neutral' | 'pine' | 'amber' | 'blue' | 'clay';

/** The structural subset of a dashboard row the composition reads. */
export interface CardFacts {
  title: string;
  destination: string;
  dates: string;
  timing: 'fixed' | 'chosen' | 'open';
  nights: number;
  party: string;
  itineraryStatus: 'ready' | 'ready_with_cautions' | 'needs_decision' | null;
  /** From `tripProgress`: where the trip is when there is no finished plan to speak for it. */
  progressState: string;
  progressLabel: string;
  progressTone: CardTone;
  bookedCount: number;
  bases: string[];
}

export interface CardMeta {
  when: {
    /** The dates, or null when the timing is still open. Set in `type-figure` by the card. */
    figure: string | null;
    /** The words that stand in for a figure while nothing is decided. */
    open: string | null;
    /** "7 nights", "4 adults" — joined with middle dots after the figure. */
    rest: string[];
    /** A footnote for dates Sidequest chose rather than the traveller. */
    note: string | null;
  };
  readiness: { label: string; tone: CardTone };
  booking: { label: string; booked: boolean };
  /**
   * Up to four base names in order, and how many more there were. Empty when
   * the only base would merely restate the title or the destination.
   */
  route: { names: string[]; more: number };
}

const ROUTE_NAMES_SHOWN = 4;

const READINESS_WORDS: Record<NonNullable<CardFacts['itineraryStatus']>, { label: string; tone: CardTone }> = {
  ready: { label: 'Plan ready', tone: 'pine' },
  ready_with_cautions: { label: 'Ready, with cautions', tone: 'amber' },
  needs_decision: { label: 'Needs a decision', tone: 'amber' },
};

export function composeCardMeta(facts: CardFacts): CardMeta {
  const rest: string[] = [];
  if (facts.nights > 0) rest.push(`${facts.nights} ${facts.nights === 1 ? 'night' : 'nights'}`);
  if (facts.party.trim()) rest.push(facts.party);

  /*
   * A build that is running speaks for the plan whatever the last plan said:
   * "Plan ready" over a rebuild in progress would send somebody to a page that
   * is about to change under them.
   */
  const readiness =
    facts.progressState === 'building'
      ? { label: facts.progressLabel, tone: facts.progressTone }
      : facts.itineraryStatus
        ? READINESS_WORDS[facts.itineraryStatus]
        : { label: facts.progressLabel, tone: facts.progressTone };

  const route = restatesTheTrip(facts) ? [] : facts.bases;

  return {
    when: {
      figure: facts.timing === 'open' ? null : facts.dates,
      open: facts.timing === 'open' ? 'Timing still open' : null,
      rest,
      note: facts.timing === 'chosen' ? 'Dates chosen for you' : null,
    },
    readiness,
    booking: {
      label: facts.bookedCount > 0 ? `${facts.bookedCount} booked` : 'Nothing booked yet',
      booked: facts.bookedCount > 0,
    },
    route: {
      names: route.slice(0, ROUTE_NAMES_SHOWN),
      more: Math.max(0, route.length - ROUTE_NAMES_SHOWN),
    },
  };
}

/**
 * A one-base trip whose base is the destination has no route to preview: the
 * line under the readiness would read "Kenya and Tanzania" beneath a card
 * already titled "Kenya and Tanzania". Two or more bases are always a route,
 * and a single base with its own name is worth saying.
 */
function restatesTheTrip(facts: Pick<CardFacts, 'bases' | 'title' | 'destination'>): boolean {
  if (facts.bases.length !== 1) return false;
  const base = fold(facts.bases[0]!);
  return base === fold(facts.title) || base === fold(facts.destination);
}

function fold(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * V9 §21 — "6 of 8 major items booked", from the booking progress the trip's
 * intelligence already computes. Null when the plan needs nothing major, so
 * a card never says "0 of 0". Pure, so the row and a test agree.
 */
export function bookingStateLabel(progress: { arranged: number; critical: number } | null | undefined): string | null {
  if (!progress || progress.critical <= 0) return null;
  return `${progress.arranged} of ${progress.critical} major item${progress.critical === 1 ? '' : 's'} booked`;
}

/**
 * V9 §21 — where a card's primary action goes. A trip under way opens Today;
 * a hub anchor from the next-action engine opens the hub at that anchor;
 * otherwise the progress path the row already computed.
 */
export function primaryHrefFor(input: { tripId: string; lifecycle: string; progressHref: string; nextHref?: string | null }): string {
  if (input.lifecycle === 'traveling') return `/trips/${input.tripId}/today`;
  if (input.nextHref) return input.nextHref.startsWith('#') ? `/trips/${input.tripId}/itinerary${input.nextHref}` : input.nextHref;
  return input.progressHref;
}
