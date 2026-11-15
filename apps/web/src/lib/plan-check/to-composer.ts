import { ASSUMED_PARTY, countryFacts, type StatedItineraryInput } from '@sidequest/core';
import type { ComposerInput } from '@/app/(product)/trips/new/actions';

/**
 * "PLAN THIS" — A CHECKED PLAN BECOMES AN ORDINARY TRIP.
 *
 * Nothing about a trip that started as somebody's own plan is special after
 * this: the composer payload is the same one the setup flow sends, so
 * `createTripFromComposer` validates it, writes the trip and its composer
 * answers, and the rest of the product (interview → discovery scan → board →
 * planner) runs unchanged.
 *
 * - **The places are the destination.** Their names, in order, become the
 *   destination phrase the intent graph splits into parts — and, with the
 *   country the plan named, "A, B and C, Japan", which the graph reads as
 *   three parts inside one country. The trip contract holds the destination
 *   at `user_explicit`.
 * - **The places are their own must-dos.** `existingPlan` carries them as one
 *   ordered line, which the canonical input reads as the traveller's own words
 *   (`existingPlanPlaceNames`) and the board checks (`plan-critique.ts`).
 * - **The stays are theirs.** `statedItinerary` carries each stay's nights,
 *   bookings, must-sees and transport with provenance into the trip contract
 *   (`contract/stated-itinerary.ts`), so "3 nights in Kyoto" is a locked fact
 *   the planner sleeps by, not a must-do it may re-split.
 * - **Dates are theirs only when they gave them.** Typed dates are `exact` and
 *   locked to the traveller; a month is a month; otherwise Sidequest is asked
 *   for the best time, exactly as "Tell me when it is best" would.
 */

export interface PlanForComposer {
  stops: readonly { label: string; nights: number; dayTrip: boolean }[];
  totalNights: number | null;
  startDate: string | null;
  endDate: string | null;
  month: number | null;
  contextCountries: readonly string[];
  /** The version they chose, as the canonical stated itinerary (nights, bookings, must-sees, transport, provenance). */
  statedItinerary?: StatedItineraryInput;
  /** Who is going; absent or `assumed` travels as an assumption every screen labels. */
  party?: { adults: number; children: number; basis: 'stated' | 'profile' | 'assumed' };
}

const MAX_DESTINATION = 200;
const MAX_PLAN = 2000;

function joined(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function destinationPhraseFor(plan: Pick<PlanForComposer, 'stops' | 'contextCountries'>): string {
  const beds = [...new Set(plan.stops.filter((s) => !s.dayTrip).map((s) => s.label.trim()).filter(Boolean))];
  const names = beds.length > 0 ? beds : [...new Set(plan.stops.map((s) => s.label.trim()))];
  const country = plan.contextCountries.length === 1 ? countryFacts(plan.contextCountries[0]!)?.name ?? null : null;
  let phrase = joined(names);
  if (country && !names.some((n) => n.toLowerCase() === country.toLowerCase())) phrase = `${phrase}, ${country}`;
  /* A long list is cut at a whole name, never mid-word. */
  while (phrase.length > MAX_DESTINATION && names.length > 1) {
    names.pop();
    phrase = joined(names) + (country ? `, ${country}` : '');
  }
  return phrase.slice(0, MAX_DESTINATION);
}

export function composerInputForPlan(plan: PlanForComposer): ComposerInput {
  const exact = Boolean(plan.startDate && plan.endDate);
  const nights = plan.totalNights !== null && plan.totalNights >= 1 ? Math.min(30, plan.totalNights) : null;
  const order = [...new Set(plan.stops.map((s) => s.label.trim()).filter(Boolean))].join(', ').slice(0, MAX_PLAN);
  return {
    destinationText: destinationPhraseFor(plan),
    destinationEntryId: null,
    dateMode: exact ? 'exact' : plan.month ? 'month' : 'best_time',
    startDate: exact ? plan.startDate! : '',
    endDate: exact ? plan.endDate! : '',
    flexDays: 3,
    month: plan.month ?? new Date().getUTCMonth() + 1,
    months: [],
    earliest: null,
    latest: null,
    recommendation: null,
    season: 'summer',
    wantsDateRecommendation: !exact && !plan.month,
    wantsLengthRecommendation: nights === null,
    nights,
    arrivalPrecision: 'not_booked',
    departurePrecision: 'not_booked',
    /* Never a silent two adults: the party they gave, or the assumption, marked as one. */
    adults: plan.party?.adults ?? ASSUMED_PARTY.adults,
    children: plan.party?.children ?? ASSUMED_PARTY.children,
    partyBasis: plan.party?.basis ?? 'assumed',
    ...(plan.statedItinerary ? { statedItinerary: plan.statedItinerary } : {}),
    travelerNeeds: [],
    mustDo: '',
    avoid: '',
    existingPlan: order,
    origin: '',
  };
}
