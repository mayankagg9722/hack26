/* Integrations → Customer migration (JSM customers → Freshservice employees).
   Talks only to /api/customer-migrations; all JSM/Freshservice API calls and
   credentials stay on the server. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  if (!$('cmCard')) return;
  var cfg = null;
  var list = [];
  var current = null;   // full migration being shown
  var polling = false;
  var showDetails = false;
  var filter = 'ALL';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status); return d; }); });
  }
  function when(iso) {
    return iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';
  }
  function note(t) { $('cmNote').textContent = t || ''; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- config ---------- */
  function loadConfig() {
    return api('GET', '/api/customer-migrations/config').then(function (c) {
      cfg = c;
      var ok = function (x) {
        if (x.missing_config && x.missing_config.length) return '<em class="warn">⚠ Needs configuration</em>';
        return '<em class="ok">✓ Connected</em>' + (x.mode === 'mock' ? ' <em>demo mode</em>' : '');
      };
      $('cmSourceState').outerHTML = '<span id="cmSourceState">' + ok(c.source) + '</span>';
      $('cmTargetState').outerHTML = '<span id="cmTargetState">' + ok(c.target) + '</span>';
      $('cmProject').innerHTML = c.projects.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') ||
        '<option value="">No project configured</option>';
      $('cmReset').hidden = !(c.source.mode === 'mock' && c.target.mode === 'mock');
      if (c.source.missing_config && c.source.missing_config.length) {
        note('JSM needs: ' + c.source.missing_config.join(', ') + ' (server configuration).');
      }
    });
  }

  /* ---------- list / history ---------- */
  function loadList() {
    return api('GET', '/api/customer-migrations').then(function (d) {
      list = d.migrations || [];
      renderHistory();
      var target = current ? list.filter(function (m) { return m.id === current.id; })[0] : list[0];
      if (target && (!current || target.status !== current.status || target.updated_at !== current.updated_at)) return open(target.id);
      if (!list.length) renderLive();
    });
  }

  function open(id) {
    return api('GET', '/api/customer-migrations/' + encodeURIComponent(id)).then(function (d) {
      current = d.migration;
      renderLive();
      renderHistory();
      if (current.status === 'RUNNING') drive();
    });
  }

  /* ---------- run ---------- */
  function start(scheduledAt) {
    var body = { project_id: $('cmProject').value, customer_count: parseInt($('cmCount').value, 10) || 100 };
    if (scheduledAt) body.scheduled_at = scheduledAt;
    $('cmStart').disabled = true;
    return api('POST', '/api/customer-migrations', body)
      .then(function (d) {
        current = d.migration;
        showDetails = false;
        note(scheduledAt ? 'Scheduled for ' + when(scheduledAt) + '. Zen will run it automatically.' : '');
        renderLive();
        return loadList().then(function () { if (current.status === 'RUNNING') drive(); });
      })
      .catch(function (err) { note('Could not start: ' + err.message); })
      .then(function () { $('cmStart').disabled = false; });
  }

  function drive() {
    if (polling || !current || current.status !== 'RUNNING') return;
    polling = true;
    var id = current.id;
    (function step() {
      if (!current || current.id !== id || current.status !== 'RUNNING') {
        polling = false;
        // another migration may have started while this loop was finishing — hand over to it
        if (current && current.status === 'RUNNING') drive(); else loadList();
        return;
      }
      api('POST', '/api/customer-migrations/' + encodeURIComponent(id) + '/advance', {})
        .then(function (d) { current = d.migration; renderLive(); })
        .catch(function (err) { note('Migration step failed: ' + err.message); current.status = 'FAILED'; })
        .then(function () { return sleep(80); })
        .then(step);
    })();
  }

  function retryFailed() {
    api('POST', '/api/customer-migrations/' + encodeURIComponent(current.id) + '/retry-failed', {})
      .then(function (d) { current = d.migration; renderLive(); drive(); })
      .catch(function (err) { note('Could not retry: ' + err.message); });
  }

  /* ---------- render ---------- */
  function title(m) {
    return {
      RUNNING: 'Migration in progress', SCHEDULED: 'Migration scheduled', COMPLETED: 'Migration complete',
      COMPLETED_WITH_EXCEPTIONS: 'Migration completed with exceptions', FAILED: 'Migration stopped'
    }[m.status] || m.status;
  }

  function renderLive() {
    var box = $('cmLive');
    var m = current;
    if (!m) { box.innerHTML = ''; return; }
    var s = m.summary;
    var cls = m.status === 'COMPLETED' ? ' done' : m.status === 'COMPLETED_WITH_EXCEPTIONS' ? ' exc' : m.status === 'FAILED' ? ' bad' : '';
    var icon = function (st) { return { done: '✓', running: '⟳', failed: '✕', pending: '○' }[st] || '○'; };
    var steps = '<ul class="cm-steps">' + m.steps.map(function (x) {
      return '<li class="' + x.status + '"><i>' + icon(x.status) + '</i><div>' + esc(x.status === 'running' && x.running ? x.running : x.label) +
        (x.detail ? '<small>' + esc(x.detail) + '</small>' : '') + '</div></li>';
    }).join('') + '</ul>';
    var pct = function (n) { return s.total ? (n / s.total) * 100 : 0; };
    var finished = ['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'FAILED'].indexOf(m.status) > -1;
    var failed = (m.records || []).filter(function (r) { return r.status === 'FAILED'; });

    var right;
    if (m.status === 'SCHEDULED') {
      right = '<div class="cm-count">' + esc(when(m.config.scheduled_at)) + '</div><p class="cm-sub">Zen starts automatically at this time using the same workflow as Start Migration. ' + s.total + ' customers → ' + esc(m.config.project_name) + '.</p>';
    } else {
      right = '<div class="cm-count">' + (s.migrated + s.skipped) + ' <small>/ ' + s.total + ' customers migrated</small></div>' +
        '<div class="cm-bar"><i style="width:' + pct(s.migrated) + '%;background:#12A150"></i><i style="width:' + pct(s.skipped) + '%;background:#2B6BFF"></i><i style="width:' + pct(s.failed) + '%;background:#E5484D"></i></div>' +
        '<div class="cm-tiles"><div class="cm-tile m"><b>' + s.migrated + '</b><span>Migrated</span></div><div class="cm-tile s"><b>' + s.skipped + '</b><span>Skipped</span></div><div class="cm-tile f"><b>' + s.failed + '</b><span>Failed</span></div></div>' +
        (failed.length ? '<div class="cm-failed"><h4>Failed</h4><ul>' + failed.slice(0, 5).map(function (r) {
          return '<li><b>' + esc(r.name || '(no name in JSM)') + '</b> — ' + esc(r.message) + '</li>';
        }).join('') + (failed.length > 5 ? '<li>…and ' + (failed.length - 5) + ' more</li>' : '') + '</ul></div>' : '') +
        (m.error ? '<div class="cm-error">' + esc(m.error) + '</div>' : '');
    }

    var rows = (m.records || []).filter(function (r) { return filter === 'ALL' || r.status === filter; });
    var count = function (st) { return (m.records || []).filter(function (r) { return st === 'ALL' || r.status === st; }).length; };
    var details = showDetails ? '<div class="cm-details"><div class="cm-filters">' +
      [['ALL', 'All'], ['MIGRATED', 'Migrated'], ['SKIPPED', 'Skipped'], ['FAILED', 'Failed']].map(function (f) {
        return '<button type="button" class="chip' + (filter === f[0] ? ' is-active' : '') + '" data-cm-filter="' + f[0] + '">' + f[1] + ' (' + count(f[0]) + ')</button>';
      }).join('') + '</div><div class="cm-table-wrap"><table class="hub-table cm-table"><thead><tr><th>JSM Customer ID</th><th>Customer</th><th>Freshservice Employee ID</th><th>Status</th><th>Note</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td><code>' + esc(r.jsm_customer_id || '—') + '</code></td><td><b>' + esc(r.name || '(no name)') + '</b><br><small class="wave-muted">' + esc(r.email) + '</small></td>' +
          '<td><code>' + esc(r.fs_employee_id || '—') + '</code></td><td><em class="' + esc(r.status) + '">' + esc(r.status.replace('_', ' ')) + '</em></td><td class="msg">' + esc(r.message || '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' : '';

    box.innerHTML = '<div class="cm-live' + cls + '">' +
      '<h3>' + (m.status === 'RUNNING' ? '<span class="run-live"></span>' : m.status === 'COMPLETED' ? '✓' : m.status === 'SCHEDULED' ? '🕒' : '⚠') + ' ' + esc(title(m)) +
        ' <small>' + esc(m.id) + (m.retries ? ' · retried ' + m.retries + '×' : '') + '</small></h3>' +
      '<p class="cm-sub">' + esc(m.source.name) + ' → ' + esc(m.target.name) + ' · Customers → Employees · project ' + esc(m.config.project_name) +
        (m.source.mode === 'mock' ? ' · demo mode' : '') + (m.finished_at ? ' · finished ' + esc(when(m.finished_at)) : m.started_at ? ' · started ' + esc(when(m.started_at)) : '') + '</p>' +
      '<div class="cm-body"><div>' + steps + '</div><div>' + right + '</div></div>' +
      (finished ? '<div class="cm-live-actions"><button class="mini ghost" id="cmDetailsBtn">' + (showDetails ? 'Hide Migration Details' : 'View Migration Details') + '</button>' +
        (failed.length || m.status === 'FAILED' ? '<button class="mini" id="cmRetryBtn">Retry Failed</button>' : '') + '</div>' : '') +
      details + '</div>';

    var d = $('cmDetailsBtn');
    if (d) d.addEventListener('click', function () { showDetails = !showDetails; renderLive(); });
    var r = $('cmRetryBtn');
    if (r) r.addEventListener('click', retryFailed);
    box.querySelectorAll('[data-cm-filter]').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.getAttribute('data-cm-filter'); renderLive(); });
    });
  }

  function renderHistory() {
    var others = list.filter(function (m) { return !current || m.id !== current.id || list.length > 1; });
    if (list.length < 2) { $('cmHistory').innerHTML = ''; return; }
    $('cmHistory').innerHTML = '<div class="cm-hist"><h4>Customer migrations</h4>' + others.slice(0, 6).map(function (m) {
      var s = m.summary;
      return '<button type="button" data-cm-open="' + esc(m.id) + '" class="' + (current && current.id === m.id ? 'is-active' : '') + '"><b>' + esc(title(m)) + '</b><span>' +
        (m.status === 'SCHEDULED' ? 'at ' + esc(when(m.config.scheduled_at)) : s.migrated + ' migrated · ' + s.skipped + ' skipped · ' + s.failed + ' failed') + ' · ' + esc(when(m.created_at)) + '</span></button>';
    }).join('') + '</div>';
    $('cmHistory').querySelectorAll('[data-cm-open]').forEach(function (b) {
      b.addEventListener('click', function () { showDetails = false; open(b.getAttribute('data-cm-open')); });
    });
  }

  /* ---------- wire up ---------- */
  $('cmStart').addEventListener('click', function () { start(null); });
  $('cmScheduleToggle').addEventListener('click', function () {
    var b = $('cmScheduleBox');
    b.hidden = !b.hidden;
    if (!b.hidden && !$('cmWhen').value) {
      var d = new Date(Date.now() + 2 * 60000);
      var p = function (n) { return String(n).padStart(2, '0'); };
      $('cmWhen').value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
  });
  $('cmSchedule').addEventListener('click', function () {
    var v = $('cmWhen').value;
    if (!v) return;
    start(new Date(v).toISOString());
  });
  $('cmReset').addEventListener('click', function () {
    if (!window.confirm('Reset the customer migration demo? This clears the simulated JSM customers, Freshservice employees, mappings and customer migration history.')) return;
    api('POST', '/api/customer-migrations/demo-reset', {}).then(function () { current = null; list = []; renderLive(); renderHistory(); note('Demo data reset.'); })
      .catch(function (err) { note('Could not reset: ' + err.message); });
  });

  loadConfig().then(loadList).catch(function (err) { note('Customer migration service unavailable: ' + err.message); });
  // start scheduled migrations while this page is open (the server scheduler does it otherwise)
  setInterval(function () { if (!polling) loadList().catch(function () {}); }, 5000);
})();
