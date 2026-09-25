const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zen-exec-"));
process.env.ZEN_DATA_DIR = DATA;
process.env.MOCK_TARGET_LATENCY_MS = "0";

const { matchEnum, parseDate, transformRecord } = require("../migration/execution/transform");
const { validateRecord } = require("../migration/execution/validation");
const { applyBasicFixes } = require("../migration/execution/fixes");
const { MockFreshserviceTargetAdapter } = require("../migration/adapters/MockFreshserviceTargetAdapter");
const { FRESHSERVICE_TICKET_FIELDS: SCHEMA } = require("../migration/adapters/freshserviceSchema");
const { createMigrationApi } = require("../migration/api");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { JsonFileGoalStore } = require("../migration/goals/store");
const { JsonFileRunStore } = require("../migration/execution/runStore");

const END = ["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED", "STOPPED"];
const PRIORITY = SCHEMA.find((f) => f.key === "priority");
const STATUS = SCHEMA.find((f) => f.key === "status");
const TYPE = SCHEMA.find((f) => f.key === "type");
const FIELDS = [
  { sourceField: "emp", targetField: "requester.employee_id" },
  { sourceField: "mail", targetField: "email" },
  { sourceField: "desc", targetField: "description" },
  { sourceField: "prio", targetField: "priority" },
  { sourceField: "state", targetField: "status" },
  { sourceField: "id", targetField: "custom_fields.legacy_ticket_id" },
  { sourceField: "created", targetField: "custom_fields.legacy_created_at" },
];

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

function freshApi() {
  const dir = fs.mkdtempSync(path.join(DATA, "api-"));
  return createMigrationApi({
    aiInterpret: null,
    store: new JsonFileMappingStore(path.join(dir, "m.json")),
    goalStore: new JsonFileGoalStore(path.join(dir, "g.json")),
    runStore: new JsonFileRunStore(path.join(dir, "r.json")),
  });
}

async function setup(api, { source = "jira", text, criteria } = {}) {
  const q = { count: "750", seed: "42" };
  const goal = (await call(api, "POST", "/api/goals/interpret", {
    query: q,
    body: { text: text || "Migrate IT this Saturday at 11 PM, then Finance the following Saturday, then HR after Finance.", timezone: "UTC", source, target: "freshservice" },
  })).body.goal;
  const s = (await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source, target: "freshservice" } })).body;
  await call(api, "PUT", "/api/mapping", { query: q, body: { source, target: "freshservice", fields: s.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })) } });
  if (criteria) {
    await call(api, "PUT", "/api/goals/" + goal.goal_id, { body: { goal: { success_criteria: { ...goal.success_criteria, ...criteria } } } });
  }
  return goal;
}

async function runToEnd(api, runId, now, { approveAtGate = false } = {}) {
  let run;
  let steps = 0;
  const phases = [];
  for (;;) {
    run = (await call(api, "POST", "/api/runs/" + runId + "/advance", { body: { now } })).body.run;
    if (phases[phases.length - 1] !== run.status) phases.push(run.status);
    steps++;
    if (steps > 1000) break;
    if (approveAtGate && run.status === "HUMAN_REVIEW_REQUIRED" && run.review_gate && run.review_gate.type === "final") {
      run = (await call(api, "POST", "/api/runs/" + runId + "/review/apply", { body: { now } })).body.run;
      phases.push("HUMAN_DECISIONS");
      continue;
    }
    if (END.includes(run.status)) break;
  }
  return { run, phases, steps };
}

/* ---------- units ---------- */

test("transform: enum synonyms, dates, emails", () => {
  assert.equal(matchEnum("P1", PRIORITY.values).value, 4);
  assert.equal(matchEnum("Highest", PRIORITY.values).value, 4);
  assert.equal(matchEnum("WIP", STATUS.values).value, 3);
  assert.equal(matchEnum("Waiting for customer", STATUS.values).value, 3);
  assert.equal(matchEnum("CLOSED", STATUS.values).value, 5);
  assert.equal(matchEnum("Change", TYPE.values).value, "Service Request");
  assert.equal(matchEnum("PRIORITY: HIGH", PRIORITY.values), null);
  assert.equal(parseDate("25/09/2025 14:03"), null);
  assert.equal(parseDate("25/09/2025 14:03", { allowDayFirst: true }), "2025-09-25T14:03:00.000Z");
  assert.equal(parseDate("31/02/2025", { allowDayFirst: true }), null);
  const { payload, unmapped } = transformRecord({ email: "A@B.COM", priority: "P3", status: "NEW", "custom_fields.legacy_ticket_id": "INC1" }, SCHEMA);
  assert.deepEqual(unmapped, []);
  assert.equal(payload.email, "a@b.com");
  assert.equal(payload.priority, 2);
  assert.equal(payload.status, 2);
  assert.equal(payload.custom_fields.legacy_ticket_id, "INC1");
});

test("validation + basic fixes: fixable vs needs review", () => {
  const ctx = { fields: FIELDS, targetSchema: SCHEMA, seenIds: new Set(["INC9"]) };
  const good = { emp: "E1", mail: "a@b.com", desc: "Broken", prio: "P2", state: "Open", id: "INC1", created: "2025-01-01T00:00:00Z" };
  assert.deepEqual(validateRecord(good, ctx).filter((i) => i.severity === "error"), []);

  const fixable = { ...good, mail: "ana.p at corp.com", prio: "PRIORITY: HIGH", created: "25/09/2025 14:03" };
  const errs = validateRecord(fixable, ctx).filter((i) => i.severity === "error");
  assert.deepEqual(errs.map((e) => e.code).sort(), ["invalid_date", "invalid_email", "unrecognized_value"]);
  const fixed = applyBasicFixes(fixable, errs, SCHEMA);
  assert.equal(fixed.unfixed.length, 0);
  assert.equal(fixed.record.mail, "ana.p@corp.com");
  assert.equal(fixed.fixes.length, 3);
  assert.deepEqual(validateRecord(fixed.record, ctx).filter((i) => i.severity === "error"), []);

  const review = { ...good, mail: "n/a", desc: "", id: "INC9" };
  const r = applyBasicFixes(review, validateRecord(review, ctx).filter((i) => i.severity === "error"), SCHEMA);
  assert.deepEqual(r.unfixed.map((e) => e.code).sort(), ["duplicate", "invalid_email", "missing_required"]);
});

test("mock target: validates like the API, retries, reads back, counts", async () => {
  const t = new MockFreshserviceTargetAdapter({ id: "freshservice", name: "Freshservice" }, { file: path.join(DATA, "t.json"), latencyMs: 0 });
  const ok = { email: "a@b.com", subject: "S", description: "D", priority: 2, status: 2, workspace_id: "it", requester: { employee_id: "E1" }, custom_fields: { legacy_ticket_id: "X1" } };
  const [a, b] = await t.writeRecords([ok, { ...ok, email: "nope", custom_fields: { legacy_ticket_id: "X2" } }], { runId: "r1" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.error.retryable, false);
  assert.match(b.error.message, /email/);
  assert.equal((await t.readRecords([a.id]))[0].email, "a@b.com");
  assert.equal(await t.countRecords({ runId: "r1", workspaceId: "it" }), 1);
  // deterministic API failures: 429 fails once, 503 twice, 500 always
  const many = Array.from({ length: 4000 }, (_, i) => ({ ...ok, custom_fields: { legacy_ticket_id: "T" + i } }));
  const codesAt = async (attempt) => (await t.writeRecords(many, { runId: "r2", attempt })).map((r) => (r.ok ? "ok" : r.error.code));
  const [a1, a2, a3, a4] = [await codesAt(1), await codesAt(2), await codesAt(3), await codesAt(4)];
  for (const code of ["429", "503", "500"]) assert.ok(a1.includes(code), code + " occurs");
  a1.forEach((c, i) => {
    if (c === "429") assert.deepEqual([a2[i], a3[i]], ["ok", "ok"]);
    if (c === "503") assert.deepEqual([a2[i], a3[i]], ["503", "ok"]);
    if (c === "500") assert.deepEqual([a2[i], a3[i], a4[i]], ["500", "500", "ok"], "outlasts automatic retries, clears later");
  });
  assert.deepEqual(await codesAt(1), a1, "same records fail the same way every run");
  const noEmp = await t.writeRecords([{ ...ok, requester: {}, custom_fields: { legacy_ticket_id: "X9" } }], { runId: "r3" });
  assert.match(noEmp[0].error.message, /employee_id/);
});

/* ---------- full flow ---------- */

test("executor: goal → plan → execute → COMPLETED, with real counts and reconciliation", async () => {
  const api = freshApi();
  const goal = await setup(api);
  const now = "2026-09-26T23:30:00Z"; // Saturday night, outside business hours
  const start = await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.run.status, "VALIDATING");

  const { run, phases } = await runToEnd(api, start.body.run.run_id, now, { approveAtGate: true });
  assert.equal(run.status, "COMPLETED", run.status_reason);
  assert.ok(phases.includes("HUMAN_DECISIONS"), "paused for human review before completing");
  for (const p of ["VALIDATING", "MAPPING", "MIGRATING", "VALIDATING_TARGET", "RECONCILING", "COMPLETED"]) assert.ok(phases.includes(p), p);

  const t = run.totals;
  assert.equal(t.processed, t.expected, "every in-scope record processed");
  assert.equal(t.processed, t.successful + t.failed);
  assert.ok(t.remediated > 0 && t.human_resolved > 0, "dirty demo data exercises auto-fixes and human decisions");
  assert.equal(run.failures_count, t.failed);
  assert.equal(t.failed, t.remediated + t.human_review + t.human_resolved + t.skipped);
  assert.equal(t.human_review, 0, "nothing left waiting");
  assert.equal(run.remediation.detected, t.failed);
  assert.equal(run.remediation.resolved, t.remediated);
  assert.equal(run.remediation.pending, 0);
  assert.ok(phases.includes("REMEDIATING"));
  for (const w of Object.values(run.waves)) {
    assert.equal(w.phase, "COMPLETED");
    assert.equal(w.reconciliation.match, true);
    assert.equal(w.reconciliation.target_count, w.counts.successful + w.counts.remediated + w.counts.human_resolved);
    assert.ok(w.evaluation.met);
  }

  const g = (await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal;
  assert.equal(g.status, "COMPLETED");
  assert.ok(g.waves.every((w) => w.status === "COMPLETED" && w.result.success_criteria_met && w.result.run_id === run.run_id));
  assert.equal(g.active_run_id, null);
  const again = await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now } });
  assert.equal(again.status, 409, "nothing left to run");
});

test("executor: unmet success criteria → HUMAN_REVIEW_REQUIRED and later waves stay paused", async () => {
  const api = freshApi();
  const goal = await setup(api, {
    criteria: { min_success_rate: 0.995 },
    text: "Start with IT this Saturday at 11 PM. If IT succeeds, migrate Finance the following Saturday. HR should migrate after Finance is successfully validated.",
  });
  const now = "2026-09-26T23:30:00Z";
  const start = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now } })).body.run;
  const { run } = await runToEnd(api, start.run_id, now);
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED");
  assert.match(run.status_reason, /below 99/);
  const g = (await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal;
  assert.deepEqual(g.waves.map((w) => w.status), ["HUMAN_REVIEW_REQUIRED", "PLANNED", "PLANNED"]);
  assert.equal(g.waves[1].display_status, "Waiting on IT");
});

test("executor: no approved mapping → blocked at pre-checks, nothing written", async () => {
  const api = freshApi();
  const goal = (await call(api, "POST", "/api/goals/interpret", { body: { text: "Migrate IT from Mock Legacy System to Freshservice tomorrow at 10 PM.", timezone: "UTC", source: "mock-legacy" } })).body.goal;
  const now = "2026-09-26T23:30:00Z";
  const start = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now } })).body.run;
  const { run } = await runToEnd(api, start.run_id, now);
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(run.totals.processed, 0);
  assert.match(run.status_reason, /Field mappings/);
});

test("executor: blackout needs an explicit override; pause and resume keep position", async () => {
  const api = freshApi();
  const goal = await setup(api, { text: "Migrate IT this Saturday at 11 PM. Do not run migrations during business hours." });
  const monday = "2026-09-28T10:00:00Z"; // Monday 10:00 UTC — business hours
  const blocked = await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now: monday } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "BLACKOUT");

  const start = await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now: monday, override_blackout: true } });
  assert.equal(start.status, 200);
  assert.equal(start.body.run.trigger.override_blackout, true);
  const id = start.body.run.run_id;
  let run;
  do { run = (await call(api, "POST", "/api/runs/" + id + "/advance", { body: { now: monday, max_records: 20 } })).body.run; } while (run.status !== "MIGRATING" || run.totals.processed === 0);
  const before = run.totals.processed;
  run = (await call(api, "POST", "/api/runs/" + id + "/pause", { body: { now: monday } })).body.run;
  assert.equal(run.status, "PAUSED");
  run = (await call(api, "POST", "/api/runs/" + id + "/advance", { body: { now: monday } })).body.run;
  assert.equal(run.totals.processed, before, "paused runs don't advance");
  run = (await call(api, "POST", "/api/runs/" + id + "/resume", { body: { now: monday } })).body.run;
  assert.equal(run.status, "MIGRATING");
  const end = await runToEnd(api, id, monday, { approveAtGate: true });
  assert.equal(end.run.status, "COMPLETED");
  assert.equal(end.run.totals.processed, end.run.totals.expected, "no record skipped or repeated across pause");
  const g = (await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal;
  assert.ok(g.waves[0].history.some((h) => h.to === "PAUSED") && g.waves[0].history.some((h) => h.from === "PAUSED" && h.to === "RUNNING"));
});
