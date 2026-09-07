#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"

fail() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"

get_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m 0600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

SANDBOX_STORE="$(get_env XPAYMENTS_SANDBOX_STORE_CODE)"
SANDBOX_KEY="$(get_env XPAYMENTS_SANDBOX_API_KEY)"
SANDBOX_SECRET="$(get_env XPAYMENTS_SANDBOX_WEBHOOK_SECRET)"

if [ -z "$SANDBOX_STORE" ] || [ -z "$SANDBOX_KEY" ] || [ -z "$SANDBOX_SECRET" ]; then
  LEGACY_STORE="$(get_env XPAYMENTS_STORE_CODE_EUR)"
  LEGACY_KEY="$(get_env XPAYMENTS_API_KEY_EUR)"
  LEGACY_SECRET="$(get_env XPAYMENTS_WEBHOOK_SECRET_EUR)"

  [ -n "$LEGACY_STORE" ] || fail "No current EUR Store code available to migrate"
  [[ "$LEGACY_KEY" == xp_test_* ]] || fail "Current EUR key is not xp_test_; refusing automatic sandbox migration"
  [[ "$LEGACY_SECRET" == whsec_* ]] || fail "Current EUR webhook secret is missing or invalid"

  set_env XPAYMENTS_SANDBOX_STORE_CODE "$LEGACY_STORE"
  set_env XPAYMENTS_SANDBOX_API_KEY "$LEGACY_KEY"
  set_env XPAYMENTS_SANDBOX_WEBHOOK_SECRET "$LEGACY_SECRET"

  SANDBOX_STORE="$LEGACY_STORE"
  SANDBOX_KEY="$LEGACY_KEY"
  SANDBOX_SECRET="$LEGACY_SECRET"
fi

[[ "$SANDBOX_KEY" == xp_test_* ]] || fail "XPAYMENTS_SANDBOX_API_KEY must use xp_test_"
[[ "$SANDBOX_SECRET" == whsec_* ]] || fail "XPAYMENTS_SANDBOX_WEBHOOK_SECRET must use whsec_"
[ -n "$SANDBOX_STORE" ] || fail "XPAYMENTS_SANDBOX_STORE_CODE is empty"

chmod 600 "$ENV_FILE"
unset SANDBOX_KEY SANDBOX_SECRET LEGACY_KEY LEGACY_SECRET

echo "Dedicated XPAYMENTS sandbox lane saved. Recreating only MyPets API..."
docker compose -p mypets -f "$COMPOSE_FILE" up -d --force-recreate --no-deps api

for i in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && {
    docker logs --tail 180 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  }
  sleep 2
done

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || fail "MyPets API did not become healthy"

printf '\nXPAYMENTS sandbox lane ready\n'
printf 'Store:          %s\n' "$SANDBOX_STORE"
printf 'API key:        xp_test_... (hidden)\n'
printf 'Webhook secret: whsec_... (hidden)\n'
printf 'Preferred URL:  https://api.mypets.lat/v1/payments/webhooks/xpayments-sandbox\n'
printf '\nExisting XPAYMENTS_STORE_CODE_EUR / API_KEY_EUR / WEBHOOK_SECRET_EUR were NOT changed.\n'
printf 'They can now be replaced later by the dedicated MYPETS-EUR live credentials.\n'
