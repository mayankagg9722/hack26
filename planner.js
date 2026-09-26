/* Zen Goal planner — natural-language migration goal → reviewed, scheduled
   plan. Talks to /api/goals (functions/migration/goals). Times are shown and
   edited in the goal's timezone. */
(function () {
  'use strict';

  var STORE_KEY = 'zen.integrations.v1';
  var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var DAY_LABEL = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };
  var EXAMPLES = [
    { label: 'Demo scenario', text: 'Migrate all employee and ticket records from Jira Service Management to Freshservice. Start with IT this Saturday at 11 PM. If IT migration succeeds with at least 95% success and has no critical errors, migrate Finance the following Saturday. HR should migrate after Finance is successfully validated. Do not run migrations during business hours.' },
    { label: 'Weekend waves', text: 'Migrate all employee and ticket records from Jira Service Management to Freshservice, starting with IT this weekend, then Finance next weekend, and HR after that.' },
    { label: 'Let Zen recommend a time', text: "We have 10,000 tickets in Legacy ITSM and don't want to disrupt employees during business hours. Move them to Freshservice." },
    { label: 'Window & pause rules', text: 'Migrate Facilities from Jira to Freshservice tomorrow at 10 PM. Pause the migration if success rate drops below 90%. If it is not complete by 3 AM, escalate.' }
  ];
  var POLICY_LABELS = {
    'continue': 'Continue to next wave', ai_remediation: 'Attempt AI remediation', human_review: 'Human review',
    pause: 'Pause migration', stop: 'Stop safely', escalate: 'Escalate to admin'
  };
  var OVERRUN_LABELS = { pause: 'Pause — wait for next window', 'continue': 'Continue if no critical issues', escalate: 'Escalate to an admin', stop: 'Stop safely' };
  var EDITABLE = ['DRAFT', 'PLANNED', 'READY', 'BLOCKED', 'HUMAN_REVIEW_REQUIRED'];

  var conn = loadConn();
  var goals = [];
  var goal = null;   // server copy
  var draft = null;  // editable copy
  var dirty = false;
  var showJson = false;
  var run = null;       // latest run summary for the open goal
  var polling = false;
  var RUN_END = ['COMPLETED', 'HUMAN_REVIEW_REQUIRED', 'BLOCKED', 'PAUSED', 'FAILED', 'STOPPED'];
  var reviewOpen = {};    // group → records list expanded
  var reviewInputs = {};  // failure_id → {sourceField: value}
  var reviewErrors = {};  // failure_id → message
  var reviewBusy = false;
  var RUN_STEPS = ['VALIDATING', 'MAPPING', 'MIGRATING', 'REMEDIATING', 'VALIDATING_TARGET', 'RECONCILING', 'HUMAN_REVIEW', 'COMPLETED'];
  var remOpen = false;        // AI Remediation panel expanded
  var remFilter = 'HUMAN_REVIEW_REQUIRED';
  var remDetail = null;       // failure_id with source/mapping shown
  var STRATEGY_LABELS = {
    normalize_format: 'Normalised data', swap_mismatched_fields: 'Corrected swapped fields', infer_employee_id: 'Inferred employee ID',
    infer_email: 'Inferred email', normalize_department: 'Applied known department mapping', ai_department: 'AI department mapping',
    retry_api: 'Retried API request'
  };

  var $ = function (id) { return document.getElementById(id); };

  // A browser holding an older copy of planner.html may lack newer containers — create them
  (function ensureContainers() {
    var anchor = document.getElementById('gReco') || document.getElementById('plan');
    [['runCard', 'hub-card run-card'], ['reviewCard', 'hub-card review-card']].forEach(function (c) {
      if (document.getElementById(c[0]) || !anchor) return;
      var el = document.createElement('article');
      el.id = c[0];
      el.className = c[1];
      el.hidden = true;
      if (anchor.id === 'plan') anchor.insertBefore(el, anchor.children[1] || null);
      else anchor.parentNode.insertBefore(el, anchor);
    });
    if (!document.getElementById('runBtn')) {
      var approve = document.getElementById('approveBtn');
      if (approve) {
        var b = document.createElement('button');
        b.className = 'mini';
        b.id = 'runBtn';
        b.hidden = true;
        b.textContent = 'Approve & run migration';
        approve.parentNode.appendChild(b);
      }
    }
    // stylesheet for the newer panels
    if (!document.querySelector('link[href^="planner.css?v=8"]')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'planner.css?v=8';
      document.head.appendChild(l);
    }
  })();

  var browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  /* ---------- helpers ---------- */
  function loadConn() {
    var fallback = { connected: {}, source: 'jira', target: 'freshservice', demo: { count: 750, seed: 42 } };
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && s.connected ? s : fallback;
    } catch (e) { return fallback; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function api(method, path, body) {
    var q = 'count=' + encodeURIComponent(conn.demo.count) + '&seed=' + encodeURIComponent(conn.demo.seed);
    return fetch(path + (path.indexOf('?') > -1 ? '&' : '?') + q, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function showAlert(html) { $('plAlert').innerHTML = html; $('plAlert').hidden = false; }
  function hideAlert() { $('plAlert').hidden = true; }

  /* timezone maths (mirrors functions/migration/goals/time.js) */
  function zonedParts(date, tz) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(date);
    var get = function (t) { return +parts.filter(function (p) { return p.type === t; })[0].value; };
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
  }
  function zonedToUtc(y, m, d, h, mi, tz) {
    var offset = function (ts) {
      var p = zonedParts(new Date(ts), tz);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ts / 60000) * 60000;
    };
    var guess = Date.UTC(y, m - 1, d, h, mi);
    var t = guess - offset(guess);
    var second = guess - offset(t);
    return new Date(second !== t ? second : t);
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toInput(iso, tz) {
    if (!iso) return '';
    var p = zonedParts(new Date(iso), tz);
    return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
  }
  function fromInput(v, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '');
    return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz).toISOString() : null;
  }
  function fmt(iso, tz, withDay) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: withDay === false ? undefined : 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
    }).format(new Date(iso));
  }
  function fmtTime(iso, tz) {
    return iso ? new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
  }

  function waveName(id) {
    var w = draft.waves.filter(function (x) { return x.wave_id === id; })[0];
    return w ? w.name : id;
  }
  function statusClass(label) {
    if (/^Scheduled/.test(label)) return 'sched';
    if (/^(Ready|Completed)/.test(label)) return 'ok';
    if (/^(Blocked|Human review|Failed)/.test(label)) return 'bad';
    if (/^(Paused|Pre-check)/.test(label)) return 'warn';
    return '';
  }
  function goalBadge(status) {
    var cls = { PLANNED: 'ok', READY: 'ok', COMPLETED: 'ok', DRAFT: '', BLOCKED: 'warn', HUMAN_REVIEW_REQUIRED: 'warn', FAILED: 'warn', PAUSED: 'warn' }[status];
    return '<em class="int-badge ' + (cls || '') + '">' + esc(status.replace(/_/g, ' ')) + '</em>';
  }

  function setDirty(v) {
    dirty = v;
    $('saveBtn').hidden = !dirty;
  }

  /* ---------- goal list ---------- */
  function loadGoals(selectId) {
    return api('GET', '/api/goals').then(function (res) {
      goals = res.goals;
      renderGoalList();
      if (selectId) {
        var g = goals.filter(function (x) { return x.goal_id === selectId; })[0];
        if (g) setGoal(g);
        else showAlert('That goal no longer exists.');
      }
    }).catch(function (err) {
      $('goalList').innerHTML = '<p class="int-note">Could not load goals: ' + esc(err.message) + '</p>';
    });
  }

  function renderGoalList() {
    $('goalCount').textContent = goals.length ? goals.length + ' goal' + (goals.length > 1 ? 's' : '') : '';
    if (!goals.length) { $('goalList').innerHTML = '<p class="int-note">No goals yet. Describe one on the left.</p>'; return; }
    $('goalList').innerHTML = '';
    goals.forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'pl-goal' + (goal && goal.goal_id === g.goal_id ? ' is-active' : '');
      b.innerHTML = '<div><b>' + esc(g.title) + '</b><span>' + g.waves.length + ' wave(s) · first ' +
        esc(fmt(g.schedule.first_start, g.schedule.timezone)) + '</span></div>' + goalBadge(g.status);
      b.addEventListener('click', function () {
        if (dirty && !window.confirm('Discard unsaved changes?')) return;
        setGoal(g);
      });
      $('goalList').appendChild(b);
    });
  }

  /* ---------- plan ---------- */
  function plan() {
    var text = $('goalText').value.trim();
    if (!text) { $('goalText').focus(); return; }
    if (dirty && !window.confirm('Discard unsaved changes to the current goal?')) return;
    $('planBtn').disabled = true;
    $('planBtn').textContent = 'Zen is planning…';
    hideAlert();
    api('POST', '/api/goals/interpret', { text: text, timezone: browserTz, source: conn.source, target: conn.target })
      .then(function (res) {
        setGoal(res.goal);
        return loadGoals();
      })
      .catch(function (err) { showAlert('Zen could not plan that goal: ' + esc(err.message)); })
      .then(function () { $('planBtn').disabled = false; $('planBtn').textContent = 'Plan with Zen'; });
  }

  function setGoal(g) {
    if (!goal || goal.goal_id !== g.goal_id) { run = null; loadRun(g); }
    goal = g;
    draft = clone(g);
    setDirty(false);
    hideAlert();
    history.replaceState(null, '', 'planner.html?goal=' + encodeURIComponent(g.goal_id));
    $('plan').hidden = false;
    render();
    renderGoalList();
  }

  function payload() {
    return {
      title: draft.title,
      record_types: draft.record_types,
      options: draft.options,
      success_criteria: draft.success_criteria,
      failure_policy: draft.failure_policy,
      migration_window: { duration_minutes: draft.migration_window.duration_minutes, on_overrun: draft.migration_window.on_overrun },
      blackout_periods: draft.blackout_periods,
      waves: draft.waves.map(function (w) {
        return {
          wave_id: w.wave_id, name: w.name, workspace_id: w.workspace ? w.workspace.id : null,
          schedule: { type: w.schedule.type, at: w.schedule.at },
          depends_on: (w.depends_on || []).map(function (d) { return { wave_id: d.wave_id }; })
        };
      })
    };
  }

  function save() {
    return api('PUT', '/api/goals/' + encodeURIComponent(goal.goal_id), { goal: payload() })
      .then(function (res) { setGoal(res.goal); return loadGoals(); })
      .catch(function (err) { showAlert('Could not save: ' + esc(err.message)); throw err; });
  }

  function withSaved(fn) {
    return dirty ? save().then(fn) : fn();
  }

  function approve() {
    withSaved(function () {
      return api('POST', '/api/goals/' + encodeURIComponent(goal.goal_id) + '/approve', {})
        .then(function (res) { setGoal(res.goal); return loadGoals(); });
    }).catch(function (err) { showAlert('Could not approve: ' + esc(err.message)); });
  }

  function precheck(waveId) {
    withSaved(function () {
      return api('POST', '/api/goals/' + encodeURIComponent(goal.goal_id) + '/precheck', waveId ? { wave_id: waveId } : {})
        .then(function (res) { setGoal(res.goal); return loadGoals(); });
    }).catch(function (err) { showAlert('Pre-checks failed to run: ' + esc(err.message)); });
  }

  function removeGoal() {
    if (!window.confirm('Delete this goal?')) return;
    api('DELETE', '/api/goals/' + encodeURIComponent(goal.goal_id)).then(function () {
      goal = null; draft = null; setDirty(false);
      $('plan').hidden = true;
      history.replaceState(null, '', 'planner.html');
      return loadGoals();
    }).catch(function (err) { showAlert('Could not delete: ' + esc(err.message)); });
  }

  function addWave(ws) {
    var last = draft.waves[draft.waves.length - 1];
    draft.waves.push({
      name: ws.name.replace(/ Workspace$/, ''),
      workspace: { id: ws.id, name: ws.name },
      schedule: { type: 'after_dependency', at: null },
      depends_on: last ? [{ wave_id: last.wave_id }] : []
    });
    save();
  }

  /* ---------- migration run ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadRun(g) {
    var id = g.active_run_id || (g.runs && g.runs.length ? g.runs[g.runs.length - 1].run_id : null);
    $('runCard').hidden = true;
    $('reviewCard').hidden = true;
    if (!id) return;
    api('GET', '/api/runs/' + encodeURIComponent(id)).then(function (res) {
      if (!goal || goal.goal_id !== g.goal_id) return;
      run = res.run;
      renderRun();
      render();
      if (RUN_END.indexOf(run.status) === -1) poll();
    }).catch(function () {});
  }

  function startRun(override) {
    withSaved(function () {
      return api('POST', '/api/goals/' + encodeURIComponent(goal.goal_id) + '/run', { override_blackout: Boolean(override) })
        .then(function (res) { run = res.run; renderRun(); render(); poll(); refreshGoal(); })
        .catch(function (err) {
          if (/blackout/i.test(err.message) && window.confirm(err.message + '\n\nRun the migration anyway?')) return startRun(true);
          showAlert('Could not start the migration: ' + esc(err.message));
        });
    });
  }

  function poll() {
    if (polling || !run) return;
    polling = true;
    var goalId = goal.goal_id;
    (function step() {
      if (!run || !goal || goal.goal_id !== goalId || RUN_END.indexOf(run.status) > -1) {
        polling = false;
        if (goal && goal.goal_id === goalId) refreshGoal();
        return;
      }
      api('POST', '/api/runs/' + encodeURIComponent(run.run_id) + '/advance', {})
        .then(function (res) { run = res.run; renderRun(); })
        .catch(function (err) { showAlert('Migration step failed: ' + esc(err.message)); run.status = 'FAILED'; })
        .then(function () { return sleep(120); })
        .then(step);
    })();
  }

  function refreshGoal() {
    api('GET', '/api/goals/' + encodeURIComponent(goal.goal_id)).then(function (res) {
      goal = res.goal;
      if (!dirty) draft = clone(goal);
      render();
      renderRun();
      return loadGoals();
    }).catch(function () {});
  }

  function runControl(action) {
    if (action === 'stop' && !window.confirm('Stop the migration? Records already written stay in the target; nothing else will be written. You can retry later.')) return;
    api('POST', '/api/runs/' + encodeURIComponent(run.run_id) + '/' + action, {})
      .then(function (res) {
        run = res.run;
        renderRun(); render();
        if (RUN_END.indexOf(run.status) === -1) poll(); else refreshGoal();
      })
      .catch(function (err) { showAlert('Could not ' + action + ': ' + esc(err.message)); });
  }

  /* ---------- human review actions ---------- */
  function reviewCall(path, body) {
    if (reviewBusy) return Promise.resolve();
    reviewBusy = true;
    renderReview();
    return fetch(path + '?count=' + encodeURIComponent(conn.demo.count) + '&seed=' + encodeURIComponent(conn.demo.seed), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (data.run) run = data.run;
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    }).finally(function () {
      reviewBusy = false;
      renderRun(); render();
      if (run && RUN_END.indexOf(run.status) === -1) poll(); else if (goal) refreshGoal();
    });
  }
  function approveRecord(fid) {
    delete reviewErrors[fid];
    reviewCall('/api/runs/' + encodeURIComponent(run.run_id) + '/review/' + encodeURIComponent(fid) + '/approve', { values: reviewInputs[fid] || {} })
      .catch(function (err) { reviewErrors[fid] = err.message; renderReview(); });
  }
  function skipRecord(fid) {
    reviewCall('/api/runs/' + encodeURIComponent(run.run_id) + '/review/' + encodeURIComponent(fid) + '/skip', {})
      .catch(function (err) { showAlert('Could not skip: ' + esc(err.message)); });
  }
  function applyGroup(group, mode) {
    var items = run.failures.filter(function (f) { return f.status === 'HUMAN_REVIEW_REQUIRED' && (!group || (f.recommendation && f.recommendation.group === group)); });
    if (mode === 'skip') {
      if (!window.confirm('Skip ' + items.length + ' record(s)? They will not be migrated.')) return;
      var chain = Promise.resolve();
      items.forEach(function (f) { chain = chain.then(function () { return reviewCall('/api/runs/' + encodeURIComponent(run.run_id) + '/review/' + encodeURIComponent(f.failure_id) + '/skip', {}); }); });
      chain.catch(function (err) { showAlert('Could not skip: ' + esc(err.message)); });
      return;
    }
    reviewCall('/api/runs/' + encodeURIComponent(run.run_id) + '/review/apply', { group: group || null })
      .then(function (data) {
        var o = data && data.outcome;
        if (o && (o.failed.length || o.needs_input)) {
          showAlert(o.approved + ' retried successfully, ' + o.skipped + ' skipped' + (o.failed.length ? ', ' + o.failed.length + ' still failing' : '') +
            (o.needs_input ? ', ' + o.needs_input + ' need you to type a value' : '') + '.');
        }
      })
      .catch(function (err) { showAlert('Could not apply recommendations: ' + esc(err.message)); });
  }
  function retryRun() {
    api('POST', '/api/runs/' + encodeURIComponent(run.run_id) + '/retry', {})
      .then(function (res) { run = res.run; renderRun(); render(); poll(); })
      .catch(function (err) {
        if (/blackout/i.test(err.message) && window.confirm(err.message + '\n\nRetry anyway?')) {
          return api('POST', '/api/runs/' + encodeURIComponent(run.run_id) + '/retry', { override_blackout: true })
            .then(function (res) { run = res.run; renderRun(); render(); poll(); });
        }
        showAlert('Could not retry: ' + esc(err.message));
      });
  }

  function renderReview() {
    var card = $('reviewCard');
    var rv = run && run.review;
    if (!rv || !rv.escalated) { card.hidden = true; return; }
    card.hidden = false;
    var awaiting = rv.awaiting;
    var open = awaiting && run.review_gate;
    var closed = ['COMPLETED', 'STOPPED', 'FAILED'].indexOf(run.status) > -1;
    card.className = 'hub-card review-card' + (awaiting ? ' is-open' : ' is-done');
    var stepList = function (attempts) {
      return '<ol class="rv-tried">' + (attempts || []).filter(function (a) { return a.step !== 'Human-approved retry'; }).map(function (a) {
        return '<li class="' + (a.ok ? 'ok' : '') + '"><b>' + esc(a.step) + '</b> — ' + esc(a.result) + '</li>';
      }).join('') + '</ol>';
    };
    var groupsHtml = rv.groups.map(function (g) {
      var expanded = reviewOpen[g.group];
      var rec = g.recommendation || {};
      var records = run.failures.filter(function (f) { return g.failure_ids.indexOf(f.failure_id) > -1; });
      var rows = expanded ? records.map(function (f) {
        var src = f.source || {};
        var who = Object.keys(src).filter(function (k) { return /name|reporter$|full_name|employee_name/i.test(k); }).map(function (k) { return src[k]; })[0] || '';
        var mail = Object.keys(src).filter(function (k) { return /mail/i.test(k); }).map(function (k) { return src[k]; })[0] || '';
        var fr = f.recommendation || {};
        var inputs = f.status === 'HUMAN_REVIEW_REQUIRED' && !closed ? (fr.changes || []).map(function (c) {
          var cur = reviewInputs[f.failure_id] && reviewInputs[f.failure_id][c.field] != null ? reviewInputs[f.failure_id][c.field] : c.value;
          return '<label class="rv-input"><span>' + esc(c.label) + '</span><input data-rv-input="' + esc(f.failure_id) + '" data-field="' + esc(c.field) + '" value="' + esc(cur) + '" placeholder="' + esc(c.hint) + '" title="' + esc(c.hint) + '"></label>';
        }).join('') : '';
        var state = f.status === 'RESOLVED' ? '<span class="rem-ok">✓ Approved by ' + esc(f.decision && f.decision.by) + ' — migrated as #' + esc(f.outcome && f.outcome.target_id) + '</span>'
          : f.status === 'SKIPPED' ? '<span class="wave-muted">Skipped by ' + esc(f.decision && f.decision.by) + '</span>'
            : f.status === 'DEFERRED' ? '<span class="wave-muted">Deferred — not migrated</span>' : '';
        return '<div class="rv-record">' +
          '<div class="rv-rec-id"><b>' + esc(f.record_id || f.failure_id) + '</b><small>' + esc(who) + (mail ? ' · ' + esc(mail) : '') + ' · ' + esc(run.waves[f.wave_id] ? run.waves[f.wave_id].name : '') + '</small></div>' +
          '<div class="rv-rec-body">' + (inputs || state) + (reviewErrors[f.failure_id] ? '<p class="rv-error">' + esc(reviewErrors[f.failure_id]) + '</p>' : '') + '</div>' +
          (f.status === 'HUMAN_REVIEW_REQUIRED' && !closed ? '<div class="rv-rec-actions"><button class="mini" data-rv-approve="' + esc(f.failure_id) + '"' + (reviewBusy ? ' disabled' : '') + '>Approve Retry</button>' +
            '<button class="mini ghost" data-rv-skip="' + esc(f.failure_id) + '"' + (reviewBusy ? ' disabled' : '') + '>Skip Record</button></div>' : '') +
        '</div>';
      }).join('') : '';
      return '<div class="rv-group' + (g.pending ? '' : ' done') + '">' +
        '<div class="rv-group-head"><h3>' + esc(g.title) + '</h3><span class="rv-count">' + g.total + ' record' + (g.total > 1 ? 's' : '') + ' affected' +
          (g.pending ? ' · <b>' + g.pending + ' pending</b>' : '') + (g.resolved ? ' · ' + g.resolved + ' approved' : '') + (g.skipped ? ' · ' + g.skipped + ' skipped' : '') + '</span></div>' +
        '<div class="rv-grid">' +
          '<div><h4>What failed</h4><p>' + esc(g.category) + ': ' + esc(g.what_failed) + '</p><h4>Why it failed</h4><p>' + esc(g.why || '—') + '</p></div>' +
          '<div><h4>What Zen tried</h4>' + stepList(g.attempts) + '<p class="rv-result"><b>Result:</b> ' + (g.pending ? 'Unable to resolve safely.' : 'Decided by a human.') + '</p></div>' +
          '<div><h4>What Zen recommends</h4><p class="rv-rec">' + esc(rec.summary || '—') + '</p>' +
            (g.pending && !closed ? '<div class="rv-actions">' +
              (rec.action === 'skip' ? '<button class="mini" data-rv-group-skip="' + esc(g.group) + '"' + (reviewBusy ? ' disabled' : '') + '>Skip ' + g.pending + ' record' + (g.pending > 1 ? 's' : '') + ' (recommended)</button>' +
                '<button class="mini ghost" data-rv-open="' + esc(g.group) + '">Review individually</button>'
                : '<button class="mini" data-rv-group="' + esc(g.group) + '"' + (reviewBusy || rec.needs_input ? ' disabled' : '') + '>Approve Retry (' + g.pending + ')</button>' +
                '<button class="mini ghost" data-rv-group-skip="' + esc(g.group) + '"' + (reviewBusy ? ' disabled' : '') + '>Skip</button>') +
            '</div>' + (rec.needs_input ? '<p class="wave-muted">Needs a value from you — open the records below.</p>' : '') : '') +
          '</div>' +
        '</div>' +
        '<button type="button" class="rv-toggle" data-rv-open="' + esc(g.group) + '">' + (expanded ? 'Hide records ▲' : 'Show ' + g.total + ' record' + (g.total > 1 ? 's' : '') + ' ▼') + '</button>' +
        (expanded ? '<div class="rv-records">' + rows + '</div>' : '') +
      '</div>';
    }).join('');

    var st = rv.status;
    card.innerHTML =
      '<div class="rv-head"><div><h2>' + (awaiting ? '⚠ Human Review Required' : 'Human review — all exceptions decided') + '</h2>' +
        '<p class="run-sub">' + (open ? 'Migration paused — waiting for your decision. Zen resumes automatically once every exception is decided.'
          : awaiting && closed ? 'This run ended with open exceptions.' : awaiting ? 'Zen escalated these while the migration continues.' :
            rv.human_resolved + ' approved, ' + rv.skipped + ' skipped' + (rv.deferred ? ', ' + rv.deferred + ' deferred' : '') + '.') + '</p></div>' +
        (open ? '<div class="pl-actions"><button class="mini" id="rvApplyAll"' + (reviewBusy ? ' disabled' : '') + '>Approve all recommended</button>' +
          '<button class="mini ghost" data-run="resume">Resume Migration</button><button class="mini ghost" data-run="stop">Stop Migration</button></div>' : '') +
      '</div>' +
      '<div class="rv-context">' +
        '<div><span>Current migration status</span><b>' + esc(st.run_status.replace(/_/g, ' ').toLowerCase()) + '</b><small>' + esc(st.current_wave) + ' · ' + st.migrated.toLocaleString() + ' of ' + st.expected.toLocaleString() + ' migrated</small></div>' +
        '<div><span>Records affected</span><b>' + rv.escalated + '</b><small>' + awaiting + ' awaiting a decision</small></div>' +
        '<div><span>Success rate</span><b>' + rv.impact.success_rate_now + '%</b><small>' + (awaiting ? rv.impact.success_rate_if_approved + '% if the recommendations are approved' : 'final') + '</small></div>' +
        '<div class="wide"><span>Impact on migration</span><p>' + esc(rv.impact.message) + '</p></div>' +
      '</div>' +
      '<div class="rv-groups">' + groupsHtml + '</div>';

    card.querySelectorAll('[data-run]').forEach(function (b) { b.addEventListener('click', function () { runControl(b.getAttribute('data-run')); }); });
    var all = $('rvApplyAll');
    if (all) all.addEventListener('click', function () { applyGroup(null, 'approve'); });
    card.querySelectorAll('[data-rv-open]').forEach(function (b) { b.addEventListener('click', function () { var g = b.getAttribute('data-rv-open'); reviewOpen[g] = !reviewOpen[g]; renderReview(); }); });
    card.querySelectorAll('[data-rv-group]').forEach(function (b) { b.addEventListener('click', function () { applyGroup(b.getAttribute('data-rv-group'), 'approve'); }); });
    card.querySelectorAll('[data-rv-group-skip]').forEach(function (b) { b.addEventListener('click', function () { applyGroup(b.getAttribute('data-rv-group-skip'), 'skip'); }); });
    card.querySelectorAll('[data-rv-approve]').forEach(function (b) { b.addEventListener('click', function () { approveRecord(b.getAttribute('data-rv-approve')); }); });
    card.querySelectorAll('[data-rv-skip]').forEach(function (b) { b.addEventListener('click', function () { skipRecord(b.getAttribute('data-rv-skip')); }); });
    card.querySelectorAll('[data-rv-input]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var fid = inp.getAttribute('data-rv-input');
        reviewInputs[fid] = reviewInputs[fid] || {};
        reviewInputs[fid][inp.getAttribute('data-field')] = inp.value;
      });
    });
  }

  function renderRun() {
    try {
      drawRun();
    } catch (err) {
      // never leave the panel blank — show what went wrong instead
      var card = $('runCard');
      card.hidden = false;
      card.innerHTML = '<p class="int-note">Could not display this migration run (' + esc(err.message) + '). Reload the page with Cmd+Shift+R.</p>';
      if (window.console) console.error(err);
    }
  }

  function drawRun() {
    var card = $('runCard');
    if (!run) { card.hidden = true; return; }
    card.hidden = false;
    var tz = draft ? draft.schedule.timezone : browserTz;
    var t = run.totals;
    var ended = RUN_END.indexOf(run.status) > -1;
    var wave = run.waves[run.current_wave_id];
    var idx = run.wave_order.indexOf(run.current_wave_id);
    var title = { COMPLETED: 'Migration completed', HUMAN_REVIEW_REQUIRED: run.review_gate ? 'Migration paused — human review required' : 'Migration stopped — human review required',
      BLOCKED: 'Migration blocked', PAUSED: 'Migration paused', FAILED: 'Migration failed', STOPPED: 'Migration stopped' }[run.status] || 'Migration in progress';
    card.className = 'hub-card run-card' + (run.status === 'COMPLETED' ? ' done' : (ended ? ' attn' : ''));
    var pct = t.expected ? Math.min(100, Math.round((t.processed / t.expected) * 100)) : 0;
    var stepIdx = RUN_STEPS.indexOf(wave.phase);
    if (run.status === 'HUMAN_REVIEW_REQUIRED' && run.review_gate && run.review_gate.type === 'final') stepIdx = RUN_STEPS.indexOf('HUMAN_REVIEW');
    if (run.status === 'FINALIZING') stepIdx = RUN_STEPS.indexOf('HUMAN_REVIEW') + 1;
    var stopped = ended && run.status !== 'COMPLETED' && !run.review_gate;
    var steps = RUN_STEPS.map(function (p, i) {
      var cls = '';
      if (run.status === 'COMPLETED' || i < stepIdx) cls = 'done';
      else if (i === stepIdx) cls = stopped ? 'stop' : 'now';
      if (stopped && stepIdx === -1 && i === 0) cls = 'stop';
      return '<div class="run-step ' + cls + '">' + p.replace(/_/g, ' ') + '</div>';
    }).join('');
    var time = function (iso) { return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso)); };

    var rows = run.wave_order.map(function (id, i) {
      var w = run.waves[id];
      var rate = w.evaluation ? (w.evaluation.success_rate * 100).toFixed(1) + '%' : (w.counts.processed ? (((w.counts.successful + w.counts.remediated) / w.counts.processed) * 100).toFixed(1) + '%' : '—');
      var recon = w.reconciliation ? (w.reconciliation.match ? '<em class="ok">Matched</em>' : '<em class="warn">Gaps</em>') : '—';
      return '<tr><td><b>' + (i + 1) + '. ' + esc(w.name) + '</b></td><td>' + esc(w.phase.replace(/_/g, ' ').toLowerCase()) + '</td><td>' +
        w.counts.processed + ' / ' + w.expected + '</td><td>' + w.counts.successful + '</td><td>' + w.counts.remediated + '</td><td>' +
        w.counts.human_review + '</td><td>' + rate + '</td><td>' + recon + '</td></tr>';
    }).join('');

    card.innerHTML =
      '<div class="run-head"><div><h2>' + (ended ? '' : '<span class="run-live"></span>') + esc(title) + '</h2>' +
        '<p class="run-sub">Source: <b>' + esc(run.source.name) + '</b> → Target: <b>' + esc(run.target.name) + '</b>' +
        (run.source.mode === 'mock' ? ' · demo data' : '') + ' · mapping v' + esc(run.mapping_version || '—') + ' · ' + esc(run.run_id) + '</p>' +
        (run.status_reason && ended ? '<p class="run-sub">' + esc(run.status_reason) + '</p>' : '') + '</div>' +
        '<div class="pl-actions">' +
          (!ended && wave.phase === 'MIGRATING' ? '<button class="mini ghost" data-run="pause">Pause</button>' : '') +
          (run.status === 'PAUSED' || run.review_gate ? '<button class="mini" data-run="resume">Resume</button>' : '') +
          (['COMPLETED', 'STOPPED', 'FAILED'].indexOf(run.status) === -1 && run.status !== 'BLOCKED' ? '<button class="mini ghost" data-run="stop">Stop</button>' : '') +
          (['STOPPED', 'FAILED', 'BLOCKED'].indexOf(run.status) > -1 && goal && goal.status !== 'COMPLETED' ? '<button class="mini" id="retryRunBtn">Retry</button>' : '') +
          '<a class="mini' + (run.status === 'COMPLETED' ? '' : ' ghost') + '" id="runReportLink" href="#">' + (run.status === 'COMPLETED' ? 'View migration report →' : 'Live report') + '</a>' +
        '</div></div>' +
      '<div class="run-steps">' + steps + '</div>' +
      '<div class="run-wave">Wave ' + (idx + 1) + ' of ' + run.wave_order.length + ' — <b>' + esc(wave.name) + '</b>' +
        (wave.workspace ? ' → ' + esc(run.target.name) + ' / ' + esc(wave.workspace.name) : '') + '</div>' +
      '<div class="run-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="run-tiles">' +
        '<div class="run-tile"><span>Records processed</span><b>' + t.processed.toLocaleString() + ' / ' + t.expected.toLocaleString() + '</b></div>' +
        '<div class="run-tile ok"><span>Successful</span><b>' + t.successful.toLocaleString() + '</b></div>' +
        '<div class="run-tile bad"><span>Failed</span><b>' + t.failed.toLocaleString() + '</b></div>' +
        '<div class="run-tile fix"><span>Remediated</span><b>' + t.remediated.toLocaleString() + '</b></div>' +
        '<div class="run-tile rev"><span>Human review</span><b>' + t.human_review.toLocaleString() + '</b></div>' +
      '</div>' +
      productStripHtml() +
      '<table class="hub-table run-table"><thead><tr><th>Wave</th><th>Phase</th><th>Processed</th><th>Successful</th><th>Remediated</th><th>Review</th><th>Success</th><th>Reconciliation</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="run-cols">' +
        '<div><h3>Activity</h3><div class="run-log">' + run.events.slice().reverse().map(function (e) {
          return '<div><time>' + esc(time(e.at)) + '</time><span class="' + esc(e.level) + '">' + esc(e.message) + '</span></div>';
        }).join('') + '</div></div>' +
        '<div>' + remediationSummaryHtml() + '</div>' +
      '</div>' + remediationDetailHtml();
    card.querySelectorAll('[data-run]').forEach(function (b) {
      b.addEventListener('click', function () { runControl(b.getAttribute('data-run')); });
    });
    var retryBtn = card.querySelector('#retryRunBtn');
    var reportLink = card.querySelector('#runReportLink');
    if (reportLink) reportLink.href = 'report.html?run=' + encodeURIComponent(run.run_id);
    if (retryBtn) retryBtn.addEventListener('click', retryRun);
    renderReview();
    var sum = card.querySelector('[data-rem-toggle]');
    if (sum) sum.addEventListener('click', function () { remOpen = !remOpen; renderRun(); });
    card.querySelectorAll('[data-rem-filter]').forEach(function (b) {
      b.addEventListener('click', function () { remFilter = b.getAttribute('data-rem-filter'); remDetail = null; renderRun(); });
    });
    card.querySelectorAll('[data-rem-detail]').forEach(function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-rem-detail'); remDetail = remDetail === id ? null : id; renderRun(); });
    });
  }

  function productStripHtml() {
    var r = run.remediation;
    var rv = run.review;
    if (!r || !r.detected) return '';
    return '<div class="split-strip">' +
      '<div class="ai"><span>AI handles routine work</span><b>' + r.resolved + ' of ' + r.detected + '</b> failures fixed automatically by Zen' +
        (r.ai_resolved ? ' (' + r.ai_resolved + ' with Claude)' : '') + '</div>' +
      '<div class="human"><span>Human handles exceptions</span><b>' + (rv ? rv.escalated : r.human_review) + '</b> escalated · ' +
        (rv && rv.awaiting ? '<b>' + rv.awaiting + ' need your decision</b>' : (rv ? rv.human_resolved + ' approved, ' + rv.skipped + ' skipped' : '')) + '</div>' +
    '</div>';
  }

  function remediationSummaryHtml() {
    var r = run.remediation || { detected: 0, resolved: 0, human_review: 0, pending: 0, ai_resolved: 0 };
    if (!r.detected) return '<h3>AI Remediation</h3><p class="wave-muted">No failures detected yet.</p>';
    return '<h3>AI Remediation</h3>' +
      '<button type="button" class="rem-summary' + (remOpen ? ' open' : '') + '" data-rem-toggle aria-expanded="' + remOpen + '">' +
        '<b>' + r.detected + ' failure' + (r.detected > 1 ? 's' : '') + ' detected</b>' +
        '<span class="rem-ok">✓ ' + r.resolved + ' automatically resolved' + (r.ai_resolved ? ' <small>(' + r.ai_resolved + ' with AI)</small>' : '') + '</span>' +
        '<span class="rem-warn">⚠ ' + r.human_review + ' require human review</span>' +
        (r.pending ? '<span class="rem-pending">… ' + r.pending + ' being analysed</span>' : '') +
        '<em>' + (remOpen ? 'Hide details ▲' : 'Show reasons ▼') + '</em>' +
      '</button>' +
      (r.ai_error ? '<p class="wave-muted">AI was unavailable (' + esc(r.ai_error) + '); records needing it went to human review.</p>' : '');
  }

  function remediationDetailHtml() {
    var r = run.remediation;
    if (!remOpen || !r || !r.detected) return '';
    var cats = Object.keys(r.by_category).map(function (k) {
      var c = r.by_category[k];
      return '<tr><td>' + esc(c.label) + '</td><td>' + c.detected + '</td><td class="rem-ok">' + c.resolved + '</td><td class="rem-warn">' + c.human_review + '</td>' +
        (c.pending ? '<td>' + c.pending + '</td>' : '<td>—</td>') + '</tr>';
    }).join('');
    var list = (run.failures || []).filter(function (f) { return remFilter === 'ALL' || f.status === remFilter; });
    var rows = list.slice(0, 150).map(function (f) {
      var rem = f.remediation || {};
      var what = rem.strategies && rem.strategies.length
        ? rem.strategies.filter(function (v, i, a) { return a.indexOf(v) === i; }).map(function (st) { return STRATEGY_LABELS[st] || st; }).join(', ')
        : (f.status === 'OPEN' || f.status === 'REMEDIATING' ? 'Analysing…' : 'Not auto-fixable');
      var changes = (rem.changes || []).filter(function (c) { return c.detail !== '' || c.strategy !== 'swap_mismatched_fields'; }).map(function (c) {
        return '<div class="rem-change"><code>' + esc(c.field) + '</code> <s>' + esc(c.from === '' ? '(empty)' : c.from) + '</s> → <b>' + esc(c.to) + '</b>' +
          (c.detail ? '<small>' + esc(c.detail) + '</small>' : '') + '</div>';
      }).join('');
      var outcome = f.status === 'RESOLVED'
        ? '<span class="rem-ok">✓ Re-processed and written' + (f.outcome && f.outcome.target_id ? ' (#' + esc(f.outcome.target_id) + ')' : '') + '</span>' +
          (rem.rerouted_to ? ' <small>→ re-routed to ' + esc(rem.rerouted_to) + '</small>' : '') +
          (rem.method === 'ai' ? ' <span class="map-method ai">AI</span>' : '')
        : f.status === 'HUMAN_REVIEW_REQUIRED' ? '<span class="rem-warn">⚠ ' + esc(f.review_reason || 'Needs review') + '</span>' : '<span class="wave-muted">Pending</span>';
      var detail = remDetail === f.failure_id
        ? '<tr class="rem-more"><td colspan="6"><div class="rem-grid"><div><h4>Source data</h4><dl class="kv">' + Object.keys(f.source).map(function (k) {
            return '<dt>' + esc(k) + '</dt><dd>' + esc(f.source[k] === '' ? '(empty)' : f.source[k]) + '</dd>';
          }).join('') + '</dl></div><div><h4>Target mapping</h4><div class="walk-map">' + f.target_mapping.map(function (m) {
            return '<code>' + esc(m.sourceField) + '</code><i>→</i><b>' + esc(m.targetField) + '</b><span>' + esc(m.value === '' ? '(empty)' : m.value) + '</span>';
          }).join('') + '</div><h4>Recommended action</h4><p>' + esc(f.recommended_action || '—') + '</p>' +
          (f.write_error ? '<h4>Target error</h4><p>' + esc(f.write_error.code + ' ' + f.write_error.message) + '</p>' : '') +
          '</div></div></td></tr>'
        : '';
      return '<tr class="rem-row" data-rem-detail="' + esc(f.failure_id) + '"><td><b>' + esc(f.record_id || f.failure_id) + '</b><small>' + esc(run.waves[f.wave_id] ? run.waves[f.wave_id].name : '') + '</small></td>' +
        '<td>' + esc(f.category_label) + '</td><td class="rem-reason">' + esc(f.reason) + '</td>' +
        '<td>' + esc(what) + changes + '</td><td>' + f.retry_count + '</td><td>' + outcome + '</td></tr>' + detail;
    }).join('');
    var count = function (st) { return (run.failures || []).filter(function (f) { return st === 'ALL' || f.status === st; }).length; };
    return '<div class="rem-detail">' +
      '<table class="hub-table rem-cats"><thead><tr><th>Error category</th><th>Detected</th><th>Resolved</th><th>Human review</th><th>Pending</th></tr></thead><tbody>' + cats + '</tbody></table>' +
      '<div class="rem-filters">' + [['HUMAN_REVIEW_REQUIRED', 'Human review'], ['RESOLVED', 'Automatically resolved'], ['ALL', 'All failures']].map(function (x) {
        return '<button type="button" class="chip' + (remFilter === x[0] ? ' is-active' : '') + '" data-rem-filter="' + x[0] + '">' + x[1] + ' (' + count(x[0]) + ')</button>';
      }).join('') + '<span class="wave-muted">Click a row for source data and mapping.</span></div>' +
      '<div class="int-table-wrap"><table class="hub-table rem-table"><thead><tr><th>Record</th><th>Category</th><th>Failure reason</th><th>Remediation</th><th>Retries</th><th>Result</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6" class="wave-muted">None.</td></tr>') + '</tbody></table></div>' +
      (list.length > 150 ? '<p class="wave-muted">Showing 150 of ' + list.length + '.</p>' : '') +
    '</div>';
  }

  /* ---------- render ---------- */
  function render() {
    var tz = draft.schedule.timezone;
    $('tzNote').textContent = 'Times in ' + tz;
    $('gTitle').textContent = draft.title;
    $('gStatus').outerHTML = goalBadge(goal.status).replace('<em ', '<em id="gStatus" ');
    var m = $('gMethod');
    m.textContent = goal.interpretation.method === 'ai' ? 'Interpreted by Claude' : 'Interpreted by rules';
    m.className = 'map-method ' + (goal.interpretation.method === 'ai' ? 'ai' : '');
    $('gQuote').textContent = '“' + draft.goal_description + '”';
    $('approveBtn').hidden = Boolean(goal.approved_at);
    var runActive = run && RUN_END.indexOf(run.status) === -1;
    $('runBtn').hidden = goal.status === 'COMPLETED' || runActive || (run && (run.status === 'PAUSED' || run.review_gate));
    $('runBtn').textContent = goal.approved_at ? 'Run migration now' : 'Approve & run migration';
    $('precheckAllBtn').hidden = !goal.approved_at;

    renderFacts();
    renderMessages(tz);
    renderReco(tz);
    renderWaves(tz);
    renderCriteria();
    renderPolicy();
    renderBlackouts();
    renderConfig(tz);
  }

  function renderFacts() {
    var fm = draft.field_mapping;
    var toggle = function (key, label) {
      return '<div class="pl-fact"><span>' + label + '</span><label><input type="checkbox" data-opt="' + key + '"' +
        (draft.options[key] ? ' checked' : '') + '> ' + (draft.options[key] ? 'Enabled' : 'Disabled') + '</label></div>';
    };
    var rt = function (key, label) {
      return '<label><input type="checkbox" data-rt="' + key + '"' + (draft.record_types.indexOf(key) > -1 ? ' checked' : '') + '> ' + label + '</label>';
    };
    $('gFacts').innerHTML =
      '<div class="pl-fact"><span>Source</span><b>' + esc(draft.source.name) + '</b></div>' +
      '<div class="pl-fact"><span>Target</span><b>' + esc(draft.target.name) + '</b></div>' +
      '<div class="pl-fact"><span>Records</span>' + rt('employees', 'Employees') + rt('tickets', 'Tickets') + '</div>' +
      '<div class="pl-fact"><span>Scope</span><b>' + (draft.scope.type === 'all' ? 'All records' : 'Filtered') + '</b></div>' +
      '<div class="pl-fact"><span>Field mapping</span>' + (fm.status === 'approved'
        ? '<b>Approved v' + fm.version + '</b> · <a href="mapping.html">view</a>'
        : '<b>Not approved</b> · <a href="mapping.html">review</a>') + '</div>' +
      '<div class="pl-fact"><span>Workspace classification</span><b>Enabled</b></div>' +
      toggle('validation', 'Validation') + toggle('remediation', 'Remediation') + toggle('human_escalation', 'Human escalation');

    $('gFacts').querySelectorAll('[data-opt]').forEach(function (el) {
      el.addEventListener('change', function () { draft.options[el.getAttribute('data-opt')] = el.checked; setDirty(true); render(); });
    });
    $('gFacts').querySelectorAll('[data-rt]').forEach(function (el) {
      el.addEventListener('change', function () {
        var k = el.getAttribute('data-rt');
        draft.record_types = draft.record_types.filter(function (x) { return x !== k; });
        if (el.checked) draft.record_types.push(k);
        setDirty(true); render();
      });
    });
  }

  function renderMessages() {
    var html = '';
    (goal.warnings || []).forEach(function (w) { html += '<div class="pl-msg warn"><span>⚠ ' + esc(w) + '</span></div>'; });
    (goal.uncovered_workspaces || []).forEach(function (u) {
      html += '<div class="pl-msg note"><span>' + esc(u.name) + ' isn\'t in any wave (' + u.tickets.toLocaleString() + ' tickets).</span>' +
        '<button class="mini ghost" data-add-ws="' + esc(u.id) + '">Add as wave</button></div>';
    });
    var interp = goal.interpretation || {};
    if (interp.error) html += '<div class="pl-msg note"><span>Claude was unavailable, so Zen used its built-in rules to read this goal.</span></div>';
    (interp.notes || []).forEach(function (n) {
      if (/No approved field mapping/.test(n) && goal.field_mapping.status === 'approved') return; // resolved since planning
      html += '<div class="pl-msg note"><span>' + esc(n) + '</span></div>';
    });
    if ((interp.defaults_applied || []).length) {
      html += '<div class="pl-msg note"><span>Default success criteria applied where you didn\'t specify one — adjust them on the right.</span></div>';
    }
    $('gMessages').innerHTML = html ? '<div class="pl-msgs">' + html + '</div>' : '';
    $('gMessages').querySelectorAll('[data-add-ws]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = goal.uncovered_workspaces.filter(function (x) { return String(x.id) === b.getAttribute('data-add-ws'); })[0];
        if (u) addWave(u);
      });
    });
  }

  function renderReco(tz) {
    var r = goal.recommendation;
    var el = $('gReco');
    if (!r) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<h3>Zen recommendation <span class="map-method ai">Recommendation</span></h3>' +
      '<div class="pl-reco-when">' + esc(fmt(r.at, tz)) + ' · ' + Math.round(r.window_minutes / 60) + '-hour window</div>' +
      '<ul>' + r.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<p class="int-note">' + (r.applied
        ? 'Applied to Wave 1. Change the time below or approve it as is.'
        : 'Your requested time conflicts with a blackout period. This slot doesn\'t.') + '</p>' +
      (r.applied ? '' : '<button class="mini" id="useReco">Use this time for Wave 1</button>');
    var use = $('useReco');
    if (use) use.addEventListener('click', function () {
      draft.waves[0].schedule = { type: 'at', at: r.at };
      setDirty(true); render();
    });
  }

  function renderWaves(tz) {
    var box = $('waves');
    box.innerHTML = '';
    var linear = draft.waves.length > 1 && draft.waves.slice(1).every(function (w, i) {
      return (w.depends_on || []).some(function (d) { return d.wave_id === draft.waves[i].wave_id; });
    });
    $('chain').textContent = linear
      ? 'Dependency: ' + draft.waves.map(function (w) { return w.name; }).join(' → ')
      : (goal.dependencies.length ? goal.dependencies.length + ' dependenc' + (goal.dependencies.length > 1 ? 'ies' : 'y') : 'No dependencies');

    var workspaces = draft.workspace_mapping.workspaces || [];
    draft.waves.forEach(function (w, i) {
      var serverWave = goal.waves.filter(function (x) { return x.wave_id === w.wave_id; })[0] || w;
      var editable = EDITABLE.indexOf(serverWave.status) > -1;
      var label = serverWave.display_status || serverWave.status;
      var el = document.createElement('div');
      el.className = 'wave' + (/Blocked|Human review|Failed|Paused/.test(label) ? ' is-attn' : '') + (label === 'Ready' ? ' is-ready' : '');

      var est = serverWave.record_estimate;
      var records = est ? (est.tickets || 0).toLocaleString() + ' tickets' + (est.employees != null ? ' · ' + est.employees.toLocaleString() + ' employees' : '') : '—';
      var others = draft.waves.filter(function (x) { return x.wave_id && x.wave_id !== w.wave_id; });

      var sched;
      if (w.schedule.type === 'at') {
        sched = '<input type="datetime-local" data-f="at" value="' + esc(toInput(w.schedule.at, tz)) + '"' + (editable ? '' : ' disabled') + '>' +
          (w.schedule.recommended ? '<span class="wave-tag">Recommended</span>' : '');
      } else if (w.schedule.type === 'after_dependency') {
        sched = '<span>After ' + esc((w.depends_on || []).map(function (d) { return waveName(d.wave_id); }).join(', ') || '…') + ' validation</span>' +
          (serverWave.schedule.estimated_at ? '<span class="wave-muted">est. ' + esc(fmt(serverWave.schedule.estimated_at, tz)) + '</span>' : '');
      } else {
        sched = '<span>Immediately on approval</span>';
      }
      var win = serverWave.window && serverWave.window.start
        ? esc(fmt(serverWave.window.start, tz)) + ' – ' + esc(fmtTime(serverWave.window.end, tz)) + (serverWave.window.estimated ? ' <span class="wave-muted">(estimated)</span>' : '')
        : '—';

      el.innerHTML =
        '<div class="wave-head"><h3><span class="wave-num">' + (i + 1) + '</span>Wave ' + (i + 1) + ' — <input data-f="name" value="' + esc(w.name) + '"' + (editable ? '' : ' disabled') + ' aria-label="Wave name"></h3>' +
          '<em class="wave-status ' + statusClass(label) + '">' + esc(label) + '</em></div>' +
        '<div class="wave-grid">' +
          '<span>Target</span><div>' + esc(draft.target.name) + ' → <select data-f="ws"' + (editable ? '' : ' disabled') + '>' +
            workspaces.map(function (ws) { return '<option value="' + esc(ws.id) + '"' + (w.workspace && String(w.workspace.id) === String(ws.id) ? ' selected' : '') + '>' + esc(ws.name) + '</option>'; }).join('') +
            (w.workspace ? '' : '<option value="" selected>All workspaces</option>') + '</select></div>' +
          '<span>Records</span><div>' + records + '</div>' +
          '<span>Schedule</span><div class="wave-sched"><select data-f="type"' + (editable ? '' : ' disabled') + '>' +
            '<option value="at"' + (w.schedule.type === 'at' ? ' selected' : '') + '>Specific time</option>' +
            '<option value="after_dependency"' + (w.schedule.type === 'after_dependency' ? ' selected' : '') + '>After dependency</option>' +
            '<option value="immediate"' + (w.schedule.type === 'immediate' ? ' selected' : '') + '>Immediately</option>' +
          '</select>' + sched + '</div>' +
          '<span>Window</span><div>' + win + '</div>' +
          '<span>Depends on</span><div class="wave-deps">' + (others.length ? others.map(function (o) {
            var on = (w.depends_on || []).some(function (d) { return d.wave_id === o.wave_id; });
            return '<label><input type="checkbox" data-dep="' + esc(o.wave_id) + '"' + (on ? ' checked' : '') + (editable ? '' : ' disabled') + '> ' + esc(o.name) + '</label>';
          }).join('') : '<span class="wave-muted">—</span>') + '</div>' +
        '</div>' +
        (serverWave.prechecks ? '<div class="checks">' + serverWave.prechecks.results.map(function (c) {
          var icon = { pass: '✓', fail: '✕', waiting: '…' }[c.status] || '·';
          return '<div class="check ' + c.status + '"><i>' + icon + '</i><div>' + esc(c.label) + '<small>' + esc(c.detail) + '</small></div></div>';
        }).join('') + '</div>' : '') +
        '<div class="wave-foot"><span class="wave-reason">' + esc(serverWave.status_reason || '') + '</span><span>' +
          (goal.approved_at && editable ? '<button class="mini ghost" data-act="precheck">Run pre-checks</button> ' : '') +
          (editable && draft.waves.length > 1 ? '<button class="mini ghost" data-act="remove" aria-label="Remove wave">✕</button>' : '') +
        '</span></div>';

      var on = function (sel, ev, fn) { var x = el.querySelector(sel); if (x) x.addEventListener(ev, fn); };
      on('[data-f="name"]', 'change', function (e) { w.name = e.target.value; setDirty(true); render(); });
      on('[data-f="ws"]', 'change', function (e) {
        var ws = workspaces.filter(function (x) { return String(x.id) === e.target.value; })[0];
        w.workspace = ws ? { id: ws.id, name: ws.name } : null; setDirty(true); render();
      });
      on('[data-f="type"]', 'change', function (e) {
        w.schedule = { type: e.target.value, at: e.target.value === 'at' ? (w.schedule.at || serverWave.schedule.estimated_at || goal.schedule.first_start) : null };
        setDirty(true); render();
      });
      on('[data-f="at"]', 'change', function (e) {
        var iso = fromInput(e.target.value, tz);
        if (iso) { w.schedule = { type: 'at', at: iso }; setDirty(true); render(); }
      });
      el.querySelectorAll('[data-dep]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-dep');
          w.depends_on = (w.depends_on || []).filter(function (d) { return d.wave_id !== id; });
          if (cb.checked) w.depends_on.push({ wave_id: id });
          setDirty(true); render();
        });
      });
      on('[data-act="precheck"]', 'click', function () { precheck(w.wave_id); });
      on('[data-act="remove"]', 'click', function () {
        if (!window.confirm('Remove wave "' + w.name + '"?')) return;
        draft.waves = draft.waves.filter(function (x) { return x !== w; });
        draft.waves.forEach(function (x) { x.depends_on = (x.depends_on || []).filter(function (d) { return d.wave_id !== w.wave_id; }); });
        save();
      });

      if (i > 0) {
        var prev = draft.waves[i - 1];
        var link = document.createElement('div');
        var gated = (w.depends_on || []).some(function (d) { return d.wave_id === prev.wave_id; });
        link.className = 'wave-link';
        link.innerHTML = gated ? '<b>↓</b>' + esc(prev.name) + ' validation · if successful' : '<b>↓</b>';
        box.appendChild(link);
      }
      box.appendChild(el);
    });

    var used = {};
    draft.waves.forEach(function (w) { if (w.workspace) used[String(w.workspace.id)] = true; });
    var free = workspaces.filter(function (ws) { return !used[String(ws.id)]; });
    $('addWaveWs').innerHTML = free.map(function (ws) { return '<option value="' + esc(ws.id) + '">' + esc(ws.name) + '</option>'; }).join('');
    $('addWaveWs').parentNode.hidden = !free.length;
  }

  function renderCriteria() {
    var c = draft.success_criteria;
    var parts = ['Success rate <b>≥ ' + Math.round(c.min_success_rate * 100) + '%</b>', 'Critical errors <b>= ' + c.max_critical_errors + '</b>'];
    if (c.required_fields_populated) parts.push('All required fields populated');
    if (c.reconciliation_complete) parts.push('Reconciliation complete');
    if (c.no_unresolved_high_severity) parts.push('No unresolved high-severity failures');
    $('formula').innerHTML = parts.join(' <b>AND</b> ') + '<br><span class="wave-muted">Only when these are met does Zen proceed to the next wave.</span>';
    $('criteria').innerHTML =
      '<label for="scRate">Minimum success rate (%)</label><input id="scRate" type="number" min="1" max="100" step="1" value="' + Math.round(c.min_success_rate * 100) + '">' +
      '<label for="scCrit">Maximum critical errors</label><input id="scCrit" type="number" min="0" step="1" value="' + c.max_critical_errors + '">' +
      '<label class="pl-check"><input type="checkbox" id="scReq"' + (c.required_fields_populated ? ' checked' : '') + '> All required fields populated</label>' +
      '<label class="pl-check"><input type="checkbox" id="scRec"' + (c.reconciliation_complete ? ' checked' : '') + '> Source/target reconciliation completed</label>' +
      '<label class="pl-check"><input type="checkbox" id="scHigh"' + (c.no_unresolved_high_severity ? ' checked' : '') + '> No unresolved high-severity failures</label>';
    var upd = function () {
      draft.success_criteria = {
        min_success_rate: Math.min(100, Math.max(1, +$('scRate').value || 95)) / 100,
        max_critical_errors: Math.max(0, parseInt($('scCrit').value, 10) || 0),
        required_fields_populated: $('scReq').checked,
        reconciliation_complete: $('scRec').checked,
        no_unresolved_high_severity: $('scHigh').checked
      };
      setDirty(true); render();
    };
    ['scRate', 'scCrit', 'scReq', 'scRec', 'scHigh'].forEach(function (id) { $(id).addEventListener('change', upd); });
  }

  function select(id, options, value) {
    return '<select id="' + id + '">' + Object.keys(options).map(function (k) {
      return '<option value="' + k + '"' + (k === value ? ' selected' : '') + '>' + esc(options[k]) + '</option>';
    }).join('') + '</select>';
  }
  function pick(keys) {
    var o = {};
    keys.forEach(function (k) { o[k] = POLICY_LABELS[k]; });
    return o;
  }

  function renderPolicy() {
    var w = draft.migration_window;
    var p = draft.failure_policy;
    $('policy').innerHTML =
      '<h4>Migration window</h4>' +
      '<label for="winHours">Window length (hours)</label><input id="winHours" type="number" min="0.5" max="24" step="0.5" value="' + (w.duration_minutes / 60) + '">' +
      '<label for="winOver">If not finished in the window</label>' + select('winOver', OVERRUN_LABELS, w.on_overrun) +
      '<h4>Execution policy</h4>' +
      '<label for="polOk">If the wave succeeds</label>' + select('polOk', pick(['continue', 'human_review', 'pause']), p.on_success) +
      '<label for="polPartial">If it partially fails</label>' + select('polPartial', pick(['ai_remediation', 'human_review', 'pause']), p.on_partial_failure) +
      '<label for="polUnres">If still unresolved</label>' + select('polUnres', pick(['human_review', 'pause', 'stop']), p.on_unresolved) +
      '<label for="polCrit">On a critical failure</label>' + select('polCrit', pick(['pause', 'stop', 'escalate']), p.on_critical_failure) +
      '<label for="polPause">Pause if success rate drops below (%)</label><input id="polPause" type="number" min="1" max="100" placeholder="off" value="' +
        (p.pause_below_success_rate != null ? Math.round(p.pause_below_success_rate * 100) : '') + '">';
    var upd = function () {
      draft.migration_window = { duration_minutes: Math.round(Math.min(24, Math.max(0.5, +$('winHours').value || 5)) * 60), on_overrun: $('winOver').value };
      var pause = $('polPause').value.trim();
      draft.failure_policy = {
        on_success: $('polOk').value, on_partial_failure: $('polPartial').value, on_unresolved: $('polUnres').value,
        on_critical_failure: $('polCrit').value, pause_below_success_rate: pause === '' ? null : Math.min(100, Math.max(1, +pause)) / 100
      };
      setDirty(true); render();
    };
    ['winHours', 'winOver', 'polOk', 'polPartial', 'polUnres', 'polCrit', 'polPause'].forEach(function (id) { $(id).addEventListener('change', upd); });
  }

  function renderBlackouts() {
    var box = $('blackouts');
    box.innerHTML = draft.blackout_periods.length ? '' : '<p class="wave-muted">None — migrations may run at any time.</p>';
    draft.blackout_periods.forEach(function (b, i) {
      var row = document.createElement('div');
      row.className = 'bo-row';
      row.innerHTML = '<input type="text" data-f="label" value="' + esc(b.label) + '" aria-label="Blackout name">' +
        '<div class="bo-days">' + DAYS.map(function (d) {
          return '<button type="button" data-day="' + d + '" class="' + (b.days.indexOf(d) > -1 ? 'on' : '') + '">' + DAY_LABEL[d] + '</button>';
        }).join('') + '</div>' +
        '<input type="time" data-f="start" value="' + esc(b.start) + '" aria-label="Start"> – <input type="time" data-f="end" value="' + esc(b.end) + '" aria-label="End">' +
        '<button class="mini ghost" data-f="rm" aria-label="Remove blackout">✕</button>';
      row.querySelector('[data-f="label"]').addEventListener('change', function (e) { b.label = e.target.value; setDirty(true); render(); });
      row.querySelector('[data-f="start"]').addEventListener('change', function (e) { b.start = e.target.value; setDirty(true); render(); });
      row.querySelector('[data-f="end"]').addEventListener('change', function (e) { b.end = e.target.value; setDirty(true); render(); });
      row.querySelector('[data-f="rm"]').addEventListener('click', function () { draft.blackout_periods.splice(i, 1); setDirty(true); render(); });
      row.querySelectorAll('[data-day]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var d = btn.getAttribute('data-day');
          b.days = b.days.indexOf(d) > -1 ? b.days.filter(function (x) { return x !== d; }) : b.days.concat(d);
          setDirty(true); render();
        });
      });
      box.appendChild(row);
    });
  }

  function renderConfig(tz) {
    var g = draft;
    var pad = function (k) { return (k + ':').padEnd(21); };
    var sub = function (k) { return '  ' + (k + ':').padEnd(19); };
    var lines = [
      pad('Goal') + g.title,
      pad('Source') + g.source.name + (g.source.mode === 'mock' ? ' (demo)' : ''),
      pad('Target') + g.target.name + (g.target.mode === 'mock' ? ' (demo)' : ''),
      pad('Records') + g.record_types.join(' + ') + ' · ' + (g.scope.type === 'all' ? 'all records' : 'filtered'),
      pad('Field mapping') + (g.field_mapping.status === 'approved' ? 'approved v' + g.field_mapping.version : 'not approved (suggested)'),
      pad('Workspaces') + 'classified by ' + (g.workspace_mapping.department_field || 'department'),
      pad('Timezone') + tz,
      ''
    ];
    goal.waves.forEach(function (w, i) {
      var when = w.schedule.type === 'at' ? fmt(w.schedule.at, tz) : w.schedule.type === 'immediate' ? 'immediately' :
        'after ' + w.depends_on.map(function (d) { return waveName(d.wave_id); }).join(', ') + ' validation' + (w.schedule.estimated_at ? ' (est. ' + fmt(w.schedule.estimated_at, tz) + ')' : '');
      lines.push(pad('Wave ' + (i + 1)) + w.name + ' → ' + g.target.name + ' / ' + (w.workspace ? w.workspace.name : 'all workspaces'));
      lines.push(sub('Schedule') + when);
      lines.push(sub('Window') + (g.migration_window.duration_minutes / 60) + ' h' + (w.window && w.window.start ? ' (' + fmtTime(w.window.start, tz) + ' – ' + fmtTime(w.window.end, tz) + ')' : ''));
      lines.push(sub('Dependency') + (w.depends_on.length ? w.depends_on.map(function (d) { return waveName(d.wave_id) + ' (success criteria met)'; }).join(', ') : 'none'));
      if (w.record_estimate) lines.push(sub('Records') + w.record_estimate.tickets + ' tickets' + (w.record_estimate.employees != null ? ', ' + w.record_estimate.employees + ' employees' : ''));
      lines.push(sub('Status') + w.status);
    });
    var c = g.success_criteria;
    var p = g.failure_policy;
    lines.push('',
      pad('Success threshold') + Math.round(c.min_success_rate * 100) + '%',
      pad('Critical errors') + c.max_critical_errors,
      pad('Required fields') + (c.required_fields_populated ? 'must be populated' : 'not checked'),
      pad('Reconciliation') + (c.reconciliation_complete ? 'required' : 'not required'),
      pad('On success') + POLICY_LABELS[p.on_success],
      pad('On partial failure') + POLICY_LABELS[p.on_partial_failure],
      pad('If unresolved') + POLICY_LABELS[p.on_unresolved],
      pad('On critical failure') + POLICY_LABELS[p.on_critical_failure],
      pad('Pause below') + (p.pause_below_success_rate != null ? Math.round(p.pause_below_success_rate * 100) + '% success' : 'off'),
      pad('Window overrun') + OVERRUN_LABELS[g.migration_window.on_overrun],
      pad('Blackout') + (g.blackout_periods.length ? g.blackout_periods.map(function (b) {
        return b.label + ' ' + b.days.join(',') + ' ' + b.start + '–' + b.end;
      }).join('; ') : 'none'),
      pad('Status') + goal.status + (goal.approved_at ? ' (approved ' + fmt(goal.approved_at, tz) + ')' : ' (not approved)')
    );
    $('configText').textContent = lines.join('\n');
    $('configJson').textContent = JSON.stringify(goal, null, 2);
    $('configText').hidden = showJson;
    $('configJson').hidden = !showJson;
    $('toggleJson').textContent = showJson ? 'Show summary' : 'Show JSON';
  }

  /* ---------- wire up ---------- */
  EXAMPLES.forEach(function (ex) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = ex.label;
    b.addEventListener('click', function () { $('goalText').value = ex.text; $('goalText').focus(); });
    $('examples').appendChild(b);
  });
  $('planBtn').addEventListener('click', plan);
  $('goalText').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) plan(); });
  $('saveBtn').addEventListener('click', function () { save().catch(function () {}); });
  $('approveBtn').addEventListener('click', approve);
  $('runBtn').addEventListener('click', function () {
    var msg = goal.approved_at
      ? 'Run this migration now instead of waiting for the schedule?'
      : 'Approve this plan and run the migration now?';
    if (window.confirm(msg)) startRun(false);
  });
  $('precheckAllBtn').addEventListener('click', function () { precheck(null); });
  $('deleteBtn').addEventListener('click', removeGoal);
  var resetBtn = $('resetDemo');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    if (!window.confirm('Reset demo data? This empties the simulated Freshservice so the next demo run starts fresh (108 failures → 88 auto-fixed → 20 human review with the standard 750-record demo data). Saved goals are kept.')) return;
    api('POST', '/api/demo/reset', { target: 'freshservice' })
      .then(function (res) { showAlert('Demo data reset — cleared ' + res.cleared.toLocaleString() + ' simulated Freshservice ticket(s). Plan and run a goal to start the demo.'); })
      .catch(function (err) { showAlert('Could not reset: ' + esc(err.message)); });
  });
  $('addWaveBtn').addEventListener('click', function () {
    var id = $('addWaveWs').value;
    var ws = (draft.workspace_mapping.workspaces || []).filter(function (x) { return String(x.id) === id; })[0];
    if (ws) withSaved(function () { addWave(ws); });
  });
  $('addBlackout').addEventListener('click', function () {
    draft.blackout_periods.push({ label: 'Business hours', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00' });
    setDirty(true); render();
  });
  $('toggleJson').addEventListener('click', function () { showJson = !showJson; renderConfig(draft.schedule.timezone); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  $('tzNote').textContent = 'Times in ' + browserTz;
  var params = new URLSearchParams(location.search);
  loadGoals(params.get('goal'));
})();
