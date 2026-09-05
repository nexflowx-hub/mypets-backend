#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
MIGRATION="$APP_DIR/supabase/migrations/20260905033000_core_platform.sql"
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

CURRENT_URL="$(sed -n 's/^SUPABASE_URL=//p' "$ENV_FILE" | tail -1)"
CURRENT_KEY="$(sed -n 's/^SUPABASE_PUBLISHABLE_KEY=//p' "$ENV_FILE" | tail -1)"

if [ -z "$CURRENT_URL" ]; then
  echo "Paste the Project URL from the SAME Supabase project already used by this MyPets backend."
  read -r -p "Supabase Project URL (https://...supabase.co): " CURRENT_URL
fi
case "$CURRENT_URL" in
  https://*.supabase.co) ;;
  *) fail "Invalid Supabase project URL" ;;
esac

if [ -z "$CURRENT_KEY" ]; then
  echo "Paste the Publishable key from that SAME Supabase project. Legacy anon key also works, but publishable is preferred."
  read -r -s -p "Supabase publishable key: " CURRENT_KEY
  echo
fi
[ -n "$CURRENT_KEY" ] || fail "Supabase publishable key is required"

log "Updating API Auth configuration without touching database credentials"
set_env "SUPABASE_URL" "$CURRENT_URL"
set_env "SUPABASE_PUBLISHABLE_KEY" "$CURRENT_KEY"
set_env "APP_VERSION" "0.2.0"
unset CURRENT_KEY

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing from $ENV_FILE"

log "Applying MyPets core-platform migration to the existing Supabase database"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f /sql/migrations/20260905033000_core_platform.sql'
unset DB_URL

log "Building and restarting only MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build

log "Waiting for MyPets API health"
for i in $(seq 1 40); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    break
  fi
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

log "Checking API and Auth configuration"
docker run --rm --network mypets_edge curlimages/curl:8.12.1 -fsS http://mypets-api:8081/health
echo
docker run --rm --network mypets_edge curlimages/curl:8.12.1 -fsS http://mypets-api:8081/v1/config
echo

log "Checking public HTTPS route"
curl -fsS https://api.mypets.lat/health
echo

echo
echo "============================================================"
echo "MyPets Core v1 deployed."
echo "No Caddy, AtlasWallet or database connection settings were changed."
echo "Expected config: authEnabled=true"
echo "Next: add matching public Supabase Auth values to Vercel."
echo "============================================================"
