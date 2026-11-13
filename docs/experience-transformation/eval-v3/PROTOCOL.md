# Evaluation v3 — protocol (frozen 2026-11-13, before any v3 code change)

Not edited after results are seen; deviations go to `DEVIATIONS.md`.

## Compared

- **Previous:** commit `71e587d` (the v2 final build).
- **New:** the head of `feat/trip-experience-release-pass` when run (commit recorded per row).
- Both run locally side by side, each with its own database, with staging's provider configuration (model, geocoder, router, POI, food), builds one at a time to avoid geocoder throttling, servers supervised (v2 deviations 1, 3, 5).

## Scenarios (3 independent runs each per build)

The five v2 scenarios the brief names, unchanged: `beach-island` (Kauai), `tanzania-safari`, `kumano-kodo`, `iceland-ring-road`, `kyrgyzstan`; plus two new: `mountain-road-trip` ("Scottish Highlands road trip", 6–13 June 2027, couple) and `point-to-point-trek` ("Tour du Mont Blanc trek", 10–19 July 2027, friends). Requirements: v2 `requirements.json` unchanged for the five; `requirements-new.json`, researched independently before any v3 result, for the two.

## Measures (decided now)

Deterministic, from the recorded page and plan rows:

1. **Impossible transport legs** — a leg whose stated minutes are below the travel-time lower bound implied by two verified legs to a common point (triangle inequality), or a drive between points the router reported disconnected, or a rail leg in a country/trip where the requirements flag rail as non-existent.
2. **Repeated backtracking** — the number of distinct days whose stops fall in the same distant zone (> 60 minutes from the base) beyond the first.
3. **Defining-experience coverage** — share of `requirements` defining experiences present (as v2), with failure stage (discovery/selection).
4. **Hotel-base suitability** — number of bases and whether bases follow the requirements' recommended structure (stays at stage ends for a trek; at least one base near each defining region for multi-region trips).
5. **Journey-structure consistency** — the plan's stated structure (bases, moves, transport) matches one archetype end to end (no rental car on an operator or transit trip; no day-hike-by-car pattern on a point-to-point trek).
6. **Daily feasibility** — days whose travel exceeds `maxDailyTravelMinutes`; red flags; sky-timing and early-start violations (v2 checks).
7. **Total travel burden** — total and longest-day travel minutes.
8. **Variance** — min/max/sd of each across the three runs.

Blind: pairs (previous run *i* vs new run *i*), A/B randomised (seed 20261115), chrome stripped (v1 rules), **the v2 rubric unchanged** (`../eval-v2/blind/rubric.md`), three separate judges, requirements visible to judges, key never visible.
