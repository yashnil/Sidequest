#!/usr/bin/env bash
# Interleaved before/after Lighthouse rounds on one port.
#
#   PERF_TOOLS=<dir> ab.sh <seed.json> <outdir> <simulate|devtools> [rounds] [forms] [pages]
#
# Why interleaved: other work on this machine moved the load average between 13
# and 115 during this pass, so two blocks of runs taken at different times would
# compare the machine with itself. Each round serves the baseline snapshot
# (apps/.web-before), one run per page, stops it, then the same for the current
# build. A round's two halves see the same contention.
#
# Each server is warmed with a few requests first, so these runs measure the
# page and not the first request after process start.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$1"; OUT="$2"; METHOD="$3"; ROUNDS="${4:-3}"; FORMS="${5:-mobile}"; PAGES="${6:-landing,decide,trip}"
export PORT=4420
mkdir -p "$OUT"
for round in $(seq 1 "$ROUNDS"); do
  for side in before after; do
    if [ "$side" = before ]; then APP="${PERF_BEFORE_APP:-apps/.web-before}"; else APP=apps/web; fi
    PERF_APP="$APP" "$HERE/serve.sh" openfreemap >"$OUT/server-$side.log" 2>&1 &
    PID=$!
    for _ in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:$PORT/api/health && break; sleep 0.5; done
    for path in / /decide; do for _ in 1 2 3; do curl -s -o /dev/null "http://127.0.0.1:$PORT$path"; done; done
    # The trip route too: without this its first run measures module evaluation (TTFB 0.9-3.3 s), not the page.
    TRIP="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['tripId'])" "$SEED")"
    COOKIE="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('; '.join(c['name']+'='+c['value'] for c in d['cookies']))" "$SEED")"
    for _ in 1 2 3; do curl -s -o /dev/null -H "Cookie: $COOKIE" "http://127.0.0.1:$PORT/trips/$TRIP/itinerary"; done
    sleep 4
    node "$HERE/lighthouse-run.mjs" --seed "$SEED" --out "$OUT/$side-$METHOD-$round.json" --runs 1 --pages "$PAGES" --forms "$FORMS" --throttling "$METHOD" 2>&1 | sed "s/^/[$side $round] /" | cut -c1-230
    echo "[$side $round] load: $(uptime | sed 's/.*load averages*: //')"
    kill "$PID"
    wait "$PID" 2>/dev/null
    for _ in $(seq 1 60); do lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
  done
done
