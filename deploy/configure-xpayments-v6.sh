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
  local currency="$1" answer store_code api_key
  read -r -p "Configure MyPets ${currency} Store now? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || return 0

  read -r -p "XPAYMENTS Store code (${currency}): " store_code
  [ -n "$store_code" ] || fail "Store code cannot be empty"

  read -r -s -p "XPAYMENTS API key (${currency}) [hidden]: " api_key
  echo
  [ -n "$api_key" ] || fail "API key cannot be empty"
  [[ "$api_key" == xp_test_* || "$api_key" == xp_live_* ]] || fail "Unexpected XPAYMENTS key prefix"

  set_env "XPAYMENTS_STORE_CODE_${currency}" "$store_code"
  set_env "XPAYMENTS_API_KEY_${currency}" "$api_key"
  unset api_key
}

set_env "PAYMENT_PROVIDER" "xpayments"
set_env "XPAYMENTS_API_BASE" "https://api.xpayments.digital/api/v1"
set_env "XPAYMENTS_CHECKOUT_BASE" "https://checkout.xpayments.digital"

configure_currency EUR
configure_currency BRL

read -r -p "Enable public MyPets payments now? [y/N]: " enable
if [[ "$enable" =~ ^[Yy]$ ]]; then
  has_key="$(grep -Ec '^XPAYMENTS_API_KEY_(EUR|BRL)=xp_(test|live)_' "$ENV_FILE" || true)"
  [ "$has_key" -gt 0 ] || fail "No XPAYMENTS API key is configured"
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

# This endpoint deliberately exposes only capability flags/currencies, never API keys.
curl -fsS https://api.mypets.lat/v1/config
echo

echo "XPAYMENTS configuration saved server-side. Secret values were not printed."
