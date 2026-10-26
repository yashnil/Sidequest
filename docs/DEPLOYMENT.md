# Deploying Sidequest (private alpha)

## Architecture

One Railway service (`@sidequest/web`, project `diligent-celebration`, environment `production`):

- **Build:** Railpack, Node 22.21 (`.nvmrc`), `npm run build --workspace=@sidequest/web`.
- **Start:** `npm run start --workspace=@sidequest/web` (`next start`, binds the platform's `PORT`).
- **One replica.** SQLite on a Railway volume mounted at `/data`; the database is `/data/sidequest.db` (WAL mode).
- **Health:** `GET /api/health` (database `SELECT 1`, used by Railway's health check). **Readiness:** `GET /api/readiness` (every capability, with a `ready` / `degraded` / `broken` verdict and the traveller-facing consequence; no secrets, no paths).
- **Restart:** `ON_FAILURE`, up to 10 retries.
- **Deploys:** a push to `main` on GitHub (`yashnil/Sidequest`) builds and deploys automatically. Settings are in `railway.json` (config as code). Its watch patterns include `packages/**`, so a fix in the shared packages should redeploy too. **Unverified:** after the first deploy with `railway.json`, Railway recorded the file's fields but still reported the dashboard's watch pattern (`/apps/web/**`). Set Service → Settings → Watch Paths to match `railway.json`, or confirm with a `packages/`-only commit.
- **Background work:** discovery scans and builds run in the same process after the response (`after()`), with heartbeats and durable rows (`discovery_scans`, `generation_progress`). A deploy or a crash during one leaves it `lost`. The traveller sees that, and pressing Build again resumes from saved answers.

### Why this is enough for a private alpha, and where it stops

Single-instance SQLite on a volume is durable across restarts and redeploys (verified 2026-10-06; see the checklist). It is **not** highly available:

- A deploy has a short unavailable window while the new container takes the volume.
- One process serves everyone.
- A lost volume loses everything since the last backup.

Do not add replicas. SQLite on one volume cannot be shared. Outgrowing this means moving to Postgres; that is a public-beta decision, not an alpha one.

## Environment contract

### Required (the server refuses to start on Railway without these)

| Variable | Rule |
|---|---|
| `SIDEQUEST_DB_PATH` | Absolute, under the mounted volume (`/data/sidequest.db`). |
| `SIDEQUEST_SESSION_SECRET` | 32+ random characters. Changing it signs everyone out of their trips. |
| `SIDEQUEST_BASE_URL` | The public `https://` URL. Never `localhost` or `*.railway.internal`. |
| *(fixture switches)* | None of `SIDEQUEST_*_PROVIDER=fixture` in production. |

Enforced by `requiredConfigProblems` (`apps/web/src/lib/providers/capabilities.mjs`), at start (`instrumentation.ts`) and in `npm run doctor`. A refused start fails the health check, so Railway keeps the previous deployment serving.

### Required for trips to be generated (readiness says `broken` without it)

| Variable | Without it |
|---|---|
| `ANTHROPIC_API_KEY` | Discovery scans and board-less trips cannot be generated. Existing trips stay readable. |

### Strongly recommended

| Variable | Without it |
|---|---|
| `SIDEQUEST_FETCH_USER_AGENT` | Must name a real contact (`Sidequest/1.0 (you@example.com)`). Nominatim's policy requires it, and may block a placeholder. |
| `GOOGLE_MAPS_API_KEY` | Proposed places are placed by Nominatim only. A live Seoul scan placed 16 of 27, against 30 of 32 for Tokyo with Places. |
| `SIDEQUEST_POI_PROVIDER=overpass` (+ `SIDEQUEST_POI_URL` for your own endpoint) | Meals give area-level advice instead of named venues. |
| `SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice` + `OPENROUTESERVICE_API_KEY` | Travel times are labelled distance estimates. |
| `SIDEQUEST_TRUSTED_PROXY_HOPS` | **Set to `1` on Railway.** Railway's edge appends the client address it observed to `X-Forwarded-For`, so the address is the last element (`lib/net/caller.ts` counts that many hops from the right; the client can only prepend). Without it the app cannot attribute a request to an address at all: spend falls back to the session cookie, which any script can mint, and cookie farming is bounded only by the new-spender bucket and the deployment fences. Verify after a deploy: from a known IP, check a rate-limited refusal is per-connection (or dump the header once from a debug route) — if Railway ever adds a second proxy hop, the value becomes `2`. |
| `SIDEQUEST_DAILY_MODEL_CALLS` | Global model-call ceiling per UTC day. **Default 800** (`lib/compiler/daily-ceiling.ts`); `SIDEQUEST_DAILY_LIVE_COMPILATIONS` defaults to 60. Each caller (account, trusted address or signed cookie) gets 10%. At Opus rates 800 calls can be hundreds of dollars a day, so set it deliberately — e.g. `100` for a small alpha. |
| `SIDEQUEST_ANONYMOUS_SPEND_SHARE` | Fraction (0–1, default `0.75`) of each daily ceiling that callers who are not signed in may use between them. The rest is reserved for signed-in accounts, so an anonymous flood cannot starve them. `1` turns the reservation off. |
| `SIDEQUEST_NEW_SPENDERS_PER_HOUR` | How many cookie-only identities (no trusted address, not signed in) may start spending per hour, deployment-wide (default `30`). A browser is admitted once per day; this is what stops a cookie farm from getting a fresh allowance per cookie. Has no effect on `ip:` or `user:` callers. |
| `SIDEQUEST_SUPPORT_EMAIL` | The contact address shown on `/support`, `/privacy` and `/terms`. Unset, the pages say no address has been published — Sidequest never invents one. |

### Optional

`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (sign-in; both or neither, and the redirect URI must be `${SIDEQUEST_BASE_URL}/api/auth/google/callback`), `SIDEQUEST_LABS_TOKEN` (opens `/labs`), `SIDEQUEST_INDEXABLE=on` (allow search engines; off for the alpha), `SIDEQUEST_WEATHER_PROVIDER` / `SIDEQUEST_CLIMATE_PROVIDER` (`openmeteo`), `SIDEQUEST_IMAGERY_PROVIDER` (`wikimedia`), `SIDEQUEST_MAP_*`.

### Development only (never in production)

`SIDEQUEST_COMPOSER_PROVIDER=fixture`, `SIDEQUEST_COMPILER_PROVIDER=fixture`, `SIDEQUEST_FIXTURES=allow`, `SIDEQUEST_FIXTURE_NOW`, `SIDEQUEST_AUTH_PROVIDER=fixture`, `SIDEQUEST_PLACES_FIXTURE`, `SIDEQUEST_ROUTES_FIXTURE`, `SIDEQUEST_SECURE_COOKIES=off`, `SIDEQUEST_ACTION_FENCES=off`.

### Spend controls (what bounds an abusive client)

Every billed door — a Discovery scan, a model-composed build (a planner build is free and is not charged), a refinement interpretation — passes, in order:

1. its own per-minute fence (`scan_start`, `build_start`, `refine` in `lib/net/rate-limit.ts`), per identity and deployment-wide (8×);
2. `billed_hourly`: 12 billed presses an hour per identity across all doors, plus a deployment-wide 96;
3. the daily ledger (`lib/compiler/daily-ceiling.ts`): the caller's 10% share, the anonymous pool (`SIDEQUEST_ANONYMOUS_SPEND_SHARE`), the new-spender admission for cookie-only callers (`SIDEQUEST_NEW_SPENDERS_PER_HOUR`), then the global ceiling.

The caller key is the signed-in account first, then the trusted address (`SIDEQUEST_TRUSTED_PROXY_HOPS`), then a signed session cookie the browser actually presented. A cookie can never reset its own allowance: "Delete all my data" keeps the day's ledger and rate rows, and a fresh cookie must be admitted before it spends. Still recommended before a public launch: a human check (e.g. Turnstile) or sign-in before a new identity's first billed call, and alerts at 50% / 90% of the ceiling.

Check any environment with `npm run doctor -- --probe`. It ends with "Can this deployment serve a traveller right now?", using the same verdicts as `/api/readiness`.

## Ownership and sharing (what the alpha actually is)

- **Anonymous by default.** A trip belongs to the browser that made it (an httpOnly session cookie). Another browser, or a cleared cookie, cannot see or edit it. Every page, server action, the calendar export, and the progress and scan APIs answer "not found" to a stranger.
- **This is not account sync.** Clearing cookies loses access to a trip unless the traveller signed in with Google (when configured), which claims the browser's trips to the account.
- **Share links** (`/share/<128-bit token>`) are read-only copies built for a public audience. They carry no trip id, no booking references, no notes, no party diet or accessibility facts, and no owner controls. They do show the plan's next actions, read-only, and its estimated budget ranges.
- **Calendar feeds** (`/api/calendar/<256-bit token>`) are revocable and carry no references, notes or costs.
- **Download and delete.** `/profile` → "Your data" (also reachable signed out) offers "Download my data" (`GET /api/me/export`, JSON, credentials stripped), "Delete this trip" and "Delete all my data" (typed confirmation). Signed in, the last deletes the account (`users` cascades sessions, people, evidence, saved ideas, dismissals and its trips); signed out, every unclaimed row the browser cookie owns. Trip rows cascade from `trips`; the three tables that name a trip without a foreign key are cleared explicitly (`lib/db/data-rights-repository.ts`, completeness checked by `data-rights.test.ts`). The day's spend ledger and rate buckets are kept. Railway volume backups still hold deleted rows until they rotate.
- **Legal pages.** `/privacy`, `/terms` and `/support` describe what the code collects and where it is sent. They are marked **draft** and need owner/legal review before a public launch; link them from the chrome footer, `/signin` and the share page.
- **Google sign-in** binds the OAuth `state` to the starting browser with a 10-minute httpOnly `sidequest_oauth` cookie (path `/api/auth`, one-time) and also requires the same `sidequest_session` cookie at the callback (login CSRF). `/api/auth/google/start` is rate limited (`auth_start`).

## Backup and restore

The database is one file, `/data/sidequest.db`, plus its `-wal` and `-shm` files while the app runs.

**Primary: Railway volume backups.** Service → Volumes → `@sidequest/web-volume` → Backups. Take one before every deploy that changes the schema, and schedule a daily one.

**Portable copy** (needs `railway ssh`, which needs an SSH key added to the Railway account):

```
railway ssh -p diligent-celebration -e production -s @sidequest/web -- \
  node apps/web/scripts/backup-db.mjs /data/sidequest.db /data/backup-$(date +%Y%m%d).db
```

`backup-db.mjs` uses SQLite's online backup API, which is safe while the app is writing, unlike `cp`. It then runs `integrity_check` and prints row counts for the traveller tables. Copy the file off the volume before relying on it.

**Restore:**
1. Take a backup of the current state first.
2. Stop the service (scale to 0, or remove the start command).
3. Replace `/data/sidequest.db` with the backup, and delete `sidequest.db-wal` and `sidequest.db-shm`.
4. Start the service.
5. Check `/api/readiness` reports database `ready`.

The round trip was tested locally on 2026-10-06: backup, row counts equal, `integrity_check` ok, production build served from the restored file.

**Redeploys and crashes:** the volume survives both. A crash mid-scan or mid-build leaves that job `lost`, never half-saved. The trip and its answers are intact.

## Rollback

Railway → Deployments → pick the last good deployment → **Redeploy**, or `railway redeploy` after reverting the commit on `main`. Schema changes are additive (`CREATE TABLE IF NOT EXISTS`, nullable columns), so an older build reads a newer database. Restore a backup only if the data itself is wrong.

## Logs

`railway logs -p diligent-celebration -e production -s @sidequest/web -n 2000` (add `--json` for structured fields).

- `sidequest_event` lines are product counters: trip_created, interview_completed, discovery_completed/failed, auto_pick_used, build_completed (planner mode, fallback reason, measured/estimated/unmeasured leg counts), build_failed, itinerary_opened, regenerate_used, export_used, share_created, feedback_submitted. They carry an 8-character trip reference and enumerated facts, never trip content.
- `Discovery scan proposal …` / `Discovery scan unplaced …` / `Discovery scan supplement …` give each scan's own account. The full record is on `discovery_scans.extras_json.diagnostics`.
- `Build failed {ref, kind, cause, where}` is keyed by the reference the traveller is shown.
- `Planner fallback {plannerFallbackReason}` appears whenever a trip was not planner-built.

- `{"event":"sidequest_request_error",…}` is one JSON line per server error caught by Next (`instrumentation.ts#onRequestError`): `requestId` (minted by `proxy.ts` for every page, action and API request, and returned as the `x-request-id` response header), `edgeRequestId` (Railway's `x-railway-request-id`), the route *pattern*, method, context, error name, digest and a clipped, key-redacted message. Never headers, cookies, bodies or query strings. Search by the id a traveller reports: `railway logs … | grep <id>`.

Railway keeps only the current deployment's log window. Read logs before redeploying if you need them. For a public launch, add a log drain with retention and an error tracker fed from `onRequestError`.

## Security headers

`next.config.ts` serves a CSP (map tiles from `tiles.openfreemap.org` and AWS terrain tiles from `s3.amazonaws.com` in `img-src`/`connect-src`), HSTS, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a `Permissions-Policy` that refuses camera, microphone, geolocation, payment and the other powerful features (nothing uses them). `/share/*`, `/trips/*`, `/api/*`, `/profile` and `/labs/*` also send `X-Robots-Tag: noindex, nofollow`. The image optimizer is off (`images.unoptimized`; `/_next/image` answers 404) because nothing uses `next/image`. With `SIDEQUEST_INDEXABLE=on` and `SIDEQUEST_BASE_URL` set, `robots.txt` names `/sitemap.xml`, which lists `/`, `/decide`, `/privacy`, `/terms` and `/support` only.

## Dependencies

Run `npm audit --omit=dev --audit-level=high` before every deploy (add it to CI). On 2026-10-24 production dependencies had 0 advisories after upgrading `next` 16.3.4 → 16.4.3, `zod` → 4.6.7, `postal-mime` 3.0.0 → 4.1.4, `sharp` → 0.35.5 and `source-map-js` → 1.2.2.
