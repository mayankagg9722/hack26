/* run_migration — the migration agent's executor.

   PLAN → PRE-CHECK → (per entity, customers before tickets because tickets
   reference requesters) FETCH → TRANSFORM → LOOKUP TARGET REFERENCES →
   CREATE/UPDATE → [HUMAN REVIEW gate] → VALIDATE → RECONCILE → COMPLETE

   Works only with the source/target interfaces (jsmSource.js,
   freshserviceTarget.js) and normalised entities. advance() does one
   bounded step and persists the run, so the UI (or a scheduler) drives it
   over many short HTTP calls and every number shown is real state.

   Idempotency: every source → target ID pair is stored the moment a record
   is written (EntityMappingStore). A record that already has a target is
   updated, never created again; an existing requester with the same email
   is linked, not duplicated.

   Failures are typed (FAILURE_TYPES), never hidden. Safe fixes are applied
   automatically and only count once the target accepted the record;
   everything else stops at the human-review gate with what Zen tried and a
   recommendation (approve / skip / stop). */

const crypto = require("crypto");
const { activeRows, pendingRows } = require("./mapping");
const T = require("./transforms");
const { classifyWorkspace } = require("../mapping/workspaces");
const { isPlaceholder } = require("../execution/remediation");
const { MIN_CONFIDENCE } = require("../execution/aiDepartments");
const { inBlackout } = require("../goals/time");

const ENTITIES = {
  customers: { source: "customer", target: "requester", pair: "customer→requester", label: "Customers → Requesters" },
  tickets: { source: "ticket", target: "ticket", pair: "ticket→ticket", label: "Tickets → Tickets" },
};
const ENTITY_ORDER = ["customers", "tickets"];
const ENTITY_STAGES = [
  { key: "fetch", label: "Fetch source data" },
  { key: "transform", label: "Transform" },
  { key: "lookup", label: "Lookup target references" },
  { key: "write", label: "Create / update target records" },
  { key: "review", label: "Human review" },
  { key: "validate", label: "Validate" },
];
const STAGE_LABELS = { plan: "Plan", precheck: "Pre-check", reconcile: "Reconcile", complete: "Complete" };

const FAILURE_TYPES = {
  MISSING_REQUESTER: { label: "Missing requester", severity: "HIGH" },
  INVALID_DEPARTMENT: { label: "Invalid department", severity: "MEDIUM" },
  INVALID_PRIORITY: { label: "Invalid priority mapping", severity: "MEDIUM" },
  MISSING_REQUIRED_FIELD: { label: "Missing required field", severity: "HIGH" },
  INVALID_WORKSPACE: { label: "Invalid workspace", severity: "MEDIUM" },
  API_FAILURE: { label: "API failure", severity: "HIGH" },
  RATE_LIMIT: { label: "Rate limit", severity: "MEDIUM" },
  DUPLICATE_REQUESTER: { label: "Duplicate requester", severity: "LOW" },
  MISSING_EMAIL: { label: "Missing email", severity: "HIGH" },
  VALIDATION_MISMATCH: { label: "Validation mismatch", severity: "MEDIUM" },
};
const FINAL = ["SUCCESS", "REMEDIATED", "RESOLVED", "SKIPPED", "FAILED"];
const MIGRATED = ["SUCCESS", "REMEDIATED", "RESOLVED"];
const BATCH = 25;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_EVENTS = 250;

class AgentError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

function now() { return new Date().toISOString(); }

class MigrationAgentEngine {
  /**
   * @param {object} deps
   * @param {object} deps.store          AgentStore (runs + mappings)
   * @param {Function} deps.idMap        (target) => EntityMappingStore
   * @param {Function} deps.source       () => JSM source
   * @param {Function} deps.target       () => Freshservice target
   * @param {object} [deps.goalStore]
   * @param {object} [deps.mappingStore] legacy mapping store (workspace overrides from Field mapping)
   * @param {Function} [deps.getAiDepartmentResolver] () => async ({values, departments}) => {value: {department, confidence, reason}}
   * @param {number} [deps.retryDelayMs]
   */
  constructor({ store, idMap, source, target, goalStore = null, mappingStore = null, getAiDepartmentResolver = () => null, retryDelayMs }) {
    Object.assign(this, { store, idMapFor: idMap, sourceFactory: source, targetFactory: target, goalStore, mappingStore, getAiDepartmentResolver });
    this.retryDelayMs = retryDelayMs != null ? retryDelayMs : 0;
    this.locks = new Map();
  }

  /* ---------- start ---------- */

  async start({ goalId = null, entities, mappingIds = {}, overrideBlackout = false, by = "admin" } = {}) {
    let goal = null;
    if (goalId) {
      if (!this.goalStore) throw new AgentError(400, "Goals are not available");
      goal = await this.goalStore.get(goalId);
      if (!goal) throw new AgentError(404, "Goal not found");
    }
    let list = Array.isArray(entities) && entities.length ? entities : goal
      ? (goal.record_types || []).map((r) => (r === "employees" ? "customers" : r)).filter((e) => ENTITIES[e])
      : ENTITY_ORDER.slice();
    list = ENTITY_ORDER.filter((e) => list.includes(e));
    if (!list.length) throw new AgentError(400, "Choose at least one entity: customers, tickets");
    const mappings = {};
    for (const e of list) {
      const id = mappingIds[e];
      const m = id ? await this.store.getMapping(id) : await this.store.latestMapping(ENTITIES[e].pair);
      if (!m) throw new AgentError(409, "Generate the " + ENTITIES[e].label + " mapping first", { code: "NO_MAPPING", entity: e });
      const pending = pendingRows(m);
      if (pending.length) {
        throw new AgentError(409, "Confirm or reject the low-confidence mappings first: " + pending.map((r) => r.source + " → " + r.target).join(", "), { code: "PENDING_MAPPINGS", entity: e, fields: pending.map((r) => r.source) });
      }
      mappings[e] = m.mappingId;
    }
    const source = this.sourceFactory();
    const target = this.targetFactory();
    const steps = [{ key: "plan", entity: null, label: STAGE_LABELS.plan }, { key: "precheck", entity: null, label: STAGE_LABELS.precheck }];
    for (const e of list) for (const s of ENTITY_STAGES) steps.push({ key: s.key, entity: e, label: s.label });
    steps.push({ key: "reconcile", entity: null, label: STAGE_LABELS.reconcile }, { key: "complete", entity: null, label: STAGE_LABELS.complete });

    const run = {
      id: "agent_" + crypto.randomBytes(5).toString("hex"),
      goal_id: goal ? goal.goal_id : null,
      goal_name: goal ? goal.name || goal.title || goal.goal_id : null,
      success_criteria: { min_success_rate: goal && goal.success_criteria && goal.success_criteria.min_success_rate != null ? goal.success_criteria.min_success_rate : 0.95 },
      source: { system: "JSM", name: source.system, mode: source.mode, via: source.via },
      target: { system: "Freshservice", name: target.system, mode: target.mode, via: target.via },
      entities: list,
      mapping_ids: mappings,
      override_blackout: Boolean(overrideBlackout),
      status: "RUNNING",
      status_reason: null,
      steps: steps.map((s) => ({ ...s, status: "upcoming", detail: null, started_at: null, finished_at: null })),
      cursor: 0,
      step_cursor: 0,
      plan: null,
      refs: null,
      records: {},
      order: {},
      department_resolution: {},
      reconciliation: null,
      evaluation: null,
      insights: null,
      events: [],
      created_by: by,
      created_at: now(),
      started_at: now(),
      finished_at: null,
      updated_at: now(),
    };
    this.event(run, "info", "Migration started by " + by + (goal ? " for goal " + run.goal_name : "") + ".");
    await this.store.saveRun(run);
    return run;
  }

  /* ---------- drive ---------- */

  async advance(id) {
    return this.withLock(id, () => this.step(id));
  }

  async step(id) {
    const run = await this.load(id);
    if (run.status !== "RUNNING") return run;
    const step = run.steps[run.cursor];
    if (!step) return run;
    if (step.status === "upcoming") { step.status = "running"; step.started_at = now(); }
    let done = false;
    try {
      done = await this.runStep(run, step);
    } catch (err) {
      if (err.blocking || err.code === "config") {
        step.status = "failed";
        step.detail = err.message;
        this.finish(run, "BLOCKED", err.message);
      } else {
        step.status = "failed";
        step.detail = err.message;
        this.finish(run, "FAILED", "Unexpected error in " + step.label + ": " + err.message);
      }
      this.event(run, "error", step.label + (step.entity ? " (" + step.entity + ")" : "") + " failed: " + err.message);
    }
    if (done && run.status === "RUNNING") {
      step.status = step.status === "running" ? "done" : step.status;
      step.finished_at = now();
      run.cursor++;
      run.step_cursor = 0;
    }
    run.updated_at = now();
    await this.store.saveRun(run);
    return run;
  }

  async runStep(run, step) {
    const ctx = await this.context(run, step.entity);
    switch (step.key) {
      case "plan": return this.plan(run, ctx);
      case "precheck": return this.precheck(run, ctx);
      case "fetch": return this.fetch(run, step, ctx);
      case "transform": return this.transformAll(run, step, ctx);
      case "lookup": return this.batch(run, step, ctx, (rec) => rec.status === "PENDING" && rec.stage === "transform", (rec) => this.lookup(run, rec, ctx));
      case "write": return this.batch(run, step, ctx, (rec) => rec.status === "PENDING" && rec.stage === "lookup", (rec) => this.write(run, rec, ctx));
      case "review": return this.reviewGate(run, step);
      case "validate": return this.batch(run, step, ctx, (rec) => MIGRATED.includes(rec.status) && rec.written_in === run.id && !rec.validation, (rec) => this.validate(run, rec, ctx));
      case "reconcile": return this.reconcile(run);
      case "complete": return this.complete(run);
      default: return true;
    }
  }

  async context(run, entity) {
    const target = this.targetFactory();
    const ctx = { target, source: null, entity, idMap: this.idMapFor(target), refs: run.refs };
    if (entity) {
      const m = await this.store.getMapping(run.mapping_ids[entity]);
      ctx.mapping = m;
      ctx.rows = activeRows(m);
      ctx.bySource = Object.fromEntries(ctx.rows.map((r) => [r.source, r]));
    }
    return ctx;
  }

  /* ---------- global stages ---------- */

  async plan(run) {
    const saved = this.mappingStore ? await this.mappingStore.get("jira", "freshservice").catch(() => null) : null;
    const mappings = {};
    for (const e of run.entities) {
      const m = await this.store.getMapping(run.mapping_ids[e]);
      mappings[e] = { mapping_id: m.mappingId, fields: activeRows(m).length, unmapped: m.fields.filter((r) => !r.target && r.transformation !== "idMapping").map((r) => r.source) };
    }
    run.plan = {
      order: run.entities.map((e) => ENTITIES[e].label),
      order_reason: run.entities.length > 1 ? "Customers first: tickets reference requesters, so requesters must exist before tickets are created." : null,
      mappings,
      workspace_overrides: (saved && saved.workspaceRules) || {},
      workspace_mapping: {},
      success_criteria: run.success_criteria,
      idempotency: "Source → target IDs are stored per record; retries update or link instead of creating duplicates.",
    };
    this.event(run, "info", "Plan: " + run.plan.order.join(", then ") + ".");
    return true;
  }

  async precheck(run, ctx) {
    const checks = [];
    const source = this.sourceFactory();
    const target = ctx.target;
    if (run.goal_id && this.goalStore) {
      const goal = await this.goalStore.get(run.goal_id);
      const b = goal && goal.blackout_periods ? inBlackout(new Date(), goal.blackout_periods, (goal.schedule && goal.schedule.timezone) || "UTC") : null;
      if (b && !run.override_blackout) {
        checks.push({ check: "Blackout window", ok: false, detail: "Now is inside the \"" + (b.label || "blackout") + "\" blackout period of the goal." });
      } else {
        checks.push({ check: "Blackout window", ok: true, detail: b ? "Inside a blackout period — overridden by the Admin." : "Not in a blackout period." });
      }
    }
    try {
      const [departments, groups, workspaces, locations] = await Promise.all([target.departments(), target.groups(), target.workspaces(), target.locations()]);
      run.refs = { departments, groups, workspaces, locations };
      checks.push({ check: "Freshservice reachable", ok: true, detail: departments.length + " departments, " + workspaces.length + " workspaces, " + groups.length + " groups (" + target.via + ")." });
    } catch (err) {
      checks.push({ check: "Freshservice reachable", ok: false, detail: err.message });
    }
    if (target.mode === "live" && !target.writesAllowed) {
      checks.push({ check: "Live writes allowed", ok: false, detail: "Set ZEN_ALLOW_LIVE_WRITES=true to let Zen create records in the live Freshservice tenant." });
    }
    const discovered = await source.discover().catch((err) => [{ status: "error", message: err.message }]);
    for (const e of run.entities) {
      const d = discovered.find((x) => x.entityType === ENTITIES[e].source);
      checks.push({ check: "JSM " + e + " readable", ok: Boolean(d && d.status === "ready"), detail: d ? d.message || (d.count != null ? d.count + " records (" + source.via + ")." : "Ready.") : "Not discovered." });
      const m = await this.store.getMapping(run.mapping_ids[e]);
      checks.push({ check: ENTITIES[e].label + " mapping", ok: !m.missingRequired.length && !pendingRows(m).length, detail: m.missingRequired.length ? "Required Freshservice fields not mapped: " + m.missingRequired.join(", ") : activeRows(m).length + " field mappings approved." });
    }
    run.plan.prechecks = checks;
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      this.finish(run, "BLOCKED", "Pre-check failed: " + failed.map((c) => c.check + " — " + c.detail).join(" "));
      run.steps[run.cursor].status = "failed";
      run.steps[run.cursor].detail = failed.map((c) => c.check).join(", ");
      return false;
    }
    run.steps[run.cursor].detail = checks.length + " checks passed";
    this.event(run, "info", "Pre-checks passed (" + checks.length + ").");
    return true;
  }

  /* ---------- entity stages ---------- */

  async fetch(run, step) {
    const source = this.sourceFactory();
    const list = await source.fetch(ENTITIES[step.entity].source);
    run.order[step.entity] = [];
    for (const item of list) {
      const key = step.entity + ":" + item.id;
      if (run.records[key]) continue; // duplicate source rows are reported once
      run.order[step.entity].push(key);
      run.records[key] = {
        key, entity: step.entity, entityType: item.entityType, sourceId: item.id,
        label: item.entityType === "customer" ? item.normalized.name || item.normalized.email || item.id : item.normalized.summary || item.id,
        native: item.native, normalized: item.normalized, demo: item.demo || null,
        targetId: null, action: null, status: "PENDING", stage: "fetch",
        timestamp: now(), errors: [], error: null, remediationAttempted: false, remediationResult: null,
        remediation: [], notes: [], review: null, overrides: {}, payload: null, refs: null, written_in: null, validation: null,
      };
    }
    step.detail = list.length + " records from " + source.via;
    this.event(run, "info", "Fetched " + list.length + " JSM " + step.entity + ".");
    return true;
  }

  async transformAll(run, step, ctx) {
    const keys = run.order[step.entity] || [];
    for (const k of keys) {
      const rec = run.records[k];
      if (rec.status !== "PENDING" || rec.stage !== "fetch") continue;
      const prior = await ctx.idMap.get(step.entity, rec.sourceId);
      if (prior && prior.overrides && Object.keys(prior.overrides).length) {
        rec.overrides = prior.overrides;
        rec.notes.push("Reusing the Admin's decision from an earlier run.");
      }
      this.transform(run, rec, ctx);
    }
    if (step.entity === "tickets") this.recordWorkspaceMapping(run, keys.map((k) => run.records[k]), ctx);
    step.detail = this.stageCount(run, step.entity, "transform") + " transformed";
    return true;
  }

  /** Generic batch runner over the entity's records; true when nothing is left. */
  async batch(run, step, ctx, eligible, fn) {
    const keys = (run.order[step.entity] || []).filter((k) => eligible(run.records[k]));
    if (step.key === "lookup" && !run.department_resolution[step.entity]) await this.resolveDepartments(run, step.entity, ctx);
    for (const k of keys.slice(0, BATCH)) {
      await fn(run.records[k]);
      run.records[k].timestamp = now();
    }
    const left = keys.length - Math.min(keys.length, BATCH);
    const total = (run.order[step.entity] || []).length;
    step.detail = (total - left) + " / " + total;
    return left === 0;
  }

  reviewGate(run, step) {
    const pending = (run.order[step.entity] || []).map((k) => run.records[k]).filter((r) => r.status === "HUMAN_REVIEW_REQUIRED");
    if (!pending.length) {
      step.status = step.status === "running" && !step.detail ? "skipped" : "done";
      step.detail = step.detail || "Nothing needed a human";
      return true;
    }
    step.detail = pending.length + " waiting for a decision";
    run.status = "HUMAN_REVIEW_REQUIRED";
    run.status_reason = pending.length + " " + step.entity + " need a human decision before Zen continues" + (step.entity === "customers" && run.entities.includes("tickets") ? " (tickets depend on these requesters)." : ".");
    this.event(run, "warn", run.status_reason);
    return false;
  }

  /* ---------- per record ---------- */

  transform(run, rec, ctx) {
    const n = { ...rec.native, ...rec.overrides.native };
    const payload = {};
    const refs = {};
    const failures = [];
    const footer = [];
    for (const r of ctx.rows) {
      const v = n[r.source];
      switch (r.transformation) {
        case "idMapping": break;
        case "splitName": Object.assign(payload, T.splitName(v)); if (!payload.first_name) failures.push(["MISSING_REQUIRED_FIELD", "Name is blank in JSM (Freshservice requires first_name)"]); break;
        case "rename": case "direct": case "lookup":
          if (r.target === "email") {
            const e = String(v || "").trim().toLowerCase();
            if (!e) failures.push(["MISSING_EMAIL", "Customer has no email address in JSM"]);
            else if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) failures.push(["MISSING_EMAIL", "Email '" + e + "' is not a valid address"]);
            payload.primary_email = e;
          } else if (r.target === "subject") {
            payload.subject = String(v || "").trim();
            if (!payload.subject) failures.push(["MISSING_REQUIRED_FIELD", "Summary is blank in JSM (Freshservice requires subject)"]);
          } else if (r.target === "description") {
            payload.description = String(v || "").trim();
          } else if (r.target === "location") {
            refs.location = v;
          } else if (v != null && v !== "") {
            payload[r.targetApi && !r.targetApi.includes(" ") ? r.targetApi : r.target] = v;
          }
          break;
        case "transformPriority": {
          const p = T.transformPriority(v);
          if (p.error) failures.push(["INVALID_PRIORITY", p.error]); else payload.priority = p.value;
          break;
        }
        case "transformStatus": payload.status = T.transformStatus(v, n.statusCategory).value; break;
        case "issueType": payload.type = /incident|problem|bug|outage/i.test(String(v)) ? "Incident" : "Service Request"; break;
        case "lookupRequester": refs.reporter = v || null; break;
        case "lookupDepartment": refs.department = v || null; break;
        case "classifyWorkspace": refs.workspace = n.workspace || null; refs.workspaceDepartment = n.department || null; break;
        case "preserveInDescription": if (v) footer.push("Created in JSM on " + String(v).slice(0, 10)); break;
        default: break;
      }
    }
    if (rec.entity === "tickets") {
      if (!payload.description && payload.subject) {
        const f = this.fail(rec, "MISSING_REQUIRED_FIELD", "Description is blank in JSM (Freshservice requires description)", "transform");
        payload.description = payload.subject;
        this.remediate(rec, "fill_description", "Description was blank — used the summary", true, f);
      }
      footer.unshift("Migrated from JSM " + rec.sourceId);
    }
    // safe fixes for what the transform found
    for (const [type, message] of failures) {
      const fail = this.fail(rec, type, message, "transform");
      if (type === "MISSING_REQUIRED_FIELD" && rec.entity === "customers") {
        const name = T.nameFromEmail(payload.primary_email);
        if (name) { Object.assign(payload, T.splitName(name)); this.remediate(rec, "derive_name_from_email", "Name derived from the email address: " + name, true, fail); continue; }
      }
      if (type === "MISSING_REQUIRED_FIELD" && rec.entity === "tickets") {
        const first = String(payload.description || "").split(/(?<=[.!?])\s/)[0].slice(0, 80).trim();
        if (first) { payload.subject = first; this.remediate(rec, "subject_from_description", "Subject taken from the first sentence of the description", true, fail); continue; }
        this.remediate(rec, "subject_from_description", "Summary and description are both blank — nothing to derive a subject from", false, fail);
        return this.toReview(run, rec, fail, {
          problem: "The JSM ticket has no summary and no description; Freshservice requires both.",
          tried: ["Looked for a summary", "Tried to derive the subject from the description (empty)"],
          recommendation: "Migrate with a placeholder subject \"Migrated from JSM " + rec.sourceId + "\" so the record is not lost.",
          action: "use_placeholder_subject",
        });
      }
      if (type === "INVALID_PRIORITY") {
        const hit = T.normalizePriority(n.priority);
        if (hit) { payload.priority = hit.value; this.remediate(rec, "normalize_priority", "'" + n.priority + "' → " + T.FS_PRIORITY[hit.value] + " (found '" + hit.word + "')", true, fail); continue; }
        this.remediate(rec, "normalize_priority", "No known priority word in '" + n.priority + "'", false, fail);
        return this.toReview(run, rec, fail, {
          problem: "Priority '" + n.priority + "' has no Freshservice equivalent.",
          tried: ["Matched against the priority mapping (Highest…Lowest, P1…P5)", "Looked for a priority word inside the value"],
          recommendation: "Use Freshservice priority 2 (Medium), the default for unclassified tickets.",
          action: "use_default_priority",
        });
      }
      if (type === "MISSING_EMAIL") {
        this.remediate(rec, "find_email", "No other JSM record for this customer has an email", false, fail);
        return this.toReview(run, rec, fail, {
          problem: "Freshservice requesters need an email, and this JSM customer has none.",
          tried: ["Read the customer's JSM profile", "Searched the other JSM records for this account ID"],
          recommendation: "Enter the employee's email, then Zen creates the requester.",
          action: "provide_email", needsInput: "email",
        });
      }
      return this.toReview(run, rec, fail, { problem: message, tried: [], recommendation: "Fix the source record in JSM and retry.", action: "retry" });
    }
    if (footer.length && rec.entity === "tickets") payload.description = (payload.description || "") + "\n\n— " + footer.join(" · ");
    rec.payload = payload;
    rec.refs = refs;
    rec.stage = "transform";
    return true;
  }

  async lookup(run, rec, ctx) {
    const entityKey = rec.entity;
    const existing = await ctx.idMap.get(entityKey, rec.sourceId);
    if (existing && existing.target_id) {
      rec.targetId = existing.target_id;
      rec.action = existing.action === "linked" ? "linked" : "update";
      rec.notes.push("Already migrated (→ " + existing.target_id + ") — will " + (rec.action === "linked" ? "stay linked" : "update, not create") + ".");
    }
    const refs = rec.refs || {};

    // department → ID
    if (refs.department && !rec.overrides.noDepartment) {
      const res = (run.department_resolution[entityKey] || {})[refs.department];
      if (res && res.department) {
        if (rec.entity === "customers") rec.payload.department_ids = [res.department.id]; else rec.payload.department_id = res.department.id;
        if (res.via !== "exact") {
          const fail = this.fail(rec, "INVALID_DEPARTMENT", "Department '" + refs.department + "' does not exist in Freshservice", "lookup");
          this.remediate(rec, res.via === "ai" ? "ai_department" : "normalize_department", "'" + refs.department + "' → " + res.department.name + " (" + (res.via === "ai" ? "Claude, " + Math.round(res.confidence * 100) + "% — " + res.reason : res.via) + ")", true, fail);
        }
      } else {
        const fail = this.fail(rec, "INVALID_DEPARTMENT", "Department '" + refs.department + "' does not exist in Freshservice", "lookup");
        const tried = ["Exact match against " + (ctx.refs.departments || []).length + " Freshservice departments", "Known aliases, abbreviations and spelling"];
        if (res && res.aiTried) tried.push("Asked Claude — " + (res.reason || "no confident match"));
        this.remediate(rec, "normalize_department", "No safe match for '" + refs.department + "'", false, fail);
        return this.toReview(run, rec, fail, {
          problem: "Department '" + refs.department + "' does not exist in Freshservice.",
          tried, recommendation: "Migrate without a department (it can be set in Freshservice later), or add the department to Freshservice and retry.",
          action: "migrate_without_department",
        });
      }
    }
    if (refs.location) {
      const loc = (ctx.refs.locations || []).find((l) => l.name.toLowerCase() === String(refs.location).toLowerCase());
      if (loc) rec.payload.location_id = loc.id; else rec.notes.push("Location '" + refs.location + "' not in Freshservice — left blank.");
    }

    if (rec.entity === "customers" && rec.action !== "update" && rec.action !== "linked") {
      const found = await ctx.target.findRequesterByEmail(rec.payload.primary_email);
      if (found) {
        const fail = this.fail(rec, "DUPLICATE_REQUESTER", "A requester with " + rec.payload.primary_email + " already exists in Freshservice (" + found.id + ")", "lookup");
        this.remediate(rec, "link_existing_requester", "Linked to existing requester " + found.id + " instead of creating a duplicate", true, fail);
        rec.targetId = found.id;
        rec.action = "linked";
        await ctx.idMap.set(entityKey, rec.sourceId, { target_id: found.id, action: "linked", run_id: run.id, email: rec.payload.primary_email });
        return this.succeed(run, rec, "linked");
      }
    }
    if (rec.entity === "tickets") {
      const ok = await this.resolveRequester(run, rec, ctx);
      if (!ok) return false;
      this.resolveWorkspace(run, rec, ctx);
    }
    if (rec.action === "linked") return this.succeed(run, rec, "linked");
    rec.stage = "lookup";
    return true;
  }

  async resolveRequester(run, rec, ctx) {
    if (rec.overrides.requester_id) { rec.payload.requester_id = rec.overrides.requester_id; return true; }
    const r = rec.refs.reporter || {};
    if (r.accountId) {
      const m = await ctx.idMap.get("customers", r.accountId);
      if (m && m.target_id) { rec.payload.requester_id = m.target_id; return true; }
    }
    const fail = this.fail(rec, "MISSING_REQUESTER", "Requester '" + (r.displayName || r.accountId || "unknown") + "' could not be resolved", "lookup");
    const tried = ["Looked up the JSM customer in Zen's ID map"];
    const email = String(r.emailAddress || "").toLowerCase();
    if (email) {
      tried.push("Searched Freshservice requesters by email " + email);
      const found = await ctx.target.findRequesterByEmail(email);
      if (found) {
        rec.payload.requester_id = found.id;
        this.remediate(rec, "requester_by_email", "Found requester " + found.id + " by email " + email, true, fail);
        return true;
      }
    }
    let matches = [];
    if (r.displayName) {
      tried.push("Searched Freshservice requesters by display name '" + r.displayName + "'");
      matches = await ctx.target.searchRequestersByName(r.displayName);
    }
    this.remediate(rec, "resolve_requester", tried.slice(1).join("; ") + " — " + (matches.length === 1 ? "one name match, needs confirmation" : "no match"), false, fail);
    if (matches.length === 1) {
      this.toReview(run, rec, fail, {
        problem: "Requester could not be resolved by ID or email.", tried: tried.concat("Found exactly one requester named '" + r.displayName + "' (" + matches[0].id + ")"),
        recommendation: "Link the ticket to " + matches[0].name + " (" + (matches[0].email || "no email") + ") — a name match alone is not safe enough to apply automatically.",
        action: "link_requester", data: { requester_id: matches[0].id },
      });
      return false;
    }
    this.toReview(run, rec, fail, {
      problem: "Requester could not be resolved.", tried: tried.concat(matches.length ? matches.length + " requesters share this name" : "No matching requester found"),
      recommendation: email ? "Create a new Freshservice requester for " + (r.displayName || email) + " (" + email + ") and link the ticket." : "Enter the requester's email; Zen creates the requester and links the ticket.",
      action: email ? "create_requester" : "provide_requester_email", needsInput: email ? null : "email",
      data: { name: r.displayName || "", email },
    });
    return false;
  }

  resolveWorkspace(run, rec, ctx) {
    const ws = ctx.refs.workspaces || [];
    if (!ws.length) return;
    const refs = rec.refs;
    const overrides = (run.plan && run.plan.workspace_overrides) || {};
    if (refs.workspace) {
      const named = ws.find((w) => w.name.toLowerCase() === String(refs.workspace).toLowerCase());
      if (named) { rec.payload.workspace_id = named.id; rec.workspace = { id: named.id, name: named.name, rule: "source" }; return; }
      const fail = this.fail(rec, "INVALID_WORKSPACE", "Workspace '" + refs.workspace + "' does not exist in Freshservice", "lookup");
      const c = classifyWorkspace(refs.workspaceDepartment, ws, overrides);
      rec.payload.workspace_id = c.workspaceId;
      rec.workspace = { id: c.workspaceId, name: c.workspaceName, rule: c.rule };
      this.remediate(rec, "classify_workspace", "Workspace Classification: " + c.reason, true, fail);
      return;
    }
    const c = classifyWorkspace(refs.workspaceDepartment, ws, overrides);
    rec.payload.workspace_id = c.workspaceId;
    rec.workspace = { id: c.workspaceId, name: c.workspaceName, rule: c.rule };
  }

  async write(run, rec, ctx) {
    const isCustomer = rec.entity === "customers";
    const demo = rec.demo || {};
    let attempt = 0;
    let lastErr = null;
    let apiFail = null;
    while (attempt < MAX_WRITE_ATTEMPTS) {
      attempt++;
      try {
        let res;
        if (rec.action === "update" && rec.targetId) {
          res = isCustomer ? await ctx.target.updateRequester(rec.targetId, rec.payload) : await ctx.target.updateTicket(rec.targetId, rec.payload);
        } else {
          const opts = { simulate: demo.apiFailure, key: rec.sourceId };
          res = isCustomer ? await ctx.target.createRequester(rec.payload, opts) : await ctx.target.createTicket(rec.payload, opts);
        }
        rec.targetId = res.id;
        const action = rec.action === "update" ? "updated" : "created";
        // human decisions travel with the ID map, so a re-run doesn't ask again
        const decided = rec.resolving || Object.keys(rec.overrides).length ? { overrides: rec.overrides } : {};
        await ctx.idMap.set(rec.entity, rec.sourceId, { target_id: res.id, action, run_id: run.id, ...decided, ...(isCustomer ? { email: rec.payload.primary_email } : {}) });
        if (apiFail) this.remediate(rec, apiFail.type === "RATE_LIMIT" ? "backoff_retry" : "retry_api", "Succeeded on attempt " + attempt + " of " + MAX_WRITE_ATTEMPTS, true, apiFail);
        return this.succeed(run, rec, action);
      } catch (err) {
        lastErr = err;
        if (err.blocking || err.code === "config") throw err;
        if (err.retryable) {
          if (!apiFail) apiFail = this.fail(rec, err.status === 429 || err.rateLimited ? "RATE_LIMIT" : "API_FAILURE", err.message, "write");
          else apiFail.message = err.message;
          if (attempt < MAX_WRITE_ATTEMPTS && this.retryDelayMs) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
          continue;
        }
        if (err.duplicate && isCustomer) {
          const found = await ctx.target.findRequesterByEmail(rec.payload.primary_email);
          const fail = this.fail(rec, "DUPLICATE_REQUESTER", err.message, "write");
          if (found) {
            rec.targetId = found.id;
            rec.action = "linked";
            this.remediate(rec, "link_existing_requester", "Freshservice reported a duplicate — linked to existing requester " + found.id, true, fail);
            await ctx.idMap.set(rec.entity, rec.sourceId, { target_id: found.id, action: "linked", run_id: run.id, email: rec.payload.primary_email });
            return this.succeed(run, rec, "linked");
          }
        }
        if (err.status === 404 && rec.action === "update") {
          rec.notes.push("Target record " + rec.targetId + " no longer exists — creating it again.");
          rec.action = null;
          rec.targetId = null;
          continue;
        }
        break;
      }
    }
    if (apiFail && lastErr && lastErr.retryable) {
      this.remediate(rec, "retry_api", "Retried " + MAX_WRITE_ATTEMPTS + " times — still failing (" + lastErr.message + ")", false, apiFail);
      return this.toReview(run, rec, apiFail, {
        problem: "Freshservice kept failing: " + lastErr.message, tried: ["Retried " + MAX_WRITE_ATTEMPTS + " times with backoff"],
        recommendation: "Retry once the Freshservice API is healthy.", action: "retry",
      });
    }
    const type = classifyApiError(lastErr ? lastErr.message : "");
    const fail = this.fail(rec, type, lastErr ? lastErr.message : "Unknown error", "write");
    return this.toReview(run, rec, fail, {
      problem: "Freshservice rejected the record: " + (lastErr ? lastErr.message : "unknown error"), tried: ["Validated the payload against the mapping", "Sent it to Freshservice"],
      recommendation: "Correct the value in JSM (or the mapping) and retry.", action: "retry",
    });
  }

  async validate(run, rec, ctx) {
    const t = rec.entity === "customers" ? await ctx.target.getRequester(rec.targetId) : await ctx.target.getTicket(rec.targetId);
    const problems = [];
    if (!t) problems.push("Record " + rec.targetId + " was not found in Freshservice");
    else if (rec.entity === "customers") {
      if (String(t.primary_email || "").toLowerCase() !== String(rec.payload.primary_email || "").toLowerCase()) problems.push("Email differs in Freshservice");
    } else {
      if (t.subject !== rec.payload.subject) problems.push("Subject differs in Freshservice");
      if (String(t.requester_id) !== String(rec.payload.requester_id)) problems.push("Requester differs in Freshservice");
    }
    rec.validation = { ok: !problems.length, problems, at: now() };
    if (problems.length) {
      this.fail(rec, "VALIDATION_MISMATCH", problems.join("; "), "validate");
      rec.status = "FAILED";
    }
  }

  async reconcile(run) {
    const target = this.targetFactory();
    const idMap = this.idMapFor(target);
    const out = {};
    for (const e of run.entities) {
      const recs = (run.order[e] || []).map((k) => run.records[k]);
      const migrated = recs.filter((r) => MIGRATED.includes(r.status));
      const targetIds = migrated.map((r) => r.targetId).filter(Boolean);
      const mapped = await Promise.all(migrated.map((r) => idMap.get(e, r.sourceId)));
      const linked = migrated.filter((r) => r.action === "linked").length;
      out[e] = {
        source_total: recs.length,
        migrated: migrated.length,
        created: migrated.filter((r) => r.action === "created").length,
        updated: migrated.filter((r) => r.action === "updated").length,
        linked,
        skipped: recs.filter((r) => r.status === "SKIPPED").length,
        failed: recs.filter((r) => r.status === "FAILED").length,
        pending_review: recs.filter((r) => r.status === "HUMAN_REVIEW_REQUIRED").length,
        id_map_entries: mapped.filter((m) => m && m.target_id).length,
        verified_in_target: migrated.filter((r) => r.validation && r.validation.ok).length + migrated.filter((r) => r.action === "linked" && !r.validation).length,
        duplicate_target_ids: e === "tickets" ? targetIds.length - new Set(targetIds).size : 0,
      };
      const o = out[e];
      o.balanced = o.migrated + o.skipped + o.failed + o.pending_review === o.source_total && o.id_map_entries === o.migrated && o.duplicate_target_ids === 0;
    }
    run.reconciliation = out;
    run.steps[run.cursor].detail = Object.values(out).every((o) => o.balanced) ? "Source and target balance" : "Differences found";
    this.event(run, "info", "Reconciliation: " + run.entities.map((e) => e + " " + out[e].migrated + "/" + out[e].source_total).join(", ") + ".");
    return true;
  }

  complete(run) {
    const s = summarize(run);
    const min = run.success_criteria.min_success_rate;
    run.evaluation = { success_rate: s.success_rate, min_success_rate: min, met: s.success_rate != null && s.success_rate >= min };
    this.finish(run, "COMPLETED", "Migrated " + s.migrated + " of " + s.total + " records (" + pct(s.success_rate) + " success)" + (run.evaluation.met ? "." : " — below the " + pct(min) + " success criterion."));
    run.steps[run.cursor].status = "done";
    run.steps[run.cursor].finished_at = now();
    return true;
  }

  /* ---------- human review ---------- */

  /**
   * @param {string} id
   * @param {string} recordKey
   * @param {{action: "approve"|"skip", input?: {email?: string}, by?: string}} decision
   */
  async review(id, recordKey, { action, input = {}, by = "admin" } = {}) {
    return this.withLock(id, async () => {
      const run = await this.load(id);
      const rec = run.records[recordKey];
      if (!rec) throw new AgentError(404, "Record not found");
      if (rec.status !== "HUMAN_REVIEW_REQUIRED") throw new AgentError(409, "This record is not waiting for review");
      // decisions are taken at the review gate, never while records are still being written
      if (run.status !== "HUMAN_REVIEW_REQUIRED") throw new AgentError(409, run.status === "RUNNING" ? "Zen is still migrating — decisions open when it pauses for review" : "The migration is " + run.status.toLowerCase());
      if (action === "skip") {
        rec.status = "SKIPPED";
        rec.review.decision = { action: "skip", by, at: now() };
        rec.remediationResult = rec.remediationResult || "FAILED";
        this.event(run, "info", by + " skipped " + rec.sourceId + ".");
      } else if (action === "approve") {
        await this.applyApproval(run, rec, input, by);
      } else {
        throw new AgentError(400, "action must be approve or skip");
      }
      this.maybeResume(run);
      run.updated_at = now();
      await this.store.saveRun(run);
      return run;
    });
  }

  async applyApproval(run, rec, input, by) {
    const r = rec.review;
    const o = rec.overrides;
    o.native = o.native || {};
    const email = String(input.email || "").trim().toLowerCase();
    if (r.needsInput === "email" && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new AgentError(400, "Enter a valid email address");
    const ctx = await this.context(run, rec.entity);
    switch (r.action) {
      case "provide_email": o.native.emailAddress = email; break;
      case "migrate_without_department": o.noDepartment = true; break;
      case "use_default_priority": o.native.priority = "Medium"; break;
      case "use_placeholder_subject": o.native.summary = "Migrated from JSM " + rec.sourceId; o.native.description = "No description in JSM."; break;
      case "link_requester": o.requester_id = r.data.requester_id; break;
      case "create_requester":
      case "provide_requester_email": {
        const who = { name: r.data.name || T.nameFromEmail(email || r.data.email), email: email || r.data.email };
        const existing = await ctx.target.findRequesterByEmail(who.email);
        const created = existing || await ctx.target.createRequester({ ...T.splitName(who.name || T.nameFromEmail(who.email)), primary_email: who.email });
        o.requester_id = created.id;
        rec.notes.push((existing ? "Linked existing" : "Created") + " requester " + created.id + " for " + who.email + " (approved by " + by + ").");
        break;
      }
      case "retry": default: break;
    }
    const attempt = { action: r.action, by, at: now(), input: email ? { email } : undefined };
    r.history = (r.history || []).concat(attempt);
    // re-run the record through the same pipeline
    rec.status = "PENDING";
    rec.stage = "fetch";
    rec.error = null;
    rec.resolving = true;
    this.transform(run, rec, ctx);
    if (rec.status === "PENDING") await this.lookup(run, rec, ctx);
    if (rec.status === "PENDING" && rec.stage === "lookup") await this.write(run, rec, ctx);
    if (MIGRATED.includes(rec.status)) {
      if (rec.written_in === run.id && rec.targetId && run.steps.some((s) => s.entity === rec.entity && s.key === "validate" && s.status === "done")) await this.validate(run, rec, ctx);
      rec.status = rec.status === "FAILED" ? "FAILED" : "RESOLVED";
      rec.review.decision = { action: "approve", by, at: now(), result: "resolved" };
      this.event(run, "info", by + " approved " + rec.sourceId + " — resolved (" + (rec.targetId || "") + ").");
    } else {
      this.event(run, "warn", by + " approved a retry of " + rec.sourceId + " — still needs attention.");
    }
    rec.resolving = false;
  }

  async stop(id, { by = "admin" } = {}) {
    return this.withLock(id, async () => {
      const run = await this.load(id);
      if (["COMPLETED", "STOPPED", "FAILED"].includes(run.status)) throw new AgentError(409, "The migration has already finished");
      const step = run.steps[run.cursor];
      if (step) { step.status = "failed"; step.detail = "Stopped by " + by; }
      this.finish(run, "STOPPED", "Stopped by " + by + ". Records already written stay in Freshservice and are tracked in the ID map, so a new run continues without duplicates.");
      await this.store.saveRun(run);
      return run;
    });
  }

  maybeResume(run) {
    if (run.status !== "HUMAN_REVIEW_REQUIRED") return;
    const step = run.steps[run.cursor];
    const pending = (run.order[step.entity] || []).some((k) => run.records[k].status === "HUMAN_REVIEW_REQUIRED");
    if (!pending) {
      run.status = "RUNNING";
      run.status_reason = null;
      step.detail = "All decisions made";
      this.event(run, "info", "Every review decision is made — continuing.");
    }
  }

  /* One mutation of a run at a time: in this process (promise chain) and
     across processes/instances sharing the data dir (store lock). */
  async withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.catch(() => null).then(() => (this.store.withRunLock ? this.store.withRunLock(id, fn) : fn()));
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  /* ---------- department resolution (rules, then Claude) ---------- */

  async resolveDepartments(run, entity, ctx) {
    const departments = ctx.refs.departments || [];
    const values = [...new Set((run.order[entity] || []).map((k) => run.records[k]).filter((r) => r.refs && r.refs.department).map((r) => r.refs.department))];
    const out = {};
    const unknown = [];
    for (const v of values) {
      const exact = T.lookupDepartment(v, departments);
      if (exact.department) { out[v] = { department: exact.department, via: "exact" }; continue; }
      const fixed = T.remediateDepartment(v, departments);
      if (fixed) { out[v] = { department: fixed.department, via: fixed.via }; continue; }
      out[v] = { department: null };
      if (!isPlaceholder(v)) unknown.push(v);
    }
    const ai = this.getAiDepartmentResolver();
    if (ai && unknown.length) {
      try {
        const res = await ai({ values: unknown, departments: departments.map((d) => d.name) });
        for (const v of unknown) {
          const r = res[v];
          out[v].aiTried = true;
          if (r && r.department && r.confidence >= MIN_CONFIDENCE) out[v] = { department: departments.find((d) => d.name === r.department), via: "ai", confidence: r.confidence, reason: r.reason };
          else out[v].reason = r ? r.reason : "no answer";
        }
      } catch (err) {
        this.event(run, "warn", "Claude department matching unavailable: " + err.message);
      }
    }
    run.department_resolution[entity] = out;
  }

  recordWorkspaceMapping(run, recs, ctx) {
    const ws = ctx.refs.workspaces || [];
    if (!ws.length) return;
    const seen = {};
    for (const r of recs) {
      const d = r.refs && r.refs.workspaceDepartment;
      if (!d || seen[d]) continue;
      const c = classifyWorkspace(d, ws, (run.plan && run.plan.workspace_overrides) || {});
      seen[d] = { workspace_id: c.workspaceId, workspace: c.workspaceName, rule: c.rule };
    }
    run.plan.workspace_mapping = seen;
  }

  /* ---------- bookkeeping ---------- */

  fail(rec, type, message, stage) {
    const f = { type, label: FAILURE_TYPES[type].label, severity: FAILURE_TYPES[type].severity, message, stage, at: now(), remediation: null };
    if (rec.resolving) f.retry = true; // raised again while re-running an approved record — not a new failure
    rec.errors.push(f);
    rec.error = f;
    return f;
  }

  remediate(rec, strategy, detail, ok, failure) {
    const entry = { strategy, detail, ok, at: now() };
    if (rec.resolving) entry.retry = true;
    rec.remediation.push(entry);
    rec.remediationAttempted = true;
    if (failure) failure.remediation = entry;
    if (entry.retry) return; // remediationResult reports Zen's own fixes, not the human-approved re-run
    if (ok && rec.remediationResult !== "FAILED") rec.remediationResult = "SUCCESS";
    if (!ok) rec.remediationResult = "FAILED";
  }

  toReview(run, rec, failure, review) {
    rec.status = "HUMAN_REVIEW_REQUIRED";
    rec.review = { ...review, failure_type: failure.type, severity: failure.severity, history: (rec.review && rec.review.history) || [], requested_at: now() };
    return false;
  }

  succeed(run, rec, action) {
    rec.action = action;
    rec.written_in = action === "linked" ? rec.written_in : run.id;
    rec.stage = "write";
    rec.error = null;
    const fixed = rec.remediation.some((r) => r.ok && !r.retry);
    rec.status = rec.resolving ? "RESOLVED" : fixed ? "REMEDIATED" : "SUCCESS";
    if (fixed && !rec.resolving) rec.remediationResult = "SUCCESS";
    return true;
  }

  stageCount(run, entity, stage) {
    return (run.order[entity] || []).filter((k) => run.records[k].stage === stage || run.records[k].status !== "PENDING").length;
  }

  finish(run, status, reason) {
    run.status = status;
    run.status_reason = reason;
    run.finished_at = now();
    this.event(run, status === "COMPLETED" ? "success" : "error", reason);
  }

  event(run, level, message) {
    run.events.push({ at: now(), level, message });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  async load(id) {
    const run = await this.store.getRun(id);
    if (!run) throw new AgentError(404, "Migration not found");
    return run;
  }
}

function classifyApiError(msg) {
  if (/requester/i.test(msg)) return "MISSING_REQUESTER";
  if (/workspace/i.test(msg)) return "INVALID_WORKSPACE";
  if (/department/i.test(msg)) return "INVALID_DEPARTMENT";
  if (/priority/i.test(msg)) return "INVALID_PRIORITY";
  if (/email/i.test(msg)) return "MISSING_EMAIL";
  return "MISSING_REQUIRED_FIELD";
}

function pct(x) { return x == null ? "—" : +(x * 100).toFixed(1) + "%"; }

/** Real counts from the record ledger. */
function summarize(run) {
  const recs = Object.values(run.records);
  const count = (st) => recs.filter((r) => r.status === st).length;
  const done = recs.filter((r) => FINAL.includes(r.status) || r.status === "HUMAN_REVIEW_REQUIRED");
  const per = {};
  for (const e of run.entities) {
    const list = recs.filter((r) => r.entity === e);
    const c = (st) => list.filter((r) => r.status === st).length;
    per[e] = {
      total: list.length, processed: list.filter((r) => FINAL.includes(r.status) || r.status === "HUMAN_REVIEW_REQUIRED").length,
      successful: c("SUCCESS"), remediated: c("REMEDIATED"), resolved: c("RESOLVED"), failed: c("FAILED"), skipped: c("SKIPPED"), human_review: c("HUMAN_REVIEW_REQUIRED"),
      created: list.filter((r) => MIGRATED.includes(r.status) && r.action === "created").length,
      updated: list.filter((r) => MIGRATED.includes(r.status) && r.action === "updated").length,
      linked: list.filter((r) => MIGRATED.includes(r.status) && r.action === "linked").length,
    };
  }
  const migrated = count("SUCCESS") + count("REMEDIATED") + count("RESOLVED");
  const processed = done.length;
  const byType = {};
  for (const r of recs) {
    for (const f of r.errors.filter((x) => !x.retry)) {
      const b = byType[f.type] = byType[f.type] || { type: f.type, label: f.label, severity: f.severity, count: 0, auto_fixed: 0, human: 0, open: 0, examples: [] };
      b.count++;
      if (f.remediation && f.remediation.ok) b.auto_fixed++;
      else if (r.status === "RESOLVED") b.human++;
      else if (r.status === "HUMAN_REVIEW_REQUIRED" || r.status === "SKIPPED" || r.status === "FAILED") b.open++;
      if (b.examples.length < 3) b.examples.push(r.sourceId);
    }
  }
  return {
    total: recs.length, processed, migrated,
    successful: count("SUCCESS"), remediated: count("REMEDIATED"), resolved: count("RESOLVED"),
    failed: count("FAILED"), skipped: count("SKIPPED"), human_review: count("HUMAN_REVIEW_REQUIRED"),
    progress: recs.length ? processed / recs.length : 0,
    success_rate: processed ? migrated / processed : null,
    per_entity: per,
    failures_by_type: Object.values(byType).sort((a, b) => b.count - a.count),
  };
}

module.exports = { MigrationAgentEngine, AgentError, summarize, ENTITIES, ENTITY_ORDER, FAILURE_TYPES, MIGRATED };
