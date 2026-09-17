# MyPets Community Cause Intake V1

## Goal

Grow the public cause directory with low friction while keeping financial collection behind an explicit verification boundary.

## Trust ladder

### Level 1 — Community presence

A visitor can submit a cause without creating an account and without providing bank details or identity documents.

The platform creates the canonical public cause immediately with:

- `beneficiary_kind = COMMUNITY`
- `verification_status = UNVERIFIED`
- `fundraising_status = DISABLED`
- `support_mode = NON_FINANCIAL`
- stable `/causas/:slug` URL
- promotion queue status `QUEUED`

The public page must say that the content was submitted by the community and is not yet verified by MyPets.

Contact name, email and WhatsApp remain private unless the submitter explicitly opts into public WhatsApp display.

### Level 2 — MyPets Verified

The same cause can later be linked to an authenticated protector/beneficiary after human review, identity/document checks and ownership verification.

Promotion must preserve the existing cause ID/slug so SEO, shares and history remain stable.

Financial support must remain disabled until the PSP/payment-provider onboarding and beneficiary payout configuration are complete.

## Financial model

Do not market the MyPets beneficiary experience as a bank/payment account.

Use:

- verified beneficiary profile
- support payment ledger
- amount pending/available for payout
- provider/PSP settlement
- payout records

The payment provider remains responsible for actual payment processing and settlement according to the configured merchant/beneficiary model.

## Promotion

Every self-service cause receives one `cause_promotion_queue` record. `QUEUED` means editorial/automation work is pending; it never means that Instagram, Facebook or TikTok publishing already occurred.

Future n8n/social connectors can consume this queue after credentials, moderation rules and channel-specific approval are configured.

## Media

V1 accepts public media URLs and social links. Anonymous binary uploads are intentionally not exposed until a dedicated abuse-resistant upload flow is implemented (file limits, MIME validation, malware/moderation controls and storage isolation).

Large/local files can be collected through the official support channel during review.
