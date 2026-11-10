# Release candidate report (2026-11-09)

Branch `feat/trip-experience-release-pass`. Not merged, not deployed; no production data touched.
Detail: `recommendations/comparison.md`, `itinerary/REPORT.md`, `food/REPORT.md`, `perf/REPORT.md`, `security/REPORT.md`, `ux/REPORT.md`, `screens/{before,after}/{desktop,mobile}/`, `live/`.

## Verification on the final code

| Check | Result |
|---|---|
| Typecheck | clean |
| Lint | 0 errors, 147 warnings |
| Unit | 9,197 passed, 1 skipped, 0 failed |
| Production build | succeeds |
| Playwright desktop, mobile | 245 and 234 passed in the full runs; the 18 + 21 that timed out passed when rerun alone (19 + 21 tests). No test failed on rerun. The full runs took over an hour each, about twice their usual time. |
| Live acceptance | 4 trips and 2 Help-me-choose requests pass. About 14 recorded model calls across all attempts. No separate spend figure was taken. |

Tablet layout (`viewports.spec.ts`), the Today and globe configs were not rerun on the final code.

## Live acceptance found four bugs that fixtures did not

1. "Tenerife, Canary Islands" split into a Colombian namesake and Spain, so nothing placed.
2. A vague request stored an assumption over its schema limit, so the traveller got a 404.
3. A router that did not answer held a scan for 280 s and left food no time.
4. The scan map threw on a bad coordinate, and the error screen replaced the page before the finished trip.

## Known weaknesses, most severe first

1. In live runs every travel leg was an estimate: no router covers these areas without `OPENROUTESERVICE_API_KEY`.
2. Opening hours are effectively absent for restaurants; plans say so.
3. Trip page mobile LCP is about 3.5 s, unchanged.
4. Help-me-choose question selection blocks the event loop for 100 ms or more per step.
5. Estimators stay weak for scenic driving, rail, hot springs and birding; "Remote monasteries and high passes" still returned Bali, Fes and Lake Atitlán live.
6. Discovery Board picks cannot influence where the trip sleeps; 54 of 1,765 evaluated days have a transfer over the traveller's limit, stated but not fixed.
7. National parks, protected areas and ski areas keep circular extents.
8. Cost evidence is thin: 3.8% of guide destinations have five or more dated room prices.
9. React hydration error #418 appears on at least one page, before and after this work; not located.
10. The stay decision is recorded but not shown in the UI.
