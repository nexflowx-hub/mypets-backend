#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"

fail() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m 0600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

set_env "PAYMENTS_LIVE" "false"
chmod 600 "$ENV_FILE"

echo "PAYMENTS_LIVE=false saved. Recreating only MyPets API to reload env..."
docker compose -p mypets -f "$COMPOSE_FILE" up -d --force-recreate --no-deps api

for i in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && {
    docker logs --tail 180 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  }
  sleep 2
done

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

CONFIG="$(curl -fsS https://api.mypets.lat/v1/config)"
printf '%s\n' "$CONFIG"

case "$CONFIG" in
  *'"paymentsLive":false'*) ;;
  *) fail "Public config does not confirm paymentsLive=false" ;;
esac

echo "Public MyPets payments are disabled. No XPAYMENTS secrets were changed or printed."
