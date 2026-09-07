#!/usr/bin/env bash
set -Eeuo pipefail

API_CONTAINER="mypets-api"
CURRENCY="${1:-EUR}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run as root"
[[ "$CURRENCY" == "EUR" || "$CURRENCY" == "BRL" ]] || fail "Usage: $0 [EUR|BRL]"
docker inspect "$API_CONTAINER" >/dev/null 2>&1 || fail "Container $API_CONTAINER not found"

KEY_VAR="XPAYMENTS_API_KEY_${CURRENCY}"
STORE_VAR="XPAYMENTS_STORE_CODE_${CURRENCY}"

KEY_PREFIX="$(docker exec "$API_CONTAINER" sh -lc "value=\$(printenv '$KEY_VAR'); printf '%s' \"\${value:0:8}\"" 2>/dev/null || true)"
STORE_CODE="$(docker exec "$API_CONTAINER" sh -lc "printenv '$STORE_VAR'" 2>/dev/null || true)"

[ -n "$STORE_CODE" ] || fail "$STORE_VAR is not configured"
[[ "$KEY_PREFIX" == "xp_test_" ]] || fail "$KEY_VAR must be an xp_test_ key for this sandbox preflight"

echo "XPAYMENTS sandbox preflight"
echo "Currency: $CURRENCY"
echo "Store:    $STORE_CODE"
echo "Key:      xp_test_... (hidden)"
echo

# Run through the same compiled adapter used by the MyPets API. The API key stays
# inside the container environment and is never printed or passed on the command line.
docker exec "$API_CONTAINER" node --input-type=module -e "
  const mod = await import('/app/dist/payments/xpayments.js');
  const currency = '$CURRENCY';
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
echo "This does NOT enable PAYMENTS_LIVE and does not credit any MyPets cause."
echo "Open the checkout URL only when you are ready to perform the sandbox payment test."
