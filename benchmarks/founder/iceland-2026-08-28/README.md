# Founder Benchmark — Iceland — 2026-08-28

## Purpose

This folder preserves a founder product comparison between:

1. a simple frontier-LLM response to a minimal travel-planning request; and
2. the Sidequest product output generated for a comparable Iceland trip.

This benchmark exists because the founder judged the simple LLM result to be substantially better as a travel plan despite Sidequest requiring much more user input, computation, product flow, and implementation complexity.

The benchmark is intended to guide the Baseline-First Hybrid Planner architecture.

## Benchmark request

The original simple request was:

> Plan me a 12 day comprehensive itinerary for July in Iceland. Plan what you think is right for me.

See `request.md`.

## Artifacts

### `chatgpt-baseline.md`

Machine-readable copy of the baseline frontier-LLM itinerary.

Claude Code should normally read this file instead of the PDF to minimize context and parsing cost.

### `chatgpt-baseline.pdf`

Immutable human-facing snapshot of the same baseline result.

Use primarily for visual/manual comparison.

### `sidequest-current.pdf`

Immutable snapshot of the Sidequest founder-test output produced before the Phase 17 architectural pivot.

### `founder-notes.md`

The founder's qualitative assessment of the comparison and the product lessons that should be preserved during implementation.

## What this benchmark demonstrates

The baseline LLM was substantially stronger at:

- holistic trip composition;
- determining the appropriate country-scale route;
- regional coverage;
- destination-specific judgment;
- choosing major attractions;
- including less-obvious worthwhile experiences;
- allocating twelve days effectively;
- balancing difficult and easier days;
- explaining deliberate omissions;
- creating a complete useful trip immediately;
- minimizing required user interaction;
- reaching useful output quickly.

The current Sidequest result demonstrated stronger machinery around structured constraints, provenance, routing evidence, uncertainty, and deterministic verification, but that machinery did not compensate for the much weaker trip itself.

The desired Sidequest architecture should combine both strengths.

## Critical benchmark rule

THIS IS AN EVALUATION ARTIFACT, NOT A GOLDEN ITINERARY.

Production code must never:

- hardcode Iceland places from this benchmark;
- reproduce the baseline route by name;
- add destination-specific exceptions merely to improve this comparison;
- read this benchmark at runtime;
- use benchmark attraction names as production ranking hints;
- tune Iceland-specific thresholds to obtain a benchmark win.

The benchmark represents a class of planning-quality failure.

Phase 17 must fix that class of failure generically.

## Target product principle

Sidequest should start from at least the holistic planning quality of a capable frontier travel-planning model and then improve the result through:

- structured traveler preferences;
- persistent personalization;
- place identity and enrichment;
- measured routing;
- access and schedule evidence;
- weather and daylight intelligence;
- deterministic feasibility;
- hard-constraint enforcement;
- transparent uncertainty;
- specialized editing and discovery interfaces.

The model composes the trip.

Sidequest verifies, personalizes, corrects, optimizes, and presents it.

## Success criterion

The Phase 17 Iceland result does not need to match the baseline itinerary.

It should, however, be competitive or better on:

- trip structure;
- regional intelligence;
- major-attraction recall;
- interesting lesser-known experiences;
- itinerary completeness;
- daily pacing;
- purposeful free time;
- destination-specific judgment.

It should be materially stronger on:

- personalization;
- measured logistics;
- hard-constraint compliance;
- practical verification;
- explicit uncertainty;
- correction stability;
- editability.

If Sidequest again requires substantially more effort and time while producing a trip the founder would much rather replace with the simple LLM result, the architectural experiment has failed.