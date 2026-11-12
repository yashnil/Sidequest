# Experience transformation — plan and state

The brief is "Sidequest — The Complete Travel Experience Transformation" (2026-11-12). Research is in `research.md`, and the baseline recommendations are in `baseline/advisor-before.json`.

Decisions taken with the owner:
- The PDF renderer runs as a **staging-only** Railway service.
- Lodging uses **free open data with no prices**. LiteAPI is deferred.

## Diagnosis from the baseline (systemic, not per destination)

1. **The request parser drops the trip's character.**
   - "with my family" sets no party.
   - "outdoors stuff" sets no interest.
   - "feel good / life has been stressful" becomes BM25 terms instead of intent.
   - What remains is one interest, "wellness", so the shortlist is ranked on spa strength: Tongariro, Arenal and the Maldives for a family outdoor retreat.
2. **There is no notion of what kind of vacation it is.** The scorer is a weighted mean of attributes. Nothing asks whether the whole trip would feel restorative, how many hotel moves or how much transport stress it implies, or whether its signature experience is a trek the traveller did not ask for.
3. **Duration is suggested, never questioned.** Ten nights is offered even where ten is the destination's maximum.
4. **Card copy is one template:** "Strong on X, in season in Y."
5. **Planning optimises to fill days.**
   - Auto-pick takes most of the board.
   - The stay objective favours one base even with heavy backtracking.
   - Point-to-point hikes are stops with a visit duration.
   - (Kumano evidence: 11 nights in Hongū and about 1,382 km of driving, against official models of 3–6 days with no driving.)
6. **The PDF prints the screen.** It is not a document designed for paper.
7. **Bookings say "somewhere to stay in X"** with no named properties.

## Workstreams

| Stream | Owner | Scope |
|---|---|---|
| A. Trip intent and vacation fit | lead | Party, outdoors and emotional context in the parser (stated back, never diagnosed); a `TripConcept` reading; a vacation-fit factor (effort, logistics, lodging character, family, signature alignment); duration fit with pairing advice; follow-ups that re-retrieve and explain what changed; distinct card copy |
| B. Imagery | agent | Multi-candidate Commons pipeline (P948/P8592/P18/P180) with a quality gate, standard widths, focal point, contexts (hero, card, thumb) and a cartographic fallback |
| C. PDF guide | agent | Dedicated print route, compact and complete variants, SVG maps, QR codes, a renderer service (staging only) |
| D. Named lodging | agent | Overture/OSM properties per base ranked by effect on the trip; dated booking searches; no prices |
| E. Planner quality | lead (after A) | Marginal value and redundancy in selection; a trip-length verdict; hikes as episodes with return or luggage logistics; base objective weighing backtracking; quality gate before "Ready" |
| F. Trip UI and maps | after B–E | Progressive disclosure, day view, map clustering, routed vs straight lines |
| G. Flow | after A | Fewer waiting stages |
| H. Evaluation | lead | Ten scenarios, before and after, blind review |

## State after phase 1 (2026-11-12)

**A. Trip intent and vacation fit.** Done.
- New: `packages/core/src/advisor/concept.ts`.
- Wired through `parse`, `profile`, `score`, `select` and `advise`.
- Tests: `concept.test.ts`, plus updated eval copy.
- What changed:
  - The request is read as a weighted kind of trip, said back as correctable assumptions.
  - "Retreat" is no longer a spa booking.
  - "With my family" is read.
  - Emotional words never become search terms.
  - A new factor, "How the trip would feel", weighs effort, the stays actually needed, friction, comfort and family. Only rest, wellness and pilgrimage (and nature, when no activity is named) score what carries them, and the factor's weight scales with how much the kind of trip matters.
  - When no activity leads, the primaries and alternates must suit the kind of trip.
  - Cards lead with what carries the trip and how it would run (one base or split, car or not). They never suggest more nights than a place carries, and they say what to do with the rest (a pairing in the same country).
  - Every change after a follow-up states its reason: "New: … —" / "Dropped: … —".
- Evidence:
  - `baseline/advisor-before.json` / `advisor-after.json`: the owner's request now gets Jamaica, Tongariro & Rotorua and Palawan, with no Kumano Kodo or Maldives among the primaries.
  - The global benchmark on the same 211 requests: 428/468 checks before and 428/468 after; requests passing every check 159 → 160 (`benchmark/`).
  - Curated eval: 118/118.

**B. Imagery.** Done for advisor cards.
- `lib/media/*`, `components/media/*`.
- Commons candidates are tied to the place's QID, with a location cross-check and a per-context gate.
- 46 of the 55 sampled destinations that answered now get a card photograph (previously letterboxed 7:1 banners).
- Share-alike files are shown whole (not cropped) pending the owner's licence ruling.
- Board, trip and itinerary images still use `DestinationImage`.

**C. PDF guide.** Built and verified locally.
- Dedicated `(print)` route with Compact and Complete versions, an SVG map and QR codes.
- `services/pdf-renderer` exists but is not deployed.
- Mammoth Lakes: 18 pages before → 7 / 9 after.
- Samples: `pdf/after/`.

**D. Named lodging.** Done.
- Overture/OSM properties ranked by their effect on the trip.
- A traveller-pressed panel in Bookings.
- No prices.
- Never rendered in a browser yet.

**E. Planner.**
- Value of free time added to the objective (`TIME_VALUE`). Measured effect on the offline evaluation is small (moves that lose time 16 → 13, strenuous back-to-back days 2 → 1, stops unchanged).
- A restful concept from Help me choose now defaults the trip to a slow pace and light days.
- A near-duplicate rule was tried and reverted: "same kind within 2 km" cannot tell a museum quarter from a string of wayside shrines.
- Not done:
  - hikes as episodes with return or luggage logistics;
  - the base objective's backtracking weight;
  - the trip-length verdict on the plan;
  - the quality gate before "Ready".

**F/G/H.** Not started: the itinerary information architecture and day view, map clustering, flow consolidation, and the ten-scenario blind evaluation.
