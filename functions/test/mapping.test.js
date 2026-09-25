const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { generateDemoRecords, nativeSchema, toNativeRecord, nativeFieldMap, DEMO_PROFILES } = require("../migration/demoData");
const { suggestMappings, tokens } = require("../migration/mapping/suggest");
const { classifyWorkspace } = require("../migration/mapping/workspaces");
const { applyMapping } = require("../migration/mapping/apply");
const { JsonFileMappingStore } = require("../migration/mapping/store");
const { aiSuggestMappings } = require("../migration/mapping/aiSuggest");
const { createSourceAdapter, createTargetAdapter } = require("../migration/registry");
const { MigrationEngine } = require("../migration/engine");
const { createMigrationApi } = require("../migration/api");
const { FRESHSERVICE_TICKET_FIELDS: TARGET, FRESHSERVICE_DEFAULT_WORKSPACES: WORKSPACES } = require("../migration/adapters/freshserviceSchema");

const NO_ENV = {};
const ZEN_TO_TARGET = {
  employeeId: "requester.employee_id", employeeName: "requester.name", email: "email", department: "department",
  ticketId: "custom_fields.legacy_ticket_id", ticketType: "type", priority: "priority", description: "description",
  status: "status", createdDate: "custom_fields.legacy_created_at",
};

function sourceFieldsFor(profile) {
  const recs = generateDemoRecords({ profile, count: 20 }).map((r, i) => toNativeRecord(profile, r, i));
  return nativeSchema(profile).map((f) => ({ key: f.key, samples: recs.slice(0, 5).map((r) => r[f.key]) }));
}

function tmpStore() {
  return new JsonFileMappingStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zen-test-")), "mappings.json"));
}

/* minimal req/res doubles for the HTTP handler */
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

test("tokens: abbreviations and synonyms normalise", () => {
  assert.deepEqual(tokens("employee_identification_number"), ["employee", "id"]);
  assert.deepEqual(tokens("DEPT_CODE"), ["department"]);
  assert.deepEqual(tokens("Issue key"), ["ticket", "id"]);
  assert.deepEqual(tokens("OPEN_DT"), ["created", "date"]);
});

test("heuristic suggestions match the ground truth for every source dialect", () => {
  for (const profile of DEMO_PROFILES) {
    const truth = nativeFieldMap(profile);
    for (const s of suggestMappings(sourceFieldsFor(profile), TARGET)) {
      const expected = truth[s.sourceField] ? ZEN_TO_TARGET[truth[s.sourceField]] : null;
      assert.equal(s.targetField, expected, profile + ": " + s.sourceField);
      if (expected) assert.ok(s.confidence >= 0.5 && s.reason.length > 0);
    }
  }
});

test("heuristic explains the prompt's example (employee_identification_number → employee_id)", () => {
  const [s] = suggestMappings([{ key: "employee_identification_number", samples: ["EMP10001"] }], TARGET);
  assert.equal(s.targetField, "requester.employee_id");
  assert.match(s.reason, /equivalent/);
});

test("workspace classification: rules, overrides, default", () => {
  assert.equal(classifyWorkspace("IT", WORKSPACES).workspaceId, "it");
  assert.equal(classifyWorkspace("IT Operations", WORKSPACES).workspaceId, "it");
  assert.equal(classifyWorkspace("Information Technology", WORKSPACES).workspaceId, "it");
  assert.equal(classifyWorkspace("HR", WORKSPACES).workspaceId, "hr");
  assert.equal(classifyWorkspace("People & Culture", WORKSPACES).workspaceId, "hr");
  assert.equal(classifyWorkspace("FIN", WORKSPACES).workspaceId, "finance");
  assert.equal(classifyWorkspace("Accounts", WORKSPACES).workspaceId, "finance");
  assert.equal(classifyWorkspace("Facilities", WORKSPACES).workspaceId, "facilities");
  assert.equal(classifyWorkspace("Workplace Services", WORKSPACES).workspaceId, "facilities");
  const sales = classifyWorkspace("Sales", WORKSPACES);
  assert.equal(sales.rule, "default");
  assert.equal(sales.workspaceId, "it");
  const over = classifyWorkspace("Sales", WORKSPACES, { Sales: "finance" });
  assert.equal(over.rule, "override");
  assert.equal(over.workspaceId, "finance");
  assert.equal(classifyWorkspace("IT", []).rule, "none");
});

test("applyMapping copies mapped values and derives subject", () => {
  const raw = { dept: "HR", ticket_description: "Laptop broken", junk: "x" };
  const { mapped, target } = applyMapping(raw, [
    { sourceField: "dept", targetField: "department" },
    { sourceField: "ticket_description", targetField: "description" },
  ], TARGET);
  assert.equal(mapped.length, 2);
  assert.deepEqual(target, { department: "HR", description: "Laptop broken", subject: "Laptop broken" });
});

test("store: save versions, get, remove", async () => {
  const store = tmpStore();
  assert.equal(await store.get("jira", "freshservice"), null);
  const a = await store.save({ sourceId: "jira", targetId: "freshservice", fields: [], workspaceRules: {} });
  const b = await store.save({ sourceId: "jira", targetId: "freshservice", fields: [], workspaceRules: {} });
  assert.equal(a.version, 1);
  assert.equal(b.version, 2);
  assert.equal((await store.get("jira", "freshservice")).version, 2);
  assert.equal(await store.remove("jira", "freshservice"), true);
  assert.equal(await store.get("jira", "freshservice"), null);
});

test("aiSuggestMappings: parses structured output and de-duplicates targets", async () => {
  let request;
  const fakeClient = {
    beta: {
      messages: {
        create: async (req) => {
          request = req;
          return {
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: JSON.stringify({
                mappings: [
                  { source_field: "dept", target_field: "department", confidence: 0.9, reason: "Same data." },
                  { source_field: "division", target_field: "department", confidence: 0.4, reason: "Maybe." },
                  { source_field: "junk", target_field: "", confidence: 0.1, reason: "No match." },
                ],
              }),
            }],
          };
        },
      },
    },
  };
  const fields = [{ key: "dept", samples: ["HR"] }, { key: "division", samples: ["X"] }, { key: "junk", samples: [] }];
  const out = await aiSuggestMappings({ sourceFields: fields, targetFields: TARGET, client: fakeClient });
  assert.equal(request.model, "claude-opus-5");
  assert.equal(request.output_config.format.type, "json_schema");
  assert.deepEqual(out.map((o) => o.targetField), ["department", null, null]);
  assert.ok(out.every((o) => o.method === "ai"));
});

test("aiSuggestMappings: refusal raises so the caller can fall back", async () => {
  const fakeClient = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
  await assert.rejects(aiSuggestMappings({ sourceFields: [{ key: "a" }], targetFields: TARGET, client: fakeClient }), /declined/);
});

test("engine.suggestMapping: AI failure falls back to heuristic; saved decisions are reused", async () => {
  const engine = new MigrationEngine({
    source: createSourceAdapter("legacy-itsm", { count: 100 }, NO_ENV),
    target: createTargetAdapter("freshservice", NO_ENV),
  });
  const fallback = await engine.suggestMapping({ aiSuggest: async () => { throw new Error("offline"); } });
  assert.equal(fallback.aiUsed, false);
  assert.equal(fallback.aiError, "offline");
  assert.equal(fallback.rows.find((r) => r.sourceField === "dept").targetField, "department");

  const saved = { fields: [{ sourceField: "dept", targetField: "department", decision: "accepted" }] };
  const reused = await engine.suggestMapping({ saved });
  assert.equal(reused.reused, 1);
  assert.equal(reused.discovered, 10);
  const deptRow = reused.rows.find((r) => r.sourceField === "dept");
  assert.equal(deptRow.method, "saved");
  assert.equal(deptRow.decision, "accepted");
});

test("engine.previewMapping: source → mapped → target → workspace", async () => {
  const engine = new MigrationEngine({
    source: createSourceAdapter("legacy-itsm", { count: 300 }, NO_ENV),
    target: createTargetAdapter("freshservice", NO_ENV),
  });
  const { rows } = await engine.suggestMapping();
  const fields = rows.filter((r) => r.targetField).map((r) => ({ sourceField: r.sourceField, targetField: r.targetField }));
  const p = await engine.previewMapping({ fields, index: 3 });
  assert.equal(p.total, 300);
  assert.equal(p.scanned, 300);
  assert.equal(p.departmentField, "dept");
  const rec = p.records[0];
  assert.equal(rec.index, 3);
  assert.equal(rec.target.department, rec.source.dept);
  assert.equal(rec.target.workspace_id, rec.workspace.workspaceId);
  assert.equal(p.distribution.reduce((n, d) => n + d.count, 0), 300);
  const hr = p.departments.find((d) => d.value === "HR");
  assert.equal(hr.workspaceId, "hr");
});

test("api: suggest → save → suggest reuses → preview → forget", async () => {
  const store = tmpStore();
  const api = createMigrationApi({ store }); // no key → heuristic
  const q = { count: "200", seed: "5" };

  const first = await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "mock-legacy", target: "freshservice" } });
  assert.equal(first.status, 200);
  assert.equal(first.body.saved, null);
  assert.equal(first.body.aiAvailable, false);
  assert.equal(first.body.discovered, 11);

  const fields = first.body.rows.map((r) => ({ ...r, decision: r.targetField ? "accepted" : "rejected" }));
  const put = await call(api, "PUT", "/api/mapping", {
    query: q, body: { source: "mock-legacy", target: "freshservice", fields, workspaceRules: { Sales: "finance" } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.saved.version, 1);

  const second = await call(api, "POST", "/api/mapping/suggest", { query: q, body: { source: "mock-legacy", target: "freshservice" } });
  assert.equal(second.body.reused, 11);
  assert.equal(second.body.discovered, 0);
  assert.ok(second.body.rows.every((r) => r.method === "saved"));
  assert.deepEqual(second.body.saved.workspaceRules, { Sales: "finance" });

  const prev = await call(api, "POST", "/api/mapping/preview", {
    query: q, body: { source: "mock-legacy", target: "freshservice", fields, workspaceRules: { Sales: "finance" }, index: 0 },
  });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.records.length, 1);
  assert.equal(prev.body.departments.find((d) => d.value === "Sales").workspaceId, "finance");

  const del = await call(api, "DELETE", "/api/mapping", { query: { source: "mock-legacy", target: "freshservice" } });
  assert.equal(del.body.removed, true);
});

test("api: rejects bad mappings", async () => {
  const api = createMigrationApi({ store: tmpStore() });
  const base = { source: "legacy-itsm", target: "freshservice" };
  const unknown = await call(api, "PUT", "/api/mapping", { body: { ...base, fields: [{ sourceField: "nope", targetField: "email", decision: "accepted" }] } });
  assert.equal(unknown.status, 400);
  const dup = await call(api, "PUT", "/api/mapping", {
    body: { ...base, fields: [
      { sourceField: "dept", targetField: "email", decision: "modified" },
      { sourceField: "email_address", targetField: "email", decision: "accepted" },
    ] },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /mapped twice/);
  const ws = await call(api, "PUT", "/api/mapping", { body: { ...base, fields: [], workspaceRules: { HR: "nowhere" } } });
  assert.equal(ws.status, 400);
  const missing = await call(api, "POST", "/api/mapping/suggest", { body: { source: "nope", target: "freshservice" } });
  assert.equal(missing.status, 404);
});
