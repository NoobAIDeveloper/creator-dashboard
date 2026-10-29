# Daily refresh routine

This is the prompt for the scheduled Claude routine that keeps the Command Center sheet current.
The dashboard reads the sheet live, so whatever this routine writes shows up on the next page load.

Schedule: daily at 06:00 IST (00:30 UTC). Connectors needed: Google Sheets, Google Drive.

---

You maintain the Brevo Creator Command Center sheet
(`1srynUL5IRwlGKVRy7jPp20yO6eOaGKVJiqwSqDNOH6w`). Its source of truth is the Creator
Partnerships Tracker (`17-3Cya-WXsLDY4FwjWO7NI3tzjPz46Sgraz8u9ofB5w`), which the team edits by
hand. Work through the steps below in order.

Rules for every step:
- Never delete rows a person added by hand, except where a step says so.
- Never overwrite a filled number with a blank, and write numbers as plain digits (`216K` → `216000`).
- Batch your writes (one `update_values` per tab, or one `update_spreadsheet` with several
  `pasteData` requests): the Sheets connector allows only a few writes per minute.
- No emails, Gmail ids or contact details in this sheet. It is public. Fees are fine.

## 1. Deals → `Deals`

Read the tracker tabs `Live Links`, `LinkedIn Seeding`, `Finalized Deals`, `Newsletters` and any
campaign tab (`BFCM campaign`, and any new tab whose header has `Live URL`).

One row per creator deal (match on `deal_id`, else creator + campaign). Columns:
`deal_id`, `creator`, `campaign`, `kind` (`creator` or `newsletter`), `platforms`, `fee_usd`
(plain number, the tracker's agreed fee), `status` (`Live`, `Approved`, `In progress`, `Closed`),
`payment_status` (`Paid` / `Not paid`, as the tracker says), `source` (tracker tab), `notes`.
Approved LinkedIn Seeding creators count as `Approved`. Update changed fees and statuses in place.

## 2. Live posts → `Influencer Posts`

For every live post (it has a live URL) not already in `Influencer Posts` (match on `live_url`,
else creator + platform + format + date_live), append a row:

- Skip Stories. Only feed posts, reels, videos and threads count. If a deal included a story, the
  reel's `format` says `Reel + Story`.
- Skip newsletters: they go to step 3.
- `post_id`: `<creator-slug>-<platform>-<format-slug>-<n>`, lowercase, hyphens.
- `campaign`: the `utm_campaign` in the tracked link (`n1-listtax`, `linkedin-seeding`, `bfcm-2026`, …).
  No link: LinkedIn seeding posts → `linkedin-seeding`, BFCM tab → `bfcm-2026`. Add any new
  campaign id to `Campaigns` with a readable name.
- `platform`: Instagram, TikTok, YouTube, LinkedIn or X, from the live URL. One row per post.
- `date_live`: `YYYY-MM-DD`. Fuzzy dates: best guess here, original text in `date_note`.
- `deal_id`: the matching row in `Deals`. The dashboard splits a deal's fee evenly across its posts.
- `source`: the tracker tab.

## 3. Newsletters → `Newsletter Placements`

From the tracker's newsletter rows, one row per send (match on `placement_id`). Set `status` to
`Sent` once the send date has passed and the tracker confirms it ran, `Scheduled` before that.
Copy `total_sends`, `opens`, `clicks`, `unique_clicks` and `report_link` when the tracker or the
publisher report has them. Link each row to its deal via `deal_id`.

## 4. Refresh metrics

For each row in `Influencer Posts`:
- Copy any newer numbers the tracker's `Live Links` tab has for the same post (the team updates
  views, likes, comments, shares, saves, GA4 sessions by hand).
- For posts live in the last 45 days, also try the public page: YouTube and TikTok views, likes,
  comments (plus shares and saves on TikTok). Instagram and LinkedIn usually need a login: if the
  numbers aren't readable, leave the row alone.

Set `stats_as_of` to today on rows you changed. If a new value is lower than the stored one, keep
the old value and add a short note in `notes`.

Then append one row per post to `Metrics History` with today's `date` and the post's current
`views, reach, impressions, likes, comments, shares, saves, ga4_sessions, ga4_engaged_sessions,
stats_as_of`. Skip this if today's date is already in the tab.

## 5. Pipeline → `Upcoming Posts`

Every creator deal that is agreed but not yet live, one row per deliverable (no newsletters, no
closed, passed, withdrawn or dropped deals).
- `stage`: `Awaiting draft`, `In production`, `In review`, `Approved` or `Scheduled`.
- `on_hold`: `TRUE` when the tracker says publishing is paused.
- `planned_live`, `draft_due`: `YYYY-MM-DD`, blank if unknown.
- `notes`: one short line on what is blocking it.
- `updated`: today.

Update rows in place (match on `item_id`). When a post goes live (it now has a row in
`Influencer Posts`), delete its `Upcoming Posts` row.

## 6. Content calendar → `Content Calendar`

For calendar rows whose `date` has passed and whose `status` is `Built` or `Ready`: if a
`post_url` is filled, set `status` to `Published`. Don't change anything else; the team edits
this tab.

## 7. Stamp the run

In `Meta`, set `last_refresh` to the current UTC time (ISO 8601) and `refreshed_by` to
`daily routine`. In `refresh_log`, write one line: deals changed, posts added, metrics refreshed,
newsletter sends updated, pipeline rows changed, and anything you couldn't read.
