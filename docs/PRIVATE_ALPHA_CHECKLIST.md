# Private alpha checklist

Deployment details, the environment contract, backup and rollback are in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Before deploy

- [ ] `git diff --check`, `npm run typecheck`, `npm run lint` (0 errors), `npm run test`, `npm run build`, all green.
- [ ] Browser suite: `npx playwright test e2e/canonical-plan.spec.ts e2e/itinerary.spec.ts e2e/trip-hub.spec.ts e2e/live-world.spec.ts e2e/discovery-scan.spec.ts e2e/alpha-feedback.spec.ts --project=desktop`.
- [ ] Failure behaviour on the production build: `npx playwright test -c playwright.degraded.config.ts` (no spend).
- [ ] Environment, checked by name (never print values): `railway variables -p diligent-celebration -e production --json` piped through a key-only filter.
  - [ ] Required: `SIDEQUEST_DB_PATH=/data/sidequest.db`, `SIDEQUEST_SESSION_SECRET` (64 chars), `SIDEQUEST_BASE_URL=https://…`, no fixture switches.
  - [ ] `ANTHROPIC_API_KEY` set.
  - [ ] `SIDEQUEST_FETCH_USER_AGENT` names a real contact, not `<your-email>`.
  - [ ] `SIDEQUEST_DAILY_MODEL_CALLS` sized for the number of testers (each caller gets 10%).
  - [ ] Recommended: `GOOGLE_MAPS_API_KEY`, `SIDEQUEST_POI_PROVIDER=overpass`, openrouteservice (key present).
- [ ] Volume `@sidequest/web-volume` is mounted at `/data`.
- [ ] A Railway volume backup was taken (Volumes → Backups).
- [ ] Note the current deployment id, for rollback.

## After deploy

- [ ] Deployment `SUCCESS`: `railway deployment list -p diligent-celebration -e production -s @sidequest/web`.
- [ ] `curl -s $URL/api/health` → `{"ok":true,"database":"ready"}`.
- [ ] `curl -s $URL/api/readiness` → `"ready": true`. Read every `degraded` row's `consequence` and make sure each is a degradation you accept.
- [ ] Free smoke at three widths: `SIDEQUEST_ALPHA_URL=$URL npx playwright test -c playwright.alpha.config.ts smoke` (add `SIDEQUEST_ALPHA_SHARE_URL=<a share link>` to cover the share page).
- [ ] Build one real trip and prove persistence (one model call):
  1. `SIDEQUEST_ALPHA_URL=$URL SIDEQUEST_ALPHA_LIVE=1 SIDEQUEST_ALPHA_PHASE=create SIDEQUEST_ALPHA_STATE=<file> npx playwright test -c playwright.alpha.config.ts persistence --project=desktop`
  2. `railway redeploy -p diligent-celebration -e production -s @sidequest/web -y`, and wait for `SUCCESS`.
  3. The same command with `SIDEQUEST_ALPHA_PHASE=verify`. The itinerary, board decision, calendar feed and share link survive; a stranger sees only the share page.
- [ ] Share test: open the share link in a private window; no notes, references, party facts or owner controls.
- [ ] Calendar test: the feed URL from Pack returns `BEGIN:VCALENDAR`, with URLs on `SIDEQUEST_BASE_URL`.
- [ ] Logs: `railway logs … | grep sidequest_event` shows the run's `trip_created` … `build_completed` with `mode` = `planner`.

## Known limitations (tell alpha testers)

- **Routing:** travel times are estimates unless openrouteservice answers. Estimates are always labelled, never shown as measured.
- **Transit:** strategy-level only (metro/rail/bus by distance). No live timetables, no live traffic.
- **Food:** with no food provider configured, meals are area-level advice ("lunch around X") rather than named restaurants. Nothing is booked, and opening hours are often unconfirmed.
- **Place coverage:** without Google Places, some well-known places do not place, especially where the map knows only the local-language name. Scans now also try the local name.
- **Safety, legal and entry rules:** coverage is incomplete. Sidequest links official sources and never confirms a visa, health or advisory rule itself.
- **Export:** PDF is the browser's print-to-PDF, not a generated file. Calendar export and feed are native (ICS).
- **Accounts:** a trip belongs to the browser that made it unless the traveller signs in. Clearing cookies loses access.
- **Architecture:** single-instance SQLite on one volume. Deploys have a short unavailable window, there is no high availability, and backups are manual or volume snapshots.
- **Model allowance:** each tester gets 10% of the daily model-call ceiling. Past it, scans are refused with a plain message until the next day.

## Rollback

1. Railway → Deployments → the last good deployment → **Redeploy**. Or revert the commit on `main` and push, which redeploys.
2. Check `/api/health` and `/api/readiness`.
3. Restore a volume backup only if data, rather than code, went wrong (see `DEPLOYMENT.md`).
