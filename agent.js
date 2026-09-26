/* Zen Migration agent: discover → map → run (remediation + human review) → insights.
   All work happens on the server (/api/agent/*); every number shown comes from
   the run's record ledger. No credentials in the browser. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PAIRS = [
    { pair: 'customer→requester', entity: 'customers', label: 'Customers → Requesters' },
    { pair: 'ticket→ticket', entity: 'tickets', label: 'Tickets → Tickets' }
  ];
  var TRANSFORM = {
    direct: 'direct', rename: 'rename', splitName: 'splitName()', transformPriority: 'transformPriority()', transformStatus: 'transformStatus()',
    lookupRequester: 'lookup requester', lookupDepartment: 'lookup department', classifyWorkspace: 'Workspace Classification',
    issueType: 'transformType()', preserveInDescription: 'keep in description', idMapping: 'Zen ID map', lookup: 'lookup'
  };
  var METHOD = { exact: 'Exact name', known: 'Vendor rule', semantic: 'Semantic', ai: 'Claude', none: '—' };
  var LEVEL = { HIGH: 'ok', MEDIUM: 'warn', LOW: 'bad' };
  var REC = {
    PENDING: ['Pending', ''], SUCCESS: ['Success', 'ok'], REMEDIATED: ['Remediated', 'sched'], RESOLVED: ['Resolved by human', 'sched'],
    SKIPPED: ['Skipped', 'warn'], FAILED: ['Failed', 'bad'], HUMAN_REVIEW_REQUIRED: ['Human review', 'bad']
  };
  var RUN = {
    RUNNING: ['Running', 'running'], HUMAN_REVIEW_REQUIRED: ['Human review required', 'partial'], COMPLETED: ['Completed', 'ok'],
    STOPPED: ['Stopped', 'partial'], FAILED: ['Failed', 'failed'], BLOCKED: ['Blocked', 'failed']
  };
  var STEP = { upcoming: ['Upcoming', ''], running: ['In progress', 'sched'], done: ['Done', 'ok'], failed: ['Failed', 'bad'], skipped: ['Not needed', ''] };

  var state = { source: null, target: null, mappings: {}, tab: 'customers', run: null, goals: [], ledger: 'ALL', emails: {}, driving: null, busy: false };

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status); return d; }); });
  }
  function when(iso) {
    return iso ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
  }
  function pct(x) { return x == null ? '—' : +(x * 100).toFixed(1) + '%'; }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function alertMsg(t) { var a = $('agAlert'); a.hidden = !t; a.textContent = t || ''; }
  function badge(text, cls) { return '<em class="' + (cls || '') + '">' + esc(text) + '</em>'; }
  function modeBadge(mode) { return mode === 'live' ? '<span class="int-mode live">Real API</span>' : '<span class="int-mode ag-mock">Mock data</span>'; }

  /* ---------- 1. discover ---------- */
  function discover() {
    $('agDiscover').disabled = true;
    return Promise.all([api('GET', '/api/agent/source-entities'), api('GET', '/api/agent/target-entities')])
      .then(function (r) {
        state.source = r[0]; state.target = r[1];
        renderSystems(); renderRunConfig();
        $('agGenerate').disabled = false;
      })
      .catch(function (err) { alertMsg('Discovery failed: ' + err.message); })
      .then(function () { $('agDiscover').disabled = false; });
  }

  function renderSystems() {
    [['agSource', state.source, 'Source'], ['agTarget', state.target, 'Target']].forEach(function (x) {
      var d = x[1];
      var rows = d.entities.map(function (e) {
        var fields = e.fields.map(function (f) { return f.key; });
        var status = e.status === 'ready'
          ? (x[2] === 'Source' ? '<span class="wave-muted">→ ' + esc(e.migratesToLabel || '') + '</span>' : badge('Discovered', 'ok'))
          : badge(e.status === 'error' ? 'Error' : 'Needs configuration', e.status === 'error' ? 'bad' : 'warn');
        return '<tr><td><b>' + esc(e.displayName) + '</b><small class="ag-sub">' + esc(e.description) + '</small>' +
          (e.status !== 'ready' && e.message ? '<small class="ag-sub ag-warn">' + esc(e.message) + '</small>' : '') + '</td>' +
          '<td class="ag-fields" title="' + esc(fields.join(', ')) + '">' + fields.length + ' · ' + esc(fields.slice(0, 4).join(', ')) + (fields.length > 4 ? '…' : '') + '</td>' +
          '<td>' + (e.count == null ? '—' : num(e.count)) + '</td><td>' + status + '</td></tr>';
      }).join('');
      $(x[0]).innerHTML = '<div class="ag-system-head"><div><span class="ag-eyebrow">' + x[2] + ' system</span><b>' + esc(d.system) + '</b></div>' +
        '<div class="ag-mode">' + modeBadge(d.mode) + '<small>via ' + esc(d.via) + '</small></div></div>' +
        '<div class="int-table-wrap"><table class="hub-table ag-table"><thead><tr><th>Entity</th><th>Fields</th><th>Records</th><th>' + (x[2] === 'Source' ? 'Migrates to' : 'Status') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    });
    var notes = (state.target.notes || []);
    $('agTargetNotes').innerHTML = notes.length ? '<div class="pl-msgs"><div class="pl-msg warn">' + esc(notes.join(' ')) + '</div></div>' : '';
  }

  /* ---------- 2. mapping ---------- */
  function loadMappings() {
    return Promise.all(PAIRS.map(function (p) { return api('GET', '/api/agent/mappings?pair=' + encodeURIComponent(p.pair)); }))
      .then(function (res) { PAIRS.forEach(function (p, i) { state.mappings[p.entity] = res[i].mapping; }); renderMapping(); renderRunConfig(); });
  }

  function currentPair() { return PAIRS.filter(function (p) { return p.entity === state.tab; })[0]; }

  function renderMapping() {
    $('agPairs').innerHTML = PAIRS.map(function (p) {
      return '<button type="button" class="chip' + (state.tab === p.entity ? ' is-active' : '') + '" data-tab="' + p.entity + '">' + esc(p.label) + '</button>';
    }).join('');
    var m = state.mappings[state.tab];
    $('agGenerate').textContent = m ? 'Regenerate mapping' : 'Generate mapping';
    $('agGenerate').className = m ? 'mini ghost' : 'mini';
    if (!m) {
      $('agMapping').innerHTML = '<p class="goal-empty ag-empty">No mapping yet for ' + esc(currentPair().label) + '. Generate it — Zen reads both schemas and proposes each field.</p>';
    } else {
      var pending = m.fields.filter(function (f) { return f.decision === 'pending'; }).length;
      var ai = m.aiUsed ? 'Claude reviewed the fields the rules could not place.' : m.aiError ? 'Claude was unavailable (' + m.aiError + ') — rules only.' : m.aiAvailable ? 'Every field was placed by rules; Claude was not needed.' : 'Claude is not configured on the server — rules only.';
      var rows = m.fields.map(function (f) {
        var dest = f.target ? '<code>' + esc(f.target) + '</code>' + (f.targetApi && f.targetApi !== f.target ? '<small class="ag-sub">API: ' + esc(f.targetApi) + '</small>' : '')
          : '<span class="wave-muted">' + (f.transformation === 'idMapping' ? 'Zen ID map' : 'Not migrated') + '</span>';
        var conf = f.level ? badge(f.level, LEVEL[f.level]) + ' <span class="ag-pct">' + Math.round(f.confidence * 100) + '%</span>' : '<span class="wave-muted">—</span>';
        var dec = f.decision === 'pending'
          ? '<span class="rv-actions"><button class="mini" data-decide="confirmed" data-field="' + esc(f.source) + '">Confirm</button><button class="mini ghost" data-decide="rejected" data-field="' + esc(f.source) + '">Reject</button></span>'
          : f.decision === 'confirmed' ? badge('Confirmed', 'ok') : f.decision === 'rejected' ? badge('Rejected', '') : (f.target ? '<span class="wave-muted">Automatic</span>' : '');
        return '<tr' + (f.decision === 'pending' ? ' class="is-risk"' : '') + '><td><code>' + esc(f.source) + '</code></td><td>' + dest + '</td><td class="ag-nowrap">' + conf + '</td>' +
          '<td><code class="ag-tf">' + esc(f.transformation ? TRANSFORM[f.transformation] || f.transformation : '—') + '</code></td><td>' + esc(METHOD[f.method] || f.method) + '</td>' +
          '<td>' + dec + '</td><td class="ag-why">' + esc(f.reason) + '</td></tr>';
      }).join('');
      $('agMapping').innerHTML =
        (pending ? '<div class="pl-msgs"><div class="pl-msg warn">' + pending + ' low-confidence ' + (pending === 1 ? 'mapping needs' : 'mappings need') + ' your confirmation before the migration can run.</div></div>' : '') +
        (m.missingRequired.length ? '<div class="pl-msgs"><div class="pl-msg warn">Required Freshservice fields with no source: ' + esc(m.missingRequired.join(', ')) + '.</div></div>' : '') +
        '<p class="int-note">' + esc(ai) + ' Generated ' + esc(when(m.createdAt)) + '.</p>' +
        '<div class="int-table-wrap"><table class="hub-table ag-table"><thead><tr><th>Source (JSM)</th><th>Destination (Freshservice)</th><th>Confidence</th><th>Transformation</th><th>Method</th><th>Decision</th><th>Why</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    renderWorkspace();
  }

  function renderWorkspace() {
    if (state.tab !== 'tickets') { $('agWorkspace').innerHTML = ''; return; }
    var ws = (state.run && state.run.plan && state.run.plan.workspace_mapping) || {};
    var keys = Object.keys(ws);
    $('agWorkspace').innerHTML = '<h3 class="ag-h3">Workspace mapping</h3>' + (keys.length
      ? '<div class="int-table-wrap"><table class="hub-table ag-table"><thead><tr><th>JSM department</th><th>Freshservice workspace</th><th>Rule</th></tr></thead><tbody>' +
        keys.map(function (k) {
          var w = ws[k];
          return '<tr><td>' + esc(k) + '</td><td><b>' + esc(w.workspace) + '</b></td><td>' + badge(w.rule === 'rule' ? 'Department rule' : w.rule === 'override' ? 'Admin override' : 'Default workspace', w.rule === 'default' ? '' : 'sched') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<p class="int-note">Computed from the ticket departments during the run, by Zen\'s Workspace Classification (department rules, Admin overrides from Field mapping, then the default workspace).</p>');
  }

  function generate() {
    var p = currentPair();
    $('agGenerate').disabled = true;
    $('agGenerate').textContent = 'Generating…';
    api('POST', '/api/agent/mappings', { pair: p.pair })
      .then(function (d) { state.mappings[p.entity] = d.mapping; alertMsg(''); })
      .catch(function (err) { alertMsg('Could not generate the mapping: ' + err.message); })
      .then(function () { $('agGenerate').disabled = false; renderMapping(); renderRunConfig(); });
  }

  function decide(field, decision) {
    var m = state.mappings[state.tab];
    api('POST', '/api/agent/mappings/' + encodeURIComponent(m.mappingId) + '/decide', { source: field, decision: decision })
      .then(function (d) { state.mappings[state.tab] = d.mapping; renderMapping(); renderRunConfig(); })
      .catch(function (err) { alertMsg('Could not save the decision: ' + err.message); });
  }

  /* ---------- 3. run ---------- */
  function selectedEntities() {
    return [].slice.call(document.querySelectorAll('.ag-entities input:checked')).map(function (i) { return i.value; });
  }
  function isActive() { return state.run && (state.run.status === 'RUNNING' || state.run.status === 'HUMAN_REVIEW_REQUIRED'); }

  function renderRunConfig() {
    if (state.source) $('agSrcMode').innerHTML = modeBadge(state.source.mode);
    if (state.target) $('agTgtMode').innerHTML = modeBadge(state.target.mode);
    var demo = state.source && state.target && state.source.mode === 'mock' && state.target.mode === 'mock';
    $('agDemoNote').hidden = !demo;
    $('agReset').hidden = !demo;
    var ents = selectedEntities();
    var missing = ents.filter(function (e) { return !state.mappings[e]; });
    var pending = ents.filter(function (e) { return state.mappings[e] && state.mappings[e].fields.some(function (f) { return f.decision === 'pending'; }); });
    var writes = !state.target || state.target.writes_allowed !== false;
    var reason = !ents.length ? 'Choose at least one entity.' : missing.length ? 'Generate the ' + missing.join(' and ') + ' mapping first.'
      : pending.length ? 'Confirm the low-confidence ' + pending.join(' and ') + ' mappings first.' : !writes ? 'Writes to the live Freshservice tenant are disabled on the server (ZEN_ALLOW_LIVE_WRITES).' : '';
    $('agRun').disabled = Boolean(reason) || isActive() || state.busy;
    $('agRunNote').textContent = isActive() ? '' : reason;
    [].slice.call(document.querySelectorAll('.ag-entities input')).forEach(function (i) { i.disabled = isActive(); });
    $('agGoal').disabled = isActive();
  }

  function loadGoals() {
    return api('GET', '/api/goals').then(function (d) {
      state.goals = d.goals || [];
      $('agGoal').innerHTML = '<option value="">No goal — run now</option>' + state.goals.map(function (g) {
        return '<option value="' + esc(g.goal_id) + '">' + esc(g.title || g.name || g.goal_id) + '</option>';
      }).join('');
    }).catch(function () {});
  }

  function startRun() {
    var ents = selectedEntities();
    var ids = {};
    ents.forEach(function (e) { ids[e] = state.mappings[e].mappingId; });
    state.busy = true; renderRunConfig();
    $('agRun').textContent = 'Starting…';
    api('POST', '/api/agent/runs', { goalId: $('agGoal').value || null, entities: ents, mappingIds: ids })
      .then(function (d) { state.run = d.run; alertMsg(''); renderRun(); drive(d.run.id); })
      .catch(function (err) { alertMsg('Could not start the migration: ' + err.message); })
      .then(function () { state.busy = false; $('agRun').textContent = 'Run migration'; renderRunConfig(); });
  }

  // advance while RUNNING; each call does one bounded step on the server
  function drive(id) {
    if (state.driving === id) return;
    state.driving = id;
    (function step() {
      api('POST', '/api/agent/runs/' + encodeURIComponent(id) + '/advance', {})
        .then(function (d) {
          state.run = d.run;
          renderRun();
          if (d.run.status === 'RUNNING' && state.driving === id) return sleep(60).then(step);
          state.driving = null;
        })
        .catch(function (err) { state.driving = null; alertMsg('Lost contact with the migration: ' + err.message); });
    })();
  }

  function stopRun() {
    if (!window.confirm('Stop this migration? Records already written stay in Freshservice and are tracked, so a new run continues without duplicates.')) return;
    state.driving = null;
    api('POST', '/api/agent/runs/' + encodeURIComponent(state.run.id) + '/stop', {})
      .then(function (d) { state.run = d.run; renderRun(); })
      .catch(function (err) { alertMsg('Could not stop: ' + err.message); });
  }

  function review(key, action, btn) {
    var rec = (state.run.records || []).filter(function (r) { return r.key === key; })[0];
    var input = rec && rec.review && rec.review.needsInput === 'email' ? { email: state.emails[key] || '' } : undefined;
    if (btn) { btn.disabled = true; btn.textContent = action === 'approve' ? 'Retrying…' : 'Skipping…'; }
    api('POST', '/api/agent/runs/' + encodeURIComponent(state.run.id) + '/review', { record: key, action: action, input: input })
      .then(function (d) {
        state.run = d.run;
        var after = (d.run.records || []).filter(function (r) { return r.key === key; })[0];
        alertMsg(action === 'approve' && after && after.status === 'HUMAN_REVIEW_REQUIRED' ? rec.sourceId + ' still needs attention: ' + (after.review ? after.review.problem : '') : '');
        renderRun();
        if (d.run.status === 'RUNNING') drive(d.run.id);
      })
      .catch(function (err) { alertMsg('Could not apply the decision: ' + err.message); renderRun(); });
  }

  function renderRun() {
    var r = state.run;
    renderRunConfig();
    renderWorkspace();
    $('agInsightsCard').hidden = !(r && r.summary.processed > 0);
    if (!r) { $('agLive').innerHTML = ''; renderInsights(); return; }
    var s = r.summary;
    var running = r.status === 'RUNNING';
    var cur = r.steps[r.cursor];
    var cls = r.status === 'COMPLETED' ? ' done' : r.status === 'HUMAN_REVIEW_REQUIRED' || r.status === 'STOPPED' ? ' exc' : r.status === 'FAILED' || r.status === 'BLOCKED' ? ' bad' : '';
    var st = RUN[r.status] || [r.status, ''];

    // stage matrix: one row per stage, one column per entity
    var rows = [];
    r.steps.forEach(function (x) {
      var row = rows.filter(function (y) { return y.key === x.key; })[0];
      if (!row) { row = { key: x.key, label: x.label, cells: {} }; rows.push(row); }
      if (x.entity) row.cells[x.entity] = x; else r.entities.forEach(function (e) { row.cells[e] = x; });
    });
    var cell = function (x) {
      if (!x) return '<td class="wave-muted">—</td>';
      var t = STEP[x.status] || [x.status, ''];
      return '<td>' + badge(t[0], t[1]) + (x.detail ? '<small class="ag-sub">' + esc(x.detail) + '</small>' : '') + '</td>';
    };
    var stages = '<table class="hub-table ag-table ag-stages"><thead><tr><th>Stage</th>' + r.entities.map(function (e) { return '<th>' + (e === 'customers' ? 'Customers' : 'Tickets') + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (y) { return '<tr><td><b>' + esc(y.label) + '</b></td>' + r.entities.map(function (e) { return cell(y.cells[e]); }).join('') + '</tr>'; }).join('') + '</tbody></table>';

    var tiles = '<div class="run-tiles ag-tiles">' +
      [['Successful', s.successful, 'ok'], ['Remediated by Zen', s.remediated, 'fix'], ['Resolved by human', s.resolved, 'fix'], ['Human review', s.human_review, s.human_review ? 'rev' : ''],
        ['Skipped', s.skipped, s.skipped ? 'rev' : ''], ['Failed', s.failed, s.failed ? 'bad' : ''], ['Success rate', pct(s.success_rate), '']].map(function (t) {
        return '<div class="run-tile ' + t[2] + '"><span>' + t[0] + '</span><b>' + (typeof t[1] === 'number' ? num(t[1]) : t[1]) + '</b></div>';
      }).join('') + '</div>';

    var ent = '<table class="hub-table ag-table"><thead><tr><th>Entity</th><th>Processed</th><th>Created</th><th>Updated</th><th>Linked</th><th>Reconciled</th></tr></thead><tbody>' +
      r.entities.map(function (e) {
        var p = s.per_entity[e] || {};
        var rec = r.reconciliation && r.reconciliation[e];
        return '<tr><td><b>' + (e === 'customers' ? 'Customers' : 'Tickets') + '</b></td><td>' + p.processed + ' / ' + p.total + '</td><td>' + p.created + '</td><td>' + p.updated + '</td><td>' + p.linked + '</td><td>' +
          (rec ? badge(rec.balanced ? 'Balanced' : 'Differences', rec.balanced ? 'ok' : 'bad') : '<span class="wave-muted">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';

    var checks = r.plan && r.plan.prechecks && r.status === 'BLOCKED'
      ? '<div class="pl-msgs">' + r.plan.prechecks.map(function (c) { return '<div class="pl-msg ' + (c.ok ? 'note' : 'warn') + '"><span><b>' + (c.ok ? '✓ ' : '✕ ') + esc(c.check) + '</b> — ' + esc(c.detail) + '</span></div>'; }).join('') + '</div>' : '';

    var statusMsg = r.status_reason && !running
      ? '<div class="pl-msgs"><div class="pl-msg ' + (r.status === 'COMPLETED' && r.evaluation && r.evaluation.met ? 'note' : 'warn') + '">' + esc(r.status_reason) + '</div></div>' : '';

    $('agLive').innerHTML = '<div class="cm-live' + cls + '">' +
      '<h3>' + (running ? '<span class="run-live"></span>' : r.status === 'COMPLETED' ? '✓' : '⚠') + ' ' +
        esc(running && cur ? cur.label + (cur.entity ? ' · ' + cur.entity : '') : 'Migration ' + r.id.replace('agent_', '#')) +
        ' <span class="rp-pill ' + st[1] + '">' + esc(st[0]) + '</span>' + (r.goal_name ? ' <small>Goal: ' + esc(r.goal_name) + '</small>' : '') + '</h3>' +
      '<p class="cm-sub">' + esc(r.source.name) + ' (' + (r.source.mode === 'live' ? 'real API' : 'mock data') + ') → ' + esc(r.target.name) + ' (' + (r.target.mode === 'live' ? 'real API' : 'mock data') + ') · started ' + esc(when(r.started_at)) +
        (r.finished_at ? ' · finished ' + esc(when(r.finished_at)) : '') + '</p>' +
      statusMsg +
      '<div class="cm-body ag-body"><div>' +
        '<div class="cm-count">' + num(s.processed) + ' <small>/ ' + num(s.total) + ' records processed · ' + pct(s.progress) + '</small></div>' +
        '<div class="run-bar ag-bar"><i style="width:' + (s.progress * 100) + '%"></i></div>' + tiles + ent +
        (running || r.status === 'HUMAN_REVIEW_REQUIRED' ? '<div class="cm-live-actions"><button class="mini ghost ag-stop" id="agStop">Stop migration</button></div>' : '') +
      '</div><div class="int-table-wrap">' + stages + '</div></div>' +
      checks + renderReview(r) + renderLedger(r) + '</div>';

    var stop = $('agStop');
    if (stop) stop.addEventListener('click', stopRun);
    renderInsights();
  }

  function renderReview(r) {
    // decisions open at the review gate; records flagged mid-run show in the ledger until then
    if (r.status !== 'HUMAN_REVIEW_REQUIRED') return '';
    var items = (r.records || []).filter(function (x) { return x.status === 'HUMAN_REVIEW_REQUIRED'; });
    if (!items.length) return '';
    return '<div class="ag-review"><div class="rv-head"><h2>⚠ Human review required · ' + items.length + '</h2><span class="rv-count">Zen handled the routine fixes. These need a decision before the migration continues.</span></div>' +
      '<div class="rv-groups">' + items.map(function (x) {
        var v = x.review || {};
        return '<div class="rv-group"><div class="rv-group-head"><h3>' + esc(x.sourceId) + ' <span class="ag-sub-inline">' + esc(x.label) + '</span></h3>' +
          '<span>' + badge((x.error && x.error.label) || v.failure_type, 'warn') + ' ' + badge(v.severity, v.severity === 'HIGH' ? 'bad' : v.severity === 'MEDIUM' ? 'warn' : '') + '</span></div>' +
          '<div class="rv-grid"><div><h4>Problem</h4><p>' + esc(v.problem) + '</p></div>' +
          '<div><h4>Zen tried</h4><ul class="rv-tried">' + (v.tried || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' +
          '<div><h4>Recommendation</h4><p class="rv-rec">' + esc(v.recommendation) + '</p></div></div>' +
          (v.needsInput === 'email' ? '<label class="rv-input ag-input"><span>Email address</span><input type="email" data-email="' + esc(x.key) + '" value="' + esc(state.emails[x.key] || '') + '" placeholder="name@company.com"></label>' : '') +
          '<div class="rv-actions ag-actions"><button class="mini" data-review="approve" data-key="' + esc(x.key) + '">Approve &amp; retry</button>' +
          '<button class="mini ghost" data-review="skip" data-key="' + esc(x.key) + '">Skip record</button>' +
          '<button class="mini ghost ag-stop" data-review="stop">Stop migration</button></div></div>';
      }).join('') + '</div></div>';
  }

  function renderLedger(r) {
    var all = r.records || [];
    if (!all.length) return '';
    var match = function (x, f) {
      return f === 'ALL' || (f === 'REMEDIATED' && (x.status === 'REMEDIATED' || x.status === 'RESOLVED')) ||
        (f === 'REVIEW' && x.status === 'HUMAN_REVIEW_REQUIRED') || (f === 'ISSUES' && (x.status === 'SKIPPED' || x.status === 'FAILED'));
    };
    var count = function (f) { return all.filter(function (x) { return match(x, f); }).length; };
    var rows = all.filter(function (x) { return match(x, state.ledger); });
    return '<div class="cm-details ag-ledger"><h3 class="ag-h3">Record ledger</h3><div class="cm-filters">' +
      [['ALL', 'All'], ['REMEDIATED', 'Remediated'], ['REVIEW', 'Human review'], ['ISSUES', 'Skipped / failed']].map(function (f) {
        return '<button type="button" class="chip' + (state.ledger === f[0] ? ' is-active' : '') + '" data-ledger="' + f[0] + '">' + f[1] + ' (' + count(f[0]) + ')</button>';
      }).join('') + '</div><div class="int-table-wrap ag-scroll"><table class="hub-table ag-table"><thead><tr><th>Source record</th><th>Type</th><th>Status</th><th>Freshservice ID</th><th>Failure</th><th>Remediation</th><th>Updated</th></tr></thead><tbody>' +
      rows.map(function (x) {
        var t = REC[x.status] || [x.status, ''];
        var errs = x.errors.filter(function (e) { return !e.retry; });
        var fixes = x.remediation.filter(function (m) { return !m.retry; });
        return '<tr><td><code>' + esc(x.sourceId) + '</code><small class="ag-sub">' + esc(x.label) + '</small></td><td>' + (x.entityType === 'customer' ? 'Customer' : 'Ticket') + '</td><td>' + badge(t[0], t[1]) + '</td>' +
          '<td>' + (x.targetId ? '<code>' + esc(x.targetId) + '</code><small class="ag-sub">' + esc(x.action || '') + '</small>' : '<span class="wave-muted">—</span>') + '</td>' +
          '<td class="ag-why">' + (errs.length ? errs.map(function (e) { return '<b>' + esc(e.label) + '</b> — ' + esc(e.message); }).join('<br>') : '<span class="wave-muted">—</span>') + '</td>' +
          '<td class="ag-why">' + (fixes.length ? fixes.map(function (m) { return (m.ok ? '<span class="rem-ok">Fixed:</span> ' : '<span class="rem-warn">Tried:</span> ') + esc(m.detail); }).join('<br>') : '<span class="wave-muted">Not needed</span>') + '</td>' +
          '<td class="wave-muted ag-nowrap">' + esc(when(x.timestamp)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  /* ---------- 4. insights ---------- */
  function generateInsights() {
    var btn = $('agInsightsBtn');
    btn.disabled = true; btn.textContent = 'Asking Claude…';
    api('POST', '/api/agent/runs/' + encodeURIComponent(state.run.id) + '/insights', {})
      .then(function (d) { state.run.insights = d.insights; renderInsights(); alertMsg(''); })
      .catch(function (err) { alertMsg('Could not generate insights: ' + err.message); })
      .then(function () { btn.disabled = false; btn.textContent = state.run.insights ? 'Regenerate insights' : 'Generate insights with Claude'; });
  }

  function renderInsights() {
    var r = state.run;
    var ok = r && ['COMPLETED', 'STOPPED', 'HUMAN_REVIEW_REQUIRED', 'FAILED', 'BLOCKED'].indexOf(r.status) > -1;
    $('agInsightsBtn').disabled = !ok;
    var ins = r && r.insights;
    if (!ins) { $('agInsights').innerHTML = ok ? '' : '<p class="int-note">Insights are available once the migration finishes or pauses for review.</p>'; return; }
    $('agInsightsBtn').textContent = 'Regenerate insights';
    var i = ins.insights;
    var s = ins.summary;
    var list = function (title, items) {
      return '<div class="ag-ins-block"><h4>' + title + '</h4>' + (items.length ? '<ul>' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '<p class="wave-muted">Nothing to report.</p>') + '</div>';
    };
    $('agInsights').innerHTML =
      '<div class="ag-ins-head">' + (ins.generated_by === 'claude' ? '<span class="rp-pill running">✦ Generated by Claude · ' + esc(ins.model) + '</span>' : '<span class="rp-pill partial">Rule-based summary — Claude not used</span>') +
        ' <span class="wave-muted">' + esc(when(ins.generated_at)) + (ins.error ? ' · ' + esc(ins.error) : '') + '</span></div>' +
      '<h3 class="ag-headline">' + esc(i.headline) + '</h3>' +
      '<section class="rp-kpis ag-kpis">' + [
        ['Records processed', s.processed, 'var(--rp-first)'], ['Migrated', s.migrated, 'var(--rp-good)'], ['Auto-remediated', s.auto_remediated, 'var(--rp-auto)'],
        ['Resolved by human', s.resolved_by_human, 'var(--rp-human)'], ['Human review', s.awaiting_human_review + s.skipped, 'var(--rp-open)'], ['Success rate', pct(s.success_rate), 'var(--rp-good)']
      ].map(function (k) { return '<div class="rp-kpi"><i style="background:' + k[2] + '"></i><span>' + k[0] + '</span><b>' + (typeof k[1] === 'number' ? num(k[1]) : k[1]) + '</b></div>'; }).join('') + '</section>' +
      '<div class="rp-two ag-ins">' +
        list('What went well', i.went_well) +
        list('What went wrong', i.went_wrong.map(function (w) { return w.count + ' × ' + w.title + ' — ' + w.detail; })) +
        list('How Zen fixed it', i.how_fixed.map(function (f) { return f.count + ' ' + f.title; })) +
        '<div class="ag-ins-block"><h4>What still needs human action</h4><p><b>' + i.needs_human.count + '</b> ' + (i.needs_human.count === 1 ? 'record' : 'records') + '. ' + esc(i.needs_human.reason) + '</p><p class="wave-muted">Recommended: ' + esc(i.needs_human.recommended_action) + '</p></div>' +
        list('Recommendations', i.recommendations) +
      '</div>';
  }

  /* ---------- wire up ---------- */
  $('agDiscover').addEventListener('click', discover);
  $('agGenerate').addEventListener('click', generate);
  $('agRun').addEventListener('click', startRun);
  $('agInsightsBtn').addEventListener('click', generateInsights);
  document.querySelectorAll('.ag-entities input').forEach(function (i) { i.addEventListener('change', renderRunConfig); });
  $('agPairs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]');
    if (b) { state.tab = b.getAttribute('data-tab'); renderMapping(); }
  });
  $('agMapping').addEventListener('click', function (e) {
    var b = e.target.closest('[data-decide]');
    if (b) { b.disabled = true; decide(b.getAttribute('data-field'), b.getAttribute('data-decide')); }
  });
  $('agLive').addEventListener('click', function (e) {
    var b = e.target.closest('[data-review]');
    if (b) {
      var a = b.getAttribute('data-review');
      if (a === 'stop') stopRun(); else review(b.getAttribute('data-key'), a, b);
      return;
    }
    var l = e.target.closest('[data-ledger]');
    if (l) { state.ledger = l.getAttribute('data-ledger'); renderRun(); }
  });
  $('agLive').addEventListener('input', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-email');
    if (k) state.emails[k] = e.target.value;
  });
  $('agReset').addEventListener('click', function () {
    if (!window.confirm('Reset the migration agent demo? This clears agent migrations, mappings and the simulated Freshservice records.')) return;
    api('POST', '/api/agent/demo-reset', {})
      .then(function () { state.run = null; state.mappings = {}; renderRun(); renderMapping(); renderInsights(); alertMsg(''); $('agRunNote').textContent = 'Demo data reset.'; })
      .catch(function (err) { alertMsg('Could not reset: ' + err.message); });
  });

  // initial load: discovery, saved mappings, goals, latest run
  discover();
  loadMappings().catch(function () { renderMapping(); });
  loadGoals();
  api('GET', '/api/agent/runs').then(function (d) {
    if (!d.runs[0]) return;
    return api('GET', '/api/agent/runs/' + encodeURIComponent(d.runs[0].id)).then(function (x) {
      state.run = x.run; renderRun();
      if (x.run.status === 'RUNNING') drive(x.run.id);
    });
  }).catch(function () {});

})();
