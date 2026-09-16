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
docker compose version >/dev/null || fail "Docker Compose plugin is required"

log "Checking repository safety"
if [ -n "$(git -C "$APP_DIR" status --porcelain)" ]; then
  git -C "$APP_DIR" status --short
  fail "Working tree is not clean. Review local changes before launch; this script will not overwrite them."
fi

log "Fast-forwarding MyPets backend main"
git -C "$APP_DIR" fetch --prune origin main
git -C "$APP_DIR" checkout main >/dev/null 2>&1 || fail "Could not checkout main"
git -C "$APP_DIR" merge --ff-only origin/main
HEAD_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
echo "Backend HEAD: $HEAD_SHA"

log "Checking launch configuration without printing secrets"
python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
env = {}
for raw in path.read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip()

expected = {
    "PAYMENT_PROVIDER": "xpayments",
    "PAYMENTS_LIVE": "false",
    "XPAYMENTS_STORE_CODE_BRL": "MYPETS-BRL",
    "XPAYMENTS_STORE_CODE_EUR": "MYPETS-EUR",
}
problems = []
for key, value in expected.items():
    actual = env.get(key, "")
    print(f"{key}={actual or 'MISSING'}")
    if actual != value:
        problems.append(f"{key} must be {value!r} during preflight")

for key in ("XPAYMENTS_API_KEY_BRL", "XPAYMENTS_API_KEY_EUR"):
    value = env.get(key, "")
    state = "SET LIVE" if value.startswith("xp_live_") else "INVALID/MISSING"
    print(f"{key}: {state}")
    if state != "SET LIVE":
        problems.append(f"{key} must be a live key")

for key in ("XPAYMENTS_WEBHOOK_SECRET_BRL", "XPAYMENTS_WEBHOOK_SECRET_EUR"):
    state = "SET" if env.get(key, "") else "MISSING_OR_EMPTY"
    print(f"{key}: {state}")

for key in ("XPAYMENTS_NATIVE_METHODS_BRL", "XPAYMENTS_NATIVE_METHODS_EUR"):
    print(f"{key}={env.get(key, 'MISSING')}")

if problems:
    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    raise SystemExit(2)
PY

log "Building and recreating only MyPets API"
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

[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || {
  docker logs --tail 180 "$API_CONTAINER" || true
  fail "MyPets API did not become healthy"
}

log "Verifying runtime is still financially closed"
RUNTIME_LIVE="$(docker exec "$API_CONTAINER" sh -lc 'printf "%s" "${PAYMENTS_LIVE:-MISSING}"')"
echo "Runtime PAYMENTS_LIVE=$RUNTIME_LIVE"
[ "$RUNTIME_LIVE" = "false" ] || fail "Preflight requires runtime PAYMENTS_LIVE=false"

log "Checking public API"
curl -fsS https://api.mypets.lat/health
echo
CONFIG="$(curl -fsS https://api.mypets.lat/v1/config)"
echo "$CONFIG"

python3 - "$CONFIG" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
data = payload.get("data", {})
if data.get("brand") != "mypets" or data.get("environment") != "production":
    raise SystemExit("ERROR: unexpected public config")
if data.get("paymentsLive") is not False:
    raise SystemExit("ERROR: payments unexpectedly live during preflight")
print("Public payments remain closed: OK")
print("Configured payment currencies:", data.get("paymentCurrencies", []))
print("Configured webhook currencies:", data.get("paymentWebhookCurrencies", []))
PY

echo
echo "============================================================"
echo "MyPets launch preflight v11 complete."
echo "Backend is current, healthy and PAYMENTS_LIVE remains false."
echo "Webhook/API secrets were never printed."
echo "No Caddy, XPAYMENTS Store, payout or unrelated database settings were changed."
echo "============================================================"
