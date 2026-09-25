/* HTTP routes for migration goals (mounted by ../api.js under /api/goals).
     POST   /api/goals/interpret        {text, timezone, source?, target?, now?}  → DRAFT goal
     GET    /api/goals                  list
     GET    /api/goals/due?now=         waves the executor should act on
     GET    /api/goals/:id
     PUT    /api/goals/:id              {goal}  admin edits
     POST   /api/goals/:id/approve      DRAFT → PLANNED (scheduled)
     POST   /api/goals/:id/precheck     {wave_id?}  run pre-migration checks
     DELETE /api/goals/:id */

const { interpretRules } = require("./rulesInterpreter");
const { buildGoal, normalizeGoal, refresh, PlanError } = require("./planner");
const { runPrechecks } = require("./prechecks");
const { transition, dueWaves, TransitionError } = require("./model");
const { isValidTimeZone } = require("./time");
const { createSourceAdapter, createTargetAdapter, listIntegrations } = require("../registry");
const { MigrationEngine } = require("../engine");

class GoalHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseNow(v) {
  if (!v) return new Date();
  const d = new Date(v);
  if (isNaN(d)) throw new GoalHttpError(400, "Invalid 'now'");
  return d;
}

function engineFor(sourceId, targetId, demo = {}) {
  const source = createSourceAdapter(sourceId, demo);
  const target = createTargetAdapter(targetId);
  if (!source || !target) throw new GoalHttpError(404, "Unknown integration");
  return new MigrationEngine({ source, target });
}

/**
 * @param {object} deps
 * @param {object} deps.goalStore
 * @param {object} deps.mappingStore
 * @param {() => Function|null} deps.getAiInterpreter  returns async ({text, catalog}) => intent, or null
 * @param {object} deps.logger
 */
function createGoalRoutes({ goalStore, mappingStore, getAiInterpreter, logger }) {
  async function load(id) {
    const goal = await goalStore.get(id);
    if (!goal) throw new GoalHttpError(404, "Goal not found");
    return goal;
  }

  return async function handleGoals(req, res, parts, params) {
    const [, id, action] = parts;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      if (id === "interpret" && req.method === "POST") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new GoalHttpError(400, "Describe the migration goal");
        if (text.length > 4000) throw new GoalHttpError(400, "Goal description is too long");
        const timezone = body.timezone && isValidTimeZone(body.timezone) ? body.timezone : "UTC";
        const now = parseNow(body.now);
        const catalog = listIntegrations();
        const demo = { count: params.count || 750, seed: params.seed || 42 };

        let intent = null;
        let interpretation = { method: "rules" };
        const ai = getAiInterpreter();
        if (ai) {
          try {
            intent = await ai({ text, catalog });
            interpretation = { method: "ai", model: "claude-opus-5" };
          } catch (err) {
            logger.warn("AI goal interpretation unavailable, used rules", { error: err.message });
            interpretation = { method: "rules", error: err.message };
          }
        }
        if (!intent) intent = interpretRules(text, catalog);

        const goal = await buildGoal(intent, {
          text, now, timezone, catalog, demo, interpretation, mappingStore,
          defaults: { source: body.source || catalog.sources[0].id, target: body.target || catalog.targets[0].id },
          engineFor: (s, t) => engineFor(s, t, demo),
        });
        await goalStore.save(goal);
        res.json({ goal });
        return;
      }

      if (!id && req.method === "GET") {
        const now = parseNow(params.now);
        const goals = (await goalStore.list()).map((g) => refresh(g, now));
        res.json({ goals });
        return;
      }

      if (id === "due" && req.method === "GET") {
        const now = parseNow(params.now);
        const due = [];
        for (const g of await goalStore.list()) {
          for (const d of dueWaves(g, now)) due.push({ goal_id: g.goal_id, ...d });
        }
        res.json({ now: now.toISOString(), due });
        return;
      }

      if (id && !action) {
        if (req.method === "GET") {
          res.json({ goal: refresh(await load(id), parseNow(params.now)) });
          return;
        }
        if (req.method === "PUT") {
          const stored = await load(id);
          const input = body.goal && typeof body.goal === "object" ? body.goal : body;
          const goal = await normalizeGoal(stored, input, {
            now: parseNow(body.now), mappingStore,
            engineFor: (s, t) => engineFor(s, t, stored.source.demo),
          });
          await goalStore.save(goal);
          res.json({ goal });
          return;
        }
        if (req.method === "DELETE") {
          res.json({ removed: await goalStore.remove(id) });
          return;
        }
      }

      if (id && action === "approve" && req.method === "POST") {
        const goal = await load(id);
        const now = parseNow(body.now);
        const pastDue = goal.waves.filter((w) => w.schedule.type === "at" && w.window && new Date(w.window.end) < now);
        if (pastDue.length) throw new GoalHttpError(400, pastDue.map((w) => w.name).join(", ") + " is scheduled in the past — change the time first");
        goal.waves.forEach((w) => { if (w.status === "DRAFT") transition(w, "PLANNED", "Approved and scheduled.", now); });
        goal.approved_at = now.toISOString();
        const saved = await goalStore.save(refresh(goal, now));
        res.json({ goal: saved });
        return;
      }

      if (id && action === "precheck" && req.method === "POST") {
        const goal = await load(id);
        if (!goal.approved_at) throw new GoalHttpError(400, "Approve the goal before running pre-checks");
        const now = parseNow(body.now);
        const eligible = ["PLANNED", "READY", "BLOCKED", "HUMAN_REVIEW_REQUIRED"];
        const targets = body.wave_id
          ? goal.waves.filter((w) => w.wave_id === body.wave_id)
          : goal.waves.filter((w) => eligible.includes(w.status));
        if (body.wave_id && !targets.length) throw new GoalHttpError(404, "Wave not found");
        const engine = engineFor(goal.source.id, goal.target.id, goal.source.demo);
        const savedMapping = await mappingStore.get(goal.source.id, goal.target.id);
        if (savedMapping) {
          goal.field_mapping = {
            ...goal.field_mapping, status: "approved", version: savedMapping.version, approved_at: savedMapping.approvedAt,
            fields: savedMapping.fields.filter((f) => f.targetField && f.decision !== "rejected").length,
          };
        }
        for (const wave of targets) {
          if (!eligible.includes(wave.status)) throw new GoalHttpError(409, wave.name + " is " + wave.status + " — pre-checks can't run now");
          transition(wave, "PRECHECK", "Running pre-migration checks.", now);
          const pre = await runPrechecks({ goal, wave, engine, savedMapping, now });
          wave.prechecks = pre;
          transition(wave, pre.outcome, pre.reason, now);
        }
        const saved = await goalStore.save(refresh(goal, now));
        res.json({ goal: saved });
        return;
      }

      throw new GoalHttpError(404, "Unknown route");
    } catch (err) {
      if (err instanceof GoalHttpError) return res.status(err.status).json({ error: err.message });
      if (err instanceof PlanError) return res.status(400).json({ error: err.message });
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      throw err;
    }
  };
}

module.exports = { createGoalRoutes };
