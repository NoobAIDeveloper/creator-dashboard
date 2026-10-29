# Creator Command Center

Brevo's dashboard for running the influencer program: owned social, influencer performance,
the upcoming-post pipeline, and the owned content calendar with comments.

```
Creator Partnerships Tracker ──(daily Claude routine)──▶ Command Center sheet ◀──(comments, ideas)
                                                            │
                                         Apps Script web app (JSON)
                                                            │
                                    GitHub Pages site (docs/) ── refetches every 3 h
```

- **Data:** [Brevo Creator Command Center — Data](https://docs.google.com/spreadsheets/d/1srynUL5IRwlGKVRy7jPp20yO6eOaGKVJiqwSqDNOH6w/edit)
  (Google Sheet). One clean tab per section. The team can edit it by hand.
- **API:** `apps-script/Code.gs`, a free Apps Script web app that serves the sheet as JSON and
  records calendar comments and suggestions.
- **Site:** `docs/`, a static page with no build step, hosted on GitHub Pages.
- **Refresh:** a daily Claude routine (`ROUTINE.md`) syncs the tracker into the sheet and refreshes
  public metrics.
- **Fallback:** `docs/data/snapshot.json` is used when `config.js` has no endpoint or the endpoint
  can't be reached.

## Set up (about 15 minutes)

1. **Deploy the data endpoint.** Open the Command Center sheet → Extensions → Apps Script. Replace
   `Code.gs` with `apps-script/Code.gs` and save. Then Deploy → New deployment → type **Web app** →
   Execute as **Me** → Who has access **Anyone** → Deploy. Approve the permissions and copy the
   `/exec` URL.
2. **Point the site at it.** Paste the URL into `docs/config.js` as `endpoint`.
3. **Publish.** Push this folder to a GitHub repo, then Settings → Pages → Deploy from branch →
   `main` / `docs`.
4. **Schedule the refresh.** In Claude Code run `/schedule` and paste the prompt from `ROUTINE.md`
   (daily, 06:00 IST).
5. **Owned social.** Create a Drive folder called **Owned Social Exports**. Drop X and Instagram
   CSV exports in it weekly. In the sheet's `Meta` tab, add a row `owned_accounts` listing Brevo's
   handles (for example `x:@brevo, instagram:@brevo.ecommerce`).

## Access

Anyone with the Apps Script URL can read the data and post comments, and on a public repo the
Pages site is public too. The data holds creator handles, post links and metrics. It has no fees,
emails or payment details: keep it that way. If the site must be internal only, use one of:

- a private repo with GitHub Enterprise Pages access control (Brevo's GitHub plan may include this), or
- Cloudflare Pages + Cloudflare Access (free up to 50 users, restricted to @brevo.com), or
- Vercel with password protection (paid plan).

## Local preview

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000. With no endpoint set, the site runs from the snapshot.

## Regenerating the snapshot

`scripts/seed.py` is the one-time importer that built the first version of the sheet from the
tracker's `Live Links` export. The daily routine has taken over that job. To refresh the fallback
snapshot, export the endpoint's JSON to `docs/data/snapshot.json`:

```
curl -L "<endpoint>?action=data" -o docs/data/snapshot.json
```
