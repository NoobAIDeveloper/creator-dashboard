-- ============================================================================
-- Daily signups — Ecommerce BU, split Brevo Ecommerce / PushOwl
-- Step 1: destination table (run once)
-- ============================================================================
-- Replace YOUR_PROJECT.YOUR_DATASET with the dataset your dashboard reads from.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.signups_daily_ecommerce`
(
  signup_date   DATE      NOT NULL OPTIONS(description = "Brevo: org creation date. PushOwl: first Shopify app install date of the shop."),
  segment       STRING    NOT NULL OPTIONS(description = "'Brevo Ecommerce' (new orgs, Ecommerce BU) or 'PushOwl' (new shops installing the app). Sum both = Ecommerce BU total."),
  signup_count  INT64              OPTIONS(description = "NULL = source not refreshed for that day (not zero). Brevo: COUNT DISTINCT organization_id. PushOwl: shops whose first-ever install is that day."),
  loaded_at     TIMESTAMP NOT NULL OPTIONS(description = "When this row was last (re)computed")
)
PARTITION BY signup_date
CLUSTER BY segment
OPTIONS (description = "Daily new accounts for the Ecommerce BU. Recomputes the last 7 days each run, then freezes (BU of a new org can still change after that).");
