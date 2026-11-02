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


def main():
    npc = read("npc_daily_ecommerce.csv", "npc_date", "brevo_ecommerce_npc", "pushowl_npc")
    signups = zero_after_delisting(read("signups_daily_ecommerce.csv", "signup_date", "brevo_ecommerce_signups", "pushowl_new_shops"))
    brevo_app = {d: be for d, be, _ in read("brevo_shopify_app_installs.csv", "date", "brevo_app_installs", None)}
    # Shopify installs: Brevo app connections (Brevo Ecommerce) and PushOwl first installs (PushOwl).
    installs = [[d, brevo_app.get(d), po] for d, _, po in signups]

    out = {
        "meta": {
            "generated_at": date.today().isoformat(),
            "source": "NAO (root-station-198710), Ecommerce BU",
            "through": npc[-1][0],
            "pushowl_delisted": PUSHOWL_DELISTED,
        },
        "columns": ["date", "brevo_ecommerce", "pushowl"],
        "metrics": {
            "npc": {"label": "NPCs", "long": "New paying customers", "rows": npc},
            "signups": {"label": "Signups", "long": "Signups", "rows": signups},
            "installs": {"label": "Shopify installs", "long": "Shopify app installs", "rows": installs},
        },
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    for k, m in out["metrics"].items():
        rows = m["rows"]
        print(f"{k:9s} {rows[0][0]} → {rows[-1][0]}  rows={len(rows)}  "
              f"brevo blanks={sum(r[1] is None for r in rows)}  pushowl blanks={sum(r[2] is None for r in rows)}")


if __name__ == "__main__":
    main()
