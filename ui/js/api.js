'use strict';
/* GoFM api: one function per CONTRACT endpoint. Depends on core.js (GOFM.api, GOFM.url). */
window.GOFM = window.GOFM || {};
(function (G) {
  var A = G.apiEP = {};

  function q(params) {
    var s = '';
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null) return;
      s += (s ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(v);
    });
    return s;
  }
  function joinPath(dir, name) {
    dir = String(dir || '/').replace(/\/+$/, '');
    return (dir + '/' + String(name || '')).replace(/\/{2,}/g, '/');
  }
  A.joinPath = joinPath;

  /* session / auth */
  A.session = function () { return G.api('api/session'); };
  A.login = function (user, pass) { return G.api('api/login', { method: 'POST', body: { user: user, pass: pass } }); };
  A.logout = function () { return G.api('api/logout', { method: 'POST', body: {} }); };
  A.version = function () { return G.api('api/version'); };

  /* listing / stat */
  A.list = function (dir, opt) {
    opt = opt || {};
    return G.api('api/list' + q({
      dir: dir, sort: opt.sort, asc: opt.asc ? 1 : undefined,
      q: opt.q, all: opt.all ? 1 : undefined
    }));
  };
  A.stat = function (path) { return G.api('api/stat' + q({ path: path })); };

  /* mutations */
  A.mkdir = function (dir, name) { return G.api('api/mkdir', { method: 'POST', body: { dir: dir, name: name } }); };
  A.create = function (dir, name, content) {
    var b = { dir: dir, name: name };
    if (content != null) b.content = content;
    return G.api('api/create', { method: 'POST', body: b });
  };
  A.rename = function (from, to, name) {
    var b = { from: from, to: to };
    if (name) b.name = name;
    else if (to) b.name = to.split('/').filter(Boolean).pop();
    return G.api('api/rename', { method: 'POST', body: b });
  };
  A.move = function (items, to) { return G.api('api/move', { method: 'POST', body: { items: items, to: to } }); };
  A.copy = function (items, to) { return G.api('api/copy', { method: 'POST', body: { items: items, to: to } }); };
  A.del = function (items) { return G.api('api/delete', { method: 'POST', body: { items: items } }); };
  A.save = function (path, content, opt) {
    opt = opt || {};
    var headers = {};
    if (opt.etag) headers['If-Match'] = opt.etag;
    return G.api('api/save', {
      method: 'POST',
      body: { path: path, content: content, backup: opt.backup !== false },
      headers: headers
    });
  };
  A.chmod = function (path, mode) { return G.api('api/chmod', { method: 'POST', body: { path: path, mode: mode } }); };
  A.hash = function (path, algo) { return G.api('api/hash' + q({ path: path, algo: algo || 'sha256' })); };
  A.usage = function (path) { return G.api('api/usage' + q({ path: path || '/' })); };

  /* uploads */
  A.upload = function (fullPath, blob, opt) {
    opt = opt || {};
    var headers = { 'X-CSRF': G.state.csrf || '' };
    if (opt.mkdir) headers['X-Gofm-Mkdir'] = '1';
    return G.api('api/upload?path=' + encodeURIComponent(fullPath), { method: 'POST', body: blob, headers: headers });
  };
  A.uploadChunk = function (file, meta, signal) {
    var fd = new FormData();
    fd.append('file', file, meta.name || file.name || 'blob');
    fd.append('upload_id', meta.upload_id);
    fd.append('index', meta.index);
    fd.append('total', meta.total);
    fd.append('size', meta.size != null ? meta.size : file.size);
    fd.append('name', meta.name);
    fd.append('dir', meta.dir || '/');
    fd.append('path', meta.path);
    return G.api('api/upload/chunk', { method: 'POST', body: fd, signal: signal });
  };

  /* url fetch / archives */
  A.urlfetch = function (url, dir) { return G.api('api/urlfetch', { method: 'POST', body: { url: url, dir: dir } }); };
  A.archive = function (items, kind, dir, targetName) {
    var b = { items: items, kind: kind, dir: dir };
    if (targetName) b.target_name = targetName;
    return G.api('api/archive', { method: 'POST', body: b });
  };
  A.extract = function (archive, to, unique) {
    return G.api('api/extract', { method: 'POST', body: { archive: archive, to: to, unique: !!unique } });
  };

  /* jobs */
  A.jobs = function () { return G.api('api/jobs'); };
  A.jobCancel = function (id) { return G.api('api/jobs/cancel', { method: 'POST', body: { id: id } }); };
  A.jobRetry = function (id) { return G.api('api/jobs/retry', { method: 'POST', body: { id: id } }); };

  /* prefs / i18n / diag */
  A.pref = function (theme, lang, density) {
    return G.api('api/pref', { method: 'POST', body: { theme: theme, lang: lang, density: density } });
  };
  A.i18n = function (lang) { return G.api('api/i18n' + q({ lang: lang })); };
  A.diag = function (payload) {
    return G.api('api/diag', { method: 'POST', body: payload || {} }).then(function () { return { ok: true }; }, function () { return { ok: false }; });
  };

  /* download URL: prefer raw /f/ (works with Range + attachment), api/download fallback */
  A.rawURL = function (path) { return G.url('f/' + String(path || '').replace(/^\/+/, '')); };
  A.rawUrl = A.rawURL;
  A.downloadURL = function (path) { return G.url('f/' + String(path || '').replace(/^\/+/, '')); };
  A.inlineURL = function (path) { return G.url('f/' + String(path || '').replace(/^\/+/, '')); };
  A.downloadAPI = function (path) { return G.url('api/download' + q({ path: path })); };
  A.joinPath = joinPath;

  /* SSE jobs stream with manual retry (EventSource; reconnect w/ backoff if closed) */
  var sse = { src: null, tries: 0, timer: null, stopped: false };
  A.jobsStream = function (onJob, onStatus) {
    if (typeof window.EventSource !== 'function') {
      if (onStatus) onStatus('unsupported');
      A.pollJobs(onJob, onStatus);
      return;
    }
    A.jobsStreamStop();
    sse.stopped = false;
    function connect() {
      if (sse.stopped) return;
      try { if (sse.src) { sse.src.close(); } } catch (e) { }
      var src = null;
      try { src = new EventSource(G.url('api/jobs/stream'), { withCredentials: true }); } catch (e) { src = null; }
      if (!src) { sse.timer = setTimeout(connect, 5000); return; }
      sse.src = src;
      src.addEventListener('job', function (ev) {
        sse.tries = 0;
        var data = null;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data && onJob) { try { onJob(data); } catch (e) { } }
      });
      src.addEventListener('open', function () { sse.tries = 0; if (onStatus) onStatus('open'); });
      src.onerror = function () {
        if (onStatus) onStatus('error');
        try { src.close(); } catch (e) { }
        sse.src = null;
        if (sse.stopped) return;
        sse.tries++;
        var wait = Math.min(30000, 1000 * Math.pow(2, Math.min(sse.tries, 5)));
        clearTimeout(sse.timer);
        sse.timer = setTimeout(connect, wait);
      };
    }
    connect();
    A.pollJobs(onJob, null); /* one-shot snapshot sync */
  };
  A.jobsStreamStop = function () {
    sse.stopped = true;
    clearTimeout(sse.timer);
    try { if (sse.src) sse.src.close(); } catch (e) { }
    sse.src = null;
  };
  /* fallback/one-shot job snapshot */
  A.pollJobs = function (onJob, ignore) {
    A.jobs().then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.jobs)) return;
      res.jobs.forEach(function (j) { if (onJob) { try { onJob(j); } catch (e) { } } });
    }, function () { });
  };
})(window.GOFM);
