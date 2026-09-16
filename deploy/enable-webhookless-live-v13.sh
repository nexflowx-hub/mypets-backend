#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"
BACKUP="${ENV_FILE}.pre-webhookless-live.$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "Missing $COMPOSE_FILE"
command -v docker >/dev/null || fail "Docker is required"
command -v curl >/dev/null || fail "curl is required"
command -v jq >/dev/null || fail "jq is required"

value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

rollback() {
  local code=$?
  if [ "$code" -eq 0 ]; then return; fi
  echo "Activation failed; restoring previous api.env" >&2
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    docker compose -p mypets -f "$COMPOSE_FILE" up -d --force-recreate >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap rollback ERR

log "Validating dedicated LIVE Stores and keys"
[ "$(value PAYMENT_PROVIDER)" = "xpayments" ] || fail "PAYMENT_PROVIDER must be xpayments"
[ "$(value XPAYMENTS_STORE_CODE_BRL)" = "MYPETS-BRL" ] || fail "BRL Store must be MYPETS-BRL"
[ "$(value XPAYMENTS_STORE_CODE_EUR)" = "MYPETS-EUR" ] || fail "EUR Store must be MYPETS-EUR"
[[ "$(value XPAYMENTS_API_KEY_BRL)" == xp_live_* ]] || fail "BRL API key must be LIVE"
[[ "$(value XPAYMENTS_API_KEY_EUR)" == xp_live_* ]] || fail "EUR API key must be LIVE"
[ "$(value PAYOUTS_ENABLED)" != "true" ] || fail "PAYOUTS_ENABLED must remain false during launch"

printf 'PAYMENT_PROVIDER=xpayments\n'
printf 'XPAYMENTS_STORE_CODE_BRL=MYPETS-BRL\n'
printf 'XPAYMENTS_STORE_CODE_EUR=MYPETS-EUR\n'
printf 'XPAYMENTS_API_KEY_BRL: SET LIVE\n'
printf 'XPAYMENTS_API_KEY_EUR: SET LIVE\n'
printf 'XPAYMENTS_WEBHOOK_SECRET_BRL: %s\n' "$([ -n "$(value XPAYMENTS_WEBHOOK_SECRET_BRL)" ] && echo SET || echo MISSING_OR_EMPTY)"
printf 'XPAYMENTS_WEBHOOK_SECRET_EUR: %s\n' "$([ -n "$(value XPAYMENTS_WEBHOOK_SECRET_EUR)" ] && echo SET || echo MISSING_OR_EMPTY)"

log "Backing up api.env and enabling explicit degraded LIVE mode"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
set_env XPAYMENTS_ALLOW_WEBHOOKLESS_LIVE true
set_env PAYMENTS_LIVE true
chmod 600 "$ENV_FILE"

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

log "Verifying runtime and public config"
[ "$(docker exec "$API_CONTAINER" sh -lc 'printf %s "${PAYMENTS_LIVE:-}"')" = "true" ] || fail "Runtime PAYMENTS_LIVE is not true"
[ "$(docker exec "$API_CONTAINER" sh -lc 'printf %s "${XPAYMENTS_ALLOW_WEBHOOKLESS_LIVE:-}"')" = "true" ] || fail "Runtime webhookless flag is not true"

curl -fsS https://api.mypets.lat/health | tee /tmp/mypets-live-health.json
echo
curl -fsS https://api.mypets.lat/v1/config | tee /tmp/mypets-live-config.json
echo

jq -e '.status == "ok" and .database == "ok"' /tmp/mypets-live-health.json >/dev/null
jq -e '.data.paymentsLive == true and .data.paymentProvider == "xpayments"' /tmp/mypets-live-config.json >/dev/null
jq -e '(.data.paymentCurrencies | index("BRL")) != null and (.data.paymentCurrencies | index("EUR")) != null' /tmp/mypets-live-config.json >/dev/null
jq -e '(.data.degradedPaymentCurrencies | index("BRL")) != null and (.data.degradedPaymentCurrencies | index("EUR")) != null' /tmp/mypets-live-config.json >/dev/null

trap - ERR

echo
echo "============================================================"
echo "MyPets degraded LIVE mode is active."
echo "Payments can be created with LIVE Store keys."
echo "Merchant webhook secrets are still missing: webhook deliveries may return 503."
echo "Hosted XPay sessions can use server-side session reconciliation."
echo "Native S2S payments can remain PENDING locally until manual/webhook reconciliation."
echo "Keep payouts disabled and reconcile provider transactions operationally."
echo "Backup: $BACKUP"
echo "============================================================"
