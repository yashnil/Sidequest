# Destination discovery — "Help me choose", rebuilt (2026-10-26)

Uncommitted. Local review: http://localhost:3000/decide

## 1. Confirmed root causes of the original failure

Reproduced from the stored session (`decision_sessions` row `2dd186c0…`, answers: summer, flexible length, themes outdoors/wildlife/mountains/water). The shortlist was Republika Srpska, Municipality of Staro Nagoričane, Varna, Auvergne-Rhône-Alpes, Baden-Württemberg, Silesian Voivodeship, Santa Cruz, Perak — **all eight scored 100, coverage 0.17, band `thin_evidence`**.

Confirmed, each from the code and the stored factors:

1. **The candidate universe was administrative.** `recommendationUniverse` read Overture *divisions* (`region`, `county`) — 239 candidates, three per country, countries in code order, capped at 240. Nothing in it was chosen for being a place people travel to.
2. **The only measured evidence was settlement density.** `supplyFit` ("182 mapped places across 8 areas") and `varietyFit` ("8 distinct areas") were the only measured factors. `themeFit` returned `no_index_coverage` for every region (the index has no mountains, lakes or coasts); climate returned `climate_provider_unavailable`.
3. **The score was normalised over measured weight only**, so a candidate measured on 17% of the nominal weight and maxing both settlement counts scored 100. Every region with ≥ 8 town clusters tied.
4. **Ties fell back to a prominence/id order**, which is why the visible winners were arbitrary.
5. **The intake stopped after "when" and "what for"** — the two essentials — because its stopping rule summed nominal weights of dimensions the ranker could not actually measure.
6. **Imagery** resolved Wikidata images for administrative items, which are maps, flags and coats of arms as often as photographs.

Hypotheses not confirmed: geographic concentration was *not* a bias in the ranking itself; it was the code-ordered country scan plus ties.

## 2. Architecture

**Before:** composer answers → `recommendDestinations` (Overture divisions, settlement clustering, 12 climate lookups) → 14-dimension ranking → greedy country-diverse admit → 8 cards.

**After** (`packages/core/src/advisor/`, pure; web in `apps/web/src/components/advisor/`, `app/(product)/decide/advisor-actions.ts`, `lib/destinations/advisor.ts`):

```
free text ──parse.ts──▶ TripComposerAnswers (+ discovery)
                              │
          questions.ts ◀──────┤  next question = max expected shortlist change
                              ▼
        profile.ts ─▶ score.ts (exclusions · measured · not asked) ─▶ select.ts (MMR + floors)
                              ▼
                 advise.ts (words) ─▶ climate check (web, deadline 9 s) ─▶ stored AdvisorShortlist
                              ▼
     adopt ─▶ ordinary trip, destinationQuery = entry.resolveAs ─▶ existing plan / scan / build
```

No model and no provider decide the list. The answers live on the shared `TripComposerAnswers` (new optional `discovery` field), so a chosen destination carries every answer into the trip; there is no second profile.

## 3. Adaptive questioning

- **Read first.** `parseTravelRequest` (deterministic phrase table) reads season/months, length, interests, budget, party, adventure, reach, named regions and country groups, origin, transport, crowds, novelty and climate. Vague words set nothing ("outdoors" alone is flagged as vague, not mapped to hiking). Each reading is shown back as a chip; assumptions are stated ("We read 'summer' as June–August…").
- **Question bank** of 16, each a set of options that are pure patches on the answers. Conditional questions appear only when relevant (wildlife kind, mountain style, swimming, which interest leads).
- **Selection by expected change:** `value(q) = Σ P(option) · distance(current shortlist, shortlist if option) / effort`, with explicit priors per option (tested) and top-3 positions weighted double. Essentials (what for, when) first.
- **Stopping:** below 0.18 expected change, or after five follow-ups; "Show me places now" from the second question on; skip any; a skip is no information and never re-asked.
- Runs in the browser (p50 ~20 ms per step), with a live world map of the provisional leaders.

## 4. Candidate generation

A curated catalog of **234 travel destinations** in 24 world regions (`advisor/catalog/regions/`): national parks, ranges, island groups, coasts, lake districts, country circuits. Each entry states kind, countries, centre and radius, bases to sleep in, nights (min/ideal/max), 24 experience scores (0–3), highlights, monthly season suitability, typical highs and wetness, on-the-ground cost, lodging tiers, challenge (easiest/typical), remoteness, crowds, familiarity, access (airports, reach, car, transit), family and low-mobility suitability, trade-offs, cautions, and evidence (basis, as-of, references). Authored by five region agents against one rubric; validated by schema and catalog tests (coverage per continent, ≥ 30% little-known, every experience offered somewhere, hemisphere sanity, no repeated QIDs). 223 entries carry a Wikidata item **verified by coordinate** with `packages/core/scripts/catalog-wikidata.mjs` (a remembered QID is never trusted).

Hierarchy: world region → destination → bases (the existing planner expands bases into places after adoption).

## 5. Normalisation and entity filtering

Only travel destinations exist in the catalog; administrative units cannot be recommended because they are not candidates. Adoption goes through `resolveAs` ("Lofoten, Norway"; a bare country for a whole-country circuit) and the V8.1 semantic gate, like anything typed.

## 6. Ranking and diversity

- **Hard constraints** (excluded with a reason): outside the requested regions or countries, out of season in every month of the window, too far for a short trip or a stated limit, too short for the place, too demanding at "comfortable", inaccessible with limited mobility, car-only with poor transit for a non-driver, named in "avoid", set aside, or not offering what was asked.
- **Soft factors**, weighted (experience .32, season .15, budget .08, adventure .08, reach .07, climate .07, duration .06, novelty .06, group/crowds/getting-around .03–.04), multiplied by emphasis from what was said (a tight budget ×2, limited mobility ×3, a long stated trip ×2.5…).
- **Not asked ≠ scored:** an unasked factor leaves the score and is listed as an open question; coverage is shown on each card and breaks ties.
- **Interest fit** blends the mean over an interest's experiences with its best *major* component; sea swimming is credited only where days are warm.
- **Familiarity is never a bonus**; it counts only against a stated appetite for classics or the unusual.
- **Shortlist:** MMR (Carbonell & Goldstein 1998) with similarity = experience cosine + geography + same country/continent; λ 0.68 for broad requests, 0.8 single-interest, 0.9 when the place is narrowed. Relevance floor (≥ 0.5, within 0.14 of the best, filled from the next best when that would empty the list) and a **lead floor**: once a lead interest is stated, every primary pick must be good at it; if too few are, the screen says which constraint holds them back.

## 7. Data sources and confidence

| Source | Use | Confidence shown |
|---|---|---|
| Sidequest catalog (editorial, references per entry) | everything ranked | "Our reading is editorial, from …" on each card |
| Open-Meteo ERA5 archive (existing, cached 30 days) | checks the catalog's highs for the picks | "Checked against 2006–2025 records…" or "Records show … not … — check before you book", or "unchecked" |
| Wikidata / Commons (existing imagery gate) | photographs of the destination's own item | credit link; otherwise a labelled locator map, never a pretend photo |
| Natural Earth 1:110m land (public domain) | the dotted world map | caption |

Literature review: `docs/destination-discovery/research.md`.

## 8–9. Recommendations, before and after

See `before-after.md` (all 34 scenarios, generated by `vitest.harness.config.ts` against a copy of the dev database; old ranker run with fixture climate).

## 9b. Blinded qualitative evaluation

The objective checks above test properties; whether a list is *good advice* is a judgement. For that, both systems' top three for all 34 scenarios were shuffled into anonymous lists X/Y (seeded shuffle; key withheld) and rated 1–5 by a separate model-assisted evaluator instructed to act as an experienced travel advisor and not to read anything else (`blind/blind.json`, `blind/ratings.json`, `blind/key.json`). This is a model judgement, not a human panel.

| | Fit | Defensibility | Variety | Preferred |
|---|---|---|---|---|
| Before (previous ranker) | 1.44 | 1.56 | 1.68 | 0 of 34 |
| After (destination advisor) | 4.38 | 4.62 | 4.32 | 34 of 34 |

Weakest "after" ratings (fit 3): wildlife-led original request (Kruger lacks the coast/swimming also asked for), remote expedition (Corsica and Réunion busier than "far from anyone"), summer from Sydney, mountains "not too far" from Delhi (Yunnan and Kyrgyzstan stretch the distance), and marine wildlife in June (one pick off-season for puffins).

## 10. Test results (final build)

- `npm run test`: 591 files, **8,666 passed**, 1 skipped, 0 failed (includes 81 advisor tests: catalog, parser, profile, scoring, selection, interview, climate check, and the 34-scenario evaluation).
- `npm run typecheck` clean; `npm run lint` 0 errors (128 warnings, all pre-existing); `git diff --check` clean.
- Browser, full run on the pass build: maps **8 passed** (6 skipped by design); desktop **254 passed, 1 failed**; mobile **245 passed, 1 failed**, 9 skipped; Today **4 passed**. The one failure (both projects) was an over-specified assertion in the new `decide.spec.ts` (it named which follow-up comes first; that is the interview's call) — fixed to assert the real property (nothing already said is re-asked).
- Browser, on the final rebuild after the last fixes: `decide`, `imagery`, `viewports` specs, desktop + mobile: **30 passed**.
- Real dev-server walks (desktop 1440 and phone 390): no console errors, no horizontal overflow.

## 11. Latency

| Measure | p50 | p95 | n |
|---|---|---|---|
| Next question (pure, Node) | 19.6 ms | 62 ms | 136 steps |
| Shortlist build, pure | 0.7 ms | 3.4 ms | 34 |
| Shortlist build on the server incl. climate check (dev, mixed cold/warm cache) | 2.9 s | 3.5 s | 12 |
| Questions asked per scenario | 3 | 5 | 34 |

The climate check has a 9 s deadline; past it the card says "unchecked". Every build is counted, none excluded.

## 12. Model-backed vs no-model

The advisor makes **no model call** by design; nothing to verify there. Downstream, an adopted pick (Adirondacks) was run through the real pipeline on the dev server with the working key: the discovery scan's single proposal call returned 37 candidates (`stop=end_turn`), the planner built 8 days across 3 bases, carrying dates, nights, party and driving from the advisor. The scan took 209 s (existing scan pipeline, unchanged here).

## 13. Limitations

- The catalog is editorial and model-authored from general knowledge; only temperatures are checked against records, and only for the places on screen. Prices, permits, closures and advisories are not verified (cards say so).
- 234 destinations is a deliberate first slice; regions with fewer entries (West/Central Africa, Pacific) get fewer options.
- 11 entries have no verified Wikidata item, and some items are a base town rather than the whole region; those cards show the locator.
- The question priors are assumptions, not learned from traffic.
- The interview stops at five follow-ups in most broad scenarios; the low-value stop triggers mainly for specific requests.
- The old `DecisionComposer`, `ShortlistView`, `DecisionRevise` and the old decide actions are no longer reached by any route but were left in place.
