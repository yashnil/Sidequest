# Owner acceptance — what needs your Google account or your dashboards

Staging: `https://sidequestweb-staging.up.railway.app`. About 20 minutes. Use a desktop browser and a phone.
Fixture sign-in proves nothing here — every step below is real Google OAuth.

## Already verified without your account (2026-11-15)

- `/api/auth/google/start` redirects to Google with PKCE (`S256`), `prompt=select_account`, scope `openid email profile`,
  `redirect_uri=https://sidequestweb-staging.up.railway.app/api/auth/google/callback`, and sets a 10-minute
  `Secure; HttpOnly; SameSite=lax` `sidequest_oauth` cookie on path `/api/auth`.
- Google answers that redirect with its account chooser (not `redirect_uri_mismatch` / `invalid_client`), so the
  staging client ID and callback are registered.
- `SIDEQUEST_SECURE_COOKIES=on`, `SIDEQUEST_BASE_URL` is the staging origin, `/labs*` returns 404, `/api/readiness` is ready.

## A. Sign in and persistence (desktop)

1. Open staging in a private window. Start a trip from the home page *before* signing in (any destination); stop at the questionnaire.
2. Press **Sign in** → choose your Google account. Expect to return to where you were, and an offer to keep this browser's trip on your account. Accept.
3. Finish the trip through the board and build. Note the trip URL.
4. **Sign out** (profile). The trip URL now shows the "not yours / sign in" state, not the plan.
5. Sign in again. The trip is in your list and opens.
6. Close the browser entirely, reopen staging (not private): you are still signed in (90-day session).

## B. Ownership isolation

7. In a second browser (or another Google account), open the trip URL from step 3. Expect no plan and no owner controls.
8. In that second browser, open `/api/me/export`: it lists none of your trips.

## C. Share and revoke

9. Owner: trip → **Share** → create a read-only link. Open it in the second browser: plan visible, no booking refs, notes, party needs, or edit controls.
10. Owner: **Revoke** the link. Reload in the second browser: the link no longer shows the plan.

## D. Account preferences

11. Profile → edit travel preferences, save, reload: they stick.
12. Profile → learned preferences: dismiss one; switch learning **off**; reload — the switch stays off.
13. Profile → **Download my data**: the JSON contains your account and the trip, no session tokens.

## E. Mobile session

14. On a phone, sign in with the same account. The trip from step 3 is listed and opens; Today and Pack work.
15. Sign out on the phone; the desktop session stays signed in (sessions are per device).

## F. Dashboards (no code change needed; record the answers)

- **Anthropic console** → billing: confirm a monthly spend limit is set for the staging key. The app itself caps
  model calls at `SIDEQUEST_DAILY_MODEL_CALLS=300` per day.
- **Google Cloud console** → APIs: confirm budget alerts / quotas on the Maps key (Places is the only billed Google API in use).
- **Google OAuth consent screen**: publishing status. In "Testing", only listed test users can sign in — add beta users or publish.
- **Railway** → `@sidequest/web` volume → Backups: confirm a daily backup schedule exists (the CLI cannot read it).
  Procedure and tested scripts: `docs/DEPLOYMENT.md#backup-and-restore`.
- **Support address**: `SIDEQUEST_SUPPORT_EMAIL` is unset on staging, so the legal pages say no address is published yet.
- **Legal**: `/privacy`, `/terms`, `/support` were updated for the beta but remain marked draft: fill in the operator's
  legal entity, governing law and any liability cap, and have them reviewed.

Report any step that differs, with the time it happened (staging logs: `railway logs -e staging -s @sidequest/web`).
