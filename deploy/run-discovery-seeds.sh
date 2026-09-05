#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/apps/mypets/api}"
ENV_FILE="${ENV_FILE:-/srv/apps/mypets/env/api.env}"
SEED_FILE="${1:-$APP_DIR/data/discovery-seeds/initial-pt-br.txt}"
API_URL="${MYPETS_API_URL:-https://api.mypets.lat/v1}"

fail() { echo "ERROR: $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ -f "$SEED_FILE" ] || fail "Missing seed file $SEED_FILE"
[ -f "$APP_DIR/dist/discovery-crawler.js" ] || fail "Build backend first; dist/discovery-crawler.js not found"

TOKEN="$(sed -n 's/^DISCOVERY_INGEST_TOKEN=//p' "$ENV_FILE" | tail -1)"
[ "${#TOKEN}" -ge 16 ] || fail "DISCOVERY_INGEST_TOKEN is missing or too short"

export DISCOVERY_INGEST_TOKEN="$TOKEN"
export MYPETS_API_URL="$API_URL"
unset TOKEN

ok=0
failed=0

while IFS='|' read -r country city url; do
  [[ -z "${country// }" || "${country:0:1}" == "#" ]] && continue
  [[ -z "${url// }" ]] && continue

  echo
  echo "==> Discovering $url [$country${city:+ / $city}]"
  args=("$url" "--country=$country")
  [[ -n "$city" ]] && args+=("--city=$city")

  if node "$APP_DIR/dist/discovery-crawler.js" "${args[@]}"; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "WARN: discovery failed for $url" >&2
  fi

done < "$SEED_FILE"

echo
echo "Discovery batch complete: $ok succeeded, $failed failed."
[ "$failed" -eq 0 ]
