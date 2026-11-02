# Daily NPC, signups & Brevo Shopify app pipelines — Ecommerce BU

| Table | SQL | Data 2025-01-01 → 2026-11-01 |
|---|---|---|
| `npc_daily_ecommerce` | `01_create_table.sql`, `02_daily_merge.sql` | `npc_daily_ecommerce.csv` |
| `signups_daily_ecommerce` | `03_signups_create_table.sql`, `04_signups_daily_merge.sql` | `signups_daily_ecommerce.csv` |
| `brevo_shopify_app_installs_daily` | `05_brevo_shopify_app_installs.sql` | `brevo_shopify_app_installs.csv` |

NPC and signups share the same segments: Brevo Ecommerce + PushOwl = Ecommerce BU total. `run_pipeline.py` drives the NPC job only; schedule the other SQL files directly as BigQuery scheduled queries.

---

# NPC

Source: NAO's warehouse tables in `root-station-198710`. Definitions follow NAO's finance rules and were checked against NAO on 2026-11-02.

## Output

One table, `npc_daily_ecommerce`, one row per **day × segment**:

| npc_date | segment | npc_count | bu_source | loaded_at |
|---|---|---|---|---|
| 2026-10-30 | Brevo Ecommerce | 84 | monthly | … |
| 2026-10-30 | PushOwl | 10 | monthly | … |

- **Brevo Ecommerce**: Ecommerce BU, PushOwl excluded.
- **PushOwl**: `is_pushowl_client`, or the PushOwl billing subsidiary (`subsidiary LIKE '%pushow%'`) as a backup for the rare corp with no BU row. The backup changes exactly one day (2026-07-28: PushOwl 8 → 11). PushOwl is part of the Ecommerce BU by construction, so **the two segments add up to the Ecommerce BU total**.
- Days with no NPCs are stored as `0`.

`npc_daily_ecommerce.csv` holds the same data for 2025-01-01 → 2026-11-01, pulled from NAO. 2025 is complete: every 2025 NPC has a monthly BU row and a BU-dimension row, and the PushOwl flag matches the PushOwl subsidiary in every month.

## Metric definition

**NPC** (New Paying Customer): a corporate org on the day of its first recurring invoice that was not cancelled.

```sql
COUNT(DISTINCT corporate_organization_id)
FROM dbt_refined_zone_billing_systems.deferred_revenue_kpi
WHERE is_recurring_revenue AND NOT full_invoice_cancelled
  AND is_first_invoice_not_cancelled_recurring
  AND DATE_TRUNC(DATE(recurring_first_invoice_not_cancelled_date), MONTH) = month
```

⚠️ The last line matters. `is_first_invoice_not_cancelled_recurring`, the same thing as Omni's `is_npc`, is a sticky client-level flag. Counted on its own it overstates NPCs about 4×. Omni's "Number of NPCs (Finance Defintion)" tile has this bug; its "Number of New Clients" measure is the correct one.

**BU**: `monthly_business_unit` from `fact_organization_bu_classification_monthly`, for the NPC month. That table lags the calendar and has no rows for the current month. Those days use `last_business_unit` instead and are tagged `bu_source = 'provisional'`. They switch to `monthly` automatically once the month lands.

## Reconciliation (run 2026-11-02)

| Month | All NPC (this logic) | NAO / Omni-exact `new_logo_mom` | Ecommerce incl. PushOwl | Omni-exact Ecommerce |
|---|---|---|---|---|
| Jul 2026 | 14,408 | 14,396 | 2,228 | 2,223 |
| Aug 2026 | 13,714 | 13,704 | 2,104 | 2,093 |
| Sep 2026 | 15,959 | 15,952 | 2,373 | 2,364 |
| Oct 2026 | 17,084 | 17,068 | 2,643 | 2,627 |

That is within 0.1% overall and 0.6% on Ecommerce. The corp-grain measure can't give daily granularity, which is why the pipeline uses the row-level pattern.

## Setup

1. Replace `YOUR_PROJECT.YOUR_DATASET` in both SQL files with the dataset your dashboard reads. NAO itself is read-only; this needs a BigQuery service account with read access to `root-station-198710` and write access to your dataset.
2. Run `01_create_table.sql` once.
3. Backfill: `python run_pipeline.py --start 2024-01-01 --end <yesterday>`. Monthly BU history starts 2024-01.
4. Schedule `02_daily_merge.sql` as a BigQuery scheduled query, daily (e.g. 06:00 Europe/Paris), or run `python run_pipeline.py` from Airflow/cron.

## Things that will look odd on the dashboard

- **The last 1–2 days are low.** Billing data lands with a lag; 2026-11-01 showed 5 NPCs when pulled the next morning. The 45-day recompute fills them in. Consider greying out the last 2 days, or charting up to D-2.
- **Recent numbers can drop slightly.** A first invoice cancelled after the fact removes that NPC.
- **Weekends are about a third of weekdays.** That's the real pattern, not missing data.
- **PushOwl vs company-wide totals.** Company-wide finance totals exclude PushOwl, but the Ecommerce BU includes it. If you show Ecommerce next to a Brevo-wide NPC number, say they're on different perimeters.

---

# Signups

## Output

`signups_daily_ecommerce`, one row per **day × segment**: `signup_date`, `segment`, `signup_count`, `loaded_at`. Same two segments as NPC; their sum is the Ecommerce BU total.

## Definitions

The two halves of the Ecommerce BU acquire accounts in different systems, so "signup" means a different event for each:

- **Brevo Ecommerce:** a new Brevo organization (`orga_creation_date`) whose corporate org is in the Ecommerce BU.
  - Source: `rpt_marketing_organizations_data`, the official first-touch org table, one row per org.
  - Bots and fakes excluded (`is_bot = FALSE`, `updated_is_fake = FALSE`), as in NAO's marketing rules.
  - BU via `dim_corp_org` → `dim_organization_bu_classification.last_business_unit`.
- **PushOwl:** a Shopify shop installing the PushOwl app for the first time.
  - Source: `rpt_pushowl_acquisition_installs` (GA4 `shopify_app_install`), first install per `shop_url`, test shops excluded. Reinstalls don't count again.
  - PushOwl shops aren't Brevo organizations, so they never appear in the Brevo signups table.

Adding the two is a reasonable "new Ecommerce accounts" total, but they're different events: an account creation versus an app install.

## ⚠️ Brevo Ecommerce signups before 2025-11-02 are blank — and can't be rebuilt

The BU table (`dim_organization_bu_classification`) only holds orgs created in the **last 365 days**, plus older orgs that pay or are active. Most older free signups have no BU row at all:

| Signup month | Signups with a BU row |
|---|---|
| Jan–Aug 2025 | 20–27% |
| Sep–Oct 2025 | 31–33% |
| 2025-11-01 | 33% |
| 2025-11-02 onwards | 100% |

The cut-off is exactly today minus 365 days. Counting Ecommerce on those older days would undercount 3–5×, and the drop would look like real growth: daily Brevo Ecommerce signups appear to double overnight on 2025-11-02. Total signups are actually flat at 27–29K/week across that date.

So in `signups_daily_ecommerce.csv`, `brevo_ecommerce_signups` and `ecommerce_bu_total_signups` are **blank from 2025-01-01 to 2025-11-01**; PushOwl is filled for all of 2025.

What this means for the pipeline:
- **The cut-off moves forward one day every day.** Tomorrow, 2025-11-02 loses its BU rows too. A day's Brevo Ecommerce signup count can only be computed while that day is under a year old.
- **The daily job is the only durable history.** It freezes each day 7 days after signup, well inside the window. The CSV is accurate today; load it now, and never re-backfill from scratch for dates more than a year old.
- **To get Jan–Oct 2025 back**, someone needs a historical snapshot of the BU table, or a rebuild of the BU rule for older orgs. Both are for the BU classification owner.

## PushOwl "first installs" in early 2025 include some older shops

The PushOwl install history starts on 2025-01-01. A shop that first installed in 2024, uninstalled, and reinstalled in 2025 counts as new in 2025, because its earlier install is invisible. It can't be identified shop by shop, but it can be sized:

- The share of installs that are visible repeats rises as the history window grows: 1.4% in Jan 2025, 2–4% through 2025, then about 6% by mid-2026, once a year-plus of history is visible.
- Taking 6% as the true repeat rate, early months are short of the repeats they should show. That gap is roughly **800–1,000 shops counted as new in 2025** that are really pre-2025 shops returning. That's about 3% of 2025's ~29,000 PushOwl "first installs".
- It's front-loaded: about 90–100 a month (4%) in Jan–Mar 2025, tapering to a few dozen a month by late 2025, and roughly 170 more in H1 2026.
- It's an estimate, and if the true long-run repeat rate is above 6% it's a lower bound.

## ⚠️ Open issues (found 2026-11-02)

1. **PushOwl install tracking broke on 2026-10-21.** Both PushOwl GA4 tables still refresh daily, but `shopify_app_install` events have been zero since Oct 21; before that they averaged 60–80 a day. This is a tracking problem, not real zero installs. Those days are **blank** in the CSV and **NULL** in the table, so the dashboard shows a gap, not a cliff. The job looks back 45 days for PushOwl, so the gap fills in automatically if the events are backfilled. → Report to whoever owns the PushOwl GA4 export.
2. **Brevo Ecommerce signups jump in the last two weeks.** About 600/weekday in September, 900 mid-October, 1,300 on Oct 29–30. The Ecommerce share of all signups rose from about 8% to 11.5% in the week of Oct 26. Two explanations fit and I can't tell them apart from the data:
   - real growth (a campaign or a new acquisition source), or
   - a BU-classification effect: a new org's BU is set from early signals (declared e-commerce, website scan) and some get reclassified later, which would inflate the most recent days.

   Check with the BU classification owner before reading the late-October spike as growth.

## BU for signups is today's BU

Historical monthly BU only exists for orgs that transacted, so a free signup has no "BU at signup date"; the table uses the current one. The daily job recomputes the last **7 days** and then freezes each day. Going forward, each day keeps the BU it had a week after signup. The CSV backfill uses today's BU for every day, so it isn't strictly comparable with days captured live. The difference should be small, but it's another reason to resolve issue 2.

## Setup

1. Replace `YOUR_PROJECT.YOUR_DATASET` in `03_` and `04_`.
2. Run `03_signups_create_table.sql` once.
3. Backfill **by loading `signups_daily_ecommerce.csv`**, not by re-running the query: its Brevo values for 2025-11-02 onward stop being reproducible as each date passes the 365-day mark. Load blank cells as NULL.
4. Schedule `04_signups_daily_merge.sql` daily, after the NPC job.

---

# Brevo Shopify app installs

Daily installs of the **Brevo** Shopify app, not the PushOwl app. SQL and caveats are in `05_brevo_shopify_app_installs.sql`; data is in `brevo_shopify_app_installs.csv` (`date,brevo_app_installs`).

- **Source:** `dbt_refined_zone_engineer.plugin_dashboard`, Brevo's own plugin-connection registry. One install = one new connection with `plugin_name = 'Pushowl Shopify'`, dated by `created_at`. Internal, bot and fake orgs are excluded.
- **The name is misleading.** `Pushowl Shopify` (type `sib`) is the current Brevo Shopify app, built on PushOwl's tech. It sits on Brevo orgs and has been live since July 2024, with about 39K connections since 2025. The legacy `Shopify` connector has had about 50 new connections since 2025 and is excluded.
- **Reinstalls count again.** About 13–15% of monthly connections since August 2025 come from orgs that had connected before. For first-time installs only, count orgs whose earliest connection is that day; the SQL file explains how.
- **It isn't an App Store event feed.** NAO has no GA4 or App Store data for the Brevo app. Brevo's App Store registry (`pgsql_app_store_as_integrations`) is deliberately excluded from NAO and doesn't tie to this table. If you need true App Store installs, the Shopify Partner Dashboard for the Brevo app is the source; ask the Data team to bring it, or that registry, into NAO.
- **Recent days are low.** The last ~10 days run at 20–60 a day, against 70–90 in September. Some connections may not yet be resolved to an org. The job recomputes 30 days, but check before reading it as a drop.
- **Spikes line up with PushOwl.** 2025-07-25 (257 vs PushOwl's 245) and 2026-10-03 (215 vs 191) spike on the same days in both apps. That's probably a shared Shopify App Store event, such as a feature or promotion, not a data error: the two series come from unrelated systems, and the Brevo series kept flowing after PushOwl's tracking broke.
