# Evaluation v2 — protocol (frozen 2026-11-12, before any v2 code change)

This file is written and committed **before** the planning-correctness changes, and is not edited after results are seen. Any deviation is recorded in `DEVIATIONS.md` with the reason, never by editing this file.

## What is compared

- **Old:** commit `ee57c8c` (the build judged "before" in v1).
- **New:** the head of `feat/trip-experience-release-pass` at the time of the run (commit recorded in each row).
- **Requirements:** `requirements.json` / `requirements.md`, researched independently from primary sources by an agent that never saw an itinerary or the code.

Both builds run locally side by side, each with its own database, started with the **same provider configuration as the staging environment** (same model, geocoder, router, POI and food providers), so the only difference is the code. Trips are created through the real UI by `e2e/staging/scenarios.spec.ts` ("Plan with smart defaults"), exactly as in v1.

## Runs

- The ten v1 scenarios, unchanged requests and dates.
- **3 independent runs per scenario per build** (60 trips). Each run is a fresh trip, so the discovery proposal is regenerated each time.
- A run that fails for a reason outside the app (the evaluator's network) is re-run and logged in `DEVIATIONS.md`; a run that fails inside the app counts as a failed run.

## Measures (decided now)

### A. Deterministic checks per run (no model involved), from the recorded page text and plan rows

1. **Defining experiences present** — for each `requirements.json` defining experience, whether any of its `anyOf` terms appears in a scheduled stop/meal/travel row. Reported as the share of runs that contain it.
2. **Red flags** — for each red flag, whether any `anyOf` phrase appears anywhere in the trip text (overview, days, bookings). Counted per run.
3. **Time-of-day violations** — a stop named sunset/sunrise/stargazing/night-sky scheduled more than 60 minutes from the researched local sunset/sunrise, or stargazing before civil dusk.
4. **Early starts** — any day starting before 06:30 on a scenario whose request asks for rest/easy days.
5. **Transport contradiction** — a rental car/hire car in bookings or overview for a scenario whose requirements forbid self-drive (stated "by train", operator safari).
6. **Travel burden** — longest day's travel minutes vs `maxDailyTravelMinutes`; total travel minutes.
7. **Structure** — number of bases and nights, empty ordinary days, one-stop days.
8. **Failure stage** — for a missing defining experience: was it on the Discovery Board (selection/scheduling failure) or not (discovery failure)?

### B. Independent judges (blind)

- Pairs (old vs new) built per run index, A/B randomised with a fixed seed, interface chrome and photo credits stripped (v1 `blind.py` rules).
- **Three separate judge agents**, each seeing only the rubric, `requirements.md` and the pairs — never the key, the metrics or which build is which. Rubric dimensions (1–5 each): trip-intent alignment; defining experiences; geographic coherence; transportation; realistic timing; activity quality; accommodation suitability; pace; safety and seasonal feasibility; overall practical usefulness.
- Reported per scenario: each judge's preference per run, mean and spread of totals; agreement between judges.

## What counts as "better"

The new build is better on a scenario only if, across its 3 runs, it has (a) no more red flags and no more hard-constraint violations than the old build, and (b) a higher defining-experience presence or a higher judge preference without (a) getting worse. Aggregates are reported, but the scenario table is the result.
