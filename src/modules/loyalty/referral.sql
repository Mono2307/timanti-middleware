-- Referral programme tables (src/modules/loyalty/referral.js). Run once in the Supabase SQL editor
-- before the referral deploy goes live. Safe to re-run.

-- One code per referring customer, made the first time they open their "Refer a friend" card (or
-- when staff tag a draft with their phone). The link is https://timanti.in/?ref=<code>.
create table if not exists referral_codes (
  customer_id  text primary key,
  code         text not null unique,
  created_at   timestamptz not null default now()
);

-- "This logged-in visitor arrived on <code>": the backup when the order itself carries no referral
-- (GoKwik may drop the cart attribute). First claim per customer wins. phone lets an order that
-- GoKwik attached to another customer record with the same phone still find it.
create table if not exists referral_claims (
  referee_customer_id  text primary key,
  code                 text not null,
  phone                text,
  created_at           timestamptz not null default now()
);
create index if not exists referral_claims_phone_idx on referral_claims (phone) where phone is not null;

-- One row per referred friend's order (source_order_id). status:
--   awaiting_payment  the friend's first order exists but is not fully paid yet
--   earned            usable by the referrer until expires_at (12 months after earned_at)
--   used              went on one of the referrer's bills (used_order_*)
--   void              the friend's order was cancelled / fully refunded before the reward was used
--   rejected          did not qualify (reason says why: own code, not a first order, top tier ...)
-- An earned row past expires_at is expired; nothing has to sweep it.
create table if not exists referral_rewards (
  id                    bigserial primary key,
  source_order_id       text not null unique,
  source_order_name     text,
  referrer_customer_id  text,
  referee_customer_id   text,
  code                  text,
  via                   text,
  status                text not null check (status in ('awaiting_payment', 'earned', 'used', 'void', 'rejected')),
  reason                text,
  earned_at             timestamptz,
  expires_at            timestamptz,
  used_order_id         text,
  used_order_name       text,
  used_channel          text,
  used_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists referral_rewards_referrer_idx on referral_rewards (referrer_customer_id, status);

-- The online code / store redemption that used a reward points back at it.
alter table loyalty_redemptions add column if not exists referral_reward_id bigint;

notify pgrst, 'reload schema';
