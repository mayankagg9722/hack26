const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.MOCK_API_LATENCY_MS = "0";
const { createMigrationApi } = require("../migration/api");
const { generateMapping } = require("../migration/agent/mapping");
const { transformPriority, transformStatus, normalizePriority } = require("../migration/agent/transforms");
const { generateMigrationInsights } = require("../migration/agent/insights");
const { McpClient, parseSse } = require("../migration/agent/mcpClient");
const { nativeFields, REQUESTER_FIELDS } = require("../migration/agent/freshserviceTarget");

function fresh() {
  process.env.ZEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zen-agent-"));
  return createMigrationApi({ aiInterpret: null, aiDepartments: null });
}
function call(handler, method, urlPath, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); }, send(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method, path: urlPath, query: {}, body: body || {} }, res);
  });
}
async function mappings(api) {
  const c = (await call(api, "POST", "/api/agent/mappings", { pair: "customer→requester" })).body.mapping;
  const t = (await call(api, "POST", "/api/agent/mappings", { pair: "ticket→ticket" })).body.mapping;
  for (const f of c.fields.filter((x) => x.decision === "pending")) await call(api, "POST", "/api/agent/mappings/" + c.mappingId + "/decide", { source: f.source, decision: "confirmed" });
  return { c, t };
}
/** Drives a run; onReview decides each pending record ("approve" | "skip"). */
async function drive(api, id, onReview) {
  let run;
  for (let i = 0; i < 500; i++) {
    run = (await call(api, "POST", "/api/agent/runs/" + id + "/advance")).body.run;
    if (run.status === "HUMAN_REVIEW_REQUIRED") {
      if (!onReview) return run;
      for (const r of run.records.filter((x) => x.status === "HUMAN_REVIEW_REQUIRED")) {
        const decision = onReview(r);
        const input = r.review.needsInput === "email" ? { email: "fixed" + i + "@northwind.example.com" } : {};
        run = (await call(api, "POST", "/api/agent/runs/" + id + "/review", { record: r.key, action: decision, input })).body.run;
      }
    } else if (run.status !== "RUNNING") return run;
  }
  throw new Error("run did not finish");
}

test("discovery labels demo data as MOCK DATA and lists the required entities", async () => {
  const api = fresh();
  const s = (await call(api, "GET", "/api/agent/source-entities")).body;
  const t = (await call(api, "GET", "/api/agent/target-entities")).body;
  assert.equal(s.label, "MOCK DATA");
  assert.equal(t.label, "MOCK DATA");
  assert.deepEqual(s.entities.map((e) => e.entityType), ["customer", "ticket"]);
  assert.deepEqual(t.entities.map((e) => e.entityType), ["requester", "ticket", "department", "group", "workspace"]);
  assert.ok(s.entities[0].fields.some((f) => f.key === "emailAddress"));
  assert.ok(!JSON.stringify([s, t]).match(/api_key|apikey|token|password/i), "no credentials in discovery");
  const tools = (await call(api, "GET", "/api/agent/tools")).body.tools.map((x) => x.name);
  assert.deepEqual(tools, ["list_source_entities", "list_target_entities", "generate_mapping", "run_migration", "generate_migration_insights"]);
});

test("mapping: known vendor rules, transformations, low confidence needs confirmation", async () => {
  const api = fresh();
  const c = (await call(api, "POST", "/api/agent/mappings", { pair: "customer→requester" })).body.mapping;
  const by = Object.fromEntries(c.fields.map((f) => [f.source, f]));
  assert.equal(by.displayName.target, "name");
  assert.equal(by.displayName.transformation, "splitName");
  assert.equal(by.department.transformation, "lookupDepartment");
  assert.equal(by.jobTitle.target, "job_title");
  assert.equal(by.office.level, "LOW");
  assert.equal(by.office.decision, "pending");
  assert.equal(by.timeZone.target, null, "no invented mapping");
  const t = (await call(api, "POST", "/api/agent/mappings", { pair: "ticket→ticket" })).body.mapping;
  const tb = Object.fromEntries(t.fields.map((f) => [f.source, f]));
  assert.equal(tb.summary.target, "subject");
  assert.equal(tb.priority.transformation, "transformPriority");
  assert.equal(tb.reporter.target, "requester_id");
  assert.equal(tb.reporter.transformation, "lookupRequester");
  assert.deepEqual(t.missingRequired, []);

  const blocked = await call(api, "POST", "/api/agent/runs", {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "PENDING_MAPPINGS");
});

test("mapping uses Claude only for fields rules can't place, and caps its confidence", async () => {
  const src = { entityType: "customer", fields: [{ key: "displayName" }, { key: "costCentre", sample: "CC-100" }] };
  const tgt = { entityType: "requester", fields: REQUESTER_FIELDS };
  let asked = null;
  const m = await generateMapping({
    pair: "customer→requester", sourceEntity: src, targetEntity: tgt,
    aiSuggest: async ({ sourceFields }) => { asked = sourceFields.map((f) => f.key); return [{ sourceField: "costCentre", targetField: "department", confidence: 0.99, reason: "Cost centre implies department." }]; },
  });
  assert.deepEqual(asked, ["costCentre"]);
  const row = m.fields.find((f) => f.source === "costCentre");
  assert.equal(row.method, "ai");
  assert.equal(row.confidence, 0.93);
});

test("value transformations follow Freshservice API values", () => {
  assert.equal(transformPriority("Highest").value, 4);
  assert.equal(transformPriority("Lowest").value, 1);
  assert.ok(transformPriority("Whenever").error);
  assert.equal(normalizePriority("P1 - Critical").value, 4);
  assert.equal(transformStatus("Waiting for customer").value, 3);
  assert.equal(transformStatus("Triage", "done").value, 4);
});

test("full demo run: every failure type is captured, review gate pauses, reconciliation balances", async () => {
  const api = fresh();
  const { c, t } = await mappings(api);
  const start = await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } });
  assert.equal(start.status, 200);
  const id = start.body.run.id;

  const paused = await drive(api, id, null);
  assert.equal(paused.status, "HUMAN_REVIEW_REQUIRED");
  const cust = paused.records.filter((r) => r.status === "HUMAN_REVIEW_REQUIRED");
  assert.deepEqual(cust.map((r) => r.review.failure_type).sort(), ["INVALID_DEPARTMENT", "MISSING_EMAIL"]);
  assert.ok(paused.records.every((r) => r.entity === "customers" || r.status === "PENDING"), "tickets wait for the customer review");
  assert.ok(cust.every((r) => r.review.tried.length && r.review.recommendation));

  const done = await drive(api, id, () => "approve");
  assert.equal(done.status, "COMPLETED");
  const types = done.summary.failures_by_type.map((f) => f.type).sort();
  for (const tp of ["MISSING_REQUESTER", "INVALID_DEPARTMENT", "INVALID_PRIORITY", "MISSING_REQUIRED_FIELD", "INVALID_WORKSPACE", "API_FAILURE", "RATE_LIMIT", "DUPLICATE_REQUESTER", "MISSING_EMAIL"]) {
    assert.ok(types.includes(tp), "captured " + tp);
  }
  const s = done.summary;
  assert.equal(s.total, s.successful + s.remediated + s.resolved + s.skipped + s.failed + s.human_review);
  assert.equal(s.human_review, 0);
  for (const e of ["customers", "tickets"]) assert.equal(done.reconciliation[e].balanced, true, e + " reconciles");
  assert.equal(done.reconciliation.customers.linked, 2, "existing requesters linked, not duplicated");
  const rec = done.records.find((r) => r.sourceId === "SD-1164");
  assert.equal(rec.status, "RESOLVED");
  assert.ok(rec.remediationAttempted);
  assert.equal(rec.remediationResult, "FAILED");
  assert.ok(done.records.every((r) => r.status !== "SUCCESS" || r.targetId), "every success has a target ID");
});

test("idempotency: a second run updates, never creates, and remembers human decisions", async () => {
  const api = fresh();
  const { c, t } = await mappings(api);
  const r1 = (await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } })).body.run;
  await drive(api, r1.id, () => "approve");
  const tenant = () => JSON.parse(fs.readFileSync(path.join(process.env.ZEN_DATA_DIR, "agent-mock-freshservice.json"), "utf8"));
  const before = { tickets: Object.keys(tenant().tickets).length, requesters: Object.keys(tenant().requesters).length };

  const r2 = (await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } })).body.run;
  const done = await drive(api, r2.id, () => { throw new Error("no review expected on the re-run"); });
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.summary.per_entity.tickets.created, 0);
  assert.equal(done.summary.per_entity.customers.created, 0);
  assert.equal(done.summary.per_entity.tickets.updated, 240);
  assert.deepEqual({ tickets: Object.keys(tenant().tickets).length, requesters: Object.keys(tenant().requesters).length }, before);
});

test("skip and stop are honoured", async () => {
  const api = fresh();
  const { c, t } = await mappings(api);
  const r = (await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } })).body.run;
  const paused = await drive(api, r.id, null);
  const first = paused.records.find((x) => x.status === "HUMAN_REVIEW_REQUIRED");
  const skipped = (await call(api, "POST", "/api/agent/runs/" + r.id + "/review", { record: first.key, action: "skip" })).body.run;
  assert.equal(skipped.records.find((x) => x.key === first.key).status, "SKIPPED");
  assert.equal(skipped.status, "HUMAN_REVIEW_REQUIRED", "still one decision left");
  const stopped = (await call(api, "POST", "/api/agent/runs/" + r.id + "/stop")).body.run;
  assert.equal(stopped.status, "STOPPED");
  const again = await call(api, "POST", "/api/agent/runs/" + r.id + "/advance");
  assert.equal(again.body.run.status, "STOPPED");
});

test("insights: Claude gets facts without emails; rule-based fallback is labelled", async () => {
  const api = fresh();
  const { c, t } = await mappings(api);
  const r = (await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } })).body.run;
  await drive(api, r.id, (x) => (x.review.failure_type === "API_FAILURE" ? "skip" : "approve"));
  const noKey = (await call(api, "POST", "/api/agent/runs/" + r.id + "/insights")).body.insights;
  assert.equal(noKey.generated_by, "rules");
  assert.equal(noKey.insights.needs_human.count, 1);

  const { AgentStore } = require("../migration/agent/store");
  const run = await new AgentStore().getRun(r.id);
  let prompt = null;
  const client = { beta: { messages: { create: async (req) => {
    prompt = req.messages[0].content;
    assert.equal(req.output_config.format.type, "json_schema");
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ headline: "h", went_well: ["w"], went_wrong: [], how_fixed: [], needs_human: { count: 1, reason: "r", recommended_action: "a" }, recommendations: ["x"] }) }] };
  } } } };
  const out = await generateMigrationInsights(run, { client });
  assert.equal(out.generated_by, "claude");
  assert.equal(out.summary.skipped, 1);
  assert.ok(!/@/.test(prompt), "no email addresses sent to Claude");
});

test("MCP client: initialize, discover tools, call a tool over SSE", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ method: msg.method, session: init.headers["Mcp-Session-Id"], auth: init.headers.Authorization });
    const headers = new Map([["content-type", "text/event-stream"], ["mcp-session-id", "s1"]]);
    const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} }
      : msg.method === "tools/list" ? { tools: [{ name: "fetchRequesters" }, { name: "fetchTicketFormFields" }] }
      : msg.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify({ ticket_fields: [{ name: "subject" }] }) }] } : {};
    const body = msg.id != null ? "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n\n" : "";
    return { ok: true, status: 200, headers: { get: (k) => headers.get(k) }, text: async () => body };
  };
  const mcp = new McpClient({ url: "https://acme.freshservice.com/mcp", headers: { Authorization: "key" }, fetchImpl });
  const tool = await mcp.findTool(/^fetchTicketFormFields$/);
  assert.equal(tool.name, "fetchTicketFormFields");
  const data = await mcp.callTool(tool.name, {});
  assert.deepEqual(data.ticket_fields, [{ name: "subject" }]);
  assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(calls[3].session, "s1");
  assert.equal(parseSse("data: {\"id\":7,\"result\":1}\n\n", 7).result, 1);
});

test("live Freshservice field lists are normalised onto Zen's keys", () => {
  const fields = nativeFields("requester", [{ name: "first_name", label: "First name" }, { name: "last_name" }, { name: "primary_email", label: "Email" }, { name: "custom_badge", label: "Badge", field_type: "custom_text" }], REQUESTER_FIELDS);
  assert.deepEqual(fields.map((f) => f.key), ["name", "email", "custom_badge"]);
});

test("review decisions wait for the gate, and run mutations are serialised across processes", async () => {
  const api = fresh();
  const { c, t } = await mappings(api);
  const r = (await call(api, "POST", "/api/agent/runs", { mappingIds: { customers: c.mappingId, tickets: t.mappingId } })).body.run;
  let run;
  do { run = (await call(api, "POST", "/api/agent/runs/" + r.id + "/advance")).body.run; } while (run.status === "RUNNING" && !run.records.some((x) => x.status === "HUMAN_REVIEW_REQUIRED"));
  assert.equal(run.status, "RUNNING", "flagged during transform, gate not reached yet");
  const early = run.records.find((x) => x.status === "HUMAN_REVIEW_REQUIRED");
  const res = await call(api, "POST", "/api/agent/runs/" + r.id + "/review", { record: early.key, action: "skip" });
  assert.equal(res.status, 409);

  const { AgentStore } = require("../migration/agent/store");
  const a = new AgentStore();
  const b = new AgentStore(); // a second "process" sharing the data dir
  const order = [];
  await Promise.all([
    a.withRunLock("x", async () => { order.push("a1"); await new Promise((ok) => setTimeout(ok, 60)); order.push("a2"); }),
    new Promise((ok) => setTimeout(ok, 10)).then(() => b.withRunLock("x", async () => { order.push("b1"); })),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});
