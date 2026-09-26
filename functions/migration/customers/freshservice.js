/* Freshservice requester (employee) integration for the customer flow.
   Create a Requester: POST /api/v2/requesters (https://api.freshservice.com/#create_a_requester).
   Live mode needs FRESHSERVICE_DOMAIN + FRESHSERVICE_API_KEY (server-side);
   otherwise a simulated Freshservice with the same interface is used. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { IntegrationError } = require("./jsm");

function dataDir() {
  return process.env.ZEN_DATA_DIR || path.join(require("os").tmpdir(), "zen-data");
}
function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Zen customer → Freshservice requester payload: Name → Name, Email → Email.
    (The JSM customer ID reference is kept in Zen's mapping store, not sent.) */
function toRequester(customer) {
  const parts = String(customer.name || "").trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || "",
    last_name: parts.slice(1).join(" "),
    primary_email: customer.email,
  };
}

class LiveFreshserviceRequesters {
  constructor(env) {
    this.mode = "live";
    this.baseUrl = "https://" + env.FRESHSERVICE_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(env.FRESHSERVICE_API_KEY + ":X").toString("base64");
  }
  async request(method, p, body) {
    let res;
    try {
      res = await fetch(this.baseUrl + p, { method, headers: { Authorization: this.auth, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new IntegrationError("Could not reach Freshservice: " + err.message, { code: "network", retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data.errors || []).map((e) => (e.field ? e.field + ": " : "") + e.message).join("; ") || data.description || data.message || "HTTP " + res.status;
      throw new IntegrationError("Freshservice " + res.status + ": " + detail, {
        code: String(res.status), status: res.status, retryable: res.status === 429 || res.status >= 500,
        blocking: res.status === 401 || res.status === 403, duplicate: res.status === 409 || /already exists/i.test(detail),
      });
    }
    return data;
  }
  async verify() {
    await this.request("GET", "/api/v2/requesters?per_page=1");
    return { ok: true, message: "Connected to Freshservice" };
  }
  async findByEmail(email) {
    const data = await this.request("GET", "/api/v2/requesters?email=" + encodeURIComponent(email));
    const r = (data.requesters || [])[0];
    return r ? { id: String(r.id), email: r.primary_email } : null;
  }
  async createRequester(payload) {
    const data = await this.request("POST", "/api/v2/requesters", payload);
    return { id: String(data.requester.id) };
  }
  async exists(id) {
    try { await this.request("GET", "/api/v2/requesters/" + encodeURIComponent(id)); return true; } catch (e) { return false; }
  }
}

/* Simulated Freshservice: two employees exist before Zen runs (so the demo
   shows duplicate protection), rejects blank names like the real API, and
   returns one deterministic transient 503 that succeeds on retry. */
class MockFreshserviceRequesters {
  constructor({ latencyMs, seedEmails } = {}) {
    this.mode = "mock";
    this.file = path.join(dataDir(), "mock-freshservice-requesters.json");
    this.latencyMs = latencyMs != null ? latencyMs : Number(process.env.MOCK_API_LATENCY_MS || 15);
    this.seedEmails = seedEmails || [];
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return null; }
  }
  save(db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(db));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  db() {
    let db = this.load();
    if (!db) {
      db = { next_id: 50001, requesters: {}, attempts: {} };
      for (const e of this.seedEmails) {
        const id = String(db.next_id++);
        db.requesters[id] = { id, primary_email: e, first_name: "Existing", last_name: "Employee", created_by: "admin (before Zen)" };
      }
      this.save(db);
    }
    return db;
  }
  async verify() { await sleep(this.latencyMs); this.db(); return { ok: true, message: "Demo mode — simulated Freshservice account" }; }
  async findByEmail(email) {
    await sleep(this.latencyMs);
    const r = Object.values(this.db().requesters).find((x) => x.primary_email === String(email).toLowerCase());
    return r ? { id: r.id, email: r.primary_email } : null;
  }
  async createRequester(p) {
    await sleep(this.latencyMs);
    const db = this.db();
    const key = String(p.primary_email).toLowerCase();
    // deterministic transient failure: ~1% of emails fail their first two attempts
    const bucket = crypto.createHash("md5").update(key).digest().readUInt32BE(0) % 100;
    db.attempts[key] = (db.attempts[key] || 0) + 1;
    if (bucket === 7 && db.attempts[key] <= 2) { this.save(db); throw new IntegrationError("Freshservice 503: Service temporarily unavailable", { code: "503", status: 503, retryable: true }); }
    if (!p.first_name) throw new IntegrationError("Freshservice 400: Validation failed — first_name: It should not be blank", { code: "400", status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(key)) throw new IntegrationError("Freshservice 400: Validation failed — primary_email: It should be a valid email address", { code: "400", status: 400 });
    if (Object.values(db.requesters).some((r) => r.primary_email === key)) {
      throw new IntegrationError("Freshservice 409: A requester with this email already exists", { code: "409", status: 409, duplicate: true });
    }
    const id = String(db.next_id++);
    db.requesters[id] = { id, ...p, primary_email: key, created_by: "Zen" };
    this.save(db);
    return { id };
  }
  async exists(id) { return Boolean(this.db().requesters[id]); }
  async reset() {
    const db = this.load();
    const n = db ? Object.values(db.requesters).filter((r) => r.created_by === "Zen").length : 0;
    try { fs.unlinkSync(this.file); } catch (e) { /* already empty */ }
    return n;
  }
}

function createFreshserviceRequesters(env = process.env, opts = {}) {
  return env.FRESHSERVICE_DOMAIN && env.FRESHSERVICE_API_KEY ? new LiveFreshserviceRequesters(env) : new MockFreshserviceRequesters(opts);
}

module.exports = { createFreshserviceRequesters, LiveFreshserviceRequesters, MockFreshserviceRequesters, toRequester };
