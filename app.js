/* ClickCRM frontend. Static site (GitHub Pages) that talks to the Apps Script backend. */
(function () {
  'use strict';

  const CLIENT_VERSION = '1.0.0';
  const CFG = window.CLICKCRM_CONFIG || {};
  const LS_TOKEN = 'clickcrm.token';
  const LS_OUTBOX = 'clickcrm.outbox';
  const TZ = 'Asia/Jerusalem';

  const CONSENT = { NONE: 'Not contacted', SENT: 'Request sent', YES: 'Yes', NO: 'Said no', UNSUB: 'Unsubscribed' };
  const CONSENT_LIST = [CONSENT.NONE, CONSENT.SENT, CONSENT.YES, CONSENT.NO, CONSENT.UNSUB];
  const PRODUCT_STATUSES = ['Info sent', 'Interested', 'Trying', 'Customer', 'Not relevant'];
  const CONF_RANK = { High: 0, Medium: 1, Low: 2 };

  const S = {
    token: '', tokenExp: 0, email: '',
    loaded: false,
    companies: [], people: [], tasks: [], unread: [], products: [], settings: {},
    me: '', sentToday: 0, lastSync: '', lastBackup: '',
    bundle: null,
    outbox: [],
    busy: 0,
    serverVersion: '',
    versionWarned: false,
    lastRefresh: 0,
    filters: { q: '', status: '', segment: '', product: '', conf: '', archived: false, sort: 'name' },
    importRows: null
  };
  const inflight = new Set();
  let gisReady = false;

  // ============================== helpers ==============================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ESC[ch]); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function newReqId() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return 'r' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  const dtFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function fmtDateTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : dtFmt.format(d); }
  function fmtDay(ymd) { if (!ymd) return ''; const d = new Date(ymd + 'T12:00:00Z'); return isNaN(d) ? ymd : dFmt.format(d); }
  function todayYmd() { return ymdFmt.format(new Date()); }
  function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function phoneDigits(s) { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('972')) d = '0' + d.slice(3); return d; }
  function telHref(s) { return 'tel:' + String(s || '').replace(/[^\d+]/g, ''); }
  function urlHref(u) { u = String(u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u; }
  function domainOf(website, email) {
    let d = String(website || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/:\d+$/, '');
    if (d.indexOf('.') < 0) d = '';
    if (!d && email && email.indexOf('@') > 0) d = email.split('@')[1].toLowerCase();
    return d;
  }
  function fill(tpl, ctx) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined ? ctx[k] : m)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function primaryName(c) { return c.nameHe || c.nameEn || '(no name)'; }
  function secondaryName(c) { return c.nameHe && c.nameEn ? c.nameEn : ''; }
  function status(c) { return c.consentStatus || CONSENT.NONE; }
  function stClass(st) {
    return { [CONSENT.NONE]: 'st-none', [CONSENT.SENT]: 'st-sent', [CONSENT.YES]: 'st-yes', [CONSENT.NO]: 'st-no', [CONSENT.UNSUB]: 'st-unsub' }[st] || 'st-none';
  }
  function badge(st) { return `<span class="badge ${stClass(st)}">${esc(st)}</span>`; }
  function confHtml(v) { return v ? `<span class="conf ${esc(v)}"><i></i>${esc(v)}</span>` : '<span class="conf"><i></i>Unknown</span>'; }
  function isArchived(c) { return c.archived === 'TRUE'; }
  function companyById(id) { return S.companies.find(c => c.id === id) || (S.bundle && S.bundle.company.id === id ? S.bundle.company : null); }
  function productById(id) { return S.products.find(p => p.id === id); }
  function activeProducts() { return S.products.filter(p => p.active === 'TRUE'); }
  function blocked(c) { const st = status(c); return st === CONSENT.NO || st === CONSENT.UNSUB; }
  function ctxFor(c, p) {
    return {
      company: c ? (c.nameHe || c.nameEn || '') : '', sender: S.settings.senderName || '', senderEmail: S.me || '',
      product: p ? p.name : '', link: p ? p.website : '', store: p ? p.storeLink : ''
    };
  }
  function footerText() {
    const s = S.settings;
    const contact = [S.me, s.senderPhone].filter(Boolean).join(' | ');
    return ['--', s.senderName || '', s.senderAddress || '', contact, '',
      'קיבלתם הודעה זו כי הסכמתם לקבל ממני מידע.', 'להסרה, השיבו להודעה זו עם המילה "הסר".'].join('\n');
  }
  function gmailUrl(hash) { return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(S.me || S.email) + '#' + hash; }

  // ============================== auth ==============================
  function decodeJwt(t) {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '==='.slice((p.length + 3) % 4));
    const json = decodeURIComponent(Array.from(bin, ch => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  }
  function setToken(t) {
    const p = decodeJwt(t);
    S.token = t; S.tokenExp = (p.exp || 0) * 1000; S.email = String(p.email || '').toLowerCase();
    try { localStorage.setItem(LS_TOKEN, t); } catch (e) { /* private mode */ }
  }
  function loadToken() { try { const t = localStorage.getItem(LS_TOKEN); if (t) setToken(t); } catch (e) { clearToken(); } }
  function clearToken() { S.token = ''; S.tokenExp = 0; try { localStorage.removeItem(LS_TOKEN); } catch (e) { /* ignore */ } }
  function tokenValid() { return !!S.token && S.tokenExp - Date.now() > 60 * 1000; }

  function whenGis() {
    return new Promise(resolve => {
      const tick = () => (window.google && google.accounts && google.accounts.id) ? resolve() : setTimeout(tick, 100);
      tick();
    });
  }
  async function initGis() {
    await whenGis();
    google.accounts.id.initialize({
      client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true,
      cancel_on_tap_outside: false, use_fedcm_for_prompt: true
    });
    gisReady = true;
    google.accounts.id.renderButton($('#signin-button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280 });
    if (!$('#signin').hidden) { try { google.accounts.id.prompt(); } catch (e) { /* button still works */ } }
  }
  function onCredential(resp) {
    try { setToken(resp.credential); } catch (e) { showSignin('Sign-in failed. Please try again.'); return; }
    const allowed = String(CFG.ALLOWED_EMAIL || '').toLowerCase();
    if (allowed && S.email !== allowed) {
      const wrong = S.email;
      clearToken();
      showSignin(`You signed in as ${wrong}. Choose ${allowed} instead.`);
      return;
    }
    $('#signin').hidden = true;
    if (!S.loaded) startApp(); else flushOutbox();
  }
  function showSignin(msg) {
    $('#signin').hidden = false;
    $('#signin-msg').textContent = msg || '';
    if (gisReady) { try { google.accounts.id.prompt(); } catch (e) { /* ignore */ } }
  }
  function signOut() {
    clearToken();
    if (gisReady) { try { google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ } }
    showSignin('You are signed out.');
  }

  // ============================== API ==============================
  function netError(msg) { const e = new Error(msg); e.code = 'NETWORK'; e.unknown = true; return e; }

  async function api(action, payload, opts) {
    opts = opts || {};
    if (!tokenValid()) { const e = new Error('Please sign in again.'); e.code = 'AUTH'; throw e; }
    const body = JSON.stringify({ action, payload: payload || {}, token: S.token, reqId: opts.reqId || '', clientVersion: CLIENT_VERSION });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
    let data;
    try {
      const res = await fetch(CFG.BACKEND_URL, {
        method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: ctrl.signal
      });
      try { data = await res.json(); } catch (e) { throw netError('The server answer could not be read.'); }
    } catch (e) {
      if (e.code === 'NETWORK') throw e;
      throw netError(navigator.onLine ? 'No answer from the server.' : 'You are offline.');
    } finally {
      clearTimeout(timer);
    }
    checkVersion(data.serverVersion);
    if (!data.ok) {
      const e = new Error(data.message || 'Something went wrong.');
      e.code = data.code; e.unknown = !!data.unknown;
      if (e.code === 'AUTH') { clearToken(); showSignin(e.message); }
      if (e.code === 'FORBIDDEN') { clearToken(); showSignin(e.message); }
      throw e;
    }
    return data;
  }

  function checkVersion(sv) {
    if (!sv) return;
    S.serverVersion = sv;
    const a = CLIENT_VERSION.split('.').slice(0, 2).join('.');
    const b = String(sv).split('.').slice(0, 2).join('.');
    if (a !== b && !S.versionWarned) {
      S.versionWarned = true;
      const el = $('#banner');
      el.hidden = false;
      el.innerHTML = `<b>Versions don’t match.</b> Website ${esc(CLIENT_VERSION)}, backend ${esc(sv)}. In Apps Script choose Deploy → Manage deployments → Edit → Version: New version → Deploy, then reload this page.`;
    }
  }

  // ============================== outbox (safe saving) ==============================
  function loadOutbox() { try { S.outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]'); } catch (e) { S.outbox = []; } }
  function saveOutbox() { try { localStorage.setItem(LS_OUTBOX, JSON.stringify(S.outbox)); } catch (e) { /* ignore */ } updateSyncPill(); }
  function dropOutbox(reqId) { S.outbox = S.outbox.filter(i => i.reqId !== reqId); saveOutbox(); }

  /** Saves a change. Returns server data, or null if it is kept on this device to retry later. Throws on a definite error. */
  async function write(action, payload, label) {
    const item = { reqId: newReqId(), action, payload, label: label || 'Change', createdAt: Date.now() };
    S.outbox.push(item); saveOutbox();
    inflight.add(item.reqId); S.busy++; updateSyncPill();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api(action, payload, { reqId: item.reqId });
          dropOutbox(item.reqId);
          await applyResult(data);
          return data;
        } catch (e) {
          if (e.code === 'AUTH' || e.code === 'FORBIDDEN') {
            toast('Sign in again. Your change is kept on this device and will be saved after you sign in.', 'warn');
            return null;
          }
          if (e.unknown || e.code === 'BUSY') {
            if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
            toast('Not saved yet. It is kept on this device and will be saved automatically.', 'warn');
            return null;
          }
          dropOutbox(item.reqId);
          throw e;
        }
      }
      return null;
    } finally {
      inflight.delete(item.reqId); S.busy--; updateSyncPill();
    }
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !S.outbox.length || !tokenValid()) return;
    flushing = true; S.busy++; updateSyncPill();
    try {
      for (const item of S.outbox.slice()) {
        if (inflight.has(item.reqId)) continue;
        inflight.add(item.reqId);
        try {
          const data = await api(item.action, item.payload, { reqId: item.reqId });
          dropOutbox(item.reqId);
          await applyResult(data);
          toast(item.label + ': saved');
        } catch (e) {
          if (e.unknown || e.code === 'BUSY' || e.code === 'AUTH' || e.code === 'FORBIDDEN') break;
          dropOutbox(item.reqId);
          toast(`“${item.label}” could not be saved: ${e.message}`, 'error');
        } finally {
          inflight.delete(item.reqId);
        }
      }
    } finally {
      flushing = false; S.busy--; updateSyncPill();
    }
  }

  function updateSyncPill() {
    const el = $('#sync-pill');
    if (!el) return;
    el.className = 'sync-pill';
    if (S.busy > 0) { el.classList.add('busy'); el.textContent = 'Saving…'; return; }
    const waiting = S.outbox.length;
    if (waiting) { el.classList.add('warn'); el.textContent = `${plural(waiting, 'change', 'changes')} waiting to save`; return; }
    if (!navigator.onLine) { el.classList.add('warn'); el.textContent = 'Offline'; return; }
    el.textContent = S.lastSync ? 'Emails checked ' + fmtDateTime(S.lastSync) : 'All saved';
  }

  /** Sends an email. Never retried automatically. Returns {status:'sent'|'failed'|'unknown', message}. */
  async function sendEmail(action, payload, reqId) {
    if (!tokenValid()) { showSignin('Sign in again, then press Send.'); return { status: 'failed', message: 'Sign in again, then press Send.' }; }
    S.busy++; updateSyncPill();
    try {
      const data = await api(action, payload, { reqId, timeout: 120000 });
      await applyResult(data);
      return { status: 'sent' };
    } catch (e) {
      if (e.unknown) return { status: 'unknown', message: e.message };
      return { status: 'failed', message: e.message, code: e.code };
    } finally {
      S.busy--; updateSyncPill();
    }
  }

  // ============================== data ==============================
  function applyBoot(b) {
    S.companies = b.companies || [];
    S.people = b.people || [];
    S.tasks = b.tasks || [];
    S.unread = b.unread || [];
    S.products = b.products || [];
    S.settings = b.settings || {};
    S.me = b.me || S.email;
    S.sentToday = b.sentToday || 0;
    S.lastSync = b.lastSync || '';
    S.lastBackup = b.lastBackup || '';
    S.lastRefresh = Date.now();
    S.loaded = true;
    $('#side-user').textContent = S.me;
    updateCounts();
  }
  function applyBundle(b) {
    if (!b || !b.company) return;
    const i = S.companies.findIndex(c => c.id === b.company.id);
    if (i >= 0) S.companies[i] = b.company; else S.companies.push(b.company);
    S.people = S.people.filter(p => p.companyId !== b.company.id).concat(b.people || []);
    const r = route();
    if (r.name === 'company' && r.id === b.company.id) S.bundle = b;
    else if (S.bundle && S.bundle.company.id === b.company.id) S.bundle = b;
  }
  async function applyResult(data) {
    if (!data) return;
    if (data.boot) applyBoot(data.boot);
    if (data.bundle) applyBundle(data.bundle);
    if (data.tasks) S.tasks = data.tasks;
    if (data.unread) S.unread = data.unread;
    if (data.products) S.products = data.products;
    if (data.settings) S.settings = data.settings;
    if (typeof data.sentToday === 'number') S.sentToday = data.sentToday;
    if (data.refetch) await refreshAll(true);
    updateCounts();
    render();
  }
  async function refreshAll(silent) {
    try {
      const data = await api('bootstrap');
      applyBoot(data.boot);
      const r = route();
      if (r.name === 'company' && r.id) {
        const d2 = await api('getCompany', { id: r.id });
        S.bundle = d2.bundle;
      }
      render();
    } catch (e) {
      if (!silent) throw e;
    }
  }
  async function loadCompany(id) {
    try {
      const data = await api('getCompany', { id });
      if (route().id === id) { S.bundle = data.bundle; applyBundle(data.bundle); render(); }
    } catch (e) {
      if (route().id === id) $('#view').innerHTML = errorBox(e.message, 'reload-company');
    }
  }
  function updateCounts() {
    const n = S.unread.length;
    $$('[data-count="unread"]').forEach(el => { el.textContent = n ? String(n) : ''; });
    document.title = n ? `(${n}) ClickCRM` : 'ClickCRM';
  }

  // ============================== routing & rendering ==============================
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    return { name: parts[0] || 'today', id: parts[1] ? decodeURIComponent(parts[1]) : '' };
  }
  function go(hash) { if (location.hash === hash) onRoute(); else location.hash = hash; }
  function onRoute() {
    const r = route();
    if (r.name === 'company') {
      if (!S.bundle || S.bundle.company.id !== r.id) { S.bundle = null; loadCompany(r.id); }
    }
    render();
    window.scrollTo(0, 0);
    closeSearch();
  }

  function render() {
    if (!S.loaded) return;
    const r = route();
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === r.name || (r.name === 'company' && a.dataset.nav === 'companies')));
    const view = $('#view');
    const active = document.activeElement;
    const keep = active && view.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    let html;
    switch (r.name) {
      case 'companies': html = viewCompanies(); break;
      case 'company': html = viewCompany(r.id); break;
      case 'products': html = viewProducts(); break;
      case 'import': html = viewImport(); break;
      case 'settings': html = viewSettings(); break;
      default: html = viewToday();
    }
    view.innerHTML = html;
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ } }
    }
    updateSyncPill();
  }
  function errorBox(msg, act) {
    return `<div class="panel"><p>${esc(msg)}</p><button class="btn" data-act="${esc(act)}">Try again</button></div>`;
  }

  // ---------- Today ----------
  function viewToday() {
    const today = todayYmd();
    const soonEnd = addDaysYmd(today, 7);
    const limit = Number(S.settings.dailyLimit || 20);
    const unread = S.unread.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const todo = S.tasks.filter(t => !t.dueDate || t.dueDate <= today).sort(byDue);
    const soon = S.tasks.filter(t => t.dueDate && t.dueDate > today && t.dueDate <= soonEnd).sort(byDue);
    const live = S.companies.filter(c => !isArchived(c));
    const readyAll = live.filter(c => status(c) === CONSENT.NONE && c.email);
    const ready = readyAll.slice().sort(byConfidence).slice(0, 8);
    const counts = {};
    CONSENT_LIST.forEach(s => { counts[s] = 0; });
    live.forEach(c => { counts[status(c)] = (counts[status(c)] || 0) + 1; });
    const pct = Math.min(100, Math.round((S.sentToday / limit) * 100));

    return `
      <div class="page-head">
        <div><h1>Today</h1><p>${esc(dFmt.format(new Date()))}</p></div>
        <div class="actions"><button class="btn" data-act="new-task">Add to-do</button><button class="btn" data-act="new-company">Add company</button></div>
      </div>
      <div class="today-grid">
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>New replies<span class="count">${unread.length || ''}</span></h2></div>
            ${unread.length ? unread.map(replyCard).join('') : '<p class="empty">No new replies. Use “Check replies” at the top to look again.</p>'}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Ready to contact<span class="count">${readyAll.length || ''}</span></h2>
              <a href="#/companies" data-act="filter-status" data-status="${esc(CONSENT.NONE)}" class="small">See all</a></div>
            <div class="meter"><span>Sent today: ${S.sentToday} of ${limit}</span><span class="meter-bar"><i style="width:${pct}%"></i></span></div>
            ${ready.length ? ready.map(c => `
              <div class="ready-row">
                <div class="grow"><a href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>
                  <div class="small muted">${esc([c.city, c.segment].filter(Boolean).join(', '))}</div></div>
                ${confHtml(c.revitConfidence)}
                <button class="btn small" data-act="compose-consent" data-id="${esc(c.id)}">Send request</button>
              </div>`).join('') : (live.length
                ? '<p class="empty">Everyone with an email address has been contacted. Import more companies to continue.</p>'
                : '<p class="empty">No companies yet. <a href="#/import">Import your list</a> to start.</p>')}
          </section>
        </div>
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>To do</h2><button class="link-btn" data-act="new-task">Add</button></div>
            ${todo.length ? todo.map(taskRow).join('') : '<p class="empty">Nothing to do today.</p>'}
            ${soon.length ? `<h3 style="margin-top:14px">Coming up</h3>${soon.map(taskRow).join('')}` : ''}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Your list</h2><span class="small muted">${plural(live.length, 'company', 'companies')}</span></div>
            <div class="status-strip">
              ${CONSENT_LIST.map(s => `<button data-act="filter-status" data-status="${esc(s)}"><b>${counts[s] || 0}</b><span>${esc(s)}</span></button>`).join('')}
            </div>
          </section>
        </div>
      </div>`;
  }
  function byDue(a, b) { return String(a.dueDate || '0').localeCompare(String(b.dueDate || '0')); }
  function byConfidence(a, b) {
    const d = (CONF_RANK[a.revitConfidence] ?? 3) - (CONF_RANK[b.revitConfidence] ?? 3);
    return d || primaryName(a).localeCompare(primaryName(b));
  }

  function replyCard(a) {
    const c = companyById(a.companyId) || { id: a.companyId, nameEn: a.companyName };
    return `
      <article class="reply">
        <div class="reply-head"><a class="reply-co" href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>
          ${badge(status(c))}<time>${esc(fmtDateTime(a.date))}</time></div>
        <div class="reply-from" dir="auto">${esc(a.fromAddr)}</div>
        <p class="reply-text" dir="auto">${esc(String(a.body || '').slice(0, 400))}${String(a.body || '').length > 400 ? '…' : ''}</p>
        ${reviewButtons(a, c)}
      </article>`;
  }
  function reviewButtons(a, c) {
    const sug = a.suggest || '';
    const hint = { yes: 'This looks like a yes.', no: 'This looks like a no.', unsub: 'This looks like a removal request.' }[sug];
    const b = (decision, text) => `<button class="btn small ${sug === decision ? 'suggested' : ''}" data-act="review" data-id="${esc(a.id)}" data-decision="${decision}">${text}</button>`;
    const reply = `<button class="btn small ghost" data-act="compose-reply" data-thread="${esc(a.threadId)}" data-company="${esc(c.id)}">Reply</button>`;
    if (status(c) === CONSENT.SENT) {
      return `${hint ? `<p class="reply-hint">${hint} Please confirm.</p>` : ''}
        <div class="actions">${b('yes', 'They said yes')}${b('no', 'They said no')}${b('unsub', 'Remove them')}${b('read', 'Just mark as read')}${reply}</div>`;
    }
    return `${sug === 'unsub' ? '<p class="reply-hint">This looks like a removal request.</p>' : ''}
      <div class="actions">${reply}${b('read', 'Mark as read')}${status(c) !== CONSENT.UNSUB ? b('unsub', 'Remove them') : ''}</div>`;
  }
  function taskRow(t) {
    const c = t.companyId ? companyById(t.companyId) : null;
    const due = t.dueDate ? fmtDay(t.dueDate) : '';
    return `<div class="task">
      <button class="task-check" data-act="task-done" data-id="${esc(t.id)}" aria-label="Mark as done"></button>
      <div class="task-body"><div dir="auto">${esc(t.text)}</div>
        <div class="task-meta">${due ? esc(due) : 'No date'}${c ? ` · <a href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>` : ''}</div></div>
      <button class="link-btn small" data-act="edit-task" data-id="${esc(t.id)}">Edit</button>
    </div>`;
  }

  // ---------- Companies ----------
  function filteredCompanies() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    const qDigits = phoneDigits(q);
    let list = S.companies.filter(c => (f.archived ? isArchived(c) : !isArchived(c)));
    if (f.status) list = list.filter(c => status(c) === f.status);
    if (f.segment) list = list.filter(c => (c.segment || '') === f.segment);
    if (f.conf) list = list.filter(c => (c.revitConfidence || '') === (f.conf === 'none' ? '' : f.conf));
    if (f.product) list = list.filter(c => c.productStatus && c.productStatus[f.product]);
    if (q) list = list.filter(c => matchesQuery(c, q, qDigits));
    const sorts = {
      name: (a, b) => primaryName(a).localeCompare(primaryName(b)),
      updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      confidence: byConfidence
    };
    return list.sort(sorts[f.sort] || sorts.name);
  }
  function matchesQuery(c, q, qDigits) {
    const hay = [c.nameEn, c.nameHe, c.email, c.domain, c.city, c.segment].join(' ').toLowerCase();
    if (hay.indexOf(q) >= 0) return true;
    if (qDigits.length >= 4 && phoneDigits(c.phone).indexOf(qDigits) >= 0) return true;
    return S.people.some(p => p.companyId === c.id &&
      ([p.name, p.email].join(' ').toLowerCase().indexOf(q) >= 0 || (qDigits.length >= 4 && phoneDigits(p.phone).indexOf(qDigits) >= 0)));
  }
  function viewCompanies() {
    const f = S.filters;
    const segments = Array.from(new Set(S.companies.map(c => c.segment).filter(Boolean))).sort();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return `
      <div class="page-head">
        <div><h1>Companies</h1></div>
        <div class="actions"><a class="btn" href="#/import">Import list</a><button class="btn primary" data-act="new-company">Add company</button></div>
      </div>
      <div class="filters">
        <input type="search" id="co-q" data-filter="q" value="${esc(f.q)}" placeholder="Search name, email, city or phone" dir="auto" aria-label="Search companies">
        <select data-filter="status" aria-label="Consent status">${opt('', 'Any status', f.status)}${CONSENT_LIST.map(s => opt(s, s, f.status)).join('')}</select>
        <select data-filter="segment" aria-label="Segment">${opt('', 'Any segment', f.segment)}${segments.map(s => opt(s, s, f.segment)).join('')}</select>
        <select data-filter="conf" aria-label="Revit confidence">${opt('', 'Any Revit confidence', f.conf)}${['High', 'Medium', 'Low'].map(s => opt(s, s, f.conf)).join('')}${opt('none', 'Unknown', f.conf)}</select>
        <select data-filter="product" aria-label="Product">${opt('', 'Any product', f.product)}${S.products.map(p => opt(p.id, 'Has ' + p.name + ' status', f.product)).join('')}</select>
        <select data-filter="sort" aria-label="Sort">${opt('name', 'Sort by name', f.sort)}${opt('updated', 'Recently updated', f.sort)}${opt('confidence', 'Revit confidence', f.sort)}</select>
        <label class="check"><input type="checkbox" data-filter="archived" ${f.archived ? 'checked' : ''}> Archived</label>
      </div>
      <div id="co-results">${companyListHtml()}</div>`;
  }
  function companyListHtml() {
    const list = filteredCompanies();
    if (!S.companies.length) {
      return `<div class="panel"><p>No companies yet. Import the list from your research, or add one by hand.</p>
        <div class="actions"><a class="btn primary" href="#/import">Import list</a><button class="btn" data-act="new-company">Add company</button></div></div>`;
    }
    if (!list.length) return '<div class="panel"><p class="empty">No companies match these filters.</p></div>';
    return `<p class="list-count">${plural(list.length, 'company', 'companies')}</p>
      <div class="co-list">${list.map(companyRowHtml).join('')}</div>`;
  }
  function companyRowHtml(c) {
    const ps = c.productStatus || {};
    const tags = Object.keys(ps).map(pid => { const p = productById(pid); return p && ps[pid] ? `<span class="tag">${esc(p.name)}: ${esc(ps[pid])}</span>` : ''; }).join('');
    return `<a class="co-row" href="#/company/${encodeURIComponent(c.id)}">
      <span><span class="co-name" dir="auto">${esc(primaryName(c))}</span>${secondaryName(c) ? `<span class="co-sub">${esc(secondaryName(c))}</span>` : ''}</span>
      <span class="co-meta" dir="auto">${esc(c.city || '')}</span>
      <span class="co-conf">${confHtml(c.revitConfidence)}</span>
      <span class="co-status">${badge(status(c))}${tags}</span>
    </a>`;
  }

  // ---------- Company page ----------
  function viewCompany(id) {
    const b = S.bundle;
    if (!b || b.company.id !== id) return '<div class="loading">Loading company…</div>';
    const c = b.company;
    const st = status(c);
    const pending = S.outbox.filter(i => i.payload && i.payload.companyId === c.id && (i.action === 'addNote' || i.action === 'logCall'));
    const openTasks = b.tasks.filter(t => t.done !== 'TRUE').sort(byDue);
    const meta = [c.city, c.segment, c.employees ? c.employees + ' employees' : ''].filter(Boolean);

    let primary = '';
    if (!isArchived(c) && st === CONSENT.NONE && c.email) primary = `<button class="btn primary" data-act="compose-consent" data-id="${esc(c.id)}">Send consent request</button>`;
    if (!isArchived(c) && st === CONSENT.YES) primary = `<button class="btn primary" data-act="compose-product" data-id="${esc(c.id)}">Send product email</button>`;

    return `
      <a class="back" href="#/companies">‹ Companies</a>
      ${isArchived(c) ? '<div class="notice archived-note">This company is archived. Restore it to work with it again.</div>' : ''}
      <div class="co-head">
        <h1 dir="auto">${esc(primaryName(c))}</h1>
        ${secondaryName(c) ? `<div class="alt-name">${esc(secondaryName(c))}</div>` : ''}
        <div class="meta-line">${badge(st)}${confHtml(c.revitConfidence)}${meta.map(m => `<span dir="auto">${esc(m)}</span>`).join('')}</div>
        <div class="actions">
          ${primary}
          <button class="btn" data-act="log-call" data-id="${esc(c.id)}">Log call</button>
          <button class="btn" data-act="add-note" data-id="${esc(c.id)}">Add note</button>
          <button class="btn" data-act="new-task" data-company="${esc(c.id)}">Add to-do</button>
          ${c.phone ? `<a class="btn" href="${esc(telHref(c.phone))}">Call ${esc(c.phone)}</a>` : ''}
          ${c.email || c.domain ? `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(gmailUrl('search/' + encodeURIComponent(c.domain || c.email)))}">Find in Gmail</a>` : ''}
        </div>
      </div>
      <div class="co-layout">
        <div class="stack">
          ${consentPanel(c)}
          ${productsPanel(c)}
          <section class="panel">
            <div class="panel-head"><h2>To do</h2><button class="link-btn" data-act="new-task" data-company="${esc(c.id)}">Add</button></div>
            ${openTasks.length ? openTasks.map(taskRow).join('') : '<p class="empty">No open to-dos.</p>'}
          </section>
          ${detailsPanel(c)}
          <section class="panel">
            <div class="panel-head"><h2>People</h2><button class="link-btn" data-act="person" data-company="${esc(c.id)}">Add person</button></div>
            ${b.people.length ? b.people.map(p => `
              <div class="person"><div class="grow"><b dir="auto">${esc(p.name)}</b>${p.role ? ` <span class="muted" dir="auto">${esc(p.role)}</span>` : ''}
                <div class="small">${p.email ? esc(p.email) : ''}${p.email && p.phone ? ' · ' : ''}${p.phone ? `<a href="${esc(telHref(p.phone))}">${esc(p.phone)}</a>` : ''}</div>
                ${p.notes ? `<div class="small muted" dir="auto">${esc(p.notes)}</div>` : ''}</div>
                <button class="link-btn small" data-act="person" data-id="${esc(p.id)}" data-company="${esc(c.id)}">Edit</button></div>`).join('')
              : '<p class="empty">Add people when they give you their details, for example after they reply or call.</p>'}
          </section>
          <div class="actions">
            <button class="btn ghost" data-act="archive" data-id="${esc(c.id)}" data-archived="${isArchived(c) ? '' : '1'}">${isArchived(c) ? 'Restore company' : 'Archive company'}</button>
          </div>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>History</h2><span class="small muted">${plural(b.activities.length, 'entry', 'entries')}</span></div>
          <ul class="timeline">
            ${pending.map(i => `<li class="act pending"><div class="act-head"><span class="act-kind">${i.action === 'logCall' ? 'Call' : 'Note'}</span><time>Waiting to save</time></div>
              <div class="act-body" dir="auto">${esc(i.payload.summary || i.payload.text || '')}</div></li>`).join('')}
            ${b.activities.length ? b.activities.map(a => activityHtml(a, c)).join('') : (pending.length ? '' : '<li class="empty">Nothing here yet.</li>')}
          </ul>
        </section>
      </div>`;
  }

  function consentPanel(c) {
    const st = status(c);
    const steps = [
      { label: CONSENT.NONE, date: '' },
      { label: CONSENT.SENT, date: c.consentRequestDate },
      { label: 'Agreed', date: c.consentDate }
    ];
    let items;
    if (st === CONSENT.NO || st === CONSENT.UNSUB) {
      items = `<li class="done">${CONSENT.NONE}</li>
        <li class="${c.consentRequestDate ? 'done' : ''}">${CONSENT.SENT}${c.consentRequestDate ? `<time>${esc(fmtDateTime(c.consentRequestDate))}</time>` : ''}</li>
        <li class="stop ${stClass(st)}">${esc(st)}${c.unsubscribedDate && st === CONSENT.UNSUB ? `<time>${esc(fmtDateTime(c.unsubscribedDate))}</time>` : ''}</li>`;
    } else {
      const idx = st === CONSENT.YES ? 2 : st === CONSENT.SENT ? 1 : 0;
      items = steps.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now ' + stClass(st) : ''}">${esc(s.label)}${s.date && i <= idx ? `<time>${esc(fmtDateTime(s.date))}</time>` : ''}</li>`).join('');
    }
    let text = '';
    if (st === CONSENT.NONE) text = c.email ? 'You can send one consent request to this company.' : 'Add an email address to send a consent request.';
    if (st === CONSENT.SENT) text = 'Waiting for their answer. The law allows only one request, so the CRM won’t send another.';
    if (st === CONSENT.YES) text = 'They agreed. You can send product emails.';
    if (st === CONSENT.NO) text = 'They said no. The CRM blocks all emails to this company.';
    if (st === CONSENT.UNSUB) text = 'They asked to be removed. The CRM blocks all emails to this company.';
    return `<section class="panel">
      <div class="panel-head"><h2>Consent</h2><button class="link-btn" data-act="change-consent" data-id="${esc(c.id)}">Change</button></div>
      <ol class="rail">${items}</ol>
      <p class="small" style="margin:0">${esc(text)}</p>
      ${st === CONSENT.YES && c.consentProof ? `<div class="proof" dir="auto">${esc(c.consentProof)}</div>
        ${c.consentProofLink ? `<a class="small" target="_blank" rel="noopener" href="${esc(c.consentProofLink)}">Open the reply in Gmail</a>` : ''}` : ''}
    </section>`;
  }

  function productsPanel(c) {
    const ps = c.productStatus || {};
    const list = S.products.filter(p => p.active === 'TRUE' || ps[p.id]);
    if (!list.length) return '';
    return `<section class="panel"><div class="panel-head"><h2>Products</h2></div>
      ${list.map(p => `<div class="prod-row"><span>${esc(p.name)}</span>
        <select data-act-change="product-status" data-company="${esc(c.id)}" data-product="${esc(p.id)}" aria-label="${esc(p.name)} status">
          <option value="">Not started</option>
          ${PRODUCT_STATUSES.map(s => `<option ${ps[p.id] === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select></div>`).join('')}
    </section>`;
  }

  function detailsPanel(c) {
    const row = (label, val) => (val ? `<dt>${esc(label)}</dt><dd dir="auto">${val}</dd>` : '');
    const link = (u, text) => (u ? `<a href="${esc(urlHref(u))}" target="_blank" rel="noopener" dir="ltr">${esc(text || u)}</a>` : '');
    return `<section class="panel">
      <div class="panel-head"><h2>Details</h2><button class="link-btn" data-act="edit-company" data-id="${esc(c.id)}">Edit</button></div>
      <dl class="dl">
        ${row('Email', c.email ? esc(c.email) : '')}
        ${row('Phone', c.phone ? `<a href="${esc(telHref(c.phone))}">${esc(c.phone)}</a>` : '')}
        ${row('Website', link(c.website))}
        ${row('LinkedIn', link(c.linkedin, 'Profile'))}
        ${row('City', esc(c.city))}
        ${row('Segment', esc(c.segment))}
        ${row('Revit evidence', esc(c.revitEvidence))}
        ${row('Evidence page', link(c.evidenceUrl, 'Open'))}
        ${row('Email found at', link(c.sourceUrl, 'Open'))}
        ${row('Notes', esc(c.notes))}
        ${row('Added', esc(fmtDateTime(c.createdAt)))}
      </dl>
    </section>`;
  }

  function bodyBlock(text) {
    const t = String(text || '');
    if (!t) return '';
    const long = t.length > 380 || t.split('\n').length > 6;
    return `<div class="act-body ${long ? 'clamp' : ''}" dir="auto">${esc(t)}</div>${long ? '<button class="link-btn small" data-act="expand">Show all</button>' : ''}`;
  }

  function activityHtml(a, c) {
    const when = `<time>${esc(fmtDateTime(a.date))}</time>`;
    const gmail = a.threadId ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(gmailUrl('all/' + a.threadId))}">Open in Gmail</a>` : '';
    if (a.type === 'email_in') {
      return `<li class="act act-in ${a.unread === 'TRUE' ? 'is-new' : ''}">
        <div class="act-head"><span class="act-kind">Email received</span>${a.unread === 'TRUE' ? '<span class="new-dot">New</span>' : ''}${when}</div>
        <div class="act-line" dir="auto">From ${esc(a.fromAddr)}</div>
        <div class="act-subj" dir="auto">${esc(a.subject)}</div>
        ${bodyBlock(a.body)}
        ${a.unread === 'TRUE' ? reviewButtons(a, c) : `<div class="act-actions"><button class="btn small" data-act="compose-reply" data-thread="${esc(a.threadId)}" data-company="${esc(c.id)}">Reply</button>${gmail}</div>`}
      </li>`;
    }
    if (a.type === 'email_out') {
      const kind = { consent: 'Consent request sent', product: 'Product email sent', reply: 'Reply sent', gmail: 'Email sent from Gmail' }[a.kind] || 'Email sent';
      return `<li class="act act-out">
        <div class="act-head"><span class="act-kind">${esc(kind)}</span>${when}</div>
        <div class="act-line" dir="auto">To ${esc(a.toAddr)}</div>
        <div class="act-subj" dir="auto">${esc(a.subject)}</div>
        ${bodyBlock(a.body)}
        ${gmail ? `<div class="act-actions">${gmail}</div>` : ''}
      </li>`;
    }
    if (a.type === 'call_in' || a.type === 'call_out') {
      return `<li class="act act-call">
        <div class="act-head"><span class="act-kind">${a.type === 'call_in' ? 'They called' : 'You called'}</span>${when}</div>
        ${a.subject ? `<div class="act-line" dir="auto">With ${esc(a.subject)}</div>` : ''}
        ${bodyBlock(a.body)}
      </li>`;
    }
    if (a.type === 'note') {
      return `<li class="act"><div class="act-head"><span class="act-kind">Note</span>${when}</div>${bodyBlock(a.body)}</li>`;
    }
    return `<li class="act act-status"><div class="act-head"><span class="act-kind" dir="auto">${esc(a.subject || 'Update')}</span>${when}</div>
      ${a.body ? `<div class="small muted" dir="auto" style="white-space:pre-wrap">${esc(a.body)}</div>` : ''}</li>`;
  }

  // ---------- Products ----------
  function viewProducts() {
    return `
      <div class="page-head"><div><h1>Products</h1><p>Each product has its own pitch email. Inactive products can’t be sent.</p></div>
        <button class="btn primary" data-act="edit-product">Add product</button></div>
      <div class="grid-2">
        ${S.products.map(p => {
          const n = S.companies.filter(c => c.productStatus && c.productStatus[p.id]).length;
          return `<section class="panel prod-card">
            <div class="panel-head"><h3>${esc(p.name)} ${p.active === 'TRUE' ? '' : '<span class="tag">Inactive</span>'}</h3>
              <button class="link-btn" data-act="edit-product" data-id="${esc(p.id)}">Edit</button></div>
            ${p.description ? `<p dir="auto">${esc(p.description)}</p>` : ''}
            <p class="small">${p.website ? `<a href="${esc(urlHref(p.website))}" target="_blank" rel="noopener">Website</a>` : 'No website'}
              · ${p.storeLink ? `<a href="${esc(urlHref(p.storeLink))}" target="_blank" rel="noopener">Store page</a>` : '<span style="color:var(--st-sent)">Store link missing</span>'}</p>
            <p class="small muted">${plural(n, 'company has', 'companies have')} a status for this product.</p>
          </section>`;
        }).join('') || '<p class="empty">No products yet.</p>'}
      </div>`;
  }

  // ---------- Import ----------
  function viewImport() {
    const rows = S.importRows;
    let preview = '';
    if (rows) {
      const add = rows.filter(r => r._status === 'New').length;
      preview = `<section class="panel">
        <div class="panel-head"><h2>Check before importing</h2><span class="small muted">${plural(add, 'new company', 'new companies')}, ${rows.length - add} skipped</span></div>
        <div class="table-wrap"><table class="preview"><thead><tr><th>Result</th><th>Company</th><th>Email</th><th>City</th><th>Revit</th><th>Website</th></tr></thead>
        <tbody>${rows.slice(0, 300).map(r => `<tr class="${r._status === 'New' ? '' : 'skip'}"><td>${esc(r._status)}</td>
          <td dir="auto">${esc(r.nameHe || r.nameEn)}</td><td>${esc(r.email || '—')}</td><td dir="auto">${esc(r.city)}</td>
          <td>${esc(r.revitConfidence)}</td><td>${esc(r.website)}</td></tr>`).join('')}</tbody></table></div>
        ${rows.length > 300 ? `<p class="hint">Showing the first 300 rows.</p>` : ''}
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="import-run" ${add ? '' : 'disabled'}>Import ${plural(add, 'company', 'companies')}</button>
          <button class="btn" data-act="import-clear">Start over</button></div>
        <p id="import-progress" class="hint" style="margin-top:8px"></p>
      </section>`;
    }
    return `
      <div class="page-head"><div><h1>Import list</h1><p>Load the CSV from your research. Companies already in the CRM are skipped automatically.</p></div></div>
      <div class="stack">
        <section class="panel">
          <div class="form-grid">
            <label class="field full"><span>CSV file</span><input type="file" accept=".csv,.tsv,.txt,text/csv" data-act-change="import-file"></label>
            <label class="field full"><span>Or paste the CSV text</span><textarea id="import-text" class="tall" dir="ltr" placeholder="&quot;Company Name (English)&quot;,&quot;Company Name (Hebrew)&quot;,..."></textarea></label>
          </div>
          <div class="actions" style="margin-top:10px"><button class="btn" data-act="import-parse">Check pasted text</button></div>
          <p class="hint" style="margin-top:8px">Recognized columns: company name (English/Hebrew), segment, city, website, general email, email source URL, phone, LinkedIn, Revit evidence, evidence URL, Revit confidence, employees, notes. “NOT FOUND” values are left empty.</p>
        </section>
        ${preview}
      </div>`;
  }

  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const sep = firstLine.indexOf('\t') >= 0 && firstLine.indexOf(',') < 0 ? '\t' : ',';
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
  }
  const IMPORT_RULES = [
    ['nameHe', h => /hebrew|עברית/.test(h)],
    ['nameEn', h => /(company|name)/.test(h) && !/contact|named/.test(h)],
    ['sourceUrl', h => /email source|source url/.test(h)],
    ['evidenceUrl', h => /evidence url/.test(h)],
    ['revitEvidence', h => /evidence/.test(h)],
    ['revitConfidence', h => /confidence/.test(h)],
    ['email', h => /e-?mail/.test(h) && !/named|contact|source/.test(h)],
    ['linkedin', h => /linkedin/.test(h)],
    ['website', h => /website|^site$|^url$|domain/.test(h)],
    ['phone', h => /phone|טלפון/.test(h)],
    ['city', h => /city|עיר/.test(h)],
    ['segment', h => /segment|category|type/.test(h)],
    ['employees', h => /employee|size/.test(h)],
    ['notes', h => /note/.test(h)]
  ];
  function mapHeaders(headers) {
    const used = new Set();
    return headers.map(raw => {
      const h = String(raw).toLowerCase().trim();
      for (const [field, test] of IMPORT_RULES) {
        if (!used.has(field) && test(h)) { used.add(field); return field; }
      }
      return '';
    });
  }
  function cleanVal(v) {
    v = String(v == null ? '' : v).trim();
    return /^(not found|n\/a|na|none|unknown|-|—)$/i.test(v) ? '' : v;
  }
  function prepareImport(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('No rows found. The first line must be the column names.');
    const fields = mapHeaders(rows[0]);
    if (fields.indexOf('nameEn') < 0 && fields.indexOf('nameHe') < 0) throw new Error('Couldn’t find a company name column.');
    const domains = new Set(S.companies.map(c => c.domain).filter(Boolean));
    const emails = new Set(S.companies.map(c => String(c.email || '').toLowerCase()).filter(Boolean));
    return rows.slice(1).map(r => {
      const o = {};
      fields.forEach((f, i) => { if (f) o[f] = cleanVal(r[i]); });
      o.email = String(o.email || '').toLowerCase();
      if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) o.email = '';
      const d = domainOf(o.website, /@(gmail|walla|yahoo|hotmail|outlook)\./.test(o.email) ? '' : o.email);
      if (!o.nameEn && !o.nameHe) o._status = 'No name';
      else if ((d && domains.has(d)) || (o.email && emails.has(o.email))) o._status = 'Already in CRM';
      else { o._status = 'New'; if (d) domains.add(d); if (o.email) emails.add(o.email); }
      return o;
    });
  }
  async function runImport() {
    const rows = (S.importRows || []).filter(r => r._status === 'New').map(r => { const o = Object.assign({}, r); delete o._status; return o; });
    const btn = $('[data-act="import-run"]');
    const prog = $('#import-progress');
    if (btn) btn.disabled = true;
    let added = 0, skipped = 0, queued = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      if (prog) prog.textContent = `Importing ${Math.min(i + 50, rows.length)} of ${rows.length}…`;
      try {
        const r = await write('importCompanies', { rows: chunk }, 'Import');
        if (r) { added += r.added || 0; skipped += (r.skipped || []).length; } else queued += chunk.length;
      } catch (e) {
        toast('Import stopped: ' + e.message, 'error');
        break;
      }
    }
    S.importRows = null;
    await refreshAll(true);
    toast(`Imported ${plural(added, 'company', 'companies')}` + (skipped ? `, ${skipped} skipped` : '') + (queued ? `, ${queued} waiting to save` : ''));
    go('#/companies');
  }

  // ---------- Settings ----------
  function viewSettings() {
    const s = S.settings;
    return `
      <div class="page-head"><div><h1>Settings</h1></div></div>
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Sender details</h2></div>
          <div class="form-grid" id="settings-form">
            <label class="field full"><span>Your name (shown as the sender)</span><input name="senderName" dir="auto" value="${esc(s.senderName)}"></label>
            <label class="field full"><span>Postal address (required by law in product emails)</span><input name="senderAddress" dir="auto" value="${esc(s.senderAddress)}"></label>
            <label class="field"><span>Phone (optional)</span><input name="senderPhone" dir="ltr" value="${esc(s.senderPhone)}"></label>
            <label class="field"><span>Daily email limit</span><input name="dailyLimit" type="number" min="1" max="90" value="${esc(s.dailyLimit || 20)}"></label>
            <p class="hint full">The limit counts consent requests and product emails. 10–20 a day keeps Gmail from flagging you as spam. Replies don’t count.</p>
            <label class="field full"><span>Consent request subject</span><input name="consentSubject" dir="auto" value="${esc(s.consentSubject)}"></label>
            <label class="field full"><span>Consent request text</span><textarea name="consentBody" class="tall" dir="rtl">${esc(s.consentBody)}</textarea>
              <span class="hint">Keep it a plain question: no links, no product benefits, no “free”. Placeholders: {company} {sender} {senderEmail}</span></label>
          </div>
          <p class="form-error" id="settings-error"></p>
          <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="save-settings">Save settings</button></div>
        </section>
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>Added to every product email</h2></div>
            <pre class="footer-preview" dir="rtl">${esc(footerText())}</pre>
            <p class="hint" style="margin-top:8px">The subject always starts with “פרסומת:”.</p>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>System</h2></div>
            <dl class="kv">
              <dt>Signed in as</dt><dd>${esc(S.me || S.email)}</dd>
              <dt>Emails last checked</dt><dd>${esc(fmtDateTime(S.lastSync) || 'Not yet')}</dd>
              <dt>Last backup</dt><dd>${esc(fmtDateTime(S.lastBackup) || 'Not yet (runs nightly)')}</dd>
              <dt>Changes waiting</dt><dd>${S.outbox.length} ${S.outbox.length ? '<button class="link-btn" data-act="flush">Save now</button>' : ''}</dd>
              <dt>Website version</dt><dd>${esc(CLIENT_VERSION)}</dd>
              <dt>Backend version</dt><dd>${esc(S.serverVersion || '—')}</dd>
            </dl>
            <div class="actions" style="margin-top:12px"><button class="btn" data-act="reload-all">Reload data</button><button class="btn" data-act="sign-out">Sign out</button></div>
          </section>
        </div>
      </div>`;
  }

  // ============================== modals ==============================
  function openModal(title, bodyHtml, footHtml, opts) {
    closeModal(true);
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"></div>
      <div class="modal ${opts && opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">×</button></div>
        <div class="modal-body">${bodyHtml}<p class="form-error" role="alert"></p></div>
        <div class="modal-foot">${footHtml}</div>
      </div>`;
    root.hidden = false;
    root.dataset.locked = '';
    document.body.classList.add('modal-open');
    const m = $('.modal', root);
    const first = $('input:not([type=hidden]):not([disabled]):not([type=checkbox]):not([type=radio]), textarea:not([readonly]), select', m);
    if (first) setTimeout(() => first.focus(), 30);
    return m;
  }
  function closeModal(force) {
    const root = $('#modal-root');
    if (!force && root.dataset.locked === '1') return;
    root.innerHTML = ''; root.hidden = true; root.dataset.locked = '';
    document.body.classList.remove('modal-open');
  }
  function lockModal(on) { $('#modal-root').dataset.locked = on ? '1' : ''; }
  function formData(m) {
    const o = {};
    $$('[name]', m).forEach(el => {
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.tagName === 'TEXTAREA' ? el.value.replace(/\s+$/, '') : el.value.trim();
    });
    return o;
  }
  function bindSave(m, action, build, doneText) {
    const btn = $('[data-save]', m);
    const err = $('.modal-body > .form-error', m);
    btn.addEventListener('click', async () => {
      err.textContent = '';
      let payload;
      try { payload = build(formData(m)); } catch (e) { err.textContent = e.message; return; }
      btn.disabled = true;
      try {
        const r = await write(action, payload, doneText);
        closeModal(true);
        if (r) toast(doneText);
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
  }
  const field = (label, name, value, extra) =>
    `<label class="field ${extra && extra.full ? 'full' : ''}"><span>${esc(label)}</span>${extra && extra.textarea
      ? `<textarea name="${name}" dir="${(extra && extra.dir) || 'auto'}" ${extra.tall ? 'class="tall"' : ''}>${esc(value)}</textarea>`
      : `<input name="${name}" value="${esc(value)}" dir="${(extra && extra.dir) || 'auto'}" ${extra && extra.type ? `type="${extra.type}"` : ''}>`}</label>`;

  function companyModal(c) {
    c = c || {};
    const m = openModal(c.id ? 'Edit company' : 'Add company', `
      <div class="form-grid">
        ${field('Name (Hebrew)', 'nameHe', c.nameHe)}
        ${field('Name (English)', 'nameEn', c.nameEn, { dir: 'ltr' })}
        ${field('General email', 'email', c.email, { dir: 'ltr', type: 'email' })}
        ${field('Phone', 'phone', c.phone, { dir: 'ltr', type: 'tel' })}
        ${field('Website', 'website', c.website, { dir: 'ltr' })}
        ${field('City', 'city', c.city)}
        ${field('Segment', 'segment', c.segment)}
        <label class="field"><span>Revit confidence</span><select name="revitConfidence">
          ${['', 'High', 'Medium', 'Low'].map(v => `<option value="${v}" ${v === (c.revitConfidence || '') ? 'selected' : ''}>${v || 'Unknown'}</option>`).join('')}</select></label>
        ${field('Employees (approx.)', 'employees', c.employees)}
        ${field('LinkedIn', 'linkedin', c.linkedin, { dir: 'ltr' })}
        ${field('Revit evidence', 'revitEvidence', c.revitEvidence, { full: true })}
        ${field('Evidence page', 'evidenceUrl', c.evidenceUrl, { dir: 'ltr' })}
        ${field('Where the email was found', 'sourceUrl', c.sourceUrl, { dir: 'ltr' })}
        ${field('Notes', 'notes', c.notes, { full: true, textarea: true })}
      </div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>${c.id ? 'Save changes' : 'Add company'}</button>`, { wide: true });
    const btn = $('[data-save]', m);
    const err = $('.modal-body > .form-error', m);
    btn.addEventListener('click', async () => {
      const d = formData(m);
      if (!d.nameHe && !d.nameEn) { err.textContent = 'Enter a company name.'; return; }
      if (c.id) d.id = c.id;
      btn.disabled = true; err.textContent = '';
      try {
        const r = await write('saveCompany', d, c.id ? 'Company saved' : 'Company added');
        closeModal(true);
        if (r) { toast(c.id ? 'Company saved' : 'Company added'); if (!c.id && r.companyId) go('#/company/' + encodeURIComponent(r.companyId)); }
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    });
  }

  function noteModal(companyId) {
    const m = openModal('Add note', `<label class="field"><span>Note</span><textarea name="text" dir="auto"></textarea></label>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>Save note</button>`);
    bindSave(m, 'addNote', d => { if (!d.text) throw new Error('Write a note first.'); return { companyId, text: d.text }; }, 'Note saved');
  }

  function callModal(companyId) {
    const people = S.people.filter(p => p.companyId === companyId);
    const m = openModal('Log call', `
      <div class="radio-row" role="radiogroup" aria-label="Who called">
        <label><input type="radio" name="direction" value="in" checked><span>They called</span></label>
        <label><input type="radio" name="direction" value="out"><span>I called</span></label>
      </div>
      <label class="field"><span>Spoke with</span><input name="withWhom" dir="auto" list="call-people"></label>
      <datalist id="call-people">${people.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
      <label class="field"><span>What was said</span><textarea name="summary" dir="auto"></textarea></label>
      <div class="form-grid">
        ${field('Follow-up to-do (optional)', 'taskText', '')}
        <label class="field"><span>Follow-up date</span><input type="date" name="taskDate"></label>
      </div>
      <p class="hint">If they agreed on the phone to receive information, also use “Change” in the Consent panel and write down when and who.</p>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>Save call</button>`);
    bindSave(m, 'logCall', d => {
      if (!d.summary) throw new Error('Write a short summary of the call.');
      return { companyId, direction: d.direction, withWhom: d.withWhom, summary: d.summary, taskText: d.taskText, taskDate: d.taskDate };
    }, 'Call saved');
  }

  function taskModal(task, companyId) {
    task = task || {};
    const cid = task.companyId || companyId || '';
    const c = cid ? companyById(cid) : null;
    const m = openModal(task.id ? 'Edit to-do' : 'Add to-do', `
      ${c ? `<p class="small muted">For <b dir="auto">${esc(primaryName(c))}</b></p>` : ''}
      <label class="field"><span>What needs to be done</span><input name="text" dir="auto" value="${esc(task.text)}"></label>
      <label class="field"><span>Date (optional)</span><input type="date" name="dueDate" value="${esc(task.dueDate)}"></label>`,
      `${task.id ? '<button class="btn danger" data-act="delete-task" data-id="' + esc(task.id) + '">Delete</button>' : ''}
       <button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>${task.id ? 'Save' : 'Add to-do'}</button>`);
    bindSave(m, 'saveTask', d => {
      if (!d.text) throw new Error('Write what needs to be done.');
      return task.id ? { id: task.id, text: d.text, dueDate: d.dueDate } : { companyId: cid, text: d.text, dueDate: d.dueDate };
    }, 'To-do saved');
  }

  function personModal(companyId, personId) {
    const p = personId ? (S.people.find(x => x.id === personId) || {}) : {};
    const m = openModal(p.id ? 'Edit person' : 'Add person', `
      <div class="form-grid">
        ${field('Name', 'name', p.name)}
        ${field('Role', 'role', p.role)}
        ${field('Email', 'email', p.email, { dir: 'ltr', type: 'email' })}
        ${field('Phone', 'phone', p.phone, { dir: 'ltr', type: 'tel' })}
        ${field('Notes', 'notes', p.notes, { full: true, textarea: true })}
      </div>`,
      `${p.id ? `<button class="btn danger" data-act="delete-person" data-id="${esc(p.id)}">Remove</button>` : ''}
       <button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>${p.id ? 'Save' : 'Add person'}</button>`);
    bindSave(m, 'savePerson', d => {
      if (!d.name) throw new Error('Enter a name.');
      return Object.assign(d, p.id ? { id: p.id } : { companyId });
    }, 'Person saved');
  }

  function consentModal(c) {
    const st = status(c);
    const m = openModal('Change consent status', `
      <p class="small">Use this when something happened outside the CRM, for example they agreed by phone, or a request was marked as sent but never left Gmail.</p>
      <label class="field"><span>New status</span><select name="status">${CONSENT_LIST.map(s => `<option ${s === st ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label class="field"><span>What happened (required for “Yes”, it is your proof)</span><textarea name="note" dir="auto" placeholder="Dana from the office agreed by phone on 3 Nov"></textarea></label>
      ${st === CONSENT.NO || st === CONSENT.UNSUB ? `<div class="notice danger">This company asked not to be contacted.</div>
        <label class="check"><input type="checkbox" name="confirm"><span>I have their new, clear permission.</span></label>` : ''}`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>Save status</button>`);
    bindSave(m, 'setConsent', d => {
      if (d.status === CONSENT.YES && !d.note) throw new Error('Write how they agreed. This is your proof of consent.');
      if ((st === CONSENT.NO || st === CONSENT.UNSUB) && d.status !== st && !d.confirm) throw new Error('Tick the box to confirm you have their new permission.');
      return { companyId: c.id, status: d.status, note: d.note, confirm: !!d.confirm || !(st === CONSENT.NO || st === CONSENT.UNSUB) };
    }, 'Status saved');
  }

  function productModal(p) {
    p = p || { active: 'TRUE' };
    const m = openModal(p.id ? 'Edit product' : 'Add product', `
      <div class="form-grid">
        ${field('Product name', 'name', p.name, { dir: 'ltr' })}
        <label class="field"><span>Order in lists</span><input name="sortOrder" type="number" min="1" value="${esc(p.sortOrder || 10)}"></label>
        ${field('Short description (for you)', 'description', p.description, { full: true })}
        ${field('Website', 'website', p.website, { dir: 'ltr' })}
        ${field('Store / download link', 'storeLink', p.storeLink, { dir: 'ltr' })}
        ${field('Pitch subject (פרסומת: is added automatically)', 'pitchSubject', p.pitchSubject, { full: true })}
        <label class="field full"><span>Pitch email text</span><textarea name="pitchBody" class="tall" dir="rtl">${esc(p.pitchBody)}</textarea>
          <span class="hint">Placeholders: {company} {sender} {product} {link} {store}. Your legal footer is added automatically.</span></label>
        <label class="check full"><input type="checkbox" name="active" ${p.active === 'TRUE' ? 'checked' : ''}><span>Active (can be sent)</span></label>
      </div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>${p.id ? 'Save product' : 'Add product'}</button>`, { wide: true });
    bindSave(m, 'saveProduct', d => {
      if (!d.name) throw new Error('Enter a product name.');
      return Object.assign(d, p.id ? { id: p.id } : {});
    }, 'Product saved');
  }

  // ---------- email composers ----------
  function sendFlow(m, run, doneText) {
    const btn = $('[data-send]', m);
    const box = $('.send-status', m);
    const cancel = $('.modal-foot [data-act="close-modal"]', m);
    const reqId = newReqId(); // one ID per email: a repeat can never create a second email
    const setBox = (cls, html) => { box.className = 'send-status ' + cls; box.innerHTML = html; };
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const payload = run.payload();
      if (!payload) return;
      btn.disabled = true; lockModal(true);
      setBox('working', 'Sending…');
      const r = await sendEmail(run.action, payload, reqId);
      lockModal(false);
      if (r.status === 'sent') {
        setBox('ok', esc(doneText));
        btn.hidden = true; cancel.textContent = 'Close';
        toast(doneText);
        if (run.after) run.after();
      } else if (r.status === 'failed') {
        setBox('error', esc(r.message));
        btn.disabled = false;
        if (r.code === 'CONFIRM_NEEDED' && run.onConfirmNeeded) run.onConfirmNeeded();
      } else {
        showUnknown();
      }
    });
    function showUnknown() {
      btn.disabled = true;
      setBox('unknown', `<b>Not sure if it was sent.</b> The connection dropped before Gmail confirmed. Don’t send again until you check.
        <div class="actions"><button class="btn small" data-check>Check again</button>
        <a class="btn small ghost" target="_blank" rel="noopener" href="${esc(gmailUrl('sent'))}">Open Gmail Sent</a></div>`);
      $('[data-check]', box).addEventListener('click', async () => {
        setBox('working', 'Checking…');
        try {
          const d = await api('checkRequest', { reqId });
          if (d.status === 'done') {
            setBox('ok', esc(doneText)); btn.hidden = true; cancel.textContent = 'Close';
            await refreshAll(true);
          } else if (d.status === 'failed' || d.status === 'none') {
            setBox('error', d.status === 'none' ? 'The server never received it, so nothing was sent. You can send it now.' : 'It was not sent. You can try again.');
            btn.disabled = false;
          } else {
            showUnknown();
            box.insertAdjacentHTML('afterbegin', '<p style="margin:0 0 6px">Still not confirmed. If the email is in Gmail Sent, it was sent.</p>');
          }
        } catch (e) {
          showUnknown();
        }
      });
    }
  }

  function composeConsent(id) {
    const c = companyById(id);
    if (!c) return;
    const s = S.settings;
    const ctx = ctxFor(c, null);
    const m = openModal('Send consent request', `
      <p class="small">To <b dir="ltr">${esc(c.email)}</b> at <b dir="auto">${esc(primaryName(c))}</b></p>
      <div class="mail-preview"><div class="mail-subj" dir="auto">${esc(fill(s.consentSubject, ctx))}</div>
        <pre class="mail-body" dir="rtl">${esc(fill(s.consentBody, ctx))}</pre></div>
      <p class="hint">This is the one request the law allows. After it is sent, the CRM won’t let you send another to this company. You can change the wording in Settings.</p>
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-send>Send request</button>`, { wide: true });
    sendFlow(m, { action: 'sendConsent', payload: () => ({ companyId: c.id }) }, 'Consent request sent');
  }

  function composeProduct(id) {
    const c = companyById(id);
    if (!c) return;
    const prods = activeProducts();
    if (!prods.length) { toast('Add an active product first.', 'warn'); return; }
    const s = S.settings;
    const missing = !s.senderName || !s.senderAddress;
    const recips = [];
    [c.consentFrom, c.email].concat(S.people.filter(p => p.companyId === c.id).map(p => p.email))
      .forEach(e => { e = String(e || '').toLowerCase(); if (e && recips.indexOf(e) < 0) recips.push(e); });
    const p0 = prods[0];
    const m = openModal('Send product email', `
      ${missing ? '<div class="notice danger">Add your name and postal address in <a href="#/settings" data-act="close-modal">Settings</a> first. The law requires them in advertising emails.</div>' : ''}
      <div class="form-grid">
        <label class="field"><span>Product</span><select name="productId">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>To</span><select name="to" dir="ltr">${recips.map(e => `<option>${esc(e)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Subject</span><div class="subject-row" dir="rtl"><span class="prefix">פרסומת:</span><input name="subject" dir="auto"></div></label>
      <label class="field"><span>Email text</span><textarea name="body" class="tall" dir="rtl"></textarea></label>
      <div><span class="small muted">Added automatically at the end</span><pre class="footer-preview" dir="rtl">${esc(footerText())}</pre></div>
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-send ${missing ? 'disabled' : ''}>Send email</button>`, { wide: true });
    const sel = $('[name=productId]', m);
    const fillFor = pid => {
      const p = productById(pid) || p0;
      const ctx = ctxFor(c, p);
      $('[name=subject]', m).value = fill(p.pitchSubject, ctx).replace(/^\s*פרסומת\s*[:\-–]?\s*/, '');
      $('[name=body]', m).value = fill(p.pitchBody, ctx);
    };
    fillFor(p0.id);
    sel.addEventListener('change', () => fillFor(sel.value));
    sendFlow(m, {
      action: 'sendProduct',
      payload: () => {
        const d = formData(m);
        if (!d.subject || !d.body) { $('.send-status', m).className = 'send-status error'; $('.send-status', m).textContent = 'Write a subject and a text.'; return null; }
        if (/\{store\}|\{link\}/.test(d.body)) { $('.send-status', m).className = 'send-status error'; $('.send-status', m).textContent = 'A link is missing. Add it to the product (Products page) or remove the placeholder.'; return null; }
        return { companyId: c.id, productId: d.productId, to: d.to, subject: d.subject, body: d.body };
      }
    }, 'Product email sent');
  }

  function composeReply(threadId, companyId) {
    const c = companyById(companyId) || (S.bundle && S.bundle.company);
    const acts = (S.bundle && S.bundle.company.id === companyId ? S.bundle.activities : S.unread).filter(a => a.threadId === threadId);
    const last = acts.filter(a => a.type === 'email_in').sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || acts[0] || {};
    const isBlocked = c && blocked(c);
    const m = openModal('Reply', `
      <p class="small">To <b dir="ltr">${esc(last.fromAddr || '')}</b></p>
      <p class="small muted" dir="auto">Re: ${esc(String(last.subject || '').replace(/^(re:\s*)+/i, ''))}</p>
      ${last.body ? `<div class="proof" dir="auto" style="border-left-color:var(--accent)">${esc(String(last.body).slice(0, 600))}</div>` : ''}
      ${isBlocked ? `<div class="notice danger">This company asked not to be contacted. Only reply to answer them, for example to confirm they were removed.</div>
        <label class="check"><input type="checkbox" name="confirm"><span>This reply has no advertising.</span></label>` : ''}
      <label class="field"><span>Your reply</span><textarea name="body" class="tall" dir="rtl"></textarea></label>
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-send>Send reply</button>`, { wide: true });
    sendFlow(m, {
      action: 'sendReply',
      payload: () => {
        const d = formData(m);
        const box = $('.send-status', m);
        if (!d.body) { box.className = 'send-status error'; box.textContent = 'Write your reply first.'; return null; }
        if (isBlocked && !d.confirm) { box.className = 'send-status error'; box.textContent = 'Tick the box to confirm the reply has no advertising.'; return null; }
        return { threadId, body: d.body, confirm: !!d.confirm };
      }
    }, 'Reply sent');
  }

  // ============================== global search ==============================
  function runSearch(q) {
    const box = $('#search-results');
    q = q.trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; return; }
    const digits = phoneDigits(q);
    const hits = S.companies.filter(c => matchesQuery(c, q, digits)).slice(0, 12);
    box.hidden = false;
    box.innerHTML = hits.length ? hits.map(c => `<a href="#/company/${encodeURIComponent(c.id)}"><span dir="auto">${esc(primaryName(c))}</span>
        <span class="sr-sub">${esc([c.city, c.phone, c.email].filter(Boolean).join(' · '))} ${isArchived(c) ? '(archived)' : ''}</span></a>`).join('')
      : `<div class="sr-empty">No company found. <button class="link-btn" data-act="new-company">Add company</button></div>`;
  }
  function closeSearch() {
    const box = $('#search-results');
    if (box) box.hidden = true;
  }

  // ============================== toasts ==============================
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
  }

  // ============================== events ==============================
  const ACTS = {
    'close-modal': () => closeModal(),
    'sign-out': () => signOut(),
    'check-replies': async (el) => {
      el.disabled = true;
      try {
        const r = await write('checkReplies', {}, 'Check replies');
        if (r) { const n = (r.sync && r.sync.incoming) || 0; toast(n ? `${plural(n, 'new reply', 'new replies')}` : 'No new replies'); }
      } catch (e) { toast(e.message, 'error'); }
      el.disabled = false;
    },
    'filter-status': (el, ev) => { ev.preventDefault(); Object.assign(S.filters, { status: el.dataset.status, q: '', archived: false }); go('#/companies'); },
    'new-company': () => { closeSearch(); companyModal(); },
    'edit-company': el => companyModal(companyById(el.dataset.id)),
    'archive': async el => {
      const archiving = !!el.dataset.archived;
      if (archiving && !confirm('Archive this company? It will be hidden from lists. Its history and consent status are kept.')) return;
      try { await write('archiveCompany', { companyId: el.dataset.id, archived: archiving }, archiving ? 'Archived' : 'Restored'); } catch (e) { toast(e.message, 'error'); }
    },
    'add-note': el => noteModal(el.dataset.id),
    'log-call': el => callModal(el.dataset.id),
    'new-task': el => taskModal(null, el.dataset.company),
    'edit-task': el => taskModal(findTask(el.dataset.id)),
    'delete-task': async el => {
      if (!confirm('Delete this to-do?')) return;
      try { await write('deleteTask', { id: el.dataset.id }, 'To-do deleted'); closeModal(true); } catch (e) { toast(e.message, 'error'); }
    },
    'task-done': async el => {
      el.disabled = true;
      try { const r = await write('saveTask', { id: el.dataset.id, done: true }, 'To-do done'); if (r) toast('Done'); } catch (e) { toast(e.message, 'error'); el.disabled = false; }
    },
    'person': el => personModal(el.dataset.company, el.dataset.id),
    'delete-person': async el => {
      if (!confirm('Remove this person?')) return;
      try { await write('deletePerson', { id: el.dataset.id }, 'Person removed'); closeModal(true); } catch (e) { toast(e.message, 'error'); }
    },
    'change-consent': el => consentModal(companyById(el.dataset.id)),
    'review': async el => {
      const box = el.closest('.actions');
      $$('button', box).forEach(b => { b.disabled = true; });
      const labels = { yes: 'Marked as agreed', no: 'Marked as said no', unsub: 'Removed. No more emails will be sent', read: 'Marked as read' };
      try {
        const r = await write('reviewReply', { activityId: el.dataset.id, decision: el.dataset.decision }, labels[el.dataset.decision]);
        if (r) toast(labels[el.dataset.decision]);
      } catch (e) { toast(e.message, 'error'); $$('button', box).forEach(b => { b.disabled = false; }); }
    },
    'compose-consent': el => composeConsent(el.dataset.id),
    'compose-product': el => composeProduct(el.dataset.id),
    'compose-reply': el => composeReply(el.dataset.thread, el.dataset.company),
    'edit-product': el => productModal(el.dataset.id ? productById(el.dataset.id) : null),
    'save-settings': async el => {
      const d = formData($('#settings-form'));
      const err = $('#settings-error');
      err.textContent = '';
      el.disabled = true;
      try { const r = await write('saveSettings', d, 'Settings saved'); if (r) toast('Settings saved'); } catch (e) { err.textContent = e.message; }
      el.disabled = false;
    },
    'expand': el => { const body = el.previousElementSibling; body.classList.remove('clamp'); el.remove(); },
    'import-parse': () => {
      try { S.importRows = prepareImport($('#import-text').value); render(); } catch (e) { toast(e.message, 'error'); }
    },
    'import-run': () => runImport(),
    'import-clear': () => { S.importRows = null; render(); },
    'flush': () => flushOutbox(),
    'reload-all': async () => { try { await refreshAll(); toast('Data reloaded'); } catch (e) { toast(e.message, 'error'); } },
    'reload-company': () => { const r = route(); if (r.id) loadCompany(r.id); },
    'retry-start': () => startApp()
  };
  function findTask(id) {
    return S.tasks.find(t => t.id === id) || (S.bundle ? S.bundle.tasks.find(t => t.id === id) : null);
  }

  function bindGlobal() {
    document.addEventListener('click', ev => {
      const el = ev.target.closest('[data-act]');
      if (el && ACTS[el.dataset.act]) {
        if (el.tagName === 'BUTTON') ev.preventDefault();
        ACTS[el.dataset.act](el, ev);
      }
      if (!ev.target.closest('.search-wrap')) closeSearch();
    });
    document.addEventListener('change', async ev => {
      const el = ev.target;
      if (el.dataset.filter) {
        S.filters[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
        const box = $('#co-results'); if (box) box.innerHTML = companyListHtml();
        return;
      }
      if (el.dataset.actChange === 'product-status') {
        el.disabled = true;
        try { await write('setProductStatus', { companyId: el.dataset.company, productId: el.dataset.product, status: el.value }, 'Product status saved'); }
        catch (e) { toast(e.message, 'error'); }
        el.disabled = false;
      }
      if (el.dataset.actChange === 'import-file' && el.files && el.files[0]) {
        try { const text = await el.files[0].text(); S.importRows = prepareImport(text); render(); }
        catch (e) { toast(e.message, 'error'); }
      }
    });
    document.addEventListener('input', ev => {
      const el = ev.target;
      if (el.dataset.filter === 'q') {
        S.filters.q = el.value;
        const box = $('#co-results'); if (box) box.innerHTML = companyListHtml();
      }
      if (el.id === 'global-search') runSearch(el.value);
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { closeSearch(); if (!$('#modal-root').hidden) closeModal(); }
      if (ev.key === 'Enter' && ev.target.id === 'global-search') {
        const first = $('#search-results a'); if (first) { location.hash = first.getAttribute('href'); $('#global-search').value = ''; }
      }
    });
    window.addEventListener('hashchange', () => { onRoute(); const s = $('#global-search'); if (s) s.value = ''; });
    window.addEventListener('online', () => { updateSyncPill(); flushOutbox(); });
    window.addEventListener('offline', updateSyncPill);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.loaded && Date.now() - S.lastRefresh > 2 * 60 * 1000 && $('#modal-root').hidden) {
        refreshAll(true); flushOutbox();
      }
    });
    window.addEventListener('beforeunload', ev => {
      if (S.busy > 0) { ev.preventDefault(); ev.returnValue = ''; }
    });
    setInterval(() => { if (S.outbox.length) flushOutbox(); }, 30 * 1000);
    setInterval(() => {
      if (document.visibilityState === 'visible' && S.loaded && $('#modal-root').hidden && !S.busy) refreshAll(true);
    }, 5 * 60 * 1000);
    setInterval(() => {
      if (S.token && gisReady && S.tokenExp - Date.now() < 10 * 60 * 1000) { try { google.accounts.id.prompt(); } catch (e) { /* ignore */ } }
    }, 4 * 60 * 1000);
  }

  // ============================== start ==============================
  function configOk() {
    const bad = v => !v || String(v).indexOf('PASTE_') === 0;
    return !bad(CFG.BACKEND_URL) && !bad(CFG.GOOGLE_CLIENT_ID);
  }
  async function startApp() {
    $('#app').hidden = false;
    $('#signin').hidden = true;
    $('#view').innerHTML = '<div class="loading">Loading your CRM…</div>';
    try {
      await refreshAll();
      onRoute();
      flushOutbox();
    } catch (e) {
      if (e.code === 'AUTH' || e.code === 'FORBIDDEN') return;
      $('#view').innerHTML = errorBox(e.code === 'CONFIG' ? e.message : 'Couldn’t load the CRM: ' + e.message, 'retry-start');
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!configOk()) {
      document.body.innerHTML = `<div class="sys"><h1>Almost there</h1>
        <p>Open <code>config.js</code> and paste your <code>BACKEND_URL</code> and <code>GOOGLE_CLIENT_ID</code> (SETUP.md steps 3 and 6). Then upload it to GitHub again.</p></div>`;
      return;
    }
    loadOutbox();
    bindGlobal();
    loadToken();
    initGis();
    if (tokenValid()) startApp(); else showSignin();
  });
})();
