/* Zen Field mapping — AI-suggested source → target field mapping, workspace
   classification and a record walkthrough. Talks to /api/mapping
   (functions/migration). Shares connection state with the Integrations page. */
(function () {
  'use strict';

  var STORE_KEY = 'zen.integrations.v1';

  var conn = loadConn();
  var catalog = { sources: [], targets: [] };
  var page = {
    rows: [],            // field decisions
    targetFields: [],
    workspaces: [],
    workspaceRules: {},  // department value → workspace id (overrides)
    departments: [],
    saved: null,
    aiUsed: false,
    aiError: null,
    aiAvailable: false,
    reused: 0,
    index: 0,
    total: 0,
    dirty: false
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- helpers ---------- */
  function loadConn() {
    var fallback = { connected: {}, source: 'jira', target: 'freshservice', demo: { count: 750, seed: 42 } };
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && s.connected ? s : fallback;
    } catch (e) { return fallback; }
  }
  function saveConn() { localStorage.setItem(STORE_KEY, JSON.stringify(conn)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function demoQuery() {
    return 'count=' + encodeURIComponent(conn.demo.count) + '&seed=' + encodeURIComponent(conn.demo.seed);
  }

  function api(method, path, body) {
    var sep = path.indexOf('?') > -1 ? '&' : '?';
    return fetch(path + sep + demoQuery(), {
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

  function pair() { return { source: conn.source, target: conn.target }; }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function targetLabel(key) {
    var f = page.targetFields.filter(function (t) { return t.key === key; })[0];
    return f ? f.label : key;
  }
  function wsName(id) {
    var w = page.workspaces.filter(function (x) { return String(x.id) === String(id); })[0];
    return w ? w.name : '—';
  }

  function showAlert(html) { $('mapAlert').innerHTML = html; $('mapAlert').hidden = false; }
  function hideAlert() { $('mapAlert').hidden = true; }
  function showWork(visible) {
    ['mapBar', 'fieldsCard', 'lowerGrid'].forEach(function (id) { $(id).hidden = !visible; });
  }

  function timeAgo(iso) {
    var d = new Date(iso);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- decisions ---------- */
  function decide(row, decision) {
    row.decision = decision;
    page.dirty = true;
    renderAll();
    schedulePreview();
  }

  function setTarget(row, key) {
    row.targetField = key || null;
    if (!row.targetField) row.decision = 'rejected';
    else row.decision = row.targetField === row.suggestedTarget ? 'accepted' : 'modified';
    page.dirty = true;
    renderAll();
    schedulePreview();
  }

  function activeFields() {
    return page.rows
      .filter(function (r) { return r.targetField && r.decision !== 'rejected'; })
      .map(function (r) { return { sourceField: r.sourceField, targetField: r.targetField }; });
  }

  /* ---------- render: status bar ---------- */
  function renderBar() {
    var counts = { pending: 0, accepted: 0, modified: 0, rejected: 0 };
    page.rows.forEach(function (r) { counts[r.decision] = (counts[r.decision] || 0) + 1; });
    var badge = $('mapBadge');
    var summary;

    if (page.saved && page.reused && !page.dirty) {
      badge.textContent = 'Saved mapping v' + page.saved.version;
      badge.className = 'int-badge ok';
      summary = 'Reusing the mapping approved ' + timeAgo(page.saved.approvedAt) + ' for ' + page.reused + ' fields.';
      if (page.rows.length > page.reused) summary += ' Zen suggested ' + (page.rows.length - page.reused) + ' new field(s).';
    } else if (page.dirty) {
      badge.textContent = 'Unsaved changes';
      badge.className = 'int-badge warn';
      summary = counts.accepted + ' accepted · ' + counts.modified + ' modified · ' + counts.rejected + ' rejected · ' + counts.pending + ' to review';
    } else {
      badge.textContent = page.aiUsed ? 'AI suggestions' : 'Suggestions';
      badge.className = 'int-badge' + (page.aiUsed ? ' ai' : '');
      summary = 'Zen suggested ' + page.rows.filter(function (r) { return r.suggestedTarget; }).length + ' of ' + page.rows.length +
        ' mappings' + (page.aiUsed ? ' using Claude' : ' from field names and sample values') + '. Accept, change or reject each one.';
      if (page.aiError) summary += ' (AI unavailable: using built-in matching.)';
    }
    $('mapSummary').textContent = summary;
    $('forget').hidden = !page.saved;
    $('fieldCount').textContent = page.rows.length + ' source fields';
  }

  /* ---------- render: field table ---------- */
  function usedTargets(except) {
    var used = {};
    page.rows.forEach(function (r) {
      if (r !== except && r.targetField && r.decision !== 'rejected') used[r.targetField] = true;
    });
    return used;
  }

  function renderRows() {
    var tbody = $('fieldRows');
    tbody.innerHTML = '';
    page.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      if (row.decision === 'rejected') tr.className = 'is-rejected';
      var used = usedTargets(row);
      var samples = (row.samples || []).filter(function (v) { return v !== '' && v != null; }).slice(0, 3);

      var options = '<option value="">— No target (skip) —</option>' + page.targetFields.map(function (t) {
        var taken = used[t.key] && t.key !== row.targetField;
        return '<option value="' + esc(t.key) + '"' + (t.key === row.targetField ? ' selected' : '') + (taken ? ' disabled' : '') + '>' +
          esc(t.label) + (taken ? ' (in use)' : '') + '</option>';
      }).join('');

      var conf = Math.round((row.confidence || 0) * 100);
      var confClass = conf >= 80 ? '' : (conf >= 50 ? 'mid' : 'low');
      var method = row.method === 'ai' ? 'AI' : (row.method === 'saved' ? 'Saved' : 'Heuristic');
      var suggestion = row.suggestedTarget
        ? '<div class="map-conf"><span class="bar"><i class="' + confClass + '" style="width:' + conf + '%"></i></span>' + conf + '% → ' +
          esc(targetLabel(row.suggestedTarget)) + ' <span class="map-method ' + esc(row.method) + '">' + method + '</span></div>'
        : '<div class="map-conf">No match <span class="map-method ' + esc(row.method) + '">' + method + '</span></div>';

      tr.innerHTML =
        '<td><code>' + esc(row.sourceField) + '</code><span class="map-samples" title="' + esc(samples.join(' · ')) + '">' + esc(samples.join(' · ') || 'no sample values') + '</span></td>' +
        '<td class="map-arrow">→</td>' +
        '<td><select aria-label="Target for ' + esc(row.sourceField) + '">' + options + '</select></td>' +
        '<td class="map-sugg">' + suggestion + '<div class="map-reason">' + esc(row.reason) + '</div></td>' +
        '<td><em class="' + esc(row.decision) + '">' + esc(row.decision === 'pending' ? 'To review' : row.decision.charAt(0).toUpperCase() + row.decision.slice(1)) + '</em></td>' +
        '<td><div class="map-actions">' +
          '<button class="mini" data-act="accept"' + (row.targetField ? '' : ' disabled') + ' title="Accept">✓ Accept</button>' +
          '<button class="mini ghost" data-act="reject" title="Reject">✕</button>' +
        '</div></td>';

      tr.querySelector('select').addEventListener('change', function (e) { setTarget(row, e.target.value); });
      tr.querySelector('[data-act="accept"]').addEventListener('click', function () {
        decide(row, row.targetField === row.suggestedTarget ? 'accepted' : 'modified');
      });
      tr.querySelector('[data-act="reject"]').addEventListener('click', function () {
        decide(row, row.decision === 'rejected' ? 'pending' : 'rejected');
      });
      tbody.appendChild(tr);
    });
  }

  /* ---------- render: workspace classification ---------- */
  function renderDepartments(preview) {
    $('deptFieldNote').textContent = preview.departmentField
      ? 'from source field ' + preview.departmentField
      : 'map a field to Department to classify';

    var max = Math.max.apply(null, preview.distribution.map(function (d) { return d.count; }).concat(1));
    $('distribution').innerHTML = preview.distribution.map(function (d) {
      return '<div class="map-dist-row"><span>' + esc(d.name) + '</span><div class="fbar"><i style="width:' +
        Math.round((d.count / max) * 100) + '%"></i></div><b>' + d.count.toLocaleString() + '</b></div>';
    }).join('');

    var tbody = $('deptRows');
    tbody.innerHTML = '';
    preview.departments.forEach(function (d) {
      var tr = document.createElement('tr');
      var ruleLabel = { override: 'Override', rule: 'Rule', 'default': 'Default', none: '' }[d.rule] || '';
      var ruleClass = { override: 'modified', rule: 'ok', 'default': 'warn' }[d.rule] || '';
      tr.innerHTML =
        '<td><b>' + esc(d.value || '(blank)') + '</b></td>' +
        '<td>' + d.count.toLocaleString() + '</td>' +
        '<td><select aria-label="Workspace for ' + esc(d.value) + '">' + page.workspaces.map(function (w) {
          return '<option value="' + esc(w.id) + '"' + (String(w.id) === String(d.workspaceId) ? ' selected' : '') + '>' + esc(w.name) + '</option>';
        }).join('') + '</select></td>' +
        '<td class="map-rule"><em class="' + ruleClass + '">' + ruleLabel + '</em>' + esc(d.reason) + '</td>';
      tr.querySelector('select').addEventListener('change', function (e) {
        if (String(e.target.value) === String(d.suggested)) delete page.workspaceRules[d.value];
        else page.workspaceRules[d.value] = e.target.value;
        page.dirty = true;
        renderBar();
        schedulePreview();
      });
      tbody.appendChild(tr);
    });
  }

  /* ---------- render: record walkthrough ---------- */
  function kv(obj, derivedKeys) {
    return '<dl class="kv">' + Object.keys(obj).map(function (k) {
      var derived = derivedKeys && derivedKeys[k];
      return '<dt>' + esc(k) + '</dt><dd' + (derived ? ' class="derived"' : '') + '>' + esc(obj[k] === '' ? '(empty)' : obj[k]) +
        (derived ? ' · ' + esc(derived) : '') + '</dd>';
    }).join('') + '</dl>';
  }

  function renderWalk(preview) {
    page.total = preview.total || 0;
    $('recPos').textContent = page.total ? 'Record ' + (page.index + 1).toLocaleString() + ' of ' + page.total.toLocaleString() : '—';
    $('prevRec').disabled = page.index <= 0;
    $('nextRec').disabled = page.index >= page.total - 1;

    var rec = preview.records[0];
    if (!rec) { $('walk').innerHTML = '<p class="int-note">No record at this position.</p>'; return; }
    var src = byId(catalog.sources, conn.source);
    var tgt = byId(catalog.targets, conn.target);

    var mappedKeys = {};
    rec.mapped.forEach(function (m) { mappedKeys[m.targetField] = true; });
    var derived = {};
    Object.keys(rec.target).forEach(function (k) {
      if (!mappedKeys[k]) derived[k] = k === 'workspace_id' ? 'from workspace classification' : 'derived by Zen';
    });

    var ws = rec.workspace;
    $('walk').innerHTML =
      '<div class="walk-step"><h3>Source record · ' + esc(src ? src.name : conn.source) + '</h3>' + kv(rec.source) + '</div>' +
      '<div class="walk-down">↓</div>' +
      '<div class="walk-step"><h3>Mapped fields · ' + rec.mapped.length + ' active</h3><div class="walk-map">' +
        (rec.mapped.length ? rec.mapped.map(function (m) {
          return '<code>' + esc(m.sourceField) + '</code><i>→</i><b>' + esc(m.targetLabel) + '</b><span>' + esc(m.value) + '</span>';
        }).join('') : '<span>No active mappings yet.</span>') +
      '</div></div>' +
      '<div class="walk-down">↓</div>' +
      '<div class="walk-step"><h3>Target fields · ' + esc(tgt ? tgt.name : conn.target) + ' payload</h3>' + kv(rec.target, derived) + '</div>' +
      '<div class="walk-down">↓</div>' +
      '<div class="walk-step ws"><h3>Target workspace</h3>' +
        (ws.departmentField
          ? '<div class="walk-ws">Department = ' + esc(ws.department || '(blank)') + ' <i>→</i> <b>' + esc(tgt ? tgt.name : 'Target') + ' Workspace = ' + esc(ws.workspaceName) + '</b></div>' +
            '<p class="int-note">' + esc(ws.reason) + '</p>'
          : '<p class="int-note">Map a source field to <b>Department</b> so Zen can classify the workspace.</p>') +
      '</div>';
  }

  function renderAll() {
    renderBar();
    renderRows();
  }

  /* ---------- preview (debounced, latest wins) ---------- */
  var previewTimer = null;
  var previewSeq = 0;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 200);
  }

  function runPreview() {
    var seq = ++previewSeq;
    var body = pair();
    body.fields = page.rows.map(function (r) {
      return { sourceField: r.sourceField, targetField: r.targetField, decision: r.decision };
    });
    body.workspaceRules = page.workspaceRules;
    body.index = page.index;
    api('POST', '/api/mapping/preview', body)
      .then(function (p) {
        if (seq !== previewSeq) return;
        page.workspaces = p.workspaces;
        renderDepartments(p);
        renderWalk(p);
      })
      .catch(function (err) {
        if (seq !== previewSeq) return;
        $('walk').innerHTML = '<p class="int-note">Preview failed: ' + esc(err.message) + '</p>';
      });
  }

  /* ---------- load / suggest ---------- */
  function suggest(force) {
    hideAlert();
    showWork(false);
    showAlert('Zen is analysing the <b>' + esc((byId(catalog.sources, conn.source) || {}).name || conn.source) +
      '</b> fields and sample values…');
    var body = pair();
    body.force = !!force;
    api('POST', '/api/mapping/suggest', body)
      .then(function (res) {
        hideAlert();
        page.rows = res.rows;
        page.targetFields = res.targetFields;
        page.workspaces = res.workspaces;
        page.saved = res.saved;
        page.reused = res.reused;
        page.aiUsed = res.aiUsed;
        page.aiError = res.aiError;
        page.aiAvailable = res.aiAvailable;
        page.workspaceRules = force || !res.saved ? {} : Object.assign({}, res.saved.workspaceRules);
        page.index = 0;
        page.dirty = false;
        showWork(true);
        renderAll();
        runPreview();
      })
      .catch(function (err) {
        showAlert('Could not load suggestions: ' + esc(err.message) +
          '. Is the Zen integration service running? (<code>npx firebase-tools@latest emulators:start --only hosting,functions</code>)');
      });
  }

  function save() {
    var body = pair();
    body.fields = page.rows;
    body.workspaceRules = page.workspaceRules;
    $('save').disabled = true;
    api('PUT', '/api/mapping', body)
      .then(function (res) {
        page.saved = { version: res.saved.version, approvedAt: res.saved.approvedAt, workspaceRules: res.saved.workspaceRules };
        page.reused = res.saved.fields.length;
        page.rows.forEach(function (r) { if (r.decision !== 'pending') r.method = 'saved'; });
        page.dirty = false;
        renderAll();
        if (res.pendingSkipped) {
          showAlert(res.pendingSkipped + ' field(s) still to review were not saved; Zen will suggest them again next time.');
        } else {
          hideAlert();
        }
      })
      .catch(function (err) { showAlert('Save failed: ' + esc(err.message)); })
      .then(function () { $('save').disabled = false; });
  }

  function forget() {
    api('DELETE', '/api/mapping?source=' + encodeURIComponent(conn.source) + '&target=' + encodeURIComponent(conn.target))
      .then(function () { suggest(true); })
      .catch(function (err) { showAlert('Could not forget mapping: ' + esc(err.message)); });
  }

  /* ---------- pair selection ---------- */
  function renderPairSelects() {
    $('sourceSelect').innerHTML = catalog.sources.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === conn.source ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    $('targetSelect').innerHTML = catalog.targets.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === conn.target ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('');
  }

  function start() {
    var src = byId(catalog.sources, conn.source);
    var tgt = byId(catalog.targets, conn.target);
    var missing = [src, tgt].filter(function (x) { return x && !conn.connected[x.id]; });
    if (missing.length) {
      showWork(false);
      showAlert('Connect <b>' + missing.map(function (x) { return esc(x.name); }).join('</b> and <b>') +
        '</b> on the <a href="integrations.html"><b>Integrations</b></a> page first.');
      return;
    }
    suggest(false);
  }

  function changePair() {
    if (page.dirty && !window.confirm('Discard unsaved mapping changes?')) {
      renderPairSelects();
      return;
    }
    conn.source = $('sourceSelect').value;
    conn.target = $('targetSelect').value;
    saveConn();
    start();
  }

  /* ---------- wire up ---------- */
  $('sourceSelect').addEventListener('change', changePair);
  $('targetSelect').addEventListener('change', changePair);
  $('save').addEventListener('click', save);
  $('rerun').addEventListener('click', function () {
    if (page.dirty && !window.confirm('Discard unsaved changes and ask Zen again?')) return;
    suggest(true);
  });
  $('forget').addEventListener('click', function () {
    if (window.confirm('Forget the saved mapping for this source and target?')) forget();
  });
  // Record walkthrough accordion (collapsed by default to keep the page short)
  $('walkToggle').addEventListener('click', function () {
    var open = $('walkToggle').getAttribute('aria-expanded') !== 'true';
    $('walkToggle').setAttribute('aria-expanded', String(open));
    $('walkBody').hidden = !open;
    $('walkNav').hidden = !open;
    $('walkHint').hidden = open;
    $('walkCard').classList.toggle('is-open', open);
  });
  $('prevRec').addEventListener('click', function () { if (page.index > 0) { page.index--; runPreview(); } });
  $('nextRec').addEventListener('click', function () { if (page.index < page.total - 1) { page.index++; runPreview(); } });
  window.addEventListener('beforeunload', function (e) {
    if (page.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  fetch('/api/integrations')
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (data) {
      catalog.sources = data.sources || [];
      catalog.targets = data.targets || [];
      if (!byId(catalog.sources, conn.source) && catalog.sources[0]) conn.source = catalog.sources[0].id;
      if (!byId(catalog.targets, conn.target) && catalog.targets[0]) conn.target = catalog.targets[0].id;
      renderPairSelects();
      start();
    })
    .catch(function () {
      showAlert('Zen\'s integration service isn\'t reachable. Run it locally with ' +
        '<code>npx firebase-tools@latest emulators:start --only hosting,functions</code> and reload.');
    });
})();
