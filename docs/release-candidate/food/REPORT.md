# Food recommendations: release-candidate report

Evaluated 2026-11-09 from recorded open data. No paid calls.

### How this was measured

`apps/web/src/lib/discovery-scan/food-eval/` replays six recorded trips through the product's two food steps (`groundScanFood`, `reconcile.nameVenuesForDay`). A separate judge in `eval.ts` shares no ranking code with them. The trips are a dense city (Tokyo and Kyoto), an island (Tenerife), a rural road trip (Scottish Highlands), a small town (Keswick), a remote park (Torres del Paine) and a sparsely mapped non-Latin region (Karakol), each with 2 to 4 traveller profiles.

Run with: `SIDEQUEST_FOOD_EVAL_LABEL=after npx vitest run -c vitest.food.config.ts apps/web/src/lib/discovery-scan/food-eval/eval.harness.ts`. It is offline and repeatable. `baseline.json` was generated from unchanged product code with the final judge.

The judge also reads the recorded world around the trip. A *coverage miss* means food exists within reach but the plan named nowhere. A *sparse* meal means the recording holds nothing within reach. The day structure is a stand-in (nearest base, nearest-neighbour chain), so the numbers describe food on a plausible day, not day construction.

**Limits.** OpenStreetMap could not be recorded (public Overpass returned 502, 504 or timed out all session), so fixtures have `osm: null` and hours evidence reads 0% before and after; hours logic has unit tests only. The cuisine prior comes from these six trips. Coordinates of the three hand-authored scenarios are approximate.

### Results

See the before-and-after table above. Further rows: venues kept 157 → 433; practical chain passed over 0 → 0; venues repeated on a trip 7 → 6; named without hours evidence and said so 140/140 → 182/182; coverage misses now saying we did not find one to name 0 → 24; sparse meals sent to a distant venue 0 → 0; sparse meals told a meal was available there 3 → 0.

### Regressions investigated

- Same cuisine back to back, 6 → 19: more meals are named and labelled, and most of the rise is travellers who asked for a cuisine. About 1 per trip for no stated preference. Trip-wide variety term added (`cuisineAlreadyEaten`).
- Chain share, 0.6% → 6%: intended. The old code deleted chains wherever independents existed.
- A bug the harness exposed: a dinner back at base was judged from the day's last stop, producing "self-cater from Unimarc" in a town with 39 restaurants. Dinner at the end of a day is now also judged around the base.

### What changed

- **Identity** (`packages/core/src/food/identity.ts`): names fold in any script. The old `a-z0-9` fold made every non-Latin name empty, so any two non-Latin venues within 150 m counted as one. Generic words are counted from the names. A doubtful pair keeps both. A second source's hours, diet and cuisine merge onto the first.
- **Chains, from data:** `brand:wikidata`, a brand the venue's name extends, repeated names. Overture's bare `brand` is unreliable (about a third unrelated to the venue). Chains are never excluded; an independent wins unless the chain is materially closer.
- **Ranking** (`packages/core/src/food/meal-rank.ts`): every term is in `MEAL_RANK_KM`, in kilometres, with the discount capped. Terms: liked or disliked cuisine, local cuisine, confirmed hours, cuisine already eaten, chain, coffee shop at lunch, takeaway at dinner, pub food unconfirmed, inferred price above band. No term penalises missing evidence. Cuisine wishes are read from the traveller's notes against cuisines on offer, with negation. A stated diet is honoured first.
- **Budget:** only a published band can exclude a venue.
- **Coverage:** 16 boxes (was 8), 5 base boxes (was 3), 120 venues (was 60). Pubs, tea rooms and food trucks are kept; a pub says "Check that it is serving food". Cuisine diversity within each box. Address locality replaces the destination name.
- **Hours:** `opening_hours` through the existing `parseOsmOpeningHours`. A venue recorded as closed for that meal is not named. The shown window is the one the meal falls in. With no record the plan says hours are not confirmed. Hours credit whoever recorded them.
- **Sparse areas** (`mealAlternativeFor`): `FoodDataset.searched` records which boxes answered and what they held. Sparse lunches name a real grocery, convenience store, market or bakery near the base or on the way out, or a café to eat at before leaving; otherwise the plan says to bring food. Where nobody looked, it says so and does not advise packing.
- **Every sentence reads a field:** cuisine label, common here, you said you like it, part of a chain. None claims a venue is good.

### What remains, by traveller impact

1. Hours evidence is effectively absent: Overture has none and Overpass is only asked for thin boxes. A bulk or self-hosted OSM extract would change this.
2. Diet evidence is thin (3.7% of venues), only from venues filed as vegetarian, vegan, halal, kosher or gluten-free.
3. 28 coverage misses remain, mostly from the 16-box limit. Boxes are drawn before the traveller picks; reading food for chosen stops at build time would close this.
4. Breakfast is still not named.
5. A scan that finds no venue at all stores no food dataset, so sparse advice cannot run there.
6. Live latency of 16 boxes is unmeasured.

### Provider and licence notes

- **Overture places:** CDLA-Permissive-2.0 (Meta, Microsoft), Apache-2.0 (Foursquare), CC0 (some others), kept per venue in `source.element.licenceId`. Reasons credit "© Overture Maps Foundation" and the region's licence list adds CDLA-Permissive-2.0. **Gap:** the region list says CDLA even when a row is Apache-2.0, so Foursquare-derived rows may need their own notice. Worth a licence review before release.
- **OpenStreetMap (ODbL-1.0):** OSM venues credit "© OpenStreetMap contributors" in the reason and add the licence to the region. OSM evidence merged onto an Overture venue also marks the scan as using OSM.
- **Google:** nothing added; no Google name, duration or polyline stored.
- **Fixtures:** `food-eval/fixtures/*.json.gz` hold raw Overture rows under the licences above.
