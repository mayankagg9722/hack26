/* HTTP routes for migration runs (mounted by ../api.js).
     POST /api/goals/:id/run        {override_blackout?}  approve (if needed) and start now
     GET  /api/runs?goal_id=        list runs (summaries)
     GET  /api/runs/:id
     POST /api/runs/:id/advance     do the next unit of work (phase step or batch)
     POST /api/runs/:id/pause
     POST /api/runs/:id/resume
   advance is what the UI polls; a worker or scheduler can call it the same way. */

const { ExecutionError } = require("./executor");

function summary(run) {
  const { seen_ids, review_queue, remediations, events, ...rest } = run; // eslint-disable-line no-unused-vars
  const waves = {};
  for (const [id, w] of Object.entries(run.waves)) {
    const { written_ids, cursor, ...wr } = w; // eslint-disable-line no-unused-vars
    waves[id] = wr;
  }
  return {
    ...rest,
    waves,
    review_queue_count: review_queue.length,
    review_queue: review_queue.slice(0, 50).map(({ source, ...q }) => q), // eslint-disable-line no-unused-vars
    remediations_count: remediations.length,
    remediations: remediations.slice(-25),
    events: events.slice(-40),
  };
}

function parseNow(v) {
  if (!v) return new Date();
  const d = new Date(v);
  if (isNaN(d)) throw new ExecutionError(400, "Invalid 'now'");
  return d;
}

function createRunRoutes({ executor, runStore }) {
  return async function handleRuns(req, res, parts, params) {
    const [group, id, action] = parts;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      if (group === "goals" && action === "run" && req.method === "POST") {
        const run = await executor.start(id, { now: parseNow(body.now), overrideBlackout: Boolean(body.override_blackout) });
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && !id && req.method === "GET") {
        const runs = await runStore.list({ goalId: params.goal_id || null });
        res.json({ runs: runs.map(summary) });
        return;
      }
      if (group === "runs" && id && !action && req.method === "GET") {
        const run = await runStore.get(id);
        if (!run) throw new ExecutionError(404, "Run not found");
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && id && action === "advance" && req.method === "POST") {
        const budget = Math.min(Math.max(parseInt(body.budget_ms, 10) || 1200, 100), 20000);
        const run = await executor.advance(id, { now: parseNow(body.now), budgetMs: budget, maxRecords: Math.min(parseInt(body.max_records, 10) || 40, 500) });
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && id && (action === "pause" || action === "resume") && req.method === "POST") {
        const run = await executor[action](id, { now: parseNow(body.now) });
        res.json({ run: summary(run) });
        return;
      }
      throw new ExecutionError(404, "Unknown route");
    } catch (err) {
      if (err instanceof ExecutionError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  };
}

module.exports = { createRunRoutes, summary };
