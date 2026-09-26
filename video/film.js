'use strict';
// Deterministic film renderer: window.renderAt(t) draws the frame at time t (seconds).
(function () {
  const D = window.__DATA;
  const SB = D.storyboard, TM = D.timing, B = D.beats, FPS = SB.fps;
  const stage = document.getElementById('stage');

  // ------------------------------------------------------------ helpers
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const eio = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const eo = (p) => 1 - Math.pow(1 - p, 3);
  const eback = (p) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  const P = (t, a, b, e = eio) => e(clamp((t - a) / (b - a)));
  const win = (t, a, b, fi = 0.4, fo = 0.4) => Math.min(fi > 0 ? clamp((t - a) / fi) : +(t >= a), fo > 0 ? clamp((b - t) / fo) : +(t < b));
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const CS = (i) => TM[i].start, CE = (i) => TM[i].start + TM[i].dur;
  let uid = 0;

  const h = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const tf = (el, o, x = 0, y = 0, s = 1, r = 0) => { el.style.opacity = o; el.style.transform = `translate(${x}px,${y}px) scale(${s}) rotate(${r}deg)`; };
  const fadeUp = (el, t, t0, d = 0.5, dy = 16) => { const p = P(t, t0, t0 + d, eo); tf(el, p, 0, (1 - p) * dy); return p; };
  const popIn = (el, t, t0, d = 0.5) => { const p = clamp((t - t0) / d); tf(el, clamp(p * 2.5), 0, 0, 0.6 + 0.4 * eback(p)); return p; };
  const setText = (el, s) => { if (el.__t !== s) { el.textContent = s; el.__t = s; } };
  const setHTML = (el, s) => { if (el.__h !== s) { el.innerHTML = s; el.__h = s; } };
  const setCls = (el, c) => { if (el.className !== c) el.className = c; };
  function setCam(el, cx, cy, z, bounds = [0, 0, 1920, 1080]) {
    if (bounds && z >= 1) {
      const hw = 960 / z, hh = 540 / z, [x0, y0, x1, y1] = bounds;
      cx = clamp(cx, x0 + hw, Math.max(x0 + hw, x1 - hw)); cy = clamp(cy, y0 + hh, Math.max(y0 + hh, y1 - hh));
    }
    el.style.transform = `translate(${960 - cx * z}px,${540 - cy * z}px) scale(${z})`;
  }
  function camAt(list, t) {
    let cur = list[0].slice(2);
    for (let k = 1; k < list.length; k++) {
      const [t0, d, ...v] = list[k];
      if (t <= t0) break;
      const p = eio(clamp((t - t0) / Math.max(0.001, d)));
      cur = cur.map((x, i) => lerp(x, v[i], p));
    }
    return cur;
  }
  function amp(name, t) {
    for (const c of TM) {
      if (c.speaker !== name || t < c.start || t >= c.start + c.dur) continue;
      const a = c.amp;
      if (!a || !a.length) return clamp(0.45 + 0.4 * Math.sin(t * 21) * Math.sin(t * 6.3 + 1));
      const x = (t - c.start) * FPS, k = Math.floor(x);
      return lerp(a[k] || 0, a[k + 1] || 0, x - k);
    }
    return 0;
  }

  // ------------------------------------------------------------ icons
  const I = {
    check: (c = '#fff', s = 14) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    x: (c = '#fff', s = 14) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/></svg>`,
    warn: (c = '#A76A00', s = 16) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    arrow: (c = '#8A97AD', s = 22) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    send: () => '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z" fill="#fff"/></svg>',
    bell: (c = '#fff') => `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 17v-6a6 6 0 1112 0v6l2 2H4z" fill="${c}"/><circle cx="12" cy="21" r="2" fill="${c}"/></svg>`,
    mail: (c = '#fff') => `<svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M4 7l8 6 8-6" fill="none" stroke="${c}" stroke-width="2.2"/></svg>`,
    bolt: (c = '#fff') => `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="${c}"/></svg>`,
    clock: (c = '#fff') => `<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2.2"/><path d="M12 7v5l3 2" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    shield: (c = '#12A36B', s = 22) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    search: (c = '#1D6BF3', s = 14) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="${c}" stroke-width="2.8"/><path d="M15.5 15.5L21 21" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/></svg>`,
  };
  const okc = (s = 26, i = 14) => `<span class="okc" style="width:${s}px;height:${s}px">${I.check('#fff', i)}</span>`;
  const zenMark = (s) => {
    const id = 'zg' + uid++;
    return `<svg class="zm" width="${s}" height="${s}" viewBox="0 0 120 120"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#14B8A6"/></linearGradient></defs><circle class="zr" cx="60" cy="60" r="44" fill="none" stroke="url(#${id})" stroke-width="11" stroke-linecap="round" stroke-dasharray="250 400" transform="rotate(-62 60 60)"/><circle class="zd" cx="60" cy="60" r="13" fill="url(#${id})"/></svg>`;
  };
  const zenAv = '<svg width="18" height="18" viewBox="0 0 120 120"><circle cx="60" cy="60" r="40" fill="none" stroke="#fff" stroke-width="16" stroke-dasharray="210 400" stroke-linecap="round" transform="rotate(-62 60 60)"/></svg>';

  // ------------------------------------------------------------ people
  const CH = {
    maya: { skin: '#B97E5A', shade: '#9D6546', hair: '#1D1411', cloth: '#1E2E4E', inner: '#F3EFE9', lip: '#8A4640', style: 'long', sw: 160, earrings: true },
    rahul: { skin: '#A36C49', shade: '#86573A', hair: '#15110F', cloth: '#56657A', inner: '#DCE6F2', lip: '#76402F', style: 'short', sw: 172, glasses: true, beard: true },
    sarah: { skin: '#EFC6A6', shade: '#D8A585', hair: '#9C5E36', cloth: '#2D3441', inner: '#F1ECE4', lip: '#B25A57', style: 'bob', sw: 158, necklace: true },
  };
  const NAME = { maya: 'Maya', rahul: 'Rahul', sarah: 'Sarah' };
  // [smile, worry, frown, raise]
  const MOOD = {
    neutral: [0.15, 0, 0, 0], happy: [0.85, 0, 0, 0.15], confident: [0.55, 0, 0, 0.1], focused: [0.05, 0, 0.45, 0],
    concerned: [-0.2, 0.55, 0, 0], worried: [-0.45, 1, 0, 0], stressed: [-0.5, 0.35, 0.7, 0], surprised: [0.1, 0.25, 0, 1],
    relieved: [0.95, 0.1, 0, 0.35], thinking: [0.0, 0.2, 0.3, 0],
  };
  function personSVG(key) {
    const c = CH[key], id = 'p' + uid++, sw = c.sw;
    const back = {
      long: 'M110,196 C100,112 150,70 204,72 C262,74 304,118 294,200 C300,280 314,360 300,430 L106,430 C90,360 102,280 110,196 Z',
      bob: 'M104,206 C96,114 150,74 204,76 C260,78 308,118 298,208 C302,254 304,292 292,322 L108,322 C96,292 98,254 104,206 Z',
      short: '',
    }[c.style];
    const front = {
      long: 'M120,214 C110,122 158,84 206,86 C254,88 290,124 282,200 C276,160 256,134 222,124 C190,150 156,160 128,226 Z M124,200 C116,250 118,300 136,346 L112,350 C98,296 102,244 114,196 Z M276,200 C284,250 282,300 264,346 L288,350 C302,296 298,244 286,196 Z',
      bob: 'M118,218 C108,120 160,86 208,88 C258,90 294,128 286,214 C272,166 244,134 204,130 C174,142 146,168 126,226 Z M122,206 C114,248 116,288 128,318 L106,318 C96,286 98,248 108,204 Z M278,206 C286,248 284,288 272,318 L294,318 C304,286 302,248 292,204 Z',
      short: 'M122,196 C114,120 154,80 204,80 C256,80 290,122 280,192 C274,164 264,146 248,138 C224,150 176,150 150,140 C136,154 128,172 122,196 Z',
    }[c.style];
    const torso = `M${200 - sw},520 C${202 - sw},420 ${240 - sw},362 170,344 L230,344 C${160 + sw},362 ${198 + sw},420 ${200 + sw},520 Z`;
    const clothes = key === 'rahul'
      ? `<path d="M166,348 C180,372 220,372 234,348 L228,334 C214,358 186,358 172,334 Z" fill="#46546A"/><path d="M200,368 L200,470" stroke="#3B475A" stroke-width="3"/><path d="M${214 - sw},470 C${230 - sw},440 ${250 - sw},420 ${262 - sw},410" stroke="rgba(0,0,0,.12)" stroke-width="4" fill="none"/>`
      : `<path d="M170,344 L230,344 L216,470 L184,470 Z" fill="${c.inner}"/><path d="M180,340 L220,340 L200,384 Z" fill="${c.shade}"/><path d="M170,344 L190,472 M230,344 L210,472" stroke="rgba(0,0,0,.24)" stroke-width="3" fill="none"/>` +
        (c.necklace ? '<path d="M184,346 Q200,376 216,346" stroke="#EFE8D6" stroke-width="2.6" fill="none"/><circle cx="200" cy="369" r="4" fill="#EFE8D6"/>' : '');
    const eye = (cx, s) => `<g class="e${s}"><ellipse cx="${cx}" cy="204" rx="11.5" ry="7.8" fill="#FBF8F5"/><g clip-path="url(#${id}${s})"><g class="i${s}"><circle cx="${cx}" cy="204" r="6.2" fill="#2A1C15"/><circle cx="${cx + 2}" cy="202" r="1.8" fill="#fff"/></g></g><path d="M${cx - 12.5},201 Q${cx},192.5 ${cx + 12.5},201" stroke="#2B1D16" stroke-width="2.8" fill="none" stroke-linecap="round"/></g>`;
    return `<svg class="person" viewBox="0 0 400 520">
      <defs><clipPath id="${id}L"><ellipse cx="168" cy="204" rx="11.5" ry="7.8"/></clipPath><clipPath id="${id}R"><ellipse cx="232" cy="204" rx="11.5" ry="7.8"/></clipPath></defs>
      <g class="hb">${back ? `<path d="${back}" fill="${c.hair}"/>` : ''}</g>
      <g class="bd"><path d="${torso}" fill="${c.cloth}"/><path d="M172,262 L172,330 C172,356 228,356 228,330 L228,262 Z" fill="${c.shade}"/>${clothes}<ellipse cx="200" cy="294" rx="34" ry="13" fill="rgba(0,0,0,.13)"/></g>
      <g class="hd">
        <ellipse cx="126" cy="210" rx="13" ry="21" fill="${c.shade}"/><ellipse cx="274" cy="210" rx="13" ry="21" fill="${c.shade}"/>
        <path d="M124,196 C124,128 158,96 200,96 C242,96 276,128 276,196 C276,256 244,300 200,300 C156,300 124,256 124,196 Z" fill="${c.skin}"/>
        <ellipse cx="151" cy="244" rx="15" ry="8" fill="#E0705F" opacity=".13"/><ellipse cx="249" cy="244" rx="15" ry="8" fill="#E0705F" opacity=".13"/>
        ${c.beard ? `<path d="M132,232 C138,280 168,302 200,302 C232,302 262,280 268,232 C262,262 246,280 224,286 C214,278 186,278 176,286 C154,280 138,262 132,232 Z" fill="${c.hair}" opacity=".38"/><path d="M180,248 C190,242 210,242 220,248 C212,253 188,253 180,248 Z" fill="${c.hair}" opacity=".62"/>` : ''}
        <path d="M199,206 C196,224 191,236 198,241 C202,243 207,242 210,239" stroke="${c.shade}" stroke-width="3" fill="none" stroke-linecap="round"/>
        ${eye(168, 'L')}${eye(232, 'R')}
        <path class="brL" stroke="${c.hair}" stroke-width="6.5" fill="none" stroke-linecap="round"/>
        <path class="brR" stroke="${c.hair}" stroke-width="6.5" fill="none" stroke-linecap="round"/>
        <path class="mo" fill="#4A1F1F" stroke="${c.lip}" stroke-width="3.2" stroke-linejoin="round"/>
        ${c.glasses ? '<g fill="rgba(255,255,255,.07)" stroke="#20242C" stroke-width="3.4"><rect x="146" y="189" width="45" height="29" rx="11"/><rect x="209" y="189" width="45" height="29" rx="11"/><path d="M191,201 Q200,196 209,201 M146,199 L128,195 M254,199 L272,195" fill="none"/></g>' : ''}
        <path d="${front}" fill="${c.hair}"/>
        ${c.earrings ? '<circle cx="124" cy="236" r="4.5" fill="#D9B45C"/><circle cx="276" cy="236" r="4.5" fill="#D9B45C"/>' : ''}
      </g></svg>`;
  }
  const actors = [];
  function mount(el, key, grp, cfg) {
    el.innerHTML = personSVG(key);
    const svg = el.firstElementChild;
    const A = { key, name: NAME[key], g: grp, seed: cfg.seed ?? actors.length * 1.9 + 0.7, mood: cfg.mood || [[0, 'neutral']], look: cfg.look || [[0, 0, 0]], tilt: cfg.tilt || [[0, 0, 0]] };
    for (const k of ['hd', 'hb', 'bd', 'eL', 'eR', 'iL', 'iR', 'brL', 'brR', 'mo']) A[k] = $('.' + k, svg);
    actors.push(A);
    return A;
  }
  function kfv(list, t, dur) {
    const val = (k) => { const v = list[k].slice(1); return typeof v[0] === 'string' ? MOOD[v[0]] : v; };
    let i = -1;
    for (let k = 0; k < list.length; k++) if (list[k][0] <= t) i = k;
    if (i <= 0) return val(0);
    const p = eio(clamp((t - list[i][0]) / dur));
    const a = val(i - 1), b = val(i);
    return b.map((v, k) => lerp(a[k], v, p));
  }
  const blinkK = (t, seed) => { const per = 3.4 + (Math.floor(seed * 10) % 3) * 0.55; const ph = (t + seed * 1.37) % per; return ph < 0.17 ? 1 - Math.sin((ph / 0.17) * Math.PI) * 0.94 : 1; };
  const brow = (x1, y1, x2, y2) => `M${x1},${y1} Q${(x1 + x2) / 2},${Math.min(y1, y2) - 6} ${x2},${y2}`;
  function mouthPath(sm, op) {
    const hw = 20 * (1 + sm * 0.14 - op * 0.12);
    const cy = 263 - sm * 5 + op;
    const um = 263 + sm * 1.5 - op * 2.5;
    const lm = um + Math.max(0.6, sm * 4) + op * 15;
    return `M${200 - hw},${cy} Q200,${2 * um - cy} ${200 + hw},${cy} Q200,${2 * lm - cy} ${200 - hw},${cy} Z`;
  }
  function updActor(A, t) {
    const [sm0, wo, fr, ra] = kfv(A.mood, t, 0.8);
    const [lx, ly] = kfv(A.look, t, 0.35);
    const [tilt, nod] = kfv(A.tilt, t, 0.9);
    const a = amp(A.name, t);
    const op = clamp(a * 1.05);
    const sm = sm0 * (1 - 0.35 * op);
    const br = Math.sin(t * 1.55 + A.seed * 3);
    const rot = tilt + Math.sin(t * 0.63 + A.seed) * 0.9 + Math.sin(t * 3.3 + A.seed) * op * 1.3;
    const dy = nod + br * 0.9 - op * 1.6;
    const head = `translate(${Math.sin(t * 0.41 + A.seed) * 1.2},${dy}) rotate(${rot} 200 300)`;
    A.hd.setAttribute('transform', head);
    A.hb.setAttribute('transform', head);
    A.bd.setAttribute('transform', `translate(0,${br * 1.3})`);
    const k = blinkK(t, A.seed) * (1 + ra * 0.12 - fr * 0.1);
    const et = `translate(0,${204 * (1 - k)}) scale(1,${k})`;
    A.eL.setAttribute('transform', et);
    A.eR.setAttribute('transform', et);
    const it = `translate(${lx * 4.6},${ly * 2.6})`;
    A.iL.setAttribute('transform', it);
    A.iR.setAttribute('transform', it);
    const yi = 177 - wo * 7 + fr * 4.5 - ra * 6, yo = 176 + wo * 1.5 - fr - ra * 6;
    A.brL.setAttribute('d', brow(148, yo, 186, yi));
    A.brR.setAttribute('d', brow(214, yi, 252, yo));
    A.mo.setAttribute('d', mouthPath(sm, op));
  }

  // ------------------------------------------------------------ backdrops
  function officeHTML(seed, blur = 4) {
    const r = rng(seed);
    const sky = (w) => {
      let s = '';
      for (let x = -10; x < w;) { const bw = 40 + r() * 90, bh = 140 + r() * 380; s += `<rect x="${x.toFixed(0)}" y="${(600 - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="rgba(110,138,178,${(0.22 + r() * 0.3).toFixed(2)})"/>`; x += bw + 4 + r() * 16; }
      return `<svg width="${w}" height="600">${s}</svg>`;
    };
    const leaves = Array.from({ length: 14 }, (_, i) => { const a = -80 + i * 12 + r() * 8; return `<ellipse cx="110" cy="210" rx="16" ry="${70 + r() * 40}" fill="${i % 2 ? '#5E8C6A' : '#4F7B5C'}" transform="rotate(${a} 110 300) translate(0,${-40 - r() * 30})"/>`; }).join('');
    const bokeh = Array.from({ length: 9 }, () => `<div class="bokeh" style="left:${(r() * 1900).toFixed(0)}px;top:${(60 + r() * 520).toFixed(0)}px;width:${(30 + r() * 70).toFixed(0)}px;height:${(30 + r() * 70).toFixed(0)}px;opacity:${(0.2 + r() * 0.4).toFixed(2)}"></div>`).join('');
    return `<div class="office">
      <div class="win" style="left:60px;width:560px;filter:blur(${blur}px)">${sky(560)}<div class="mull" style="left:273px"></div></div>
      <div class="win" style="left:660px;width:560px;filter:blur(${blur}px)">${sky(560)}<div class="mull" style="left:273px"></div></div>
      <div class="win" style="left:1260px;width:600px;filter:blur(${blur}px)">${sky(600)}<div class="mull" style="left:293px"></div></div>
      <div class="shelf" style="left:40px;top:700px;width:420px;height:150px;background:#C3CBD8"></div>
      <svg class="plant" style="left:1660px;top:420px" width="220" height="440"><g>${leaves}</g><path d="M60,300 L160,300 L148,430 L72,430 Z" fill="#E9ECF1"/></svg>
      ${bokeh}</div>`;
  }
  const tileBg = {
    maya: 'linear-gradient(180deg,#DCE6F2,#C6D3E4)',
    sarah: 'linear-gradient(180deg,#EDE3D8,#D6C7B6)',
    rahul: 'linear-gradient(180deg,#E1E5EA,#C8CFD9)',
  };

  // ------------------------------------------------------------ groups
  const groups = [];
  function group(id, a, b, fi, fo, html) {
    const el = h(`<div class="group" id="${id}">${html}</div>`);
    stage.appendChild(el);
    const g = { el, a, b, fi, fo, vis: false, upd: () => {} };
    groups.push(g);
    return g;
  }

  // ===== Scene 1a - the message
  const G1a = group('g1a', 0, 7.1, 0, 0.05, `
    <div class="cam">${officeHTML(11)}
      <div class="abs" id="a_maya1" style="left:230px;top:190px;width:580px"></div>
      <div class="desk"></div>
      <div class="laptop" style="left:690px;top:704px;width:360px;height:150px"></div>
      <div class="mug" style="left:170px;top:796px"></div>
    </div>
    <div class="toast" id="toast1" style="left:1090px;top:250px">
      <div class="hd"><div class="av">SW</div><div><b>Sarah Whitfield</b><br>VP, Business Operations · now</div></div>
      <div class="msg">We're moving our IT operations to <em>Freshservice</em>.</div>
    </div>
    <div class="golive" id="golive1" style="left:1090px;top:520px">
      <div class="cal"><i>OCT</i><b>17</b></div><div><div class="t1">Go-live target</div><div class="t2">3 weeks</div></div>
    </div>
    <div class="lower3" id="l3maya"><b>Maya Iyer</b><span>IT Onboarding Manager · Contoso</span></div>`);
  mount($('#a_maya1'), 'maya', G1a, {
    mood: [[0, 'confident'], [B.toast + 0.3, 'focused'], [B.golive + 0.1, 'surprised'], [B.golive + 1.3, 'confident']],
    look: [[0, 0.1, 0.2], [B.toast + 0.1, 0.95, -0.1], [B.golive + 1.5, 0.2, 0]],
    tilt: [[0, 0, 0], [B.toast + 0.2, 2, 0], [B.golive + 1.4, -1, 0]],
  });
  G1a.upd = (t) => {
    setCam($('.cam', G1a.el), 760, 520, lerp(1.0, 1.06, P(t, 0, 7.1, (p) => p)));
    const pt = P(t, B.toast, B.toast + 0.6, eo);
    tf($('#toast1'), pt, (1 - pt) * 60, 0);
    popIn($('#golive1'), t, B.golive, 0.55);
    const l3 = win(t, 1.3, 6.0, 0.5, 0.5);
    tf($('#l3maya'), l3, (1 - l3) * -30, 0);
  };

  // ===== Scene 1b - the JSM estate
  const tiles1 = [['Employees', 4212], ['Tickets', 5788], ['Years of history', 6], ['Custom fields', 147]];
  const tiles2 = [['Request types', 64], ['SLA policies', 38], ['Automation rules', 212], ['Attachments', 21930]];
  const tileHTML = (list) => list.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v" data-n="${v}">0</div></div>`).join('');
  const pri = { Highest: 'red', High: 'amber', Medium: 'blue', Low: 'grey' };
  const recent = [
    ['SR-10482', 'Laptop won’t connect to VPN', 'J. Alvarez', 'Highest', 'In progress'],
    ['SR-10477', 'New starter access — Finance', 'A. Chen', 'Medium', 'Waiting for support'],
    ['SR-10471', 'Outlook calendar not syncing', 'P. Nair', 'High', 'Open'],
    ['SR-10466', 'Badge reader offline, floor 3', 'M. Okafor', 'Low', 'Resolved'],
    ['SR-10459', 'Adobe Acrobat license request', 'S. Patel', 'Medium', 'Resolved'],
  ];
  const everything = ['4,212 employees', '5,788 tickets', '6 years of history', '38 SLA policies', '212 automation rules', '147 custom fields', '64 request types', '21,930 attachments'];
  const evPos = [[90, 170], [1500, 130], [40, 470], [1560, 430], [120, 760], [1480, 740], [640, 40], [980, 860]];
  const G1b = group('g1b', 6.5, 18.4, 0.6, 0.05, `
    <div class="dark"><div class="gridbg"></div></div>
    <div class="cam">
      <div class="app" style="left:210px;top:100px;width:1500px;height:860px">
        <div class="bar"><div class="logo"></div><b>Jira Service Management</b><span class="crumb">Projects / Contoso IT Service Desk</span></div>
        <div class="nav"><div>Queues</div><div class="on">Overview</div><div>Customers</div><div>Organizations</div><div>Reports</div><div>SLAs</div><div>Automation</div><div>Knowledge base</div><div>Project settings</div></div>
        <div class="content">
          <div class="h2">Contoso IT Service Desk</div><div class="sub">contoso.atlassian.net · in production since 2020</div>
          <div class="tiles" style="grid-template-columns:repeat(4,1fr)">${tileHTML(tiles1)}</div>
          <div class="tiles" style="grid-template-columns:repeat(4,1fr);margin-top:16px">${tileHTML(tiles2)}</div>
          <div style="margin-top:26px;font-size:18px;font-weight:650">Recent requests</div>
          <table class="t"><tr><th>Key</th><th>Summary</th><th>Reporter</th><th>Priority</th><th>Status</th></tr>
          ${recent.map((r) => `<tr class="rr"><td class="mono" style="color:#0B4FC4">${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td><span class="chip ${pri[r[3]]}">${r[3]}</span></td><td>${r[4]}</td></tr>`).join('')}</table>
        </div>
      </div>
    </div>
    <div id="dim1b" style="position:absolute;inset:0;background:#0A1222;opacity:0"></div>
    ${everything.map((s, i) => `<div class="everything ev" style="left:${evPos[i][0]}px;top:${evPos[i][1]}px">${s}</div>`).join('')}`);
  G1b.upd = (t) => {
    const [cx, cy, z] = camAt([[6.5, 0, 700, 330, 1.3], [8.6, 4.2, 960, 540, 1.0]], t);
    setCam($('.cam', G1b.el), cx, cy, z, false);
    const pc = P(t, 7.0, 9.4, eo);
    $$('.tile .v', G1b.el).forEach((el) => setText(el, fmt(+el.dataset.n * pc)));
    $$('.rr', G1b.el).forEach((el, i) => fadeUp(el, t, 7.6 + i * 0.14, 0.4, 10));
    $('#dim1b').style.opacity = 0.55 * P(t, B.everything - 0.2, B.everything + 0.8);
    $$('.ev', G1b.el).forEach((el, i) => { const p = clamp((t - B.everything - i * 0.17) / 0.5); tf(el, clamp(p * 2.5), 0, Math.sin(t * 0.9 + i) * 6, 0.6 + 0.4 * eback(p)); });
  };

  // ===== Scene 2a - handoff to Rahul
  const G2a = group('g2a', 17.9, 26.95, 0.5, 0.05, `
    <div class="cam">${officeHTML(23)}
      <div class="abs" id="a_maya2" style="left:140px;top:236px;width:540px"></div>
      <div class="abs" id="a_rahul2" style="left:1180px;top:214px;width:560px"></div>
      <div class="desk"></div>
      <div class="laptop" style="left:1110px;top:716px;width:380px;height:150px"></div>
      <div class="mug" style="left:760px;top:796px"></div>
    </div>
    <div class="lower3" id="l3rahul" style="left:auto;right:96px"><b>Rahul Menon</b><span>Migration Engineer · Contoso</span></div>`);
  mount($('#a_maya2'), 'maya', G2a, {
    mood: [[0, 'confident'], [CE(2) + 0.2, 'neutral'], [CS(3) + 0.6, 'confident']],
    look: [[0, 0.95, 0], [25.9, 0.7, 0.2]],
    tilt: [[0, 2.5, 0]],
  });
  mount($('#a_rahul2'), 'rahul', G2a, {
    mood: [[0, 'neutral'], [CS(3) - 0.2, 'confident'], [25.8, 'focused']],
    look: [[0, -0.95, 0], [25.8, -0.4, 0.9]],
    tilt: [[0, -2, 0], [CS(3), -1, 2], [CS(3) + 0.5, -1, 0], [25.8, 1, 4]],
  });
  G2a.upd = (t) => {
    setCam($('.cam', G2a.el), 960, lerp(540, 520, P(t, 17.9, 27)), lerp(1.03, 1.08, P(t, 17.9, 27, (p) => p)));
    const l3 = win(t, CS(3) - 0.2, 26.5, 0.5, 0.5);
    tf($('#l3rahul'), l3, (1 - l3) * 30, 0);
  };

  // ===== Scene 2b - the spreadsheet
  const cols = [50, 280, 130, 320, 140, 230, 470];
  const sheet = [
    ['JSM customer field', 'Type', 'Freshservice requester field', 'Type', 'Status', 'Notes'],
    ['displayName', 'string', 'name', 'string', ['ok', '✓ Mapped'], ''],
    ['email', 'string', 'email', 'string', ['ok', '✓ Mapped'], 'case sensitive?'],
    ['department', 'string', 'department', 'lookup', ['warn', '? Check values'], '14 JSM values vs 11 in Freshservice'],
    ['title', 'string', 'job_title', 'string', ['ok', '✓ Mapped'], ''],
    ['accountId', 'string', '—', '', ['bad', '✗ No match'], 'no equivalent field??'],
    ['—', '', 'location', 'lookup', ['warn', '? Source'], 'where does location come from?'],
    ['timeZone', 'string', 'time_zone', 'enum', ['warn', '? Format'], '"Asia/Kolkata" vs "Chennai"'],
    ['customfield_10042', 'option', '???', '', ['bad', '✗ Unknown'], 'Cost Center — ask finance'],
    ['organization', 'array', '???', '', ['bad', '✗ Unknown'], ''],
    ['', '', '', '', '', ''], ['', '', '', '', '', ''],
  ];
  const sheetRows = sheet.map((r, i) => `<div class="row ${i === 0 ? 'head' : 'dr'}"><div class="rn">${i + 1}</div>${r.map((c, j) => {
    const [cls, txt] = Array.isArray(c) ? c : ['', c];
    return `<div class="${cls} ${j === 0 || j === 2 ? 'mono' : ''}" style="width:${cols[j + 1]}px;${j === 0 || j === 2 ? 'font-size:17px' : ''}">${txt}</div>`;
  }).join('')}</div>`).join('');
  const G2b = group('g2b', 26.4, 33.5, 0.55, 0.05, `
    ${officeHTML(31, 9)}<div style="position:absolute;inset:0;background:rgba(10,18,34,.35)"></div>
    <div class="cam">
      <div class="xl" style="left:150px;top:80px;width:1620px;height:880px">
        <div class="tb"><span class="dots"><i></i><i></i><i></i></span><b style="font-weight:600">JSM_to_Freshservice_mapping_v7_FINAL (2).xlsx</b><span style="margin-left:auto;opacity:.7">Saved · Rahul Menon</span></div>
        <div class="rib"><b style="color:#1F8A4C">File</b><span>Home</span><span>Insert</span><span>Formulas</span><span>Data</span><span>Review</span><span>View</span></div>
        <div class="fx"><div class="nm" id="xlNm">C2</div><div class="fi">fx</div><div class="fv mono" id="xlFv"></div></div>
        <div class="grid"><div class="row hdr"><div class="rn"></div>${['A', 'B', 'C', 'D', 'E', 'F'].map((l, j) => `<div style="width:${cols[j + 1]}px">${l}</div>`).join('')}</div>${sheetRows}</div>
        <div class="selbox" id="xlSel"></div>
        <div class="tabs"><div class="on">Customers</div><div>Tickets</div><div>Priorities</div><div>SLAs</div><div>Workflows</div><div>Issues (23)</div></div>
      </div>
      <div class="comment" id="xlCom" style="left:1330px;top:448px"><b>Rahul Menon · just now</b>accountId has no Freshservice equivalent. Keep as external ID?</div>
      <div class="sticky" id="xlSticky" style="left:1440px;top:700px">147 custom fields still to map…</div>
    </div>`);
  const xlRowT = (i) => 26.9 + (i - 1) * 0.55;
  G2b.upd = (t) => {
    setCam($('.cam', G2b.el), lerp(960, 900, P(t, 26.4, 33.5)), lerp(540, 470, P(t, 26.4, 33.5)), lerp(1.0, 1.14, P(t, 26.4, 33.5, (p) => p)), false);
    const rows = $$('.grid .row.dr', G2b.el);
    let cur = 1;
    rows.forEach((el, k) => {
      const i = k + 1;
      if (i >= sheet.length - 2) return;
      const p = P(t, xlRowT(i), xlRowT(i) + 0.25, eo);
      $$('div:not(.rn)', el).forEach((c) => { c.style.opacity = p; });
      if (t >= xlRowT(i)) cur = i;
    });
    const row = sheet[cur];
    const sel = $('#xlSel');
    sel.style.left = cols[0] + cols[1] + cols[2] + 'px';
    sel.style.top = 130 + 34 + cur * 50 + 'px';
    sel.style.width = cols[3] + 'px';
    sel.style.height = '50px';
    setText($('#xlNm'), 'C' + (cur + 1));
    const full = String(row[2]);
    const n = Math.floor(clamp((t - xlRowT(cur)) / 0.35) * full.length);
    setText($('#xlFv'), full.slice(0, n));
    fadeUp($('#xlCom'), t, 29.7, 0.45, 12);
    const ps = clamp((t - 30.9) / 0.5);
    tf($('#xlSticky'), clamp(ps * 2.5), 0, 0, 0.6 + 0.4 * eback(ps), -4);
  };

  // ===== Scene 3a - the problems
  const notifs = Array.from({ length: 18 }, (_, i) => {
    const kinds = [['mail', 'Email sent to requester', `INC-${2041 + i} · ticket imported`], ['bolt', 'Auto-assign rule triggered', `INC-${2041 + i} → Service Desk L1`], ['clock', 'SLA timer started', `INC-${2041 + i} · resolution due in 8h`], ['bell', 'New ticket created', `INC-${2041 + i} · requester notified`]];
    return kinds[i % 4];
  });
  const nr = rng(5);
  const nPos = notifs.map(() => [60 + nr() * 1380, 120 + nr() * 700]);
  const G3a = group('g3a', 33.0, 47.3, 0.5, 0.05, `
    <div class="dark"><div class="gridbg"></div></div>
    <div class="cam">
      <div class="card prob redl" id="pc1" style="left:250px;top:130px"><span class="chip red">${I.x('#C2343B', 12)} Unmapped field</span><div class="ttl">No match for a custom field</div>
        <div class="code mono">customfield_10042 · "Cost Center"<br>→ Freshservice: <b style="color:#C2343B">no equivalent field</b></div><div class="bd">Which requester field should hold it — or should it be dropped?</div></div>
      <div class="card prob ambl" id="pc2" style="left:1130px;top:130px"><span class="chip amber">${I.warn('#A76A00', 13)} Value mismatch</span><div class="ttl">JSM priority “Highest” → ?</div>
        <div class="opt"><span>Low</span><span class="mono">1</span></div><div class="opt"><span>Medium</span><span class="mono">2</span></div><div class="opt" id="optH"><span>High</span><span class="mono">3</span></div><div class="opt" id="optU"><span>Urgent</span><span class="mono">4</span></div></div>
      <div class="card prob redl" id="pc3" style="left:250px;top:560px"><span class="chip red">${I.x('#C2343B', 12)} Import error 422</span><div class="ttl">Requester not found</div>
        <div class="code mono">SR-10482 · requester<br>"J.Alvarez@Contoso.com"<br><b style="color:#C2343B">not found in Freshservice</b></div></div>
      <div class="card prob ambl" id="pc4" style="left:1130px;top:560px"><span class="chip amber">${I.warn('#A76A00', 13)} Side effects</span><div class="ttl">Workflows fired on import</div>
        <div class="bd">Every imported ticket triggered auto-assign rules, SLA timers and emails to employees.</div></div>
    </div>
    <div id="redtint" style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, transparent 35%, rgba(224,72,79,.32));opacity:0"></div>
    ${notifs.map((n, i) => `<div class="ntf" style="left:${nPos[i][0].toFixed(0)}px;top:${nPos[i][1].toFixed(0)}px"><div class="ic" style="background:${['#1D6BF3', '#7C4DFF', '#E8A317', '#12A36B'][i % 4]}">${I[n[0]]()}</div><div><b>${n[1]}</b><span>${n[2]}</span></div></div>`).join('')}
    <div style="position:absolute;left:0;right:0;top:40px;text-align:center"><div class="counter" id="ecount" style="position:relative;display:inline-block">0 emails sent to employees</div></div>`);
  const nT = notifs.map((_, i) => B.notif - 0.25 + 4.0 * Math.pow(i / notifs.length, 0.7));
  G3a.upd = (t) => {
    const [cx, cy, z] = camAt([[33, 0, 520, 320, 1.34], [B.card2 - 0.35, 0.8, 1400, 320, 1.34], [B.card3 - 0.35, 0.8, 520, 740, 1.34], [B.card4 - 0.35, 0.8, 1400, 740, 1.34], [B.notif + 0.3, 1.6, 960, 540, 1.0]], t);
    setCam($('.cam', G3a.el), cx, cy, z, false);
    [B.card1, B.card2, B.card3, B.card4].forEach((b, i) => { const p = clamp((t - b + 0.1) / 0.55); tf($('#pc' + (i + 1)), clamp(p * 2.5), 0, (1 - eo(p)) * 30, 0.85 + 0.15 * eback(p), (1 - eo(p)) * (i % 2 ? 2 : -2)); });
    const flick = Math.floor((t - B.card2) / 0.45) % 2 === 0;
    $('#optH').style.background = t > B.card2 + 0.5 && flick ? '#FFF4DE' : '';
    $('#optU').style.background = t > B.card2 + 0.5 && !flick ? '#FFF4DE' : '';
    $$('.ntf', G3a.el).forEach((el, i) => { const p = P(t, nT[i], nT[i] + 0.3, eo); tf(el, p, (1 - p) * 50, 0); });
    $('#redtint').style.opacity = P(t, B.notif, 46.8, (p) => p);
    const pe = P(t, B.notif, 46.8, (p) => p * p);
    const ec = $('#ecount');
    ec.style.opacity = win(t, B.notif + 0.2, 60, 0.3, 0.1);
    setText(ec, fmt(1284 * pe) + ' emails sent to employees');
  };

  // ===== Scene 3b - the dashboard
  const reasons = [['Requester not found', 142], ['Invalid priority value', 88], ['Required field missing', 61], ['Duplicate record', 28]];
  const G3b = group('g3b', 46.8, 54.6, 0.5, 0.05, `
    <div class="dark"><div class="gridbg"></div></div>
    <div class="cam">
      <div class="card dash" style="left:310px;top:70px">
        <div style="display:flex;align-items:center;gap:16px"><div class="h2">Migration run #3 · Customers &amp; Tickets</div><span class="chip red">Completed with errors</span></div>
        <div class="sub">Manual CSV import · started 09:12 · duration 2h 47m</div>
        <div class="kpis">
          <div class="kpi"><div class="k">Processed</div><div class="v" data-n="3421">0</div></div>
          <div class="kpi"><div class="k">Successful</div><div class="v" data-n="3102" style="color:#13804A">0</div></div>
          <div class="kpi" style="background:#FDF0F0"><div class="k">Failed</div><div class="v" data-n="319" style="color:#C2343B">0</div></div>
          <div class="kpi" style="background:#FFF7E6"><div class="k">Unknown mappings</div><div class="v" data-n="47" style="color:#A76A00">0</div></div>
        </div>
        <div class="bar2"><i id="b3g" style="background:#12A36B"></i><i id="b3r" style="background:#E0484F"></i></div>
        <div style="margin-top:26px;font-size:15px;font-weight:700;color:#8A97AD;letter-spacing:1.2px">TOP FAILURE REASONS</div>
        ${reasons.map(([k, v]) => `<div class="reason rs3"><span>${k}</span><span style="display:flex;align-items:center;gap:14px"><span style="display:block;width:${v * 1.6}px;height:8px;border-radius:4px;background:#F2B8BB"></span><b>${v}</b></span></div>`).join('')}
      </div>
    </div>
    <div class="portrait" id="pMaya" style="left:100px;top:640px"><div class="pw" id="a_maya3"></div></div><div class="ptag" id="tMaya" style="left:190px;top:930px">Maya</div>
    <div class="portrait" id="pRahul" style="left:1520px;top:640px"><div class="pw" id="a_rahul3"></div></div><div class="ptag" id="tRahul" style="left:1605px;top:930px">Rahul</div>`);
  mount($('#a_maya3'), 'maya', G3b, { mood: [[0, 'concerned'], [CE(6), 'worried']], look: [[0, 0.3, -0.2], [CE(6) + 0.3, 0.9, 0]], tilt: [[0, 0, 0], [CS(6), 2, 0]] });
  mount($('#a_rahul3'), 'rahul', G3b, { mood: [[0, 'stressed'], [CE(7), 'worried']], look: [[0, -0.2, 0.8], [CS(7), -0.8, 0.1], [CE(7), -0.2, 0.9]], tilt: [[0, 0, 5], [CS(7), -2, 0], [CE(7), 1, 6]] });
  G3b.upd = (t) => {
    setCam($('.cam', G3b.el), 960, lerp(540, 520, P(t, 47, 54)), lerp(1.0, 1.04, P(t, 46.8, 54.6, (p) => p)), false);
    const pc = P(t, 47.0, 48.8, eo);
    $$('.kpi .v', G3b.el).forEach((el) => setText(el, fmt(+el.dataset.n * pc)));
    $('#b3g').style.width = (3102 / 3421) * 100 * pc + '%';
    $('#b3r').style.width = (319 / 3421) * 100 * pc + '%';
    $$('.rs3', G3b.el).forEach((el, i) => fadeUp(el, t, 48.0 + i * 0.18, 0.4, 10));
    const pm = popIn($('#pMaya'), t, CS(6) - 0.4, 0.5); tf($('#tMaya'), clamp(pm * 2));
    const pr = popIn($('#pRahul'), t, CS(7) - 0.5, 0.5); tf($('#tRahul'), clamp(pr * 2));
  };

  // ===== Scene 4 - are we ready?
  const G4 = group('g4', 54.0, 68.0, 0.6, 0.6, `
    <div class="cam"><div class="meet">
      <div class="top"><span class="rec"></span><b style="font-weight:600">Go-live readiness review</b><span style="color:#9AA5B8">· Contoso × Freshservice</span><span class="tm" id="mtm">00:14:32</span></div>
      <div class="mtile" id="tlMaya" style="left:60px;top:150px;background:${tileBg.maya}"><div class="pw" id="a_maya4"></div><div class="nm">Maya Iyer</div><div class="ring"></div></div>
      <div class="mtile" id="tlSarah" style="left:670px;top:150px;background:${tileBg.sarah}"><div class="pw" id="a_sarah4"></div><div class="nm">Sarah Whitfield · VP Business Operations</div><div class="ring"></div></div>
      <div class="mtile" id="tlRahul" style="left:1280px;top:150px;background:${tileBg.rahul}"><div class="pw" id="a_rahul4"></div><div class="nm">Rahul Menon</div><div class="ring"></div></div>
      <div class="tools"><i></i><i></i><i></i><i class="end"></i></div>
    </div></div>
    <div id="dim4" style="position:absolute;inset:0;background:#070C16;opacity:0"></div>
    <div class="words" id="w1" style="top:392px;font-size:66px">Migration isn’t just about moving data.</div>
    <div class="words" id="w2" style="top:500px;font-size:66px">It’s about knowing whether you can <span id="wTrust" style="position:relative;display:inline-block">trust<span id="wLine" style="position:absolute;left:0;right:0;bottom:-4px;height:6px;border-radius:3px;background:#3B82F6;transform-origin:0 50%"></span></span> the migration.</div>`);
  mount($('#a_maya4'), 'maya', G4, { mood: [[0, 'neutral'], [CS(8) + 0.4, 'concerned'], [CE(8) + 0.1, 'worried']], look: [[0, 0.2, 0], [CE(8) + 0.3, -0.5, 0.7]], tilt: [[0, 0, 0], [CE(8) + 0.3, -3, 4]] });
  mount($('#a_sarah4'), 'sarah', G4, { mood: [[0, 'neutral'], [CS(8), 'focused'], [CE(8) + 0.6, 'concerned']], look: [[0, 0, 0]], tilt: [[0, 0, 0], [CE(8) + 0.4, 3, 0]] });
  mount($('#a_rahul4'), 'rahul', G4, { mood: [[0, 'focused'], [CE(8) + 0.2, 'worried']], look: [[0, 0, 0.2], [CE(8) + 0.5, -0.8, 0.3], [CE(8) + 1.6, -0.2, 0.9]], tilt: [[0, 0, 0], [CE(8) + 0.5, -2, 2], [CE(8) + 1.6, 1, 6]] });
  G4.upd = (t) => {
    const cam = $('.cam', G4.el);
    const [cx, cy, z] = camAt([[54, 0, 960, 540, 1.0], [CS(8) - 0.3, 1.3, 960, 420, 1.2], [CE(8) + 0.2, 1.3, 960, 500, 1.0], [B.realProblem, 6, 960, 480, 1.08]], t);
    setCam(cam, cx, cy, z);
    const secs = 14 * 60 + 32 + Math.floor(t - 54);
    setText($('#mtm'), `00:${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`);
    [['#tlMaya', 'Maya'], ['#tlSarah', 'Sarah'], ['#tlRahul', 'Rahul']].forEach(([s, n]) => { $('.ring', $(s)).style.opacity = clamp(amp(n, t) * 3); });
    const dp = P(t, B.line1 - 0.7, B.line1 + 0.3);
    $('#dim4').style.opacity = 0.8 * dp;
    cam.style.filter = dp > 0.01 ? `blur(${(8 * dp).toFixed(2)}px)` : 'none';
    fadeUp($('#w1'), t, B.line1 - 0.1, 0.6, 20);
    fadeUp($('#w2'), t, B.line2 - 0.1, 0.6, 20);
    const tp = P(t, B.trust, B.trust + 0.5, eo);
    $('#wTrust').style.color = tp > 0.01 ? `rgb(${lerp(255, 94, tp)},${lerp(255, 162, tp)},255)` : '#fff';
    $('#wLine').style.transform = `scaleX(${tp})`;
  };

  // ===== Scene 5 - Zen appears
  const G5 = group('g5', 67.9, 76.4, 0, 0.05, `
    <div class="black"></div><div class="glow" id="zGlow"></div>
    <div class="abs" id="zMark" style="left:870px;top:250px;width:180px;height:180px">${zenMark(180)}</div>
    <div class="wordmark" id="zWord" style="top:470px;font-size:150px;line-height:1">ZEN</div>
    <div class="tagline" id="zTag" style="top:690px">The autonomous enterprise migration agent.</div>`);
  G5.upd = (t) => {
    const g = P(t, B.zen - 0.2, B.zen + 2.4, eo);
    tf($('#zGlow'), g * (0.85 + 0.15 * Math.sin(t * 1.3)), 0, 0, 0.6 + 0.4 * g);
    const d = P(t, B.zen, B.zen + 1.5, eio);
    const zm = $('#zMark');
    $('.zr', zm).setAttribute('stroke-dashoffset', String(250 * (1 - d)));
    $('.zd', zm).style.opacity = P(t, B.zen + 0.9, B.zen + 1.4);
    zm.style.opacity = d > 0 ? 1 : 0;
    const w = P(t, B.zen + 0.3, B.zen + 1.6, eo);
    const zw = $('#zWord');
    zw.style.opacity = w;
    zw.style.letterSpacing = lerp(70, 34, w) + 'px';
    zw.style.textIndent = lerp(70, 34, w) + 'px';
    fadeUp($('#zTag'), t, B.tagline - 0.1, 0.8, 18);
    const out = P(t, 75.5, 76.4);
    $('.black', G5.el).style.opacity = 1;
    [zm, zw, $('#zTag')].forEach((el) => { if (out > 0) el.style.opacity = +el.style.opacity * (1 - out); });
  };

  // ===== Zen workspace (scenes 6-10)
  const steps = ['Goal', 'Discover', 'Map', 'Test', 'Migrate', 'Reconcile'];
  const stepAct = [75, 92.6, 97.8, 108.8, B.start + 0.2, B.complete];
  const stepDone = [B.understood + 0.6, 97.8, 106.4, B.ready, B.complete, B.reconciled + 1.5];
  const sideItems = [['goal', 'Goal'], ['discover', 'Discover'], ['map', 'Map'], ['test', 'Test'], ['migrate', 'Migrate'], ['reconcile', 'Reconcile'], ['review', 'Human review']];
  const mapRows = [
    ['displayName', 'name', 'direct', 'grey', 99], ['email', 'email', 'direct', 'grey', 100], ['department', 'department', 'value map', 'blue', 97],
    ['title', 'job_title', 'direct', 'grey', 96], ['summary', 'subject', 'direct', 'grey', 99], ['customer', 'requester', 'lookup', 'teal', 98],
  ];
  const ent = (id, sys, name, fields, count, x, y) => `<div class="box ent" id="${id}" style="left:${x}px;top:${y}px;height:118px">
      <span class="chip ${sys === 'JSM' ? 'blue' : 'green'}" style="font-size:13px;padding:3px 10px">${sys}</span><div class="en">${name}</div>
      <div class="cnt"><span class="fcnt" data-n="${count[0]}">0</span> fields · ${count[1]}</div>
      <div class="fc">${fields.map((f) => `<span class="mono">${f}</span>`).join('')}</div></div>`;
  const checks = [['Field mapping', '42 / 42 mapped'], ['Required fields', 'All present'], ['Workspace mapping', 'IT → IT workspace'], ['Test migration', '100 records'], ['Critical errors', '0']];
  const mini = (id, v, k, x, color) => `<div class="mini" id="${id}"><div class="v" style="color:${color}">${v}</div><div class="k">${k}</div><div class="x">${x}</div></div>`;
  const ring = (id, r, sw, size) => `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1D6BF3"/><stop offset="1" stop-color="#12B5A6"/></linearGradient></defs><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#EEF1F6" stroke-width="${sw}"/><circle id="${id}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id}g)" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * r).toFixed(1)}" stroke-dashoffset="${(2 * Math.PI * r).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  const btnS = 'height:38px;font-size:15px;padding:0 12px;border-radius:10px';
  const MSGS = [
    { at: B.send, who: 'u', text: 'Migrate all employees and tickets from Jira Service Management to Freshservice.' },
    { typing: [B.send + 0.2, B.understood] },
    { at: B.understood, who: 'z', text: 'Goal understood.', cue: 12 },
    { at: 84.8, who: 'z', text: 'Source: Jira Service Management. Target: Freshservice. Entities: employees → requesters, tickets → tickets.' },
    { at: B.work + 0.3, who: 'z', text: 'I’ll discover both schemas, map every field and test on a sample before migrating anything.' },
    { at: 94.8, who: 'z', text: 'Discovered 2 entities and 42 fields in Jira Service Management, plus their Freshservice counterparts.' },
    { at: B.mappings + 3.2, who: 'z', text: 'Mapped 42 fields: 36 high-confidence, 5 medium. accountId is kept as an external reference. Priority “Highest” → Urgent.' },
    { at: 109.4, who: 'z', text: 'Running a test migration on 100 sample records. Notifications and workflows are paused.' },
    { at: B.ready, who: 'z', cls: 'g', text: 'Migration is ready. Readiness 96%, zero critical errors.', cue: 17 },
    { at: B.start + 0.3, who: 's', text: 'Full migration started · 10,000 records' },
    { at: B.diagnosing, who: 'z', cls: 'a', text: 'SR-10482: requester not found. Diagnosing…' },
    { at: B.resolved, who: 'z', cls: 'g', text: 'Resolved: verified email match j.alvarez@contoso.com.' },
    { at: B.review, who: 'z', cls: 'a', text: 'SR-11907 can’t be safely resolved: two plausible requesters. Human review required.' },
    { at: B.fixes + 0.4, who: 'z', text: 'SR-11907 is parked in the review queue. Everything else continues.' },
    { at: B.complete, who: 's', text: 'Migration complete · 10,000 records reconciled' },
    { at: B.ask, who: 'u', text: 'Zen, what went wrong?', cue: 23 },
    { at: B.answer, who: 'z', tag: 'Insight · Claude', text: 'The primary issue was missing requester information. I automatically resolved records where a reliable requester match was found. 70 records require human review.', cue: 24 },
  ];
  const msgHTML = (m) => {
    if (m.typing) return '<div class="mw"><div class="m z"><div class="av" style="background:linear-gradient(135deg,#3B82F6,#14B8A6)">' + zenAv + '</div><div class="bb dots3"><i></i><i></i><i></i></div></div></div>';
    if (m.who === 's') return `<div class="mw"><div class="m s"><div class="bb">${m.text}</div></div></div>`;
    const av = m.who === 'z' ? `<div class="av" style="background:linear-gradient(135deg,#3B82F6,#14B8A6)">${zenAv}</div>` : '<div class="av" style="background:#23324F">MI</div>';
    const tag = m.tag ? `<div style="font-size:11.5px;font-weight:700;letter-spacing:1.2px;color:#8A97AD;margin-bottom:6px;text-transform:uppercase">${m.tag}</div>` : '';
    return `<div class="mw"><div class="m ${m.who}">${av}<div class="bb ${m.cls || ''}">${tag}<span class="sv"></span><span class="sh" style="visibility:hidden">${m.text}</span>${m.extra || ''}</div></div></div>`;
  };
  const GZ = group('gz', 75.7, 167.1, 0.7, 0.05, `
    <div class="zbg"><div class="blob" style="left:-200px;top:-200px;width:900px;height:900px;background:#CFE0FB"></div><div class="blob" style="left:1300px;top:500px;width:900px;height:900px;background:#CDEFEA"></div></div>
    <div class="cam" id="zcam"><div class="zwin" id="zwin">
      <div class="ztb"><div class="brand">${zenMark(28)}ZEN</div><div class="ctx">Workspace <b>Contoso IT</b> &nbsp;·&nbsp; Project <b>JSM → Freshservice</b></div>
        <span class="chip grey" id="zstat" style="margin-left:auto">Awaiting goal</span><div class="me" style="margin-left:14px">MI</div></div>
      <div class="zbody">
        <div class="zside">${sideItems.map(([k, l]) => `<div class="it" data-k="${k}"><i></i>${l}${k === 'review' ? '<span class="badge" id="zbadge">0</span>' : ''}</div>`).join('')}
          <div class="guard"><b>${I.shield('#12A36B', 15)} Guardrails</b>Notifications paused<br>Workflows sandboxed<br>Every change logged &amp; reversible</div></div>
        <div class="zmain">
          <div class="stepper">${steps.map((s, i) => `${i ? '<div class="sline"><i></i></div>' : ''}<div class="step"><span class="dot">${i + 1}</span>${s}</div>`).join('')}</div>

          <div class="view" id="vEmpty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
            ${zenMark(84)}
            <div style="font-size:34px;font-weight:700;letter-spacing:-.5px;margin-top:22px">What should Zen migrate?</div>
            <div style="font-size:18px;color:#6B7A93;margin-top:10px;max-width:640px;line-height:1.5">Describe the goal. Zen plans, tests and executes the migration, and asks you when judgment is required.</div>
            <div style="display:flex;gap:10px;margin-top:28px"><span class="chip grey">ServiceNow → Freshservice</span><span class="chip grey">Zendesk → Freshservice</span><span class="chip grey" id="sugg">Jira Service Management → Freshservice</span></div>
          </div>

          <div class="view" id="vPlan">
            <div class="vh">Migration plan</div><div class="vs">Built from your goal · nothing is migrated until the test passes</div>
            <div class="box" id="pBox1" style="left:0;right:0;top:78px;height:118px;padding:18px 26px"><div class="lbl">Systems</div>
              <div style="display:flex;align-items:center;gap:34px;margin-top:12px">
                <div class="sys" id="pSrc"><div class="lg jsm"><i></i></div><div><b>Jira Service Management</b><span>Source · contoso.atlassian.net</span></div></div>
                <div id="pArr">${I.arrow('#1D6BF3', 34)}</div>
                <div class="sys" id="pTgt"><div class="lg fs"><i></i></div><div><b>Freshservice</b><span>Target · contoso.freshservice.com</span></div></div></div></div>
            <div class="box" id="pBox2" style="left:0;right:0;top:210px;height:176px;padding:18px 26px"><div class="lbl">Entities</div>
              <div class="prow" id="pE1" style="margin-top:12px;padding:11px 18px"><b style="font-weight:650">Customers / Employees</b>${I.arrow()}<span>Requesters</span><span class="d">4,212 records</span></div>
              <div class="prow" id="pE2" style="padding:11px 18px"><b style="font-weight:650">Tickets</b>${I.arrow()}<span>Tickets</span><span class="d">5,788 records</span></div></div>
            <div class="box" id="pBox3" style="left:0;right:0;top:400px;height:304px;padding:18px 26px"><div class="lbl">Plan</div>
              ${['Discover schemas and fields', 'Map fields and values', 'Test migration on a 100-record sample', 'Migrate with live monitoring', 'Reconcile and explain the results'].map((s, i) => `<div class="prow pst" style="padding:6px 14px;margin:${i ? 6 : 12}px 0 0;font-size:17px"><span class="n" style="width:26px;height:26px;font-size:13px">${i + 1}</span>${s}<span class="d">${i === 3 ? 'automatic · escalates exceptions' : i === 2 ? 'gate before go' : 'automatic'}</span></div>`).join('')}</div>
          </div>

          <div class="view" id="vMap">
            <div class="vh">Schema discovery &amp; field mapping</div><div class="vs">Jira Service Management → Freshservice</div>
            ${ent('eS1', 'JSM', 'Customers', ['displayName', 'email', 'department', '+11'], [14, '4,212 records'], 0, 78)}
            ${ent('eS2', 'JSM', 'Tickets', ['summary', 'customer', 'priority', '+25'], [28, '5,788 records'], 0, 206)}
            ${ent('eT1', 'Freshservice', 'Requesters', ['name', 'email', 'job_title', '+21'], [24, 'target'], 578, 78)}
            ${ent('eT2', 'Freshservice', 'Tickets', ['subject', 'requester', 'priority', '+28'], [31, 'target'], 578, 206)}
            <svg id="mapLinks" style="position:absolute;left:0;top:78px;overflow:visible" width="958" height="250">
              <path id="lk1" d="M380,59 C470,59 488,59 578,59" stroke="#1D6BF3" stroke-width="3" fill="none" stroke-dasharray="200" stroke-dashoffset="200"/>
              <path id="lk2" d="M380,187 C470,187 488,187 578,187" stroke="#1D6BF3" stroke-width="3" fill="none" stroke-dasharray="200" stroke-dashoffset="200"/>
              <circle id="lkd1" cx="0" cy="59" r="6" fill="#1D6BF3"/><circle id="lkd2" cx="0" cy="187" r="6" fill="#1D6BF3"/></svg>
            <div id="scan" style="position:absolute;left:-10px;right:-10px;height:3px;border-radius:2px;background:linear-gradient(90deg,transparent,#1D6BF3,#12B5A6,transparent);box-shadow:0 0 18px rgba(29,107,243,.6)"></div>
            <div class="box" id="mapTbl" style="left:0;right:0;top:338px;height:366px;overflow:hidden">
              <div class="mrow h"><div>JSM field</div><div></div><div>Freshservice field</div><div>Rule</div><div>Confidence</div><div></div></div>
              ${mapRows.map((r) => `<div class="mrow mr" style="height:46px"><div class="src mono">${r[0]}</div><div class="ar">→</div><div class="dst mono">${r[1]}</div><div><span class="chip ${r[3]}" style="font-size:14px;padding:4px 12px">${r[2]}</span></div><div class="conf"><div class="cb"><i style="width:0"></i></div><span>${r[4]}%</span></div><div class="ok">${okc(24, 13)}</div></div>`).join('')}
              <div id="mapFoot" style="position:absolute;left:18px;right:18px;bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:nowrap">
                <span class="chip green" style="font-size:14px">42 fields mapped</span><span class="chip grey" style="font-size:14px">36 high confidence</span><span class="chip grey" style="font-size:14px">5 medium</span><span class="chip amber" style="font-size:14px">accountId → external ID</span><span class="chip blue" style="font-size:14px">priority “Highest” → Urgent</span></div>
            </div>
          </div>

          <div class="view" id="vTest">
            <div class="vh">Test migration</div><div class="vs">100-record sample · sandboxed · notifications and workflows paused</div>
            <div class="box" style="left:0;top:78px;width:330px;height:292px"><div style="position:absolute;left:55px;top:26px">${ring('tRing', 96, 18, 220)}</div>
              <div style="position:absolute;left:0;right:0;top:104px;text-align:center"><div id="tPct" style="font-size:54px;font-weight:750;letter-spacing:-1px">0%</div><div style="font-size:15px;color:#6B7A93;font-weight:600">Migration readiness</div></div></div>
            <div class="box checks" style="left:350px;right:0;top:78px;height:292px;padding:8px 26px">
              ${checks.map(([k, r]) => `<div class="ck"><span class="cko">${okc(26, 14)}</span><span>${k}</span><span class="r">${r}</span></div>`).join('')}</div>
            <div class="box" style="left:0;right:0;top:388px;height:86px;padding:16px 24px">
              <div style="display:flex;align-items:baseline;gap:12px"><span class="lbl">Test run</span><span id="tCnt" style="font-size:17px;font-weight:650;font-variant-numeric:tabular-nums">0 / 100 records</span><span id="tState" style="margin-left:auto;font-size:15px;color:#6B7A93">Running in sandbox…</span></div>
              <div class="pbar" style="margin-top:12px"><i id="tBar"></i></div></div>
            <div style="position:absolute;left:0;right:0;top:490px;height:120px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
              ${mini('tm1', '0', 'Successful', 'Migrated and validated', '#13804A')}${mini('tm2', '0', 'Automatically remediated', 'Email match · department normalized', '#0B8C80')}${mini('tm3', '0', 'Critical errors', 'Nothing blocking go-live', '#0B1B33')}</div>
            <div class="ready" id="readyBan" style="top:626px;height:78px">${okc(40, 22)}<div><b>Migration is ready</b><br><span>Readiness 96% · 0 critical errors · 2 records auto-remediated</span></div><div class="btn pri" id="startBtn" style="margin-left:auto">Start full migration</div></div>
          </div>

          <div class="view" id="vRun">
            <div class="vh">Full migration</div><div class="vs">10,000 records · Jira Service Management → Freshservice</div>
            <div class="box" style="left:0;right:0;top:78px;height:128px;padding:18px 24px">
              <div style="display:flex;align-items:baseline;gap:12px"><span class="lbl">Progress</span><span id="rCount" style="font-size:30px;font-weight:750;font-variant-numeric:tabular-nums">0</span><span style="color:#6B7A93;font-size:18px">/ 10,000 records</span><span id="rPct" style="margin-left:auto;font-size:24px;font-weight:700;color:#1B5FD6;font-variant-numeric:tabular-nums">0%</span></div>
              <div class="pbar" style="margin-top:12px;height:16px"><i id="rBar"></i></div>
              <div id="rMeta" style="margin-top:10px;font-size:14px;color:#6B7A93">Elapsed 0m · 89 records/min</div></div>
            <div style="position:absolute;left:0;right:0;top:220px;height:116px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
              ${mini('rm1', '0', 'Successful', 'First-pass migrated', '#13804A')}${mini('rm2', '0', 'Automatically remediated', 'Fixed safely, then retried', '#0B8C80')}${mini('rm3', '0', 'Human review', 'Needs a person’s judgment', '#A76A00')}</div>
            <div class="box" style="left:0;top:346px;width:470px;height:358px;overflow:hidden"><div class="lbl" style="padding:16px 18px 0">Live activity</div>
              <div class="feed" id="feed" style="position:absolute;left:0;right:0;top:44px;bottom:0;-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 30px)">${Array.from({ length: 10 }, () => '<div class="frow" style="position:absolute;left:0;right:0;top:0"></div>').join('')}</div></div>
            <div class="box" id="diag" style="left:488px;right:0;top:346px;height:358px;overflow:hidden">
              <div class="pane" id="d0" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;background:#fff">${I.shield('#12A36B', 44)}<div style="font-size:20px;font-weight:650;margin-top:12px">No exceptions</div><div style="font-size:15px;color:#6B7A93;margin-top:6px;line-height:1.45">Zen diagnoses failures as they happen and fixes what it safely can.</div></div>
              <div class="pane" id="dA" style="position:absolute;inset:0;padding:18px 20px;background:#fff">
                <div style="display:flex;align-items:center;gap:10px"><span class="chip amber" id="dAchip">${I.search('#A76A00', 13)} Diagnosing</span><span class="mono" style="font-size:15px;color:#42526E">SR-10482</span></div>
                <div style="font-size:19px;font-weight:650;margin-top:12px">Requester not found</div>
                <div class="mono" style="font-size:14px;color:#6B7A93;margin-top:4px">J.Alvarez@Contoso.com</div>
                <div style="margin-top:10px">
                  <div class="dstep" id="ds1"><span class="si" style="background:#EEF1F6">${I.search('#4A5B78', 12)}</span>Search requesters by email<span class="rs" style="color:#6B7A93">No exact match</span></div>
                  <div class="dstep" id="ds2"><span class="si" style="background:#EEF1F6">${I.search('#4A5B78', 12)}</span>Normalize and match existing requesters<span class="rs" style="color:#13804A">1 match</span></div>
                  <div class="dstep" id="ds3"><span class="si" style="background:#E6F6EE">${I.check('#13804A', 12)}</span>Verify identity and department<span class="rs" style="color:#13804A">Verified</span></div></div>
                <div id="dsRes" style="margin-top:12px;padding:12px 14px;border-radius:12px;background:#E9F7EF;color:#0E6B3D;font-weight:650;font-size:16px;display:flex;gap:10px;align-items:center">${okc(24, 13)} Resolved · linked to j.alvarez@contoso.com</div></div>
              <div class="pane" id="dB" style="position:absolute;inset:0;padding:18px 20px;background:#fff">
                <div style="display:flex;align-items:center;gap:10px"><span class="chip red">${I.warn('#C2343B', 13)} Human review required</span><span class="mono" style="font-size:15px;color:#42526E">SR-11907</span></div>
                <div style="font-size:15.5px;color:#42526E;margin-top:12px;line-height:1.45">No verified match for <span class="mono" style="font-size:14px">p.nair@contoso-partners.com</span>. Two requesters are plausible:</div>
                <div class="cand"><span class="rb"></span><b style="font-weight:600">Priya Nair</b><span class="mono" style="font-size:13px;color:#6B7A93">priya.nair@contoso.com</span><span class="cs">61%</span></div>
                <div class="cand"><span class="rb"></span><b style="font-weight:600">Priya Natarajan</b><span class="mono" style="font-size:13px;color:#6B7A93">p.natarajan@contoso.com</span><span class="cs">58%</span></div>
                <div style="font-size:13.5px;color:#A76A00;margin-top:10px">Below the 95% confidence required for automatic remediation.</div>
                <div style="display:flex;gap:8px;margin-top:12px"><span class="btn pri" style="${btnS}">Approve &amp; Retry</span><span class="btn sec" style="${btnS}">Skip Record</span><span class="btn dng" style="${btnS}">Stop Migration</span></div>
                <div id="parked" style="margin-top:12px;font-size:14px;color:#4A5B78;display:flex;gap:8px;align-items:center">${I.clock('#4A5B78')} Parked in review queue · migration continues</div></div>
            </div>
          </div>

          <div class="view" id="vDone">
            <div style="display:flex;align-items:center;gap:14px">${okc(34, 18)}<div class="vh">Migration complete</div></div>
            <div class="vs">Reconciled · Jira Service Management → Freshservice · 1h 52m</div>
            <div class="box" style="left:0;top:86px;width:300px;height:290px"><div style="position:absolute;left:40px;top:14px">${ring('dRing', 100, 18, 220)}</div>
              <div style="position:absolute;left:0;right:0;top:92px;text-align:center"><div id="dPct" style="font-size:50px;font-weight:750;letter-spacing:-1px">0%</div><div style="font-size:14px;color:#6B7A93;font-weight:600">first-pass success</div></div>
              <div style="position:absolute;left:0;right:0;top:248px;text-align:center;font-size:15px;font-weight:650;color:#0B8C80">99.3% migrated after remediation</div></div>
            <div style="position:absolute;left:318px;right:0;top:86px;height:290px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:14px">
              ${mini('dm1', '0', 'Records', 'Customers and tickets', '#0B1B33')}${mini('dm2', '0', 'Successful', 'First-pass migrated', '#13804A')}${mini('dm3', '0', 'Automatically remediated', 'Verified email match · department normalized', '#0B8C80')}${mini('dm4', '0', 'Human review', 'No reliable requester match', '#A76A00')}</div>
            <div class="box" style="left:0;right:0;top:394px;height:310px;padding:18px 24px"><div class="lbl">Reconciliation</div>
              <div class="bar2" style="margin-top:12px;height:18px"><i id="db1" style="background:#12A36B"></i><i id="db2" style="background:#12B5A6"></i><i id="db3" style="background:#E8A317"></i></div>
              ${[['Requester matched by verified email', '212', 'teal', 'auto-fixed'], ['Department value normalized', '68', 'teal', 'auto-fixed'], ['Ambiguous requester, no reliable match', '70', 'amber', 'human review'], ['Critical errors', '0', 'green', 'none']].map((r) => `<div class="reason rs10" style="font-size:18px"><span>${r[0]}</span><span style="display:flex;gap:14px;align-items:center"><b>${r[1]}</b><span class="chip ${r[2]}" style="font-size:13px;width:120px;justify-content:center">${r[3]}</span></span></div>`).join('')}
            </div>
          </div>
        </div>
        <div class="zchat">
          <div class="zc-h"><div id="zAv" style="position:relative;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#3B82F6,#14B8A6);display:grid;place-items:center">${zenAv}<div id="zHalo" style="position:absolute;inset:-6px;border-radius:50%;border:3px solid rgba(29,107,243,.4);opacity:0"></div></div>
            <div><b>Zen</b><div style="font-size:13px;color:#6B7A93">Migration agent · insights by Claude</div></div><div class="stt"><i></i>Online</div></div>
          <div class="msgs" id="msgs">${MSGS.map(msgHTML).join('')}</div>
          <div class="zin" id="zin"><div class="tx" id="zinTx"></div><div class="send" id="sendBtn">${I.send()}</div></div>
        </div>
      </div>
      <svg class="cursor" id="cur" viewBox="0 0 30 40"><path d="M3 2 L3 30 L10 23 L15 35 L20 33 L15 21 L25 21 Z" fill="#fff" stroke="#0B1B33" stroke-width="2" stroke-linejoin="round"/></svg>
      <div id="ripple" style="position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #1D6BF3;opacity:0;z-index:49"></div>
    </div></div>
    <div class="calltile" id="ctMaya" style="left:40px;top:684px;width:300px;height:196px;background:${tileBg.maya}"><div class="abs" id="a_maya5" style="left:55px;top:4px;width:190px"></div><div class="nm">Maya Iyer</div><div class="ring"></div></div>`);
  mount($('#a_maya5'), 'maya', GZ, {
    mood: [[0, 'thinking'], [B.fixes, 'focused'], [B.fixes + 3.2, 'confident']],
    look: [[0, 0.5, 0.3], [B.fixes, 0.7, 0.1], [B.fixes + 3.2, 0.2, 0]],
    tilt: [[0, 0, 2], [B.fixes + 1, 1, 5], [B.fixes + 1.6, 1, 0]],
  });
  const ZCAM = [
    [75.7, 0, 960, 540, 1.0], [B.typeStart - 0.7, 1.3, 1560, 760, 1.42], [B.understood + 0.1, 1.2, 1300, 520, 1.1], [84.4, 1.4, 820, 500, 1.16],
    [91.4, 1.2, 960, 540, 1.0], [92.8, 1.2, 820, 420, 1.16], [B.mappings - 0.8, 1.4, 820, 650, 1.16], [105.8, 1.4, 960, 540, 1.0],
    [109.0, 1.2, 820, 480, 1.12], [B.n98 - 0.9, 1.2, 820, 720, 1.18], [B.ready - 0.3, 1.0, 900, 750, 1.1], [126.2, 1.3, 960, 560, 1.0],
    [B.start + 0.6, 1.2, 820, 440, 1.1], [B.err - 0.3, 1.2, 830, 660, 1.2], [B.review - 0.2, 1.0, 1040, 690, 1.2], [B.hide + 0.8, 1.8, 960, 560, 1.02],
    [B.complete + 0.2, 1.0, 820, 470, 1.1], [B.answer - 0.4, 1.2, 1420, 560, 1.22], [B.answer70 - 0.7, 1.3, 960, 540, 1.0],
  ];
  const ZST = [[0, 'Awaiting goal', 'grey'], [B.understood, 'Planning', 'blue'], [92.6, 'Discovering', 'blue'], [97.8, 'Mapping', 'blue'], [108.8, 'Testing', 'blue'], [B.ready, 'Ready to migrate', 'green'],
    [B.start + 0.2, 'Migrating', 'blue'], [B.review, 'Migrating · # in review', 'amber'], [B.complete, 'Complete · reconciled', 'green']];
  const ZSIDE = [[0, 'goal'], [92.6, 'discover'], [97.8, 'map'], [108.8, 'test'], [B.start + 0.2, 'migrate'], [B.review, 'review'], [B.fixes, 'migrate'], [B.complete, 'reconcile']];
  const VIEWS = [['vEmpty', 0, B.understood + 0.2], ['vPlan', B.understood + 0.2, 92.6], ['vMap', 92.6, 108.8], ['vTest', 108.8, B.start + 0.25], ['vRun', B.start + 0.25, B.complete], ['vDone', B.complete, 999]];
  const at = (list, t) => { let v = list[0]; for (const x of list) if (x[0] <= t) v = x; return v; };

  // live feed
  const R0 = B.start + 0.45;
  const FT = [];
  for (let x = R0; x < B.err - 0.12; x += 1 / 4.2) FT.push(x);
  const kE = FT.length; FT.push(B.err);
  for (let x = B.err + 1.9; x < B.review - 0.5; x += 2.1) FT.push(x);
  const kR = FT.length; FT.push(B.review);
  for (let x = B.review + 1.6; x < 141.4; x += 0.9) FT.push(x);
  for (let x = 141.4; x < B.complete - 0.3; x += 1 / 5.5) FT.push(x);
  const FEED = (() => {
    const r = rng(99), rows = [];
    const who = ['A. Chen', 'M. Okafor', 'S. Patel', 'L. Novak', 'R. Silva', 'K. Tanaka', 'D. Mensah', 'E. Rossi', 'F. Haddad', 'G. Kim', 'H. Olsen', 'I. Duarte'];
    for (let k = 0; k < FT.length; k++) {
      if (k % 9 === 5) rows.push(['f', '↻', 'SR-' + (10300 + k * 7), r() < 0.5 ? 'Auto-remediated · requester matched by verified email' : 'Auto-remediated · department “IT Ops” → IT Operations']);
      else if (r() < 0.42) rows.push(['', '✓', 'REQ-' + (4100 + k * 3), 'Requester created · ' + who[k % who.length]]);
      else rows.push(['', '✓', 'SR-' + (10300 + k * 7), 'Ticket migrated · requester linked · SLA kept']);
    }
    return rows;
  })();
  const FCOL = { '': '#12A36B', f: '#0B8C80', e: '#C2343B', w: '#A76A00' };
  const feedRow = (k, t) => {
    if (k === kE) return t < B.resolved ? ['e', '✕', 'SR-10482', 'Requester not found · J.Alvarez@Contoso.com'] : ['f', '✓', 'SR-10482', 'Resolved · verified email match'];
    if (k === kR) return ['w', '!', 'SR-11907', 'Parked for human review · ambiguous requester'];
    return FEED[k];
  };
  function runStats(t) {
    const a = R0, b = B.complete - 0.3;
    if (t >= b) return [10000, 9650, 280, 70];
    const p = clamp((t - a) / (b - a));
    const proc = Math.round(10000 * (p * p * (3 - 2 * p) * 0.35 + p * 0.65));
    const rem = Math.round(280 * Math.pow(clamp((t - a - 0.8) / (b - a - 0.8)), 1.05));
    const rev = t < B.review ? 0 : Math.round(1 + 69 * Math.pow(clamp((t - B.review - 1.5) / (b - B.review - 1.5)), 1.2));
    return [proc, Math.max(0, proc - rem - rev), rem, rev];
  }

  // chat bookkeeping (heights measured once fonts are ready)
  const mws = $$('.mw', GZ.el);
  const pos = {};
  function measure() {
    mws.forEach((el) => { el.__h = el.scrollHeight; el.style.height = '0px'; });
    const zr = $('#zwin').getBoundingClientRect();
    for (const id of ['sendBtn', 'startBtn']) { const r = $('#' + id).getBoundingClientRect(); pos[id] = [r.left - zr.left + r.width / 2, r.top - zr.top + r.height / 2]; }
  }
  const streamDur = (m) => (m.cue !== undefined ? TM[m.cue].dur : clamp(m.text.length / 55, 0.6, 2.2));

  GZ.upd = (t) => {
    const [cx, cy, z] = camAt(ZCAM, t);
    setCam($('#zcam'), cx, cy, z, [40, -4, 1880, 960]);
    const ein = P(t, 75.7, 76.9, eo);
    $('#zwin').style.transform = `translateY(${(1 - ein) * 40}px) scale(${0.965 + 0.035 * ein})`;

    const stats = runStats(t);
    const st = at(ZST, t);
    setText($('#zstat'), st[1].replace('#', fmt(stats[3])));
    setCls($('#zstat'), 'chip ' + st[2]);
    const side = at(ZSIDE, t)[1];
    $$('.zside .it', GZ.el).forEach((el) => setCls(el, 'it' + (el.dataset.k === side ? ' on' : '')));
    const badge = $('#zbadge');
    setText(badge, String(stats[3]));
    badge.style.opacity = stats[3] > 0 ? 1 : 0;

    const stepEls = $$('.step', GZ.el), lines = $$('.sline i', GZ.el);
    stepEls.forEach((el, i) => {
      const s = t >= stepDone[i] ? 'done' : t >= stepAct[i] ? 'act' : '';
      setCls(el, 'step ' + s);
      setHTML($('.dot', el), s === 'done' ? I.check('#fff', 14) : String(i + 1));
    });
    lines.forEach((el, i) => { el.style.width = 100 * P(t, stepDone[i], stepDone[i] + 0.6) + '%'; });

    for (const [id, a, b] of VIEWS) {
      const el = $('#' + id);
      const o = id === 'vEmpty' ? (t < b ? 1 : clamp(1 - (t - b) / 0.35)) : win(t, a, b, 0.45, 0.3);
      el.style.visibility = o > 0 ? 'visible' : 'hidden';
      tf(el, o, 0, (1 - o) * 14);
    }

    // goal / empty state
    const sg = $('#sugg');
    setCls(sg, 'chip ' + (t > B.typeStart + 1.2 ? 'blue' : 'grey'));

    // plan
    if (t > B.understood && t < 93.5) {
      fadeUp($('#pBox1'), t, B.understood + 0.3, 0.5); fadeUp($('#pBox2'), t, B.understood + 0.5, 0.5); fadeUp($('#pBox3'), t, B.understood + 0.7, 0.5);
      popIn($('#pSrc'), t, 84.3, 0.5); tf($('#pArr'), P(t, 84.8, 85.3), (1 - P(t, 84.8, 85.3)) * -16, 0); popIn($('#pTgt'), t, 85.0, 0.5);
      fadeUp($('#pE1'), t, 85.7, 0.45, 10); fadeUp($('#pE2'), t, 86.1, 0.45, 10);
      $$('.pst', GZ.el).forEach((el, i) => fadeUp(el, t, 86.8 + i * 0.32, 0.4, 10));
      const hl = (el, b0) => { const p = win(t, b0 - 0.1, b0 + 1.4, 0.25, 0.5); el.style.boxShadow = `0 0 0 ${3 * p}px rgba(29,107,243,${0.35 * p})`; };
      hl($('#pSrc').closest('.box'), B.source); hl($('#pBox2'), B.target + 0.6); hl($('#pBox3'), B.work);
    }

    // mapping
    if (t > 92 && t < 109.5) {
      ['eS1', 'eT1', 'eS2', 'eT2'].forEach((id, i) => {
        const t0 = 92.9 + i * 0.35;
        const el = $('#' + id);
        fadeUp(el, t, t0, 0.45, 12);
        $$('.fc span', el).forEach((s, j) => { s.style.opacity = P(t, t0 + 0.4 + j * 0.18, t0 + 0.7 + j * 0.18); });
        const f = $('.fcnt', el); setText(f, String(Math.round(+f.dataset.n * P(t, t0 + 0.3, t0 + 1.6, eo))));
      });
      const sc = $('#scan');
      sc.style.top = lerp(78, 330, P(t, 92.9, 95.4, (p) => p)) + 'px';
      sc.style.opacity = win(t, 92.9, 95.6, 0.2, 0.4);
      [[1, B.customers], [2, B.tickets]].forEach(([k, b0]) => {
        const p = P(t, b0 - 0.2, b0 + 0.6, eio);
        $('#lk' + k).setAttribute('stroke-dashoffset', String(200 * (1 - p)));
        const d = $('#lkd' + k);
        d.setAttribute('cx', String(380 + 198 * p));
        d.style.opacity = p > 0 && p < 1 ? 1 : 0;
        const tgt = $(k === 1 ? '#eT1' : '#eT2');
        const glow = win(t, b0 + 0.5, b0 + 1.8, 0.2, 0.6);
        tgt.style.boxShadow = `0 0 0 ${3 * glow}px rgba(18,163,107,${0.35 * glow})`;
      });
      fadeUp($('#mapTbl'), t, B.mappings - 1.0, 0.5, 14);
      $$('.mr', GZ.el).forEach((el, i) => {
        const t0 = B.mappings - 0.4 + i * 0.55;
        fadeUp(el, t, t0, 0.35, 8);
        $('.cb i', el).style.width = mapRows[i][4] * P(t, t0 + 0.1, t0 + 0.7, eo) + '%';
        popIn($('.ok', el), t, t0 + 0.55, 0.35);
      });
      fadeUp($('#mapFoot'), t, B.mappings - 0.4 + 6 * 0.55 + 0.4, 0.5, 8);
    }

    // test
    if (t > 108 && t < 129.5) {
      const ringP = P(t, 109.8, B.n98 + 0.5, eio);
      const c = 2 * Math.PI * 96;
      $('#tRing').setAttribute('stroke-dashoffset', String(c * (1 - 0.96 * ringP)));
      setText($('#tPct'), Math.round(96 * ringP) + '%');
      const ckT = [109.9, 110.6, 111.3, 115.4, B.n0 + 0.2];
      $$('.checks .ck', GZ.el).forEach((el, i) => {
        el.style.opacity = 0.35 + 0.65 * P(t, ckT[i] - 0.2, ckT[i]);
        popIn($('.cko', el), t, ckT[i], 0.4);
        $('.r', el).style.opacity = P(t, ckT[i] + 0.1, ckT[i] + 0.4);
      });
      const tp = P(t, 110.2, 115.2, (p) => p);
      $('#tBar').style.width = tp * 100 + '%';
      setText($('#tCnt'), Math.round(tp * 100) + ' / 100 records');
      setText($('#tState'), tp < 1 ? 'Running in sandbox…' : 'Complete · sandbox rolled back');
      const cnt = (id, n, b0) => { const el = $('#' + id); setText($('.v', el), String(Math.round(n * P(t, b0 - 0.2, b0 + 0.6, eo)))); el.style.boxShadow = `0 0 0 ${3 * win(t, b0 - 0.2, b0 + 1.5, 0.2, 0.5)}px rgba(29,107,243,.25)`; };
      cnt('tm1', 98, B.n98); cnt('tm2', 2, B.n2); cnt('tm3', 0, B.n0);
      const rb = clamp((t - B.ready + 0.2) / 0.5);
      tf($('#readyBan'), clamp(rb * 2.5), 0, (1 - eo(rb)) * 20, 0.9 + 0.1 * eback(rb));
      const sb = $('#startBtn');
      const press = win(t, B.start - 0.08, B.start + 0.12, 0.05, 0.1);
      sb.style.transform = `scale(${1 + 0.03 * Math.sin(t * 5) * clamp(t - B.ready - 0.8) * (t < B.start ? 1 : 0) - 0.05 * press})`;
    }

    // run
    if (t > B.start && t < 154) {
      const [proc, succ, rem, rev] = stats;
      setText($('#rCount'), fmt(proc));
      setText($('#rPct'), Math.floor(proc / 100) + '%');
      $('#rBar').style.width = proc / 100 + '%';
      const mins = Math.round((proc / 10000) * 112);
      setText($('#rMeta'), `Elapsed ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m · 89 records/min · notifications paused`);
      setText($('.v', $('#rm1')), fmt(succ)); setText($('.v', $('#rm2')), fmt(rem)); setText($('.v', $('#rm3')), fmt(rev));
      let n = 0;
      while (n < FT.length && FT[n] <= t) n++;
      const sp = n ? P(t, FT[n - 1], FT[n - 1] + 0.22, eo) : 1;
      $$('.frow', $('#feed')).forEach((el, j) => {
        const k = n - 10 + j;
        if (k < 0) { el.style.opacity = 0; return; }
        const row = feedRow(k, t);
        const key = k + row[0];
        if (el.__k !== key) { el.__k = key; el.className = 'frow ' + row[0]; el.innerHTML = `<span class="st" style="color:${FCOL[row[0]]}">${row[1]}</span><span class="ky mono">${row[2]}</span><span class="ms">${row[3]}</span>`; }
        el.style.opacity = 1;
        el.style.transform = `translateY(${(j - 2) * 38 + (1 - sp) * 38}px)`;
      });
      const oA = win(t, B.diagnosing - 0.2, B.review - 0.2, 0.35, 0.3), oB = win(t, B.review - 0.2, 999, 0.35, 0.1);
      $('#d0').style.opacity = 1 - P(t, B.diagnosing - 0.6, B.diagnosing - 0.2);
      tf($('#dA'), oA, (1 - oA) * 24, 0); tf($('#dB'), oB, (1 - oB) * 24, 0);
      const dsT = [B.diagnosing + 0.4, B.diagnosing + 1.4, B.resolved - 0.9];
      ['#ds1', '#ds2', '#ds3'].forEach((s, i) => { const el = $(s); fadeUp(el, t, dsT[i], 0.4, 8); $('.rs', el).style.opacity = P(t, dsT[i] + 0.4, dsT[i] + 0.7); });
      fadeUp($('#dsRes'), t, B.resolved, 0.45, 10);
      setHTML($('#dAchip'), t < B.resolved ? `${I.search('#A76A00', 13)} Diagnosing` : `${I.check('#13804A', 13)} Resolved`);
      setCls($('#dAchip'), 'chip ' + (t < B.resolved ? 'amber' : 'green'));
      $('#diag').style.boxShadow = `0 0 0 ${4 * win(t, B.review, B.review + 2.2, 0.2, 0.8)}px rgba(224,72,79,.28)`;
      fadeUp($('#parked'), t, B.fixes + 0.4, 0.5, 8);
    }

    // done
    if (t > B.complete - 0.5) {
      const dp = P(t, B.complete + 0.2, B.complete + 2.0, eio);
      const c = 2 * Math.PI * 100;
      $('#dRing').setAttribute('stroke-dashoffset', String(c * (1 - 0.965 * dp)));
      setText($('#dPct'), (96.5 * dp).toFixed(1) + '%');
      [['dm1', 10000], ['dm2', 9650], ['dm3', 280], ['dm4', 70]].forEach(([id, v], i) => { setText($('.v', $('#' + id)), fmt(v * P(t, B.complete + 0.3 + i * 0.12, B.complete + 1.8 + i * 0.12, eo))); });
      const bp = P(t, B.complete + 0.6, B.complete + 1.8, eo);
      $('#db1').style.width = 96.5 * bp + '%'; $('#db2').style.width = 2.8 * bp + '%'; $('#db3').style.width = 0.7 * bp + '%';
      $$('.rs10', GZ.el).forEach((el, i) => fadeUp(el, t, B.complete + 0.9 + i * 0.2, 0.4, 8));
      const hl = win(t, B.answer70 - 0.3, B.answer70 + 2.2, 0.3, 0.6);
      $('#dm4').style.boxShadow = `0 0 0 ${4 * hl}px rgba(232,163,23,.35)`;
    }

    // chat
    MSGS.forEach((m, i) => {
      const el = mws[i];
      let p;
      if (m.typing) p = Math.min(P(t, m.typing[0], m.typing[0] + 0.25, eo), 1 - P(t, m.typing[1] - 0.1, m.typing[1] + 0.15));
      else p = P(t, m.at, m.at + 0.35, eo);
      el.style.height = el.__h * p + 'px';
      el.style.opacity = p;
      if (m.typing) { $$('.dots3 i', el).forEach((d, j) => { d.style.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 9 - j * 0.9)); }); return; }
      if (m.who === 's' || p <= 0) return;
      const sv = $('.sv', el), sh = $('.sh', el);
      const n = m.who === 'u' && m.cue === undefined ? m.text.length : Math.round(m.text.length * clamp((t - m.at) / streamDur(m)));
      if (sv.__n !== n) { sv.textContent = m.text.slice(0, n); sh.textContent = m.text.slice(n); sv.__n = n; }
      const mx = $('.mx', el);
      if (mx) mx.style.opacity = P(t, m.at + streamDur(m), m.at + streamDur(m) + 0.4);
    });
    const za = amp('Zen', t);
    $('#zHalo').style.opacity = clamp(za * 1.6);
    $('#zHalo').style.transform = `scale(${1 + za * 0.18})`;

    // composer
    const tx = $('#zinTx');
    if (t >= B.typeStart && t < B.send) {
      const full = MSGS[0].text;
      const n = Math.round(full.length * clamp((t - B.typeStart) / (B.typeEnd - B.typeStart - 0.2)));
      const caret = Math.floor(t * 2.2) % 2 === 0 || n < full.length ? '<span class="caret"></span>' : '';
      setHTML(tx, full.slice(0, n).replace(/&/g, '&amp;') + caret);
      $('#zin').style.borderColor = '#1D6BF3';
    } else {
      setHTML(tx, `<span class="ph">${t < B.typeStart ? 'Describe your migration goal…' : 'Ask Zen anything…'}</span>`);
      $('#zin').style.borderColor = '#CBD3DF';
    }
    const press = win(t, B.send - 0.06, B.send + 0.14, 0.05, 0.12);
    $('#sendBtn').style.transform = `scale(${1 - 0.12 * press})`;

    // cursor
    const cur = $('#cur'), rip = $('#ripple');
    const paths = [
      [B.send - 1.5, B.send + 1.0, [1480, 640], pos.sendBtn, B.send],
      [B.start - 1.8, B.start + 1.0, [760, 560], pos.startBtn, B.start],
    ];
    let shown = false;
    for (const [a, b, from, to, click] of paths) {
      if (t < a || t > b) continue;
      shown = true;
      const p = P(t, a, click - 0.2, eio);
      const x = lerp(from[0], to[0], p) - 4, y = lerp(from[1], to[1], p) + Math.sin(p * Math.PI) * -40 - 2;
      const pr = win(t, click - 0.05, click + 0.12, 0.04, 0.1);
      cur.style.opacity = win(t, a, b, 0.3, 0.3);
      cur.style.transform = `translate(${x}px,${y}px) scale(${1 - 0.15 * pr})`;
      const rp = clamp((t - click) / 0.5);
      rip.style.left = to[0] + 'px'; rip.style.top = to[1] + 'px';
      rip.style.opacity = t >= click ? 0.8 * (1 - rp) : 0;
      rip.style.transform = `scale(${0.4 + rp * 1.2})`;
    }
    if (!shown) { cur.style.opacity = 0; rip.style.opacity = 0; }

    // call tile (Maya reviewing)
    const ms = clamp((t - (B.hide - 0.2)) / 0.6) * (1 - P(t, B.complete - 0.6, B.complete - 0.1));
    tf($('#ctMaya'), clamp(ms * 2), (1 - eo(ms)) * -60, 0);
    $('.ring', $('#ctMaya')).style.opacity = clamp(amp('Maya', t) * 3);
  };

  // ===== Scene 10b - back in the readiness review
  const G10 = group('g10', 166.6, 175.3, 0.5, 0.05, `
    <div class="cam"><div class="meet">
      <div class="top"><span class="rec"></span><b style="font-weight:600">Go-live readiness review</b><span style="color:#9AA5B8">· Contoso × Freshservice</span><span class="tm" id="mtm2">00:06:12</span></div>
      <div class="mtile" id="t2Maya" style="left:60px;top:120px;height:500px;background:${tileBg.maya}"><div class="pw" id="a_maya6" style="bottom:-160px"></div><div class="nm">Maya Iyer</div><div class="ring"></div></div>
      <div class="mtile" id="t2Sarah" style="left:670px;top:120px;height:500px;background:${tileBg.sarah}"><div class="pw" id="a_sarah6" style="bottom:-160px"></div><div class="nm">Sarah Whitfield · VP Business Operations</div><div class="ring"></div></div>
      <div class="mtile" id="t2Rahul" style="left:1280px;top:120px;height:500px;background:${tileBg.rahul}"><div class="pw" id="a_rahul6" style="bottom:-160px"></div><div class="nm">Rahul Menon</div><div class="ring"></div></div>
    </div></div>
    <div class="card" id="zCard" style="left:340px;top:652px;width:1240px;padding:22px 28px">
      <div style="display:flex;align-items:center;gap:16px">
        <div style="width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#3B82F6,#14B8A6);display:grid;place-items:center;flex:none">${zenAv}</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700;letter-spacing:1.4px;color:#8A97AD">ZEN · GO-LIVE READINESS</div>
          <div id="zcText" style="font-size:25px;font-weight:600;margin-top:4px;line-height:1.35"><span class="sv"></span><span class="sh" style="visibility:hidden">The migration is reconciled and the remaining exceptions are clearly identified.</span></div></div>
        <span class="chip green" id="zcOk" style="flex:none">${I.check('#13804A', 13)} Reconciled</span></div>
      <div style="display:flex;gap:10px;margin-top:16px;padding-left:62px">${['green|9,650 successful', 'teal|280 auto-remediated', 'amber|70 in human review', 'grey|0 critical errors'].map((s) => `<span class="chip ${s.split('|')[0]} zc">${s.split('|')[1]}</span>`).join('')}</div>
    </div>`);
  const zText = 'The migration is reconciled and the remaining exceptions are clearly identified.';
  mount($('#a_maya6'), 'maya', G10, { mood: [[0, 'concerned'], [CS(26) + 1.4, 'confident'], [CE(26) - 1.1, 'relieved']], look: [[0, 0.2, 0.1], [CS(26), 0.3, 0.6], [CE(26) - 1.2, 0, 0]], tilt: [[0, 0, 0], [CE(26) - 1.0, -2, 4], [CE(26) - 0.4, -2, 0]] });
  mount($('#a_sarah6'), 'sarah', G10, { mood: [[0, 'neutral'], [CS(25) - 0.2, 'focused'], [CE(26) - 1.4, 'happy']], look: [[0, 0, 0], [CS(26), 0.2, 0.6], [CE(26) - 1.5, 0, 0]], tilt: [[0, 0, 0], [CE(26) - 1.2, 2, 4], [CE(26) - 0.6, 2, 0]] });
  mount($('#a_rahul6'), 'rahul', G10, { mood: [[0, 'focused'], [CS(26) + 2.2, 'confident'], [CE(26) - 0.8, 'happy']], look: [[0, 0, 0.3], [CS(26), -0.2, 0.7], [CE(26) - 1.0, 0, 0]], tilt: [[0, 0, 0], [CE(26) - 0.8, 1, 5], [CE(26) - 0.2, 1, 0]] });
  G10.upd = (t) => {
    const [cx, cy, z] = camAt([[166.6, 0, 960, 520, 1.0], [CS(25) - 0.4, 1.0, 960, 380, 1.14], [CE(25) + 0.3, 1.2, 960, 540, 1.0], [CE(26) - 1.6, 2.8, 960, 470, 1.06]], t);
    setCam($('.cam', G10.el), cx, cy, z);
    const secs = 6 * 60 + 12 + Math.floor(t - 166.6);
    setText($('#mtm2'), `00:${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`);
    [['#t2Maya', 'Maya'], ['#t2Sarah', 'Sarah'], ['#t2Rahul', 'Rahul']].forEach(([s, n]) => { $('.ring', $(s)).style.opacity = clamp(amp(n, t) * 3); });
    fadeUp($('#zCard'), t, CS(26) - 0.4, 0.5, 24);
    const n = Math.round(zText.length * clamp((t - CS(26)) / TM[26].dur));
    const sv = $('#zcText .sv'), sh = $('#zcText .sh');
    if (sv.__n !== n) { sv.textContent = zText.slice(0, n); sh.textContent = zText.slice(n); sv.__n = n; }
    popIn($('#zcOk'), t, CE(26) - 0.3, 0.45);
    $$('.zc', G10.el).forEach((el, i) => fadeUp(el, t, CS(26) + 1.0 + i * 0.3, 0.4, 8));
  };

  // ===== End frame
  const GE = group('gEnd', 174.9, 181, 0.6, 0, `
    <div class="black" style="background:radial-gradient(1200px 800px at 50% 42%, #0F1E3A 0%, #060B16 70%)"></div><div class="glow" id="eGlow" style="top:36%"></div>
    <div class="abs" id="eMark" style="left:900px;top:228px;width:120px;height:120px">${zenMark(120)}</div>
    <div class="wordmark" id="eWord" style="top:372px;font-size:110px;line-height:1;letter-spacing:30px;text-indent:30px">ZEN</div>
    <div class="tagline" id="eLine" style="top:540px">From migration project <span style="color:#5EA2FF;font-weight:600">→</span> migration agent.</div>
    <div class="tagline" style="top:640px;font-size:54px;font-weight:650;color:#fff;letter-spacing:-.5px"><span id="eT1" style="display:inline-block">Give Zen the goal.</span> <span id="eT2" style="display:inline-block;color:#7FD8CB">Let Zen own the migration.</span></div>`);
  GE.upd = (t) => {
    tf($('#eGlow'), P(t, 174.9, 177), 0, 0, 0.8 + 0.2 * P(t, 174.9, 180));
    const d = P(t, 175.0, 176.2);
    $('.zr', $('#eMark')).setAttribute('stroke-dashoffset', String(250 * (1 - d)));
    fadeUp($('#eWord'), t, 175.1, 0.8, 16);
    fadeUp($('#eLine'), t, 175.5, 0.7, 14);
    fadeUp($('#eT1'), t, B.give - 0.05, 0.6, 16);
    fadeUp($('#eT2'), t, B.letZen - 0.05, 0.6, 16);
  };

  // ------------------------------------------------------------ overlays
  stage.appendChild(h('<div id="vignette"></div>'));
  const vig = $('#vignette');
  const capWrap = h('<div id="captions"><div class="cap"></div></div>');
  stage.appendChild(capWrap);
  const cap = capWrap.firstElementChild;
  const fade = h('<div id="fade"></div>'); stage.appendChild(fade);
  const disc = h(`<div id="disc">${SB.disclosure}</div>`); stage.appendChild(disc);
  const CAPCOL = { Maya: '#8DB8FF', Rahul: '#FFCD7A', Sarah: '#FFA3B8', Zen: '#63E6D4' };
  const NOCAP = new Set([10, 26, 27]);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const CAPS = [];
  TM.forEach((c, i) => {
    if (NOCAP.has(i)) return;
    const lines = [];
    for (const s of c.text.split(/(?<=[.?!])\s+/)) {
      if (lines.length && (lines[lines.length - 1] + ' ' + s).length <= 56) lines[lines.length - 1] += ' ' + s; else lines.push(s);
    }
    const words = c.words || [];
    let tokens = 0;
    const segs = lines.map((text, k) => {
      let a = c.start;
      if (k > 0) {
        const first = norm(text.split(/\s+/)[0]);
        const j = words.findIndex((w, n) => n >= tokens - 2 && norm(w.w) && (norm(w.w).startsWith(first) || first.startsWith(norm(w.w))));
        a = j >= 0 ? c.start + words[j].t - 0.08 : c.start + (c.text.indexOf(text) / c.text.length) * c.dur;
      }
      tokens += text.split(/\s+/).length;
      return { i, speaker: c.speaker, text, a };
    });
    segs.forEach((s, k) => { s.b = k + 1 < segs.length ? segs[k + 1].a : c.start + c.dur + 0.35; });
    segs.forEach((s) => { if (i === 9) s.b = Math.min(s.b, B.line1 - 0.15); if (s.b > s.a + 0.2) CAPS.push(s); });
  });
  function updCaptions(t) {
    const s = CAPS.find((x) => t >= x.a - 0.05 && t < x.b);
    if (!s) { cap.style.opacity = 0; return; }
    const c0 = CAPS.find((x) => x.i === s.i);
    const o = Math.min(clamp((t - c0.a + 0.05) / 0.15), clamp((CAPS.filter((x) => x.i === s.i).pop().b - t) / 0.2));
    setHTML(cap, (s.speaker === 'Narrator' ? '' : `<span class="who" style="color:${CAPCOL[s.speaker]}">${s.speaker}</span>`) + s.text);
    cap.style.opacity = o;
  }

  window.renderAt = function (t) {
    for (const g of groups) {
      const o = win(t, g.a, g.b, g.fi, g.fo);
      const vis = o > 0.001;
      if (vis !== g.vis) { g.el.style.visibility = vis ? 'visible' : 'hidden'; g.vis = vis; }
      g.el.style.opacity = o;
      if (vis) g.upd(t);
    }
    for (const A of actors) if (A.g.vis) updActor(A, t);
    vig.style.opacity = 1 - 0.75 * win(t, 76.2, 167.1, 0.6, 0.4);
    updCaptions(t);
    fade.style.opacity = Math.max(1 - clamp(t / 0.9), clamp((t - 179.2) / 0.8));
    disc.style.opacity = win(t, 176.6, 181, 0.6, 0);
  };

  document.fonts.ready.then(() => {
    groups.forEach((g) => { g.el.style.visibility = 'hidden'; });
    measure();
    window.renderAt(0);
    window.__ready = true;
  });
})();
