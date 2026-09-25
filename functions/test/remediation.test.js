const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zen-rem-"));
process.env.ZEN_DATA_DIR = DATA;
process.env.MOCK_TARGET_LATENCY_MS = "0";

const { generateDemoRecords } = require("../migration/demoData");
const { RemediationEngine, buildEmployeeIndex, normalizeDepartment, isPlaceholder } = require("../migration/execution/remediation");
const { captureFailure } = require("../migration/execution/failures");
const { validateRecord } = require("../migration/execution/validation");
const { resolveDepartmentsWithClaude } = require("../migration/execution/aiDepartments");
const { FRESHSERVICE_TICKET_FIELDS: SCHEMA } = require("../migration/adapters/freshserviceSchema");
const { createMigrationApi } = require("../migration/api");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { JsonFileGoalStore } = require("../migration/goals/store");
const { JsonFileRunStore } = require("../migration/execution/runStore");

const DEPTS = SCHEMA.find((f) => f.key === "department").values;
const FIELDS = [
  { sourceField: "emp", targetField: "requester.employee_id" },
  { sourceField: "name", targetField: "requester.name" },
  { sourceField: "mail", targetField: "email" },
  { sourceField: "dept", targetField: "department" },
  { sourceField: "id", targetField: "custom_fields.legacy_ticket_id" },
  { sourceField: "type", targetField: "type" },
  { sourceField: "prio", targetField: "priority" },
  { sourceField: "desc", targetField: "description" },
  { sourceField: "state", targetField: "status" },
  { sourceField: "created", targetField: "custom_fields.legacy_created_at" },
];
const BASE = { emp: "E1", name: "Ana P", mail: "ana@corp.com", dept: "IT", id: "T1", type: "Incident", prio: "P2", desc: "Broken", state: "Open", created: "2025-01-01T00:00:00Z" };
const OTHERS = [BASE, { ...BASE, id: "T2" }, { ...BASE, emp: "E2", mail: "bo@corp.com", id: "T3" }];

function failureFor(raw, extra = {}) {
  const ctx = { fields: FIELDS, targetSchema: SCHEMA, seenIds: new Set(extra.seen || []) };
  const issues = validateRecord(raw, ctx).filter((i) => i.severity === "error");
  return captureFailure({ raw, recordId: raw.id, waveId: "w1", issues, ctx, seq: 1, ...extra.capture });
}
function engine(ai = {}, aiAvailable = true) {
  return new RemediationEngine({ fields: FIELDS, targetSchema: SCHEMA, employeeIndex: buildEmployeeIndex(OTHERS, FIELDS), aiDepartments: ai, aiAvailable });
}

test("controlled demo failures are deterministic", () => {
  const a = generateDemoRecords({ profile: "jira", count: 750, seed: 42 }).map((r) => r._issue || "");
  const b = generateDemoRecords({ profile: "jira", count: 750, seed: 42 }).map((r) => r._issue || "");
  assert.deepEqual(a, b);
  const controlled = a.filter((x) => x.startsWith("controlled:"));
  for (const t of ["missing_employee_id", "missing_employee_id_new_hire", "invalid_department_alias", "invalid_department_semantic",
    "invalid_department_garbage", "field_mapping_mismatch", "missing_email", "missing_description"]) {
    assert.ok(controlled.includes("controlled:" + t), t);
  }
});

test("failure capture: category, reason, source, mapping, retry count", () => {
  const f = failureFor({ ...BASE, emp: "" });
  assert.equal(f.category, "missing_employee_id");
  assert.equal(f.record_id, "T1");
  assert.equal(f.retry_count, 0);
  assert.equal(f.status, "OPEN");
  assert.deepEqual(f.source, { ...BASE, emp: "" });
  assert.ok(f.target_mapping.some((m) => m.targetField === "requester.employee_id" && m.value === ""));
  assert.equal(failureFor({ ...BASE, dept: "Fin & Accts" }).category, "invalid_department");
  assert.equal(failureFor({ ...BASE, prio: "Incident", type: "P2" }).category, "field_mapping_mismatch");
  assert.equal(failureFor({ ...BASE, desc: "" }).category, "missing_required_field");
  assert.equal(failureFor(BASE, { seen: ["T1"] }).category, "duplicate_record");
  const api = captureFailure({ raw: BASE, recordId: "T1", waveId: "w1", ctx: { fields: FIELDS, targetSchema: SCHEMA }, seq: 2, writeError: { code: "503", message: "down", retryable: true }, payload: { x: 1 } });
  assert.equal(api.category, "api_failure");
  assert.deepEqual(api.target_payload, { x: 1 });
});

test("department normalisation rules", () => {
  assert.equal(normalizeDepartment("Fin & Accts", DEPTS).department, "Finance");
  assert.equal(normalizeDepartment("IT Dept.", DEPTS).department, "IT");
  assert.equal(normalizeDepartment("Facilties", DEPTS).department, "Facilities");
  assert.equal(normalizeDepartment("Human Res.", DEPTS).department, "HR");
  assert.equal(normalizeDepartment("Infra & Networking", DEPTS), null, "needs semantic understanding");
  assert.equal(normalizeDepartment("???", DEPTS), null);
  assert.ok(isPlaceholder("???") && isPlaceholder("DEPT-000") && isPlaceholder("N/A") && !isPlaceholder("Office Management"));
});

test("remediation decisions: safe fixes vs human review", () => {
  const e = engine({ "Infra & Networking": { department: "IT", confidence: 0.93, reason: "Infrastructure is IT" }, "Blue Team": { department: "IT", confidence: 0.4, reason: "unclear" } });
  const decide = (raw, extra) => e.analyze(failureFor(raw, extra));

  const inferId = decide({ ...BASE, emp: "" });
  assert.equal(inferId.fixable, true);
  assert.equal(inferId.steps[0].strategy, "infer_employee_id");
  assert.equal(decide({ ...BASE, emp: "", mail: "new@corp.com" }).fixable, false, "no other record");

  assert.equal(decide({ ...BASE, mail: "" }).steps[0].strategy, "infer_email");
  assert.equal(decide({ ...BASE, mail: "n/a" }).steps[0].strategy, "infer_email");
  assert.equal(decide({ ...BASE, mail: "ana at corp.com" }).steps[0].strategy, "normalize_format");

  assert.equal(decide({ ...BASE, dept: "Facilties" }).steps[0].strategy, "normalize_department");
  assert.equal(decide({ ...BASE, dept: "Infra & Networking" }).steps[0].strategy, "ai_department");
  assert.match(decide({ ...BASE, dept: "Blue Team" }).reason, /couldn't map/i, "low AI confidence is not applied");
  assert.match(decide({ ...BASE, dept: "???" }).reason, /placeholder/);
  assert.equal(engine({}, false).analyze(failureFor({ ...BASE, dept: "Infra & Networking" })).fixable, false, "no AI → human review");

  const swap = decide({ ...BASE, prio: "Incident", type: "P2" });
  assert.equal(swap.fixable, true);
  assert.equal(swap.steps.length, 1);
  assert.equal(swap.steps[0].strategy, "swap_mismatched_fields");

  assert.equal(decide({ ...BASE, desc: "" }).fixable, false);
  assert.equal(decide(BASE, { seen: ["T1"] }).fixable, false);
});

test("apply: fixes produce a record that now validates", () => {
  const e = engine({ "Infra & Networking": { department: "IT", confidence: 0.9, reason: "r" } });
  for (const raw of [{ ...BASE, emp: "" }, { ...BASE, mail: "" }, { ...BASE, dept: "Fin & Accts" }, { ...BASE, dept: "Infra & Networking" },
    { ...BASE, prio: "Incident", type: "P2" }, { ...BASE, created: "25/09/2025 14:03", mail: " Ana@Corp.COM " }]) {
    const f = failureFor(raw);
    const plan = e.analyze(f);
    assert.equal(plan.fixable, true, JSON.stringify(raw));
    const { record, changes, method } = e.apply(f, plan);
    assert.ok(changes.length > 0);
    assert.deepEqual(validateRecord(record, { fields: FIELDS, targetSchema: SCHEMA, seenIds: new Set() }).filter((i) => i.severity === "error"), [], JSON.stringify(record));
    if (raw.dept === "Infra & Networking") assert.equal(method, "ai");
  }
});

test("claude department resolver: request shape and answer handling", async () => {
  let req;
  const client = { beta: { messages: { create: async (r) => { req = r; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ results: [
    { value: "Infra & Networking", department: "IT", confidence: 0.92, reason: "Infrastructure teams sit in IT." },
    { value: "Blue Team", department: "", confidence: 0.2, reason: "Unclear." },
  ] }) }] }; } } } };
  const out = await resolveDepartmentsWithClaude({ values: ["Infra & Networking", "Blue Team"], departments: DEPTS, client });
  assert.equal(req.model, "claude-opus-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(out["Infra & Networking"].department, "IT");
  assert.equal(out["Blue Team"].department, null);
});

/* ---------- full flow: migration → failure → remediation → retry → updated result ---------- */

function call(handler, method, urlPath, { query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, send(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method, path: urlPath, query, body }, res);
  });
}

async function runMigration(aiDepartments) {
  const dir = fs.mkdtempSync(path.join(DATA, "api-"));
  const api = createMigrationApi({
    aiInterpret: null, aiDepartments,
    store: new JsonFileMappingStore(path.join(dir, "m.json")),
    goalStore: new JsonFileGoalStore(path.join(dir, "g.json")),
    runStore: new JsonFileRunStore(path.join(dir, "r.json")),
  });
  const q = { count: "750", seed: "42" };
  const goal = (await call(api, "POST", "/api/goals/interpret", { query: q, body: { text: "Start with IT this Saturday at 11 PM, then Finance the following Saturday, then HR, then Facilities.", timezone: "UTC", source: "jira" } })).body.goal;
  const s = (await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "jira", target: "freshservice" } })).body;
  await call(api, "PUT", "/api/mapping", { query: q, body: { source: "jira", target: "freshservice", fields: s.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })) } });
  const now = "2026-09-26T23:30:00Z";
  let run = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now } })).body.run;
  const phases = [];
  while (!["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED", "STOPPED"].includes(run.status)) {
    run = (await call(api, "POST", "/api/runs/" + run.run_id + "/advance", { body: { now } })).body.run;
    if (phases[phases.length - 1] !== run.status) phases.push(run.status);
  }
  return { run, phases, api, now };
}

test("flow: failures are captured, safely fixable ones are fixed + re-written, the rest go to human review", async () => {
  const aiCalls = [];
  const { run, phases } = await runMigration(async ({ values, departments }) => {
    aiCalls.push(values);
    const known = { "Infra & Networking": "IT", "Office Management": "Facilities", "Talent Acquisition": "HR", "Treasury Ops": "Finance" };
    return Object.fromEntries(values.map((v) => [v, known[v] && departments.includes(known[v])
      ? { department: known[v], confidence: 0.9, reason: "clear" } : { department: null, confidence: 0.1, reason: "unclear" }]));
  });
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED", "pauses for the exceptions");
  assert.equal(run.review_gate.type, "final");
  assert.ok(phases.includes("REMEDIATING"));
  const r = run.remediation;
  assert.equal(r.detected, run.totals.failed);
  assert.equal(r.resolved + r.human_review, r.detected);
  assert.equal(r.pending, 0);
  assert.ok(r.resolved > r.human_review, "most failures are fixed automatically");
  assert.ok(r.ai_resolved > 0 && aiCalls.length > 0);
  assert.ok(aiCalls.flat().every((v) => !/^\?+$|^DEPT-|^N\/A$/.test(v)), "placeholders never sent to AI");

  for (const cat of ["missing_employee_id", "invalid_department", "field_mapping_mismatch", "missing_required_field", "api_failure"]) {
    assert.ok(r.by_category[cat] && r.by_category[cat].detected > 0, cat + " detected");
  }
  // every RESOLVED failure really landed in the target; every other one did not
  for (const f of run.failures) {
    if (f.status === "RESOLVED") {
      assert.ok(f.outcome && f.outcome.target_id, f.failure_id + " has a target id");
      assert.ok(f.remediation.strategies.length > 0);
    } else {
      assert.equal(f.status, "HUMAN_REVIEW_REQUIRED");
      assert.ok(!f.outcome || !f.outcome.target_id);
      assert.ok(f.review_reason);
    }
    assert.ok(f.recommended_action);
  }
  const api500 = run.failures.filter((f) => f.write_error && f.write_error.code === "500");
  assert.ok(api500.every((f) => f.status === "HUMAN_REVIEW_REQUIRED" && f.retry_count === 2), "500 outlasting automatic retries → human review");
  const api503 = run.failures.filter((f) => f.write_error && f.write_error.code === "503");
  assert.ok(api503.length && api503.every((f) => f.status === "RESOLVED" && f.retry_count === 2), "503 succeeds on the 3rd attempt");
  // reconciliation includes remediated records (some re-routed to another workspace)
  for (const w of Object.values(run.waves)) {
    assert.equal(w.reconciliation.match, true, w.name);
    assert.equal(w.reconciliation.target_count, w.counts.successful + w.counts.remediated);
    assert.equal(w.verification.problems, 0);
  }
});

test("flow: without AI the same failures stay safe — semantic departments go to human review", async () => {
  const { run } = await runMigration(null);
  const dept = run.remediation.by_category.invalid_department;
  assert.ok(dept.human_review > 0);
  assert.equal(run.remediation.ai_resolved, 0);
  const semantic = run.failures.find((f) => f.source.Department === "Infra & Networking");
  assert.equal(semantic.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED");
  assert.match(semantic.review_reason, /AI remediation is unavailable/);
});
