# Phase 13 Goal — Sidequest vs. Fast API-Assisted Claude Planner

## Purpose

Build an internal, blind, side-by-side benchmark that tests whether the current Sidequest planning architecture provides enough additional user value to justify its complexity and latency when compared with a strong, much simpler API-assisted Claude planner.

Do not assume Sidequest wins.

The alternative must reflect the founder's realistic workflow:

1. A traveler completes a detailed questionnaire.
2. The system performs a quick preliminary destination scan.
3. It asks a small number of destination-aware follow-up questions.
4. Claude receives the comprehensive traveler profile plus structured place, route, hours, weather, daylight, food, and access context.
5. Claude creates a complete structured itinerary.
6. Neutral deterministic validators inspect the itinerary.
7. At most one bounded repair call fixes critical or major errors.
8. The result should normally arrive close to one minute under ordinary warm conditions.

The benchmark must let the founder compare both plans blindly through one neutral UI, submit ratings and corrections, and reveal the system identities only afterward.

This is an experimental product surface under `/labs/benchmark`. Do not alter normal Sidequest behavior merely to improve its benchmark result.

## Branch and starting-state requirements

Work only when all of the following are true:

- Phase 12 has been committed and merged by the user.
- The current branch is `phase-13-sidequest-vs-ai-baseline` or another explicit Phase 13 benchmark branch.
- The working tree does not contain uncommitted Phase 12 implementation.
- `.claude-private/implementation/phase-13-handoff.md` exists and describes the stable production contracts.

At startup inspect:

- current branch and HEAD
- `git status --short`
- `git diff --check`
- recent git history
- `.claude-private/PROGRESS.md`
- `.claude-private/implementation/phase-13-handoff.md`
- traveler-profile schemas
- destination resolution and autocomplete
- Help Me Decide
- candidate portfolios
- provisional and final boards
- routing, hours, access, weather, food, daylight, and planner validation
- Anthropic provider boundaries and provider switches
- cost and timing repositories
- live-evaluation harnesses
- migrations and historical fixtures
- Playwright projects and `testMatch`

If the branch or merge prerequisites are not satisfied, stop and report the exact mismatch. Do not modify Phase 12 or combine the phases.

## Non-negotiable constraints

- Do not commit, push, merge, deploy, or modify secrets.
- Do not read, print, echo, serialize, or modify `apps/web/.env.local`.
- Do not enable live providers by default.
- All automated tests remain offline.
- Do not add destination-specific benchmark logic.
- Do not let either system see the other system's native output.
- Do not tune either system after seeing a case without creating a new benchmark version.
- Do not manufacture subjective reviewer ratings.
- Do not claim a winner from automated validators alone.
- Do not claim statistical significance from a small pilot.
- Failed and partial plans remain benchmark results.
- No page render may initiate a planning or model operation.
- Original plan outputs are immutable.
- Operational timing and cost remain separate from semantic plan artifacts.
- The Claude baseline must be genuinely competitive, not a straw man.
- The baseline must not reuse Sidequest's deterministic scheduler, candidate-selection engine, route-clustering optimizer, or automatic itinerary-revision engine.
- Sidequest must run through its normal production pipeline without benchmark-specific quality changes.

## Completion definition

Phase 13 implementation is ready for founder evaluation only when:

1. A neutral shared trip-request contract exists.
2. Current Sidequest can run unchanged through a benchmark adapter.
3. A strong API-assisted Claude planner exists with strict structured output.
4. The Claude planner uses no more than:
   - one optional bounded preliminary synthesis call,
   - one primary itinerary-generation call,
   - one bounded repair call.
5. Both outputs convert to one neutral benchmark-plan schema without erasing failures or unknowns.
6. The same neutral validators inspect both systems.
7. `/labs/benchmark` supports creation, execution, blind review, correction rounds, identity reveal, and results.
8. System identity, architecture, latency, and cost remain hidden until the initial review is locked.
9. Benchmark sessions, assignments, plans, metrics, reviews, and correction versions persist immutably.
10. A reviewer can run at least one complete blind comparison locally.
11. At least two bounded live pilot pairs are generated when a benchmark budget is explicitly supplied:
    - one straightforward city/transit case,
    - one broad, island, outdoor, or weak-data case.
12. No subjective winner is invented when the founder has not reviewed the plans.
13. Unit, integration, migration, architecture, accessibility, and performance tests pass.
14. `npm run verify` passes.
15. Three consecutive complete Playwright runs pass at:
    - 1440 × 900 desktop,
    - 1024 × 768 tablet,
    - 390 × 844 mobile,
    with no executed source or test changes between runs.
16. Final reviews contain no open high- or medium-severity correctness, fairness, security, or experimental-integrity findings.
17. A concise founder test guide explains exactly how to run and rate the pilot.

## Required private documents

Create:

- `.claude-private/benchmark/phase-13-acceptance.md`
- `.claude-private/benchmark/phase-13-plan.md`
- `.claude-private/benchmark/decision-rules.md`
- `.claude-private/benchmark/prompt-contract.md`
- `.claude-private/benchmark/founder-test-guide.md`
- `.claude-private/benchmark/results.md`

Update:

- `.claude-private/PROGRESS.md`

Write the decision rules before inspecting live pair results.

## Orchestration

Begin with eight read-only agents in parallel.

### Agent A — Sidequest benchmark adapter

Determine how to:

- create and run an ordinary Sidequest trip,
- observe its normal persisted milestones,
- preserve its native artifacts,
- convert the final or partial result to the neutral benchmark schema,
- measure time to provisional value, final board, itinerary, cost, evidence, and failure state,
- keep production behavior unchanged.

Return exact files, contracts, risks, and tests.

### Agent B — Strong fast-Claude planner

Design the strongest realistic Claude-led baseline under the call and latency budgets.

Define:

- preliminary scan,
- high-value follow-up questions,
- candidate and route packet,
- strict generation schema,
- validation and one repair boundary,
- prompt-injection defense,
- unknown handling,
- timing and cost accounting.

Return exact files, prompt structure, contracts, risks, and tests.

### Agent C — Shared questionnaire and information parity

Audit the existing traveler profile and define a shared request that gives both systems equivalent confirmed information.

Identify:

- initial questions,
- destination-aware follow-up questions,
- answer transfer,
- concepts representable in both systems,
- question-burden measurement,
- fairness risks when one system asks more questions.

### Agent D — Neutral validation

Design system-independent checks for:

- dates and partial arrival/departure days,
- route continuity,
- impossible jumps,
- bases and transfers,
- daily travel tolerance,
- hours and seasonal access,
- daylight,
- meals,
- activity density,
- free time,
- duplicate places,
- must-dos and hard avoidances,
- supported mobility constraints,
- unsupported factual claims,
- unsupported exact numbers,
- internal contradictions,
- evidence insufficiency.

Absence of evidence is lower verifiability or unknown, not automatically an error.

### Agent E — Blind methodology and decision rules

Design:

- randomized A/B assignment,
- randomized display order,
- label leakage prevention,
- review locking,
- ordering-bias capture,
- human ratings,
- correction burden,
- pre-registered decision rules,
- pilot versus meaningful-sample labeling.

### Agent F — Benchmark product UX

Design the internal routes and neutral renderer.

Prevent visual or textual clues that reveal:

- Sidequest,
- Claude,
- model names,
- Discovery Board terminology,
- deterministic versus AI architecture,
- native stage names.

Cover desktop, tablet, mobile, keyboard, focus, reduced motion, and screen-reader labels.

### Agent G — Persistence, concurrency, and security

Design:

- immutable sessions,
- run identities,
- neutral plans,
- assignments,
- reviews,
- identity reveal,
- correction versions,
- atomic start and correction claims,
- model-call single flight,
- stale-write protection,
- failure retention,
- migration compatibility,
- cross-system and cross-session isolation.

### Agent H — Performance, cost, and test strategy

Define:

- equivalent timing boundaries,
- time to first useful result,
- time to first itinerary,
- time to validated plan,
- model calls and token spend,
- provider calls,
- cache behavior,
- failed-run accounting,
- offline fixtures,
- live budget enforcement,
- final Playwright stability.

Each initial agent returns:

- findings,
- proposed contracts,
- exact file map,
- risks,
- prohibited shortcuts,
- tests,
- unresolved questions.

Initial agents do not edit files.

The main agent synthesizes one implementation plan, assigns non-overlapping ownership, and exclusively owns:

- shared schemas and barrels,
- migration ordering,
- central benchmark orchestration,
- assignment and blinding,
- neutral metric calculation,
- budget enforcement,
- final integration,
- final acceptance decisions.

## 1. Shared traveler request

Create a versioned `BenchmarkTripRequest` with at least:

- destination or destination mode,
- destination identity,
- dates or flexible-date mode,
- duration,
- origin,
- arrival and departure timing,
- adults and children,
- explicitly supplied mobility constraints,
- explicitly supplied dietary requirements,
- budget band,
- accommodation preference,
- desired base count,
- hotel-change tolerance,
- transportation preference,
- public-transit preference,
- driving tolerance,
- total daily travel tolerance,
- pace,
- activity intensity,
- desired free time,
- interests,
- must-do experiences,
- dislikes,
- hard avoidances,
- crowd tolerance,
- food importance,
- nightlife importance,
- indoor/outdoor balance,
- weather preferences,
- heat, cold, rain, and snow tolerance,
- early-morning tolerance,
- reservation tolerance,
- guided-tour preference,
- traveler free text,
- schema version.

Both systems receive the same initial request.

The fast-Claude planner may perform preliminary research and ask approximately two to six high-value follow-up questions.

Sidequest may use its normal adaptive questionnaire.

Before final planning, make equivalent confirmed answers available to both systems when the concept is representable in both.

Persist:

- every question,
- which system requested it,
- why it was asked,
- every answer,
- answer timestamps,
- total question count,
- time spent answering,
- information transferred between systems.

Do not let one system win because it silently received more traveler information.

## 2. Fast preliminary scan

The Claude baseline performs a fast, bounded scan that identifies information likely to change the trip:

- geographic scale,
- candidate clusters,
- likely bases,
- transfer realities,
- route-time constraints,
- seasonal access,
- climate or forecast semantics,
- daylight,
- likely transport mode,
- core attraction categories,
- food availability,
- closures or booking constraints,
- feasibility risks,
- important unknowns.

Use structured sources first.

Use at most one bounded synthesis/extraction model call only when deterministic data cannot produce useful follow-up questions.

The scan returns:

- destination interpretation,
- likely scope,
- likely trip structure,
- important known constraints,
- explicit unknowns,
- proposed follow-up questions,
- source references,
- observed latency and cost.

Follow-up questions must change a planning decision. Do not ask generic questions already answered in the shared request.

## 3. Strong Claude planner

Implement this baseline flow:

`shared request → destination identity → preliminary scan → targeted follow-ups → normalized research packet → one structured generation call → neutral validation → zero or one bounded repair call → final or partial plan`

The baseline may use stable Sidequest provider boundaries for:

- destination identity,
- lawful open place inventory,
- geocoding,
- measured routes,
- hours and access,
- weather within supported forecast horizons,
- climate outside forecast horizons,
- daylight,
- food candidates,
- source-backed research,
- image identity for the neutral renderer.

It may not use:

- Sidequest's deterministic candidate-selection engine,
- Sidequest's deterministic itinerary scheduler,
- Sidequest's route-clustering optimizer,
- Sidequest's automatic revision engine,
- Sidequest's final itinerary or board as context,
- destination-specific handcrafted plans.

Claude is responsible for:

- choosing from the supplied candidate packet,
- synthesizing discovery,
- proposing bases,
- composing the day-by-day schedule,
- placing meals and free time,
- selecting alternatives,
- explaining traveler fit,
- returning strict structured output.

Deterministic code is responsible for:

- collecting and normalizing source data,
- calculating route times,
- neutral validation,
- producing a bounded repair packet,
- persistence,
- cost and timing.

## 4. Model-call and latency contract

Maximum per benchmark trip:

- zero or one preliminary synthesis call,
- one primary itinerary-generation call,
- zero or one repair call,
- maximum three model calls,
- one repair attempt maximum.

Targets:

- useful preliminary summary under 10 seconds warm,
- follow-up questions under 15 seconds warm,
- first complete itinerary under 45 seconds warm,
- validated or repaired result under 60 seconds warm,
- cold result under 90 seconds under ordinary provider behavior.

These are measurement targets, not permission to invent facts or conceal partial results.

If the repaired result still has critical errors:

- return partial or failed,
- preserve valid components,
- expose unresolved failures,
- do not loop.

Use durable single-flight operation identities that include:

- session,
- request version,
- normalized input hash,
- prompt version,
- schema version,
- model identity,
- locale,
- operation type.

Record model calls, input/output tokens, latency, cost, failure, and repair state even when the call fails.

## 5. Versioned generation prompt and schema

Write the production prompt contract to:

`.claude-private/benchmark/prompt-contract.md`

Create a strict structured-output schema.

The generation call receives only:

- confirmed traveler profile,
- confirmed follow-up answers,
- destination identity and scope,
- dates and partial-day constraints,
- bounded candidate packet,
- possible bases,
- measured route packet,
- hours and access packet,
- weather/climate/daylight packet,
- food packet,
- explicit unknowns,
- planning constraints,
- source-reference identifiers,
- output schema.

The model returns:

- trip summary,
- destination scope,
- proposed bases,
- transfer structure,
- day-by-day itinerary,
- ordered activities,
- meals,
- free-time blocks,
- measured or explicitly unknown travel segments,
- opening/access assumptions,
- weather-sensitive alternatives,
- preparation notes,
- exclusions,
- unresolved unknowns,
- concise traveler-fit explanations.

Each day includes:

- date,
- active base,
- start/end assumptions,
- ordered items,
- approximate start/end times,
- stable location identities,
- activity roles,
- travel from previous item,
- source-backed constraints used,
- meal placement,
- free time,
- daily travel total,
- uncertainty flags.

The model must not invent unsupported:

- exact opening hours,
- exact route times,
- current closure status,
- admission prices,
- reservation requirements,
- forecast weather beyond provider horizon,
- dietary safety,
- accessibility,
- visas or border eligibility,
- airfare,
- lodging prices,
- current safety.

Unknowns remain unknown.

Do not persist or expose hidden chain-of-thought.

Persist prompt version, schema version, model identity, input hash, output hash, tokens, latency, cost, and validation result.

## 6. Sidequest adapter

Run Sidequest through its current production path:

`traveler intent → destination resolution → profile → scope → regional expansion → discovery → verification → deterministic planning → validation/revision → itinerary`

The benchmark adapter may:

- create an ordinary trip,
- provide the equivalent confirmed traveler answers,
- start the normal persisted job,
- observe milestones,
- preserve native outputs,
- convert final or partial artifacts to the neutral schema,
- collect operational metrics.

It may not:

- change Sidequest scoring,
- inject handcrafted candidates,
- bypass readiness gates,
- manually repair the itinerary,
- expose the competing plan,
- grant Sidequest information unavailable to the baseline.

Add architecture tests proving benchmark code cannot alter production ranking or planning contracts.

## 7. Neutral benchmark plan

Create a versioned `BenchmarkPlan` independent of both native formats.

Represent:

- plan identity,
- hidden producing-system reference,
- request version,
- destination and scope,
- dates,
- bases,
- days,
- ordered stops,
- meals,
- transfers,
- travel segments,
- opening/access assumptions,
- free time,
- alternatives,
- preparation,
- evidence references,
- unknowns,
- exclusions,
- warnings,
- generation state,
- validation state.

Keep operational metrics separate:

- time to first useful result,
- time to follow-up questions,
- time to first itinerary,
- time to validated plan,
- total wall time,
- model calls,
- tokens,
- model cost,
- source calls,
- route calls/pairs,
- weather calls,
- cache hits/misses,
- retries,
- repair calls,
- database growth.

Unavailable metrics remain null with a reason; never serialize them as zero.

System-specific diagnostics remain separate and hidden before identity reveal.

## 8. Neutral validators

Run the same validators against both neutral plans.

Validate:

- every date in range,
- arrival/departure partial days,
- geographic continuity,
- route-time availability,
- impossible jumps,
- base consistency,
- transfer days,
- daily travel tolerance,
- traveler driving limits,
- activity overlap,
- missing travel segments,
- activity-duration plausibility,
- opening-window conflicts,
- seasonal-access conflicts,
- daylight where relevant,
- meal coverage,
- food placement relative to route,
- excessive density,
- insufficient free time,
- duplicate candidates,
- ignored must-dos,
- hard-avoidance violations,
- supported mobility conflicts,
- unsupported factual claims,
- unsupported exact values,
- empty days,
- empty successful plans,
- internal contradictions.

Classify findings:

- critical,
- major,
- minor,
- informational,
- unknown due to insufficient evidence.

Unknown is not an error.

When one system lacks evidence needed for a check, report lower verifiability rather than automatically marking it wrong.

Add neutrality tests using structurally equivalent plans from both systems and prove identical findings.

## 9. Blind benchmark experience

Build internal-only routes:

- `/labs/benchmark`
- `/labs/benchmark/new`
- `/labs/benchmark/[sessionId]/run`
- `/labs/benchmark/[sessionId]/review`
- `/labs/benchmark/[sessionId]/results`

Do not add these routes to the normal customer journey.

Session flow:

1. Collect the shared request.
2. Run both systems independently.
3. Randomly assign the plans to A and B.
4. Randomize which plan appears first.
5. Persist assignment and order.
6. Render both through one neutral UI.
7. Hide producing system, architecture, model, latency, and cost.
8. Collect and lock the initial review.
9. Reveal system identity.
10. Display objective validation, latency, cost, and native diagnostics afterward.

Prevent leakage through:

- terminology,
- typography,
- card structure,
- evidence labels,
- loading copy,
- error copy,
- URLs,
- HTML metadata,
- accessibility labels,
- analytics events,
- hidden attributes,
- serialized page data.

Before reveal, do not show:

- Sidequest,
- Claude,
- Anthropic,
- model names,
- Discovery Board,
- deterministic,
- AI-generated,
- system-specific stages.

A failure or partial plan must still render neutrally and remain reviewable.

## 10. Human review

Collect blind 1–7 ratings for:

- overall quality,
- likelihood of taking the trip,
- personal fit,
- discovery quality,
- excitement,
- pacing,
- logistical realism,
- food placement,
- transportation realism,
- clarity,
- trust,
- flexibility,
- alternatives,
- handling of unknowns,
- effort required to fix.

Collect forced choices:

- Which trip would you book?
- Which understands you better?
- Which feels more realistic?
- Which has more interesting discoveries?
- Which requires fewer changes?
- Which do you trust more?

Options:

- Plan A,
- Plan B,
- Tie,
- Cannot judge.

Require a short explanation for the overall choice.

Lock the initial review before identity, latency, or cost reveal.

After reveal ask:

- Does the slower plan justify the wait?
- Would you wait this long for the better plan?
- Which product would you use for a real trip?
- Would you pay more for either result?

Do not create automated answers to these subjective questions.

## 11. Correction-burden experiment

After initial review, allow the reviewer to submit the same natural-language correction to both plans.

Examples:

- make it less rushed,
- reduce driving,
- add food near the hike,
- replace touristy places,
- add more free time,
- include my must-do,
- remove something I dislike,
- improve the rainy-day plan,
- reduce hotel changes,
- make the first day realistic.

Sidequest correction:

- use existing structured controls and deterministic recomputation where supported,
- do not add a benchmark-only chat scheduler.

Claude baseline correction:

- use one bounded structured revision call with the original plan, correction, relevant source packet, and validator findings.

Persist immutable correction versions linked to the originals.

Measure:

- correction rounds,
- time,
- cost,
- whether old constraints regress,
- whether new major errors appear,
- final satisfaction,
- abandonment.

Maximum three correction rounds per system per session.

Prevent stale correction results from overwriting newer versions.

## 12. Pre-registered decision rules

Before inspecting live pair results, write `.claude-private/benchmark/decision-rules.md`.

Primary metric:

- blind forced-choice preference.

Secondary metrics:

- critical and major errors,
- correction rounds,
- personal fit,
- likelihood of taking the trip,
- trust,
- time to first useful result,
- total latency,
- total cost,
- failure rate,
- evidence coverage.

Initial directional thresholds:

Sidequest clearly justifies its complexity when it:

- wins at least 65% of non-tied blind comparisons,
- reduces critical/major errors by at least 50%,
- reduces correction burden by at least 30%,
- materially improves personal fit or trust,
- provides useful provisional value early enough for users to tolerate final latency.

The fast Claude planner is favored when it:

- remains within roughly 10% of Sidequest on preference and correctness,
- is materially faster and cheaper,
- requires no more meaningful corrections,
- produces plans users are equally willing to take.

A hybrid direction is favored when:

- Claude leads discovery, excitement, speed, or initial composition,
- Sidequest leads routing, feasibility, trust, or correction stability,
- Claude composition plus deterministic validation appears likely to outperform both.

These thresholds may be refined only before live results are inspected.

Do not declare a winner from the implementation smoke test or from one reviewer.

## 13. Persistence and experimental integrity

Persist:

- benchmark session,
- benchmark version,
- case version,
- shared request,
- question/answer history,
- Sidequest run identity,
- Claude run identity,
- immutable native outputs,
- immutable neutral plans,
- randomized assignment,
- display order,
- validation results,
- correction versions,
- reviewer ratings,
- reviewer notes,
- review-lock timestamp,
- identity-reveal timestamp,
- latency and cost,
- provider/model/prompt/schema versions,
- final session state.

Protect against:

- duplicate session starts,
- concurrent planning stampedes,
- cross-system output access,
- cross-session leakage,
- assignment tampering,
- refresh-based identity reveal,
- review edits after lock,
- repeated submission,
- unbounded correction calls,
- stale correction overwrite,
- malformed model JSON,
- NaN or Infinity metrics,
- missing spend records,
- provider diagnostics entering plan prose,
- hidden system labels in model output,
- prompt injection in traveler free text,
- unsupported claims disguised as notes,
- destination-specific benchmark behavior,
- omitted failed runs.

A failure remains visible and affects benchmark metrics.

No render path may call a provider or model.

## 14. Benchmark case library

Create a versioned offline case library with at least 16 materially different profiles:

1. dense city,
2. public-transit city,
3. food-focused weekend,
4. nightlife-focused short trip,
5. broad 10–12 day country trip,
6. multi-base road trip,
7. national park,
8. remote outdoor region,
9. island,
10. archipelago or ferry trip,
11. family trip,
12. low-driving traveler,
13. slow-paced traveler,
14. explicitly mobility-constrained traveler,
15. shoulder-season weather-sensitive trip,
16. weak-data destination.

Include a geographic mix such as:

- New York City,
- Bali,
- Kyrgyzstan,
- Iceland or Slovenia,
- one national park,
- one East Asian city,
- one Latin American destination,
- one small island,
- one weak-data destination.

Destination names may exist in benchmark fixtures, but no production behavior may branch on them.

Do not commit sensitive personal profiles.

## 15. Offline test matrix

All automated tests remain offline.

Create fixtures for:

- valid Sidequest plan,
- valid fast-Claude plan,
- invalid Claude plan repaired successfully,
- invalid Claude plan still failing,
- Sidequest partial result,
- Claude partial result,
- one-system failure,
- both-system failure,
- A-left assignment,
- B-left assignment,
- review lock,
- identity reveal,
- correction round,
- ordering-bias record,
- unsupported exact claim,
- route conflict,
- hours conflict,
- excessive travel,
- missing meal,
- ignored hard avoidance,
- unknown evidence,
- tie review,
- concurrent benchmark start,
- concurrent correction,
- provider outage,
- model outage,
- Sidequest warm reuse,
- Claude prompt-version change,
- absent metric with reason,
- prompt-injection traveler text,
- hidden identity string in model output.

Add unit, integration, migration, architecture, accessibility, performance, and Playwright tests proving:

- both systems receive equivalent confirmed inputs,
- neither can access the other native output,
- Sidequest production behavior is unchanged,
- the baseline does not call Sidequest's forbidden planner modules,
- labels remain hidden before reveal,
- display order is randomized and persisted,
- ratings lock before reveal,
- identity reveal is irreversible,
- neutral validators treat equivalent plans identically,
- preliminary synthesis is bounded,
- itinerary generation is one call,
- repair is at most one call,
- corrections are bounded,
- failed systems remain reviewable,
- spend and latency are recorded for failures,
- null never becomes zero,
- no provider runs during render,
- no destination-specific benchmark rule exists,
- existing production routes remain unchanged.

## 16. Live pilot and budget

Do not run paid benchmark operations unless the command environment explicitly includes:

`SIDEQUEST_BENCHMARK_BUDGET_USD`

When absent, complete all implementation and offline verification, generate an offline demonstration session, and report that live pilot generation was intentionally skipped.

Do not modify `.env.local`.

Check only credential presence; never print values.

Use command-level provider switches.

The first live pilot should be bounded to at least two paired runs when budget allows:

### Pair 1 — straightforward city or transit trip

Prefer New York City or another well-covered transit city.

Measure:

- questions,
- time to first useful value,
- time to first itinerary,
- time to validated result,
- plan state,
- validation findings,
- cost,
- evidence coverage.

### Pair 2 — broad, island, outdoor, or weak-data trip

Prefer Bali, Kyrgyzstan, Iceland/Slovenia, a national park, or a weak-data destination.

Measure the same fields.

Generate both plans and persist the blind session.

Do not submit subjective ratings on the founder's behalf.

Stop before the configured budget ceiling.

Any prompt, schema, or algorithm change after inspecting a live result creates a new benchmark version. Preserve prior results.

## 17. Founder test guide

Create `.claude-private/benchmark/founder-test-guide.md` with concise instructions for the founder to:

1. start the app on port 4200,
2. open `/labs/benchmark`,
3. create or select a pilot session,
4. complete shared questions,
5. wait for both systems,
6. review Plan A and Plan B without revealing identities,
7. submit ratings,
8. apply one or more identical corrections,
9. lock the review,
10. reveal identities, latency, cost, and validation,
11. interpret the result without overgeneralizing.

Explain what is:

- automated evidence,
- human judgment,
- directional pilot evidence,
- insufficient evidence.

## 18. Final dashboard

Build an internal results view showing:

- total sessions,
- completed sessions,
- partial and failed runs,
- ties,
- Sidequest blind wins,
- Claude blind wins,
- non-tied win rate,
- average ratings,
- critical and major errors,
- correction rounds,
- time to first value,
- total latency,
- cost,
- evidence coverage,
- cold versus warm behavior.

Support breakdown by:

- city,
- country,
- transit,
- road trip,
- outdoor,
- island,
- strong-data destination,
- weak-data destination,
- short trip,
- long trip.

Clearly label:

- implementation smoke test,
- directional pilot,
- meaningful sample.

Do not display statistical-significance claims unless a future analysis genuinely supports them.

## 19. Final reviews

After implementation and offline tests, launch six read-only final reviews:

1. experimental fairness,
2. fast-Claude baseline strength and absence of straw-man constraints,
3. validator neutrality,
4. blinding, persistence, concurrency, and security,
5. UI, accessibility, and reviewer-bias leakage,
6. latency, cost, and statistical interpretation.

Each returns severity, exact files, reproducible failure, and generic correction.

Fix every high- and medium-severity correctness, fairness, security, or experimental-integrity finding.

Do not broaden Phase 13 into normal product roadmap work.

## 20. Final verification

Run throughout:

- targeted unit tests,
- targeted integration tests,
- type checking,
- lint,
- targeted Playwright.

At completion run:

- `npx vitest run`
- `npm run verify`
- `npx playwright test`

Then run the entire Playwright suite two more times without changing any executed source or test file.

Required final state:

- three consecutive complete Playwright runs,
- desktop 1440 × 900,
- tablet 1024 × 768,
- mobile 390 × 844,
- zero failures,
- no hidden retries,
- no newly added skips,
- no arbitrary timeout increases,
- zero console errors,
- no horizontal overflow.

Manually inspect the benchmark routes at all three viewports for:

- neutral rendering,
- no system leakage,
- partial and failed plans,
- rating controls,
- correction flow,
- review lock,
- identity reveal,
- results,
- keyboard navigation,
- visible focus,
- reduced motion,
- screen-reader names.

Run migration validation against historical Phase 7–12 fixtures and new benchmark fixtures.

Confirm:

- normal Sidequest routes behave unchanged,
- branch is an explicit Phase 13 branch,
- `.env.local` is untouched and ignored,
- no credentials are tracked,
- no provider is enabled by default,
- automated tests remain offline,
- no destination-specific benchmark logic exists,
- `git diff --check` passes.

Remove temporary databases, raw provider/model responses, screenshots, profiling output, debug logs, scratch scripts, and benchmark exports containing personal data.

Do not remove legitimate ignored `apps/web/data/` development state.

## Valid stopping conditions

### Success

Return only after:

- all implementation acceptance criteria are met,
- final reviews have zero open high/medium findings,
- Vitest passes,
- `npm run verify` exits 0,
- three consecutive complete Playwright runs pass,
- a complete offline blind benchmark session works end to end,
- at least two live paired sessions exist when an explicit budget was supplied,
- the founder test guide exists,
- no subjective winner was fabricated.

The final report must include:

- starting and ending working-tree accounting,
- branch and HEAD,
- agents and ownership,
- shared request contract,
- Sidequest adapter behavior,
- fast-Claude architecture,
- exact call budget,
- prompt/schema versions,
- validator behavior,
- blinding and persistence,
- correction-burden flow,
- security findings,
- migration evidence,
- test counts,
- three Playwright results,
- live pilot generation table or explicit budget-based skip,
- latency and cost measurements,
- objective validator findings,
- limitations,
- exact steps for founder review,
- recommended decision after the founder supplies ratings.

End exactly with:

`PHASE 13 BENCHMARK READY FOR FOUNDER REVIEW`

### External blocker

Stop only when an external service, missing credential, corrupted external dependency, or environment failure prevents completion after all offline implementation is complete.

Report only:

- exact blocked command,
- exact error,
- why repository changes cannot resolve it,
- completed offline work,
- safest user action.

Implementation difficulty, architectural uncertainty, a large diff, failed obsolete tests, lack of human ratings, or absence of a live budget are not external blockers. Absence of a live budget means finish offline and report the live pilot as skipped.
