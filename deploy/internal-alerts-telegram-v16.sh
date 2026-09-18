#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATION="20260918004500_internal_alerts_telegram_v1.sql"
EXPECTED_MIN_HEAD="d9186a3f7f392ace2911b0ab7ddf594ee12877d6"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
command -v docker >/dev/null || fail "Docker is required"
command -v curl >/dev/null || fail "curl is required"

log "Checking repository safety"
[ -z "$(git -C "$APP_DIR" status --short)" ] || fail "Repository has local changes"

git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" checkout main
git -C "$APP_DIR" merge --ff-only origin/main
HEAD_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
printf 'Backend HEAD: %s\n' "$HEAD_SHA"
git -C "$APP_DIR" merge-base --is-ancestor "$EXPECTED_MIN_HEAD" "$HEAD_SHA" || fail "main does not contain the internal alerts release"

[ -f "$APP_DIR/supabase/migrations/$MIGRATION" ] || fail "Missing migration $MIGRATION"
DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

log "Applying internal alerts + Telegram outbox migration"
docker run --rm -e DIRECT_URL="$DB_URL" -v "$APP_DIR/supabase:/sql:ro" postgres:16-alpine \
  sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying internal alert database contract"
docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<'SQL'
select 'alerts_table=' || to_regclass('public.internal_alerts');
select 'deliveries_table=' || to_regclass('public.internal_alert_deliveries');
select 'alerts_rls=' || relrowsecurity from pg_class where oid='public.internal_alerts'::regclass;
select 'deliveries_rls=' || relrowsecurity from pg_class where oid='public.internal_alert_deliveries'::regclass;
select 'dedupe_index=' || to_regclass('public.internal_alerts_dedupe_key_unique');
select 'delivery_unique=' || to_regclass('public.internal_alert_deliveries_alert_channel_unique');
SQL
unset DB_URL

log "Rebuilding MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build --force-recreate

log "Waiting for API health"
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && { docker logs --tail 180 "$API_CONTAINER" || true; fail "MyPets API became unhealthy"; }
  sleep 2
done
[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

log "Verifying public API"
curl -fsS https://api.mypets.lat/health
echo
curl -fsS https://api.mypets.lat/v1/config >/dev/null

log "Checking alert runtime mode"
if grep -q '^TELEGRAM_ALERT_ENABLED=true$' "$ENV_FILE"; then
  echo "TELEGRAM_ALERT_ENABLED=true"
  grep -q '^TELEGRAM_ALERT_BOT_TOKEN=.$' "$ENV_FILE" && true || echo "Telegram bot token presence will be validated by the API runtime."
else
  echo "Telegram delivery remains disabled. Internal event/ticket logging is active."
fi

log "Recent API alert dispatcher logs"
docker logs --since 3m "$API_CONTAINER" 2>&1 | grep -E 'Telegram internal alert|mypets-api' | tail -20 || true

echo
echo "============================================================"
echo "MyPets Internal Alerts + Telegram V1 is deployed."
echo "Internal event/ticket logging is active."
echo "Telegram delivery is controlled only by server-side env vars."
echo "Payments and customer-facing flows do not depend on Telegram."
echo "============================================================"
