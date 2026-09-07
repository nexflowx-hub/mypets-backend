#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/srv/apps/mypets/api"
ENV_FILE="/srv/apps/mypets/env/api.env"
API_CONTAINER="mypets-api"
CURRENCY="${1:-EUR}"
AMOUNT_CENTS="${2:-100}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE"
[[ "$CURRENCY" =~ ^(EUR|BRL)$ ]] || fail "Currency must be EUR or BRL"
[[ "$AMOUNT_CENTS" =~ ^[0-9]+$ ]] || fail "Amount must be integer cents"
[ "$AMOUNT_CENTS" -ge 100 ] || fail "Minimum sandbox amount is 100 cents"

PAYMENTS_LIVE="$(sed -n 's/^PAYMENTS_LIVE=//p' "$ENV_FILE" | tail -1)"
[ "$PAYMENTS_LIVE" != "true" ] || fail "Refusing sandbox preparation while PAYMENTS_LIVE=true"

API_KEY="$(sed -n "s/^XPAYMENTS_API_KEY_${CURRENCY}=//p" "$ENV_FILE" | tail -1)"
[[ "$API_KEY" == xp_test_* ]] || fail "${CURRENCY} must be configured with an xp_test_ key"
unset API_KEY

DB_URL="$(sed -n 's/^DIRECT_URL=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_URL" ] || fail "DIRECT_URL is missing"

RUN_TOKEN="$(date -u +%Y%m%d%H%M%S)-$RANDOM"
REFERENCE="MYPETS-SANDBOX-${RUN_TOKEN}"
SLUG="xpayments-sandbox-${RUN_TOKEN,,}"
IDEMPOTENCY="sandbox-${RUN_TOKEN}"
TARGET_CENTS=$((AMOUNT_CENTS * 10))

printf '\n==> Creating hidden MyPets sandbox cause + payment intent\n'
SQL="
with chosen_protector as (
  select id
  from public.protectors
  where status = 'ACTIVE'
  order by created_at asc
  limit 1
), created_cause as (
  insert into public.causes (
    protector_id, slug, title, summary, country, city,
    support_mode, target_amount_cents, raised_amount_cents,
    currency, status, is_public, published_at
  )
  select
    p.id,
    '${SLUG}',
    '[SANDBOX] XPAYMENTS E2E',
    'Hidden technical payment verification record. Not a real fundraising cause.',
    coalesce((select country from public.protectors where id = p.id), 'PT'),
    coalesce((select city from public.protectors where id = p.id), 'Sandbox'),
    'FINANCIAL',
    ${TARGET_CENTS},
    0,
    '${CURRENCY}',
    'ACTIVE',
    false,
    now()
  from chosen_protector p
  returning id, protector_id
), created_intent as (
  insert into public.payment_intents (
    id, cause_id, protector_id, provider, provider_reference,
    amount_cents, currency, frequency, status, idempotency_key,
    source, medium, campaign, metadata
  )
  select
    gen_random_uuid(),
    c.id,
    c.protector_id,
    'XPAYMENTS',
    '${REFERENCE}',
    ${AMOUNT_CENTS},
    '${CURRENCY}',
    'ONE_TIME',
    'CREATED',
    '${IDEMPOTENCY}',
    'sandbox',
    'server-test',
    'xpayments-e2e',
    jsonb_build_object('sandbox', true, 'testType', 'XPAYMENTS_E2E')
  from created_cause c
  returning id, cause_id, protector_id
)
select i.id, i.cause_id, i.protector_id
from created_intent i;
"

ROW="$(docker run --rm postgres:16-alpine \
  psql --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' \
  --dbname="$DB_URL" --command="$SQL" | tail -1)"

[ -n "$ROW" ] || fail "No active protector exists or sandbox records could not be created"
IFS='|' read -r INTENT_ID CAUSE_ID PROTECTOR_ID <<< "$ROW"
[[ "$INTENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Invalid intent id returned"
[[ "$CAUSE_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Invalid cause id returned"

printf 'Cause:     %s\n' "$CAUSE_ID"
printf 'Intent:    %s\n' "$INTENT_ID"
printf 'Reference: %s\n' "$REFERENCE"
printf 'Amount:    %s %s cents\n' "$CURRENCY" "$AMOUNT_CENTS"
printf 'Visibility: hidden (is_public=false)\n'

printf '\n==> Creating XPAYMENTS sandbox checkout session\n'
docker exec -i \
  -e XP_SANDBOX_INTENT_ID="$INTENT_ID" \
  -e XP_SANDBOX_CAUSE_ID="$CAUSE_ID" \
  -e XP_SANDBOX_PROTECTOR_ID="$PROTECTOR_ID" \
  -e XP_SANDBOX_REFERENCE="$REFERENCE" \
  -e XP_SANDBOX_CURRENCY="$CURRENCY" \
  -e XP_SANDBOX_AMOUNT_CENTS="$AMOUNT_CENTS" \
  "$API_CONTAINER" node --input-type=module - <<'NODE'
import { PrismaClient } from '@prisma/client';
import { createXPaymentsSession } from './dist/payments/xpayments.js';

const prisma = new PrismaClient();
const intentId = process.env.XP_SANDBOX_INTENT_ID;
const causeId = process.env.XP_SANDBOX_CAUSE_ID;
const protectorId = process.env.XP_SANDBOX_PROTECTOR_ID;
const reference = process.env.XP_SANDBOX_REFERENCE;
const currency = process.env.XP_SANDBOX_CURRENCY;
const amountCents = Number(process.env.XP_SANDBOX_AMOUNT_CENTS);

try {
  const session = await createXPaymentsSession({
    amountCents,
    currency,
    reference,
    customerEmail: null,
    metadata: {
      sandbox: true,
      testType: 'XPAYMENTS_E2E',
      mypetsIntentId: intentId,
      causeId,
      protectorId,
      targetType: 'CAUSE',
    },
  });

  await prisma.$executeRaw`
    update public.payment_intents
    set provider_store_code = ${session.storeCode},
        provider_session_id = ${session.sessionId},
        checkout_url = ${session.checkoutUrl},
        status = 'PENDING',
        updated_at = now()
    where id = ${intentId}::uuid
  `;

  console.log(JSON.stringify({
    ok: true,
    causeId,
    intentId,
    reference,
    amountCents,
    currency,
    sessionId: session.sessionId,
    checkoutUrl: session.checkoutUrl,
    embedUrl: session.embedUrl,
    storeCode: session.storeCode,
    paymentsLive: false,
  }, null, 2));
} catch (error) {
  await prisma.$executeRaw`
    update public.payment_intents
    set status = 'FAILED', updated_at = now()
    where id = ${intentId}::uuid
  `.catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
NODE

unset DB_URL

cat <<'TXT'

Sandbox preparation complete.
- The cause is hidden and cannot appear in public MyPets listings.
- PAYMENTS_LIVE remains false.
- Open only the returned XPAYMENTS checkout URL and use Stripe TEST data.
- After payment, run deploy/verify-xpayments-cause-sandbox-v7.sh <intent-id>.
TXT
