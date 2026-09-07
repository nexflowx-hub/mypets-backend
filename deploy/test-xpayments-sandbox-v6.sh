#!/usr/bin/env bash
set -Eeuo pipefail

API_CONTAINER="mypets-api"
CURRENCY="${1:-EUR}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[[ "$CURRENCY" == "EUR" || "$CURRENCY" == "BRL" ]] || fail "Usage: $0 [EUR|BRL]"
docker inspect "$API_CONTAINER" >/dev/null 2>&1 || fail "Container $API_CONTAINER not found"

STORE_CODE="$(docker exec "$API_CONTAINER" sh -lc "printenv XPAYMENTS_SANDBOX_STORE_CODE" 2>/dev/null || true)"
KEY_PREFIX="$(docker exec "$API_CONTAINER" sh -lc "value=\$(printenv XPAYMENTS_SANDBOX_API_KEY); printf '%s' \"\${value:0:8}\"" 2>/dev/null || true)"

[ -n "$STORE_CODE" ] || fail "XPAYMENTS_SANDBOX_STORE_CODE is not configured"
[[ "$KEY_PREFIX" == "xp_test_" ]] || fail "XPAYMENTS_SANDBOX_API_KEY must be an xp_test_ key"

echo "XPAYMENTS sandbox preflight"
echo "Currency: $CURRENCY"
echo "Store:    $STORE_CODE"
echo "Key:      xp_test_... (hidden)"
echo

# The same compiled adapter is used with process-local sandbox overrides. Public
# EUR/BRL credentials remain untouched, even if PAYMENTS_LIVE is enabled.
docker exec "$API_CONTAINER" node --input-type=module -e "
  const currency = '$CURRENCY';
  const sandboxKey = process.env.XPAYMENTS_SANDBOX_API_KEY || '';
  const sandboxStore = process.env.XPAYMENTS_SANDBOX_STORE_CODE || '';
  if (!sandboxKey.startsWith('xp_test_')) throw new Error('Missing sandbox key');
  if (!sandboxStore) throw new Error('Missing sandbox Store');
  process.env['XPAYMENTS_API_KEY_' + currency] = sandboxKey;
  process.env['XPAYMENTS_STORE_CODE_' + currency] = sandboxStore;
  process.env.PAYMENTS_LIVE = 'false';

  const mod = await import('/app/dist/payments/xpayments.js');
  const reference = 'MYPETS-PREFLIGHT-' + Date.now();
  const session = await mod.createXPaymentsSession({
    amountCents: 100,
    currency,
    reference,
    customerEmail: null,
    metadata: {
      source: 'mypets_vps_preflight',
      environment: 'sandbox',
      purpose: 'connectivity_test'
    }
  });
  console.log(JSON.stringify({
    ok: true,
    reference,
    storeCode: session.storeCode,
    sessionId: session.sessionId,
    checkoutUrl: session.checkoutUrl,
    embedUrl: session.embedUrl
  }, null, 2));
"

echo
echo "Preflight session created successfully."
echo "Dedicated sandbox credentials were used; public EUR/BRL routing was not changed."
echo "Open the checkout URL only when you are ready to perform a sandbox payment test."
