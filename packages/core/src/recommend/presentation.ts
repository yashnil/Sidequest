import { BUDGET_BAND_LABELS, TRIP_THEME_LABELS, type TripComposerAnswers } from '../schemas/composer';
import { RANK_DIMENSION_LABELS, type RankDimension, type RankedDestination } from '../schemas/shortlist';
import type { DestinationFeatureType } from '../schemas/destination-index';

/**
 * V11 §A2 — WHAT A FEATURED RECOMMENDATION HAS TO SAY.
 *
 * The brief lists seven things each of the three-and-a-wildcard must
 * communicate: the destination, a recommended sub-window inside the free dates,
 * why it fits *this* traveller, the trip concept, its defining draws, budget
 * fit, travel burden, and the main tradeoff. This file derives every one of them
 * **from measurements the ranking already made**, and returns `null` for each
 * one it cannot.
 *
 * That is the whole design rule, and it is worth stating plainly because the
 * temptation on a results screen is enormous: a destination card with a blank
 * where the budget line should be looks unfinished, and the cheapest way to fill
 * it is to write something plausible. Sidequest has no airfare source, no
 * lodging prices and no ticket costs — so a "budget fit" here is a statement
 * about what the index knows about *where you can sleep*, labelled as one, and a
 * "travel burden" is a distance, labelled as one. Neither is ever a number of
 * dollars, and no sentence in this file is generated for a dimension whose
 * measure came back unknown.
 *
 * Nothing here calls a model. Nothing here reads a provider.
 */

function factor(pick: RankedDestination, id: RankDimension) {
  return pick.factors.find((entry) => entry.id === id);
}

function measuredValue(pick: RankedDestination, id: RankDimension): number | null {
  const measure = factor(pick, id)?.measure;
  return measure?.kind === 'measured' ? measure.value : null;
}

function measuredBasis(pick: RankedDestination, id: RankDimension): string | null {
  const measure = factor(pick, id)?.measure;
  return measure?.kind === 'measured' ? measure.basis : null;
}

// ---------------------------------------------------------------------------
// The sub-window
// ---------------------------------------------------------------------------

export interface RecommendedWindow {
  startDate: string;
  endDate: string;
  nights: number;
  /** Why the window sits where it does. Always a checkable sentence. */
  basis: string;
  /** True when the window is the traveller's whole free period rather than a choice we made. */
  wholeWindow: boolean;
}

const DAY_MS = 86_400_000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parse(value: string | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * Where inside a free window this trip should actually sit.
 *
 * Three cases, and each says which it is:
 *
 * - The free window is the trip. Nothing to choose, and the screen must not
 *   dress that up as a recommendation.
 * - The free window is longer, and we know which months this place is best in
 *   (`bestMonths`, from the same climate records the ranking scored). The window
 *   slides to the first position whose midpoint falls in the best month.
 * - The free window is longer and we know nothing about the months. The window
 *   goes at the start of the free period and the basis **says** it was not
 *   chosen, because a recommendation nobody made must not read as one.
 */
export function recommendedWindow(
  pick: RankedDestination,
  answers: TripComposerAnswers,
): RecommendedWindow | null {
  const from = parse(answers.dates.startDate);
  const to = parse(answers.dates.endDate);
  if (!from || !to || to.getTime() < from.getTime()) return null;

  const freeNights = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  const wanted = tripNights(pick, answers);
  if (wanted === null || wanted >= freeNights) {
    return {
      startDate: iso(from),
      endDate: iso(to),
      nights: freeNights,
      basis: 'your whole free window',
      wholeWindow: true,
    };
  }

  const best = new Set(pick.bestMonths ?? []);
  const latestStart = freeNights - wanted;

  /*
   * THE WINDOW THAT SPENDS THE MOST NIGHTS IN A GOOD MONTH.
   *
   * Not "the window whose midpoint falls in the best month", which was the first
   * rule here and was wrong in the case that matters most: a fortnight free over
   * New Year, ten nights wanted, and a place best in January. No offset puts the
   * midpoint in January, so the rule found nothing and reported that none of the
   * window was any good — while a window starting a week later would have spent
   * most of its nights there. Counting nights answers the question actually
   * being asked, and ties go to the earliest window because a traveller who
   * gains nothing by waiting should not be told to wait.
   */
  if (best.size > 0) {
    let chosen: { offset: number; nights: number } | null = null;
    for (let offset = 0; offset <= latestStart; offset += 1) {
      let inSeason = 0;
      for (let night = 0; night < wanted; night += 1) {
        const day = new Date(from.getTime() + (offset + night) * DAY_MS);
        if (best.has(day.getUTCMonth() + 1)) inSeason += 1;
      }
      if (!chosen || inSeason > chosen.nights) chosen = { offset, nights: inSeason };
    }
    if (chosen && chosen.nights > 0) {
      const start = new Date(from.getTime() + chosen.offset * DAY_MS);
      return {
        startDate: iso(start),
        endDate: iso(new Date(start.getTime() + wanted * DAY_MS)),
        nights: wanted,
        basis:
          chosen.nights === wanted
            ? `all ${wanted} nights fall in this place's best months, on the climate records`
            : `${chosen.nights} of ${wanted} nights fall in this place's best months, which is the most your window allows`,
        wholeWindow: false,
      };
    }
  }

  return {
    startDate: iso(from),
    endDate: iso(new Date(from.getTime() + wanted * DAY_MS)),
    nights: wanted,
    basis:
      best.size > 0
        ? `${wanted} nights from the start of your window — none of it falls in this place's best months`
        : `${wanted} nights from the start of your window — we have no records to prefer one part of it`,
    wholeWindow: false,
  };
}

/**
 * How long the trip itself is, which is not how long the traveller is free.
 *
 * `nightsFrom` reads a start and an end date as a trip length, and on this
 * screen those two dates are a *free window* — sixteen days off over New Year is
 * not a sixteen-night trip. Reading it here would have made every sub-window the
 * whole window, which is the one answer §A2 exists to replace.
 */
export function tripNights(pick: RankedDestination, answers: TripComposerAnswers): number | null {
  const duration = answers.duration;
  if (duration.mode === 'fixed' && duration.nights) return duration.nights;
  if (duration.mode === 'range') return duration.maxNights ?? duration.minNights ?? null;
  return pick.suggestedNights ?? null;
}

// ---------------------------------------------------------------------------
// The trip concept
// ---------------------------------------------------------------------------

/*
 * Total over the index's own feature vocabulary, so a new kind of place is a
 * compile error here rather than an unnamed "place" on the results screen.
 */
const CONCEPT_NOUN: Record<DestinationFeatureType, string> = {
  country: 'country',
  dependency: 'territory',
  region: 'region',
  county: 'county',
  city: 'city and the country around it',
  town: 'town and the country around it',
  district: 'district',
  island: 'island',
  national_park: 'national park',
  protected_area: 'protected landscape',
  natural_region: 'landscape',
  landmark: 'place',
  other: 'place',
};

/**
 * What kind of trip this would be, in one line.
 *
 * Assembled from three measured things — how many nights the ground supports,
 * how many bases it proposes, and what kind of place it is — and nothing else. A
 * concept invented for flavour ("a soulful journey through…") would be the
 * product's own voice standing in for evidence, and there is none of it here.
 */
export function tripConcept(pick: RankedDestination, answers: TripComposerAnswers): string | null {
  const nights = tripNights(pick, answers);
  const bases = pick.suggestedBases ?? null;
  const noun = CONCEPT_NOUN[pick.featureType];

  const shape =
    bases === null
      ? null
      : bases === 1
        ? 'one base, days out from it'
        : bases === 2
          ? 'two bases, the trip split between them'
          : `${bases} bases, a route rather than a stay`;

  if (nights === null && shape === null) return null;
  if (shape === null) return `${nights} nights in a ${noun}.`;
  if (nights === null) return `A ${noun}: ${shape}.`;
  return `${nights} nights in a ${noun} — ${shape}.`;
}

// ---------------------------------------------------------------------------
// What it is for
// ---------------------------------------------------------------------------

/**
 * The draws, from what was actually counted.
 *
 * Deliberately *not* a list of named attractions: the index holds feature counts
 * and area structure, not a curated set of experiences, and naming three sights
 * here would be the product inventing content it does not have. What it can say
 * truthfully is how much is here, how spread out it is, and which of the
 * traveller's own stated themes the place scored on — each with the basis the
 * ranking recorded.
 */
export function definingDraws(pick: RankedDestination, answers: TripComposerAnswers): string[] {
  const draws: string[] = [];

  const theme = measuredValue(pick, 'themeFit');
  const themeBasis = measuredBasis(pick, 'themeFit');
  if (theme !== null && theme >= 0.6 && answers.themes.length > 0) {
    draws.push(
      `${answers.themes.map((entry) => TRIP_THEME_LABELS[entry]).join(', ')} — ${themeBasis ?? 'scored against what you said you came for'}.`,
    );
  }

  const supplyBasis = measuredBasis(pick, 'supplyFit');
  if (supplyBasis && (measuredValue(pick, 'supplyFit') ?? 0) >= 0.6) draws.push(`${supplyBasis}.`);

  const varietyBasis = measuredBasis(pick, 'varietyFit');
  if (varietyBasis && (measuredValue(pick, 'varietyFit') ?? 0) >= 0.4) draws.push(`${varietyBasis}.`);

  return [...new Set(draws)].slice(0, 3);
}

// ---------------------------------------------------------------------------
// Budget and travel burden
// ---------------------------------------------------------------------------

export interface FitStatement {
  /** Two or three words, for the row label. */
  word: string;
  /** The measurement behind the word. Never a currency figure. */
  detail: string;
}

/**
 * What we can honestly say about money.
 *
 * One thing, and it is not a total: whether beds of the kind the traveller asked
 * for are recorded here. Sidequest holds no lodging prices, no airfares and no
 * ticket costs, so a "budget fit" that scored a trip against a figure would be a
 * fabrication — and the figure the traveller typed is carried through to the
 * trip untouched, where the budget model that does have evidence uses it.
 */
export function budgetFit(pick: RankedDestination, answers: TripComposerAnswers): FitStatement {
  const value = measuredValue(pick, 'comfortFit');
  const basis = measuredBasis(pick, 'comfortFit');
  if (value === null) {
    return {
      word: 'Not checked',
      detail: answers.lodgingComfort
        ? 'we have nothing on record about where you can sleep here'
        : 'you have not said what kind of place you want to sleep in',
    };
  }
  const word = value >= 0.9 ? 'Comfortable' : value >= 0.6 ? 'Workable' : 'Tight';
  return { word, detail: basis ?? 'from what the index records about places to stay' };
}

/**
 * How much of the trip is spent getting there.
 *
 * A distance and the traveller's own stated appetite for flying, which is what
 * `flightBurden` measures. Never a fare and never a flight time: §3 forbids
 * inventing airfare and the product has no source for either.
 */
export function travelBurden(pick: RankedDestination): FitStatement {
  const value = measuredValue(pick, 'flightBurden');
  const basis = measuredBasis(pick, 'flightBurden');
  if (value === null) {
    return { word: 'Not checked', detail: 'we could not place where you are starting from' };
  }
  const word = value >= 0.75 ? 'Light' : value >= 0.45 ? 'Moderate' : 'Heavy';
  return { word, detail: basis ?? 'great-circle distance from your origin' };
}

/**
 * The one thing somebody would most want warned about.
 *
 * The ranking's own first tradeoff where it produced one; otherwise the weakest
 * dimension it actually measured, named with its basis. Null when everything it
 * could measure came out well — which is a real answer and must not be filled
 * with a manufactured caveat.
 */
export function mainTradeoff(pick: RankedDestination): string | null {
  if (pick.tradeoffs.length > 0) return pick.tradeoffs[0]!;
  if (pick.conflicts.length > 0) return pick.conflicts[0]!.message;

  let weakest: { id: RankDimension; value: number; basis: string } | null = null;
  for (const entry of pick.factors) {
    if (entry.measure.kind !== 'measured') continue;
    if (entry.measure.value >= 0.5) continue;
    if (!weakest || entry.measure.value < weakest.value) {
      weakest = { id: entry.id, value: entry.measure.value, basis: entry.measure.basis };
    }
  }
  if (!weakest) return null;
  return `${RANK_DIMENSION_LABELS[weakest.id]}: ${weakest.basis}.`;
}

// ---------------------------------------------------------------------------
// The whole card
// ---------------------------------------------------------------------------

export interface FeaturedRecommendation {
  window: RecommendedWindow | null;
  concept: string | null;
  /** Why it fits *this* traveller. The ranking's own reasons, never rewritten. */
  fit: string[];
  draws: string[];
  budget: FitStatement;
  travel: FitStatement;
  tradeoff: string | null;
  /** What the traveller said that shaped this, so the card can name it back. */
  answered: string[];
}

export function featureRecommendation(
  pick: RankedDestination,
  answers: TripComposerAnswers,
): FeaturedRecommendation {
  const answered: string[] = [];
  if (answers.themes.length > 0) answered.push(answers.themes.map((theme) => TRIP_THEME_LABELS[theme]).join(', '));
  if (answers.outdoorIntensity) answered.push(`${answers.outdoorIntensity} days`);
  if (answers.budget && answers.budget !== 'unstated') answered.push(BUDGET_BAND_LABELS[answers.budget].toLowerCase());
  if (typeof answers.budgetPerPerson === 'number') {
    answered.push(
      `${answers.budgetPerPerson.toLocaleString('en-GB')} per person${
        answers.budgetIncludesFlights === undefined ? '' : answers.budgetIncludesFlights ? ' including flights' : ' before flights'
      }`,
    );
  }

  return {
    window: recommendedWindow(pick, answers),
    concept: tripConcept(pick, answers),
    fit: pick.reasons,
    draws: definingDraws(pick, answers),
    budget: budgetFit(pick, answers),
    travel: travelBurden(pick),
    tradeoff: mainTradeoff(pick),
    answered,
  };
}
