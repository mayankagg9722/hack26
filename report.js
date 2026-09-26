/* Zen migration report — renders GET /api/runs/:id/report. Every number here
   comes from the stored migration run; nothing is hard-coded. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var COLORS = { first: 'var(--rp-first)', auto: 'var(--rp-auto)', human: 'var(--rp-human)', open: 'var(--rp-open)' };
  var report = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(x) { return Number(x || 0).toLocaleString(); }
  function pct(x, digits) { return (x * 100).toFixed(digits == null ? 1 : digits).replace(/\.0$/, '') + '%'; }
  function dur(ms) {
    if (ms < 1000) return Math.max(0, Math.round(ms)) + ' ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ' + Math.round(s % 60) + ' s';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function when(iso) {
    return iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso)) : '—';
  }
  function time(iso) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
  }

  /* ---------- hover tooltip (shared) ---------- */
  var tip = $('rpTip');
  document.addEventListener('mousemove', function (e) {
    var t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t.getAttribute('data-tip');
    tip.hidden = false;
    var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 10);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
  });

  /* ---------- sections ---------- */
  function hero(r) {
    var rec = r.reconciliation.status;
    var cls = { 'COMPLETE': '', 'PARTIALLY COMPLETE': 'partial', 'FAILED': 'failed', 'IN PROGRESS': 'running' }[rec];
    var head = r.status === 'COMPLETED' ? (rec === 'COMPLETE' ? 'Migration complete' : 'Migration complete — ' + n(r.reconciliation.unresolved) + ' not migrated')
      : r.status === 'STOPPED' ? 'Migration stopped' : r.status === 'FAILED' ? 'Migration failed'
        : r.status === 'HUMAN_REVIEW_REQUIRED' ? 'Waiting for human review' : 'Migration in progress';
    $('rpHero').innerHTML =
      '<div><span class="rp-status ' + cls + '">' + (rec === 'COMPLETE' ? '✓' : rec === 'IN PROGRESS' ? '●' : '⚠') + ' ' + esc(rec) + '</span>' +
        '<h1>' + esc(head) + '</h1>' +
        '<p>' + esc(r.source.name) + ' <i>→</i> ' + esc(r.target.name) + (r.goal_title ? ' · ' + esc(r.goal_title.split(':')[0]) : '') + '</p>' +
        '<div class="rp-meta"><span>Migration <b>' + esc(r.run_id) + '</b></span><span>Started <b>' + esc(when(r.started_at)) + '</b></span>' +
          '<span>Finished <b>' + esc(when(r.finished_at)) + '</b></span><span>Took <b>' + esc(dur(r.value.elapsed_ms)) + '</b></span>' +
          (r.mapping_version ? '<span>Mapping <b>v' + esc(r.mapping_version) + '</b></span>' : '') + '</div></div>' +
      '<div class="rp-score"><b>' + pct(r.rates.success_rate) + '</b><span>success rate · ' + n(r.totals.migrated) + ' of ' + n(r.totals.total_records) + ' records in ' + esc(r.target.name) + '</span>' +
        '<div class="rp-actions"><button class="mini ghost" id="rpJson">Download JSON</button><button class="mini ghost" onclick="window.print()">Print / PDF</button>' +
        '<a class="mini" href="planner.html?goal=' + encodeURIComponent(r.goal_id) + '">Open goal</a></div></div>';
    $('rpJson').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'zen-migration-report-' + r.run_id + '.json';
      a.click();
    });
  }

  function kpis(r) {
    var t = r.totals;
    var tile = function (label, value, sub, color) {
      return '<div class="rp-kpi">' + (color ? '<i style="background:' + color + '"></i>' : '') + '<span>' + label + '</span><b>' + value + '</b><small>' + sub + '</small></div>';
    };
    $('rpKpis').innerHTML =
      tile('Total records', n(t.total_records), t.already_migrated ? n(t.already_migrated) + ' from an earlier run' : 'in scope') +
      tile('Migrated first time', n(t.first_pass_success), pct(r.rates.first_pass_rate) + ' first-pass', COLORS.first) +
      tile('Auto-remediated', n(t.auto_remediated), 'fixed by Zen' + (r.rates.ai_resolved ? ', ' + r.rates.ai_resolved + ' with Claude' : ''), COLORS.auto) +
      tile('Resolved by humans', n(t.human_resolved), n(t.escalated) + ' escalated', COLORS.human) +
      tile('Not migrated', n(t.not_migrated), [t.skipped && n(t.skipped) + ' skipped', t.deferred && n(t.deferred) + ' deferred', t.awaiting && n(t.awaiting) + ' awaiting'].filter(Boolean).join(' · ') || 'none', COLORS.open) +
      tile('Success rate', pct(r.rates.success_rate), n(t.failed_first_pass) + ' failed on first attempt');
  }

  function outcome(r) {
    var t = r.totals;
    var parts = [
      { key: 'first', label: 'Migrated first time', v: t.first_pass_success + t.already_migrated },
      { key: 'auto', label: 'Auto-remediated by Zen', v: t.auto_remediated },
      { key: 'human', label: 'Resolved by a human', v: t.human_resolved },
      { key: 'open', label: '⚠ Not migrated', v: t.not_migrated }
    ].filter(function (p) { return p.v > 0; });
    var total = t.total_records || 1;
    $('rpOutcome').innerHTML =
      '<div class="rp-bar" role="img" aria-label="Record outcomes">' + parts.map(function (p) {
        return '<div style="flex:' + p.v + ';background:' + COLORS[p.key] + '" data-tip="<b>' + esc(p.label) + '</b>' + n(p.v) + ' records · ' + pct(p.v / total) + '"></div>';
      }).join('') + '</div>' +
      '<div class="rp-legend">' + parts.map(function (p) {
        return '<div><i style="background:' + COLORS[p.key] + '"></i>' + esc(p.label) + ' <b>' + n(p.v) + '</b><small>' + pct(p.v / total) + '</small></div>';
      }).join('') + '</div>' +
      '<table class="hub-table rp-table" id="outcomeTable" hidden><thead><tr><th>Outcome</th><th class="num">Records</th><th class="num">Share</th></tr></thead><tbody>' +
        parts.map(function (p) { return '<tr><td>' + esc(p.label) + '</td><td class="num">' + n(p.v) + '</td><td class="num">' + pct(p.v / total) + '</td></tr>'; }).join('') +
        '<tr><td><b>Total</b></td><td class="num"><b>' + n(total) + '</b></td><td class="num">100%</td></tr></tbody></table>';
  }

  function reconciliation(r) {
    var rc = r.reconciliation;
    var cls = { 'COMPLETE': 'ok', 'PARTIALLY COMPLETE': 'partial', 'FAILED': 'failed', 'IN PROGRESS': 'running' }[rc.status];
    $('rpRecBadge').innerHTML = '<span class="rp-pill ' + cls + '">' + (rc.status === 'COMPLETE' ? '✓ ' : '⚠ ') + esc(rc.status) + '</span>';
    var b = rc.unresolved_breakdown;
    $('rpRec').innerHTML =
      '<div class="rp-rec-flow"><div><span>Source records</span><b>' + n(rc.source_records) + '</b></div><em>→</em>' +
        '<div><span>Target records</span><b>' + n(rc.target_records) + '</b></div><em>=</em>' +
        '<div class="unres"><span>Unresolved</span><b>' + n(rc.unresolved) + '</b></div></div>' +
      '<div class="rp-list">' +
        '<div><span>Verified in ' + esc(r.target.name) + ' (read back after writing)</span><b>' + n(rc.target_records) + '</b></div>' +
        '<div><span>Skipped by a human decision</span><b>' + n(b.skipped) + '</b></div>' +
        '<div><span>Deferred</span><b>' + n(b.deferred) + '</b></div>' +
        (b.awaiting ? '<div><span>Awaiting a decision</span><b>' + n(b.awaiting) + '</b></div>' : '') +
        '<div><span>Problems found in target verification</span><b>' + n(rc.verification_problems) + '</b></div>' +
      '</div>' +
      '<table class="hub-table rp-table"><thead><tr><th>Wave</th><th class="num">Source</th><th class="num">Target</th><th>Reconciled</th></tr></thead><tbody>' +
        rc.waves.map(function (w) {
          return '<tr><td><b>' + esc(w.name) + '</b> <small class="wave-muted">' + esc(w.workspace) + '</small></td><td class="num">' + n(w.source) + '</td><td class="num">' + n(w.target) + '</td><td>' +
            (w.match === null ? '—' : w.source === w.target ? '<em class="ok">✓ Matched</em>' : '<em class="warn">' + n(w.source - w.target) + ' unresolved</em>') + '</td></tr>';
        }).join('') + '</tbody></table>';
  }

  function value(r) {
    var v = r.value;
    var t = r.totals;
    $('rpValueNote').textContent = v.demo_target ? 'demo target (simulated API latency)' : '';
    var box = function (label, val, sub, hi) { return '<div class="rp-value' + (hi ? ' hi' : '') + '"><span>' + label + '</span><b>' + val + '</b><small>' + sub + '</small></div>'; };
    $('rpValue').innerHTML = '<div class="rp-values">' +
      box('Time taken', dur(v.elapsed_ms), 'start to finish', false) +
      box('Records per minute', n(v.records_per_minute), 'during Zen processing (' + dur(v.processing_ms) + ')', true) +
      box('Automatic remediation rate', pct(r.rates.auto_remediation_rate), n(t.auto_remediated) + ' of ' + n(t.failed_first_pass) + ' failures fixed without a person', true) +
      box('Human intervention rate', pct(r.rates.human_intervention_rate, 1), n(t.escalated) + ' of ' + n(t.total_records) + ' records needed a person', false) +
      box('Success rate', pct(r.rates.success_rate), n(t.migrated) + ' records in ' + esc(r.target.name), false) +
      box('Human decision time', dur(v.human_wait_ms), v.paused_ms ? 'plus ' + dur(v.paused_ms) + ' paused by an admin' : 'time the migration waited for review', false) +
    '</div>';
  }

  function failures(r) {
    var rows = r.failure_breakdown;
    if (!rows.length) { $('rpFailures').innerHTML = '<p class="int-note">No failures — every record migrated on the first attempt.</p>'; return; }
    var max = Math.max.apply(null, rows.map(function (c) { return c.detected; }));
    var seg = function (key, v, label, c) {
      return v ? '<div style="flex:' + v + ';background:' + COLORS[key] + '" data-tip="<b>' + esc(c.label) + '</b>' + esc(label) + ': ' + n(v) + ' of ' + n(c.detected) + '"></div>' : '';
    };
    $('rpFailures').innerHTML =
      '<div class="rp-hbars">' + rows.map(function (c) {
        return '<div class="rp-hrow"><span>' + esc(c.label) + '</span><div class="rp-htrack" style="width:' + Math.max(4, (c.detected / max) * 100) + '%">' +
          seg('auto', c.auto_fixed, 'Auto-fixed by Zen', c) + seg('human', c.human_resolved, 'Resolved by a human', c) + seg('open', c.unresolved, 'Not migrated', c) +
          '</div><b>' + n(c.detected) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="rp-legend"><div><i style="background:' + COLORS.auto + '"></i>Auto-fixed by Zen</div><div><i style="background:' + COLORS.human + '"></i>Resolved by a human</div><div><i style="background:' + COLORS.open + '"></i>⚠ Not migrated</div></div>' +
      '<table class="hub-table rp-table" id="failureTable" hidden><thead><tr><th>Category</th><th class="num">Detected</th><th class="num">Auto-fixed</th><th class="num">By a human</th><th class="num">Not migrated</th></tr></thead><tbody>' +
        rows.map(function (c) { return '<tr><td>' + esc(c.label) + '</td><td class="num">' + n(c.detected) + '</td><td class="num">' + n(c.auto_fixed) + '</td><td class="num">' + n(c.human_resolved) + '</td><td class="num">' + n(c.unresolved) + '</td></tr>'; }).join('') +
      '</tbody></table>';
  }

  function waves(r) {
    $('rpWaves').innerHTML = '<table class="hub-table rp-table"><thead><tr><th>Wave</th><th class="num">Records</th><th class="num">First time</th><th class="num">Auto-fixed</th><th class="num">Human</th><th class="num">Success</th><th>Status</th></tr></thead><tbody>' +
      r.waves.map(function (w) {
        return '<tr><td><b>' + esc(w.name) + '</b><br><small class="wave-muted">' + esc(w.workspace) + '</small></td><td class="num">' + n(w.processed) + '</td><td class="num">' + n(w.first_pass) +
          '</td><td class="num">' + n(w.auto_remediated) + '</td><td class="num">' + n(w.human_resolved) + '</td><td class="num">' + pct(w.success_rate) + '</td><td>' +
          (w.phase === 'COMPLETED' ? '<em class="ok">Completed</em>' : '<em>' + esc(w.phase.replace(/_/g, ' ').toLowerCase()) + '</em>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function workspaces(r) {
    if (!r.workspaces.length) { $('rpWorkspaces').innerHTML = '<p class="int-note">Nothing written yet.</p>'; return; }
    var max = r.workspaces[0].records;
    $('rpWorkspaces').innerHTML = '<div class="rp-ws">' + r.workspaces.map(function (w) {
      return '<div class="rp-wsrow" data-tip="<b>' + esc(w.name) + '</b>' + n(w.records) + ' records written"><span>' + esc(w.name) + '</span><div><i style="width:' + Math.max(2, (w.records / max) * 100) + '%"></i></div><b>' + n(w.records) + '</b></div>';
    }).join('') + '</div><p class="int-note">Records written by this migration, by the workspace they landed in (after department corrections).</p>';
  }

  function unresolved(r) {
    var list = r.unresolved_records;
    $('rpUnresolvedCount').textContent = list.length ? list.length + ' record' + (list.length > 1 ? 's' : '') : '';
    $('rpUnresolved').innerHTML = list.length ? '<div class="rp-un">' + list.map(function (u) {
      return '<div><b>' + esc(u.record_id) + '</b>' + esc(u.category) + ' · <span class="wave-muted">' + esc(u.status.replace(/_/g, ' ').toLowerCase()) + (u.decision ? ' (' + esc(u.decision.replace('_', ' ')) + ')' : '') + '</span><small>' + esc(u.reason) + '</small></div>';
    }).join('') + '</div>' : '<p class="int-note">✓ Every record reached ' + esc(r.target.name) + '.</p>';
  }

  function timeline(r) {
    $('rpTimeline').innerHTML = '<div class="rp-tl">' + r.timeline.slice().reverse().map(function (e) {
      return '<div><time>' + esc(time(e.at)) + '</time><span class="' + esc(e.level) + '">' + esc(e.message) + '</span></div>';
    }).join('') + '</div>';
  }

  function render(r) {
    report = r;
    document.title = 'Migration report ' + r.run_id + ' — Zen';
    hero(r); kpis(r); outcome(r); reconciliation(r); value(r); failures(r); waves(r); workspaces(r); unresolved(r); timeline(r);
    $('rpFoot').textContent = 'Generated ' + when(r.generated_at) + ' from the live migration state of ' + r.run_id + '. Success rate = records now in ' + r.target.name +
      ' ÷ total records. Reconciliation counts records read back from ' + r.target.name + ' after writing.';
    $('report').hidden = false;
    document.querySelectorAll('[data-table]').forEach(function (b) {
      b.onclick = function () {
        var t = $(b.getAttribute('data-table'));
        t.hidden = !t.hidden;
        b.textContent = t.hidden ? 'Show table' : 'Hide table';
      };
    });
  }

  function load(runId) {
    fetch('/api/runs/' + encodeURIComponent(runId) + '/report')
      .then(function (res) { return res.json().then(function (d) { if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status); return d; }); })
      .then(function (d) {
        render(d.report);
        // keep a live report fresh while the migration is still going
        if (d.report.reconciliation.status === 'IN PROGRESS') setTimeout(function () { load(runId); }, 2000);
      })
      .catch(function (err) {
        $('rpAlert').innerHTML = 'Could not load the migration report: ' + esc(err.message) + '. <a href="history.html"><b>Open migration history</b></a>.';
        $('rpAlert').hidden = false;
      });
  }

  var runId = new URLSearchParams(location.search).get('run');
  if (runId) load(runId);
  else {
    // no id: open the most recent migration
    fetch('/api/runs?view=history').then(function (r) { return r.json(); }).then(function (d) {
      if (d.history && d.history.length) location.replace('report.html?run=' + encodeURIComponent(d.history[0].run_id));
      else { $('rpAlert').innerHTML = 'No migrations yet. <a href="planner.html"><b>Plan and run one</b></a>.'; $('rpAlert').hidden = false; }
    });
  }
})();
