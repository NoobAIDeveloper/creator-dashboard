/* Creator Command Center — reads the Command Center sheet (via Apps Script) or the bundled snapshot. */
(() => {
  'use strict';

  const CFG = Object.assign({ endpoint: '', snapshot: 'data/snapshot.json', staleAfterDays: 7 }, window.CC_CONFIG || {});
  const PLATFORM_ORDER = ['Instagram', 'TikTok', 'YouTube', 'LinkedIn', 'X', 'Newsletter'];
  const PLATFORM_COLOR = {
    Instagram: 'var(--pf-instagram)', TikTok: 'var(--pf-tiktok)', YouTube: 'var(--pf-youtube)',
    LinkedIn: 'var(--pf-linkedin)', Newsletter: 'var(--pf-newsletter)', X: 'var(--pf-x)',
  };
  const STAGES = ['Awaiting draft', 'In production', 'In review', 'Approved', 'Scheduled'];
  const STAGE_TONE = { 'Awaiting draft': '', 'In production': 'info', 'In review': 'warn', Approved: 'ok', Scheduled: 'ok' };
  const CAL_STATUS = ['Needs input', 'Ready', 'Built', 'Published'];
  const CAL_TONE = { 'Needs input': 'warn', Ready: 'info', Built: 'ok', Published: 'ok' };
  const CAL_COLOR = { 'Needs input': 'var(--warn)', Ready: 'var(--info)', Built: 'var(--ok)', Published: 'var(--primary)' };
  const VIEWS = {
    owned: 'Owned social', influencers: 'Influencer performance', newsletters: 'Newsletters', upcoming: 'Upcoming posts', calendar: 'Content calendar',
  };

  const state = {
    data: null, live: false, error: '',
    inf: { campaign: 'all', platforms: new Set(), q: '', sort: { key: 'date_live', dir: -1 }, csort: { key: 'spend', dir: -1 } },
    up: { campaign: 'all', platform: 'all', stage: null, holdOnly: false },
    nl: { campaign: 'all', newsletter: 'all' },
    own: { platform: 'all', days: 30 },
    cal: { platform: 'all', statuses: new Set(), lane: 'all', q: '', showPast: false },
  };

  /* ---------- utils ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const sum = (arr) => arr.reduce((a, b) => a + (b ?? 0), 0);
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat('en');
  const fmtN = (n) => (n === null || n === undefined ? '—' : Math.abs(n) >= 10000 ? compact.format(n) : whole.format(Math.round(n)));
  const fmtPct = (r) => (r === null || !Number.isFinite(r) ? '—' : (r * 100).toFixed(1) + '%');
  const fmtUSD = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : '$' + (Math.abs(n) >= 10000 ? compact.format(n) : whole.format(Math.round(n))));
  const fmtCPM = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : '$' + n.toFixed(2));
  const cpmHtml = (s) => (s.cpm === null || s.cpm === undefined ? '<span class="dash">—</span>' : fmtCPM(s.cpm) + (s.cpmPartial ? ` <span class="partial" title="${s.cpmMissing} of ${s.cpmOf} posts have no views or impressions logged yet">partial</span>` : ''));
  const pctCell = (r) => (r === null || !Number.isFinite(r) ? '<span class="dash">—</span>' : fmtPct(r));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parseDay = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  };
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const todayUTC = () => { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); };
  const fmtDay = (s, withYear) => {
    const d = parseDay(s); if (!d) return '';
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? ', ' + d.getUTCFullYear() : ''}`;
  };
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');
  const store = {
    get(k) { try { return localStorage.getItem('cc:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('cc:' + k, v); } catch { /* storage unavailable */ } },
  };
  const pdot = (p) => `<span class="pdot" style="background:${PLATFORM_COLOR[p] || 'var(--fg-3)'}"></span>`;
  const extIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>';
  const byPlatformOrder = (a, b) => {
    const ia = PLATFORM_ORDER.indexOf(a), ib = PLATFORM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  };

  /* ---------- data ---------- */
  async function load() {
    $('#freshness').textContent = 'Loading data…';
    state.error = '';
    let data = null;
    if (CFG.endpoint) {
      try {
        const r = await fetch(CFG.endpoint + (CFG.endpoint.includes('?') ? '&' : '?') + 'action=data&t=' + Date.now());
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json();
        if (data.error) throw new Error(data.error);
        state.live = true;
      } catch (e) {
        state.error = `Couldn't reach the live sheet (${e.message}). Showing the last snapshot instead.`;
      }
    }
    if (!data) {
      try {
        const r = await fetch(CFG.snapshot + '?t=' + Date.now());
        data = await r.json();
        state.live = false;
      } catch (e) {
        state.error = `No data could be loaded (${e.message}). Check config.js.`;
        data = {};
      }
    }
    state.data = prepare(data);
    renderFreshness();
    render();
  }

  function prepare(d) {
    // Newsletter placements have their own tab and metrics; keep them out of creator totals.
    // Stories vanish after 24 hours and report no views, so they're left out too; their deal's fee
    // goes to the reel or video it was sold with.
    const isStory = (p) => /^\s*stor(y|ies)\b/i.test(String(p.format || ''));
    const posts = (d.influencerPosts || []).filter((p) => p.creator && p.platform && p.platform !== 'Newsletter' && !isStory(p)).map((p) => {
      const views = num(p.views), impressions = num(p.impressions), reach = num(p.reach);
      const exposure = views ?? impressions ?? reach;
      const parts = [num(p.likes), num(p.comments), num(p.shares), num(p.saves)];
      const eng = parts.every((x) => x === null) ? null : sum(parts);
      return {
        ...p, views, impressions, reach, exposure, eng,
        exposureKind: views !== null ? 'views' : impressions !== null ? 'impressions' : reach !== null ? 'reach' : '',
        likes: num(p.likes), comments: num(p.comments), shares: num(p.shares), saves: num(p.saves),
        sessions: num(p.ga4_sessions), engaged: num(p.ga4_engaged_sessions), signups: num(p.signups),
        engRate: eng !== null && exposure ? eng / exposure : null,
        live_url: safeUrl(p.live_url),
      };
    });
    const owned = (d.ownedPosts || []).map((p) => {
      const parts = [num(p.likes), num(p.comments), num(p.shares), num(p.saves)];
      const eng = parts.every((x) => x === null) ? null : sum(parts);
      const impressions = num(p.impressions) ?? num(p.views) ?? num(p.reach);
      return { ...p, impressions, eng, link_clicks: num(p.link_clicks), url: safeUrl(p.url), engRate: eng !== null && impressions ? eng / impressions : null };
    });
    const newsletters = (d.newsletters || []).filter((n) => n.newsletter).map((n) => ({
      ...n, total_sends: num(n.total_sends), opens: num(n.opens), clicks: num(n.clicks), unique_clicks: num(n.unique_clicks),
      newsletter_url: safeUrl(n.newsletter_url), report_link: safeUrl(n.report_link),
    }));
    // Spend: each deal's fee is split evenly across the posts (or newsletter placements) it covers.
    const deals = (d.deals || []).filter((x) => x.deal_id).map((x) => ({ ...x, fee: num(x.fee_usd) }));
    const dealById = new Map(deals.map((x) => [x.deal_id, x]));
    const allocate = (rows, exposureKey) => {
      const n = {};
      rows.forEach((r) => { if (r.deal_id) n[r.deal_id] = (n[r.deal_id] || 0) + 1; });
      rows.forEach((r) => {
        const dl = dealById.get(r.deal_id);
        r.cost = dl && dl.fee !== null ? dl.fee / n[r.deal_id] : null;
        r.dealPosts = n[r.deal_id] || 0;
        r.dealFee = dl ? dl.fee : null;
        r.cpm = r.cost !== null && r[exposureKey] ? (r.cost / r[exposureKey]) * 1000 : null;
      });
    };
    allocate(posts, 'exposure');
    return {
      meta: d.meta || {},
      campaigns: d.campaigns || [],
      posts,
      newsletters,
      deals,
      upcoming: (d.upcoming || []).filter((u) => u.creator),
      owned,
      accounts: (d.ownedAccounts || []).map((a) => ({ ...a, followers: num(a.followers) })),
      calendar: (d.calendar || []).filter((c) => c.title || c.date),
      comments: d.comments || [],
    };
  }

  const campaignName = (id) => (state.data.campaigns.find((c) => c.campaign_id === id) || {}).name || id || 'Unassigned';

  function renderFreshness() {
    const m = state.data.meta;
    const t = m.last_refresh ? new Date(m.last_refresh) : null;
    const when = t && !isNaN(t) ? t.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
    $('#freshness').innerHTML = `Data refreshed <b>${esc(when)}</b><br>${state.live ? 'Live from the Command Center sheet' : CFG.endpoint ? 'Live sheet unreachable, showing the bundled copy' : 'Bundled copy. Refresh reads the live sheet once it is connected.'}`;
    $('#nav-upcoming').textContent = state.data.upcoming.length || '';
  }

  /* ---------- router ---------- */
  function currentView() {
    const v = location.hash.replace('#', '').split('?')[0];
    return VIEWS[v] ? v : 'influencers';
  }
  function render() {
    if (!state.data) return;
    const v = currentView();
    $('#view-title').textContent = VIEWS[v];
    document.title = `${VIEWS[v]} · Creator Command Center`;
    document.querySelectorAll('.nav a').forEach((a) => (a.dataset.view === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    const el = $('#view');
    const notice = state.error ? `<div class="notice"><span>${esc(state.error)}</span></div>` : '';
    el.innerHTML = notice + ({ owned: viewOwned, influencers: viewInfluencers, newsletters: viewNewsletters, upcoming: viewUpcoming, calendar: viewCalendar }[v])();
    ({ owned: bindOwned, influencers: bindInfluencers, newsletters: bindNewsletters, upcoming: bindUpcoming, calendar: bindCalendar }[v])(el);
  }

  /* =========================================================
     Influencer performance
     ========================================================= */
  function infFiltered() {
    const f = state.inf;
    return state.data.posts.filter((p) =>
      (f.campaign === 'all' || p.campaign === f.campaign) &&
      (!f.platforms.size || f.platforms.has(p.platform)));
  }
  function aggregate(posts) {
    const both = posts.filter((p) => p.eng !== null && p.exposure);
    return {
      posts: posts.length,
      creators: new Set(posts.map((p) => p.creator.toLowerCase())).size,
      exposure: sum(posts.map((p) => p.exposure)),
      withExposure: posts.filter((p) => p.exposure !== null).length,
      // null (shown as —) when no post reports engagement at all, e.g. newsletters
      eng: posts.some((p) => p.eng !== null) ? sum(posts.map((p) => p.eng)) : null,
      engRate: sum(both.map((p) => p.exposure)) ? sum(both.map((p) => p.eng)) / sum(both.map((p) => p.exposure)) : null,
      sessions: sum(posts.map((p) => p.sessions)),
      engaged: sum(posts.map((p) => p.engaged)),
      withSessions: posts.filter((p) => p.sessions !== null).length,
      ...spendStats(posts),
    };
  }
  // CPM only uses posts that report views or impressions, so missing stats don't count as zero reach.
  function spendStats(posts) {
    const priced = posts.filter((p) => p.cost !== null);
    const ratio = (key, per) => {
      const rows = priced.filter((p) => p[key] !== null);
      const denom = sum(rows.map((p) => p[key]));
      return denom ? (sum(rows.map((p) => p.cost)) / denom) * per : null;
    };
    const missing = priced.filter((p) => p.exposure === null).length;
    return {
      spend: priced.length ? sum(priced.map((p) => p.cost)) : null,
      cpm: ratio('exposure', 1000),
      // CPM is partial when some paid-for posts have no views or impressions logged yet.
      cpmPartial: missing > 0, cpmMissing: missing, cpmOf: priced.length,
    };
  }

  function viewInfluencers() {
    const all = state.data.posts;
    if (!all.length) {
      return `<div class="empty"><h3>No live influencer posts yet</h3><p>Posts appear here once they're added to the <b>Influencer Posts</b> tab of the Command Center sheet.</p></div>`;
    }
    const f = state.inf;
    const usedCampaigns = [...new Set(all.map((p) => p.campaign))];
    const platforms = [...new Set(all.map((p) => p.platform))].sort(byPlatformOrder);
    const posts = infFiltered();
    const a = aggregate(posts);

    const byP = platforms.map((p) => ({ p, rows: posts.filter((x) => x.platform === p) })).filter((g) => g.rows.length);
    const maxCount = Math.max(1, ...byP.map((g) => g.rows.length));
    const spendByP = byP.map((g) => ({ p: g.p, v: aggregate(g.rows).spend || 0 }));
    const maxSpend = Math.max(1, ...spendByP.map((x) => x.v));
    const booked = state.data.deals.filter((x) => x.kind === 'Creator' && x.status === 'Booked' &&
      (f.campaign === 'all' || x.campaign === f.campaign) &&
      (!f.platforms.size || [...f.platforms].some((p) => String(x.platforms).includes(p))));
    const bookedSpend = sum(booked.map((x) => x.fee));
    const cell = (v, fmt = fmtN) => (v === null || v === undefined ? '<span class="dash">—</span>' : fmt(v));
    const lede = posts.length
      ? `<b>${a.posts}</b> live posts from <b>${a.creators}</b> creators${f.campaign !== 'all' ? ` in ${esc(campaignName(f.campaign))}` : ''}, reaching <b>${fmtN(a.exposure)}</b> views and impressions for <b>${fmtUSD(a.spend)}</b> of spend${a.cpm !== null ? `, a <b>${fmtCPM(a.cpm)}</b> CPM` : ''}.`
      : 'No posts match these filters.';

    return `
      <p class="lede">${lede}</p>
      <div class="toolbar">
        <div class="field"><label for="inf-campaign">Campaign</label>
          <select id="inf-campaign">
            <option value="all">All campaigns</option>
            ${usedCampaigns.map((c) => `<option value="${esc(c)}" ${f.campaign === c ? 'selected' : ''}>${esc(campaignName(c))}</option>`).join('')}
          </select></div>
        <div class="field"><span class="label">Platform</span>
          <div class="chips" role="group" aria-label="Platform">
            <button class="chip" data-pf="" aria-pressed="${!f.platforms.size}">All</button>
            ${platforms.map((p) => `<button class="chip" data-pf="${esc(p)}" aria-pressed="${f.platforms.has(p)}">${pdot(p)}${esc(p)}</button>`).join('')}
          </div></div>
      </div>

      <div class="kpis">
        ${kpi('Live posts', fmtN(a.posts), `${a.creators} creators · ${byP.length} platforms`)}
        ${kpi('Spend on live posts', fmtUSD(a.spend), `${fmtUSD(bookedSpend)} more booked with approved creators`)}
        ${kpi('Views & impressions', fmtN(a.exposure), `${a.withExposure} of ${a.posts} posts reporting`)}
        ${kpi('CPM', fmtCPM(a.cpm), a.cpmPartial ? `Partial: ${a.cpmMissing} of ${a.cpmOf} posts have no views logged yet` : 'Spend per 1,000 views & impressions')}
        ${kpi('Engagements', fmtN(a.eng), `${fmtPct(a.engRate)} engagement rate`)}
        ${kpi('Site sessions', fmtN(a.sessions), `${fmtN(a.engaged)} engaged · GA4 · ${a.withSessions} posts tracked`)}
      </div>

      <div class="grid-2">
        <section class="card" id="posts-by-platform">
          <div class="card-head"><h2>Posts by platform</h2><span class="note">Live posts in the current filter</span></div>
          <div class="pbars">
            ${byP.map((g) => `<div class="pbar"><span class="name">${pdot(g.p)}${esc(g.p)}</span>
              <span class="track"><span class="fill" style="width:${(g.rows.length / maxCount) * 100}%;background:${PLATFORM_COLOR[g.p] || 'var(--bar)'}"></span></span>
              <span class="val">${g.rows.length}</span></div>`).join('') || '<p class="muted">No posts.</p>'}
          </div>
        </section>
        <section class="card" id="spend-by-platform">
          <div class="card-head"><h2>Spend by platform</h2><span class="note">Multi-platform deals split evenly across their posts</span></div>
          <div class="pbars wide">
            ${spendByP.map((x) => `<div class="pbar"><span class="name">${pdot(x.p)}${esc(x.p)}</span>
              <span class="track"><span class="fill" style="width:${(x.v / maxSpend) * 100}%;background:${PLATFORM_COLOR[x.p] || 'var(--bar)'}"></span></span>
              <span class="val">${fmtUSD(x.v)}</span></div>`).join('') || '<p class="muted">No spend.</p>'}
          </div>
        </section>
      </div>

      <section class="card" id="platform-summary">
        <div class="card-head"><h2>Platform summary</h2><span class="note">CPM and engagement rate only count posts that report views. “Partial” means some posts are still missing views.</span></div>
        <div class="table-wrap" style="max-height:none">
          <table>
            <thead><tr><th>Platform</th><th class="num">Posts</th><th class="num">Creators</th><th class="num">Spend</th><th class="num">Views / impr.</th><th class="num">CPM</th><th class="num">Engagements</th><th class="num">Eng. rate</th><th class="num">Sessions</th></tr></thead>
            <tbody>${byP.map((g) => {
              const s = aggregate(g.rows);
              return `<tr><td>${pdot(g.p)} ${esc(g.p)}</td><td class="num">${s.posts}</td><td class="num">${s.creators}</td><td class="num">${fmtUSD(s.spend)}</td>
                <td class="num">${s.withExposure ? fmtN(s.exposure) : '<span class="dash">—</span>'}</td><td class="num">${cpmHtml(s)}</td>
                <td class="num">${fmtN(s.eng)}</td><td class="num">${pctCell(s.engRate)}</td>
                <td class="num">${s.withSessions ? fmtN(s.sessions) : '<span class="dash">—</span>'}</td></tr>`;
            }).join('')}
            ${byP.length > 1 ? `<tr class="total"><td>All platforms</td><td class="num">${a.posts}</td><td class="num">${a.creators}</td><td class="num">${fmtUSD(a.spend)}</td><td class="num">${fmtN(a.exposure)}</td><td class="num">${cpmHtml(a)}</td><td class="num">${fmtN(a.eng)}</td><td class="num">${pctCell(a.engRate)}</td><td class="num">${fmtN(a.sessions)}</td></tr>` : ''}</tbody>
          </table>
        </div>
      </section>

      <section class="card" id="by-creator">
        <div class="card-head"><h2>By creator</h2><span class="note">One row per deal. Click a column to sort; lowest CPM is the best value.</span></div>
        <div class="table-wrap" id="creator-table">${creatorTable(posts)}</div>
      </section>

      <section class="card" id="post-table">
        <div class="card-head"><h2>Every live post, by platform</h2><span class="note">One row per post. A creator on two platforms appears under both; their fee is split evenly.</span></div>
        <div class="table-tools"><input type="search" id="inf-q" placeholder="Search creator, handle or format" value="${esc(f.q)}" aria-label="Search posts"></div>
        <div class="table-wrap" id="inf-table">${postTable(posts)}</div>
      </section>`;
  }

  const CREATOR_COLS = [
    { key: 'creator', label: 'Creator' },
    { key: 'posts', label: 'Posts', num: true },
    { key: 'spend', label: 'Spend', num: true },
    { key: 'exposure', label: 'Views / impr.', num: true },
    { key: 'cpm', label: 'CPM', num: true },
    { key: 'engRate', label: 'Eng. rate', num: true },
    { key: 'sessions', label: 'Sessions', num: true },
  ];

  // One link per platform; numbered when a creator has several posts on the same platform.
  function postLinks(list) {
    const byPf = new Map();
    list.filter((p) => p.live_url).forEach((p) => { if (!byPf.has(p.platform)) byPf.set(p.platform, []); byPf.get(p.platform).push(p); });
    const out = [...byPf.keys()].sort(byPlatformOrder).map((pf) => {
      const ps = byPf.get(pf);
      const a = (p, label) => `<a href="${esc(p.live_url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.format)}${p.date_live ? ' · ' + esc(fmtDay(p.date_live)) : ''}">${label}</a>`;
      return ps.length === 1
        ? `<span class="plink">${pdot(pf)}${a(ps[0], `${esc(pf)} ↗`)}</span>`
        : `<span class="plink">${pdot(pf)}${esc(pf)} ${ps.map((p, i) => a(p, `${i + 1}↗`)).join(' ')}</span>`;
    });
    return out.length ? `<div class="plinks">${out.join('')}</div>` : '';
  }

  function creatorTable(posts) {
    const byDeal = new Map();
    posts.forEach((p) => { if (!byDeal.has(p.deal_id)) byDeal.set(p.deal_id, []); byDeal.get(p.deal_id).push(p); });
    const rows = [...byDeal.entries()].map(([id, list]) => {
      const s = aggregate(list);
      return {
        id, creator: list[0].creator, campaign: list[0].campaign,
        links: list,
        posts: list.length, spend: s.spend, exposure: s.withExposure ? s.exposure : null,
        cpm: s.cpm, cpmPartial: s.cpmPartial, cpmMissing: s.cpmMissing, cpmOf: s.cpmOf, engRate: s.engRate, sessions: s.withSessions ? s.sessions : null,
      };
    });
    const { key, dir } = state.inf.csort;
    rows.sort((x, y) => {
      const a = x[key], b = y[key];
      if (a === null || a === '') return 1;
      if (b === null || b === '') return -1;
      return (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))) * dir;
    });
    const c = (v, fmt = fmtN) => (v === null ? '<span class="dash">—</span>' : fmt(v));
    const head = CREATOR_COLS.map((col) => `<th class="${col.num ? 'num' : ''}" aria-sort="${key === col.key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-csort="${col.key}">${esc(col.label)}</button></th>`).join('');
    const body = rows.map((r) => `<tr>
      <td><div class="creator">${esc(r.creator)}</div>${state.inf.campaign === 'all' ? `<div class="handle">${esc(campaignName(r.campaign))}</div>` : ''}${postLinks(r.links)}</td>
      <td class="num">${r.posts}</td><td class="num">${c(r.spend, fmtUSD)}</td>
      <td class="num">${c(r.exposure)}</td><td class="num">${c(r.cpm, fmtCPM)}</td><td class="num">${pctCell(r.engRate)}</td>
      <td class="num">${c(r.sessions)}</td></tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  const kpi = (label, value, sub, cls = '') =>
    `<div class="kpi ${cls}"><span class="k-label">${esc(label)}</span><span class="k-value">${value}</span><span class="k-sub">${sub}</span></div>`;

  const POST_COLS = [
    { key: 'creator', label: 'Creator' },
    { key: 'format', label: 'Format' },
    { key: 'date_live', label: 'Posted' },
    { key: 'live_url', label: 'Post', nosort: true },
    { key: 'cost', label: 'Cost', num: true },
    { key: 'exposure', label: 'Views / impr.', num: true },
    { key: 'cpm', label: 'CPM', num: true },
    { key: 'likes', label: 'Likes', num: true },
    { key: 'comments', label: 'Comments', num: true },
    { key: 'shares', label: 'Shares', num: true },
    { key: 'saves', label: 'Saves', num: true },
    { key: 'engRate', label: 'Eng. rate', num: true },
    { key: 'sessions', label: 'Sessions', num: true },
    { key: 'stats_as_of', label: 'Stats as of' },
  ];

  function postTable(posts) {
    const f = state.inf;
    const q = f.q.trim().toLowerCase();
    const rows = q ? posts.filter((p) => [p.creator, p.handle, p.format, p.platform].join(' ').toLowerCase().includes(q)) : posts;
    if (!rows.length) return '<p class="muted" style="padding:1rem">No posts match.</p>';
    const { key, dir } = f.sort;
    const cmp = (a, b) => {
      const x = a[key], y = b[key];
      if (x === null || x === '' || x === undefined) return 1;
      if (y === null || y === '' || y === undefined) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    };
    const groups = [...new Set(rows.map((p) => p.platform))].sort(byPlatformOrder);
    const today = todayUTC();
    const head = POST_COLS.map((c) => {
      const sort = key === c.key ? (dir > 0 ? 'ascending' : 'descending') : 'none';
      const inner = c.nosort ? esc(c.label) : `<button data-sort="${c.key}">${esc(c.label)}</button>`;
      return `<th class="${c.num ? 'num' : ''}" ${c.nosort ? '' : `aria-sort="${sort}"`}>${inner}</th>`;
    }).join('');
    const body = groups.map((g) => {
      const list = rows.filter((p) => p.platform === g).sort(cmp);
      const s = aggregate(list);
      return `<tr class="group"><td colspan="${POST_COLS.length}">${pdot(g)} ${esc(g)}<span class="gsub">${s.posts} posts · ${fmtUSD(s.spend)} · ${fmtN(s.exposure)} views/impr. · ${fmtCPM(s.cpm)} CPM${s.cpmPartial ? ' (partial)' : ''} · ${fmtPct(s.engRate)} eng.</span></td></tr>` +
        list.map((p) => {
          const asOf = parseDay(p.stats_as_of);
          const age = asOf ? daysBetween(asOf, today) : null;
          const stale = age === null ? '<span class="pill">No stats yet</span>'
            : age > CFG.staleAfterDays ? `<span class="pill warn" title="${esc(fmtDay(p.stats_as_of, true))}">${age}d old</span>`
            : `<span class="muted">${esc(fmtDay(p.stats_as_of))}</span>`;
          const exp = p.exposure === null ? '<span class="dash">—</span>' : `${fmtN(p.exposure)}${p.exposureKind === 'impressions' ? ' <span class="muted">impr.</span>' : ''}`;
          const d = (v) => (v === null ? '<span class="dash">—</span>' : fmtN(v));
          return `<tr>
            <td><div class="creator">${esc(p.creator)}</div><div class="handle">${esc(p.handle)}${p.campaign && state.inf.campaign === 'all' ? ` · ${esc(campaignName(p.campaign))}` : ''}</div></td>
            <td>${esc(p.format)}</td>
            <td title="${esc(p.date_note)}">${esc(fmtDay(p.date_live)) || '<span class="dash">—</span>'}</td>
            <td>${p.live_url ? `<a class="link-out" href="${esc(p.live_url)}" target="_blank" rel="noopener noreferrer">Open ${extIcon}</a>` : `<span class="muted" title="${esc(p.notes)}">No link</span>`}</td>
            <td class="num" title="${p.dealPosts > 1 ? esc(`1/${p.dealPosts} of a ${fmtUSD(p.dealFee)} deal`) : ''}">${p.cost === null ? '<span class="dash">—</span>' : fmtUSD(p.cost)}</td>
            <td class="num">${exp}</td><td class="num">${p.cpm === null ? '<span class="dash">—</span>' : fmtCPM(p.cpm)}</td><td class="num">${d(p.likes)}</td><td class="num">${d(p.comments)}</td><td class="num">${d(p.shares)}</td><td class="num">${d(p.saves)}</td>
            <td class="num">${fmtPct(p.engRate)}</td><td class="num">${d(p.sessions)}</td>
            <td>${stale}</td></tr>`;
        }).join('');
    }).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function bindInfluencers(el) {
    const f = state.inf;
    el.querySelector('#inf-campaign')?.addEventListener('change', (e) => { f.campaign = e.target.value; render(); });
    el.querySelectorAll('[data-pf]').forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.pf;
      if (!p) f.platforms.clear(); else if (f.platforms.has(p)) f.platforms.delete(p); else f.platforms.add(p);
      render();
    }));
    const redrawTable = () => { $('#inf-table').innerHTML = postTable(infFiltered()); bindSort(); };
    const bindSort = () => el.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      f.sort = f.sort.key === k ? { key: k, dir: -f.sort.dir } : { key: k, dir: POST_COLS.find((c) => c.key === k).num ? -1 : 1 };
      redrawTable();
    }));
    el.querySelector('#inf-q')?.addEventListener('input', (e) => { f.q = e.target.value; redrawTable(); });
    bindSort();
    const bindCSort = () => el.querySelectorAll('[data-csort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.csort;
      f.csort = f.csort.key === k ? { key: k, dir: -f.csort.dir } : { key: k, dir: CREATOR_COLS.find((c) => c.key === k).num ? -1 : 1 };
      $('#creator-table').innerHTML = creatorTable(infFiltered());
      bindCSort();
    }));
    bindCSort();
  }

  /* =========================================================
     Newsletters
     ========================================================= */
  const nlSent = (n) => String(n.status).toLowerCase() === 'sent';
  function nlAgg(rows) {
    const total = (k) => (rows.some((r) => r[k] !== null) ? sum(rows.map((r) => r[k])) : null);
    // Rates only over sends that report both numbers, so a missing report doesn't drag a rate down.
    const rate = (k) => {
      const both = rows.filter((r) => r[k] !== null && r.total_sends);
      return both.length ? sum(both.map((r) => r[k])) / sum(both.map((r) => r.total_sends)) : null;
    };
    return {
      sent: rows.filter(nlSent).length,
      reported: rows.filter((r) => nlSent(r) && r.total_sends !== null).length,
      sends: total('total_sends'), opens: total('opens'), clicks: total('clicks'), uclicks: total('unique_clicks'),
      openRate: rate('opens'), ctr: rate('clicks'), uctr: rate('unique_clicks'),
    };
  }
  // Newsletter deals are paid up front: a paid deal's full fee counts as spent, never split by send.
  const nlDeal = (name) => state.data.deals.find((x) => x.kind === 'Newsletter' && x.creator === name);
  const isPaid = (deal) => !!deal && deal.payment_status === 'Paid';

  function viewNewsletters() {
    const all = state.data.newsletters;
    if (!all.length) {
      return `<div class="empty"><h3>No newsletter placements yet</h3><p>Add each booked send to the <b>Newsletter Placements</b> tab of the Command Center sheet, then fill in total sends, opens, clicks and unique clicks from the publisher's report.</p></div>`;
    }
    const f = state.nl;
    const today = todayUTC();
    const campaigns = [...new Set(all.map((n) => n.campaign))];
    const names = [...new Set(all.map((n) => n.newsletter))].sort();
    const rows = all.filter((n) => (f.campaign === 'all' || n.campaign === f.campaign) && (f.newsletter === 'all' || n.newsletter === f.newsletter));
    const sent = rows.filter(nlSent);
    const a = nlAgg(sent);
    const upcoming = rows.filter((n) => !nlSent(n) && parseDay(n.send_date) && parseDay(n.send_date) >= today);
    const unconfirmed = rows.filter((n) => !nlSent(n) && parseDay(n.send_date) && parseDay(n.send_date) < today);
    const d = (v) => (v === null ? '<span class="dash">—</span>' : fmtN(v));
    const money = (v, fmt = fmtUSD) => (v === null ? '<span class="dash">—</span>' : fmt(v));
    const shown = [...new Set(rows.map((n) => n.newsletter))].map(nlDeal).filter(Boolean);
    const spend = sum(shown.filter(isPaid).map((x) => x.fee));
    const unpaid = sum(shown.filter((x) => !isPaid(x)).map((x) => x.fee));
    // Cost per send or click only when every send that ran has a publisher report, so a fee isn't divided by a partial count.
    const perUnit = (deal, s, key, per) => (isPaid(deal) && s.sent && s.reported === s.sent && s[key] ? (deal.fee / s[key]) * per : null);
    const status = (n) => {
      if (nlSent(n)) return '<span class="pill ok">Sent</span>';
      const day = parseDay(n.send_date);
      return day && day < today ? '<span class="pill warn">Confirm sent</span>' : '<span class="pill info">Scheduled</span>';
    };
    const byName = names.filter((nm) => rows.some((n) => n.newsletter === nm)).map((nm) => {
      const list = rows.filter((n) => n.newsletter === nm);
      const next = list.filter((n) => !nlSent(n) && parseDay(n.send_date) >= today).map((n) => n.send_date).sort()[0];
      const deal = nlDeal(nm), s = nlAgg(list.filter(nlSent));
      return { nm, url: list[0].newsletter_url, s, deal, booked: list.length, next,
        spend: isPaid(deal) ? deal.fee : null, cpm: perUnit(deal, s, 'sends', 1000), cpuc: perUnit(deal, s, 'uclicks', 1) };
    });
    const sorted = rows.slice().sort((x, y) => String(y.send_date).localeCompare(String(x.send_date)));

    return `
      <p class="lede"><b>${a.sent}</b> sends have run across <b>${new Set(sent.map((n) => n.newsletter)).size}</b> newsletters, and <b>${upcoming.length}</b> more are booked. ${a.reported ? `Publisher reports are logged for ${a.reported} of ${a.sent} sends.` : 'No publisher reports are logged yet, so the numbers below are blank until they are added to the sheet.'}</p>
      ${unconfirmed.length ? `<div class="notice"><span><b>${unconfirmed.length} booked ${unconfirmed.length === 1 ? 'send is' : 'sends are'} past ${unconfirmed.length === 1 ? 'its' : 'their'} date</b> without being marked as sent. Confirm with the publisher, then set the status to Sent in the sheet.</span></div>` : ''}
      <div class="toolbar">
        <div class="field"><label for="nl-campaign">Campaign</label><select id="nl-campaign">
          <option value="all">All campaigns</option>
          ${campaigns.map((c) => `<option value="${esc(c)}" ${f.campaign === c ? 'selected' : ''}>${esc(campaignName(c))}</option>`).join('')}</select></div>
        <div class="field"><label for="nl-name">Newsletter</label><select id="nl-name">
          <option value="all">All newsletters</option>
          ${names.map((nm) => `<option ${f.newsletter === nm ? 'selected' : ''}>${esc(nm)}</option>`).join('')}</select></div>
      </div>
      <div class="kpis">
        ${kpi('Sends run', fmtN(a.sent), `${upcoming.length} booked ahead`)}
        ${kpi('Spend', fmtUSD(spend), unpaid ? `Paid deals. ${fmtUSD(unpaid)} more booked, not yet paid` : 'Paid deals, counted in full')}
        ${kpi('Total sends', fmtN(a.sends), a.reported ? `Recipients across ${a.reported} reported sends` : 'Awaiting publisher reports')}
        ${kpi('Opens', fmtN(a.opens), `${fmtPct(a.openRate)} open rate`)}
        ${kpi('Clicks', fmtN(a.clicks), `${fmtPct(a.ctr)} click rate`)}
        ${kpi('Unique clicks', fmtN(a.uclicks), `${fmtPct(a.uctr)} unique click rate`)}
      </div>
      <section class="card" id="nl-by-newsletter">
        <div class="card-head"><h2>By newsletter</h2><span class="note">Spend is a paid deal's full fee. CPM and cost per unique click show once every send that ran has a publisher report.</span></div>
        <div class="table-wrap" style="max-height:none">
          <table><thead><tr><th>Newsletter</th><th class="num">Sends run</th><th class="num">Spend</th><th class="num">Total sends</th><th class="num">CPM</th><th class="num">Opens</th><th class="num">Open rate</th><th class="num">Clicks</th><th class="num">Unique clicks</th><th class="num">Unique click rate</th><th class="num">Cost / unique click</th><th>Next send</th></tr></thead>
          <tbody>${byName.map((g) => `<tr>
            <td>${g.url ? `<a class="link-out" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">${esc(g.nm)} ${extIcon}</a>` : esc(g.nm)}</td>
            <td class="num">${g.s.sent} <span class="muted">of ${g.booked}</span></td><td class="num">${g.spend !== null ? fmtUSD(g.spend) : g.deal ? `<span class="muted">${fmtUSD(g.deal.fee)} not paid</span>` : '<span class="dash">—</span>'}</td><td class="num">${d(g.s.sends)}</td><td class="num">${money(g.cpm, fmtCPM)}</td><td class="num">${d(g.s.opens)}</td><td class="num">${pctCell(g.s.openRate)}</td>
            <td class="num">${d(g.s.clicks)}</td><td class="num">${d(g.s.uclicks)}</td><td class="num">${pctCell(g.s.uctr)}</td><td class="num">${money(g.cpuc, fmtCPM)}</td>
            <td>${g.next ? esc(fmtDay(g.next, true)) : '<span class="muted">None booked</span>'}</td></tr>`).join('')}</tbody></table>
        </div>
      </section>
      <section class="card" id="nl-placements">
        <div class="card-head"><h2>Every send</h2><span class="note">Newest first, including booked sends</span></div>
        <div class="table-wrap">
          <table><thead><tr><th>Send date</th><th>Newsletter</th><th>Placement</th><th>Status</th><th class="num">Total sends</th><th class="num">Opens</th><th class="num">Open rate</th><th class="num">Clicks</th><th class="num">Unique clicks</th><th>Report</th><th>Notes</th></tr></thead>
          <tbody>${sorted.map((n) => `<tr>
            <td>${esc(fmtDay(n.send_date, true)) || '<span class="dash">—</span>'}</td>
            <td><div class="creator">${esc(n.newsletter)}</div>${f.campaign === 'all' ? `<div class="handle">${esc(campaignName(n.campaign))}</div>` : ''}</td>
            <td>${esc(n.placement)}</td><td>${status(n)}</td>
            <td class="num">${d(n.total_sends)}</td><td class="num">${d(n.opens)}</td><td class="num">${pctCell(n.opens !== null && n.total_sends ? n.opens / n.total_sends : null)}</td>
            <td class="num">${d(n.clicks)}</td><td class="num">${d(n.unique_clicks)}</td>
            <td>${n.report_link ? `<a class="link-out" href="${esc(n.report_link)}" target="_blank" rel="noopener noreferrer">Open ${extIcon}</a>` : '<span class="muted">Not logged</span>'}</td>
            <td class="wrap">${esc(n.notes)}</td></tr>`).join('')}</tbody></table>
        </div>
      </section>`;
  }

  function bindNewsletters(el) {
    el.querySelector('#nl-campaign')?.addEventListener('change', (e) => { state.nl.campaign = e.target.value; render(); });
    el.querySelector('#nl-name')?.addEventListener('change', (e) => { state.nl.newsletter = e.target.value; render(); });
  }

  /* =========================================================
     Upcoming posts
     ========================================================= */
  function viewUpcoming() {
    const all = state.data.upcoming;
    if (!all.length) {
      return `<div class="empty"><h3>Nothing in the pipeline</h3><p>Add a row to the <b>Upcoming Posts</b> tab once a creator post has a brief, a draft or a posting date. It moves to Influencer performance once it's live.</p></div>`;
    }
    const f = state.up;
    const today = todayUTC();
    const isHold = (u) => String(u.on_hold).toUpperCase() === 'TRUE';
    const base = all.filter((u) => (f.campaign === 'all' || u.campaign === f.campaign) && (f.platform === 'all' || u.platform === f.platform));
    const rows = base.filter((u) => (!f.stage || u.stage === f.stage) && (!f.holdOnly || isHold(u)));
    const in7 = base.filter((u) => { const d = parseDay(u.planned_live); return d && d >= today && daysBetween(today, d) <= 7; });
    const overdue = base.filter((u) => { const d = parseDay(u.planned_live); return d && d < today; });
    const ready = base.filter((u) => u.stage === 'Approved' || u.stage === 'Scheduled');
    const held = base.filter(isHold);
    const campaigns = [...new Set(all.map((u) => u.campaign))];
    const platforms = [...new Set(all.map((u) => u.platform))].sort(byPlatformOrder);

    const dated = new Map();
    rows.forEach((u) => { const k = parseDay(u.planned_live) ? u.planned_live.slice(0, 10) : ''; if (!dated.has(k)) dated.set(k, []); dated.get(k).push(u); });
    const keys = [...dated.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    const nextDate = [...dated.keys()].filter((k) => k && parseDay(k) >= today).sort()[0];

    const lede = `<b>${base.length}</b> posts in the pipeline. <b>${held.length}</b> are on hold${held.length ? ' waiting for a go-ahead' : ''}${nextDate ? `, and the next planned go-live is <b>${esc(fmtDay(nextDate, true))}</b> with ${dated.get(nextDate).length} posts` : ''}.`;

    return `
      <p class="lede">${lede}</p>
      <div class="toolbar">
        <div class="field"><label for="up-campaign">Campaign</label><select id="up-campaign">
          <option value="all">All campaigns</option>
          ${campaigns.map((c) => `<option value="${esc(c)}" ${f.campaign === c ? 'selected' : ''}>${esc(campaignName(c))}</option>`).join('')}</select></div>
        <div class="field"><label for="up-platform">Platform</label><select id="up-platform">
          <option value="all">All platforms</option>
          ${platforms.map((p) => `<option ${f.platform === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      </div>
      <div class="kpis">
        ${kpi('Upcoming posts', fmtN(base.length), `${new Set(base.map((u) => u.creator)).size} creators`)}
        ${kpi('Going live in 7 days', fmtN(in7.length), nextDate ? `Next: ${esc(fmtDay(nextDate))}` : 'No dates set')}
        ${kpi('Approved or scheduled', fmtN(ready.length), 'Content signed off')}
        ${kpi('On hold', fmtN(held.length), 'Waiting for a go-ahead', held.length ? '' : '')}
        ${kpi('Past planned date', fmtN(overdue.length), 'Confirm live or reschedule', overdue.length ? 'alert' : '')}
      </div>
      <section class="card" id="pipeline">
        <div class="card-head"><h2>Pipeline by stage</h2><span class="note">Click a stage to filter the list</span>
          <label class="right" style="display:flex;gap:.4rem;align-items:center;font-size:.85rem"><input type="checkbox" id="up-hold" ${f.holdOnly ? 'checked' : ''}> On hold only</label></div>
        <div class="pipeline">
          ${STAGES.map((s) => {
            const n = base.filter((u) => u.stage === s);
            const h = n.filter(isHold).length;
            return `<button class="stage" data-stage="${esc(s)}" aria-pressed="${f.stage === s}"><span class="s-n">${n.length}</span><span class="s-l">${esc(s)}</span><span class="s-h">${h ? `${h} on hold` : '&nbsp;'}</span></button>`;
          }).join('')}
        </div>
      </section>
      <section class="card" id="schedule">
        <div class="card-head"><h2>By planned go-live date</h2><span class="note">${rows.length} posts${f.stage ? ` · ${esc(f.stage)}` : ''}${f.holdOnly ? ' · on hold' : ''}</span></div>
        <div class="timeline">
          ${keys.map((k) => {
            const d = parseDay(k);
            const rel = !d ? '' : daysBetween(today, d);
            const relTxt = !d ? 'Date to be set' : rel === 0 ? 'Today' : rel === 1 ? 'Tomorrow' : rel > 0 ? `In ${rel} days` : `${-rel} days ago`;
            return `<div class="tl-day"><div class="tl-date"><div class="d">${d ? esc(fmtDay(k)) : 'No date'}</div><div class="rel ${d && rel < 0 ? 'over' : ''}">${relTxt}</div></div>
              <div class="tl-items">${dated.get(k).map((u) => `
                <div class="tl-item">
                  <div class="who">
                    <div class="name"><span class="creator">${esc(u.creator)}</span>${u.handle ? `<span class="handle">${esc(u.handle)}</span>` : ''}</div>
                    <div class="what">${pdot(u.platform)} ${esc(u.platform)} · ${esc(u.deliverable)}</div>
                  </div>
                  <div class="tags">${f.campaign === 'all' ? `<span class="pill platform">${esc(campaignName(u.campaign))}</span>` : ''}<span class="pill ${STAGE_TONE[u.stage] || ''}">${esc(u.stage)}</span>${isHold(u) ? '<span class="pill bad">On hold</span>' : ''}${d && rel < 0 ? '<span class="pill warn">Past date</span>' : ''}</div>
                  ${u.notes ? `<div class="note">${esc(u.notes)}${u.draft_due ? ` · Draft due ${esc(fmtDay(u.draft_due))}` : ''}</div>` : u.draft_due ? `<div class="note">Draft due ${esc(fmtDay(u.draft_due))}</div>` : ''}
                </div>`).join('')}</div></div>`;
          }).join('') || '<p class="muted">No posts match these filters.</p>'}
        </div>
      </section>`;
  }

  function bindUpcoming(el) {
    const f = state.up;
    el.querySelector('#up-campaign')?.addEventListener('change', (e) => { f.campaign = e.target.value; render(); });
    el.querySelector('#up-platform')?.addEventListener('change', (e) => { f.platform = e.target.value; render(); });
    el.querySelector('#up-hold')?.addEventListener('change', (e) => { f.holdOnly = e.target.checked; render(); });
    el.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => { f.stage = f.stage === b.dataset.stage ? null : b.dataset.stage; render(); }));
  }

  /* =========================================================
     Owned social
     ========================================================= */
  function viewOwned() {
    const f = state.own;
    const { owned, accounts } = state.data;
    if (!owned.length && !accounts.length) {
      return `
        <p class="lede">Performance of Brevo's own posts on <b>X</b> and <b>Instagram</b>: impressions, engagement and link clicks for everything published from the <a href="#calendar">content calendar</a>.</p>
        <div class="empty">
          <h3>No published posts with stats yet</h3>
          <p>${state.data.calendar.filter(isPublished).length} calendar posts are marked Published. Stats appear here once a row is added to the <b>Owned Posts</b> tab of the Command Center sheet, with <b>calendar_id</b> set to the calendar post's ID (for example <code>IG-1028</code>) so the two stay linked.</p>
        </div>`;
    }
    const today = todayUTC();
    const from = new Date(today - f.days * 86400000);
    const inPlat = (p) => f.platform === 'all' || p.platform === f.platform;
    const rows = owned.filter((p) => inPlat(p) && parseDay(p.date) && parseDay(p.date) >= from);
    const both = rows.filter((p) => p.eng !== null && p.impressions);
    const imp = sum(rows.map((p) => p.impressions));
    const eng = sum(rows.map((p) => p.eng));
    const rate = sum(both.map((p) => p.impressions)) ? sum(both.map((p) => p.eng)) / sum(both.map((p) => p.impressions)) : null;
    const clicks = sum(rows.map((p) => p.link_clicks));
    const plats = ['X', 'Instagram'];
    const followerLine = plats.filter((p) => f.platform === 'all' || p === f.platform).map((p) => {
      const series = accounts.filter((a) => a.platform === p && a.followers !== null).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (!series.length) return null;
      const last = series[series.length - 1];
      const prior = series.filter((a) => parseDay(a.date) <= new Date(parseDay(last.date) - f.days * 86400000)).pop() || series[0];
      const delta = last.followers - prior.followers;
      return { p, last: last.followers, delta };
    }).filter(Boolean);
    const followers = sum(followerLine.map((x) => x.last));
    const fDelta = sum(followerLine.map((x) => x.delta));

    return `
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Platform">
          ${['all', ...plats].map((p) => `<button data-own-pf="${p}" aria-pressed="${f.platform === p}">${p === 'all' ? 'All' : p}</button>`).join('')}
        </div>
        <div class="seg" role="group" aria-label="Period">
          ${[7, 30, 90].map((d) => `<button data-own-days="${d}" aria-pressed="${f.days === d}">${d} days</button>`).join('')}
        </div>
      </div>
      <div class="kpis">
        ${kpi('Posts', fmtN(rows.length), `Last ${f.days} days`)}
        ${kpi('Impressions', fmtN(imp), `${fmtN(rows.length ? imp / rows.length : null)} per post`)}
        ${kpi('Engagements', fmtN(eng), `${fmtPct(rate)} engagement rate`)}
        ${kpi('Link clicks', fmtN(clicks), imp ? `${fmtPct(clicks / imp)} click-through` : '')}
        ${kpi('Followers', followerLine.length ? fmtN(followers) : '—', followerLine.length ? `${fDelta >= 0 ? '+' : ''}${fmtN(fDelta)} in ${f.days} days` : 'No follower log yet')}
      </div>
      <section class="card" id="owned-trend">
        <div class="card-head"><h2>Impressions by day</h2><span class="note">Sum of impressions for posts published that day</span></div>
        <div class="chart" id="own-chart"></div>
      </section>
      <section class="card" id="owned-posts">
        <div class="card-head"><h2>Posts</h2><span class="note">Sorted by impressions</span></div>
        <div class="table-wrap">
          <table><thead><tr><th>Date</th><th>Platform</th><th>Post</th><th class="num">Impressions</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th class="num">Link clicks</th><th class="num">Eng. rate</th></tr></thead>
          <tbody>${rows.slice().sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1)).map((p) => `<tr>
            <td>${esc(fmtDay(p.date))}</td><td>${pdot(p.platform)} ${esc(p.platform)}</td>
            <td class="wrap">${(() => {
              const cal = state.data.calendar.find((c) => c.item_id === p.calendar_id);
              const label = (cal ? cal.title : p.text || p.type || 'Open post').slice(0, 90);
              return p.url ? `<a class="link-out" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${extIcon}</a>` : esc(label);
            })()}</td>
            <td class="num">${fmtN(p.impressions)}</td><td class="num">${fmtN(num(p.likes))}</td><td class="num">${fmtN(num(p.comments))}</td><td class="num">${fmtN(num(p.shares))}</td><td class="num">${fmtN(p.link_clicks)}</td><td class="num">${fmtPct(p.engRate)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No posts in this period.</td></tr>'}</tbody></table>
        </div>
      </section>`;
  }

  function bindOwned(el) {
    el.querySelectorAll('[data-own-pf]').forEach((b) => b.addEventListener('click', () => { state.own.platform = b.dataset.ownPf; render(); }));
    el.querySelectorAll('[data-own-days]').forEach((b) => b.addEventListener('click', () => { state.own.days = +b.dataset.ownDays; render(); }));
    const box = el.querySelector('#own-chart');
    if (box) drawDailyBars(box);
  }

  function drawDailyBars(box) {
    const f = state.own;
    const today = todayUTC();
    const days = [];
    for (let i = f.days - 1; i >= 0; i--) days.push(isoDay(new Date(today - i * 86400000)));
    const totals = days.map((d) => ({ d, v: sum(state.data.owned.filter((p) => (f.platform === 'all' || p.platform === f.platform) && String(p.date).slice(0, 10) === d).map((p) => p.impressions)) }));
    const W = Math.max(300, box.clientWidth), H = 220, m = { t: 10, r: 8, b: 24, l: 44 };
    const max = Math.max(1, ...totals.map((t) => t.v));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const bw = iw / days.length;
    const y = (v) => m.t + ih - (v / top) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Impressions per day">`;
    for (let v = 0; v <= top; v += step) {
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" />`;
      svg += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    }
    const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(iw / 56)));
    totals.forEach((t, i) => {
      const x = m.l + i * bw;
      const h = Math.max(t.v ? 2 : 0, (t.v / top) * ih);
      svg += `<rect data-i="${i}" x="${x + bw * 0.15}" y="${m.t + ih - h}" width="${Math.max(1, bw * 0.7)}" height="${h}" rx="${Math.min(4, bw * 0.35)}" fill="var(--bar)" />`;
      svg += `<rect data-i="${i}" x="${x}" y="${m.t}" width="${bw}" height="${ih}" fill="transparent" />`;
      if (i % labelEvery === 0) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(fmtDay(t.d))}</text>`;
    });
    svg += '</svg>';
    box.innerHTML = svg;
    const tip = $('#tooltip');
    box.querySelectorAll('rect[data-i]').forEach((r) => {
      r.addEventListener('mousemove', (e) => {
        const t = totals[+r.dataset.i];
        tip.innerHTML = `<div class="t-h">${esc(fmtDay(t.d, true))}</div><div class="t-v">${fmtN(t.v)} impressions</div>`;
        tip.hidden = false;
        const tw = tip.offsetWidth;
        tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 12) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
      });
      r.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  /* =========================================================
     Content calendar — production layout: week blocks, one row per day, Instagram and X side by side
     ========================================================= */
  const isPublished = (c) => c.status === 'Published';
  const ownedFor = (id) => state.data.owned.find((o) => o.calendar_id === id);
  const commentCount = (id) => state.data.comments.filter((c) => c.item_id === id).length;
  const weekStart = (d) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function calFiltered() {
    const f = state.cal;
    const q = f.q.trim().toLowerCase();
    return state.data.calendar.filter((c) =>
      (f.platform === 'all' || c.platform === f.platform) &&
      (!f.statuses.size || f.statuses.has(c.status || 'Ready')) &&
      (f.lane === 'all' || c.lane === f.lane) &&
      (!q || [c.item_id, c.title, c.hook, c.caption, c.format, c.lane, c.tool].join(' ').toLowerCase().includes(q)));
  }

  function viewCalendar() {
    const f = state.cal;
    const all = state.data.calendar;
    const today = todayUTC();
    const canWrite = !!(CFG.endpoint && state.live);
    if (!all.length) {
      return `<div class="empty"><h3>The calendar is empty</h3><p>Add posts to the <b>Content Calendar</b> tab of the Command Center sheet: date, time, platform, format, lane, title, hook and status.</p></div>`;
    }
    const upcomingAll = all.filter((c) => parseDay(c.date) && parseDay(c.date) >= today && !isPublished(c));
    const next7 = upcomingAll.filter((c) => daysBetween(today, parseDay(c.date)) < 7);
    const needs = upcomingAll.filter((c) => c.status === 'Needs input');
    const last = all.map((c) => c.date).filter(Boolean).sort().pop();
    const lanes = [...new Set(all.map((c) => c.lane).filter(Boolean))];
    const items = calFiltered().filter((c) => f.showPast || (parseDay(c.date) && parseDay(c.date) >= today));
    const cols = f.platform === 'all' ? ['Instagram', 'X'] : [f.platform];

    // Group by week, then by day.
    const days = [...new Set(items.map((c) => String(c.date).slice(0, 10)).filter((d) => parseDay(d)))].sort();
    const weeks = new Map();
    days.forEach((d) => {
      const k = isoDay(weekStart(parseDay(d)));
      if (!weeks.has(k)) weeks.set(k, []);
      weeks.get(k).push(d);
    });

    const card = (c) => {
      const o = isPublished(c) ? ownedFor(c.item_id) : null;
      const n = commentCount(c.item_id);
      const needsN = String(c.needs_to_build || '').split(';').filter((s) => s.trim()).length;
      return `<button class="post" data-item="${esc(c.item_id)}">
        <span class="p-meta"><b>${esc(c.format)}</b><span class="lane">${esc(c.lane)}</span><span class="p-time" title="${esc(c.time_ist)}">${esc(c.time_et)}</span></span>
        <span class="p-title">${esc(c.title || '(untitled)')}</span>
        ${c.hook && c.hook.trim() !== String(c.title).trim() ? `<span class="p-hook">${esc(c.hook)}</span>` : ''}
        ${o ? `<span class="p-stats">${fmtN(o.impressions)} impr. · ${fmtPct(o.engRate)} eng. · ${fmtN(o.link_clicks)} clicks</span>` : ''}
        <span class="p-foot"><span class="pill ${CAL_TONE[c.status] || ''}">${esc(c.status || 'Ready')}</span>${c.status === 'Needs input' && needsN ? `<span class="muted">${needsN} input${needsN > 1 ? 's' : ''} missing</span>` : ''}<span class="spacer"></span>${n ? `<span class="muted">${n} comment${n > 1 ? 's' : ''}</span>` : ''}<span class="p-id">${esc(c.item_id)}</span></span>
      </button>`;
    };

    const body = [...weeks.entries()].map(([wk, wdays]) => {
      const count = items.filter((c) => wdays.includes(String(c.date).slice(0, 10))).length;
      return `<section class="week" aria-label="Week of ${esc(fmtDay(wk))}">
        <div class="weekhead"><h2>Week of ${esc(fmtDay(wk))}</h2><span class="muted">${count} post${count === 1 ? '' : 's'}</span></div>
        <div class="dayrow colheads" style="--cols:${cols.length}"><span>Date</span>${cols.map((p) => `<span>${pdot(p)} ${esc(p)}</span>`).join('')}</div>
        ${wdays.map((d) => {
          const dt = parseDay(d);
          const rel = daysBetween(today, dt);
          return `<div class="dayrow" style="--cols:${cols.length}">
            <div class="dcell"><span class="dnum">${dt.getUTCDate()}</span><span class="dname">${DOW[dt.getUTCDay()]} · ${MON[dt.getUTCMonth()]}</span>${rel === 0 ? '<span class="dflag">Today</span>' : rel === 1 ? '<span class="dflag">Tomorrow</span>' : ''}</div>
            ${cols.map((p) => {
              const list = items.filter((c) => String(c.date).slice(0, 10) === d && c.platform === p).sort((a, b) => String(a.time_et).localeCompare(String(b.time_et)));
              return `<div class="pcell"><span class="plabel">${esc(p)}</span>${list.map(card).join('') || '<span class="none">Nothing planned</span>'}</div>`;
            }).join('')}
          </div>`;
        }).join('')}
      </section>`;
    }).join('');

    return `
      <p class="lede"><b>${upcomingAll.length}</b> posts planned for Brevo Ecom on Instagram and X through <b>${esc(fmtDay(last, true))}</b>. <b>${next7.length}</b> go out in the next 7 days${needs.length ? `, and <b>${needs.length}</b> still need an input before they can be built` : ''}. Times are US Eastern; hover a time for IST.</p>
      <div class="kpis">
        ${kpi('Upcoming posts', fmtN(upcomingAll.length), `${upcomingAll.filter((c) => c.platform === 'Instagram').length} Instagram · ${upcomingAll.filter((c) => c.platform === 'X').length} X`)}
        ${kpi('Next 7 days', fmtN(next7.length), next7.length ? `${next7.filter((c) => c.status === 'Built').length} built, ${next7.filter((c) => c.status !== 'Built').length} still to build` : 'Nothing scheduled')}
        ${kpi('Needs input', fmtN(needs.length), 'Blocked on footage, numbers or a decision', needs.filter((c) => daysBetween(today, parseDay(c.date)) < 7).length ? 'alert' : '')}
        ${kpi('Built', fmtN(all.filter((c) => c.status === 'Built').length), 'Assets ready to post')}
        ${kpi('Published', fmtN(all.filter(isPublished).length), 'Stats on the Owned social tab')}
      </div>
      <div class="toolbar cal-filters">
        <div class="seg" role="group" aria-label="Platform">
          ${['all', 'Instagram', 'X'].map((p) => `<button data-cal-pf="${p}" aria-pressed="${f.platform === p}">${p === 'all' ? 'Both' : p}</button>`).join('')}
        </div>
        <div class="chips" role="group" aria-label="Status">
          ${CAL_STATUS.map((s) => `<button class="chip" data-cal-st="${esc(s)}" aria-pressed="${f.statuses.has(s)}"><span class="dot" style="background:${CAL_COLOR[s]}"></span>${esc(s)}</button>`).join('')}
        </div>
        <select id="cal-lane" aria-label="Lane"><option value="all">All lanes</option>${lanes.map((l) => `<option ${f.lane === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <input type="search" id="cal-q" placeholder="Search posts" value="${esc(f.q)}" aria-label="Search posts">
        <label class="inline-check"><input type="checkbox" id="cal-past" ${f.showPast ? 'checked' : ''}> Show past days</label>
        <span class="spacer"></span>
        <button class="btn" id="cal-add" ${canWrite ? '' : 'disabled title="Connect the live sheet in config.js to add posts"'}>Suggest a post</button>
      </div>
      <div id="cal-body">${body || '<p class="muted">No posts match these filters.</p>'}</div>`;
  }

  function bindCalendar(el) {
    const f = state.cal;
    el.querySelectorAll('[data-cal-pf]').forEach((b) => b.addEventListener('click', () => { f.platform = b.dataset.calPf; render(); }));
    el.querySelectorAll('[data-cal-st]').forEach((b) => b.addEventListener('click', () => {
      const s = b.dataset.calSt;
      if (f.statuses.has(s)) f.statuses.delete(s); else f.statuses.add(s);
      render();
    }));
    el.querySelector('#cal-lane')?.addEventListener('change', (e) => { f.lane = e.target.value; render(); });
    el.querySelector('#cal-past')?.addEventListener('change', (e) => { f.showPast = e.target.checked; render(); });
    const q = el.querySelector('#cal-q');
    q?.addEventListener('input', () => {
      f.q = q.value;
      const pos = q.selectionStart;
      render();
      const nq = $('#cal-q'); nq.focus(); nq.setSelectionRange(pos, pos);
    });
    el.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openItem(b.dataset.item)));
    el.querySelector('#cal-add')?.addEventListener('click', openSuggest);
  }

  /* ---------- drawer ---------- */
  let lastFocus = null;
  function openDrawer(html) {
    lastFocus = document.activeElement;
    const d = $('#drawer');
    d.innerHTML = `<button class="close" aria-label="Close">×</button>` + html;
    d.hidden = false; $('#scrim').hidden = false;
    d.scrollTop = 0;
    d.querySelector('.close').addEventListener('click', closeDrawer);
    d.querySelector('.close').focus();
    return d;
  }
  function closeDrawer() {
    $('#drawer').hidden = true; $('#scrim').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  function openItem(id) {
    const c = state.data.calendar.find((x) => x.item_id === id);
    if (!c) return;
    const canWrite = !!(CFG.endpoint && state.live);
    const comments = state.data.comments.filter((x) => x.item_id === id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const link = safeUrl(c.link), live = safeUrl(c.post_url);
    const pair = c.pair_id ? state.data.calendar.find((x) => x.item_id === c.pair_id) : null;
    const o = ownedFor(id);
    const needs = lines(String(c.needs_to_build || '').replace(/;\s*/g, '\n'));
    const confirm = lines(String(c.confirm_before_posting || '').replace(/;\s*/g, '\n'));
    const d = openDrawer(`
      <div class="p-meta"><span class="pill ${CAL_TONE[c.status] || ''}">${esc(c.status || 'Ready')}</span><span class="muted">${esc(c.item_id)}</span></div>
      <h2 id="drawer-title">${esc(c.title || '(untitled)')}</h2>
      <dl class="dl">
        <dt>When</dt><dd>${esc(fmtDay(c.date, true))}${c.time_et ? ` · ${esc(c.time_et)}` : ''}${c.time_ist ? ` <span class="muted">(${esc(c.time_ist)})</span>` : ''}</dd>
        <dt>Platform</dt><dd>${pdot(c.platform)} ${esc(c.platform)} · ${esc(c.format)}</dd>
        ${c.lane ? `<dt>Lane</dt><dd>${esc(c.lane)}</dd>` : ''}
        ${c.tool ? `<dt>Points to</dt><dd>${link ? `<a class="link-out" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(c.tool)} ${extIcon}</a>` : esc(c.tool)}</dd>` : ''}
        ${pair ? `<dt>Paired with</dt><dd><button class="linkish" data-open="${esc(pair.item_id)}">${esc(pair.item_id)} · ${esc(pair.title)}</button></dd>` : ''}
        ${live ? `<dt>Live post</dt><dd><a class="link-out" href="${esc(live)}" target="_blank" rel="noopener noreferrer">Open post ${extIcon}</a></dd>` : ''}
      </dl>
      ${o ? `<div class="statline">${[['Impressions', fmtN(o.impressions)], ['Engagement', fmtPct(o.engRate)], ['Link clicks', fmtN(o.link_clicks)]].map(([k, v]) => `<div><span class="label">${k}</span><b>${v}</b></div>`).join('')}</div>` : ''}
      ${needs.length ? `<div><div class="label">Needs to build</div><ul class="needs">${needs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${confirm.length ? `<div><div class="label">Confirm before posting</div><ul class="needs">${confirm.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${c.hook ? `<div><div class="label">Hook</div><p class="hookline">${esc(c.hook)}</p></div>` : ''}
      ${c.beats ? `<div><div class="label">${c.format === 'Carousel' ? 'Slides' : c.format === 'Reel' ? 'Beats' : 'Copy'}</div><ul class="beats">${lines(c.beats).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
      ${c.caption ? `<div><div class="label">Caption</div><div class="copy-block">${esc(c.caption)}</div></div>` : ''}
      ${c.stories ? `<div><div class="label">Story frames</div><ul class="plain">${lines(c.stories).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${link ? `<div><div class="label">Tracked link</div><code class="url">${esc(link)}</code></div>` : ''}
      <div><div class="label">Comments (${comments.length})</div>
        <div class="comments" id="c-list">${comments.map(commentHtml).join('') || '<p class="muted" style="margin:.3rem 0 0">No comments yet.</p>'}</div></div>
      <div class="form" id="c-form">
        <div class="field"><label for="c-author">Your name</label><input type="text" id="c-author" maxlength="60" value="${esc(store.get('author') || '')}" ${canWrite ? '' : 'disabled'}></div>
        <div class="field"><label for="c-text">Comment</label><textarea id="c-text" maxlength="2000" placeholder="Suggest a better hook, flag a date clash…" ${canWrite ? '' : 'disabled'}></textarea></div>
        <div><button class="btn" id="c-send" ${canWrite ? '' : 'disabled'}>Post comment</button></div>
        <div class="form-msg" id="c-msg">${canWrite ? '' : 'Comments need the live sheet connection (config.js).'}</div>
      </div>`);
    d.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openItem(b.dataset.open)));
    d.querySelector('#c-send')?.addEventListener('click', async () => {
      const author = d.querySelector('#c-author').value.trim();
      const text = d.querySelector('#c-text').value.trim();
      const msg = d.querySelector('#c-msg');
      if (!author || !text) { msg.textContent = 'Add your name and a comment first.'; msg.className = 'form-msg err'; return; }
      store.set('author', author);
      msg.textContent = 'Posting…'; msg.className = 'form-msg';
      try {
        const res = await post({ action: 'comment', item_id: id, author, text });
        state.data.comments.push(res.comment);
        d.querySelector('#c-text').value = '';
        d.querySelector('#c-list').innerHTML = state.data.comments.filter((x) => x.item_id === id).map(commentHtml).join('');
        msg.textContent = 'Comment posted.';
      } catch (e) {
        msg.textContent = `Couldn't post the comment: ${e.message}. Try again.`; msg.className = 'form-msg err';
      }
    });
  }
  const commentHtml = (c) => {
    const t = new Date(c.created_at);
    const when = isNaN(t) ? '' : t.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="comment"><div class="meta"><b>${esc(c.author)}</b> · ${esc(when)}</div><p>${esc(c.text)}</p></div>`;
  };

  function openSuggest() {
    const t = todayUTC();
    const d = openDrawer(`
      <h2 id="drawer-title">Suggest a post</h2>
      <p class="lede">It's added to the calendar as <b>Needs input</b>. The owner fills in the rest in the sheet.</p>
      <div class="form">
        <div class="row">
          <div class="field"><label for="s-date">Date</label><input type="date" id="s-date" value="${isoDay(new Date(t.getTime() + 86400000))}"></div>
          <div class="field"><label for="s-platform">Platform</label><select id="s-platform"><option>Instagram</option><option>X</option></select></div>
          <div class="field"><label for="s-format">Format</label><select id="s-format"><option>Reel</option><option>Carousel</option><option>Post</option><option>Thread</option><option>Poll</option></select></div>
        </div>
        <div class="field"><label for="s-title">Title</label><input type="text" id="s-title" maxlength="120" placeholder="Cyber Monday beats Black Friday"></div>
        <div class="field"><label for="s-hook">Hook or idea</label><textarea id="s-hook" maxlength="4000"></textarea></div>
        <div class="field"><label for="s-author">Your name</label><input type="text" id="s-author" maxlength="60" value="${esc(store.get('author') || '')}"></div>
        <div><button class="btn" id="s-send">Add to calendar</button></div>
        <div class="form-msg" id="s-msg"></div>
      </div>`);
    d.querySelector('#s-send').addEventListener('click', async () => {
      const v = (s) => d.querySelector(s).value.trim();
      const msg = d.querySelector('#s-msg');
      if (!v('#s-title') || !v('#s-author')) { msg.textContent = 'Add a title and your name first.'; msg.className = 'form-msg err'; return; }
      store.set('author', v('#s-author'));
      msg.textContent = 'Adding…'; msg.className = 'form-msg';
      try {
        const res = await post({ action: 'calendar_add', date: v('#s-date'), platform: v('#s-platform'), format: v('#s-format'), title: v('#s-title'), hook: v('#s-hook'), author: v('#s-author') });
        state.data.calendar.push(res.item);
        closeDrawer();
        render();
      } catch (e) {
        msg.textContent = `Couldn't add the post: ${e.message}. Try again.`; msg.className = 'form-msg err';
      }
    });
  }

  async function post(payload) {
    // text/plain keeps this a simple request, so Apps Script needs no CORS preflight.
    const r = await fetch(CFG.endpoint, { method: 'POST', body: JSON.stringify(payload) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'unknown error');
    return j;
  }

  /* ---------- boot ---------- */
  window.addEventListener('hashchange', () => { render(); $('#sidebar').classList.remove('open'); $('#view').focus({ preventScroll: true }); });
  $('#reload').addEventListener('click', load);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
  $('#menu-btn').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menu-btn').setAttribute('aria-expanded', String(open));
  });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (currentView() === 'owned') render(); }, 150); });
  // Pages stay open on a wall screen: pull fresh data every 3 hours.
  setInterval(load, 3 * 60 * 60 * 1000);
  load();
})();
