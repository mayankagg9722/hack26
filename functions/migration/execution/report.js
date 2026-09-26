/* Migration report: "Did my migration actually work?" — computed only from
   the stored run (and its goal), never from fixed numbers.

   Definitions
     total records        source records in scope for this run (+ ones an earlier run already migrated)
     migrated first time  written on the first attempt
     auto-remediated      failed, fixed by Zen, re-processed and written
     resolved by humans   escalated, approved by a person, re-processed and written
     not migrated         skipped / deferred / still awaiting a decision
     success rate         records now in the target ÷ total records
   Reconciliation compares source records with records verified in the target. */

const REC_STATUS = { COMPLETE: "COMPLETE", PARTIAL: "PARTIALLY COMPLETE", FAILED: "FAILED", RUNNING: "IN PROGRESS" };
const ACTIVE = ["PLANNED", "VALIDATING", "MAPPING", "MIGRATING", "REMEDIATING", "VALIDATING_TARGET", "RECONCILING", "FINALIZING"];

const rate = (n, d) => (d ? n / d : 0);

function sumWaves(run, fn) {
  return Object.values(run.waves).reduce((n, w) => n + (fn(w) || 0), 0);
}

function buildReport(run, goal = null, now = new Date()) {
  const t = run.totals || {};
  const failures = run.failures || [];
  const alreadyMigrated = sumWaves(run, (w) => w.already_migrated);
  const processed = t.processed || 0;
  const firstPass = t.successful || 0;
  const autoFixed = t.remediated || 0;
  const humanResolved = t.human_resolved || 0;
  const skipped = failures.filter((f) => f.status === "SKIPPED").length;
  const deferred = failures.filter((f) => f.status === "DEFERRED").length;
  const awaiting = failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED").length;
  const pendingRemediation = failures.filter((f) => f.status === "OPEN" || f.status === "REMEDIATING").length;
  const migratedThisRun = firstPass + autoFixed + humanResolved;
  const total = processed + alreadyMigrated;
  const notMigrated = total - migratedThisRun - alreadyMigrated;
  const escalated = failures.filter((f) => ["HUMAN_REVIEW_REQUIRED", "SKIPPED", "DEFERRED"].includes(f.status) || f.resolved_by === "human").length;

  // reconciliation: records verified in the target (per wave) + ones migrated by earlier runs
  const verifiedThisRun = sumWaves(run, (w) => (w.verification ? w.verification.checked : w.counts.successful + w.counts.remediated + (w.counts.human_resolved || 0)));
  const targetRecords = verifiedThisRun + alreadyMigrated;
  const unresolved = Math.max(0, total - targetRecords);
  const problems = sumWaves(run, (w) => (w.verification ? w.verification.problems + (w.verification.missing || 0) : 0));
  const running = ACTIVE.includes(run.status) || (run.status === "HUMAN_REVIEW_REQUIRED" && run.review_gate);
  let recStatus;
  if (running) recStatus = REC_STATUS.RUNNING;
  else if (targetRecords === 0) recStatus = REC_STATUS.FAILED;
  else if (unresolved === 0 && problems === 0) recStatus = REC_STATUS.COMPLETE;
  else recStatus = REC_STATUS.PARTIAL;

  // failure breakdown by category and outcome
  const byCat = {};
  for (const f of failures) {
    const c = (byCat[f.category] = byCat[f.category] || { category: f.category, label: f.category_label, detected: 0, auto_fixed: 0, human_resolved: 0, unresolved: 0 });
    c.detected++;
    if (f.status === "RESOLVED" && f.resolved_by === "human") c.human_resolved++;
    else if (f.status === "RESOLVED") c.auto_fixed++;
    else c.unresolved++;
  }

  // time
  const start = new Date(run.created_at);
  const end = run.finished_at ? new Date(run.finished_at) : now;
  const elapsed = Math.max(0, end - start);
  const humanWait = (run.human_wait_ms || 0) + (run.review_gate && !run.finished_at ? Math.max(0, now - new Date(run.review_gate.opened_at)) : 0);
  const paused = (run.paused_ms || 0) + (run.paused_at ? Math.max(0, now - new Date(run.paused_at)) : 0);
  const processing = Math.max(1, elapsed - humanWait - paused);

  // where records landed
  const landed = {};
  for (const w of Object.values(run.waves)) for (const x of w.written || []) landed[x.workspace_id] = (landed[x.workspace_id] || 0) + 1;
  const wsNames = {};
  for (const w of Object.values(run.waves)) if (w.workspace) wsNames[w.workspace.id] = w.workspace.name;
  for (const f of failures) if (f.remediation && f.remediation.rerouted_to && f.outcome) wsNames[f.outcome.workspace_id] = f.remediation.rerouted_to;

  const keyEvents = (run.events || []).filter((e) => e.level !== "info" || /started|completed|paused|resum|stopped|continuing/i.test(e.message));

  return {
    run_id: run.run_id,
    goal_id: run.goal_id,
    goal_title: goal ? goal.title : null,
    goal_description: goal ? goal.goal_description : null,
    source: run.source,
    target: run.target,
    status: run.status,
    status_reason: run.status_reason,
    trigger: run.trigger,
    mapping_version: run.mapping_version,
    started_at: run.created_at,
    finished_at: run.finished_at,
    generated_at: now.toISOString(),
    totals: {
      total_records: total,
      processed,
      already_migrated: alreadyMigrated,
      first_pass_success: firstPass,
      auto_remediated: autoFixed,
      human_resolved: humanResolved,
      migrated: migratedThisRun + alreadyMigrated,
      not_migrated: notMigrated,
      failed_first_pass: t.failed || 0,
      escalated,
      skipped,
      deferred,
      awaiting,
      pending_remediation: pendingRemediation,
    },
    rates: {
      success_rate: rate(migratedThisRun + alreadyMigrated, total),
      first_pass_rate: rate(firstPass, processed),
      auto_remediation_rate: rate(autoFixed, t.failed || 0),
      human_intervention_rate: rate(escalated, total),
      ai_resolved: (run.remediation && run.remediation.ai_resolved) || 0,
    },
    reconciliation: {
      source_records: total,
      target_records: targetRecords,
      unresolved,
      unresolved_breakdown: { skipped, deferred, awaiting, pending_remediation: pendingRemediation },
      verification_problems: problems,
      status: recStatus,
      waves: run.wave_order.map((id) => {
        const w = run.waves[id];
        return {
          name: w.name, workspace: w.workspace ? w.workspace.name : "All workspaces",
          source: w.counts.processed + (w.already_migrated || 0),
          target: (w.verification ? w.verification.checked : 0) + (w.already_migrated || 0),
          match: w.reconciliation ? w.reconciliation.match : null,
        };
      }),
    },
    failure_breakdown: Object.values(byCat).sort((a, b) => b.detected - a.detected),
    value: {
      elapsed_ms: elapsed,
      processing_ms: processing,
      human_wait_ms: humanWait,
      paused_ms: paused,
      records_per_minute: processed ? Math.round(processed / (processing / 60000)) : 0,
      demo_target: run.target.mode === "mock",
    },
    waves: run.wave_order.map((id) => {
      const w = run.waves[id];
      const c = w.counts;
      const done = c.successful + c.remediated + (c.human_resolved || 0);
      const times = Object.values(w.phase_times || {}).map((x) => new Date(x).getTime());
      return {
        wave_id: id, name: w.name, workspace: w.workspace ? w.workspace.name : "All workspaces", phase: w.phase,
        processed: c.processed, first_pass: c.successful, auto_remediated: c.remediated, human_resolved: c.human_resolved || 0,
        not_migrated: c.processed - done, already_migrated: w.already_migrated || 0,
        success_rate: rate(done, c.processed), reconciled: w.reconciliation ? w.reconciliation.match : null,
        duration_ms: times.length ? (w.finished_at ? new Date(w.finished_at) : end) - Math.min(...times) : 0,
      };
    }),
    workspaces: Object.entries(landed).map(([id, n]) => ({ id, name: wsNames[id] || id, records: n })).sort((a, b) => b.records - a.records),
    unresolved_records: failures.filter((f) => ["SKIPPED", "DEFERRED", "HUMAN_REVIEW_REQUIRED"].includes(f.status)).map((f) => ({
      record_id: f.record_id, category: f.category_label, status: f.status,
      reason: f.review_reason || f.reason,
      decision: f.decision ? f.decision.action + " by " + f.decision.by : null,
    })),
    timeline: keyEvents.slice(-25),
  };
}

/** One row per run for the history view. */
function historyRow(run, goal = null) {
  const r = buildReport(run, goal);
  return {
    run_id: r.run_id, goal_id: r.goal_id, goal_title: r.goal_title,
    source: r.source.name, target: r.target.name,
    started_at: r.started_at, finished_at: r.finished_at, status: r.status,
    records_processed: r.totals.processed, total_records: r.totals.total_records,
    success_rate: r.rates.success_rate, failures: r.totals.failed_first_pass,
    auto_remediated: r.totals.auto_remediated, human_interventions: r.totals.escalated,
    reconciliation: r.reconciliation.status, elapsed_ms: r.value.elapsed_ms,
  };
}

module.exports = { buildReport, historyRow, REC_STATUS };
