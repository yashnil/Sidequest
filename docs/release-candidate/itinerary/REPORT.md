# Itinerary planner: structure as an objective, days repaired before display

Harness: `apps/web/src/lib/planning/evaluation/` (`npx vitest run -c vitest.harness.config.ts apps/web/src/lib/planning/evaluation/itinerary.harness.ts`). 19 boards (6 recorded live scans, 6 bench boards, 2 fixture proposals, 5 synthetic geometries) x 12 travellers = 228 trips, 1,765 days, through the real assembler, Discovery Board and planner. No model, provider or database. `baseline.json` was taken before any behaviour change; `after.json` is the current planner.

**Read these figures with three limits in mind.** Every travel time is an estimate, because no router is recorded for these boards. Places on recorded scans get their kind and effort from a name table, since the recordings hold only names and coordinates. Each board's "must" picks are chosen by the fixtures, not by real travellers. One measure also differs slightly between the two runs: "days past their window" follows the route each planner actually schedules, so moving days are loops in the baseline and journeys after.

## Before and after

| Measure (228 trips) | Before | After |
|---|---:|---:|
| Hotel moves | 144 | 126 |
| Trips with at least one move | 97 | 94 |
| One-night stays | 18 | 12 |
| Mean travel per day (min) | 96 | 86 |
| Worst single day of travel (min) | 1,205 | 515 |
| Days over the traveller's travel limit | 190 | 85 |
| - the transfer alone is over the limit | 65 | 54 |
| - moving day, transfer + stops over | 66 | 29 |
| - holds the traveller's own pick | 25 | 2 |
| - Sidequest's own picks or uncounted sunrise runs | 34 | 0 |
| Minutes over the limit, all trips | 20,376 | 7,920 |
| Days past their window | 27 | 5 |
| Heavy arrival days | 25 | 2 |
| Heavy departure days | 4 | 2 |
| Traveller's picks placed (of 516) | 445 | 456 |
| Defect days not stated anywhere | 219 | 0 |
| Days repaired before display | n/a | 65 |
| Backtracking days | 2 | 0 |
| Stops scheduled | 3,453 | 3,289 |
| Empty days between arrival and departure | 1 | 14 |
| Moves that save less than their transfer | 4 of 144 | 13 of 126 |
| One-stop interior days | 180 | 211 |

The bottom four rows got worse. Each is covered under "Regressions, one by one".

## What changed

**Base choice is one objective** (`packages/core/src/scan/stay-objective.ts`, replacing the threshold ladder in `chooseScanBases`). Cost, in minutes of the traveller's time, is day travel + transfers + move overhead + move inconvenience + the value of what goes unseen + half of any day nothing within reach can fill. Each candidate set of bases is ordered, given its best night split, and costed.

- Move overhead depends on no car, children, mobility and pace.
- Inconvenience comes from the traveller's stated hotel-switch tolerance.
- The stated cap on hotel changes is hard.
- Parts of the destination and must-dos the traveller named are compared before cost. A weighted penalty alone was outbid by transfer costs and dropped Dublin from a trip whose must-do was there.
- More moves must win by a margin, wider for estimated times. Near-ties go to the proposal's own night hints.

The small-island rule and the other thresholds are gone.

**The decision is recorded** (`schemas/stay.ts`): on `basePortfolio.decision` and on `itinerary.package.planning.stay`, with the alternatives' numbers and one displayable sentence. `basePortfolio.rationale` now carries that sentence.

**Prevention in the day validator.** A transfer now comes off the traveller's limit. Sunrise runs count. A moving day is modelled as a journey (last base, stops, tonight's base, as the reconciler builds it), so a stop costs its detour rather than a round trip.

**Repair** (`planning/structure-repair.ts`). A traveller's pick left on a day it overfills moves to the day that takes it at the least cost, giving up as few of Sidequest's picks as possible. Nothing the traveller chose is removed. Whatever cannot be repaired is stated on the day with its figures (`package.planning.dayNotes`, and the day's note). Back-to-back strenuous days (2) and backtracking (2) were too rare in the baseline to justify a repair class; hard days together are stated.

**Different travellers get different structures on one board.** Ireland: default Dublin 3 > Galway 4; happy to move Dublin 2 > Galway 2 > Killarney 3; no car Dublin 7; limit of 90 minutes a day Dublin 2 > Killarney 5. Tenerife with a car keeps one base; without a car it moves. `stay-objective.test.ts` proves this on the five synthetic geometries.

## Regressions, one by one

- **Empty interior days, 1 to 14.** Ten are moving days where the transfer used the traveller's limit and nothing lay on the way. The journey is the day, so `plannerFallbackReasonOf` no longer treats an empty moving day as a thin board. Before that change, these days would have sent the trip to model composition. Four are non-moving days, two of them Ireland with one base, where the base was chosen to reach the traveller's pick and little else is in range. Those four still trigger the fallback.
- **Moves that lose time, 4 to 13.** Seven are the named Tokyo-and-Kyoto trip, on purpose: the traveller named both cities. Three are three-day trips forced by named must-dos. Three are car-free, and all see more places for less total travel than staying put. The metric counts travel only, not places reached.
- **One-stop interior days, 180 to 211.** Only 3 have a compatible unscheduled neighbour, and most follow from the limits now being enforced. Long trips run out of places within reach; the 12-day profile alone accounts for 55.
- **Stops scheduled, down 4.7%.** Expected: those stops were the ones that broke the traveller's own limit. No case drops more of the traveller's picks than before; 7 drop fewer.

## What remains

1. Picks made on the Discovery Board cannot influence the bases, which are chosen at scan time; only must-dos named at setup can.
2. The objective's constants are judgement, checked against this harness and not against real travellers' preferences.
3. 54 days have a transfer longer than the traveller's own limit. They are stated, not fixed.
4. Hours: 0 conflicts means little here. Scan-built regions have no opening-hours evidence until verification, so hours are unknown on 1,323 stops. Unknown is not a pass.
5. The UI does not yet show `planning.stay`; only the data is exposed.
