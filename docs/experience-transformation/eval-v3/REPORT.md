# Evaluation v3 — Geographic feasibility, defining experiences and journey structure

Protocol: `PROTOCOL.md` (frozen before results). Deviations: `DEVIATIONS.md`. Rubric: `blind/rubric.md` (the v2 rubric, unchanged). Requirements: `requirements-all.md`.

## Builds

| Name | Commit | What it is |
|---|---|---|
| previous | `71e587d` | the build this pass started from |
| new | `98ce484` | the v3 architecture as first finished (archetypes, pillars, route feasibility, trail stages, grammar fix) |
| fixed | `04de949` | `new` + the fixes its deterministic grades forced (DEVIATIONS 5) — **the build the judges compared** |
| post-fix | `2696db4`, `243d0b4` | fixes for defects the blind judges found; checked by unit tests and targeted live runs, not re-judged |

Seven scenarios (Kauai, Tanzania, Kumano Kodo, Iceland ring road, Kyrgyzstan, Scottish Highlands road trip, Tour du Mont Blanc trek), three full live passes per build, real providers (Anthropic, Nominatim, Google Places on staging's quota, openrouteservice, Overture, Wikidata) through staging's environment on local servers.

## Deterministic results (21 runs per build, `grade.py`)

| Measure | previous | new (98ce484) | fixed (04de949) |
|---|---|---|---|
| Defining-experience coverage | 68.4 % | 65.0 % | **72.6 %** |
| Hard failures (frozen definition) | 21 | 9 | **12** |
| Journey-consistency failures (hire car on a no-self-drive trip, trek without luggage) | 9 | 3 | **0** |
| Red flags from the requirements | 12 | 4 | 10 |
| Impossible legs (certified by measured legs) | 0 | 2 | 2 |
| Walking-pace rides printed as measured (post-hoc, DEVIATIONS 6) | 2 | 24 | **0** |
| Mean longest day of travel (min) | 310 | 408 | 371 |
| Mean total travel (min) | 1,164 | 1,473 | 1,214 |
| Days over the traveller's daily limit | 41 | 49 | 49 |

Per scenario (mean ± sd over three runs; coverage is out of the scenario's defining experiences):

| Scenario | coverage prev → fixed | hard prev → fixed | bases prev → fixed | longest day prev → fixed |
|---|---|---|---|---|
| Kauai | 4.3 → 5.0 /5 | 0 → 0 | 1.0 → 1.7 | 190 → 165 |
| Iceland | 4.0 → 4.0 /6 | 1.0 → 1.0 | 4 → 4 | 510 → 330 |
| Kumano Kodo | 4.0 → 4.0 /5 | 3.3 → 1.0 | 1 → 2 | 142 → 192 |
| Kyrgyzstan | 2.3 → 3.0 /6 | 0.3 → 1.0 | 1.7 → 2.7 | 318 → 1,040 |
| Highlands road trip | 4.7 → 4.0 /6 | 0 → 0.3 | 3.3 → 3.0 | 240 → 213 |
| TMB trek | 3.3 → 4.0 /6 | 1.7 → 0.3 | 1 → 4 | 218 → 197 |
| Tanzania | 4.0 → 4.3 /5 | 0.7 → 0.3 | 2.3 → 2.0 | 555 → 462 |

Variance: fixed has a lower sd than previous on longest day in Iceland, Tanzania and the Highlands; Kauai's total travel sd rose (one run with two north-shore out-and-backs).

**Caveat found by the judges:** the coverage grader matches names, so Tanzania's "Serengeti Balloon Safari" — placed at an office in Arusha — counted as the Serengeti. Tanzania's 4.3 overstates the fixed build; the blind result below is the truer reading.

## Blind comparison — previous vs fixed (three independent judges × three runs, 63 verdicts)

| Scenario | fixed | previous | tie | mean total prev → fixed (of 50) |
|---|---|---|---|---|
| Kauai | 6 | 3 | 0 | 30.9 → 33.0 |
| Iceland | 9 | 0 | 0 | 25.8 → 33.2 |
| Kumano Kodo | 9 | 0 | 0 | 25.7 → 30.3 |
| Kyrgyzstan | 3 | 6 | 0 | 18.9 → 18.4 |
| Highlands road trip | 7 | 1 | 1 | 31.7 → 36.1 |
| TMB trek | 9 | 0 | 0 | 17.6 → 22.3 |
| Tanzania | 0 | 8 | 1 | 26.9 → 23.3 |
| **All** | **43** | **18** | **2** | 19 of 21 pairs unanimous |

By dimension (mean of 63, prev → fixed): intent 2.44 → 3.08, defining 2.68 → 3.13, geography 2.29 → 2.57, transport 2.37 → 2.92, quality 2.78 → 3.13, lodging 2.44 → 2.94, safety/season 2.52 → 2.73, usefulness 2.14 → 2.44; **worse: timing 2.79 → 2.44, pace 2.87 → 2.73**.

## Deteriorations investigated

| Where | Cause | Status |
|---|---|---|
| Kyrgyzstan, Tanzania (new) | a car-free trip's foot matrix, now really measured, lent walking times to bus/transfer legs ("12 hr 45 min bus · 64 km") | fixed `04de949` |
| Tanzania (new) | "3 game drives" met by three stops around one crater | fixed `04de949` (distinct areas) |
| TMB (both) | "Tour du Mont Blanc trek" never read as a trail → urban single base | fixed `04de949` |
| Kyrgyzstan (fixed, judges) | the "Song-Kol Lake area" base geocoded to a café called Song-Kol in Bishkek | fixed `2696db4`; two live re-runs sleep at the real lake |
| Tanzania (fixed, judges 0–8) | "Serengeti Balloon Safari" at the operator's office in Arusha; the stay decision then dropped the Serengeti nights | fixed `243d0b4` (base-locality check); live re-check below |
| Kauai timing (fixed, judges) | the destination carried the US default zone (New York): sunset read as midnight, "sunset" visits at 22:30–23:00 | fixed `243d0b4` (zone must fit longitude) |
| Kumano, TMB (new and fixed) | invented trains between mountain villages (metro on a "local" trail scope; car-free moves used national rail facts) | fixed `243d0b4` |
| East Africa replay | the stricter foot-matrix rule cost an arrival evening its dinner | fixed `04de949` (dinner may run to 21:00 on a day without a hard end) |

## Post-judging live re-checks (not judged; `runs/postfix/`, `runs/final/`)

| Run | Result |
|---|---|
| Kyrgyzstan ×2 (`2696db4`) | both sleep at the real Song-Kol (no café base in Bishkek); no impossible day; longest move an honest ~7 h bus estimate |
| Tanzania #2 (`243d0b4`) | Karatu + central Serengeti bases, Ngorongoro floor, Manyara, Seronera drives; 4/5 defining, 0 hard |
| Tanzania #1 (`243d0b4`) | **degraded:** the scan measured 90 of 1,482 pairs (openrouteservice quota exhausted after a day of eval traffic), the planner found no feasible day assignment and fell back to model composition, which added a Zanzibar extension and left the Serengeti days empty |
| Kauai (`243d0b4`) | Princeville 5 + Poipu 2, 5/5 defining, 0 hard, no late "sunset" visits |
| Kumano (`243d0b4`) | invented trains gone (1 train leg vs 17–20 before; buses instead); **but this run kept one Yunomine base and did not follow the trail** (run-to-run variance in the trail decision) |
| TMB (`243d0b4`) | follows the trail Les Houches → Contamines → Chapieux, no trains; still flags the closed Croix du Bonhomme refuge and an over-long stage |

## Release verification

| Check | Result |
|---|---|
| Unit (`npm run test`) | 9,557 passed, 1 skipped, 0 failed |
| Typecheck | clean |
| Lint | 0 errors (150 pre-existing warnings) |
| Mobile browser suite (full) | first run 264 passed / 1 failed / 10 skipped — the failure was a real regression (journey archetype), fixed in `0ace6b9`; final run below |
| Desktop browser suite (full) | 271 passed / 2 failed / 2 skipped; both failures pass alone (load) |
| Tablet | 14 passed |
| Maps | 30 passed / 1 failed / 7 skipped; the failure passes alone (load) |
| Globe | 23 passed, 1 skipped |
| Today mode (fixture clock) | 4 passed |
| Journeys | 16 passed, 14 skipped |
| Staging propagation (deployed `04de949`) | `staging.spec.ts` live trips Tanzania, Iceland, Highlands: 3 passed (reload-stable plan, edit/undo/version restore, booking and map links, ICS with TZID, printed PDF, share); scenarios Kumano + TMB with both PDF formats: 2 passed |
| Slow transport/food tests | profiled and split earlier in this pass (`1eb07a4`): mobile timings 42–56 s → 13–27 s; no timeout raised |

The machine ran other projects' heavy jobs throughout (load 10–95); every browser failure was re-run alone.

**Final mobile run (`0ace6b9` build):** 264 passed, 1 failed, 10 skipped. The structural-refinement regression is fixed (it passes in the suite and alone). The one failure, `board-integrity.spec.ts` "hiding every place leaves an explanation and a way back", is **intermittent** (1 of 6 and 3 of 8 when repeated alone): if the background compile finishes during the test, the reload shows a newer board whose cards carry no hide marks. The test now waits for in-flight saves before reloading, but the timing dependency on the compile remains and is not fixed in this pass. The component and the action have not changed in this pass.

## Unresolved limitations

- **Straight-line fallbacks remain where no router answers.** Public openrouteservice refused the geocoded Applecross Pass point even at a 10 km snap, so every leg into it stays a labelled straight-line estimate ("≈50 min … estimated from map distance"), which across the Inner Sound is about an hour short. The triangle bound only helps when a measured pivot exists; direct checks now go first to such dark columns, but a point no router reaches stays an estimate.
- **TMB stage scheduling:** judges found stages starting at 11:00–11:15 and an over-long Col de la Seigne day (Chapieux–Courmayeur shown as ~42 km); no Swiss section in any run. The party limits and dusk margin are in place but the stage split for an over-long stage is not.
- **Days over the traveller's limit** did not improve (41 → 49); consolidation rarely changes results on real geometry.
- **A base placed far outside the trip** (Tanzania's "Tarangire area lodges" in Dar es Salaam) is not yet refused; it was not chosen, but it should be unplaced.
- **Move-day backtracks** (Kyrgyzstan run 3: Bishkek → Song-Kol → back to Osh Bazaar) are not detected across the move.
- **The coverage grader matches names** and can be fooled by a misplaced namesake; blind judging is the check on it.
- **Degraded routing still degrades badly.** When the router's quota is spent, the planner can find no feasible day assignment and the model-composition fallback takes over; it is not bound by the pillars or the stay decision (Tanzania re-check #1: Zanzibar added, Serengeti days empty). The fallback should be held to the same essentials, or the planner should accept estimated legs instead of giving up.
- **Trail-following varies run to run** (Kumano kept one base in one of four runs on the final build).
- **The timezone fix is a guard, not a lookup:** a destination whose only zone is a far country default now has an unknown sky (no sunset timing) rather than a wrong one, and the calendar export still carries that zone. A coordinate→zone lookup is the real fix.
- **A town keeps one base by its archetype.** Correctly stated now, but a town at the edge of a large region (Mammoth Lakes) never moves even when a second base would save real travel.
- **Highlands coverage** slipped (4.7 → 4.0): Eilean Donan and the Road to the Isles lose to essential pillars on move days in some runs.
