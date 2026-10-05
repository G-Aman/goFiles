'use strict';
/* GoFM actions: modal system + ctx/toolbar actions (mkdir,newfile,rename,move,copy,delete,compress,extract,urlfetch,download,newcopy,chmod,props,hash). */
window.GOFM = window.GOFM || {};
(function (G) {
  var A = G.actions = G.actions || {};
  var E = G.escapeHtml, T = G.t;
  function st() { return G.state; }
  function al() {
    var a = (st().config && st().config.allow);
    if (!a || typeof a !== 'object') {
      return { write: true, delete: true, upload: true, urlfetch: true, archive: true, extract: true, edit: true, chmod: true, hash: true, webdav: true };
    }
    return a;
  }
  function msg(r, fb) { return (r && r.error && r.error.message) || T(fb); }
  function bad(r, fb) { G.toast(msg(r, fb), { kind: 'error' }); }
  function B_refresh() { if (G.browser && G.browser.refresh) G.browser.refresh(); }
  function targets(item) {
    if (G.browser) {
      var sel = G.browser.selectedItems();
      if (sel.length > 1) return sel;
    }
    return item ? [item] : (G.browser ? G.browser.selectedItems() : []);
  }

  /* ---------- permission gating ---------- */
  /* Capability check. The server sends perms {r,u,w,d} from acl.conf, where
     "u" (upload new files) is deliberately separate from "w" (modify existing)
     and "d" (delete). A read-only or drop-box folder must hide the controls
     it cannot use rather than offering actions that 403. */
  G.canAction = function (action, items) {
    items = items || [];
    var a = al(), p = st().perms || {};
    var pr = !!p.r, pu = !!p.u, pw = !!p.w, pd = !!p.d;
    var any = items.length > 0, one = items.length === 1;
    var arch = any && items.every(function (i) { return /\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(String(i.name)); });
    switch (action) {
      case 'open': case 'quickview': case 'download': return any && pr;
      case 'props': return one && pr;
      case 'hash': return any && pr && !!a.hash;
      // creating something new needs the upload bit
      case 'upload': case 'upload-folder': case 'mkdir': case 'newfile':
        return pu && !!a.upload;
      case 'url': return pu && !!a.urlfetch;
      // editing needs write bit + text file
      case 'edit': return pw && !!a.edit && one && (G.editor && G.editor.canEdit ? G.editor.canEdit(items[0]) : true);
      // modifying something that already exists needs the write bit
      case 'newcopy': return pw && !!a.write && one && !items[0].is_dir;
      case 'rename': return pw && !!a.write && one;
      case 'copy': return pw && !!a.write && any;
      // a move relocates: it modifies the source, so it is a write
      case 'move': return pw && !!a.write && any;
      case 'compress':
    case 'compress-zip': case 'compress-tar': return pu && !!a.archive && any;
      case 'extract-here': case 'extract-folder': return pw && !!a.extract && one && arch;
      case 'chmod': return pw && !!a.chmod && one;
      case 'delete': return pd && !!a.delete && any;
      case 'settings': case 'theme': case 'logout': return true;
      default: return false;
    }
  };

  /* ---------- modal system (stack + focus trap + Esc) ---------- */
  var stack = [];
  G.modals = { openCount: function () { return stack.length; }, top: function () { return stack[stack.length - 1]; } };
  A.openModal = function (opt) {
    opt = opt || {};
    var root = document.getElementById('modal-root');
    if (!root) { G.warnOnce('modal', '#modal-root missing'); return null; }
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    var card = document.createElement('div');
    card.className = 'modal' + (opt.className ? ' ' + opt.className : '');
    card.style.position = 'relative';
    if (opt.closeBtn !== false) {
      var xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.className = 'btn btn-icon modal-x-btn';
      xBtn.setAttribute('aria-label', G.t('btn.close') || 'Close');
      xBtn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:10;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:transparent;border:none;color:var(--muted);cursor:pointer;';
      xBtn.innerHTML = '<svg class="i" width="18" height="18" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      xBtn.addEventListener('click', function() { close(); });
      card.appendChild(xBtn);
    }
    if (opt.title) {
      var h = document.createElement('h2'); h.className = 'modal-title'; h.textContent = opt.title || '';
      card.appendChild(h);
    }
    var body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof opt.body === 'string') body.innerHTML = opt.body; /* only escapeHtml'd fragments */
    else if (opt.body && opt.body.nodeType) body.appendChild(opt.body);
    card.appendChild(body);
    var btns = document.createElement('div');
    btns.className = 'modal-btns' + (opt.centerButtons ? ' modal-btns-center' : '');
    if (opt.centerButtons) {
      btns.style.justifyContent = 'center';
    }
    (opt.buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '');
      if (b.icon) {
        el.innerHTML = '<svg class="i" width="16" height="16" viewBox="0 0 24 24" style="margin-right:6px;vertical-align:-2px;"><use href="' + b.icon + '"/></svg><span>' + G.escapeHtml(b.label) + '</span>';
      } else {
        el.textContent = b.label;
      }
      if (typeof b.onClick === 'function') el.addEventListener('click', function () { b.onClick(ctx); });
      else el.addEventListener('click', function () { close(); });
      btns.appendChild(el);
    });
    card.appendChild(btns);
    var form = card.querySelector('form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var primary = btns.querySelector('.btn-primary');
        if (primary) primary.click();
      });
    }
    wrap.appendChild(card);
    root.appendChild(wrap);
    var ctx = { wrap: wrap, body: body, modal: card, close: close };
    stack.push(ctx);
    function close() {
      var i = stack.indexOf(ctx);
      if (i >= 0) stack.splice(i, 1);
      wrap.remove();
      if (typeof opt.onClose === 'function') { try { opt.onClose(); } catch (e) { } }
      var prev = stack[stack.length - 1];
      if (prev && prev.lastFocus && prev.lastFocus.focus) { try { prev.lastFocus.focus(); } catch (e) { } }
    }
    ctx.lastFocus = document.activeElement;
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap && opt.dismissable !== false) close(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        var f = card.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    setTimeout(function () {
      var x = card.querySelector('input,textarea,select,button.btn-primary,button');
      if (x) { try { x.focus(); if (x.select) x.select(); } catch (e) { } }
    }, 30);
    G.applyI18n(wrap);
    return ctx;
  };
  A.closeModal = function () { var m = G.modals.top(); if (m) m.close(); };
  A.closeAllModals = function () { while (stack.length) stack[stack.length - 1].close(); };

  function formHtml(fields) {
    return '<form class="mform">' + fields.map(function (f) {
      var inp;
      if (f.type === 'select') {
        inp = '<select name="' + E(f.name) + '">' + (f.options || []).map(function (o) {
          return '<option value="' + E(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + E(o.label) + '</option>';
        }).join('') + '</select>';
      } else {
        inp = '<input name="' + E(f.name) + '" type="' + E(f.type || 'text') + '" value="' + E(f.value != null ? f.value : '') + '" placeholder="' + E(f.placeholder || '') + '">';
      }
      return '<label class="fld"><span class="fld-l">' + E(f.label) + '</span>' + inp + '</label>';
    }).join('') + '</form>';
  }
  function fv(m) {
    var out = {};
    m.body.querySelectorAll('input,select').forEach(function (i) { out[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
    return out;
  }
  A.formHtml = formHtml;

  /* ---------- folder picker (lazy /api/list, only dirs) ---------- */
  A.pickFolder = function (title, startDir) {
    return new Promise(function (resolve) {
      var chosen = { path: null, done: false };
      var root = document.createElement('div');
      root.className = 'picker';
      root.innerHTML = '<div class="picker-crumbslot"></div>' +
        '<input type="text" class="pk-cur" value="' + E(startDir || '/') + '" aria-label="' + E(T('picker.target')) + '">' +
        '<div class="picker-list"></div>';
      function go(d) {
        root.querySelector('.pk-cur').value = d;
        var parts = String(d).split('/').filter(Boolean);
        var cb = root.querySelector('.picker-crumbslot');
        cb.innerHTML = '<div class="picker-crumb"><button type="button" class="pk-go" data-d="/">' + E(T('crumb.root')) + '</button>' +
          parts.map(function (p, i) {
            return ' / <button type="button" class="pk-go" data-d="' + E('/' + parts.slice(0, i + 1).join('/')) + '">' + E(p) + '</button>';
          }).join('') + '</div>';
        cb.querySelectorAll('.pk-go').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.d); }); });
        var host = root.querySelector('.picker-list');
        host.textContent = '';
        G.apiEP.list(d, { sort: 'name', asc: true }).then(function (res) {
          if (!res || !res.ok) { host.innerHTML = '<div class="picker-err">' + E(msg(res, 'err.loadDir')) + '</div>'; return; }
          if (String(d) !== '/') {
            var up = document.createElement('button');
            up.type = 'button'; up.className = 'pk-row'; up.textContent = '\u2026 ' + T('nav.up');
            up.addEventListener('click', function () {
              var p = String(d).replace(/\/+$/, '');
              go(p.slice(0, p.lastIndexOf('/')) || '/');
            });
            host.appendChild(up);
          }
          var dirs = (res.items || []).filter(function (i) { return i.is_dir; });
          if (!dirs.length) { var e = document.createElement('div'); e.className = 'picker-empty'; e.textContent = T('picker.empty'); host.appendChild(e); }
          dirs.forEach(function (it) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'pk-row';
            b.innerHTML = '<span class="ic ic-folder" aria-hidden="true"></span><span></span>';
            b.lastChild.textContent = it.name;
            b.addEventListener('click', function () { go(it.path); });
            host.appendChild(b);
          });
        });
      }
      A.openModal({
        title: title || T('picker.title'),
        body: root,
        buttons: [{ label: T('btn.cancel') }, {
          label: T('btn.choose'), primary: true, onClick: function (m) {
            chosen.path = m.body.querySelector('.pk-cur').value || '/';
            chosen.done = true;
            m.close();
          }
        }],
        onClose: function () { resolve(chosen.done ? chosen.path : null); }
      });
      go(startDir || '/');
    });
  };

  /* ---------- create / rename / delete ---------- */
  A.act_mkdir = function () {
    if (!G.canAction('mkdir', [])) return;
    A.openModal({
      title: T('mkdir.title'),
      body: formHtml([{ name: 'name', label: T('mkdir.name'), value: T('mkdir.default') }]),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.create'), primary: true, onClick: function (m) {
          var nm = (fv(m).name || '').trim();
          if (!nm) return;
          G.apiEP.mkdir(st().dir, nm).then(function (r) {
            if (r && r.ok) { m.close(); G.toast(T('mkdir.done', { n: nm })); B_refresh(); } else bad(r, 'err.mkdir');
          });
        }
      }]
    });
  };
  A.act_newfile = function () {
    if (!G.canAction('newfile', [])) return;
    A.openModal({
      title: T('newfile.title'),
      body: formHtml([{ name: 'name', label: T('newfile.name'), value: 'untitled.txt', placeholder: 'notes.md' }]),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.create'), primary: true, onClick: function (m) {
          var nm = (fv(m).name || '').trim();
          if (!nm) return;
          G.apiEP.create(st().dir, nm, '').then(function (r) {
            if (r && r.ok) { m.close(); G.toast(T('newfile.done', { n: nm })); B_refresh(); } else bad(r, 'err.create');
          });
        }
      }]
    });
  };
  A.act_rename = function (item) {
    var t = targets(item);
    if (t.length !== 1) return;
    if (G.canAction && !G.canAction('rename', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    var it = t[0];
    A.openModal({
      title: T('rename.title'),
      body: formHtml([{ name: 'to', label: T('rename.name'), value: it.name }]),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.rename'), primary: true, onClick: function (m) {
          var nv = (fv(m).to || '').trim();
          if (!nv || nv === it.name) { m.close(); return; }
          var parent = it.path.slice(0, it.path.lastIndexOf('/')) || '';
          G.apiEP.rename(it.path, parent + '/' + nv).then(function (r) {
            if (r && r.ok) { m.close(); B_refresh(); } else bad(r, 'err.rename');
          });
        }
      }]
    });
  };
  A.act_delete = function (item) {
    var t = targets(item);
    if (!t.length) return;
    if (G.canAction && !G.canAction('delete', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    A.openModal({
      title: T('delete.title', { n: t.length }),
      className: 'modal-danger',
      body: '<ul class="del-list">' + t.slice(0, 12).map(function (x) { return '<li>' + E(x.name) + '</li>'; }).join('') +
        (t.length > 12 ? '<li>' + E(T('delete.more', { n: t.length - 12 })) + '</li>' : '') + '</ul>' +
        (t.length > 1 ? '<p>' + E(T('delete.count', { n: t.length })) + '</p>' : ''),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.delete'), danger: true, primary: true, onClick: function (m) {
          var paths = t.map(function (x) { return x.path; });
          G.apiEP.del(paths).then(function (r) {
            if (r && r.ok) {
              m.close();
              if ((r.failed || []).length) G.toast(T('delete.partial', { ok: (r.done || []).length, bad: r.failed.length }), { kind: 'warn' });
              else G.toast(T('delete.done', { n: paths.length }));
              st().sel.clear();
              B_refresh();
            } else bad(r, 'err.delete');
          });
        }
      }]
    });
  };

  /* ---------- move / copy / new copy ---------- */
  A.act_moveto = function (item) { moveOrCopy('move', item); };
  A.act_copyto = function (item) { moveOrCopy('copy', item); };
  function moveOrCopy(kind, item) {
    var t = targets(item);
    if (!t.length) return;
    if (G.canAction && !G.canAction(kind === 'copy' ? 'copy' : 'move', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    A.pickFolder(kind === 'copy' ? T('copy.title') : T('move.title'), st().dir).then(function (to) {
      if (!to) return;
      var paths = t.map(function (x) { return x.path; });
      (kind === 'copy' ? G.apiEP.copy : G.apiEP.move)(paths, to).then(function (r) {
        if (!r || !r.ok) { bad(r, kind === 'copy' ? 'err.copy' : 'err.move'); return; }
        var failed = (r.failed || []).length;
        if (failed) G.toast(T('move.partial', { ok: (r.done || []).length, bad: failed }), { kind: 'warn', ms: 6000 });
        else G.toast(kind === 'copy' ? T('copy.done') : T('move.done'));
        if (kind === 'move') st().sel.clear();
        B_refresh();
      });
    });
  }
  A.act_newcopy = function (item) {
    var t = targets(item);
    if (t.length !== 1) return;
    G.apiEP.copy([t[0].path], st().dir).then(function (r) {
      if (r && r.ok) { G.toast(T('newcopy.done')); B_refresh(); } else bad(r, 'err.copy');
    });
  };

  /* ---------- compress / extract ---------- */
  A.act_compress = function (kind0, item) {
    var t = targets(item);
    if (!t.length) return;
    if (G.canAction && !G.canAction(kind0 === 'compress-tar' ? 'compress-tar' : 'compress-zip', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    var kind = kind0 === 'compress-tar' ? 'tar' : 'zip';
    var sug = t.length === 1 ? String(t[0].name).replace(/\.[^.]+$/, '') + '.' + kind : 'archive.' + kind;
    A.openModal({
      title: T('compress.title'),
      body: formHtml([
        { name: 'target', label: T('compress.name'), value: sug },
        { name: 'kind', label: T('compress.kind'), type: 'select', value: kind, options: [{ value: 'zip', label: 'Zip' }, { value: 'tar', label: 'Tar' }, { value: 'targz', label: 'Tar.gz' }] }
      ]),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.create'), primary: true, onClick: function (m) {
          var v = fv(m);
          G.apiEP.archive(t.map(function (x) { return x.path; }), v.kind || 'zip', st().dir, (v.target || '').trim()).then(function (r) {
            if (!r || !r.ok) { bad(r, 'err.compress'); return; }
            m.close();
            G.toast(r.job_id ? T('compress.started') : T('compress.done', { n: G.baseName(r.path || '') }));
            B_refresh();
          });
        }
      }]
    });
  };
  A.act_extract = function (mode, item) {
    var t = targets(item);
    if (t.length !== 1) return;
    if (G.canAction && !G.canAction(mode === 'folder' ? 'extract-folder' : 'extract-here', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    var ar = t[0];
    function doIt(to, unique) {
      G.apiEP.extract(ar.path, to, unique).then(function (r) {
        if (!r || !r.ok) { bad(r, 'err.extract'); return; }
        G.toast(r.job_id ? T('extract.started') : T('extract.done'));
        B_refresh();
      });
    }
    if (mode === 'here') { doIt('same', false); return; }
    A.openModal({
      title: T('extract.title'),
      body: '<form class="mform"><label class="rad"><input type="radio" name="ex" value="u" checked><span>' + E(T('extract.unique')) + '</span></label>' +
        '<label class="rad"><input type="radio" name="ex" value="t"><span>' + E(T('extract.target')) + '</span></label></form>',
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.extract'), primary: true, onClick: function (m) {
          var u = m.body.querySelector('input[name=ex]:checked');
          m.close();
          if (u && u.value === 'u') doIt('same', true);
          else A.pickFolder(T('extract.target'), st().dir).then(function (to) { if (to) doIt(to, false); });
        }
      }]
    });
  };

  /* ---------- urlfetch ---------- */
  A.act_urlfetch = function () {
    if (!G.canAction('url', [])) return;
    A.openModal({
      title: T('url.title'),
      body: formHtml([{ name: 'url', label: T('url.label'), placeholder: 'https://example.com/file.zip' }, { name: 'dir', label: T('url.dir'), value: st().dir }]),
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.addJob'), primary: true, onClick: function (m) {
          var v = fv(m), u = (v.url || '').trim();
          if (!/^https?:\/\//i.test(u)) { G.toast(T('url.bad'), { kind: 'error' }); return; }
          G.apiEP.urlfetch(u, v.dir || st().dir).then(function (r) {
            if (r && r.ok && r.job_id) {
              m.close();
              G.toast(T('url.started'));
              if (G.jobs && G.jobs.awaitResult) {
                G.jobs.awaitResult(r.job_id).then(function () {
                  if (G.browser && G.browser.refresh) {
                    try { G.browser.refresh(); } catch (e) { }
                  }
                }, function () { });
              }
            } else {
              bad(r, 'err.urlfetch');
            }
          });
        }
      }]
    });
  };

  /* ---------- download ---------- */
  A.act_download = function (item) {
    var t = targets(item);
    if (!t.length) return;
    if (t.length === 1 && !t[0].is_dir) { A.triggerDownload(G.apiEP.downloadURL(t[0].path)); return; }
    G.apiEP.archive(t.map(function (x) { return x.path; }), 'zip', st().dir, 'download.zip').then(function (r) {
      if (r && r.ok && r.path) return A.triggerDownload(G.apiEP.downloadURL(r.path));
      if (r && r.ok && r.job_id) {
        // async zip: wait for it, then download. A bare toast meant the
        // button appeared to do nothing.
        G.toast(T('download.job'), { kind: 'info' });
        if (!G.jobs || !G.jobs.awaitResult) return;
        return G.jobs.awaitResult(r.job_id).then(function (p) {
          if (p) A.triggerDownload(G.apiEP.downloadURL(p));
          else bad(r, 'err.download');
        }, function () { bad(r, 'err.download'); });
      }
      bad(r, 'err.download');
    });
  };
  A.triggerDownload = function (url) {
    var a = document.createElement('a');
    a.href = url; a.download = ''; a.style.display = 'none';
    document.body.appendChild(a);
    try { a.click(); } catch (e) { }
    setTimeout(function () { a.remove(); }, 4000);
  };

  /* ---------- chmod (3x3 rwx <-> octal live preview) ---------- */
  A.act_chmod = function (item) {
    var t = targets(item);
    if (t.length !== 1) return;
    if (G.canAction && !G.canAction('chmod', t)) { G.toast(T('err.readonly') || 'Permission denied', { kind: 'error' }); return; }
    var it = t[0];
    G.apiEP.stat(it.path).then(function (r) {
      var modeVal = (r && r.ok && r.item && r.item.mode != null) ? r.item.mode : (it.mode || 0);
      renderChmod(it, modeVal);
    }, function () {
      renderChmod(it, it.mode || 0);
    });
  };
  function renderChmod(it, initialMode) {
    var d = ('000' + Number(initialMode || 0).toString(8)).slice(-3).split('');
    var labels = [T('chmod.owner'), T('chmod.group'), T('chmod.other')];
    var body = document.createElement('div');
    body.className = 'chmod';
    var html = '<div class="chmod-grid"><div></div><div class="ch-h">r</div><div class="ch-h">w</div><div class="ch-h">x</div>';
    for (var r = 0; r < 3; r++) {
      html += '<div class="ch-r">' + E(labels[r]) + '</div>';
      for (var c = 0; c < 3; c++) {
        html += '<label class="ch-c"><input type="checkbox" data-rr="' + r + '" data-cc="' + c + '"' + ((parseInt(d[r], 10) & (4 >> c)) ? ' checked' : '') + '></label>';
      }
    }
    html += '</div><label class="fld"><span class="fld-l">' + E(T('chmod.octal')) + '</span><input type="text" class="ch-num" value="' + E(d.join('')) + '" maxlength="4"></label><div class="ch-preview"></div>';
    body.innerHTML = html;
    function rwx(s) {
      return s.split('').map(function (ch) {
        var n = parseInt(ch, 10);
        return (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-');
      }).join('');
    }
    function preview(s) { body.querySelector('.ch-preview').textContent = T('chmod.preview', { o: s, s: rwx(s) }); }
    function syncBoxes() {
      var dd = [0, 0, 0];
      body.querySelectorAll('input[data-rr]').forEach(function (cb) { if (cb.checked) dd[+cb.dataset.rr] += 4 >> +cb.dataset.cc; });
      var s = '' + dd[0] + dd[1] + dd[2];
      body.querySelector('.ch-num').value = s;
      preview(s);
    }
    function syncNum() {
      var m = /^0?([0-7]{3})$/.exec((body.querySelector('.ch-num').value || '').trim());
      if (!m) { body.querySelector('.ch-preview').textContent = T('chmod.bad'); return; }
      body.querySelectorAll('input[data-rr]').forEach(function (cb) {
        cb.checked = (parseInt(m[1].charAt(+cb.dataset.rr), 10) & (4 >> +cb.dataset.cc)) !== 0;
      });
      preview(m[1]);
    }
    body.addEventListener('change', function (e) { if (e.target && e.target.matches && e.target.matches('input[data-rr]')) syncBoxes(); });
    body.querySelector('.ch-num').addEventListener('input', syncNum);
    preview(d.join(''));
    A.openModal({
      title: T('chmod.title'),
      body: body,
      buttons: [{ label: T('btn.cancel') }, {
        label: T('btn.apply'), primary: true, onClick: function (m) {
          var o = (body.querySelector('.ch-num').value || '').trim();
          if (!/^0?[0-7]{3}$/.test(o)) { G.toast(T('chmod.bad'), { kind: 'error' }); return; }
          if (o.length === 3) o = '0' + o;
          G.apiEP.chmod(it.path, o).then(function (r) {
            if (r && r.ok) { m.close(); G.toast(T('chmod.done', { m: r.mode || o })); B_refresh(); } else bad(r, 'err.chmod');
          });
        }
      }]
    });
  };

  /* ---------- properties + hash ---------- */
  A.act_props = function (item) {
    var t = targets(item);
    if (t.length !== 1) {
      // The toolbar keeps this button enabled for any selection, so with
      // several files selected it used to return in silence and look broken.
      G.toast(T('props.oneOnly') || 'Select a single file to see its properties', { kind: 'error' });
      return;
    }
    var it = t[0];
    function row(k, v) { return '<dt>' + E(k) + '</dt><dd>' + E(v) + '</dd>'; }
    var body = document.createElement('div');
    body.innerHTML = '<dl class="props">' + row(T('props.name'), it.name) + row(T('props.path'), it.path) +
      '<dt>' + E(T('props.size')) + '</dt><dd data-el="size">' + E(it.is_dir ? T('props.folder') : G.fmtSize(it.size)) + '</dd>' +
      row(T('props.mtime'), G.fmtDate(it.mtime)) +
      '<dt>' + E(T('props.mode')) + '</dt><dd data-el="mode">' + E('—') + '</dd>' +
      row(T('props.mime'), it.mime || '—') + '</dl>' +
      '<div class="hash-row"><select data-el="algo"><option value="md5">MD5</option><option value="sha1">SHA-1</option><option value="sha256" selected>SHA-256</option></select>' +
      '<button type="button" class="btn" data-el="hashbtn">' + E(T('props.hash')) + '</button></div>' +
      '<pre data-el="hashout" class="hash-out" hidden></pre>';
    A.openModal({ title: T('props.title'), body: body, buttons: [{ label: T('btn.close'), primary: true }] });
    G.apiEP.stat(it.path).then(function (r) {
      if (!r || !r.ok || !r.item) return;
      var modeEl = body.querySelector('[data-el=mode]');
      if (modeEl && r.item.mode != null) modeEl.textContent = ('0' + Number(r.item.mode).toString(8)).slice(-4);
      var sizeEl = body.querySelector('[data-el=size]');
      if (sizeEl && r.item.size != null && !r.item.is_dir) sizeEl.textContent = G.fmtSize(r.item.size);
    }, function () { });
    body.querySelector('[data-el=hashbtn]').addEventListener('click', function () {
      var out = body.querySelector('[data-el=hashout]');
      var algo = body.querySelector('[data-el=algo]').value;
      out.hidden = false;
      out.textContent = T('props.hashing');
      G.apiEP.hash(it.path, algo).then(function (r) {
        if (r && r.ok && r.hash) { out.textContent = algo + ': ' + r.hash; out.dataset.copy = r.hash; }
        else out.textContent = msg(r, 'err.hash');
      });
    });
    body.addEventListener('click', function (e) {
      var out = body.querySelector('[data-el=hashout]');
      if (e.target === out && out.dataset.copy) {
        var ta = document.createElement('textarea');
        ta.value = out.dataset.copy;
        ta.style.cssText = 'position:fixed;left:-2000px';
        document.body.appendChild(ta);
        ta.select();
        try { if (document.execCommand) document.execCommand('copy'); G.toast(T('props.copied')); } catch (e) { }
        ta.remove();
      }
    });
  };
  A.act_hash = function (item) { A.act_props(item); };

  /* ---------- upload (hidden file input) ---------- */
  A.act_upload = function () {
    if (G.browser && G.browser.canUpload && !G.browser.canUpload()) { G.toast(T('err.readonly'), { kind: 'error' }); return; }
    var inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.style.position = 'fixed'; inp.style.left = '-9999px';
    inp.addEventListener('change', function () {
      var arr = [];
      var fl = inp.files || [];
      for (var i = 0; i < fl.length; i++) { arr.push({ file: fl[i], rel: fl[i].name }); }
      if (G.browser && G.browser.queueUploads) G.browser.queueUploads(arr, st().dir);
      if (inp.parentNode) inp.parentNode.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  };

  /* ---------- folder upload (webkitdirectory picker) ---------- */
  A.act_uploadFolder = function () {
    if (G.browser && G.browser.canUpload && !G.browser.canUpload()) { G.toast(T('err.readonly'), { kind: 'error' }); return; }
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.webkitdirectory = true;
    inp.directory = true;
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    inp.addEventListener('change', function () {
      var fl = inp.files || [];
      var arr = [];
      for (var i = 0; i < fl.length; i++) {
        arr.push({ file: fl[i], rel: fl[i].webkitRelativePath || fl[i].name });
      }
      // Keep relative path hierarchy with root folder preserved
      if (G.browser && G.browser.queueUploads) G.browser.queueUploads(arr, st().dir);
      if (inp.parentNode) inp.parentNode.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  };

  /* ---------- editor drawer (handlers relative to the editor markup) ---------- */
  A.act_editorClose = function () { if (G.editor && G.editor.close) G.editor.close(); };
  A.act_editorSave = function () { if (G.editor && G.editor.save) G.editor.save(); };
  A.act_editorRevert = function () {
    var it = (G.browser && G.browser.ctxTarget) || null;
    var cur = G.editor && G.editor.current;
    if (cur && cur.path) { G.editor.openEdit({ path: cur.path, name: cur.name }); G.toast(T('ed.reverted')); }
  };

})(window.GOFM);
