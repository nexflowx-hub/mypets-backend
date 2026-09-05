#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATIONS=(
  "20260905193000_pet_media_storage.sql"
  "20260905203500_story_catalog_fallback.sql"
)

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

for migration in "${MIGRATIONS[@]}"; do
  log "Applying $migration"
  docker run --rm \
    -e DIRECT_URL="$DB_URL" \
    -v "$APP_DIR/supabase:/sql:ro" \
    postgres:16-alpine \
    sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$migration"
done

log "Verifying story fallback catalog"
STORY_COUNT="$(docker run --rm -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -Atc "select count(*) from public.stories where active=true and is_demo=true"')"
[ "${STORY_COUNT:-0}" -ge 4 ] || fail "Expected at least 4 active demo stories, got ${STORY_COUNT:-0}"
echo "active_demo_stories=$STORY_COUNT"

unset DB_URL
set_env "APP_VERSION" "0.9.0"

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

log "Checking public story API"
curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/stories
echo

echo
echo "============================================================"
echo "MyPets Stories v5 deployed."
echo "Live stories are preferred; demo stories are automatic fallback."
echo "Demo fallback remains visibly marked as demonstration in frontend."
echo "No Caddy, AtlasWallet or database connection settings changed."
echo "============================================================"
