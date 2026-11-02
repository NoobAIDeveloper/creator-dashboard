-- ============================================================================
-- Daily Google Search Console clicks & impressions — branded ecommerce queries
-- Built and checked against NAO on 2026-11-02.
-- ============================================================================
-- Source
--   root-station-198710.dbt_refined_zone_marketing.searchdata_url_impression_brevo_com_view
--   = GSC bulk export for sc-domain:brevo.com (the ONLY Search Console property in NAO).
--   Grain: data_date × url × query × country × device × search_type.
--   GSC lands with a ~2-day lag: yesterday is usually not there yet.
--
-- brevo = query contains "brevo" AND any of shopify / ecommerce / e-commerce /
--         woocommerce / store  (case-insensitive substring match, as specified)
--
-- pushowl: there is NO pushowl.com Search Console data in NAO, so the pushowl
--   columns are NULL. The query below can also count "pushowl"/"push owl" searches
--   that showed brevo.com (about 20–100 impressions and 0–6 clicks a day). That is
--   brevo.com's visibility on PushOwl searches, not pushowl.com's, so it is
--   kept out of the pushowl columns.
--
-- Caveats
--   * Anonymized queries have query = NULL and are invisible to any query filter,
--     so these are lower bounds.
--   * "store" is a substring match: it also catches "brevo app store" (about 1–2% of
--     impressions in Oct 2026), "restore", "storefront", etc. For whole words only, use
--     r'shopify|ecommerce|e-commerce|woocommerce|\bstores?\b'.
--   * "e commerce" (with a space) is NOT matched by the spec as written.
--   * Since 2026 a large share of impressions comes from long, AI-prompt-style queries
--     ("as an e-commerce manager… rank brevo vs klaviyo…"): about 40% of Oct 2026
--     impressions, with 0 clicks, against none in Jul 2025. Impressions trends across
--     that period are not like-for-like; clicks are much less affected.
--     To exclude them, add: AND ARRAY_LENGTH(SPLIT(LOWER(query), ' ')) <= 8
--   * The view is large: keep data_date bounded. A full 22-month run in NAO had to be
--     split into quarters to stay under its 3 GB scan cap; in BigQuery directly
--     (or as a scheduled query) one run is fine.
-- ============================================================================

DECLARE start_date DATE DEFAULT DATE '2025-01-01';
DECLARE end_date   DATE DEFAULT DATE_SUB(CURRENT_DATE('Europe/Paris'), INTERVAL 1 DAY);

WITH agg AS (
  SELECT
    data_date,
    SUM(IF(REGEXP_CONTAINS(LOWER(query), r'brevo')
           AND REGEXP_CONTAINS(LOWER(query), r'shopify|ecommerce|e-commerce|woocommerce|store'),
           clicks, 0))      AS brevo_clicks,
    SUM(IF(REGEXP_CONTAINS(LOWER(query), r'brevo')
           AND REGEXP_CONTAINS(LOWER(query), r'shopify|ecommerce|e-commerce|woocommerce|store'),
           impressions, 0)) AS brevo_impressions,
    -- informational only: PushOwl searches that showed brevo.com (not pushowl.com)
    SUM(IF(REGEXP_CONTAINS(LOWER(query), r'pushowl|push owl'), clicks, 0))      AS pushowl_on_brevo_com_clicks,
    SUM(IF(REGEXP_CONTAINS(LOWER(query), r'pushowl|push owl'), impressions, 0)) AS pushowl_on_brevo_com_impressions
  FROM `root-station-198710.dbt_refined_zone_marketing.searchdata_url_impression_brevo_com_view`
  WHERE data_date BETWEEN start_date AND end_date
    AND REGEXP_CONTAINS(LOWER(query), r'brevo|pushowl|push owl')   -- prunes most rows early
  GROUP BY data_date
),
last_day AS (
  SELECT MAX(data_date) AS d
  FROM `root-station-198710.dbt_refined_zone_marketing.searchdata_url_impression_brevo_com_view`
  WHERE data_date BETWEEN DATE_SUB(end_date, INTERVAL 7 DAY) AND end_date
)
SELECT
  d AS date,
  -- days GSC has not delivered yet stay NULL instead of 0
  IF(d > l.d, NULL, COALESCE(a.brevo_clicks, 0))      AS brevo_clicks,
  IF(d > l.d, NULL, COALESCE(a.brevo_impressions, 0)) AS brevo_impressions,
  CAST(NULL AS INT64) AS pushowl_clicks,        -- no pushowl.com GSC property in NAO
  CAST(NULL AS INT64) AS pushowl_impressions
FROM UNNEST(GENERATE_DATE_ARRAY(start_date, end_date)) AS d
CROSS JOIN last_day l
LEFT JOIN agg a ON a.data_date = d
ORDER BY d;
