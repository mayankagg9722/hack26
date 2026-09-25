/* MigrationExecutor — runs an approved migration goal.

   For every source record in a wave:
     read → validate → (basic auto-fix) → map fields → classify workspace →
     transform values → write via TargetAdapter → record the outcome.

   Execution is incremental and resumable: advance() does one step (a phase
   change, or one batch of records) and persists the run, so it works on
   serverless (each HTTP call does bounded work) and a worker/scheduler can
   drive it the same way the UI does.

   Run phases per wave:
     VALIDATING → MAPPING → MIGRATING → VALIDATING_TARGET → RECONCILING
   Run end states: COMPLETED | HUMAN_REVIEW_REQUIRED | BLOCKED | PAUSED | FAILED

   Depends only on the adapter contracts plus the mapping, workspace,
   validation and transform modules — nothing Jira- or Freshservice-specific. */

const crypto = require("crypto");
const { applyMapping, departmentSourceField } = require("../mapping/apply");
const { classifyWorkspace } = require("../mapping/workspaces");
const { validateRecord, verifyTargetRecords } = require("./validation");
const { applyBasicFixes } = require("./fixes");
const { transformRecord } = require("./transform");
const { runPrechecks } = require("../goals/prechecks");
const { transition, isDependencySatisfied, decideNextAction, deriveGoalStatus, displayStatus } = require("../goals/model");
const { inBlackout } = require("../goals/time");

const RUN_PHASES = ["PLANNED", "VALIDATING", "MAPPING", "MIGRATING", "VALIDATING_TARGET", "RECONCILING"];
const RUN_END_STATES = ["COMPLETED", "HUMAN_REVIEW_REQUIRED", "BLOCKED", "PAUSED", "FAILED"];
const PAGE_SIZE = 100;
const MAX_QUEUE = 500;
const MAX_EVENTS = 200;

class ExecutionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emptyCounts() {
  return { processed: 0, successful: 0, failed: 0, remediated: 0, human_review: 0 };
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
   */
  constructor({ goalStore, runStore, mappingStore, engineFor, logger = console }) {
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

    const runId = "run_" + crypto.randomBytes(5).toString("hex");
    const waves = {};
    for (const id of order) {
      const gw = goal.waves.find((w) => w.wave_id === id);
      const exp = gw.workspace ? (expected.byWorkspace[String(gw.workspace.id)] || 0) : expected.total;
      waves[id] = {
        wave_id: id, name: gw.name, workspace: gw.workspace, phase: "PLANNED", expected: exp,
        counts: emptyCounts(), scanned: 0, cursor: null, page_offset: 0, source_exhausted: false,
        written_ids: [], phase_times: {}, verification: null, reconciliation: null, evaluation: null, decision: null,
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
      review_queue: [],
      remediations: [],
      events: [],
      status_reason: "",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      finished_at: null,
    };
    this.event(run, "info", "Migration started by " + by + " — " + order.length + " wave(s), about " + run.totals.expected.toLocaleString() + " records.");
    if (run.trigger.override_blackout) this.event(run, "warn", "Blackout period overridden by " + by + ".");
    this.enterPhase(run, waves[order[0]], "VALIDATING", now);

    goal.active_run_id = runId;
    goal.runs = (goal.runs || []).concat({ run_id: runId, started_at: now.toISOString() });
    await this.saveGoal(goal, now);
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
      switch (wave.phase) {
        case "VALIDATING": await this.phaseValidate(run, wave, gw, goal, engine, now); break;
        case "MAPPING": await this.phaseMapping(run, wave, gw, goal, engine, now); break;
        case "MIGRATING": await this.phaseMigrate(run, wave, gw, goal, engine, now, { budgetMs, maxRecords }); break;
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

    run.totals = Object.values(run.waves).reduce((t, w) => addCounts(t, w.counts), { ...emptyCounts(), expected: run.totals.expected });
    run.updated_at = now.toISOString();
    await this.saveGoal(goal, now);
    await this.runStore.save(run);
    return run;
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
    run.status = "PAUSED";
    run.status_reason = "Paused by " + by + ".";
    this.event(run, "warn", "Paused by " + by + ".");
    await this.saveGoal(goal, now);
    await this.runStore.save(run);
    return run;
  }

  async resume(runId, { now = new Date(), by = "admin" } = {}) {
    const run = await this.runStore.get(runId);
    if (!run) throw new ExecutionError(404, "Run not found");
    if (run.status !== "PAUSED" || !run.paused_phase) throw new ExecutionError(409, "Only a paused run can be resumed");
    const goal = await this.goalStore.get(run.goal_id);
    const gw = goal.waves.find((w) => w.wave_id === run.current_wave_id);
    const phase = run.paused_phase;
    if (gw.status === "PAUSED") transition(gw, "RUNNING", "Resumed by " + by + ".", now);
    run.status = phase;
    run.paused_phase = null;
    run.status_reason = "";
    this.event(run, "info", "Resumed by " + by + ".");
    await this.saveGoal(goal, now);
    await this.runStore.save(run);
    return run;
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
    const classifyCache = new Map();
    const classify = (dept) => {
      const key = String(dept == null ? "" : dept);
      if (!classifyCache.has(key)) classifyCache.set(key, classifyWorkspace(key, workspaces, overrides));
      return classifyCache.get(key);
    };
    const ctx = { fields, targetSchema, seenIds };
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
          batch.push({ raw, ws, ref: this.recordRef(raw, fields) });
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

      // 2–5. validate → fix → map → classify → transform
      for (const item of batch) Object.assign(item, this.prepare(item.raw, item.ws, ctx));

      // 6. write, retrying transient failures once
      const ready = batch.filter((b) => b.state === "ready");
      if (ready.length) {
        const first = await engine.target.writeRecords(ready.map((b) => b.payload), { runId: run.run_id, attempt: 1 });
        ready.forEach((b, i) => { b.write = first[i]; });
        const retry = ready.filter((b) => !b.write.ok && b.write.error && b.write.error.retryable);
        if (retry.length) {
          const second = await engine.target.writeRecords(retry.map((b) => b.payload), { runId: run.run_id, attempt: 2 });
          retry.forEach((b, i) => {
            b.fixes.push("Retried after transient error " + b.write.error.code + " (" + b.write.error.message + ")");
            b.write = second[i];
          });
        }
      }

      // 7. record results
      for (const b of batch) this.record(run, wave, b);
      processed += batch.length;
    }

    run.seen_ids = [...seenIds];
    if (wave.source_exhausted) {
      const c = wave.counts;
      this.event(run, "info", wave.name + ": processed " + c.processed.toLocaleString() + " records — " + c.successful + " successful, " +
        c.remediated + " auto-fixed, " + c.human_review + " queued for human review.");
      transition(gw, "VALIDATING", "Verifying records in " + goal.target.name + ".", now);
      this.enterPhase(run, wave, "VALIDATING_TARGET", now);
    }
  }

  /** Validate, fix, map, classify and transform one source record. */
  prepare(raw, ws, ctx) {
    const fixes = [];
    let record = raw;
    const errors = validateRecord(raw, ctx).filter((i) => i.severity === "error");
    if (errors.length) {
      const fixed = applyBasicFixes(raw, errors, ctx.targetSchema);
      fixes.push(...fixed.fixes);
      if (fixed.unfixed.length) return { state: "review", issues: fixed.unfixed, fixes };
      record = fixed.record;
      const again = validateRecord(record, ctx).filter((i) => i.severity === "error");
      if (again.length) return { state: "review", issues: again, fixes };
    }
    const { target } = applyMapping(record, ctx.fields, ctx.targetSchema);
    const { payload, notes, unmapped } = transformRecord(target, ctx.targetSchema);
    if (unmapped.length) {
      return { state: "review", issues: unmapped.map((k) => ({ targetField: k, code: "unrecognized_value", severity: "error", message: "No target value for " + k })), fixes };
    }
    if (typeof payload.subject === "string" && payload.subject.length > 255) payload.subject = payload.subject.slice(0, 252) + "…";
    if (ws.workspaceId != null) payload.workspace_id = ws.workspaceId;
    const legacyId = payload.custom_fields && payload.custom_fields.legacy_ticket_id;
    if (legacyId) ctx.seenIds.add(String(legacyId));
    return { state: "ready", payload, fixes, notes };
  }

  record(run, wave, b) {
    const c = wave.counts;
    c.processed++;
    if (b.state === "ready" && b.write && b.write.ok) {
      wave.written_ids.push(b.write.id);
      if (b.fixes.length) {
        c.remediated++;
        c.failed++;
        if (run.remediations.length < MAX_QUEUE) run.remediations.push({ wave_id: wave.wave_id, record: b.ref, fixes: b.fixes, target_id: b.write.id });
      } else {
        c.successful++;
      }
      return;
    }
    c.failed++;
    c.human_review++;
    const reason = b.state === "review"
      ? b.issues.map((i) => i.message).join("; ")
      : "Target rejected the record: " + (b.write && b.write.error ? b.write.error.message : "unknown error");
    if (run.review_queue.length < MAX_QUEUE) {
      run.review_queue.push({
        wave_id: wave.wave_id, record: b.ref, reason, fixes_tried: b.fixes,
        issues: (b.issues || []).map((i) => ({ field: i.field, code: i.code, message: i.message })),
        source: b.raw, status: "OPEN",
      });
    }
  }

  recordRef(raw, fields) {
    const idField = fields.find((f) => f.targetField === "custom_fields.legacy_ticket_id");
    return idField ? String(raw[idField.sourceField]) : null;
  }

  async phaseVerify(run, wave, gw, goal, engine, now) {
    const targetSchema = await engine.target.getSchema();
    const ids = wave.written_ids;
    const sample = engine.target.mode === "live" ? ids.slice(0, 100) : ids;
    const records = await engine.target.readRecords(sample);
    const v = verifyTargetRecords(records, targetSchema, wave.workspace ? wave.workspace.id : null);
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
    const migrated = c.successful + c.remediated;
    const targetCount = await engine.target.countRecords({ runId: run.run_id, workspaceId: wave.workspace ? wave.workspace.id : null });
    const counted = targetCount == null ? wave.verification.checked : targetCount;
    const unaccounted = c.processed - migrated - c.human_review;
    wave.reconciliation = {
      source_in_scope: c.processed,
      expected: wave.expected,
      migrated,
      in_review: c.human_review,
      target_count: counted,
      unaccounted,
      match: counted === migrated && unaccounted === 0 && wave.verification.missing === 0,
    };

    const result = {
      total: c.processed,
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

  async saveGoal(goal, now) {
    goal.waves.forEach((w) => { w.display_status = displayStatus(goal, w); });
    goal.status = deriveGoalStatus(goal);
    goal.updated_at = now.toISOString();
    await this.goalStore.save(goal);
  }
}

module.exports = { MigrationExecutor, ExecutionError, RUN_PHASES, RUN_END_STATES };
