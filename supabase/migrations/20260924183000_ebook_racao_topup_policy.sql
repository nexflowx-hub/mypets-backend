-- Free-form top-ups are allowed on the ebook campaign without increasing the guaranteed kg count.
-- The public kg goal is therefore tracked from confirmed payment metadata, not from cause.raised_amount_cents / unit price.

update public.causes
set
  target_amount_cents = null,
  campaign_meta = coalesce(campaign_meta, '{}'::jsonb)
    || '{
      "goalKg":100,
      "topUpAllowed":true,
      "topUpPolicy":"Any amount above the selected ebook base price is additional support to the MyPets food campaign and does not increase the guaranteed ebook/kg entitlement unless another ebook unit is explicitly selected.",
      "impactMetricSource":"payment_intent.rewardKeys"
    }'::jsonb,
  updated_at = now()
where id = '9a7f1000-0000-4a11-8c01-000000000007'::uuid
   or slug = 'mypets-ebook-racao-brl';
