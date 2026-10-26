# Sidequest — Survey Atlas (creative reinvention, 2026-10-25)

**A trip is a survey of a place.** The product is a survey sheet you fill in and a map that answers.
Two grounds, one language:

- **Survey paper** (`bone` + the hairline survey grid `.survey`) — where you read and decide: interview, the board's register, a day's timeline, Plan/Book/Prepare.
- **Night atlas** (`night`) — where the place itself is the subject: the landing globe, the scan, the board's stage map, the journey map.

Chosen after three rendered concepts (`prototypes/`, shots in `prototypes/shots/{a,b,c}`):
A *Living Atlas* (cinematic night map stage — kept as the stage), B *Folio* (editorial photography — kept for lead prints and day openers),
C *Survey Journal* (grid, coordinate bar, numbered specimens, ruled rows — kept as the system). References: `research/references.md`.

## The vocabulary (use these, don't invent new chrome)
| Element | Use | Where it lives |
|---|---|---|
| `.survey` / `.survey-night` | page ground with a hairline grid instead of card borders | `app/globals.css` |
| `.ruled` / `.ruled-strong` / `.ruled-night` | rows separated by rules, never boxed; a section opens on an ink rule | globals |
| `.sheet` (= `Panel`, `.card`) | the only container: square, hairline, ink top rule | globals, `ui.tsx#Panel` |
| `.sheet-label`, `.coordbar` | JetBrains Mono margin text: sheet numbers, counts, coordinates | globals |
| `.label-box` + `.label-row` | boxed stats that share borders (Moving · Effort · Back by) | globals |
| `.numeral-giant`, `.display-stage` | the huge light Fraunces numeral / headline (day 02, question 03) | globals |
| `.chip-in` | square "IN" toggle; flare when pressed | globals |
| `.print-frame` | a photograph as a print: white border, mono caption. **Never crop** a share-alike file — show it whole (`ratio="natural"`); mixed shapes are the rhythm | globals + `DestinationImage` |
| `.atlas-pin` | numbered specimen pins on the atlas map (chosen = flare, base = square, meal = glacier, muted = dot) | globals + `atlas/AtlasMap` |
| `AtlasMap` | the interactive map: real coordinates, `<button>` pins, routes by evidence (measured solid / estimated dashed / unmeasured dotted / boat-rail glacier), fly-to focus, live coordinate bar, SVG fallback | `components/atlas/` |
| `atlasStyle('survey'|'night')` | Sidequest's own cartography; the default trip basemap (`sidequest:survey`) | `components/atlas/atlas-style.ts` |
| Motion | `.mask-rise` (headline lines rise from their baseline), `.wipe-in`, `.fade-up` with `--d` delays; route draw-on; camera flights. Reduced motion: jump + whole lines | globals, AtlasMap |

## Rules
- **Flare is for the one action that moves the trip forward and for "in your trip".** Never decoration.
- **Numbers are the bridge between list and map**: the same two-digit number on a row and its pin.
- Square for data, round only for actions (buttons stay pills).
- Copy: short, concrete, no "reimagine", no paragraphs explaining the product. A sentence, not a panel.
- Keep every `data-testid`, role and accessible name the e2e suite uses; keep all logic and server actions.
- No fake places, routes or photographs. Unknown ≠ false still holds in the visuals (dotted = not measured).
