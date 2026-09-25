/* Pre-migration checks for a wave. Every check is critical: if any fails the
   wave must not start. Outcome drives the wave's next state:
     READY                 all checks passed
     PLANNED (waiting)     upstream wave not yet validated — not an error
     BLOCKED               a system problem (connection, auth, window)
     HUMAN_REVIEW_REQUIRED a decision is needed (mapping, workspaces, required fields) */

const { windowBlackoutConflict } = require("./time");
const { waveById } = require("./model");

const REVIEW_CHECKS = new Set(["field_mapping", "workspace_mapping", "required_fields", "upstream_failed"]);

function check(id, label, status, detail) {
  return { id, label, status, critical: true, detail };
}

/**
 * @param {object} args
 * @param {object} args.goal
 * @param {object} args.wave
 * @param {object} args.engine        MigrationEngine for goal.source → goal.target
 * @param {object|null} args.savedMapping
 * @param {Date} args.now
 * @param {{start: Date, end: Date, overrideBlackout: boolean}} [args.runNow]  manual run: check this window instead of the schedule
 * @returns {Promise<{ran_at, results, outcome, reason}>}
 */
async function runPrechecks({ goal, wave, engine, savedMapping, now = new Date(), runNow = null }) {
  const results = [];
  const [srcConn, tgtConn, targetSchema, workspaces] = await Promise.all([
    engine.source.testConnection().catch((e) => ({ ok: false, message: e.message })),
    engine.target.testConnection().catch((e) => ({ ok: false, message: e.message })),
    engine.target.getSchema(),
    engine.target.getWorkspaces(),
  ]);

  results.push(check("source_connection", "Source connection available", srcConn.ok ? "pass" : "fail",
    srcConn.ok ? goal.source.name + ": " + srcConn.message : "Cannot reach " + goal.source.name + ": " + srcConn.message));
  results.push(check("target_connection", "Target connection available", tgtConn.ok ? "pass" : "fail",
    tgtConn.ok ? goal.target.name + ": " + tgtConn.message : "Cannot reach " + goal.target.name + ": " + tgtConn.message));

  const live = [engine.source, engine.target].filter((a) => a.mode === "live");
  const authOk = srcConn.ok && tgtConn.ok;
  results.push(check("authentication", "Authentication valid", authOk ? "pass" : "fail",
    !authOk ? "Credentials were rejected or the systems are unreachable."
      : live.length ? "API credentials accepted by " + live.map((a) => a.name).join(" and ") + "."
        : "Demo mode — no credentials required."));

  const active = savedMapping ? savedMapping.fields.filter((f) => f.targetField && f.decision !== "rejected") : [];
  results.push(check("field_mapping", "Field mappings available", savedMapping ? "pass" : "fail",
    savedMapping ? "Approved mapping v" + savedMapping.version + " with " + active.length + " fields."
      : "No approved field mapping for " + goal.source.name + " → " + goal.target.name + ". Review and save one on the Field mapping page."));

  if (wave.workspace) {
    const ws = workspaces.find((w) => String(w.id) === String(wave.workspace.id));
    results.push(check("workspace_mapping", "Workspace mappings available", ws ? "pass" : "fail",
      ws ? "Records route to " + ws.name + "." : wave.workspace.name + " does not exist in " + goal.target.name + "."));
  } else {
    results.push(check("workspace_mapping", "Workspace mappings available", workspaces.length || wave.category === "all" ? "pass" : "fail",
      "Records route by department across " + workspaces.length + " workspace(s)."));
  }

  const mappedTargets = new Set(active.map((f) => f.targetField));
  const derivable = { subject: "description" };
  const missing = targetSchema.filter((f) => f.required && !mappedTargets.has(f.key) && !(derivable[f.key] && mappedTargets.has(derivable[f.key])));
  results.push(check("required_fields", "Required fields validated", savedMapping && !missing.length ? "pass" : "fail",
    !savedMapping ? "Needs an approved field mapping first."
      : missing.length ? "Not mapped: " + missing.map((f) => f.label).join(", ") + "."
        : "All required " + goal.target.name + " fields are mapped."));

  // window
  let windowStatus = "pass";
  let windowDetail;
  if (runNow) {
    const hit = windowBlackoutConflict(runNow.start, runNow.end, goal.blackout_periods, goal.schedule.timezone);
    if (hit && !runNow.overrideBlackout) {
      windowStatus = "fail";
      windowDetail = "Running now would overlap the \"" + (hit.blackout.label || "blackout") + "\" blackout.";
    } else {
      windowDetail = hit ? "Run started now — blackout overridden by an admin." : "Run started now; the window is clear of blackout periods.";
    }
  } else if (wave.schedule.type === "after_dependency") {
    windowDetail = "Starts in the next window after its dependency is validated" +
      (wave.window && wave.window.start ? " (estimated " + wave.window.start + ")." : ".");
    if (wave.window && wave.window.start && goal.blackout_periods.length
        && windowBlackoutConflict(new Date(wave.window.start), new Date(wave.window.end), goal.blackout_periods, goal.schedule.timezone)) {
      windowStatus = "fail";
      windowDetail = "Estimated window overlaps a blackout period.";
    }
  } else if (!wave.window || !wave.window.start) {
    windowStatus = "fail";
    windowDetail = "No schedule set.";
  } else if (new Date(wave.window.end) < now) {
    windowStatus = "fail";
    windowDetail = "The migration window ended " + wave.window.end + " — reschedule this wave.";
  } else {
    const hit = windowBlackoutConflict(new Date(wave.window.start), new Date(wave.window.end), goal.blackout_periods, goal.schedule.timezone);
    if (hit) {
      windowStatus = "fail";
      windowDetail = "Window overlaps the \"" + (hit.blackout.label || "blackout") + "\" blackout at " + hit.at + ".";
    } else {
      windowDetail = "Window is clear of blackout periods.";
    }
  }
  results.push(check("migration_window", "Migration window available", windowStatus, windowDetail));

  // upstream waves
  const deps = (wave.depends_on || []).map((d) => waveById(goal, d.wave_id)).filter(Boolean);
  if (!deps.length) {
    results.push(check("previous_reconciled", "Previous migration successfully reconciled", "pass", "No dependency — this wave can start on schedule."));
  } else {
    const failed = deps.filter((u) => ["FAILED", "BLOCKED", "HUMAN_REVIEW_REQUIRED", "PAUSED"].includes(u.status));
    const done = deps.filter((u) => u.status === "COMPLETED" && u.result && u.result.success_criteria_met);
    if (failed.length) {
      results.push(check("upstream_failed", "Previous migration successfully reconciled", "fail",
        failed.map((u) => u.name + " is " + u.status.replace(/_/g, " ").toLowerCase()).join("; ") + " — this wave stays paused."));
    } else if (done.length === deps.length) {
      results.push(check("previous_reconciled", "Previous migration successfully reconciled", "pass",
        deps.map((u) => u.name).join(", ") + " completed and met its success criteria."));
    } else {
      results.push(check("previous_reconciled", "Previous migration successfully reconciled", "waiting",
        "Waiting for " + deps.filter((u) => !done.includes(u)).map((u) => u.name).join(", ") + " to be validated."));
    }
  }

  const failures = results.filter((r) => r.status === "fail");
  const waiting = results.filter((r) => r.status === "waiting");
  let outcome;
  let reason;
  if (failures.length) {
    const review = failures.some((f) => REVIEW_CHECKS.has(f.id));
    outcome = review ? "HUMAN_REVIEW_REQUIRED" : "BLOCKED";
    reason = failures.map((f) => f.label + ": " + f.detail).join(" ");
  } else if (waiting.length) {
    outcome = "PLANNED";
    reason = waiting[0].detail;
  } else {
    outcome = "READY";
    reason = "All pre-migration checks passed.";
  }
  return { ran_at: now.toISOString(), results, outcome, reason };
}

module.exports = { runPrechecks };
