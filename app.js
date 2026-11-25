/* ClickCRM frontend. Static site (GitHub Pages) that talks to the Apps Script backend. */
(function () {
  'use strict';

  const CLIENT_VERSION = '1.10.5';
  const CFG = window.CLICKCRM_CONFIG || {};
  const LS_TOKEN = 'clickcrm.token';
  const LS_OUTBOX = 'clickcrm.outbox';
  const LS_COUNTRY = 'clickcrm.country';
  const US_TZ_NAMES = { 'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Indiana/Indianapolis': 'Eastern',
    'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Boise': 'Mountain', 'America/Phoenix': 'Arizona',
    'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii', 'America/Puerto_Rico': 'Atlantic' };
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
    filters: { q: '', status: '', segment: '', product: '', conf: '', email: '', archived: false, sort: 'name' },
    importRows: null,
    country: 'IL'
  };
  try { const v = localStorage.getItem(LS_COUNTRY); if (v === 'US' || v === 'OT') S.country = v; } catch (e) { /* ignore */ }
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
  function badge(st, us) { return `<span class="badge ${stClass(st)}">${esc(stLabel(st, us))}</span>`; }
  function badgeFor(c) { return badge(status(c), isUs(c)); }
  // ---- countries ----
  // Groups: IL = Israel, US = USA, OT = other countries (stored as a 2-letter code, e.g. AR). US and OT get the English email.
  const OTHER_COUNTRIES = { AR: 'Argentina', GT: 'Guatemala', PY: 'Paraguay', PG: 'Papua New Guinea', FJ: 'Fiji', PW: 'Palau',
    CA: 'Canada', MX: 'Mexico', BR: 'Brazil', CL: 'Chile', CO: 'Colombia', PE: 'Peru', UY: 'Uruguay', CR: 'Costa Rica', PA: 'Panama',
    EC: 'Ecuador', BO: 'Bolivia', HN: 'Honduras', SV: 'El Salvador', NI: 'Nicaragua', DO: 'Dominican Republic', GB: 'United Kingdom',
    IE: 'Ireland', AU: 'Australia', NZ: 'New Zealand', ZA: 'South Africa', IN: 'India', SG: 'Singapore', PH: 'Philippines',
    AE: 'United Arab Emirates', WS: 'Samoa', TO: 'Tonga', VU: 'Vanuatu', SB: 'Solomon Islands', OT: 'Other country' };
  function countryCode(c) {
    const t = String((c && c.country) || '').trim().toUpperCase();
    if (!t || t === 'IL' || t === 'ISRAEL') return 'IL';
    if (/^(US|USA|UNITED STATES)$/.test(t)) return 'US';
    if (OTHER_COUNTRIES[t]) return t;
    const k = Object.keys(OTHER_COUNTRIES).find(x => OTHER_COUNTRIES[x].toUpperCase() === t);
    return k || 'OT';
  }
  function countryOf(c) { const k = countryCode(c); return k === 'IL' || k === 'US' ? k : 'OT'; }
  function countryName(c) { const k = countryCode(c); return k === 'IL' ? 'Israel' : k === 'US' ? 'USA' : OTHER_COUNTRIES[k]; }
  function groupName(g) { return g === 'US' ? 'USA' : g === 'OT' ? 'Other countries' : 'Israel'; }
  /** English group: USA and other countries (one English email, no consent request). */
  function isUs(c) { return countryOf(c) !== 'IL'; }
  function inCountry(c) { return countryOf(c) === S.country; }
  /** The same statuses, named for what they mean in the US (no consent step there). */
  function stLabel(st, us) {
    if (!us) return st;
    return { [CONSENT.SENT]: 'Emailed', [CONSENT.YES]: 'Interested' }[st] || st;
  }
  function usLocalTime(c) {
    const tz = c.timezone || 'America/New_York';
    try {
      const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date());
      return t + ' ' + (c.timezone ? (US_TZ_NAMES[tz] || tz) : 'Eastern (state unknown)');
    } catch (e) { return ''; }
  }
  function usOpenNow(c) {
    const at = (tz, from, to) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
      const wd = (parts.find(p => p.type === 'weekday') || {}).value;
      const hr = Number((parts.find(p => p.type === 'hour') || {}).value);
      return ['Mon', 'Tue', 'Wed', 'Thu'].indexOf(wd) >= 0 && hr >= from && hr < to;
    };
    return c.timezone ? at(c.timezone, 9, 16) : (at('America/New_York', 12, 16) && at('America/Los_Angeles', 9, 13));
  }
  function usFooterText(signed) {
    const s = S.settings;
    return ['--', signed ? null : (s.senderNameEn || '(your name in English)'), s.senderAddressEn || '(your postal address in English)',
      [S.me, s.senderPhone].filter(Boolean).join(' | '), '',
      'This is a one-time promotional email about a Revit add-in.',
      'If you\'d rather not hear from me, reply "unsubscribe" and I won\'t write again.'].filter(l => l !== null).join('\n');
  }
  function syncCountryButtons() {
    $$('[data-act="set-country"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.country === S.country ? 'true' : 'false'));
    document.body.classList.toggle('country-us', S.country !== 'IL');
  }
  function confHtml(v) { return v ? `<span class="conf ${esc(v)}"><i></i>${esc(v)}</span>` : '<span class="conf"><i></i>Unknown</span>'; }
  function isArchived(c) { return c.archived === 'TRUE'; }
  function companyById(id) { return S.companies.find(c => c.id === id) || (S.bundle && S.bundle.company.id === id ? S.bundle.company : null); }
  function productById(id) { return S.products.find(p => p.id === id); }
  function activeProducts() { return S.products.filter(p => p.active === 'TRUE'); }
  function blocked(c) { const st = status(c); return st === CONSENT.NO || st === CONSENT.UNSUB; }
  function ctxFor(c, p) {
    const us = c && isUs(c);
    return {
      company: c ? (us ? (c.nameEn || c.nameHe || '') : (c.nameHe || c.nameEn || '')) : '',
      sender: (us ? S.settings.senderNameEn : S.settings.senderName) || S.settings.senderName || '', senderEmail: S.me || '',
      product: p ? p.name : '', link: p ? p.website : '', store: p ? p.storeLink : ''
    };
  }
  function footerText(signed) {
    const s = S.settings;
    const contact = [S.me, s.senderPhone].filter(Boolean).join(' | ');
    return ['--', signed ? null : (s.senderName || ''), s.senderAddress || '', contact, '',
      'קיבלתם הודעה זו כי הסכמתם לקבל ממני מידע.', 'להסרה, השיבו להודעה זו עם המילה "הסר".'].filter(l => l !== null).join('\n');
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
  async function sendEmail(action, payload, reqId, timeout) {
    if (!tokenValid()) { showSignin('Sign in again, then press Send.'); return { status: 'failed', message: 'Sign in again, then press Send.' }; }
    S.busy++; updateSyncPill();
    try {
      const data = await api(action, payload, { reqId, timeout: timeout || 120000 });
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
    S.autoToday = b.autoToday || 0;
    S.bouncesToday = b.bouncesToday || 0;
    S.autoProductToday = b.autoProductToday || 0;
    S.usToday = b.usToday || 0;
    S.lastSync = b.lastSync || '';
    S.lastBackup = b.lastBackup || '';
    S.inbox = b.inbox || {};
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
    // Keep what the user is typing when the screen redraws itself (auto refresh, saving another panel).
    const hash = location.hash;
    const dirty = [];
    if (S.lastRenderHash === hash && !S.freshForm) {
      view.querySelectorAll('input, textarea, select').forEach(el => {
        const key = el.id || (el.name ? (el.closest('form') ? (el.closest('form').id || '') : '') + ':' + el.name : '');
        if (!key || el.type === 'file') return;
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked !== el.defaultChecked) dirty.push({ key, checked: el.checked, val: el.value }); }
        else if (el.tagName === 'SELECT') { const d = [...el.options].find(o => o.defaultSelected); if (el.value !== (d ? d.value : (el.options[0] || {}).value)) dirty.push({ key, val: el.value }); }
        else if (el.value !== el.defaultValue) dirty.push({ key, val: el.value });
      });
    }
    S.freshForm = false;
    S.lastRenderHash = hash;
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
    if (dirty.length) {
      view.querySelectorAll('input, textarea, select').forEach(el => {
        const key = el.id || (el.name ? (el.closest('form') ? (el.closest('form').id || '') : '') + ':' + el.name : '');
        const d = dirty.find(x => x.key === key && (x.checked === undefined || x.val === el.value));
        if (!d) return;
        if (d.checked !== undefined) el.checked = d.checked; else el.value = d.val;
      });
    }
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text field */ } }
    }
    updateSyncPill();
    syncCountryButtons();
    applyTranslation();
  }

  // ---- Translate to English (toggle in the top bar) ----
  const LS_TR = 'clickcrm.translate';
  const trCache = new Map();
  let trOn = false;
  try { trOn = localStorage.getItem(LS_TR) === '1'; } catch (e) { /* ignore */ }
  const NON_EN = /[֐-׿Ѐ-ӿ]/;
  function syncTrButton() {
    const b = $('#tr-toggle'); if (!b) return;
    b.setAttribute('aria-pressed', trOn ? 'true' : 'false');
    b.textContent = 'EN';
    b.title = trOn ? 'English translation is on (click to show the original)' : 'Show Hebrew and Russian messages in English';
  }
  async function applyTranslation() {
    syncTrButton();
    if (!trOn) return;
    const els = $$('#view .act-body, #view .reply-text, #view .proof, #view .mail-body, #view .task-body > div')
      .filter(el => !el.dataset.orig && NON_EN.test(el.textContent));
    const need = [...new Set(els.map(el => el.textContent.trim()).filter(t => !trCache.has(t)))];
    for (let i = 0; i < need.length; i += 20) {
      const chunk = need.slice(i, i + 20);
      try {
        const r = await api('translate', { texts: chunk });
        chunk.forEach((t, k) => trCache.set(t, (r.texts && r.texts[k]) || t));
      } catch (e) { toast('Translation failed: ' + e.message, 'error'); trOn = false; syncTrButton(); return; }
    }
    if (!trOn) return;
    els.forEach(el => {
      const t = el.textContent.trim();
      if (!trCache.has(t) || !el.isConnected || el.dataset.orig) return;
      el.dataset.orig = el.textContent;
      el.textContent = trCache.get(t);
      el.setAttribute('dir', 'ltr');
      el.title = 'Original: ' + t.slice(0, 300);
    });
  }
  function toggleTranslate() {
    trOn = !trOn;
    try { localStorage.setItem(LS_TR, trOn ? '1' : '0'); } catch (e) { /* ignore */ }
    render();
  }

  function errorBox(msg, act) {
    return `<div class="panel"><p>${esc(msg)}</p><button class="btn" data-act="${esc(act)}">Try again</button></div>`;
  }

  // ---------- Today ----------
  function viewToday() {
    const today = todayYmd();
    const soonEnd = addDaysYmd(today, 7);
    const limit = Number(S.settings.dailyLimit || 20);
    const us = S.country !== 'IL';
    const here = a => { const c = companyById(a.companyId); return c ? inCountry(c) : S.country === 'IL'; };
    const unread = S.unread.filter(here).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const tasks = S.tasks.filter(t => !t.companyId || here(t));
    const todo = tasks.filter(t => !t.dueDate || t.dueDate <= today).sort(byDue);
    const soon = tasks.filter(t => t.dueDate && t.dueDate > today && t.dueDate <= soonEnd).sort(byDue);
    const live = S.companies.filter(c => !isArchived(c) && inCountry(c));
    const withPerson = new Set(S.people.filter(p => p.email && p.deleted !== 'TRUE').map(p => p.companyId));
    const readyAll = live.filter(c => status(c) === CONSENT.NONE && (c.email || (us && withPerson.has(c.id))));
    const ready = readyAll.slice().sort(byConfidence).slice(0, 8);
    const counts = {};
    CONSENT_LIST.forEach(s => { counts[s] = 0; });
    live.forEach(c => { counts[status(c)] = (counts[status(c)] || 0) + 1; });
    const pct = Math.min(100, Math.round((S.sentToday / limit) * 100));

    return `
      <div class="page-head">
        <div><h1>Today <span class="country-tag">${groupName(S.country)}</span></h1><p>${esc(dFmt.format(new Date()))}</p></div>
        <div class="actions"><button class="btn" data-act="new-task">Add to-do</button><button class="btn" data-act="new-company">Add company</button></div>
      </div>
      <div class="today-grid">
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><h2>New replies<span class="count">${unread.length || ''}</span></h2></div>
            ${unread.length ? unread.map(replyCard).join('') : '<p class="empty">No new replies. Use “Check replies” at the top to look again.</p>'}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>${us ? 'Ready to email' : 'Ready to contact'}<span class="count">${readyAll.length || ''}</span></h2>
              <div class="actions"><a href="#/companies" data-act="filter-status" data-status="${esc(CONSENT.NONE)}" class="small">See all</a>
              ${readyAll.length && !us ? '<button class="btn small primary" data-act="batch">Send batch now</button>' : ''}</div></div>
            <div class="meter"><span>Sent today (all countries together): ${S.sentToday} of ${limit}</span><span class="meter-bar"><i style="width:${pct}%"></i></span></div>
            ${us ? autoUsLine() : autoLine() + autoProductLine()}
            ${ready.length ? ready.map(c => `
              <div class="ready-row">
                <div class="grow"><a href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>
                  <div class="small muted">${esc((us ? [c.city, c.state, usLocalTime(c)] : [c.city, c.segment]).filter(Boolean).join(', '))}</div></div>
                ${confHtml(c.revitConfidence)}
                ${us ? `<button class="btn small" data-act="compose-us" data-id="${esc(c.id)}">Send email</button>`
                  : `<button class="btn small" data-act="compose-consent" data-id="${esc(c.id)}">Send request</button>`}
              </div>`).join('') : (live.length
                ? '<p class="empty">Everyone with an email address has been contacted. Import more companies to continue.</p>'
                : `<p class="empty">No ${S.country === 'IL' ? '' : groupName(S.country) + ' '}companies yet. <a href="#/import">Import your list</a> to start.</p>`)}
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
              ${CONSENT_LIST.map(s => `<button data-act="filter-status" data-status="${esc(s)}"><b>${counts[s] || 0}</b><span>${esc(stLabel(s, us))}</span></button>`).join('')}
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

  function isShabbat() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const wd = (parts.find(p => p.type === 'weekday') || {}).value;
    const hr = Number((parts.find(p => p.type === 'hour') || {}).value);
    return wd === 'Sat' || (wd === 'Fri' && hr >= 12);
  }
  function batchCandidates() {
    const conf = S.settings.autoConfidence || 'High,Medium';
    const allowed = conf === 'High' ? ['High'] : conf === 'All' ? null : ['High', 'Medium'];
    return S.companies.filter(c => !isArchived(c) && !isUs(c) && status(c) === CONSENT.NONE && c.email &&
      (!allowed || allowed.indexOf(c.revitConfidence) >= 0));
  }

  function productQueue(pid) {
    const unreadCo = new Set(S.unread.filter(a => a.type === 'email_in').map(a => a.companyId));
    const ready = [], manual = [];
    S.companies.forEach(c => {
      if (isArchived(c) || isUs(c) || status(c) !== CONSENT.YES) return;
      if ((c.productStatus || {})[pid] || unreadCo.has(c.id)) return;
      ready.push(c); // the server sends to the chosen people ("Gets emails") or the company address
    });
    return { ready, manual };
  }

  function autoLine() {
    const s = S.settings;
    if (s.autoPausedReason) return `<p class="notice danger small">${esc(s.autoPausedReason)} <a href="#/settings">Settings</a></p>`;
    if (s.autoSend === 'TRUE') {
      return `<p class="notice calm small">Automatic sending is on: ${S.autoToday} of ${esc(s.autoPerDay)} sent today. It runs Sunday–Thursday, 08:00–17:00. <a href="#/settings">Change</a></p>`;
    }
    return `<p class="small muted">Automatic sending is off. <a href="#/settings">Turn it on in Settings</a>.</p>`;
  }
  function autoUsLine() {
    const s = S.settings;
    if (s.usPausedReason && s.usAuto !== 'TRUE') return `<p class="notice danger small">${esc(s.usPausedReason)} <a href="#/settings">Settings</a></p>`;
    if (s.usAuto === 'TRUE') {
      return `<p class="notice calm small">Automatic US emails are on: ${S.usToday || 0} of ${esc(s.usPerDay || 15)} sent today. Each company gets one email, Monday–Thursday 9:00–16:00 in its own time zone (on Israel time: about 16:00 until 02:00), at least 30 minutes apart. Never on Friday or Shabbat. <a href="#/settings">Change</a></p>`;
    }
    return `<p class="small muted">Automatic US emails are off. <a href="#/settings">Turn them on in Settings</a>.</p>`;
  }
  function autoProductLine() {
    const s = S.settings;
    if (s.autoProduct !== 'TRUE') return '';
    const p = productById(s.autoProductId);
    const q = productQueue(s.autoProductId);
    return `<p class="notice calm small">Automatic ${esc(p ? p.name : 'product')} emails are on: ${S.autoProductToday || 0} sent today, ${q.ready.length} waiting${q.manual.length ? `, ${q.manual.length} for you to send by hand` : ''}. <a href="#/settings">Change</a></p>`;
  }

  function replyCard(a) {
    const c = companyById(a.companyId) || { id: a.companyId, nameEn: a.companyName };
    return `
      <article class="reply ${a.kind === 'bounce' ? 'is-bounce' : ''}">
        <div class="reply-head"><a class="reply-co" href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>
          ${badgeFor(c)}<time>${esc(fmtDateTime(a.date))}</time></div>
        ${a.kind === 'bounce' ? bounceCard(a, c) : `
        ${sentSummary(a.sent, false, c)}
        <div class="reply-mail">${mailView(a)}</div>
        ${peopleBox(a, c)}
        ${reviewButtons(a, c)}`}
      </article>`;
  }
  /** A bounce, short: which address, why, the buttons; the full message folded. */
  function bounceInfo(a) {
    const text = String(a.fullBody || a.body || '');
    const me = String(S.me || '').toLowerCase();
    const addr = (text.match(/[A-Za-z0-9][\w.+-]*@[\w-]+(?:\.[\w-]+)+/g) || [])
      .map(x => x.toLowerCase()).find(x => x !== me && !/^(mailer-daemon|postmaster|microsoftexchange[0-9a-f]+)@|@googlemail\.com$|@google\.com$/.test(x)) || '';
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
    const why = lines.find(l => /not found|doesn.t exist|does not exist|no such user|unknown user|user unknown|invalid|rejected|blocked|quota|mailbox (is )?full|over quota|inactive|disabled|unable to receive|couldn.t be delivered|wasn.t delivered|not delivered|5\.\d\.\d|4\.\d\.\d/i.test(l)) || lines[0] || '';
    const soft = /quota|full|temporar|try again|delay|4\.\d\.\d/i.test(text) && !/5\.1\.1|not found|does not exist|no such user/i.test(text);
    const blocked = !soft && /message blocked|blocked|spam|policy|reputation/i.test(text) && !/address not found|does not exist|no such user|5\.1\.1/i.test(text);
    let plain = why.replace(/^\*+\s*|\s*\*+$/g, '');
    if (/^Status:\s*4\./i.test(plain)) plain = 'Delayed: their mail server did not answer (' + plain.replace(/^Status:\s*/i, '') + ')';
    return { addr, why: plain.slice(0, 220), soft, blocked };
  }
  function bounceCard(a, c) {
    const b = bounceInfo(a);
    return `<div class="bounce-box">
        <div><b>Email bounced</b>${b.addr ? ` · <span dir="ltr" class="addr">${esc(b.addr)}</span>` : ''}</div>
        ${b.why ? `<div class="small muted" dir="auto">${esc(b.why)}</div>` : ''}
        ${b.soft ? '<div class="small">Looks temporary (mailbox full or delayed). The address is probably fine: just mark it as read.</div>' : ''}
        ${b.blocked ? '<div class="small">Their server blocked the email (a spam filter). The address is probably fine, so “Bad address” is not needed: mark it as read.</div>' : ''}
      </div>
      ${reviewButtons(a, c)}
      <details class="bounce-full"><summary class="small">Show the full bounce message</summary><div class="reply-mail">${mailView(a)}</div></details>`;
  }
  function reviewButtons(a, c) {
    if (a.kind === 'bounce') {
      return `<p class="reply-hint small">“Bad address” removes the address (kept in the notes) and sets the company back to “Not contacted”.</p>
        <div class="actions"><button class="btn small primary" data-act="bounced" data-id="${esc(a.id)}">Bad address</button>
        <a class="btn small" href="#/company/${encodeURIComponent(c.id)}">Open company</a>
        <button class="btn small ghost" data-act="review" data-id="${esc(a.id)}" data-decision="read">Mark as read</button></div>`;
    }
    if (a.kind === 'auto_reply') {
      return `<p class="reply-hint small">This looks like an automatic reply (out of office or similar). If it is a real answer, use the buttons below.</p>
        <div class="actions"><button class="btn small primary" data-act="review" data-id="${esc(a.id)}" data-decision="read">Mark as read</button>
        <button class="btn small" data-act="review" data-id="${esc(a.id)}" data-decision="unsub">Remove them</button>
        <a class="btn small" href="#/company/${encodeURIComponent(c.id)}">Open company</a>
        <button class="btn small ghost" data-act="compose-reply" data-thread="${esc(a.threadId)}" data-company="${esc(c.id)}">Reply</button></div>`;
    }
    const sug = a.suggest || '';
    const hint = { yes: 'This looks like a yes.', no: 'This looks like a no.', unsub: 'This looks like a removal request.' }[sug];
    const b = (decision, text) => `<button class="btn small ${sug === decision ? 'suggested' : ''}" data-act="review" data-id="${esc(a.id)}" data-decision="${decision}">${text}</button>`;
    const reply = `<button class="btn small ghost" data-act="compose-reply" data-thread="${esc(a.threadId)}" data-company="${esc(c.id)}">Reply</button>`;
    if (status(c) === CONSENT.SENT && isUs(c)) {
      const h = { yes: 'This looks interested.', no: 'This looks like a no.', unsub: 'This looks like an unsubscribe request.' }[sug];
      return `${h ? `<p class="reply-hint">${h} Please confirm.</p>` : ''}
        <div class="actions">${b('yes', 'Interested')}${b('no', 'Not interested')}${b('unsub', 'Unsubscribe them')}${b('read', 'Just mark as read')}${reply}</div>`;
    }
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
    let list = S.companies.filter(c => inCountry(c) && (f.archived ? isArchived(c) : !isArchived(c)));
    if (f.status) list = list.filter(c => status(c) === f.status);
    if (f.segment) list = list.filter(c => (c.segment || '') === f.segment);
    if (f.conf) list = list.filter(c => (c.revitConfidence || '') === (f.conf === 'none' ? '' : f.conf));
    if (f.product) list = list.filter(c => c.productStatus && c.productStatus[f.product]);
    if (f.email === 'missing') list = list.filter(c => !c.email);
    if (f.email === 'has') list = list.filter(c => c.email);
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
    const segments = Array.from(new Set(S.companies.filter(inCountry).map(c => c.segment).filter(Boolean))).sort();
    const us = S.country !== 'IL';
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return `
      <div class="page-head">
        <div><h1>Companies <span class="country-tag">${groupName(S.country)}</span></h1></div>
        <div class="actions"><a class="btn" href="#/import">Import list</a><button class="btn primary" data-act="new-company">Add company</button></div>
      </div>
      <div class="filters">
        <input type="search" id="co-q" data-filter="q" value="${esc(f.q)}" placeholder="Search name, email, city or phone" dir="auto" aria-label="Search companies">
        <select data-filter="status" aria-label="Status">${opt('', 'Any status', f.status)}${CONSENT_LIST.map(s => opt(s, stLabel(s, us), f.status)).join('')}</select>
        <select data-filter="segment" aria-label="Segment">${opt('', 'Any segment', f.segment)}${segments.map(s => opt(s, s, f.segment)).join('')}</select>
        <select data-filter="conf" aria-label="Revit confidence">${opt('', 'Any Revit confidence', f.conf)}${['High', 'Medium', 'Low'].map(s => opt(s, s, f.conf)).join('')}${opt('none', 'Unknown', f.conf)}</select>
        <select data-filter="product" aria-label="Product">${opt('', 'Any product', f.product)}${S.products.map(p => opt(p.id, 'Has ' + p.name + ' status', f.product)).join('')}</select>
        <select data-filter="email" aria-label="Email">${opt('', 'Any email', f.email)}${opt('has', 'Has email', f.email)}${opt('missing', 'No email (find one)', f.email)}</select>
        <select data-filter="sort" aria-label="Sort">${opt('name', 'Sort by name', f.sort)}${opt('updated', 'Recently updated', f.sort)}${opt('confidence', 'Revit confidence', f.sort)}</select>
        <label class="check"><input type="checkbox" data-filter="archived" ${f.archived ? 'checked' : ''}> Archived</label>
      </div>
      <div id="co-results">${companyListHtml()}</div>`;
  }
  function companyListHtml() {
    const list = filteredCompanies();
    if (!S.companies.some(inCountry)) {
      return `<div class="panel"><p>No ${S.country === 'IL' ? '' : groupName(S.country) + ' '}companies yet. Import the list from your research, or add one by hand.</p>
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
      <span class="co-meta" dir="auto">${esc([c.city, countryOf(c) === 'US' ? c.state : countryOf(c) === 'OT' ? countryName(c) : ''].filter(Boolean).join(', '))}</span>
      <span class="co-conf">${confHtml(c.revitConfidence)}</span>
      <span class="co-status">${badgeFor(c)}${tags}</span>
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
    const us = isUs(c);
    const meta = [us ? countryName(c) : '', c.city, countryOf(c) === 'US' ? c.state : '', c.segment, c.employees ? c.employees + ' employees' : ''].filter(Boolean);
    const hasTo = c.email || b.people.some(p => p.email);

    let primary = '';
    if (!isArchived(c) && st === CONSENT.NONE && us && hasTo) primary = `<button class="btn primary" data-act="compose-us" data-id="${esc(c.id)}">Send email</button>`;
    else if (!isArchived(c) && st === CONSENT.NONE && c.email) primary = `<button class="btn primary" data-act="compose-consent" data-id="${esc(c.id)}">Send consent request</button>`;
    if (!isArchived(c) && st === CONSENT.YES) primary = `<button class="btn primary" data-act="compose-product" data-id="${esc(c.id)}">Send product email</button>`;

    return `
      <a class="back" href="#/companies">‹ Companies</a>
      ${isArchived(c) ? '<div class="notice archived-note">This company is archived. Restore it to work with it again.</div>' : ''}
      <div class="co-head">
        <h1 dir="auto">${esc(primaryName(c))}</h1>
        ${secondaryName(c) ? `<div class="alt-name">${esc(secondaryName(c))}</div>` : ''}
        <div class="meta-line">${badgeFor(c)}${confHtml(c.revitConfidence)}${meta.map(m => `<span dir="auto">${esc(m)}</span>`).join('')}</div>
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
          ${us ? usPanel(c) : consentPanel(c)}
          ${productsPanel(c)}
          <section class="panel">
            <div class="panel-head"><h2>To do</h2><button class="link-btn" data-act="new-task" data-company="${esc(c.id)}">Add</button></div>
            ${openTasks.length ? openTasks.map(taskRow).join('') : '<p class="empty">No open to-dos.</p>'}
          </section>
          ${detailsPanel(c)}
          <section class="panel">
            <div class="panel-head"><h2>People</h2><button class="link-btn" data-act="person" data-company="${esc(c.id)}">Add person</button></div>
            ${b.people.length ? b.people.map(p => `
              <div class="person"><div class="grow"><b dir="auto">${esc(p.name)}</b>${contactIds(b.people).indexOf(p.id) >= 0 ? ` <span class="badge st-yes">Gets emails${contactIds(b.people)[0] === p.id ? '' : ' (Cc)'}</span>` : ''}${p.role ? ` <span class="muted" dir="auto">${esc(p.role)}</span>` : ''}
                <div class="small">${p.email ? esc(p.email) : ''}${p.email && p.phone ? ' · ' : ''}${p.phone ? `<a href="${esc(telHref(p.phone))}">${esc(p.phone)}</a>` : ''}</div>
                ${p.notes ? `<div class="small muted" dir="auto">${esc(p.notes)}</div>` : ''}</div>
                ${p.email ? (p.preferred === 'TRUE'
                  ? `<button class="link-btn small" data-act="set-contact" data-id="${esc(p.id)}" data-on="0">Stop emails here</button>`
                  : `<button class="link-btn small" data-act="set-contact" data-id="${esc(p.id)}" data-on="1">${b.people.some(x => x.preferred === 'TRUE' && x.email) ? 'Also send here' : 'Send emails here'}</button>`) : ''}
                <button class="link-btn small" data-act="person" data-id="${esc(p.id)}" data-company="${esc(c.id)}">Edit</button></div>`).join('')
              : '<p class="empty">Add people when they give you their details, for example after they reply or call. Once a person has an email, product emails go to them instead of the general address. Use “Send emails here” on several people to send to all of them (first one To, the others Cc).</p>'}
          </section>
          <div class="actions">
            <button class="btn ghost" data-act="archive" data-id="${esc(c.id)}" data-archived="${isArchived(c) ? '' : '1'}">${isArchived(c) ? 'Restore company' : 'Archive company'}</button>
          </div>
        </div>
        <section class="panel">
          ${sentSummary(b.activities.filter(a => a.type === 'email_out'), true, c)}
          <div class="panel-head"><h2>History</h2><span class="small muted">${plural(b.activities.length, 'entry', 'entries')}</span></div>
          <ul class="timeline">
            ${pending.map(i => `<li class="act pending"><div class="act-head"><span class="act-kind">${i.action === 'logCall' ? 'Call' : 'Note'}</span><time>Waiting to save</time></div>
              <div class="act-body" dir="auto">${esc(i.payload.summary || i.payload.text || '')}</div></li>`).join('')}
            ${b.activities.length ? b.activities.map(a => activityHtml(a, c)).join('') : (pending.length ? '' : '<li class="empty">Nothing here yet.</li>')}
          </ul>
        </section>
      </div>`;
  }

  function usPanel(c) {
    const st = status(c);
    let text;
    if (st === CONSENT.NONE) text = usOpenNow(c)
      ? 'Not emailed yet. It is working hours there now, so the automatic queue (if on) can send it today.'
      : 'Not emailed yet. The automatic queue sends it Monday–Thursday 9:00–16:00 their time.';
    if (st === CONSENT.SENT) text = 'They got the one email. The CRM won’t send another. If they reply, it shows in Today.';
    if (st === CONSENT.YES) text = 'They are interested. You can send them product emails.';
    if (st === CONSENT.NO) text = 'They said no. The CRM blocks all emails to this company.';
    if (st === CONSENT.UNSUB) text = 'They unsubscribed. The CRM blocks all emails to this company.';
    return `<section class="panel">
      <div class="panel-head"><h2>Outreach (English email)</h2><button class="link-btn" data-act="change-consent" data-id="${esc(c.id)}">Change</button></div>
      <p class="small" style="margin:0 0 6px">${badgeFor(c)} ${c.consentRequestDate ? 'Emailed ' + esc(fmtDateTime(c.consentRequestDate)) : ''}</p>
      <p class="small" style="margin:0">${esc(text)}</p>
      <p class="small muted" style="margin:6px 0 0">Their time now: ${esc(usLocalTime(c))}${c.state ? '' : ' · add the state (Edit) for the right time zone'}</p>
    </section>`;
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
        ${row('Country', esc(countryName(c)))}
        ${row('City', esc(c.city))}
        ${row('State', countryOf(c) === 'US' ? esc(c.state) : '')}
        ${row('Segment', esc(c.segment))}
        ${row('Revit evidence', esc(c.revitEvidence))}
        ${row('Evidence page', link(c.evidenceUrl, 'Open'))}
        ${row('Email found at', link(c.sourceUrl, 'Open'))}
        ${row('Contact page', link(c.contactUrl, 'Open'))}
        ${row('Notes', esc(c.notes))}
        ${row('Added', esc(fmtDateTime(c.createdAt)))}
      </dl>
    </section>`;
  }

  // ---------- email display ----------
  const HEAD_KEYS = { from: 'from', 'מאת': 'from', sent: 'sent', date: 'sent', 'נשלח': 'sent', 'תאריך': 'sent',
    to: 'to', 'אל': 'to', cc: 'cc', 'עותק': 'cc', subject: 'subject', 'נושא': 'subject' };
  const HEAD_RE = /^(from|sent|date|to|cc|subject|מאת|נשלח|תאריך|אל|עותק|נושא)\s*:\s*(.*)$/i;

  /** Clean an email's plain text: no hidden direction marks, no <mailto:…> copies, no [cid:image…] placeholders. */
  function cleanMail(t) {
    return String(t || '').replace(/\r/g, '')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/<mailto:[^>]*>/gi, '')
      .replace(/\[cid:[^\]]*\]/gi, '')
      .replace(/[ \t]+$/gm, '');
  }
  /** Decode MIME words like =?UTF-8?B?…?= that some mail programs leave in names. */
  function decodeWords(v) {
    return String(v || '').replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (all, enc, txt) => {
      try {
        const bin = enc.toLowerCase() === 'b' ? atob(txt)
          : txt.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
        return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
      } catch (e) { return all; }
    });
  }
  function tidy(t) { return t.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(); }

  /** Split a received email (with its quoted conversation) into separate messages, newest first.
   *  Understands Outlook headers (From:/Sent:/To:/Cc:/Subject:, also in Hebrew) and Gmail's "On … wrote:" lines. */
  function splitThread(text) {
    const lines = cleanMail(text).split('\n');
    const msgs = [];
    let cur = { head: {}, lines: [] };
    const unq = l => l.replace(/^(\s*>)+\s?/, '');
    for (let i = 0; i < lines.length; i++) {
      const L = unq(lines[i]).trim();
      if (/^-{2,}\s*(original message|forwarded message|הודעה מקורית|הודעה שהועברה)\s*-{2,}$/i.test(L)) continue;
      // Outlook block: a From: line with more header lines right after it
      if (/^(from|מאת)\s*:/i.test(L) && lines.slice(i + 1, i + 5).some(x => /^(sent|date|to|subject|נשלח|תאריך|אל|נושא)\s*:/i.test(unq(x).trim()))) {
        msgs.push(cur);
        const head = {};
        let j = i, lastKey = '';
        for (; j < lines.length; j++) {
          const x = unq(lines[j]).trim();
          const m = x.match(HEAD_RE);
          if (m) { lastKey = HEAD_KEYS[m[1].toLowerCase()]; head[lastKey] = m[2].trim(); continue; }
          if (!x) break;
          if (lastKey && lastKey !== 'subject' && /[@;,]/.test(x)) { head[lastKey] += ' ' + x; continue; } // wrapped address list
          break;
        }
        cur = { head, lines: [] };
        i = j - 1;
        continue;
      }
      // Gmail: "On Tue, 17 Nov 2026, Name <a@b> wrote:" or "בתאריך … מאת Name <a@b>:" (may wrap over 2–3 lines)
      if (/^(on\s|בתאריך\s)/i.test(L)) {
        let joined = L, k = i;
        while (k < i + 2 && !/(wrote|כתב|כתבה|כתב\/ה)\s*:\s*$|>\s*:\s*$/i.test(joined) && k + 1 < lines.length) { k++; joined += ' ' + unq(lines[k]).trim(); }
        if (/(wrote|כתב|כתבה|כתב\/ה)\s*:\s*$|>\s*:\s*$/i.test(joined) && joined.length < 300) {
          msgs.push(cur);
          const t = joined.replace(/^(on|בתאריך)\s+/i, '').replace(/\s*(wrote|כתב|כתבה|כתב\/ה)?\s*:\s*$/i, '');
          let when = t, who = '';
          const he = t.split(/\s+מאת\s+/);
          if (he.length > 1) { when = he[0]; who = he.slice(1).join(' מאת '); }
          else {
            const tm = t.match(/^(.*?\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?)\s*,?\s*(.*)$/i);
            if (tm) { when = tm[1]; who = tm[2]; }
          }
          cur = { head: { from: who.replace(/,\s*</, ' <'), sent: when }, lines: [] };
          i = k;
          continue;
        }
      }
      cur.lines.push(unq(lines[i]));
    }
    msgs.push(cur);
    const sq = v => decodeWords(v).replace(/\s+/g, ' ').replace(/<\s+/g, '<').replace(/\s+>/g, '>').trim();
    return msgs.map(m => { const h = {}; Object.keys(m.head).forEach(k => { h[k] = sq(m.head[k]); }); return { head: h, body: tidy(m.lines.join('\n')) }; })
      .filter((m, k) => k === 0 || m.body || Object.keys(m.head).length);
  }

  function isMe(addr) { return !!S.me && String(addr || '').toLowerCase().indexOf(S.me) >= 0; }

  /** From / To / Cc / Subject as labelled rows. */
  function mailHead(h) {
    const row = (label, v, html) => (v ? `<dt>${label}</dt><dd>${html || `<span dir="auto">${esc(v)}</span>`}</dd>` : '');
    return `<dl class="mail-head">${row('From', h.from, addrList(h.from))}${row('Date', h.sent)}${row('To', h.to, addrList(h.to))}${row('Cc', h.cc, addrList(h.cc))}${row('Subject', h.subject)}</dl>`;
  }
  /** "Name" <a@b>; Other <c@d>  →  each person as: name (in its own direction) then the address, left to right. */
  function addrList(v) {
    const parts = String(v || '').match(/[^,;<]*<[^>]*>|[^,;\s][^,;]*/g) || [];
    return parts.map(x => {
      const m = x.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
      const name = (m ? m[1] : '').replace(/^["'\s]+|["'\s]+$/g, '');
      const mail = m ? m[2].trim() : x.trim();
      if (!mail) return '';
      return `<span class="addr">${name && name.toLowerCase() !== mail.toLowerCase() ? `<span dir="auto">${esc(name)}</span> ` : ''}<span class="addr-mail" dir="ltr">${esc(mail)}</span></span>`;
    }).filter(Boolean).join('<span class="addr-sep">, </span>');
  }

  /** A whole email: header box, the new text, and the older messages folded away underneath. */
  function mailView(a) {
    const msgs = splitThread(a.fullBody || a.body);
    const top = msgs[0];
    const older = msgs.slice(1);
    const head = { from: a.fromAddr, to: a.toAddr || top.head.to, cc: a.ccAddr || top.head.cc, subject: a.subject };
    const olderHtml = older.length ? `<details class="older"><summary>Earlier in this conversation (${older.length})</summary>
      ${older.map(m => `<div class="quoted ${isMe(m.head.from) ? 'from-me' : ''}">
        ${isMe(m.head.from) ? '<span class="you-tag">Your email</span>' : ''}${mailHead(m.head)}
        ${m.body ? bodyBlock(m.body) : '<p class="small muted">(no text)</p>'}</div>`).join('')}
      </details>` : '';
    return `${mailHead(head)}
      <div class="mail-new">${top.body ? bodyBlock(top.body, 1200) : '<p class="small muted">(no new text)</p>'}</div>
      ${olderHtml}`;
  }

  /** People named in an email (From, To, Cc, or an address written in the text) who aren't saved yet.
   *  Header addresses count only from the company's own domain; addresses written in the text count from any domain. */
  function peopleInMail(a, c) {
    const me = String(S.me || '').toLowerCase();
    const doms = [c.domain, String(c.email || '').split('@')[1]].filter(Boolean).map(d => String(d).toLowerCase().replace(/^www\./, ''));
    const known = new Set(S.people.filter(p => p.companyId === c.id && p.deleted !== 'TRUE').map(p => String(p.email || '').toLowerCase()));
    known.add(String(c.email || '').toLowerCase());
    const found = new Map();
    const take = (mail, name, fromText) => {
      mail = String(mail || '').trim().toLowerCase().replace(/^[-._+]+/, '').replace(/[.,;:)]+$/, '');
      if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/.test(mail) || mail === me || known.has(mail) || found.has(mail)) return;
      if (/^(mailer-daemon|postmaster|microsoftexchange[0-9a-f]+|no-?reply|donotreply)@/.test(mail)) return;
      const dom = mail.split('@')[1];
      if (!fromText && !doms.some(d => dom === d || dom.endsWith('.' + d))) return;
      found.set(mail, cleanName(name, mail));
    };
    const fromHead = v => (String(v || '').match(/[^,;<]*<[^>]*>|[^,;\s][^,;]*/g) || []).forEach(x => {
      const m = x.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
      take(m ? m[2] : x, m ? m[1] : '', false);
    });
    fromHead(a.fromAddr); fromHead(a.toAddr); fromHead(a.ccAddr);
    splitThread(a.fullBody || a.body).forEach(m => {
      fromHead(m.head.from); fromHead(m.head.to); fromHead(m.head.cc);
      (m.body.match(/[A-Za-z0-9][\w.+-]*@[\w-]+(?:\.[\w-]+)+/g) || []).forEach(e => take(e, '', true));
    });
    return [...found].map(([email, name]) => ({ email, name }));
  }
  /** "Edna //LS - Arch" → "Edna"; "Ayala Teitcher // LS-Arch" → "Ayala Teitcher"; no name → from the address. */
  function cleanName(name, mail) {
    let n = String(name || '').replace(/^["'\s]+|["'\s]+$/g, '').split(/\s*(?:\/\/|\||\s-\s)\s*/)[0].trim();
    n = n.replace(/\s+(architects?|arch|engineers?|engineering|ltd|inc|studio|office|אדריכלים|משרד)\.?$/i, '').trim();
    const generic = /^(info|office|mail|admin|studio|contact|hello|sales|secretary|reception|משרד|מזכירות|office manager)$/i;
    if (generic.test(n) && !generic.test(mail.split('@')[0])) n = '';
    if (!n || n.indexOf('@') >= 0) {
      const local = mail.split('@')[0];
      n = /^(info|office|mail|admin|studio|contact|hello|sales|secretary)$/i.test(local) ? local : local.split(/[._-]/)[0];
      n = n.charAt(0).toUpperCase() + n.slice(1);
    }
    return n;
  }
  function peopleBox(a, c) {
    if (a.kind === 'bounce' || !c || !c.id) return '';
    const list = peopleInMail(a, c);
    if (!list.length) return '';
    return `<div class="found-people"><div class="found-title">People in this email</div>
      ${list.map(p => `<div class="found-row"><span class="addr"><span dir="auto">${esc(p.name)}</span> <span class="addr-mail" dir="ltr">${esc(p.email)}</span></span>
        <span class="found-btns"><button class="btn small" data-act="add-found" data-company="${esc(c.id)}" data-email="${esc(p.email)}" data-name="${esc(p.name)}" data-date="${esc(a.date)}" data-pref="1">Add – gets emails</button>
        <button class="btn small ghost" data-act="add-found" data-company="${esc(c.id)}" data-email="${esc(p.email)}" data-name="${esc(p.name)}" data-date="${esc(a.date)}">Add as contact only</button></span></div>`).join('')}
    </div>`;
  }

  /** What we have sent this company: kind, date, to (and Cc). Newest first. */
  /** For a "Yes" company that hasn't had the automatic product yet: when will it go, to whom, or what holds it back. */
  function productNextLine(c, out) {
    if (!c || !c.id || isUs(c) || status(c) !== CONSENT.YES || isArchived(c)) return '';
    const s = S.settings || {};
    const pid = s.autoProductId || ((activeProducts()[0] || {}).id) || '';
    const prod = productById(pid);
    if (!prod) return '';
    let ps = {};
    if (c.productStatus && typeof c.productStatus === 'object') ps = c.productStatus;
    else { try { ps = JSON.parse(c.productStatus || '{}') || {}; } catch (e) { /* ignore */ } }
    if (ps[pid] || out.some(a => a.kind === 'product' && a.productId === pid)) return '';
    const people = S.people.filter(p => p.companyId === c.id && p.deleted !== 'TRUE');
    const ids = contactIds(people);
    const who = ids.length
      ? ids.map((id, k) => { const p = people.find(x => x.id === id); return (k ? 'Cc ' : '') + (p.name || p.email); }).join(', ')
      : (c.email || 'their address');
    const unread = S.unread.filter(a => a.companyId === c.id && a.type === 'email_in').length;
    const send = `<button class="btn small" data-act="compose-product" data-id="${esc(c.id)}">Send now</button>`;
    let text;
    if (unread) text = `${esc(prod.name)} is waiting: ${plural(unread, 'unread reply', 'unread replies')}. Mark ${unread > 1 ? 'them' : 'it'} as read and it goes automatically to ${esc(who)}.`;
    else if (s.autoProduct === 'TRUE' && s.autoProductId === pid) text = `${esc(prod.name)} will go automatically to ${esc(who)} (Sun–Thu 08:00–17:00, one every 10 minutes).`;
    else text = `${esc(prod.name)} not sent yet. Automatic product emails are off; it will go to ${esc(who)} when you send it.`;
    return `<div class="sent-next ${unread ? 'is-held' : ''}" dir="auto"><span>${text}</span>${unread ? '' : send}</div>`;
  }

  function sentSummary(list, open, c) {
    const out = (list || []).filter(a => a.type === undefined || a.type === 'email_out')
      .slice().sort((x, y) => String(y.date).localeCompare(String(x.date)));
    const next = productNextLine(c, out);
    if (!out.length) return `<div class="sent-sum empty-sum">We haven’t emailed them yet.${next}</div>`;
    const usCo = c && isUs(c);
    const label = a => {
      if (a.kind === 'consent') return 'Consent request';
      if (a.kind === 'product') { const p = productById(a.productId); return (p ? p.name : 'Product') + ' email'; }
      if (a.kind === 'reply') return 'Reply';
      if (a.kind === 'gmail') return 'From Gmail';
      return 'Email';
    };
    const prodSent = out.some(a => a.kind === 'product');
    return `<div class="sent-sum ${open ? 'open' : ''}">
      <div class="sent-title">What we sent them${prodSent || usCo ? '' : ' <span class="badge st-sent">No product email yet</span>'}</div>
      <ul>${out.map(a => `<li><span class="sent-kind ${a.kind === 'product' ? 'is-prod' : ''}">${esc(label(a))}</span>
        <time>${esc(fmtDateTime(a.date))}</time>
        <span class="sent-to" dir="ltr">→ ${esc(a.toAddr || '')}${a.ccAddr ? ` · Cc ${esc(a.ccAddr)}` : ''}</span></li>`).join('')}</ul>
      ${next}
    </div>`;
  }

  function bodyBlock(text, max) {
    const t = String(text || '');
    if (!t) return '';
    const long = max ? t.length > max : (t.length > 380 || t.split('\n').length > 6);
    return `<div class="act-body ${long ? 'clamp' : ''}" dir="auto">${esc(t)}</div>${long ? '<button class="link-btn small" data-act="expand">Show all</button>' : ''}`;
  }

  function activityHtml(a, c) {
    const when = `<time>${esc(fmtDateTime(a.date))}</time>`;
    const gmail = a.threadId ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(gmailUrl('all/' + a.threadId))}">Open in Gmail</a>` : '';
    if (a.type === 'email_in') {
      return `<li class="act act-in ${a.unread === 'TRUE' ? 'is-new' : ''}">
        <div class="act-head"><span class="act-kind">${a.kind === 'bounce' ? 'Email bounced' : (a.kind === 'auto_reply' ? 'Automatic reply' : 'Email received')}</span>${a.unread === 'TRUE' ? '<span class="new-dot">New</span>' : ''}${when}</div>
        ${mailView(a)}
        ${peopleBox(a, c)}
        ${a.unread === 'TRUE' ? reviewButtons(a, c) : `<div class="act-actions"><button class="btn small" data-act="compose-reply" data-thread="${esc(a.threadId)}" data-company="${esc(c.id)}">Reply</button>${gmail}</div>`}
      </li>`;
    }
    if (a.type === 'email_out') {
      const kind = { consent: 'Consent request sent', product: 'Product email sent', reply: 'Reply sent', gmail: 'Email sent from Gmail' }[a.kind] || 'Email sent';
      return `<li class="act act-out">
        <div class="act-head"><span class="act-kind">${esc(kind)}</span>${when}</div>
        ${mailHead({ to: a.toAddr, cc: a.ccAddr, subject: a.subject })}
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
          <td dir="auto">${esc(r.nameHe || r.nameEn)}${countryOf(r) !== 'IL' ? ` <span class="tag">${esc(countryName(r))}</span>` : ''}</td><td>${esc(r.email || '—')}${r.contactEmail ? `<div class="small muted">${esc((r.contactName ? r.contactName + ': ' : '') + r.contactEmail)}</div>` : ''}</td><td dir="auto">${esc([r.city, r.state].filter(Boolean).join(', '))}</td>
          <td>${esc(r.revitConfidence)}</td><td>${esc(r.website)}</td></tr>`).join('')}</tbody></table></div>
        ${rows.length > 300 ? `<p class="hint">Showing the first 300 rows.</p>` : ''}
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="import-run" ${add ? '' : 'disabled'}>Import ${plural(add, 'company', 'companies')}</button>
          <button class="btn" data-act="import-clear">Start over</button></div>
        <p id="import-progress" class="hint" style="margin-top:8px"></p>
      </section>`;
    }
    return `
      <div class="page-head"><div><h1>Import list <span class="country-tag">${groupName(S.country)}</span></h1><p>Load the CSV from your research. Companies already in the CRM are skipped automatically.</p></div></div>
      <div class="notice calm small" style="margin-bottom:12px">These companies will be added to <b>${groupName(S.country)}</b> (unless the file has a Country column${S.country === 'OT' ? ', which other countries need: a country name or 2-letter code such as Argentina or AR' : ''}). To import into another group, switch at the top first.</div>
      <div class="stack">
        <section class="panel">
          <div class="form-grid">
            <label class="field full"><span>CSV file</span><input type="file" accept=".csv,.tsv,.txt,text/csv" data-act-change="import-file"></label>
            <label class="field full"><span>Or paste the CSV text</span><textarea id="import-text" class="tall" dir="ltr" placeholder="&quot;Company Name (English)&quot;,&quot;Company Name (Hebrew)&quot;,..."></textarea></label>
          </div>
          <div class="actions" style="margin-top:10px"><button class="btn" data-act="import-parse">Check pasted text</button></div>
          <p class="hint" style="margin-top:8px">Recognized columns: company name (English/Hebrew), segment, city, state, country, website, general email, email source URL, contact page URL, phone, LinkedIn, Revit evidence, evidence URL, Revit confidence, employees, notes, and for a named person (e.g. the BIM manager): contact name, contact email, contact role. A named contact gets the email instead of the general address. “NOT FOUND” values are left empty.</p>
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
    ['contactEmail', h => /e-?mail/.test(h) && /contact|named|person|bim/.test(h) && !/source|general/.test(h)],
    ['contactName', h => /(contact|named|person|bim)/.test(h) && /name|manager|lead/.test(h) && !/e-?mail|role|title|page|url/.test(h)],
    ['contactRole', h => /(contact|person).*(role|title)|^(role|title|job title)$/.test(h)],
    ['country', h => /^country$/.test(h)],
    ['state', h => /^(state|st|state\/province|us state)$/.test(h)],
    ['nameHe', h => /hebrew|עברית/.test(h)],
    ['nameEn', h => /(company|name)/.test(h) && !/contact|named/.test(h)],
    ['contactUrl', h => /contact (page|url|form)/.test(h)],
    ['sourceUrl', h => /email source|source url/.test(h)],
    ['evidenceUrl', h => /evidence url/.test(h)],
    ['revitEvidence', h => /evidence/.test(h) && !/date|type/.test(h)],
    ['revitConfidence', h => /confidence/.test(h)],
    ['email', h => /e-?mail/.test(h) && !/named|contact|source/.test(h)],
    ['linkedin', h => /linkedin/.test(h)],
    ['website', h => /website|^site$|^url$|domain/.test(h)],
    ['phone', h => /phone|טלפון/.test(h)],
    ['city', h => /city|עיר/.test(h)],
    ['segment', h => /segment|category|type/.test(h) && !/evidence/.test(h)],
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
      if (!o.country) o.country = S.country === 'OT' ? 'OT' : S.country;
      o.email = String(o.email || '').toLowerCase();
      o.contactEmail = String(o.contactEmail || '').toLowerCase();
      if (o.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.contactEmail)) o.contactEmail = '';
      if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) o.email = '';
      const d = domainOf(o.website, /@(gmail|walla|yahoo|hotmail|outlook)\./.test(o.email) ? '' : o.email);
      if (!o.email && o.contactEmail) o._contactOnly = true;
      if (!o.nameEn && !o.nameHe) o._status = 'No name';
      else if ((d && domains.has(d)) || (o.email && emails.has(o.email))) o._status = 'Already in CRM';
      else { o._status = 'New'; if (d) domains.add(d); if (o.email) emails.add(o.email); }
      return o;
    });
  }
  async function runImport() {
    const rows = (S.importRows || []).filter(r => r._status === 'New').map(r => { const o = Object.assign({}, r); delete o._status; delete o._contactOnly; return o; });
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
    S.importRows = null; S.freshForm = true;
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
          <section class="panel" id="auto-form">
            <div class="panel-head"><h2>Automatic sending</h2></div>
            ${s.autoPausedReason ? `<p class="notice danger small">${esc(s.autoPausedReason)}</p>` : ''}
            <label class="check"><input type="checkbox" name="autoSend" ${s.autoSend === 'TRUE' ? 'checked' : ''}><span>Send consent requests automatically</span></label>
            <div class="form-grid" style="margin-top:8px">
              <label class="field"><span>Requests per day</span><input name="autoPerDay" type="number" min="1" max="90" value="${esc(s.autoPerDay || 50)}"></label>
              <label class="field"><span>Which companies</span><select name="autoConfidence">
                ${[['High', 'High Revit confidence only'], ['High,Medium', 'High and Medium'], ['All', 'All with an email']].map(([v, l]) => `<option value="${v}" ${v === (s.autoConfidence || 'High,Medium') ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
            </div>
            <p class="hint" style="margin-top:8px">Sends to “Not contacted” companies, highest confidence first, spread over Sunday–Thursday 08:00–17:00 (a few every 10 minutes). Each company still gets only one request. The daily email limit on the left is the overall cap, so set it a little higher than this number to leave room for product emails. It pauses itself if many emails bounce.</p>
            <p class="small" style="margin-top:6px">Today: ${S.autoToday || 0} sent automatically, ${S.bouncesToday || 0} bounced.</p>
            <p class="form-error" id="auto-error"></p>
            <div class="actions" style="margin-top:10px"><button class="btn primary" data-act="save-auto">Save automatic sending</button></div>
          </section>
          <section class="panel" id="autoprod-form">
            <div class="panel-head"><h2>Automatic product emails</h2></div>
            ${(() => {
              const prods = activeProducts();
              const pid = s.autoProductId || (prods[0] && prods[0].id) || '';
              const q = productQueue(pid);
              return `
              <label class="check"><input type="checkbox" name="autoProduct" ${s.autoProduct === 'TRUE' ? 'checked' : ''}><span>Send the product email automatically to companies that said yes</span></label>
              <label class="field" style="margin-top:8px"><span>Product</span><select name="autoProductId">
                ${prods.map(p => `<option value="${esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
              <p class="hint" style="margin-top:8px">One email every 10 minutes, Sunday–Thursday 08:00–17:00, using the product’s pitch text. It goes to the address that said yes. Each company gets it once. Companies with an unread reply wait until you review it.</p>
              <p class="small" style="margin-top:6px">Waiting: ${q.ready.length}. Sent automatically today: ${S.autoProductToday || 0}.</p>
              ${q.manual.length ? `<p class="small" style="margin-top:6px">Send these yourself, because you added people there (choose who gets it): ${q.manual.map(c => `<a href="#/company/${encodeURIComponent(c.id)}" dir="auto">${esc(primaryName(c))}</a>`).join(', ')}</p>` : ''}
              ${!s.senderAddress ? '<p class="notice danger small" style="margin-top:6px">Add your postal address on the left first. It’s required in product emails.</p>' : ''}
              <p class="form-error" id="autoprod-error"></p>
              <div class="actions" style="margin-top:10px"><button class="btn primary" data-act="save-autoprod">Save automatic product emails</button></div>`;
            })()}
          </section>
          <section class="panel" id="us-form">
            <div class="panel-head"><h2>USA and other countries (English email)</h2></div>
            ${s.usPausedReason && s.usAuto !== 'TRUE' ? `<p class="notice danger small">${esc(s.usPausedReason)}</p>` : ''}
            <div class="form-grid">
              <label class="field full"><span>Your name in English (shown as the sender)</span><input name="senderNameEn" dir="ltr" value="${esc(s.senderNameEn)}"></label>
              <label class="field full"><span>Postal address in English (required by US law)</span><input name="senderAddressEn" dir="ltr" value="${esc(s.senderAddressEn)}" placeholder="Street 1, Safed, Israel"></label>
            </div>
            <label class="check" style="margin-top:8px"><input type="checkbox" name="usAuto" ${s.usAuto === 'TRUE' ? 'checked' : ''}><span>Send the English email automatically (USA and other countries)</span></label>
            <div class="form-grid" style="margin-top:8px">
              <label class="field"><span>English emails per day (USA and other countries)</span><input name="usPerDay" type="number" min="1" max="40" value="${esc(s.usPerDay || 15)}"></label>
              <label class="field"><span>Product</span><select name="usProductId">
                ${activeProducts().map(p => `<option value="${esc(p.id)}" ${p.id === (s.usProductId || 'p_clickto3d') ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
            </div>
            <p class="hint" style="margin-top:8px">Each US or other-country company gets one English email (no consent request: US law allows a business email with your address and an unsubscribe line). It goes Monday–Thursday 9:00–16:00 in the company’s own time zone (from its state or country), at least 30 minutes apart, best Revit confidence first. Never on Friday or Shabbat. It goes to the named contact if the list has one, else the general address. English emails also count toward the daily email limit. Start low (about 15): many cold emails from a free Gmail address can get it flagged.</p>
            <p class="small" style="margin-top:6px">Sent today: ${S.usToday || 0}.</p>
            <pre class="footer-preview" dir="ltr" style="margin-top:8px">${esc(usFooterText())}</pre>
            <p class="hint">Your name line is left out when the email is already signed with your name.</p>
            <p class="form-error" id="us-error"></p>
            <div class="actions" style="margin-top:10px"><button class="btn primary" data-act="save-us">Save English emails</button></div>
            <div class="form-grid" style="margin-top:14px">
              <label class="field full"><span>Send a test of the English email to</span><input name="usTestTo" id="us-test-to" type="email" dir="ltr" placeholder="your personal email"></label>
            </div>
            <p class="hint">Uses the saved English email and the settings above. The subject starts with [TEST]. No company is marked, and it doesn't count toward the daily limit.</p>
            <p class="form-error" id="us-test-error"></p>
            <div class="actions" style="margin-top:6px"><button class="btn" data-act="send-us-test">Send test email</button></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Added to every Hebrew product email (Israel)</h2></div>
            <pre class="footer-preview" dir="rtl">${esc(footerText())}</pre>
            <p class="hint">Your name line is left out when the email is already signed with your name.</p>
            <p class="hint" style="margin-top:8px">The subject always starts with “פרסומת:”.</p>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>System</h2></div>
            <dl class="kv">
              <dt>Signed in as</dt><dd>${esc(S.me || S.email)}</dd>
              <dt>Emails last checked</dt><dd>${esc(fmtDateTime(S.lastSync) || 'Not yet')}</dd>
              <dt>Last backup</dt><dd>${esc(fmtDateTime(S.lastBackup) || 'Not yet (runs nightly)')}</dd>
              <dt>Command inbox</dt><dd>${S.inbox && S.inbox.url ? `<a href="${esc(S.inbox.url)}" target="_blank" rel="noopener">Open folder</a>` : 'Created on the next check (within 15 min)'}
                · last checked ${esc(fmtDateTime(S.inbox && S.inbox.lastRun) || 'not yet')}
                ${S.inbox && S.inbox.lastSummary ? `<div class="small muted" dir="auto">${esc(S.inbox.lastSummary)}</div>` : ''}
                <div><button class="link-btn" data-act="process-inbox">Apply command files now</button></div></dd>
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
        <label class="field"><span>Country</span><select name="country">
          ${(() => { const cur = c.id ? countryCode(c) : S.country; return [['IL', 'Israel'], ['US', 'USA']].concat(Object.keys(OTHER_COUNTRIES).filter(k => k !== 'OT').map(k => [k, OTHER_COUNTRIES[k]]).sort((a, b) => a[1].localeCompare(b[1])), [['OT', 'Other country']])
            .map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join(''); })()}</select></label>
        ${field('State (USA, e.g. NY)', 'state', c.state, { dir: 'ltr' })}
        ${field('City', 'city', c.city)}
        ${field('Segment', 'segment', c.segment)}
        <label class="field"><span>Revit confidence</span><select name="revitConfidence">
          ${['', 'High', 'Medium', 'Low'].map(v => `<option value="${v}" ${v === (c.revitConfidence || '') ? 'selected' : ''}>${v || 'Unknown'}</option>`).join('')}</select></label>
        ${field('Employees (approx.)', 'employees', c.employees)}
        ${field('LinkedIn', 'linkedin', c.linkedin, { dir: 'ltr' })}
        ${field('Revit evidence', 'revitEvidence', c.revitEvidence, { full: true })}
        ${field('Evidence page', 'evidenceUrl', c.evidenceUrl, { dir: 'ltr' })}
        ${field('Where the email was found', 'sourceUrl', c.sourceUrl, { dir: 'ltr' })}
        ${field('Contact page', 'contactUrl', c.contactUrl, { dir: 'ltr' })}
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
      <p class="hint">If they want product emails, ask them to confirm by email. Phone consent isn’t enough as proof.</p>`,
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

  /** Same rule as the backend: everyone marked "Gets emails" (oldest first; first = To, rest = Cc),
   *  else the most recently edited person with an email. Returns person ids. */
  function contactIds(people) {
    const withEmail = (people || []).filter(p => p.email && p.deleted !== 'TRUE');
    const chosen = withEmail.filter(p => p.preferred === 'TRUE').sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
    if (chosen.length) return chosen.map(p => p.id);
    let best = null;
    withEmail.forEach(p => { if (!best || String(p.updatedAt || p.createdAt) >= String(best.updatedAt || best.createdAt)) best = p; });
    return best ? [best.id] : [];
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
      <p class="small">Use this when something happened outside the CRM, for example they agreed in an email the CRM didn’t catch, or a request was marked as sent but never left Gmail. A “Yes” needs written consent (an email), not a phone call.</p>
      <label class="field"><span>New status</span><select name="status">${CONSENT_LIST.map(s => `<option value="${esc(s)}" ${s === st ? 'selected' : ''}>${esc(stLabel(s, isUs(c)))}</option>`).join('')}</select></label>
      <label class="field"><span>What happened (required for “Yes” and for resetting a sent request)</span><textarea name="note" dir="auto" placeholder="Replied “כן” by email on 3 Nov from dana@firm.co.il"></textarea></label>
      ${st === CONSENT.NO || st === CONSENT.UNSUB ? `<div class="notice danger">This company asked not to be contacted.</div>
        <label class="check"><input type="checkbox" name="confirm"><span>I have their new, clear permission.</span></label>` : ''}`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-save>Save status</button>`);
    bindSave(m, 'setConsent', d => {
      if (d.status === CONSENT.YES && !d.note) throw new Error('Write how they agreed. This is your proof of consent.');
      if (st === CONSENT.SENT && d.status === CONSENT.NONE && !d.note) throw new Error('Write why the request should be reset. Only reset it if the request really was not sent.');
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
        <fieldset class="lang-box full"><legend><span class="lang-flag il">Israel</span> Hebrew email</legend>
          <p class="hint">Sent to Israeli companies that said yes. “פרסומת:” and the Hebrew legal footer are added automatically.</p>
          ${field('Subject', 'pitchSubject', p.pitchSubject, { full: true })}
          <label class="field full"><span>Email text</span><textarea name="pitchBody" class="tall" dir="rtl">${esc(p.pitchBody)}</textarea></label>
        </fieldset>
        <fieldset class="lang-box us full"><legend><span class="lang-flag us">USA + other</span> English email</legend>
          <p class="hint">Sent once to each USA or other-country company. Your English address and the unsubscribe line are added automatically. No “פרסומת:”.</p>
          ${field('Subject', 'pitchSubjectEn', p.pitchSubjectEn, { full: true, dir: 'ltr' })}
          <label class="field full"><span>Email text</span><textarea name="pitchBodyEn" class="tall" dir="ltr">${esc(p.pitchBodyEn)}</textarea></label>
        </fieldset>
        <p class="hint full">Placeholders for both: {company} {sender} {product} {link} {store}</p>
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

  function batchModal() {
    if (isShabbat()) { toast('No sending on Shabbat. Batches can be sent from Sunday until Friday 12:00.', 'warn'); return; }
    const limit = Number(S.settings.dailyLimit || 20);
    const left = Math.max(0, limit - S.sentToday);
    const avail = batchCandidates().length;
    const conf = { High: 'High Revit confidence only', 'High,Medium': 'High and Medium Revit confidence', All: 'all companies with an email' }[S.settings.autoConfidence || 'High,Medium'];
    const max = Math.min(left, avail, 90);
    const m = openModal('Send batch now', `
      <p class="small">Sends the consent request right now to the next companies on your list: “Not contacted”, ${esc(conf)}, best first. Each company still gets only one request.</p>
      <dl class="kv"><dt>Companies waiting</dt><dd>${avail}</dd><dt>Left in today’s limit</dt><dd>${left} of ${limit}</dd></dl>
      ${max ? `<label class="field"><span>How many to send now</span><input name="count" type="number" min="1" max="${max}" value="${Math.min(max, 20)}"></label>
        <p class="hint">Takes about 3 seconds per email. Keep this window open until it finishes.</p>`
        : `<div class="notice">${left ? 'No companies are waiting for a request.' : 'Today’s limit is reached. Raise it in Settings, or continue tomorrow.'}</div>`}
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button>${max ? '<button class="btn primary" data-send>Send batch</button>' : ''}`);
    if (!max) return;
    const btn = $('[data-send]', m);
    const box = $('.send-status', m);
    const cancel = $('.modal-foot [data-act="close-modal"]', m);
    const reqId = newReqId();
    btn.addEventListener('click', async () => {
      const n = Math.round(Number(formData(m).count));
      if (!(n >= 1 && n <= max)) { box.className = 'send-status error'; box.textContent = `Choose a number between 1 and ${max}.`; return; }
      btn.disabled = true; lockModal(true);
      box.className = 'send-status working'; box.textContent = `Sending ${n} requests… about ${Math.ceil(n * 3 / 60)} min. Keep this window open.`;
      let result = null;
      S.busy++; updateSyncPill();
      try {
        const data = await api('sendBatch', { count: n }, { reqId, timeout: 300000 });
        result = data.batch;
        await applyResult(data);
      } catch (e) {
        lockModal(false); S.busy--; updateSyncPill();
        if (e.unknown) {
          box.className = 'send-status unknown';
          box.innerHTML = '<b>The connection dropped, but the batch may still be running.</b> Nothing will be sent twice. Wait a few minutes, then use “Reload data” in Settings to see the results.';
        } else { box.className = 'send-status error'; box.textContent = e.message; btn.disabled = false; }
        return;
      }
      lockModal(false); S.busy--; updateSyncPill();
      const parts = [`${plural(result.sent, 'request', 'requests')} sent`];
      if (result.unknown) parts.push(`${result.unknown} not confirmed by Gmail (check Gmail Sent; they won’t be resent)`);
      if (result.failed) parts.push(`${result.failed} skipped (see each company’s history)`);
      if (result.stopped === 'limit') parts.push('stopped at today’s limit');
      if (result.stopped === 'time') parts.push('stopped after 4 minutes; send another batch for the rest');
      box.className = 'send-status ' + (result.sent ? 'ok' : 'error');
      box.textContent = parts.join('. ') + '.';
      btn.hidden = true; cancel.textContent = 'Close';
      toast(`${plural(result.sent, 'request', 'requests')} sent`);
    });
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

  /** The one English email to a US company. */
  function composeUs(id) {
    const c = companyById(id);
    if (!c) return;
    const s = S.settings;
    const prods = activeProducts().filter(p => p.pitchBodyEn);
    if (!prods.length) { toast('Add the English email to a product first (Products page).', 'warn'); return; }
    const p0 = prods.find(p => p.id === s.usProductId) || prods[0];
    const missing = !s.senderNameEn || !s.senderAddressEn;
    const people = S.people.filter(p => p.companyId === c.id && p.deleted !== 'TRUE');
    const contacts = contactIds(people).map(pid => String((people.find(p => p.id === pid) || {}).email || '').toLowerCase()).filter(Boolean);
    const recips = [];
    contacts.concat([c.email], people.map(p => p.email)).forEach(e => { e = String(e || '').toLowerCase(); if (e && recips.indexOf(e) < 0) recips.push(e); });
    const nameOf = e => { const p = people.find(x => String(x.email || '').toLowerCase() === e); return p ? p.name : ''; };
    const open = usOpenNow(c);
    const m = openModal('Send English email', `
      ${missing ? '<div class="notice danger">Add your name and postal address in English first (<a href="#/settings" data-act="close-modal">Settings → English email</a>). The law requires them.</div>' : ''}
      <p class="small">Their time now: <b>${esc(usLocalTime(c))}</b>${open ? '' : ' · outside their working hours (the automatic queue would wait for Mon–Thu 9:00–16:00)'}</p>
      <div class="form-grid">
        <label class="field"><span>Product</span><select name="productId">${prods.map(p => `<option value="${esc(p.id)}" ${p.id === p0.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>To</span><select name="to" dir="ltr">${recips.map(e => `<option value="${esc(e)}">${esc(e)}${nameOf(e) ? ' – ' + esc(nameOf(e)) : ''}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Subject</span><input name="subject" dir="ltr"></label>
      <label class="field"><span>Email text</span><textarea name="body" class="tall" dir="ltr"></textarea></label>
      <div><span class="small muted">Added automatically at the end</span><pre class="footer-preview" dir="ltr">${esc(usFooterText(true))}</pre></div>
      <p class="hint">Each company gets this English email once. After it is sent, the CRM won’t send another.</p>
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-send ${missing || !recips.length ? 'disabled' : ''}>Send email</button>`, { wide: true });
    const sel = $('[name=productId]', m);
    const fillFor = pid => {
      const p = productById(pid) || p0;
      const ctx = ctxFor(c, p);
      $('[name=subject]', m).value = fill(p.pitchSubjectEn, ctx);
      $('[name=body]', m).value = fill(p.pitchBodyEn, ctx);
    };
    fillFor(p0.id);
    sel.addEventListener('change', () => fillFor(sel.value));
    sendFlow(m, {
      action: 'sendUs',
      payload: () => {
        const d = formData(m);
        const box = $('.send-status', m);
        if (!d.subject || !d.body) { box.className = 'send-status error'; box.textContent = 'Write a subject and a text.'; return null; }
        if (/\{store\}|\{link\}/.test(d.body)) { box.className = 'send-status error'; box.textContent = 'A link is missing. Add it to the product (Products page) or remove the placeholder.'; return null; }
        return { companyId: c.id, productId: d.productId, to: d.to, subject: d.subject, body: d.body };
      }
    }, 'Email sent');
  }

  function composeProduct(id) {
    const c = companyById(id);
    if (!c) return;
    const prods = activeProducts();
    if (!prods.length) { toast('Add an active product first.', 'warn'); return; }
    const s = S.settings;
    const us = isUs(c);
    const missing = us ? (!s.senderNameEn || !s.senderAddressEn) : (!s.senderName || !s.senderAddress);
    const people = S.people.filter(p => p.companyId === c.id && p.deleted !== 'TRUE');
    const contacts = contactIds(people).map(id => String((people.find(p => p.id === id) || {}).email || '').toLowerCase()).filter(Boolean);
    const recips = [];
    contacts.concat([c.consentFrom, c.email], people.map(p => p.email))
      .forEach(e => { e = String(e || '').toLowerCase(); if (e && recips.indexOf(e) < 0) recips.push(e); });
    const nameOf = e => { const p = people.find(x => String(x.email || '').toLowerCase() === e); return p ? p.name : ''; };
    const p0 = prods[0];
    const m = openModal('Send product email', `
      ${missing ? '<div class="notice danger">Add your name and postal address in <a href="#/settings" data-act="close-modal">Settings</a> first. The law requires them in advertising emails.</div>' : ''}
      <div class="form-grid">
        <label class="field"><span>Product</span><select name="productId">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>To</span><select name="to" dir="ltr">${recips.map(e => `<option value="${esc(e)}">${esc(e)}${nameOf(e) ? ' – ' + esc(nameOf(e)) : ''}</option>`).join('')}</select></label>
      </div>
      ${recips.length > 1 ? `<fieldset class="cc-list"><legend>Cc (also gets it)</legend>
        ${recips.map(e => `<label class="check" data-cc="${esc(e)}"><input type="checkbox" name="cc" value="${esc(e)}" ${contacts.indexOf(e) > 0 ? 'checked' : ''}><span dir="ltr">${esc(e)}${nameOf(e) ? ' – <span dir="auto">' + esc(nameOf(e)) + '</span>' : ''}</span></label>`).join('')}
      </fieldset>` : ''}
      ${us ? `<label class="field"><span>Subject</span><input name="subject" dir="ltr"></label>
      <label class="field"><span>Email text</span><textarea name="body" class="tall" dir="ltr"></textarea></label>
      <div><span class="small muted">Added automatically at the end</span><pre class="footer-preview" dir="ltr">${esc(usFooterText(true))}</pre></div>`
      : `<label class="field"><span>Subject</span><div class="subject-row" dir="rtl"><span class="prefix">פרסומת:</span><input name="subject" dir="auto"></div></label>
      <label class="field"><span>Email text</span><textarea name="body" class="tall" dir="rtl"></textarea></label>
      <div><span class="small muted">Added automatically at the end</span><pre class="footer-preview" dir="rtl">${esc(footerText(true))}</pre></div>`}
      <div class="send-status" aria-live="polite"></div>`,
      `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-send ${missing ? 'disabled' : ''}>Send email</button>`, { wide: true });
    const sel = $('[name=productId]', m);
    const fillFor = pid => {
      const p = productById(pid) || p0;
      const ctx = ctxFor(c, p);
      if (us) {
        $('[name=subject]', m).value = fill(p.pitchSubjectEn, ctx);
        $('[name=body]', m).value = fill(p.pitchBodyEn, ctx);
        return;
      }
      $('[name=subject]', m).value = fill(p.pitchSubject, ctx).replace(/^\s*פרסומת\s*[:\-–]?\s*/, '');
      $('[name=body]', m).value = fill(p.pitchBody, ctx);
    };
    fillFor(p0.id);
    sel.addEventListener('change', () => fillFor(sel.value));
    const toSel = $('[name=to]', m);
    const syncCc = () => $$('[data-cc]', m).forEach(l => { const same = l.dataset.cc === toSel.value; l.hidden = same; if (same) $('input', l).checked = false; });
    toSel.addEventListener('change', syncCc);
    syncCc();
    sendFlow(m, {
      action: 'sendProduct',
      payload: () => {
        const d = formData(m);
        if (!d.subject || !d.body) { $('.send-status', m).className = 'send-status error'; $('.send-status', m).textContent = 'Write a subject and a text.'; return null; }
        if (/\{store\}|\{link\}/.test(d.body)) { $('.send-status', m).className = 'send-status error'; $('.send-status', m).textContent = 'A link is missing. Add it to the product (Products page) or remove the placeholder.'; return null; }
        const cc = $$('[name=cc]:checked', m).map(x => x.value).filter(e => e !== d.to);
        return { companyId: c.id, productId: d.productId, to: d.to, cc, subject: d.subject, body: d.body };
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
      <label class="field"><span>Your reply</span><textarea name="body" class="tall" dir="${c && isUs(c) ? 'ltr' : 'rtl'}"></textarea></label>
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
        <span class="sr-sub">${isUs(c) ? esc(countryName(c)) + ' · ' : ''}${[c.city, c.phone, c.email].filter(Boolean).map(v => '<bdi>' + esc(v) + '</bdi>').join(' · ')} ${isArchived(c) ? '(archived)' : ''}</span></a>`).join('')
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
    'toggle-translate': () => toggleTranslate(),
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
    'add-found': async el => {
      const d = el.dataset;
      const pref = d.pref === '1';
      el.disabled = true;
      const when = d.date ? new Date(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      try {
        await write('savePerson', { companyId: d.company, name: d.name, email: d.email, preferred: pref, notes: 'Found in their email' + (when ? ' of ' + when : '') },
          pref ? d.name + ' added and will get product emails' : d.name + ' added as a contact');
      } catch (e) { el.disabled = false; toast(e.message, 'error'); }
    },
    'set-contact': async el => {
      const on = el.dataset.on !== '0';
      try { await write('setContactPerson', { id: el.dataset.id, on }, on ? 'Product emails will go to this person' : 'This person won’t get product emails'); } catch (e) { toast(e.message, 'error'); }
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
    'bounced': async el => {
      const box = el.closest('.actions');
      $$('button', box).forEach(b => { b.disabled = true; });
      try {
        const r = await write('markBounced', { activityId: el.dataset.id }, 'Bad address removed');
        if (r) toast('Address removed. The company is back to “Not contacted”.');
      } catch (e) { toast(e.message, 'error'); $$('button', box).forEach(b => { b.disabled = false; }); }
    },
    'compose-consent': el => composeConsent(el.dataset.id),
    'compose-us': el => composeUs(el.dataset.id),
    'set-country': el => {
      const want = el.dataset.country === 'US' || el.dataset.country === 'OT' ? el.dataset.country : 'IL';
      if (want === S.country) return;
      S.country = want;
      try { localStorage.setItem(LS_COUNTRY, want); } catch (e) { /* ignore */ }
      Object.assign(S.filters, { status: '', segment: '' });
      S.importRows = null;
      if (route().name === 'company') go('#/companies'); else render();
    },
    'save-us': async el => {
      const d = formData($('#us-form'));
      const err = $('#us-error');
      err.textContent = '';
      el.disabled = true;
      try {
        const r = await write('saveSettings', { senderNameEn: d.senderNameEn, senderAddressEn: d.senderAddressEn, usAuto: !!d.usAuto, usPerDay: d.usPerDay, usProductId: d.usProductId }, 'English emails saved');
        if (r) toast(d.usAuto ? 'Automatic English emails are on' : 'English email settings saved');
      } catch (e) { err.textContent = e.message; }
      el.disabled = false;
    },
    'send-us-test': async el => {
      const input = $('#us-test-to');
      const err = $('#us-test-error');
      err.textContent = '';
      const to = String(input.value || '').trim();
      if (!to) { err.textContent = 'Enter the email address to send the test to.'; return; }
      el.disabled = true;
      try {
        await api('sendUsTest', { to }, { reqId: newReqId() });
        toast('Test email sent to ' + to);
      } catch (e) { err.textContent = e.message; }
      el.disabled = false;
    },
    'batch': () => batchModal(),
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
    'save-auto': async el => {
      const d = formData($('#auto-form'));
      const err = $('#auto-error');
      err.textContent = '';
      if (d.autoSend && Number(d.autoPerDay) > Number(S.settings.dailyLimit || 20)) {
        err.textContent = `Your overall daily limit is ${S.settings.dailyLimit || 20}. Raise it on the left (and save) to at least ${d.autoPerDay}, or automatic sending will stop at the limit.`;
      }
      el.disabled = true;
      try {
        const r = await write('saveSettings', { autoSend: !!d.autoSend, autoPerDay: d.autoPerDay, autoConfidence: d.autoConfidence }, 'Automatic sending saved');
        if (r) toast(d.autoSend ? 'Automatic sending is on' : 'Automatic sending is off');
      } catch (e) { err.textContent = e.message; }
      el.disabled = false;
    },
    'save-autoprod': async el => {
      const d = formData($('#autoprod-form'));
      const err = $('#autoprod-error');
      err.textContent = '';
      el.disabled = true;
      try {
        const r = await write('saveSettings', { autoProduct: !!d.autoProduct, autoProductId: d.autoProductId }, 'Automatic product emails saved');
        if (r) toast(d.autoProduct ? 'Automatic product emails are on' : 'Automatic product emails are off');
      } catch (e) { err.textContent = e.message; }
      el.disabled = false;
    },
    'expand': el => { const body = el.previousElementSibling; body.classList.remove('clamp'); el.remove(); },
    'import-parse': () => {
      try { S.importRows = prepareImport($('#import-text').value); render(); } catch (e) { toast(e.message, 'error'); }
    },
    'import-run': () => runImport(),
    'import-clear': () => { S.importRows = null; S.freshForm = true; render(); },
    'flush': () => flushOutbox(),
    'process-inbox': async el => {
      el.disabled = true;
      try {
        const r = await write('processInbox', {}, 'Command files');
        if (r) { const n = (r.inboxRun && r.inboxRun.files) || 0; toast(n ? `${plural(n, 'command file', 'command files')} applied. Results are in the Done folder.` : 'No new command files'); }
      } catch (e) { toast(e.message, 'error'); }
      el.disabled = false;
    },
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
