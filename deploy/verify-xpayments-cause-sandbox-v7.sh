#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="/srv/apps/mypets/env/api.env"
API_CONTAINER="mypets-api"
INTENT_ID="${1:-}"
MODE="${2:-}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[[ "$INTENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Usage: $0 <intent-id> [--replay|--cleanup]"
[[ -z "$MODE" || "$MODE" == "--replay" || "$MODE" == "--cleanup" ]] || fail "Unknown mode: $MODE"

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

STATE_SQL="select p.id, p.cause_id, p.provider_reference, coalesce(p.provider_session_id,''), p.amount_cents, p.currency, p.status, coalesce(c.raised_amount_cents,0), coalesce(c.is_public,false), coalesce(c.title,''), coalesce(p.metadata->>'sandboxReplayVerifiedAt','') from public.payment_intents p left join public.causes c on c.id = p.cause_id where p.id = '${INTENT_ID}'::uuid limit 1;"

load_state() {
  docker run --rm postgres:16-alpine \
    psql --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' \
    --dbname="$DB_URL" --command="$STATE_SQL" | tail -1
}

ROW="$(load_state)"
[ -n "$ROW" ] || fail "Payment intent not found"
IFS='|' read -r ID CAUSE_ID REFERENCE SESSION_ID AMOUNT_CENTS CURRENCY INTENT_STATUS RAISED_CENTS IS_PUBLIC CAUSE_TITLE REPLAY_VERIFIED_AT <<< "$ROW"
[[ "$REFERENCE" =~ ^MYPETS-SANDBOX-[A-Za-z0-9._:-]+$ ]] || fail "Refusing to verify non-sandbox intent"
[ "$IS_PUBLIC" = "f" ] || fail "Sandbox cause unexpectedly public"

printf '\n==> MyPets sandbox state\n'
printf 'Intent:       %s\n' "$ID"
printf 'Cause:        %s\n' "$CAUSE_ID"
printf 'Reference:    %s\n' "$REFERENCE"
printf 'Amount:       %s %s cents\n' "$CURRENCY" "$AMOUNT_CENTS"
printf 'Intent:       %s\n' "$INTENT_STATUS"
printf 'Cause raised: %s cents\n' "$RAISED_CENTS"
printf 'Public:       %s\n' "$IS_PUBLIC"
printf 'Title:        %s\n' "$CAUSE_TITLE"
printf 'Replay check: %s\n' "${REPLAY_VERIFIED_AT:-not verified}"

if [[ "$SESSION_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
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
else
  echo "No XPAYMENTS session id recorded."
fi

printf '\n==> MyPets webhook audit\n'
WEBHOOK_SQL="select event_type, signature_valid, processing_status, coalesce(processing_error,'') as processing_error, payload->>'transaction_id' as transaction_id, payload->>'status' as provider_status, received_at from public.payment_provider_events where payload->>'reference' = '${REFERENCE}' order by received_at desc;"
docker run --rm postgres:16-alpine \
  psql --set=ON_ERROR_STOP=1 --pset=pager=off --dbname="$DB_URL" --command="$WEBHOOK_SQL"

if [ "$MODE" = "--replay" ]; then
  [ "$INTENT_STATUS" = "SUCCEEDED" ] || fail "Replay test requires intent status SUCCEEDED first"
  [ "$RAISED_CENTS" -eq "$AMOUNT_CENTS" ] || fail "Replay test requires raised amount to equal the sandbox amount before replay"

  EVENT_SQL="select payload->>'event', payload->>'transaction_id', payload->>'reference', payload->>'amount', payload->>'currency', coalesce(payload->>'status',''), coalesce(payload->>'method',''), payload->>'timestamp' from public.payment_provider_events where payload->>'reference' = '${REFERENCE}' and signature_valid is true order by received_at desc limit 1;"
  EVENT_ROW="$(docker run --rm postgres:16-alpine \
    psql --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' \
    --dbname="$DB_URL" --command="$EVENT_SQL" | tail -1)"
  [ -n "$EVENT_ROW" ] || fail "No signed webhook event available for replay"
  IFS='|' read -r EVENT TX_ID EVENT_REF EVENT_AMOUNT EVENT_CURRENCY EVENT_STATUS EVENT_METHOD EVENT_TIMESTAMP <<< "$EVENT_ROW"

  printf '\n==> Replaying the signed sandbox webhook once\n'
  docker exec -i \
    -e XP_REPLAY_EVENT="$EVENT" \
    -e XP_REPLAY_TX_ID="$TX_ID" \
    -e XP_REPLAY_REFERENCE="$EVENT_REF" \
    -e XP_REPLAY_AMOUNT="$EVENT_AMOUNT" \
    -e XP_REPLAY_CURRENCY="$EVENT_CURRENCY" \
    -e XP_REPLAY_STATUS="$EVENT_STATUS" \
    -e XP_REPLAY_METHOD="$EVENT_METHOD" \
    -e XP_REPLAY_TIMESTAMP="$EVENT_TIMESTAMP" \
    "$API_CONTAINER" node --input-type=module - <<'NODE'
import crypto from 'node:crypto';

const secret = process.env.XPAYMENTS_SANDBOX_WEBHOOK_SECRET || '';
if (!secret.startsWith('whsec_')) throw new Error('Missing XPAYMENTS_SANDBOX_WEBHOOK_SECRET');

const payload = {
  event: process.env.XP_REPLAY_EVENT,
  transaction_id: process.env.XP_REPLAY_TX_ID,
  reference: process.env.XP_REPLAY_REFERENCE,
  amount: process.env.XP_REPLAY_AMOUNT,
  currency: process.env.XP_REPLAY_CURRENCY,
  status: process.env.XP_REPLAY_STATUS,
  method: process.env.XP_REPLAY_METHOD || null,
  timestamp: process.env.XP_REPLAY_TIMESTAMP,
};
const raw = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
const response = await fetch('https://api.mypets.lat/v1/payments/webhooks/xpayments-sandbox', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-nexflowx-signature': signature,
  },
  body: raw,
  signal: AbortSignal.timeout(10000),
});
const body = await response.json().catch(() => ({}));
console.log(JSON.stringify({ httpStatus: response.status, body }, null, 2));
if (!response.ok) process.exit(2);
NODE

  ROW_AFTER="$(load_state)"
  IFS='|' read -r _ _ _ _ _ _ STATUS_AFTER RAISED_AFTER _ _ _ <<< "$ROW_AFTER"
  printf '\n==> State after replay\n'
  printf 'Intent status: %s\n' "$STATUS_AFTER"
  printf 'Cause raised:  %s cents\n' "$RAISED_AFTER"
  [ "$STATUS_AFTER" = "SUCCEEDED" ] || fail "Intent lost SUCCEEDED state after replay"
  [ "$RAISED_AFTER" -eq "$AMOUNT_CENTS" ] || fail "IDEMPOTENCY FAILURE: cause amount changed after duplicate webhook"

  docker run --rm postgres:16-alpine \
    psql --set=ON_ERROR_STOP=1 --dbname="$DB_URL" --command="update public.payment_intents set metadata = metadata || jsonb_build_object('sandboxReplayVerifiedAt', now()) where id = '${INTENT_ID}'::uuid;" >/dev/null

  echo "Idempotency PASS: duplicate webhook did not increment the cause again."
  echo "Replay verification recorded on the sandbox payment intent."
fi

if [ "$MODE" = "--cleanup" ]; then
  [ "$INTENT_STATUS" = "SUCCEEDED" ] || fail "Cleanup is allowed only after a successful sandbox payment"
  [ -n "$REPLAY_VERIFIED_AT" ] || fail "Cleanup blocked: run --replay successfully before removing the sandbox cause"
  printf '\n==> Removing hidden sandbox cause\n'
  docker run --rm postgres:16-alpine \
    psql --set=ON_ERROR_STOP=1 --dbname="$DB_URL" --command="delete from public.causes where id = '${CAUSE_ID}'::uuid and is_public = false and title = '[SANDBOX] XPAYMENTS E2E';"
  echo "Hidden sandbox cause removed. Payment intent and provider audit remain for traceability."
fi

unset DB_URL

cat <<'TXT'

PASS criteria before/after live activation:
- XPAYMENTS sandbox session status = succeeded/completed.
- MyPets sandbox payment_intent status = SUCCEEDED.
- Hidden cause raised_amount_cents equals exactly the test payment amount.
- Sandbox webhook signature_valid = true and processing_status = PROCESSED.
- With --replay, raised_amount_cents remains unchanged after the duplicate webhook.
- Sandbox credentials remain isolated from public EUR/BRL Stores.
TXT
