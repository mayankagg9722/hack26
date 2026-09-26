/* HTTP routes for the integrations / migration layer.
     GET    /api/integrations
     POST   /api/integrations/:id/connect
     GET    /api/integrations/:id/records?limit=&cursor=&count=&seed=
     GET    /api/migration/pipeline?source=&target=&count=&seed=
     POST   /api/mapping/suggest   {source, target, force?}
     POST   /api/mapping/preview   {source, target, fields, workspaceRules?, index?}
     GET    /api/mapping?source=&target=
     PUT    /api/mapping           {source, target, fields, workspaceRules?}
     DELETE /api/mapping?source=&target=
     /api/goals/...         migration goals — see goals/routes.js
     /api/runs/...          migration execution — see execution/routes.js
     /api/customer-migrations/...  JSM customers → Freshservice employees — see customers/routes.js
     /api/agent/...         migration agent tools (discover, map, run, insights) — see agent/routes.js
   Connection state is held by the client; "connect" verifies the adapter
   can reach its system. count/seed (demo data) may be sent as query params. */

const { logger } = require("firebase-functions");
const { createSourceAdapter, createTargetAdapter, listIntegrations } = require("./registry");
const { MigrationEngine } = require("./engine");
const { JsonFileMappingStore } = require("./mapping/store");
const { aiSuggestMappings } = require("./mapping/aiSuggest");
const { JsonFileGoalStore } = require("./goals/store");
const { createGoalRoutes } = require("./goals/routes");
const { interpretWithClaude } = require("./goals/aiInterpreter");
const { MigrationExecutor } = require("./execution/executor");
const { JsonFileRunStore } = require("./execution/runStore");
const { createRunRoutes } = require("./execution/routes");
const { resolveDepartmentsWithClaude } = require("./execution/aiDepartments");
const { CustomerMigrationEngine } = require("./customers/engine");
const { CustomerMigrationStore, EntityMappingStore } = require("./customers/stores");
const { createCustomerMigrationRoutes } = require("./customers/routes");
const { createJsmCustomers } = require("./customers/jsm");
const { createFreshserviceRequesters } = require("./customers/freshservice");
const { preExistingEmployeeEmails } = require("./customers/demoCustomers");
const { MigrationAgentEngine } = require("./agent/engine");
const { AgentStore } = require("./agent/store");
const { createAgentRoutes } = require("./agent/routes");
const { createJsmSource } = require("./agent/jsmSource");
const { createFreshserviceTarget } = require("./agent/freshserviceTarget");

const DECISIONS = new Set(["accepted", "modified", "rejected"]);

function routeParts(path) {
  const i = path.indexOf("/api/");
  const rest = i >= 0 ? path.slice(i + 5) : path;
  return rest.split("/").filter(Boolean);
}

function findAdapter(id, query) {
  return createSourceAdapter(id, query) || createTargetAdapter(id);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function engineFor(params) {
  const source = createSourceAdapter(params.source, params);
  const target = createTargetAdapter(params.target);
  if (!source) throw new HttpError(404, "Unknown integration: " + (params.source || "(none)"));
  if (!target) throw new HttpError(404, "Unknown integration: " + (params.target || "(none)"));
  return new MigrationEngine({ source, target });
}

/* Keep only well-formed field decisions that reference real fields. */
async function validateFields(engine, fields) {
  if (!Array.isArray(fields)) throw new HttpError(400, '"fields" must be an array');
  const [rawSchema, targetSchema] = await Promise.all([engine.source.getRawSchema(), engine.target.getSchema()]);
  const sourceKeys = new Set(rawSchema.map((f) => f.key));
  const targetKeys = new Set(targetSchema.map((f) => f.key));
  const seenTargets = new Set();
  return fields.map((f) => {
    if (!f || !sourceKeys.has(f.sourceField)) throw new HttpError(400, "Unknown source field: " + (f && f.sourceField));
    const targetField = f.targetField || null;
    if (targetField && !targetKeys.has(targetField)) throw new HttpError(400, "Unknown target field: " + targetField);
    if (f.decision && !DECISIONS.has(f.decision) && f.decision !== "pending") {
      throw new HttpError(400, "Invalid decision: " + f.decision);
    }
    if (targetField && f.decision !== "rejected") {
      if (seenTargets.has(targetField)) throw new HttpError(400, "Target field mapped twice: " + targetField);
      seenTargets.add(targetField);
    }
    return {
      sourceField: f.sourceField,
      targetField,
      suggestedTarget: f.suggestedTarget || null,
      decision: f.decision || "pending",
      confidence: typeof f.confidence === "number" ? f.confidence : null,
      reason: typeof f.reason === "string" ? f.reason.slice(0, 300) : "",
      method: typeof f.method === "string" ? f.method : "",
    };
  });
}

async function validateWorkspaceRules(engine, rules) {
  if (rules == null) return {};
  if (typeof rules !== "object" || Array.isArray(rules)) throw new HttpError(400, '"workspaceRules" must be an object');
  const ids = new Set((await engine.target.getWorkspaces()).map((w) => String(w.id)));
  const out = {};
  for (const [dept, id] of Object.entries(rules)) {
    if (!ids.has(String(id))) throw new HttpError(400, "Unknown workspace: " + id);
    out[String(dept).slice(0, 120)] = id;
  }
  return out;
}

/* Mappings used for the preview: everything with a target that isn't rejected. */
function activeFields(fields) {
  return fields.filter((f) => f.targetField && f.decision !== "rejected");
}

/**
 * @param {object} [deps]
 * @param {() => string} [deps.getAnthropicKey]  enables Claude suggestions when it returns a key
 * @param {object} [deps.store]  mapping store (get/save/remove)
 * @param {Function} [deps.aiSuggest]  override the Claude suggester (tests)
 * @param {object} [deps.goalStore]  migration goal store (list/get/save/remove)
 * @param {Function|null} [deps.aiInterpret]  override the Claude goal interpreter (tests); null disables it
 * @param {object} [deps.runStore]  migration run store
 * @param {Function|null} [deps.aiDepartments]  override the Claude department resolver (tests); null disables it
 */
function createMigrationApi({
  getAnthropicKey = () => "", store = new JsonFileMappingStore(), aiSuggest,
  goalStore = new JsonFileGoalStore(), aiInterpret, runStore = new JsonFileRunStore(), aiDepartments,
} = {}) {
  function anthropicKey() {
    try { return getAnthropicKey() || ""; } catch (err) { return ""; }
  }
  function aiSuggester() {
    if (aiSuggest) return aiSuggest;
    const key = anthropicKey();
    return key ? (args) => aiSuggestMappings({ ...args, apiKey: key }) : null;
  }
  const handleGoals = createGoalRoutes({
    goalStore,
    mappingStore: store,
    logger,
    getAiInterpreter: () => {
      if (aiInterpret !== undefined) return aiInterpret;
      const key = anthropicKey();
      return key ? (args) => interpretWithClaude({ ...args, apiKey: key }) : null;
    },
  });

  const executor = new MigrationExecutor({
    goalStore,
    runStore,
    mappingStore: store,
    logger,
    getAiDepartmentResolver: () => {
      if (aiDepartments !== undefined) return aiDepartments;
      const key = anthropicKey();
      return key ? (args) => resolveDepartmentsWithClaude({ ...args, apiKey: key }) : null;
    },
    engineFor: (goal) => new MigrationEngine({
      source: createSourceAdapter(goal.source.id, goal.source.demo || {}),
      target: createTargetAdapter(goal.target.id),
    }),
  });
  const handleRuns = createRunRoutes({ executor, runStore, goalStore });

  // JSM customers → Freshservice employees (store paths resolve per request so ZEN_DATA_DIR changes apply)
  const customerDeps = () => {
    const store = new CustomerMigrationStore();
    const mappings = new EntityMappingStore();
    const jsm = () => createJsmCustomers();
    const freshservice = (run) => createFreshserviceRequesters(process.env, { seedEmails: preExistingEmployeeEmails(run && run.config ? run.config.customer_count : 100) });
    return { store, mappings, jsm, freshservice, engine: new CustomerMigrationEngine({ store, mappings, jsm, freshservice }) };
  };

  // Migration agent (store paths resolve per request so ZEN_DATA_DIR changes apply)
  const agentDeps = () => {
    const agentStore = new AgentStore();
    const source = () => createJsmSource();
    const target = () => createFreshserviceTarget();
    // demo runs keep their ID map apart from live ones
    const idMap = (t) => new EntityMappingStore(t.mode === "mock" ? require("path").join(process.env.ZEN_DATA_DIR || require("path").join(require("os").tmpdir(), "zen-data"), "agent-entity-mappings.json") : undefined);
    const engine = new MigrationAgentEngine({
      store: agentStore, idMap, source, target, goalStore, mappingStore: store,
      retryDelayMs: process.env.FRESHSERVICE_DOMAIN ? 1000 : 0,
      getAiDepartmentResolver: () => {
        if (aiDepartments !== undefined) return aiDepartments;
        const key = anthropicKey();
        return key ? (args) => resolveDepartmentsWithClaude({ ...args, apiKey: key }) : null;
      },
    });
    return { engine, store: agentStore, source, target, getAnthropicKey: anthropicKey, aiSuggest: aiSuggest || null };
  };
  let agentHandler = null;
  let agentDir = null;

  return async function handleMigrationApi(req, res) {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const [group, id, action] = routeParts(req.path || "/");
    const q = req.query || {};
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const params = { ...q, ...body };

    try {
      if (group === "integrations" && !id && req.method === "GET") {
        res.json(listIntegrations());
        return;
      }

      if (group === "integrations" && id && action === "connect" && req.method === "POST") {
        const adapter = findAdapter(id, q);
        if (!adapter) return notFound(res, id);
        const result = await adapter.testConnection();
        res.status(result.ok ? 200 : 502).json({ ...adapter.info(), connected: result.ok, message: result.message });
        return;
      }

      if (group === "integrations" && id && action === "records" && req.method === "GET") {
        const source = createSourceAdapter(id, q);
        if (!source) return notFound(res, id);
        const limit = Math.min(Math.max(parseInt(q.limit, 10) || 10, 1), 100);
        const [page, total] = await Promise.all([
          source.fetchRecords({ cursor: q.cursor || null, limit }),
          source.countRecords(),
        ]);
        res.json({ source: source.info(), total, records: page.records, nextCursor: page.nextCursor });
        return;
      }

      if (group === "migration" && id === "pipeline" && req.method === "GET") {
        res.json(await engineFor(q).describe());
        return;
      }

      if (group === "mapping" && !id) {
        const engine = engineFor(params);
        if (req.method === "GET") {
          res.json({ saved: await store.get(params.source, params.target) });
          return;
        }
        if (req.method === "PUT") {
          const fields = await validateFields(engine, body.fields);
          const decided = fields.filter((f) => f.decision !== "pending");
          const saved = await store.save({
            sourceId: params.source,
            targetId: params.target,
            fields: decided,
            workspaceRules: await validateWorkspaceRules(engine, body.workspaceRules),
          });
          res.json({ saved, pendingSkipped: fields.length - decided.length });
          return;
        }
        if (req.method === "DELETE") {
          res.json({ removed: await store.remove(params.source, params.target) });
          return;
        }
      }

      // demo only: clear the simulated target so every demo run starts identically
      if (group === "demo" && id === "reset" && req.method === "POST") {
        const target = createTargetAdapter(params.target || "freshservice");
        if (!target || target.mode !== "mock" || typeof target.reset !== "function") {
          res.status(409).json({ error: "Reset is only available for demo (mock) targets" });
          return;
        }
        res.json({ cleared: await target.reset() });
        return;
      }

      if (group === "agent") {
        // one engine per data dir, so its per-run locks are shared across requests
        const dir = process.env.ZEN_DATA_DIR || "";
        if (!agentHandler || agentDir !== dir) { agentHandler = createAgentRoutes(agentDeps()); agentDir = dir; }
        await agentHandler(req, res, routeParts(req.path || "/"));
        return;
      }

      if (group === "customer-migrations") {
        await createCustomerMigrationRoutes(customerDeps())(req, res, routeParts(req.path || "/"));
        return;
      }

      if (group === "runs" || (group === "goals" && action === "run")) {
        await handleRuns(req, res, routeParts(req.path || "/"), params);
        return;
      }
      if (group === "goals") {
        await handleGoals(req, res, routeParts(req.path || "/"), params);
        return;
      }

      if (group === "mapping" && id === "suggest" && req.method === "POST") {
        const engine = engineFor(params);
        const saved = body.force ? null : await store.get(params.source, params.target);
        const result = await engine.suggestMapping({ saved, aiSuggest: aiSuggester() });
        if (result.aiError) logger.warn("AI mapping suggestions unavailable, used heuristics", { error: result.aiError });
        res.json({
          ...result,
          saved: saved ? { version: saved.version, approvedAt: saved.approvedAt, workspaceRules: saved.workspaceRules || {} } : null,
          aiAvailable: Boolean(aiSuggester()),
        });
        return;
      }

      if (group === "mapping" && id === "preview" && req.method === "POST") {
        const engine = engineFor(params);
        const fields = await validateFields(engine, body.fields || []);
        const workspaceRules = await validateWorkspaceRules(engine, body.workspaceRules);
        const index = Math.max(parseInt(body.index, 10) || 0, 0);
        res.json(await engine.previewMapping({ fields: activeFields(fields), workspaceRules, index, limit: 1 }));
        return;
      }

      res.status(404).json({ error: "Unknown route" });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      logger.error("migration api failed", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  };
}

function notFound(res, id) {
  res.status(404).json({ error: "Unknown integration: " + (id || "(none)") });
}

// default instance (no Claude key) for callers that don't need configuration
const handleMigrationApi = createMigrationApi();

module.exports = { createMigrationApi, handleMigrationApi, routeParts };
