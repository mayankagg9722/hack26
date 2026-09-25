/* MockFreshserviceTargetAdapter — stands in for Freshservice in demo mode.
   Behaves like the API where it matters for a migration: validates each
   payload, rejects bad ones, returns deterministic API failures (429/503/500), stores what
   was written (JSON file) so it can be read back and reconciled.
   Same schema and workspaces as the live adapter. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { TargetAdapter } = require("./TargetAdapter");
const { FRESHSERVICE_TICKET_FIELDS, FRESHSERVICE_DEFAULT_WORKSPACES } = require("./freshserviceSchema");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
/* Deterministic API failures, keyed by a hash of the legacy ticket id:
     < 1.5%   429 rate limit on the first attempt
     1.5–2.2% 503 unavailable on attempts 1–2 (succeeds on the 3rd)
     2.2–2.6% 500 on attempts 1–3 — outlasts automatic retries, clears for a
              later (human-approved) retry, like an outage that ends */
const API_FAILURES = [
  { upTo: 0.015, code: "429", message: "Rate limit exceeded — retry after 1s", failAttempts: 1 },
  { upTo: 0.022, code: "503", message: "Service temporarily unavailable", failAttempts: 2 },
  { upTo: 0.026, code: "500", message: "Internal server error while creating ticket", failAttempts: 3 },
];
const DEPARTMENTS = FRESHSERVICE_TICKET_FIELDS.find((f) => f.key === "department").values;

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

class MockFreshserviceTargetAdapter extends TargetAdapter {
  /**
   * @param {object} meta
   * @param {object} [opts]
   * @param {string} [opts.file]       storage file (default <tmp>/zen-data/mock-freshservice.json)
   * @param {number} [opts.latencyMs]  simulated API latency per record
   */
  constructor(meta, opts = {}) {
    super({ ...meta, mode: "mock" });
    this.file = opts.file || path.join(process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data"), "mock-freshservice.json");
    this.latencyMs = opts.latencyMs != null ? opts.latencyMs : Number(process.env.MOCK_TARGET_LATENCY_MS || 3);
  }

  async testConnection() {
    return { ok: true, message: "Demo mode — simulated Freshservice workspace." };
  }

  async getSchema() {
    return FRESHSERVICE_TICKET_FIELDS;
  }

  async getWorkspaces() {
    return FRESHSERVICE_DEFAULT_WORKSPACES;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      return { next_id: 1001, tickets: {} };
    }
  }

  persist(db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, this.file);
  }

  /* Same validation Freshservice applies to POST /api/v2/tickets. */
  reject(p) {
    const workspaces = new Set(FRESHSERVICE_DEFAULT_WORKSPACES.map((w) => String(w.id)));
    if (!p.email || !EMAIL_RE.test(p.email)) return "email: It should be a valid email address";
    if (!p.subject) return "subject: It should not be blank";
    if (!p.description) return "description: It should not be blank";
    if (![1, 2, 3, 4].includes(p.priority)) return "priority: It should be one of these values: '1,2,3,4'";
    if (![2, 3, 4, 5].includes(p.status)) return "status: It should be one of these values: '2,3,4,5'";
    if (p.type && !["Incident", "Service Request"].includes(p.type)) return "type: It should be one of these values: 'Incident,Service Request'";
    if (p.workspace_id != null && !workspaces.has(String(p.workspace_id))) return "workspace_id: Workspace does not exist";
    if (p.department != null && !DEPARTMENTS.includes(p.department)) return "department: Department does not exist";
    if (!p.requester || !p.requester.employee_id) return "requester.employee_id: It should not be blank";
    return null;
  }

  apiFailure(p, attempt) {
    const key = String((p.custom_fields && p.custom_fields.legacy_ticket_id) || p.email || "");
    const h = crypto.createHash("md5").update(key).digest().readUInt32BE(0) / 0xffffffff;
    const f = API_FAILURES.find((x) => h < x.upTo);
    return f && attempt <= f.failAttempts ? f : null;
  }

  async writeRecords(records, { runId = null, attempt = 1 } = {}) {
    await sleep(this.latencyMs * records.length);
    const db = this.load();
    const results = records.map((p) => {
      const fail = this.apiFailure(p, attempt);
      if (fail) return { ok: false, error: { code: fail.code, message: fail.message, retryable: true } };
      const why = this.reject(p);
      if (why) return { ok: false, error: { code: "400", message: "Validation failed: " + why, retryable: false } };
      const id = db.next_id++;
      db.tickets[id] = { ...p, id, created_at: new Date().toISOString(), migration_run_id: runId };
      return { ok: true, id };
    });
    this.persist(db);
    return results;
  }

  /** Demo only: forget everything written, so the next demo starts from an empty target. */
  async reset() {
    const before = Object.keys(this.load().tickets).length;
    this.persist({ next_id: 1001, tickets: {} });
    return before;
  }

  async readRecords(ids) {
    const db = this.load();
    return ids.map((id) => db.tickets[id]).filter(Boolean);
  }

  async findRequesterByEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return null;
    const hit = Object.values(this.load().tickets).find((t) => t.email === e && t.requester && t.requester.employee_id);
    return hit ? { employee_id: hit.requester.employee_id, name: hit.requester.name || null } : null;
  }

  async countRecords({ runId = null, workspaceId = null } = {}) {
    return Object.values(this.load().tickets).filter((t) =>
      (runId == null || t.migration_run_id === runId) && (workspaceId == null || String(t.workspace_id) === String(workspaceId))
    ).length;
  }
}

module.exports = { MockFreshserviceTargetAdapter };
