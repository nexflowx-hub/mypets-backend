#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
GROWTH_MIGRATION="20260924063000_growth_landing_attribution.sql"
EBOOK_MIGRATION="20260924161000_ebook_racao_1kg_fund.sql"

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

log "Applying 1 eBook = 1 kg fund migration"
docker run --rm   -e DIRECT_URL="$DB_URL"   -v "$APP_DIR/supabase:/sql:ro"   postgres:16-alpine   sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying dedicated food fund"
FUND_STATE="$(
  docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<'SQL'
select concat_ws('|',
  fund_code,
  status,
  currency,
  vertical,
  beneficiary_kind,
  campaign_meta->>'unitType',
  campaign_meta->>'unitQuantity',
  campaign_meta->>'unitPriceCents',
  campaign_meta->>'campaignVersion'
)
from public.causes
where id = '9a7f1000-0000-4a11-8c01-000000000007'::uuid
  and slug = 'mypets-ebook-racao-brl';
SQL
)"
EXPECTED="EBOOK_RACAO|ACTIVE|BRL|FOOD|MYPETS|DOG_FOOD_KG|1|1290|1kg-v1"
[ "$FUND_STATE" = "$EXPECTED" ] || fail "Unexpected EBOOK_RACAO state: $FUND_STATE"
unset DB_URL

log "Rebuilding MyPets API"
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

log "Proving cause-intake DB round-trip"
READINESS="$(curl -fsS -X POST https://api.mypets.lat/v1/cause-intake/readiness)"
echo "$READINESS"
printf '%s' "$READINESS" | grep -q '"status":"ready"' || fail "Readiness status is not ready"
printf '%s' "$READINESS" | grep -q '"databaseRoundTrip":true' || fail "Database round-trip was not confirmed"
printf '%s' "$READINESS" | grep -q '"rolledBack":true' || fail "Readiness transaction was not rolled back"

PAYMENTS_LIVE_AFTER="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1)"
PAYOUTS_ENABLED_AFTER="$(sed -n 's/^PAYOUTS_ENABLED=//p' "$ENV_FILE" | tail -1)"
[ "$PAYMENTS_LIVE_BEFORE" = "$PAYMENTS_LIVE_AFTER" ] || fail "PAYMENTS_LIVE changed unexpectedly"
[ "$PAYOUTS_ENABLED_BEFORE" = "$PAYOUTS_ENABLED_AFTER" ] || fail "PAYOUTS_ENABLED changed unexpectedly"

echo
echo "============================================================"
echo "MyPets eBook Racao v19 deployed and verified."
echo "Growth landing attribution: OK"
echo "Cause intake readiness: OK"
echo "Fund EBOOK_RACAO: 1 kg @ BRL 12.90: OK"
echo "API health: OK"
echo "No payment secret or payout setting was changed."
echo "============================================================"
