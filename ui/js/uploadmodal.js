/* Upload modal: Files / Folder / From-URL tabs, drag-and-drop, and a live
   status list rendered from the same job state the activity tray uses.
   Minimising hands off to the tray, which stays the single source of truth. */
(function () {
  'use strict';
  var G = window.GOFM || (window.GOFM = {});
  var A = G.actions = G.actions || {};
  var $ = function (id) { return document.getElementById(id); };
  var T = function (k, v) { return G.t ? G.t(k, v) : k; };
  var st = function () { return G.state; };

  var modal, listEl, minimized = false, wireOnce = false;

  function dir() {
    return (st() && st().dir) || '/';
  }

  /* ---------- rendering ---------- */

  function renderList() {
    if (!listEl) return;
    var jobs = st().jobs;
    var items = [];
    jobs.forEach(function (j) { items.push(j); });
    // newest first
    items.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    items = items.slice(0, 40);
    if (!items.length) {
      listEl.hidden = true;
      listEl.textContent = '';
      return;
    }
    listEl.hidden = false;
    listEl.textContent = '';
    items.forEach(function (j) {
      if (j.state === 'cancelled' || j.state === 'canceled') return;
      var pct = (j.total > 0) ? Math.min(100, Math.round((j.done || 0) / j.total * 100)) : (j.state === 'done' ? 100 : 0);
      var row = document.createElement('div');
      row.className = 'up-row state-' + (j.state || 'queued');

      var head = document.createElement('div');
      head.className = 'up-row-head';

      var name = document.createElement('div');
      name.className = 'up-row-name';
      name.textContent = j.name || j.id || '';
      head.appendChild(name);

      if (j.state === 'active' || j.state === 'running' || j.state === 'queued' || j.state === 'paused') {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'up-row-cancel';
        cancelBtn.title = 'Cancel upload';
        cancelBtn.innerHTML = '×';
        cancelBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (G.jobs && G.jobs.act) {
            G.jobs.act(j.id, 'abort');
          }
          if (G.jobs && G.jobs.dismiss) {
            G.jobs.dismiss(j.id);
          }
          renderList();
        });
        head.appendChild(cancelBtn);
      }
      row.appendChild(head);

      var meta = document.createElement('div');
      meta.className = 'up-row-meta';
      var failed = (j.state === 'error' || j.state === 'failed');
      if (failed) {
        // Surface the reason. A silent failure is the worst case: the user
        // sees the job vanish with no explanation.
        meta.textContent = (j.error || T('err.upload') || 'Failed');
      } else if (j.state === 'done' || j.state === 'completed' || j.state === 'ok') {
        var doneTxt = [];
        if (j.done) doneTxt.push(G.fmtSize ? G.fmtSize(j.done) : j.done);
        if (j.result) doneTxt.push('→ ' + j.result);
        meta.textContent = doneTxt.join('  ') || (T('job.done') || 'Done');
      } else {
        var parts = [];
        if (j.total > 0) {
          var pc = Math.min(100, Math.round((j.done || 0) / j.total * 100));
          parts.push((G.fmtSize ? G.fmtSize(j.done) : j.done) + ' / ' + (G.fmtSize ? G.fmtSize(j.total) : j.total));
          parts.push(pc + '%');
        } else {
          // no Content-Length: bytes + a determinate-looking bar is a lie,
          // so show bytes only and let the bar stay indeterminate
          parts.push((G.fmtSize ? G.fmtSize(j.done) : (j.done || 0)) + ' / ?');
        }
        var sp = (j.speed > 0) ? j.speed : (j.serverSpeed > 0 ? j.serverSpeed : (j.ema > 0 ? j.ema : 0));
        if (sp > 0) parts.push(G.fmtSpeed ? G.fmtSpeed(sp) : Math.round(sp) + ' B/s');
        meta.textContent = parts.join('  ·  ');
      }
      row.appendChild(meta);

      var bar = document.createElement('div');
      bar.className = 'up-row-bar';
      var fill = document.createElement('div');
      fill.className = 'up-row-fill';
      if (j.total > 0) {
        fill.style.width = pct + '%';
      } else {
        // unknown total: animate instead of drawing a fake percentage
        bar.classList.add('is-indeterminate');
      }
      bar.appendChild(fill);
      row.appendChild(bar);
      listEl.appendChild(row);
    });
  }

  var raf = null;
  function schedule() {
    if (raf) return;
    raf = setTimeout(function () { raf = null; if (!modal.hidden) renderList(); }, 400);
  }

  /* ---------- open / close ---------- */

  A.uploadModalOpen = function (tab) {
    modal = modal || $('upload-modal');
    if (!modal) { A.act_upload(); return; }
    modal.hidden = false;
    minimized = false;
    // Show where the upload will land, so it is never a guess. Defaults to
    // the folder currently open.
    var dest = $('up-dest');
    if (dest) {
      var d = (st() && st().dir) || '/';
      dest.textContent = 'To: ' + d;
    }
    if (tab) A.uploadTab(tab);
    renderList();
    A.uploadModalWatch();
  };

  A.uploadModalClose = function () {
    if (!modal) return;
    modal.hidden = true;
  };

  A.uploadModalWatch = function () {
    // mirror tray updates into the modal list while it is open
    if (wireOnce) return;
    wireOnce = true;
    setInterval(function () {
      if (modal && !modal.hidden) renderList();
    }, 500);
  };

  /* ---------- tabs ---------- */

  A.uploadTab = function (which) {
    var tabs = document.querySelectorAll('#upload-modal [data-up-tab]');
    var panes = document.querySelectorAll('#upload-modal [data-up-pane]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.upTab === which;
      tabs[i].classList.toggle('is-on', on);
      tabs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('is-on', panes[j].dataset.upPane === which);
    }
  };

  /* ---------- wiring ---------- */

  function pickFiles(folder) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    if (folder) { inp.webkitdirectory = true; inp.directory = true; }
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    inp.addEventListener('change', function () {
      var fl = inp.files || [];
      var arr = [];
      for (var i = 0; i < fl.length; i++) {
        arr.push({ file: fl[i], rel: (folder && fl[i].webkitRelativePath) ? fl[i].webkitRelativePath : fl[i].name });
      }
      // Preserve the picked top-level folder name so it uploads AS a folder, not dumped flat
      // arr retains relative paths: e.g. "MyFolder/sub/file.txt" 
      if (arr.length && G.browser && G.browser.queueUploads) G.browser.queueUploads(arr, dir());
      renderList();
      if (inp.parentNode) inp.parentNode.removeChild(inp);
    });
    document.body.appendChild(inp);
    inp.click();
  }

  function wireDrop(el, folder) {
    if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', function () { pickFiles(folder); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(folder); }
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); el.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      el.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); el.classList.remove('is-over'); });
    });
    el.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var out = [];
      // folders arrive as a DataTransferItem tree, not a FileList with paths
      if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        var pending = dt.items.length;
        (function walk(entry, prefix) {
          if (!entry) { if (--pending === 0) flush(); return; }
          if (entry.isFile) {
            entry.file(function (f) {
              out.push({ file: f, rel: prefix ? prefix + '/' + f.name : f.name });
              if (--pending === 0) flush();
            }, function () { if (--pending === 0) flush(); });
          } else if (entry.isDirectory) {
            var reader = entry.createReader();
            reader.readEntries(function (kids) {
              (function next() {
                if (!kids.length) { if (--pending === 0) flush(); return; }
                kids.forEach(function (k) { walk(k, prefix ? prefix + '/' + entry.name : entry.name); });
                reader.readEntries(next);
              })();
            }, function () { if (--pending === 0) flush(); });
          } else if (--pending === 0) flush();
        })(dt.items[0].webkitGetAsEntry(), '');
      } else {
        var fl = dt.files || [];
        for (var i = 0; i < fl.length; i++) out.push({ file: fl[i], rel: fl[i].name });
        pending = 0;
        flush();
      }
      function flush() {
        if (out.length && G.browser && G.browser.queueUploads) G.browser.queueUploads(out, dir());
        renderList();
      }
    });
  }

  A.wireUploadModal = function () {
    modal = modal || $('upload-modal');
    listEl = listEl || $('up-list');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';

    var close = $('up-close');
    if (close) close.addEventListener('click', A.uploadModalClose);

    var tabs = document.querySelectorAll('[data-up-tab]');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.addEventListener('click', function () { A.uploadTab(t.dataset.upTab); });
      })(tabs[i]);
    }

    wireDrop($('up-drop'), false);
    var fbtn = $('up-folder');
    if (fbtn && !fbtn.dataset.wired) { fbtn.dataset.wired = '1'; fbtn.addEventListener('click', function () { pickFiles(true); }); }

    var form = $('up-url-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var inp = $('up-url');
        var u = (inp && inp.value || '').trim();
        if (!/^https?:\/\//i.test(u)) {
          G.toast(T('url.bad') || 'Enter a valid http(s) URL', { kind: 'error' });
          return;
        }
        if (G.apiEP && G.apiEP.urlfetch) {
          G.apiEP.urlfetch(u, dir()).then(function (r) {
            if (r && r.ok && r.job_id) {
              inp.value = '';
              renderList();
              // The fetch runs async: its failure lands on the job, not on
              // this response. Watch it so the reason reaches the list.
              if (G.jobs && G.jobs.awaitResult) {
                G.jobs.awaitResult(r.job_id).then(function () {
                  renderList();
                  if (G.browser && G.browser.refresh) {
                    try { G.browser.refresh(); } catch (e) { }
                  }
                },
                  function (e) {
                    renderList();
                    G.toast((e && e.message) || T('err.urlfetch'), { kind: 'error', ms: 8000 });
                  });
              }
            } else {
              // server rejected it up front (bad URL, private target, denied
              // extension) — show exactly why instead of closing silently
              var msg = (r && r.error && r.error.message) || T('err.urlfetch');
              G.toast(msg, { kind: 'error', ms: 8000 });
              inp.focus();
            }
          }, function () { G.toast(T('err.urlfetch'), { kind: 'error', ms: 8000 }); });
        }
      });
    }

    // clicking the backdrop closes
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) A.uploadModalClose(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.hidden) A.uploadModalClose();
    });
  };
})();
