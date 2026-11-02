"""
Daily NPC — Ecommerce BU, split Brevo Ecommerce / PushOwl (source: NAO tables in root-station-198710).

Runs the MERGE in 02_daily_merge.sql for a date range, then sanity-checks the
result. Use it for the one-off historical backfill, or as the daily job if you
orchestrate with Airflow/cron instead of a BigQuery scheduled query.

Usage
  pip install google-cloud-bigquery
  gcloud auth application-default login

  # one-off backfill (chunked by month to keep scans small)
  python run_pipeline.py --start 2024-01-01 --end 2026-11-01

  # daily run (default: rolling last 45 days, up to yesterday)
  python run_pipeline.py

The service account needs read access to root-station-198710 (the NAO source tables)
and write access to DEST_TABLE. Set DEST_TABLE below or via the NPC_DEST_TABLE env var.
Monthly BU history starts 2024-01, so don't backfill earlier than that.
"""
import argparse
import os
import sys
from datetime import date, timedelta
from pathlib import Path

from google.cloud import bigquery

DEST_TABLE = os.getenv("NPC_DEST_TABLE", "YOUR_PROJECT.YOUR_DATASET.npc_daily_ecommerce")
LOOKBACK_DAYS = 45

HERE = Path(__file__).parent


def load_merge_sql() -> str:
    """Take the MERGE statement from 02_daily_merge.sql and make dates query parameters."""
    sql = (HERE / "02_daily_merge.sql").read_text()
    sql = sql[sql.index("MERGE"):]  # drop the DECLARE block; dates come in as params
    sql = sql.replace("start_date", "@start_date").replace("end_date", "@end_date")
    sql = sql.replace("YOUR_PROJECT.YOUR_DATASET.npc_daily_ecommerce", DEST_TABLE)
    return sql


def month_chunks(start: date, end: date):
    cur = start
    while cur <= end:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        yield cur, min(end, nxt - timedelta(days=1))
        cur = nxt


def run(client: bigquery.Client, start: date, end: date) -> None:
    sql = load_merge_sql()
    for s, e in month_chunks(start, end):
        job = client.query(
            sql,
            job_config=bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("start_date", "DATE", s),
                bigquery.ScalarQueryParameter("end_date", "DATE", e),
            ]),
        )
        job.result()
        print(f"{s} → {e}: {job.num_dml_affected_rows or 0} rows inserted/updated")


def sanity_check(client: bigquery.Client, start: date, end: date) -> bool:
    """Flag empty segments and days far off the trailing average — usually a filter or BU-mapping issue."""
    rows = list(client.query(
        f"""
        SELECT segment,
               SUM(npc_count)                     AS total,
               COUNTIF(npc_count = 0)             AS zero_days,
               COUNT(*)                           AS days,
               MAX(npc_count)                     AS max_day,
               AVG(npc_count)                     AS avg_day
        FROM `{DEST_TABLE}`
        WHERE npc_date BETWEEN @s AND @e
        GROUP BY segment
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("s", "DATE", start),
            bigquery.ScalarQueryParameter("e", "DATE", end),
        ]),
    ).result())

    ok = True
    seen = {r.segment for r in rows}
    for seg in ("Brevo Ecommerce", "PushOwl"):
        if seg not in seen:
            print(f"WARNING: no rows for segment {seg!r}")
            ok = False
    for r in rows:
        print(f"{r.segment:16s} total={r.total:>7} avg/day={r.avg_day:6.1f} "
              f"max/day={r.max_day:>5} zero-days={r.zero_days}/{r.days}")
        if r.total == 0:
            print(f"WARNING: {r.segment} has 0 NPC over the window — check the BU value "
                  "('Ecommerce') and is_pushowl_client on dim_organization_bu_classification.")
            ok = False
    return ok


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=date.fromisoformat)
    p.add_argument("--end", type=date.fromisoformat)
    args = p.parse_args()

    yesterday = date.today() - timedelta(days=1)
    end = args.end or yesterday
    start = args.start or (end - timedelta(days=LOOKBACK_DAYS))

    client = bigquery.Client()
    run(client, start, end)
    return 0 if sanity_check(client, start, end) else 1


if __name__ == "__main__":
    sys.exit(main())
