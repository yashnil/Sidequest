import { INTEREST_LABELS, type Interest, type PlaceCategory } from '../schemas/common';
import { frequencyCostOf } from '../scoring/frequency';
import type { TravelerProfile } from '../schemas/profile';
import type { StoredSelectionStatus } from '../schemas/discovery';
import { nothingIsPublishedAboutIt } from '../quality/significance';
import { detourToleranceMinutesFor, DETOUR_STRETCH_MULTIPLIER } from '../travel/reach';
import { significanceLean, type DiscoveryCandidate } from './board';

export interface AutoSelection {
  /** Place ids to pre-check, in board order. */
  selectedIds: string[];
  /** Stops this trip has room for, from its length and the traveller's pace. */
  targetCount: number;
  /**
   * How many of those this pass was actually free to fill.
   *
   * Smaller than `targetCount` where the traveller has already included places
   * by hand — those occupy the trip's capacity, and a pass that spent the full
   * target on top of them would over-fill the days it is sizing itself against.
   * Zero is a real answer and means the traveller has already filled the trip.
   */
  slots: number;
  /** Plain-language account of what the selection traded off. */
  notes: string[];
  stats: {
    hiddenGemShare: number;
    /**
     * One-way minutes summed across picks, in whatever mode each is made in.
     *
     * Was `totalDriveMinutesOneWay`, and on a car-free board it was structurally
     * **zero** — the only thing that added to it was a candidate whose access
     * rules named `drive`, and there were none — so the figure said "no travel
     * at all" about a trip made entirely of train journeys.
     */
    totalTravelMinutesOneWay: number;
    /** The part of that actually spent at a wheel. Zero for a non-driver. */
    totalDriveMinutesOneWay: number;
    byCategory: Partial<Record<PlaceCategory, number>>;
  };
  /**
   * Why each candidate that was not pre-selected was left out.
   *
   * Section 7: "when a candidate is excluded, store or expose a truthful
   * reason". Every one of these was already computed and thrown away — the band
   * pre-filter did not even produce one — so a traveller looking at a thin
   * pre-selection had no way to tell "we ran out of slots" from "your frequency
   * ceiling stopped us" from "we could not route it".
   */
  excluded: { placeId: string; reason: ExclusionReason }[];
}

/** Why auto-pick left a candidate alone. Never a judgement it did not make. */
export const AUTO_SELECT_EXCLUSIONS = [
  /** Unworkable on these dates or for this traveller. The board says why. */
  'not_workable',
  /** A weak fit on its own merits, which auto-pick never proposes. */
  'weak_fit',
  /** Past the per-interest ceiling the traveller set. */
  'frequency',
  /** The board already holds enough of this kind of thing. */
  'category',
  /** Would take the trip past the travel the traveller said they would accept. */
  'travel_budget',
  /** Already at the one pick allowed past the usual detour. */
  'stretch',
  /** The famous/hidden balance they asked for is already met. */
  'mix',
  /** No legal way in on any day of the trip. */
  'access',
  /** Nothing could establish the journey, so it is not pre-selected for them. */
  'reach_unverified',
  /**
   * Nothing outside the record establishes that this place is anything, so
   * auto-pick does not build a day around it. It stays a card.
   */
  'standing_unestablished',
  /**
   * The only journey anybody could price is a walk longer than the traveller's
   * own walking answer allows, so the planner will refuse the same leg.
   */
  'walk_too_long',
  /**
   * The traveller has already answered for this one, and auto-pick does not
   * overrule them. See `AutoSelectInput.decided`.
   */
  'already_decided',
  /** Real, eligible, and there were no slots left. */
  'no_slots',
] as const;
export type ExclusionReason = (typeof AUTO_SELECT_EXCLUSIONS)[number];

export interface AutoSelectInput {
  candidates: DiscoveryCandidate[];
  profile: TravelerProfile;
  tripDays: number;
  /**
   * WHAT THE TRAVELLER HAS ALREADY DECIDED BY HAND, AND WHY IT BELONGS HERE.
   *
   * Auto-pick spent slots on places whose selection it could not change. The
   * store deletes only its own rows and inserts `ON CONFLICT DO NOTHING`, so
   * every hand-made choice survives a re-pick untouched — which is right, and
   * which meant a place the traveller had *skipped* consumed one of the N slots,
   * had its insert quietly refused, and left the product saying "We picked 15
   * places" over fourteen. The count was not a rounding error: it was a promise
   * about somebody's trip that the next statement in the same transaction broke.
   *
   * So the answers come in and none of the three spends a slot. A skip is a
   * refusal and is never proposed again; a maybe is a decision to park something
   * and is not overruled; an include is already on the board and already
   * occupies a stop, which is why it draws down `slots` rather than being
   * re-picked. What is left is exactly the set of cards this pass can turn on,
   * so the number it reports is the number that changes. A `dismissed` row — the
   * traveller un-ticking one of our picks — is decided too, which is the whole
   * point of recording it: it is never proposed again.
   *
   * Optional, and absent means nobody has decided anything. Every product caller
   * passes `travellerDecided(getSelections(tripId))`, including the
   * questionnaire's seeding on the way to a build.
   */
  decided?: Readonly<Record<string, StoredSelectionStatus>>;
  /**
   * `DiscoveryBoard.transitUnmeasured`, passed straight through.
   *
   * The walking rule below has to bound a walk exactly as the planner will, and
   * the planner bounds a walk that stands in for an unmeasurable scheduled
   * journey like the ride it is. This pass holds candidates rather than travel
   * knowledge, so the board that does hold it hands the fact over.
   *
   * Optional, and absent is the walking bound: a caller that cannot establish
   * the gap does not get to widen anything on the strength of it.
   */
  transitUnmeasured?: boolean;
}

/**
 * WHAT LOCAL SIGNIFICANCE IS WORTH TO A PRE-SELECTION, AND WHY IT IS BOUNDED.
 *
 * The board composes significance *inside* a fit band, so the band gate bounds
 * it there and no weight can make a famous place outrank a better-suited one.
 * This comparison has no such gate — one greedy pass ranges over every eligible
 * candidate at once — so the same guarantee has to be bought numerically.
 *
 * Ten hundredths is the narrowest gap between two adjacent bands in
 * `scoring/fit.ts` (`top_pick` at 88, `strong` at 78). At this share the full
 * width of the significance scale is worth exactly that much of a fit score:
 * standing can reorder candidates within one band's worth of match and no
 * further, which is the same rule the board keeps structurally. A place that
 * matters enormously and suits this traveller poorly still loses.
 */
const SIGNIFICANCE_PULL = 0.1;

/**
 * The stop length at which a pick *is* the day rather than part of one.
 *
 * Two hours, and not a number chosen here: it is the same bar the compiler's
 * role assessment uses to separate `itinerary_anchor` from every kind below it,
 * and it is a property of the archetype rather than of any particular place —
 * what the table says a museum or a day hike takes. Stated in this package
 * because the dependency runs compiler → core and a pre-selection cannot import
 * one: `assessRoleEligibility`'s own `ANCHOR_MINUTES` is the same two hours for
 * the same reason, and a divergence between them would be one layer calling a
 * stop an anchor while the next declines to.
 *
 * The live record this bounds carried `typicalDurationMinutes` 240 and became
 * the sole activity of a day holding 42% of a trip's activity time.
 */
export const ANCHOR_SLOT_MINUTES = 120;

/**
 * Picks a balanced starting set so the traveller confirms a plan rather than
 * builds one. Fully deterministic: the same board and profile always produce the
 * same selection, which is what makes it testable and what keeps the "auto-pick"
 * button honest.
 *
 * Constraints applied, in order of precedence:
 *   - never select something unworkable or a weak fit
 *   - respect the per-interest frequency ceiling the traveller set
 *   - keep total driving inside a sane share of the trip's travel budget
 *   - allow at most one stop beyond the stated detour tolerance
 *   - hold roughly the famous/hidden balance they asked for
 *   - keep category variety so the trip is not six versions of one thing
 */
export function autoSelect(input: AutoSelectInput): AutoSelection {
  const { candidates, profile, tripDays } = input;
  const derived = profile.derived;
  const decided = input.decided ?? {};
  const transitUnmeasured = input.transitUnmeasured ?? false;

  // Arrival and departure days realistically hold about half a day each.
  const effectiveDays = Math.max(1, tripDays - 1);
  const targetCount = Math.max(1, Math.round(derived.activitySlotsPerDay * effectiveDays));

  /*
   * Stops the traveller has already put in the trip, counted on this board only.
   *
   * A stored choice about a place that is no longer a card occupies nothing —
   * the trip cannot go there — so counting it would shrink this pass over a
   * place nobody can visit.
   */
  const alreadyIncluded = candidates.filter(
    (candidate) => decided[candidate.place.id] === 'included',
  ).length;
  const slots = Math.max(0, targetCount - alreadyIncluded);

  const excluded: { placeId: string; reason: ExclusionReason }[] = [];
  const eligible = candidates.filter((candidate) => {
    /*
     * Their own answer first, ahead of every verdict of ours. A place the
     * traveller skipped is not excluded for being a weak fit — it is excluded
     * because they said no, and reporting our reason over theirs would be the
     * product explaining a decision it did not make.
     */
    if (decided[candidate.place.id] !== undefined) {
      excluded.push({ placeId: candidate.place.id, reason: 'already_decided' });
      return false;
    }
    if (candidate.fit.band === 'not_workable') {
      excluded.push({ placeId: candidate.place.id, reason: 'not_workable' });
      return false;
    }
    if (candidate.fit.band === 'weak') {
      excluded.push({ placeId: candidate.place.id, reason: 'weak_fit' });
      return false;
    }
    return true;
  });

  // Coarse travel budget, measured in one-way minutes summed across picks.
  // Stops that share a day share their travel, so this deliberately under-counts
  // rather than modelling round trips per stop — the routing phase will replace
  // it with a real travel-time matrix. Half the trip's total travel allowance
  // keeps the board from pre-selecting a week of long journeys without starving
  // the cheap stops fifteen minutes from town.
  //
  // TWO BUDGETS, because the traveller gave two answers. There was one, it was
  // the driving one, and it was drawn down only by stops whose *access rules*
  // named a car — so a car-free board had no travel accounting whatsoever and
  // auto-pick would happily pre-select six hour-long train journeys against a
  // budget of zero it never consulted.
  const driveBudget = Math.round(tripDays * profile.transport.maxDailyDriveMinutes * 0.5);
  const travelBudget = Math.round(tripDays * profile.transport.maxDailyTransportMinutes * 0.5);
  const maxPerCategory = Math.max(2, Math.ceil(targetCount / 3));
  const maxStretch = 1;
  const maxHidden = Math.ceil(targetCount * derived.hiddenGemTarget) + 1;
  const maxClassic = Math.ceil(targetCount * (1 - derived.hiddenGemTarget)) + 1;
  // A ceiling on classics is not the same as a floor on gems: without a reserved
  // quota, a hidden-gem-leaning traveller ends up with the same board as everyone
  // else, because interest and distance dominate the ordering. Hold back a share
  // of the slots for genuine gems and fill them from the top down.
  const minHidden = Math.floor(targetCount * derived.hiddenGemTarget * 0.7);

  const interestCounts = new Map<Interest, number>();
  const categoryCounts = new Map<PlaceCategory, number>();
  const selected: DiscoveryCandidate[] = [];
  const notes: string[] = [];
  let driveUsed = 0;
  let travelUsed = 0;
  let stretchUsed = 0;
  let hiddenUsed = 0;
  let classicUsed = 0;
  const skippedForFrequency = new Set<Interest>();
  /*
   * What the set already holds, along the axes a portfolio is balanced on.
   *
   * Separate from the counters above because those are *ceilings* — they say
   * when to stop — and these are *marginal value*: they say which of two
   * admissible candidates makes the better next pick. A board where every
   * constraint is slack still has a best answer, and before this the ordering
   * had no opinion about it.
   */
  const effortTaken = new Set<string>();
  const areasTaken = new Set<string>();
  const interestsTaken = new Set<Interest>();
  let poorWeatherHeld = 0;

  /*
   * The scale travel is judged against: the longest journey on this board.
   *
   * Relative rather than absolute, because "far" is a property of the
   * destination and not of a number. Twenty-five minutes is the far end of a
   * city board and the near end of an island one, and a fixed threshold would
   * make the penalty meaningless on one of them.
   */
  const longestJourney = eligible.reduce(
    (longest, candidate) =>
      candidate.detourClass === 'base' || candidate.travelMinutesFromBase === null
        ? longest
        : Math.max(longest, candidate.travelMinutesFromBase),
    0,
  );

  const byScore = [...eligible].sort(
    (a, b) => b.fit.score - a.fit.score || a.place.id.localeCompare(b.place.id),
  );

  /**
   * How much this candidate would add to the set *as it currently stands*.
   *
   * THE DEFECT THIS REPLACES. Selection took strictly the top N by fit score,
   * and fit score is a blunt instrument at the top of its range: on a live Tokyo
   * board a stop fifteen minutes' walk from the bed lost to six stops twenty-two
   * to twenty-eight minutes away by train, because all seven scored within noise
   * of one another and nothing else was consulted. The traveller got a
   * pre-selection that was six train rides and a monoculture — which is the
   * definition of ranking a list rather than composing a trip (§10.7).
   *
   * Three terms, and each answers a question the score cannot:
   *
   *   - **Travel burden.** An hour spent getting somewhere is an hour not spent
   *     anywhere, and it is the cost the traveller feels first.
   *   - **Marginal variety.** The fourth viewpoint is worth less than the first,
   *     whatever it scores. Category, effort, area and interest each earn a
   *     bonus only while the set is still missing them.
   *   - **Weather over these dates.** A stop the forecast is against is a worse
   *     pick than an equal one it is not, and one shelter is worth holding.
   *   - **Local significance.** Of two stops the scorer cannot separate, the one
   *     the place itself is known for is the better trip. Bounded — see
   *     `SIGNIFICANCE_PULL` — so it orders near-ties rather than overruling fit.
   *
   * Every term is small relative to the score itself: this reorders candidates
   * the scorer considers equivalent, and never promotes a poor fit over a good
   * one. Deterministic — no randomness, no clock — so the same board and profile
   * always produce the same set.
   */
  function marginalValue(candidate: DiscoveryCandidate): number {
    /*
     * Normalised to 0–1, because `FitAssessment.score` is 0–100 and every term
     * below is expressed as a fraction of a whole fit. Getting this wrong is
     * silent: on the raw scale a 0.06 variety bonus is six hundredths of a
     * point, so the portfolio terms would apply only to exact ties and the
     * function would read as balanced while behaving as top-N-by-score.
     */
    let value = candidate.fit.score / 100;

    const minutes = candidate.travelMinutesFromBase;
    if (candidate.detourClass !== 'base' && minutes !== null && longestJourney > 0) {
      value -= 0.15 * (minutes / longestJourney);
    } else if (candidate.detourClass !== 'base' && minutes === null) {
      /*
       * A journey nobody could time pays the *whole* travel penalty, which is
       * what the longest journey on this board pays.
       *
       * Otherwise the absence of a measurement is a discount: every timed
       * candidate is charged for its minutes and an untimed one is charged
       * nothing, so the greedy pass prefers exactly the stops it knows least
       * about. That is the shape a reviewer found at the top of a live board —
       * two cards nobody could route sitting above two the traveller could walk
       * to in twenty minutes.
       *
       * It is a cost, not a verdict. The card keeps its band, its label and its
       * place on the board; this only decides which of two admissible candidates
       * is the better next pick, and of those two it is the one we can actually
       * get them to.
       */
      value -= 0.15;
    }

    /*
     * The famous/quiet lean, as a preference rather than only as a quota.
     *
     * `minHidden` and `maxClassic` are ceilings and floors; they decide when a
     * set is unbalanced, not which of two admissible candidates is the better
     * next pick. On a board where the travel budget binds before either bound
     * does — a real trip, most of the time — a quota-only model produced the
     * *identical* selection for "mostly famous" and "deep cuts", because the two
     * profiles never reached the bound that distinguishes them. Centred on 0.5
     * so a traveller with no lean pays and receives nothing.
     */
    value +=
      (derived.hiddenGemTarget - 0.5) * 0.24 * (candidate.place.hiddenGemScore - 0.5) * 2;

    /*
     * How much the place matters here, on the same centred scale the board
     * orders by. Absent significance leans neither way — an authored region
     * carries none, and reading the absence as "this does not matter" would let
     * a field nobody filled in decide somebody's trip.
     */
    value += SIGNIFICANCE_PULL * (significanceLean(candidate.place) ?? 0);

    if (!categoryCounts.has(candidate.place.category)) value += 0.06;
    if (!effortTaken.has(candidate.place.physicalIntensity)) value += 0.04;
    if (!areasTaken.has(areaCellOf(candidate))) value += 0.05;
    const primary = candidate.fit.primaryInterest;
    if (primary && !interestsTaken.has(primary)) value += 0.03;

    if (candidate.weather.badges.includes('poor_in_the_forecast')) value -= 0.08;
    if (candidate.weather.badges.includes('poor_weather_friendly') && poorWeatherHeld === 0) {
      value += 0.05;
    }

    return value;
  }

  /**
   * One greedy pass over the admissible candidates, re-ranking after every take.
   *
   * Re-ranking is the whole mechanism: the bonus for an unused category is only
   * meaningful if it disappears the moment that category is used, and a sort
   * computed once cannot express that. The cost is quadratic in the board size,
   * which for forty candidates and fifteen slots is a few hundred comparisons.
   */
  function fill(relaxed: boolean): void {
    for (;;) {
      if (selected.length >= slots) return;
      const slotsLeft = slots - selected.length;
      const gemsStillNeeded = minHidden - hiddenUsed;

      let best: { candidate: DiscoveryCandidate; value: number } | null = null;
      for (const candidate of byScore) {
        if (selected.includes(candidate)) continue;
        // Once the remaining slots are exactly what the gem quota still needs,
        // stop spending them on anything else.
        if (!relaxed && gemsStillNeeded >= slotsLeft && !isHiddenGem(candidate)) continue;

        const check = canTake(candidate, {
          interestCounts,
          categoryCounts,
          driveUsed,
          driveBudget,
          travelUsed,
          travelBudget,
          maxPerCategory: relaxed ? maxPerCategory + 1 : maxPerCategory,
          stretchUsed,
          maxStretch,
          hiddenUsed,
          maxHidden: relaxed ? targetCount : maxHidden,
          classicUsed,
          maxClassic: relaxed ? targetCount : maxClassic,
          profile,
          transitUnmeasured,
          allowUnverifiedReach: relaxed,
        });
        if (!check.ok) {
          if (!relaxed && check.reason === 'frequency' && candidate.fit.primaryInterest) {
            skippedForFrequency.add(candidate.fit.primaryInterest);
          }
          continue;
        }

        const value = marginalValue(candidate);
        // `byScore` is already a total order, so the first candidate at a given
        // value wins and the result is stable without a second tiebreak here.
        if (!best || value > best.value) best = { candidate, value };
      }

      if (!best) return;
      take(best.candidate);
    }
  }

  /*
   * The traveller's own included stops occupy their room before either pass
   * runs — seeded from the same board-current candidates the slot count reads,
   * because a stored choice about a place that is no longer a card occupies
   * nothing, for the reason `alreadyIncluded` states. Room only: the
   * every axis of it, including the marginal-value sets — the fills then
   * continue from the state the pass would be in had it picked the stop
   * itself. See `occupyRoom`; the closing sentence still reports only what
   * this pass composed.
   */
  for (const candidate of candidates) {
    if (decided[candidate.place.id] === 'included') occupyRoom(candidate);
  }

  // Pass 1 — every constraint active.
  fill(false);
  // Pass 2 — fill any remaining slots, relaxing the balance targets but never
  // the traveller's own frequency ceilings or travel budget.
  fill(true);

  /*
   * The final verdict per eligible candidate, taken once, after both passes.
   * Re-running `canTake` against the *finished* counters is what makes the
   * reason honest: a candidate rejected in pass 1 for category saturation and
   * then taken in pass 2 is not excluded at all, and one that was fine on every
   * rule and simply arrived after the last slot is `no_slots` rather than a
   * constraint it never actually hit.
   */
  for (const candidate of byScore) {
    if (selected.includes(candidate)) continue;
    const check = canTake(candidate, {
      interestCounts,
      categoryCounts,
      driveUsed,
      driveBudget,
      travelUsed,
      travelBudget,
      maxPerCategory: maxPerCategory + 1,
      stretchUsed,
      maxStretch,
      hiddenUsed,
      maxHidden: targetCount,
      classicUsed,
      maxClassic: targetCount,
      profile,
      transitUnmeasured,
      allowUnverifiedReach: true,
    });
    excluded.push({
      placeId: candidate.place.id,
      reason: check.ok ? 'no_slots' : check.reason,
    });
  }

  /**
   * The room one stop occupies, charged identically whether this pass picked
   * it or the traveller did.
   *
   * Split out of `take` because the traveller's own included stops must draw
   * down every ceiling and budget the pass fills against — and they did not.
   * They consumed a *slot* (see `alreadyIncluded` above) and nothing else, so
   * while slots were the binding constraint the guarantee held by accident,
   * and the moment the shared frequency ledger became the binding constraint
   * a manual include stopped costing anything: auto-pick filled a whole
   * trip's worth of ledger room *beside* the stop the traveller had already
   * put in, and re-spent that stop's allowance on a substitute. An
   * instruction outranks a preference cap — a manual stop is never refused —
   * but it still occupies the room it takes.
   */
  function occupyRoom(candidate: DiscoveryCandidate) {
    for (const [interest, cost] of frequencyCost(candidate, input.profile)) {
      interestCounts.set(interest, (interestCounts.get(interest) ?? 0) + cost);
    }
    categoryCounts.set(
      candidate.place.category,
      (categoryCounts.get(candidate.place.category) ?? 0) + 1,
    );
    /*
     * Charged to the budget the mode actually spends, and to both where the mode
     * is a drive — an hour at the wheel is an hour of getting about as well as an
     * hour of driving. An unresolved journey draws down nothing: there is no
     * number, and inventing one to spend would be fake precision on the exact
     * axis this pass exists to remove.
     */
    const minutes = candidate.travelMinutesFromBase;
    if (minutes !== null && candidate.detourClass !== 'base') {
      /*
       * Base-area stops spend nothing. They are minutes from the bed by
       * definition, and charging them would let five strolls around town eat
       * the budget that exists to bound genuine journeys out.
       */
      travelUsed += minutes;
      if (drivesThere(candidate)) driveUsed += minutes;
    }
    if (candidate.detourClass === 'stretch') stretchUsed += 1;
    if (isHiddenGem(candidate)) hiddenUsed += 1;
    if (candidate.place.popularityScore >= 0.7) classicUsed += 1;
    /*
     * The marginal-value sets belong here too: they describe "the set as it
     * currently stands", and the traveller's own included museum makes a
     * second museum a worse next pick exactly as one this pass chose would.
     * Charging them here is also what makes the pass an extension of the
     * first one rather than a re-run beside it — with the traveller's stop
     * seeded, the fills continue from the same state the original pass was in
     * after taking it.
     */
    effortTaken.add(candidate.place.physicalIntensity);
    areasTaken.add(areaCellOf(candidate));
    if (candidate.fit.primaryInterest) interestsTaken.add(candidate.fit.primaryInterest);
    if (candidate.weather.badges.includes('poor_weather_friendly')) poorWeatherHeld += 1;
  }

  function take(candidate: DiscoveryCandidate) {
    selected.push(candidate);
    occupyRoom(candidate);
  }

  /*
   * WHAT IT DID, ALWAYS — not only when something went wrong.
   *
   * Every note here used to be conditional, so the common case produced an empty
   * list: a traveller pressed "choose for me", fifteen cards silently gained a
   * green border somewhere down a page thirty screens long, and the product said
   * nothing at all about what it had just decided on their behalf. §10.7 asks
   * for a selection that *feels* intelligent, and an unexplained one cannot.
   *
   * The sentence states the composition rather than the algorithm: how many, out
   * of how many days, across how many kinds of thing, and how much of it is
   * quiet finds. Those are the axes it actually balanced.
   */
  if (selected.length > 0) {
    /* Counted over what this pass picked — the counters above also hold the
     * traveller's own seeded stops, and this sentence is about ours. */
    const kinds = new Set(selected.map((candidate) => candidate.place.category)).size;
    const quiet = selected.filter(isHiddenGem).length;
    const parts = [
      `${selected.length} ${selected.length === 1 ? 'place' : 'places'} for your ${tripDays} days`,
      `${kinds} different ${kinds === 1 ? 'kind of thing' : 'kinds of thing'}`,
    ];
    if (quiet > 0) parts.push(`${quiet} of them quieter finds`);
    const areasPicked = new Set(selected.map(areaCellOf)).size;
    if (areasPicked > 1) parts.push(`spread over ${areasPicked} parts of the area`);
    notes.push(`We picked ${listOut(parts)}.`);
  } else if (slots === 0) {
    /*
     * Nothing was picked because there was nothing to pick *with*. Said plainly,
     * because the sentence below it would otherwise blame the destination for
     * the traveller's own full trip.
     */
    notes.push(
      `Your own choices already fill the ${targetCount} ${targetCount === 1 ? 'stop' : 'stops'} this trip has room for, so we have not added to them.`,
    );
  } else if (eligible.length === 0 && Object.keys(decided).length > 0) {
    notes.push(
      'You have already told us where you stand on everything here, so there was nothing left for us to choose between.',
    );
  } else {
    notes.push(
      'We could not pre-select anything here: everything on this board is either shut on your dates, past how far you will travel, or a journey nobody could verify.',
    );
  }

  /*
   * Only where something was actually picked. The two notes were independent
   * and both fired on an empty selection, so a board with nothing to pre-select
   * said "we could not pre-select anything" and then, underneath it, "we
   * pre-selected 0 rather than padding out to 18" — the same fact twice, the
   * second time in the compiler's arithmetic.
   */
  if (selected.length > 0 && slots - selected.length >= 2) {
    /*
     * Measured against the room this pass actually had, not against the trip's
     * whole capacity. Where the traveller has already included places by hand
     * the two differ, and "padding out to fifteen" over a trip that is already
     * nine tenths full is an invitation to overfill it.
     */
    notes.push(
      `We pre-selected ${selected.length} rather than padding out to ${slots}. Add more from the board if you want fuller days.`,
    );
  }
  const heldBack = [...skippedForFrequency].sort();
  if (heldBack.length > 0) {
    const named = heldBack.slice(0, 3).map((interest) => INTEREST_LABELS[interest].toLowerCase());
    const list =
      named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    notes.push(
      `There is more ${list} on the board — we stopped at the frequency you asked for rather than filling the trip with it.`,
    );
  }
  /*
   * A THIN PASS OWES THE ONE REFUSAL THE BOARD DOES NOT SHOW.
   *
   * The walk rule in `canTake` leaves no mark a traveller can see: the cards keep
   * their bands and their copy, which is the point of it being a pre-selection
   * rule. On a car-free board whose only instrument is a pedestrian one that is
   * most of the board, and the traveller is left looking at twenty-four places,
   * two ticks and no account of the gap between them. Only where the pass ran out
   * of admissible candidates rather than out of slots — with the trip filled, the
   * refusal cost them nothing worth a sentence.
   */
  const walkedPastAnswer = excluded.filter((entry) => entry.reason === 'walk_too_long').length;
  if (walkedPastAnswer > 0 && selected.length < slots) {
    const one = walkedPastAnswer === 1;
    notes.push(
      `We could not pre-select ${walkedPastAnswer} ${one ? 'place' : 'places'} here: the only journey anybody could time to ${one ? 'it' : 'them'} is a walk longer than you said you would go on foot. Tick ${one ? 'it' : 'them'} yourself if you would take that walk.`,
    );
  }
  /*
   * AND THE SAME DEBT FOR THE EVIDENCE REFUSAL, FOR THE SAME REASON.
   *
   * `standingWasEstablished` in `canTake` leaves no mark a traveller can see
   * either — the cards keep their bands and their copy — and on a destination
   * whose catalogue rows are thin it can be the difference between a full
   * pre-selection and a short one. Only where the pass ran out of admissible
   * candidates rather than out of slots: with the trip filled, the refusal cost
   * them nothing worth a sentence.
   */
  const unevidenced = excluded.filter(
    (entry) => entry.reason === 'standing_unestablished',
  ).length;
  if (unevidenced > 0 && selected.length < slots) {
    const one = unevidenced === 1;
    notes.push(
      `We left ${unevidenced} ${one ? 'place' : 'places'} out of the pre-selection: nothing beyond ${one ? 'its' : 'their'} name and position is published about ${one ? 'it' : 'them'}, which is not enough to build a day around. ${one ? 'It is' : 'They are'} still on the board if you want to add ${one ? 'it' : 'them'} yourself.`,
    );
  }
  if (stretchUsed > 0) {
    // "the extra drive" on a trip with no car was one of the board's plainer
    // untruths. The sentence is about distance, so it says distance.
    notes.push('One pick sits past your usual detour limit because it earned the extra journey.');
  }
  /*
   * WHAT PASS TWO TOOK ON TRUST, SAID BEFORE THE TRAVELLER FINDS OUT.
   *
   * The relaxation in `canTake` is the difference between a pre-selection and a
   * blank page on a destination nothing could route, and it is only defensible
   * while it is stated. A traveller who is handed twelve stops and later reads
   * "we have no travel data for the way in to this" on the plan has been told
   * twice, in the wrong order; a traveller told here can decide now.
   */
  const untimed = selected.filter(
    (candidate) => candidate.detourClass !== 'base' && candidate.reach.status !== 'measured',
  ).length;
  if (untimed > 0) {
    notes.push(
      untimed === selected.length
        ? 'Nothing here could time the way to any of these. They are picked for how well they suit you, not for how long they take to reach.'
        : `Nothing here could time the way to ${untimed} of these, so they are picked for how well they suit you rather than for how long they take to reach.`,
    );
  }

  return {
    selectedIds: selected.map((candidate) => candidate.place.id),
    targetCount,
    slots,
    notes,
    stats: {
      hiddenGemShare: selected.length > 0 ? hiddenUsed / selected.length : 0,
      totalTravelMinutesOneWay: travelUsed,
      totalDriveMinutesOneWay: driveUsed,
      byCategory: Object.fromEntries(categoryCounts) as Partial<Record<PlaceCategory, number>>,
    },
    excluded: excluded.sort((a, b) => a.placeId.localeCompare(b.placeId)),
  };
}

/** Same threshold the board uses to file something under hidden gems. */
function isHiddenGem(candidate: DiscoveryCandidate): boolean {
  return candidate.place.hiddenGemScore >= 0.6;
}

/**
 * A COARSE PATCH OF GROUND, SO "SPREAD OUT" MEANS SOMETHING.
 *
 * Geography is one of §10.7's balance axes and the selector had no notion of it
 * at all — six stops in one suburb and six stops across a city were the same set
 * as far as the ordering was concerned. There is no cluster structure on a
 * candidate to read, so this derives one the crudest defensible way: round the
 * coordinates to a cell and call two places in the same cell the same area.
 *
 * A fiftieth of a degree is roughly two kilometres north-south, which is about
 * the distance at which two stops stop being "the same afternoon". It is
 * deliberately coarse and deliberately not a claim: nothing downstream treats
 * this as a real region, it only decides which of two equally-scored candidates
 * adds more variety. A candidate with no coordinates falls back to its own id,
 * which makes it its own area — the honest reading of "we do not know where this
 * is", and never a claim that it sits beside something else.
 */
function areaCellOf(candidate: DiscoveryCandidate): string {
  const point = candidate.place.coordinates;
  if (!point) return candidate.place.id;
  return `${Math.round(point.lat * 50)}:${Math.round(point.lng * 50)}`;
}

/** "a, b and c" — a list a person would say, for a sentence read aloud. */
function listOut(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface TakeContext {
  interestCounts: Map<Interest, number>;
  categoryCounts: Map<PlaceCategory, number>;
  driveUsed: number;
  driveBudget: number;
  travelUsed: number;
  travelBudget: number;
  maxPerCategory: number;
  stretchUsed: number;
  maxStretch: number;
  hiddenUsed: number;
  maxHidden: number;
  classicUsed: number;
  maxClassic: number;
  profile: TravelerProfile;
  /** See `AutoSelectInput.transitUnmeasured`. Bounds the walking rule only. */
  transitUnmeasured: boolean;
  /**
   * Whether a stop nobody could time may be taken.
   *
   * False on the first pass and true on the second, which is what makes the
   * refusal a preference rather than a wall. See the note beside it in
   * `canTake`; a `conflict` is never admitted by either.
   */
  allowUnverifiedReach: boolean;
}

type TakeCheck = { ok: true } | { ok: false; reason: ExclusionReason };

/**
 * True when this candidate spends the traveller's own *driving* budget.
 *
 * Both halves are required and they answer different questions. The resolved
 * mode says the journey is made on a road; the access rules say who is at the
 * wheel. A gateway reached along that same road on a park shuttle is a road
 * journey nobody drives, and charging it to the driving cap would refuse a stop
 * over driving that does not happen.
 */
function drivesThere(candidate: DiscoveryCandidate): boolean {
  return (
    candidate.travelModeFromBase === 'drive' && candidate.access.requiredModes.includes('drive')
  );
}

/**
 * WHAT ONE STOP COSTS AGAINST THE TRAVELLER'S FREQUENCY CEILINGS.
 *
 * The shared definition in `scoring/frequency.ts`, read through one seam so the
 * pre-selection, the packer and the validator cannot come to different views of
 * "how many of these did you ask for". This function existed through two
 * generations of disagreement — a full unit of the fit assessment's primary
 * plus fractional secondaries, then a single unit of the primary alone — and
 * the §29 G evaluation caught what any one-interest-per-stop ledger permits:
 * five stops matching a four-cap interest, the fifth filed under a different
 * primary, admitted or not depending on nothing but candidate order. The
 * shared ledger charges every interest the traveller asked for that the stop
 * serves, in whole units, so no upstream ordering can overspend a ceiling.
 */
function frequencyCost(
  candidate: DiscoveryCandidate,
  profile: TravelerProfile,
): [Interest, number][] {
  return frequencyCostOf(candidate.place, profile);
}

function canTake(candidate: DiscoveryCandidate, ctx: TakeContext): TakeCheck {
  /*
   * AN ANCHOR SLOT REQUIRES CORROBORATING EVIDENCE.
   *
   * A pre-selected stop is not a suggestion. It is what the planner schedules,
   * what the day is built around and what the readiness verdict is computed
   * over — and on a live dense-metro compile that machinery handed a
   * **240-minute** block, 42% of the trip's whole activity time, to a record
   * whose description read "Nothing beyond its name and position is published
   * about it": notice never observed, no local standing of any kind, source
   * confidence 0.41. The compiler's own fields said the record was unsupported
   * and every stage downstream read them as permission, because none of them
   * asked.
   *
   * So this pass asks, through `nothingIsPublishedAboutIt` — the standing
   * model's own name for the population its compiled description already says
   * this about in so many words, so the sentence a traveller reads on the card
   * and the condition the pre-selection applies cannot come apart.
   * Deliberately not a threshold and deliberately not a count of recorded
   * attributes: a complete listing is metadata completeness, which is the one
   * thing this product refuses to read as significance, and the offending
   * record would have cleared such a bar anyway.
   *
   * It refuses a **pre-selection** and nothing else, exactly like the reach and
   * walking rules below: the card keeps its band, its seat on the board and its
   * own thin copy about what could not be established, and a traveller who
   * ticks it themselves gets it. An authored place carries no standing fields
   * and is exempt — curation is the evidence there — and so is a place stored
   * before the distinction existed. Unlike the reach rule this is not relaxed
   * on the second pass: a thinner trip is the honest outcome, and the notes say
   * so out loud.
   *
   * First in the list, ahead of the traveller's own ceilings, because the order
   * here decides which sentence they are shown. Every rule below is a fact
   * about *this trip* — a frequency ceiling met, a budget spent, a slot gone —
   * and reporting one of those over "nothing is published about this place"
   * would be the product explaining a permanent refusal with a temporary
   * reason.
   *
   * **And it is a condition on the anchor slot, not on the card and not on
   * every pick.** The refusal has to be as narrow as the claim: a stop that
   * cannot hold a morning is not the thing a day is built around, and refusing
   * every unevidenced short stop would empty the pre-selection of any
   * destination whose catalogue is thin — the blank page the reach rule below
   * already had to learn not to produce. `roleCanAnchor` in the pack schema
   * says the same thing from the other side: role eligibility is "eligibility,
   * not a promise… whether something can actually hold a morning depends on its
   * evidence", and this is that evidence arriving.
   */
  if (
    candidate.place.typicalDurationMinutes >= ANCHOR_SLOT_MINUTES &&
    nothingIsPublishedAboutIt(candidate.place)
  ) {
    return { ok: false, reason: 'standing_unestablished' };
  }
  for (const [interest, cost] of frequencyCost(candidate, ctx.profile)) {
    const cap = ctx.profile.derived.frequencyCaps[interest] ?? 0;
    if ((ctx.interestCounts.get(interest) ?? 0) + cost > cap) {
      return { ok: false, reason: 'frequency' };
    }
  }
  if ((ctx.categoryCounts.get(candidate.place.category) ?? 0) >= ctx.maxPerCategory) {
    return { ok: false, reason: 'category' };
  }
  /*
   * BOTH BUDGETS, AND THE SAME REACH TRUTH THE BOARD AND PLANNER USE.
   *
   * A drive spends the driving budget and the transport budget; anything else
   * spends only the second. `travelMinutesFromBase` is the resolved journey, so
   * a train is charged as a train — which is the whole of §7.
   */
  const minutes = candidate.travelMinutesFromBase;
  if (minutes !== null) {
    if (drivesThere(candidate) && ctx.driveUsed + minutes > ctx.driveBudget) {
      return { ok: false, reason: 'travel_budget' };
    }
    if (ctx.travelBudget > 0 && ctx.travelUsed + minutes > ctx.travelBudget) {
      return { ok: false, reason: 'travel_budget' };
    }
  }
  // Auto-pick must never propose something the traveller cannot legally reach on
  // any day of their trip. The board explains why; the pre-selection just leaves
  // it alone.
  if (candidate.access.status === 'blocked') {
    return { ok: false, reason: 'access' };
  }
  /*
   * A journey nobody could verify is not pre-selected *for* the traveller —
   * while there is anything better to spend a slot on.
   *
   * The two unresolved states are not the same refusal, and treating them alike
   * is what emptied a whole board. `conflict` — a provider was asked about this
   * ground and the only route it found is one this traveller may not use — is
   * the road-only candidate a non-driver must never be handed, and no amount of
   * slack makes it takeable. `unmeasured` is a gap in what anybody could time,
   * and the difference matters because a gap can cover *everything*.
   *
   * It did. A car-free metropolis whose walking network could not be routed gets
   * a road matrix by loud substitution, and then every pair on the board is a
   * road duration this traveller may not use and a walk too long to model — so
   * an unconditional refusal here returned **one pick out of twelve slots** over
   * a board of twenty-four real places. That is not the planner's refusal
   * arriving early; it is the product declining to do the thing the button says
   * it does, on the destination class it matters most for.
   *
   * So the refusal is a *preference*, spent in the order the two passes already
   * express: pass one fills the trip from journeys we can stand behind, and pass
   * two — which relaxes the balance targets and never the traveller's own
   * ceilings — will take a stop we could not time rather than leave the trip
   * empty. What that costs is honest and is said out loud in the notes; what it
   * buys is a portfolio the traveller can edit instead of a blank page.
   *
   * A place *at* the base is exempt in both passes, because there is no journey
   * to verify — `classifyDetour` returns `base` before it looks at reach for
   * exactly that reason, and requiring a measured leg here would empty the
   * pre-selection of a car-free town trip whose every stop is on the doorstep.
   */
  if (candidate.detourClass !== 'base' && candidate.reach.status !== 'measured') {
    if (candidate.reach.status === 'conflict' || !ctx.allowUnverifiedReach) {
      return { ok: false, reason: 'reach_unverified' };
    }
  }
  /*
   * TOO FAR IS NOT PRE-SELECTED, FOR ANY MODE.
   *
   * `too_far` now means "the round trip exceeds the budget for the mode that
   * would make it" — it is no longer a hard fit blocker for a non-driving
   * journey, so the card stays a card, keeps its band and can be added by hand.
   * But auto-pick proposing it would put the planner's refusal after the
   * traveller's approval: the scheduler applies the same caps and would drop
   * the stop with a reason on the finished plan, which is the Phase 9 shape —
   * a board that promises and a planner that takes it back.
   */
  if (candidate.detourClass === 'too_far') {
    return { ok: false, reason: 'travel_budget' };
  }
  /*
   * AND THE SAME POLICY FOR A WALK, WHICH THE DISTANCE CLASS CANNOT EXPRESS.
   *
   * Where no transit provider is configured, the compiled matrix measures
   * pedestrian journeys only, so a landmark ten minutes away on a metro arrives
   * here as a measured forty-minute walk. `classifyDetour` files that `unknown`
   * rather than `too_far` — correctly, because a walking figure standing in for
   * scheduled transport nobody could time is not this traveller's distance — so
   * the rule above never sees it, and the reach rule sees a measurement. Both
   * pass, and the pre-selection takes a seat the plan cannot lay:
   * `resolvePlannerLeg` refuses the identical leg, because a measured walk is
   * only laid within `DETOUR_STRETCH_MULTIPLIER` of the traveller's own walking
   * answer. Two live car-free dense-metro boards: twenty-four cards, five and
   * eight pre-selected, one and two scheduled, every refusal a measured walk of
   * thirty-nine to sixty-six minutes against a stated twenty-five.
   *
   * The bound is the planner's, read through the same helper, the same constant
   * and the same fact about whether a scheduled network went unmeasured here, so
   * the two verdicts about one journey cannot drift. Where it did, the bound was
   * the last-mile answer and the planner's was the ride budget, and the board
   * withheld seats the plan would have laid. It refuses a
   * *pre-selection* and nothing else, exactly like the rule above: the card keeps
   * its band, its place on the board and its honest copy about what could not be
   * verified, and a traveller who ticks it themselves gets the planner's own
   * sentence about the walk rather than a silent absence.
   *
   * A place at the base is exempt for the reason the rules above are — there is
   * no journey to verify.
   */
  if (
    candidate.detourClass !== 'base' &&
    candidate.reach.status === 'measured' &&
    candidate.reach.mode === 'walk' &&
    candidate.reach.travelMinutes >
      detourToleranceMinutesFor(ctx.profile, 'walk', {
        transitUnmeasured: ctx.transitUnmeasured,
      }) * DETOUR_STRETCH_MULTIPLIER
  ) {
    return { ok: false, reason: 'walk_too_long' };
  }
  if (candidate.detourClass === 'stretch' && ctx.stretchUsed >= ctx.maxStretch) {
    return { ok: false, reason: 'stretch' };
  }
  if (candidate.place.hiddenGemScore >= 0.6 && ctx.hiddenUsed >= ctx.maxHidden) {
    return { ok: false, reason: 'mix' };
  }
  if (candidate.place.popularityScore >= 0.7 && ctx.classicUsed >= ctx.maxClassic) {
    return { ok: false, reason: 'mix' };
  }
  return { ok: true };
}
