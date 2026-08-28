# Founder assessment

## Overall judgment

The simple ChatGPT baseline is substantially better than the current Sidequest result as an actual travel plan.

This is not primarily a visual-design criticism.

It is a planning-intelligence and product-flow failure.

## What the baseline does better

- Produces a comprehensive useful itinerary from one short prompt.
- Correctly understands Iceland as a country-scale road-trip problem.
- Chooses a coherent regional route.
- Allocates the available twelve days effectively.
- Includes major destination-defining experiences.
- Includes less-obvious places that materially improve the trip.
- Makes intelligent tradeoffs between regions.
- Alternates demanding and easier days.
- Minimizes unexplained downtime.
- Explains meaningful exclusions.
- Feels like something a knowledgeable traveler might actually take.
- Produces useful value in roughly a minute rather than after a long mandatory funnel.

## What the current Sidequest result does poorly

- Requires too much mandatory input before proving value.
- Exposes too much internal planning machinery to the traveler.
- Treats the Discovery Board as a prerequisite rather than an enhancement.
- Collapses a requested moving Iceland route toward Reykjavik.
- Allows evidence availability to determine the trip structure.
- Eliminates plausible useful experiences too aggressively when evidence is incomplete.
- Produces too few meaningful activities.
- Leaves large unexplained blocks of free time.
- Misses major Iceland regions and destination-defining experiences.
- Makes the user do planning work Sidequest should have done.
- Takes substantially longer while producing a substantially weaker trip.

## Product expectation

Sidequest should outperform a simple LLM by taking the strongest parts of frontier-model travel planning and adding specialized intelligence.

The intended advantage is:

frontier-model travel judgment
+
traveler-specific preferences
+
persistent personalization
+
place and route APIs
+
structured research
+
deterministic feasibility
+
specialized travel-product UX

—not replacing strong model judgment with a much weaker deterministic candidate funnel.

## Architectural implication

The model should be permitted to compose the trip.

The deterministic system should verify, constrain, optimize and repair it.

Unknown soft facts should generally lower confidence rather than automatically deleting useful planning ideas.

Hard factual and logistical constraints remain deterministic and load-bearing.

## Benchmark warning

Do not optimize production code specifically for this Iceland result.

The benchmark is evidence of a general architectural failure, not a golden route to reproduce.