-- ============================================================================
-- Signup → NPC timing, Ecommerce BU (Brevo Ecommerce; PushOwl excluded)
-- Built in NAO on 2026-11-02. Outputs:
--   ecommerce_days_to_npc_by_month.csv      (query A)
--   ecommerce_days_to_npc_distribution.csv  (query B)
--   ecommerce_signup_week_npc_cohorts.csv   (query C)
--   pushowl_install_to_npc.csv              (fuzzy match, run in NAO's local DB; see README)
--
-- Differences from npc_daily_ecommerce / signups_daily_ecommerce, flagged by NAO:
--   * counted per organization_id, not per corporate_organization_id;
--   * BU = last_business_unit (today's BU), not the BU in the NPC month. Brevo's default for
--     NPC analysis is the BU at conversion (first_business_unit), so counts differ slightly.
-- days_to_npc = first non-cancelled recurring invoice date − orga_creation_date.
-- ============================================================================

-- ---------- A. Percentiles of days to NPC, overall and by NPC month ----------
WITH npc AS (
  SELECT d.organization_id,
         MIN(DATE(d.recurring_first_invoice_not_cancelled_date)) AS npc_date
  FROM `root-station-198710.dbt_refined_zone_billing_systems.deferred_revenue_kpi` d
  WHERE d.month >= DATE '2025-01-01'
    AND d.is_recurring_revenue = TRUE
    AND d.full_invoice_cancelled = FALSE
    AND d.is_first_invoice_not_cancelled_recurring
    AND DATE_TRUNC(DATE(d.recurring_first_invoice_not_cancelled_date), MONTH) = d.month
    AND LOWER(COALESCE(d.subsidiary, '')) NOT IN ('pushowl', 'pushowl stripe')
  GROUP BY d.organization_id
),
base AS (
  SELECT n.npc_date, DATE_DIFF(n.npc_date, m.orga_creation_date, DAY) AS days_to_npc
  FROM npc n
  JOIN `root-station-198710.dbt_refined_zone_marketing.rpt_marketing_organizations_data` m
    ON n.organization_id = CAST(m.organization_id AS STRING)
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_corp_org_enriched` e
    ON m.organization_id = e.organization_id
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_organization_bu_classification` bu
    ON CAST(e.corporate_organization_id AS STRING) = bu.corporate_organization_id
  WHERE NOT COALESCE(m.is_bot, FALSE) AND NOT COALESCE(m.updated_is_fake, FALSE)
    AND NOT COALESCE(e.is_internal, FALSE) AND NOT COALESCE(e.is_bot, FALSE) AND NOT COALESCE(e.is_fake, FALSE)
    AND e.last_business_unit = 'Ecommerce'
    AND NOT COALESCE(bu.is_pushowl_client, FALSE)
    AND n.npc_date BETWEEN DATE '2025-01-01' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
),
g AS (
  SELECT 'Overall' AS npc_month, days_to_npc FROM base
  UNION ALL
  SELECT FORMAT_DATE('%Y-%m', npc_date), days_to_npc FROM base
)
SELECT npc_month,
  COUNT(*) AS npc_count,
  ROUND(AVG(days_to_npc), 1) AS mean_days,
  APPROX_QUANTILES(days_to_npc, 100)[OFFSET(25)] AS p25,
  APPROX_QUANTILES(days_to_npc, 100)[OFFSET(50)] AS median,
  APPROX_QUANTILES(days_to_npc, 100)[OFFSET(75)] AS p75,
  APPROX_QUANTILES(days_to_npc, 100)[OFFSET(90)] AS p90
FROM g
GROUP BY npc_month
ORDER BY npc_month = 'Overall' DESC, npc_month;

-- ---------- B. Distribution of days to NPC ----------
WITH npc AS (
  SELECT d.organization_id,
         MIN(DATE(d.recurring_first_invoice_not_cancelled_date)) AS npc_date
  FROM `root-station-198710.dbt_refined_zone_billing_systems.deferred_revenue_kpi` d
  WHERE d.month >= DATE '2025-01-01'
    AND d.is_recurring_revenue = TRUE
    AND d.full_invoice_cancelled = FALSE
    AND d.is_first_invoice_not_cancelled_recurring
    AND DATE_TRUNC(DATE(d.recurring_first_invoice_not_cancelled_date), MONTH) = d.month
    AND LOWER(COALESCE(d.subsidiary, '')) NOT IN ('pushowl', 'pushowl stripe')
  GROUP BY d.organization_id
),
ecom AS (
  SELECT m.organization_id, m.orga_creation_date
  FROM `root-station-198710.dbt_refined_zone_marketing.rpt_marketing_organizations_data` m
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_corp_org_enriched` e
    ON m.organization_id = e.organization_id
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_organization_bu_classification` bu
    ON CAST(e.corporate_organization_id AS STRING) = bu.corporate_organization_id
  WHERE NOT COALESCE(m.is_bot, FALSE) AND NOT COALESCE(m.updated_is_fake, FALSE)
    AND NOT COALESCE(e.is_internal, FALSE) AND NOT COALESCE(e.is_bot, FALSE) AND NOT COALESCE(e.is_fake, FALSE)
    AND e.last_business_unit = 'Ecommerce'
    AND NOT COALESCE(bu.is_pushowl_client, FALSE)
),
base AS (
  SELECT DATE_DIFF(n.npc_date, c.orga_creation_date, DAY) AS d
  FROM npc n JOIN ecom c ON n.organization_id = CAST(c.organization_id AS STRING)
  WHERE n.npc_date BETWEEN DATE '2025-01-01' AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
),
b AS (
  SELECT CASE WHEN d = 0 THEN '0' WHEN d <= 7 THEN '1-7' WHEN d <= 14 THEN '8-14'
              WHEN d <= 30 THEN '15-30' WHEN d <= 60 THEN '31-60' WHEN d <= 90 THEN '61-90'
              WHEN d <= 180 THEN '91-180' WHEN d <= 365 THEN '181-365' ELSE '365+' END AS days_bucket,
         CASE WHEN d = 0 THEN 1 WHEN d <= 7 THEN 2 WHEN d <= 14 THEN 3 WHEN d <= 30 THEN 4 WHEN d <= 60 THEN 5
              WHEN d <= 90 THEN 6 WHEN d <= 180 THEN 7 WHEN d <= 365 THEN 8 ELSE 9 END AS ord
  FROM base
)
SELECT days_bucket, COUNT(*) AS npc_count,
       ROUND(SAFE_DIVIDE(COUNT(*), SUM(COUNT(*)) OVER ()), 4) AS share
FROM b GROUP BY days_bucket, ord ORDER BY ord;

-- ---------- C. Signup-week cohorts: NPCs within 14 / 30 / 60 / 90 days ----------
-- A cell is NULL until the window has fully passed for every signup in that week.
WITH npc AS (
  SELECT d.organization_id,
         MIN(DATE(d.recurring_first_invoice_not_cancelled_date)) AS npc_date
  FROM `root-station-198710.dbt_refined_zone_billing_systems.deferred_revenue_kpi` d
  WHERE d.month >= DATE '2025-11-01'
    AND d.is_recurring_revenue = TRUE
    AND d.full_invoice_cancelled = FALSE
    AND d.is_first_invoice_not_cancelled_recurring
    AND DATE_TRUNC(DATE(d.recurring_first_invoice_not_cancelled_date), MONTH) = d.month
    AND LOWER(COALESCE(d.subsidiary, '')) NOT IN ('pushowl', 'pushowl stripe')
  GROUP BY d.organization_id
),
ecom AS (
  SELECT m.organization_id, m.orga_creation_date,
         DATE_TRUNC(m.orga_creation_date, ISOWEEK) AS signup_week
  FROM `root-station-198710.dbt_refined_zone_marketing.rpt_marketing_organizations_data` m
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_corp_org_enriched` e
    ON m.organization_id = e.organization_id
  LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_organization_bu_classification` bu
    ON CAST(e.corporate_organization_id AS STRING) = bu.corporate_organization_id
  WHERE NOT COALESCE(m.is_bot, FALSE) AND NOT COALESCE(m.updated_is_fake, FALSE)
    AND NOT COALESCE(e.is_internal, FALSE) AND NOT COALESCE(e.is_bot, FALSE) AND NOT COALESCE(e.is_fake, FALSE)
    AND e.last_business_unit = 'Ecommerce'
    AND NOT COALESCE(bu.is_pushowl_client, FALSE)
    AND m.orga_creation_date >= DATE '2025-11-03'
    AND m.orga_creation_date < DATE_TRUNC(CURRENT_DATE(), ISOWEEK)
),
j AS (
  SELECT c.signup_week, c.organization_id,
         IF(n.npc_date < CURRENT_DATE(), DATE_DIFF(n.npc_date, c.orga_creation_date, DAY), NULL) AS d
  FROM ecom c LEFT JOIN npc n ON n.organization_id = CAST(c.organization_id AS STRING)
)
SELECT signup_week,
  COUNT(DISTINCT organization_id) AS signups,
  IF(DATE_ADD(signup_week, INTERVAL 6 + 14 DAY) < CURRENT_DATE(), COUNTIF(d BETWEEN 0 AND 14), NULL) AS npc_within_14d,
  IF(DATE_ADD(signup_week, INTERVAL 6 + 30 DAY) < CURRENT_DATE(), COUNTIF(d BETWEEN 0 AND 30), NULL) AS npc_within_30d,
  IF(DATE_ADD(signup_week, INTERVAL 6 + 60 DAY) < CURRENT_DATE(), COUNTIF(d BETWEEN 0 AND 60), NULL) AS npc_within_60d,
  IF(DATE_ADD(signup_week, INTERVAL 6 + 90 DAY) < CURRENT_DATE(), COUNTIF(d BETWEEN 0 AND 90), NULL) AS npc_within_90d
FROM j GROUP BY signup_week ORDER BY signup_week;
