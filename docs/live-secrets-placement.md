# MyPets live payment secrets placement

MyPets payment credentials are owned by the backend runtime at `api.mypets.lat`, not by the public frontend deployment.

Production source of truth:

- VPS env file: `/srv/apps/mypets/env/api.env`
- Backend container: `mypets-api`
- Provider: XPAYMENTS

The Vercel frontend should not hold or use XPAYMENTS live API keys or webhook secrets. Public frontend configuration should consume `/v1/config` and the MyPets payment API instead.

Required backend variables include:

- `PAYMENT_PROVIDER=xpayments`
- `PAYMENTS_LIVE=false` until live certification completes
- `XPAYMENTS_STORE_CODE_BRL=MYPETS-BRL`
- `XPAYMENTS_API_KEY_BRL`
- `XPAYMENTS_WEBHOOK_SECRET_BRL`
- `XPAYMENTS_NATIVE_METHODS_BRL=pix`
- `XPAYMENTS_STORE_CODE_EUR=MYPETS-EUR`
- `XPAYMENTS_API_KEY_EUR`
- `XPAYMENTS_WEBHOOK_SECRET_EUR`
- `XPAYMENTS_NATIVE_METHODS_EUR=mb_way,multibanco,bizum`

Do not commit secret values to Git.
