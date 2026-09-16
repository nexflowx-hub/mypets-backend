#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
API_CONTAINER="mypets-api"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ -f "$COMPOSE_FILE" ] || fail "Missing $COMPOSE_FILE"
command -v docker >/dev/null || fail "Docker is required"
docker compose version >/dev/null || fail "Docker Compose plugin is required"
command -v python3 >/dev/null || fail "python3 is required"
command -v curl >/dev/null || fail "curl is required"
command -v jq >/dev/null || fail "jq is required"

payments_live="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
[ "$payments_live" = "false" ] || fail "PAYMENTS_LIVE must remain false while installing webhook secrets"

provider="$(sed -n 's/^PAYMENT_PROVIDER=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
[ "$provider" = "xpayments" ] || fail "PAYMENT_PROVIDER must be xpayments"

brl_store="$(sed -n 's/^XPAYMENTS_STORE_CODE_BRL=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
eur_store="$(sed -n 's/^XPAYMENTS_STORE_CODE_EUR=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"
[ "$brl_store" = "MYPETS-BRL" ] || fail "XPAYMENTS_STORE_CODE_BRL must be MYPETS-BRL"
[ "$eur_store" = "MYPETS-EUR" ] || fail "XPAYMENTS_STORE_CODE_EUR must be MYPETS-EUR"

log "Reading webhook signing secrets securely"
printf 'MYPETS-BRL webhook signing secret: ' >&2
IFS= read -r -s BRL_SECRET
echo >&2
printf 'MYPETS-EUR webhook signing secret: ' >&2
IFS= read -r -s EUR_SECRET
echo >&2

[ -n "$BRL_SECRET" ] || fail "BRL webhook secret cannot be empty"
[ -n "$EUR_SECRET" ] || fail "EUR webhook secret cannot be empty"
[ "${#BRL_SECRET}" -ge 16 ] || fail "BRL webhook secret looks too short"
[ "${#EUR_SECRET}" -ge 16 ] || fail "EUR webhook secret looks too short"

backup="${ENV_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$ENV_FILE" "$backup"
chmod 600 "$backup"

log "Updating backend env without printing secret values"
BRL_SECRET="$BRL_SECRET" EUR_SECRET="$EUR_SECRET" python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])
values = {
    "XPAYMENTS_WEBHOOK_SECRET_BRL": os.environ["BRL_SECRET"],
    "XPAYMENTS_WEBHOOK_SECRET_EUR": os.environ["EUR_SECRET"],
}

lines = path.read_text().splitlines()
out = []
seen = set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.split("=", 1)[0].strip()
        if key in values:
            out.append(f"{key}={values[key]}")
            seen.add(key)
            continue
    out.append(line)

for key, value in values.items():
    if key not in seen:
        out.append(f"{key}={value}")

path.write_text("\n".join(out) + "\n")
PY
unset BRL_SECRET EUR_SECRET
chmod 600 "$ENV_FILE"

for name in XPAYMENTS_WEBHOOK_SECRET_BRL XPAYMENTS_WEBHOOK_SECRET_EUR; do
  if grep -qE "^${name}=.+" "$ENV_FILE"; then
    echo "$name: SET"
  else
    fail "$name is still empty after update"
  fi
done

log "Recreating only MyPets API with PAYMENTS_LIVE still false"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --force-recreate

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

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || {
  docker logs --tail 180 "$API_CONTAINER" || true
  fail "MyPets API did not become healthy"
}

runtime_live="$(docker exec "$API_CONTAINER" sh -lc 'printf "%s" "${PAYMENTS_LIVE:-MISSING}"')"
[ "$runtime_live" = "false" ] || fail "Runtime PAYMENTS_LIVE is not false"
echo "Runtime PAYMENTS_LIVE=false"

log "Checking public payment readiness"
curl -fsS https://api.mypets.lat/health | tee /tmp/mypets-health.json >/dev/null
curl -fsS https://api.mypets.lat/v1/config | tee /tmp/mypets-config.json >/dev/null
jq -e '.status == "ok" and .database == "ok"' /tmp/mypets-health.json >/dev/null
jq -e '.data.brand == "mypets" and .data.environment == "production" and .data.paymentsLive == false' /tmp/mypets-config.json >/dev/null
jq -e '(.data.paymentCurrencies | index("BRL")) != null and (.data.paymentCurrencies | index("EUR")) != null' /tmp/mypets-config.json >/dev/null
jq -e '(.data.paymentWebhookCurrencies | index("BRL")) != null and (.data.paymentWebhookCurrencies | index("EUR")) != null' /tmp/mypets-config.json >/dev/null

echo "paymentCurrencies=$(jq -c '.data.paymentCurrencies' /tmp/mypets-config.json)"
echo "paymentWebhookCurrencies=$(jq -c '.data.paymentWebhookCurrencies' /tmp/mypets-config.json)"
echo "paymentsLive=$(jq -r '.data.paymentsLive' /tmp/mypets-config.json)"

echo
echo "============================================================"
echo "MyPets webhook secrets v12 installed."
echo "Both BRL and EUR lanes are configured but public payments remain closed."
echo "Backup created at: $backup"
echo "No secret value was printed."
echo "============================================================"
