#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="/srv/apps/mypets/env/api.env"
APP_DIR="/srv/apps/mypets/api"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"

fail() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m 0600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

configure_currency() {
  local currency="$1" answer store_code api_key webhook_secret expected_store
  expected_store="MYPETS-${currency}"

  read -r -p "Configure live ${expected_store} now? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || return 0

  read -r -p "XPAYMENTS Store code (${currency}) [${expected_store}]: " store_code
  store_code="${store_code:-$expected_store}"
  [ "$store_code" = "$expected_store" ] || fail "Expected Store code ${expected_store}"

  read -r -s -p "XPAYMENTS live API key (${currency}) [hidden]: " api_key
  echo
  [[ "$api_key" == xp_live_* ]] || fail "${expected_store} requires an xp_live_ API key; sandbox keys belong in XPAYMENTS_SANDBOX_API_KEY"

  read -r -s -p "XPAYMENTS webhook secret (${currency}) [hidden]: " webhook_secret
  echo
  [[ "$webhook_secret" == whsec_* ]] || fail "Unexpected XPAYMENTS webhook secret prefix"

  set_env "XPAYMENTS_STORE_CODE_${currency}" "$store_code"
  set_env "XPAYMENTS_API_KEY_${currency}" "$api_key"
  set_env "XPAYMENTS_WEBHOOK_SECRET_${currency}" "$webhook_secret"
  unset api_key webhook_secret
}

set_env "PAYMENT_PROVIDER" "xpayments"
set_env "XPAYMENTS_API_BASE" "https://api.xpayments.digital/api/v1"
set_env "XPAYMENTS_CHECKOUT_BASE" "https://checkout.xpayments.digital"

configure_currency EUR
configure_currency BRL

read -r -p "Enable public MyPets payments now? [y/N]: " enable
if [[ "$enable" =~ ^[Yy]$ ]]; then
  configured_live=0
  for currency in EUR BRL; do
    expected_store="MYPETS-${currency}"
    store_code="$(sed -n "s/^XPAYMENTS_STORE_CODE_${currency}=//p" "$ENV_FILE" | tail -1)"
    api_key="$(sed -n "s/^XPAYMENTS_API_KEY_${currency}=//p" "$ENV_FILE" | tail -1)"
    webhook_secret="$(sed -n "s/^XPAYMENTS_WEBHOOK_SECRET_${currency}=//p" "$ENV_FILE" | tail -1)"

    if [ -n "$api_key" ]; then
      [ "$store_code" = "$expected_store" ] || {
        set_env "PAYMENTS_LIVE" "false"
        fail "${currency} is configured but Store code is not ${expected_store}"
      }
      [[ "$api_key" == xp_live_* ]] || {
        set_env "PAYMENTS_LIVE" "false"
        fail "Refusing PAYMENTS_LIVE=true: ${currency} does not use xp_live_"
      }
      [[ "$webhook_secret" == whsec_* ]] || {
        set_env "PAYMENTS_LIVE" "false"
        fail "${currency} has a live API key but no valid webhook secret"
      }
      configured_live=$((configured_live + 1))
    fi
  done

  [ "$configured_live" -gt 0 ] || {
    set_env "PAYMENTS_LIVE" "false"
    fail "No complete XPAYMENTS live Store configuration is present"
  }

  set_env "PAYMENTS_LIVE" "true"
else
  set_env "PAYMENTS_LIVE" "false"
fi

chmod 600 "$ENV_FILE"

echo "Restarting only MyPets API..."
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build

for i in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && fail "MyPets API became unhealthy"
  sleep 2
done

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

# This endpoint deliberately exposes only capability flags/currencies, never API keys or webhook secrets.
curl -fsS https://api.mypets.lat/v1/config
echo

echo "XPAYMENTS live Store configuration saved server-side. Secret values were not printed."
