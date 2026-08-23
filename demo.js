/* Zen live-session demo — fully scripted, no backend. */
(function () {
  'use strict';

  var spotlight = document.getElementById('spotlight');
  var coach = document.getElementById('coach');
  var coachText = document.getElementById('coachText');
  var body = document.getElementById('zpBody');
  var input = document.getElementById('zpInput');
  var send = document.getElementById('zpSend');
  var planItems = document.querySelectorAll('#planList li');
  var setupBar = document.getElementById('setupBar');
  var setupPct = document.getElementById('setupPct');
  var oauth = document.getElementById('oauth');
  var mapping = document.getElementById('mappingPanel');
  var doneCard = document.getElementById('doneCard');

  var step = 0;

  /* ---------- helpers ---------- */
  function el(cls, html) {
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    return d;
  }
  function scroll() { body.scrollTop = body.scrollHeight; }

  function typing(ms, then) {
    var t = el('typing', '<i></i><i></i><i></i>');
    body.appendChild(t); scroll();
    setTimeout(function () { t.remove(); then(); }, ms);
  }
  function say(html, delay, then) {
    typing(delay || 850, function () {
      body.appendChild(el('bubble bot', html));
      scroll();
      if (then) then();
    });
  }
  function user(text) {
    body.appendChild(el('bubble user', text));
    scroll();
  }
  function choices(list, delay) {
    setTimeout(function () {
      list.forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'zc-choice';
        b.textContent = c.label;
        b.addEventListener('click', function () {
          clearChoices();
          user(c.label);
          c.run();
        });
        body.appendChild(b);
      });
      scroll();
    }, delay || 1400);
  }
  function clearChoices() {
    body.querySelectorAll('.zc-choice').forEach(function (b) { b.remove(); });
  }

  /* ---------- spotlight ---------- */
  function highlight(selector, text, placement) {
    var target = document.querySelector(selector);
    if (!target) { hideSpot(); return; }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () {
      var r = target.getBoundingClientRect();
      spotlight.hidden = false;
      spotlight.style.left = (r.left - 6) + 'px';
      spotlight.style.top = (r.top - 6) + 'px';
      spotlight.style.width = (r.width + 12) + 'px';
      spotlight.style.height = (r.height + 12) + 'px';

      coach.hidden = false;
      coachText.innerHTML = text;
      var top = placement === 'above' ? r.top - coach.offsetHeight - 18 : r.bottom + 16;
      var left = Math.min(Math.max(r.left, 16), window.innerWidth - 400);
      coach.style.top = top + 'px';
      coach.style.left = left + 'px';
    }, 260);
  }
  function hideSpot() { spotlight.hidden = true; coach.hidden = true; }
  window.addEventListener('resize', hideSpot);

  /* ---------- plan + progress ---------- */
  function setPlan(n) {
    planItems.forEach(function (li, i) {
      li.classList.toggle('done', i < n);
      li.classList.toggle('current', i === n);
      li.querySelector('.tick').className = i < n ? 'tick' : 'tick idle';
      li.querySelector('.tick').textContent = i < n ? '✓' : '';
    });
    var pct = Math.round((n / planItems.length) * 100);
    setupBar.style.width = Math.max(pct, 8) + '%';
    setupPct.textContent = n + ' of ' + planItems.length + ' steps';
  }

  /* ---------- session timer ---------- */
  var seconds = 0;
  setInterval(function () {
    seconds++;
    var m = String(Math.floor(seconds / 60)).padStart(2, '0');
    var s = String(seconds % 60).padStart(2, '0');
    document.getElementById('zpTimer').textContent = m + ':' + s;
  }, 1000);

  /* ---------- the scripted flow ---------- */
  function stepGoal() {
    setPlan(0);
    say('Hi John 👋 I\'m Zen. I can see your screen — you\'re on the Integrations page for <b>Northwind Group</b>.', 700);
    setTimeout(function () {
      say('What are you trying to get done today?', 700);
      choices([
        { label: 'Connect our accounting system', run: stepFindApp },
        { label: 'Set up SMS reminders', run: function () {
            say('Got it — Twilio is a two minute job. But your accounting sync unlocks billing, which is your bigger blocker. Want to do that first?', 900);
            choices([
              { label: 'Yes, accounting first', run: stepFindApp },
              { label: 'No, SMS please', run: stepFindApp }
            ], 1900);
          } },
        { label: 'Just exploring', run: function () {
            say('No problem. Most clinics start with accounting — shall I show you?', 800);
            choices([{ label: 'Sure, show me', run: stepFindApp }], 1700);
          } }
      ], 1700);
    }, 1700);
  }

  function stepFindApp() {
    setPlan(1);
    say('We use QuickBooks at 60% of clinics your size. I\'ll point it out — click <b>Connect</b> on the QuickBooks card.', 900, function () {
      highlight('[data-connect="quickbooks"]', 'Click <b>Connect</b> here. I\'ll wait — take your time.');
      step = 1;
    });
  }

  function stepAuthorise() {
    setPlan(2);
    hideSpot();
    oauth.hidden = false;
    say('This is QuickBooks\' own authorisation screen — Zenith never sees your password. Review the permissions and hit <b>Authorise</b>.', 900, function () {
      setTimeout(function () {
        highlight('#oauthAllow', 'Everything here is read plus invoice write. Safe to authorise.', 'above');
      }, 400);
    });
    step = 2;
  }

  function stepMapping() {
    setPlan(3);
    oauth.hidden = true;
    hideSpot();
    document.querySelector('[data-connect="quickbooks"]').textContent = 'Connected ✓';
    document.querySelector('[data-connect="quickbooks"]').classList.add('is-connected');
    mapping.hidden = false;
    say('Connected. 🎉 Now the part that usually goes wrong: mapping your accounts.', 800);
    setTimeout(function () {
      say('Consultations should go to <b>4000 · Services Income</b>, and since you\'re a health provider your tax code is <b>GST-FREE</b>, not GST 10%. I\'ve pre-filled both — check them and save.', 1000, function () {
        highlight('[data-action="finish"]', 'Confirm the two dropdowns above, then click <b>Save mapping &amp; finish</b>.', 'above');
      });
    }, 1800);
    step = 3;
  }

  function stepFinish() {
    setPlan(5);
    hideSpot();
    say('Running a test sync…', 600);
    setTimeout(function () {
      say('First sync completed — 128 invoices matched, 0 errors. You\'re fully set up. ✅', 900, function () {
        setTimeout(function () { doneCard.hidden = false; }, 900);
      });
    }, 2200);
    step = 4;
  }

  /* ---------- wire product interactions ---------- */
  document.querySelectorAll('[data-connect]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.getAttribute('data-connect') !== 'quickbooks') {
        say('That one\'s not part of today\'s plan — let\'s finish QuickBooks first, then I\'ll come back to it.', 700, function () {
          highlight('[data-connect="quickbooks"]', 'This one 👉 <b>Connect</b> QuickBooks.');
        });
        return;
      }
      if (btn.classList.contains('is-connected')) return;
      user('Clicked Connect');
      stepAuthorise();
    });
  });

  document.getElementById('oauthAllow').addEventListener('click', function () {
    user('Authorised');
    stepMapping();
  });
  document.getElementById('oauthCancel').addEventListener('click', function () {
    oauth.hidden = true;
    say('No worries — nothing was shared. Click <b>Connect</b> again when you\'re ready.', 800, function () {
      highlight('[data-connect="quickbooks"]', 'Ready when you are.');
    });
  });
  document.querySelector('[data-action="finish"]').addEventListener('click', function () {
    user('Saved the mapping');
    stepFinish();
  });

  document.querySelectorAll('.fa-nav').forEach(function (nav) {
    nav.addEventListener('click', function () {
      document.querySelectorAll('.fa-nav').forEach(function (n) { n.classList.remove('is-active'); });
      nav.classList.add('is-active');
      say('We\'re mid-way through the integration — I\'ll bring you back to <b>Integrations</b> so we don\'t lose progress.', 800, function () {
        document.querySelectorAll('.fa-nav').forEach(function (n) { n.classList.remove('is-active'); });
        document.querySelector('[data-step-target="nav-integrations"]').classList.add('is-active');
      });
    });
  });

  /* escalation */
  document.getElementById('escalateBtn').addEventListener('click', function () {
    user('I need a human');
    say('On it. I\'m handing you to <b>Tanya Goel</b>, your onboarding lead, with the full transcript and your 3 completed steps attached. She\'ll join in under 2 minutes.', 1000);
  });

  /* free text */
  function handleTyped() {
    var text = input.value.trim();
    if (!text) return;
    user(text.replace(/</g, '&lt;'));
    input.value = '';
    var t = text.toLowerCase();
    var reply = 'Good question. In production I\'d answer from your own help docs. For now, follow the highlighted step and I\'ll keep guiding you.';
    if (t.indexOf('tax') > -1 || t.indexOf('gst') > -1) reply = 'Health consultations in Australia are <b>GST-FREE</b>. Product sales still attract GST 10% — I\'ve split them for you.';
    else if (t.indexOf('safe') > -1 || t.indexOf('secur') > -1 || t.indexOf('password') > -1) reply = 'You authorise inside QuickBooks itself. Zenith receives a revocable token — never your password.';
    else if (t.indexOf('stuck') > -1 || t.indexOf('help') > -1) reply = 'No stress. Look for the purple highlight on screen — that\'s exactly where to click next.';
    else if (t.indexOf('human') > -1 || t.indexOf('person') > -1) reply = 'I can bring in Tanya, your onboarding lead, right now. Hit <b>Human</b> in the controls above.';
    else if (t.indexOf('xero') > -1) reply = 'Xero works the same way — once QuickBooks is done I can walk you through switching or adding it.';
    say(reply, 900);
  }
  send.addEventListener('click', handleTyped);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleTyped(); });

  /* restart */
  function restart() { window.location.reload(); }
  document.getElementById('restart').addEventListener('click', restart);
  document.getElementById('replay').addEventListener('click', restart);

  /* go */
  setPlan(0);
  setTimeout(stepGoal, 600);
})();
