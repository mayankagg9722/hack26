/* Admin Hub — "Upcoming migration goals" card. Reads scheduled goals from
   /api/goals (functions/migration/goals) and lists each wave. */
(function () {
  'use strict';

  var body = document.getElementById('goalsBody');
  if (!body) return;
  var MAX_ROWS = 5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(iso, tz) {
    if (!iso) return '';
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      .format(new Date(iso));
  }
  function statusClass(label) {
    if (/^Scheduled/.test(label)) return 'sched';
    if (/^(Ready|Completed)/.test(label)) return 'ok';
    if (/^(Blocked|Human review|Failed)/.test(label)) return 'bad';
    if (/^(Paused|Pre-check|Waiting)/.test(label)) return 'warn';
    return '';
  }
  function shortName(name) { return String(name).replace(/ Service Management$/, ''); }

  fetch('/api/goals')
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (data) {
      // active and upcoming goals first, then completed ones
      var goals = (data.goals || []).slice().sort(function (a, b) {
        return (a.status === 'COMPLETED') - (b.status === 'COMPLETED');
      });
      if (!goals.length) {
        body.innerHTML = '<p class="goal-empty">No migration goals yet. <a href="planner.html">Plan one with Zen →</a></p>';
        return;
      }
      var rows = [];
      goals.forEach(function (g) {
        var tz = g.schedule.timezone;
        g.waves.forEach(function (w) {
          var when = w.schedule.type === 'after_dependency'
            ? 'After ' + w.depends_on.map(function (d) {
                var up = g.waves.filter(function (x) { return x.wave_id === d.wave_id; })[0];
                return up ? up.name : d.wave_id;
              }).join(', ') + ' validation' + (w.schedule.estimated_at ? '<span class="goal-sub">est. ' + esc(fmt(w.schedule.estimated_at, tz)) + '</span>' : '')
            : w.schedule.type === 'immediate' ? 'Immediately' : esc(fmt(w.schedule.at, tz));
          var label = w.display_status || w.status;
          rows.push('<tr' + (/Blocked|Human review|Failed/.test(label) ? ' class="is-risk"' : '') + '>' +
            '<td><a class="goal-link" href="planner.html?goal=' + encodeURIComponent(g.goal_id) + '">' + esc(w.name) + ' Migration</a>' +
              '<span class="goal-sub">Wave ' + w.order + ' of ' + g.waves.length + ' · ' + esc(g.title.split(':')[0]) + '</span></td>' +
            '<td>' + esc(shortName(g.source.name)) + '</td>' +
            '<td>' + esc(g.target.name) + (w.workspace ? '<span class="goal-sub">' + esc(w.workspace.name) + '</span>' : '') + '</td>' +
            '<td>' + when + '</td>' +
            '<td>' + (w.record_estimate ? Number(w.record_estimate.tickets || 0).toLocaleString() : '—') + '</td>' +
            '<td><em class="' + statusClass(label) + '">' + esc(label) + '</em></td></tr>');
        });
      });
      // keep the Overview short: the most relevant waves only, the rest live in the Goal planner
      var shown = rows.slice(0, MAX_ROWS);
      body.innerHTML = '<table class="hub-table"><thead><tr><th>Goal</th><th>Source</th><th>Target</th><th>Schedule</th><th>Tickets</th><th>Status</th></tr></thead><tbody>' +
        shown.join('') + '</tbody></table>' +
        (rows.length > shown.length ? '<p class="goal-more">Showing ' + shown.length + ' of ' + rows.length + ' waves across ' + goals.length + ' goals · <a href="planner.html">See all in the goal planner →</a></p>' : '');
    })
    .catch(function () {
      body.innerHTML = '<p class="goal-empty">Migration goals are unavailable — start the Zen integration service to see scheduled goals.</p>';
    });
})();
