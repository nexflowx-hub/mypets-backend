# MyPets Commerce V1

## Scope

Commerce is a separate bounded context from causes, funds, support intents and contributions.

Never write store orders or store payments into support/contribution tables.

## Markets

| Market | Currency | Legal entity code | Payment profile | Initial state |
| --- | --- | --- | --- | --- |
| BR | BRL | MYPETS_BR | XPAYMENTS_BR | enabled |
| UK | GBP | HUMAN_IMPACT_UK | XPAYMENTS_INTL | preparing |
| EU | EUR | HUMAN_IMPACT_UK | XPAYMENTS_INTL | preparing |

`legal_entity_code` is persisted on every order as an immutable seller-routing snapshot. The checkout must display the same seller before payment confirmation.

## Core tables

- `commerce_markets`
- `commerce_products`
- `commerce_product_variants`
- `commerce_product_offers`
- `commerce_inventory_locations`
- `commerce_inventory`
- `commerce_orders`
- `commerce_order_items`
- `commerce_payments`
- `commerce_refunds`

## Order invariants

1. One order belongs to exactly one market and one currency.
2. One order has one seller/legal-entity snapshot.
3. Payment provider routing comes from the market/payment profile, never from the browser alone.
4. An order is not paid until a provider-confirmed financial state is persisted.
5. A checkout session or QR creation does not mean payment success.
6. Refunds reference the original commercial payment.
7. Support/contribution flows remain separate from commerce.

## Intended API surface

The SQL migration only creates the persistence contract. Public commerce endpoints should be introduced in a follow-up implementation after provider credentials, shipping rules and real catalog inventory are approved.

Suggested surface:

- `GET /v1/commerce/markets`
- `GET /v1/commerce/products?market=BR`
- `GET /v1/commerce/products/:slug?market=BR`
- `POST /v1/commerce/orders`
- `GET /v1/commerce/orders/:id`
- `POST /v1/commerce/orders/:id/payments`
- `POST /v1/commerce/orders/:id/refunds` (authenticated/admin)

## Launch rule

BR can be enabled first. UK/EU remain disabled until the relevant payment account, tax/VAT position, delivery model, returns address and real offers are approved.
