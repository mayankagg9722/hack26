/* MockFreshserviceTargetAdapter — stands in for Freshservice in demo mode.
   Behaves like the API where it matters for a migration: validates each
   payload, rejects bad ones, returns occasional transient 429s, stores what
   was written (JSON file) so it can be read back and reconciled.
   Same schema and workspaces as the live adapter. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { TargetAdapter } = require("./TargetAdapter");
const { FRESHSERVICE_TICKET_FIELDS, FRESHSERVICE_DEFAULT_WORKSPACES } = require("./freshserviceSchema");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const TRANSIENT_RATE = 0.02; // share of first attempts that hit a rate limit

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
    return null;
  }

  transient(p, attempt) {
    if (attempt > 1) return false;
    const key = String((p.custom_fields && p.custom_fields.legacy_ticket_id) || p.email || "") + "#" + attempt;
    const h = crypto.createHash("md5").update(key).digest().readUInt32BE(0) / 0xffffffff;
    return h < TRANSIENT_RATE;
  }

  async writeRecords(records, { runId = null, attempt = 1 } = {}) {
    await sleep(this.latencyMs * records.length);
    const db = this.load();
    const results = records.map((p) => {
      if (this.transient(p, attempt)) {
        return { ok: false, error: { code: "429", message: "Rate limit exceeded — retry after 1s", retryable: true } };
      }
      const why = this.reject(p);
      if (why) return { ok: false, error: { code: "400", message: "Validation failed: " + why, retryable: false } };
      const id = db.next_id++;
      db.tickets[id] = { ...p, id, created_at: new Date().toISOString(), migration_run_id: runId };
      return { ok: true, id };
    });
    this.persist(db);
    return results;
  }

  async readRecords(ids) {
    const db = this.load();
    return ids.map((id) => db.tickets[id]).filter(Boolean);
  }

  async countRecords({ runId = null, workspaceId = null } = {}) {
    return Object.values(this.load().tickets).filter((t) =>
      (runId == null || t.migration_run_id === runId) && (workspaceId == null || String(t.workspace_id) === String(workspaceId))
    ).length;
  }
}

module.exports = { MockFreshserviceTargetAdapter };
