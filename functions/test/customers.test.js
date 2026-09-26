const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MOCK_API_LATENCY_MS = "0";
const { createMigrationApi } = require("../migration/api");
const { CustomerMigrationEngine } = require("../migration/customers/engine");
const { CustomerMigrationStore, EntityMappingStore } = require("../migration/customers/stores");
const { LiveJsmCustomers, normalizeJsmCustomer, IntegrationError } = require("../migration/customers/jsm");
const { toRequester } = require("../migration/customers/freshservice");

function fresh() {
  process.env.ZEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zen-cust-"));
  return createMigrationApi({ aiInterpret: null });
}
function call(handler, method, urlPath, { body } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, send(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method, path: urlPath, query: {}, body }, res);
  });
}
async function runAll(api, id) {
  let m;
  const phases = [];
  do {
    m = (await call(api, "POST", "/api/customer-migrations/" + id + "/advance", { body: {} })).body.migration;
    if (m.phase && phases[phases.length - 1] !== m.phase) phases.push(m.phase);
  } while (m.status === "RUNNING");
  return { m, phases };
}

test("demo flow: create in JSM → associate → retrieve → create employees → 97 / 2 / 1", async () => {
  const api = fresh();
  const cfg = (await call(api, "GET", "/api/customer-migrations/config")).body;
  assert.equal(cfg.source.mode, "mock");
  assert.deepEqual(cfg.entity, { source: "Customers", target: "Employees" });
  assert.ok(!JSON.stringify(cfg).match(/token|api_key|password/i), "no credentials in the config response");

  const start = await call(api, "POST", "/api/customer-migrations", { body: { project_id: "SD", customer_count: 100 } });
  assert.equal(start.body.migration.status, "RUNNING");
  const { m, phases } = await runAll(api, start.body.migration.id);
  assert.deepEqual(phases, ["CREATING_JSM_CUSTOMERS", "ASSOCIATING", "RETRIEVING", "CREATING_EMPLOYEES", "STORING_MAPPING"], "the authoritative order");
  assert.deepEqual(m.steps.map((x) => x.label), ["Customers created in JSM", "Customers mapped to JSM project", "Customers retrieved from JSM project", "Freshservice employees created", "JSM ↔ Freshservice mapping stored"]);
  assert.ok(m.records.every((r) => r.association_confirmed), "every customer's project mapping confirmed in step 2");
  assert.equal(m.status, "COMPLETED_WITH_EXCEPTIONS");
  assert.deepEqual([m.summary.migrated, m.summary.skipped, m.summary.failed], [97, 2, 1]);
  assert.ok(m.steps.every((s) => s.status === "done"));

  for (const r of m.records) {
    assert.ok(r.jsm_customer_id, "every customer has a JSM ID");
    if (r.status === "MIGRATED" || r.status === "SKIPPED") assert.ok(r.fs_employee_id);
  }
  const failed = m.records.find((r) => r.status === "FAILED");
  assert.match(failed.message, /Freshservice 400: Validation failed/);
  assert.equal(failed.stage, "employees");
  assert.ok(m.records.some((r) => r.status === "MIGRATED" && r.attempts > 1), "transient 503s retried automatically");
  assert.ok(m.records.filter((r) => r.status === "SKIPPED").every((r) => /already existed/.test(r.message)));

  const mappings = new EntityMappingStore();
  assert.equal((await mappings.all("customers")).length, 99, "JSM ↔ Freshservice mapping stored for migrated + linked");
});

test("idempotent: a second run creates nothing new; retry failed re-attempts only the failures", async () => {
  const api = fresh();
  const first = (await call(api, "POST", "/api/customer-migrations", { body: { project_id: "SD", customer_count: 50 } })).body.migration;
  const a = await runAll(api, first.id);
  const retried = (await call(api, "POST", "/api/customer-migrations/" + first.id + "/retry-failed", { body: {} })).body.migration;
  assert.equal(retried.phase, "CREATING_EMPLOYEES");
  const b = await runAll(api, first.id);
  assert.equal(b.m.summary.failed, a.m.summary.failed, "a validation error stays failed — no fake success");
  assert.equal(b.m.retries, 1);

  const second = (await call(api, "POST", "/api/customer-migrations", { body: { project_id: "SD", customer_count: 50 } })).body.migration;
  const c = await runAll(api, second.id);
  assert.equal(c.m.summary.migrated, 0, "no duplicate employees");
  assert.equal(c.m.summary.skipped, a.m.summary.migrated + a.m.summary.skipped);
  assert.ok(c.m.records.every((r) => r.jsm_source === "reused"), "no duplicate JSM customers");
  const noRetry = await call(api, "POST", "/api/customer-migrations/" + second.id + "/retry-failed", { body: {} });
  assert.equal(noRetry.status, 200); // the blank-name customer is still failed
});

test("scheduling reuses the same engine", async () => {
  const api = fresh();
  const past = await call(api, "POST", "/api/customer-migrations", { body: { project_id: "SD", scheduled_at: "2020-01-01T00:00:00Z" } });
  assert.equal(past.status, 400);
  const at = new Date(Date.now() + 60000).toISOString();
  const s = (await call(api, "POST", "/api/customer-migrations", { body: { project_id: "HR", customer_count: 10, scheduled_at: at } })).body.migration;
  assert.equal(s.status, "SCHEDULED");
  assert.equal((await call(api, "POST", "/api/customer-migrations/" + s.id + "/advance", { body: {} })).body.migration.status, "SCHEDULED", "does nothing before its time");
  const engine = new CustomerMigrationEngine({ store: new CustomerMigrationStore(), mappings: new EntityMappingStore() });
  const ran = await engine.runScheduled({ now: () => new Date(Date.now() + 120000) });
  assert.deepEqual(ran.map((r) => r.status), ["COMPLETED"]);
  const done = (await call(api, "GET", "/api/customer-migrations/" + s.id)).body.migration;
  assert.equal(done.summary.migrated, 10);
});

test("step 2: a failed project mapping marks only that customer FAILED; step 3 never fetches it", async () => {
  process.env.ZEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zen-cust-"));
  const { MockJsmCustomers } = require("../migration/customers/jsm");
  let badId = null;
  class PickyJsm extends MockJsmCustomers {
    async addCustomersToProject(projectId, ids) {
      if (!badId) badId = ids[3];
      if (ids.includes(badId)) throw new IntegrationError("JSM 400: Customer cannot be added to this project", { code: "400", status: 400 });
      return super.addCustomersToProject(projectId, ids);
    }
  }
  const jsm = new PickyJsm({ latencyMs: 0 });
  const engine = new CustomerMigrationEngine({ store: new CustomerMigrationStore(), mappings: new EntityMappingStore(), jsm: () => jsm });
  let cur = await engine.create({ projectId: "SD", customerCount: 30 });
  while (cur.status === "RUNNING") cur = await engine.advance(cur.id);
  const failedAssoc = cur.records.filter((r) => r.stage === "associate" && r.status === "FAILED");
  assert.equal(failedAssoc.length, 1, "the batch failure is isolated to the one customer");
  assert.equal(failedAssoc[0].jsm_customer_id, badId);
  assert.match(failedAssoc[0].message, /Could not map to JSM project SD: JSM 400/);
  assert.equal(failedAssoc[0].retrieved, false, "not fetched or created in Freshservice");
  assert.equal(failedAssoc[0].fs_employee_id, null);
  assert.equal(cur.status, "COMPLETED_WITH_EXCEPTIONS");
  assert.match(cur.steps.find((x) => x.key === "associate").detail, /1 failed/);

  // JSM recovers → Retry Failed restarts from step 2 for that customer only
  badId = "none";
  await engine.retryFailed(cur.id);
  cur = await engine.store.get(cur.id);
  assert.equal(cur.phase, "ASSOCIATING");
  while (cur.status === "RUNNING") cur = await engine.advance(cur.id);
  const fixed = cur.records.find((r) => r.jsm_customer_id === failedAssoc[0].jsm_customer_id);
  assert.ok(["MIGRATED", "SKIPPED"].includes(fixed.status), fixed.message);
});

test("live JSM: unconfigured project endpoints block instead of guessing; 405 endpoint unused", async () => {
  const env = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" };
  const live = new LiveJsmCustomers(env);
  assert.deepEqual(live.missingConfig(), ["JSM_ADD_PROJECT_CUSTOMERS_PATH", "JSM_LIST_PROJECT_CUSTOMERS_PATH"]);
  await assert.rejects(live.listProjectCustomers("SD"), (e) => e.blocking && /not configured/.test(e.message));
  await assert.rejects(live.addCustomersToProject("SD", ["x"]), (e) => e.blocking);
  const src = fs.readFileSync(path.join(__dirname, "../migration/customers/jsm.js"), "utf8");
  assert.ok(!/request\("GET", *this\.paths\.create/.test(src), "never GETs the customer collection (405)");

  process.env.ZEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zen-cust-"));
  const engine = new CustomerMigrationEngine({ store: new CustomerMigrationStore(), mappings: new EntityMappingStore(), jsm: () => live });
  const run = await engine.create({ projectId: "SD", customerCount: 5 });
  const after = await engine.advance(run.id);
  assert.equal(after.status, "FAILED");
  assert.match(after.error, /needs configuration: JSM_ADD_PROJECT_CUSTOMERS_PATH/);
  assert.ok(after.records.every((r) => r.status === "PENDING"), "no customer touched");
});

test("data model: JSM normalisation and requester mapping", () => {
  assert.deepEqual(normalizeJsmCustomer({ accountId: "qm:1", displayName: " Jane D ", emailAddress: "Jane@Example.com" }, "ABC"),
    { jsmCustomerId: "qm:1", name: "Jane D", email: "jane@example.com", projectId: "ABC" });
  assert.deepEqual(toRequester({ jsmCustomerId: "qm:1", name: "Jane van Dyke", email: "jane@example.com" }),
    { first_name: "Jane", last_name: "van Dyke", primary_email: "jane@example.com" }, "Name → Name, Email → Email");
});
