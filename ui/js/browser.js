'use strict';
/* GoFM browser: dir listing (list+grid), selection, ctx menu, keyboard, drag-drop chunk uploads. */
window.GOFM = window.GOFM || {};
(function (G) {
  var B = G.browser = {};
  var E = G.escapeHtml;

  function $(id) { return document.getElementById(id); }
  function st() { return G.state; }

  /* ---------- data loading ---------- */
  var loadSeq = 0;
  B.loadDir = async function (dir, opt) {
    var curSeq = ++loadSeq;
    opt = opt || {};
    dir = (dir == null || dir === '') ? '/' : String(dir);
    var res = await G.apiEP.list(dir, { sort: st().sort.key, asc: st().sort.asc });
    if (curSeq !== loadSeq) return false;
    if (!res || !res.ok) {
      G.toast((res && res.error && res.error.message) || G.t('err.loadDir'), { kind: 'error' });
      return false;
    }
    st().dir = res.dir || dir;
    st().items = Array.isArray(res.items) ? res.items : [];
    /* The listing response carries the permissions for THIS path, not the
       session-wide defaults. Without storing them, a control gated on perms
       (Upload, New) kept whatever value the login response had, which is why
       a read-only shared folder still showed the Upload button. */
    if (res.perms && typeof res.perms === 'object') st().perms = res.perms;
    if (res.allow && typeof res.allow === 'object') st().allow = res.allow;
    st().sel.clear();
    // leaving check mode on navigation: "click = open" must be the default
    // again, otherwise browsing a new folder selects instead of opening
    B.setCheckMode(false);
    // a stale ctxTarget from another directory would apply rename/props/delete
    // to a file that is no longer on screen
    B.ctxTarget = null;
    B.hideCtx();
    B.render();
    B.renderBreadcrumb(res.parent, res.dir || dir);
    if (G.syncPermUI) G.syncPermUI();
    G.selbarUpdate();
    if (B.tree) B.tree.sync(st().dir, res.items);
    if (!opt.silent && G.router) G.router.syncHash(st().dir);
    /* A guest cannot read /api/usage, so refreshing the storage bar for them
       only produced a 401 (surfacing as a "login required" toast) on every
       single navigation. */
    if (G.storageBar && !st().guest) G.storageBar.refresh();
    return true;
  };
  B.refresh = function () {
    return B.loadDir(st().dir);
  };

  /* ---------- folder tree in sidebar ---------- */
  var treeNodes = { '/': { path: '/', name: 'My files', is_dir: true, children: null } };
  var expanded = new Set(['/']);

  B.tree = {
    sync: async function (currentDir, currentItems) {
      currentDir = (currentDir == null || currentDir === '') ? '/' : String(currentDir);
      if (currentItems) {
        var subdirs = currentItems.filter(function (it) { return it.is_dir; });
        if (!treeNodes[currentDir]) {
          treeNodes[currentDir] = { path: currentDir, name: G.baseName(currentDir) || 'My files', is_dir: true, children: null };
        }
        treeNodes[currentDir].children = subdirs.map(function (d) {
          if (!treeNodes[d.path]) treeNodes[d.path] = { path: d.path, name: d.name, is_dir: true, children: null };
          return d.path;
        });
      }
      var parts = currentDir.split('/').filter(Boolean);
      var acc = '';
      expanded.add('/');
      for (var i = 0; i < parts.length; i++) {
        acc += '/' + parts[i];
        expanded.add(acc);
      }
      B.tree.render();
    },
    toggle: async function (path) {
      if (expanded.has(path)) {
        if (path !== '/') expanded.delete(path);
      } else {
        expanded.add(path);
        if (!treeNodes[path] || treeNodes[path].children == null) {
          var res = await G.apiEP.list(path);
          if (res && res.ok && Array.isArray(res.items)) {
            var subdirs = res.items.filter(function (it) { return it.is_dir; });
            if (!treeNodes[path]) treeNodes[path] = { path: path, name: G.baseName(path), is_dir: true };
            treeNodes[path].children = subdirs.map(function (d) {
              if (!treeNodes[d.path]) treeNodes[d.path] = { path: d.path, name: d.name, is_dir: true, children: null };
              return d.path;
            });
          }
        }
      }
      B.tree.render();
    },
    render: function () {
      var root = $('folder-tree') || $('tree-views');
      if (!root) return;
      root.textContent = '';

      function buildNode(p, isRoot) {
        var n = treeNodes[p] || { path: p, name: isRoot ? 'My files' : G.baseName(p), is_dir: true };
        var isExp = expanded.has(p);
        var hasKids = n.children && n.children.length > 0;
        var isCur = st().dir === p;

        var wrap = document.createElement('div');
        wrap.className = 'tree-node';
        wrap.dataset.treePath = p;

        var row = document.createElement('div');
        row.className = 'tree-row' + (isCur ? ' active' : '');
        row.dataset.nav = p;

        var tog = document.createElement('button');
        tog.type = 'button';
        tog.className = 'tree-toggle' + (isExp ? ' open' : '') + (n.children && n.children.length === 0 ? ' empty' : '');
        tog.dataset.treeToggle = p;
        tog.setAttribute('aria-label', isExp ? 'Collapse folder' : 'Expand folder');
        tog.innerHTML = '<svg class="i" viewBox="0 0 24 24"><use href="#i-caret"/></svg>';
        row.appendChild(tog);

        var link = document.createElement('button');
        link.type = 'button';
        link.className = 'tree-link';
        link.dataset.treeNav = p;
        var icHref = isRoot ? '#i-drive' : '#i-folder';
        var label = isRoot ? G.t('My files') : n.name;
        link.innerHTML = '<svg class="i fic" viewBox="0 0 24 24"><use href="' + icHref + '"/></svg>' +
          '<span class="tree-label">' + E(label) + '</span>';
        row.appendChild(link);
        wrap.appendChild(row);

        if (isExp && hasKids) {
          var branch = document.createElement('div');
          branch.className = 'tree-branch';
          n.children.forEach(function (cp) {
            branch.appendChild(buildNode(cp, false));
          });
          wrap.appendChild(branch);
        }
        return wrap;
      }

      root.appendChild(buildNode('/', true));
    }
  };

  /* ---------- filtering / sorting ---------- */
  function isHidden(name) {
    if (!st().showHidden && String(name).charAt(0) === '.') return true;
    var pats = (st().config && st().config.hidden) || [];
    for (var i = 0; i < pats.length; i++) if (G.patternMatches(pats[i], name)) return true;
    return false;
  }
  B.sortItems = function (items) {
    var key = st().sort.key, asc = st().sort.asc ? 1 : -1;
    var arr = items.slice();
    arr.sort(function (a, b) {
      var ad = a.is_dir ? 0 : 1, bd = b.is_dir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      var r = 0;
      if (key === 'size') r = (Number(a.size) || 0) - (Number(b.size) || 0);
      // mtime arrives as an ISO-8601 string; subtracting two strings yields
      // NaN, which Array.sort treats as "equal" and silently keeps the
      // server's order — the column looked like it did nothing.
      else if (key === 'time') r = tsOf(a.mtime) - tsOf(b.mtime);
      else if (key === 'type') r = String(G.extOf(a.name)).localeCompare(String(G.extOf(b.name)));
      else r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
      return r * asc;
    });
    function tsOf(v) {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      var t = Date.parse(String(v));
      return isNaN(t) ? 0 : t;
    }
    return arr;
  };
  B.visibleItems = function () {
    var out = st().items.filter(function (it) { return !isHidden(it.name); });
    var sv = G.SAVED_VIEWS && G.SAVED_VIEWS[st().savedView];
    if (sv) out = out.filter(function (it) { return !it.is_dir && sv.test(it); });
    return B.sortItems(out);
  };

  /* ---------- render ---------- */
  function cloneFrom(tplId, fallbackTag, fallbackClass) {
    var tpl = $(tplId);
    if (tpl && tpl.content && tpl.content.firstElementChild) return tpl.content.firstElementChild.cloneNode(true);
    var el = document.createElement(fallbackTag || 'div');
    if (fallbackClass) el.className = fallbackClass;
    return el;
  }
  function fillRow(el, item, index) {
    el.dataset.path = item.path;
    el.dataset.index = index;
    if (!el.dataset.name) el.dataset.name = item.name;

    // 1. Icon symbol href & tint class
    var iconHref = G.fileIconHref ? G.fileIconHref(item.name, item.is_dir) : (item.is_dir ? '#i-folder' : '#i-file');
    var tint = G.fileIconClass ? G.fileIconClass(item.name, item.is_dir) : (item.is_dir ? 'ic-folder' : 'ic-file');
    var use = el.querySelector('.use-ic');
    if (use) use.setAttribute('href', iconHref);
    var fic = el.querySelector('.fic');
    if (fic) fic.classList.add(tint);
    el.classList.add(tint);

    // 2. Name
    var fname = el.querySelector('.fname-text') || el.querySelector('.tile-name') || el.querySelector('[data-el=name], .name, .row-name');
    if (fname) {
      fname.textContent = item.name;
      fname.title = item.name;
    }

    // 3. Size, Time, Type, Meta
    var sizeEl = el.querySelector('[data-el=size], .col-size');
    if (sizeEl) sizeEl.textContent = item.is_dir ? '—' : G.fmtSize(item.size);

    var timeEl = el.querySelector('[data-el=time], .col-time');
    if (timeEl) timeEl.textContent = G.fmtDate(item.mtime);

    var typeEl = el.querySelector('[data-el=type], .col-type');
    if (typeEl) typeEl.textContent = item.is_dir ? G.t('type.folder') : (item.mime || G.extOf(item.name).toUpperCase() || G.t('type.file'));

    var tileMeta = el.querySelector('.tile-meta');
    if (tileMeta) tileMeta.textContent = item.is_dir ? G.t('type.folder') : G.fmtSize(item.size);

    // 4. Checkbox
    var cb = el.querySelector('input[type=checkbox]');
    if (cb) {
      cb.checked = st().sel.has(item.path);
      cb.setAttribute('aria-label', G.t('sel.select') + ' ' + item.name);
    }
    el.setAttribute('role', 'row');
    el.tabIndex = 0;
    el.classList.toggle('sel', st().sel.has(item.path));
    el.classList.toggle('selected', st().sel.has(item.path));
    el.classList.toggle('is-dir', !!item.is_dir);

    // 5. Image thumbnail
    var thumb = el.querySelector('[data-el=thumb], .thumb');
    if (thumb && /image/i.test(item.mime || '') && !item.is_dir) {
      thumb.loading = 'lazy';
      thumb.alt = item.name;
      thumb.src = G.apiEP.inlineURL(item.path);
      thumb.hidden = false;
      var media = el.querySelector('.tile-media');
      if (media) media.classList.add('thumb-loaded');
    }

    // 6. Overflow / more button
    var ov = el.querySelector('[data-el=overflow], .overflow-btn, .row-more, [data-action=more]');
    if (ov) ov.dataset.overflow = item.path;
    return el;
  }

  /* One button in the topbar, beside the theme toggle, that switches the
     current mode. aria-pressed and the icon both follow the active mode. */
  B.syncViewButtons = function () {
    var btn = $('view-toggle');
    if (!btn) return;
    var grid = st().view === 'grid';
    btn.setAttribute('aria-pressed', grid ? 'true' : 'false');
    btn.setAttribute('aria-label', grid ? 'Switch to list view' : 'Switch to grid view');
    var use = btn.querySelector('use');
    if (use) use.setAttribute('href', grid ? '#i-list' : '#i-grid');
  };
  /* Single entry point for the view switch, used by the topbar buttons and
     by the drawer copy on phones (which is why both pairs must be synced). */
  B.setViewMode = function (v) {
    if (st().view === v) return;
    st().view = v;
    G.LS.set('gofm.view', v);
    B.render();
    B.syncViewButtons();
  };
  B.render = function () {
    var items = B.visibleItems();
    B._lastRender = items;
    var list = $('list-rows'), grid = $('grid-tiles');
    var isGrid = st().view === 'grid';
    if (list) list.hidden = isGrid;
    if (grid) grid.hidden = !isGrid;
    if (isGrid) {
      // the column header describes the list grid's tracks; in tile view it
      // has no relationship to the tiles and used to stay pinned above them
      var chh = $('colhead');
      if (chh) chh.hidden = true;
      if (grid) {
        grid.textContent = '';
        items.forEach(function (it, i) { grid.appendChild(fillRow(cloneFrom('tpl-tile', 'div', 'tile'), it, i)); });
      }
    } else {
      var chl = $('colhead');
      if (chl) chl.hidden = false;
      if (list) {
        list.textContent = '';
        items.forEach(function (it, i) { list.appendChild(fillRow(cloneFrom('tpl-row', 'div', 'row'), it, i)); });
      }
    }
    if (!list && !grid) G.warnOnce('list', '#list-rows/#grid-tiles missing');
    var empty = $('empty-state') || $('empty-msg');
    if (empty) empty.hidden = items.length !== 0;
    var mainEl = $('main');
    if (mainEl) mainEl.classList.toggle('show-empty', items.length === 0);
    B.syncViewButtons();
    B.renderColheads();
  };
  B.renderColheads = function () {
    var ch = $('colhead');
    if (!ch) return;
    ch.querySelectorAll('[data-sort]').forEach(function (h) {
      var k = h.dataset.sort;
      h.classList.toggle('sorted', st().sort.key === k);
      h.setAttribute('aria-sort', st().sort.key === k ? (st().sort.asc ? 'ascending' : 'descending') : 'none');
    });
  };
  B.renderBreadcrumb = function (parent, dirOverride) {
    var bc = $('breadcrumb');
    if (!bc) { G.warnOnce('bc', '#breadcrumb missing'); return; }
    bc.textContent = '';
    // Delegated once: crumbs are rebuilt on every navigation, so binding each
    // node would be wasted work — and a per-node handler was what got lost
    // when the breadcrumb was refactored, leaving every crumb inert.
    if (!bc.dataset.wired) {
      bc.dataset.wired = '1';
      bc.addEventListener('click', function (e) {
        var c = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
        if (!c) return;
        e.preventDefault();
        var p = c.dataset.nav;
        if (p) B.loadDir(p);
      });
    }
    var parts = String(dirOverride || st().dir || '/').split('/').filter(Boolean);
    var mk = function (label, path, cur) {
      var a = document.createElement('button');
      a.type = 'button';
      a.className = 'crumb' + (cur ? ' cur' : '');
      a.textContent = label;
      a.dataset.nav = path;
      if (cur) a.setAttribute('aria-current', 'page');
      bc.appendChild(a);
      if (!cur) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        sep.setAttribute('aria-hidden', 'true');
        bc.appendChild(sep);
      }
    };
    mk(G.t(st().savedView ? ('view.' + st().savedView) : 'crumb.root'), st().savedView ? '/' + st().savedView : '/', parts.length <= 1);
    var acc = '';
    parts.forEach(function (p, i) {
      if (st().savedView && i === 0) return; /* view key shown as root crumb */
      acc += '/' + p;
      mk(p, acc, i === parts.length - 1);
    });
    if (parts.length > 1 && parent) {
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'crumb-up';
      up.dataset.nav = parent;
      up.title = G.t('nav.up');
      up.textContent = '\u2191';
      bc.insertBefore(up, bc.firstChild);
    }
  };

  
  
  

  /* ---------- selection ---------- */
  B.clearSel = function () { st().sel.clear(); B.paintSel(); G.selbarUpdate(); };
  B.setSel = function (paths) {
    st().sel.clear();
    (paths || []).forEach(function (p) { st().sel.add(p); });
    B.paintSel();
    G.selbarUpdate();
  };
  B.syncSelAll = function () {
    var sa = $('sel-all');
    if (!sa) return;
    var items = B._lastRender || [];
    var vis = 0;
    items.forEach(function (it) { if (st().sel.has(it.path)) vis++; });
    sa.checked = items.length > 0 && vis === items.length;
    sa.indeterminate = vis > 0 && vis < items.length;
  };
  B.paintSel = function () {
    // an emptied selection means the user is done choosing: fall back to
    // click-to-open so the next click browses instead of selecting
    if (st().checkMode && st().sel.size === 0) B.setCheckMode(false);
    document.querySelectorAll('#list-rows [data-path], #grid-tiles [data-path]').forEach(function (el) {
      var on = st().sel.has(el.dataset.path);
      el.classList.toggle('sel', on);
      el.classList.toggle('selected', on);
      var cb = el.querySelector('input[type=checkbox]');
      if (cb) cb.checked = on;
    });
    B.syncSelAll();
  };
  B.selectedItems = function () {
    var pool = B.visibleItems();
    return pool.filter(function (it) { return st().sel.has(it.path); });
  };
  B.selectRange = function (fromIdx, toIdx) {
    var items = B._lastRender || [];
    var a = Math.min(fromIdx, toIdx), b = Math.max(fromIdx, toIdx);
    for (var i = a; i <= b && i < items.length; i++) st().sel.add(items[i].path);
    B.paintSel();
    G.selbarUpdate();
  };
  B.selectAllVisible = function () {
    var items = B._lastRender || [];
    if (!items.length) return;
    // toggle: if everything visible is already selected, clear instead
    var allOn = items.every(function (it) { return st().sel.has(it.path); });
    if (allOn) st().sel.clear();
    else items.forEach(function (it) { st().sel.add(it.path); });
    B.paintSel();
    G.selbarUpdate();
  };
  B.focusIndex = function (i, scroll) {
    var host = st().view === 'grid' ? $('grid-tiles') : $('list-rows');
    if (!host) return;
    var els = host.querySelectorAll('[data-index]');
    if (!els.length) return;
    i = Math.max(0, Math.min(els.length - 1, i));
    els[i].focus();
    B._focusIdx = i;
    if (scroll !== false) { try { els[i].scrollIntoView({ block: 'nearest' }); } catch (e) { } }
  };
  B.indexForEl = function (el) {
    if (!el || el.dataset == null || el.dataset.index == null) return -1;
    return parseInt(el.dataset.index, 10);
  };

  /* ---------- open ---------- */
  B.openItem = function (item) {
    if (!item) return;
    if (item.is_dir) { st().savedView = ''; B.loadDir(item.path); return; }
    B.requestOpen(item);
  };
  B.requestOpen = function (item) {
    // Open in quickview / preview mode by default for all files
    if (G.actions.quickview) {
      G.actions.quickview(item);
    } else if (G.editor && G.editor.canEdit && G.editor.canEdit(item)) {
      G.editor.openEdit(item);
    }
  };
  B.jumpToResult = function (item) {
    if (item.is_dir) { st().savedView = ''; B.loadDir(item.path); }
    else {
      var parent = item.path.slice(0, item.path.lastIndexOf('/')) || '/';
      st().savedView = '';
        B.loadDir(parent).then(function () { B.setSel([item.path]); });
    }
  };

  /* ---------- context menu ---------- */
  B.ctxTarget = null;
  B.showCtx = function (entries, x, y) {
    var menu = $('ctx-menu');
    if (!menu) return;
    var item = B.ctxTarget;
    var multi = st().sel.size > 1 && (!item || st().sel.has(item.path));
    var targets = multi ? B.selectedItems() : (item ? [item] : []);
    var isArch = targets.length === 1 && /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i.test(String(targets[0].name || ''));
    var isDir = targets.length === 1 && !!targets[0].is_dir;

    menu.querySelectorAll('.menu-item').forEach(function (btn) {
      var act = btn.dataset.action;
      if (!act) return;
      var show = true;
      if (act === 'quickview') show = !multi;
      else if (act === 'download') show = !isDir;
      else if (act === 'newfile' || act === 'mkdir') show = !multi;
      else if (act === 'rename') show = !multi && targets.length === 1;
      else if (act === 'copy' || act === 'move') show = targets.length > 0;
      else if (act === 'chmod') show = !multi && targets.length === 1;
      else if (act === 'hash') show = !multi && !isDir;
      else if (act === 'props') show = !multi;
      else if (act === 'delete') show = targets.length > 0;
      
      // Dynamic ACL & capability check
      if (show && G.canAction) {
        show = G.canAction(act, targets);
      }
      btn.hidden = !show;
    });

    // inject an Edit entry only when the target is genuinely text-editable
    var editBtn = menu.querySelector('[data-action=edit]');
    if (!editBtn) {
      editBtn = document.createElement('button');
      editBtn.className = 'menu-item';
      editBtn.type = 'button';
      editBtn.dataset.action = 'edit';
      editBtn.innerHTML = '<svg class="i" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-edit"/></svg>' +
        '<span class="menu-label">Edit</span>';
      var anchor = menu.querySelector('[data-action=rename]');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(editBtn, anchor);
    }
    var editable = !multi && targets.length === 1 && G.editor && G.editor.canEdit && G.editor.canEdit(targets[0]);
    editBtn.hidden = !editable;

    var cComp = $('ctx-compress') || menu.querySelector('#ctx-compress');
    if (cComp) cComp.hidden = (targets.length === 0) || !(G.canAction && (G.canAction('compress', targets) || G.canAction('compress-zip', targets)));

    var cExt = $('ctx-extract') || menu.querySelector('#ctx-extract');
    if (cExt) cExt.hidden = !isArch || !(G.canAction && G.canAction('extract-here', targets));

    menu.hidden = false;
    menu.classList.add('open');
    var w = menu.offsetWidth || 220;
    var h = menu.offsetHeight || 320;
    var maxX = (window.innerWidth || 1024) - w - 12;
    var maxY = (window.innerHeight || 768) - h - 12;
    menu.style.left = Math.max(12, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(12, Math.min(y, maxY)) + 'px';
  };
  B.hideCtx = function () {
    var menu = $('ctx-menu');
    if (menu) { menu.hidden = true; menu.classList.remove('open'); }
  };
  B.ctxAtEl = function (el, x, y) {
    var item = B.itemFromEl(el);
    if (!item) return;
    if (!st().sel.has(item.path)) B.setSel([item.path]);
    B.ctxTarget = item;
    B.showCtx(null, x, y);
  };
  B.itemFromEl = function (el) {
    var row = el && el.closest ? el.closest('[data-path]') : null;
    if (!row) return null;
    var pool = st().items;
    for (var i = 0; i < pool.length; i++) if (pool[i].path === row.dataset.path) return pool[i];
    return { name: G.baseName(row.dataset.path), path: row.dataset.path, is_dir: row.classList.contains('is-dir'), size: 0 };
  };

  /* ---------- check mode (Drive-style multi-select) ---------- */
  /* Off by default: a plain click opens the item. Toggled on by clicking a
     checkbox (or Ctrl/Shift-clicking), cleared when the selection empties or
     the user navigates, so ordinary browsing always returns to "click = open". */
  B.checkMode = function () { return !!st().checkMode; };
  B.setCheckMode = function (on) {
    if (st().checkMode === !!on) return;
    st().checkMode = !!on;
    var main = $('main');
    if (main) main.classList.toggle('check-mode', !!on);
    var hint = $('check-hint');
    if (hint) hint.hidden = !on;
  };
  B.exitCheckMode = function () {
    if (!st().checkMode) return;
    B.setCheckMode(false);
    B.clearSel();
  };

  /* ---------- event wiring ---------- */
  B.wire = function () {
    var main = $('main') || document.body;
    // Drag-and-drop and paste are advertised in the UI (the #dropzone pill and
    // the "Drop files to upload" empty state) but were never initialised, so
    // both were dead.
    if (B.setupDnD) B.setupDnD(main);
    if (B.setupPaste) B.setupPaste();

    var vt = $('view-toggle');
    if (vt && !vt.dataset.wired) {
      vt.dataset.wired = '1';
      vt.addEventListener('click', function (e) {
        e.stopPropagation();
        B.setViewMode(st().view === 'grid' ? 'list' : 'grid');
      });
    }
    /* Drive-style interaction model:
     - single click on a row OPENS it (browse into a folder, preview a file)
     - clicking the checkbox enters "check mode": from then on a plain click
       toggles selection instead of opening, so a whole folder can be
       multi-selected without holding Ctrl
     - Ctrl/Cmd-click always toggles, Shift-click always ranges, in both modes
   Previously a plain click selected and opening needed a double click, which
   made ordinary browsing feel wrong. */
function onRowClick(e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-path]') : null;
      if (!el) return;
      var idx = B.indexForEl(el);
      var more = e.target && e.target.closest ? e.target.closest('[data-action=more], .row-more, [data-overflow]') : null;
      if (more) {
        e.preventDefault();
        e.stopPropagation();
        var r = more.getBoundingClientRect();
        B.ctxAtEl(el, r.left, r.bottom + 4);
        return;
      }
      if (e.target && e.target.closest && e.target.closest('.cb')) {
        // The delegated 'change' listener owns the checkbox: the native toggle
        // already happened. Enabling check mode here is what makes the rest of
        // the UI behave like Drive — subsequent plain clicks select.
        B._anchor = idx;
        B.setCheckMode(true);
        return;
      }
      if (e.shiftKey && B._anchor != null && idx >= 0) { B.selectRange(B._anchor, idx); B.setCheckMode(true); return; }
      if (e.ctrlKey || e.metaKey) {
        B.setCheckMode(true);
        if (st().sel.has(el.dataset.path)) st().sel.delete(el.dataset.path); else st().sel.add(el.dataset.path);
        B._anchor = idx;
        B.paintSel(); G.selbarUpdate();
        return;
      }
      if (B.checkMode()) {
        // in check mode a plain click toggles rather than opening
        if (st().sel.has(el.dataset.path)) st().sel.delete(el.dataset.path); else st().sel.add(el.dataset.path);
        B._anchor = idx;
        B.paintSel(); G.selbarUpdate();
        return;
      }
      B.focusIndex(idx, false);
      B.openItem(B.itemFromEl(el));
    }
function onRowDbl(e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-path]') : null;
      if (!el) return;
      var it = B.itemFromEl(el);
      B.openItem(it);
    }
    main.addEventListener('click', onRowClick);
    main.addEventListener('dblclick', onRowDbl);
    main.addEventListener('contextmenu', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-path]') : null;
      if (!el) { B.hideCtx(); return; }
      e.preventDefault();
      B.ctxAtEl(el, e.clientX, e.clientY);
    });
    document.addEventListener('click', function (e) {
      var menu = $('ctx-menu');
      if (menu && !menu.hidden && !(e.target && (menu.contains(e.target) || e.target.closest('[data-action=more], .row-more, [data-overflow]')))) {
        B.hideCtx();
      }
      var nm = $('new-menu');
      if (nm && !nm.hidden && !(e.target && (nm.contains(e.target) || e.target.closest('#rail-new, [data-action=new-menu]')))) {
        nm.hidden = true;
      }
      var um = $('user-menu');
      if (um && !um.hidden && !(e.target && (um.contains(e.target) || e.target.closest('#user-btn')))) {
        um.hidden = true;
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') B.hideCtx();
    });

    /* sort headers */
    var ch = $('colhead');
    if (ch) ch.addEventListener('click', function (e) {
      var h = e.target && e.target.closest ? e.target.closest('[data-sort]') : null;
      if (!h) return;
      var k = h.dataset.sort;
      if (st().sort.key === k) st().sort.asc = !st().sort.asc;
      else { st().sort.key = k; st().sort.asc = true; }
      G.LS.setJSON('gofm.sort', st().sort);
      B.render();
    });

    /* select-all header checkbox */
    var sa = $('sel-all');
    if (sa) {
      sa.addEventListener('click', function (e) {
        e.stopPropagation();
        // do NOT preventDefault: the checkbox must keep toggling itself
        var items = B._lastRender || [];
        if (sa.checked) {
          items.forEach(function (it) { st().sel.add(it.path); });
        } else {
          st().sel.clear();
        }
        B.paintSel();
        G.selbarUpdate();
      });
    }

    /* selection count chip doubles as "clear selection" (its aria-label) */
    var sc = $('sel-count');
    if (sc && !sc.dataset.wired) {
      sc.dataset.wired = '1';
      sc.addEventListener('click', function (e) {
        e.stopPropagation();
        B.clearSel();
      });
    }

    /* Single source of truth for checkbox toggles. Works for clicks on the
       input itself AND on the visible .cb-box inside its <label>, with or
       without Ctrl/Shift, because we read the control's native checked state
       on 'change' instead of guessing from the click event. */
    main.addEventListener('change', function (e) {
      var cb = e.target && e.target.closest ? e.target.closest('input[type=checkbox]') : null;
      if (!cb || cb.id === 'sel-all') return;
      var row = cb.closest('[data-path]');
      if (!row) return;
      if (cb.checked) st().sel.add(row.dataset.path);
      else st().sel.delete(row.dataset.path);
      B._anchor = B.indexForEl(row);
      B.paintSel();
      G.selbarUpdate();
    });
  };

  /* ---------- keyboard navigation ---------- */
  B.onKey = function (e) {
    var ae = document.activeElement;
    var tag = (ae && ae.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (ae && ae.isContentEditable)) return false;
    if (G.modals && G.modals.openCount && G.modals.openCount() > 0) return false;
    // The editor drawer and quickview are neither modals nor inputs, but they
    // hold focus (Ace focuses a <div>). Without this, Delete/F2 fire against
    // the file list *behind* the open editor.
    var drawer = document.getElementById('editor');
    if (drawer && !drawer.hidden) return false;
    var qv = document.getElementById('quickview');
    if (qv && !qv.hidden) return false;
    var items = B._lastRender || [];
    var idx = (B._focusIdx == null ? -1 : B._focusIdx);
    var k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'a' || k === 'A')) {
      e.preventDefault();
      B.setCheckMode(true);
      B.selectAllVisible();
      return true;
    }
    if (k === 'Escape' && B.checkMode()) {
      e.preventDefault();
      B.exitCheckMode();
      return true;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!items.length) return false;
      e.preventDefault();
      var ni = idx < 0 ? 0 : Math.max(0, Math.min(items.length - 1, idx + (k === 'ArrowDown' ? 1 : -1)));
      B.focusIndex(ni);
      // arrows only extend the selection in check mode; otherwise they just
      // move focus, so browsing with the keyboard does not accumulate a
      // selection the user never asked for
      if (B.checkMode() && e.shiftKey && B._anchor != null) B.selectRange(B._anchor, ni);
      return true;
    }
    if (k === 'Enter' && idx >= 0 && items[idx]) { e.preventDefault(); B.openItem(items[idx]); return true; }
    if (k === 'Delete' && st().sel.size) {
      e.preventDefault();
      if (G.actions && G.actions.act_delete) G.actions.act_delete();
      return true;
    }
    if (k === 'F2' && st().sel.size === 1) {
      e.preventDefault();
      if (G.actions && G.actions.act_rename) G.actions.act_rename(B.selectedItems()[0]);
      return true;
    }
    if ((k === 'a' || k === 'A') && (e.ctrlKey || e.metaKey) && idx >= 0) {
      e.preventDefault();
      B.selectAllVisible();
      return true;
    }
    return false;
  };

  /* ---------- drag & drop uploads (chunked) ---------- */
  B.setupDnD = function (host) {
    if (!host) return;
    var depth = 0;
    host.addEventListener('dragenter', function () {
      if (!B.canUpload()) return;
      depth++;
      B.setDropping(true);
    });
    host.addEventListener('dragover', function (e) {
      if (!B.canUpload()) return;
      if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (e2) { } }
      e.preventDefault();
    });
    host.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) B.setDropping(false);
    });
    host.addEventListener('drop', async function (e) {
      if (!B.canUpload()) return;
      e.preventDefault();
      depth = 0;
      B.setDropping(false);
      var files = [], dirs = [];
      var dt = e.dataTransfer;
      var walked = false;
      if (dt && dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        var entries = [];
        for (var i = 0; i < dt.items.length; i++) {
          try { if (dt.items[i].kind === 'file') { var en = dt.items[i].webkitGetAsEntry(); if (en) entries.push(en); } } catch (e2) { }
        }
        if (entries.length) {
          walked = true;
          for (var j = 0; j < entries.length; j++) {
            try { await B.walkEntry(entries[j], entries[j].name, files, dirs); } catch (e2) { }
          }
        }
      }
      if (!walked && dt && dt.files && dt.files.length) {
        for (var m = 0; m < dt.files.length; m++) files.push({ file: dt.files[m], rel: dt.files[m].webkitRelativePath || dt.files[m].name });
      }
      if (files.length) {
        B.queueUploads(files, st().dir);
      }
    });
  };
  B.walkEntry = function (entry, relPath, files, dirs) {
    return new Promise(function (resolve) {
      if (!entry) return resolve();
      if (entry.isFile) {
        try {
          entry.file(function (f) { files.push({ file: f, rel: relPath }); resolve(); }, function () { resolve(); });
        } catch (e) { resolve(); }
        return;
      }
      if (!entry.isDirectory) return resolve();
      if (dirs) dirs.push(relPath);
      var acc = [];
      var reader;
      try { reader = entry.createReader(); } catch (e) { return resolve(); }
      var step = function () {
        try {
          reader.readEntries(function (ents) {
            if (!ents || !ents.length) {
              var chain = Promise.resolve();
              acc.forEach(function (sub) {
                chain = chain.then(function () { return B.walkEntry(sub, relPath + '/' + sub.name, files, dirs); });
              });
              chain.then(function () { resolve(); }, function () { resolve(); });
              return;
            }
            acc = acc.concat([].slice.call(ents));
            step();
          }, function () { resolve(); });
        } catch (e) { resolve(); }
      };
      step();
    });
  };
  B.canUpload = function () {
    /* Prefer the per-folder allow map from /api/list. The session-level map
       only exists for a signed-in user, so a guest could never pass this
       check and a drop box (@/path:ru) looked permanently read-only. */
    var perDir = st().allow;
    if (perDir && typeof perDir.upload === 'boolean') return !!perDir.upload;
    var allow = (st().config && st().config.allow) || {};
    // upload is its own permission bit: a drop box (ru) may add files
    // even though it may not modify or delete anything
    return !!allow.upload && !!st().perms.u;
  };
  B.setDropping = function (on) {
    var main = $('main'), dz = $('dropzone');
    if (main) main.classList.toggle('dragging', !!on);
    if (dz) dz.classList.toggle('show', !!on);
  };

  /* upload one file via chunk protocol w/ per-file tray row + one retry per chunk */
  B.uploadFile = function (file, relPath, dir) {
    var cfg = st().config || {};
    var chunk = Math.max(1, cfg.chunk_bytes || 2000000);
    var total = Math.max(1, Math.ceil(file.size / chunk));
    var uid = G.uuid();
    var rel = relPath || file.name;
    var path = G.apiEP.joinPath(dir || st().dir, rel);
    var job = G.jobs.addLocal({ id: uid, kind: 'upload', type: 'upload', name: G.baseName(rel), done: 0, total: file.size });
    var aborted = false, paused = false, waiters = [];
    var ctrl = {
      abort: function () { aborted = true; paused = false; waiters.splice(0).forEach(function (r) { r(); }); try { if (job._ac) job._ac.abort(); } catch (e) { } },
      retry: function () { aborted = false; paused = false; G.jobs.updateLocal(uid, { state: 'active', error: '' }); run(); },
      pause: function () {
        if (aborted) return;
        paused = true;
        G.jobs.updateLocal(uid, { state: 'paused' });
      },
      resume: function () {
        if (aborted) return;
        paused = false;
        G.jobs.updateLocal(uid, { state: 'active' });
        waiters.splice(0).forEach(function (r) { r(); });
      }
    };
    function hold() { return new Promise(function (res) { if (!paused) return res(); waiters.push(res); }); }
    G.jobs.setCtl(uid, ctrl);
    async function sendChunk(i) {
      var start = i * chunk;
      var blob = file.slice(start, Math.min(start + chunk, file.size));
      var meta = { upload_id: uid, index: i, total: total, size: file.size, name: G.baseName(rel), path: path, dir: dir || st().dir };
      job._ac = (typeof window.AbortController === 'function') ? new AbortController() : null;
      var r = await G.apiEP.uploadChunk(blob, meta, job._ac ? job._ac.signal : undefined);
      if (!r || !r.ok) {
        await new Promise(function (res) { setTimeout(res, 400); }); /* single retry per chunk */
        r = await G.apiEP.uploadChunk(blob, meta, job._ac ? job._ac.signal : undefined);
      }
      return r;
    }
    async function run() {
      try {
        for (var i = 0; i < total; i++) {
          if (aborted) { G.jobs.updateLocal(uid, { state: 'cancelled' }); return; }
          await hold();
          if (aborted) { G.jobs.updateLocal(uid, { state: 'cancelled' }); return; }
          var r = await sendChunk(i);
          if (aborted) { G.jobs.updateLocal(uid, { state: 'cancelled' }); return; }
          if (!r || !r.ok) {
            G.jobs.updateLocal(uid, { state: 'error', error: (r && r.error && r.error.message) || G.t('err.upload') });
            return;
          }
          if (i === total - 1 && r.path) job.finalPath = r.path;
          var curDone = Math.min(file.size, (i + 1) * chunk);
          var now = Date.now();
          if (!job._startT) { job._startT = now; job._lastT = now; job._lastD = 0; }
          var dt = (now - (job._lastT || now)) / 1000;
          var speed = 0;
          if (dt >= 0.3) {
            speed = (curDone - (job._lastD || 0)) / dt;
            job._lastT = now;
            job._lastD = curDone;
          } else if (now > job._startT) {
            speed = curDone / ((now - job._startT) / 1000);
          }
          G.jobs.updateLocal(uid, { done: curDone, speed: speed });
        }
        G.jobs.updateLocal(uid, { state: 'done', done: file.size });
        // refresh once the file is actually on disk — otherwise a freshly
        // uploaded file stays invisible until the user hits refresh by hand
        if (G.browser && G.browser.refresh) { try { G.browser.refresh(); } catch (e) { } }
      } catch (e) {
        G.jobs.updateLocal(uid, { state: 'error', error: String((e && e.message) || e).slice(0, 120) });
      }
    }
    run();
    return uid;
  };
  function queueWithRelativePaths(files) {
    var base = st().dir || '/';
    var grouped = {};
    var order = [];
    files.forEach(function (f) {
      var rel = String(f.rel || f.file.name);
      var i = rel.lastIndexOf('/');
      var dir = i >= 0 ? rel.slice(0, i) : '';
      var name = i >= 0 ? rel.slice(i + 1) : rel;
      var target = dir ? G.apiEP.joinPath(base, dir) : base;
      if (!grouped[target]) { grouped[target] = []; order.push(target); }
      grouped[target].push({ file: f.file, name: name });
    });
    var queued = 0;
    order.forEach(function (dir) {
      queued += B.uploadToDir(grouped[dir], dir);
    });
    if (queued) {
      G.toast(G.t('upload.queued', { n: queued }));
      B.refresh();
    }
  }

  B.queueDropped = function (files) { queueWithRelativePaths(files || []); };

  B.uploadToDir = function (entries, dir) {
    if (!B.canUpload()) { G.toast(G.t('err.readonly'), { kind: 'error' }); return 0; }
    var over = (st().config && st().config.max_upload_bytes) || 0;
    var n = 0;
    (entries || []).forEach(function (e) {
      var file = e.file || e;
      var name = e.name || file.name;
      if (over && file.size > over) {
        G.toast(G.t('err.tooLarge', { n: name, max: G.fmtSize(over) }), { kind: 'error' });
        return;
      }
      B.uploadFile(file, name, dir);
      n++;
    });
    return n;
  };

  B.queueUploads = function (files, targetDir) {
    if (!B.canUpload()) { G.toast(G.t('err.readonly'), { kind: 'error' }); return; }
    var base = targetDir || st().dir || '/';
    var over = (st().config && st().config.max_upload_bytes) || 0;
    var list = (files || []).slice();
    var ok = 0;
    list.forEach(function (f) {
      var file = f.file || f;
      var rel = String(f.rel || file.webkitRelativePath || file.name);
      if (over && file.size > over) {
        G.toast(G.t('err.tooLarge', { n: rel, max: G.fmtSize(over) }), { kind: 'error' });
        return;
      }
      var i = rel.lastIndexOf('/');
      var subDir = i >= 0 ? rel.slice(0, i) : '';
      var fileName = i >= 0 ? rel.slice(i + 1) : rel;
      var dest = subDir ? G.apiEP.joinPath(base, subDir) : base;
      B.uploadFile(file, fileName, dest);
      ok++;
    });
    if (ok) { G.toast(G.t('upload.queued', { n: ok })); B.refresh(); }
  };

  /* ---------- paste files ---------- */
  B.setupPaste = function () {
    if (B._pasteWired) return;
    B._pasteWired = true;
    document.addEventListener('paste', function (e) {
      if (!B.canUpload() || !e.clipboardData) return;
      var ae = document.activeElement;
      var ed = $('ed-code');
      if (ed && ae === ed) return; /* editing text: let paste through */
      var fl = e.clipboardData.files;
      if (!fl || !fl.length) return;
      var files = [];
      for (var i = 0; i < fl.length; i++) files.push({ file: fl[i], rel: fl[i].name || ('pasted-' + (i + 1) + '.png') });
      e.preventDefault();
      B.queueUploads(files);
    });
  };
})(window.GOFM);
