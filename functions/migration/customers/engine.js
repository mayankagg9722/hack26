/* Customer → Employee migration engine (JSM → Freshservice).

   Admin clicks Start (or a schedule fires) → Zen runs this exact sequence:
     1. CREATE CUSTOMER IN JSM            capture the JSM customer ID (credentials are checked first)
     2. MAP CUSTOMER TO JSM PROJECT       associate + confirm, per customer
     3. FETCH CUSTOMER FROM JSM PROJECT   project-level customer endpoint only
     4. CREATE FRESHSERVICE EMPLOYEE      Name → Name, Email → Email; capture the employee ID
     5. STORE JSM ↔ FRESHSERVICE MAPPING  confirm every mapping (each is also saved the moment
                                          its employee is created, so an interrupted run never duplicates)

   Every step works through jsm.js / freshservice.js only. Work is done in
   small, persisted steps (advance()), so the UI can show live progress and a
   scheduler can drive the exact same code. Safe to re-run: existing mappings
   are never recreated. */

const crypto = require("crypto");
const { createJsmCustomers } = require("./jsm");
const { createFreshserviceRequesters, toRequester } = require("./freshservice");
const { demoCustomers, preExistingEmployeeEmails } = require("./demoCustomers");

const ENTITY = "customers";
const BATCH = 10;
const ASSOCIATE_BATCH = 50;
const MAX_ATTEMPTS = 3;
const FINAL = ["MIGRATED", "SKIPPED", "FAILED"];
const STEPS = [
  { key: "jsm_customers", label: "Customers created in JSM", running: "Creating customers in JSM" },
  { key: "associate", label: "Customers mapped to JSM project", running: "Mapping customers to JSM project" },
  { key: "retrieve", label: "Customers retrieved from JSM project", running: "Retrieving customers from JSM project" },
  { key: "employees", label: "Freshservice employees created", running: "Creating Freshservice employees" },
  { key: "mapping", label: "JSM ↔ Freshservice mapping stored", running: "Storing JSM ↔ Freshservice mapping" },
];
const PHASE_STEP = { CREATING_JSM_CUSTOMERS: "jsm_customers", ASSOCIATING: "associate", RETRIEVING: "retrieve", CREATING_EMPLOYEES: "employees", STORING_MAPPING: "mapping" };

class MigrationRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class CustomerMigrationEngine {
  /**
   * @param {object} deps
   * @param {object} deps.store     CustomerMigrationStore
   * @param {object} deps.mappings  EntityMappingStore
   * @param {Function} [deps.jsm]   () => JSM customer service
   * @param {Function} [deps.freshservice]  (run) => Freshservice requester service
   */
  constructor({ store, mappings, jsm, freshservice }) {
    this.store = store;
    this.mappings = mappings;
    this.jsmFactory = jsm || (() => createJsmCustomers());
    this.fsFactory = freshservice || ((run) => createFreshserviceRequesters(process.env, { seedEmails: preExistingEmployeeEmails(run ? run.config.customer_count : 100) }));
  }

  /* ---------- setup ---------- */

  async config() {
    const jsm = this.jsmFactory();
    const fsr = this.fsFactory(null);
    return {
      source: { system: "jsm", name: "Jira Service Management", mode: jsm.mode, missing_config: jsm.missingConfig() },
      target: { system: "freshservice", name: "Freshservice", mode: fsr.mode },
      entity: { source: "Customers", target: "Employees" },
      projects: await jsm.listProjects(),
    };
  }

  /**
   * Create a migration: runs now, or at scheduledAt (same workflow either way).
   * @param {{projectId: string, customerCount?: number, customers?: Array<{name,email}>, scheduledAt?: string, by?: string, now?: Date}} opts
   */
  async create({ projectId, customerCount = 100, customers = null, scheduledAt = null, by = "admin", now = new Date() }) {
    if (!projectId) throw new MigrationRequestError(400, "Choose a JSM project");
    const count = Math.min(Math.max(parseInt(customerCount, 10) || 100, 1), 1000);
    const list = customers || demoCustomers(count);
    let at = null;
    if (scheduledAt) {
      at = new Date(scheduledAt);
      if (isNaN(at)) throw new MigrationRequestError(400, "Invalid schedule time");
      if (at <= now) throw new MigrationRequestError(400, "Pick a time in the future");
    }
    const projects = await this.jsmFactory().listProjects();
    const project = projects.find((p) => String(p.id) === String(projectId)) || { id: projectId, name: projectId };
    const jsm = this.jsmFactory();
    const fsr = this.fsFactory({ config: { customer_count: count } });
    const run = {
      id: "cm_" + crypto.randomBytes(5).toString("hex"),
      entity: ENTITY,
      source: { system: "jsm", name: "Jira Service Management", mode: jsm.mode },
      target: { system: "freshservice", name: "Freshservice", mode: fsr.mode },
      config: { project_id: project.id, project_name: project.name, customer_count: list.length, scheduled_at: at ? at.toISOString() : null, created_by: by },
      status: at ? "SCHEDULED" : "RUNNING",
      phase: at ? null : "CREATING_JSM_CUSTOMERS",
      verified: false,
      steps: STEPS.map((s) => ({ ...s, status: "pending", detail: "" })),
      records: list.map((c, i) => ({
        key: "c" + (i + 1), name: c.name, email: String(c.email || "").trim().toLowerCase(),
        jsm_customer_id: null, jsm_source: null, associated: false, association_confirmed: false, retrieved: false,
        fs_employee_id: null, status: "PENDING", stage: null, message: "", attempts: 0,
      })),
      summary: null,
      error: null,
      retries: 0,
      events: [],
      created_at: now.toISOString(),
      started_at: at ? null : now.toISOString(),
      finished_at: null,
      updated_at: now.toISOString(),
    };
    this.event(run, at ? "Scheduled by " + by + " for " + at.toISOString() + "." : "Started by " + by + ".");
    this.stamp(run, now);
    this.summarise(run);
    await this.store.save(run);
    return run;
  }

  /** Start scheduled migrations whose time has come (called by the scheduler and on list). */
  async startDue(now = new Date()) {
    const started = [];
    for (const run of await this.store.list()) {
      if (run.status === "SCHEDULED" && new Date(run.config.scheduled_at) <= now) {
        run.status = "RUNNING";
        run.phase = "CREATING_JSM_CUSTOMERS";
        run.started_at = now.toISOString();
        this.event(run, "Scheduled migration started.");
        await this.store.save(run);
        started.push(run.id);
      }
    }
    return started;
  }

  /** Make failed records retryable and continue from the earliest step they need. */
  async retryFailed(id, { by = "admin", now = new Date() } = {}) {
    const run = await this.store.get(id);
    if (!run) throw new MigrationRequestError(404, "Migration not found");
    if (run.status === "RUNNING" || run.status === "SCHEDULED") throw new MigrationRequestError(409, "The migration is still running");
    const failed = run.records.filter((r) => r.status === "FAILED");
    if (!failed.length && run.status !== "FAILED") throw new MigrationRequestError(409, "There are no failed customers to retry");
    const order = ["jsm_customers", "associate", "retrieve", "employees", "mapping"];
    let earliest = run.status === "FAILED" ? (PHASE_STEP[run.failed_phase] || "jsm_customers") : "employees";
    for (const r of failed) {
      if (r.stage === "jsm_customers") { r.jsm_customer_id = null; r.associated = false; r.association_confirmed = false; r.retrieved = false; }
      if (r.stage === "associate") { r.associated = false; r.association_confirmed = false; r.retrieved = false; }
      if (r.stage === "retrieve") r.retrieved = false;
      if (r.stage === "mapping") r.fs_employee_id = r.fs_employee_id || null;
      if (order.indexOf(r.stage) > -1 && order.indexOf(r.stage) < order.indexOf(earliest)) earliest = r.stage;
      r.status = "IN_PROGRESS";
      r.message = "Retry requested by " + by;
    }
    run.retries++;
    run.status = "RUNNING";
    run.error = null;
    run.finished_at = null;
    run.phase = Object.keys(PHASE_STEP).find((p) => PHASE_STEP[p] === earliest);
    if (run.status === "FAILED") run.verified = false;
    const from = STEPS.findIndex((s) => s.key === earliest);
    run.steps.forEach((s, i) => { if (i >= from) { s.status = "pending"; } });
    this.event(run, by + " retried " + failed.length + " failed customer(s).");
    this.stamp(run, now);
    this.summarise(run);
    run.updated_at = now.toISOString();
    await this.store.save(run);
    return run;
  }

  /* ---------- execution ---------- */

  /** Do the next unit of work and persist. */
  async advance(id, { now = new Date() } = {}) {
    const run = await this.store.get(id);
    if (!run) throw new MigrationRequestError(404, "Migration not found");
    if (run.status !== "RUNNING") return run;
    const jsm = this.jsmFactory();
    const fsr = this.fsFactory(run);
    try {
      switch (run.phase) {
        case "CREATING_JSM_CUSTOMERS":
          if (!run.verified) await this.verify(run, jsm, fsr);
          await this.createJsmCustomers(run, jsm);
          break;
        case "ASSOCIATING": await this.associate(run, jsm); break;
        case "RETRIEVING": await this.retrieve(run, jsm); break;
        case "CREATING_EMPLOYEES": await this.createEmployees(run, fsr); break;
        case "STORING_MAPPING": await this.storeMapping(run, fsr, now); break;
        default: throw new Error("Unknown phase " + run.phase);
      }
    } catch (err) {
      // blocking / system-level failure: stop and say why; records keep their state for a retry
      run.failed_phase = run.phase;
      const step = run.steps.find((s) => s.key === PHASE_STEP[run.phase]);
      if (step) { step.status = "failed"; step.detail = err.message; }
      run.status = "FAILED";
      run.error = err.message;
      run.finished_at = now.toISOString();
      this.event(run, "Migration stopped: " + err.message);
    }
    this.stamp(run, now);
    this.summarise(run);
    run.updated_at = now.toISOString();
    await this.store.save(run);
    return run;
  }

  /** Record when each customer's status last changed (shown as "Last updated"). */
  stamp(run, now) {
    for (const r of run.records) {
      if (r.last_status !== r.status) {
        r.last_status = r.status;
        r.updated_at = now.toISOString();
      }
    }
  }

  step(run, key, status, detail) {
    const s = run.steps.find((x) => x.key === key);
    s.status = status;
    if (detail != null) s.detail = detail;
  }

  active(run) {
    return run.records.filter((r) => !FINAL.includes(r.status));
  }

  fail(run, r, stage, message) {
    r.status = "FAILED";
    r.stage = stage;
    r.message = message;
  }

  /** Before step 1: credentials and configuration must be in place, or nothing is touched. */
  async verify(run, jsm, fsr) {
    this.step(run, "jsm_customers", "running", "Checking JSM and Freshservice access…");
    const missing = jsm.missingConfig();
    if (missing.length) throw Object.assign(new Error("JSM integration needs configuration: " + missing.join(", ") + " (endpoints from the JSM API contract)."), { blocking: true });
    await jsm.verify();
    await fsr.verify();
    run.verified = true;
    run.records.forEach((r) => { if (r.status === "PENDING") r.status = "IN_PROGRESS"; });
    this.event(run, jsm.mode === "mock" ? "Connected to the simulated JSM and Freshservice (demo mode)." : "JSM and Freshservice accepted Zen's credentials.");
  }

  async createJsmCustomers(run, jsm) {
    const todo = this.active(run).filter((r) => !r.jsm_customer_id).slice(0, BATCH);
    for (const r of todo) {
      r.stage = "jsm_customers";
      const known = await this.mappings.getSourceId("jsm_customer_by_email", r.email);
      if (known) { r.jsm_customer_id = known; r.jsm_source = "reused"; continue; }
      try {
        const c = await jsm.createCustomer({ name: r.name, email: r.email });
        r.jsm_customer_id = c.jsmCustomerId;
        r.jsm_source = "created";
        await this.mappings.setSourceId("jsm_customer_by_email", r.email, c.jsmCustomerId);
      } catch (err) {
        if (err.blocking) throw err;
        this.fail(run, r, "jsm_customers", err.duplicate
          ? "Customer already exists in JSM but Zen has no record of its ID — it needs to be linked before it can be migrated."
          : err.message);
      }
    }
    const remaining = this.active(run).filter((r) => !r.jsm_customer_id).length;
    const done = run.records.filter((r) => r.jsm_customer_id).length;
    this.step(run, "jsm_customers", remaining ? "running" : "done",
      done + " of " + run.records.length + " customers in JSM (" + run.records.filter((r) => r.jsm_source === "created").length + " created, " +
      run.records.filter((r) => r.jsm_source === "reused").length + " already there)");
    if (!remaining) { run.phase = "ASSOCIATING"; this.step(run, "associate", "running"); }
  }

  /** Step 2: associate customers with the project and confirm each one before step 3. */
  async associate(run, jsm) {
    const todo = this.active(run).filter((r) => r.jsm_customer_id && !r.association_confirmed).slice(0, ASSOCIATE_BATCH);
    if (todo.length) {
      try {
        await jsm.addCustomersToProject(run.config.project_id, todo.map((r) => r.jsm_customer_id));
        todo.forEach((r) => this.confirmAssociation(run, r));
      } catch (err) {
        if (err.blocking) throw err;
        // the batch failed: associate one by one so only the customers that really fail are marked FAILED
        for (const r of todo) {
          try {
            await jsm.addCustomersToProject(run.config.project_id, [r.jsm_customer_id]);
            this.confirmAssociation(run, r);
          } catch (e) {
            if (e.blocking) throw e;
            this.fail(run, r, "associate", "Could not map to JSM project " + run.config.project_id + ": " + e.message);
          }
        }
      }
    }
    const remaining = this.active(run).filter((r) => r.jsm_customer_id && !r.association_confirmed).length;
    const failed = run.records.filter((r) => r.status === "FAILED" && r.stage === "associate").length;
    this.step(run, "associate", remaining ? "running" : "done",
      run.records.filter((r) => r.association_confirmed).length + " customers mapped to " + run.config.project_name + " and confirmed" + (failed ? " · " + failed + " failed" : ""));
    if (!remaining) { run.phase = "RETRIEVING"; this.step(run, "retrieve", "running"); }
  }

  confirmAssociation(run, r) {
    r.associated = true;
    r.association_confirmed = true; // JSM accepted the association for this customer ID
    r.stage = "associate";
  }

  async retrieve(run, jsm) {
    const list = await jsm.listProjectCustomers(run.config.project_id);
    const byId = new Map(list.map((c) => [c.jsmCustomerId, c]));
    for (const r of this.active(run).filter((x) => x.association_confirmed && !x.retrieved)) {
      const c = byId.get(r.jsm_customer_id);
      r.stage = "retrieve";
      if (!c) { this.fail(run, r, "retrieve", "Not returned by the project's customer list — the project association could not be confirmed."); continue; }
      // the JSM record is the source of truth from here on
      r.retrieved = true;
      r.name = c.name;
      r.email = c.email;
    }
    this.step(run, "retrieve", "done", list.length + " customers returned by " + run.config.project_name + "'s customer list; " + run.records.filter((r) => r.retrieved).length + " matched this migration");
    run.phase = "CREATING_EMPLOYEES";
    this.step(run, "employees", "running");
  }

  async createEmployees(run, fsr) {
    const todo = this.active(run).filter((r) => r.retrieved).slice(0, BATCH);
    for (const r of todo) {
      r.stage = "employees";
      const existing = await this.mappings.get(ENTITY, r.jsm_customer_id);
      if (existing) {
        r.fs_employee_id = existing.fs_employee_id;
        r.status = "SKIPPED";
        r.message = "Already migrated" + (existing.run_id && existing.run_id !== run.id ? " in migration " + existing.run_id : "") + " — no duplicate created.";
        continue;
      }
      const customer = { jsmCustomerId: r.jsm_customer_id, name: r.name, email: r.email };
      try {
        const found = await fsr.findByEmail(r.email);
        if (found) {
          await this.link(run, r, found.id, "linked");
          r.status = "SKIPPED";
          r.message = "Employee already existed in Freshservice — linked to it, no duplicate created.";
          continue;
        }
        let created = null;
        let lastErr = null;
        for (let a = 1; a <= MAX_ATTEMPTS && !created; a++) {
          r.attempts++;
          try {
            created = await fsr.createRequester(toRequester(customer));
          } catch (err) {
            lastErr = err;
            if (err.duplicate) {
              const again = await fsr.findByEmail(r.email);
              if (again) { await this.link(run, r, again.id, "linked"); r.status = "SKIPPED"; r.message = "Employee already existed in Freshservice — linked."; break; }
            }
            if (!err.retryable || err.blocking) break;
          }
        }
        if (r.status === "SKIPPED") continue;
        if (created) {
          await this.link(run, r, created.id, "created");
          r.status = "MIGRATED";
          r.message = r.attempts > 1 ? "Created after " + r.attempts + " attempts (" + lastErr.code + " retried)." : "";
        } else {
          if (lastErr && lastErr.blocking) throw lastErr;
          this.fail(run, r, "employees", lastErr ? lastErr.message : "Unknown error");
        }
      } catch (err) {
        if (err.blocking) throw err;
        this.fail(run, r, "employees", err.message);
      }
    }
    const remaining = this.active(run).filter((r) => r.retrieved).length;
    const s = this.summarise(run);
    this.step(run, "employees", remaining ? "running" : "done", s.migrated + " created, " + s.skipped + " already existed, " + s.failed + " failed");
    if (!remaining) { run.phase = "STORING_MAPPING"; this.step(run, "mapping", "running"); }
  }

  async link(run, r, fsId, how) {
    r.fs_employee_id = fsId;
    await this.mappings.set(ENTITY, r.jsm_customer_id, {
      fs_employee_id: fsId, email: r.email, name: r.name, run_id: run.id, link: how, migrated_at: new Date().toISOString(),
    });
  }

  /** Step 5: every migrated/linked customer must have its JSM → Freshservice mapping stored and its employee present. */
  async storeMapping(run, fsr, now) {
    let problems = 0;
    for (const r of run.records.filter((x) => x.fs_employee_id && x.status !== "FAILED")) {
      let mapped = await this.mappings.get(ENTITY, r.jsm_customer_id);
      if (!mapped) {
        await this.link(run, r, r.fs_employee_id, r.status === "MIGRATED" ? "created" : "linked");
        mapped = await this.mappings.get(ENTITY, r.jsm_customer_id);
      }
      const exists = await fsr.exists(r.fs_employee_id);
      if (!exists || !mapped || String(mapped.fs_employee_id) !== String(r.fs_employee_id)) {
        problems++;
        this.fail(run, r, "mapping", !exists ? "Employee " + r.fs_employee_id + " not found in Freshservice on read-back." : "Mapping could not be stored.");
      }
    }
    // anything still open at this point never made it through an earlier step
    this.active(run).forEach((r) => this.fail(run, r, r.stage || "retrieve", r.message || "Did not complete the migration steps."));
    const s = this.summarise(run);
    const stored = (await this.mappings.all(ENTITY)).filter((m) => run.records.some((r) => r.jsm_customer_id === m.source_id)).length;
    this.step(run, "mapping", "done", problems ? problems + " problem(s) found" : stored + " JSM customer ID → Freshservice employee ID mappings stored and verified");
    run.status = s.failed ? "COMPLETED_WITH_EXCEPTIONS" : "COMPLETED";
    run.phase = null;
    run.finished_at = now.toISOString();
    this.event(run, (s.failed ? "Migration completed with exceptions" : "Migration complete") + ": " + s.migrated + " migrated, " + s.skipped + " skipped, " + s.failed + " failed.");
  }

  summarise(run) {
    const c = (st) => run.records.filter((r) => r.status === st).length;
    run.summary = {
      total: run.records.length, migrated: c("MIGRATED"), skipped: c("SKIPPED"), failed: c("FAILED"),
      pending: c("PENDING"), in_progress: c("IN_PROGRESS"),
    };
    run.summary.done = run.summary.migrated + run.summary.skipped + run.summary.failed;
    return run.summary;
  }

  event(run, message) {
    run.events.push({ at: new Date().toISOString(), message });
    if (run.events.length > 100) run.events.shift();
  }

  /** Scheduler entry point: start due migrations and drive running ones for up to budgetMs. */
  async runScheduled({ budgetMs = 50000, now = () => new Date() } = {}) {
    await this.startDue(now());
    const started = Date.now();
    const ran = [];
    for (const run of (await this.store.list()).filter((r) => r.status === "RUNNING")) {
      let cur = run;
      while (cur.status === "RUNNING" && Date.now() - started < budgetMs) cur = await this.advance(cur.id, { now: now() });
      ran.push({ id: cur.id, status: cur.status });
    }
    return ran;
  }
}

module.exports = { CustomerMigrationEngine, MigrationRequestError, STEPS };
