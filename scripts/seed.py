"""One-time seed: turn the Creator Partnerships Tracker into the Command Center's clean tabs.

Usage: python3 -I scripts/seed.py <live_links.json> <out_dir>
Writes <out_dir>/tabs.json (rows per tab, for the sheet) and <out_dir>/snapshot.json (site fallback).
After this, the daily Claude routine keeps the tabs in sync (see ROUTINE.md).
"""
import json
import re
import sys
from datetime import date, datetime, timezone

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

INFLUENCER_COLS = [
    "post_id", "campaign", "creator", "handle", "platform", "format", "live_url", "date_live",
    "date_note", "views", "reach", "impressions", "likes", "comments", "shares", "saves",
    "link_clicks", "ga4_sessions", "ga4_engaged_sessions", "signups", "creator_followers",
    "stats_as_of", "source", "notes",
]
UPCOMING_COLS = [
    "item_id", "campaign", "creator", "handle", "platform", "deliverable", "owner", "stage",
    "on_hold", "draft_due", "planned_live", "notes", "updated",
]
OWNED_POST_COLS = [
    "post_id", "platform", "account", "date", "url", "type", "text", "impressions", "reach",
    "views", "likes", "comments", "shares", "saves", "link_clicks", "profile_visits",
    "stats_as_of", "source",
]
OWNED_ACCOUNT_COLS = ["date", "platform", "account", "followers", "source"]
CALENDAR_COLS = [
    "item_id", "date", "time", "platform", "format", "title", "copy", "owner", "status",
    "asset_link", "post_url", "campaign", "added_by", "added_at",
]
COMMENT_COLS = ["comment_id", "item_id", "author", "text", "created_at"]
CAMPAIGN_COLS = ["campaign_id", "name", "start", "end", "utm_campaign", "notes"]
META_COLS = ["key", "value"]

CAMPAIGNS = [
    ["n1-listtax", "N1 · The List Tax", "2026-09-11", "2026-10-31", "n1-listtax",
     "September creator campaign, Klaviyo list-tax calculator landing page"],
    ["linkedin-seeding", "LinkedIn seeding", "2026-10-06", "2026-10-31", "linkedin-seeding",
     "B2B creator text posts with first-comment tracked link"],
    ["bfcm-2026", "BFCM 2026", "2026-11-02", "2026-12-01", "bfcm-2026",
     "Black Friday / Cyber Monday creator wave (PushOwl brief v2)"],
    ["unassigned", "Unassigned", "", "", "", "Booked but not yet tied to a campaign"],
]


def num(s):
    """'216K' -> 216000, '1,762' -> 1762, '1.23%' / 'not available' / '' -> ''."""
    s = (s or "").strip().replace(",", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KkMm]?)", s)
    if not m:
        return ""
    v = float(m.group(1)) * {"": 1, "k": 1e3, "m": 1e6}[m.group(2).lower()]
    return int(round(v))


def day(s, year=2026):
    """First 'DD-Mon[-YYYY]' in free text -> 'YYYY-MM-DD', else ''."""
    m = re.search(r"(\d{1,2})[- ]([A-Za-z]{3})[a-z]*(?:[- ](\d{4}))?", s or "")
    if not m or m.group(2).lower() not in MONTHS:
        return ""
    return date(int(m.group(3) or year), MONTHS[m.group(2).lower()], int(m.group(1))).isoformat()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def influencer_rows(values):
    h = values[0]
    col = {name: i for i, name in enumerate(h)}
    rows, seen = [], {}
    for r in values[1:]:
        r = r + [""] * (len(h) - len(r))
        creator, platform = r[0].strip(), r[3].strip()
        if not creator or creator == "TOTAL" or not platform:
            continue
        fmt = r[4].strip()
        url = r[5].strip() if r[5].strip().startswith("http") else ""
        m = re.search(r"utm_campaign=([\w-]+)", r[8])
        campaign = m.group(1) if m else ("linkedin-seeding" if platform == "LinkedIn" else "n1-listtax")
        live = day(r[6])
        base = f"{slug(creator)[:24]}-{slug(platform)}-{slug(fmt)[:12]}"
        seen[base] = seen.get(base, 0) + 1
        out = {
            "post_id": f"{base}-{seen[base]}",
            "campaign": campaign,
            "creator": creator,
            "handle": r[1].strip(),
            "platform": platform,
            "format": fmt,
            "live_url": url,
            "date_live": live,
            "date_note": "" if re.fullmatch(r"\d{1,2}-[A-Za-z]{3}-\d{4}", r[6].strip()) else r[6].strip(),
            "views": num(r[col["Views / plays"]]),
            "reach": num(r[col["Reach (unique)"]]),
            "impressions": num(r[col["Impressions"]]),
            "likes": num(r[col["Likes"]]),
            "comments": num(r[col["Comments"]]),
            "shares": num(r[col["Shares"]]),
            "saves": num(r[col["Saves"]]),
            "link_clicks": num(r[col["Link clicks / sticker taps"]]),
            "ga4_sessions": num(r[col["GA4 sessions"]]),
            "ga4_engaged_sessions": num(r[col["GA4 engaged sessions"]]),
            # "Brevo signups (attributed)" holds the deal fee in this sheet; GA4 signup_free is the real count.
            "signups": num(r[col["GA4 signup_free"]]),
            "creator_followers": num(r[col["Creator followers (22-Oct-2026 live read)"]]),
            "stats_as_of": day(r[col["Stats as of"]]),
            "source": "Tracker · Live Links",
            "notes": "" if url else "No public URL (Story or newsletter placement)",
        }
        rows.append(out)
    return rows


# Live posts confirmed in Finalized Deals after the 21-Oct Live Links reconciliation.
LATE_LIVE = [
    ("Katie Bell", "@katiebellsupport", "Instagram", "Reel", "https://www.instagram.com/reel/Dey8iKYs65Q/", "2026-10-22", "n1-listtax"),
    ("Yuvraj Kewate (The SaaS Hub)", "@thesaashub", "Instagram", "Reel", "https://www.instagram.com/reel/Deyi0YbPhDk/", "2026-10-22", "n1-listtax"),
    ("Irawan / Expatify", "Expatify (company page)", "LinkedIn", "Text post", "https://www.linkedin.com/feed/update/urn:li:activity:7518596798303789056", "2026-10-21", "linkedin-seeding"),
]

# Read from the tracker's BFCM campaign and Finalized Deals tabs on 27-Oct-2026. Closed / passed deals left out.
# (creator, handle, platform, deliverable, owner, stage, on_hold, draft_due, planned_live, campaign, note)
HOLD = "Publishing on hold until go-ahead (22-Oct)"
UPCOMING = [
    ("Daniil Andreev (ECORN)", "", "LinkedIn", "Text post", "Farooq", "Awaiting draft", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD),
    ("Binal Shah", "@bybinalshah", "Instagram", "Reel + Story + 7-day bio link", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Reminder sent 21-Oct"),
    ("Masud Mohamed", "@aipreneurx", "Instagram", "Reel + Story + 7-day bio link", "Farooq", "In production", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Script approved 20-Oct; video due as private link"),
    ("Peter Griffin (eztech.withpeter)", "@eztech.withpeter", "Instagram", "Instagram post", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Reminder sent 21-Oct"),
    ("Peter Griffin (griffins.tech)", "@griffins.tech", "Instagram", "Instagram + Facebook post", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Moved from N1 to BFCM"),
    ("Goodness Odika", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; tracked link pending"),
    ("Aleksandar Hadzhiyski (Titan Media)", "", "LinkedIn", "Text post", "Farooq", "In review", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Revision sent 21-Oct; awaiting updated draft"),
    ("Muhammad Ayaan (Valenti Retention)", "", "LinkedIn", "Text post", "Farooq", "Awaiting draft", False, "2026-11-13", "2026-11-20", "bfcm-2026", "Wave 2"),
    ("Chikezie Chidera (Dera Email marketing)", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; tracked link pending"),
    ("Victor Eshiet", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; tracked link pending"),
    ("Leonel Di Camillo", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", "Creator scheduled 2-Nov 19:55 PT; " + HOLD),
    ("Monirul Islam", "", "LinkedIn", "Text post", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Reminder sent 21-Oct"),
    ("Jerish Jacob (Behaf)", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; tracked link pending BFCM URL"),
    ("Taylor Allen (The TAC Agency)", "", "LinkedIn", "Text post", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", ""),
    ("Michael Keeling (Brand GrowthIQ)", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; destination TBD"),
    ("Debasmita Choudhury (Dibs)", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD + "; destination TBD"),
    ("Mohammad Anas (Hostography)", "", "LinkedIn", "Text post", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Personal vs company page still open"),
    ("Frank (Lion Media)", "@frankkenne_", "Instagram", "Reel", "Farooq", "Awaiting draft", False, "2026-10-26", "2026-11-02", "bfcm-2026", "Commercials still open"),
    ("Branda Villacob (The Relevant Collective)", "@therelevantcollective", "Instagram", "Reel", "Farooq", "In review", True, "2026-10-26", "2026-11-02", "bfcm-2026", "Draft v1 follows the old list-tax brief; brief conflict escalated"),
    ("Mickelle Sleyster (Blip Billboards)", "", "LinkedIn", "Text post", "Farooq", "In review", True, "2026-10-26", "2026-11-02", "bfcm-2026", "2 minor fixes sent; " + HOLD),
    ("Eman Khalid", "", "LinkedIn", "Text post", "Farooq", "Approved", True, "2026-10-26", "2026-11-02", "bfcm-2026", HOLD),
    ("Apoorva Sharma", "@globetrendgirl", "Instagram", "Reel + Story", "Bharat", "In production", True, "", "", "bfcm-2026", "Video ~50% shot; waiting on app details"),
    ("Ecommerce Coffee Break", "ecommerce-coffee-break.beehiiv.com", "Newsletter", "Primary placement (1 of 4)", "Bharat", "Scheduled", False, "", "2026-10-20", "n1-listtax", "Confirm the send ran and log it as live"),
    ("Ecommerce Coffee Break", "ecommerce-coffee-break.beehiiv.com", "Newsletter", "Primary placement (2 of 4)", "Bharat", "Scheduled", False, "", "2026-10-27", "n1-listtax", ""),
    ("Ecommerce Coffee Break", "ecommerce-coffee-break.beehiiv.com", "Newsletter", "Primary placement (3 of 4)", "Bharat", "Scheduled", False, "", "2026-11-03", "n1-listtax", ""),
    ("Ecommerce Coffee Break", "ecommerce-coffee-break.beehiiv.com", "Newsletter", "Primary placement (4 of 4)", "Bharat", "Scheduled", False, "", "2026-11-10", "n1-listtax", ""),
    ("Rishabh Singh", "@rishabhsinghtech", "Instagram", "Reel + Story", "Farooq to Bharat", "Approved", True, "", "2026-10-26", "n1-listtax", "Cut approved 22-Oct; do not publish before 26-Oct"),
    ("topclickmediasa", "@topclickmediasa", "Instagram", "Reel + Story", "Bharat", "In production", False, "", "", "n1-listtax", "In production since 18-Sep; ETA chased 21-Oct"),
    ("Rocky Veen", "@rockyveen", "TikTok", "TikTok + Instagram Reel", "Bharat", "Awaiting draft", False, "", "", "n1-listtax", "Script awaited since 23-Sep brief"),
    ("DTC Newsletter (Temi George)", "directtoconsumer.co", "Newsletter", "Spotlight placement (1 of 2)", "Bharat", "Scheduled", False, "", "2026-12-08", "unassigned", "Date held until invoice is paid (due 31-Oct)"),
    ("DTC Newsletter (Temi George)", "directtoconsumer.co", "Newsletter", "Spotlight placement (2 of 2)", "Bharat", "Scheduled", False, "", "2026-12-09", "unassigned", "Date held until invoice is paid (due 31-Oct)"),
]


def main(src, out_dir):
    values = json.load(open(src))["values"]
    posts = influencer_rows(values)
    for creator, handle, platform, fmt, url, live, campaign in LATE_LIVE:
        posts.append({**{c: "" for c in INFLUENCER_COLS},
                      "post_id": f"{slug(creator)[:24]}-{slug(platform)}-{slug(fmt)[:12]}-1",
                      "campaign": campaign, "creator": creator, "handle": handle, "platform": platform,
                      "format": fmt, "live_url": url, "date_live": live,
                      "source": "Tracker · Finalized Deals", "notes": "Live after 21-Oct reconciliation; metrics not read yet"})
    today = "2026-10-27"
    upcoming, seen = [], {}
    for (creator, handle, platform, deliv, owner, stage, hold, due, live, campaign, note) in UPCOMING:
        base = f"{slug(creator)[:24]}-{slug(platform)}"
        seen[base] = seen.get(base, 0) + 1
        upcoming.append({"item_id": f"{base}-{seen[base]}", "campaign": campaign, "creator": creator,
                         "handle": handle, "platform": platform, "deliverable": deliv, "owner": owner,
                         "stage": stage, "on_hold": "TRUE" if hold else "FALSE", "draft_due": due,
                         "planned_live": live, "notes": note, "updated": today})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tabs = {
        "Influencer Posts": [INFLUENCER_COLS] + [[p[c] for c in INFLUENCER_COLS] for p in posts],
        "Upcoming Posts": [UPCOMING_COLS] + [[u[c] for c in UPCOMING_COLS] for u in upcoming],
        "Owned Posts": [OWNED_POST_COLS],
        "Owned Accounts": [OWNED_ACCOUNT_COLS],
        "Content Calendar": [CALENDAR_COLS],
        "Comments": [COMMENT_COLS],
        "Campaigns": [CAMPAIGN_COLS] + CAMPAIGNS,
        "Meta": [META_COLS, ["last_refresh", now], ["refreshed_by", "seed.py (initial import)"],
                 ["tracker_id", "17-3Cya-WXsLDY4FwjWO7NI3tzjPz46Sgraz8u9ofB5w"]],
    }
    json.dump(tabs, open(f"{out_dir}/tabs.json", "w"), indent=1)

    def objs(rows):
        return [dict(zip(rows[0], r)) for r in rows[1:]]
    snapshot = {
        "meta": dict((k, v) for k, v in tabs["Meta"][1:]),
        "campaigns": objs(tabs["Campaigns"]),
        "influencerPosts": objs(tabs["Influencer Posts"]),
        "upcoming": objs(tabs["Upcoming Posts"]),
        "ownedPosts": [], "ownedAccounts": [], "calendar": [], "comments": [],
    }
    json.dump(snapshot, open(f"{out_dir}/snapshot.json", "w"), indent=1)
    print(len(posts), "posts,", len(upcoming), "upcoming")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
