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

log "Applying Admin + Claim Center migration"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f /sql/migrations/20260905150000_admin_claim_center.sql'
unset DB_URL

if ! grep -q '^PUBLIC_SITE_URL=' "$ENV_FILE"; then
  set_env "PUBLIC_SITE_URL" "https://mypets.lat"
fi

CURRENT_ADMINS="$(sed -n 's/^ADMIN_EMAILS=//p' "$ENV_FILE" | tail -1)"
if [ -z "$CURRENT_ADMINS" ]; then
  echo
  echo "Enter the email of the MyPets account that should have SUPERADMIN access."
  echo "This value stays only in the VPS environment file."
  read -r -p "Admin email: " ADMIN_EMAIL
  ADMIN_EMAIL="$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "$ADMIN_EMAIL" == *@*.* ]] || fail "Admin email does not look valid"
  set_env "ADMIN_EMAILS" "$ADMIN_EMAIL"
fi
unset CURRENT_ADMINS

set_env "APP_VERSION" "0.7.0"
set_env "PUBLIC_DEMO_CONTENT" "false"

log "Building and restarting only MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build

log "Waiting for MyPets API health"
for i in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  if [ "$status" = "unhealthy" ]; then
    docker logs --tail 180 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  fi
  sleep 2
done

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || {
  docker logs --tail 180 "$API_CONTAINER" || true
  fail "MyPets API did not become healthy"
}

log "Checking Admin + Claim Center public configuration"
curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/config
echo

echo
echo "============================================================"
echo "MyPets Admin + Claim Center v3 deployed."
echo "Admin access uses normal Supabase Auth + server-side ADMIN_EMAILS."
echo "Claim invite tokens are hashed in the database and time-limited."
echo "No Caddy, AtlasWallet or database connection settings changed."
echo "============================================================"
