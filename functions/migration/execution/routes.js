/* HTTP routes for migration runs (mounted by ../api.js).
     POST /api/goals/:id/run        {override_blackout?}  approve (if needed) and start now
     GET  /api/runs?goal_id=        list runs (summaries)
     GET  /api/runs?view=history    one compact row per run (migration history)
     GET  /api/runs/:id/report      migration report + reconciliation
     GET  /api/runs/:id
     POST /api/runs/:id/advance     do the next unit of work (phase step or batch)
     POST /api/runs/:id/pause
     POST /api/runs/:id/resume      also leaves the human review gate
     POST /api/runs/:id/stop
     POST /api/runs/:id/retry       new run for the goal; skips records already migrated
     POST /api/runs/:id/review/:failureId/approve   {values?}  approve retry
     POST /api/runs/:id/review/:failureId/skip
     POST /api/runs/:id/review/apply                {group?}   apply Zen's recommendations
   advance is what the UI polls; a worker or scheduler can call it the same way. */

const { ExecutionError } = require("./executor");
const { REVIEW_GROUPS } = require("./remediation");
const { buildReport, historyRow } = require("./report");

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 100);

/* Everything a human needs to decide: grouped exceptions, what Zen tried and recommends, impact and status. */
function reviewSummary(run) {
  const failures = run.failures || [];
  const escalated = failures.filter((f) => ["HUMAN_REVIEW_REQUIRED", "SKIPPED", "DEFERRED"].includes(f.status) || f.resolved_by === "human");
  const pending = failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED");
  const t = run.totals;
  const denominator = t.processed - t.skipped;
  const migrated = t.successful + t.remediated + (t.human_resolved || 0);
  const groups = {};
  for (const f of escalated) {
    const key = (f.recommendation && f.recommendation.group) || "invalid_value";
    const g = (groups[key] = groups[key] || {
      group: key, title: REVIEW_GROUPS[key] || "Needs review", category: f.category_label,
      what_failed: f.issues && f.issues[0] ? f.issues[0].message : f.reason,
      why: f.review_reason, attempts: f.attempts || [], recommendation: f.recommendation,
      total: 0, pending: 0, resolved: 0, skipped: 0, failure_ids: [],
    });
    g.total++;
    g.failure_ids.push(f.failure_id);
    if (f.status === "HUMAN_REVIEW_REQUIRED") g.pending++;
    else if (f.status === "RESOLVED") g.resolved++;
    else g.skipped++;
  }
  const blockedWaves = run.review_gate && run.review_gate.type === "criteria"
    ? run.wave_order.slice(run.wave_order.indexOf(run.review_gate.wave_id) + 1).map((id) => run.waves[id].name) : [];
  const waveName = run.waves[run.current_wave_id] ? run.waves[run.current_wave_id].name : "";
  return {
    gate: run.review_gate,
    awaiting: pending.length,
    escalated: escalated.length,
    auto_resolved: (run.remediation && run.remediation.resolved) || 0,
    human_resolved: failures.filter((f) => f.resolved_by === "human" && f.status === "RESOLVED").length,
    skipped: failures.filter((f) => f.status === "SKIPPED").length,
    deferred: failures.filter((f) => f.status === "DEFERRED").length,
    impact: {
      records_not_migrated: pending.length,
      success_rate_now: pct(migrated, denominator),
      success_rate_if_approved: pct(migrated + pending.length, denominator),
      blocked_waves: blockedWaves,
      message: !pending.length ? "No decisions outstanding."
        : blockedWaves.length ? waveName + " did not meet its success criteria, so " + blockedWaves.join(", ") + " can't start until these are resolved."
          : "Everything else is migrated and every wave met its success criteria. These " + pending.length + " record(s) are not in " + run.target.name + " yet; Zen finishes the migration once you decide.",
    },
    status: { run_status: run.status, current_wave: waveName, processed: t.processed, expected: t.expected, migrated },
    groups: Object.values(groups).sort((a, b) => b.pending - a.pending || b.total - a.total),
  };
}

function summary(run) {
  const { seen_ids, failures, events, ...rest } = run; // eslint-disable-line no-unused-vars
  const waves = {};
  for (const [id, w] of Object.entries(run.waves)) {
    const { written, cursor, ...wr } = w; // eslint-disable-line no-unused-vars
    waves[id] = wr;
  }
  return {
    ...rest,
    waves,
    // full failure records (source data, mapping, remediation, outcome) for the review UI
    failures: (failures || []).slice(0, 500),
    failures_count: (failures || []).length,
    review: reviewSummary(run),
    events: events.slice(-40),
  };
}

function parseNow(v) {
  if (!v) return new Date();
  const d = new Date(v);
  if (isNaN(d)) throw new ExecutionError(400, "Invalid 'now'");
  return d;
}

function createRunRoutes({ executor, runStore, goalStore }) {
  const goalOf = async (run) => (goalStore ? goalStore.get(run.goal_id) : null);
  return async function handleRuns(req, res, parts, params) {
    const [group, id, action] = parts;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      if (group === "goals" && action === "run" && req.method === "POST") {
        const run = await executor.start(id, { now: parseNow(body.now), overrideBlackout: Boolean(body.override_blackout) });
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && !id && req.method === "GET" && params.view === "history") {
        const runs = await runStore.list({ goalId: params.goal_id || null });
        const rows = [];
        for (const r of runs) rows.push(historyRow(r, await goalOf(r)));
        res.json({ history: rows });
        return;
      }
      if (group === "runs" && id && action === "report" && req.method === "GET") {
        const run = await runStore.get(id);
        if (!run) throw new ExecutionError(404, "Run not found");
        res.json({ report: buildReport(run, await goalOf(run)) });
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
      if (group === "runs" && id && ["pause", "resume", "stop"].includes(action) && req.method === "POST") {
        const run = await executor[action](id, { now: parseNow(body.now), by: body.by || "admin" });
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && id && action === "retry" && req.method === "POST") {
        const run = await executor.retry(id, { now: parseNow(body.now), by: body.by || "admin", overrideBlackout: body.override_blackout });
        res.json({ run: summary(run) });
        return;
      }
      if (group === "runs" && id && action === "review" && req.method === "POST") {
        const [, , , target, verb] = parts;
        const opts = { now: parseNow(body.now), by: body.by || "admin" };
        if (target === "apply") {
          const { run, outcome } = await executor.applyRecommendations(id, { ...opts, group: body.group || null });
          res.json({ run: summary(run), outcome });
          return;
        }
        if (target && verb === "approve") {
          try {
            const run = await executor.approveReview(id, target, { ...opts, values: body.values || {} });
            res.json({ run: summary(run) });
          } catch (err) {
            if (err instanceof ExecutionError && err.status === 422) {
              const run = await runStore.get(id);
              res.status(422).json({ error: err.message, run: summary(run) });
              return;
            }
            throw err;
          }
          return;
        }
        if (target && verb === "skip") {
          const run = await executor.skipReview(id, target, { ...opts, reason: body.reason || "" });
          res.json({ run: summary(run) });
          return;
        }
      }
      throw new ExecutionError(404, "Unknown route");
    } catch (err) {
      if (err instanceof ExecutionError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  };
}

module.exports = { createRunRoutes, summary };
