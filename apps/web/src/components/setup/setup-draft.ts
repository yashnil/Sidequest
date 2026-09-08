import type { DateMode, TravelerNeed, TripComposerAnswers } from '@sidequest/core';
import type { ComposerInput } from '@/app/(product)/trips/new/actions';

/**
 * THE SETUP DRAFT — WHAT THE FIRST FIVE SCREENS HOLD, AS PLAIN DATA.
 *
 * Separated from the screens so the step machine is a pure function that can be
 * tested without a browser: which step comes next, whether a step has been
 * answered, and what the whole thing means when it is handed to the server.
 *
 * Every field has an "unanswered" value that is distinguishable from an answer.
 * `nights: null` is nobody has said; `partyShape: null` is nobody has said. That
 * distinction is what stops a screen presenting Sidequest's own default as the
 * traveller's decision — the same rule the composer schema holds.
 */

export const SETUP_STEPS = ['where', 'when', 'nights', 'who', 'fixed'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_LABELS: Record<SetupStepId, string> = {
  where: 'Where',
  when: 'When',
  nights: 'How long',
  who: 'Who',
  fixed: 'Anything fixed',
};

export type PartyShape = 'solo' | 'couple' | 'friends' | 'family' | 'other';

export interface TimingPick {
  startDate: string;
  endDate: string;
  label: string;
  month: number;
  year: number;
  reasons: string[];
  tradeoffs: string[];
}

export interface SetupDraft {
  destinationText: string;
  destinationEntryId: string | null;
  destinationCenter: { lat: number; lng: number } | null;
  destinationBounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null;
  destinationFeatureType: string | null;

  dateMode: DateMode;
  startDate: string;
  endDate: string;
  flexDays: number;
  month: number;
  months: number[];
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  earliest: string;
  latest: string;
  /** What Sidequest proposed and the traveller accepted, when they asked it to choose. */
  pick: TimingPick | null;

  nights: number | null;
  wantsLengthHelp: boolean;

  partyShape: PartyShape | null;
  adults: number;
  children: number;
  travelerNeeds: TravelerNeed[];

  knowsFlightTimes: boolean;
  arrival: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown' | 'not_booked';
  departure: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown' | 'not_booked';

  mustDo: string;
  avoid: string;

  /**
   * The steps the traveller has actually answered and moved past.
   *
   * Load-bearing, not bookkeeping: without it the running summary showed
   * "6 nights · 7 days" and a date range on the very first screen, because those
   * are the *defaults the form starts with*. Presenting Sidequest's placeholder
   * as somebody's answer is the exact failure the composer schema's
   * "undefined is not the same as no" rule exists to prevent, and it had crept
   * back in through the summary panel.
   */
  answered: SetupStepId[];
}

export function initialDraft(defaults: { startDate: string; endDate: string }, prior?: TripComposerAnswers): SetupDraft {
  const now = new Date();
  const base: SetupDraft = {
    destinationText: '',
    destinationEntryId: null,
    destinationCenter: null,
    destinationBounds: null,
    destinationFeatureType: null,
    dateMode: 'exact',
    /*
     * Empty, not prefilled. Two dates a month out are a decision nobody made,
     * and a traveller who presses Continue past them has been handed a trip
     * length they never chose — the same defaults-as-answers failure the
     * summary had. `defaults` is used only to seed an *edit*, where the dates
     * really were answered once.
     */
    startDate: '',
    endDate: '',
    flexDays: 3,
    month: (now.getUTCMonth() % 12) + 1,
    months: [],
    season: 'summer',
    earliest: '',
    latest: '',
    pick: null,
    nights: null,
    wantsLengthHelp: false,
    partyShape: null,
    adults: 2,
    children: 0,
    travelerNeeds: [],
    knowsFlightTimes: false,
    arrival: 'afternoon',
    departure: 'morning',
    mustDo: '',
    avoid: '',
    answered: [],
  };
  if (!prior) return base;
  const nights = prior.duration.nights ?? nightsBetween(prior.dates.startDate, prior.dates.endDate);
  return {
    ...base,
    destinationText: prior.destinationQuery ?? prior.destination?.displayName ?? '',
    destinationEntryId: prior.destination?.entryId ?? null,
    destinationCenter: prior.destination?.center ?? null,
    destinationBounds: prior.destination?.bounds ?? null,
    destinationFeatureType: prior.destination?.featureType ?? null,
    dateMode: prior.dates.mode,
    startDate: prior.dates.startDate ?? base.startDate,
    endDate: prior.dates.endDate ?? base.endDate,
    flexDays: prior.dates.flexDays ?? base.flexDays,
    month: prior.dates.month ?? base.month,
    months: [...(prior.dates.months ?? [])],
    season: prior.dates.season ?? base.season,
    earliest: prior.dates.earliest ?? base.earliest,
    latest: prior.dates.latest ?? base.latest,
    pick: prior.dates.recommendation
      ? {
          startDate: prior.dates.recommendation.startDate,
          endDate: prior.dates.recommendation.endDate,
          label: prior.dates.recommendation.label,
          month: prior.dates.recommendation.month,
          year: prior.dates.recommendation.year,
          reasons: [...prior.dates.recommendation.reasons],
          tradeoffs: [...prior.dates.recommendation.tradeoffs],
        }
      : null,
    nights,
    wantsLengthHelp: prior.duration.wantsRecommendation,
    partyShape: partyShapeFrom(prior.adults, prior.children),
    adults: prior.adults,
    children: prior.children,
    travelerNeeds: [...prior.travelerNeeds],
    knowsFlightTimes: prior.arrival?.precision !== undefined && prior.arrival.precision !== 'not_booked',
    arrival: prior.arrival?.precision ?? base.arrival,
    departure: prior.departure?.precision ?? base.departure,
    mustDo: prior.mustDo ?? '',
    avoid: prior.avoid ?? '',
    // Everything a stored trip holds has been answered once already.
    answered: [...SETUP_STEPS],
  };
}

function partyShapeFrom(adults: number, children: number): PartyShape | null {
  if (children > 0) return 'family';
  if (adults === 1) return 'solo';
  if (adults === 2) return 'couple';
  if (adults >= 3) return 'friends';
  return null;
}

export function nightsBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const nights = Math.round((to - from) / 86_400_000);
  return nights > 0 ? nights : null;
}

/**
 * Whether a step is worth showing at all.
 *
 * Only one is conditional today, and for a reason that matters: a traveller who
 * gave two exact dates has already answered "how many nights", and asking again
 * is asking them to check our arithmetic.
 */
export function stepIsRelevant(step: SetupStepId, draft: SetupDraft): boolean {
  if (step !== 'nights') return true;
  return nightsBetween(draft.startDate, draft.endDate) === null || !dateModeGivesDates(draft.dateMode);
}

/**
 * The dates a window actually covers once the traveller has said how long.
 *
 * A recommendation is placed before the length is known — that is the order the
 * questions have to be in, because "when is it best" is the question somebody
 * asks first. When they then say ten nights rather than the seven the window was
 * placed with, the window keeps its *start* (which is what the evidence chose)
 * and grows. Nothing about the reasons changes: they are about the month.
 */
export function effectiveWindow(draft: SetupDraft): { startDate: string; endDate: string } | null {
  if (!draft.pick) return null;
  const nights = draft.nights ?? nightsBetween(draft.pick.startDate, draft.pick.endDate);
  if (nights === null) return { startDate: draft.pick.startDate, endDate: draft.pick.endDate };
  const start = Date.parse(`${draft.pick.startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return { startDate: draft.pick.startDate, endDate: draft.pick.endDate };
  return { startDate: draft.pick.startDate, endDate: new Date(start + nights * 86_400_000).toISOString().slice(0, 10) };
}

function dateModeGivesDates(mode: DateMode): boolean {
  return mode === 'exact' || mode === 'flexible';
}

export function nextStep(step: SetupStepId, draft: SetupDraft): SetupStepId | null {
  const index = SETUP_STEPS.indexOf(step);
  for (let i = index + 1; i < SETUP_STEPS.length; i += 1) {
    const candidate = SETUP_STEPS[i]!;
    if (stepIsRelevant(candidate, draft)) return candidate;
  }
  return null;
}

export function previousStep(step: SetupStepId, draft: SetupDraft): SetupStepId | null {
  const index = SETUP_STEPS.indexOf(step);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = SETUP_STEPS[i]!;
    if (stepIsRelevant(candidate, draft)) return candidate;
  }
  return null;
}

/** Whether the traveller has said enough on this screen to move on. */
export function isStepAnswered(step: SetupStepId, draft: SetupDraft): boolean {
  switch (step) {
    case 'where':
      return draft.destinationText.trim().length >= 2;
    case 'when':
      return timingIsAnswered(draft);
    case 'nights':
      return draft.nights !== null || draft.wantsLengthHelp;
    case 'who':
      return draft.partyShape !== null;
    case 'fixed':
      // Nothing fixed is a complete answer, and the commonest one.
      return true;
    default:
      return false;
  }
}

export function timingIsAnswered(draft: SetupDraft): boolean {
  switch (draft.dateMode) {
    case 'exact':
    case 'flexible':
      return nightsBetween(draft.startDate, draft.endDate) !== null;
    case 'month':
      return draft.month >= 1 && draft.month <= 12;
    case 'months':
      return draft.months.length > 0;
    case 'window':
      return nightsBetween(draft.earliest, draft.latest) !== null;
    case 'season':
      return true;
    case 'best_time':
    case 'undecided':
      return true;
    default:
      return false;
  }
}

export function describeParty(draft: SetupDraft): string {
  const adults = `${draft.adults} adult${draft.adults === 1 ? '' : 's'}`;
  return draft.children > 0 ? `${adults}, ${draft.children} child${draft.children === 1 ? '' : 'ren'}` : adults;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function describeTiming(draft: SetupDraft): { value: string; assumed: boolean } {
  if (draft.pick) return { value: draft.pick.label, assumed: true };
  switch (draft.dateMode) {
    case 'exact':
    case 'flexible': {
      const nights = nightsBetween(draft.startDate, draft.endDate);
      if (nights === null) return { value: 'Not set', assumed: false };
      return { value: `${draft.startDate} → ${draft.endDate}${draft.dateMode === 'flexible' ? ` ± ${draft.flexDays}d` : ''}`, assumed: false };
    }
    case 'month':
      return { value: MONTH_NAMES[draft.month - 1] ?? '—', assumed: false };
    case 'months':
      return { value: draft.months.map((m) => MONTH_NAMES[m - 1]?.slice(0, 3) ?? '').join(', '), assumed: false };
    case 'window':
      return { value: `Free ${draft.earliest} → ${draft.latest}`, assumed: false };
    case 'season':
      return { value: draft.season.charAt(0).toUpperCase() + draft.season.slice(1), assumed: false };
    case 'best_time':
      return { value: 'Sidequest chooses', assumed: true };
    case 'undecided':
    default:
      return { value: 'Not decided', assumed: true };
  }
}

export interface SetupSummary {
  short: string;
  lines: { label: string; value: string; assumed: boolean }[];
}

/**
 * The running summary beside the question — ONLY what the traveller has said.
 *
 * A line appears when its step has been answered and moved past, never because
 * a control happens to hold a default. A destination is the exception: it is
 * shown as it is typed, because that is the screen the traveller is on.
 */
export function summaryOf(draft: SetupDraft): SetupSummary {
  const lines: SetupSummary['lines'] = [];
  const has = (step: SetupStepId) => draft.answered.includes(step);
  const destination = draft.destinationText.trim();
  if (destination) lines.push({ label: 'Where', value: destination, assumed: false });

  if (has('when')) {
    const timing = describeTiming(draft);
    lines.push({ label: 'When', value: timing.value, assumed: timing.assumed });
  }

  const window = effectiveWindow(draft);
  const nights = draft.nights ?? (window ? nightsBetween(window.startDate, window.endDate) : null) ?? (has('when') ? nightsBetween(draft.startDate, draft.endDate) : null);
  if (has('nights') || (has('when') && nights !== null)) {
    if (nights !== null) lines.push({ label: 'Length', value: `${nights} nights · ${nights + 1} days`, assumed: false });
    else if (draft.wantsLengthHelp) lines.push({ label: 'Length', value: 'Sidequest suggests one', assumed: true });
  }

  if (has('who') && draft.partyShape) lines.push({ label: 'Who', value: describeParty(draft), assumed: false });

  const short = destination ? [destination, nights !== null ? `${nights} nights` : null].filter(Boolean).join(' · ') : 'Start with where';
  return { short, lines };
}

/** Nights to send when the traveller has not chosen one. Never presented to them as their answer. */
const ASSUMED_NIGHTS = 6;

/** The setup draft as the payload both composer server actions already read. */
export function payloadFor(draft: SetupDraft): ComposerInput {
  const derived = nightsBetween(draft.startDate, draft.endDate);
  const window = effectiveWindow(draft);
  const nights = draft.nights ?? (window ? nightsBetween(window.startDate, window.endDate) : null) ?? derived ?? ASSUMED_NIGHTS;
  /*
   * An accepted recommendation becomes the trip's dates, and the mode it was
   * asked under is kept — so every screen downstream can still say the dates
   * were chosen for the traveller rather than by them.
   */
  const startDate = window?.startDate ?? draft.startDate;
  const endDate = window?.endDate ?? draft.endDate;
  return {
    destinationText: draft.destinationText.trim(),
    destinationEntryId: draft.destinationEntryId,
    dateMode: draft.dateMode,
    startDate,
    endDate,
    flexDays: draft.flexDays,
    month: draft.pick?.month ?? draft.month,
    months: draft.months,
    earliest: draft.dateMode === 'window' ? draft.earliest : null,
    latest: draft.dateMode === 'window' ? draft.latest : null,
    season: draft.season,
    recommendation: draft.pick && window
      ? {
          startDate: window.startDate,
          endDate: window.endDate,
          label: draft.pick.label,
          month: draft.pick.month,
          year: draft.pick.year,
          reasons: draft.pick.reasons,
          tradeoffs: draft.pick.tradeoffs,
        }
      : null,
    wantsDateRecommendation: draft.dateMode === 'best_time' || draft.dateMode === 'window' || draft.dateMode === 'months',
    wantsLengthRecommendation: draft.wantsLengthHelp,
    nights: draft.nights ?? (draft.pick ? nights : null),
    arrivalPrecision: draft.knowsFlightTimes ? draft.arrival : 'not_booked',
    departurePrecision: draft.knowsFlightTimes ? draft.departure : 'not_booked',
    adults: draft.adults,
    children: draft.children,
    travelerNeeds: draft.travelerNeeds,
    mustDo: draft.mustDo,
    avoid: draft.avoid,
    origin: '',
  };
}
