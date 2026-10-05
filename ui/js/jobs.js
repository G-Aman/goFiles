'use strict';
/* GoFM jobs: bottom activity tray + SSE feed. Requires core.js + api.js. */
window.GOFM = window.GOFM || {};
(function (G) {
  var J = G.jobs = {};
  var MAX_ROWS = 30;
  var DONE_FADE_MS = 4000;

  function normId(j) { return j.id || j.upload_id || ('local-' + G.uuid()); }

  J.upsert = function (data) {
    if (!data) return null;
    var id = normId(data);
    var jobs = G.state.jobs;
    var cur = jobs.get(id);
    if (!cur) {
      cur = {
        id: id, kind: data.kind || 'server', type: data.type || 'job', name: data.name || id,
        state: data.state || 'active', done: data.done || 0, total: data.total || 0,
        speed: 0, eta: data.eta || 0, error: data.error || '', samples: [], ema: 0, ctl: null, finishedAt: 0
      };
      jobs.set(id, cur);
    }
    if (data.name) cur.name = data.name;
    if (data.type) cur.type = data.type;
    if (data.state) {
      if (data.state !== cur.state) cur.samples = [];
      cur.state = data.state;
    }
    if (data.done != null) cur.done = data.done;
    if (data.total != null) cur.total = data.total;
    if (data.error != null) cur.error = data.error;
    if (data.speed != null) cur.serverSpeed = data.speed;
    if (data.eta != null) cur.eta = data.eta;
    /* EMA speed over last 3 samples */
    var now = Date.now();
    if (cur.state === 'active' || cur.state === 'running') {
      if (cur._t && cur._d != null && now > cur._t && cur.done >= cur._d) {
        var inst = (cur.done - cur._d) * 1000 / (now - cur._t);
        cur.samples.push(inst);
        if (cur.samples.length > 3) cur.samples.shift();
        var e = cur.samples[0];
        for (var i = 1; i < cur.samples.length; i++) e = e * 0.5 + cur.samples[i] * 0.5;
        cur.ema = e;
      }
      cur._t = now; cur._d = cur.done;
    }
    var done = (cur.state === 'done' || cur.state === 'completed' || cur.state === 'ok' || cur.state === 'error' || cur.state === 'failed' || cur.state === 'cancelled');
    if (done && !cur.finishedAt) {
      cur.finishedAt = now;
      if (cur.state === 'done' || cur.state === 'completed' || cur.state === 'ok') {
        if (G.browser && G.browser.refresh) {
          try { G.browser.refresh(); } catch (e) { }
        }
        setTimeout(function () { J.dismiss(id); }, DONE_FADE_MS);
      }
    }
    J.render();
    return cur;
  };

  J.addLocal = function (meta) {
    var cur = J.upsert(Object.assign({ kind: 'local', state: 'active' }, meta));
    if (cur) cur.ctl = meta.ctl || null;
    J.render();
    return cur;
  };
  J.setCtl = function (id, ctl) { var j = G.state.jobs.get(id); if (j) j.ctl = ctl; };
  J.updateLocal = function (id, patch) {
    var j = G.state.jobs.get(id);
    if (!j) return;
    if (patch.done != null) j.done = patch.done;
    if (patch.total != null) j.total = patch.total;
    if (patch.speed != null) j.speed = patch.speed;
    if (patch.state != null) { if (patch.state !== j.state) j.samples = []; j.state = patch.state; }
    if (patch.name != null) j.name = patch.name;
    if (patch.error != null) j.error = patch.error;
    if (j.state === 'done' && !j.finishedAt) {
      j.finishedAt = Date.now();
      setTimeout(function () { J.dismiss(id); }, DONE_FADE_MS);
    }
    J.render();
  };
  J.dismiss = function (id) {
    if (G.state.jobs.delete(id)) J.render();
  };
  J.activeCount = function () {
    var n = 0;
    G.state.jobs.forEach(function (j) {
      if (j.state === 'active' || j.state === 'running' || j.state === 'queued' || j.state === 'paused') n++;
    });
    return n;
  };

  function speedOf(j) {
    if (j.speed > 0) return j.speed;
    if (j.serverSpeed > 0) return j.serverSpeed;
    if (j.ema > 0) return j.ema;
    if (j.total > 0 && j.eta > 0) return j.done / Math.max(1, (j.done + j.eta));
    return 0;
  }
  function typeIcon(t) {
    t = String(t || '');
    if (t.indexOf('url') === 0) return 'job-ic job-ic-url';
    if (t.indexOf('upload') === 0) return 'job-ic job-ic-upload';
    if (t.indexOf('arch') >= 0 || t.indexOf('zip') >= 0 || t.indexOf('tar') >= 0) return 'job-ic job-ic-zip';
    if (t.indexOf('extract') >= 0 || t.indexOf('unzip') >= 0) return 'job-ic job-ic-unzip';
    if (t.indexOf('move') === 0 || t.indexOf('copy') === 0) return 'job-ic job-ic-move';
    if (t.indexOf('delete') === 0) return 'job-ic job-ic-del';
    return 'job-ic job-ic-generic';
  }
  function stateLabel(j) {
    if (j.state === 'error' || j.state === 'failed') return G.t('job.failed');
    if (j.state === 'cancelled') return G.t('job.cancelled');
    if (j.state === 'done' || j.state === 'completed' || j.state === 'ok') return G.t('job.done');
    if (j.state === 'paused') return G.t('job.paused');
    if (j.state === 'queued') return G.t('job.queued');
    return G.t('job.active');
  }
  function btn(act, label, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tray-btn';
    b.dataset.jobAct = act;
    b.textContent = label;
    if (title) b.title = title;
    return b;
  }

  J.isLive = function (j) {
    var s = j && j.state;
    return s === 'active' || s === 'running' || s === 'queued' || s === 'paused';
  };
  J.pruneSettled = function () {
    // A completed upload is a one-off event. The server keeps finished jobs in
    // its /api/jobs snapshot and the SSE feed replays them, so without this the
    // tray would resurrect "old upload" rows on every poll. Drop settled jobs
    // as soon as they land instead of waiting on a dismissal timer.
    var jobs = G.state.jobs;
    jobs.forEach(function (j, id) {
      if (!J.isLive(j) && !j._keep) jobs.delete(id);
    });
  };

  J.render = function () {
    var list = document.getElementById('tray-list');
    var head = document.getElementById('tray-head');
    var tray = document.getElementById('tray');
    if (head) {
      var badge = head.querySelector('.tray-badge');
      if (!badge) { badge = document.createElement('span'); badge.className = 'tray-badge'; head.appendChild(badge); }
      var n = J.activeCount();
      badge.textContent = n > 0 ? String(n) : '';
      badge.hidden = n === 0;
    }
    if (!list) { G.warnOnce('tray', '#tray-list missing, tray render skipped'); return; }
    var arr = [];
    G.state.jobs.forEach(function (j) { arr.push(j); });
    arr.sort(function (a, b) {
      var ad = (a.state === 'active' || a.state === 'running' || a.state === 'queued') ? 0 : 1;
      var bd = (b.state === 'active' || b.state === 'running' || b.state === 'queued') ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return (b.finishedAt || 0) - (a.finishedAt || 0);
    });
    arr = arr.slice(0, MAX_ROWS);
    list.textContent = '';
    arr.forEach(function (j) {
      var row = document.createElement('div');
      row.className = 'tray-row state-' + j.state;
      row.dataset.jobId = j.id;
      var ic = document.createElement('span');
      ic.className = typeIcon(j.type);
      ic.setAttribute('aria-hidden', 'true');
      row.appendChild(ic);
      var col = document.createElement('div');
      col.className = 'tray-col';
      var n1 = document.createElement('div');
      n1.className = 'tray-name';
      n1.textContent = j.name;
      n1.title = j.name;
      col.appendChild(n1);
      var bar = document.createElement('div');
      bar.className = 'tray-bar';
      var fill = document.createElement('div');
      fill.className = 'tray-fill';
      var pct = (j.total > 0) ? Math.min(100, Math.round(j.done / j.total * 100)) : (j.state === 'done' || j.state === 'completed' || j.state === 'ok' ? 100 : 0);
      fill.style.width = pct + '%';
      if (j.state === 'error' || j.state === 'failed') fill.classList.add('err');
      if (pct >= 100 || j.state === 'done' || j.state === 'completed' || j.state === 'ok') fill.classList.add('ok');
      bar.appendChild(fill);
      col.appendChild(bar);
      var meta = document.createElement('div');
      meta.className = 'tray-meta';
      var parts = [stateLabel(j)];
      if (j.total > 0) parts.push(pct + '% (' + G.fmtSize(j.done) + '/' + G.fmtSize(j.total) + ')');
      var sp = speedOf(j);
      if (sp > 0 && (j.state === 'active' || j.state === 'running')) parts.push(G.fmtSpeed(sp));
      if (j.eta > 0 && (j.state === 'active' || j.state === 'running')) parts.push(G.t('job.left', { d: G.fmtDur(j.eta) }));
      if (j.error) { parts.push(String(j.error).slice(0, 80)); meta.classList.add('has-err'); }
      meta.textContent = parts.join(' · ');
      col.appendChild(meta);
      row.appendChild(col);
      var acts = document.createElement('div');
      acts.className = 'tray-acts';
      if (j.state === 'error' || j.state === 'failed') {
        if (j.kind === 'server' || j.retryable) acts.appendChild(btn('retry', G.t('job.retry'), G.t('job.retry')));
        acts.appendChild(btn('dismiss', '×', G.t('job.dismiss')));
      } else if (j.state === 'done' || j.state === 'completed' || j.state === 'ok' || j.state === 'cancelled') {
        acts.appendChild(btn('dismiss', '×', G.t('job.dismiss')));
      } else {
        if (j.kind === 'upload' || j.kind === 'local') acts.appendChild(btn('abort', G.t('job.cancel'), G.t('job.cancel')));
        else if (j.type === 'urlfetch') acts.appendChild(btn('cancel', G.t('job.cancel'), G.t('job.cancel')));
        if (j.state === 'paused') acts.appendChild(btn('resume', G.t('job.resume'), G.t('job.resume')));
      }
      row.appendChild(acts);
      list.appendChild(row);
    });
    if (tray) {
      var liveJobs = arr.filter(function (j) {
        var s = j.state;
        return s === 'active' || s === 'running' || s === 'queued' || s === 'paused';
      });
      var shouldShow = liveJobs.length > 0 || arr.some(function (j) {
        return (Date.now() - (j.finishedAt || 0)) < 5000;
      });
      tray.classList.toggle('has-jobs', shouldShow);
      tray.hidden = !shouldShow;
      tray.dataset.idle = liveJobs.length === 0 ? '1' : '0';
    }
    var tb = document.getElementById('tray-busy');
    if (tb) tb.hidden = J.activeCount() === 0;
    var tc = document.getElementById('tray-count');
    if (tc) {
      var live = J.activeCount();
      tc.textContent = live > 0 ? String(live) : (arr.length ? String(arr.length) : '0');
    }
  };

  J.act = function (id, act) {
    var j = G.state.jobs ? G.state.jobs.get(id) : null;
    if (!j) return;
    if (act === 'dismiss') { J.dismiss(id); }
    else if (act === 'pause' || act === 'resume') {
      if (j.ctl) {
        if (act === 'pause' && j.ctl.pause) j.ctl.pause();
        else if (act === 'resume' && j.ctl.resume) j.ctl.resume();
      }
      J.render();
    }
    else if (act === 'retry') {
      if (j.kind === 'local' && j.ctl && j.ctl.retry) j.ctl.retry();
      else if (G.apiEP && G.apiEP.jobRetry) G.apiEP.jobRetry(id).then(function () { J.render(); }, function () { });
    }
    else if (act === 'cancel' || act === 'abort') {
      if (j.ctl && j.ctl.abort) { try { j.ctl.abort(); } catch (e2) { } }
      else if (G.apiEP && G.apiEP.jobCancel) G.apiEP.jobCancel(id).then(function () { }, function () { });
      if (act === 'abort') J.updateLocal(id, { state: 'cancelled' });
    }
  };

  J.jobAct = jobAct;
  function jobAct(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-job-act]') : null;
    if (!b) return;
    var row = b.closest('[data-job-id]');
    if (!row) return;
    var id = row.dataset.jobId;
    var act = b.dataset.jobAct;
    J.act(id, act);
  }

  J.isCollapsed = function () { return G.LS.get('gofm.tray.collapsed') === '1'; };
  J.setCollapsed = function (v) {
    G.LS.set('gofm.tray.collapsed', v ? '1' : '0');
    var tray = document.getElementById('tray');
    if (tray) tray.classList.toggle('collapsed', !!v);
  };

  /* Resolve a job that produces a file (multi-file download zips, extract):
     poll /api/jobs until it settles, then hand back the result path.
     Previously these callers just toasted "job started" and stopped, so a
     multi-file download silently did nothing. */
  J.awaitResult = function (id, opt) {
    opt = opt || {};
    var tries = opt.tries || 120;      // ~2 min at 1s
    var delay = opt.delay || 1000;
    return new Promise(function (resolve, reject) {
      function once() {
        G.apiEP.jobs().then(function (r) {
          var list = (r && (r.jobs || r.items)) || [];
          var j = null;
          for (var i = 0; i < list.length; i++) if (list[i].id === id) { j = list[i]; break; }
          if (!j) {
            if (--tries > 0) return setTimeout(once, delay);
            return reject(new Error('job ' + id + ' disappeared'));
          }
          if (j.state === 'done' || j.state === 'completed' || j.state === 'ok') return resolve(j.result || null);
          if (j.state === 'error' || j.state === 'failed') {
            return reject(new Error(j.error || ('job ' + j.state)));
          }
          // A job stuck in queued/running with zero progress is never going to
          // finish. Surface that instead of animating forever.
          if ((j.state === 'queued' || j.state === 'running') && !j.done && !started) {
            started = Date.now();
          } else if ((j.done || started) && (j.state === 'queued' || j.state === 'running')) {
            if (!j.done && Date.now() - started > stalledMs) {
              return reject(new Error('no progress — the server stopped responding'));
            }
          }
          if (--tries > 0) return setTimeout(once, delay);
          reject(new Error('job timed out'));
        }, function () {
          if (--tries > 0) setTimeout(once, delay); else reject(new Error('poll failed'));
        });
      }
      var started = 0;
      var stalledMs = opt.stallMs || 120000;
      once();
    });
  };

  J.init = function () {
    var tray = document.getElementById('tray');
    if (!tray) { G.warnOnce('tray-init', '#tray missing'); return; }
    J.setCollapsed(J.isCollapsed());
    var head = document.getElementById('tray-head');
    if (head) head.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('[data-job-act]')) return;
      J.setCollapsed(!J.isCollapsed());
    });
    tray.addEventListener('click', jobAct);
    if (G.apiEP && G.apiEP.jobsStream) {
      G.apiEP.jobsStream(function (job) { J.upsert(job); }, null);
    }
    J.render();
    setInterval(J.render, 2000);
  };
})(window.GOFM);
