import { INTEREST_LABELS, type Interest, type PlaceCategory } from '../schemas/common';
import type { TravelerProfile } from '../schemas/profile';
import type { DiscoveryCandidate } from './board';

export interface AutoSelection {
  /** Place ids to pre-check, in board order. */
  selectedIds: string[];
  targetCount: number;
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
  /** Real, eligible, and there were no slots left. */
  'no_slots',
] as const;
export type ExclusionReason = (typeof AUTO_SELECT_EXCLUSIONS)[number];

export interface AutoSelectInput {
  candidates: DiscoveryCandidate[];
  profile: TravelerProfile;
  tripDays: number;
}

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

  // Arrival and departure days realistically hold about half a day each.
  const effectiveDays = Math.max(1, tripDays - 1);
  const targetCount = Math.max(1, Math.round(derived.activitySlotsPerDay * effectiveDays));

  const excluded: { placeId: string; reason: ExclusionReason }[] = [];
  const eligible = candidates.filter((candidate) => {
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
      if (selected.length >= targetCount) return;
      const slotsLeft = targetCount - selected.length;
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
    });
    excluded.push({
      placeId: candidate.place.id,
      reason: check.ok ? 'no_slots' : check.reason,
    });
  }

  function take(candidate: DiscoveryCandidate) {
    selected.push(candidate);
    for (const [interest, cost] of frequencyCost(candidate)) {
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
    effortTaken.add(candidate.place.physicalIntensity);
    areasTaken.add(areaCellOf(candidate));
    if (candidate.fit.primaryInterest) interestsTaken.add(candidate.fit.primaryInterest);
    if (candidate.weather.badges.includes('poor_weather_friendly')) poorWeatherHeld += 1;
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
    const kinds = categoryCounts.size;
    const quiet = hiddenUsed;
    const parts = [
      `${selected.length} ${selected.length === 1 ? 'place' : 'places'} for your ${tripDays} days`,
      `${kinds} different ${kinds === 1 ? 'kind of thing' : 'kinds of thing'}`,
    ];
    if (quiet > 0) parts.push(`${quiet} of them quieter finds`);
    if (areasTaken.size > 1) parts.push(`spread over ${areasTaken.size} parts of the area`);
    notes.push(`We picked ${listOut(parts)}.`);
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
  if (selected.length > 0 && targetCount - selected.length >= 2) {
    notes.push(
      `We pre-selected ${selected.length} rather than padding out to ${targetCount}. Add more from the board if you want fuller days.`,
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
  if (stretchUsed > 0) {
    // "the extra drive" on a trip with no car was one of the board's plainer
    // untruths. The sentence is about distance, so it says distance.
    notes.push('One pick sits past your usual detour limit because it earned the extra journey.');
  }

  return {
    selectedIds: selected.map((candidate) => candidate.place.id),
    targetCount,
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
 * One stop, one unit, charged to the one interest the traveller is there for.
 *
 * It used to charge the primary interest in full and every other interest the
 * place satisfied at a half, so that a lakeside hike drew down the hiking
 * allowance whole and the lake allowance partially. That reasoning is right
 * about the place and wrong about the ceiling. `frequencyCaps` is one number
 * read by three modules — this one refuses against it, the packer refuses
 * against it, the validator afterwards warns when a finished plan exceeded it —
 * and the other two count **stops**, one integer per place. Fractions are
 * arithmetic no other reader of the same number can reproduce: four lakeside
 * walks filled a two-stop lake allowance without one lake-led pick, and the
 * board then declined a genuine lake against a ceiling that, counted the way
 * the plan counts it, was empty. The traveller reads the refusal in the notes
 * and finds nothing on their board that explains it. §9.3's ceiling is a number
 * of stops, so this spends stops.
 *
 * The interest charged is `fit.primaryInterest` — the one the traveller is
 * actually there for, and the same field the board's own frequency tests and
 * "we stopped at the frequency you asked for" note already key on — falling
 * back to the place's leading interest where the scorer named none.
 *
 * The planner and validator currently key on `place.interests[0]` instead.
 * That is the same interest on every place whose leading category the traveller
 * cares about, and the wrong one where they do not: a lake the traveller is
 * lukewarm about but which is also the region's best hike is charged to lakes
 * there and to hiking here. Closing that needs the planner's half, which is not
 * this module's to change; it is recorded as a handoff, and this is the
 * definition both sides should end up holding.
 */
function frequencyCost(candidate: DiscoveryCandidate): [Interest, number][] {
  const interest = candidate.fit.primaryInterest ?? candidate.place.interests[0];
  return interest === undefined ? [] : [[interest, 1]];
}

function canTake(candidate: DiscoveryCandidate, ctx: TakeContext): TakeCheck {
  for (const [interest, cost] of frequencyCost(candidate)) {
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
   * A journey nobody could verify is not pre-selected *for* the traveller.
   *
   * Both unresolved states, and for the same reason rather than two. `conflict`
   * — the only measured route is one this traveller may not use — is the
   * road-only candidate a non-driver must never be handed. `unmeasured` is a
   * gap in what anybody could time. Neither is a duration auto-pick can fit into
   * a day, and pre-checking a stop we cannot time puts the planner's refusal
   * *after* the traveller's approval, which is the order that wastes their time.
   *
   * It stays on the board, keeps its score, its badges and its access notes, and
   * can be added by hand. This is a statement about what we will decide on
   * somebody's behalf, not a verdict on the place.
   *
   * A place *at* the base is exempt, because there is no journey to verify —
   * `classifyDetour` returns `base` before it looks at reach for exactly that
   * reason, and requiring a measured leg here would empty the pre-selection of a
   * car-free town trip whose every stop is on the doorstep.
   */
  if (candidate.detourClass !== 'base' && candidate.reach.status !== 'measured') {
    return { ok: false, reason: 'reach_unverified' };
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
