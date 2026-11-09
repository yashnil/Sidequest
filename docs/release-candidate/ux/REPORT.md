# Release candidate: first-time traveller audit

Walked on the fixture providers (no paid calls; map tiles are answered locally, so basemaps are empty on purpose) at 1440×900 and 390×844.

Two gaps in the screen sets:
- `14-stop-selected-map` has no "before": the walk's selector for that step was wrong on the before run, and I did not rebuild the old code to retake it.
- `19-map-day` has no "after": the Map tab now opens on the selected day, so `18-map` already is that picture.

### Ranked findings

| # | Problem | Status | What changed |
|---|---|---|---|
| 1 | The map and itinerary were separate. Days, the Map tab and the phone map each kept their own day and stop; only a mouse could select a row. | Fixed | One selection above every view (`hub/TripSelection.tsx`, rules in `hub/trip-selection-model.ts`). |
| 2 | On a phone it was map or list, never both. A full-screen modal, and pressing a pin closed it. | Fixed | A dock above the tab bar (`hub/DayMapSheet.tsx`). |
| 3 | Hand edits could not be taken back, and removing a stop said nothing. After Ask → hand edit → Ask → Undo, the restored version predated the hand edit, so it vanished under "back as it was". | Fixed | Every hand edit is a version (`recordEditVersion`); the baseline is re-recorded whenever the history's head is not the plan on the page. One toast says what changed and offers Undo (`hub/EditToast.tsx`, `undoTripEditAction`). Undoing a removal lifts the board skip. |
| 4 | "Rebuild my trip" on the board silently replaced edits and forgot must-keep and locked stops. | Fixed | Shows the same "Replaced: …" sentences as Regenerate and asks first; carries must-keeps. With no edits to lose it still builds on one press. |
| 5 | Stop rows spent both lines repeating the questionnaire ("You marked lakes & rivers…"), cutting off the place description. | Fixed on rows | Rows lead with the place. Presentation only. |
| 6 | Technical map wording, and straight lines drawn as routes. | Fixed on the day map | "Straight lines, not the road"; "Not on the map: X — no confirmed position yet". A timed leg with no shape is dashed (`atlas-model.ts`). |
| 7 | The phone map button was missing on arrival (CSS keyed on `days`, but the tab opens on `overview`). | Fixed | Both views count. |
| 8 | Two "Ask Sidequest" buttons on desktop. | Fixed | The float appears only on a page with no hub trigger. |
| 9 | The phone day rail left a band where content showed through. | Fixed | Offset corrected below `sm`. |

### The connection

- **Selecting a day** (rail, map day strip, dock arrows) draws and frames that day's route on every map.
- **Selecting a stop:** its number on the row is now a real button with `aria-pressed`, named "Show X on the map". It marks the pin and brings it into frame.
- **Selecting a pin** brings its row into view, marks it and moves focus to it. Keyboard pins use Enter or Space.
- **State** survives tab changes and a reload (session storage per trip, best effort; the shared copy stores nothing). A moved stop keeps its selection, a removed one releases it, and a vanished day falls back to the nearest.
- **Screen readers:** one polite live region says what each choice did.
- **Reduced motion:** no glide, flash or dock rise; cameras jump.
- **Missing coordinates** are absent, never fatal, and the day names the stops not drawn. A custom stop has no position and is named that way.
- `map-camera.ts` still decides the Map tab's frame.

**Why a dock on phones.** A toggle is the same either/or with a nicer switch. A mini-map under the top chrome adds a second sticky band where "the day being read" is measured. A dock at the thumb keeps the list and its scroll position, and each side answers the other. The map isn't created until the dock first opens, and never on wide screens. Full screen (ribbon, 3D, Replay) is one press away. No new dependencies.

### What can still replace a choice

| Action | What happens |
|---|---|
| Regenerate, or Rebuild on the board | Board decisions, carried must-keeps and locks, bookings and the party survive. Moves, custom stops, durations and eased or fixed days are replaced, and the traveller is told first. A must-keep not on the board is named as at risk. |
| Refresh trip information | Adds evidence only; the plan is unchanged. |
| Rebuild with improved planning | Already asks, and says it re-plans from scratch. |
| Re-scan the board | Says picks on places that still appear are kept; does not list which picks were lost. |

### Found, not fixed

- **React hydration error #418** appears on at least one page in every walk, before and after, on both widths. It predates this work; I did not locate the page.
- **Share panel under More:** the link field collapses to a sliver and the hero clips the menu (`before/desktop/22-share.jpg`).
- **The map's stop card** still shows the "You marked…" sentence and raw coordinates, and covers part of the route.
- **Dashed lines on the phone dock** render as a fine hatch in headless software GL at 3× (`after/mobile/15-phone-day-map.jpg`). Check on a real device.
- **Wording left alone:** "judged on 6 of 11 things" and "No photograph yet" on the shortlist; a "Book" heading inside "Bookings"; "2 things we could not check" on the board; the board's and `DayMap`'s "nobody publishes where".
- **Undo limit:** a lock removed along with a stop is not restored.
- **Not browser-tested or photographed:** selection under reduced motion has no dedicated browser test, and the tablet layout (floating dock card) was not photographed.
- **For the performance engineer:** the landing globe is a dark disc until it loads (`before/desktop/01-landing.jpg`), and landing screenshots hit a 20 s timeout under load. I made no landing copy changes.

### Questions for the owner

1. Should a rebuild be undoable? The old plan is not kept unless a version already exists. "Restore the previous plan" is small to build, but it is a product promise.
2. Should version history be capped? Each hand edit adds a full itinerary row (two for the first edit), with no pruning. Fine at this scale.
3. Is it right that Ask's "Undo last change" now also undoes hand edits? I think so, since there is one history, but it is a behaviour change.
