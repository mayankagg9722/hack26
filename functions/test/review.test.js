const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zen-review-"));
process.env.ZEN_DATA_DIR = DATA;
process.env.MOCK_TARGET_LATENCY_MS = "0";

const { createMigrationApi } = require("../migration/api");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { JsonFileGoalStore } = require("../migration/goals/store");
const { JsonFileRunStore } = require("../migration/execution/runStore");

const END = ["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED", "STOPPED"];
const NOW = "2026-09-26T23:30:00Z";
const AI = async ({ values, departments }) => {
  const known = { "Infra & Networking": "IT", "Talent Acquisition": "HR", "Treasury Ops": "Finance" };
  return Object.fromEntries(values.map((v) => [v, known[v] && departments.includes(known[v])
    ? { department: known[v], confidence: 0.9, reason: "clear" } : { department: "Facilities", confidence: 0.7, reason: "probably" }]));
};

function call(handler, method, urlPath, { query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, send(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method, path: urlPath, query, body }, res);
  });
}

async function pausedRun({ criteria, text, stopWhen } = {}) {
  const dir = fs.mkdtempSync(path.join(DATA, "api-"));
  process.env.ZEN_DATA_DIR = dir; // own mock Freshservice, so earlier tests' requesters don't leak in
  const api = createMigrationApi({
    aiInterpret: null, aiDepartments: AI,
    store: new JsonFileMappingStore(path.join(dir, "m.json")),
    goalStore: new JsonFileGoalStore(path.join(dir, "g.json")),
    runStore: new JsonFileRunStore(path.join(dir, "r.json")),
  });
  const q = { count: "750", seed: "42" };
  const goal = (await call(api, "POST", "/api/goals/interpret", { query: q, body: { text: text || "Start with IT this Saturday at 11 PM. If IT succeeds, migrate Finance the following Saturday. HR after Finance is validated. Facilities after HR.", timezone: "UTC", source: "jira" } })).body.goal;
  const s = (await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "jira", target: "freshservice" } })).body;
  await call(api, "PUT", "/api/mapping", { query: q, body: { source: "jira", target: "freshservice", fields: s.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" })) } });
  if (criteria) await call(api, "PUT", "/api/goals/" + goal.goal_id, { body: { goal: { success_criteria: { ...goal.success_criteria, ...criteria } } } });
  let run = (await call(api, "POST", "/api/goals/" + goal.goal_id + "/run", { body: { now: NOW } })).body.run;
  while (!END.includes(run.status) && !(stopWhen && stopWhen(run))) run = (await call(api, "POST", "/api/runs/" + run.run_id + "/advance", { body: { now: NOW } })).body.run;
  return { api, goal, run };
}
async function advanceAll(api, run) {
  while (!END.includes(run.status)) run = (await call(api, "POST", "/api/runs/" + run.run_id + "/advance", { body: { now: NOW } })).body.run;
  return run;
}

test("demo: failures → auto-fixes → pause → human approves → Zen resumes → completes", async () => {
  const { api, goal, run } = await pausedRun();
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(run.review_gate.type, "final");
  const rv = run.review;
  assert.ok(run.remediation.detected >= 90 && run.remediation.resolved >= 70 && rv.awaiting >= 15, JSON.stringify(run.remediation));
  assert.equal(rv.awaiting + run.remediation.resolved, run.remediation.detected);
  assert.match(rv.impact.message, /not in Freshservice yet/);
  assert.ok(rv.impact.success_rate_if_approved > rv.impact.success_rate_now);
  assert.equal((await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal.status, "HUMAN_REVIEW_REQUIRED");

  const emp = rv.groups.find((g) => g.group === "missing_employee_id");
  assert.deepEqual(emp.attempts.map((a) => a.step), ["Field mapping lookup", "Previous migration mapping", "Source data validation", "Automatic retry"]);
  assert.match(emp.why, /cannot be safely inferred/);
  assert.equal(emp.recommendation.action, "retry_with_changes");
  for (const g of rv.groups) assert.ok(g.recommendation && g.recommendation.summary && g.total > 0 && g.what_failed);

  // paused runs don't advance
  const idle = (await call(api, "POST", "/api/runs/" + run.run_id + "/advance", { body: { now: NOW } })).body.run;
  assert.equal(idle.status, "HUMAN_REVIEW_REQUIRED");

  const applied = await call(api, "POST", "/api/runs/" + run.run_id + "/review/apply", { body: { now: NOW } });
  assert.equal(applied.body.outcome.failed.length, 0);
  assert.equal(applied.body.run.status, "FINALIZING", "Zen resumes by itself once every exception is decided");
  const done = await advanceAll(api, applied.body.run);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.review.awaiting, 0);
  assert.ok(done.review.human_resolved > 0);
  const t = done.totals;
  assert.equal(t.failed, t.remediated + t.human_resolved + t.skipped);
  for (const w of Object.values(done.waves)) assert.equal(w.reconciliation.match, true, w.name);
  const g = (await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal;
  assert.equal(g.status, "COMPLETED");
  assert.equal(g.pending_review_count, 0);
});

test("approve retry: human-edited values, typed input required, still-invalid stays in review", async () => {
  const { api, run } = await pausedRun();
  const item = run.failures.find((f) => f.status === "HUMAN_REVIEW_REQUIRED" && f.recommendation.group === "missing_employee_id");
  const field = item.recommendation.changes[0].field;

  const empty = await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + item.failure_id + "/approve", { body: { now: NOW, values: { [field]: "  " } } });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /Enter a value/);

  const ok = await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + item.failure_id + "/approve", { body: { now: NOW, values: { [field]: "EMP99001" } } });
  assert.equal(ok.status, 200);
  const f = ok.body.run.failures.find((x) => x.failure_id === item.failure_id);
  assert.equal(f.status, "RESOLVED");
  assert.equal(f.resolved_by, "human");
  assert.equal(f.decision.values[field], "EMP99001");
  assert.ok(f.outcome.target_id);
  assert.ok(f.attempts.some((a) => a.step === "Human-approved retry" && a.ok));

  const again = await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + item.failure_id + "/approve", { body: { now: NOW } });
  assert.equal(again.status, 409, "can't approve twice");

  const api500 = run.failures.find((x) => x.status === "HUMAN_REVIEW_REQUIRED" && x.recommendation.group === "api_failure");
  if (api500) {
    const r = await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + api500.failure_id + "/approve", { body: { now: NOW } });
    assert.equal(r.status, 200, "outage cleared — approved retry succeeds");
  }
});

test("skip record and resume with pending items defers them; stop then retry skips migrated records", async () => {
  const { api, goal, run } = await pausedRun();
  const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED");
  const skipped = (await call(api, "POST", "/api/runs/" + run.run_id + "/review/" + pending[0].failure_id + "/skip", { body: { now: NOW } })).body.run;
  assert.equal(skipped.failures.find((f) => f.failure_id === pending[0].failure_id).status, "SKIPPED");
  assert.equal(skipped.review.awaiting, pending.length - 1);

  const resumed = (await call(api, "POST", "/api/runs/" + run.run_id + "/resume", { body: { now: NOW } })).body.run;
  assert.equal(resumed.status, "FINALIZING");
  const done = await advanceAll(api, resumed);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.review.deferred, pending.length - 1);
  assert.match(done.status_reason, /deferred/);

  // stop mid-migration, then retry: a new run continues without rewriting anything
  const second = await pausedRun({ stopWhen: (r) => r.status === "MIGRATING" && r.totals.processed >= 200 });
  const stopped = (await call(second.api, "POST", "/api/runs/" + second.run.run_id + "/stop", { body: { now: NOW } })).body.run;
  assert.equal(stopped.status, "STOPPED");
  const written = stopped.totals.successful;
  const idle = (await call(second.api, "POST", "/api/runs/" + second.run.run_id + "/advance", { body: { now: NOW } })).body.run;
  assert.equal(idle.totals.processed, stopped.totals.processed, "a stopped run writes nothing more");
  const g = (await call(second.api, "GET", "/api/goals/" + second.goal.goal_id)).body.goal;
  assert.equal(g.waves[0].status, "PAUSED");
  const retry = await call(second.api, "POST", "/api/runs/" + second.run.run_id + "/retry", { body: { now: NOW } });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.notEqual(retry.body.run.run_id, second.run.run_id);
  assert.equal(retry.body.run.skip_ids.length, written, "records written by the stopped run are skipped");
  let rerun = await advanceAll(second.api, retry.body.run);
  assert.equal(rerun.status, "HUMAN_REVIEW_REQUIRED");
  rerun = (await call(second.api, "POST", "/api/runs/" + rerun.run_id + "/review/apply", { body: { now: NOW } })).body.run;
  rerun = await advanceAll(second.api, rerun);
  assert.equal(rerun.status, "COMPLETED");
  const alreadyMigrated = Object.values(rerun.waves).reduce((n, w) => n + w.already_migrated, 0);
  // ≥: a duplicate source record of an already-migrated ticket is skipped too
  assert.ok(alreadyMigrated >= written && alreadyMigrated <= written + 3, alreadyMigrated + " vs " + written);
  assert.equal(alreadyMigrated + rerun.totals.processed, 750, "every record handled exactly once across both runs");

  // stopping at the review pause defers the open exceptions
  const third = await pausedRun();
  const stop3 = (await call(third.api, "POST", "/api/runs/" + third.run.run_id + "/stop", { body: { now: NOW } })).body.run;
  assert.equal(stop3.review.awaiting, 0);
  assert.ok(stop3.review.deferred > 0);
  assert.equal((await call(third.api, "POST", "/api/runs/" + third.run.run_id + "/review/apply", { body: { now: NOW } })).status, 409);
});

test("unmet criteria pause the wave; human decisions + resume re-check and continue", async () => {
  const { api, goal, run } = await pausedRun({
    criteria: { min_success_rate: 0.99 },
    text: "Start with IT this Saturday at 11 PM. If IT succeeds, migrate Finance the following Saturday.",
  });
  assert.equal(run.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(run.review_gate.type, "criteria");
  assert.deepEqual(run.review.impact.blocked_waves, ["Finance"]);
  const g1 = (await call(api, "GET", "/api/goals/" + goal.goal_id)).body.goal;
  assert.equal(g1.waves[1].display_status, "Waiting on IT");

  const applied = (await call(api, "POST", "/api/runs/" + run.run_id + "/review/apply", { body: { now: NOW } })).body.run;
  assert.equal(applied.status, "VALIDATING_TARGET", "re-checking IT with the decisions included");
  const next = await advanceAll(api, applied);
  assert.ok(["COMPLETED", "HUMAN_REVIEW_REQUIRED"].includes(next.status));
  assert.equal(next.waves.w1.phase, "COMPLETED", "IT now meets 99%");
  assert.ok(next.wave_order.every((id) => next.waves[id].counts.processed > 0), "Finance ran after the human decisions");
});
