#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
MIGRATION="20260911223000_cause_vertical_campaigns.sql"
API_CONTAINER="mypets-api"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
command -v docker >/dev/null || fail "Docker is required"
docker compose version >/dev/null || fail "Docker Compose plugin is required"

log "Syncing MyPets backend main"
git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" reset --hard origin/main

[ -f "$APP_DIR/supabase/migrations/$MIGRATION" ] || fail "Missing migration $MIGRATION after sync"

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing from $ENV_FILE"

log "Applying additive cause campaign migration"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying campaign columns and trigger"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -Atc "
    select string_agg(column_name, ',' order by column_name)
    from information_schema.columns
    where table_schema = '"'"'public'"'"'
      and table_name = '"'"'causes'"'"'
      and column_name in ('"'"'vertical'"'"','"'"'campaign_key'"'"','"'"'campaign_meta'"'"');
    select tgname
    from pg_trigger
    where tgrelid = '"'"'public.payment_intents'"'"'::regclass
      and tgname = '"'"'payment_intents_growth_events'"'"'
      and not tgisinternal;
  "'
unset DB_URL

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

log "Checking public API"
curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/config
echo

for vertical in VET RESCUE SHELTER EMERGENCY; do
  log "Checking vertical endpoint: $vertical"
  curl -fsS "https://api.mypets.lat/v1/causes/vertical/$vertical?limit=1"
  echo
done

log "Checking an unknown campaign returns 404 rather than a server error"
status_code="$(curl -sS -o /tmp/mypets-campaign-check.json -w '%{http_code}' https://api.mypets.lat/v1/cause-campaigns/preflight-not-a-real-campaign)"
[ "$status_code" = "404" ] || {
  cat /tmp/mypets-campaign-check.json || true
  fail "Expected campaign preflight 404, got HTTP $status_code"
}
rm -f /tmp/mypets-campaign-check.json

echo
echo "============================================================"
echo "MyPets campaign verticals v9 deployed."
echo "Cause vertical classification + campaign API + payment funnel analytics are active."
echo "No payment credentials, Caddy settings or unrelated databases were changed."
echo "============================================================"
