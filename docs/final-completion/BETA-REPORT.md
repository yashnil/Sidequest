# Beta acceptance report — 2026-11-16

**Recommendation: ready for a small, invited beta (tens of people, not a public launch), once the owner has completed
real Google sign-in (`OWNER-ACCEPTANCE.md` A–F).** No known critical defect remains. The one critical defect this pass
found (every trek failed to plan) is fixed, tested and verified live on staging. Six P2 quality issues remain. They
are listed below and should be shared with beta users as known issues.

## What was tested

| | |
|---|---|
| Branch | `feat/trip-experience-release-pass` (not merged; `main` and production untouched) |
| Final commit | `6352fd5` fix(trail): beds a followed trail adds get estimated matrix rows |
| Staging deployment | `8a97d7c8` · 6352fd5 · SUCCESS 2026-11-16 03:41 UTC · https://sidequestweb-staging.up.railway.app |
| Commits in this pass | `8463ebd` beta fixes · `f1914e3` display-title clipping + support wording · `6352fd5` trail matrix fix |

**Deploy note (owner action):** Railway skipped the 6352fd5 push, and a later `railway up` of the same tree, with "No
changes to watched files", although `railway.json` watches `/packages/**`. The service's dashboard watch paths
probably override the file. 6352fd5 was deployed with `railway redeploy --commit <sha>`. Check
Railway → `@sidequest/web` → Settings → Watch Paths before relying on automatic deploys. I did not change any Railway
setting.

## Automated results (final code, 6352fd5)

| Gate | Result |
|---|---|
| Unit (vitest, full) | 682 files · **9,827 passed**, 1 skipped, 0 failed |
| Typecheck | clean |
| Lint | 0 errors (existing `no-console` warnings in scripts) |
| Build | OK |
| `git diff --check` | clean |
| Browser, desktop (full) | **285 passed**, 2 skipped, 0 failed (38 min) |
| Browser, mobile (full) | **277 passed**, 10 skipped, 0 failed (38 min) |

## Live journeys on staging (real model, geocoders and routers)

Thirteen journeys ran overnight on f1914e3. The three treks failed there and were re-run on 6352fd5. Graded with
`docs/final-completion/eval/grade.py`. "Defining" means the destination's essential experiences appearing in the plan
(the lists are in `requirements-unseen.json` and `requirements-beta.json`).

| Journey | Result | Defining | Max day | Bases | Notes |
|---|---|---|---|---|---|
| Family wellness (advisor → Lake Atitlán) | pass | 2/4 | 140 min | 1 | lake villages planned as drives (P2) |
| Madeira levada hiking | pass | 2/6 | 145 | 1 | says correctly there is no railway |
| Tokyo–Kyoto by transit | pass | 4/5 | 270 | 2 | Tokyo→Kyoto by train; 2 km city hops worded "train" (P3) |
| Tanzania safari | pass | 3/5 | 205 | 2 | **Serengeti not in the plan** (P2) |
| Oaxaca food & culture | pass | 4/6 | 223 | 2 | rental car for a coast leg; within the 240-min limit |
| Faroe road trip | pass | 6/6 | 277 | 3 | **"Drive to Mykines"**, an island reached by ferry (P2) |
| Azores hot springs (unseen) | pass | 5/5 | 215 | 1 | no rail or metro anywhere |
| Slovenia family (unseen) | pass | 4/5 | 190 | 1 | |
| Advisor: warm unwind (unseen) | pass | 3/3 | 125 | 1 | Jamaica; Lagos City is a weak third pick (P3) |
| Advisor: history by rail (unseen) | pass | 2/4 | 125 | 1 | **10 nights in one Fes riad, no train** (P2) |
| Imported plan (Mode 3) | pass | stated stays 4/4, 0 conflicts | | 4 | every stay "as you said" |
| Kumano Kodo (re-run, fixed build) | pass | 4/5 | 160 | 7 | walked in order: Takahara → Chikatsuyu → Hosshinmon → Hongū → Koguchi → Nachisan; no car; luggage transfer |
| Tour du Mont Blanc (re-run) | pass | 3/6 | 175 | 4 | French and Italian sections only; no Swiss section (P2) |
| Torres del Paine W (unseen, re-run) | pass | 4/5 | 140 | 2 | refugio beds, walk and bus legs only, no trains |

Across all 14: 0 impossible legs, 0 dawn starts on slow trips, 0 transport contradictions, and every Compact and
Complete PDF returned HTTP 200.

## Defects

| Sev | Defect | Status |
|---|---|---|
| **P0** | Every followed trail (Kumano, TMB, Torres) failed discovery with `base_missing_from_matrix`: beds the trail adds at stage ends had no travel-time row, and staging's region integrity check refused the build. | **Fixed** in 6352fd5 (coordinate-estimated rows labelled `plausible_unverified`). Regression test asserts the integrity check; all three treks pass live. |
| P2 | Water crossings planned as drives when no router measured them: "Drive to Mykines" (Faroe), Lake Atitlán villages reached only by boat. | Open. A generic fix needs coastline/landmass data per point; the atlas has it only per destination. Legs are marked "estimated from map distance". |
| P2 | Safari plan omits the Serengeti and is "built around markets and hot springs". | Open (planner selection: a far park loses to nearby picks). |
| P2 | "Old towns by train" (advisor → Fes & Chefchaouen) became 10 nights in one base with no train. | Open. |
| P2 | A rental car is chosen although the advisor card said no car is needed. | Open. The harness answers "will drive", so this is partly the test's input. |
| P2 | TMB plan walks only part of the circuit across 10 days. | Open. |
| P3 | Short city hops worded "train" (Kyoto); taxi legs on a car-free trail worded "drive" (Kumano). | Open. |
| P3 | Weak third advisor pick for a restful beach trip (Lagos City). | Open. |
| P3 | One "strenuous" text flag is a false positive ("steeply built village"). | Not a defect in the product. |

No defect found in this pass invents a transport service, a price or availability.

## Visual acceptance

Checked on staging: public pages (`/`, `/decide`, `/improve`, `/signin`, `/privacy`, `/terms`, `/support`) at desktop and
phone width, plus the live trip pages and advisor shortlist from the runs above (`eval/live4/screens`,
`eval/live5/screens`).

- No console errors and no horizontal overflow at either width.
- The display-title clipping ("Japan typography") is fixed in f1914e3.
- Shortlist cards, trip hero, planning panel and attributions render cleanly.

## Provider cost

- **Anthropic:** at most 300 model calls a day (`SIDEQUEST_DAILY_MODEL_CALLS`). This pass used about 20–35 calls on
  2026-11-16, an estimate: one discovery proposal per journey, plus advisor research and destination interpretation
  where they ran. The logs don't show an exact per-call count. The previous UTC day hit the anonymous share (75% of
  300); caps were not raised.
- **Google:** Places is the only billed Google API in use, and the call count is not in the app logs (owner dashboard
  check, `OWNER-ACCEPTANCE.md` F).
- **Everything else** is keyless or free tier: openrouteservice, Nominatim, Overture, Wikidata.
- No new paid services or subscriptions.

## Not verified by me

- **Real Google OAuth:** the redirect, PKCE, cookie and registered callback are verified, but signing in needs the
  owner's account. Fixture sign-in is not evidence. Follow `OWNER-ACCEPTANCE.md`.
- Railway backup schedule, Anthropic and Google spend limits, OAuth consent-screen status, and the support address:
  dashboard checks in `OWNER-ACCEPTANCE.md` F.
- Legal pages remain drafts that need the operator's entity details and a review.
