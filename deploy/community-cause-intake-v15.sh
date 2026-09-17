#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATION="20260917182000_community_cause_intake_v1.sql"
EXPECTED_MIN_HEAD="9b785c38b67bdb8a2028586e81bb3efcdbb6c472"

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
git -C "$APP_DIR" merge-base --is-ancestor "$EXPECTED_MIN_HEAD" "$HEAD_SHA" || fail "main does not contain the community cause intake release"

[ -f "$APP_DIR/supabase/migrations/$MIGRATION" ] || fail "Missing migration $MIGRATION"
DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

log "Applying community cause intake migration"
docker run --rm -e DIRECT_URL="$DB_URL" -v "$APP_DIR/supabase:/sql:ro" postgres:16-alpine \
  sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying database contract"
docker run --rm -i -e DIRECT_URL="$DB_URL" postgres:16-alpine sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -At' <<'SQL'
select 'causes_columns=' || count(*)
from information_schema.columns
where table_schema='public' and table_name='causes'
  and column_name in ('beneficiary_kind','cause_type','region','verification_status','fundraising_status','intake_source');
select 'intake_table=' || to_regclass('public.cause_intake_submissions');
select 'promotion_table=' || to_regclass('public.cause_promotion_queue');
select 'community_constraint=' || count(*)
from pg_constraint
where conrelid='public.causes'::regclass and conname='causes_community_gate_check';
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
CONFIG="$(curl -fsS https://api.mypets.lat/v1/config)"
printf '%s\n' "$CONFIG"
printf '%s' "$CONFIG" | grep -q '"causeIntakeEnabled":true' || fail "causeIntakeEnabled is not true in public config"

log "Checking canonical causes API remains healthy"
curl -fsS 'https://api.mypets.lat/v1/causes?limit=1' >/dev/null

echo
echo "============================================================"
echo "MyPets Community Cause Intake V1 is deployed."
echo "Community submissions are public but financially disabled."
echo "No payment credentials, payout settings or PAYMENTS_LIVE were changed."
echo "============================================================"
