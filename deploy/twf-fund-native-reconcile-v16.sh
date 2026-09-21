#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
MIGRATION="20260921062000_together_we_feed_fund.sql"
API_CONTAINER="mypets-api"
FUND_ID="9a7f1000-0000-4a11-8c01-000000000006"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "Missing $COMPOSE_FILE"
command -v docker >/dev/null || fail "Docker is required"
command -v curl >/dev/null || fail "curl is required"

if [ -n "$(git -C "$APP_DIR" status --porcelain)" ]; then
  fail "Repository has local changes; refusing to overwrite them"
fi

PAYMENTS_LIVE_BEFORE="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1)"
PAYOUTS_ENABLED_BEFORE="$(sed -n 's/^PAYOUTS_ENABLED=//p' "$ENV_FILE" | tail -1)"

log "Fast-forwarding MyPets backend main"
git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" checkout main
git -C "$APP_DIR" merge --ff-only origin/main
echo "Backend HEAD: $(git -C "$APP_DIR" rev-parse HEAD)"

[ -f "$APP_DIR/supabase/migrations/$MIGRATION" ] || fail "Missing migration $MIGRATION"

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

log "Applying Together We Feed dedicated fund migration"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying dedicated fund"
docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<SQL
select case
  when id = '$FUND_ID'::uuid
   and beneficiary_kind = 'MYPETS'
   and fund_code = 'TOGETHER_WE_FEED'
   and currency = 'BRL'
   and vertical = 'FOOD'
   and status = 'ACTIVE'
   and verification_status = 'PLATFORM'
   and fundraising_status = 'ENABLED'
  then 'twf_fund_ok'
  else 'twf_fund_invalid'
end
from public.causes
where id = '$FUND_ID'::uuid;
SQL
unset DB_URL

log "Rebuilding and recreating only MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build --force-recreate

log "Waiting for MyPets API health"
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  if [ "$status" = "unhealthy" ]; then
    docker logs --tail 180 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  fi
  sleep 2
done
[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

log "Verifying public API"
curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/config
echo

PAYMENTS_LIVE_AFTER="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1)"
PAYOUTS_ENABLED_AFTER="$(sed -n 's/^PAYOUTS_ENABLED=//p' "$ENV_FILE" | tail -1)"
[ "$PAYMENTS_LIVE_BEFORE" = "$PAYMENTS_LIVE_AFTER" ] || fail "PAYMENTS_LIVE changed unexpectedly"
[ "$PAYOUTS_ENABLED_BEFORE" = "$PAYOUTS_ENABLED_AFTER" ] || fail "PAYOUTS_ENABLED changed unexpectedly"

echo
echo "============================================================"
echo "Together We Feed fund + Native reconciliation deployed."
echo "Fund ID: $FUND_ID"
echo "No payment secret, PAYMENTS_LIVE or payout setting was changed."
echo "============================================================"
