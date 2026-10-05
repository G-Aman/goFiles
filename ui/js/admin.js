/* Admin sheet: Users & Permissions Management. */
(function () {
  'use strict';
  var G = window.GOFM || (window.GOFM = {});
  var $ = function (id) { return document.getElementById(id); };
  var E = function (s) { return G.escapeHtml ? G.escapeHtml(String(s)) : String(s); };

  var sheet, wired = false;
  var currentUsers = [];
  var userRules = {}; // map: username -> { path: '/', r: true, u: true, w: true, d: false }
  var publicAccess = { enabled: false, path: '/Public', r: true, u: false, w: false, d: false };

  function api(path, method, body) {
    return G.api(path, method ? { method: method, body: body } : undefined);
  }

  function cleanPath(p) {
    p = (p || '').trim();
    while (p.indexOf('/@/') >= 0 || p.indexOf('@') === 0) {
      p = p.replace(/\/@\//g, '/').replace(/^@+/, '');
    }
    p = '/' + p.replace(/^\/+/, '');
    return p;
  }

  // Parse lines like "user@/path:ruwd" or "@/path:r"
  function parseRuleLines(text) {
    var rules = [];
    (text || '').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line || line.indexOf('#') === 0) return;
      var i = line.lastIndexOf(':');
      var perms = 'r';
      var target = line;
      if (i >= 0 && line.slice(i).indexOf('/') < 0) {
        perms = line.slice(i + 1);
        target = line.slice(0, i);
      }
      var user = '@', path = '/';
      if (target.indexOf('@') === 0) {
        user = '@';
        path = cleanPath(target.slice(1));
      } else {
        var at = target.indexOf('@');
        if (at >= 0) {
          user = target.slice(0, at).trim();
          path = cleanPath(target.slice(at + 1));
        } else if (target.indexOf('/') === 0) {
          user = '*';
          path = cleanPath(target);
        } else {
          user = target.trim();
          path = '/';
        }
      }
      rules.push({
        user: user,
        path: path,
        r: perms.indexOf('r') >= 0,
        u: perms.indexOf('u') >= 0,
        w: perms.indexOf('w') >= 0,
        d: perms.indexOf('d') >= 0
      });
    });
    return rules;
  }

  function gatherAllRules() {
    var rules = [];
    if (publicAccess.enabled) {
      var pPath = cleanPath($('adm-pub-path') ? $('adm-pub-path').value : publicAccess.path);
      rules.push({
        user: '@',
        path: pPath || '/Public',
        r: $('adm-pub-r') ? $('adm-pub-r').checked : publicAccess.r,
        u: $('adm-pub-u') ? $('adm-pub-u').checked : publicAccess.u,
        w: $('adm-pub-w') ? $('adm-pub-w').checked : publicAccess.w,
        d: $('adm-pub-d') ? $('adm-pub-d').checked : publicAccess.d
      });
    }
    currentUsers.forEach(function (u) {
      if (u.admin) return; // Superadmin is core, never has ACL rules
      var ur = userRules[u.name] || { path: u.home || '/', r: true, u: true, w: true, d: false };
      rules.push({
        user: u.name,
        path: cleanPath(ur.path || u.home || '/'),
        r: !!ur.r,
        u: !!ur.u,
        w: !!ur.w,
        d: !!ur.d
      });
    });
    return rules;
  }

  function serializeRules(rules) {
    var lines = [
      '# goFiles access control — one rule per line.',
      '# <user|@|*> / <path> : <perms>      e.g.  @/Public:ru',
      '#   r = read/list/download    u = upload NEW files',
      '#   w = modify existing (rename, edit, chmod)   d = delete',
      '# NOTE: editing a file needs "w". An owner rule must be ruwd.',
      '# Longest path wins; a named user beats @ and *.'
    ];
    rules.forEach(function (rl) {
      var p = (rl.r ? 'r' : '') + (rl.u ? 'u' : '') + (rl.w ? 'w' : '') + (rl.d ? 'd' : '');
      if (!p) p = 'r';
      var pathClean = cleanPath(rl.path);
      if (!rl.user || rl.user === '@') {
        lines.push('@' + pathClean + ':' + p);
      } else {
        lines.push(rl.user + '@' + pathClean + ':' + p);
      }
    });
    return lines.join('\n') + '\n';
  }

  function syncRulesToRaw() {
    var rawTa = $('adm-acl');
    if (rawTa) rawTa.value = serializeRules(gatherAllRules());
  }

  function renderPublicAccess() {
    var toggle = $('adm-pub-toggle');
    var cfgBox = $('adm-pub-config');
    var statusText = $('adm-pub-status-text');
    var pathInput = $('adm-pub-path');
    var cbR = $('adm-pub-r'), cbU = $('adm-pub-u'), cbW = $('adm-pub-w'), cbD = $('adm-pub-d');

    if (toggle) toggle.checked = publicAccess.enabled;
    if (cfgBox) cfgBox.style.display = publicAccess.enabled ? 'block' : 'none';
    if (pathInput) pathInput.value = publicAccess.path || '/Public';
    if (cbR) cbR.checked = publicAccess.r;
    if (cbU) cbU.checked = publicAccess.u;
    if (cbW) cbW.checked = publicAccess.w;
    if (cbD) cbD.checked = publicAccess.d;

    if (statusText) {
      if (publicAccess.enabled) {
        statusText.textContent = 'Enabled: guests can access ' + (publicAccess.path || '/Public');
        statusText.style.color = 'var(--accent)';
      } else {
        statusText.textContent = 'Disabled (Login required for all paths)';
        statusText.style.color = 'var(--muted)';
      }
    }
  }

  function renderUsers() {
    var host = $('adm-users');
    if (!host) return;
    host.textContent = '';

    // Filter out any superadmin account
    var list = currentUsers.filter(function (u) { return !u.admin; });

    if (!list.length) {
      host.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:12px;background:var(--surface-2);border-radius:6px;border:1px dashed var(--line-soft);">No additional users configured yet. Create one below.</div>';
      return;
    }

    list.forEach(function (u) {
      var card = document.createElement('div');
      card.className = 'adm-user-card';

      // Header row
      var head = document.createElement('div');
      head.className = 'adm-user-card-head';

      var userTitle = document.createElement('div');
      userTitle.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;';
      userTitle.innerHTML = '<b style="font-size:13px;">' + E(u.name) + '</b>' +
        ' <span style="font-size:11px;color:var(--muted);margin-left:4px;">Home: <code>' + E(u.home || '/') + '</code></span>';
      head.appendChild(userTitle);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

      var pwdBtn = document.createElement('button');
      pwdBtn.className = 'btn sm';
      pwdBtn.type = 'button';
      pwdBtn.textContent = 'Change Password';
      pwdBtn.title = 'Change password for ' + u.name;
      actions.appendChild(pwdBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'btn sm btn-danger';
      delBtn.type = 'button';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', function () {
        if (!window.confirm('Delete user account ' + u.name + '?')) return;
        api('api/users', 'DELETE', { user: u.name }).then(function (res) {
          if (res && res.ok) {
            G.toast('User removed: ' + u.name, { kind: 'success' });
            delete userRules[u.name];
            saveACL(false);
            load();
          } else {
            G.toast((res && res.error && res.error.message) || 'failed to delete user', { kind: 'error' });
          }
        });
      });
      actions.appendChild(delBtn);
      head.appendChild(actions);
      card.appendChild(head);

      // Password Drawer (Inline)
      var pwdBox = document.createElement('div');
      pwdBox.className = 'adm-pwd-box';
      pwdBox.style.display = 'none';

      var pwdInp = document.createElement('input');
      pwdInp.type = 'password';
      pwdInp.className = 'adm-input';
      pwdInp.placeholder = 'New password for ' + u.name;
      pwdInp.autocomplete = 'new-password';
      pwdBox.appendChild(pwdInp);

      var pwdSave = document.createElement('button');
      pwdSave.className = 'btn sm btn-primary';
      pwdSave.type = 'button';
      pwdSave.textContent = 'Update';
      pwdSave.addEventListener('click', function () {
        var val = pwdInp.value;
        if (!val) {
          G.toast('Enter new password', { kind: 'error' });
          return;
        }
        api('api/users', 'PUT', { user: u.name, pass: val }).then(function (res) {
          if (res && res.ok) {
            G.toast('Password updated for ' + u.name, { kind: 'success' });
            pwdInp.value = '';
            pwdBox.style.display = 'none';
          } else {
            G.toast((res && res.error && res.error.message) || 'failed to update password', { kind: 'error' });
          }
        });
      });
      pwdBox.appendChild(pwdSave);

      var pwdCancel = document.createElement('button');
      pwdCancel.className = 'btn sm';
      pwdCancel.type = 'button';
      pwdCancel.textContent = 'Cancel';
      pwdCancel.addEventListener('click', function () {
        pwdInp.value = '';
        pwdBox.style.display = 'none';
      });
      pwdBox.appendChild(pwdCancel);

      pwdBtn.addEventListener('click', function () {
        pwdBox.style.display = pwdBox.style.display === 'none' ? 'flex' : 'none';
        if (pwdBox.style.display !== 'none') pwdInp.focus();
      });
      card.appendChild(pwdBox);

      // Permissions for this user (rendered directly in the same card)
      var ur = userRules[u.name] || (userRules[u.name] = { path: u.home || '/', r: true, u: true, w: true, d: false });

      var body = document.createElement('div');
      body.className = 'adm-user-card-body';

      var permRow = document.createElement('div');
      permRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

      var dirLabel = document.createElement('span');
      dirLabel.style.cssText = 'font-size:11px;color:var(--muted);min-width:60px;';
      dirLabel.textContent = 'Directory:';
      permRow.appendChild(dirLabel);

      var pathInp = document.createElement('input');
      pathInp.type = 'text';
      pathInp.className = 'adm-input';
      pathInp.style.cssText = 'flex:1;min-width:100px;font-family:ui-monospace,monospace;';
      pathInp.value = ur.path || u.home || '/';
      pathInp.spellcheck = false;
      pathInp.addEventListener('input', function () {
        ur.path = cleanPath(pathInp.value);
        syncRulesToRaw();
      });
      permRow.appendChild(pathInp);

      var chipsBox = document.createElement('div');
      chipsBox.className = 'adm-perms-row';

      [
        { bit: 'r', title: 'Read (R)' },
        { bit: 'u', title: 'Upload (U)' },
        { bit: 'w', title: 'Write (W)' },
        { bit: 'd', title: 'Delete (D)' }
      ].forEach(function (pdef) {
        var chip = document.createElement('label');
        chip.className = 'adm-chip';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!ur[pdef.bit];
        cb.addEventListener('change', function () {
          ur[pdef.bit] = cb.checked;
          syncRulesToRaw();
        });
        chip.appendChild(cb);
        var txt = document.createElement('span');
        txt.textContent = pdef.bit.toUpperCase();
        txt.title = pdef.title;
        chip.appendChild(txt);
        chipsBox.appendChild(chip);
      });
      permRow.appendChild(chipsBox);

      body.appendChild(permRow);
      card.appendChild(body);

      host.appendChild(card);
    });
  }

  function saveACL(showToast) {
    var rules = gatherAllRules();
    var payloadText = serializeRules(rules);
    return api('api/acl', 'POST', { rules: rules, text: payloadText }).then(function (r) {
      if (r && r.ok) {
        if (showToast !== false) {
          G.toast('Permissions saved (' + (r.count || rules.length) + ' rules active)', { kind: 'success' });
        }
        syncRulesToRaw();
      } else {
        G.toast((r && r.error && r.error.message) || 'failed to save permissions', { kind: 'error' });
      }
    });
  }

  function load() {
    api('api/users').then(function (ru) {
      if (!ru || !ru.ok) {
        G.toast((ru && ru.error && ru.error.message) || 'admin only', { kind: 'error' });
        return;
      }
      currentUsers = (ru.users || []).filter(function(u){ return !u.admin; });
      var pEl = $('adm-aclpath');
      if (pEl) pEl.textContent = ru.acl_path || '';

      api('api/acl').then(function (ra) {
        var rawRules = [];
        if (ra && ra.ok) {
          if (ra.rules && ra.rules.length) {
            rawRules = ra.rules;
          } else {
            rawRules = parseRuleLines(ra.text || '');
          }
          if (pEl && ra.path) pEl.textContent = ra.path;
        }

        // 1. Identify public access rule
        publicAccess = { enabled: false, path: '/Public', r: true, u: false, w: false, d: false };
        for (var i = 0; i < rawRules.length; i++) {
          var rl = rawRules[i];
          if (!rl.user || rl.user === '@') {
            publicAccess.enabled = true;
            publicAccess.path = cleanPath(rl.path) || '/Public';
            publicAccess.r = !!rl.r;
            publicAccess.u = !!rl.u;
            publicAccess.w = !!rl.w;
            publicAccess.d = !!rl.d;
            break;
          }
        }

        // 2. Identify user rules
        userRules = {};
        currentUsers.forEach(function (u) {
          if (u.admin) return;
          var matched = null;
          for (var j = 0; j < rawRules.length; j++) {
            if (rawRules[j].user === u.name) {
              matched = rawRules[j];
              break;
            }
          }
          if (matched) {
            userRules[u.name] = {
              path: cleanPath(matched.path) || u.home || '/',
              r: !!matched.r,
              u: !!matched.u,
              w: !!matched.w,
              d: !!matched.d
            };
          } else {
            // Default user permission rule
            userRules[u.name] = {
              path: u.home || '/',
              r: true,
              u: true,
              w: true,
              d: false
            };
          }
        });

        renderPublicAccess();
        renderUsers();
        syncRulesToRaw();
      });
    }, function () {
      G.toast('admin only', { kind: 'error' });
    });
  }

  function wire() {
    if (wired) return;
    wired = true;

    // Public toggle
    var pubToggle = $('adm-pub-toggle');
    if (pubToggle) {
      pubToggle.addEventListener('change', function () {
        publicAccess.enabled = pubToggle.checked;
        var cfgBox = $('adm-pub-config');
        if (cfgBox) cfgBox.style.display = publicAccess.enabled ? 'block' : 'none';
        var statusText = $('adm-pub-status-text');
        if (statusText) {
          if (publicAccess.enabled) {
            statusText.textContent = 'Enabled: guests can access ' + (publicAccess.path || '/Public');
            statusText.style.color = 'var(--accent)';
          } else {
            statusText.textContent = 'Disabled (Login required for all paths)';
            statusText.style.color = 'var(--muted)';
          }
        }
        syncRulesToRaw();
      });
    }

    var pubPath = $('adm-pub-path');
    if (pubPath) {
      pubPath.addEventListener('input', function () {
        publicAccess.path = cleanPath(pubPath.value);
        syncRulesToRaw();
      });
    }

    ['r', 'u', 'w', 'd'].forEach(function (b) {
      var cb = $('adm-pub-' + b);
      if (cb) {
        cb.addEventListener('change', function () {
          publicAccess[b] = cb.checked;
          syncRulesToRaw();
        });
      }
    });

    // Add user
    var addBtn = $('adm-user-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var uInp = $('adm-user-name');
        var pInp = $('adm-user-pass');
        var hInp = $('adm-user-home');
        var name = uInp ? uInp.value.trim() : '';
        var pass = pInp ? pInp.value : '';
        var home = hInp && hInp.value.trim() ? hInp.value.trim() : '/';

        if (!name || !pass) {
          G.toast('Username and password required', { kind: 'error' });
          return;
        }

        api('api/users', 'POST', { user: name, pass: pass, home: home }).then(function (r) {
          if (r && r.ok) {
            if (uInp) uInp.value = '';
            if (pInp) pInp.value = '';
            if (hInp) hInp.value = '/';
            G.toast('User added: ' + name, { kind: 'success' });

            // Automatically set user permissions
            userRules[name] = {
              path: cleanPath(home),
              r: $('adm-new-r') ? $('adm-new-r').checked : true,
              u: $('adm-new-u') ? $('adm-new-u').checked : true,
              w: $('adm-new-w') ? $('adm-new-w').checked : true,
              d: $('adm-new-d') ? $('adm-new-d').checked : false
            };
            saveACL(false);
            load();
          } else {
            G.toast((r && r.error && r.error.message) || 'failed to add user', { kind: 'error' });
          }
        });
      });
    }

    // Save All Permissions
    var saveBtn = $('adm-acl-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveACL(true);
      });
    }
  }

  G.admin = {
    open: function () {
      sheet = sheet || $('admin-sheet');
      if (!sheet) {
        G.toast('admin UI unavailable', { kind: 'error' });
        return;
      }
      sheet.hidden = false;
      sheet.classList.add('open');
      wire();
      load();
    },
    close: function () {
      sheet = sheet || $('admin-sheet');
      if (!sheet) return;
      sheet.hidden = true;
      sheet.classList.remove('open');
    }
  };
})();
