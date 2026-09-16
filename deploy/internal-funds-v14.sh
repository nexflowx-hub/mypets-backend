#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATIONS=(
  "20260916153000_mypets_internal_funds.sql"
  "20260916153500_mypets_internal_funds_seed.sql"
)

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
command -v docker >/dev/null || fail "Docker is required"

log "Checking repository safety"
[ -z "$(git -C "$APP_DIR" status --short)" ] || fail "Repository has local changes"

git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" checkout main
git -C "$APP_DIR" merge --ff-only origin/main
printf 'Backend HEAD: %s\n' "$(git -C "$APP_DIR" rev-parse HEAD)"

for migration in "${MIGRATIONS[@]}"; do
  [ -f "$APP_DIR/supabase/migrations/$migration" ] || fail "Missing migration $migration"
done

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

for migration in "${MIGRATIONS[@]}"; do
  log "Applying $migration"
  docker run --rm -e DIRECT_URL="$DB_URL" -v "$APP_DIR/supabase:/sql:ro" postgres:16-alpine \
    sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$migration"
done

log "Verifying first-party MyPets BRL funds"
docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<'SQL'
select slug || '|' || beneficiary_kind || '|' || fund_code || '|' || currency || '|' || status
from public.causes
where slug in (
  'mypets-geral-brl',
  'mypets-vet-help-brl',
  'mypets-rescue-brl',
  'mypets-shelter-brl',
  'mypets-emergency-brl'
)
order by slug;
SQL
unset DB_URL

log "Rebuilding and recreating only MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build --force-recreate

log "Waiting for MyPets API health"
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && { docker logs --tail 180 "$API_CONTAINER" || true; fail "MyPets API became unhealthy"; }
  sleep 2
done
[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/config
echo

echo
echo "============================================================"
echo "MyPets first-party BRL funds are installed."
echo "This script did not change PAYMENTS_LIVE, webhook secrets or payouts."
echo "============================================================"
