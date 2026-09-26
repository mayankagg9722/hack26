'use strict';
// Zen story film pipeline: prepare (TTS + score + mix) -> preview (stills) -> render (frames -> mp4) -> verify.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const ROOT = __dirname;
const ASSETS = path.join(ROOT, 'assets');
const VOICE_DIR = path.join(ASSETS, 'voice');
const OUT = path.join(ROOT, 'out');
const SB = JSON.parse(fs.readFileSync(path.join(ROOT, 'storyboard.json'), 'utf8'));
const SR = 48000;
const FPS = SB.fps;
const DUR = SB.duration;
const FINAL = path.join(OUT, 'Zen-Migration-Story.mp4');

const VOICE_FALLBACKS = {
  Narrator: ['en-US-AndrewNeural', 'en-US-AndrewMultilingualNeural', 'en-US-GuyNeural'],
  Maya: ['en-IN-NeerjaNeural', 'en-IN-NeerjaExpressiveNeural', 'en-US-JennyNeural'],
  Rahul: ['en-IN-PrabhatNeural', 'en-US-BrianNeural', 'en-US-GuyNeural'],
  Sarah: ['en-GB-SoniaNeural', 'en-GB-LibbyNeural', 'en-US-AriaNeural'],
  Zen: ['en-US-AvaNeural', 'en-US-AvaMultilingualNeural', 'en-US-EmmaNeural'],
};
const BASE_RATE = { Narrator: -4, Maya: 0, Rahul: -2, Sarah: -3, Zen: -6 };

const mkdir = (d) => fs.mkdirSync(d, { recursive: true });
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const log = (...a) => console.log('[zen-film]', ...a);

// ---------------------------------------------------------------- TTS
async function synth(voice, text, ratePct, dir) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
    const rate = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    return await tts.toFile(dir, text, { rate });
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}

function decode(file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), 'pipe:1'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error('ffmpeg decode failed: ' + r.stderr);
  const b = Buffer.from(r.stdout);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
}

function parseWords(metaFile) {
  if (!metaFile || !fs.existsSync(metaFile)) return [];
  const raw = fs.readFileSync(metaFile, 'utf8');
  const out = [];
  const re = /"Offset"\s*:\s*(\d+)[\s\S]*?"Text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw))) out.push({ w: JSON.parse('"' + m[2] + '"'), t: Number(m[1]) / 1e7 });
  return out;
}

function analyse(pcm) {
  const thr = 0.012;
  let a = 0, b = pcm.length - 1;
  while (a < pcm.length && Math.abs(pcm[a]) < thr) a++;
  while (b > a && Math.abs(pcm[b]) < thr) b--;
  a = Math.max(0, a - Math.round(0.03 * SR));
  b = Math.min(pcm.length - 1, b + Math.round(0.09 * SR));
  const trimmed = pcm.subarray(a, b + 1);
  const hop = SR / FPS;
  const frames = Math.ceil(trimmed.length / hop);
  const rms = [];
  for (let f = 0; f < frames; f++) {
    let s = 0, n = 0;
    const i0 = Math.floor(f * hop), i1 = Math.min(trimmed.length, Math.floor((f + 1) * hop));
    for (let i = i0; i < i1; i++) { s += trimmed[i] * trimmed[i]; n++; }
    rms.push(n ? Math.sqrt(s / n) : 0);
  }
  const sorted = rms.filter((v) => v > 0.004).sort((x, y) => x - y);
  const ref = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 1;
  const amp = rms.map((v) => +clamp(Math.pow(v / ref, 0.8)).toFixed(3));
  return { lead: a / SR, dur: trimmed.length / SR, amp };
}

async function prepareVoices() {
  mkdir(VOICE_DIR);
  const timing = [];
  for (let i = 0; i < SB.cues.length; i++) {
    const cue = SB.cues[i];
    const next = SB.cues[i + 1];
    const limit = Math.min(next ? next.start - 0.25 : DUR - 0.2, Math.max(cue.end, cue.start + 1)) - cue.start;
    const id = String(i).padStart(2, '0');
    const mp3 = path.join(VOICE_DIR, id + '.mp3');
    const metaPath = path.join(VOICE_DIR, id + '.json');
    const voices = [SB.voices[cue.speaker], ...(VOICE_FALLBACKS[cue.speaker] || [])].filter((v, k, arr) => v && arr.indexOf(v) === k);
    let rate = BASE_RATE[cue.speaker] || 0;

    let cached = null;
    if (fs.existsSync(mp3) && fs.existsSync(metaPath)) {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const fits = m.dur <= limit + 0.05 && (m.rate === rate || Math.abs((m.limit ?? -1) - limit) < 0.01);
      if (m.text === cue.text && m.speaker === cue.speaker && fits) cached = m;
    }
    let info;
    if (cached) {
      info = cached;
    } else {
      for (let attempt = 0; attempt < 4; attempt++) {
        const tmp = path.join(VOICE_DIR, 'tmp_' + id);
        mkdir(tmp);
        let res = null, voice = null, lastErr = null;
        for (const v of voices) {
          for (let retry = 0; retry < 3 && !res; retry++) {
            try { res = await synth(v, cue.text, rate, tmp); voice = v; } catch (e) { lastErr = e; }
          }
          if (res) break;
        }
        if (!res) throw new Error(`TTS failed for cue ${i}: ${lastErr && lastErr.message}`);
        const pcm = decode(res.audioFilePath);
        const a = analyse(pcm);
        const words = parseWords(res.metadataFilePath).map((w) => ({ w: w.w, t: +(w.t - a.lead).toFixed(3) }));
        fs.copyFileSync(res.audioFilePath, mp3);
        fs.rmSync(tmp, { recursive: true, force: true });
        info = { speaker: cue.speaker, text: cue.text, voice, rate, limit: +limit.toFixed(3), lead: a.lead, dur: a.dur, words, amp: a.amp };
        if (a.dur <= limit + 0.05 || rate >= 30) break;
        rate = Math.min(30, rate + Math.ceil((a.dur / limit - 1) * 100) + 2);
        log(`cue ${id} ${a.dur.toFixed(2)}s > ${limit.toFixed(2)}s window, retry at rate ${rate}%`);
      }
      fs.writeFileSync(metaPath, JSON.stringify(info));
    }
    if (info.dur > limit + 0.3) log(`WARN cue ${id} (${info.dur.toFixed(2)}s) overruns window ${limit.toFixed(2)}s`);
    log(`voice ${id} ${cue.speaker.padEnd(8)} ${info.voice} rate ${info.rate}% ${info.dur.toFixed(2)}s`);
    timing.push({ speaker: cue.speaker, text: cue.text, start: cue.start, dur: +info.dur.toFixed(3), lead: info.lead, words: info.words, amp: info.amp });
  }
  return timing;
}

// ---------------------------------------------------------------- beats (shared with film.js)
function wordTime(timing, ci, word, nth = 0) {
  const c = timing[ci];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const target = norm(word);
  let k = 0;
  for (const w of c.words || []) {
    if (norm(w.w).startsWith(target)) { if (k === nth) return +(c.start + w.t).toFixed(3); k++; }
  }
  const idx = c.text.toLowerCase().indexOf(word.toLowerCase());
  const frac = idx < 0 ? 0 : idx / c.text.length;
  return +(c.start + frac * c.dur).toFixed(3);
}

function computeBeats(timing) {
  const W = (ci, w, n) => wordTime(timing, ci, w, n);
  const S = (ci) => timing[ci].start;
  const E = (ci) => timing[ci].start + timing[ci].dur;
  return {
    toast: 0.9, golive: W(0, 'Three'), everything: W(1, 'everything'),
    card1: W(5, 'field'), card2: W(5, 'Priorities'), card3: W(5, 'Missing'), card4: W(5, 'suddenly'), notif: W(5, 'thousands'),
    realProblem: S(9), line1: W(9, 'Migration'), line2: W(9, "It's"), trust: W(9, 'trust'),
    zen: S(10), tagline: W(10, 'The'),
    typeStart: S(11), typeEnd: E(11), send: E(11) + 0.15, understood: S(12),
    source: W(13, 'source'), target: W(13, 'target'), work: W(13, 'work'),
    discover: S(14), customers: W(14, 'Customers'), tickets: W(14, 'Tickets'), mappings: W(14, 'Field', 1),
    testFirst: S(15), n98: W(16, 'Ninety'), n2: W(16, 'Two'), n0: W(16, 'Zero'), ready: S(17),
    start: S(18) - 0.5, err: W(18, 'Then'), diagnosing: S(19), resolved: S(20), review: S(21), hide: S(22), fixes: W(22, 'fixes'), human: W(22, 'human'),
    complete: 153.2, ask: S(23), answer: S(24), answer70: W(24, 'Seventy'), sarah: S(25), reconciled: S(26),
    end: 175.0, give: S(27), letZen: W(27, 'Let'),
  };
}

// ---------------------------------------------------------------- score & sfx synthesis
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function makeTable(partials) {
  const n = 4096, t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    let s = 0;
    for (const [h, a] of partials) s += a * Math.sin(2 * Math.PI * h * i / n);
    t[i] = s;
  }
  let pk = 0; for (const v of t) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i <= n; i++) t[i] /= pk;
  return t;
}
const TBL = {
  pad: makeTable([1, 2, 3, 4, 5, 6, 7].map((h) => [h, 1 / Math.pow(h, 1.9)])),
  warm: makeTable([[1, 1], [2, 0.32], [3, 0.12], [4, 0.05]]),
  sine: makeTable([[1, 1]]),
  pluck: makeTable([[1, 1], [2, 0.45], [3, 0.18], [4, 0.08], [6, 0.03]]),
};
const look = (t, ph) => { const x = ph * 4096; const i = x | 0; const f = x - i; return t[i] + (t[i + 1] - t[i]) * f; };

function synthScore(beats, timing) {
  const N = Math.ceil(DUR * SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  const DL = new Float32Array(N), DR = new Float32Array(N); // dry bus (no reverb)
  const rand = rng(7);

  function tone(t0, len, freq, amp, o = {}) {
    const atk = o.atk ?? 0.8, rel = o.rel ?? 1.5, tbl = o.tbl || TBL.pad;
    const det = o.det ?? 6, pan = o.pan ?? 0, vib = o.vib ?? 0, trem = o.trem ?? 0;
    const s0 = Math.max(0, Math.floor(t0 * SR)), s1 = Math.min(N, Math.floor((t0 + len + rel) * SR));
    const f = [freq * Math.pow(2, -det / 1200), freq, freq * Math.pow(2, det / 1200)];
    const ph = [rand(), rand(), rand()];
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    const tgtL = o.dry ? DL : L, tgtR = o.dry ? DR : R;
    for (let s = s0; s < s1; s++) {
      const t = s / SR - t0;
      let env = t < atk ? Math.sin((t / atk) * Math.PI / 2) : 1;
      if (t > len) env *= Math.exp(-(t - len) / (rel / 4));
      if (o.decay) env *= Math.exp(-t / o.decay);
      if (trem) env *= 1 - trem * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t));
      const v = vib ? 1 + vib * Math.sin(2 * Math.PI * 5 * t) : 1;
      const a = look(tbl, ph[0]), b = look(tbl, ph[1]), c = look(tbl, ph[2]);
      for (let k = 0; k < 3; k++) { ph[k] += (f[k] * v) / SR; ph[k] -= ph[k] | 0; }
      const e = env * amp;
      tgtL[s] += (a * 0.62 + b * 0.5) * e * gl;
      tgtR[s] += (c * 0.62 + b * 0.5) * e * gr;
    }
  }
  const chord = (t0, len, notes, amp, o = {}) => notes.forEach((m, i) => tone(t0, len, mtof(m), amp * (i === 0 ? 1.1 : 0.62), { ...o, pan: ((i % 2) ? 0.35 : -0.35) * (i ? 1 : 0) }));
  const pluck = (t0, m, amp, pan = 0) => tone(t0, 0.02, mtof(m), amp, { tbl: TBL.pluck, atk: 0.006, rel: 0.05, decay: 0.55, det: 3, pan });
  const bell = (t0, m, amp, pan = 0) => { tone(t0, 0.01, mtof(m), amp, { tbl: TBL.sine, atk: 0.004, rel: 0.05, decay: 1.2, det: 2, pan }); tone(t0, 0.01, mtof(m) * 2.76, amp * 0.25, { tbl: TBL.sine, atk: 0.003, rel: 0.05, decay: 0.4, det: 0, pan }); };

  function noise(t0, len, amp, o = {}) {
    const s0 = Math.max(0, Math.floor(t0 * SR)), s1 = Math.min(N, Math.floor((t0 + len) * SR));
    let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
    const tgtL = o.dry ? DL : L, tgtR = o.dry ? DR : R;
    for (let s = s0; s < s1; s++) {
      const p = (s - s0) / (s1 - s0);
      const env = o.shape ? o.shape(p) : Math.sin(p * Math.PI);
      const cut = o.cut ? o.cut(p) : 0.2;
      const nl = rand() * 2 - 1, nr = rand() * 2 - 1;
      lpL += cut * (nl - lpL); lpR += cut * (nr - lpR);
      let yl = lpL, yr = lpR;
      if (o.hp) { const hl = yl - hpL, hr = yr - hpR; hpL += 0.08 * hl; hpR += 0.08 * hr; yl = hl; yr = hr; }
      tgtL[s] += yl * env * amp; tgtR[s] += yr * env * amp;
    }
  }
  function sweep(t0, len, f0, f1, amp, o = {}) {
    const s0 = Math.max(0, Math.floor(t0 * SR)), s1 = Math.min(N, Math.floor((t0 + len) * SR));
    let ph = 0;
    const tgtL = o.dry ? DL : L, tgtR = o.dry ? DR : R;
    for (let s = s0; s < s1; s++) {
      const t = (s - s0) / SR, p = t / len;
      const f = f1 + (f0 - f1) * Math.exp(-t / (o.glide ?? 0.05));
      ph += f / SR;
      const env = Math.min(1, t / 0.004) * Math.exp(-t / (o.decay ?? 0.25)) * (o.fadeEnd ? 1 - p : 1);
      const v = Math.sin(2 * Math.PI * ph) * env * amp;
      tgtL[s] += v; tgtR[s] += v;
    }
  }
  const kick = (t0, amp) => sweep(t0, 0.5, 130, 46, amp, { glide: 0.035, decay: 0.16, dry: true });
  const tick = (t0, amp) => noise(t0, 0.012, amp, { cut: () => 0.9, hp: true, shape: (p) => 1 - p, dry: true });
  const whoosh = (t0, amp = 0.16) => noise(t0 - 0.35, 0.8, amp, { cut: (p) => 0.02 + 0.2 * Math.sin(p * Math.PI), shape: (p) => Math.pow(Math.sin(p * Math.PI), 2) });
  const click = (t0, amp = 0.3) => { noise(t0, 0.006, amp, { cut: () => 0.7, hp: true, shape: (p) => 1 - p, dry: true }); sweep(t0, 0.03, 2200, 1800, amp * 0.15, { decay: 0.01, dry: true }); };
  const ping = (t0, amp = 0.12, m = 88) => { bell(t0, m, amp, 0.2); bell(t0 + 0.09, m + 5, amp * 0.8, 0.2); };
  const bonk = (t0, amp = 0.22) => { sweep(t0, 0.6, 160, 98, amp, { glide: 0.1, decay: 0.28 }); noise(t0, 0.25, amp * 0.25, { cut: () => 0.05, shape: (p) => 1 - p }); };
  const blip = (t0, amp = 0.06) => { bell(t0, 93, amp, 0.3); };
  const typing = (a, b, rate, amp) => { const r = rng(Math.floor(a * 100)); for (let t = a; t < b; t += (0.6 + r() * 0.9) / rate) click(t, amp * (0.6 + r() * 0.5)); };

  // ---- harmony
  const Ch = {
    D: [50, 57, 62, 64, 66], Bm: [47, 54, 59, 62, 66], G: [43, 55, 59, 62, 66], Asus: [45, 57, 62, 64, 69], A: [45, 57, 61, 64, 69],
    Em: [40, 55, 59, 62, 67], Fsm: [42, 54, 57, 61, 66], AoC: [49, 57, 61, 64, 69], DoF: [42, 54, 57, 62, 66],
    dark1: [35, 47, 54, 59, 62], dark2: [36, 48, 55, 60, 63], dark3: [35, 47, 54, 58, 62], hollow1: [40, 52, 59, 66], hollow2: [43, 55, 62, 69],
    reveal: [38, 50, 57, 64, 69, 74], final: [38, 50, 57, 62, 64, 66, 69, 74],
  };
  const prog = (list, amp, o) => list.forEach(([t, len, c]) => chord(t, len, Ch[c], amp, o));
  prog([[0, 4.6, 'D'], [4.5, 4.6, 'Bm'], [9, 4.6, 'G'], [13.5, 2.3, 'Asus'], [15.75, 2.4, 'A']], 0.05, { atk: 1.2, rel: 1.6 });
  prog([[18, 4.1, 'Bm'], [22, 4.1, 'G'], [26, 3.6, 'Em'], [29.5, 3.4, 'Fsm']], 0.048, { atk: 0.9, rel: 1.4 });
  prog([[33, 7.6, 'dark1'], [40.5, 6.6, 'dark2'], [47, 6.8, 'dark3']], 0.052, { atk: 1.0, rel: 1.5, tbl: TBL.warm, det: 9 });
  prog([[54, 7.1, 'hollow1'], [61, 5.8, 'hollow2']], 0.04, { atk: 1.5, rel: 1.2, tbl: TBL.warm });
  tone(55, 11.5, mtof(78), 0.018, { tbl: TBL.sine, atk: 2, rel: 1, trem: 0.4 });
  chord(beats.zen - 0.3, 6.0, Ch.reveal, 0.05, { atk: 2.2, rel: 1.8 });
  const bar = 60 / 84 * 4;
  const zenProg = ['D', 'AoC', 'Bm', 'G'];
  for (let t = 76, k = 0; t < 131.6; t += bar * 2, k++) chord(t, Math.min(bar * 2 + 0.1, 131.8 - t), Ch[zenProg[k % 4]], 0.044, { atk: 0.7, rel: 1.4 });
  prog([[131.6, 4.6, 'Bm'], [136.2, 3.5, 'Em'], [139.6, 4.9, 'G'], [144.4, 2.9, 'Bm'], [147.2, 2.9, 'G'], [150.1, 3.1, 'Asus']], 0.044, { atk: 0.8, rel: 1.4 });
  prog([[153, 4.6, 'G'], [157.5, 4.6, 'DoF'], [162, 4.6, 'Em'], [166.5, 2.3, 'Asus'], [168.75, 2.4, 'A'], [171, 4.2, 'D']], 0.05, { atk: 1.0, rel: 1.4 });
  chord(175, 3.4, Ch.final, 0.05, { atk: 1.2, rel: 1.6 });

  // bass
  const bass = (t, len, m, a = 0.05) => tone(t, len, mtof(m), a, { tbl: TBL.warm, atk: 0.2, rel: 0.8, det: 0 });
  [[0, 4.5, 38], [4.5, 4.5, 35], [9, 4.5, 31], [13.5, 4.5, 33], [18, 4, 35], [22, 4, 31], [26, 3.5, 28], [29.5, 3.5, 30]].forEach(([t, l, m]) => bass(t, l, m));
  [[33, 7.5, 23], [40.5, 6.5, 24], [47, 7, 23]].forEach(([t, l, m]) => bass(t, l, m, 0.07));
  for (let t = 76, k = 0; t < 131.6; t += bar * 2, k++) bass(t, bar * 2, [38, 37, 35, 31][k % 4], 0.045);
  [[153, 4.5, 31], [157.5, 4.5, 30], [162, 4.5, 28], [166.5, 4.5, 33], [171, 4, 26], [175, 3.5, 26]].forEach(([t, l, m]) => bass(t, l, m, 0.05));

  // arps
  const e8 = 60 / 84 / 2;
  const arp = (a, b, notesAt, amp) => { let k = 0; for (let t = a; t < b; t += e8, k++) { const ns = notesAt(t); const pat = [0, 1, 2, 3, 2, 1, 2, 3]; pluck(t, ns[pat[k % 8] % ns.length] + 12, amp * (k % 2 ? 0.7 : 1), (k % 2 ? 0.3 : -0.3)); } };
  const chordAt = (t) => { if (t < 4.5) return Ch.D; if (t < 9) return Ch.Bm; if (t < 13.5) return Ch.G; return Ch.A; };
  arp(0.5, 17.6, (t) => chordAt(t).slice(1), 0.028);
  arp(18, 33, (t) => (t < 22 ? Ch.Bm : t < 26 ? Ch.G : t < 29.5 ? Ch.Em : Ch.Fsm).slice(1), 0.022);
  const zenAt = (t) => Ch[zenProg[Math.floor((t - 76) / (bar * 2)) % 4]].slice(1);
  arp(beats.send, 131.6, zenAt, 0.03);
  arp(131.6, 139.6, (t) => (t < 136.2 ? Ch.Bm : Ch.Em).slice(1), 0.016);
  arp(144.4, 153, (t) => (t < 147.2 ? Ch.Bm : t < 150.1 ? Ch.G : Ch.Asus).slice(1), 0.026);
  arp(153, 174.5, (t) => (t < 157.5 ? Ch.G : t < 162 ? Ch.DoF : t < 166.5 ? Ch.Em : t < 171 ? Ch.A : Ch.D).slice(1), 0.022);

  // rhythm
  for (let t = 26.6; t < 33; t += 60 / 84) tick(t, 0.05);
  for (let t = 33.5, k = 0; t < 46.8; t += 60 / 96 / 2, k++) sweep(t, 0.3, 70, 49, 0.03 + 0.05 * ((t - 33.5) / 13.3), { glide: 0.02, decay: 0.12, dry: true });
  for (let t = 92; t < 131.6; t += 60 / 84) kick(t, 0.13);
  for (let t = 108 + e8; t < 131.6; t += e8 * 2) tick(t, 0.035);
  for (let t = 146; t < 153; t += 60 / 84) kick(t, 0.1);

  // sfx
  ping(beats.toast, 0.1);
  click(beats.golive, 0.2); blip(beats.golive, 0.04);
  [6.7, 18.1, 26.6, 33.1, 46.9, 54.1, 75.9, 166.7, 175.0].forEach((t) => whoosh(t));
  typing(26.9, 32.6, 9, 0.12);
  typing(beats.typeStart + 0.1, beats.typeEnd - 0.1, 11, 0.12);
  click(beats.send, 0.35); click(beats.start, 0.35);
  [beats.card1, beats.card2, beats.card3, beats.card4].forEach((t) => bonk(t));
  { const r = rng(42); for (let i = 0; i < 44; i++) { const p = i / 44; const t = beats.notif - 0.3 + 4.2 * Math.pow(p, 0.6); ping(t, 0.035 + r() * 0.02, 84 + Math.floor(r() * 9)); } }
  noise(beats.card4, 4.2, 0.06, { cut: (p) => 0.01 + 0.3 * p, shape: (p) => p * p });
  bonk(47.0, 0.14);
  sweep(beats.zen - 0.05, 4, 70, 30, 0.34, { glide: 0.6, decay: 1.4 });
  noise(beats.zen - 0.05, 3.4, 0.08, { cut: (p) => 0.08 * (1 - p) + 0.005, shape: (p) => Math.exp(-p * 3) });
  [0, 1, 2, 3].forEach((k) => bell(beats.zen + 0.25 + k * 0.18, [74, 78, 81, 86][k], 0.035, k % 2 ? 0.4 : -0.4));
  for (let i = 0; i < 6; i++) blip(beats.mappings - 0.4 + i * 0.55 + 0.55, 0.025);
  [109.9, 110.6, 111.3, 115.4, beats.n0 + 0.2].forEach((t) => blip(t, 0.03));
  [74, 78, 81, 86].forEach((m, k) => bell(beats.ready + k * 0.11, m, 0.06, 0));
  [81, 86].forEach((m, k) => bell(beats.resolved + k * 0.1, m, 0.05, 0));
  [79, 76].forEach((m, k) => bell(beats.review + k * 0.22, m, 0.06, 0));
  bonk(beats.err + 0.1, 0.1);
  [74, 78, 81, 86, 90].forEach((m, k) => bell(beats.complete + k * 0.12, m, 0.06, 0));
  const zenMsgs = [beats.understood, beats.source, beats.discover + 0.2, beats.mappings, 109.5, beats.diagnosing, beats.answer, beats.reconciled];
  zenMsgs.forEach((t) => blip(t, 0.02));

  // reverb on the wet bus
  const reverb = (x, off) => {
    const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round((d + off) * 1.088)), i: 0, lp: 0 }));
    const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(Math.round((d + off) * 1.088)), i: 0 }));
    const y = new Float32Array(x.length);
    for (let s = 0; s < x.length; s++) {
      const inp = x[s] * 0.2;
      let acc = 0;
      for (const c of combs) { const o = c.buf[c.i]; c.lp = o * 0.62 + c.lp * 0.38; c.buf[c.i] = inp + c.lp * 0.86; c.i = (c.i + 1) % c.buf.length; acc += o; }
      for (const a of aps) { const b = a.buf[a.i]; const o = -acc + b; a.buf[a.i] = acc + b * 0.5; a.i = (a.i + 1) % a.buf.length; acc = o; }
      y[s] = acc;
    }
    return y;
  };
  const wL = reverb(L, 0), wR = reverb(R, 23);
  for (let s = 0; s < N; s++) { L[s] = L[s] * 0.8 + wL[s] * 0.5 + DL[s]; R[s] = R[s] * 0.8 + wR[s] * 0.5 + DR[s]; }

  // silence the reveal gap, fade at the end
  const gapA = Math.floor(67.6 * SR), gapB = Math.floor((beats.zen - 0.1) * SR);
  for (let s = gapA; s < gapB; s++) { const k = clamp(1 - (s - gapA) / (0.5 * SR)); L[s] *= k; R[s] *= k; }
  const endA = Math.floor(178.6 * SR);
  for (let s = endA; s < N; s++) { const k = clamp(1 - (s - endA) / (N - endA)); L[s] *= k * k; R[s] *= k * k; }
  return [L, R];
}

function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

function mix(timing, beats) {
  const N = Math.ceil(DUR * SR);
  const voice = new Float32Array(N);
  timing.forEach((c, i) => {
    const pcm = decode(path.join(VOICE_DIR, String(i).padStart(2, '0') + '.mp3'));
    const a = Math.round(c.lead * SR), n = Math.round(c.dur * SR);
    let ss = 0, cnt = 0;
    for (let k = 0; k < n; k++) { const v = pcm[a + k] || 0; if (Math.abs(v) > 0.01) { ss += v * v; cnt++; } }
    const g = 0.15 / Math.sqrt(ss / Math.max(1, cnt));
    const s0 = Math.round(c.start * SR);
    for (let k = 0; k < n && s0 + k < N; k++) {
      const fade = Math.min(1, k / 240, (n - k) / 480);
      voice[s0 + k] += (pcm[a + k] || 0) * g * fade;
    }
  });
  const [L, R] = synthScore(beats, timing);
  let env = 0;
  const att = 1 - Math.exp(-1 / (0.03 * SR)), rel = 1 - Math.exp(-1 / (0.5 * SR));
  for (let s = 0; s < N; s++) {
    const x = Math.abs(voice[s]);
    env += (x > env ? att : rel) * (x - env);
    const duck = 1 - 0.5 * clamp(env * 7);
    L[s] = L[s] * 0.9 * duck + voice[s];
    R[s] = R[s] * 0.9 * duck + voice[s];
  }
  let pk = 0;
  for (let s = 0; s < N; s++) pk = Math.max(pk, Math.abs(L[s]), Math.abs(R[s]));
  const g = pk > 0.89 ? 0.89 / pk : 1;
  for (let s = 0; s < N; s++) { L[s] *= g; R[s] *= g; }
  writeWav(path.join(ASSETS, 'mix.wav'), L, R);
  log(`mix written (peak ${pk.toFixed(3)}, gain ${g.toFixed(3)})`);
}

function writeSrt(timing) {
  const f = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const srt = timing.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.start + c.dur + 0.2)}\n${c.speaker === 'Narrator' ? '' : c.speaker.toUpperCase() + ': '}${c.text}\n`).join('\n');
  mkdir(OUT);
  fs.writeFileSync(path.join(OUT, 'Zen-Migration-Story.srt'), srt);
}

async function prepare() {
  mkdir(ASSETS);
  const timing = await prepareVoices();
  const beats = computeBeats(timing);
  fs.writeFileSync(path.join(ASSETS, 'timing.json'), JSON.stringify({ timing, beats }));
  mix(timing, beats);
  writeSrt(timing);
}

// ---------------------------------------------------------------- rendering
function loadData() {
  const f = path.join(ASSETS, 'timing.json');
  if (fs.existsSync(f)) { const { timing } = JSON.parse(fs.readFileSync(f, 'utf8')); return { storyboard: SB, timing, beats: computeBeats(timing) }; }
  log('WARN no assets/timing.json - using storyboard timing without lip-sync (run prepare first)');
  const timing = SB.cues.map((c) => ({ speaker: c.speaker, text: c.text, start: c.start, dur: c.end - c.start, words: [], amp: [] }));
  return { storyboard: SB, timing, beats: computeBeats(timing) };
}

async function openPage(browser, data) {
  const page = await browser.newPage({ viewport: { width: SB.width, height: SB.height }, deviceScaleFactor: 1 });
  await page.addInitScript((d) => { window.__DATA = d; }, data);
  await page.goto('file:///' + path.join(ROOT, 'film.html').replace(/\\/g, '/'));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  page.on('pageerror', (e) => log('PAGE ERROR', e.message));
  return page;
}

async function launch() {
  const { chromium } = require('playwright-core');
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'] }); } catch (e) { log(`channel ${channel} unavailable: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('No Chromium-based browser (Edge/Chrome) found');
}

async function preview(times) {
  const data = loadData();
  const dir = path.join(OUT, 'preview');
  mkdir(dir);
  const browser = await launch();
  const page = await openPage(browser, data);
  for (const t of times) {
    await page.evaluate((x) => window.renderAt(x), t);
    const f = path.join(dir, `t_${String(t.toFixed(1)).padStart(5, '0')}.png`);
    await page.screenshot({ path: f });
    log('still', f);
  }
  await browser.close();
}

function encoder(file) {
  const p = spawn(ffmpeg, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2), file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  return { stdin: p.stdin, done };
}

async function render() {
  const data = loadData();
  if (!fs.existsSync(path.join(ASSETS, 'mix.wav'))) throw new Error('assets/mix.wav missing - run `npm run prepare-assets` first');
  mkdir(OUT);
  const segDir = path.join(OUT, 'segments');
  mkdir(segDir);
  const total = Math.round(DUR * FPS);
  const workers = Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)));
  const per = Math.ceil(total / workers);
  const browser = await launch();
  let doneFrames = 0;
  const t0 = Date.now();
  const segs = [];
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const a = w * per, b = Math.min(total, a + per);
    const seg = path.join(segDir, `seg_${w}.mp4`);
    segs[w] = seg;
    const page = await openPage(browser, data);
    const enc = encoder(seg);
    for (let f = a; f < b; f++) {
      await page.evaluate((x) => window.renderAt(x), f / FPS);
      const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
      doneFrames++;
      if (doneFrames % 120 === 0) {
        const el = (Date.now() - t0) / 1000;
        log(`frames ${doneFrames}/${total}  ${(doneFrames / el).toFixed(1)} fps  eta ${Math.round((total - doneFrames) / (doneFrames / el))}s`);
      }
    }
    enc.stdin.end();
    await enc.done;
    await page.close();
  }));
  await browser.close();
  const list = path.join(segDir, 'list.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
  const video = path.join(segDir, 'video.mp4');
  run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
  mux();
  writeSrt(data.timing);
  log('wrote', FINAL, `in ${Math.round((Date.now() - t0) / 1000)}s`);
}

function mux() {
  const video = path.join(OUT, 'segments', 'video.mp4');
  const wav = path.join(ASSETS, 'mix.wav');
  const target = 'I=-16:TP=-1.5:LRA=11';
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', wav, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = JSON.parse(probe.stderr.slice(probe.stderr.lastIndexOf('{'), probe.stderr.lastIndexOf('}') + 1));
  const af = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
  log(`loudness ${m.input_i} LUFS -> -16 LUFS`);
  run(['-y', '-v', 'error', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-metadata', 'title=' + SB.title, '-metadata', 'comment=' + SB.disclosure, '-movflags', '+faststart', '-t', String(DUR), FINAL]);
}

function run(args) {
  const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'pipe'], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').toString());
  return r;
}

function verify() {
  if (!fs.existsSync(FINAL)) throw new Error('missing ' + FINAL);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', FINAL], { encoding: 'utf8' });
  const info = r.stderr.split('\n').filter((l) => /Duration|Stream/.test(l)).map((l) => l.trim());
  info.forEach((l) => log(l));
  const sheet = path.join(OUT, 'contact-sheet.jpg');
  run(['-y', '-v', 'error', '-i', FINAL, '-vf', 'fps=1/6,scale=384:-1,tile=6x5:padding=4:color=black', '-frames:v', '1', '-q:v', '3', sheet]);
  const vol = spawnSync(ffmpeg, ['-hide_banner', '-i', FINAL, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  vol.stderr.split('\n').filter((l) => /mean_volume|max_volume/.test(l)).forEach((l) => log(l.trim().replace(/^\[.*?\]\s*/, '')));
  log('size', (fs.statSync(FINAL).size / 1048576).toFixed(1) + ' MB', '| contact sheet', sheet);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'prepare') await prepare();
  else if (cmd === 'preview') await preview(rest.length ? rest.map(Number) : [2, 10, 16, 21, 29, 37, 44, 50, 56, 64, 71, 80, 88, 101, 120, 126, 137, 142, 158, 170, 178]);
  else if (cmd === 'render') await render();
  else if (cmd === 'remux') { mux(); verify(); }
  else if (cmd === 'verify') verify();
  else if (cmd === 'all') { await prepare(); await render(); verify(); }
  else { console.log('usage: node build.js prepare|preview [t...]|render|remux|verify|all'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
