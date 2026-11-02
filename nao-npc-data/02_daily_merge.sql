-- ============================================================================
-- Daily NPC — Ecommerce BU, split Brevo Ecommerce / PushOwl
-- Step 2: daily incremental load. Schedule as a BigQuery scheduled query
-- (daily, e.g. 06:00 Europe/Paris) or run via run_pipeline.py.
-- Verified against NAO (2026-11-02): monthly totals land within 0.1% of the
-- Omni-exact NPC measure (SUM(new_logo_mom_excluding_catch_up)), and Ecommerce
-- within 0.6%.
-- ============================================================================
-- NPC definition (NAO finance/mrr.md, "NPC in a month — the intramonth pattern"):
--   COUNT DISTINCT corporate_organization_id on deferred_revenue_kpi WHERE
--   is_recurring_revenue AND NOT full_invoice_cancelled
--   AND is_first_invoice_not_cancelled_recurring
--   AND the first-invoice date falls in the row's month.
--   ⚠ Do NOT count is_npc / is_first_invoice_not_cancelled_recurring alone: it is
--     a sticky client-level flag and overstates NPC ~4×.
--
-- BU: monthly_business_unit (fact_organization_bu_classification_monthly) for the
--   NPC month. That fact lags the calendar and has no rows for the in-progress
--   month, so those days fall back to last_business_unit and are tagged
--   'provisional'. The 45-day recompute swaps them to 'monthly' once it lands.
--
-- PushOwl: is_pushowl_client on dim_organization_bu_classification. PushOwl is part
--   of the Ecommerce BU by construction, so the two segments add up to the BU total.
--
-- Recent days move: cancellations remove NPCs after the fact, and the last
-- 1–2 days are incomplete until billing data lands. Hence the rolling window.
-- ============================================================================

DECLARE start_date DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 45 DAY);
DECLARE end_date   DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 1 DAY);

MERGE `YOUR_PROJECT.YOUR_DATASET.npc_daily_ecommerce` AS t
USING (
  WITH npc AS (
    SELECT
      corporate_organization_id AS corp,
      DATE(recurring_first_invoice_not_cancelled_date) AS npc_date,
      month,
      -- PushOwl billing subsidiary: backs up is_pushowl_client for the rare corp with no BU-dim row
      LOGICAL_OR(LOWER(subsidiary) LIKE '%pushow%') AS is_pushowl_billing
    FROM `root-station-198710.dbt_refined_zone_billing_systems.deferred_revenue_kpi`
    WHERE month BETWEEN DATE_TRUNC(start_date, MONTH) AND end_date
      AND is_recurring_revenue = TRUE
      AND full_invoice_cancelled = FALSE
      AND is_first_invoice_not_cancelled_recurring
      AND DATE_TRUNC(DATE(recurring_first_invoice_not_cancelled_date), MONTH) = month
      AND DATE(recurring_first_invoice_not_cancelled_date) BETWEEN start_date AND end_date
    GROUP BY 1, 2, 3
  ),
  seg AS (
    SELECT
      n.npc_date,
      n.corp,
      CASE
        WHEN COALESCE(d.is_pushowl_client, FALSE) OR n.is_pushowl_billing THEN 'PushOwl'
        WHEN COALESCE(f.monthly_business_unit, d.last_business_unit) = 'Ecommerce' THEN 'Brevo Ecommerce'
      END AS segment,
      IF(f.monthly_business_unit IS NULL, 'provisional', 'monthly') AS bu_source
    FROM npc n
    LEFT JOIN `root-station-198710.dbt_datamarts_zone_facts.fact_organization_bu_classification_monthly` f
      ON f.corporate_organization_id = n.corp AND f.month = n.month
    LEFT JOIN `root-station-198710.dbt_datamarts_zone_dimensions.dim_organization_bu_classification` d
      ON d.corporate_organization_id = n.corp
  ),
  agg AS (
    SELECT npc_date, segment,
      COUNT(DISTINCT corp) AS npc_count,
      IF(LOGICAL_OR(bu_source = 'provisional'), 'provisional', 'monthly') AS bu_source
    FROM seg
    WHERE segment IS NOT NULL
    GROUP BY 1, 2
  ),
  -- date spine × segments: days with no NPC are stored as 0, not missing
  spine AS (
    SELECT d AS npc_date, s AS segment
    FROM UNNEST(GENERATE_DATE_ARRAY(start_date, end_date)) AS d
    CROSS JOIN UNNEST(['Brevo Ecommerce', 'PushOwl']) AS s
  )
  SELECT
    sp.npc_date, sp.segment,
    COALESCE(a.npc_count, 0) AS npc_count,
    COALESCE(a.bu_source,
             IF(DATE_TRUNC(sp.npc_date, MONTH) >= DATE_TRUNC(CURRENT_DATE('Europe/Paris'), MONTH),
                'provisional', 'monthly')) AS bu_source
  FROM spine sp
  LEFT JOIN agg a USING (npc_date, segment)
) AS s
ON t.npc_date = s.npc_date AND t.segment = s.segment
WHEN MATCHED AND (t.npc_count != s.npc_count OR t.bu_source != s.bu_source) THEN
  UPDATE SET npc_count = s.npc_count, bu_source = s.bu_source, loaded_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
  INSERT (npc_date, segment, npc_count, bu_source, loaded_at)
  VALUES (s.npc_date, s.segment, s.npc_count, s.bu_source, CURRENT_TIMESTAMP());
