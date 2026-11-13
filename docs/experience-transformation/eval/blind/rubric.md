# Blind judging rubric — ten-scenario itinerary review

You receive, per scenario, the traveller's request and two finished trip plans labelled A and B, as a reader sees them (summary band, overview, every day, bookings). You do not know which system or version produced which. Judge each pair on the plan itself, not on wording style.

Score A and B independently, 1–5 on each criterion, then state which you would hand to this traveller (A, B or tie) and why in two or three sentences, citing specific days.

1. **Fit to the request.** Does the plan do what this traveller asked (party, pace, interests, stated mode of travel, "rest" vs "adventure")? A family wanting rest is badly served by long drives or strenuous days; a "by train" trip is badly served by a rental car.
2. **Feasibility.** Could this actually be done as written? Driving totals per day, out-and-back repetition, impossible or unmeasured legs, one-way walks with no way back, a departure day that still has activities far from the airport.
3. **Geography and bases.** Are stops grouped sensibly by area, with places to sleep that cut travel rather than add it? Are moves between bases justified?
4. **Usefulness and clarity.** Can a traveller act on it: clear day titles, meals placed, what to book and when, honest statements of what was not checked. Penalise vague filler, duplicated places, and prose that contradicts the plan.
5. **Honesty.** Does it say what it does not know (estimated times, unverified hours, seasonal closures) instead of inventing certainty? Penalise confident claims that look wrong.

Reference facts you may use (from primary sources, `research.md` §4–5): the Kumano Kodo is travelled on foot, by bus and with a luggage shuttle; official itineraries run 3–6 days; the family-friendly section is Hosshinmon-ōji → Hongū Taisha (7 km, ~2 h); the Kōyasan→Hongū bus runs only April–November; the Kawayu Sennin-buro river bath runs December–February only. For other scenarios use general travel knowledge and say when you are unsure.

Note on scenario `family-wellness-march`: the destination shortlist was answered by a test robot that always picks the first option offered. In one version the first activity option was "Spa and wellness", in the other "Mountains and trekking". Judge the shortlist on whether its picks and its own stated caveats fit the *original request*, and judge the itinerary on whether it serves a stressed family wanting rest.

Output: a JSON array, one object per scenario:
`{"scenario": "...", "scores": {"A": {"fit": n, "feasibility": n, "geography": n, "usefulness": n, "honesty": n, "total": n}, "B": {...}}, "preferred": "A" | "B" | "tie", "reason": "..."}`
