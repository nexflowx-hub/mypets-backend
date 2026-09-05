# MyPets product model v2

## Product principle

One authenticated account represents one person. A person may participate in several ways at the same time.

### Participation roles

- `PROTECTOR` — rescues, fosters, feeds, treats or coordinates animal welfare cases.
- `VOLUNTEER` — offers time, transport, foster care, skills or local help.
- `DONOR` — makes one-time financial contributions.
- `SPONSOR` — supports a pet/cause on an ongoing basis (padrinho/madrinha).
- `ADOPTER` — is interested in responsible adoption.
- `SUPPORTER` — follows, shares and amplifies causes.

Roles are additive. They are not separate accounts.

## Core entities

### Profile

Private/account-level identity and preferences. It should remain small and avoid collecting data that is not needed.

### Protector

A public-facing module attached to a profile when the user acts as a protector. Verification evidence is always private.

### Pet / FacePets

A real animal record with a stable FacePets ID, public story, status, media, updates and linked needs.

### Need

A concrete request for help, e.g. food, veterinarian, medication, transport, foster care, adoption or volunteers. A need is operational and can be resolved.

### Cause (next milestone)

A public mobilisation/fundraising funnel. A cause can target a pet, protector, need or MyPets network initiative. It owns the public CTA strategy and will later bind to an XPAYMENTS store.

A need may create or link to a cause, but the two concepts remain distinct: a need describes what is required; a cause describes how the public is mobilised.

### Story / Update

Narrative content. Pet story is the canonical origin story; pet updates form the timeline. Editorial case stories may later live in the content system rather than in the legacy `stories` seed table.

## Media strategy

Existing `pet_media` is the canonical metadata table. The target storage design is:

1. Browser asks MyPets API for an upload authorisation for a pet it owns.
2. API verifies ownership and issues a short-lived Supabase Storage upload URL.
3. Original upload lands in a private/pending area.
4. File type, size, image metadata and moderation checks run before publication.
5. Approved media receives a stable public asset path used on public/SEO pages.
6. `pet_media` stores bucket/path, provenance, caption, order and visibility.

Do not expose a Supabase secret/service-role key to the browser.

Recommended constraints: JPEG/PNG/WebP/HEIC input, image-only initially, maximum 10 MB, strip EXIF/GPS metadata, generate web-ready derivatives, retain original privately when needed.

## Social profiles

Protector social URLs are public opt-in data. Supported first-class keys: Instagram, Facebook, TikTok, YouTube and website. Only valid HTTP(S) links are exposed publicly.

## Sharing funnel

Every protector, pet and later every cause should have a canonical share action.

Phase 1: native Web Share API, WhatsApp and copy-link actions.

Phase 2: trackable short links:

- `share_links`: code, entity type/id, creator, campaign/source.
- `share_events`: click/landing/conversion events with privacy-preserving analytics.
- `/s/:code`: records the referral and redirects to the canonical entity page.

A shared link should preserve referral context through the funnel so later conversions can be attributed to follow, volunteer, sponsorship or donation actions.

## Sponsorship (padrinho/madrinha)

Sponsorship is not merely a monthly donation flag. It should become an explicit relationship:

- supporter profile
- target pet/cause
- status (`INTERESTED`, `PENDING`, `ACTIVE`, `PAUSED`, `ENDED`)
- cadence and financial terms only after XPAYMENTS integration
- communication/follow preferences
- start/end dates

A sponsor can remain anonymous publicly while still being authenticated privately.

## XPAYMENTS boundary

MyPets owns its domain model. XPAYMENTS is a payment provider adapter.

Planned provider-neutral tables:

- `payment_accounts`
- `payment_stores`
- `payment_store_bindings`
- `payment_methods`
- `payment_intents`
- `payment_transactions`
- `payment_webhook_events`
- `payment_ledger`

The intended model can support one XPAYMENTS account and a store per cause if API limits and operational rules permit. The `payment_store_bindings` layer prevents the MyPets domain from depending directly on XPAYMENTS identifiers.

No contribution may be marked paid from a browser callback. Provider webhooks/verified server-side events are authoritative.

## Editorial content: blog, guides and resources

Use a dedicated content model rather than overloading animal stories:

- `articles`
- `article_categories`
- `article_tags`
- `article_revisions`
- media relationships

Article kinds may include `GUIDE`, `NEWS`, `EDUCATION`, `SUCCESS_STORY`, `ADOPTION`, and `WELFARE`.

Guides involving veterinary/health topics should have sources, review dates and clear escalation to qualified veterinary care; AI-generated text must not be auto-published without review.

## Community forum

Reading can be public without an account. Guest writing can also be supported, but not as unrestricted raw publication.

Guest post pipeline:

1. nickname + optional private email
2. bot challenge (e.g. Turnstile)
3. IP/request rate limits at the edge/API
4. spam/scam/content checks
5. first guest posts default to moderation queue
6. reporting and moderator actions

Tables planned: `forum_threads`, `forum_posts`, `forum_reports`, `moderation_events`.

Do not publish guest email addresses. Avoid storing raw IP addresses in content records; abuse/security logs should have explicit retention rules.

## AI webchat

The webchat should be a MyPets assistant, not a payment processor or veterinary diagnostician.

Core tools:

- search pets/protectors/causes/needs
- explain how to help
- recommend volunteering opportunities
- navigate adoption resources
- retrieve reviewed guides/articles
- prepare a donation/sponsorship intent
- hand the user to secure XPAYMENTS checkout when payments are live

The chat must never request or handle raw card credentials. Veterinary content is informational and should route emergencies/diagnosis to a qualified veterinarian.

Architecture target:

`Next.js chat UI -> MyPets AI API -> model provider + MyPets tools -> canonical MyPets API/DB`

Model/provider should be abstracted. Conversations should have clear consent/retention rules and minimise personal data.

## Public/demo content rule

Production does not expose `is_demo=true` stories or metrics. Empty states are preferable to presenting fictional impact as real. Payment mock flows are also blocked publicly while `PAYMENTS_LIVE=false`.
