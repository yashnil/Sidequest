# Planner audit: structure-planner vs. the TTDP / TOPTW literature

Scope: `apps/web/src/lib/planning/structure-planner.ts` (`planStructure`), its caller `planner-composer.ts#composeWithPlanner`, `planner-autopick.ts`, and base selection in `packages/core/src/scan/assemble.ts#chooseScanBases`. No source was modified.

## 1. What the literature says, and what fits a Node server

**Problem class.** Sidequest's build is a Tourist Trip Design Problem (TTDP). The standard model is the **Team Orienteering Problem with Time Windows (TOPTW)**: each place has a score, a visit duration and an opening window; there are *m* routes (one per day) with a time budget *T_max*. The goal is to maximise the total score collected, visiting each place at most once (Vansteenwegen et al. 2009; formulation as restated in Buijs 2015). Surveys (Gavalas et al. 2014; Ruiz-Meza & Montoya-Torres 2022) find the orienteering family is the dominant TTDP model. The useful extensions are:
- the multi-constraint TOPTW, which adds budget and category caps (Garcia et al. 2010; Souffriau et al. 2013, with multiple time windows);
- hotel selection, the OPHS.

**ILS (Vansteenwegen, Souffriau, Vanden Berghe, Van Oudheusden 2009).** This was built for a mobile tourist guide that needs an answer in seconds, and was described as the fastest published TOPTW method. It has two steps:
- *Insertion.* For each unvisited place, find its cheapest feasible position, then insert the place with the best `ratio = score² / TimeInsertion`. Feasibility is O(1) per position because each visit records `Wait` and `MaxShift`/`MaxDelay`. An insertion of `j` between `i` and `k` is feasible iff `c_ij + Wait_j + T_j + c_jk − c_ik ≤ Wait_k + MaxShift_k`.
- *Shake.* Remove `R` consecutive visits from each route, starting at position `S`. Then advance `S` and grow `R` when nothing improves, and reset both when something does. It stops after a fixed number of iterations without improvement.

The shake is **deterministic**, so no RNG is needed. Gunawan, Lau, Vansteenwegen & Lu (2017) tuned a hybrid of ILS and simulated annealing and improved 50 best-known values. Labadie et al. (2012) report a granular VNS. GRASP variants randomise the insertion choice among the top-k ratios, which is not wanted here.

**Prize-collecting routing in OR-Tools.** OR-Tools gives each node a disjunction with a penalty: skipping the node costs its penalty, so the solver trades travel against prizes. Penalties larger than the total distance mean "drop only when forced". It also has a time dimension with slack for windows, and multiple vehicles (here, days). This maps cleanly onto Sidequest: penalty = experience value, vehicle = day, time dimension = the day window, capacity dimension = stop count.

**JS availability.** OR-Tools officially ships C++, Python, Java and C# bindings only.
- `mapbox/node-or-tools` is a native addon with prebuilt binaries for long-gone Node LTS releases, and has open "missing binaries" issues. It is effectively unmaintained.
- `@revolugo/ortools` wraps only the MIP classes, not routing.
- A community `or-tools-wasm` exists, but its routing coverage, size and maintenance are unverified.

Spawning a Python sidecar breaks the "pure function, renders call no provider" rules and the cold-start budget. **Conclusion:** at 10–60 candidates, 1–14 days and a budget of about 100 ms–2 s, a hand-written TS ILS is the realistic choice. The literature solves Solomon-style 100-node instances in well under a second with exactly this structure. The instance here is smaller, and the current exhaustive per-day tour (≤7 stops) is already the expensive part.

## 2. Weaknesses in the current planner

The planner is careful about *explainability* (a reason for every drop) and *constraints*. It is weak as an *optimiser*: it is a one-pass, priority-ordered greedy with no improvement phase and no stated objective.

**W1. Greedy construction with no improvement phase (`structure-planner.ts:401-453`).** Candidates are placed in fixed `plannerPriority` order (`:166-168`, `:401`), and each one goes to the best day *at that moment* (`place`, `:341-379`). Nothing ever moves after that:
- There is no relocate, swap or inter-day exchange, and no remove-and-reinsert.
- The only "undo" is in the thin-day filler (`:446-451`).

Order-dependent outcomes follow directly:
- *Day-trip capture.* A day trip may only go to an empty day (`soloDayTrip` requires `day.stops.length === 0`, `:305`). Once higher-priority stops have spread across every day, a high-fit day trip is dropped as `too_far`, even though moving two nearby stops onto one day would have freed a day.
- *First-placed stop seeds the cluster.* The coherence rule (`:326-329`, 50-minute hop) is measured against whatever landed first, so an early low-value seed can lock a day into the wrong district.
- *Strenuous adjacency is first come, first served.* An earlier strenuous stop on day 3 blocks days 2 and 4 (`:300`), even when swapping two strenuous stops would fit both.

**W2. No objective function, so "better" is undefined (`:356-365`, `:166`, `:172`).** Day choice minimises a local mix, `marginal travel + 40·load + 25·zone + weather` (`:361`). Selection is a sort on `status + fit + significance`. Nothing sums the value of the trip, so:
- *Count stands in for value.* `FILL_TARGET` (`:172`) fills days to a fraction of capacity with anything that has fit ≥ 60, whatever its marginal value per minute. A 240-minute stop with fit 61 is taken as readily as a 45-minute stop with fit 90. The literature's `score²/time` ratio exists to prevent exactly this.
- *Diversity is binary.* Frequency caps (`:404-413`) are hard counts with no diminishing returns, so the third museum is worth the same as the first until it hits the cap.
- *Base choice ignores the traveller.* `chooseScanBases` values a base by `tier weight × duration` of the scan proposal (`assemble.ts:294-306`). This runs at scan assembly, before the board. `composeWithPlanner` then takes `region.basePortfolio` as fixed (`planner-composer.ts:109-117`). The traveller's picks never move a base or its nights. An OPHS-style question ("would one more night at base B collect more of what they ticked?") is never asked.

**W3. Time is a minutes sum, not a schedule (`:331-337`, `:493-532`).**
- Capacity is `activity + tour travel + duration ≤ capacityMinutes`. There are no arrival times inside the day and no opening windows, only whole-day `closedDates` (`:292`). A 10:00–16:00 site can be ordered for 17:00 and only verification will notice.
- Lunch is a fixed 60-minute deduction if the window spans 13:00 (`:256`). The planner never schedules it. It is attached afterwards to whichever stop crosses 12:30 (`:518-531`).
- The "morning soft" rule is a post-hoc reorder with a 30-minute tolerance (`:497-511`), not part of the routing decision.
- The food-area proximity branch (`:527`) is dead code: `planner-composer.ts:215` strips coordinates, and `ScanProposalExtras.foodAreas` has none.

**Smaller issues.**
- *Unknown treated as far.* An unmeasured pair counts as **999 minutes** in the coherence check (`:327`). That makes an unknown leg a reason to keep a stop off a day, which conflicts with the "unknown ≠ false" rule. Meanwhile `tourMinutes` uses 60 (`:189`), and a null `fromBase` skips the reach check entirely (`:306`). Three different unknown policies sit in one function.
- *Pinned stops placed out of order.* Pinned stops are `must` (`planner-composer.ts:125`) but are placed in fit order with the other musts. A non-pinned must placed first can fill the pinned day and turn the lock into a `mustConflict` (`:291`, `:336`). Pinned stops should be placed first.
- *Repeated full re-solves.* `feasibility` re-solves the full day tour twice per (candidate × day) probe (`:332-333`). That is O(n·d·7!) worst case before any improvement phase, and it needs memoising before ILS multiplies the probe count.
- *No planner regression trips.* The Ireland and Iceland replays exercise model-composed drafts, not `planStructure`. Only `structure-planner.test.ts`, `product-flow.test.ts` and `operational-flow.test.ts` call the planner, so the planner has no golden-trip regression of its own.

## 3. Recommended change: a deterministic ILS improvement phase

Keep construction exactly as it is. It produces the explanations, and it is a good ILS seed. Add `improveStructure(input, plan): StructurePlan` between step 3b and step 4 (`:481` → `:489`), behind a `SIDEQUEST_PLANNER_IMPROVE` switch in `providers/switches.ts` that defaults on in fixtures first.

### 3.1 Objective (explicit, lexicographic)

```
Z = ( mustsPlaced, pinnedHeld,                            // tier 1: never traded
      Σ_days Σ_stops value(c, k_c) − weatherPenalty(c, day)
      − α·travelMinutes − β·zoneSwitches − γ·imbalance )  // tier 2
value(c, k) = (plannerPriority(c) − STATUS_BONUS[status]) · (status==='candidate' ? 1 : 1.15)
              · ρ^(k−1)                                   // k = rank of c among same primaryInterest; ρ≈0.75
imbalance  = Σ_nonEdgeDays (load_d − mean load)²          // keeps days even, prevents one 95% day + one 30% day
```

Suggested starting weights: α = 0.15 points per minute (one fit point ≈ 7 minutes of driving), β = 4, γ = 20. Calibrate them on the benchmark below. The hard `frequencyCaps` stay hard. ρ adds diminishing returns *below* the cap. A cap of 0 is still exclusion.

### 3.2 Constraints: one oracle, reused

Refactor `feasibility()` into a whole-day validator, `checkDay(day, stopIds, index, days) → ok | {reason, detail}`. Every move must pass it, so the ILS can never produce a day that construction would have refused. It honours, exactly as today:
- pace stop count (`maxStopsPerDay` with extras, `:331`) and `capacityMinutes` (`:336`);
- `maxDailyTravelMinutes`, including evening round trips (`:316`, `:337`; the drive ceiling is already folded in at `planner-composer.ts:226`);
- reach and day-trip rules (`:303-307`) and the 50-minute coherence rule (`:326`);
- strenuous spacing (`:297-301`) and `closedDates`;
- `pinnedDay`, which is never moved: a pinned stop is fixed to its day;
- hard slots: one sunrise and one evening per day, sunrise not on day 1 or a relocation day, and no evening on the last day (`:308-317`). Only `sunrise`/`sunset`/`night` are hard; `morning`/`afternoon` stay soft, per V10.

Must-dos are never removed by a move. Shake may remove them, but repair must re-place them before the solution is accepted. Otherwise tier 1 drops and the solution is rejected.

### 3.3 Operators (cheap first)

1. **Insert.** For each unscheduled plannable candidate, try every day. Use `score²/Δcost`, with Δcost = Δtravel + duration (the Vansteenwegen ratio), and take the best.
2. **Relocate (inter-day).** Move one non-pinned stop to another day when ΔZ > 0. This is the move that frees a day for a day trip (W1).
3. **Swap (inter-day).** Exchange two stops on different days. This fixes strenuous adjacency and cluster seeding.
4. **Replace.** Swap a scheduled non-must for an unscheduled candidate on the same day when the value gain is greater than the cost change (the "replace" move of Labadie and Gunawan).
5. **Intra-day order.** Keep `tourMinutes` (exact for ≤7 stops), but memoise it by `baseId + sorted ids`. Use 2-opt/Or-opt only above 7 stops.
6. **Shake (deterministic, Vansteenwegen).** For each non-edge day, remove `R` consecutive non-pinned, non-must daytime stops starting at position `S mod len`. On no improvement, set `S += R` and `R += 1`, wrapping `R` at the largest day length. On improvement, set `R = 1`.

### 3.4 Pseudocode

```ts
function improveStructure(input, seed: StructurePlan, budget = { maxIter: 200, maxNoImprove: 40 }): StructurePlan {
  let cur = clonePlan(seed), best = cur, bestZ = objective(input, best);
  let S = 0, R = 1, noImprove = 0;
  for (let it = 0; it < budget.maxIter && noImprove < budget.maxNoImprove; it++) {
    cur = localSearch(input, cur);                // insert → relocate → swap → replace until no ΔZ>0, first-improvement in id order
    const z = objective(input, cur);
    if (lexGreater(z, bestZ)) { best = clonePlan(cur); bestZ = z; R = 1; noImprove = 0; }
    else { S += R; R = R + 1 > maxDayLen(cur) ? 1 : R + 1; noImprove++; }
    cur = shake(clonePlan(best), S, R);           // deterministic; pinned + must never removed
  }
  return reexplain(input, seed, best);            // recompute dropped/weatherMoves/mustConflicts with the existing reason logic
}
```

**Determinism.** No RNG is needed. If a perturbation is ever added, seed it with mulberry32 from a hash of the sorted candidate ids. Iterate candidates and days in a fixed id order. **Bound the search by iteration count, never by wall clock.** A time-boxed loop gives different trips on a loaded Railway container than on a laptop, which breaks "same board → same structure". Keep a wall-clock guard only as a logged safety cap.

**Explanations.** `reexplain` re-runs the existing drop-reason code against the final plan. A candidate the ILS left out gets the reason `checkDay` gives for its best day, or `capacity` with "a better use of that day was …". This keeps "a reason for every drop" intact.

**Autopick.** `plannerAutoPick` gets the improvement for free, because it calls `composeWithPlanner` (`planner-autopick.ts:42`). Board picks still equal plan picks.

### 3.5 Phase 2 (separate PR): real time windows

Add `openWindow?: {startMinute, endMinute}` per date to `PlannerCandidate`, filled only from published hours: unknown hours mean no window, never closed. Inside `checkDay`, replace the minutes-sum capacity with a forward schedule carrying `Wait`/`MaxShift`. Schedule lunch as a pseudo-stop with a window of [12:00, 14:00] and 60 minutes. Then the morning preference becomes a soft window penalty in Z rather than a post-hoc reorder. Phase 3 is OPHS-style base nights: re-run `chooseScanBases`' night split with board-weighted value, and let the ILS evaluate ±1 night per base.

## 4. Proving it is better

**Planner benchmark (new).** `planning/acceptance/planner-bench.test.ts` serialises `StructurePlannerInput` from fixture regions: Iceland, Ireland, a car-free city, a multi-base road trip and a day-trip-heavy board. Store `minutes` as a matrix. Run greedy and greedy+ILS on each and report per trip:
- Z and its parts: value, travel, zone switches, imbalance;
- fit-weighted coverage (Σ fit of scheduled ÷ Σ fit of the top-N plannable);
- must and pinned coverage;
- high-fit drops (fit ≥ 70 dropped for `capacity`/`too_far`);
- empty non-edge days;
- max and mean daily travel;
- runtime p50/p95, which belongs in `npm run test:perf`, never in `npm run test`.

**Invariant tests (property-style, in `structure-planner.test.ts`).**
- ILS Z ≥ greedy Z on every fixture (best-so-far acceptance makes this a guarantee).
- Every final day passes `checkDay`.
- No must or pinned stop is lost or moved off its day.
- No sunrise/evening stop on a forbidden day; no strenuous stops back to back at slow or balanced pace.
- Every non-scheduled plannable candidate has exactly one drop reason.
- Byte-identical output across two runs, and under a shuffled `candidates` array.

**Targeted regressions for W1.**
- A board with 4 days, 6 nearby stops and one high-fit day trip: greedy drops the day trip, ILS places it.
- Two strenuous hikes that greedy blocks by adjacency: ILS swaps them into a legal spacing.
- A low-fit early seed that pulls a day to the wrong district.

**End to end.** `npx vitest run apps/web/src/lib/planning` must stay green. The Ireland replay matrix must stay all zeros. Downstream `quality-audit`/`quality-compiler` warnings must not increase: count them on each fixture before and after. A live golden-trip run (`playwright.v1-live.config.ts`) must then be read from the DB, per the V1 notes.

## Sources

- Vansteenwegen, Souffriau, Vanden Berghe, Van Oudheusden, "Iterated local search for the team orienteering problem with time windows", *Computers & OR* 36(12):3281–3290, 2009. Re-implementation with Wait/MaxDelay and ratio formulas: [Buijs 2015, EUR thesis](https://thesis.eur.nl/pub/30280/Buijs.pdf); also [Sluijk, EUR thesis](https://thesis.eur.nl/pub/34303/Sluijk.pdf)
- Vansteenwegen et al., "Metaheuristics for tourist trip planning" (2009 chapter): [EconPapers](https://econpapers.repec.org/bookchap/sprlnechp/978-3-642-00939-6_5f2.htm)
- Gunawan, Lau, Vansteenwegen, Lu, "Well-tuned algorithms for the TOPTW", *JORS* 2017: [SMU InK](https://ink.library.smu.edu.sg/sis_research/3685)
- Labadie, Mansini, Melechovský, Wolfler Calvo, "The TOPTW: an LP-based granular VNS", *EJOR* 220(1), 2012: [IDEAS](https://ideas.repec.org/a/eee/ejores/v220y2012i1p15-27.html)
- Souffriau et al., "The multiconstraint TOP with multiple time windows", *Transportation Science* 47(1), 2013: [IDEAS](https://ideas.repec.org/a/inm/ortrsc/v47y2013i1p53-63.html)
- Gavalas et al., "A survey on algorithmic approaches for solving tourist trip design problems", *J. Heuristics* 20, 2014: [OpenAlex](https://api.openalex.org/works/doi:10.1007%2FS10732-014-9242-5)
- Ruiz-Meza & Montoya-Torres, "A systematic literature review for the TTDP", *OR Perspectives* 2022: [DOAJ](https://doaj.org/article/0a77a455f7294612b5d4aa7f2aa6cf53)
- Ant colony system for TOPTW (recent comparison baseline): [arXiv 2305.07305](https://arxiv.org/pdf/2305.07305)
- OR-Tools penalties and dropping visits: [developers.google.com/optimization/routing/penalties](https://developers.google.com/optimization/routing/penalties); language support: [google/or-tools](https://github.com/google/or-tools)
- JS options: [mapbox/node-or-tools](https://github.com/mapbox/node-or-tools) (native addon, stale binaries), [@revolugo/ortools](https://npmjs.com/package/@revolugo/ortools) (MIP only), or-tools-wasm ([Show HN write-up](https://feedbagel.com/post/show-hn-solving-complex-optimization-problems-with-google-or-tools-in-browser); routing coverage unverified)
