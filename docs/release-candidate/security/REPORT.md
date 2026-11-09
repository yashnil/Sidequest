# Release-readiness audit" to the end. Please save it to that path, or tell me to if that write is allowed. Only an empty `docs/release-candidate/security/` directory exists, and git ignores it.

**Verdict:** no Critical findings and no object-level authorisation hole. 11 High findings fixed. 4 High remain, all owner decisions or configuration. Beta is unblocked once `8d122f9` is deployed and the items marked BLOCKS BETA in the owner checklist are done.

**Test caveats**
- The full `npm run test` ran once, before the last few edits. I then re-ran only the affected suites, which pass. It was not repeated in full.
- The Playwright run came before two small later edits: the rate-bucket cookie filter, and a URL regex with no producer. Both are covered by unit tests, and fences are off in that suite anyway.
- `npm run build` was re-run afterwards and passes. The header and axe walk ran on that later build.
- H-7 (photo proxy) has no route test, because Google is off in fixture mode. It is type-checked only.
- `next.config.ts` was not touched, so it should merge cleanly with the performance worktree.

---

# Release-readiness audit: security and reliability

Audited 2026-11-09 against `feat/trip-experience-release-pass` @ `de9f5e8`. Fixes are in commit `8d122f9`. No production system, production database, paid API or real secret was touched; every server ran on port 4430 with fixture providers.

## Verdict

**Nothing in the code blocks an invite-only beta once `8d122f9` is deployed and the owner steps marked BLOCKS BETA below are done.** There are no Critical findings. No object-level authorisation hole was found in any of the roughly 130 server actions and 15 route handlers. Eleven High findings were fixed. Four High findings remain, and all four are owner decisions or configuration rather than code.

A public launch is a different question. These must be settled first: the Google terms position (H-12), the Open-Meteo commercial tier (H-13), the legal pages (H-15), a human check before a new identity's first billed call, and error tracking and off-platform backups.

**How findings were established.** Six code-reading passes covered the actions, routes, outbound calls, output sinks and licences. Findings behind a fix were re-read in the code before the fix was made. Documented findings below are as read in the code and were not all independently exercised. Where a claim was measured, the report says so.

**Not covered:**
- An axe pass over a built trip's pages (only the nine shared routes below).
- Rendered PDF or print output.
- Railway's actual `X-Forwarded-For` and `X-Forwarded-Host` behaviour (needs a deployed check).
- Live Overture row licences.
- The worst-case cost of an advisor step with a free-text phrase (M-3).
- Fixture-mode degradation (`playwright.degraded.config.ts`) was not re-run.

## Findings by severity

| Severity | Fixed | Open |
|---|---|---|
| Critical | 0 | 0 |
| High | 11 | 4 (owner) |
| Medium | 8 | 13 |
| Low | 2 | 12 |

### High

| ID | Finding | Evidence | Status |
|---|---|---|---|
| H-1 | **One booked date could stall the whole server through the unauthenticated calendar feed.** A booked date was any `\d{4}-\d{2}-\d{2}`, and VTIMEZONE probed every day of every year between the earliest and latest date. One fact dated 9999 is about 139 s of synchronous CPU per zone per request (per-probe cost measured, loop extrapolated). The feed needs no cookie and has no rate limit. | `execution/calendar.ts`, `calendar-events.ts`, `booking.ts` | **Fixed 8d122f9.** Years capped at 4; only real dates within a year of the trip become events; one formatter per zone; dates validated on input. Test: `release-hardening.test.ts` |
| H-2 | **One pasted confirmation could block the event loop for minutes.** The e-mail redaction regex is quadratic: 2.7 s at 40 KB (measured), about 9 minutes extrapolated to the 512 KB cap. `<[^>]+>` and the PDF trailing-space pattern are also quadratic (measured), and the zero-run phone pattern is slow; the door had no fence. | `confirmation-extract.ts`, `execution/import.ts` | **Fixed 8d122f9.** Patterns are linear (a few ms at 512 KB on adversarial input, measured); `import_prepare` fence added. Test: `release-hardening.test.ts` |
| H-3 | **`completeAndBuildAction` was an unfenced billed door.** No bucket and no attach-to-running; every call was charged to one constant key and ran a second generation over a live one. Reachable with a client-chosen argument. | `questionnaire/actions.ts` | **Fixed 8d122f9.** Attach check, `build_start`, `billed_hourly` when model-composed, charged to `callerKey()`. Test: `ownership-release-audit.test.ts` |
| H-4 | **Advisor research charged the ledger to the raw, client-written cookie.** `sidequest_session=user:x` spent from the allowance reserved for accounts, a fresh value bought a fresh share, and `billed_hourly` was never taken. One script could spend the day's model allowance. | `decide/advisor-actions.ts`, `daily-ceiling.ts` | **Fixed 8d122f9.** Uses `callerKey()` and `guardBilledAction`. Test: forged `user:` cookie case |
| H-5 | **"Read with Sidequest" was a billed door with no fence and `caller: null`.** Each press is up to 60k characters or a photo. One browser could exhaust the shared pool for everybody. | `itinerary/actions.ts` | **Fixed 8d122f9.** `import_read` + `billed_hourly`, charged to the caller |
| H-6 | **Editing any field of a booked item silently made it Booked and locked.** `.partial()` keeps `.default()`, so setting a price on an idea produced a binding fact the planner will not move and the calendar exports as CONFIRMED. | `itinerary/actions.ts`, `booking.ts` | **Fixed 8d122f9.** `bookedPlanItemPatchSchema`. Tests: schema and through the action |
| H-7 | **The Google key could follow a redirect off Google** (read in code, not exercised), and the photo proxy streamed any content type at any size, with no fence (two billed calls per view). Applies when `SIDEQUEST_PLACE_PHOTOS=google`. | `api/place-photo/route.ts` | **Fixed 8d122f9.** Redirect handled manually and key sent only to `places.googleapis.com`; image hosts allow-listed; image types only; 6 MB cap; `place_photo` fence; non-Latin-1 credit no longer 404s the image. No route test: Google is off in fixture mode, so this is type-checked only |
| H-8 | **Places lookups were billed and unfenced** at arbitrary coordinates. | `itinerary/actions.ts` | **Fixed 8d122f9.** `place_lookup` fence, coordinates range-checked. Test: fence case |
| H-9 | **CR/LF injection in the empty calendar feed.** The name line was hand-assembled with only `,;\` stripped. Also: a bare CR in `escapeIcsText`, unvalidated `TZID`, and an invalid zone returning 500 from both calendar routes. | `api/calendar/[token]/route.ts`, `calendar.ts` | **Fixed 8d122f9.** One escape and fold path; unknown zones fall back; the feed answers with a valid empty calendar instead of a 500. Test: `release-hardening.test.ts` (builder level) |
| H-10 | **A window over 30 nights or a five-digit year made a trip, and the owner's whole `/trips` list, unreadable.** Writers skipped the limit that every read enforces. Owner-inflicted, not recoverable without database access. | `timing-actions.ts`, `plan/actions.ts` | **Fixed 8d122f9.** Test: oversized window case |
| H-11 | **Retention never ran on the normal path.** Its only trigger was the optional compiler, so the 60-day and 30-day promises in the privacy notice were not true. Expired sessions, sign-in attempts and address-keyed ledger rows were kept for ever. | `db/retention.ts`, `compiler/runner.ts` | **Fixed 8d122f9.** Hourly schedule from `instrumentation.ts`; four new sweeps. Test: `retention.test.ts` |
| H-12 | **Google terms (only if `GOOGLE_MAPS_API_KEY` is set).** Places coordinates are stored past the 30-day allowance and drawn on a non-Google map; `placeClass` and hours-derived notes persist; opted-in Routes durations and polylines persist; the photo credit does not name the photographer. | `placement.ts`, `assemble.ts`, `route-selection.ts` | **Needs owner. BLOCKS BETA if the key is set**: run without the key, or get legal sign-off |
| H-13 | **Open-Meteo's free tier is recorded as non-commercial** and the code calls the keyless hosts. | `docs/global-destinations/REPORT.md:133`, `weather/openmeteo.ts` | **Needs owner.** Your call whether a free invite-only beta counts as non-commercial; a commercial launch needs the paid API |
| H-14 | **`SIDEQUEST_TRUSTED_PROXY_HOPS` is optional at boot.** Without it a cookie-less client drains the deployment-wide fences, which denies Google sign-in, export and delete to everybody, and per-address limits do not exist. | `caller.ts`, `capabilities.mjs` | **Needs owner. BLOCKS BETA**: set it to 1 and verify (checklist) |
| H-15 | **Legal pages are drafts** with a placeholder liability section. | `LegalDocument.tsx`, `terms/page.tsx:69` | **Needs owner.** Review before inviting people; lawyer before public launch |

### Medium

| ID | Finding | Status |
|---|---|---|
| M-1 | A cookie spelled `x:@deployment` named a rate bucket the sweep exempts, giving unbounded permanent rows through any guarded door. | **Fixed 8d122f9**; a rate identity must match the minted alphabet. Test included |
| M-2 | The guest cookie's 180 days ran from its first mint and never renewed, so an active guest lost every trip mid-plan. | **Fixed 8d122f9**; `proxy.ts` renews the same value on `GET /trips*` and never mints. Tests: `proxy.test.ts` |
| M-3 | `advisorStepAction` is an unauthenticated CPU amplifier: up to 64 rankings of 36.8k rows per call, synchronous. Forty typical steps took 3.7–5.5 s, about 100–140 ms each. At the deployment fence (240/min) that is roughly half of the one thread. A step with a free-text phrase costs more (not measured). | Open. Bucket exists (`decide_step`, 40 burst, 30/min). Memoise a pass per request, or lower the deployment multiple if the beta shows load |
| M-4 | A crashed refinement held its lease for ever; `releaseStaleRuns` had no caller. | **Fixed 8d122f9**: released after 10 minutes. No dedicated test |
| M-5 | A router 404 from Google Routes was read as an authoritative "no route". | **Fixed 8d122f9** (opt-in path). No dedicated test |
| M-6 | Stops past midnight exported on the wrong day; DTEND could precede DTSTART. | **Fixed 8d122f9**. Test included |
| M-7 | Silent SDK retries on the free-text reader (up to 3 calls, 1 recorded). | **Fixed 8d122f9**. The optional research compiler (`live.ts:367`) still retries: open, secondary path |
| M-8 | `setCheckAction` accepted `__proto__` as a list and broke the trip's next load; booked ids, zones and URLs were unbounded or any scheme. | **Fixed 8d122f9**. Tests included |
| M-9 | Advisor adoption wrote the trip before its single-use claim (double trips), and `duplicateTripAction` was an unfenced row loop. | **Fixed 8d122f9**: transaction; `trip_create` fence |
| M-10 | `owner_token`, `share_token` and the raw cookie inside rate and ledger keys are plaintext at rest, so a database or backup read is takeover of every unclaimed trip and live share. Feed and auth tokens are hashed. | Open. Treat backups as credentials; hash in a later migration |
| M-11 | Decision sessions answer only to the cookie, even when signed in. | Open |
| M-12 | Interpreter spend uses one literal key for all travellers (80/day), so anonymous callers can switch interpretation off for the day. It degrades honestly. Literal fallback keys split the unattributed pool. | Open |
| M-13 | Undo checks no lease, so a stale Apply can save a plan and then report failure. | Open |
| M-14 | Provider outages are cached as answers: weather for 1 h to 30 d, imagery rejection for 90 d, a concept for 30 d. Contradicts unknown ≠ false. | Open |
| M-15 | A dead Valhalla never falls through to openrouteservice on direct legs; `response.text()`/`.json()` sit outside the try on two routing paths and can fail a build. | Open |
| M-16 | Process-wide provider queues have no length cap, and queue wait sits outside every timeout. | Open |
| M-17 | Server-action uploads cap at 1 MB (Next default) although the UI and schema promise 2–4 MB. Functional, and fails with a framework 413. | Open. Set `serverActions.bodySizeLimit` deliberately (performance engineer owns `next.config.ts`) |
| M-18 | `script-src 'unsafe-inline'` means the CSP does not mitigate script injection. React escaping and the absence of `dangerouslySetInnerHTML` are the real defence. `s3.amazonaws.com` is allowed for all buckets. | Open. A nonce CSP costs static rendering; narrow the S3 path |
| M-19 | Completing the questionnaire clears the itinerary before the scan fence, so a refused completion has no plan. | Open |
| M-20 | Log hygiene: 68 sites log full trip ids, some log raw error objects, and scan logs can carry up to 600 characters of model text and must-do names. No log line found carrying cookies, headers, e-mails or keys. | Open |
| M-21 | Share page: with Google photos on, the markup carries the owner's trip id and the images fail for readers. `decision.chosen` and some booked fields reach the shared model without rendering. | Open. Conditional on photos; strip in `strip.ts` before enabling |

### Low (documented)

- L-1 Existence oracle on about 24 actions (reads before the check; UUIDv4 ids).
- L-2 Anonymous callers can inflate two product-event counters (`productEvent` before the check).
- L-3 Unfenced owner write loops: party, feedback, selections, provisional actions (bounded by the action body limit).
- L-4 Untrusted text in the model `task` turn: e-mail subject, booked location, geocoder strings, anchor names. Output is validated and no URL, id or SQL comes from model text.
- L-5 `/api/readiness` is public and names capabilities, env var names and credential state (no values), and takes a write lock per hit.
- L-6 The labs gate is open off-Railway unless `SIDEQUEST_REQUIRE_CONFIG=on`. Moving host needs that set.
- L-7 `email_verified` is unused; the unique email index can lock out a second identity with the same address.
- L-8 No "sign out everywhere", and the guest cookie is not rotated at sign-in.
- L-9 `next/og` fetches fonts from Google for glyphs missing from its bundled font, including on the public share preview.
- L-10 Build and scan rows are never written as `lost` (derived on read; harmless).
- L-11 Offline cache keeps a deleted single trip's pages until full deletion.
- L-12 `safe-fetch` has only an idle timeout and quadratic text extraction (compiler path only).

Fixed Low: the privacy page's processor list now matches the code (Overture/S3, Google Routes, Overpass operators, Wikidata coordinates, Open-Meteo time zones); restore is scripted (`apps/web/scripts/restore-db.mjs`, documented in `docs/DEPLOYMENT.md`).

## Endpoint table

Authentication is the same for every action: any browser can POST, identified by `sidequest_session` or `sidequest_auth`. TAR = `tripAccessRefusal` before any write. Every secondary id is scoped to the authorised trip. "—" means none. **Bold** marks what `8d122f9` added.

| Doors | Reads/writes | Authorisation | Bucket | Validation | Spend, and its bound |
|---|---|---|---|---|---|
| **Itinerary** `buildItinerary`, `regenerateItinerary` | run, itinerary | TAR | `build_start`, `billed_hourly` if model | buildKey | ≤1 model call, ceiling |
| `removeStop`, `swapStop`, `swapAlternatives`, `easeDay`, `moveStop`, `shiftStop`, `setStopDuration`, `addCustomStop`, `setStopKeep`, `fixDay` | itinerary | TAR | — | ids matched to plan; ranges | none |
| `createShareLink`, `revokeShareLink`, `rotateShareLink` | `trips.share_token` | TAR | — | id | none |
| `toggleLock`, `setCheck` | locks, checks | TAR | — | **type and length; closed list** | none |
| `addBookedItem`, `updateBookedItem`, `removeBookedItem`, `markBooked`, `addConfirmation`, `replaceBooking`, `skipBooking`, `unskipBooking` | booked items, resolutions | TAR; row scoped | — | **narrowed input schema** | none |
| `saveReadinessProfile`, `clearReadinessProfile` | readiness | TAR | — | zod | none |
| `importConfirmation` | pending redacted extraction | TAR | **`import_prepare`** | zod, magic bytes, size | none; parse CPU |
| `readImportWithSidequest` | pending extraction | TAR; scoped | **`import_read` + `billed_hourly`** | zod | 1 model call, ceiling **by caller** |
| `previewImport`, `confirmImport`, `discardImport` | booked, imports | TAR; scoped | — | zod | none |
| `discoverStays`, `discoverFood` | none | TAR | **`place_lookup`** | **range-checked** | Places request |
| `refreshTripInformation` | caches, snapshot | TAR | **`trip_recheck`** | id | Wikidata, Commons, weather; 10-min throttle |
| `rebuildWithImprovedPlanning` | scan | TAR | `scan_start` + `billed_hourly` | id | 1–2 model calls, ceiling |
| **Refine** `refineTrip`, `answerRefinement` | runs, versions, plan | TAR | `refine` + `billed_hourly` | ≤600/≤400 | 1 model call, ceiling |
| `undoRefinement`, `refinementHistory`, `refinementReady` | versions | TAR | — | — | none |
| **Execution** `createCalendarFeed`, `revokeCalendarFeed`, `calendarFeedStatus`, `acknowledgeChange` | feeds, observations | TAR | — | ids | none |
| `recheckStaleFacts` | observations | TAR | — (6-hour per-trip throttle) | id | weather, places hours |
| **Plan** `resolveDestination` | intent | TAR | `destination_resolve` | id | geocoder; interpreter, ceiling |
| `selectInterpretation`, `saveClarificationAnswers`, `proposeScope`, `confirmScope`, `applyStrategy`, `reopenPreflight`, `decideMustDo` | intent | TAR | — | zod/manual, **must-do bounded** | none |
| `startCompilation`, `retryCompilation` | jobs | TAR | `compile_start` | id | research compile, ceiling |
| `cancelCompilation`, `compilationSnapshot` | jobs | TAR | — | id | none |
| `ensurePreflight`, `adoptTripLength` | preflight | TAR | `preflight` | id; 1–30 nights | climate, cached |
| `adoptDateWindow` | dates | TAR | — | **month + year** | none |
| **Questionnaire** `saveDraft`, `confirmInterpretation`, `generationProgress` | profile | TAR | — | answers schema | none |
| `completeQuestionnaire` | profile; may scan | TAR | `scan_start` + `billed_hourly` on scan | schema | scan |
| `completeAndBuild` | profile; generates | TAR | **`build_start`, `billed_hourly` if model** | schema | ≤1 model call, **by caller** |
| `startBuild`, `retryBuild` | run | TAR | `build_start`, `billed_hourly` if model | buildKey | ≤1 model call |
| `exploreExperiences`, `recommendTripTiming` | composer | TAR | `preflight` / `timing_recommendation` | schema | climate |
| `readUnresolvedText` | composer | TAR | `interpret_text` peek + charge | id | 1 model call, lease, cache, ceiling |
| `acceptTripTiming` | dates | TAR | — | zod, **30-night cap** | none |
| **Discover** `setSelection`, `setFoodSelection`, `autoPick`, `acknowledgeRemoval` | selections | TAR | — | enums | none |
| `fillBoardImagery`, `refreshWeather(Form)` | caches | TAR | — | id | Commons ≤10; weather, cached |
| `startDiscoveryScan` | scan | TAR | `scan_start` + `billed_hourly` | id regex | 1–2 model calls, ceiling |
| **New trip** `createTripFromComposer` | trip | stamps owner | `trip_create` | zod, **destination ≤200** | none |
| `updateTripFromComposer` | composer | TAR | — | zod | none |
| `placeDestination` | caches | pre-trip | `destination_resolve` when resolving | ≤120 | geocoder; interpreter, ceiling |
| `recommendTiming` | none | pre-trip | `timing_recommendation` | zod | climate |
| **Dashboard** `renameTrip`, `archiveTrip`, `setLifecycle` | trips | TAR | — | zod | none |
| `duplicateTrip` | trips | TAR | **`trip_create`** | id | none |
| **Party, feedback, provisional** `add/update/attach/removePerson`, `submitFeedback`, `submitAlphaFeedback`, `setProvisionalIntent` | party, feedback | TAR; `ownsTraveler` | — | zod | none |
| **Advisor** `startAdvisor` | session | stamps owner | `decide_start` | ≤600 | none |
| `saveAdvisorAnswers` | session | `decisionAccessRefusal` | — | schema | none |
| `buildAdvisorShortlist`, `refineAdvisor`, `resolveAdvisorImagery` | session, caches | same | `decide_shortlist` | manual | climate, Commons |
| `widenAdvisorShortlist` | session | same | `decide_shortlist` **+ `billed_hourly`** | id | 1 model call, cache, ceiling **by caller** |
| `advisorStep` | nothing stored | none needed | `decide_step` | schema | CPU only (M-3) |
| `adoptAdvisorPick` | trip | same | **`trip_create`** | pick in shortlist | none |
| **Account** `deleteTrip` | cascade | TAR | — | uuid | none |
| `saveProfile`, `dismiss/restore/confirmLearned` | account | self | — | zod | none |
| `deleteAllMyData` | cascade | account + cookie | `data_rights` | typed phrase | none |
| `signOut`, `claimBrowserTrips`, `unclaimedTripCount` | sessions, trips | presented cookie and unclaimed only | — | — | none |
| `fixtureSignIn` | users | refused unless the fixture door is open | `trip_create` | zod | none |
| **Labs** (11 actions) | benchmark | `labsAccessGranted` first | — | zod/manual | budget-bounded when live |
| **Routes** `GET trips/[id]/card`, `days/[n]/card`, `itinerary/calendar` | read | `ownedTrip` / TAR | — | id | none; **no-store on .ics** |
| `GET /api/calendar/[token]` | read | SHA-256 token, `revoked_at IS NULL` | — (bounded per request after H-1) | ≥32 chars | none |
| `GET /api/trips/[id]/progress`, `/scan` | read | TAR | — | regex | none |
| `GET /share/[token]`, OG image | read | exact token | — | — | none |
| `GET /api/place-photo` | read | TAR | **`place_photo`** | ids | 2 Places requests |
| `GET /api/me/export` | read | account + cookie | `data_rights` | — | none |
| `GET /api/auth/google/start`, `callback` | auth | state + binding cookie + PKCE | `auth_start` / state-gated | `safeReturnTo` | Google |
| `POST /api/client-failure` | log line | none | `client_failure_report` | clipped | none |
| `GET /api/destinations/suggest` | local index | none | — | ≤320 | none |
| `/api/destinations/index` | index | POST: admin token, constant-time | — | path containment | none |
| `GET /api/health`, `/api/readiness` | read | none | — | — | cached probes |

## Sessions, accounts, platform

- **Auth cookie:** httpOnly, Lax, Secure in production, 90 days absolute; token hashed at rest; logout deletes the row; a new token is minted at every sign-in.
- **Guest claim:** moves only rows where `owner_token` equals the presented cookie and `user_id IS NULL`. A claimed trip refuses its original cookie (tested).
- **OAuth:** state bound by an HMAC cookie, 10 minutes, single use, PKCE; redirects built only from `SIDEQUEST_BASE_URL`; accounts keyed on provider subject, never linked by e-mail; no open redirect found.
- **Fixture auth:** refused in production without `SIDEQUEST_AUTH_FIXTURE=allow`, and a hosted start refuses fixture switches. There is no password or OTP flow.
- **Headers as served by a production build (port 4430):** CSP, nosniff, DENY, HSTS, referrer and permissions policies; noindex on `/share`, `/trips`, `/api`; no `x-powered-by`; `/_next/image` is 404.
- **Server actions:** Next's Origin-vs-Host check is unweakened.
- **XSS and SQL:** no `dangerouslySetInnerHTML` in `apps/web/src`; every statement binds request-derived values; rendered links are http(s) or neutralised by React.
- **SSRF:** no traveller- or model-influenced host in any client; third-party URLs go through `safe-fetch`.
- **Secrets:** a scan of 1,944 tracked files found only test placeholders; `.next/static` has 0 key-shaped strings and 0 secret env names; the committed fixture database scanned clean.

## Data safety

**Migration.** The schema is unchanged between `main` and this branch (one comment differs); `SCHEMA_USER_VERSION` stays 9. The real test is `lib/db/existing-trips-survive.test.ts`: a database written by `main` @ 6aa0dc1, built and driven through 47 browser journeys (41 trips, 33 built plans, 3 accounts, shares, a feed, bookings, refinement versions, old Help-me-choose sessions). This branch opens it and proves:
- no row or column lost; integrity and foreign keys clean;
- owners and share tokens unchanged;
- every plan readable, none stale;
- owner and shared view models built for every plan; calendars served;
- old sessions re-enter;
- export and delete work;
- a second open changes nothing.

**Backup and restore.** `backup-db.mjs` and the new `restore-db.mjs` are tested as real processes (`backup-restore.test.ts`): committed rows that exist only in the WAL are captured, a live server is refused, a crash's stale `-wal` cannot replay, the replaced file is kept, and a corrupt or foreign backup is refused.

**Retention and deletion.** Account and trip deletion cascade (`data-rights.test.ts`). What lingers after a delete: the day's ledger and rate rows (now swept after 2 days), `provider_cache` (traveller wording under a 30-day key, not identity-linked), operational logs, and backups until they rotate.

**Personal data leaving the system:** Anthropic, Google (if configured), OSM services, routers, Open-Meteo, Wikimedia/Wikidata, Overture/S3, Railway, as now listed on `/privacy`.

## Reliability

Builds and scans attach on double press, heartbeat every 10 s, read as `lost` after 60/90 s, and failures inside `after()` mark the row. Retry reuses a saved draft with no model call. Every outbound call has a timeout. Model calls are bounded by per-door buckets, `billed_hourly`, a per-caller and anonymous share, and a global ceiling. Reservations are not refunded on failure, by design.

## Supply chain

`npm audit --omit=dev`: **0 production vulnerabilities**. Full audit: 14 (12 moderate, 2 high), all reported in dev tooling (vitest, vite, minimatch, brace-expansion). None ship. Left alone to keep `package-lock.json` merge-clean across the parallel worktrees; run `npm audit fix` after they merge.

## Licensing

Production code licences are permissive except optional LGPL `sharp`/libvips binaries, which are server-side and unused because the image optimizer is off. There is no third-party notices file.

| Gap | Class | Action |
|---|---|---|
| Atlas ships 26,834 verbatim Wikivoyage first sentences (`pitch`, CC BY-SA 4.0) that no UI renders | Owner | Drop `pitch` in the next atlas rebuild, which removes the share-alike question, or decide the artifact's licence |
| ODbL share-alike on stored and exported trips; public Nominatim, Overpass and Valhalla are documented as evaluation-only | Owner | `docs/osm-database-boundary.md` requires review before public deployment or export |
| Google terms (H-12) | Owner | See checklist |
| No Commons credit on the cover band and the board feature card; Today has no Open-Meteo credit; JourneyMap hides its credit on phones; InteractiveMap omits terrain | Code | Left to the UX engineer (trip page and map components) |
| Advisor interview lacks `DataAttribution` | Code | UX engineer |
| potion-base-8M, OFL fonts and MapLibre licence text, and a notices file, are not shipped | Code/owner | Add a `/credits` or NOTICE file before public launch |
| Per-record Overture licence (Apache/Foursquare notice) not shown | Code | Suspected; check live rows |

## Accessibility

`e2e/benchmark-a11y.spec.ts` passes. An axe pass (WCAG 2.0/2.1 A and AA) on a production fixture build found **0 violations** on `/`, `/decide`, `/signin`, `/privacy`, `/terms`, `/support`, `/trips`, `/trips/new` and `/profile`. These were signed-out, empty-state renders; built trip pages were not scanned and belong with the UX engineer's pass.

## Tests run

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| eslint on changed files | pass, except one existing error at `advisor-actions.ownership.test.ts:66`, already on `main` |
| `npm run test` (once, before the last edits) | 8866 passed, 6 tests failed, 4 further files failed to load. The 4 advisor failures were test cookies that needed updating for the new identity rule; they now pass. The 2 `map-vendor` failures needed a build; they now pass. The 4 `planning/acceptance/*-replay` files read `.claude-private/`, which a worktree lacks, so they did not run here |
| Affected suites after the last edits | pass (141 in `lib/net` + advisor + audit; 188 in hardening + backup + existing-trips + execution) |
| `npm run build` | pass |
| `PORT=4430 playwright e2e/accounts e2e/share e2e/benchmark-a11y e2e/v9-pack --project=desktop` | 22 passed |

New tests: `ownership-release-audit.test.ts` (32 doors as stranger, no cookie and guest-on-claimed; secondary ids), `release-hardening.test.ts`, `existing-trips-survive.test.ts`, `backup-restore.test.ts`, plus cases in `proxy.test.ts` and `retention.test.ts`.

## Owner checklist

**Before inviting anyone (BLOCKS BETA)**
1. Railway → Variables: set `SIDEQUEST_TRUSTED_PROXY_HOPS=1`. Then from a known IP, trigger a limit and confirm it is per-connection, and confirm a client-sent `X-Forwarded-For` prefix does not change the result.
2. Decide Google: leave `GOOGLE_MAPS_API_KEY` unset, or take legal advice on H-12 first. Keep `SIDEQUEST_ROUTES/TRAFFIC/TRANSIT_PROVIDER` off Google.
3. Set `SIDEQUEST_DAILY_MODEL_CALLS` deliberately (for example `100`; the default is 800). Set a hard monthly spend limit in the Anthropic console.
4. Volumes → `@sidequest/web-volume` → Backups: schedule a daily backup, take one before this deploy, and do one restore drill with `restore-db.mjs` on a copy.
5. Read `/privacy`, `/terms` and `/support`; set `SIDEQUEST_SUPPORT_EMAIL` to a monitored address.
6. Confirm `SIDEQUEST_ACTION_FENCES`, `SIDEQUEST_SECURE_COOKIES`, `SIDEQUEST_FIXTURES` and every `*_PROVIDER=fixture` are absent from production (`npm run doctor -- --probe`; check names only, never print values).

**Key rotation (recommended before the beta).** Rotate `ANTHROPIC_API_KEY`, `OPENROUTESERVICE_API_KEY` and `GOOGLE_OAUTH_CLIENT_SECRET` if any has been shared or used on a developer machine. Rotate `SIDEQUEST_LABS_TOKEN` and `SIDEQUEST_ADMIN_TOKEN` to 32+ random characters. Do not change `SIDEQUEST_SESSION_SECRET` casually: it affects token signing and the OAuth binding.

**Monitoring**
1. Uptime check on `/api/health`, and an alert when `/api/readiness` is not ready.
2. A Railway log drain with 30-day retention. Logs do not survive a deployment today.
3. An error tracker fed from `onRequestError`.
4. Alerts at 50% and 90% of the daily ceiling (`daily_provider_spend`).

**Before a public launch**
1. Lawyer review of terms and privacy, special-category data (diet and accessibility), and the Anthropic transfer.
2. Off-platform encrypted backups. They hold live guest credentials (M-10).
3. Open-Meteo commercial plan.
4. A commercial or self-hosted geocoder, Overpass and router.
5. ODbL and Wikivoyage share-alike decisions.
6. A human check before a new identity's first billed call.
7. Set `SIDEQUEST_REQUIRE_CONFIG=on` if the app ever leaves Railway.
