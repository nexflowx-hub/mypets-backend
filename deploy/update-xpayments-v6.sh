#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
MIGRATION="20260906224500_xpayments_checkout.sql"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -d "$APP_DIR/.git" ] || fail "Expected Git checkout at $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
command -v docker >/dev/null || fail "Docker is required"

set_env_default() {
  local key="$1" value="$2"
  grep -q "^${key}=" "$ENV_FILE" || printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

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

log "Applying provider-neutral XPAYMENTS checkout migration"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec "psql \"\$DIRECT_URL\" -v ON_ERROR_STOP=1 -f /sql/migrations/$MIGRATION"

log "Verifying payment tables"
docker run --rm -e DIRECT_URL="$DB_URL" postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -Atc "select to_regclass(\047public.payment_intents\047), to_regclass(\047public.payment_provider_events\047)"'
unset DB_URL

# Prepare the provider, but deliberately keep public charging disabled until a dedicated MyPets Store/API key + webhook are configured.
set_env "PAYMENT_PROVIDER" "xpayments"
set_env_default "PAYMENTS_LIVE" "false"
set_env_default "XPAYMENTS_API_BASE" "https://api.xpayments.digital/api/v1"
set_env_default "XPAYMENTS_CHECKOUT_BASE" "https://checkout.xpayments.digital"
set_env_default "XPAYMENTS_STORE_CODE_EUR" ""
set_env_default "XPAYMENTS_API_KEY_EUR" ""
set_env_default "XPAYMENTS_WEBHOOK_SECRET_EUR" ""
set_env_default "XPAYMENTS_STORE_CODE_BRL" ""
set_env_default "XPAYMENTS_API_KEY_BRL" ""
set_env_default "XPAYMENTS_WEBHOOK_SECRET_BRL" ""
set_env "APP_VERSION" "0.9.0"
chmod 600 "$ENV_FILE"

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

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

log "Public configuration (keys and webhook secrets are never printed)"
curl -fsS https://api.mypets.lat/v1/config
echo

echo
echo "============================================================"
echo "MyPets XPAYMENTS v6 backend deployed."
echo "Schema + provider adapter + signed webhook + embedded checkout API are ready."
echo "PAYMENTS_LIVE was NOT enabled automatically."
echo "Create dedicated MyPets XPAYMENTS Store/API key + webhook first,"
echo "then run deploy/configure-xpayments-v6.sh."
echo "No Caddy, AtlasWallet or database connection settings changed."
echo "============================================================"
