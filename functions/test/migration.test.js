const test = require("node:test");
const assert = require("node:assert/strict");

const { generateDemoRecords, DEMO_PROFILES } = require("../migration/demoData");
const { ZEN_RECORD_FIELDS } = require("../migration/schema");
const { createSourceAdapter, createTargetAdapter, listIntegrations } = require("../migration/registry");
const { MigrationEngine } = require("../migration/engine");
const { SourceAdapter } = require("../migration/adapters/SourceAdapter");
const { TargetAdapter } = require("../migration/adapters/TargetAdapter");
const { JiraSourceAdapter, adfToText } = require("../migration/adapters/JiraSourceAdapter");
const { FreshserviceTargetAdapter } = require("../migration/adapters/FreshserviceTargetAdapter");
const { routeParts } = require("../migration/api");

const FIELD_KEYS = ZEN_RECORD_FIELDS.map((f) => f.key);
const NO_ENV = {};

test("demo generator: requested count, full Zen shape, unique ticket ids", () => {
  for (const profile of DEMO_PROFILES) {
    const records = generateDemoRecords({ profile, count: 800, seed: 7, quality: "clean" });
    assert.equal(records.length, 800);
    for (const r of records) {
      assert.deepEqual(Object.keys(r).sort(), [...FIELD_KEYS].sort());
      assert.match(r.email, /^[^@\s]+@[^@\s]+$/);
      assert.ok(!Number.isNaN(Date.parse(r.createdDate)));
    }
    assert.equal(new Set(records.map((r) => r.ticketId)).size, 800);
  }
});

test("demo generator: deterministic per seed", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const a = generateDemoRecords({ profile: "jira", count: 50, seed: 1, now });
  const b = generateDemoRecords({ profile: "jira", count: 50, seed: 1, now });
  const c = generateDemoRecords({ profile: "jira", count: 50, seed: 2, now });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("registry: all sources and target fall back to mock without credentials", () => {
  const { sources, targets } = listIntegrations(NO_ENV);
  assert.deepEqual(sources.map((s) => s.id), ["jira", "legacy-itsm", "mock-legacy"]);
  assert.deepEqual(targets.map((t) => t.id), ["freshservice"]);
  for (const i of [...sources, ...targets]) assert.equal(i.mode, "mock");
});

test("registry: credentials switch Jira and Freshservice to live adapters", () => {
  const env = {
    JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t",
    FRESHSERVICE_DOMAIN: "acme.freshservice.com", FRESHSERVICE_API_KEY: "k",
  };
  const jira = createSourceAdapter("jira", {}, env);
  const fs = createTargetAdapter("freshservice", env);
  assert.ok(jira instanceof JiraSourceAdapter);
  assert.ok(fs instanceof FreshserviceTargetAdapter);
  assert.equal(jira.mode, "live");
  assert.equal(fs.mode, "live");
  // legacy systems have no live connector, still mock
  assert.equal(createSourceAdapter("legacy-itsm", {}, env).mode, "mock");
});

test("adapters implement their base contracts", () => {
  for (const id of ["jira", "legacy-itsm", "mock-legacy"]) {
    assert.ok(createSourceAdapter(id, {}, NO_ENV) instanceof SourceAdapter);
  }
  assert.ok(createTargetAdapter("freshservice", NO_ENV) instanceof TargetAdapter);
  assert.equal(createSourceAdapter("nope", {}, NO_ENV), null);
});

test("mock source: cursor paging walks every record exactly once", async () => {
  const src = createSourceAdapter("legacy-itsm", { count: 230, seed: 3 }, NO_ENV);
  assert.equal(await src.countRecords(), 230);
  const seen = [];
  let cursor = null;
  do {
    const page = await src.fetchRecords({ cursor, limit: 100 });
    seen.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 230);
  assert.match(seen[0].ticketId, /^INC\d{7}$/);
});

test("engine: describes the Source → Zen → Target pipeline", async () => {
  const engine = new MigrationEngine({
    source: createSourceAdapter("jira", { count: 600 }, NO_ENV),
    target: createTargetAdapter("freshservice", NO_ENV),
  });
  const p = await engine.describe();
  assert.equal(p.ready, true);
  assert.equal(p.source.id, "jira");
  assert.equal(p.source.recordCount, 600);
  assert.equal(p.target.id, "freshservice");
  assert.deepEqual(p.zen.recordModel.map((f) => f.key), FIELD_KEYS);
  assert.ok(p.target.schema.some((f) => f.key === "priority"));
});

test("engine: rejects adapters that do not meet the contract", () => {
  assert.throws(() => new MigrationEngine({ source: {}, target: createTargetAdapter("freshservice", NO_ENV) }), /source adapter is missing/);
  assert.throws(() => new MigrationEngine({ source: createSourceAdapter("jira", {}, NO_ENV) }), /target adapter/);
});

test("demo generator: realistic quality adds a few issues without changing the clean data", () => {
  const clean = generateDemoRecords({ profile: "legacy-itsm", count: 750, seed: 42, quality: "clean" });
  const real = generateDemoRecords({ profile: "legacy-itsm", count: 750, seed: 42 });
  const withIssue = real.filter((r) => r._issue);
  assert.ok(withIssue.length > 50 && withIssue.length < 120, "about 6% random issues plus ~5% controlled failures");
  assert.ok(real.slice(0, 25).every((r) => !r._issue), "head stays clean");
  assert.ok(!Object.keys(real[30]).includes("_issue"), "ground truth is not exposed");
  real.forEach((r, i) => {
    if (!r._issue) assert.deepEqual(r, clean[i]);
    else if (!r._issue.startsWith("controlled:invalid_department")) assert.equal(r.department, clean[i].department, "only controlled department failures change departments");
  });
});

test("jira mapping: issue → Zen record", () => {
  const jira = new JiraSourceAdapter({ id: "jira", name: "Jira" }, { baseUrl: "https://x", email: "e", apiToken: "t" });
  const rec = jira.toZenRecord({
    key: "SD-12",
    fields: {
      summary: "Laptop broken",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Screen cracked" }] }] },
      issuetype: { name: "Incident" },
      priority: { name: "High" },
      status: { name: "Open" },
      created: "2026-03-01T10:00:00.000+0000",
      reporter: { accountId: "abc", displayName: "Ana P", emailAddress: "ana@x.com" },
    },
  });
  assert.equal(rec.ticketId, "SD-12");
  assert.equal(rec.description, "Screen cracked");
  assert.equal(rec.employeeName, "Ana P");
  assert.equal(rec.createdDate, "2026-03-01T10:00:00.000Z");
  assert.deepEqual(Object.keys(rec).sort(), [...FIELD_KEYS].sort());
  assert.equal(adfToText(null), "");
});

test("api: route parsing works via hosting rewrite and direct function URL", () => {
  assert.deepEqual(routeParts("/api/integrations/jira/connect"), ["integrations", "jira", "connect"]);
  assert.deepEqual(routeParts("/integrations"), ["integrations"]);
  assert.deepEqual(routeParts("/api/migration/pipeline"), ["migration", "pipeline"]);
});
