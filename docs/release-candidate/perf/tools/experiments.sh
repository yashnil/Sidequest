#!/usr/bin/env bash
# One controlled paint-probe experiment per line: the same load with a single
# thing changed. Run with bash, not zsh (zsh does not split an unquoted $v, which
# silently turned an earlier round of these into five baseline runs).
#
#   experiments.sh <seed.json> [pages]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$1"
PAGES="${2:-landing,decide}"
export PORT="${PORT:-4420}"
while IFS= read -r v; do
  echo "#### ${v:-baseline}"
  # shellcheck disable=SC2086
  node "$HERE/paint-probe.mjs" --seed "$SEED" --pages "$PAGES" --runs 3 --settle 2500 $v 2>&1 | grep -E "^(landing|decide|trip) |LCP candidate|globe:|fonts:"
done <<'LIST'

--block fonts
--block scripts
--block vendor
--cpu 1
--profile none
LIST
