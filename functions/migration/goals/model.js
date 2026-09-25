/* Migration goal model — the contract between Goal Planner (this stage) and
   the Migration Executor (next stage).

   A goal is WHAT (source, target, record types, scope, mappings), WHEN
   (waves, schedule, windows, blackouts), IN WHAT ORDER (dependencies), UNDER
   WHAT CONDITIONS (success criteria) and WHAT IF IT GOES WRONG (failure
   policy). Field names are snake_case so the document can be stored and
   exchanged as-is.

   The executor is expected to:
     1. poll dueWaves(goal, now) for waves whose time has come;
     2. run pre-checks (action "precheck") and only start waves that are READY;
     3. drive wave status with transition() through RUNNING → VALIDATING →
        RECONCILING → COMPLETED, recording wave.result;
     4. call evaluateSuccessCriteria() + decideNextAction() after each wave and
        windowAction() when a window ends, and follow what they return. */

const { inBlackout } = require("./time");

const WAVE_STATES = [
  "DRAFT", "PLANNED", "PRECHECK", "READY", "RUNNING", "VALIDATING", "RECONCILING", "COMPLETED",
  "PAUSED", "BLOCKED", "HUMAN_REVIEW_REQUIRED", "FAILED",
];

// allowed wave status transitions
const TRANSITIONS = {
  DRAFT: ["PLANNED"],
  PLANNED: ["PRECHECK", "DRAFT"],
  PRECHECK: ["READY", "PLANNED", "BLOCKED", "HUMAN_REVIEW_REQUIRED"],
  READY: ["RUNNING", "PLANNED", "PRECHECK", "PAUSED"],
  RUNNING: ["VALIDATING", "PAUSED", "FAILED", "HUMAN_REVIEW_REQUIRED"],
  VALIDATING: ["RECONCILING", "PAUSED", "FAILED", "HUMAN_REVIEW_REQUIRED"],
  RECONCILING: ["COMPLETED", "PAUSED", "FAILED", "HUMAN_REVIEW_REQUIRED"],
  COMPLETED: [],
  PAUSED: ["PLANNED", "PRECHECK", "READY", "RUNNING", "FAILED"],
  BLOCKED: ["PLANNED", "PRECHECK"],
  HUMAN_REVIEW_REQUIRED: ["PLANNED", "PRECHECK", "RUNNING", "FAILED"],
  FAILED: ["PLANNED"],
};

const ACTIVE_STATES = ["RUNNING", "VALIDATING", "RECONCILING"];
const ATTENTION_STATES = ["BLOCKED", "HUMAN_REVIEW_REQUIRED", "FAILED", "PAUSED"];

const RECORD_TYPES = ["employees", "tickets"];
const SCHEDULE_TYPES = ["at", "immediate", "after_dependency"];
const OVERRUN_POLICIES = ["pause", "continue", "escalate", "stop"];
const ACTIONS = ["continue", "ai_remediation", "human_review", "pause", "stop", "escalate"];

const DEFAULT_SUCCESS_CRITERIA = {
  min_success_rate: 0.95,
  max_critical_errors: 0,
  required_fields_populated: true,
  reconciliation_complete: true,
  no_unresolved_high_severity: true,
};

const DEFAULT_FAILURE_POLICY = {
  on_success: "continue",
  on_partial_failure: "ai_remediation",
  on_unresolved: "human_review",
  on_critical_failure: "pause",
  pause_below_success_rate: null,
};

const DEFAULT_WINDOW = { duration_minutes: 300, on_overrun: "pause" };

const BUSINESS_HOURS_BLACKOUT = {
  label: "Business hours",
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "18:00",
};

class TransitionError extends Error {}

/** 0.95 → "95%", 0.995 → "99.5%" */
function pct(fraction) {
  return +(fraction * 100).toFixed(1) + "%";
}

/** Move a wave to a new status, enforcing the state machine and keeping history. */
function transition(wave, to, reason = "", at = new Date()) {
  if (!WAVE_STATES.includes(to)) throw new TransitionError("Unknown state " + to);
  const from = wave.status;
  if (from === to) {
    wave.status_reason = reason || wave.status_reason;
    return wave;
  }
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw new TransitionError("Wave " + wave.wave_id + " cannot move from " + from + " to " + to);
  }
  wave.status = to;
  wave.status_reason = reason;
  wave.history = (wave.history || []).concat({ at: at.toISOString(), from, to, reason });
  return wave;
}

function waveById(goal, id) {
  return goal.waves.find((w) => w.wave_id === id) || null;
}

/** A dependency is satisfied when the upstream wave completed and met its criteria. */
function isDependencySatisfied(goal, wave) {
  return (wave.depends_on || []).every((dep) => {
    const up = waveById(goal, dep.wave_id);
    return up && up.status === "COMPLETED" && up.result && up.result.success_criteria_met === true;
  });
}

function dependencyFailed(goal, wave) {
  return (wave.depends_on || []).some((dep) => {
    const up = waveById(goal, dep.wave_id);
    return up && ["FAILED", "BLOCKED", "HUMAN_REVIEW_REQUIRED", "PAUSED"].includes(up.status);
  });
}

/** Human-facing status used by dashboards ("Scheduled", "Waiting on IT", ...). */
function displayStatus(goal, wave) {
  if (wave.status === "PLANNED") {
    const pending = (wave.depends_on || []).filter((d) => {
      const up = waveById(goal, d.wave_id);
      return !(up && up.status === "COMPLETED");
    });
    if (pending.length) {
      const names = pending.map((d) => (waveById(goal, d.wave_id) || {}).name || d.wave_id);
      return "Waiting on " + names.join(", ");
    }
    return "Scheduled";
  }
  const labels = {
    DRAFT: "Draft", PRECHECK: "Pre-check", READY: "Ready", RUNNING: "Running", VALIDATING: "Validating",
    RECONCILING: "Reconciling", COMPLETED: "Completed", PAUSED: "Paused", BLOCKED: "Blocked",
    HUMAN_REVIEW_REQUIRED: "Human review required", FAILED: "Failed",
  };
  return labels[wave.status] || wave.status;
}

/** Goal status summarises its waves. */
function deriveGoalStatus(goal) {
  const states = goal.waves.map((w) => w.status);
  if (!states.length || states.every((s) => s === "DRAFT")) return "DRAFT";
  if (states.every((s) => s === "COMPLETED")) return "COMPLETED";
  const active = states.find((s) => ACTIVE_STATES.includes(s));
  if (active) return active;
  for (const s of ["FAILED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED"]) if (states.includes(s)) return s;
  if (states.includes("READY")) return "READY";
  if (states.includes("PRECHECK")) return "PRECHECK";
  return "PLANNED";
}

/**
 * Waves the executor should act on now.
 * @returns {Array<{wave_id, action: "precheck"|"start", reason}>}
 */
function dueWaves(goal, now = new Date()) {
  if (!goal.approved_at) return [];
  const due = [];
  for (const w of goal.waves) {
    if (!["PLANNED", "READY"].includes(w.status)) continue;
    let timeReached = false;
    if (w.schedule.type === "immediate") timeReached = true;
    else if (w.schedule.type === "at") timeReached = w.schedule.at && new Date(w.schedule.at) <= now;
    else if (w.schedule.type === "after_dependency") timeReached = true; // gated by dependency + blackout below
    if (!timeReached) continue;
    if (!isDependencySatisfied(goal, w)) continue;
    if (w.window && w.window.end && new Date(w.window.end) < now && w.schedule.type === "at") continue; // window missed
    if (inBlackout(now, goal.blackout_periods, goal.schedule.timezone)) continue;
    due.push({
      wave_id: w.wave_id,
      action: w.status === "READY" ? "start" : "precheck",
      reason: w.status === "READY" ? "Pre-checks passed and the schedule has arrived." : "Schedule reached — run pre-checks first.",
    });
  }
  return due;
}

/**
 * Compare a wave result with success criteria.
 * result: { total, succeeded, critical_errors, required_fields_missing,
 *           reconciled, unresolved_high_severity }
 */
function evaluateSuccessCriteria(criteria, result) {
  const c = { ...DEFAULT_SUCCESS_CRITERIA, ...(criteria || {}) };
  const rate = result.total ? result.succeeded / result.total : 0;
  const failures = [];
  if (c.min_success_rate != null && rate < c.min_success_rate) {
    failures.push("Success rate " + (rate * 100).toFixed(1) + "% is below " + pct(c.min_success_rate));
  }
  if (c.max_critical_errors != null && (result.critical_errors || 0) > c.max_critical_errors) {
    failures.push(result.critical_errors + " critical error(s); allowed " + c.max_critical_errors);
  }
  if (c.required_fields_populated && (result.required_fields_missing || 0) > 0) {
    failures.push(result.required_fields_missing + " record(s) missing required fields");
  }
  if (c.reconciliation_complete && !result.reconciled) failures.push("Source/target reconciliation not complete");
  if (c.no_unresolved_high_severity && (result.unresolved_high_severity || 0) > 0) {
    failures.push(result.unresolved_high_severity + " unresolved high-severity failure(s)");
  }
  return { met: failures.length === 0, success_rate: rate, failures };
}

/**
 * What the executor does after a wave (or remediation attempt) finishes.
 * @returns {{action: string, reason: string}}
 */
function decideNextAction(goal, wave, result, { remediationAttempted = false } = {}) {
  const policy = { ...DEFAULT_FAILURE_POLICY, ...(goal.failure_policy || {}) };
  const criteria = { ...DEFAULT_SUCCESS_CRITERIA, ...(wave.success_criteria || goal.success_criteria || {}) };
  const evaluation = evaluateSuccessCriteria(criteria, result);
  if (criteria.max_critical_errors != null && (result.critical_errors || 0) > criteria.max_critical_errors) {
    return { action: policy.on_critical_failure, reason: "Critical failure: " + evaluation.failures.join("; "), evaluation };
  }
  if (policy.pause_below_success_rate != null && evaluation.success_rate < policy.pause_below_success_rate) {
    return { action: "pause", reason: "Success rate fell below " + pct(policy.pause_below_success_rate), evaluation };
  }
  if (evaluation.met) return { action: policy.on_success, reason: "Success criteria met", evaluation };
  if (!remediationAttempted && goal.options && goal.options.remediation) {
    return { action: policy.on_partial_failure, reason: "Partial failure: " + evaluation.failures.join("; "), evaluation };
  }
  return {
    action: goal.options && goal.options.human_escalation ? policy.on_unresolved : "pause",
    reason: "Unresolved after remediation: " + evaluation.failures.join("; "),
    evaluation,
  };
}

/** What to do when a wave's window has ended but the wave hasn't finished. */
function windowAction(goal, wave, now = new Date(), { criticalIssues = false } = {}) {
  if (!wave.window || !wave.window.end || new Date(wave.window.end) > now) return { action: "none" };
  const policy = (goal.migration_window && goal.migration_window.on_overrun) || "pause";
  if (policy === "continue" && criticalIssues) return { action: "pause", reason: "Window ended with critical issues open" };
  return { action: policy, reason: "Migration window ended at " + wave.window.end };
}

module.exports = {
  WAVE_STATES,
  TRANSITIONS,
  ACTIVE_STATES,
  ATTENTION_STATES,
  RECORD_TYPES,
  SCHEDULE_TYPES,
  OVERRUN_POLICIES,
  ACTIONS,
  DEFAULT_SUCCESS_CRITERIA,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_WINDOW,
  BUSINESS_HOURS_BLACKOUT,
  TransitionError,
  transition,
  waveById,
  isDependencySatisfied,
  dependencyFailed,
  displayStatus,
  deriveGoalStatus,
  dueWaves,
  evaluateSuccessCriteria,
  decideNextAction,
  windowAction,
};
