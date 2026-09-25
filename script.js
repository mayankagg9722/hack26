/* Zen — prototype interactions. Free-text chat goes through /api/chat → Claude. */
(function () {
  'use strict';

  /* ---------- reveal on scroll ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  /* ---------- mobile menu ---------- */
  var burger = document.getElementById('burger');
  if (burger) {
    burger.addEventListener('click', function () {
      document.getElementById('mobileMenu').classList.toggle('is-open');
    });
  }

  /* ---------- accordions (linked to visual panels) ---------- */
  document.querySelectorAll('[data-accordion]').forEach(function (acc) {
    var items = acc.querySelectorAll('.acc-item');
    var visuals = acc.closest('.two-col')
      ? acc.closest('.two-col').querySelectorAll('.hv')
      : [];

    items.forEach(function (item) {
      item.querySelector('.acc-btn').addEventListener('click', function () {
        var wasOpen = item.classList.contains('is-open');
        var isFaq = acc.classList.contains('faq-acc');

        items.forEach(function (i) { i.classList.remove('is-open'); });
        if (!(isFaq && wasOpen)) item.classList.add('is-open');

        var idx = item.getAttribute('data-panel');
        visuals.forEach(function (v) {
          v.classList.toggle('is-active', v.getAttribute('data-visual') === idx);
        });
      });
    });
  });

  /* ---------- tabs ---------- */
  document.querySelectorAll('[data-tabs]').forEach(function (group) {
    var scope = group.parentElement;
    group.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var idx = tab.getAttribute('data-tab');
        group.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('is-active'); });
        tab.classList.add('is-active');
        scope.querySelectorAll('.tab-panel').forEach(function (p) {
          p.classList.toggle('is-active', p.getAttribute('data-tabpanel') === idx);
        });
      });
    });
  });

  /* ---------- case study carousel ---------- */
  var cases = Array.prototype.slice.call(document.querySelectorAll('.case'));
  if (cases.length) {
    var cur = 0;
    var show = function (n) {
      cur = (n + cases.length) % cases.length;
      cases.forEach(function (c, i) { c.classList.toggle('is-active', i === cur); });
    };
    var prev = document.querySelector('[data-case-prev]');
    var next = document.querySelector('[data-case-next]');
    if (prev) prev.addEventListener('click', function () { show(cur - 1); });
    if (next) next.addEventListener('click', function () { show(cur + 1); });
    setInterval(function () { show(cur + 1); }, 7000);
  }

  /* ---------- demo forms (fake submit) ---------- */
  document.querySelectorAll('[data-demo-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var note = form.querySelector('.form-note');
      var input = form.querySelector('input');
      var btn = form.querySelector('button');
      btn.textContent = 'Requested ✓';
      btn.disabled = true;
      input.value = '';
      if (note) note.hidden = false;
    });
  });

  /* ---------- count-up stats ---------- */
  var statObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      var target = parseInt(el.getAttribute('data-count'), 10);
      var suffix = el.getAttribute('data-suffix') || '';
      var start = performance.now();
      var dur = 1100;
      var step = function (now) {
        var p = Math.min((now - start) / dur, 1);
        var v = Math.floor(target * (1 - Math.pow(1 - p, 3)));
        el.textContent = v.toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      statObserver.unobserve(el);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-count]').forEach(function (el) { statObserver.observe(el); });

  /* "Guide me" jumps into the live product demo */
  var guideMe = document.getElementById('guideMe');
  if (guideMe) guideMe.addEventListener('click', function () { window.location.href = 'demo.html'; });

  /* ---------- floating Zen chat (scripted) ---------- */
  var launcher = document.getElementById('zenLauncher');
  var chat = document.getElementById('zenChat');
  var body = document.getElementById('zcBody');
  var input = document.getElementById('zcInput');
  var send = document.getElementById('zcSend');
  if (!launcher || !chat) return;

  var started = false;

  var el = function (cls, html) {
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    return d;
  };
  var scroll = function () { body.scrollTop = body.scrollHeight; };

  var typing = function (ms, then) {
    var t = el('typing', '<i></i><i></i><i></i>');
    body.appendChild(t); scroll();
    setTimeout(function () { t.remove(); then(); }, ms);
  };

  var say = function (html, delay) {
    typing(delay || 800, function () {
      body.appendChild(el('bubble bot', html));
      scroll();
    });
  };

  var choices = function (list, delay) {
    setTimeout(function () {
      list.forEach(function (c) {
        var b = el('zc-choice', c.label);
        b.tagName === 'DIV' && (b.setAttribute('role', 'button'));
        b.addEventListener('click', function () {
          body.querySelectorAll('.zc-choice').forEach(function (x) { x.remove(); });
          body.appendChild(el('bubble user', c.label));
          scroll();
          c.reply();
        });
        body.appendChild(b);
      });
      scroll();
    }, delay || 1400);
  };

  var menu = function () {
    choices([
      {
        label: 'How does Zen see my screen?',
        reply: function () {
          say('Your customer clicks <b>Share</b> once. Zen reads the live UI for that session only, masks sensitive fields, and the customer can stop at any moment.', 900);
          choices(mainMenu(), 1900);
        }
      },
      {
        label: 'Show me a live session',
        reply: function () {
          say('Let\'s go — I\'ll open a sandbox product and guide you through connecting an integration. 👀', 700);
          setTimeout(function () { window.location.href = 'demo.html'; }, 1900);
        }
      },
      {
        label: 'What does it cost?',
        reply: function () {
          say('Pricing scales with sessions, starting at <b>$1,200/mo</b> for 250 sessions. Want me to book 20 minutes with the team?', 900);
          choices([
            { label: 'Yes, book a demo', reply: function () { say('Done — grab a slot below. 📅', 600); setTimeout(function(){ document.getElementById('book').scrollIntoView({behavior:'smooth'}); }, 1200); } },
            { label: 'Not right now', reply: function () { say('No problem. I\'m here whenever you need me.', 600); choices(mainMenu(), 1500); } }
          ], 1900);
        }
      }
    ], 2800);
  };

  var mainMenu = function () {
    return [
      { label: 'Show me a live session', reply: function () { say('Opening the sandbox now…', 600); setTimeout(function () { window.location.href = 'demo.html'; }, 1600); } },
      { label: 'See the Admin Hub', reply: function () { say('Here\'s what your team sees while I run sessions.', 600); setTimeout(function () { window.location.href = 'dashboard.html'; }, 1600); } },
      { label: 'Book a demo', reply: function () { say('Drop your work email in the form and the team will reach out. 📩', 600); setTimeout(function(){ document.getElementById('book').scrollIntoView({behavior:'smooth'}); }, 1200); } }
    ];
  };

  var start = function () {
    if (started) return;
    started = true;
    say('Hi 👋 I\'m Zen, the onboarding agent. I can walk you through the product right now — no call needed.', 600);
    setTimeout(function () { say('What would you like to do first?', 700); }, 1600);
    menu();
  };

  launcher.addEventListener('click', function () {
    chat.hidden = !chat.hidden;
    if (!chat.hidden) start();
  });
  document.getElementById('zcClose').addEventListener('click', function () { chat.hidden = true; });

  var CLAUDE_FALLBACK = 'I\'m having trouble reaching my AI brain right now. Please try again in a moment, or use the quick options below.';

  var askClaude = function (message, onReply) {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        context: { page: 'landing', step: 'chat' }
      })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        var reply = result.data && result.data.reply;
        if (!reply) throw new Error('empty');
        onReply(reply);
      })
      .catch(function () {
        onReply(CLAUDE_FALLBACK);
      });
  };

  var handleTyped = function () {
    var text = input.value.trim();
    if (!text) return;
    body.appendChild(el('bubble user', text.replace(/</g, '&lt;')));
    input.value = '';
    scroll();

    var typingEl = el('typing', '<i></i><i></i><i></i>');
    body.appendChild(typingEl);
    scroll();

    askClaude(text, function (reply) {
      typingEl.remove();
      body.appendChild(el('bubble bot', reply));
      scroll();
      choices(mainMenu(), 1200);
    });
  };
  send.addEventListener('click', handleTyped);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleTyped(); });
})();
