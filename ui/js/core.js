'use strict';
/* GoFM core: namespace, state, i18n, api wrapper, toasts, formatting. Plain script, no modules. */
window.GOFM = window.GOFM || {};
(function (G) {
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
    getJSON: function (k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
    setJSON: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };
  G.LS = LS;

  G.state = {
    me: null, perms: { r: true, u: false, w: false, d: false }, allow: {}, csrf: '', config: {},
    dir: '/', items: [], sel: new Set(),
    view: 'list', sort: { key: 'name', asc: true }, savedView: '',
    theme: (LS.get('gofm.theme') || 'auto'), density: LS.get('gofm.density') || 'comfortable',
    lang: LS.get('gofm.lang') || 'auto', showHidden: LS.get('gofm.hidden') === '1',
    jobs: new Map(), signedIn: null
  };
  G.warned = {};
  G.warnOnce = function (k, msg) { if (G.warned[k]) return; G.warned[k] = 1; try { console.warn('[GoFM] ' + msg); } catch (e) { } };

  /* ---------- i18n ---------- */
  G.I18N = { lang: 'en', dict: {} };
  G.setLang = function (lang) { G.I18N.lang = lang || 'en'; };
  G.t = function (key, vars) {
    var d = G.I18N.dict || {};
    var s = (d[key] != null) ? String(d[key]) : (d.en && d.en[key] != null ? String(d.en[key]) : key);
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : m; });
    return s;
  };
  G.applyI18n = function (root) {
    root = root || document;
    try {
      root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = G.t(el.getAttribute('data-i18n')); });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) { el.setAttribute('placeholder', G.t(el.getAttribute('data-i18n-placeholder'))); });
      root.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', G.t(el.getAttribute('data-i18n-title'))); });
    } catch (e) { }
  };

  /* ---------- urls / prefix ---------- */
  function prefix() {
    var p = window.GOFM_PREFIX;
    if (typeof p !== 'string') p = '/gofm';
    p = p.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  }
  G.P = prefix;
  G.url = function (p) {
    p = String(p == null ? '' : p);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
    var pref = prefix();
    if (pref && (p === pref || p.indexOf(pref + '/') === 0)) return p;
    return pref + '/' + p.replace(/^\.?\/+/, '');
  };

  /* ---------- fetch wrapper ---------- */
  function normErr(r, body, e) {
    var code = 'error', message = '';
    if (body && typeof body === 'object') {
      var en = body.error;
      if (en && typeof en === 'object') { code = en.code || code; message = en.message || ''; }
      else if (typeof en === 'string') message = en;
      if (body.code && !message) code = body.code;
      if (body.message && !message) message = body.message;
    }
    if (!message) {
      message = (typeof body === 'string' && body) ? body.slice(0, 160)
        : (e && e.message) ? e.message
          : (r && r.status ? 'HTTP ' + r.status : G.t('err.unknown'));
    }
    if (r) code = code || String(r.status);
    return { ok: false, error: { code: code || 'error', message: String(message), http: r ? r.status : 0 } };
  }
  G.api = async function (path, opt) {
    opt = opt || {};
    var url = G.url(path);
    var m = (opt.method || 'GET').toUpperCase();
    var headers = Object.assign({}, opt.headers || {});
    var isMut = m !== 'GET' && m !== 'HEAD';
    var body = opt.body;
    if (isMut) {
      headers['X-CSRF'] = G.state.csrf || '';
      if (body && typeof body === 'object' && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
    }
    var r, data = null;
    try {
      r = await fetch(url, { method: m, headers: headers, body: body === undefined ? undefined : body, credentials: 'same-origin', signal: opt.signal });
    } catch (e) {
      return normErr(null, null, e);
    }
    if (r.status === 401) {
      var wasSignedIn = G.state.signedIn;
      G.state.signedIn = false;
      var errData = null;
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') >= 0) { try { errData = await r.json(); } catch (e) { } }
      /* Only bounce to the login screen when a real session was lost. A guest
         browsing a shared folder legitimately gets 401s from endpoints they
         are not allowed to use (usage, jobs, upload); showing the login wall
         then threw them out of the very view they were allowed to see. */
      if (wasSignedIn && !G.state.guest && G.actions && G.actions.showLogin) {
        try { G.actions.showLogin(); } catch (e) { }
      }
      return normErr(r, errData, null);
    }
    if (!opt.raw) {
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') >= 0) { try { data = await r.json(); } catch (e) { data = null; } }
      else { try { data = await r.text(); } catch (e) { data = ''; } }
      if (!r.ok) return normErr(r, data, null);
      if (data && typeof data === 'object') {
        if (data.csrf) G.state.csrf = data.csrf;
        if (data.me !== undefined && data.me !== null) G.state.me = data.me;
        if (data.perms && typeof data.perms === 'object') G.state.perms = data.perms;
      }
      return (data && typeof data === 'object') ? data : { ok: true, data: data };
    }
    if (!r.ok) return normErr(r, null, null);
    return { ok: true, resp: r };
  };

  /* ---------- toasts ---------- */
  G.toast = function (msg, opt) {
    opt = opt || {};
    var root = document.getElementById('toast-root');
    if (!root) { G.warnOnce('toast', '#toast-root missing'); return; }
    var el = document.createElement('div');
    el.className = 'toast' + (opt.kind ? ' toast-' + opt.kind : '');
    el.setAttribute('role', 'status');
    var txt = String(msg == null ? '' : msg);
    if (opt.plain || !G.escapeHtml) el.textContent = txt;
    else el.innerHTML = G.escapeHtml(txt);
    if (opt.actionLabel && typeof opt.onAction === 'function') {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-btn'; b.textContent = opt.actionLabel;
      b.addEventListener('click', function () { try { opt.onAction(); } catch (e) { } el.remove(); });
      el.appendChild(b);
    }
    root.appendChild(el);
    G.applyI18n(el);
    setTimeout(function () { el.classList.add('fade'); setTimeout(function () { el.remove(); }, 600); }, opt.ms || 4000);
  };

  /* ---------- helpers ---------- */
  G.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  G.fmtSize = function (n) {
    if (n == null || isNaN(n)) return '—';
    n = Number(n);
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB', 'PB'], i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
  };
  G.fmtDate = function (ts) {
    if (!ts) return '—';
    var d = ts instanceof Date ? ts : new Date(typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts));
    if (isNaN(d.getTime())) return '—';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  G.fmtSpeed = function (bps) { return (bps > 0 ? G.fmtSize(bps) : '—') + '/s'; };
  G.fmtDur = function (s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };

  var EXT_CLASS = {
    pdf: 'ic-pdf', doc: 'ic-doc', docx: 'ic-doc', rtf: 'ic-doc', odt: 'ic-doc', txt: 'ic-text', md: 'ic-md',
    xls: 'ic-sheet', xlsx: 'ic-sheet', csv: 'ic-sheet', ods: 'ic-sheet',
    ppt: 'ic-slide', pptx: 'ic-slide', odp: 'ic-slide',
    zip: 'ic-zip', tar: 'ic-zip', gz: 'ic-zip', tgz: 'ic-zip', '7z': 'ic-zip', rar: 'ic-zip', bz2: 'ic-zip', xz: 'ic-zip',
    png: 'ic-image', jpg: 'ic-image', jpeg: 'ic-image', gif: 'ic-image', webp: 'ic-image', svg: 'ic-image', bmp: 'ic-image', ico: 'ic-image', avif: 'ic-image',
    mp4: 'ic-video', mkv: 'ic-video', webm: 'ic-video', mov: 'ic-video', avi: 'ic-video', m4v: 'ic-video',
    mp3: 'ic-audio', wav: 'ic-audio', ogg: 'ic-audio', flac: 'ic-audio', m4a: 'ic-audio', aac: 'ic-audio', opus: 'ic-audio',
    js: 'ic-code', mjs: 'ic-code', ts: 'ic-code', jsx: 'ic-code', tsx: 'ic-code', json: 'ic-code', html: 'ic-code', htm: 'ic-code', css: 'ic-code', scss: 'ic-code', less: 'ic-code', xml: 'ic-code', yaml: 'ic-code', yml: 'ic-code', toml: 'ic-code', ini: 'ic-code', conf: 'ic-code', sh: 'ic-code', bash: 'ic-code', zsh: 'ic-code', fish: 'ic-code', py: 'ic-code', rb: 'ic-code', php: 'ic-code', pl: 'ic-code', lua: 'ic-code', r: 'ic-code', sql: 'ic-code',
    go: 'ic-go', c: 'ic-c', h: 'ic-c', cpp: 'ic-c', hpp: 'ic-c', cc: 'ic-c', rs: 'ic-rs', java: 'ic-java', swift: 'ic-code', kt: 'ic-code',
    exe: 'ic-bin', dll: 'ic-bin', so: 'ic-bin', deb: 'ic-bin', rpm: 'ic-bin', apk: 'ic-bin', dmg: 'ic-bin', msi: 'ic-bin',
    iso: 'ic-iso', torrent: 'ic-torrent'
  };
  G.fileIconClass = function (name, isDir) {
    if (isDir) return 'ic-folder';
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'dockerfile') return 'ic-code';
    return EXT_CLASS[ext] || 'ic-file';
  };
  G.fileIconHref = function (name, isDir) {
    if (isDir) return '#i-folder';
    var ext = G.extOf(name);
    if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(ext)) return '#i-image';
    if (/^(mp4|mkv|webm|mov|avi|m4v)$/i.test(ext)) return '#i-video';
    if (/^(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(ext)) return '#i-audio';
    if (/^(pdf)$/i.test(ext)) return '#i-pdf';
    if (/^(docx?|rtf|odt|pages)$/i.test(ext)) return '#i-doc';
    if (/^(txt|log|cfg|ini|env|properties)$/i.test(ext)) return '#i-txt';
    if (/^(zip|tar|gz|tgz|7z|rar|bz2|xz|iso)$/i.test(ext)) return '#i-archive';
    if (/^(js|mjs|cjs|ts|jsx|tsx|json|html?|css|scss|less|xml|ya?ml|toml|sh|bash|zsh|py|rb|php|pl|lua|r|sql|go|c|h|cpp|hpp|rs|java|swift|kt|dockerfile|makefile)$/i.test(ext)) return '#i-code';
    return '#i-file';
  };
  G.joinPath = function (dir, name) {
    dir = String(dir || '/').replace(/\/+$/, '');
    return (dir + '/' + String(name || '')).replace(/\/{2,}/g, '/');
  };
  G.baseName = function (p) { p = String(p || ''); var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); };
  G.extOf = function (name) { var m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
  G.collisionFree = function (name, taken) {
    taken = taken || function () { return false; };
    if (!taken(name)) return name;
    var m = /^(.*)\.([A-Za-z0-9]+)$/.exec(name);
    var base = m ? m[1] : name, ext = m ? '.' + m[2] : '';
    for (var i = 2; i < 100; i++) {
      var c = base + ' (' + i + ')' + ext;
      if (!taken(c)) return c;
    }
    return name + ' (' + Date.now() + ')' + ext;
  };
  G.patternMatches = function (pat, name) {
    pat = String(pat); name = String(name);
    if (pat === '*') return true;
    if (pat.charAt(0) === '*') return name.length >= pat.length - 1 && name.slice(-(pat.length - 1)) === pat.slice(1);
    return pat === name;
  };
  G.debounce = function (fn, ms) {
    var h = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(h);
      h = setTimeout(function () { h = null; fn.apply(self, args); }, ms || 200);
    };
  };
  G.uuid = function () {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  };

  /* ---------- theme ---------- */
  function sysDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }
  G.sysDark = sysDark;
  G.effectiveTheme = function () { return G.state.theme === 'auto' ? (sysDark() ? 'dark' : 'light') : G.state.theme; };
  G.applyTheme = function (t) {
    if (t) G.state.theme = t;
    var eff = G.effectiveTheme();
    try { document.documentElement.dataset.theme = eff; } catch (e) { }
    try { document.documentElement.dataset.density = G.state.density; } catch (e) { }
    LS.set('gofm.theme', G.state.theme);
    if (G.editor) G.editor.onThemeChange(eff);
  };

  /* ---------- diag beacon (throttled 5/min, failures swallowed) ---------- */
  var diagTimes = [];
  function sendBeacon(payload) {
    try {
      if (!G.apiEP || !G.apiEP.diag) return;
      if (!G.state.signedIn) return;
      var now = Date.now();
      diagTimes = diagTimes.filter(function (x) { return now - x < 60000; });
      if (diagTimes.length >= 5) return;
      diagTimes.push(now);
      payload.ua = navigator ? (navigator.userAgent || '').slice(0, 160) : '';
      G.apiEP.diag(payload).then(function () { }, function () { });
    } catch (e) { }
  }
  G.initBeacon = function () {
    if (G._beacon) return; G._beacon = true;
    window.addEventListener('error', function (e) {
      sendBeacon({ msg: String((e && (e.message || (e.error && e.error.message))) || 'error').slice(0, 300), src: (e && e.filename ? String(e.filename) : '').slice(0, 200), line: (e && e.lineno) | 0 });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      sendBeacon({ msg: String((r && (r.message || r)) || 'rejection').slice(0, 300), src: 'unhandledrejection', line: 0 });
    });
  };
  G.initBeacon();
})(window.GOFM);
