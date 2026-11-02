"""
Build docs/data/business.json (the Business impact tab's data) from the NAO exports in nao-npc-data/.

  python3 scripts/build_business.py

Each metric is stored as rows of [date, brevo_ecommerce, pushowl]. A blank cell stays null, which the
dashboard draws as a gap, except where a null is known to mean zero (see PUSHOWL_DELISTED).
"""
import csv
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "nao-npc-data"
OUT = ROOT / "docs" / "data" / "business.json"

# PushOwl was delisted from the Shopify App Store; from this day there are no new PushOwl installs,
# so blank PushOwl signup/install days are real zeros, not missing data.
PUSHOWL_DELISTED = "2026-10-21"


def cell(v):
    return int(v) if str(v).strip() != "" else None


def read(name, date_col, be_col, po_col):
    rows = []
    with open(SRC / name, newline="") as f:
        for r in csv.DictReader(f):
            d = r[date_col]
            be = cell(r[be_col]) if be_col else None
            po = cell(r[po_col]) if po_col else None
            rows.append([d, be, po])
    return rows


def zero_after_delisting(rows):
    for r in rows:
        if r[2] is None and r[0] >= PUSHOWL_DELISTED:
            r[2] = 0
    return rows


def num(v):
    v = str(v).replace(",", "").strip()
    return float(v) if v else None


def table(name):
    with open(SRC / name, newline="") as f:
        return list(csv.DictReader(f))


def conversion():
    """Signup → NPC timing for Brevo Ecommerce, and install → NPC for PushOwl (see 07_signup_to_npc.sql)."""
    pct = ["npc_count", "mean", "p25", "median", "p75", "p90"]
    by_month = [{"month": r["npc_month"].split(" ")[0], **{k: num(r[k]) for k in pct}}
                for r in table("ecommerce_days_to_npc_by_month.csv")]
    return {
        "by_month": by_month,
        "distribution": [{"bucket": r["days_bucket"], "count": num(r["npc_count"]), "share": num(r["share"])}
                         for r in table("ecommerce_days_to_npc_distribution.csv")],
        "cohorts": [{"week": r["signup_week"], "signups": num(r["signups"]),
                     **{f"d{n}": num(r[f"npc_within_{n}d"]) for n in (14, 30, 60, 90)}}
                    for r in table("ecommerce_signup_week_npc_cohorts.csv")],
        "pushowl": [{"cut": r["cut"], **{k: num(r[k]) for k in pct}} for r in table("pushowl_install_to_npc.csv")],
    }


def main():
    npc = read("npc_daily_ecommerce.csv", "npc_date", "brevo_ecommerce_npc", "pushowl_npc")
    signups = zero_after_delisting(read("signups_daily_ecommerce.csv", "signup_date", "brevo_ecommerce_signups", "pushowl_new_shops"))
    brevo_app = {d: be for d, be, _ in read("brevo_shopify_app_installs.csv", "date", "brevo_app_installs", None)}
    # Shopify installs: Brevo app connections (Brevo Ecommerce) and PushOwl first installs (PushOwl).
    installs = [[d, brevo_app.get(d), po] for d, _, po in signups]
    # Branded search: Search Console clicks on brevo.com for "brevo" + shopify/ecommerce/store queries.
    # Clicks, not impressions: since 2026 many impressions come from AI-prompt-style queries that never click.
    # NAO has no pushowl.com Search Console data, so the PushOwl half stays empty.
    branded = read("gsc_branded_ecommerce_daily.csv", "date", "brevo_clicks", "pushowl_clicks")

    out = {
        "meta": {
            "generated_at": date.today().isoformat(),
            "source": "NAO (root-station-198710), Ecommerce BU",
            "through": npc[-1][0],
            "pushowl_delisted": PUSHOWL_DELISTED,
        },
        "columns": ["date", "brevo_ecommerce", "pushowl"],
        "conversion": conversion(),
        "metrics": {
            "npc": {"label": "NPCs", "long": "New paying customers", "rows": npc},
            "signups": {"label": "Signups", "long": "Signups", "rows": signups},
            "installs": {"label": "Shopify installs", "long": "Shopify app installs", "rows": installs},
            "branded": {"label": "Branded search clicks", "long": "Branded search clicks", "rows": branded, "brevo_only": True},
        },
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    for k, m in out["metrics"].items():
        rows = m["rows"]
        print(f"{k:9s} {rows[0][0]} → {rows[-1][0]}  rows={len(rows)}  "
              f"brevo blanks={sum(r[1] is None for r in rows)}  pushowl blanks={sum(r[2] is None for r in rows)}")


if __name__ == "__main__":
    main()
