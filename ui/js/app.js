'use strict';
/* GoFM app.js: boot, i18n load, data-action delegation, rail + New menu, hash router, keybindings. Last script; everything else only defines. */
window.GOFM = window.GOFM || {};
(function (G) {
  var E = G.escapeHtml, T = G.t;
  function $(id) { return document.getElementById(id); }
  function st() { return G.state; }

  G.SAVED_VIEWS = {};

  /* ---------- i18n ---------- */
  G.resolveLang = function (lang) {
    return 'en';
  };
  G.loadLang = async function (lang) {
    lang = 'en';
    var dict = null;
    var gi = window.GOFM_I18N;
    if (gi && gi.en) dict = gi.en;
    else if (gi && typeof gi === 'object' && typeof Object.values(gi)[0] === 'string') dict = gi; // server flat dict {k:v}
    if (!dict && G.apiEP && G.apiEP.i18n) {
      var r = await G.apiEP.i18n(lang);
      if (r && r.ok && r.dict) dict = r.dict;
    }
    if (dict) G.I18N.dict = dict;
    G.setLang(lang);
    try { document.documentElement.lang = lang; } catch (e) { }
    try { document.title = T('app.title'); } catch (e) { }
    G.applyI18n(document);
    if (G.browser && G.browser.render) G.browser.render();
    if (G.jobs && G.jobs.render) G.jobs.render();
  };

  /* ---------- hash router: #/path <-> dir ---------- */
  G.router = {
    pathFromHash: function () {
      var h = String(location.hash || '');
      if (h.indexOf('#/') !== 0) return null;
      var p = decodeURIComponent(h.slice(1));
      if (p === '/files' || p === 'files') return '/';
      p = '/' + p.replace(/^\/+/, '');
      return p;
    },
    syncHash: function (path) {
      path = String(path || '/');
      if (path === '/files' || path === 'files') path = '/';
      var want = '#' + encodeURI(path);
      if (location.hash !== want) {
        try { history.pushState(null, '', want); } catch (e) { try { location.hash = want; } catch (e2) { } }
      }
    },
    handle: function (initial) {
      var p = G.router.pathFromHash();
      if (p == null) {
        if (initial) G.browser.loadDir(st().dir || '/');
        return;
      }
      if (p === '/files' || p === 'files') {
        G.router.go('/');
        return;
      }
      st().savedView = '';
      G.browser.loadDir(p);
    },
    go: function (path) {
      path = String(path || '/');
      if (path === '/files' || path === 'files') path = '/';
      var clean = '/' + path.replace(/^\/+/, '');
      if (clean === '/') { location.hash = '#/'; return; }
      location.hash = '#/' + clean.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    }
  };

  /* ---------- data-action delegation table ---------- */
  var ACTIONS = {
    'job-cancel': function (el) {
      var row = el && el.closest ? el.closest('[data-job-id]') : null;
      var id = row ? row.dataset.jobId : null;
      if (id && G.jobs && G.jobs.jobAct) G.jobs.jobAct({ target: el });
    },
    'job-pause': function (el) {
      var row = el && el.closest ? el.closest('[data-job-id]') : null;
      var id = row ? row.dataset.jobId : null;
      if (id && G.jobs && G.jobs.jobAct) G.jobs.jobAct({ target: el });
    },
    'job-retry': function (el) {
      var row = el && el.closest ? el.closest('[data-job-id]') : null;
      var id = row ? row.dataset.jobId : null;
      if (id && G.jobs && G.jobs.jobAct) G.jobs.jobAct({ target: el });
    },
    mkdir: function () { G.actions.act_mkdir(); },
    newfile: function () { G.actions.act_newfile(); },
    upload: function () { G.actions.act_upload(); },
    'upload-folder': function () { G.actions.act_uploadFolder(); },
    url: function () { G.actions.act_urlfetch(); },
    download: function (el, item) {
      if (el && el.closest && el.closest('#selbar')) {
        G.actions.act_download(); // always use full selection for selection bar button
      } else if (item) {
        G.actions.act_download(item);
      } else {
        G.actions.act_download();
      }
    },
    quickview: function (el, item) {
      var it = item || itemForTrigger(el);
      if (!it) return;
      if (it.is_dir) { if (G.browser) G.browser.openItem(it); }
      else { if (G.actions.quickview) G.actions.quickview(it); }
    },
    rename: function (el, item) { G.actions.act_rename(item); },
    copy: function (el, item) { G.actions.act_copyto(item); },
    move: function (el, item) { G.actions.act_moveto(item); },
    compress: function (el, item) { G.actions.act_compress('zip', item); },
    'compress-zip': function (el, item) { G.actions.act_compress('zip', item); },
    'compress-tar': function (el, item) { G.actions.act_compress('compress-tar', item); },
    'extract-here': function (el, item) { G.actions.act_extract('here', item); },
    'extract-folder': function (el, item) { G.actions.act_extract('folder', item); },
    chmod: function (el, item) { G.actions.act_chmod(item); },
    hash: function (el, item) { G.actions.act_hash(item); },
    props: function (el, item) { G.actions.act_props(item); },
    delete: function (el, item) { if (item) G.actions.act_delete(item); else G.actions.act_delete(); },
    settings: function () { G.actions.act_settings(); },
    admin: function () { if (G.admin) G.admin.open(); },
    signin: function () { G.actions.showLogin(true); },
    'admin-close': function () { if (G.admin) G.admin.close(); },
    theme: function () { G.actions.act_theme(); },
    logout: function () { G.actions.act_logout(); },
    /* extras: selbar / rail / toolbar */
    newcopy: function (el, item) { if (item) G.actions.act_newcopy(item); },
    'select-clear': function () { if (G.browser) G.browser.clearSel(); },
    'view-list': function () { if (G.browser && G.browser.setViewMode) G.browser.setViewMode('list'); },
    'view-grid': function () { if (G.browser && G.browser.setViewMode) G.browser.setViewMode('grid'); },
    'new-menu': function () { toggleNewMenu(); },
    refresh: function () { if (G.browser) G.browser.refresh(); },
    /* markup-driven actions (previously unhandled -> dead buttons) */
    open: function (el) { var it = itemForTrigger(el); if (it && G.browser) G.browser.openItem(it); },
    edit: function (el) {
      var it = itemForTrigger(el);
      if (!it) return;
      if (G.editor && G.editor.canEdit && G.editor.canEdit(it)) G.editor.openEdit(it);
      else if (G.actions.quickview) G.actions.quickview(it);
    },
    'settings-close': function () { var x = $('settings-sheet'); if (x) { x.hidden = true; x.classList.remove('open'); } },
    'upload-close': function () { if (G.actions.uploadModalClose) G.actions.uploadModalClose(); },
    'quickview-close': function () { if (G.actions.quickviewClose) G.actions.quickviewClose(); },
    'editor-close': function () { if (G.actions.act_editorClose) G.actions.act_editorClose(); },
    'editor-more': function (el) {
      var it = { path: G.editor && G.editor.current && G.editor.current.path,
                 name: G.editor && G.editor.current && G.editor.current.name, is_dir: false };
      if (!it.path) return;
      var r = el.getBoundingClientRect();
      if (G.browser) { G.browser.ctxTarget = it; G.browser.showCtx(null, r.left, r.bottom + 4); }
    },
    'editor-revert': function () { if (G.actions.act_editorRevert) G.actions.act_editorRevert(); },
    save: function () { if (G.actions.act_editorSave) G.actions.act_editorSave(); },
    more: function (el) {
      var it = itemForTrigger(el);
      if (!it) return;
      var host = el.closest ? el.closest('[data-path]') : null;
      var rect = el.getBoundingClientRect();
      if (G.browser && G.browser.ctxAtEl) G.browser.ctxAtEl(host, rect.left, rect.bottom + 4);
    }
  };
  G.ACTION_HANDLERS = Object.keys(ACTIONS);

  var NEEDS_ITEM = { quickview: 1, rename: 1, copy: 1, move: 1, chmod: 1, hash: 1, props: 1, newcopy: 1, 'extract-here': 1, 'extract-folder': 1, 'compress-zip': 1, 'compress-tar': 1, download: 1, delete: 1, more: 1 };

  function itemForTrigger(el) {
    if (el && el.closest && el.closest('#selbar')) {
      return null; // selection bar actions must apply to ALL selected items
    }
    if (G.browser) {
      var host = el.closest ? el.closest('[data-path]') : null;
      if (host) return G.browser.itemFromEl(host);
      if (G.browser.ctxTarget) return G.browser.ctxTarget;
      var sel = G.browser.selectedItems();
      if (sel.length === 1) return sel[0];
    }
    return null;
  }
  function onClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    var name = el.dataset.action;
    var fn = ACTIONS[name];
    if (!fn) return;
    if (el.closest && el.closest('#ctx-menu')) G.browser.hideCtx();
    if (el.closest && el.closest('#new-menu')) { var nm = $('new-menu'); if (nm) nm.hidden = true; }
    e.preventDefault();
    e.stopPropagation();
    var item = itemForTrigger(el);
    if (NEEDS_ITEM[name] && !item && G.browser && !G.browser.selectedItems().length) return;
    try { fn(el, item); } catch (err) { G.toast(String((err && err.message) || err), { kind: 'error' }); }
  }

  /* ---------- rail: New menu + saved views ---------- */
  function toggleNewMenu(force) {
    var nm = $('new-menu');
    if (!nm) { G.warnOnce('newmenu', '#new-menu missing'); return; }
    nm.querySelectorAll('[data-action]').forEach(function (b) {
      b.hidden = !G.canAction(b.dataset.action, []);
    });
    var show = (force != null) ? force : !!nm.hidden;
    nm.hidden = !show;
    nm.classList.toggle('open', show);
  }
  function wireRail() {
    var rn = $('rail-new');
    if (rn && !rn.dataset.wired) { rn.dataset.wired = '1'; rn.addEventListener('click', function (e) { e.stopPropagation(); toggleNewMenu(); }); }
    var tv = $('tree-views');
    if (tv && !tv.dataset.wired) {
      tv.dataset.wired = '1';
      tv.addEventListener('click', function (e) {
        var tog = e.target && e.target.closest ? e.target.closest('[data-tree-toggle]') : null;
        if (tog) {
          e.stopPropagation();
          e.preventDefault();
          var p = tog.dataset.treeToggle;
          if (G.browser && G.browser.tree && G.browser.tree.toggle) G.browser.tree.toggle(p);
          return;
        }
        var nav = e.target && e.target.closest ? e.target.closest('[data-tree-nav], .tree-row') : null;
        if (nav) {
          e.stopPropagation();
          e.preventDefault();
          var p = nav.dataset.treeNav || nav.dataset.nav;
          if (p) G.router.go(p);
        }
      });
    }
    // The topbar Upload button opens the one modal that covers files, folder
    // and URL. The separate #upload-menu it used to toggle was dead markup.
    /* Gate every capability-controlled control on the CURRENT folder's
       permissions. Previously these buttons were rendered unconditionally, so
       a read-only shared folder still showed Upload (and New, Rename,
       Delete…), which then failed with a 403 when used. The allow-map from
       /api/list is per-path, so this has to run on every navigation, not
       just at boot. */
    function syncPermUI() {
      var p = (G.state && G.state.perms) || {};
      var canU = !!(p.u), canW = !!(p.w), canD = !!(p.d), canR = !!p.r;
      var up = $('upload-btn');
      if (up) up.hidden = !canU;
      var rn = $('rail-new');
      if (rn) rn.hidden = !(canU || canW);
      var st2 = $('rail-settings');
      if (st2) st2.hidden = !canR; // settings shows theme/lang for read-only too
    }
    G.syncPermUI = syncPermUI;

    var uploadBtn = $('upload-btn');
    if (uploadBtn && !uploadBtn.dataset.wired) {
      uploadBtn.dataset.wired = '1';
      uploadBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        /* Use G.browser, not the local B: B is scoped to wireRail() and was
           not visible inside this listener, so every click threw a
           ReferenceError and the upload modal never opened. */
        if (G.browser && G.browser.canUpload && !G.browser.canUpload()) {
          G.toast(G.t('err.readonly') || 'You do not have upload access here', { kind: 'error' });
          return;
        }
        if (G.actions.wireUploadModal) G.actions.wireUploadModal();
        if (G.actions.uploadModalOpen) G.actions.uploadModalOpen('files');
      });
    }
    var stEl = $('rail-settings');
    if (stEl && !stEl.dataset.wired) { stEl.dataset.wired = '1'; stEl.addEventListener('click', function () { G.actions.act_settings(); }); }
    var rc = $('rail-collapse');
    var rail = $('rail');
    /* Off-canvas rail on narrow viewports: one class drives the drawer, the
       scrim and both toggles' aria state. */
    function setRailOpen(open) {
      document.documentElement.classList.toggle('rail-open', open);
      var sc = $('rail-scrim');
      if (sc) sc.hidden = !open;
      var ro = $('rail-open');
      if (ro) ro.setAttribute('aria-expanded', open ? 'true' : 'false');
      var rc2 = $('rail-collapse');
      if (rc2) rc2.setAttribute('aria-expanded', open ? 'false' : 'true');
    }
    var ro = $('rail-open');
    if (ro && !ro.dataset.wired) {
      ro.dataset.wired = '1';
      ro.addEventListener('click', function (e) {
        e.stopPropagation();
        setRailOpen(!document.documentElement.classList.contains('rail-open'));
      });
    }
    var scrim = $('rail-scrim');
    if (scrim && !scrim.dataset.wired) {
      scrim.dataset.wired = '1';
      scrim.addEventListener('click', function () { setRailOpen(false); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.documentElement.classList.contains('rail-open')) setRailOpen(false);
    });
    if (rc && rail && !rc.dataset.wired) {
      rc.dataset.wired = '1';
      rc.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.matchMedia && window.matchMedia('(max-width:760px)').matches) {
          setRailOpen(!document.documentElement.classList.contains('rail-open'));
          return;
        }
        var col = document.documentElement.classList.toggle('collapsed');
        rc.setAttribute('aria-expanded', !col);
      });
    }
    var ub = $('user-btn');
    var um = $('user-menu');
    var ua = $('user-avatar');
    if (ua && st().me) {
      ua.textContent = st().me.charAt(0).toUpperCase();
      ua.title = st().me;
    }
    if (ub && um && !ub.dataset.wired) {
      ub.dataset.wired = '1';
      ub.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = um.hidden;
        var admBtn = um.querySelector('[data-action=admin]');
        if (admBtn) admBtn.hidden = !st().admin;
        um.hidden = !open;
        um.classList.toggle('open', open);
        ub.setAttribute('aria-expanded', open);
      });
    }
  }

  /* ---------- keybindings ---------- */
  function wireKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (G.modals && G.modals.openCount && G.modals.openCount() > 0) {
          var top = G.modals.top();
          if (top && top.close) { top.close(); return; }
        }
        var adm = $('admin-sheet');
        if (adm && !adm.hidden) { if (G.admin && G.admin.close) G.admin.close(); return; }
        if (G.actions.quickviewOpen && G.actions.quickviewOpen()) { G.actions.quickviewClose(); return; }
        var sheet = $('settings-sheet');
        if (sheet && !sheet.hidden) { sheet.hidden = true; sheet.classList.remove('open'); return; }
        var um2 = $('upload-modal');
        if (um2 && !um2.hidden) { G.actions.uploadModalClose(); return; }
        var nm = $('new-menu');
        if (nm && !nm.hidden) { nm.hidden = true; return; }
        // The user menu had no dismissal path at all: no backdrop, and Escape
        // never reached it, so on a phone it stayed open over the file list.
        var um3 = $('user-menu');
        if (um3 && !um3.hidden) { um3.hidden = true; um3.classList.remove('open'); return; }
        var upm = $('upload-menu');
        if (upm && !upm.hidden) { upm.hidden = true; return; }
        if (G.browser && G.browser.hideCtx) G.browser.hideCtx();
        // Escape leaves check mode: this branch returns before onKey() runs,
        // so the handler there could never fire for the most natural exit.
        if (G.browser && G.browser.checkMode && G.browser.checkMode()) {
          G.browser.exitCheckMode();
          return;
        }
        return;
      }
      if (G.actions.quickviewOpen && G.actions.quickviewOpen()) {
        if (G.actions.quickviewKey(e)) return;
      }
      if (G.browser.onKey(e)) return;
    }, true);
    window.addEventListener('hashchange', function () { G.router.handle(false); });
    window.addEventListener('popstate', function () { G.router.handle(false); });
    try {
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onm = function () { if (st().theme === 'auto') G.applyTheme('auto'); };
        if (mq.addEventListener) mq.addEventListener('change', onm);
        else if (mq.addListener) mq.addListener(onm);
      }
    } catch (e) { }
  }

  /* ---------- session / boot ---------- */
  function applySession(s) {
    if (!s || typeof s !== 'object') return;
    if (s.me !== undefined) st().me = s.me;
    if (s.admin !== undefined) st().admin = !!s.admin;
    if (s.perms) st().perms = s.perms;
    if (s.csrf) st().csrf = s.csrf;
    if (s.config) st().config = s.config;
    var cfg = s.config || {};
    var appTitle = cfg.app_name || cfg.app || s.app || 'GoFile';
    try {
      document.querySelectorAll('.brand-text, .login-title').forEach(function(el) { el.textContent = appTitle; });
      document.title = appTitle;
      var logoUrl = cfg.logo_url || s.logo_url;
      if (logoUrl) {
        document.querySelectorAll('.logo-mark').forEach(function(el) {
          el.outerHTML = '<img class="logo-mark logo-img" src="' + G.escapeHtml(logoUrl) + '" width="28" height="28" alt="logo" style="object-fit:contain;">';
        });
      }
    } catch(e){}
    if (!G.LS.get('gofm.theme') && cfg.theme) st().theme = cfg.theme;
    if (!G.LS.get('gofm.lang') && cfg.lang) st().lang = cfg.lang;
    if (cfg.chunk_bytes == null) cfg.chunk_bytes = 2000000;
    var v = G.LS.get('gofm.view');
    if (v === 'grid' || v === 'list') st().view = v;
    var sort = G.LS.getJSON('gofm.sort');
    if (sort && sort.key) st().sort = sort;
    G.applyTheme(st().theme);
    try { document.documentElement.dataset.density = st().density; } catch (e) { }
  }
  function wireAll() {
    if (G._wired) return;
    G._wired = true;
    G.browser.wire();
    G.jobs.init();
    if (G.viewer && G.viewer.wire) G.viewer.wire();
    wireRail();
    wireKeys();
    document.addEventListener('click', onClick);
  }

  G.boot = { wireAll: wireAll,
    start: async function () {
      if (G._booted) return;
      G._booted = true;
      var loginEl = $('login');
      var lc = $('login-csrf');
      if (lc && lc.value) st().csrf = lc.value;
      var boot = window.GOFM_BOOT || null;
      applySession(boot);
      await G.loadLang(st().lang);
      G.initBeacon();
      var ok = !!(boot && boot.ok !== false && boot.me);
      if (!ok) {
        var r = await G.apiEP.session();
        if (r && r.ok) { applySession(r); ok = true; }
      }
      st().signedIn = !!ok;

      if (!ok) {
        var su = (boot && boot.setup) || await G.api('api/session').then(function (x) { return x && x.setup; }, function () { return false; });
        if (su) { G.actions.showSetup(); return; }

        var shared = (boot && boot.shared && boot.shared_dir) ? boot.shared_dir : await G.api('api/shared').then(function (x) {
          return (x && x.ok && x.dir) ? x.dir : null;
        }, function () { return null; });

        if (shared) {
          st().guest = true;
          document.documentElement.classList.add('is-guest');
          wireAll();
          var app0 = $('app');
          if (app0) { app0.hidden = false; app0.classList.add('ready'); }
          if (loginEl) { loginEl.hidden = true; loginEl.classList.remove('as-modal'); }
          var ub2 = $('user-btn');
          if (ub2) ub2.hidden = true;
          var si = $('signin-btn');
          if (si) si.hidden = false;

          var hp0 = G.router.pathFromHash();
          var targetDir = hp0 || '/';
          await G.browser.loadDir(targetDir);
          if (G.syncPermUI) G.syncPermUI();
          G.selbarUpdate();
          return;
        }

        // nothing is shared: show login full screen
        if (loginEl) loginEl.hidden = false;
        G.actions.showLogin();
        return;
      }
      if (loginEl) loginEl.hidden = true;
      wireAll();
      var app = $('app');
      if (app) { app.hidden = false; app.classList.add('ready'); }
      var hp = G.router.pathFromHash();
      G.router.handle(hp == null);
      if (G.storageBar) G.storageBar.refresh();
      if (G.syncPermUI) G.syncPermUI();
      G.selbarUpdate();
    },
    afterLogin: async function () {
      var r = await G.apiEP.session();
      if (r && r.ok) applySession(r);
      st().signedIn = true;
      st().guest = false;
      document.documentElement.classList.remove('is-guest');
      var ub = $('user-btn'); if (ub) ub.hidden = false;
      var si = $('signin-btn'); if (si) si.hidden = true;
      var ua = $('user-avatar');
      if (ua && st().me) {
        ua.textContent = st().me.charAt(0).toUpperCase();
        ua.title = st().me;
      }
      var um = $('user-menu');
      if (um) {
        var admBtn = um.querySelector('[data-action=admin]');
        if (admBtn) admBtn.hidden = !st().admin;
      }
      await G.loadLang(st().lang);
      wireAll();
      var app = $('app');
      if (app) { app.hidden = false; app.classList.add('ready'); }
      G.router.handle(G.router.pathFromHash() == null);
      if (G.storageBar) G.storageBar.refresh();
      if (G.syncPermUI) G.syncPermUI();
    }
  };
  window.gofilesBoot = function () { G.boot.start(); };
  document.addEventListener('DOMContentLoaded', function () { G.boot.start(); });
  if (document.readyState === 'interactive' || document.readyState === 'complete') G.boot.start();
})(window.GOFM);
