/* Rule-based goal interpreter: natural language → intent. Deterministic and
   always available; the Claude interpreter (aiInterpreter.js) produces the
   same intent shape and is preferred when a key is configured.

   Intent (shared with aiInterpreter):
   {
     source, target,                         // integration ids or null
     record_types: ["employees","tickets"],
     scope: "all",
     waves: [{ category: "it"|"hr"|"finance"|"facilities"|"all",
               schedule: { kind: "at"|"relative"|"after"|"immediate"|"unspecified",
                           day, relative: "this"|"next"|"following"|null,
                           date: "YYYY-MM-DD"|null, time: "HH:MM"|null,
                           day_offset, week_offset, after_wave },
               depends_on: [{ category, condition_text }] }],
     success_criteria: { min_success_rate, max_critical_errors, required_fields_populated,
                         reconciliation_complete, no_unresolved_high_severity },  // null = default
     blackout: [{ label, days, start, end }],
     failure_policy: { pause_below_success_rate, on_critical_failure },
     window: { duration_minutes, start_time, end_time, on_overrun },
     options: { validation, remediation, human_escalation },
     recurrence: { every: "week", day, time } | null,
     wants_recommendation: bool,
     volume_hint: number|null,
     notes: [string]
   } */

const { DAYS } = require("./time");

const SYSTEM_PATTERNS = {
  jira: /\bjira(\s+service\s+management)?\b|\bjsm\b/i,
  "legacy-itsm": /\blegacy\s+itsm\b/i,
  "mock-legacy": /\bmock\s+legacy(\s+system)?\b/i,
  freshservice: /\bfresh\s?service\b/i,
};

// IT must be upper-case so the pronoun "it" never reads as a department
const DEPARTMENT_PATTERNS = [
  { category: "it", re: /\bIT\b|information technology/g },
  { category: "hr", re: /\bHR\b|human resources|people\s*(?:&|and)\s*culture/gi },
  { category: "finance", re: /\bfinance\b|\baccounting\b|\baccounts\b/gi },
  { category: "facilities", re: /\bfacilities\b|\bworkplace\b/gi },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)";
const DAY_FULL = { sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday" };

function fullDay(d) {
  d = d.toLowerCase();
  return DAYS.includes(d) ? d : DAY_FULL[d];
}

/* "11 PM", "11:30pm", "23:00", "midnight", "noon" → "HH:MM" */
const TIME_RE = /\b(?:(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|([01]?\d|2[0-3]):([0-5]\d)|(midnight|noon))/i;

function parseTime(text) {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  if (m[6]) return m[6].toLowerCase() === "midnight" ? "00:00" : "12:00";
  if (m[4] !== undefined) return m[4].padStart(2, "0") + ":" + m[5];
  let h = +m[1] % 12;
  if (/p/i.test(m[3])) h += 12;
  return String(h).padStart(2, "0") + ":" + (m[2] || "00");
}

function allTimes(text) {
  const out = [];
  const re = new RegExp(TIME_RE.source, "gi");
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index, value: parseTime(m[0]) });
  return out;
}

function parseSchedule(text) {
  const t = text;
  const time = parseTime(t);
  const s = { kind: "unspecified", day: null, relative: null, date: null, time, day_offset: null, week_offset: null, after_wave: null };

  if (/\b(immediately|right away|asap|right now)\b|\bnow\b/i.test(t)) return { ...s, kind: "immediate" };

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  const md = new RegExp("\\b(" + MONTHS.join("|") + ")[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b", "i").exec(t)
    || new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + MONTHS.join("|") + ")[a-z]*\\b", "i").exec(t);
  if (iso) return { ...s, kind: "at", date: iso[1] };
  if (md) {
    const monthName = isNaN(+md[1]) ? md[1] : md[2];
    const dayNum = isNaN(+md[1]) ? +md[2] : +md[1];
    return { ...s, kind: "at", date: "MM-DD:" + String(MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1).padStart(2, "0") + "-" + String(dayNum).padStart(2, "0") };
  }

  if (/\btomorrow\b/i.test(t)) return { ...s, kind: "at", day_offset: 1 };
  if (/\btonight\b|\btoday\b/i.test(t)) return { ...s, kind: "at", day_offset: 0, time: time || (/tonight/i.test(t) ? "23:00" : null) };

  const weekend = /\b(this|next|the following|following|coming)?\s*weekend\b/i.exec(t);
  if (weekend) return { ...s, ...relativeOf(weekend[1]), day: "saturday" };

  const day = new RegExp("\\b(this|next|the following|following|coming)?\\s*" + DAY_RE + "\\b", "i").exec(t);
  if (day) return { ...s, ...relativeOf(day[1]), day: fullDay(day[2]) };

  if (/\b(the )?(following|next) week\b|\ba week later\b|\bthe week after\b/i.test(t)) {
    return { ...s, kind: "relative", relative: "following", week_offset: 1 };
  }
  if (time) return { ...s, kind: "at", day_offset: null };
  return s;
}

function relativeOf(word) {
  const w = (word || "").toLowerCase().trim();
  if (w === "next") return { kind: "at", relative: "next" };
  if (w === "following" || w === "the following") return { kind: "relative", relative: "following", week_offset: 1 };
  return { kind: "at", relative: "this" };
}

function findSystems(text, catalog) {
  const found = [];
  for (const [id, re] of Object.entries(SYSTEM_PATTERNS)) {
    const m = re.exec(text);
    if (m) found.push({ id, index: m.index });
  }
  const sources = new Set((catalog.sources || []).map((s) => s.id));
  const targets = new Set((catalog.targets || []).map((t) => t.id));
  const src = found.filter((f) => sources.has(f.id)).sort((a, b) => a.index - b.index)[0];
  const tgt = found.filter((f) => targets.has(f.id)).sort((a, b) => a.index - b.index)[0];
  return { source: src ? src.id : null, target: tgt ? tgt.id : null };
}

function departmentsIn(text) {
  const hits = [];
  for (const { category, re } of DEPARTMENT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) hits.push({ category, index: m.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

function splitClauses(text) {
  return text
    .split(/(?<=[.;!?])\s+|,?\s+(?:and\s+)?then\s+|,\s+and\s+/i)
    .map((c) => c.trim().replace(/[.;!?]+$/, ""))
    .filter(Boolean);
}

const DEP_KEYWORD = /\b(if|once|when|after|following successful|provided)\b/i;

function interpretRules(text, catalog = {}) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const notes = [];
  const intent = {
    ...findSystems(raw, catalog),
    record_types: [],
    scope: "all",
    waves: [],
    success_criteria: {
      min_success_rate: null, max_critical_errors: null, required_fields_populated: null,
      reconciliation_complete: null, no_unresolved_high_severity: null,
    },
    blackout: [],
    failure_policy: { pause_below_success_rate: null, on_critical_failure: null },
    window: { duration_minutes: null, start_time: null, end_time: null, on_overrun: null },
    options: { validation: true, remediation: true, human_escalation: true },
    recurrence: null,
    wants_recommendation: false,
    volume_hint: null,
    notes,
  };

  /* WHAT */
  if (/\b(employee|staff|user|requester)s?\s+(records?|data|profiles?|accounts?|and|&|,)/i.test(raw)
      || /\bmigrat\w*\s+(all\s+)?(the\s+|our\s+)?(employee|staff|user|requester)s?\b/i.test(raw)) intent.record_types.push("employees");
  if (/\btickets?\b|\bincidents?\b|\brequests?\b|\bcases?\b/i.test(raw)) intent.record_types.push("tickets");
  if (!intent.record_types.length) {
    intent.record_types = ["employees", "tickets"];
    notes.push("No record types named — assuming employees and tickets.");
  }
  if (/\b(only|just)\s+(open|active|recent)\b/i.test(raw)) intent.scope = "filtered";

  /* success criteria */
  const rate = /(?:at least|minimum(?: of)?|>=|≥|over|above)\s*(\d{1,3}(?:\.\d+)?)\s*%/i.exec(raw)
    || /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:success|successful|success rate)/i.exec(raw);
  if (rate && !/pause[^.]*?(below|under|less than)/i.test(raw.slice(Math.max(0, rate.index - 40), rate.index + 10))) {
    intent.success_criteria.min_success_rate = Math.min(1, +rate[1] / 100);
  }
  if (/\bno\s+critical\s+(errors?|failures?|issues?)\b|\bzero\s+critical\b/i.test(raw)) intent.success_criteria.max_critical_errors = 0;
  if (/all required fields/i.test(raw)) intent.success_criteria.required_fields_populated = true;
  if (/reconcil/i.test(raw)) intent.success_criteria.reconciliation_complete = true;
  if (/no unresolved (high|high-severity|severe)/i.test(raw)) intent.success_criteria.no_unresolved_high_severity = true;

  /* failure policy */
  const pause = /pause[^.]*?(?:below|under|less than)\s*(\d{1,3}(?:\.\d+)?)\s*%/i.exec(raw)
    || /(?:below|under|less than)\s*(\d{1,3}(?:\.\d+)?)\s*%[^.]*?pause/i.exec(raw);
  if (pause) intent.failure_policy.pause_below_success_rate = +pause[1] / 100;
  const overrun = /(?:not (?:complete|finished|done)|doesn'?t finish|runs? over|overruns?)[^.]*?\b(pause|continue|escalate|notify|stop)\b/i.exec(raw);
  if (overrun) intent.window.on_overrun = { notify: "escalate" }[overrun[1].toLowerCase()] || overrun[1].toLowerCase();
  if (/\b(no|without|skip)\s+(ai\s+)?remediation\b/i.test(raw)) intent.options.remediation = false;
  if (/\b(no|without|skip)\s+validation\b/i.test(raw)) intent.options.validation = false;
  if (/\b(no|without)\s+(human|manual)\s+(escalation|review)\b/i.test(raw)) intent.options.human_escalation = false;

  /* blackout */
  if (/business hours|working hours|office hours|during the (work)?day/i.test(raw)) {
    const range = /(?:business|working|office) hours(?: are| of|:)?\s*\(?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(raw);
    let start = "09:00";
    let end = "18:00";
    if (range) {
      start = parseTime(/am|pm/i.test(range[1]) ? range[1] : range[1] + (/:/.test(range[1]) ? "" : " am")) || start;
      end = parseTime(/am|pm/i.test(range[2]) ? range[2] : range[2] + (/:/.test(range[2]) ? "" : " pm")) || end;
    } else {
      notes.push("Business hours assumed to be Monday–Friday 9 AM–6 PM.");
    }
    intent.blackout.push({ label: "Business hours", days: ["mon", "tue", "wed", "thu", "fri"], start, end });
  }
  if (/\b(don'?t|do not|never|no)\b[^.]*\bweekdays?\b/i.test(raw) && !intent.blackout.length) {
    intent.blackout.push({ label: "Weekdays", days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "23:59" });
  }

  /* window */
  const between = new RegExp("between\\s+(" + TIME_RE.source + ")\\s+and\\s+(" + TIME_RE.source + ")", "i").exec(raw);
  if (between) {
    const times = allTimes(between[0]);
    intent.window.start_time = times[0] && times[0].value;
    intent.window.end_time = times[1] && times[1].value;
  }
  const until = new RegExp("(?:until|till|by|end(?:s|ing)? at)\\s+(" + TIME_RE.source + ")", "i").exec(raw);
  if (until && !between) intent.window.end_time = parseTime(until[1]);
  const hours = /(\d{1,2})[- ]hour(?:s)?\s+(?:migration\s+)?window|window of (\d{1,2}) hours?/i.exec(raw);
  if (hours) intent.window.duration_minutes = +(hours[1] || hours[2]) * 60;

  /* recurrence */
  const every = new RegExp("\\bevery\\s+(" + DAY_RE.slice(1, -1) + "|weekend)\\b", "i").exec(raw);
  if (every || /\bweekly\b/i.test(raw)) {
    const day = every ? (every[1].toLowerCase() === "weekend" ? "saturday" : fullDay(every[1])) : "saturday";
    intent.recurrence = { every: "week", day, time: parseTime(raw) || "23:00" };
  }

  /* recommendation hints */
  if (/\b(don'?t|do not|without|avoid)\b[^.]*\b(disrupt|impact|interrupt)/i.test(raw)
      || /\b(recommend|suggest|best time|when should)\b/i.test(raw)) intent.wants_recommendation = true;
  const vol = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\s+(?:tickets|records|employees)/i.exec(raw);
  if (vol) {
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[(vol[2] || "").toLowerCase()] || 1;
    intent.volume_hint = Math.round(parseFloat(vol[1].replace(/,/g, "")) * mult);
  }

  /* WHEN / ORDER: waves from clauses */
  const clauses = splitClauses(raw);
  const byCategory = {};
  let lastWave = null;
  for (const clause of clauses) {
    if (/\bpause\b[^.]*%/i.test(clause) && !departmentsIn(clause).length) continue;
    let cond = "";
    let main = clause;
    const lead = /^(if|once|when|after|provided)\b(.*?),\s*(.*)$/i.exec(clause);
    if (lead) {
      cond = lead[1] + lead[2];
      main = lead[3];
    }
    let waveText = main;
    let depText = cond;
    const k = DEP_KEYWORD.exec(main);
    if (k) {
      waveText = main.slice(0, k.index);
      depText = (depText ? depText + " " : "") + main.slice(k.index);
    }
    const waveDepts = departmentsIn(waveText);
    const depDepts = departmentsIn(depText);
    if (!waveDepts.length) continue;

    for (const wd of waveDepts.filter((d, i, arr) => arr.findIndex((x) => x.category === d.category) === i)) {
      const schedule = parseSchedule(waveText);
      // a time like "at 11 PM" may sit after the dependency clause
      if (!schedule.time) schedule.time = parseTime(main) || null;
      let wave = byCategory[wd.category];
      if (!wave) {
        wave = { category: wd.category, schedule, depends_on: [] };
        byCategory[wd.category] = wave;
        intent.waves.push(wave);
      } else if (schedule.kind !== "unspecified") {
        wave.schedule = schedule;
      }
      for (const dd of depDepts) {
        if (dd.category !== wd.category && !wave.depends_on.some((d) => d.category === dd.category)) {
          wave.depends_on.push({ category: dd.category, condition_text: depText.trim() });
        }
      }
      if (/\bafter (that|this|it\b)/i.test(depText) && lastWave && lastWave !== wave
          && !wave.depends_on.some((d) => d.category === lastWave.category)) {
        wave.depends_on.push({ category: lastWave.category, condition_text: depText.trim() });
      }
      if (wave.schedule.kind === "unspecified" && wave.depends_on.length) {
        wave.schedule = { ...wave.schedule, kind: "after", after_wave: wave.depends_on[0].category };
      }
      lastWave = wave;
    }
  }

  if (!intent.waves.length) {
    intent.waves.push({ category: "all", schedule: parseSchedule(raw), depends_on: [] });
  }
  if (intent.waves[0].schedule.kind === "unspecified") intent.wants_recommendation = true;
  return intent;
}

module.exports = { interpretRules, parseSchedule, parseTime, splitClauses };
