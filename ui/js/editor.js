'use strict';
/* GoFM editor: Solid single-instance Ace editor w/ robust textarea fallback. */
window.GOFM = window.GOFM || {};
(function (G) {
  var ED = G.editor = {};
  var E = G.escapeHtml, T = G.t;
  function $(id) { return document.getElementById(id); }
  function st() { return G.state; }

  var TEXT_EXT = {
    txt: 1, md: 1, markdown: 1, json: 1, jsonl: 1, yaml: 1, yml: 1, toml: 1, ini: 1, conf: 1, cfg: 1, properties: 1, env: 1,
    js: 1, mjs: 1, cjs: 1, ts: 1, jsx: 1, tsx: 1, css: 1, scss: 1, less: 1, xml: 1, html: 1, htm: 1, go: 1, py: 1, rb: 1, php: 1,
    sh: 1, bash: 1, zsh: 1, fish: 1, sql: 1, c: 1, h: 1, cpp: 1, hpp: 1, cc: 1, rs: 1, java: 1, kt: 1, swift: 1, lua: 1, r: 1, pl: 1,
    csv: 1, log: 1, gitignore: 1, dockerfile: 1, makefile: 1, mk: 1, patch: 1, diff: 1, svg: 1, tf: 1, gradle: 1, bat: 1, ps1: 1,
    service: 1, timer: 1, socket: 1, editorconfig: 1, npmignore: 1, lock: 1, sum: 1, mod: 1, httpp: 1
  };
  ED.MAX_EDIT = 2 * 1024 * 1024;
  ED.canEdit = function (item) {
    if (!item || item.is_dir) return false;
    var al = (st().config && st().config.allow) || {};
    if (al.edit === false) return false;
    if (!ED.isTextLike(item.name)) return false;
    if (item.size != null && item.size > ED.MAX_EDIT) return false;
    return true;
  };
  ED.isTextLike = function (name) {
    var n = String(name || '').toLowerCase();
    if (TEXT_EXT[G.extOf(n)]) return true;
    if (/\.(psd|pdf|zip|tar|gz|tgz|7z|rar|bz2|xz|iso|exe|dll|so|deb|rpm|apk|dmg|msi|png|jpe?g|gif|webp|bmp|ico|avif|mp4|mkv|webm|mov|avi|m4v|mp3|wav|ogg|flac|m4a|aac|opus|docx?|xlsx?|pptx?|odt|ods|odp|ttf|otf|woff2?|eot|db|sqlite|bin|img|iso)$/i.test(n)) {
      return false;
    }
    return !/\.[a-z0-9]{3,6}$/i.test(n);
  };

  var MODE_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', jsonl: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', xml: 'xml',
    md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'sh', bash: 'sh', zsh: 'sh',
    sql: 'sql', go: 'golang', py: 'python', c: 'c_cpp', h: 'c_cpp', cpp: 'c_cpp', hpp: 'c_cpp', cc: 'c_cpp', rs: 'rust',
    dockerfile: 'dockerfile', ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini', php: 'php', rb: 'ruby',
    java: 'java', lua: 'lua', r: 'r', pl: 'perl', swift: 'swift', kt: 'kotlin', svg: 'xml', ps1: 'powershell', bat: 'batchfile',
    scss: 'scss', less: 'less', mk: 'makefile', tf: 'text'
  };
  function modeFor(name) {
    var ext = G.extOf(String(name || '').toLowerCase());
    if (String(name || '').toLowerCase() === 'dockerfile' || String(name || '').toLowerCase() === 'makefile') {
      return MODE_MAP[name.toLowerCase()] || (name.toLowerCase() === 'makefile' ? 'makefile' : 'dockerfile');
    }
    return MODE_MAP[ext] || 'text';
  }

  function acePresent() {
    return (typeof window.ace !== 'undefined') && window.ace && typeof window.ace.edit === 'function';
  }

  var aceEd = null, aceHost = null, ta = null, gutter = null;
  var cur = { path: null, name: '', dirty: false, etag: null, lastSave: 0, open: false, loading: false };
  ED.current = cur;

  function initFallbackGutter() {
    ta = $('ed-code');
    gutter = $('ed-lines');
    if (ta && !ta.dataset.wired) {
      ta.dataset.wired = '1';
      ta.addEventListener('input', function () {
        if (!cur.loading && cur.open) {
          cur.dirty = true;
          paintGutter();
          setStatus();
        }
      });
      ta.addEventListener('scroll', function () { if (gutter) gutter.scrollTop = ta.scrollTop; });
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); ED.save(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          var s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 2;
          cur.dirty = true;
          paintGutter();
        }
      });
    }
  }

  function paintGutter() {
    if (!gutter || !ta) return;
    var n = ta.value.split('\n').length;
    if (gutter.childElementCount !== n || gutter.dataset.n !== String(n)) {
      var s = '';
      for (var i = 1; i <= n; i++) s += i + '\n';
      gutter.textContent = s;
      gutter.dataset.n = String(n);
    }
  }

  function initAce() {
    if (aceEd) return aceEd;
    if (!acePresent()) return null;
    var edEditor = $('ed-editor');
    if (!edEditor) return null;
    try {
      if (window.ace.config && window.ace.config.set) {
        window.ace.config.set('useWorker', false);
        window.ace.config.set('basePath', G.url('/assets/ace'));
      }
      aceHost = $('ed-ace');
      if (!aceHost) {
        aceHost = document.createElement('div');
        aceHost.id = 'ed-ace';
        aceHost.className = 'ed-ace';
        aceHost.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;background:var(--code-bg);';
        edEditor.appendChild(aceHost);
      }
      aceEd = window.ace.edit(aceHost);
      aceEd.setOptions({
        useWorker: false,
        showLineNumbers: true,
        showPrintMargin: false,
        displayIndentGuides: true,
        wrap: false,
        highlightActiveLine: true
      });
      aceEd.setFontSize('13px');
      var theme = (document.documentElement.dataset.theme === 'dark') ? 'twilight' : 'chrome';
      try { aceEd.setTheme('ace/theme/' + theme); } catch (e) { }
      aceEd.on('change', function () {
        if (!cur.loading && cur.open) {
          cur.dirty = true;
          setStatus();
        }
      });
      aceEd.commands.addCommand({
        name: 'gofiles-save',
        bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
        exec: function () { ED.save(); }
      });
      return aceEd;
    } catch (e) {
      aceEd = null;
      return null;
    }
  }

  function setStatus(extra) {
    var el = $('ed-status');
    if (!el) return;
    var content = currentContent();
    var lines = content ? content.split('\n').length : 0;
    var parts = [
      T('ed.size', { n: G.fmtSize(new Blob([content || '']).size) }),
      T('ed.lines', { n: lines }),
      cur.lastSave ? T('ed.savedAt', { t: G.fmtDate(cur.lastSave / 1000) }) : (cur.dirty ? T('ed.unsaved') : T('ed.ready'))
    ];
    if (cur.backup) parts.push(T('ed.backup', { n: cur.backup }));
    if (extra) parts.push(extra);
    el.textContent = parts.join(' · ');
    el.classList.toggle('dirty', cur.dirty);
  }

  function currentContent() {
    if (aceEd && aceHost && !aceHost.hidden) {
      return aceEd.getValue();
    }
    if (ta) return ta.value;
    return '';
  }
  ED.getContent = currentContent;

  ED.onThemeChange = function (eff) {
    try { if (aceEd) aceEd.setTheme('ace/theme/' + (eff === 'dark' ? 'twilight' : 'chrome')); } catch (e) { }
  };

  /* ---------- openEdit ---------- */
  ED.openEdit = function (item) {
    if (!item) return;
    if (!ED.canEdit(item)) {
      if (item.size != null && item.size > ED.MAX_EDIT) {
        G.toast(T('ed.tooBig', { n: G.fmtSize(item.size) }), { kind: 'warn', ms: 5000 });
      }
      if (G.actions && G.actions.quickview) G.actions.quickview(item);
      return;
    }

    var el = $('editor');
    if (!el) return;

    if (G.actions && G.actions.quickviewClose) G.actions.quickviewClose();

    initFallbackGutter();
    var ed = initAce();

    var path = item.path, name = item.name;
    var nm = $('ed-name');
    if (nm) {
      if ('value' in nm) nm.value = name;
      else nm.textContent = name;
    }

    el.hidden = false;
    el.classList.add('open');

    cur.loading = true;
    cur.dirty = false;
    cur.path = path;
    cur.name = name;

    // Cache-busting parameter guarantees freshly edited content from disk
    var fetchUrl = G.url('f/' + String(path).replace(/^\/+/, '')) + (path.indexOf('?') >= 0 ? '&' : '?') + '_nc=' + Date.now();
    fetch(fetchUrl, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) {
        bad({ error: { message: 'HTTP ' + resp.status } });
        return null;
      }
      cur.etag = resp.headers.get('etag');
      return resp.text();
    }).then(function (text) {
      if (text == null) return;
      var badEnc = /\u0000/.test(text) || /\uFFFD/.test(text.slice(0, 4096));
      if (badEnc) { G.toast(T('ed.binary'), { kind: 'error' }); ED.close(true); return; }

      cur.backup = null;
      cur.dirty = false;
      cur.lastSave = 0;

      if (ed && aceHost) {
        try {
          var m = modeFor(name);
          ed.session.setMode('ace/mode/' + m);
        } catch (e) { }
        aceHost.hidden = false;
        ed.setValue(text, -1);
        ed.clearSelection();
        if (ta) ta.hidden = true;
        if (gutter) gutter.hidden = true;
        ed.resize();
        ed.renderer.updateFull();
        setTimeout(function () {
          try { ed.resize(); ed.renderer.updateFull(); ed.focus(); } catch (e) { }
        }, 30);
      } else {
        if (aceHost) aceHost.hidden = true;
        if (ta) {
          ta.hidden = false;
          ta.value = text;
          ta.readOnly = false;
        }
        if (gutter) {
          gutter.hidden = false;
          paintGutter();
        }
        if (ta) ta.focus();
      }

      cur.loading = false;
      cur.open = true;
      cur.dirty = false;
      setStatus();
    })['catch'](function (e) {
      cur.loading = false;
      bad({ error: { message: String((e && e.message) || e) } });
    });

    function bad(r) {
      G.toast((r && r.error && r.error.message) || T('err.loadFile'), { kind: 'error' });
      ED.close(true);
    }
  };

  ED.isOpen = function () {
    return cur.open && !!cur.path && $('editor') && !$('editor').hidden;
  };

  /* ---------- save ---------- */
  ED.renameIfChanged = function () {
    var el = $('ed-name');
    if (!el || !('value' in el) || !cur.path) return Promise.resolve(false);
    var next = String(el.value || '').trim();
    var curName = G.baseName(cur.path);
    if (!next || next === curName) return Promise.resolve(false);
    var parent = cur.path.slice(0, cur.path.lastIndexOf('/')) || '/';
    return G.apiEP.rename(cur.path, parent + '/' + next).then(function (r) {
      if (r && r.ok) {
        cur.path = (r.path || parent + '/' + next);
        cur.name = G.baseName(cur.path);
        return true;
      }
      if ('value' in el) el.value = curName;
      return false;
    }, function () {
      if ('value' in el) el.value = curName;
      return false;
    });
  };

  ED.save = function (forceOverwrite) {
    if (!cur.path) return;
    var content = currentContent();
    var btn = $('ed-save');
    if (btn) btn.disabled = true;

    Promise.resolve(ED.renameIfChanged()).then(function () {
      var path = cur.path;
      var headers = {};
      if (cur.etag && !forceOverwrite) headers['If-Match'] = cur.etag;
      G.api('api/save', {
        method: 'POST',
        body: { path: path, content: content, backup: true },
        headers: headers
      }).then(function (r) {
        if (btn) btn.disabled = false;
        if (r && r.ok) {
          cur.dirty = false;
          cur.lastSave = Date.now();
          if (r.backup) cur.backup = r.backup;
          if (r.etag) cur.etag = r.etag;
          setStatus();
          G.toast(T('ed.saved', { n: G.baseName(cur.path) }));
          if (G.browser && G.browser.refresh) G.browser.refresh();
          return;
        }
        var http = (r && r.error && r.error.http) || r.http || r.status;
        if (http === 412 && !forceOverwrite) {
          conflictModal();
          return;
        }
        G.toast((r && r.error && r.error.message) || T('err.save'), { kind: 'error', ms: 6000 });
      }, function () {
        if (btn) btn.disabled = false;
        G.toast(T('err.save'), { kind: 'error' });
      });
    });
  };

  function conflictModal() {
    if (!G.actions.openModal) return;
    G.actions.openModal({
      title: T('ed.conflictT'),
      className: 'modal-warn',
      body: '<p>' + E(T('ed.conflict')) + '</p>',
      buttons: [
        { label: T('btn.cancel') },
        {
          label: T('ed.reload'), onClick: function (m) {
            m.close();
            var it = { path: cur.path, name: cur.name, size: null };
            cur.dirty = false;
            ED.openEdit(it);
          }
        },
        {
          label: T('ed.overwrite'), danger: true, primary: true, onClick: function (m) {
            m.close();
            ED.save(true);
          }
        }
      ]
    });
  }

  /* ---------- close ---------- */
  ED.close = function (force) {
    if (cur.dirty && !force) {
      if (G.actions.openModal) {
        G.actions.openModal({
          title: T('ed.unsavedT'),
          body: '<p>' + E(T('ed.unsavedQ')) + '</p>',
          buttons: [
            { label: T('btn.cancel') },
            { label: T('ed.discard'), danger: true, onClick: function (m) { m.close(); ED.close(true); } },
            { label: T('ed.save2'), primary: true, onClick: function (m) { m.close(); ED.save(); } }
          ]
        });
        return;
      }
    }
    cur.dirty = false;
    cur.open = false;
    cur.path = null;
    cur.name = '';
    var el = $('editor');
    if (el) {
      el.hidden = true;
      el.classList.remove('open');
    }
    if (ta) ta.value = '';
    if (gutter) gutter.textContent = '';
  };
  ED.isDirty = function () { return cur.dirty; };

  /* ---------- read-only mount for quickview ---------- */
  ED.readonlyMount = function (host, name, text) {
    var pre = document.createElement('pre');
    pre.className = 'qv-text';
    pre.style.cssText = 'width:100%;max-width:min(94vw, 1100px);max-height:calc(88vh - 80px);overflow:auto;padding:16px;background:var(--code-bg);color:var(--text);border-radius:8px;font:13px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;border:1px solid var(--line-soft);margin:0 auto;box-sizing:border-box;';
    pre.textContent = text;
    host.appendChild(pre);
    return function () { };
  };
})(window.GOFM);
