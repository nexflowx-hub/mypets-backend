#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATIONS=(
  "20260924161000_ebook_racao_1kg_fund.sql"
  "20260924170000_ebook_racao_launch_goal.sql"
  "20260924183000_ebook_racao_topup_policy.sql"
  "20260924190000_paid_attribution_metadata.sql"
)

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

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

for MIGRATION in "${MIGRATIONS[@]}"; do
  [ -f "$APP_DIR/supabase/migrations/$MIGRATION" ] || fail "Missing migration $MIGRATION"
  log "Applying $MIGRATION"
  docker run --rm \
    -e DIRECT_URL="$DB_URL" \
    -v "$APP_DIR/supabase:/sql:ro" \
    postgres:16-alpine \
    sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"
done

log "Verifying campaign and paid-attribution database state"
DB_STATE="$(
  docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<'SQL'
select concat_ws('|',
  c.fund_code,
  c.status,
  c.currency,
  c.campaign_meta->>'unitPriceCents',
  c.campaign_meta->>'goalKg',
  case when pg_get_functiondef('public.track_payment_intent_growth_event()'::regprocedure) like '%gclid%' then 'paid_ids_ok' else 'paid_ids_missing' end
)
from public.causes c
where c.id = '9a7f1000-0000-4a11-8c01-000000000007'::uuid
  and c.slug = 'mypets-ebook-racao-brl';
SQL
)"
[ "$DB_STATE" = "EBOOK_RACAO|ACTIVE|BRL|1290|100|paid_ids_ok" ] || fail "Unexpected campaign state: $DB_STATE"
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

log "Verifying public campaign endpoints"
curl -fsS https://api.mypets.lat/health
echo
CONFIG="$(curl -fsS https://api.mypets.lat/v1/config)"
echo "$CONFIG"
IMPACT="$(curl -fsS https://api.mypets.lat/v1/campaigns/ebook-racao/impact)"
echo "$IMPACT"
printf '%s' "$IMPACT" | grep -q '"confirmedKg":' || fail "Impact endpoint missing confirmedKg"
printf '%s' "$IMPACT" | grep -q '"extraSupportCents":' || fail "Impact endpoint missing extraSupportCents"
printf '%s' "$IMPACT" | grep -q '"goalKg":100' || fail "Impact endpoint goal is not 100kg"

READINESS="$(curl -fsS https://api.mypets.lat/v1/campaigns/ebook-racao/readiness)"
echo "$READINESS"
printf '%s' "$READINESS" | grep -q '"technicalReady":true' || fail "Paid-traffic technical readiness is not true"

PAYMENTS_LIVE_AFTER="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1)"
PAYOUTS_ENABLED_AFTER="$(sed -n 's/^PAYOUTS_ENABLED=//p' "$ENV_FILE" | tail -1)"
[ "$PAYMENTS_LIVE_BEFORE" = "$PAYMENTS_LIVE_AFTER" ] || fail "PAYMENTS_LIVE changed unexpectedly"
[ "$PAYOUTS_ENABLED_BEFORE" = "$PAYOUTS_ENABLED_AFTER" ] || fail "PAYOUTS_ENABLED changed unexpectedly"

echo
echo "============================================================"
echo "MyPets eBook paid-traffic v21 deployed and verified."
echo "Campaign 1kg fund: OK"
echo "Top-up accounting: OK"
echo "Paid-media attribution persistence: OK"
echo "Public impact endpoint: OK"
echo "Paid-traffic technical readiness: OK"
echo "Live payment proof: inspect /v1/campaigns/ebook-racao/readiness after a real R$12.90 Pix"
echo "API health: OK"
echo "No payment secret or payout setting was changed."
echo "============================================================"
