-- ============================================================================
-- Daily signups — Ecommerce BU, split Brevo Ecommerce / PushOwl
-- Step 2: daily incremental load. Schedule as a BigQuery scheduled query
-- (daily, e.g. 06:15 Europe/Paris, after the NPC job).
-- Built and checked against NAO on 2026-11-02.
-- ============================================================================
-- Brevo Ecommerce signups
--   Source: rpt_marketing_organizations_data (official first-touch org table,
--   one row per org). Signup = orga_creation_date.
--   Exclusions: is_bot = FALSE AND updated_is_fake = FALSE (NAO marketing rules).
--   BU: last_business_unit (dim_organization_bu_classification), reached via
--   dim_corp_org (organization_id -> corporate_organization_id, STRING cast).
--   There is no historical BU for non-paying orgs (the monthly BU fact only covers
--   orgs that transacted), so the BU is today's. This job recomputes the last
--   7 days and then freezes each day, so a day keeps the BU it had a week after signup.
--
-- PushOwl signups
--   PushOwl accounts are Shopify shops, not Brevo orgs: they are absent from
--   rpt_marketing_organizations_data. The equivalent of a signup is a shop's FIRST
--   install of the PushOwl Shopify app (GA4 shopify_app_install event):
--   rpt_pushowl_acquisition_installs, first install per shop_url, is_test excluded.
--   Reinstalls are not counted again. History starts 2025-01-01.
--   Days after the source's last install_date are written as NULL, not 0: the
--   install event stopped arriving on 2026-10-21 (GA4 tracking issue), and a 0
--   would read as "no installs".
-- ============================================================================

DECLARE start_date    DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 7 DAY);   -- Brevo: freeze BU after a week
DECLARE po_start_date DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 45 DAY);  -- PushOwl: refills NULL days once tracking is back
DECLARE end_date      DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 1 DAY);

MERGE `YOUR_PROJECT.YOUR_DATASET.signups_daily_ecommerce` AS t
USING (
  WITH brevo AS (
    SELECT s.orga_creation_date AS signup_date, COUNT(DISTINCT s.organization_id) AS n
    FROM `root-station-198710.dbt_refined_zone_marketing.rpt_marketing_organizations_data` s
    JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_corp_org` c
      ON c.organization_id = s.organization_id
    JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_organization_bu_classification` bu
      ON bu.corporate_organization_id = CAST(c.corporate_organization_id AS STRING)
    WHERE s.orga_creation_date BETWEEN start_date AND end_date
      AND s.is_bot = FALSE
      AND s.updated_is_fake = FALSE
      AND bu.last_business_unit = 'Ecommerce'
      AND NOT COALESCE(bu.is_pushowl_client, FALSE)
    GROUP BY 1
  ),
  installs AS (
    SELECT shop_url, install_date
    FROM `root-station-198710.dbt_refined_zone_marketing.rpt_pushowl_acquisition_installs`
    WHERE NOT COALESCE(is_test, FALSE)
  ),
  pushowl AS (
    SELECT first_install AS signup_date, COUNT(*) AS n
    FROM (SELECT shop_url, MIN(install_date) AS first_install FROM installs GROUP BY 1)
    WHERE first_install BETWEEN po_start_date AND end_date
    GROUP BY 1
  ),
  pushowl_fresh AS (SELECT MAX(install_date) AS last_day FROM installs)
  SELECT d AS signup_date, 'Brevo Ecommerce' AS segment, COALESCE(b.n, 0) AS signup_count
  FROM UNNEST(GENERATE_DATE_ARRAY(start_date, end_date)) AS d
  LEFT JOIN brevo b ON b.signup_date = d
  UNION ALL
  SELECT d, 'PushOwl', IF(d > f.last_day, NULL, COALESCE(p.n, 0))
  FROM UNNEST(GENERATE_DATE_ARRAY(po_start_date, end_date)) AS d
  CROSS JOIN pushowl_fresh f
  LEFT JOIN pushowl p ON p.signup_date = d
) AS s
ON t.signup_date = s.signup_date AND t.segment = s.segment
WHEN MATCHED AND t.signup_count IS DISTINCT FROM s.signup_count THEN
  UPDATE SET signup_count = s.signup_count, loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (signup_date, segment, signup_count, loaded_at)
  VALUES (s.signup_date, s.segment, s.signup_count, CURRENT_TIMESTAMP());
