'use strict';
/* GoFM viewer.js: quickview pager, storage bar, selection bar, settings sheet, login/logout shell bits. */
window.GOFM = window.GOFM || {};
(function (G) {
  var A = G.actions, V = G.viewer = {};
  var E = G.escapeHtml, T = G.t;
  function $(id) { return document.getElementById(id); }
  function st() { return G.state; }
  function okToast(r) { return r && r.ok; }
  function msg(r, fb) { return (r && r.error && r.error.message) || T(fb); }

  /* ---------- selection bar ---------- */
  G.selbarUpdate = function () {
    var bar = $('selbar');
    if (!bar) return;
    var n = st().sel.size;
    bar.hidden = n === 0;
    bar.classList.toggle('show', n > 0);
    var cnt = $('sel-count') || bar.querySelector('.sel-count');
    if (cnt) cnt.textContent = n > 0 ? String(n) : '0';

    if (n > 0 && G.canAction && G.browser) {
      var items = G.browser.selectedItems();
      bar.querySelectorAll('.sel-btn').forEach(function (btn) {
        var act = btn.dataset.action;
        if (!act) return;
        var allowed = G.canAction(act, items);
        btn.hidden = !allowed;
      });
    }
  };

  /* ---------- storage bar ---------- */
  G.storageBar = {
    refresh: function () {
      var fill = $('storage-fill'), bar = $('storage-bar');
      var lab = $('storage-label'), val = $('storage-value');
      if (!bar) return;
      if (fill) fill.style.width = '0%';
      if (lab) lab.textContent = G.t('Storage') || 'Storage';
      if (val) val.textContent = '';
      G.apiEP.usage(st().dir).then(function (r) {
        if (!okToast(r) || !(r.total > 0)) return;
        var used = r.used != null ? r.used : (r.total - r.free);
        var pct = Math.max(0, Math.min(100, (used / r.total) * 100));
        if (fill) fill.style.width = (pct < 0.5 && used > 0 ? 0.5 : pct) + '%';
        var s = G.fmtSize(used) + ' / ' + G.fmtSize(r.total) + ' (' + Math.round(pct) + '%)';
        if (lab) lab.textContent = G.t('Storage') || 'Storage';
        if (val) val.textContent = G.fmtSize(used) + ' / ' + G.fmtSize(r.total);
        bar.title = s;
        try { bar.setAttribute('aria-valuenow', String(Math.round(pct))); } catch (e) { }
      }, function () { });
    }
  };

  /* ---------- quickview pager ---------- */
  var qv = { open: false, items: [], idx: -1 };
  V.current = null; // item shown in quickview, for the ⋮ menu
  A.quickviewOpen = function () { return qv.open; };
  function isPreviewable(it) {
    if (!it || it.is_dir) return false;
    var mime = String(it.mime || '');
    var name = String(it.name || '').toLowerCase();
    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
    if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar|iso|bin|exe|dll|dmg|apk|dat|db|sqlite)$/i.test(name)) return false;
    // On mobile, PDFs are opened in browser/reader via compact modal instead of taking over full screen
    if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) return !isMobile;
    if (/^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(name)) return true;
    if (/^video\//i.test(mime) || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name)) return true;
    if (/^audio\//i.test(mime) || /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(name)) return true;
    if (G.editor && G.editor.isTextLike(name)) return true;
    return false;
  }

  A.quickview = function (item) {
    if (!item) return;
    if (!isPreviewable(item)) {
      // Non-previewable file: show a compact modal card with name, size and download button
      if (G.actions && G.actions.openModal) {
        var sz = (item.size != null && item.size > 0) ? G.fmtSize(item.size) : '';
        var isPdf = /\.pdf$/i.test(item.name) || (item.mime && /pdf/i.test(item.mime));
        var iconHref = G.fileIconHref ? G.fileIconHref(item.name, item.is_dir) : (isPdf ? '#i-pdf' : '#i-file');
        var iconTint = G.fileIconClass ? G.fileIconClass(item.name, item.is_dir) : (isPdf ? 'ic-pdf' : 'ic-file');
        var rawUrl = (G.apiEP && G.apiEP.rawURL ? G.apiEP.rawURL(item.path) : G.url('f/' + String(item.path || '').replace(/^\/+/, '')));
        
        var bodyHtml = '<div class="non-prev-card" style="text-align:center;padding:12px 0;">' +
          '<svg class="i fic ' + iconTint + '" width="52" height="52" viewBox="0 0 24 24" style="margin-bottom:12px;"><use href="' + iconHref + '"/></svg>' +
          '<div style="font-weight:600;font-size:15px;margin-bottom:4px;word-break:break-all;">' + G.escapeHtml(item.name) + '</div>' +
          (sz ? '<div style="color:var(--muted);font-size:13px;margin-bottom:12px;">' + G.escapeHtml(sz) + '</div>' : '') +
          (isPdf ? '' : '<p style="color:var(--muted);font-size:13px;margin:0 0 16px;">' + (G.t('qv.noPreview') || 'No preview available') + '</p>') +
          '</div>';
        
        var modalButtons = [];
        if (isPdf) {
          modalButtons.push({
            label: G.t('qv.openPdf') || 'Open in Browser',
            icon: '#i-arrow-up-right',
            primary: true,
            onClick: function(m) { m.close(); window.open(rawUrl, '_blank'); }
          });
        }
        modalButtons.push({
          label: G.t('menu.download') || 'Download',
          icon: '#i-download',
          primary: !isPdf,
          onClick: function(m) { m.close(); A.act_download(item); }
        });

        G.actions.openModal({
          title: '',
          closeBtn: true,
          centerButtons: true,
          body: bodyHtml,
          buttons: modalButtons
        });
      }
      return;
    }

    var pool = (G.browser && G.browser._lastRender) || st().items;
    var i = -1;
    for (var k = 0; k < pool.length; k++) if (pool[k].path === item.path) { i = k; break; }
    qv.items = pool;
    qv.open = true;
    V.show(i < 0 ? 0 : i);
  };
  V.show = function (i) {
    var el = $('quickview');
    if (!el) { G.warnOnce('qv', '#quickview missing'); return; }
    var items = qv.items;
    if (!items.length) { A.quickviewClose(); return; }
    i = Math.max(0, Math.min(items.length - 1, i));
    var it = items[i];
    if (!it) { A.quickviewClose(); return; }
    qv.idx = i;
    V.current = it;
    var mime = String(it.mime || '');
    el.dataset.path = it.path;
    if (G.browser) G.browser.ctxTarget = it;
    var body = $('qv-body');
    var name = $('qv-name');
    el.hidden = false;
    el.classList.add('open');
    if (name) {
      name.textContent = it.name;
    }
    var posEl = $('qv-pos');
    if (posEl) posEl.textContent = (i + 1) + ' / ' + items.length;
    var pv = $('qv-prev'), nx = $('qv-next');
    if (pv) pv.hidden = true;
    if (nx) nx.hidden = true;
    if (posEl) posEl.hidden = true;
    // hide the edit affordance for files the editor cannot handle
    var qvEdit = $('qv-edit');
    if (qvEdit) qvEdit.hidden = !(G.canAction && G.canAction('edit', [it]));
    if (!body) return;
    body.textContent = '';
    var url = (G.apiEP && G.apiEP.inlineURL ? G.apiEP.inlineURL(it.path) : G.url('f/' + String(it.path || '').replace(/^\/+/, '')));
    var mime = String(it.mime || '');
    var w, btn;
    function kindFile(re) { return new RegExp(re, 'i').test(it.name); }
    if (it.is_dir || kindFile('\\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$')) {
      w = document.createElement('div'); w.className = 'qv-msg'; w.textContent = T('qv.noPreview');
      body.appendChild(w);
    } else if (/^image\//i.test(mime) || kindFile('\\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$')) {
      w = document.createElement('img'); w.className = 'qv-img'; w.alt = it.name; w.src = url;
      body.appendChild(w);
    } else if (/^video\//i.test(mime) || kindFile('\\.(mp4|webm|mov|mkv|avi|m4v)$')) {
      w = document.createElement('video'); w.controls = true; w.className = 'qv-media'; w.src = url;
      body.appendChild(w);
    } else if (/^audio\//i.test(mime) || kindFile('\\.(mp3|wav|ogg|flac|m4a|aac|opus)$')) {
      w = document.createElement('audio'); w.controls = true; w.className = 'qv-media'; w.src = url;
      body.appendChild(w);
    } else if (/pdf/i.test(mime) || kindFile('\\.pdf$')) {
      // Zero-dependency pure browser PDF viewer (no pdf.js bloat)
      var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
      if (isMobile) {
        // Mobile browsers block raw PDF in iframe: render clean interactive mobile card with direct full-screen open
        w = document.createElement('div');
        w.className = 'qv-pdf-mobile';
        w.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;text-align:center;background:var(--surface-2);border-radius:12px;border:1px solid var(--line-soft);margin:20px auto;max-width:420px;';
        w.innerHTML = '<svg class="i" width="56" height="56" viewBox="0 0 24 24" style="color:var(--accent);margin-bottom:16px;"><use href="#i-file"/></svg>' +
          '<div style="font-weight:600;font-size:16px;margin-bottom:6px;word-break:break-all;">' + G.escapeHtml(it.name) + '</div>' +
          '<div style="font-size:13px;color:var(--muted);margin-bottom:20px;">' + (it.size > 0 ? G.fmtSize(it.size) : 'PDF Document') + '</div>' +
          '<div style="display:flex;gap:10px;width:100%;justify-content:center;">' +
          '<a href="' + url + '" target="_blank" rel="noopener" class="btn btn-primary" style="text-decoration:none;padding:8px 18px;">' + (G.t('qv.openPdf') || 'Open in PDF Reader') + '</a>' +
          '<a href="' + url + (url.indexOf('?') >= 0 ? '&' : '?') + 'download=1" class="btn" style="text-decoration:none;padding:8px 18px;">' + (G.t('menu.download') || 'Download') + '</a>' +
          '</div>';
        body.appendChild(w);
      } else {
        // Desktop & universal PDF container with action helper for encrypted/custom PDFs
        var container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:min(94vw, 1100px);height:calc(88vh - 70px);max-width:100%;';
        
        var topBar = document.createElement('div');
        topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%;padding:6px 12px;background:var(--surface-2);border-radius:8px 8px 0 0;font-size:12px;color:var(--muted);border:1px solid var(--line-soft);border-bottom:none;';
        topBar.innerHTML = '<span>PDF Preview (Encrypted/Signed PDFs require opening directly)</span>' +
          '<div style="display:flex;gap:8px;">' +
          '<a href="' + url + '" target="_blank" rel="noopener" class="btn sm btn-primary" style="text-decoration:none;">Open in PDF Viewer</a>' +
          '<a href="' + url + (url.indexOf('?') >= 0 ? '&' : '?') + 'download=1" class="btn sm" style="text-decoration:none;">Download</a>' +
          '</div>';
        container.appendChild(topBar);

        w = document.createElement('iframe');
        w.className = 'qv-pdf-frame';
        w.title = it.name;
        w.src = url;
        w.style.cssText = 'width:100%;flex:1;border:1px solid var(--line-soft);border-radius:0 0 8px 8px;background:#fff;min-height:300px;';
        container.appendChild(w);
        body.appendChild(container);
      }
    } else if (G.editor && G.editor.isTextLike(it.name) && (it.size == null || it.size < 2 * 1024 * 1024)) {
      w = document.createElement('pre'); w.className = 'qv-text'; w.textContent = T('qv.loading');
      body.appendChild(w);
      fetch(G.url('f/' + String(it.path).replace(/^\/+/, '')) + (it.path.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now(), { method: 'GET', cache: 'no-store', credentials: 'same-origin' }).then(function (resp) {
        if (resp.ok) return resp.text();
        return Promise.reject(resp);
      }).then(function (txt) {
        body.textContent = '';
        if (G.editor.readonlyMount) G.editor.readonlyMount(body, it.name, txt);
        else { w.textContent = txt; body.appendChild(w); }
      }, function () { w.textContent = T('err.loadFile'); });
    } else {
      w = document.createElement('div'); w.className = 'qv-msg';
      var m2 = document.createElement('div'); m2.textContent = T('qv.noPreview');
      btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-primary';
      btn.textContent = T('menu.download');
      btn.addEventListener('click', function () { A.act_download(it); });
      w.appendChild(m2); w.appendChild(btn);
      body.appendChild(w);
    }
  };
  V.step = function (d) { if (qv.open) V.show(qv.idx + d); };
  V.close = function () {
    qv.open = false;
    var el = $('quickview');
    if (el) { el.hidden = true; el.classList.remove('open'); }
    var body = $('qv-body');
    if (body) body.textContent = '';
  };
  A.quickviewClose = V.close;
  A.quickviewStep = V.step;
  A.quickviewShow = V.show;
  A.quickviewKey = function (e) {
    if (!qv.open) return false;
    if (e.key === 'Escape') { V.close(); return true; }
    if (e.key === 'ArrowRight') { V.step(1); return true; }
    if (e.key === 'ArrowLeft') { V.step(-1); return true; }
    return false;
  };
  V.wire = function () {
    var el = $('quickview');
    if (el) {
      var x = el.querySelector('.qv-close');
      if (x) x.addEventListener('click', V.close);
      el.addEventListener('mousedown', function (e) { if (e.target === el) V.close(); });
    }
  };

  /* ---------- settings sheet (defensive build if markup missing) ---------- */
  A.applySettings = function (patch) {
    if (patch.theme) G.applyTheme(patch.theme);
    if (patch.density) {
      st().density = patch.density;
      G.LS.set('gofm.density', patch.density);
      try { document.documentElement.dataset.density = patch.density; } catch (e) { }
    }
    if (patch.lang) {
      st().lang = patch.lang;
      G.LS.set('gofm.lang', patch.lang);
      if (G.loadLang) G.loadLang(patch.lang);
    }
    if (G.apiEP && G.apiEP.pref) G.apiEP.pref(st().theme, st().lang, st().density).then(function () { }, function () { });
  };
  A.act_settings = function () {
    var sheet = $('settings-sheet');
    if (!sheet) { G.warnOnce('settings', '#settings-sheet missing'); return; }
    if (!sheet.querySelector('#set-theme')) {
      var fld = function (id, label, opts, val) {
        return '<label class="fld"><span class="fld-l">' + E(label) + '</span><select id="' + id + '">' +
          opts.map(function (o) {
            return '<option value="' + E(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + E(o[1]) + '</option>';
          }).join('') + '</select></label>';
      };
      sheet.innerHTML = '<div class="sheet-head"><span>' + E(T('settings.title')) + '</span>' +
        '<button type="button" class="btn sm" id="set-close" aria-label="' + E(T('btn.close')) + '">\u00d7</button></div>' +
        fld('set-theme', T('set.theme'), [['auto', T('theme.auto')], ['light', T('theme.light')], ['dark', T('theme.dark')]], st().theme) +
        fld('set-lang', T('set.lang'), [['en', 'English']], st().lang) +
        fld('set-density', T('set.density'), [['comfortable', T('density.comfy')], ['compact', T('density.compact')]], st().density) +
        '<label class="fld chk"><span class="fld-l">' + E(T('set.hidden')) + '</span><input type="checkbox" id="set-hidden"' + (st().showHidden ? ' checked' : '') + '></label>' +
        '<button type="button" class="btn danger" id="set-logout">' + E(T('btn.logout')) + '</button>';
    }
    var open = !!sheet.hidden || !sheet.classList.contains('open');
    sheet.hidden = !open;
    sheet.classList.toggle('open', open);
    if (!open) return;
    var q = function (id) { return sheet.querySelector('#' + id); };
    function bind(id, fn) {
      var el = q(id);
      if (el && !el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('change', function () { fn(el); }); }
    }
    bind('set-theme', function (el) { A.applySettings({ theme: el.value }); });
    bind('set-lang', function (el) { A.applySettings({ lang: el.value }); });
    bind('set-density', function (el) { A.applySettings({ density: el.value }); });
    bind('set-chunk', function (el) {
      var mb = Number(el.value) || 1;
      st().config.chunk_bytes = mb * 1024 * 1024;
      G.LS.set('gofm.chunk', String(mb));
    });
    bind('set-extract', function (el) { G.LS.set('gofm.extract', el.value); });
    bind('set-hidden', function (el) {
      st().showHidden = !!el.checked;
      G.LS.set('gofm.hidden', el.checked ? '1' : '0');
      if (G.browser) G.browser.render();
    });
    /* Save commits chunk size + extract pref and closes the sheet */
    var sv = $('settings-save');
    if (sv && !sv.dataset.wired) {
      sv.dataset.wired = '1';
      sv.addEventListener('click', function () {
        var ck = $('set-chunk');
        if (ck) {
          var mb = Number(ck.value) || 1;
          st().config.chunk_bytes = mb * 1024 * 1024;
          G.LS.set('gofm.chunk', String(mb));
        }
        var ex = $('set-extract');
        if (ex) G.LS.set('gofm.extract', ex.value);
        sheet.hidden = true;
        sheet.classList.remove('open');
        G.toast(T('btn.apply'), { kind: 'success' });
      });
    }
    /* click-outside dismiss */
    var back = sheet.querySelector('.sheet-backdrop');
    if (back && !back.dataset.wired) {
      back.dataset.wired = '1';
      back.addEventListener('click', function () {
        sheet.hidden = true;
        sheet.classList.remove('open');
      });
    }
    var lo = q('set-logout');
    if (lo && !lo.dataset.wired) { lo.dataset.wired = '1'; lo.addEventListener('click', function () { A.act_logout(); }); }
    var x = q('set-close');
    if (x && !x.dataset.wired) { x.dataset.wired = '1'; x.addEventListener('click', function () { sheet.hidden = true; sheet.classList.remove('open'); }); }
    G.applyI18n(sheet);
  };

  /* ---------- theme cycle ---------- */
  A.act_theme = function () {
    var order = ['auto', 'light', 'dark'];
    var nt = order[(order.indexOf(st().theme) + 1) % order.length];
    A.applySettings({ theme: nt });
    G.toast(T('theme.set', { t: T('theme.' + nt) }));
  };

  /* ---------- login / logout ---------- */
  A.act_logout = function () {
    if (G.apiEP && G.apiEP.logout) G.apiEP.logout().then(function () { }, function () { });
    st().me = null;
    st().signedIn = false;
    st().admin = false;
    st().guest = true;
    st().perms = { r: false, u: false, w: false, d: false };
    document.documentElement.classList.add('is-guest');

    // Close admin sheet if open
    if (G.admin && G.admin.close) G.admin.close();

    // Close user menu and hide admin entry
    var um = $('user-menu');
    if (um) {
      um.hidden = true;
      um.classList.remove('open');
      var admBtn = um.querySelector('[data-action=admin]');
      if (admBtn) admBtn.hidden = true;
    }

    // Toggle user avatar and signin button
    var ub = $('user-btn');
    if (ub) { ub.hidden = true; ub.setAttribute('aria-expanded', 'false'); }
    var si = $('signin-btn');
    if (si) si.hidden = false;
    var ua = $('user-avatar');
    if (ua) { ua.textContent = '?'; ua.title = ''; }

    // Update permission-dependent UI
    if (G.syncPermUI) G.syncPermUI();

    /* Signing out of a server with a shared folder should land back in the
       guest view, not on a login wall the visitor cannot get past. */
    G.api('api/shared').then(function (x) {
      if (x && x.ok && x.dir) {
        A.showLogin.hide && A.showLogin.hide();
        var l = $('login');
        if (l) l.hidden = true;
        var app = $('app');
        if (app) { app.hidden = false; app.classList.add('ready'); }
        if (G.browser && G.browser.loadDir) {
          G.browser.loadDir(x.dir);
        } else if (G.router) {
          G.router.go(x.dir);
        }
        return;
      }
      A.showLogin();
    }, function () { A.showLogin(); });
  };
  /* ---------- first-run setup (no accounts configured yet) ---------- */
  A.showSetup = function () {
    var s = $('setup');
    if (!s) { A.showLogin(); return; }
    s.hidden = false;
    var app = $('app');
    if (app) app.hidden = true;
    var l = $('login');
    if (l) l.hidden = true;
    var u = $('setup-user'), p = $('setup-pass'), p2 = $('setup-pass2'), er = $('setup-err');
    if (er) er.textContent = '';
    setTimeout(function () { try { if (u) u.focus(); } catch (e) { } }, 50);
    if (s.dataset.wired) return;
    s.dataset.wired = '1';
    var f = $('setup-form');
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var user = u ? u.value.trim() : '', a1 = p ? p.value : '', a2 = p2 ? p2.value : '';
      if (!user) { if (er) er.textContent = 'Choose a username'; return; }
      if (!a1) { if (er) er.textContent = 'Password required'; return; }
      if (a1 !== a2) { if (er) er.textContent = 'Passwords do not match'; return; }
      var btn = $('setup-btn');
      if (btn) btn.disabled = true;
      G.api('api/setup', { method: 'POST', body: { user: user, pass: a1 } }).then(function (r) {
        if (r && r.ok) {
          s.hidden = true;
          return G.boot.afterLogin();
        }
        if (btn) btn.disabled = false;
        if (er) er.textContent = (r && r.error && r.error.message) || 'Setup failed';
      }, function (e2) {
        if (btn) btn.disabled = false;
        if (er) er.textContent = (e2 && e2.error && e2.error.message) || 'Setup failed';
      });
    });
  };

  /* showLogin(true) renders the form over the guest view as a modal; the
     default (no argument) is the full-page takeover used when nothing at all
     is shared. */
  A.showLogin = function (asModal) {
    var l = $('login');
    if (!l) { G.warnOnce('login', '#login missing'); return; }
    l.hidden = false;
    l.classList.toggle('as-modal', !!asModal);
    var app = $('app');
    // a guest signing in must NOT lose the file list behind the form
    if (app && !asModal) app.hidden = true;
    var u = $('login-user'), p = $('login-pass'), er = $('login-err'), c = $('login-csrf');
    if (er) er.textContent = '';
    setTimeout(function () { try { if (u) u.focus(); } catch (e) { } }, 50);
    var x = $('login-close');
    if (x && !x.dataset.wired) {
      x.dataset.wired = '1';
      x.addEventListener('click', function () {
        l.hidden = true;
        l.classList.remove('as-modal');
      });
    }
    if (asModal && !l.dataset.modalWired) {
      l.dataset.modalWired = '1';
      l.addEventListener('mousedown', function (e) {
        if (e.target === l) { l.hidden = true; l.classList.remove('as-modal'); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !l.hidden && l.classList.contains('as-modal')) {
          l.hidden = true; l.classList.remove('as-modal');
        }
      });
    }
    /* Bind the form exactly once. This guard must come AFTER the modal
       wiring above, which has to run on every call — otherwise the second
       invocation (guest pressing Sign in) would return before binding the
       submit handler and the button would do nothing. */
    if (l.dataset.wired) return;
    l.dataset.wired = '1';
    function submit(e) {
      if (e) e.preventDefault();
      var user = u ? u.value.trim() : '', pass = p ? p.value : '';
      if (!user) { if (er) er.textContent = T('login.needUser'); return; }
      if (c && c.value) G.state.csrf = c.value;
      if (er) er.textContent = T('login.working');
      G.apiEP.login(user, pass).then(function (r) {
        if (okToast(r)) {
          G.state.signedIn = true;
          G.state.guest = false;
          if (r.csrf) G.state.csrf = r.csrf;
          l.hidden = true;
          l.classList.remove('as-modal');
          // leave guest mode: sidebar and avatar come back
          var de = document.documentElement;
          if (de) de.classList.remove('is-guest');
          var ub = $('user-btn'); if (ub) ub.hidden = false;
          var si = $('signin-btn'); if (si) si.hidden = true;
          if (p) p.value = '';
          if (G.boot && G.boot.afterLogin) G.boot.afterLogin();
        } else if (er) er.textContent = msg(r, 'login.failed');
      });
    }
    var form = l.querySelector('form');
    if (form) form.addEventListener('submit', submit);
    var btnL = $('login-submit');
    if (btnL) btnL.addEventListener('click', submit);
  };
  // full-page variant wires the same form, for the no-share case
  A.showLoginFull = function () { A.showLogin(false); };
})(window.GOFM);
