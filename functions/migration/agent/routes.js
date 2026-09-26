/* HTTP routes for the migration agent (mounted by ../api.js). Each of the
   five agent tools is one route; GET /api/agent/tools describes them.
     GET  /api/agent/tools
     GET  /api/agent/source-entities           list_source_entities
     GET  /api/agent/target-entities           list_target_entities
     POST /api/agent/mappings {pair}           generate_mapping
     GET  /api/agent/mappings?pair=            latest mapping for a pair
     POST /api/agent/mappings/:id/decide {source, decision}
     GET  /api/agent/runs
     POST /api/agent/runs {goalId?, entities?, mappingIds?, overrideBlackout?}   run_migration
     GET  /api/agent/runs/:id
     POST /api/agent/runs/:id/advance
     POST /api/agent/runs/:id/review {record, action: approve|skip, input?}
     POST /api/agent/runs/:id/stop
     POST /api/agent/runs/:id/insights         generate_migration_insights
     POST /api/agent/demo-reset                demo only
   Responses never contain credentials. */

const { generateMapping, decide, PAIRS } = require("./mapping");
const { AgentError, summarize, ENTITIES } = require("./engine");
const { generateMigrationInsights } = require("./insights");

const TOOLS = [
  { name: "list_source_entities", method: "GET", path: "/api/agent/source-entities", description: "Discover migratable entities and their fields in Jira Service Management." },
  { name: "list_target_entities", method: "GET", path: "/api/agent/target-entities", description: "Discover Freshservice entities and fields (Product MCP when enabled, REST API v2 otherwise)." },
  { name: "generate_mapping", method: "POST", path: "/api/agent/mappings", description: "Map a source entity schema onto a target entity schema with confidence and transformations.", input: { pair: Object.keys(PAIRS) } },
  { name: "run_migration", method: "POST", path: "/api/agent/runs", description: "Plan, pre-check and execute the migration; resumable, idempotent, with remediation and human review.", input: { goalId: "string?", entities: ["customers", "tickets"], mappingIds: "object?" } },
  { name: "generate_migration_insights", method: "POST", path: "/api/agent/runs/:id/insights", description: "Claude analyses the migration results and returns structured insights." },
];

function modeLabel(mode) {
  return mode === "live" ? "REAL API" : "MOCK DATA";
}

function runView(run, { records = true } = {}) {
  const { records: map, order, department_resolution, ...rest } = run; // eslint-disable-line no-unused-vars
  const out = { ...rest, summary: summarize(run) };
  if (records) {
    out.records = run.entities.flatMap((e) => (order[e] || []).map((k) => {
      const { native, demo, overrides, refs, ...r } = map[k]; // eslint-disable-line no-unused-vars
      return r;
    }));
  }
  return out;
}

function createAgentRoutes({ engine, store, source, target, getAnthropicKey = () => "", aiSuggest = null }) {
  async function discoverSource() {
    const s = source();
    const entities = await s.discover();
    return { system: s.system, mode: s.mode, label: modeLabel(s.mode), via: s.via, entities };
  }
  async function discoverTarget() {
    const t = target();
    const { entities, notes } = await t.discover();
    return { system: t.system, mode: t.mode, label: modeLabel(t.mode), via: t.via, entities, notes, writes_allowed: t.mode === "mock" || Boolean(t.writesAllowed) };
  }

  return async function handle(req, res, parts) {
    const [, id, sub, action] = parts;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const q = req.query || {};
    try {
      if (id === "tools" && req.method === "GET") return res.json({ tools: TOOLS });
      if (id === "source-entities" && req.method === "GET") return res.json(await discoverSource());
      if (id === "target-entities" && req.method === "GET") return res.json(await discoverTarget());

      if (id === "mappings") {
        if (!sub && req.method === "GET") {
          const pair = q.pair;
          if (!PAIRS[pair]) throw new AgentError(400, "pair must be one of " + Object.keys(PAIRS).join(", "));
          return res.json({ mapping: await store.latestMapping(pair) });
        }
        if (!sub && req.method === "POST") {
          const p = PAIRS[body.pair];
          if (!p) throw new AgentError(400, "pair must be one of " + Object.keys(PAIRS).join(", "));
          const [src, tgt] = await Promise.all([discoverSource(), discoverTarget()]);
          const se = src.entities.find((e) => e.entityType === p.source);
          const te = tgt.entities.find((e) => e.entityType === p.target);
          if (!se || !te) throw new AgentError(409, "Entity not discovered");
          const key = getAnthropicKey();
          const ai = aiSuggest || (key ? (args) => require("../mapping/aiSuggest").aiSuggestMappings({ ...args, apiKey: key }) : null);
          const mapping = await generateMapping({ pair: body.pair, sourceEntity: se, targetEntity: te, aiSuggest: ai });
          mapping.aiAvailable = Boolean(ai);
          mapping.sourceMode = src.mode;
          mapping.targetMode = tgt.mode;
          return res.json({ mapping: await store.saveMapping(mapping) });
        }
        if (sub && action === "decide" && req.method === "POST") {
          const m = await store.getMapping(sub);
          if (!m) throw new AgentError(404, "Mapping not found");
          try { decide(m, body.source, body.decision); } catch (err) { throw new AgentError(400, err.message); }
          return res.json({ mapping: await store.saveMapping(m) });
        }
      }

      if (id === "runs") {
        if (!sub && req.method === "GET") return res.json({ runs: (await store.listRuns()).map((r) => runView(r, { records: false })) });
        if (!sub && req.method === "POST") {
          const run = await engine.start({ goalId: body.goalId || null, entities: body.entities, mappingIds: body.mappingIds || {}, overrideBlackout: Boolean(body.overrideBlackout), by: body.by || "admin" });
          return res.json({ run: runView(run) });
        }
        if (sub && !action && req.method === "GET") {
          const run = await store.getRun(sub);
          if (!run) throw new AgentError(404, "Migration not found");
          return res.json({ run: runView(run, { records: q.records !== "0" }) });
        }
        if (sub && action === "advance" && req.method === "POST") return res.json({ run: runView(await engine.advance(sub), { records: q.records !== "0" }) });
        if (sub && action === "review" && req.method === "POST") return res.json({ run: runView(await engine.review(sub, body.record, { action: body.action, input: body.input || {}, by: body.by || "admin" })) });
        if (sub && action === "stop" && req.method === "POST") return res.json({ run: runView(await engine.stop(sub, { by: body.by || "admin" })) });
        if (sub && action === "insights" && req.method === "POST") {
          const snapshot = await store.getRun(sub);
          if (!snapshot) throw new AgentError(404, "Migration not found");
          if (!["COMPLETED", "STOPPED", "HUMAN_REVIEW_REQUIRED", "FAILED", "BLOCKED"].includes(snapshot.status)) throw new AgentError(409, "Insights are available once the migration finishes or pauses");
          const mappings = {};
          for (const e of snapshot.entities) mappings[e] = await store.getMapping(snapshot.mapping_ids[e]);
          const insights = await generateMigrationInsights(snapshot, { mappings, apiKey: getAnthropicKey() });
          // Claude can take a while — save onto the latest run state, under the run lock
          await engine.withLock(sub, async () => { const run = await store.getRun(sub); run.insights = insights; await store.saveRun(run); });
          return res.json({ insights });
        }
      }

      if (id === "demo-reset" && req.method === "POST") {
        const t = target();
        const s = source();
        if (t.mode !== "mock" || s.mode !== "mock") throw new AgentError(409, "Reset is only available in demo mode");
        const idMap = engine.idMapFor(t);
        return res.json({ target_records: await t.reset(), runs: await store.clear(), id_mappings: await idMap.clear() });
      }

      throw new AgentError(404, "Unknown route");
    } catch (err) {
      if (err instanceof AgentError) return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
      if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
}

module.exports = { createAgentRoutes, runView, TOOLS, ENTITIES };
