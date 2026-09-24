-- Launch goal and immutable 1 kg commitment metadata for the MyPets ebook-to-feed campaign.
-- Existing confirmed units keep their 1 kg promise; this migration only declares the current launch target.

update public.causes
set
  target_amount_cents = 129000,
  campaign_meta = coalesce(campaign_meta, '{}'::jsonb)
    || '{
      "goalKg":100,
      "goalLabel":"Meta de lançamento: 100 kg",
      "unitType":"DOG_FOOD_KG",
      "unitQuantity":1,
      "unitPriceCents":1290,
      "unitCurrency":"BRL",
      "commitmentPolicy":"Cada participação financeira confirmada nesta versão representa 1 kg de ração. O MyPets preserva a quantidade confirmada mesmo se o custo de aquisição mudar; somente novas participações podem ter preço unitário revisto."
    }'::jsonb,
  updated_at = now()
where id = '9a7f1000-0000-4a11-8c01-000000000007'::uuid
   or slug = 'mypets-ebook-racao-brl';
