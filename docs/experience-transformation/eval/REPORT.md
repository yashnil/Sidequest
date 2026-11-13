# Ten-scenario evaluation — before vs after (2026-11-12)

**Before:** staging at `ee57c8c`. **After:** staging at `b38a08d`–`dba55ae` (see "Which run" below). Same requests, same providers, same model, run with "Plan with smart defaults" by `e2e/staging/scenarios.spec.ts`. One live run per scenario per side, so the model's candidate proposal varies between runs; this is a sample of one, not a distribution.

## Blind verdict (independent judge, labels hidden, `blind/`)

| Scenario | Preferred | Before /25 | After /25 | Judge's deciding point |
|---|---|---|---|---|
| beach-island | after (narrow) | 12 | 13 | before had a 05:30 start, a 13-hour hike day and day titles it never visits |
| city-break | after | 15 | 18 | after's days are grouped tighter; before called 16:30 "sunset" in May |
| family-wellness-march | **before** | 14 | 11 | after's advisor ranked a trekking region first despite its own "not what a restful trip is for" caveat; a Kathmandu camp placed in Pokhara |
| iceland-ring-road | after | 10 | 15 | before skipped Jökulsárlón and had ≈10 h "easy" days |
| kumano-kodo | **before** | 15 | 11 | after's proposal had no Kodo walk at all, and a Kōyasan day trip |
| kyrgyzstan | **before** (narrow) | 13 | 12 | after based three nights in Kochkor without ever going to Song-Kol |
| mountain-hiking | **before** | 16 | 14 | after spent a day on a Bolzano market trip |
| multigenerational | **before** | 13 | 11 | after sent the family to Tavira twice; both invent Algarve trains |
| tanzania-safari | **before** | 17 | 13 | after says "fly" on driving days, has no return flight, books a rental car |
| tokyo-kyoto-transit | after | 10 | 17 | before booked a rental car for a "by train" trip |

**Tally: before 6, after 4. Totals 135 vs 135.** The after build is not yet "significantly cleaner, more useful and more reliable" by this independent reading. Its wins are where logic changed (stated mode, high-speed rail, bases in Iceland, day grouping); its losses are mostly where the live model's candidate pool was weaker this run, plus specific defects listed below.

## Objective metrics (`final/compare.txt`, computed from the page text)

- Driving: beach-island 1,015 → 809 min (longest day 280 → 200); Iceland 1,983 → 1,523; family-wellness 778 → 0 (a different destination); Tokyo–Kyoto 747 → 0 (car → train). Kumano 735 → 785, mountain-hiking 815 → 1,082 and Tanzania 20 → 905 went up.
- Empty ordinary days: 4 → 3 in total.
- Readiness changed in 6 of 10; neither side is uniformly "Ready".
- One-way walk notes: 0 → 2 (Kumano: Daimon-zaka; Algarve).

## Places to stay and the printed guide (verified on staging, real browser)

- All 10 scenarios: the "Show places to stay" button named four real properties near the first base, answering in 2–36 s (Overture; Overpass was often busy and failed honestly).
- All 10 scenarios: both PDF formats rendered through the staging `pdf-renderer` service (HTTP 200, 1.1–2.3 MB, A4). Kumano and Tokyo PDFs are in `final/pdf/`.

## Which run is in "after"

Seven scenarios come from the first full run (`after/`). Mountain-hiking and multigenerational come from `after-rerun/`: the first run's lodging step hung, and the server fix (a 40 s ceiling per lodging source) shipped before the re-run. Tokyo–Kyoto comes from `after-tokyo3/`, after four fixes made *because of* earlier runs of that scenario (`b38a08d`, `5a44055`, `157b4df`, `dba55ae`). Its first after-run (rental car, 6 h 40 drive) is kept in `after/`, and the second (Kyoto dropped) in `after-rerun/`. Judging only the fixed Tokyo run favours the after side on that scenario; the report says so rather than hide it.

## Defects the judge found that are logic, not model variance (next fixes)

1. A safari run by an operator still asks for a rental car in bookings, and labels driving days "fly".
2. The advisor can rank first a place its own card says does not suit the stated kind of trip.
3. "Sunset" and "stargazing" stops are set to hours that are wrong for the date and latitude.
4. 05:30 starts appear on restful trips.
5. Return legs on out-and-back days are under-stated, and some meals are placed in the wrong town (both builds).
6. The stay objective does not yet model a point-to-point trail stage that ends at the next base.
