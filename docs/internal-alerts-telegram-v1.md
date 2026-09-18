# MyPets Internal Alerts + Telegram V1

## Purpose

Persist every important operational event inside MyPets and optionally notify the internal team in Telegram.

The alert system is deliberately decoupled from business success. If Telegram is down, a cause intake, lead, support offer or payment must still complete.

## Data model

- `public.internal_alerts`: canonical event/ticket log.
- `public.internal_alert_deliveries`: notification outbox with retries and delivery state.

Both tables have RLS enabled and browser roles (`anon`, `authenticated`) have all privileges revoked. They are internal server-side tables.

## Default Telegram events

- `CAUSE_INTAKE_CREATED` — new community cause; OPEN ticket.
- `NEED_CREATED` — new authenticated support need; OPEN ticket.
- `SUPPORT_OFFER_CREATED` — new support offer/message; OPEN ticket.
- `GROWTH_LEAD_CREATED` — new lead/contact message; OPEN ticket.
- `PAYMENT_SUCCEEDED` — newly confirmed XPAYMENTS support; LOGGED event.
- `REPORT_CREATED` — new abuse/report submission; OPEN ticket.

Future WebChat/WhatsApp messages should emit through the same `emitInternalAlert()` function instead of calling Telegram directly.

## Telegram configuration

Environment variables:

```text
TELEGRAM_ALERT_ENABLED=true
TELEGRAM_ALERT_BOT_TOKEN=<BotFather token>
TELEGRAM_ALERT_CHAT_ID=<private group/channel chat id>
TELEGRAM_ALERT_THREAD_ID=<optional Telegram forum topic id>
TELEGRAM_ALERT_EVENTS=<optional comma list or *>
```

Keep the bot token only in the backend environment.

Telegram Bot API delivery uses HTTPS `sendMessage`. A delivery is first persisted as `PENDING`; the dispatcher claims it, sends it, and marks it `SENT` or schedules retry with exponential backoff.

## Reliability

- Immediate best-effort dispatch after event creation.
- Background dispatcher every 15 seconds.
- Failed deliveries retry with backoff up to 8 attempts.
- Stale `SENDING` claims are recovered after 5 minutes.
- Payment alerts are deduplicated by MyPets payment intent id.
- All alert emitters catch their own failures so they cannot break customer-facing flows.

## Admin API

Authenticated MyPets admins:

- `GET /v1/admin/internal-alerts/config`
- `GET /v1/admin/internal-alerts/summary`
- `GET /v1/admin/internal-alerts`
- `PATCH /v1/admin/internal-alerts/:id`
- `POST /v1/admin/internal-alerts/:id/retry-telegram`

Ticket actions: `ACKNOWLEDGE`, `RESOLVE`, `IGNORE`, `REOPEN`.

## Privacy

Telegram notifications intentionally avoid sending email addresses, phone numbers, payment credentials or raw KYC data. Event metadata in the DB can contain operational references but should continue following data minimization.

## Production rollout

1. Apply `20260918004500_internal_alerts_telegram_v1.sql`.
2. Deploy/rebuild the API.
3. Confirm API health.
4. Leave `TELEGRAM_ALERT_ENABLED=false` until the private bot/group is ready.
5. Add bot token/chat id to `/srv/apps/mypets/env/api.env`.
6. Set `TELEGRAM_ALERT_ENABLED=true` and restart `mypets-api`.
7. Create one controlled real or admin test event and confirm delivery.

Do not place Telegram secrets in GitHub, frontend environment variables or Notion.
