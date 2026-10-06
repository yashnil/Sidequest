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
| `SIDEQUEST_DAILY_MODEL_CALLS` | Global model-call ceiling per day (default 20). Each caller gets 10%, i.e. 2 scans a day at the default. Raise it for an alpha with real testers. |

### Optional

`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (sign-in; both or neither, and the redirect URI must be `${SIDEQUEST_BASE_URL}/api/auth/google/callback`), `SIDEQUEST_LABS_TOKEN` (opens `/labs`), `SIDEQUEST_INDEXABLE=on` (allow search engines; off for the alpha), `SIDEQUEST_WEATHER_PROVIDER` / `SIDEQUEST_CLIMATE_PROVIDER` (`openmeteo`), `SIDEQUEST_IMAGERY_PROVIDER` (`wikimedia`), `SIDEQUEST_MAP_*`.

### Development only (never in production)

`SIDEQUEST_COMPOSER_PROVIDER=fixture`, `SIDEQUEST_COMPILER_PROVIDER=fixture`, `SIDEQUEST_FIXTURES=allow`, `SIDEQUEST_FIXTURE_NOW`, `SIDEQUEST_AUTH_PROVIDER=fixture`, `SIDEQUEST_PLACES_FIXTURE`, `SIDEQUEST_ROUTES_FIXTURE`, `SIDEQUEST_SECURE_COOKIES=off`, `SIDEQUEST_ACTION_FENCES=off`.

Check any environment with `npm run doctor -- --probe`. It ends with "Can this deployment serve a traveller right now?", using the same verdicts as `/api/readiness`.

## Ownership and sharing (what the alpha actually is)

- **Anonymous by default.** A trip belongs to the browser that made it (an httpOnly session cookie). Another browser, or a cleared cookie, cannot see or edit it. Every page, server action, the calendar export, and the progress and scan APIs answer "not found" to a stranger.
- **This is not account sync.** Clearing cookies loses access to a trip unless the traveller signed in with Google (when configured), which claims the browser's trips to the account.
- **Share links** (`/share/<128-bit token>`) are read-only copies built for a public audience. They carry no trip id, no booking references, no notes, no party diet or accessibility facts, and no owner controls. They do show the plan's next actions, read-only, and its estimated budget ranges.
- **Calendar feeds** (`/api/calendar/<256-bit token>`) are revocable and carry no references, notes or costs.

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

Railway keeps only the current deployment's log window. Read logs before redeploying if you need them.
