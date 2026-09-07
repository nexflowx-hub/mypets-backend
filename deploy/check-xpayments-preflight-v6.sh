#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
API_CONTAINER="mypets-api"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[ $# -eq 2 ] || fail "Usage: $0 <session-id> <reference>"

SESSION_ID="$1"
REFERENCE="$2"

[[ "$SESSION_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Invalid session id"
[[ "$REFERENCE" == MYPETS-PREFLIGHT-* ]] || fail "Expected a MYPETS-PREFLIGHT-* reference"

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

printf '\n==> XPAYMENTS checkout session\n'
docker exec -i -e XP_SESSION_ID="$SESSION_ID" "$API_CONTAINER" node --input-type=module - <<'NODE'
const id = process.env.XP_SESSION_ID;
const res = await fetch(`https://api.xpayments.digital/api/v1/checkout/session/${encodeURIComponent(id)}`, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(10000),
});
const body = await res.json().catch(() => ({}));
console.log(JSON.stringify({ httpStatus: res.status, body }, null, 2));
if (!res.ok) process.exit(2);
NODE

# Pass the reference as a connection setting instead of interpolating shell text into SQL.
# Preflight references are constrained to MYPETS-PREFLIGHT-* and contain no whitespace.
PGOPTIONS_REF="-c mypets.preflight_reference=${REFERENCE}"

printf '\n==> MyPets payment intent count for preflight reference (expected: 0)\n'
docker run --rm \
  -e PGOPTIONS="$PGOPTIONS_REF" \
  postgres:16-alpine \
  psql --set=ON_ERROR_STOP=1 --tuples-only --no-align --dbname="$DB_URL" --command="select count(*) from public.payment_intents where provider_reference = current_setting('mypets.preflight_reference');"

printf '\n==> MyPets webhook audit for preflight reference\n'
docker run --rm \
  -e PGOPTIONS="$PGOPTIONS_REF" \
  postgres:16-alpine \
  psql --set=ON_ERROR_STOP=1 --pset=pager=off --dbname="$DB_URL" --command="select event_type, signature_valid, processing_status, coalesce(processing_error,'') as processing_error, received_at from public.payment_provider_events where payload->>'reference' = current_setting('mypets.preflight_reference') order by received_at desc;"

unset DB_URL PGOPTIONS_REF

cat <<'TXT'

Expected after a successful sandbox payment:
- XPAYMENTS session reports a successful/completed state.
- MyPets payment_intent count remains 0 because this was only a preflight session.
- MyPets webhook audit contains a signed event with processing_status=IGNORED and processing_error=reference_not_found.

If the webhook table has no row yet, inspect the XPAYMENTS merchant webhook delivery/runtime before enabling public payments.
TXT
