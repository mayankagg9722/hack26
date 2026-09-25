/* Goal planner: intent (from the rules or Claude interpreter) → migration goal
   document (see model.js). Resolves schedules in the customer's timezone,
   sizes waves from real source data, wires dependencies, applies defaults
   and flags conflicts. normalizeGoal() re-validates admin edits. */

const crypto = require("crypto");
const {
  DAYS, zonedParts, zonedToUtc, addDays, weekdayOf, parseHHMM, hhmm, windowBlackoutConflict,
} = require("./time");
const {
  DEFAULT_SUCCESS_CRITERIA, DEFAULT_FAILURE_POLICY, DEFAULT_WINDOW, OVERRUN_POLICIES, SCHEDULE_TYPES,
  RECORD_TYPES, WAVE_STATES, deriveGoalStatus, displayStatus, transition,
} = require("./model");
const { workspaceForCategory } = require("../mapping/workspaces");

const CATEGORY_NAMES = { it: "IT", hr: "HR", finance: "Finance", facilities: "Facilities", all: "All records" };
const DEFAULT_TIME = "23:00";
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

class PlanError extends Error {}

/* ---------- schedule resolution ---------- */

function localDate(parts) {
  return { year: parts.year, month: parts.month, day: parts.day };
}

function atLocal(date, time, tz) {
  const t = parseHHMM(time) || parseHHMM(DEFAULT_TIME);
  return zonedToUtc(date.year, date.month, date.day, t.h, t.mi, tz);
}

function nextWeekday(fromDate, dayIndex, inclusive) {
  const diff = (dayIndex - weekdayOf(fromDate) + 7) % 7;
  return addDays(fromDate, diff === 0 && !inclusive ? 7 : diff);
}

function describeWhen(s) {
  const time = s.time ? " at " + s.time : "";
  if (s.kind === "immediate") return "Immediately";
  if (s.kind === "after") return "After " + (CATEGORY_NAMES[s.after_wave] || s.after_wave) + " validation";
  if (s.date) return s.date.replace("MM-DD:", "") + time;
  if (s.day_offset === 1) return "Tomorrow" + time;
  if (s.day_offset === 0) return "Today" + time;
  if (s.day) return [s.relative === "following" ? "Following" : s.relative === "next" ? "Next" : "This", cap(s.day)].join(" ") + time;
  if (s.kind === "relative") return "A week after the previous wave" + time;
  return time ? "Next" + time : "Not specified";
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve an intent schedule to an instant.
 * @returns {{at: Date|null, assumed: string[]}}
 */
function resolveSchedule(s, { tz, now, prevAt }) {
  const assumed = [];
  const today = localDate(zonedParts(now, tz));
  const time = s.time || (prevAt && s.kind === "relative" ? hhmm(zonedParts(prevAt, tz).hour, zonedParts(prevAt, tz).minute) : null);
  const useTime = time || DEFAULT_TIME;
  if (!time && s.kind !== "immediate") assumed.push("No time given — assumed 11:00 PM (outside business hours).");

  if (s.kind === "immediate") return { at: new Date(Math.ceil(now.getTime() / 60000) * 60000), assumed: [] };

  if (s.kind === "relative") {
    if (!prevAt) return resolveSchedule({ ...s, kind: "at", relative: "next" }, { tz, now, prevAt });
    const prev = localDate(zonedParts(prevAt, tz));
    const weeks = s.week_offset || 1;
    let date;
    if (s.day) date = addDays(nextWeekday(prev, DAYS.indexOf(s.day), false), 7 * (weeks - 1));
    else date = addDays(prev, 7 * weeks);
    return { at: atLocal(date, useTime, tz), assumed };
  }

  // kind "at"
  let date = null;
  if (s.date) {
    if (s.date.startsWith("MM-DD:")) {
      const [m, d] = s.date.slice(6).split("-").map(Number);
      date = { year: today.year, month: m, day: d };
      if (atLocal(date, useTime, tz) < now) date = { ...date, year: date.year + 1 };
    } else {
      const [y, m, d] = s.date.split("-").map(Number);
      date = { year: y, month: m, day: d };
    }
  } else if (s.day_offset != null) {
    date = addDays(today, s.day_offset);
  } else if (s.day) {
    date = nextWeekday(today, DAYS.indexOf(s.day), true);
    if (s.relative === "next") date = addDays(date, 7);
    if (atLocal(date, useTime, tz) <= now) {
      date = addDays(date, 7);
      assumed.push("That time has already passed this week — moved to the following week.");
    }
  } else {
    date = today;
    if (atLocal(date, useTime, tz) <= now) date = addDays(today, 1);
  }
  return { at: atLocal(date, useTime, tz), assumed };
}

/* ---------- recommendation ---------- */

function recommendSlot({ tz, now, blackouts, durationMinutes, volume }) {
  const today = localDate(zonedParts(now, tz));
  let date = nextWeekday(today, 6, true); // Saturday
  for (let i = 0; i < 8; i++) {
    const start = atLocal(date, DEFAULT_TIME, tz);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    if (start.getTime() > now.getTime() + 2 * 3600000 && !windowBlackoutConflict(start, end, blackouts, tz)) {
      const reasons = [
        "Outside business hours",
        "Lower expected user activity on a Saturday night",
        "Leaves Sunday for validation before Monday",
        "Allows human intervention if required",
      ];
      if (volume) reasons.push("Sized for about " + Number(volume).toLocaleString() + " records in a " + Math.round(durationMinutes / 60) + "-hour window");
      return { label: "Zen recommendation", at: start.toISOString(), window_minutes: durationMinutes, reasons, applied: true };
    }
    date = addDays(date, 7);
  }
  return null;
}

/* ---------- windows ---------- */

function windowDuration(intentWindow, startAt, tz) {
  if (intentWindow && intentWindow.duration_minutes) return Math.round(intentWindow.duration_minutes);
  if (intentWindow && intentWindow.end_time && startAt) {
    const s = zonedParts(startAt, tz);
    const e = parseHHMM(intentWindow.end_time);
    let mins = e.h * 60 + e.mi - (s.hour * 60 + s.minute);
    if (mins <= 0) mins += 24 * 60;
    return mins;
  }
  return DEFAULT_WINDOW.duration_minutes;
}

function waveWindow(at, minutes) {
  if (!at) return { start: null, end: null };
  const start = new Date(at);
  return { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString() };
}

/* ---------- mapping context (counts) ---------- */

async function mappingContext(engine, savedMapping) {
  let fields;
  let fieldMapping;
  if (savedMapping) {
    fields = savedMapping.fields.filter((f) => f.targetField && f.decision !== "rejected");
    fieldMapping = { status: "approved", version: savedMapping.version, approved_at: savedMapping.approvedAt, fields: fields.length };
  } else {
    const { rows } = await engine.suggestMapping();
    fields = rows.filter((r) => r.targetField).map((r) => ({ sourceField: r.sourceField, targetField: r.targetField }));
    fieldMapping = { status: "suggested", version: null, approved_at: null, fields: fields.length };
  }
  const workspaceRules = (savedMapping && savedMapping.workspaceRules) || {};
  const summary = await engine.workspaceSummary({ fields, workspaceRules });
  return { fields, fieldMapping, workspaceRules, summary };
}

/* ---------- derived pieces ---------- */

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(5).toString("hex");
}

function estimateFor(wave, summary) {
  if (wave.category === "all" || !wave.workspace) return { ...summary.totals };
  const ws = summary.workspaces.find((w) => String(w.id) === String(wave.workspace.id));
  return ws ? { tickets: ws.tickets, employees: ws.employees } : { tickets: 0, employees: 0 };
}

function detectCycle(waves) {
  const deps = Object.fromEntries(waves.map((w) => [w.wave_id, (w.depends_on || []).map((d) => d.wave_id)]));
  const state = {};
  const visit = (id, path) => {
    if (state[id] === 1) return path.concat(id);
    if (state[id] === 2) return null;
    state[id] = 1;
    for (const d of deps[id] || []) {
      const c = visit(d, path.concat(id));
      if (c) return c;
    }
    state[id] = 2;
    return null;
  };
  for (const w of waves) {
    const c = visit(w.wave_id, []);
    if (c) return c;
  }
  return null;
}

/* Recompute everything derived from the editable parts of a goal. */
function finalize(goal, { summary, now }) {
  const tz = goal.schedule.timezone;
  const minutes = goal.migration_window.duration_minutes;
  const warnings = [];
  const byId = Object.fromEntries(goal.waves.map((w) => [w.wave_id, w]));

  const cycle = detectCycle(goal.waves);
  if (cycle) throw new PlanError("Circular dependency: " + cycle.map((id) => (byId[id] || {}).name || id).join(" → "));

  // resolve estimated start for dependency-triggered waves (weekly cadence after the upstream wave)
  const estimate = (w, seen = new Set()) => {
    if (w.schedule.type !== "after_dependency") return w.schedule.at;
    if (seen.has(w.wave_id)) return null;
    seen.add(w.wave_id);
    const ups = (w.depends_on || []).map((d) => byId[d.wave_id]).filter(Boolean).map((u) => estimate(u, seen)).filter(Boolean);
    if (!ups.length) return null;
    const latest = new Date(Math.max(...ups.map((u) => new Date(u).getTime())));
    return new Date(latest.getTime() + 7 * 24 * 3600000).toISOString();
  };

  goal.waves.forEach((w, i) => {
    w.order = i + 1;
    if (w.schedule.type === "after_dependency") {
      w.schedule.at = null;
      w.schedule.estimated_at = estimate(w);
      if (!(w.depends_on || []).length) warnings.push(w.name + " runs after another wave but has no dependency — pick one.");
    } else {
      w.schedule.estimated_at = null;
    }
    const start = w.schedule.at || w.schedule.estimated_at;
    w.window = waveWindow(start, minutes);
    w.window.estimated = !w.schedule.at && Boolean(start);
    if (summary) w.record_estimate = estimateFor(w, summary);
    if (start) {
      const hit = windowBlackoutConflict(new Date(w.window.start), new Date(w.window.end), goal.blackout_periods, tz);
      if (hit) warnings.push(w.name + " window overlaps the \"" + (hit.blackout.label || "blackout") + "\" blackout period.");
      if (w.schedule.at && new Date(w.window.end) < now && ["DRAFT", "PLANNED"].includes(w.status)) {
        warnings.push(w.name + " is scheduled in the past — pick a new time.");
      }
    }
    if (!w.workspace && w.category !== "all") warnings.push(w.name + " has no matching workspace in " + goal.target.name + ".");
  });

  goal.dependencies = goal.waves.flatMap((w) => (w.depends_on || []).map((d) => ({
    from: d.wave_id, to: w.wave_id, condition: d.condition || "success_criteria_met", condition_text: d.condition_text || "",
  })));

  // coverage: workspaces with records that no wave migrates
  if (summary && !goal.waves.some((w) => w.category === "all")) {
    const covered = new Set(goal.waves.filter((w) => w.workspace).map((w) => String(w.workspace.id)));
    goal.uncovered_workspaces = summary.workspaces.filter((ws) => ws.tickets > 0 && !covered.has(String(ws.id)))
      .map((ws) => ({ id: ws.id, name: ws.name, tickets: ws.tickets, employees: ws.employees }));
    for (const u of goal.uncovered_workspaces) {
      warnings.push(u.name + " has " + u.tickets.toLocaleString() + " tickets that are not in any wave.");
    }
  } else {
    goal.uncovered_workspaces = [];
  }

  const starts = goal.waves.map((w) => w.schedule.at || w.schedule.estimated_at).filter(Boolean).sort();
  goal.schedule.first_start = starts[0] || null;
  goal.schedule.strategy = goal.waves.length > 1 ? "waves" : "single";
  const first = goal.waves.find((w) => w.schedule.at);
  if (first) {
    const p = zonedParts(new Date(first.schedule.at), tz);
    const end = new Date(new Date(first.schedule.at).getTime() + minutes * 60000);
    const e = zonedParts(end, tz);
    goal.migration_window.start_time = hhmm(p.hour, p.minute);
    goal.migration_window.end_time = hhmm(e.hour, e.minute);
  }

  goal.waves.forEach((w) => { w.display_status = displayStatus(goal, w); });
  goal.status = deriveGoalStatus(goal);
  goal.warnings = warnings;
  goal.updated_at = new Date().toISOString();
  return goal;
}

/* ---------- build from intent ---------- */

/**
 * @param {object} intent   from rulesInterpreter / aiInterpreter
 * @param {object} ctx
 * @param {string} ctx.text
 * @param {Date}   ctx.now
 * @param {string} ctx.timezone
 * @param {{sources, targets}} ctx.catalog
 * @param {{source, target}} ctx.defaults     used when the text names no system
 * @param {{count, seed}} ctx.demo
 * @param {(source, target) => MigrationEngine} ctx.engineFor
 * @param {object} ctx.mappingStore
 * @param {{method, model?, error?}} ctx.interpretation
 */
async function buildGoal(intent, ctx) {
  const tz = ctx.timezone;
  const now = ctx.now;
  const notes = (intent.notes || []).slice();

  const sourceId = intent.source || ctx.defaults.source;
  const targetId = intent.target || ctx.defaults.target;
  if (!intent.source) notes.push("No source named — using the currently selected source.");
  if (!intent.target) notes.push("No target named — using the currently selected target.");
  const source = ctx.catalog.sources.find((s) => s.id === sourceId);
  const target = ctx.catalog.targets.find((t) => t.id === targetId);
  if (!source) throw new PlanError("Unknown source system: " + sourceId);
  if (!target) throw new PlanError("Unknown target system: " + targetId);

  const engine = ctx.engineFor(source.id, target.id);
  const saved = await ctx.mappingStore.get(source.id, target.id);
  const mapCtx = await mappingContext(engine, saved);
  const workspaces = mapCtx.summary.workspaces;
  if (mapCtx.fieldMapping.status !== "approved") {
    notes.push("No approved field mapping yet — record counts use Zen's suggested mapping. Approve one before the first wave.");
  }

  // success criteria: stated values override defaults
  const successCriteria = {};
  const defaultsApplied = [];
  for (const [k, v] of Object.entries(DEFAULT_SUCCESS_CRITERIA)) {
    const stated = intent.success_criteria ? intent.success_criteria[k] : null;
    if (stated === null || stated === undefined) {
      successCriteria[k] = v;
      defaultsApplied.push(k);
    } else {
      successCriteria[k] = stated;
    }
  }

  const blackouts = (intent.blackout || []).map((b) => ({
    label: b.label || "Blackout", days: b.days, start: b.start, end: b.end,
  }));

  // waves with ids first, so dependencies can reference them
  const seen = new Set();
  const intentWaves = (intent.waves || []).filter((w) => {
    if (seen.has(w.category)) return false;
    seen.add(w.category);
    return true;
  });
  const waves = intentWaves.map((w, i) => {
    const ws = w.category === "all" ? null : workspaceForCategory(w.category, workspaces);
    return {
      wave_id: "w" + (i + 1),
      order: i + 1,
      name: CATEGORY_NAMES[w.category] || w.category,
      category: w.category,
      workspace: ws ? { id: ws.id, name: ws.name } : null,
      record_estimate: null,
      schedule: { type: "at", at: null, estimated_at: null, expression: describeWhen(w.schedule), recommended: false },
      window: null,
      depends_on: [],
      success_criteria: null, // null → goal-level criteria
      status: "DRAFT",
      status_reason: "",
      history: [],
      prechecks: null,
      result: null,
    };
  });
  const byCategory = Object.fromEntries(waves.map((w) => [w.category, w]));

  intentWaves.forEach((iw, i) => {
    const wave = waves[i];
    for (const d of iw.depends_on || []) {
      const up = byCategory[d.category];
      if (up && up !== wave && !wave.depends_on.some((x) => x.wave_id === up.wave_id)) {
        wave.depends_on.push({ wave_id: up.wave_id, condition: "success_criteria_met", condition_text: d.condition_text || "" });
      } else if (!up) {
        notes.push("'" + wave.name + "' depends on " + (CATEGORY_NAMES[d.category] || d.category) + ", which isn't a wave — dependency ignored.");
      }
    }
    if (iw.schedule.kind === "after" && iw.schedule.after_wave && byCategory[iw.schedule.after_wave]
        && !wave.depends_on.some((x) => x.wave_id === byCategory[iw.schedule.after_wave].wave_id)) {
      wave.depends_on.push({ wave_id: byCategory[iw.schedule.after_wave].wave_id, condition: "success_criteria_met", condition_text: "after " + iw.schedule.after_wave + " validation" });
    }
  });

  // resolve schedules in order
  const durationGuess = windowDuration(intent.window, null, tz);
  let recommendation = null;
  let prevAt = null;
  intentWaves.forEach((iw, i) => {
    const wave = waves[i];
    const s = { ...iw.schedule };
    if (!s.time && intent.window && intent.window.start_time) s.time = intent.window.start_time;

    if (s.kind === "after" || (s.kind === "unspecified" && wave.depends_on.length)) {
      wave.schedule.type = "after_dependency";
      if (s.kind === "unspecified") wave.schedule.expression = "After " + wave.depends_on.map((d) => waves.find((x) => x.wave_id === d.wave_id).name).join(", ") + " validation";
      return;
    }
    if (s.kind === "unspecified") {
      if (intent.recurrence) {
        const base = prevAt
          ? { kind: "relative", day: intent.recurrence.day, week_offset: 1, time: intent.recurrence.time }
          : { kind: "at", day: intent.recurrence.day, relative: "this", time: intent.recurrence.time };
        const r = resolveSchedule(base, { tz, now, prevAt });
        wave.schedule.at = r.at.toISOString();
        wave.schedule.expression = "Every " + cap(intent.recurrence.day) + " at " + intent.recurrence.time + " (wave " + (i + 1) + ")";
      } else if (!prevAt) {
        recommendation = recommendSlot({ tz, now, blackouts, durationMinutes: durationGuess, volume: intent.volume_hint || mapCtx.summary.totals.tickets });
        if (recommendation) {
          wave.schedule.at = recommendation.at;
          wave.schedule.recommended = true;
          wave.schedule.expression = "Recommended by Zen";
        } else {
          wave.schedule.type = "immediate";
          wave.schedule.at = now.toISOString();
        }
      } else {
        const r = resolveSchedule({ kind: "relative", week_offset: 1 }, { tz, now, prevAt });
        wave.schedule.at = r.at.toISOString();
        wave.schedule.expression = "A week after the previous wave";
        notes.push(wave.name + " had no time — assumed one week after the previous wave.");
      }
    } else {
      const r = resolveSchedule(s, { tz, now, prevAt });
      wave.schedule.type = s.kind === "immediate" ? "immediate" : "at";
      wave.schedule.at = r.at.toISOString();
      r.assumed.forEach((a) => notes.push(wave.name + ": " + a));
    }
    prevAt = new Date(wave.schedule.at);
  });

  const firstAt = waves.map((w) => w.schedule.at).filter(Boolean)[0];
  const duration = windowDuration(intent.window, firstAt ? new Date(firstAt) : null, tz);

  // explicit time inside a blackout → offer a recommendation without overriding the customer
  if (!recommendation && blackouts.length && firstAt) {
    const end = new Date(new Date(firstAt).getTime() + duration * 60000);
    if (windowBlackoutConflict(new Date(firstAt), end, blackouts, tz)) {
      recommendation = recommendSlot({ tz, now, blackouts, durationMinutes: duration, volume: intent.volume_hint });
      if (recommendation) recommendation.applied = false;
    }
  }

  const failurePolicy = { ...DEFAULT_FAILURE_POLICY };
  if (intent.failure_policy) {
    if (intent.failure_policy.pause_below_success_rate != null) failurePolicy.pause_below_success_rate = intent.failure_policy.pause_below_success_rate;
    if (intent.failure_policy.on_critical_failure) failurePolicy.on_critical_failure = intent.failure_policy.on_critical_failure;
  }

  const options = {
    workspace_classification: true,
    validation: intent.options ? intent.options.validation !== false : true,
    remediation: intent.options ? intent.options.remediation !== false : true,
    human_escalation: intent.options ? intent.options.human_escalation !== false : true,
  };
  const recordTypes = (intent.record_types || []).filter((r) => RECORD_TYPES.includes(r));

  const goal = {
    goal_id: newId("goal"),
    goal_description: ctx.text,
    title: (recordTypes.length === 2 ? "Employee + Ticket" : recordTypes[0] === "employees" ? "Employee" : "Ticket") +
      " migration: " + source.name + " → " + target.name,
    source: { id: source.id, name: source.name, mode: source.mode, demo: ctx.demo },
    target: { id: target.id, name: target.name, mode: target.mode },
    record_types: recordTypes.length ? recordTypes : ["employees", "tickets"],
    scope: { type: intent.scope === "filtered" ? "filtered" : "all", filter: null },
    options,
    field_mapping: { ref: source.id + "->" + target.id, ...mapCtx.fieldMapping },
    workspace_mapping: {
      enabled: true,
      overrides: mapCtx.workspaceRules,
      department_field: mapCtx.summary.departmentField,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, tickets: w.tickets, employees: w.employees })),
    },
    waves,
    schedule: { timezone: tz, first_start: null, strategy: null, recurrence: intent.recurrence || null },
    migration_window: {
      duration_minutes: duration,
      start_time: null,
      end_time: null,
      on_overrun: OVERRUN_POLICIES.includes(intent.window && intent.window.on_overrun) ? intent.window.on_overrun : DEFAULT_WINDOW.on_overrun,
    },
    dependencies: [],
    success_criteria: successCriteria,
    failure_policy: failurePolicy,
    blackout_periods: blackouts,
    recommendation,
    interpretation: { ...ctx.interpretation, notes, defaults_applied: defaultsApplied, intent },
    status: "DRAFT",
    approved_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    version: 1,
  };
  return finalize(goal, { summary: mapCtx.summary, now });
}

/* ---------- admin edits ---------- */

const TIME_RE = /^\d{2}:\d{2}$/;

function clean(stored, input) {
  const g = JSON.parse(JSON.stringify(stored));
  if (typeof input.title === "string" && input.title.trim()) g.title = input.title.trim().slice(0, 160);
  if (Array.isArray(input.record_types)) {
    const rt = input.record_types.filter((r) => RECORD_TYPES.includes(r));
    if (!rt.length) throw new PlanError("Pick at least one record type");
    g.record_types = rt;
  }
  if (input.options && typeof input.options === "object") {
    for (const k of ["validation", "remediation", "human_escalation"]) {
      if (typeof input.options[k] === "boolean") g.options[k] = input.options[k];
    }
  }
  if (input.success_criteria) {
    const sc = input.success_criteria;
    const rate = Number(sc.min_success_rate);
    if (!(rate > 0 && rate <= 1)) throw new PlanError("Success rate must be between 1% and 100%");
    const crit = Number(sc.max_critical_errors);
    if (!(crit >= 0 && Number.isInteger(crit))) throw new PlanError("Critical errors must be a whole number ≥ 0");
    g.success_criteria = {
      min_success_rate: rate,
      max_critical_errors: crit,
      required_fields_populated: Boolean(sc.required_fields_populated),
      reconciliation_complete: Boolean(sc.reconciliation_complete),
      no_unresolved_high_severity: Boolean(sc.no_unresolved_high_severity),
    };
  }
  if (input.failure_policy) {
    const p = input.failure_policy;
    const pause = p.pause_below_success_rate === null || p.pause_below_success_rate === "" ? null : Number(p.pause_below_success_rate);
    if (pause !== null && !(pause > 0 && pause <= 1)) throw new PlanError("Pause threshold must be between 1% and 100%");
    const actions = ["continue", "ai_remediation", "human_review", "pause", "stop", "escalate"];
    for (const k of ["on_success", "on_partial_failure", "on_unresolved", "on_critical_failure"]) {
      if (p[k] !== undefined && !actions.includes(p[k])) throw new PlanError("Invalid policy for " + k);
    }
    g.failure_policy = { ...g.failure_policy, ...p, pause_below_success_rate: pause };
  }
  if (input.migration_window) {
    const mins = Number(input.migration_window.duration_minutes);
    if (!(mins >= 30 && mins <= 24 * 60)) throw new PlanError("Window must be between 30 minutes and 24 hours");
    const on = input.migration_window.on_overrun;
    if (!OVERRUN_POLICIES.includes(on)) throw new PlanError("Invalid window overrun policy");
    g.migration_window.duration_minutes = Math.round(mins);
    g.migration_window.on_overrun = on;
  }
  if (Array.isArray(input.blackout_periods)) {
    g.blackout_periods = input.blackout_periods.map((b) => {
      const days = (b.days || []).filter((d) => DAY_ABBR.includes(d));
      if (!days.length || !TIME_RE.test(b.start) || !TIME_RE.test(b.end) || b.start >= b.end) {
        throw new PlanError("Each blackout needs days and a start time before its end time");
      }
      return { label: String(b.label || "Blackout").slice(0, 60), days, start: b.start, end: b.end };
    });
  }
  return g;
}

function cleanWaves(stored, inputWaves, workspaces, now) {
  if (!Array.isArray(inputWaves) || !inputWaves.length) throw new PlanError("A goal needs at least one wave");
  const prev = Object.fromEntries(stored.waves.map((w) => [w.wave_id, w]));
  const ids = new Set();
  const approved = Boolean(stored.approved_at);
  let n = stored.waves.reduce((m, w) => Math.max(m, parseInt(w.wave_id.slice(1), 10) || 0), 0);

  const waves = inputWaves.map((iw) => {
    const old = iw.wave_id && prev[iw.wave_id];
    const id = old ? old.wave_id : "w" + (++n);
    if (ids.has(id)) throw new PlanError("Duplicate wave " + id);
    ids.add(id);
    const ws = iw.workspace_id != null ? workspaces.find((w) => String(w.id) === String(iw.workspace_id)) : (old && old.workspace);
    const type = iw.schedule && SCHEDULE_TYPES.includes(iw.schedule.type) ? iw.schedule.type : (old ? old.schedule.type : "at");
    let at = null;
    if (type === "at") {
      at = iw.schedule && iw.schedule.at ? new Date(iw.schedule.at) : null;
      if (!at || isNaN(at)) throw new PlanError("Wave " + (iw.name || id) + " needs a valid start time");
      at = at.toISOString();
    } else if (type === "immediate") {
      at = (old && old.schedule.type === "immediate" && old.schedule.at) || now.toISOString();
    }
    const wave = old ? JSON.parse(JSON.stringify(old)) : {
      wave_id: id, category: ws ? String(ws.id) : "custom", record_estimate: null, success_criteria: null,
      status: approved ? "PLANNED" : "DRAFT", status_reason: "", history: [], prechecks: null, result: null,
      schedule: { expression: "Added by admin" },
    };
    const changed = old && (old.schedule.type !== type || old.schedule.at !== at);
    wave.name = String(iw.name || wave.name || "Wave").slice(0, 60);
    wave.workspace = ws ? { id: ws.id, name: ws.name } : null;
    wave.schedule = {
      ...wave.schedule, type, at,
      recommended: changed ? false : Boolean(wave.schedule.recommended),
      expression: changed ? "Set by admin" : wave.schedule.expression,
    };
    wave.depends_on = (iw.depends_on || []).map((d) => ({
      wave_id: String(d.wave_id || d),
      condition: "success_criteria_met",
      condition_text: (old && (old.depends_on || []).find((x) => x.wave_id === (d.wave_id || d)) || {}).condition_text || "",
    }));
    if (changed && ["READY", "BLOCKED", "HUMAN_REVIEW_REQUIRED"].includes(wave.status)) {
      transition(wave, "PLANNED", "Schedule changed — pre-checks must run again.");
      wave.prechecks = null;
    }
    return wave;
  });
  for (const w of waves) {
    for (const d of w.depends_on) {
      if (!ids.has(d.wave_id)) throw new PlanError(w.name + " depends on a wave that doesn't exist");
      if (d.wave_id === w.wave_id) throw new PlanError(w.name + " can't depend on itself");
    }
  }
  const removed = stored.waves.filter((w) => !ids.has(w.wave_id));
  const active = removed.find((w) => !["DRAFT", "PLANNED", "BLOCKED", "HUMAN_REVIEW_REQUIRED", "READY"].includes(w.status));
  if (active) throw new PlanError("Wave " + active.name + " is " + active.status + " and can't be removed");
  return waves;
}

/**
 * Apply admin edits to a stored goal and recompute derived fields.
 * @param {object} stored  current goal
 * @param {object} input   edited goal (editable fields only are read)
 * @param {object} ctx     { engineFor, mappingStore, now }
 */
async function normalizeGoal(stored, input, ctx) {
  const g = clean(stored, input);
  const engine = ctx.engineFor(g.source.id, g.target.id);
  const saved = await ctx.mappingStore.get(g.source.id, g.target.id);
  const mapCtx = await mappingContext(engine, saved);
  if (input.waves) g.waves = cleanWaves(stored, input.waves, mapCtx.summary.workspaces, ctx.now);
  g.field_mapping = { ref: g.source.id + "->" + g.target.id, ...mapCtx.fieldMapping };
  g.workspace_mapping = {
    ...g.workspace_mapping,
    overrides: mapCtx.workspaceRules,
    department_field: mapCtx.summary.departmentField,
    workspaces: mapCtx.summary.workspaces.map((w) => ({ id: w.id, name: w.name, tickets: w.tickets, employees: w.employees })),
  };
  if (g.recommendation && input.waves) {
    const first = g.waves.find((w) => w.schedule.recommended);
    g.recommendation.applied = Boolean(first);
  }
  g.version = (stored.version || 1) + 1;
  return finalize(g, { summary: mapCtx.summary, now: ctx.now });
}

/** Refresh derived fields (statuses, windows) without re-reading source data. */
function refresh(goal, now = new Date()) {
  return finalize(goal, { summary: null, now });
}

module.exports = { buildGoal, normalizeGoal, refresh, resolveSchedule, recommendSlot, PlanError, CATEGORY_NAMES, WAVE_STATES };
