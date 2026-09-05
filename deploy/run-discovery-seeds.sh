#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/srv/apps/mypets/api}"
ENV_FILE="${ENV_FILE:-/srv/apps/mypets/env/api.env}"
SEED_FILE="${1:-$APP_DIR/data/discovery-seeds/initial-pt-br.txt}"
API_URL="${MYPETS_API_URL:-https://api.mypets.lat/v1}"
API_CONTAINER="${API_CONTAINER:-mypets-api}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ -f "$SEED_FILE" ] || fail "Missing seed file $SEED_FILE"
command -v docker >/dev/null 2>&1 || fail "Docker is required"

docker inspect "$API_CONTAINER" >/dev/null 2>&1 || fail "Container $API_CONTAINER not found"
container_status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
[ "$container_status" = "healthy" ] || [ "$container_status" = "running" ] || fail "Container $API_CONTAINER is not ready (status: ${container_status:-unknown})"

docker exec "$API_CONTAINER" test -f /app/dist/discovery-crawler.js || fail "Crawler is missing inside $API_CONTAINER; redeploy Platform v2 first"

token_length="$(docker exec "$API_CONTAINER" node -e 'process.stdout.write(String((process.env.DISCOVERY_INGEST_TOKEN || "").length))')"
case "$token_length" in
  ''|*[!0-9]*) fail "Could not verify DISCOVERY_INGEST_TOKEN inside $API_CONTAINER" ;;
esac
[ "$token_length" -ge 16 ] || fail "DISCOVERY_INGEST_TOKEN is missing or too short inside $API_CONTAINER"

ok=0
failed=0

while IFS='|' read -r country city url; do
  [[ -z "${country// }" || "${country:0:1}" == "#" ]] && continue
  [[ -z "${url// }" ]] && continue

  echo
  echo "==> Discovering $url [$country${city:+ / $city}]"
  args=("$url" "--country=$country")
  [[ -n "$city" ]] && args+=("--city=$city")

  if docker exec \
    -e MYPETS_API_URL="$API_URL" \
    "$API_CONTAINER" \
    node /app/dist/discovery-crawler.js "${args[@]}"; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "WARN: discovery failed for $url" >&2
  fi

done < "$SEED_FILE"

echo
echo "Discovery batch complete: $ok succeeded, $failed failed."
[ "$failed" -eq 0 ]
