#!/usr/bin/env bash
# Start the production build on fixture providers for a performance measurement.
#
#   docs/release-candidate/perf/tools/serve.sh [map-provider] [db-file]
#
# - Fixture providers only: the same pins as playwright.config.ts, so nothing
#   here can reach a paid API. `map-provider` is `openfreemap` (the landing
#   globe and vector maps, as deployed) or `off` (the SVG figures).
# - `exec node next start`, so the PID of this script IS the server: RSS and
#   CPU are read from it, and stopping it kills exactly one process.
# - Requires `npm run build` first. Never `next dev`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
PORT="${PORT:-4420}"
MAP="${1:-openfreemap}"
if [ "$MAP" = "off" ]; then MAP=""; fi
DB="${2:-$ROOT/apps/web/data/perf.db}"
# PERF_APP names a build snapshot to serve instead (apps/.web-before), for interleaved A/B rounds.
cd "$ROOT/${PERF_APP:-apps/web}"
export SIDEQUEST_DB_PATH="$DB" SIDEQUEST_SECURE_COOKIES=off ANTHROPIC_API_KEY= GOOGLE_MAPS_API_KEY= \
  SIDEQUEST_GEOCODER_PROVIDER=off SIDEQUEST_PLACE_BACKBONE=off SIDEQUEST_POI_PROVIDER=off SIDEQUEST_ROUTES_PROVIDER=off \
  SIDEQUEST_RESEARCH_PROVIDER=off SIDEQUEST_IMAGERY_PROVIDER=fixture SIDEQUEST_TIMEZONE_PROVIDER=off SIDEQUEST_TRANSIT_PROVIDER= \
  SIDEQUEST_MAP_PROVIDER="$MAP" SIDEQUEST_WEATHER_PROVIDER=fixture SIDEQUEST_COMPILER_PROVIDER=fixture SIDEQUEST_COMPOSER_PROVIDER=fixture \
  SIDEQUEST_CLIMATE_PROVIDER=off SIDEQUEST_FX_PROVIDER=off SIDEQUEST_DESTINATION_INTERPRETER=fixture SIDEQUEST_BENCHMARK_MODE=fixture \
  SIDEQUEST_BENCHMARK_BUDGET_USD= SIDEQUEST_ACTION_FENCES=off SIDEQUEST_AUTH_PROVIDER=fixture SIDEQUEST_AUTH_FIXTURE=allow \
  SIDEQUEST_FIXTURES=allow SIDEQUEST_BASE_URL="http://127.0.0.1:$PORT" PORT="$PORT" NODE_ENV=production
exec node "$ROOT/apps/web/node_modules/next/dist/bin/next" start -p "$PORT"
