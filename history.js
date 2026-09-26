/* Zen migration history — one row per migration run from GET /api/runs?view=history. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(x) { return Number(x || 0).toLocaleString(); }
  function pct(x) { return (x * 100).toFixed(1).replace(/\.0$/, '') + '%'; }
  function when(iso) {
    return iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
  }
  var STATUS = {
    COMPLETED: ['ok', 'Completed'], HUMAN_REVIEW_REQUIRED: ['warn', 'Human review'], STOPPED: ['', 'Stopped'], FAILED: ['bad', 'Failed'],
    BLOCKED: ['bad', 'Blocked'], PAUSED: ['warn', 'Paused']
  };

  fetch('/api/runs?view=history')
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (d) {
      var rows = d.history || [];
      $('hsCount').textContent = rows.length + ' migration' + (rows.length === 1 ? '' : 's');
      var done = rows.filter(function (r) { return r.status === 'COMPLETED'; });
      var processed = rows.reduce(function (a, r) { return a + r.records_processed; }, 0);
      var failures = rows.reduce(function (a, r) { return a + r.failures; }, 0);
      var auto = rows.reduce(function (a, r) { return a + r.auto_remediated; }, 0);
      var human = rows.reduce(function (a, r) { return a + r.human_interventions; }, 0);
      var tile = function (label, v, sub) { return '<div class="rp-kpi"><span>' + label + '</span><b>' + v + '</b><small>' + sub + '</small></div>'; };
      $('hsKpis').innerHTML =
        tile('Migrations', n(rows.length), n(done.length) + ' completed') +
        tile('Records processed', n(processed), 'across all migrations') +
        tile('Average success', done.length ? pct(done.reduce(function (a, r) { return a + r.success_rate; }, 0) / done.length) : '—', 'completed migrations') +
        tile('Failures detected', n(failures), 'on first attempt') +
        tile('Auto-remediated', n(auto), failures ? pct(auto / failures) + ' of failures' : '—') +
        tile('Human interventions', n(human), processed ? pct(human / processed) + ' of records' : '—');
      if (!rows.length) {
        $('hsRows').innerHTML = '<tr><td colspan="10" class="wave-muted">No migrations yet. <a href="planner.html"><b>Plan and run one</b></a>.</td></tr>';
        return;
      }
      $('hsRows').innerHTML = rows.map(function (r) {
        var st = STATUS[r.status] || ['', r.status.replace(/_/g, ' ').toLowerCase()];
        return '<tr' + (/bad/.test(st[0]) ? ' class="is-risk"' : '') + '><td><code>' + esc(r.run_id) + '</code><small>' + esc((r.goal_title || '').split(':')[0]) + '</small></td>' +
          '<td>' + esc(r.source) + ' → ' + esc(r.target) + '</td><td>' + esc(when(r.started_at)) + '</td><td>' + esc(when(r.finished_at)) + '</td>' +
          '<td>' + n(r.records_processed) + (r.total_records !== r.records_processed ? '<small>of ' + n(r.total_records) + '</small>' : '') + '</td>' +
          '<td><b>' + pct(r.success_rate) + '</b><small>' + esc(r.reconciliation.toLowerCase()) + '</small></td>' +
          '<td>' + n(r.failures) + '<small>' + n(r.auto_remediated) + ' auto-fixed</small></td><td>' + n(r.human_interventions) + '</td>' +
          '<td><em class="' + st[0] + '">' + esc(st[1]) + '</em></td>' +
          '<td><a class="mini ghost" href="report.html?run=' + encodeURIComponent(r.run_id) + '">Report →</a></td></tr>';
      }).join('');
    })
    .catch(function (err) {
      $('hsAlert').innerHTML = 'Could not load migration history: ' + esc(err.message);
      $('hsAlert').hidden = false;
    });
})();
