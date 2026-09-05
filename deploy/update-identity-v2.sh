#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
command -v docker >/dev/null || fail "Docker is required"
docker compose version >/dev/null || fail "Docker Compose plugin is required"

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m 0600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

log "Syncing MyPets backend main"
git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" reset --hard origin/main

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing from $ENV_FILE"

log "Applying identity roles migration to the existing MyPets Supabase database"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f /sql/migrations/20260905050500_identity_roles.sql'
unset DB_URL

log "Switching production public content to verified/non-demo records only"
set_env "PUBLIC_DEMO_CONTENT" "false"
set_env "APP_VERSION" "0.3.0"

log "Building and restarting only MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build

log "Waiting for MyPets API health"
for i in $(seq 1 40); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then break; fi
  if [ "$status" = "unhealthy" ]; then
    docker logs --tail 150 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  fi
  sleep 2
done

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || {
  docker logs --tail 150 "$API_CONTAINER" || true
  fail "MyPets API did not become healthy"
}

log "Checking core production endpoints"
docker run --rm --network mypets_edge curlimages/curl:8.12.1 -fsS http://mypets-api:8081/health
echo
docker run --rm --network mypets_edge curlimages/curl:8.12.1 -fsS http://mypets-api:8081/v1/config
echo
curl -fsS https://api.mypets.lat/health
echo

log "Confirming public demo content is not exposed"
echo -n "Stories: "
curl -fsS https://api.mypets.lat/v1/stories
echo
echo -n "Impact: "
curl -fsS https://api.mypets.lat/v1/impact/public
echo

echo
echo "============================================================"
echo "MyPets Identity v2 deployed."
echo "- Multi-role identities enabled"
echo "- Volunteer profiles enabled"
echo "- Protector social links API enabled"
echo "- Demo public content disabled"
echo "- Mock public payments blocked"
echo "No Caddy, AtlasWallet or database connection settings were changed."
echo "============================================================"
