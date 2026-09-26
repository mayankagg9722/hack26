/* MigrationExecutor — runs an approved migration goal.

   For every source record in a wave:
     read → validate → map fields → classify workspace → transform values →
     write via TargetAdapter → record the outcome (success, or a captured
     failure). Failures are then handled in the REMEDIATING phase: the
     RemediationEngine decides what is safe to fix, the fixed record goes
     through the same pipeline again, and only a successful write counts as
     resolved; everything else goes to human review.

   Execution is incremental and resumable: advance() does one step (a phase
   change, or one batch of records) and persists the run, so it works on
   serverless (each HTTP call does bounded work) and a worker/scheduler can
   drive it the same way the UI does.

   Run phases per wave:
     VALIDATING → MAPPING → MIGRATING → REMEDIATING → VALIDATING_TARGET → RECONCILING
   Run end states: COMPLETED | HUMAN_REVIEW_REQUIRED | BLOCKED | PAUSED | FAILED | STOPPED
   HUMAN_REVIEW_REQUIRED with a review_gate is a pause, not an end: a human
   approves retries / skips records (approveReview, skipReview,
   applyRecommendations) and resume() continues — FINALIZING re-verifies the
   human-approved records and reconciles before COMPLETED.

   Depends only on the adapter contracts plus the mapping, workspace,
   validation and transform modules — nothing Jira- or Freshservice-specific. */

const crypto = require("crypto");
const { applyMapping, departmentSourceField } = require("../mapping/apply");
const { classifyWorkspace } = require("../mapping/workspaces");
const { validateRecord, verifyTargetRecords } = require("./validation");
const { transformRecord } = require("./transform");
const { captureFailure } = require("./failures");
const { RemediationEngine, buildEmployeeIndex, normalizeDepartment, isPlaceholder, MAX_ATTEMPTS } = require("./remediation");
const { runPrechecks } = require("../goals/prechecks");
const { transition, isDependencySatisfied, decideNextAction, deriveGoalStatus, displayStatus } = require("../goals/model");
const { inBlackout } = require("../goals/time");

const RUN_PHASES = ["PLANNED", "VALIDATING", "MAPPING", "MIGRATING", "REMEDIATING", "VALIDATING_TARGET", "RECONCILING"];
const RUN_END_STATES = ["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED", "STOPPED"];
const CLOSED_STATES = ["COMPLETED", "FAILED", "STOPPED"];
const PAGE_SIZE = 100;
const MAX_FAILURES = 2000;
const REMEDIATE_PER_STEP = 30;
const MAX_EVENTS = 200;

class ExecutionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emptyCounts() {
  return { processed: 0, successful: 0, failed: 0, remediated: 0, human_review: 0, human_resolved: 0, skipped: 0 };
}

function migratedOf(c) {
  return c.successful + c.remediated + (c.human_resolved || 0);
}

function addCounts(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
}

class MigrationExecutor {
  /**
   * @param {object} deps
   * @param {object} deps.goalStore
   * @param {object} deps.runStore
   * @param {object} deps.mappingStore
   * @param {(goal) => MigrationEngine} deps.engineFor   builds source + target adapters for a goal
   * @param {object} [deps.logger]
   * @param {() => Function|null} [deps.getAiDepartmentResolver]  async ({values, departments}) => {value: {department, confidence, reason}}
   */
  constructor({ goalStore, runStore, mappingStore, engineFor, logger = console, getAiDepartmentResolver = () => null }) {
    this.getAiDepartmentResolver = getAiDepartmentResolver;
    this.goalStore = goalStore;
    this.runStore = runStore;
    this.mappingStore = mappingStore;
    this.engineFor = engineFor;
    this.logger = logger;
  }

  /* ---------- start ---------- */

  /**
   * Approve (if needed) and start executing a goal now.
   * @param {string} goalId
   * @param {{now?: Date, overrideBlackout?: boolean, by?: string}} [opts]
   */
  async start(goalId, { now = new Date(), overrideBlackout = false, by = "admin" } = {}) {
    const goal = await this.goalStore.get(goalId);
    if (!goal) throw new ExecutionError(404, "Goal not found");
    if (goal.active_run_id) {
      const active = await this.runStore.get(goal.active_run_id);
      if (active && !RUN_END_STATES.includes(active.status)) {
        throw new ExecutionError(409, "A migration is already running for this goal", "ACTIVE_RUN");
      }
    }
    const blackout = inBlackout(now, goal.blackout_periods, goal.schedule.timezone);
    if (blackout && !overrideBlackout) {
      throw new ExecutionError(409, "Now is inside the \"" + (blackout.label || "blackout") + "\" blackout period. Confirm to override it.", "BLACKOUT");
    }

    if (!goal.approved_at) {
      goal.waves.forEach((w) => { if (w.status === "DRAFT") transition(w, "PLANNED", "Approved and run by " + by + ".", now); });
      goal.approved_at = now.toISOString();
    }

    const order = this.executionOrder(goal);
    if (!order.length) throw new ExecutionError(409, "Every wave in this goal has already completed", "NOTHING_TO_RUN");

    const engine = this.engineFor(goal);
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    const expected = await this.expectedCounts(engine, saved);
    // records earlier runs of this goal already wrote — never write them twice
    const previous = this.runStore.list ? await this.runStore.list({ goalId: goal.goal_id }) : [];
    const skipIds = [...new Set(previous.flatMap((r) => r.migrated_ids || []))];

    const runId = "run_" + crypto.randomBytes(5).toString("hex");
    const waves = {};
    for (const id of order) {
      const gw = goal.waves.find((w) => w.wave_id === id);
      const exp = gw.workspace ? (expected.byWorkspace[String(gw.workspace.id)] || 0) : expected.total;
      waves[id] = {
        wave_id: id, name: gw.name, workspace: gw.workspace, phase: "PLANNED", expected: exp,
        counts: emptyCounts(), scanned: 0, cursor: null, page_offset: 0, source_exhausted: false,
        written: [], human_written: [], already_migrated: 0, phase_times: {}, verification: null, reconciliation: null, evaluation: null, decision: null,
        started_at: null, finished_at: null,
      };
    }

    const run = {
      run_id: runId,
      goal_id: goal.goal_id,
      status: "PLANNED",
      trigger: { type: "manual_run_now", by, at: now.toISOString(), override_blackout: Boolean(blackout && overrideBlackout) },
      source: { id: goal.source.id, name: goal.source.name, mode: engine.source.mode },
      target: { id: goal.target.id, name: goal.target.name, mode: engine.target.mode },
      mapping_version: saved ? saved.version : null,
      wave_order: order,
      current_wave_id: order[0],
      waves,
      totals: { ...emptyCounts(), expected: order.reduce((n, id) => n + waves[id].expected, 0) },
      seen_ids: [],
      migrated_ids: [],
      skip_ids: skipIds,
      review_gate: null,
      failures: [],
      failure_seq: 0,
      ai_departments: {},
      ai_error: null,
      remediation: null,
      events: [],
      status_reason: "",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      finished_at: null,
    };
    this.event(run, "info", "Migration started by " + by + " — " + order.length + " wave(s), about " + run.totals.expected.toLocaleString() + " records.");
    if (skipIds.length) this.event(run, "info", skipIds.length + " record(s) were migrated by an earlier run and will be skipped.");
    if (run.trigger.override_blackout) this.event(run, "warn", "Blackout period overridden by " + by + ".");
    this.enterPhase(run, waves[order[0]], "VALIDATING", now);

    goal.active_run_id = runId;
    goal.runs = (goal.runs || []).concat({ run_id: runId, started_at: now.toISOString() });
    await this.saveGoal(goal, now, run);
    await this.runStore.save(run);
    return run;
  }

  /** Waves not yet completed, in dependency order (stable by wave order). */
  executionOrder(goal) {
    const pending = goal.waves.filter((w) => w.status !== "COMPLETED");
    const done = new Set(goal.waves.filter((w) => w.status === "COMPLETED").map((w) => w.wave_id));
    const order = [];
    while (order.length < pending.length) {
      const next = pending.find((w) => !order.includes(w.wave_id)
        && (w.depends_on || []).every((d) => done.has(d.wave_id) || order.includes(d.wave_id)));
      if (!next) break; // unsatisfiable dependency — planner prevents cycles
      order.push(next.wave_id);
    }
    return order;
  }

  async expectedCounts(engine, saved) {
    const fields = saved
      ? saved.fields.filter((f) => f.targetField && f.decision !== "rejected")
      : (await engine.suggestMapping()).rows.filter((r) => r.targetField);
    const summary = await engine.workspaceSummary({ fields, workspaceRules: (saved && saved.workspaceRules) || {} });
    const byWorkspace = {};
    summary.workspaces.forEach((w) => { byWorkspace[String(w.id)] = w.tickets; });
    return { total: summary.totals.tickets, byWorkspace };
  }

  /* ---------- advance ---------- */

  /**
   * Do one unit of work and persist: a phase step, or one batch of records.
   * @param {string} runId
   * @param {{now?: Date, budgetMs?: number, maxRecords?: number}} [opts]
   */
  async advance(runId, { now = new Date(), budgetMs = 1200, maxRecords = 40 } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (RUN_END_STATES.includes(run.status)) return run;

    const goal = await this.goalStore.get(run.goal_id);
    if (!goal) throw new ExecutionError(404, "Goal for this run no longer exists");
    const engine = this.engineFor(goal);
    const wave = run.waves[run.current_wave_id];
    const gw = goal.waves.find((w) => w.wave_id === wave.wave_id);

    try {
      if (run.status === "FINALIZING") {
        await this.phaseFinalize(run, goal, engine, now);
      } else switch (wave.phase) {
        case "VALIDATING": await this.phaseValidate(run, wave, gw, goal, engine, now); break;
        case "MAPPING": await this.phaseMapping(run, wave, gw, goal, engine, now); break;
        case "MIGRATING": await this.phaseMigrate(run, wave, gw, goal, engine, now, { budgetMs, maxRecords }); break;
        case "REMEDIATING": await this.phaseRemediate(run, wave, gw, goal, engine, now); break;
        case "VALIDATING_TARGET": await this.phaseVerify(run, wave, gw, goal, engine, now); break;
        case "RECONCILING": await this.phaseReconcile(run, wave, gw, goal, engine, now); break;
        default: throw new Error("Unexpected phase " + wave.phase);
      }
    } catch (err) {
      this.logger.error && this.logger.error("migration run failed", { runId, error: err.message });
      this.event(run, "error", "Run failed: " + err.message);
      this.finish(run, "FAILED", err.message, now);
      try {
        transition(gw, "FAILED", err.message, now);
      } catch (e) {
        gw.status_reason = err.message; // state machine doesn't allow FAILED from here; keep state, record why
      }
      goal.active_run_id = null;
    }

    await this.persist(run, goal, now);
    return run;
  }

  async persist(run, goal, now) {
    run.totals = Object.values(run.waves).reduce((t, w) => addCounts(t, w.counts), { ...emptyCounts(), expected: 0 });
    run.totals.expected = Object.values(run.waves).reduce((n, w) => n + w.expected, 0);
    run.remediation = this.remediationSummary(run);
    run.updated_at = now.toISOString();
    await this.saveGoal(goal, now, run);
    await this.runStore.save(run);
  }

  /** Stop after the current batch; resume() continues from the same record. */
  async pause(runId, { now = new Date(), by = "admin" } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (RUN_END_STATES.includes(run.status)) throw new ExecutionError(409, "Run is already " + run.status);
    if (run.waves[run.current_wave_id].phase !== "MIGRATING") throw new ExecutionError(409, "A run can be paused while records are being migrated");
    const goal = await this.goalStore.get(run.goal_id);
    const gw = goal.waves.find((w) => w.wave_id === run.current_wave_id);
    if (["RUNNING", "VALIDATING", "RECONCILING"].includes(gw.status)) transition(gw, "PAUSED", "Paused by " + by + ".", now);
    run.paused_phase = run.waves[run.current_wave_id].phase;
    run.paused_at = now.toISOString();
    run.status = "PAUSED";
    run.status_reason = "Paused by " + by + ".";
    this.event(run, "warn", "Paused by " + by + ".");
    await this.persist(run, goal, now);
    return run;
  }

  /** Continue a paused run, or leave the human review gate. */
  async resume(runId, { now = new Date(), by = "admin" } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    const goal = await this.goalStore.get(run.goal_id);
    const gw = goal.waves.find((w) => w.wave_id === run.current_wave_id);

    if (run.status === "HUMAN_REVIEW_REQUIRED" && run.review_gate) {
      this.leaveReviewGate(run, goal, gw, by, now);
      await this.persist(run, goal, now);
      return run;
    }
    if (run.status !== "PAUSED" || !run.paused_phase) throw new ExecutionError(409, "Only a paused run can be resumed");
    const phase = run.paused_phase;
    if (run.paused_at) run.paused_ms = (run.paused_ms || 0) + Math.max(0, now - new Date(run.paused_at));
    run.paused_at = null;
    if (gw.status === "PAUSED") transition(gw, "RUNNING", "Resumed by " + by + ".", now);
    run.status = phase;
    run.paused_phase = null;
    run.status_reason = "";
    this.event(run, "info", "Resumed by " + by + ".");
    await this.persist(run, goal, now);
    return run;
  }

  leaveReviewGate(run, goal, gw, by, now) {
    const gate = run.review_gate;
    run.human_wait_ms = (run.human_wait_ms || 0) + Math.max(0, now - new Date(gate.opened_at));
    const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED");
    run.review_gate = null;
    run.finished_at = null;
    run.status_reason = "";
    if (gate.type === "criteria") {
      // re-verify and re-evaluate the wave with the human decisions included
      const wave = run.waves[gate.wave_id];
      transition(gw, "VALIDATING", "Resumed by " + by + " after human review.", now);
      goal.active_run_id = run.run_id;
      this.event(run, "info", "Resumed by " + by + " — re-checking " + wave.name + " with the human decisions.");
      this.enterPhase(run, wave, "VALIDATING_TARGET", now);
      return;
    }
    for (const f of pending) {
      f.status = "DEFERRED";
      f.review_reason = (f.review_reason || "") + " (deferred by " + by + " when the migration resumed)";
      run.waves[f.wave_id].counts.human_review--;
      run.waves[f.wave_id].counts.deferred = (run.waves[f.wave_id].counts.deferred || 0) + 1;
    }
    goal.active_run_id = run.run_id;
    this.event(run, "info", "Resumed by " + by + (pending.length ? " — " + pending.length + " record(s) left unresolved and deferred." : " — all exceptions handled."));
    run.status = "FINALIZING";
  }

  /** Stop safely: no more records are written; written records stay; a retry can continue later. */
  async stop(runId, { now = new Date(), by = "admin" } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (CLOSED_STATES.includes(run.status)) throw new ExecutionError(409, "Run is already " + run.status.toLowerCase());
    const goal = await this.goalStore.get(run.goal_id);
    const gw = goal.waves.find((w) => w.wave_id === run.current_wave_id);
    if (gw && ["RUNNING", "VALIDATING", "RECONCILING"].includes(gw.status)) transition(gw, "PAUSED", "Migration stopped by " + by + ".", now);
    else if (gw && gw.status === "PRECHECK") transition(gw, "PLANNED", "Migration stopped by " + by + ".", now);
    else if (gw && gw.status === "HUMAN_REVIEW_REQUIRED") transition(gw, "PAUSED", "Migration stopped by " + by + ".", now);
    if (run.review_gate) run.human_wait_ms = (run.human_wait_ms || 0) + Math.max(0, now - new Date(run.review_gate.opened_at));
    for (const f of run.failures.filter((x) => x.status === "HUMAN_REVIEW_REQUIRED")) {
      f.status = "DEFERRED";
      f.review_reason = (f.review_reason || "") + " (not migrated — the migration was stopped by " + by + ")";
      run.waves[f.wave_id].counts.human_review--;
      run.waves[f.wave_id].counts.deferred = (run.waves[f.wave_id].counts.deferred || 0) + 1;
    }
    run.review_gate = null;
    run.paused_phase = null;
    this.event(run, "warn", "Stopped by " + by + ". " + run.migrated_ids.length + " record(s) already written stay in " + run.target.name + "; nothing else will be written.");
    this.finish(run, "STOPPED", "Stopped by " + by + ".", now);
    goal.active_run_id = null;
    await this.persist(run, goal, now);
    return run;
  }

  /** Start a fresh run for the same goal after a stop or failure; records already migrated are skipped. */
  async retry(runId, { now = new Date(), by = "admin", overrideBlackout } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (!["STOPPED", "FAILED", "BLOCKED", "PAUSED", "HUMAN_REVIEW_REQUIRED"].includes(run.status) || run.review_gate) {
      throw new ExecutionError(409, run.review_gate ? "This run is waiting for review — resume it instead" : "Only a stopped or failed run can be retried");
    }
    if (!CLOSED_STATES.includes(run.status)) await this.stop(runId, { now, by });
    return this.start(run.goal_id, { now, by, overrideBlackout: overrideBlackout != null ? overrideBlackout : run.trigger.override_blackout });
  }

  /* ---------- human decisions ---------- */

  async loadForReview(runId, failureId) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (CLOSED_STATES.includes(run.status)) throw new ExecutionError(409, "This run is " + run.status.toLowerCase() + " — start a new run instead");
    const f = run.failures.find((x) => x.failure_id === failureId);
    if (!f) throw new ExecutionError(404, "Review item not found");
    if (f.status !== "HUMAN_REVIEW_REQUIRED") throw new ExecutionError(409, "This record is already " + f.status.replace(/_/g, " ").toLowerCase());
    const goal = await this.goalStore.get(run.goal_id);
    return { run, goal, f };
  }

  /**
   * Human approves a retry: Zen applies its recommendation (with any values
   * the human edited), re-processes the record and writes it.
   * @param {{values?: Object<string,string>, by?: string, now?: Date}} opts  values keyed by source field
   */
  async approveReview(runId, failureId, { values = {}, by = "admin", now = new Date() } = {}) {
    const { run, goal, f } = await this.loadForReview(runId, failureId);
    const result = await this.applyApproval(run, goal, f, values, by, now);
    await this.afterDecision(run, goal, by, now);
    await this.persist(run, goal, now);
    if (!result.ok) throw new ExecutionError(422, result.message);
    return run;
  }

  async skipReview(runId, failureId, { by = "admin", now = new Date(), reason = "" } = {}) {
    const { run, goal, f } = await this.loadForReview(runId, failureId);
    this.applySkip(run, f, by, now, reason);
    await this.afterDecision(run, goal, by, now);
    await this.persist(run, goal, now);
    return run;
  }

  /** Apply Zen's recommendation to every pending item (optionally one group) that needs no typed input. */
  async applyRecommendations(runId, { by = "admin", now = new Date(), group = null } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (CLOSED_STATES.includes(run.status)) throw new ExecutionError(409, "This run is " + run.status.toLowerCase());
    const goal = await this.goalStore.get(run.goal_id);
    const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED" && (!group || (f.recommendation && f.recommendation.group === group)));
    const outcome = { approved: 0, skipped: 0, needs_input: 0, failed: [] };
    for (const f of pending) {
      const rec = f.recommendation || {};
      if (rec.needs_input) { outcome.needs_input++; continue; }
      if (rec.action === "skip") { this.applySkip(run, f, by, now, "Zen's recommendation"); outcome.skipped++; continue; }
      const r = await this.applyApproval(run, goal, f, {}, by, now);
      if (r.ok) outcome.approved++;
      else outcome.failed.push({ failure_id: f.failure_id, record_id: f.record_id, message: r.message });
    }
    this.event(run, "info", by + " applied Zen's recommendations: " + outcome.approved + " retried successfully, " + outcome.skipped + " skipped" +
      (outcome.failed.length ? ", " + outcome.failed.length + " still failing" : "") + (outcome.needs_input ? ", " + outcome.needs_input + " need typed input" : "") + ".");
    await this.afterDecision(run, goal, by, now);
    await this.persist(run, goal, now);
    return { run, outcome };
  }

  async applyApproval(run, goal, f, values, by, now) {
    const engine = this.engineFor(goal);
    const wave = run.waves[f.wave_id];
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    const fields = saved.fields.filter((x) => x.targetField && x.decision !== "rejected");
    const [targetSchema, workspaces] = await Promise.all([engine.target.getSchema(), engine.target.getWorkspaces()]);
    const classify = this.classifier(workspaces, saved.workspaceRules || {});
    const deptField = departmentSourceField(fields);
    const seenIds = new Set(run.seen_ids);
    const rec = f.recommendation || { action: "retry", changes: [] };
    let payload;
    const decision = { action: "approved_retry", by, at: now.toISOString(), values: {} };

    if (rec.action === "retry" && f.target_payload) {
      payload = f.target_payload;
    } else {
      const record = { ...f.source };
      for (const c of (f.remediation && f.remediation.changes) || []) if (c.field) record[c.field] = c.to; // keep Zen's partial fixes
      for (const c of rec.changes || []) {
        const v = values[c.field] != null ? String(values[c.field]).trim() : c.value;
        if (v === "" || v == null) return { ok: false, message: "Enter a value for " + c.label + " before approving." };
        record[c.field] = v;
        decision.values[c.field] = v;
      }
      const ws = classify(deptField ? record[deptField] : "");
      const prep = this.prepare(record, ws, { fields, targetSchema, seenIds });
      if (prep.state !== "ready") {
        const msg = "Still invalid after the approved changes: " + prep.issues.map((i) => i.message).join("; ");
        f.review_reason = msg;
        (f.attempts = f.attempts || []).push({ step: "Human-approved retry", result: msg, ok: false, by, at: now.toISOString() });
        return { ok: false, message: msg };
      }
      payload = prep.payload;
      run.seen_ids = [...seenIds];
    }

    const first = Math.max(1, (f.retry_count || 0) + (f.target_payload ? 2 : 1));
    let result;
    let attempt = first;
    for (; attempt < first + MAX_ATTEMPTS; attempt++) {
      [result] = await engine.target.writeRecords([payload], { runId: run.run_id, attempt });
      f.retry_count++;
      (f.attempts = f.attempts || []).push({ step: "Human-approved retry", result: result.ok ? "Written as #" + result.id : result.error.code + " " + result.error.message, ok: result.ok, by, at: now.toISOString() });
      if (result.ok || !(result.error && result.error.retryable)) break;
    }
    if (!result.ok) {
      f.target_payload = payload;
      f.review_reason = "Retry approved by " + by + " but the target still returned " + result.error.code + ": " + result.error.message;
      return { ok: false, message: f.review_reason };
    }
    f.status = "RESOLVED";
    f.resolved_by = "human";
    f.decision = decision;
    f.resolved_at = now.toISOString();
    f.outcome = { target_id: result.id, workspace_id: payload.workspace_id };
    wave.counts.human_review--;
    wave.counts.human_resolved++;
    wave.written.push({ id: result.id, workspace_id: payload.workspace_id });
    wave.human_written.push(result.id);
    const legacy = payload.custom_fields && payload.custom_fields.legacy_ticket_id;
    if (legacy) run.migrated_ids.push(String(legacy));
    this.event(run, "success", by + " approved a retry for " + (f.record_id || f.failure_id) + " — migrated as #" + result.id + ".");
    return { ok: true };
  }

  applySkip(run, f, by, now, reason) {
    f.status = "SKIPPED";
    f.resolved_by = "human";
    f.decision = { action: "skipped", by, at: now.toISOString(), reason };
    f.resolved_at = now.toISOString();
    run.waves[f.wave_id].counts.human_review--;
    run.waves[f.wave_id].counts.skipped++;
    this.event(run, "info", by + " skipped " + (f.record_id || f.failure_id) + (reason ? " (" + reason + ")" : "") + ".");
  }

  /** When the last pending item is decided at the review gate, Zen continues on its own. */
  async afterDecision(run, goal, by, now) {
    const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED").length;
    if (pending === 0 && run.status === "HUMAN_REVIEW_REQUIRED" && run.review_gate) {
      const gw = goal.waves.find((w) => w.wave_id === run.current_wave_id);
      this.event(run, "info", "All exceptions decided — Zen is resuming the migration.");
      this.leaveReviewGate(run, goal, gw, by, now);
    }
  }

  /* ---------- finalize after human review ---------- */

  async phaseFinalize(run, goal, engine, now) {
    const targetSchema = await engine.target.getSchema();
    for (const id of run.wave_order) {
      const wave = run.waves[id];
      if (!["COMPLETED"].includes(wave.phase)) continue;
      const records = await engine.target.readRecords(wave.written.map((w) => w.id));
      const expected = Object.fromEntries(wave.written.map((w) => [String(w.id), w.workspace_id]));
      const v = verifyTargetRecords(records, targetSchema, expected);
      wave.verification = { ...wave.verification, checked: v.checked, missing: wave.written.length - records.length, problems: v.problems.length, examples: v.problems.slice(0, 5) };
      this.reconcileCounts(wave);
      const gw = goal.waves.find((w) => w.wave_id === id);
      const evaluation = this.evaluate(goal, gw, wave);
      wave.evaluation = evaluation;
      if (gw.result) Object.assign(gw.result, { success_rate: evaluation.success_rate, success_criteria_met: evaluation.met, counts: { ...wave.counts }, reconciliation: wave.reconciliation });
    }
    const human = run.failures.filter((f) => f.resolved_by === "human" && f.status === "RESOLVED").length;
    const skipped = run.failures.filter((f) => f.status === "SKIPPED").length;
    const deferred = run.failures.filter((f) => f.status === "DEFERRED").length;
    this.event(run, "info", "Verified and reconciled " + human + " human-approved record(s) in " + goal.target.name + ".");
    this.finish(run, "COMPLETED", "All waves migrated and reconciled" + (human || skipped || deferred ? " — " + [human && human + " resolved by a human", skipped && skipped + " skipped", deferred && deferred + " deferred"].filter(Boolean).join(", ") : "") + ".", now);
    goal.active_run_id = null;
  }

  reconcileCounts(wave) {
    const c = wave.counts;
    const migrated = migratedOf(c);
    const counted = wave.verification ? wave.verification.checked : migrated;
    const unaccounted = c.processed - migrated - c.human_review - c.skipped - (c.deferred || 0);
    wave.reconciliation = {
      source_in_scope: c.processed, expected: wave.expected, migrated, in_review: c.human_review, skipped: c.skipped, deferred: c.deferred || 0,
      already_migrated: wave.already_migrated || 0, target_count: counted, unaccounted,
      match: counted === migrated && unaccounted === 0 && (!wave.verification || wave.verification.missing === 0),
    };
  }

  evaluate(goal, gw, wave) {
    const c = wave.counts;
    return decideNextAction(goal, gw, {
      total: c.processed - c.skipped, succeeded: migratedOf(c),
      critical_errors: wave.verification.problems + wave.verification.missing,
      required_fields_missing: wave.verification.problems, reconciled: wave.reconciliation.match,
      unresolved_high_severity: wave.verification.problems,
    }, { remediationAttempted: true }).evaluation;
  }

  /* ---------- phases ---------- */

  async phaseValidate(run, wave, gw, goal, engine, now) {
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    if (gw.status === "FAILED") transition(gw, "PLANNED", "Re-running after a failed attempt.", now);
    if (gw.status !== "PRECHECK") transition(gw, "PRECHECK", "Running pre-migration checks.", now);
    const minutes = goal.migration_window.duration_minutes;
    const pre = await runPrechecks({
      goal, wave: gw, engine, savedMapping: saved, now,
      runNow: { start: now, end: new Date(now.getTime() + minutes * 60000), overrideBlackout: run.trigger.override_blackout },
    });

    // source schema still has every mapped field?
    if (saved) {
      const rawKeys = new Set((await engine.source.getRawSchema()).map((f) => f.key));
      const missing = saved.fields.filter((f) => f.targetField && f.decision !== "rejected" && !rawKeys.has(f.sourceField));
      pre.results.push({
        id: "source_schema", label: "Source fields still match the mapping", critical: true,
        status: missing.length ? "fail" : "pass",
        detail: missing.length ? "Missing in source: " + missing.map((f) => f.sourceField).join(", ") : "All mapped source fields are present.",
      });
      if (missing.length && pre.outcome === "READY") {
        pre.outcome = "HUMAN_REVIEW_REQUIRED";
        pre.reason = "The source schema changed since the mapping was approved.";
      }
    }
    gw.prechecks = pre;
    transition(gw, pre.outcome, pre.reason, now);

    if (pre.outcome !== "READY") {
      this.event(run, "error", wave.name + ": pre-migration checks failed — " + pre.reason);
      this.finish(run, pre.outcome === "BLOCKED" ? "BLOCKED" : "HUMAN_REVIEW_REQUIRED", pre.reason, now);
      goal.active_run_id = null;
      return;
    }
    run.mapping_version = saved.version;
    this.event(run, "info", wave.name + ": all " + pre.results.length + " pre-migration checks passed.");
    this.enterPhase(run, wave, "MAPPING", now);
  }

  async phaseMapping(run, wave, gw, goal, engine, now) {
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    const fields = saved.fields.filter((f) => f.targetField && f.decision !== "rejected");
    wave.mapping = {
      version: saved.version,
      fields: fields.length,
      department_field: departmentSourceField(fields),
      workspace_overrides: Object.keys(saved.workspaceRules || {}).length,
    };
    transition(gw, "RUNNING", "Migrating records.", now);
    wave.started_at = now.toISOString();
    this.event(run, "info", wave.name + ": loaded mapping v" + saved.version + " (" + fields.length + " fields) — migrating " +
      wave.expected.toLocaleString() + " records to " + (wave.workspace ? wave.workspace.name : "all workspaces") + ".");
    this.enterPhase(run, wave, "MIGRATING", now);
  }

  async phaseMigrate(run, wave, gw, goal, engine, now, { budgetMs, maxRecords }) {
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    const fields = saved.fields.filter((f) => f.targetField && f.decision !== "rejected");
    const [targetSchema, workspaces] = await Promise.all([engine.target.getSchema(), engine.target.getWorkspaces()]);
    const overrides = saved.workspaceRules || {};
    const deptField = departmentSourceField(fields);
    const seenIds = new Set(run.seen_ids);
    const classify = this.classifier(workspaces, overrides);
    const ctx = { fields, targetSchema, seenIds };
    const skipSet = new Set(run.skip_ids || []);
    const started = Date.now();
    let processed = 0;

    while (!wave.source_exhausted && processed < maxRecords && Date.now() - started < budgetMs) {
      // 1. read: collect this wave's records from the source
      const batch = [];
      while (!wave.source_exhausted && batch.length < maxRecords - processed) {
        const page = await engine.source.fetchRawRecords({ cursor: wave.cursor, limit: PAGE_SIZE });
        let i = wave.page_offset;
        for (; i < page.records.length && batch.length < maxRecords - processed; i++) {
          const raw = page.records[i];
          wave.scanned++;
          const ws = classify(deptField ? raw[deptField] : "");
          if (wave.workspace && String(ws.workspaceId) !== String(wave.workspace.id)) continue;
          const ref = this.recordRef(raw, fields);
          if (ref && skipSet.has(ref)) { wave.already_migrated++; wave.expected--; continue; }
          batch.push({ raw, ws, ref });
        }
        if (i >= page.records.length) {
          wave.cursor = page.nextCursor;
          wave.page_offset = 0;
          if (!page.nextCursor) wave.source_exhausted = true;
        } else {
          wave.page_offset = i;
        }
      }
      if (!batch.length) break;

      // 2–5. validate → map → classify → transform
      for (const item of batch) Object.assign(item, this.prepare(item.raw, item.ws, ctx));

      // 6. write (first attempt — failures are remediated in the next phase)
      const ready = batch.filter((b) => b.state === "ready");
      if (ready.length) {
        const first = await engine.target.writeRecords(ready.map((b) => b.payload), { runId: run.run_id, attempt: 1 });
        ready.forEach((b, i) => { b.write = first[i]; });
      }

      // 7. record results
      for (const b of batch) this.record(run, wave, b, ctx);
      processed += batch.length;
    }

    run.seen_ids = [...seenIds];
    if (wave.source_exhausted) {
      const c = wave.counts;
      this.event(run, c.failed ? "warn" : "info", wave.name + ": processed " + c.processed.toLocaleString() + " records — " + c.successful + " successful, " +
        c.failed + " failed.");
      const open = run.failures.filter((f) => f.wave_id === wave.wave_id && f.status === "OPEN");
      if (open.length && goal.options.remediation !== false) {
        this.event(run, "info", wave.name + ": analysing " + open.length + " failure(s) for safe remediation.");
        this.enterPhase(run, wave, "REMEDIATING", now);
      } else {
        for (const f of open) this.toReview(run, wave, f, "Remediation is turned off for this goal.", now);
        this.toVerification(run, wave, gw, goal, now);
      }
    }
  }

  toVerification(run, wave, gw, goal, now) {
    transition(gw, "VALIDATING", "Verifying records in " + goal.target.name + ".", now);
    this.enterPhase(run, wave, "VALIDATING_TARGET", now);
  }

  classifier(workspaces, overrides) {
    const cache = new Map();
    return (dept) => {
      const key = String(dept == null ? "" : dept);
      if (!cache.has(key)) cache.set(key, classifyWorkspace(key, workspaces, overrides));
      return cache.get(key);
    };
  }

  /* ---------- remediation ---------- */

  async phaseRemediate(run, wave, gw, goal, engine, now) {
    const saved = await this.mappingStore.get(goal.source.id, goal.target.id);
    const fields = saved.fields.filter((f) => f.targetField && f.decision !== "rejected");
    const [targetSchema, workspaces] = await Promise.all([engine.target.getSchema(), engine.target.getWorkspaces()]);
    const classify = this.classifier(workspaces, saved.workspaceRules || {});
    const deptField = departmentSourceField(fields);
    const seenIds = new Set(run.seen_ids);
    const ctx = { fields, targetSchema, seenIds };
    const open = run.failures.filter((f) => f.wave_id === wave.wave_id && f.status === "OPEN");

    // lookups for inference: every source record
    const all = [];
    let cursor = null;
    do {
      const page = await engine.source.fetchRawRecords({ cursor, limit: PAGE_SIZE });
      all.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor && all.length < 20000);
    const employeeIndex = buildEmployeeIndex(all, fields);

    // one Claude call per wave for department values the rules can't place
    const departments = (targetSchema.find((f) => f.key === "department") || {}).values || [];
    const resolver = this.getAiDepartmentResolver();
    const unknown = [...new Set(open.filter((f) => f.category === "invalid_department")
      .flatMap((f) => f.issues.filter((i) => i.targetField === "department").map((i) => f.source[i.field])))]
      .filter((v) => !normalizeDepartment(v, departments) && !isPlaceholder(v) && !run.ai_departments[v]);
    if (unknown.length && resolver) {
      try {
        const answers = await resolver({ values: unknown, departments });
        Object.assign(run.ai_departments, answers);
        this.event(run, "info", "Claude reviewed " + unknown.length + " unrecognised department value(s).");
      } catch (err) {
        run.ai_error = err.message;
        this.event(run, "warn", "AI remediation unavailable (" + err.message + ") — those records go to human review.");
      }
    }
    // "previous migration mapping": requesters already in the target
    const emailField = (fields.find((x) => x.targetField === "email") || {}).sourceField;
    const previousRequesters = {};
    for (const f of open.filter((x) => x.category === "missing_employee_id")) {
      const email = String(f.source[emailField] || "").trim().toLowerCase();
      if (email && !(email in previousRequesters)) previousRequesters[email] = await engine.target.findRequesterByEmail(email);
    }
    const remediator = new RemediationEngine({
      fields, targetSchema, employeeIndex, previousRequesters, aiDepartments: run.ai_departments, aiAvailable: Boolean(resolver) && !run.ai_error,
    });

    const batch = open.slice(0, REMEDIATE_PER_STEP);
    for (const f of batch) {
      const plan = remediator.analyze(f);
      f.attempts = plan.attempts || [];
      f.fixable = plan.fixable;
      f.recommended_action = plan.recommended_action;
      f.status = "REMEDIATING";
      if (!plan.fixable) {
        f.remediation = { strategies: [], method: null, changes: [], explanation: plan.reason, attempted_at: now.toISOString() };
        this.toReview(run, wave, f, plan.reason, now);
        continue;
      }

      if (plan.steps[0].strategy === "retry_api") {
        await this.retryWrite(run, wave, f, f.target_payload, engine, now, { strategies: ["retry_api"], method: "retry", changes: [] });
        continue;
      }

      // fix → re-run the full pipeline → write
      const { record, changes, method } = remediator.apply(f, plan);
      const ws = classify(deptField ? record[deptField] : "");
      const again = this.prepare(record, ws, ctx);
      const remediation = { strategies: plan.steps.map((s) => s.strategy), method, changes, attempted_at: now.toISOString() };
      if (again.state !== "ready") {
        f.remediation = { ...remediation, explanation: "Fix applied but the record is still invalid: " + again.issues.map((i) => i.message).join("; ") };
        this.toReview(run, wave, f, f.remediation.explanation, now);
        continue;
      }
      if (wave.workspace && ws.workspaceId != null && String(ws.workspaceId) !== String(wave.workspace.id)) {
        remediation.rerouted_to = ws.workspaceName;
      }
      await this.retryWrite(run, wave, f, again.payload, engine, now, remediation);
    }
    run.seen_ids = [...seenIds];
    for (const f of batch) {
      if (f.status === "HUMAN_REVIEW_REQUIRED" && !f.recommendation) f.recommendation = remediator.recommend(f);
    }

    if (!run.failures.some((f) => f.wave_id === wave.wave_id && f.status === "OPEN")) {
      const mine = run.failures.filter((f) => f.wave_id === wave.wave_id);
      const resolved = mine.filter((f) => f.status === "RESOLVED").length;
      this.event(run, "success", wave.name + ": " + mine.length + " failure(s) analysed — " + resolved + " automatically resolved, " +
        (mine.length - resolved) + " need human review.");
      this.toVerification(run, wave, gw, goal, now);
    }
  }

  /** Write a (fixed) payload, retrying transient errors up to MAX_ATTEMPTS; record the real outcome. */
  async retryWrite(run, wave, f, payload, engine, now, remediation) {
    let attempt = f.category === "api_failure" ? 2 : 1;
    let result = null;
    for (; attempt <= MAX_ATTEMPTS; attempt++) {
      [result] = await engine.target.writeRecords([payload], { runId: run.run_id, attempt });
      if (f.category === "api_failure" || attempt > 1) {
        f.retry_count++;
        (f.attempts = f.attempts || []).push({ step: "Automatic retry", result: "Attempt " + attempt + ": " + (result.ok ? "written" : result.error.code + " " + result.error.message), ok: result.ok });
      }
      if (result.ok || !(result.error && result.error.retryable)) break;
    }
    if (result.ok) {
      const detail = f.category === "api_failure" ? "Succeeded on attempt " + Math.min(attempt, MAX_ATTEMPTS) + " after " + f.write_error.code : null;
      f.remediation = { ...remediation, explanation: detail || "Fixed and re-processed successfully." };
      f.status = "RESOLVED";
      f.resolved_at = now.toISOString();
      f.outcome = { target_id: result.id, workspace_id: payload.workspace_id };
      wave.written.push({ id: result.id, workspace_id: payload.workspace_id });
      const legacy = payload.custom_fields && payload.custom_fields.legacy_ticket_id;
      if (legacy) run.migrated_ids.push(String(legacy));
      wave.counts.remediated++;
      return;
    }
    f.outcome = { error: result.error };
    f.target_payload = payload; // the fixed payload — a human-approved retry resends it
    f.remediation = { ...remediation, explanation: (result.error.retryable ? "Still failing after " + MAX_ATTEMPTS + " attempts: " : "Target rejected the fixed record: ") + result.error.code + " " + result.error.message };
    this.toReview(run, wave, f, f.remediation.explanation, now);
  }

  toReview(run, wave, f, reason, now) {
    f.status = "HUMAN_REVIEW_REQUIRED";
    f.recommended_action = f.recommended_action || "Human review";
    f.review_reason = reason;
    f.resolved_at = now.toISOString();
    wave.counts.human_review++;
  }

  remediationSummary(run) {
    const by = {};
    let detected = 0;
    let resolved = 0;
    let review = 0;
    for (const f of run.failures) {
      detected++;
      const c = (by[f.category] = by[f.category] || { label: f.category_label, detected: 0, resolved: 0, human_review: 0, pending: 0 });
      c.detected++;
      if (f.status === "RESOLVED" && f.resolved_by !== "human") { c.resolved++; resolved++; } else if (f.status === "OPEN" || f.status === "REMEDIATING") c.pending++; else { c.human_review++; review++; }
    }
    const ai = run.failures.filter((f) => f.status === "RESOLVED" && f.resolved_by !== "human" && f.remediation && f.remediation.method === "ai").length;
    const count = (st, byHuman) => run.failures.filter((f) => f.status === st && (byHuman == null || (f.resolved_by === "human") === byHuman)).length;
    return {
      detected, resolved, human_review: review, pending: detected - resolved - review, ai_resolved: ai, ai_error: run.ai_error, by_category: by,
      // human_review = everything escalated; of those:
      awaiting_human: count("HUMAN_REVIEW_REQUIRED"), human_resolved: count("RESOLVED", true), skipped: count("SKIPPED"), deferred: count("DEFERRED"),
    };
  }

  /** Validate, map, classify and transform one source record. */
  prepare(raw, ws, ctx) {
    const errors = validateRecord(raw, ctx).filter((i) => i.severity === "error");
    if (errors.length) return { state: "failed", issues: errors };
    const { target } = applyMapping(raw, ctx.fields, ctx.targetSchema);
    const { payload, notes, unmapped } = transformRecord(target, ctx.targetSchema);
    if (unmapped.length) {
      return { state: "failed", issues: unmapped.map((k) => ({ targetField: k, code: "unrecognized_value", severity: "error", message: "No target value for " + k })) };
    }
    if (typeof payload.subject === "string" && payload.subject.length > 255) payload.subject = payload.subject.slice(0, 252) + "…";
    if (ws.workspaceId != null) payload.workspace_id = ws.workspaceId;
    const legacyId = payload.custom_fields && payload.custom_fields.legacy_ticket_id;
    if (legacyId) ctx.seenIds.add(String(legacyId));
    return { state: "ready", payload, notes };
  }

  record(run, wave, b, ctx) {
    const c = wave.counts;
    c.processed++;
    if (b.state === "ready" && b.write && b.write.ok) {
      wave.written.push({ id: b.write.id, workspace_id: b.payload.workspace_id });
      if (b.ref) run.migrated_ids.push(b.ref);
      c.successful++;
      return;
    }
    c.failed++;
    if (run.failures.length >= MAX_FAILURES) {
      c.human_review++; // beyond the capture limit: count, but don't keep detail
      return;
    }
    run.failures.push(captureFailure({
      raw: b.raw, recordId: b.ref, waveId: wave.wave_id, ctx, seq: ++run.failure_seq,
      issues: b.state === "failed" ? b.issues : [],
      writeError: b.state === "ready" ? (b.write && b.write.error) || { code: "unknown", message: "No response", retryable: true } : null,
      payload: b.state === "ready" ? b.payload : null,
    }));
  }

  recordRef(raw, fields) {
    const idField = fields.find((f) => f.targetField === "custom_fields.legacy_ticket_id");
    return idField ? String(raw[idField.sourceField]) : null;
  }

  async phaseVerify(run, wave, gw, goal, engine, now) {
    const targetSchema = await engine.target.getSchema();
    const written = engine.target.mode === "live" ? wave.written.slice(0, 100) : wave.written;
    const records = await engine.target.readRecords(written.map((w) => w.id));
    const expected = Object.fromEntries(written.map((w) => [String(w.id), w.workspace_id]));
    const v = verifyTargetRecords(records, targetSchema, expected);
    const sample = written;
    const ids = wave.written;
    wave.verification = {
      checked: v.checked,
      sampled: sample.length < ids.length,
      missing: sample.length - records.length,
      problems: v.problems.length,
      examples: v.problems.slice(0, 5),
    };
    this.event(run, v.problems.length || wave.verification.missing ? "warn" : "info",
      wave.name + ": verified " + v.checked.toLocaleString() + " records in " + goal.target.name +
      (v.problems.length || wave.verification.missing ? " — " + (v.problems.length + wave.verification.missing) + " problem(s)." : " — all present and complete."));
    transition(gw, "RECONCILING", "Reconciling source and target counts.", now);
    this.enterPhase(run, wave, "RECONCILING", now);
  }

  async phaseReconcile(run, wave, gw, goal, engine, now) {
    const c = wave.counts;
    this.reconcileCounts(wave);
    const migrated = migratedOf(c);

    const result = {
      total: c.processed - c.skipped,
      succeeded: migrated,
      critical_errors: wave.verification.problems + wave.verification.missing,
      required_fields_missing: wave.verification.problems,
      reconciled: wave.reconciliation.match,
      unresolved_high_severity: wave.verification.problems,
    };
    const decision = decideNextAction(goal, gw, result, { remediationAttempted: true });
    wave.evaluation = decision.evaluation;
    wave.decision = { action: decision.action, reason: decision.reason };
    gw.result = {
      run_id: run.run_id,
      success_criteria_met: decision.evaluation.met,
      success_rate: decision.evaluation.success_rate,
      counts: { ...c },
      reconciliation: wave.reconciliation,
      finished_at: now.toISOString(),
    };
    wave.finished_at = now.toISOString();
    const pct = (decision.evaluation.success_rate * 100).toFixed(1) + "%";

    if (decision.evaluation.met && decision.action === "continue") {
      transition(gw, "COMPLETED", "Migrated " + migrated + " of " + c.processed + " (" + pct + "); " + c.human_review + " in human review.", now);
      this.event(run, "success", wave.name + " completed: " + pct + " success, reconciliation " + (wave.reconciliation.match ? "matched" : "has gaps") + ".");
      wave.phase = "COMPLETED";
      const nextId = run.wave_order.find((id) => {
        const w = goal.waves.find((x) => x.wave_id === id);
        return run.waves[id].phase === "PLANNED" && w && isDependencySatisfied(goal, w);
      });
      if (nextId) {
        run.current_wave_id = nextId;
        this.event(run, "info", "Success criteria met — continuing to " + run.waves[nextId].name + ".");
        this.enterPhase(run, run.waves[nextId], "VALIDATING", now);
        return;
      }
      const pending = run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED").length;
      if (pending) {
        // AI handled the routine work; the exceptions need a person before Zen can finish
        run.review_gate = { type: "final", opened_at: now.toISOString() };
        run.status = "HUMAN_REVIEW_REQUIRED";
        run.status_reason = pending + " record(s) need a human decision before Zen can finish.";
        this.event(run, "warn", "Migration paused — " + pending + " exception(s) need a human decision. Everything else is migrated.");
      } else {
        this.finish(run, "COMPLETED", "All waves migrated and reconciled.", now);
        goal.active_run_id = null;
      }
      return;
    }

    const endState = { pause: "PAUSED", stop: "FAILED" }[decision.action] || "HUMAN_REVIEW_REQUIRED";
    const waveState = endState === "FAILED" ? "FAILED" : endState;
    transition(gw, waveState, decision.reason, now);
    wave.phase = waveState;
    this.event(run, "error", wave.name + ": " + decision.reason + " → " + endState.replace(/_/g, " ").toLowerCase() + ". Later waves stay paused.");
    if (endState === "HUMAN_REVIEW_REQUIRED") {
      // resumable: a human can approve retries / skip records, then resume to re-check this wave
      run.review_gate = { type: "criteria", wave_id: wave.wave_id, opened_at: now.toISOString() };
      run.status = "HUMAN_REVIEW_REQUIRED";
      run.status_reason = decision.reason;
      return;
    }
    this.finish(run, endState, decision.reason, now);
    goal.active_run_id = null;
  }

  /* ---------- helpers ---------- */

  enterPhase(run, wave, phase, now) {
    wave.phase = phase;
    wave.phase_times[phase] = now.toISOString();
    run.status = phase;
  }

  finish(run, status, reason, now) {
    run.status = status;
    run.status_reason = reason;
    run.finished_at = now.toISOString();
    this.event(run, status === "COMPLETED" ? "success" : "warn", "Migration " + status.replace(/_/g, " ").toLowerCase() + ": " + reason);
  }

  event(run, level, message) {
    run.events.push({ at: new Date().toISOString(), level, message });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  async saveGoal(goal, now, run = null) {
    if (run) goal.pending_review_count = run.review_gate ? run.failures.filter((f) => f.status === "HUMAN_REVIEW_REQUIRED").length : 0;
    goal.waves.forEach((w) => { w.display_status = displayStatus(goal, w); });
    goal.status = deriveGoalStatus(goal);
    goal.updated_at = now.toISOString();
    await this.goalStore.save(goal);
  }
}

module.exports = { MigrationExecutor, ExecutionError, RUN_PHASES, RUN_END_STATES };
