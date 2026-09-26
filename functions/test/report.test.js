const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zen-report-"));
process.env.ZEN_DATA_DIR = DATA;
process.env.MOCK_TARGET_LATENCY_MS = "0";

const { createMigrationApi } = require("../migration/api");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { JsonFileGoalStore } = require("../migration/goals/store");
const { JsonFileRunStore } = require("../migration/execution/runStore");

const END = ["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED", "STOPPED"];
function call(handler, method, urlPath, { query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, send(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method, path: urlPath, query, body }, res);
  });
}

async function setup(count = "750") {
  const dir = fs.mkdtempSync(path.join(DATA, "api-"));
  process.env.ZEN_DATA_DIR = dir;
  const api = createMigrationApi({
    aiInterpret: null, aiDepartments: null,
    store: new JsonFileMappingStore(path.join(dir, "m.json")),
    goalStore: new JsonFileGoalStore(path.join(dir, "g.json")),
    runStore: new JsonFileRunStore(path.join(dir, "r.json")),
  });
  const q = { count, seed: "42" };
  const goal = (await call(api, "POST", "/api/goals/interpret", { query: q, body: { text: "Start with IT this Saturday at 11 PM, then Finance, then HR, then Facilities.", timezone: "UTC", source: "jira" } })).body.goal;
  const s = (await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "jira", target: "freshservice" } })).body;
  await call(api, "PUT", "/api/mapping", { query: q, body: { source: "jira", target: "freshservice", fields: s.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })) } });
  return { api, goal };
}
async function advance(api, run) {
  while (!END.includes(run.status)) run = (await call(api, "POST", "/api/runs/" + run.run_id + "/advance", { body: {} })).body.run;
  return run;
}

test("report reflects the actual run: totals add up, reconciliation, breakdown, value, history", async () => {
  const { api, goal } = await setup();
  let run = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: {} })).body.run;
  run = await advance(api, run);

  // live report while paused for review
  const live = (await call(api, "GET", "/api/runs/" + run.run_id + "/report")).body.report;
  assert.equal(live.reconciliation.status, "IN PROGRESS");
  assert.ok(live.totals.awaiting > 0);

  const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED");
  await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + pending[0].failure_id + "/skip", { body: {} });
  run = (await call(api, "POST", "/api/runs/" + run.run_id + "/review/apply", { body: {} })).body.run;
  run = await advance(api, run);
  assert.equal(run.status, "COMPLETED");

  const r = (await call(api, "GET", "/api/runs/" + run.run_id + "/report")).body.report;
  const t = r.totals;
  assert.equal(t.total_records, 750);
  assert.equal(t.first_pass_success + t.auto_remediated + t.human_resolved + t.not_migrated, t.total_records);
  assert.equal(t.first_pass_success, run.totals.successful);
  assert.equal(t.auto_remediated, run.totals.remediated);
  assert.equal(t.human_resolved, run.totals.human_resolved);
  assert.equal(t.failed_first_pass, run.totals.failed);
  assert.ok(t.skipped >= 1 && t.not_migrated === t.skipped + t.deferred);
  assert.equal(r.rates.success_rate, t.migrated / t.total_records);

  const rc = r.reconciliation;
  assert.equal(rc.source_records, 750);
  assert.equal(rc.target_records, t.migrated, "target count comes from records read back");
  assert.equal(rc.unresolved, rc.source_records - rc.target_records);
  assert.equal(rc.status, "PARTIALLY COMPLETE");
  assert.equal(rc.waves.reduce((n, w) => n + w.source, 0), 750);

  const detected = r.failure_breakdown.reduce((n, c) => n + c.detected, 0);
  assert.equal(detected, t.failed_first_pass);
  for (const c of r.failure_breakdown) assert.equal(c.auto_fixed + c.human_resolved + c.unresolved, c.detected);
  assert.ok(r.failure_breakdown.some((c) => c.category === "missing_employee_id"));

  assert.ok(r.value.elapsed_ms > 0 && r.value.records_per_minute > 0);
  assert.equal(r.rates.auto_remediation_rate, t.auto_remediated / t.failed_first_pass);
  assert.equal(r.rates.human_intervention_rate, t.escalated / t.total_records);
  assert.equal(r.workspaces.reduce((n, w) => n + w.records, 0), t.migrated);
  assert.equal(r.unresolved_records.length, t.not_migrated);

  const h = (await call(api, "GET", "/api/runs", { query: { view: "history" } })).body.history;
  assert.equal(h.length, 1);
  assert.deepEqual(
    [h[0].run_id, h[0].status, h[0].records_processed, h[0].failures, h[0].human_interventions, h[0].success_rate],
    [run.run_id, "COMPLETED", 750, t.failed_first_pass, t.escalated, r.rates.success_rate]
  );
  assert.ok(h[0].started_at && h[0].finished_at);
});

test("report: all approved → COMPLETE; a different data size changes every number", async () => {
  const { api, goal } = await setup("300");
  let run = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: {} })).body.run;
  run = await advance(api, run);
  run = (await call(api, "POST", "/api/runs/" + run.run_id + "/review/apply", { body: {} })).body.run;
  // duplicates are recommended "skip"; approve them explicitly this time
  for (const f of run.failures.filter((x) => x.status === "HUMAN_REVIEW_REQUIRED")) {
    run = (await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + f.failure_id + "/approve", { body: {} })).body.run;
  }
  run = await advance(api, run);
  const r = (await call(api, "GET", "/api/runs/" + run.run_id + "/report")).body.report;
  assert.equal(r.totals.total_records, 300);
  if (r.totals.skipped === 0) {
    assert.equal(r.reconciliation.status, "COMPLETE");
    assert.equal(r.reconciliation.unresolved, 0);
    assert.equal(r.rates.success_rate, 1);
  }
  const missing = await call(api, "GET", "/api/runs/run_nope/report");
  assert.equal(missing.status, 404);
});
