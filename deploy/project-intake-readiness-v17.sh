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

log "Verifying public health"
curl -fsS https://api.mypets.lat/health
echo

log "Proving cause-intake database round-trip"
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
echo "MyPets project-intake readiness deployed and verified."
echo "No database migration, payment secret or payout setting changed."
echo "============================================================"
