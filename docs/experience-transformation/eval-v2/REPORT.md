# Evaluation v2 — travel quality and planning correctness (2026-11-13)

Method: `PROTOCOL.md` (frozen before any v2 code), requirements researched independently (`requirements.md`), rubric fixed before results (`blind/rubric.md`). Old build `ee57c8c` and new build run side by side locally with staging's provider configuration, 3 independent runs per scenario per build. Everything that differed from the protocol is in `DEVIATIONS.md` (server outages, a crash the runs found, geocoder refusals under parallel load, and one round of root-cause fixes followed by a full re-run).

## Main result — new build at `877f913` vs old, 30 pairs, 3 independent blind judges (90 verdicts)

| Scenario | New–Old–Tie | Old total /50 (mean ± sd) | New total /50 (mean ± sd) |
|---|---|---|---|
| tokyo-kyoto-transit | **9–0–0** | 22.2 ± 0.8 | **36.0 ± 1.6** |
| family-wellness-march* | 6–3–0 | 28.1 ± 2.9 | 31.2 ± 2.7 |
| iceland-ring-road | 6–3–0 | 27.0 ± 2.0 | 27.8 ± 1.5 |
| kumano-kodo | 6–3–0 | 27.1 ± 3.3 | 28.4 ± 1.7 |
| kyrgyzstan | 6–3–0 | 18.0 ± 3.4 | 19.9 ± 2.0 |
| multigenerational | 6–3–0 | 27.3 ± 4.6 | 29.1 ± 0.9 |
| mountain-hiking | 4–3–2 | 30.8 ± 1.2 | 31.4 ± 2.8 |
| tanzania-safari | 3–6–0 | 27.3 ± 10.2 | 23.2 ± 3.9 |
| city-break | 1–6–2 | 35.6 ± 1.8 | 32.7 ± 2.0 |
| beach-island | 1–8–0 | 30.8 ± 3.3 | 27.2 ± 1.7 |

**Totals: new 48, old 38, tie 4. The three judges agreed on 27 of 30 pairs.** The new build wins 7 of 10 scenarios; its spread is smaller than the old build's in 7 of 10 (more repeatable). \* family-wellness: the test robot answers the Help-me-choose interview by ticking the first option, and the two builds offer different first options (old pre-fills "Spa and wellness"; new asks, and the robot picks "Mountains and trekking"), so the destinations differ for reasons outside the planner.

## After the fixes the main run exposed (`2e9ed45`, `9595734`) — the 5 scenarios they touch, 3 runs each, 3 fresh blind judges (45 verdicts)

| Scenario | Main run (877f913) | After fixes |
|---|---|---|
| city-break | 1–6–2 | **6–3–0** |
| iceland-ring-road | 6–3–0 | 6–3–0 |
| mountain-hiking | 4–3–2 | 5–4–0 |
| beach-island | 1–8–0 | 3–6–0 |
| tanzania-safari | 3–6–0 | 3–6–0 |

## Deterministic checks (no model), 30 runs per build

| | Old | New (877f913) | New after fixes |
|---|---|---|---|
| Red flags from the researched requirements (total) | 25 | 16 | 5 in 15 runs |
| Sunset/sunrise/stargazing stops at the wrong hour | 4 | **0** | 0 |
| Hire car on a no-self-drive trip ("by train", operator safari) | 5 | **0** | 0 |
| Pre-dawn starts on restful trips | 0 | 0 | 0 |
| Builds that failed | 0 | 0 (2 at `6a8263c`, fixed in `83ecc69`) | 0 |
| Plans whose own contract says something essential is missing (shown on the page) | — | 8 | 1 |

Defining-experience presence per scenario, with the stage each miss was lost at, is in `final-grades.txt` / `grades.json`: most misses on both builds are *selection* (on the board, not in the plan) or *discovery* (never proposed). The new build's misses moved from discovery towards selection in Kyrgyzstan and Tanzania once the scope bug below was fixed.

## Root causes found and fixed during this pass (all generic)

1. "Tanzania safari", "Kyrgyzstan adventure" resolved as town-scale places, so every park was refused as outside the trip and a "safari lodge" was placed in the capital (shared with the old build) → trailing trip words never reach place resolution.
2. A city break slept in a satellite town three runs out of three → a city-scale destination is a part the stays must cover.
3. Defining places were unknown when stays were chosen → they join the traveller's must-dos in the stay objective (Tanzania now keeps 2–3 bases).
4. A long stargazing tour stretched a day past 24:00 and crashed the build → a window stops at midnight; the dark-sky stop keeps the darkness before it.
5. Gated venues "best at sunrise" were visited before opening; departure days began at 05:30 → dawn only under an open sky, never on the day home unprompted.
6. Plus the pre-run fixes: trip-quality contract, defining experiences, transport arrangement decided once, real solar timing, restful pace, trail stages that move the bed, day trips that must be worth their travel, advisor disqualifiers.

## What still fails, and why

- **Tanzania (3–6):** in one run of three the Serengeti is still missing. The plan can satisfy "a defining place" with Ngorongoro alone, and the stay objective does not always pay for a remote park's base. The judges also flag fictitious "train" legs on operator trips.
- **Kauai (3–6):** the single north-shore base drives to the west side on two or three separate days; the improvement phase moves one stop at a time and cannot consolidate a far zone that does not fit in one day. Where the router does not answer, straight-line estimates cannot see the Nā Pali cliffs (a "20-minute drive" between two points no road joins).
- **Kumano:** the new build walks a trail stage, but neither build plans inn-to-inn walking with luggage transfer; the proposals do not offer stage ends at lodging often enough for trail links to form.
- **Common to both builds:** Jökulsárlón skipped in several Iceland runs; Dyrhólaey inside its nesting closure; permits and reservations (Hāʻena, Auronzo) not mentioned; a party's grandparents dropped by the interview defaults.
