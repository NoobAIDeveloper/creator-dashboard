-- ============================================================================
-- Daily NPC (New Paying Customers) — Ecommerce BU, split Brevo Ecommerce / PushOwl
-- Step 1: destination table (run once)
-- ============================================================================
-- Replace YOUR_PROJECT.YOUR_DATASET with the dataset your dashboard reads from.
-- (The NAO source tables live in root-station-198710 and are read-only from NAO.)

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.npc_daily_ecommerce`
(
  npc_date    DATE      NOT NULL OPTIONS(description = "Day of the org's first recurring invoice not cancelled"),
  segment     STRING    NOT NULL OPTIONS(description = "'Brevo Ecommerce' (Ecommerce BU excl. PushOwl) or 'PushOwl' (is_pushowl_client). Sum both = Ecommerce BU total."),
  npc_count   INT64     NOT NULL OPTIONS(description = "COUNT DISTINCT corporate_organization_id, intramonth NPC pattern"),
  bu_source   STRING    NOT NULL OPTIONS(description = "'monthly' = monthly_business_unit (final); 'provisional' = last_business_unit, used until the monthly BU fact covers that month"),
  loaded_at   TIMESTAMP NOT NULL OPTIONS(description = "When this row was last (re)computed")
)
PARTITION BY npc_date
CLUSTER BY segment
OPTIONS (description = "Daily NPC for the Ecommerce BU (Brevo Ecommerce + PushOwl). Recomputes the last 45 days each run.");
