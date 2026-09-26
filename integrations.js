/* Zen Integrations — Source → Zen → Target. Talks to /api/integrations and
   /api/migration (functions/migration). Connection choices persist in
   localStorage; the backend verifies each connection through its adapter. */
(function () {
  'use strict';

  var STORE_KEY = 'zen.integrations.v1';
  var ICONS = { jira: ['JS', 'js'], 'legacy-itsm': ['LI', 'li'], 'mock-legacy': ['ML', 'ml'], freshservice: ['FS', 'fs'] };

  var state = load();
  var catalog = { sources: [], targets: [] };

  var $ = function (id) { return document.getElementById(id); };
  var alertBox = $('intAlert');

  /* ---------- helpers ---------- */
  function load() {
    var fallback = { connected: {}, source: 'jira', target: 'freshservice', demo: { count: 750, seed: 42 } };
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY));
      return s && s.connected ? s : fallback;
    } catch (e) { return fallback; }
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok && !data.message) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function demoQuery() {
    return 'count=' + encodeURIComponent(state.demo.count) + '&seed=' + encodeURIComponent(state.demo.seed);
  }

  function showAlert(html) { alertBox.innerHTML = html; alertBox.hidden = false; }
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }

  /* ---------- render: integration cards ---------- */
  function card(item, selected) {
    var icon = ICONS[item.id] || [item.name.slice(0, 2).toUpperCase(), ''];
    var on = !!state.connected[item.id];
    var el = document.createElement('article');
    el.className = 'fa-card' + (selected ? ' is-selected' : '');
    el.innerHTML =
      '<div class="fa-card-top"><span class="fa-icon ' + icon[1] + '">' + icon[0] + '</span><b>' + esc(item.name) + '</b>' +
      '<span class="int-mode' + (item.mode === 'live' ? ' live' : '') + '">' + (item.mode === 'live' ? 'Live API' : 'Demo') + '</span></div>' +
      '<p>' + esc(item.description) + '</p>' +
      '<div class="int-card-foot"><span class="int-status' + (on ? ' on' : '') + '">' + (on ? 'Connected' : 'Disconnected') + '</span>' +
      '<button class="fa-connect' + (on ? ' is-connected' : '') + '">' + (on ? 'Disconnect' : 'Connect') + '</button></div>';

    el.addEventListener('click', function () {
      state[item.role] = item.id;
      save();
      render();
    });
    el.querySelector('.fa-connect').addEventListener('click', function (e) {
      e.stopPropagation();
      state[item.role] = item.id;
      if (on) {
        delete state.connected[item.id];
        save();
        render();
      } else {
        connect(item, e.currentTarget);
      }
    });
    return el;
  }

  function connect(item, btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    var q = item.role === 'source' ? '?' + demoQuery() : '';
    api('/api/integrations/' + encodeURIComponent(item.id) + '/connect' + q, { method: 'POST' })
      .then(function (res) {
        if (res.connected) state.connected[item.id] = true;
        else showAlert('Could not connect to <b>' + esc(item.name) + '</b>: ' + esc(res.message));
        save();
        render();
      })
      .catch(function (err) {
        showAlert('Could not connect to <b>' + esc(item.name) + '</b>: ' + esc(err.message));
        render();
      });
  }

  function renderLists() {
    var sl = $('sourceList'), tl = $('targetList');
    sl.innerHTML = ''; tl.innerHTML = '';
    catalog.sources.forEach(function (s) { sl.appendChild(card(s, s.id === state.source)); });
    catalog.targets.forEach(function (t) { tl.appendChild(card(t, t.id === state.target)); });
    var count = function (list) {
      return list.filter(function (x) { return state.connected[x.id]; }).length + ' of ' + list.length + ' connected';
    };
    $('sourceCount').textContent = count(catalog.sources);
    $('targetCount').textContent = count(catalog.targets);
  }

  /* ---------- render: Zen pipeline ---------- */
  var pipelineReq = 0;

  function renderZen() {
    var src = byId(catalog.sources, state.source);
    var tgt = byId(catalog.targets, state.target);
    var srcOn = src && state.connected[src.id];
    var tgtOn = tgt && state.connected[tgt.id];

    $('zenSource').textContent = src ? src.name : 'Source';
    $('zenSource').className = srcOn ? '' : 'dim';
    $('zenTarget').textContent = tgt ? tgt.name : 'Target';
    $('zenTarget').className = tgtOn ? '' : 'dim';

    if (!(srcOn && tgtOn)) {
      $('zenState').textContent = 'Not ready';
      $('zenState').className = 'int-badge';
      $('zenNote').textContent = !srcOn && !tgtOn
        ? 'Connect a source and a target to open the pipeline.'
        : (!srcOn ? 'Connect ' + (src ? src.name : 'a source') + ' to continue.' : 'Connect ' + (tgt ? tgt.name : 'a target') + ' to continue.');
      $('zenRecords').textContent = '—';
      $('zenFields').textContent = '—';
      $('zenTargetFields').textContent = '—';
      $('zenModel').innerHTML = '';
      $('zenLinks').hidden = true;
      return;
    }

    var req = ++pipelineReq;
    $('zenNote').textContent = 'Checking both ends of the pipeline…';
    api('/api/migration/pipeline?source=' + encodeURIComponent(src.id) + '&target=' + encodeURIComponent(tgt.id) + '&' + demoQuery())
      .then(function (p) {
        if (req !== pipelineReq) return;
        $('zenState').textContent = p.ready ? 'Pipeline ready' : 'Check connections';
        $('zenState').className = 'int-badge' + (p.ready ? ' ok' : '');
        $('zenNote').textContent = p.ready
          ? 'Zen can read ' + p.source.name + ' and reach ' + p.target.name + '. Field mapping and the migration run come next.'
          : (p.source.connection.ok ? p.target.connection.message : p.source.connection.message);
        $('zenRecords').textContent = p.source.recordCount == null ? '?' : Number(p.source.recordCount).toLocaleString();
        $('zenFields').textContent = p.zen.recordModel.length;
        $('zenTargetFields').textContent = p.target.schema.length;
        $('zenModel').innerHTML = p.zen.recordModel.map(function (f) { return '<span>' + esc(f.label) + '</span>'; }).join('');
        $('zenLinks').hidden = !p.ready;
      })
      .catch(function (err) {
        if (req !== pipelineReq) return;
        $('zenState').textContent = 'Error';
        $('zenState').className = 'int-badge';
        $('zenNote').textContent = 'Pipeline check failed: ' + err.message;
      });
  }

  /* ---------- demo data ---------- */
  var previewSource = null;

  function renderDemoControls() {
    var src = byId(catalog.sources, state.source);
    var on = src && state.connected[src.id];
    var isMock = src && src.mode === 'mock';
    $('demoSourceName').textContent = src ? 'Source: ' + src.name : '';
    $('demoGenerate').disabled = !on;
    $('demoShuffle').disabled = !on || !isMock;
    $('demoCount').disabled = !isMock;
    $('demoSeed').disabled = !isMock;
    $('demoCount').value = state.demo.count;
    $('demoSeed').value = state.demo.seed;
    if (!on || state.source !== previewSource) $('demoTable').hidden = true;
    if (!on) $('demoStatus').textContent = 'Connect ' + (src ? src.name : 'a source') + ' to generate records.';
    else if (!isMock) $('demoStatus').textContent = src.name + ' is using its live API. Preview shows real records.';
    else $('demoStatus').textContent = '';
  }

  function readDemoInputs() {
    var count = parseInt($('demoCount').value, 10);
    var seed = parseInt($('demoSeed').value, 10);
    state.demo.count = Math.min(Math.max(isFinite(count) ? count : 750, 1), 5000);
    state.demo.seed = isFinite(seed) ? seed : 42;
    save();
  }

  function generate() {
    var src = byId(catalog.sources, state.source);
    if (!src || !state.connected[src.id]) return;
    readDemoInputs();
    $('demoStatus').textContent = 'Generating…';
    api('/api/integrations/' + encodeURIComponent(src.id) + '/records?limit=10&' + demoQuery())
      .then(function (res) {
        var total = res.total == null ? 'unknown number of' : Number(res.total).toLocaleString();
        $('demoStatus').innerHTML = '<b>' + total + '</b> records available from ' + esc(res.source.name) +
          ' (seed ' + esc(state.demo.seed) + '). Showing the first ' + res.records.length + '.';
        var tbody = $('demoTable').querySelector('tbody');
        tbody.innerHTML = res.records.map(function (r) {
          return '<tr><td>' + esc(r.employeeId) + '</td><td>' + esc(r.employeeName) + '</td><td>' + esc(r.email) +
            '</td><td>' + esc(r.department) + '</td><td>' + esc(r.ticketId) + '</td><td>' + esc(r.ticketType) +
            '</td><td>' + esc(r.priority) + '</td><td class="desc">' + esc(r.description) + '</td><td><em>' + esc(r.status) +
            '</em></td><td>' + esc(r.createdDate ? r.createdDate.slice(0, 10) : '') + '</td></tr>';
        }).join('');
        $('demoTable').hidden = false;
        previewSource = src.id;
        renderZen();
      })
      .catch(function (err) { $('demoStatus').textContent = 'Could not generate records: ' + err.message; });
  }

  $('demoGenerate').addEventListener('click', generate);
  $('demoShuffle').addEventListener('click', function () {
    $('demoSeed').value = Math.floor(Math.random() * 100000);
    generate();
  });

  /* ---------- boot ---------- */
  function render() {
    renderLists();
    renderZen();
    renderDemoControls();
  }

  api('/api/integrations')
    .then(function (data) {
      // only Jira Service Management is offered as a source here (legacy/mock adapters stay available to the API)
      catalog.sources = (data.sources || []).filter(function (s) { return s.id === 'jira'; }).map(function (s) { s.role = 'source'; return s; });
      catalog.targets = (data.targets || []).map(function (t) { t.role = 'target'; return t; });
      if (!byId(catalog.sources, state.source) && catalog.sources[0]) state.source = catalog.sources[0].id;
      if (!byId(catalog.targets, state.target) && catalog.targets[0]) state.target = catalog.targets[0].id;
      render();
    })
    .catch(function () {
      showAlert('Zen\'s integration service isn\'t reachable. Run it locally with ' +
        '<code>npx firebase-tools@latest emulators:start --only hosting,functions</code> and reload.');
    });
})();
