/**
 * Creator Command Center — data endpoint.
 * Serves the Command Center sheet as JSON (GET) and records calendar comments and
 * post suggestions (POST). Deploy: Extensions → Apps Script in the Command Center sheet,
 * paste this file, Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 */
const SHEET_ID = '1srynUL5IRwlGKVRy7jPp20yO6eOaGKVJiqwSqDNOH6w';
const TZ = 'Etc/UTC';

const TABS = {
  influencerPosts: 'Influencer Posts',
  newsletters: 'Newsletter Placements',
  deals: 'Deals',
  upcoming: 'Upcoming Posts',
  ownedPosts: 'Owned Posts',
  ownedAccounts: 'Owned Accounts',
  calendar: 'Content Calendar',
  comments: 'Comments',
  campaigns: 'Campaigns',
};

function doGet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const out = {};
  Object.keys(TABS).forEach((key) => { out[key] = readTab_(ss, TABS[key]); });
  out.meta = {};
  readTab_(ss, 'Meta').forEach((r) => { out.meta[r.key] = r.value; });
  return json_(out);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Request body is not valid JSON' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    if (body.action === 'comment') return json_(addComment_(ss, body));
    if (body.action === 'calendar_add') return json_(addCalendarItem_(ss, body));
    return json_({ ok: false, error: 'Unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function addComment_(ss, b) {
  const author = clean_(b.author, 60), text = clean_(b.text, 2000), itemId = clean_(b.item_id, 120);
  if (!author || !text || !itemId) return { ok: false, error: 'Name, comment and item are required' };
  const exists = readTab_(ss, TABS.calendar).some((r) => r.item_id === itemId);
  if (!exists) return { ok: false, error: 'That calendar post no longer exists' };
  const comment = {
    comment_id: Utilities.getUuid().slice(0, 8),
    item_id: itemId, author: author, text: text, created_at: new Date().toISOString(),
  };
  appendObject_(ss.getSheetByName(TABS.comments), comment);
  return { ok: true, comment: comment };
}

function addCalendarItem_(ss, b) {
  const title = clean_(b.title, 120), author = clean_(b.author, 60);
  if (!title || !author) return { ok: false, error: 'Title and name are required' };
  const platform = ['X', 'Instagram'].indexOf(b.platform) >= 0 ? b.platform : 'Instagram';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : '';
  const item = {
    item_id: (platform === 'X' ? 'X-' : 'IG-') + 'S' + Utilities.getUuid().slice(0, 6), date: date,
    platform: platform, format: clean_(b.format, 40), title: title, hook: clean_(b.hook, 4000),
    status: 'Needs input', needs_to_build: 'Suggested from the dashboard: needs a lane, time and full brief',
    added_by: author, added_at: new Date().toISOString(),
  };
  appendObject_(ss.getSheetByName(TABS.calendar), item);
  return { ok: true, item: item };
}

/* ---------- helpers ---------- */
function readTab_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  return values
    .filter((r) => r.some((c) => c !== '' && c !== null))
    .map((r) => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = cell_(r[i]); });
      return o;
    });
}

function cell_(v) {
  if (v instanceof Date) {
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, TZ, hasTime ? "yyyy-MM-dd'T'HH:mm:ss'Z'" : 'yyyy-MM-dd');
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

function appendObject_(sh, obj) {
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  // Prefix '=' / '+' / '-' / '@' so text typed into the page is never read as a formula.
  const row = head.map((h) => {
    const v = obj[h] === undefined ? '' : obj[h];
    return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
  });
  sh.appendRow(row);
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
