/* Creator Command Center — reads the Command Center sheet (via Apps Script) or the bundled snapshot. */
(() => {
  'use strict';

  const CFG = Object.assign({ endpoint: '', snapshot: 'data/snapshot.json', business: 'data/business.json', staleAfterDays: 7 }, window.CC_CONFIG || {});
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
    owned: 'Owned social', influencers: 'Influencer performance', impact: 'Business impact', newsletters: 'Newsletters', upcoming: 'Upcoming posts', calendar: 'Content calendar',
  };

  const state = {
    data: null, live: false, error: '',
    inf: { campaign: 'all', platforms: new Set(), q: '', sort: { key: 'date_live', dir: -1 }, csort: { key: 'spend', dir: -1 } },
    up: { campaign: 'all', platform: 'all', stage: null, holdOnly: false },
    nl: { campaign: 'all', newsletter: 'all' },
    own: { platform: 'all', days: 30 },
    imp: { metric: 'signups', segment: 'total', gran: 'day', bars: 'posts', lagPf: 'all', range: '30d', from: '', to: '', campaign: 'all', hidden: new Set() },
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
    state.biz = await loadBusiness();
    renderFreshness();
    render();
  }

  // Daily business metrics from NAO (Ecommerce BU, split Brevo Ecommerce / PushOwl). Optional: the
  // Business impact tab says so when the file is missing.
  async function loadBusiness() {
    try {
      const r = await fetch(CFG.business + '?t=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.json();
      const metrics = {};
      Object.entries(b.metrics || {}).forEach(([k, m]) => {
        metrics[k] = { label: m.label, long: m.long || m.label, brevoOnly: !!m.brevo_only, map: new Map((m.rows || []).map(([d, be, po]) => [d, [num(be), num(po)]])) };
      });
      return { meta: b.meta || {}, metrics };
    } catch (e) {
      return { meta: {}, metrics: {}, error: e.message };
    }
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
    el.innerHTML = notice + ({ owned: viewOwned, influencers: viewInfluencers, impact: viewImpact, newsletters: viewNewsletters, upcoming: viewUpcoming, calendar: viewCalendar }[v])();
    ({ owned: bindOwned, influencers: bindInfluencers, impact: bindImpact, newsletters: bindNewsletters, upcoming: bindUpcoming, calendar: bindCalendar }[v])(el);
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
     Business impact — creator posts (bars) against NAO business metrics (line)
     ========================================================= */
  const SEGMENTS = [['total', 'Ecommerce BU'], ['be', 'Brevo Ecommerce'], ['po', 'PushOwl']];
  // Branded search (state.biz.metrics.branded) is loaded but not offered yet: volumes are too low to read.
  // Add ['branded', 'Branded search'] back here once it picks up.
  const LINE_METRICS = [['npc', 'NPCs'], ['signups', 'Signups'], ['installs', 'Shopify installs']];
  const RANGES = [['30d', '30 days'], ['90d', '90 days'], ['12m', '12 months'], ['qtd', 'Quarter to date'], ['ytd', 'Year to date'], ['custom', 'Custom']];
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const METRIC_NOTES = {
    branded: '<b>How branded search is counted:</b> Google Search Console clicks to brevo.com from searches containing "brevo" plus shopify, ecommerce, e-commerce, woocommerce or store. Clicks rather than impressions, because since 2026 many impressions come from long AI-style prompts that never click. Volumes are small (a handful of clicks a day), so read weekly. Anonymised queries aren\'t counted, so these are lower bounds. There is no Search Console data for pushowl.com yet, so the PushOwl segment is empty and the Ecommerce BU view shows brevo.com only.',
    signups: '<b>How signups are counted:</b> Brevo Ecommerce = new Brevo organizations in the Ecommerce BU (bots and fakes excluded). PushOwl = shops installing the PushOwl Shopify app for the first time. The PushOwl app was delisted from the Shopify App Store, so PushOwl signups are zero from <b>Oct 21, 2026</b>. Brevo Ecommerce signups only exist from <b>Nov 2, 2025</b>: older days can\'t be assigned a BU, so they show as a gap.',
    installs: '<b>How installs are counted:</b> Brevo Ecommerce = new connections of the Brevo Shopify app (reinstalls count again). PushOwl = shops installing the PushOwl Shopify app for the first time, zero since its delisting on <b>Oct 21, 2026</b>. These come from Brevo\'s own data, not the Shopify Partner Dashboard.',
  };

  // null = no data for that day (e.g. a tracking gap), which is different from 0, so a missing
  // half makes the Ecommerce BU total missing too.
  function segVal(v) {
    if (!v) return null;
    const s = state.imp.segment;
    if (s === 'be') return v[0];
    if (s === 'po') return v[1];
    return v[0] === null || v[1] === null ? null : v[0] + v[1];
  }

  function impRange() {
    const f = state.imp, b = state.biz;
    const dates = [...(b.metrics.npc?.map.keys() || [])].sort();
    const first = parseDay(dates[0]) || parseDay('2026-01-01');
    const end = parseDay(b.meta.through) || parseDay(dates[dates.length - 1]) || addDays(todayUTC(), -1);
    let from;
    if (f.range === '30d') from = addDays(end, -29);
    else if (f.range === '90d') from = addDays(end, -89);
    else if (f.range === '12m') from = addDays(end, -364);
    else if (f.range === 'qtd') from = new Date(Date.UTC(end.getUTCFullYear(), Math.floor(end.getUTCMonth() / 3) * 3, 1));
    else if (f.range === 'ytd') from = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
    let to = end;
    if (f.range === 'custom') {
      from = parseDay(f.from) || addDays(end, -89);
      to = parseDay(f.to) || end;
      if (to > end) to = end;
    }
    if (from > to) from = to;
    // Weekly view: start on a Monday so the first bar isn't a short week.
    if (f.gran === 'week') from = weekStart(from);
    if (from < first) from = first;
    return { from, to, first, end };
  }

  // One row per day in range: posts by platform, newsletter sends, metric value and 7-day trailing average.
  const metricVal = (key, iso) => {
    const m = state.biz.metrics[key];
    if (!m || !m.map.has(iso)) return null;
    // Brevo-only metrics (branded search): the BU view shows the Brevo half, PushOwl has no data.
    if (m.brevoOnly) return state.imp.segment === 'po' ? null : m.map.get(iso)[0];
    return segVal(m.map.get(iso));
  };

  function impDaily(from, to) {
    const f = state.imp;
    const inCamp = (c) => f.campaign === 'all' || c === f.campaign;
    const posts = state.data.posts.filter((p) => inCamp(p.campaign) && parseDay(p.date_live));
    const sends = state.data.newsletters.filter((n) => nlSent(n) && inCamp(n.campaign) && parseDay(n.send_date));
    const val = (iso) => metricVal(f.metric, iso);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const iso = isoDay(d);
      const byP = {}, byE = {};
      let noExp = 0;
      posts.filter((p) => String(p.date_live).slice(0, 10) === iso).forEach((p) => {
        byP[p.platform] = (byP[p.platform] || 0) + 1;
        byE[p.platform] = (byE[p.platform] || 0) + (p.exposure || 0);
        if (!p.exposure) noExp += 1;
      });
      const daySends = sends.filter((n) => String(n.send_date).slice(0, 10) === iso);
      const win = [];
      for (let i = 0; i < 7; i++) { const v = val(isoDay(addDays(d, -i))); if (v !== null) win.push(v); }
      days.push({
        iso, d, byP, byE, noExp, posts: sum(Object.values(byP)), value: val(iso),
        ma: win.length === 7 ? sum(win) / 7 : null,
        sends: daySends, nlReach: sum(daySends.map((n) => n.total_sends)),
      });
    }
    return days;
  }

  function impBuckets(days) {
    if (state.imp.gran === 'day') return days.map((x) => ({ ...x, label: fmtDay(x.iso), title: fmtDay(x.iso, true), n: 1 }));
    const map = new Map();
    days.forEach((x) => {
      const k = isoDay(weekStart(x.d));
      if (!map.has(k)) map.set(k, { iso: k, byP: {}, byE: {}, noExp: 0, nlReach: 0, posts: 0, value: null, ma: null, sends: [], n: 0, gaps: 0 });
      const b = map.get(k);
      Object.entries(x.byP).forEach(([p, c]) => { b.byP[p] = (b.byP[p] || 0) + c; });
      Object.entries(x.byE).forEach(([p, c]) => { b.byE[p] = (b.byE[p] || 0) + c; });
      b.posts += x.posts; b.sends.push(...x.sends); b.n += 1; b.noExp += x.noExp; b.nlReach += x.nlReach;
      if (x.value !== null) b.value = (b.value || 0) + x.value; else b.gaps += 1;
    });
    // A week with missing days would read as a drop, so leave it out of the line.
    map.forEach((b) => { if (b.gaps) b.value = null; });
    return [...map.values()].map((b) => ({
      ...b, label: fmtDay(b.iso),
      title: `Week of ${fmtDay(b.iso, true)}${b.n < 7 ? ` (${b.n} of 7 days in range)` : ''}`,
    }));
  }

  // For each lag k: how far the metric ran above or below a normal day, k days after a day with
  // creator posts. "Normal" = the weekday's average over the range (weekends run at about a third of
  // weekdays) scaled by the 21-day centred trend, so steady growth doesn't read as a creator effect.
  function impLags(days, maxLag, pf = 'all') {
    const vals = days.filter((x) => x.value !== null);
    const dowMean = Array.from({ length: 7 }, (_, i) => {
      const xs = vals.filter((x) => x.d.getUTCDay() === i).map((x) => x.value);
      return xs.length ? sum(xs) / xs.length : 0;
    });
    const adj = days.map((x) => (x.value === null || !dowMean[x.d.getUTCDay()] ? null : x.value / dowMean[x.d.getUTCDay()]));
    const ratio = adj.map((v, i) => {
      if (v === null) return null;
      const win = adj.slice(Math.max(0, i - 10), i + 11).filter((w) => w !== null);
      const t = sum(win) / win.length;
      return t ? v / t : null;
    });
    const all = ratio.filter((r) => r !== null).map((r) => r - 1);
    const sd = Math.sqrt(sum(all.map((v) => v * v)) / Math.max(1, all.length - 1));
    const postIdx = days.map((x, i) => ((pf === 'all' ? x.posts : x.byP[pf]) ? i : -1)).filter((i) => i >= 0);
    const out = [];
    for (let k = 0; k <= maxLag; k++) {
      const rs = postIdx.map((i) => ratio[i + k]).filter((r) => r !== null && r !== undefined);
      out.push({
        k, n: rs.length,
        lift: rs.length ? sum(rs) / rs.length - 1 : null,
        noise: rs.length ? (2 * sd) / Math.sqrt(rs.length) : null,
      });
    }
    return out;
  }

  // Bar series stacked in the chart: creator posts by platform, then newsletter sends on top.
  function impStack(buckets) {
    const keys = [...new Set(buckets.flatMap((x) => Object.keys(x.byP)))].sort(byPlatformOrder);
    if (buckets.some((x) => x.sends.length)) keys.push('Newsletter');
    return keys;
  }
  const stackVal = (x, k) => (state.imp.bars === 'reach'
    ? (k === 'Newsletter' ? x.nlReach : x.byE[k] || 0)
    : (k === 'Newsletter' ? x.sends.length : x.byP[k] || 0));

  function viewImpact() {
    const f = state.imp, b = state.biz;
    if (!b || !b.metrics.npc) {
      return `<div class="empty"><h3>No business data loaded</h3><p>This tab reads <code>data/business.json</code>${b && b.error ? ` (${esc(b.error)})` : ''}.</p></div>`;
    }
    if (!b.metrics[f.metric] || !LINE_METRICS.some(([k]) => k === f.metric)) f.metric = 'signups';
    const { from, to, first, end } = impRange();
    const days = impDaily(from, to);
    const buckets = impBuckets(days);
    const m = b.metrics[f.metric];
    const segName = SEGMENTS.find((x) => x[0] === f.segment)[1];
    const span = days.length;
    const prev = impDaily(addDays(from, -span), addDays(from, -1)).filter((x) => x.value !== null);
    const total = sum(days.map((x) => x.value));
    const prevTotal = prev.length === span && from > first ? sum(prev.map((x) => x.value)) : null;
    const change = prevTotal ? (total - prevTotal) / prevTotal : null;
    const weekdays = days.filter((x) => x.value !== null && x.d.getUTCDay() % 6 !== 0);
    const missing = days.filter((x) => x.value === null).length;
    const postsN = sum(days.map((x) => x.posts));
    const postDays = days.filter((x) => x.posts).length;
    const plats = [...new Set(days.flatMap((x) => Object.keys(x.byP)))];
    const sendsN = sum(days.map((x) => x.sends.length));
    const camps = [...new Set([...state.data.posts.map((p) => p.campaign), ...state.data.newsletters.filter(nlSent).map((n) => n.campaign)])].filter((c) => c && c !== 'unassigned');
    const fromIso = isoDay(from), toIso = isoDay(to);
    const { first: lagFrom, end: lagTo } = impRange();
    const lagDays = impDaily(lagFrom, lagTo);
    const lagPlats = [...new Set(lagDays.flatMap((x) => Object.keys(x.byP)))].sort(byPlatformOrder);
    if (f.lagPf !== 'all' && !lagPlats.includes(f.lagPf)) f.lagPf = 'all';
    const lagPostDays = lagDays.filter((x) => (f.lagPf === 'all' ? x.posts : x.byP[f.lagPf])).length;
    const lagOk = lagPostDays >= 5;
    const lagWho = f.lagPf === 'all' ? 'a creator post' : `a ${f.lagPf} post`;
    const lg = (key, swatch, label) => `<button type="button" class="lg-item" data-imp-series="${esc(key)}" aria-pressed="${!f.hidden.has(key)}" title="Show or hide">${swatch} ${esc(label)}</button>`;

    return `
      <p class="lede">Creator posts going live against <b>${esc(m.long)}</b> for the <b>${esc(segName)}</b>, ${esc(fmtDay(fromIso, true))} to ${esc(fmtDay(toIso, true))}. The line is the whole segment, not only customers attributed to creators: read it for trend, not cause.</p>
      ${METRIC_NOTES[f.metric] ? `<div class="notice"><span>${METRIC_NOTES[f.metric]}</span></div>` : ''}
      <div class="toolbar">
        <div class="field"><span class="label">Line</span>
          <div class="seg" role="group" aria-label="Line metric">
            ${LINE_METRICS.map(([k, l]) => `<button data-imp-metric="${k}" aria-pressed="${f.metric === k}" ${b.metrics[k] ? '' : 'disabled title="Not loaded from NAO yet"'}>${l}</button>`).join('')}
          </div></div>
        <div class="field"><span class="label">Segment</span>
          <div class="seg" role="group" aria-label="Segment">
            ${SEGMENTS.map(([k, l]) => `<button data-imp-seg="${k}" aria-pressed="${f.segment === k}">${l}</button>`).join('')}
          </div></div>
        <div class="field"><span class="label">Bars</span>
          <div class="seg" role="group" aria-label="Bar measure">
            <button data-imp-bars="posts" aria-pressed="${f.bars === 'posts'}">Posts</button>
            <button data-imp-bars="reach" aria-pressed="${f.bars === 'reach'}">Impressions</button>
          </div></div>
        <div class="field"><span class="label">View</span>
          <div class="seg" role="group" aria-label="Granularity">
            <button data-imp-gran="day" aria-pressed="${f.gran === 'day'}">Daily</button>
            <button data-imp-gran="week" aria-pressed="${f.gran === 'week'}">Weekly</button>
          </div></div>
        <div class="field"><label for="imp-range">Date range</label>
          <select id="imp-range">${RANGES.map(([k, l]) => `<option value="${k}" ${f.range === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${f.range === 'custom' ? `
          <div class="field"><label for="imp-from">From</label><input type="date" id="imp-from" value="${fromIso}" min="${isoDay(first)}" max="${isoDay(end)}"></div>
          <div class="field"><label for="imp-to">To</label><input type="date" id="imp-to" value="${toIso}" min="${isoDay(first)}" max="${isoDay(end)}"></div>` : ''}
        <div class="field"><label for="imp-campaign">Campaign</label>
          <select id="imp-campaign">
            <option value="all">All campaigns</option>
            ${camps.map((c) => `<option value="${esc(c)}" ${f.campaign === c ? 'selected' : ''}>${esc(campaignName(c))}</option>`).join('')}
          </select></div>
      </div>
      <div class="kpis">
        ${kpi('Creator posts live', fmtN(postsN), postsN ? `On ${postDays} days · ${plats.length} platform${plats.length === 1 ? '' : 's'}` : 'None in this range')}
        ${kpi(m.label, fmtN(total), missing ? `Excludes ${missing} day${missing === 1 ? '' : 's'} with no data` : change === null ? segName : `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}% vs previous ${span} days`)}
        ${kpi(`${m.label} per weekday`, weekdays.length ? fmtN(sum(weekdays.map((x) => x.value)) / weekdays.length) : '—', 'Average, Monday to Friday')}
        ${kpi('Newsletter sends', fmtN(sendsN), sendsN ? [...new Set(days.flatMap((x) => x.sends.map((n) => n.newsletter)))].join(', ') : 'None in this range')}
      </div>
      <section class="card">
        <div class="card-head"><h2>${f.bars === 'reach' ? 'Impressions' : 'Posts live'} vs ${esc(m.label)}</h2><span class="muted">${f.gran === 'day' ? 'Per day' : 'Per week, Monday start'} · ${esc(segName)}</span>
          <span class="spacer"></span><button class="btn secondary sm" id="imp-csv" type="button">Download CSV</button></div>
        <div class="legend" aria-label="Click to show or hide a series">
          ${impStack(buckets).map((k) => lg(k, pdot(k), k === 'Newsletter' ? (f.bars === 'reach' ? 'Newsletter recipients' : 'Newsletter sends') : `${k} ${f.bars === 'reach' ? 'impressions' : 'posts'}`)).join('')}
          ${lg('line', '<i class="lg-line"></i>', m.label)}
          ${f.gran === 'day' ? lg('ma', '<i class="lg-line dash"></i>', '7-day average') : ''}
          <span class="lg-hint">Click to show or hide</span>
        </div>
        <div class="chart" id="imp-chart"></div>
        ${f.bars === 'reach' ? `<p class="note">Impressions are counted on the day each post went live (views for video, impressions otherwise), at their latest reading. Newsletter sends count their reported recipients.${sum(buckets.map((x) => x.noExp)) ? ` ${sum(buckets.map((x) => x.noExp))} posts in this range have no views logged yet and add nothing.` : ''}</p>` : ''}
      </section>
      ${campaignCard(m, segName)}
      <section class="card">
        <div class="card-head"><h2>What happens to ${esc(m.label)} in the days after ${esc(lagWho)}?</h2><span class="muted">All posts since ${esc(fmtDay(isoDay(lagFrom), true))} · ${lagPostDays} posting days · not limited by the date range above</span></div>
        <div class="seg" role="group" aria-label="Platform for the lag view">
          ${['all', ...lagPlats].map((p) => `<button data-imp-lagpf="${esc(p)}" aria-pressed="${f.lagPf === p}">${p === 'all' ? 'All platforms' : esc(p)}</button>`).join('')}
        </div>
        ${lagOk ? `
          <p class="note">For every day ${esc(lagWho)} went live (<b>day 0</b>), we take ${esc(m.label)} on that day and on each of the 14 days after, and compare them with a <b>normal day</b>: the same weekday, adjusted for the overall trend at that time. A bar at <b>+5%</b> over <b>+3</b> means that 3 days after posting days, ${esc(m.label)} averaged 5% above normal. The grey box behind each bar is the range chance alone produces: a bar that stays inside its box is not a real signal, and only bars that break out of it are coloured.</p>
          <div class="chart" id="imp-lag"></div>
          <p class="note" id="imp-lag-note"></p>`
        : `<p class="muted">Needs posts on at least 5 days. There are ${lagPostDays} so far${f.campaign !== 'all' ? ' for this campaign' : ''}${f.lagPf !== 'all' ? ` on ${esc(f.lagPf)}` : ''}.</p>`}
      </section>
      <section class="card">
        <div class="card-head"><h2>Signup to NPC conversion</h2><span class="muted">NPCs per 100 signups, per week · ${esc(segName)}</span></div>
        <div class="chart" id="imp-conv"></div>
        <p class="note">Creator campaigns bring in signups first. People then try Brevo on the free plan, and only some of them start paying once they've used it for a while, so NPCs from a wave of signups arrive weeks later. Both counts here come from the same week, which means a surge in signups pulls this rate down at first: the new signups are counted, but they haven't had time to convert yet. Watch the weeks after a campaign. If the rate recovers, or goes above where it was, the signups were good quality.</p>
      </section>`;
  }

  function bindImpact(el) {
    const f = state.imp;
    const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, fn));
    on('[data-imp-metric]', 'click', (e) => { f.metric = e.currentTarget.dataset.impMetric; render(); });
    on('[data-imp-seg]', 'click', (e) => { f.segment = e.currentTarget.dataset.impSeg; render(); });
    on('[data-imp-gran]', 'click', (e) => { f.gran = e.currentTarget.dataset.impGran; render(); });
    on('[data-imp-bars]', 'click', (e) => { f.bars = e.currentTarget.dataset.impBars; render(); });
    on('[data-imp-lagpf]', 'click', (e) => { f.lagPf = e.currentTarget.dataset.impLagpf; render(); });
    on('[data-imp-series]', 'click', (e) => {
      const k = e.currentTarget.dataset.impSeries;
      if (f.hidden.has(k)) f.hidden.delete(k); else f.hidden.add(k);
      render();
    });
    on('#imp-range', 'change', (e) => {
      if (e.target.value === 'custom') { const r = impRange(); f.from = isoDay(r.from); f.to = isoDay(r.to); }
      f.range = e.target.value; render();
    });
    on('#imp-from', 'change', (e) => { f.from = e.target.value; render(); });
    on('#imp-to', 'change', (e) => { f.to = e.target.value; render(); });
    on('#imp-campaign', 'change', (e) => { f.campaign = e.target.value; render(); });
    if (!state.biz?.metrics.npc) return;
    const { from, to } = impRange();
    const days = impDaily(from, to);
    const buckets = impBuckets(days);
    const box = el.querySelector('#imp-chart');
    if (box) drawImpact(box, buckets);
    const lagBox = el.querySelector('#imp-lag');
    if (lagBox) { const r = impRange(); drawLags(lagBox, impLags(impDaily(r.first, r.end), 14, f.lagPf)); }
    const convBox = el.querySelector('#imp-conv');
    if (convBox) drawConversion(convBox);
    on('#imp-csv', 'click', () => downloadImpactCsv(buckets));
  }

  function showTip(e, html) {
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 12) + 'px';
    tip.style.top = Math.min(window.innerHeight - th - 8, e.clientY + 12) + 'px';
  }

  function drawImpact(box, buckets) {
    const f = state.imp, m = state.biz.metrics[f.metric];
    const stack = impStack(buckets).filter((k) => !f.hidden.has(k));
    const showLine = !f.hidden.has('line');
    const showMa = f.gran === 'day' && !f.hidden.has('ma');
    const W = Math.max(320, box.clientWidth), H = 324, mg = { t: 14, r: 52, b: 40, l: 40 };
    const iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    const stackTotal = (x) => sum(stack.map((k) => stackVal(x, k)));
    // Both axes get 4 equal steps so they share gridlines.
    const maxP = Math.max(1, ...buckets.map(stackTotal));
    const stepP = f.bars === 'reach' ? fineStep(maxP / 4) : Math.max(1, Math.ceil(maxP / 4));
    const topP = stepP * 4;
    const maxV = Math.max(1, ...(showLine ? buckets.map((x) => x.value || 0) : []), ...(showMa ? buckets.map((x) => x.ma || 0) : []));
    const stepV = fineStep(maxV / 4);
    const topV = stepV * 4;
    const bw = iw / buckets.length;
    const yP = (v) => mg.t + ih - (v / topP) * ih;
    const yV = (v) => mg.t + ih - (v / topV) * ih;
    const cx = (i) => mg.l + i * bw + bw / 2;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Creator posts per ${f.gran} against ${esc(m.label)}">`;
    for (let i = 0; i <= 4; i++) {
      svg += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${yP(i * stepP)}" y2="${yP(i * stepP)}" stroke="var(--grid)" />`;
      if (stack.length) svg += `<text x="${mg.l - 6}" y="${yP(i * stepP) + 4}" text-anchor="end">${fmtN(i * stepP)}</text>`;
      if (showLine || showMa) svg += `<text x="${W - mg.r + 6}" y="${yV(i * stepV) + 4}" text-anchor="start" class="ax-line">${fmtN(i * stepV)}</text>`;
    }
    if (stack.length) svg += `<text x="${f.bars === 'reach' ? 0 : mg.l - 6}" y="${H - 2}" text-anchor="${f.bars === 'reach' ? 'start' : 'end'}" class="ax-title">${f.bars === 'reach' ? 'Impressions' : 'Posts'}</text>`;
    if (showLine || showMa) svg += `<text x="${W}" y="${H - 2}" text-anchor="end" class="ax-title">${esc(m.label)}</text>`;
    const labelEvery = Math.ceil(buckets.length / Math.max(2, Math.floor(iw / 64)));
    buckets.forEach((x, i) => {
      let y0 = mg.t + ih;
      const w = Math.max(1, Math.min(28, bw * 0.7));
      stack.forEach((k) => {
        const c = stackVal(x, k);
        if (!c) return;
        const h = (c / topP) * ih;
        y0 -= h;
        svg += `<rect x="${cx(i) - w / 2}" y="${y0}" width="${w}" height="${Math.max(1, h - 1)}" fill="${PLATFORM_COLOR[k] || 'var(--fg-3)'}" />`;
      });
      if (i % labelEvery === 0) svg += `<text x="${cx(i)}" y="${H - 18}" text-anchor="middle">${esc(x.label)}</text>`;
    });
    const path = (key) => {
      let d = '', pen = false;
      buckets.forEach((x, i) => {
        if (x[key] === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)} ${yV(x[key]).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    if (showMa) svg += `<path d="${path('ma')}" fill="none" stroke="var(--fg-2)" stroke-width="1.5" stroke-dasharray="4 3" />`;
    if (showLine) {
      svg += `<path d="${path('value')}" fill="none" stroke="var(--metric)" stroke-width="2" stroke-linejoin="round" />`;
      if (buckets.length <= 60) buckets.forEach((x, i) => { if (x.value !== null) svg += `<circle cx="${cx(i)}" cy="${yV(x.value)}" r="2.5" fill="var(--metric)" />`; });
    }
    svg += `<line id="imp-cursor" x1="0" x2="0" y1="${mg.t}" y2="${mg.t + ih}" stroke="var(--fg-3)" stroke-dasharray="2 3" visibility="hidden" />`;
    buckets.forEach((x, i) => { svg += `<rect data-i="${i}" x="${mg.l + i * bw}" y="${mg.t}" width="${bw}" height="${ih}" fill="transparent" />`; });
    svg += '</svg>';
    box.innerHTML = svg;
    const cursor = box.querySelector('#imp-cursor');
    const allKeys = impStack(buckets);
    box.querySelectorAll('rect[data-i]').forEach((r) => {
      r.addEventListener('mousemove', (e) => {
        const i = +r.dataset.i, x = buckets[i];
        cursor.setAttribute('x1', cx(i)); cursor.setAttribute('x2', cx(i)); cursor.setAttribute('visibility', 'visible');
        const pl = allKeys.filter((k) => k !== 'Newsletter' && x.byP[k]).map((k) => `<div>${pdot(k)} ${esc(k)}: ${x.byP[k]} post${x.byP[k] === 1 ? '' : 's'} · ${fmtN(x.byE[k] || 0)} impressions</div>`).join('');
        showTip(e, `<div class="t-h">${esc(x.title)}</div>
          <div class="t-v">${esc(m.label)}: <b>${x.value === null ? '—' : fmtN(x.value)}</b>${f.gran === 'day' && x.ma !== null ? ` · 7-day avg ${fmtN(x.ma)}` : ''}</div>
          <div class="t-v">Creator posts: <b>${x.posts}</b></div>${pl}
          ${x.sends.length ? `<div>${pdot('Newsletter')} Newsletter: ${esc(x.sends.map((n) => n.newsletter).join(', '))}${x.nlReach ? ` · ${fmtN(x.nlReach)} recipients` : ''}</div>` : ''}`);
      });
      r.addEventListener('mouseleave', () => { $('#tooltip').hidden = true; cursor.setAttribute('visibility', 'hidden'); });
    });
  }

  function drawLags(box, lags) {
    const m = state.biz.metrics[state.imp.metric];
    const pct = (v) => `${v >= 0 ? '+' : '−'}${+Math.abs(v * 100).toFixed(1)}%`;
    const W = Math.max(320, box.clientWidth), H = 230, mg = { t: 12, r: 12, b: 40, l: 52 };
    const iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    const ext = Math.max(0.05, ...lags.map((l) => Math.abs(l.lift || 0)), ...lags.map((l) => l.noise || 0));
    const step = fineStep(ext / 2);
    const top = step * 2;
    const y = (v) => mg.t + ih / 2 - (v / top) * (ih / 2);
    const bw = iw / lags.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(m.label)} versus a normal day, by days after a creator post">`;
    [-top, -step, 0, step, top].forEach((v) => {
      svg += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--fg-3)' : 'var(--grid)'}" />`;
      svg += `<text x="${mg.l - 6}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? 'Normal' : pct(v)}</text>`;
    });
    lags.forEach((l, i) => {
      const x0 = mg.l + i * bw, w = bw * 0.56, x = x0 + (bw - w) / 2;
      if (l.lift !== null) {
        const real = Math.abs(l.lift) > l.noise;
        svg += `<rect x="${x - 3}" y="${y(l.noise)}" width="${w + 6}" height="${y(-l.noise) - y(l.noise)}" rx="3" fill="var(--grid)" />`;
        svg += `<rect x="${x}" y="${Math.min(y(l.lift), y(0))}" width="${w}" height="${Math.max(1, Math.abs(y(l.lift) - y(0)))}" rx="2" fill="${real ? 'var(--metric)' : 'var(--bar-muted)'}" />`;
        if (bw > 34) svg += `<text x="${x + w / 2}" y="${l.lift >= 0 ? y(Math.max(l.lift, l.noise)) - 4 : y(Math.min(l.lift, -l.noise)) + 12}" text-anchor="middle" class="${real ? 'ax-line' : ''}">${pct(l.lift)}</text>`;
      }
      svg += `<text x="${x + w / 2}" y="${H - 22}" text-anchor="middle">${l.k === 0 ? 'Day 0' : '+' + l.k}</text>`;
      svg += `<rect data-i="${i}" x="${x0}" y="${mg.t}" width="${bw}" height="${ih}" fill="transparent" />`;
    });
    svg += `<text x="${mg.l + iw / 2}" y="${H - 4}" text-anchor="middle" class="ax-title">Days after a creator post went live</text></svg>`;
    box.innerHTML = svg;
    box.querySelectorAll('rect[data-i]').forEach((r) => {
      r.addEventListener('mousemove', (e) => {
        const l = lags[+r.dataset.i];
        if (l.lift === null) return;
        const when = l.k === 0 ? 'On posting days' : `${l.k} day${l.k === 1 ? '' : 's'} after posting days`;
        showTip(e, `<div class="t-h">${when}</div>
          <div class="t-v">${esc(m.label)} ${pct(l.lift)} vs a normal day</div>
          <div>Chance range: ±${(l.noise * 100).toFixed(1)}% · ${Math.abs(l.lift) > l.noise ? 'outside it, so likely real' : 'inside it, so not a signal'}</div>
          <div>Based on ${l.n} posting days</div>`);
      });
      r.addEventListener('mouseleave', () => { $('#tooltip').hidden = true; });
    });
    const real = lags.filter((l) => l.lift !== null && Math.abs(l.lift) > l.noise).sort((a, b) => b.lift - a.lift);
    const note = $('#imp-lag-note');
    if (note) {
      const days = (k) => (k === 0 ? 'on posting days' : `${k} day${k === 1 ? '' : 's'} after posting days`);
      note.innerHTML = real.length
        ? `<b>What this shows:</b> ${real.map((l) => `${esc(m.label)} ran <b>${pct(l.lift)}</b> vs normal ${days(l.k)}`).join('; ')}. Every other day is within chance. One or two bars outside their box can still be luck when 15 are tested, so look for the same day standing out across campaigns before reading it as an effect.`
        : `<b>What this shows:</b> no day stands out from chance. ${esc(m.label)} after creator posts look like ${esc(m.label)} on any other comparable day.`;
    }
  }

  // Each campaign window against (a) the 4 weeks before it, weekday-matched, and (b) the same weekdays
  // a year earlier. The chance range comes from how much single days wander in the 4-week baseline.
  function impCampaigns() {
    const f = state.imp;
    const through = parseDay(state.biz.meta.through);
    const used = new Set([...state.data.posts.map((p) => p.campaign), ...state.data.newsletters.filter(nlSent).map((n) => n.campaign)]);
    return state.data.campaigns
      .filter((c) => used.has(c.campaign_id) && parseDay(c.start) && parseDay(c.start) <= through && (f.campaign === 'all' || f.campaign === c.campaign_id))
      .map((c) => {
        const s = parseDay(c.start);
        const endPlanned = parseDay(c.end) || through;
        const e = endPlanned < through ? endPlanned : through;
        const win = [];
        for (let d = s; d <= e; d = addDays(d, 1)) win.push({ d, v: metricVal(f.metric, isoDay(d)) });
        const base = [];
        for (let d = addDays(s, -28); d < s; d = addDays(d, 1)) base.push({ d, v: metricVal(f.metric, isoDay(d)) });
        const dow = Array.from({ length: 7 }, (_, i) => {
          const xs = base.filter((x) => x.v !== null && x.d.getUTCDay() === i).map((x) => x.v);
          return xs.length ? sum(xs) / xs.length : null;
        });
        const ok = win.every((x) => x.v !== null) && base.every((x) => x.v !== null) && dow.every((x) => x);
        const actual = sum(win.map((x) => x.v));
        let lift = null, noise = null, yoy = null;
        if (ok) {
          lift = actual / sum(win.map((x) => dow[x.d.getUTCDay()])) - 1;
          const r = base.map((x) => x.v / dow[x.d.getUTCDay()] - 1);
          noise = (2 * Math.sqrt(sum(r.map((v) => v * v)) / (r.length - 1))) / Math.sqrt(win.length);
        }
        const ly = win.map((x) => metricVal(f.metric, isoDay(addDays(x.d, -364))));
        if (win.every((x) => x.v !== null) && ly.every((v) => v !== null) && sum(ly)) yoy = actual / sum(ly) - 1;
        return {
          c, s, e, days: win.length, running: endPlanned > through,
          posts: state.data.posts.filter((p) => p.campaign === c.campaign_id).length,
          sends: state.data.newsletters.filter((n) => nlSent(n) && n.campaign === c.campaign_id).length,
          perDay: win.every((x) => x.v !== null) ? actual / win.length : null,
          basePerDay: base.every((x) => x.v !== null) ? sum(base.map((x) => x.v)) / base.length : null,
          lyPerDay: ly.every((v) => v !== null) ? sum(ly) / ly.length : null,
          lift, noise, yoy,
        };
      });
  }

  function campaignCard(m, segName) {
    const rows = impCampaigns();
    if (!rows.length) return '';
    const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
    const liftCell = (r) => {
      if (r.lift === null) return '<span class="dash">—</span>';
      const real = Math.abs(r.lift) > r.noise;
      return `${pct(r.lift)} ${real ? `<span class="pill ${r.lift > 0 ? 'ok' : 'bad'}">${r.lift > 0 ? 'Above' : 'Below'} normal</span>` : `<span class="muted" title="Chance range ±${(r.noise * 100).toFixed(1)}%">within normal</span>`}`;
    };
    const cell = (v) => (v === null ? '<span class="dash">—</span>' : fmtN(v));
    return `
      <section class="card">
        <div class="card-head"><h2>Campaigns: before and during</h2><span class="muted">${esc(m.label)} per day · ${esc(segName)}</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Campaign</th><th>Window</th><th class="num">Posts</th><th class="num">During</th><th class="num">4 weeks before</th><th class="num">Change vs before</th><th class="num">Same weeks last year</th><th class="num">Change vs last year</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(campaignName(r.c.campaign_id))}</td>
            <td>${esc(fmtDay(isoDay(r.s)))} – ${esc(fmtDay(isoDay(r.e)))} <span class="muted">· ${r.days} days${r.running ? ', running' : ''}</span></td>
            <td class="num">${r.posts}${r.sends ? ` <span class="muted">+ ${r.sends} sends</span>` : ''}</td>
            <td class="num">${cell(r.perDay)}</td>
            <td class="num">${cell(r.basePerDay)}</td>
            <td class="num">${liftCell(r)}</td>
            <td class="num">${cell(r.lyPerDay)}</td>
            <td class="num">${r.yoy === null ? '<span class="dash">—</span>' : pct(r.yoy)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="note"><b>Change vs before</b> compares each day of the campaign with the same weekday in the 4 weeks before it started. It is marked above or below normal only when it falls outside what chance produces over that many days. <b>Change vs last year</b> also includes a year of business growth, so read it as context. Campaigns that overlap share the same days, so their numbers aren't additive.${state.imp.metric === 'signups' ? ' Brevo Ecommerce signups start on Nov 2, 2025, so there is no last-year figure yet.' : ''}</p>
      </section>`;
  }

  // Weekly NPCs per 100 signups for the selected segment, with weekly creator posts behind it.
  function drawConversion(box) {
    const f = state.imp;
    const { to } = impRange();
    let { from } = impRange();
    from = weekStart(from);
    // Fewer than 8 weeks makes a meaningless line; show the last 12 weeks instead.
    const short = (to - from) / 86400000 < 7 * 8;
    if (short) from = weekStart(addDays(to, -7 * 12 + 1));
    const weeks = [];
    for (let w = from; w <= to; w = addDays(w, 7)) {
      const days = [];
      for (let d = w; d < addDays(w, 7) && d <= to; d = addDays(d, 1)) days.push(isoDay(d));
      const npc = days.map((d) => metricVal('npc', d));
      const su = days.map((d) => metricVal('signups', d));
      const full = days.length === 7 && npc.every((v) => v !== null) && su.every((v) => v !== null);
      const n = sum(npc), sgn = sum(su);
      const posts = state.data.posts.filter((p) => (f.campaign === 'all' || p.campaign === f.campaign) && days.includes(String(p.date_live).slice(0, 10))).length;
      weeks.push({ iso: isoDay(w), npc: full ? n : null, su: full ? sgn : null, rate: full && sgn ? (n / sgn) * 100 : null, posts });
    }
    const W = Math.max(320, box.clientWidth), H = 240, mg = { t: 14, r: 52, b: 40, l: 40 };
    const iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    const rates = weeks.map((x) => x.rate).filter((v) => v !== null);
    if (!rates.length) { box.innerHTML = '<p class="muted">No weeks with both NPCs and signups in this range.</p>'; return; }
    const stepV = fineStep(Math.max(...rates) / 4), topV = stepV * 4;
    const stepP = Math.max(1, Math.ceil(Math.max(1, ...weeks.map((x) => x.posts)) / 4)), topP = stepP * 4;
    const bw = iw / weeks.length;
    const cx = (i) => mg.l + i * bw + bw / 2;
    const yV = (v) => mg.t + ih - (v / topV) * ih;
    const yP = (v) => mg.t + ih - (v / topP) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="NPCs per 100 signups by week">`;
    for (let i = 0; i <= 4; i++) {
      svg += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${yV(i * stepV)}" y2="${yV(i * stepV)}" stroke="var(--grid)" />`;
      svg += `<text x="${W - mg.r + 6}" y="${yV(i * stepV) + 4}" class="ax-line">${+(i * stepV).toFixed(1)}</text>`;
      svg += `<text x="${mg.l - 6}" y="${yP(i * stepP) + 4}" text-anchor="end">${i * stepP}</text>`;
    }
    svg += `<text x="${mg.l - 6}" y="${H - 2}" text-anchor="end" class="ax-title">Posts</text>`;
    svg += `<text x="${W}" y="${H - 2}" text-anchor="end" class="ax-title">NPCs per 100 signups</text>`;
    const labelEvery = Math.ceil(weeks.length / Math.max(2, Math.floor(iw / 64)));
    weeks.forEach((x, i) => {
      const w = Math.min(28, bw * 0.6);
      if (x.posts) svg += `<rect x="${cx(i) - w / 2}" y="${yP(x.posts)}" width="${w}" height="${mg.t + ih - yP(x.posts)}" rx="2" fill="var(--bar-muted)" />`;
      if (i % labelEvery === 0) svg += `<text x="${cx(i)}" y="${H - 18}" text-anchor="middle">${esc(fmtDay(x.iso))}</text>`;
    });
    let d = '', pen = false;
    weeks.forEach((x, i) => {
      if (x.rate === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)} ${yV(x.rate).toFixed(1)}`; pen = true;
    });
    svg += `<path d="${d}" fill="none" stroke="var(--metric)" stroke-width="2" stroke-linejoin="round" />`;
    weeks.forEach((x, i) => { if (x.rate !== null) svg += `<circle cx="${cx(i)}" cy="${yV(x.rate)}" r="3" fill="var(--metric)" />`; });
    weeks.forEach((x, i) => { svg += `<rect data-i="${i}" x="${mg.l + i * bw}" y="${mg.t}" width="${bw}" height="${ih}" fill="transparent" />`; });
    svg += '</svg>';
    box.innerHTML = (short ? '<p class="muted" style="margin:0 0 .4rem">Showing the last 12 weeks: the selected range is too short for a weekly rate.</p>' : '') + svg;
    box.querySelectorAll('rect[data-i]').forEach((r) => {
      r.addEventListener('mousemove', (e) => {
        const x = weeks[+r.dataset.i];
        showTip(e, `<div class="t-h">Week of ${esc(fmtDay(x.iso, true))}</div>
          <div class="t-v">${x.rate === null ? 'No complete data' : `${x.rate.toFixed(1)} NPCs per 100 signups`}</div>
          ${x.rate === null ? '' : `<div>${fmtN(x.npc)} NPCs · ${fmtN(x.su)} signups</div>`}
          <div>Creator posts: ${x.posts}</div>`);
      });
      r.addEventListener('mouseleave', () => { $('#tooltip').hidden = true; });
    });
  }

  function downloadImpactCsv(buckets) {
    const f = state.imp, m = state.biz.metrics[f.metric];
    const plats = [...new Set(buckets.flatMap((x) => Object.keys(x.byP)))].sort(byPlatformOrder);
    const segName = SEGMENTS.find((x) => x[0] === f.segment)[1];
    const head = [f.gran === 'day' ? 'date' : 'week_start', 'posts_live', ...plats.map((p) => `posts_${p.toLowerCase()}`), `${f.metric}_${segName.toLowerCase().replace(/\s+/g, '_')}`, 'newsletter_sends'];
    const rows = buckets.map((x) => [x.iso, x.posts, ...plats.map((p) => x.byP[p] || 0), x.value ?? '', x.sends.length]);
    const csv = [head, ...rows].map((r) => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `creator-posts-vs-${f.metric}-${f.gran}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
  function fineStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw > 0 ? raw : 1)));
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => n * p >= raw) || 10) * p;
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
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (['owned', 'impact'].includes(currentView())) render(); }, 150); });
  // Pages stay open on a wall screen: pull fresh data every 3 hours.
  setInterval(load, 3 * 60 * 60 * 1000);
  load();
})();
