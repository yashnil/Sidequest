# Sidequest PDF renderer

Prints the dedicated guide layout (`/trips/<id>/guide?variant=compact|complete`) to an A4 PDF with
headless Chromium. The web app never runs a browser itself; it calls this service.

## Contract

`POST /render` with header `x-renderer-secret: <RENDERER_SECRET>` and a JSON body:

```json
{ "url": "https://<app>/trips/<id>/guide?variant=compact&t=<token>", "timezone": "America/Los_Angeles", "locale": "en-GB" }
```

Answers `200 application/pdf`, `401` (bad secret), `400` (origin not allowed / bad body), `502` (the page did
not load) or `500`. `GET /health` answers `ok`.

- One long-lived browser; every job gets a fresh context (no cookies, storage or cache shared between trips).
- The browser context's time zone is the trip's (`timezone`), so nothing on the page can drift to the server's zone.
- The page is printed with CSS paged media (`preferCSSPageSize`): the layout, margins, running header and page
  numbers all come from the guide's own stylesheet.
- It waits for `document.fonts.ready` and every image to decode before printing.
- Requests are limited to `RENDERER_ALLOWED_ORIGINS` plus Wikimedia (photographs); everything else is aborted.
- The token in the URL is minted by the web app for one trip, one variant and five minutes; the service never
  logs query strings.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `RENDERER_SECRET` | yes | Shared secret; must equal the web app's `SIDEQUEST_PDF_RENDERER_SECRET`. |
| `RENDERER_ALLOWED_ORIGINS` | yes | Comma-separated origins the renderer may print, e.g. `https://sidequest.example,http://web.railway.internal:8080`. Must include the origin in `SIDEQUEST_PDF_SOURCE_URL` (or `SIDEQUEST_BASE_URL`). |
| `PORT` | no | Listen port (default 8080). |
| `RENDERER_CONCURRENCY` | no | Jobs printed at once (default 2). Each Chromium page needs roughly 150–250 MB. |
| `RENDERER_JOB_TIMEOUT_MS` | no | Navigation and print timeout per job (default 60000). |

Web app side (`apps/web`):

| Variable | Meaning |
| --- | --- |
| `SIDEQUEST_PDF_RENDERER_URL` | This service's base URL, e.g. `http://pdf-renderer.railway.internal:8080`. |
| `SIDEQUEST_PDF_RENDERER_SECRET` | Same value as `RENDERER_SECRET`. |
| `SIDEQUEST_PDF_SOURCE_URL` | Optional. The origin this service can reach the web app on; defaults to `SIDEQUEST_BASE_URL`. |

Without the first two, the export opens the print layout in the traveller's own browser (`?print=1`) instead —
the same pages, printed by their browser.

## Run locally

```sh
cd services/pdf-renderer
npm install && npx playwright-core install --only-shell chromium
RENDERER_SECRET=dev RENDERER_ALLOWED_ORIGINS=http://localhost:3000 node server.mjs
```

## Deploy (Railway or any container host)

Build from this directory's `Dockerfile` (about 0.6–0.9 GB with the CJK fonts). Give it 1 GB of memory for the
default concurrency of 2, set the two required variables, and expose it on the private network only — the
web app is its only caller.
