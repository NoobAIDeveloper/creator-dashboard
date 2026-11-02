-- ============================================================================
-- Daily installs of the Brevo Shopify app (NOT the PushOwl app)
-- Built and checked against NAO on 2026-11-02.
-- ============================================================================
-- What this counts
--   One install = one new plugin connection of the Brevo Shopify app:
--   dbt_refined_zone_engineer.plugin_dashboard, plugin_name = 'Pushowl Shopify'.
--   ⚠ Despite the name, 'Pushowl Shopify' (type 'sib') is the current BREVO Shopify
--     app, which is built on PushOwl's tech: Brevo plugin family, Brevo orgs, live since
--     2024-07. The legacy 'Shopify' connector (type 'common') has had only ~50 new
--     connections since 2025 and is excluded. The PushOwl app's own installs are
--     in rpt_pushowl_acquisition_installs, not here.
--   Date = created_at of the connection (UTC).
--   Reinstalls create a new connection and count again (~13–15% of monthly
--   connections since Aug 2025 come from orgs that had connected before).
--   For first-time installs only, count orgs whose earliest connection is that day.
--   Internal / bot / fake orgs excluded (NAO audience filter via dim_corp_org).
--   Shop URL is not usable here: every row carries the generic admin.shopify.com host.
--
-- Caveats
--   * This is Brevo's own connection registry, not Shopify App Store install events.
--     No GA4 / App Store feed for the Brevo app exists in NAO. The App Store registry
--     (dbt_trusted_zone_postgres.pgsql_app_store_as_integrations) is excluded from NAO
--     and its counts do not tie to this table.
--   * plugin_dashboard is a full-rebuild snapshot with no history; connections whose org
--     no longer resolves in dim_organization drop out. Capturing the count daily
--     (below) protects the history from that.
--   * The last ~10 days run low (Oct 23 – Nov 1 2026: 20–60/day vs 70–90 in September).
--     That may be connections not yet resolved to an org. The job recomputes
--     30 days to absorb it; check before reading it as a real drop.
-- ============================================================================

-- Step 1 (once): destination table
CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.brevo_shopify_app_installs_daily`
(
  install_date        DATE      NOT NULL,
  brevo_app_installs  INT64     NOT NULL OPTIONS(description = "New connections of the Brevo Shopify app (plugin_name 'Pushowl Shopify'), reinstalls included"),
  loaded_at           TIMESTAMP NOT NULL
)
PARTITION BY install_date;

-- Step 2 (daily, scheduled query): recompute the last 30 days.
-- For the one-off backfill, set start_date to '2025-01-01'.
DECLARE start_date DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 30 DAY);
DECLARE end_date   DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 1 DAY);

MERGE `YOUR_PROJECT.YOUR_DATASET.brevo_shopify_app_installs_daily` AS t
USING (
  WITH c AS (
    SELECT DATE(p.created_at) AS install_date, COUNT(DISTINCT p.user_connection_id) AS n
    FROM `root-station-198710.dbt_refined_zone_engineer.plugin_dashboard` p
    LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_corp_org` org
      ON org.organization_id = p.organization_id
    WHERE p.plugin_name = 'Pushowl Shopify'
      AND DATE(p.created_at) BETWEEN start_date AND end_date
      AND NOT COALESCE(org.is_internal, FALSE)
      AND NOT COALESCE(org.is_bot, FALSE)
      AND NOT COALESCE(org.is_fake, FALSE)
    GROUP BY 1
  )
  SELECT d AS install_date, COALESCE(c.n, 0) AS brevo_app_installs
  FROM UNNEST(GENERATE_DATE_ARRAY(start_date, end_date)) AS d
  LEFT JOIN c ON c.install_date = d
) AS s
ON t.install_date = s.install_date
WHEN MATCHED AND t.brevo_app_installs != s.brevo_app_installs THEN
  UPDATE SET brevo_app_installs = s.brevo_app_installs, loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (install_date, brevo_app_installs, loaded_at)
  VALUES (s.install_date, s.brevo_app_installs, CURRENT_TIMESTAMP());
