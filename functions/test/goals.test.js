const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { interpretRules } = require("../migration/goals/rulesInterpreter");
const { normalizeAiIntent, interpretWithClaude } = require("../migration/goals/aiInterpreter");
const { buildGoal, resolveSchedule } = require("../migration/goals/planner");
const { runPrechecks } = require("../migration/goals/prechecks");
const {
  transition, dueWaves, evaluateSuccessCriteria, decideNextAction, windowAction, deriveGoalStatus, TransitionError,
} = require("../migration/goals/model");
const { zonedToUtc, zonedParts, inBlackout } = require("../migration/goals/time");
const { JsonFileGoalStore } = require("../migration/goals/store");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { createSourceAdapter, createTargetAdapter, listIntegrations } = require("../migration/registry");
const { MigrationEngine } = require("../migration/engine");
const { createMigrationApi } = require("../migration/api");

const DEMO = "Migrate all employee and ticket records from Jira Service Management to Freshservice. Start with IT this Saturday at 11 PM. If IT migration succeeds with at least 95% success and has no critical errors, migrate Finance the following Saturday. HR should migrate after Finance is successfully validated. Do not run migrations during business hours.";
const NOW = new Date("2026-09-25T10:00:00Z"); // Friday
const TZ = "Asia/Kolkata";
const CATALOG = listIntegrations({});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zen-goals-"));
}
function engineFor(s, t) {
  return new MigrationEngine({ source: createSourceAdapter(s, { count: 750, seed: 42 }, {}), target: createTargetAdapter(t, {}) });
}
function local(iso, tz = TZ) {
  const p = zonedParts(new Date(iso), tz);
  return { ...p, str: p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0") + " " + String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0") };
}
async function build(text, { store, tz = TZ, now = NOW } = {}) {
  return buildGoal(interpretRules(text, CATALOG), {
    text, now, timezone: tz, catalog: CATALOG, defaults: { source: "jira", target: "freshservice" },
    demo: { count: 750, seed: 42 }, engineFor, interpretation: { method: "rules" },
    mappingStore: store || new JsonFileMappingStore(path.join(tmpDir(), "m.json")),
  });
}
function call(handler, method, urlPath, { query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, body: data }); },
      send(data) { resolve({ status: this.statusCode, body: data }); },
    };
    handler({ method, path: urlPath, query, body }, res);
  });
}

/* ---------- time ---------- */

test("time: zonedToUtc round-trips across timezones and DST", () => {
  for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Sydney"]) {
    for (const [y, m, d] of [[2026, 9, 26], [2026, 11, 7], [2027, 3, 13]]) {
      const p = zonedParts(zonedToUtc(y, m, d, 23, 0, tz), tz);
      assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [y, m, d, 23, 0], tz);
    }
  }
});

test("time: blackout detection in local time", () => {
  const b = [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" }];
  assert.ok(inBlackout(zonedToUtc(2026, 9, 28, 10, 0, TZ), b, TZ)); // Monday 10:00
  assert.equal(inBlackout(zonedToUtc(2026, 9, 26, 23, 0, TZ), b, TZ), null); // Saturday 23:00
  assert.equal(inBlackout(zonedToUtc(2026, 9, 28, 18, 0, TZ), b, TZ), null); // end is exclusive
});

test("resolveSchedule: this / next / following / tomorrow / immediate", () => {
  const ctx = { tz: TZ, now: NOW, prevAt: null };
  assert.equal(local(resolveSchedule({ kind: "at", day: "saturday", relative: "this", time: "23:00" }, ctx).at).str, "2026-09-26 23:00");
  assert.equal(local(resolveSchedule({ kind: "at", day: "saturday", relative: "next", time: "23:00" }, ctx).at).str, "2026-10-03 23:00");
  assert.equal(local(resolveSchedule({ kind: "at", day_offset: 1, time: "22:00" }, ctx).at).str, "2026-09-26 22:00");
  const prevAt = zonedToUtc(2026, 9, 26, 23, 0, TZ);
  assert.equal(local(resolveSchedule({ kind: "relative", day: "saturday", week_offset: 1 }, { ...ctx, prevAt }).at).str, "2026-10-03 23:00");
  const imm = resolveSchedule({ kind: "immediate" }, ctx).at;
  assert.ok(Math.abs(imm - NOW) < 60000);
  const passed = resolveSchedule({ kind: "at", day: "friday", relative: "this", time: "09:00" }, ctx); // Fri 09:00 IST already passed
  assert.equal(local(passed.at).str, "2026-10-02 09:00");
  assert.ok(passed.assumed.length);
});

/* ---------- interpretation ---------- */

test("rules: the exact demo scenario", () => {
  const i = interpretRules(DEMO, CATALOG);
  assert.equal(i.source, "jira");
  assert.equal(i.target, "freshservice");
  assert.deepEqual(i.record_types, ["employees", "tickets"]);
  assert.deepEqual(i.waves.map((w) => w.category), ["it", "finance", "hr"]);
  assert.deepEqual(i.waves[0].schedule, { kind: "at", day: "saturday", relative: "this", date: null, time: "23:00", day_offset: null, week_offset: null, after_wave: null });
  assert.equal(i.waves[1].schedule.kind, "relative");
  assert.deepEqual(i.waves[1].depends_on.map((d) => d.category), ["it"]);
  assert.equal(i.waves[2].schedule.kind, "after");
  assert.deepEqual(i.waves[2].depends_on.map((d) => d.category), ["finance"]);
  assert.equal(i.success_criteria.min_success_rate, 0.95);
  assert.equal(i.success_criteria.max_critical_errors, 0);
  assert.deepEqual(i.blackout, [{ label: "Business hours", days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" }]);
});

test("rules: natural-language scheduling examples", () => {
  const w = (t) => interpretRules(t, CATALOG);
  assert.equal(w("Migrate IT this weekend.").waves[0].schedule.day, "saturday");
  const fin = w("Run the Finance migration next Saturday at 11 PM.").waves[0];
  assert.deepEqual([fin.category, fin.schedule.relative, fin.schedule.time], ["finance", "next", "23:00"]);
  const hr = w("Do HR after IT is successfully validated.").waves[0];
  assert.deepEqual([hr.category, hr.schedule.kind, hr.depends_on[0].category], ["hr", "after", "it"]);
  assert.equal(w("Don't run anything during business hours.").blackout.length, 1);
  assert.equal(w("Pause the migration if success rate drops below 90%.").failure_policy.pause_below_success_rate, 0.9);
  const vol = w("We have 10,000 tickets and don't want to disrupt employees during business hours.");
  assert.equal(vol.volume_hint, 10000);
  assert.equal(vol.wants_recommendation, true);
  assert.deepEqual(vol.record_types, ["tickets"]);
  const chain = w("Migrate everything from Jira to Freshservice, starting with IT this weekend, then Finance next weekend, and HR after that.");
  assert.deepEqual(chain.waves.map((x) => x.category), ["it", "finance", "hr"]);
  assert.deepEqual(chain.waves[2].depends_on.map((d) => d.category), ["finance"]);
  const win = w("Migrate Facilities tomorrow between 10 PM and 3 AM and escalate if it is not complete.");
  assert.deepEqual([win.window.start_time, win.window.end_time], ["22:00", "03:00"]);
  const rec = w("Migrate IT, then Finance, every Saturday at 11 PM.");
  assert.deepEqual(rec.recurrence, { every: "week", day: "saturday", time: "23:00" });
  assert.equal(w("Migrate it this weekend.").waves[0].category, "all", "lower-case 'it' is a pronoun");
});

test("ai intent normalisation: sentinels → nulls, options default on", () => {
  const i = normalizeAiIntent({
    source: "jira", target: "", record_types: [], scope: "all",
    waves: [{ category: "it", schedule: { kind: "at", day: "saturday", relative: "this", date: "", time: "23:00", day_offset: -1, week_offset: -1, after_wave: "" }, depends_on: [] }],
    success_criteria: { min_success_rate: 0.95, max_critical_errors: -1, required_fields_populated: false, reconciliation_complete: true, no_unresolved_high_severity: false },
    blackout: [{ label: "x", days: ["mon"], start: "9", end: "18:00" }],
    failure_policy: { pause_below_success_rate: -1, on_critical_failure: "" },
    window: { duration_minutes: -1, start_time: "", end_time: "04:00", on_overrun: "" },
    options: { validation: "unstated", remediation: "disabled", human_escalation: "unstated" },
    recurrence: { enabled: false, day: "", time: "" }, wants_recommendation: false, volume_hint: -1, notes: [],
  });
  assert.equal(i.target, null);
  assert.deepEqual(i.record_types, ["employees", "tickets"]);
  assert.equal(i.waves[0].schedule.day_offset, null);
  assert.equal(i.success_criteria.max_critical_errors, null);
  assert.equal(i.success_criteria.required_fields_populated, null);
  assert.equal(i.success_criteria.reconciliation_complete, true);
  assert.equal(i.blackout.length, 0, "invalid times dropped");
  assert.equal(i.window.end_time, "04:00");
  assert.deepEqual(i.options, { validation: true, remediation: false, human_escalation: true });
  assert.equal(i.recurrence, null);
});

test("ai interpreter: request shape and refusal handling", async () => {
  let req;
  const ok = { beta: { messages: { create: async (r) => { req = r; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
    source: "jira", target: "freshservice", record_types: ["tickets"], scope: "all", waves: [],
    success_criteria: { min_success_rate: -1, max_critical_errors: -1, required_fields_populated: false, reconciliation_complete: false, no_unresolved_high_severity: false },
    blackout: [], failure_policy: { pause_below_success_rate: -1, on_critical_failure: "" },
    window: { duration_minutes: -1, start_time: "", end_time: "", on_overrun: "" },
    options: { validation: "unstated", remediation: "unstated", human_escalation: "unstated" },
    recurrence: { enabled: false, day: "", time: "" }, wants_recommendation: true, volume_hint: -1, notes: [] }) }] }; } } } };
  const i = await interpretWithClaude({ text: "x", catalog: CATALOG, client: ok });
  assert.equal(req.model, "claude-opus-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(i.source, "jira");
  const refuse = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
  await assert.rejects(interpretWithClaude({ text: "x", catalog: CATALOG, client: refuse }), /declined/);
});

/* ---------- planning ---------- */

test("planner: demo scenario → waves, schedule, dependencies, criteria, policy", async () => {
  const g = await build(DEMO);
  assert.equal(g.status, "DRAFT");
  assert.equal(g.source.id, "jira");
  assert.equal(g.target.id, "freshservice");
  const [it, fin, hr] = g.waves;
  assert.deepEqual(g.waves.map((w) => w.name), ["IT", "Finance", "HR"]);
  assert.deepEqual(g.waves.map((w) => w.workspace.id), ["it", "finance", "hr"]);
  assert.equal(local(it.schedule.at).str, "2026-09-26 23:00");
  assert.equal(local(fin.schedule.at).str, "2026-10-03 23:00");
  assert.equal(hr.schedule.type, "after_dependency");
  assert.equal(hr.schedule.at, null);
  assert.equal(local(hr.schedule.estimated_at).str, "2026-10-10 23:00");
  assert.equal(local(it.window.end).str, "2026-09-27 04:00");
  assert.deepEqual(fin.depends_on.map((d) => d.wave_id), [it.wave_id]);
  assert.deepEqual(hr.depends_on.map((d) => d.wave_id), [fin.wave_id]);
  assert.deepEqual(g.dependencies.map((d) => d.from + ">" + d.to), ["w1>w2", "w2>w3"]);
  assert.equal(g.success_criteria.min_success_rate, 0.95);
  assert.equal(g.success_criteria.max_critical_errors, 0);
  assert.deepEqual(g.failure_policy, { on_success: "continue", on_partial_failure: "ai_remediation", on_unresolved: "human_review", on_critical_failure: "pause", pause_below_success_rate: null });
  assert.equal(g.blackout_periods[0].start, "09:00");
  assert.equal(g.migration_window.start_time, "23:00");
  assert.equal(g.migration_window.end_time, "04:00");
  assert.ok(it.record_estimate.tickets > 0 && it.record_estimate.employees > 0);
  assert.deepEqual(g.uncovered_workspaces.map((u) => u.id), ["facilities"]);
  assert.equal(g.recommendation, null);
  for (const k of ["goal_id", "goal_description", "source", "target", "record_types", "scope", "workspace_mapping", "field_mapping", "waves", "schedule", "migration_window", "dependencies", "success_criteria", "failure_policy", "blackout_periods", "status", "created_at", "updated_at"]) {
    assert.ok(k in g, "goal has " + k);
  }
});

test("planner: recommendation when no time is given, clear of blackout", async () => {
  const g = await build("We have 10,000 tickets and don't want to disrupt employees during business hours.", { tz: "America/New_York" });
  assert.ok(g.recommendation && g.recommendation.applied);
  assert.equal(g.waves[0].schedule.recommended, true);
  const l = local(g.waves[0].schedule.at, "America/New_York");
  assert.equal(l.weekday, 6);
  assert.equal(l.hour, 23);
  assert.ok(g.recommendation.reasons.includes("Outside business hours"));
  assert.equal(g.warnings.filter((w) => /blackout/.test(w)).length, 0);
});

test("planner: explicit time inside a blackout keeps the customer's time but warns and recommends", async () => {
  const g = await build("Migrate IT on Monday at 10 AM. Don't run during business hours.");
  assert.equal(local(g.waves[0].schedule.at).str, "2026-09-28 10:00");
  assert.ok(g.warnings.some((w) => /blackout/.test(w)));
  assert.ok(g.recommendation && g.recommendation.applied === false);
});

/* ---------- state machine & executor contract ---------- */

test("model: transitions are enforced and recorded", () => {
  const w = { wave_id: "w1", status: "DRAFT", history: [] };
  transition(w, "PLANNED", "approved");
  transition(w, "PRECHECK");
  transition(w, "READY");
  assert.equal(w.history.length, 3);
  assert.throws(() => transition(w, "COMPLETED"), TransitionError);
  transition(w, "RUNNING");
  transition(w, "VALIDATING");
  transition(w, "RECONCILING");
  transition(w, "COMPLETED");
  assert.throws(() => transition(w, "RUNNING"), TransitionError);
});

test("model: success criteria and next action follow the execution policy", () => {
  const goal = { options: { remediation: true, human_escalation: true }, success_criteria: { min_success_rate: 0.95, max_critical_errors: 0, required_fields_populated: true, reconciliation_complete: true, no_unresolved_high_severity: true }, failure_policy: { pause_below_success_rate: 0.9 } };
  const wave = {};
  const ok = { total: 100, succeeded: 97, critical_errors: 0, required_fields_missing: 0, reconciled: true, unresolved_high_severity: 0 };
  assert.equal(evaluateSuccessCriteria(goal.success_criteria, ok).met, true);
  assert.equal(decideNextAction(goal, wave, ok).action, "continue");
  const partial = { ...ok, succeeded: 92 };
  assert.equal(decideNextAction(goal, wave, partial).action, "ai_remediation");
  assert.equal(decideNextAction(goal, wave, partial, { remediationAttempted: true }).action, "human_review");
  assert.equal(decideNextAction(goal, wave, { ...ok, critical_errors: 2 }).action, "pause");
  assert.equal(decideNextAction(goal, wave, { ...ok, succeeded: 85 }).action, "pause", "below pause threshold");
});

test("model: window overrun policy", () => {
  const w = { window: { end: "2026-09-27T04:00:00Z" } };
  const now = new Date("2026-09-27T05:00:00Z");
  assert.equal(windowAction({ migration_window: { on_overrun: "escalate" } }, w, now).action, "escalate");
  assert.equal(windowAction({ migration_window: { on_overrun: "continue" } }, w, now, { criticalIssues: true }).action, "pause");
  assert.equal(windowAction({ migration_window: { on_overrun: "pause" } }, w, new Date("2026-09-27T03:00:00Z")).action, "none");
});

test("model: dueWaves respects schedule, dependencies, readiness and blackout", async () => {
  const g = await build(DEMO);
  assert.deepEqual(dueWaves(g, new Date("2026-09-27T00:00:00Z")), [], "not approved yet");
  g.approved_at = NOW.toISOString();
  g.waves.forEach((w) => transition(w, "PLANNED"));
  const itStart = new Date(g.waves[0].schedule.at);
  assert.deepEqual(dueWaves(g, new Date(itStart.getTime() - 60000)), []);
  const due = dueWaves(g, new Date(itStart.getTime() + 60000));
  assert.deepEqual(due.map((d) => d.wave_id + ":" + d.action), ["w1:precheck"]);
  transition(g.waves[0], "PRECHECK");
  transition(g.waves[0], "READY");
  assert.equal(dueWaves(g, new Date(itStart.getTime() + 60000))[0].action, "start");
  // Finance's time arrives but IT never completed (and IT's window has passed) → nothing due
  assert.deepEqual(dueWaves(g, new Date(new Date(g.waves[1].schedule.at).getTime() + 60000)), []);
  // IT completes and meets criteria → Finance due at its time
  ["RUNNING", "VALIDATING", "RECONCILING", "COMPLETED"].forEach((s) => transition(g.waves[0], s));
  g.waves[0].result = { success_criteria_met: true };
  assert.deepEqual(dueWaves(g, new Date(new Date(g.waves[1].schedule.at).getTime() + 60000)).map((d) => d.wave_id), ["w2"]);
  assert.equal(deriveGoalStatus(g), "PLANNED");
});

/* ---------- pre-checks ---------- */

test("prechecks: missing mapping → human review; with mapping → ready; dependency → waiting", async () => {
  const store = new JsonFileMappingStore(path.join(tmpDir(), "m.json"));
  const g = await build(DEMO, { store });
  const engine = engineFor("jira", "freshservice");
  const noMap = await runPrechecks({ goal: g, wave: g.waves[0], engine, savedMapping: null, now: NOW });
  assert.equal(noMap.outcome, "HUMAN_REVIEW_REQUIRED");
  assert.equal(noMap.results.find((r) => r.id === "field_mapping").status, "fail");
  assert.equal(noMap.results.length, 8);

  const { rows } = await engine.suggestMapping();
  const saved = await store.save({ sourceId: "jira", targetId: "freshservice", fields: rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })), workspaceRules: {} });
  const ok = await runPrechecks({ goal: g, wave: g.waves[0], engine, savedMapping: saved, now: NOW });
  assert.equal(ok.outcome, "READY", ok.reason);
  const waiting = await runPrechecks({ goal: g, wave: g.waves[1], engine, savedMapping: saved, now: NOW });
  assert.equal(waiting.outcome, "PLANNED");
  assert.match(waiting.reason, /Waiting for IT/);
  const late = await runPrechecks({ goal: g, wave: g.waves[0], engine, savedMapping: saved, now: new Date("2026-09-28T00:00:00Z") });
  assert.equal(late.outcome, "BLOCKED");
});

/* ---------- API flow ---------- */

test("api: interpret → edit → approve → precheck → dashboard list → due", async () => {
  const dir = tmpDir();
  const mappingStore = new JsonFileMappingStore(path.join(dir, "m.json"));
  const api = createMigrationApi({ store: mappingStore, goalStore: new JsonFileGoalStore(path.join(dir, "g.json")), aiInterpret: null });
  const q = { count: "750", seed: "42" };

  const created = await call(api, "POST", "/api/goals/interpret", { query: q, body: { text: DEMO, timezone: TZ, now: NOW.toISOString() } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const goal = created.body.goal;
  assert.equal(goal.interpretation.method, "rules");
  assert.equal(goal.waves.length, 3);

  // add Facilities as wave 4, after HR validation
  const edited = {
    ...goal,
    waves: goal.waves.map((w) => ({ wave_id: w.wave_id, name: w.name, workspace_id: w.workspace.id, schedule: w.schedule, depends_on: w.depends_on }))
      .concat({ name: "Facilities", workspace_id: "facilities", schedule: { type: "after_dependency" }, depends_on: [{ wave_id: "w3" }] }),
  };
  const put = await call(api, "PUT", "/api/goals/" + goal.goal_id, { body: { goal: edited, now: NOW.toISOString() } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.goal.waves.length, 4);
  assert.deepEqual(put.body.goal.uncovered_workspaces, []);

  const cyc = { ...edited, waves: edited.waves.map((w) => (w.wave_id === "w1" ? { ...w, depends_on: [{ wave_id: "w3" }] } : w)) };
  const bad = await call(api, "PUT", "/api/goals/" + goal.goal_id, { body: { goal: cyc, now: NOW.toISOString() } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Circular/);

  const pre0 = await call(api, "POST", "/api/goals/" + goal.goal_id + "/precheck", { body: { now: NOW.toISOString() } });
  assert.equal(pre0.status, 400, "must approve first");

  const approved = await call(api, "POST", "/api/goals/" + goal.goal_id + "/approve", { body: { now: NOW.toISOString() } });
  assert.equal(approved.body.goal.status, "PLANNED");
  assert.deepEqual(approved.body.goal.waves.map((w) => w.display_status), ["Scheduled", "Waiting on IT", "Waiting on Finance", "Waiting on HR"]);

  const blocked = await call(api, "POST", "/api/goals/" + goal.goal_id + "/precheck", { body: { wave_id: "w1", now: NOW.toISOString() } });
  assert.equal(blocked.body.goal.waves[0].status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(blocked.body.goal.status, "HUMAN_REVIEW_REQUIRED");

  // admin approves a mapping, re-runs pre-checks → READY
  const sugg = await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "jira", target: "freshservice" } });
  await call(api, "PUT", "/api/mapping", { query: q, body: { source: "jira", target: "freshservice", fields: sugg.body.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })) } });
  const ready = await call(api, "POST", "/api/goals/" + goal.goal_id + "/precheck", { body: { now: NOW.toISOString() } });
  const states = ready.body.goal.waves.map((w) => w.status);
  assert.deepEqual(states, ["READY", "PLANNED", "PLANNED", "PLANNED"]);
  assert.equal(ready.body.goal.waves[0].prechecks.results.every((r) => r.status === "pass"), true);

  const list = await call(api, "GET", "/api/goals", { query: { now: NOW.toISOString() } });
  assert.equal(list.body.goals.length, 1);
  assert.equal(list.body.goals[0].status, "READY");

  const itStart = new Date(ready.body.goal.waves[0].schedule.at);
  const due = await call(api, "GET", "/api/goals/due", { query: { now: new Date(itStart.getTime() + 60000).toISOString() } });
  assert.deepEqual(due.body.due.map((d) => d.wave_id + ":" + d.action), ["w1:start"]);

  const del = await call(api, "DELETE", "/api/goals/" + goal.goal_id);
  assert.equal(del.body.removed, true);
});

test("api: AI interpreter failure falls back to rules", async () => {
  const dir = tmpDir();
  const api = createMigrationApi({
    store: new JsonFileMappingStore(path.join(dir, "m.json")),
    goalStore: new JsonFileGoalStore(path.join(dir, "g.json")),
    aiInterpret: async () => { throw new Error("offline"); },
  });
  const r = await call(api, "POST", "/api/goals/interpret", { body: { text: DEMO, timezone: TZ, now: NOW.toISOString() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.goal.interpretation.method, "rules");
  assert.equal(r.body.goal.interpretation.error, "offline");
  const empty = await call(api, "POST", "/api/goals/interpret", { body: { text: "  " } });
  assert.equal(empty.status, 400);
});
