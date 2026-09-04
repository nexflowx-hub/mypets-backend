#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_DIR="/srv/apps/mypets/env"
REPO_URL="https://github.com/nexflowx-hub/mypets-backend.git"
COMPOSE_FILE="$APP_DIR/deploy/compose.yml"
CADDY_CONTAINER="atlaswallet-caddy-1"
CADDYFILE_HOST="/opt/atlaswallet/backend/deploy/Caddyfile"
EDGE_NETWORK="mypets_edge"
API_CONTAINER="mypets-api"
API_DOMAIN="api.mypets.lat"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
command -v docker >/dev/null || fail "Docker is required"
command -v git >/dev/null || fail "git is required"
docker compose version >/dev/null || fail "Docker Compose plugin is required"
docker inspect "$CADDY_CONTAINER" >/dev/null 2>&1 || fail "Existing Caddy container $CADDY_CONTAINER not found"
[ -f "$CADDYFILE_HOST" ] || fail "Expected AtlasWallet Caddyfile not found at $CADDYFILE_HOST"

log "Checking Caddyfile mount"
if ! docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' | grep -Fq "$CADDYFILE_HOST -> /etc/caddy/Caddyfile"; then
  echo "Caddy mounts are:"
  docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
  fail "Caddyfile mount differs from expected path; refusing to edit AtlasWallet proxy"
fi

log "Syncing backend repository"
install -d -m 0750 /srv/apps/mypets "$ENV_DIR" /srv/apps/mypets/logs /srv/apps/mypets/backups
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --prune origin main
  git -C "$APP_DIR" reset --hard origin/main
elif [ ! -e "$APP_DIR" ] || [ -z "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
  rm -rf "$APP_DIR"
  git clone --branch main --single-branch "$REPO_URL" "$APP_DIR"
else
  fail "$APP_DIR exists and is not an empty directory or Git checkout"
fi

log "Database configuration"
echo "Paste the Supabase SESSION POOLER connection string (port 5432)."
echo "It will NOT be echoed and will only be written to /srv/apps/mypets/env/api.env (0600)."
read -r -s -p "Supabase Session Pooler URL: " DB_URL
echo
case "$DB_URL" in
  postgres://*|postgresql://*) ;;
  *) fail "Connection string must start with postgres:// or postgresql://" ;;
esac

umask 077
{
  printf '%s\n' 'APP_ENV=production'
  printf '%s\n' 'APP_VERSION=0.1.0'
  printf '%s\n' 'HOST=0.0.0.0'
  printf '%s\n' 'PORT=8081'
  printf 'DATABASE_URL=%s\n' "$DB_URL"
  printf 'DIRECT_URL=%s\n' "$DB_URL"
  printf '%s\n' 'CORS_ORIGINS=https://mypets.lat,https://www.mypets.lat'
  printf '%s\n' 'SHOW_DEMO_IMPACT=true'
  printf '%s\n' 'PAYMENT_PROVIDER=mock'
  printf '%s\n' 'PAYMENTS_LIVE=false'
  printf '%s\n' 'PAYOUTS_ENABLED=false'
  printf '%s\n' 'LOG_LEVEL=info'
} > "$ENV_DIR/api.env"
chmod 600 "$ENV_DIR/api.env"
unset DB_URL

log "Creating isolated MyPets edge network if needed"
docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || docker network create "$EDGE_NETWORK" >/dev/null

log "Applying canonical Supabase schema and demo seed"
DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_DIR/api.env")"
docker run --rm \
  -e DIRECT_URL="$DB_URL" \
  -v "$APP_DIR/supabase:/sql:ro" \
  postgres:16-alpine \
  sh -ec 'psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f /sql/migrations/20260904193000_init.sql && psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f /sql/seed.sql'
unset DB_URL

log "Building and starting MyPets API"
docker compose -p mypets -f "$COMPOSE_FILE" up -d --build

log "Waiting for API health"
for i in $(seq 1 30); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "unhealthy" ]; then
    docker logs --tail 120 "$API_CONTAINER" || true
    fail "MyPets API became unhealthy"
  fi
  sleep 2
done
[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER")" = "healthy" ] || {
  docker logs --tail 120 "$API_CONTAINER" || true
  fail "MyPets API did not become healthy"
}

log "Connecting existing AtlasWallet Caddy container to MyPets edge network"
if ! docker inspect "$CADDY_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep -Fxq "$EDGE_NETWORK"; then
  docker network connect "$EDGE_NETWORK" "$CADDY_CONTAINER"
fi

log "Testing API from the shared Docker network"
docker run --rm --network "$EDGE_NETWORK" curlimages/curl:8.12.1 -fsS "http://$API_CONTAINER:8081/health"
echo

log "Configuring Caddy route for $API_DOMAIN"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/srv/apps/mypets/backups/Caddyfile.${TS}.bak"
cp -a "$CADDYFILE_HOST" "$BACKUP"

if ! grep -Eq '^[[:space:]]*api\.mypets\.lat([[:space:]]|\{)' "$CADDYFILE_HOST"; then
  cat >> "$CADDYFILE_HOST" <<'CADDYEOF'

# BEGIN MYPETS API
api.mypets.lat {
    encode zstd gzip
    reverse_proxy mypets-api:8081 {
        health_uri /health
        health_interval 30s
        health_timeout 5s
    }
    header {
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
# END MYPETS API
CADDYEOF
fi

log "Validating Caddy configuration before reload"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile; then
  cp -a "$BACKUP" "$CADDYFILE_HOST"
  docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile || true
  fail "New Caddy configuration invalid; original Caddyfile restored"
fi

log "Applying Caddy configuration"
if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile 2>/tmp/mypets-caddy-reload.err; then
  log "Caddy reloaded via admin API"
else
  cat /tmp/mypets-caddy-reload.err >&2 || true
  log "Admin API unavailable; sending SIGUSR1 to reload the startup Caddyfile"
  docker kill --signal=USR1 "$CADDY_CONTAINER" >/dev/null
  sleep 3

  if docker logs --since 10s "$CADDY_CONTAINER" 2>&1 | grep -qiE 'reload|config|adapted|serving'; then
    log "Caddy accepted reload signal"
  else
    log "Could not confirm signal-based reload; restarting only the Caddy container"
    docker restart "$CADDY_CONTAINER" >/dev/null
    sleep 3
  fi
fi
rm -f /tmp/mypets-caddy-reload.err

log "Verifying Caddy is running"
[ "$(docker inspect -f '{{.State.Running}}' "$CADDY_CONTAINER")" = "true" ] || fail "Caddy container is not running"

log "Final internal checks"
docker ps --filter name=mypets-api --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'
docker run --rm --network "$EDGE_NETWORK" curlimages/curl:8.12.1 -fsS "http://$API_CONTAINER:8081/v1/stories" >/dev/null
echo "Internal API check: OK"

echo
echo "============================================================"
echo "MyPets API deployment completed."
echo "Caddy backup: $BACKUP"
echo "Next external checks:"
echo "  https://api.mypets.lat/health"
echo "  https://api.mypets.lat/v1/stories"
echo "  https://api.mypets.lat/v1/impact/public"
echo "============================================================"
