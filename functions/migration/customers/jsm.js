/* JSM customer integration — the only place that talks to Jira Service
   Management for the customer flow. Live mode needs server-side env config;
   without it the simulated JSM (same interface) is used for demos.

   Live configuration (env, server-side only):
     JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN   credentials (shared with the Jira source adapter)
     JSM_PROJECT_ID                              default project / service desk (Admin can pick another)
     JSM_CREATE_CUSTOMER_PATH                    default /rest/servicedeskapi/customer (POST)
     JSM_ADD_PROJECT_CUSTOMERS_PATH              TODO — confirm from the JSM API contract, e.g. with {projectId}
     JSM_LIST_PROJECT_CUSTOMERS_PATH             TODO — confirm from the JSM API contract, e.g. with {projectId}
   Note: GET /rest/servicedeskapi/customer returns 405 and is deliberately not used. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

class IntegrationError extends Error {
  /** @param {string} message @param {{code?: string, status?: number, retryable?: boolean, blocking?: boolean, duplicate?: boolean}} [info] */
  constructor(message, info = {}) {
    super(message);
    Object.assign(this, { code: info.code || "error", status: info.status || null, retryable: Boolean(info.retryable), blocking: Boolean(info.blocking), duplicate: Boolean(info.duplicate) });
  }
}

function dataDir() {
  return process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data");
}
function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/* ---------- live ---------- */

class LiveJsmCustomers {
  constructor(env) {
    this.mode = "live";
    this.baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN).toString("base64");
    this.paths = {
      create: env.JSM_CREATE_CUSTOMER_PATH || "/rest/servicedeskapi/customer",
      addToProject: env.JSM_ADD_PROJECT_CUSTOMERS_PATH || null, // TODO: from the JSM API contract
      listProject: env.JSM_LIST_PROJECT_CUSTOMERS_PATH || null, // TODO: from the JSM API contract
    };
    this.defaultProject = env.JSM_PROJECT_ID || null;
  }

  async request(method, p, body) {
    let res;
    try {
      res = await fetch(this.baseUrl + p, {
        method,
        headers: { Authorization: this.auth, Accept: "application/json", "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new IntegrationError("Could not reach JSM: " + err.message, { code: "network", retryable: true });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 200) }; }
    if (!res.ok) {
      const msg = (data && (data.errorMessage || (data.errorMessages && data.errorMessages.join("; ")) || data.message)) || "HTTP " + res.status;
      throw new IntegrationError("JSM " + res.status + ": " + msg, {
        code: String(res.status), status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        blocking: res.status === 401 || res.status === 403,
        duplicate: res.status === 400 && /already|exists|in use/i.test(msg),
      });
    }
    return data;
  }

  missingConfig() {
    const missing = [];
    if (!this.paths.addToProject) missing.push("JSM_ADD_PROJECT_CUSTOMERS_PATH");
    if (!this.paths.listProject) missing.push("JSM_LIST_PROJECT_CUSTOMERS_PATH");
    return missing;
  }

  async verify() {
    await this.request("GET", "/rest/api/3/myself");
    return { ok: true, message: "Connected to JSM" };
  }

  async listProjects() {
    return this.defaultProject ? [{ id: this.defaultProject, name: "Project " + this.defaultProject }] : [];
  }

  /** @returns {Promise<{jsmCustomerId, name, email}>} */
  async createCustomer({ name, email }) {
    const data = await this.request("POST", this.paths.create, { displayName: name, email });
    return { jsmCustomerId: data.accountId, name: data.displayName || name, email: data.emailAddress || email };
  }

  async addCustomersToProject(projectId, customerIds) {
    if (!this.paths.addToProject) {
      throw new IntegrationError("JSM project association endpoint is not configured (set JSM_ADD_PROJECT_CUSTOMERS_PATH from the JSM API contract).", { code: "config", blocking: true });
    }
    // TODO: request body shape to be confirmed against the JSM API contract
    await this.request("POST", this.paths.addToProject.replace("{projectId}", encodeURIComponent(projectId)), { accountIds: customerIds });
    return { associated: customerIds.length };
  }

  /** @returns {Promise<Array<{jsmCustomerId, name, email, projectId}>>} */
  async listProjectCustomers(projectId) {
    if (!this.paths.listProject) {
      throw new IntegrationError("JSM project customer endpoint is not configured (set JSM_LIST_PROJECT_CUSTOMERS_PATH from the JSM API contract).", { code: "config", blocking: true });
    }
    const out = [];
    let start = 0;
    for (let page = 0; page < 200; page++) {
      const sep = this.paths.listProject.includes("?") ? "&" : "?";
      // TODO: pagination parameters to be confirmed against the JSM API contract
      const data = await this.request("GET", this.paths.listProject.replace("{projectId}", encodeURIComponent(projectId)) + sep + "start=" + start + "&limit=50");
      const values = (data && (data.values || data.customers)) || [];
      for (const c of values) out.push(normalizeJsmCustomer(c, projectId));
      if (!values.length || data.isLastPage !== false) break;
      start += values.length;
    }
    return out;
  }
}

/** JSM customer payload → Zen customer model. */
function normalizeJsmCustomer(c, projectId) {
  return {
    jsmCustomerId: String(c.accountId || c.id || ""),
    name: String(c.displayName || c.name || "").trim(),
    email: String(c.emailAddress || c.email || "").trim().toLowerCase(),
    projectId: String(projectId),
  };
}

/* ---------- simulated JSM (demo) ---------- */

class MockJsmCustomers {
  constructor({ latencyMs } = {}) {
    this.mode = "mock";
    this.file = path.join(dataDir(), "mock-jsm.json");
    this.latencyMs = latencyMs != null ? latencyMs : Number(process.env.MOCK_API_LATENCY_MS || 15);
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return { customers: {}, projects: { SD: [], HR: [] } }; }
  }
  save(db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(db));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  missingConfig() { return []; }
  async verify() { await sleep(this.latencyMs); return { ok: true, message: "Demo mode — simulated JSM site" }; }
  async listProjects() {
    return [{ id: "SD", name: "IT Service Desk (SD)" }, { id: "HR", name: "HR Help Center (HR)" }];
  }
  async createCustomer({ name, email }) {
    await sleep(this.latencyMs);
    const db = this.load();
    const e = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new IntegrationError("JSM 400: Enter a valid email address.", { code: "400", status: 400 });
    if (Object.values(db.customers).some((c) => c.emailAddress === e)) {
      throw new IntegrationError("JSM 400: An account already exists for this email.", { code: "400", status: 400, duplicate: true });
    }
    const id = "qm:" + crypto.createHash("md5").update(e).digest("hex").slice(0, 8) + ":" + crypto.randomBytes(3).toString("hex");
    db.customers[id] = { accountId: id, displayName: name, emailAddress: e };
    this.save(db);
    return { jsmCustomerId: id, name, email: e };
  }
  async addCustomersToProject(projectId, customerIds) {
    await sleep(this.latencyMs);
    const db = this.load();
    if (!db.projects[projectId]) throw new IntegrationError("JSM 404: Service desk " + projectId + " not found.", { code: "404", status: 404, blocking: true });
    const unknown = customerIds.filter((id) => !db.customers[id]);
    if (unknown.length) throw new IntegrationError("JSM 400: Unknown customer " + unknown[0] + ".", { code: "400", status: 400 });
    db.projects[projectId] = [...new Set(db.projects[projectId].concat(customerIds))];
    this.save(db);
    return { associated: customerIds.length };
  }
  async listProjectCustomers(projectId) {
    await sleep(this.latencyMs);
    const db = this.load();
    if (!db.projects[projectId]) throw new IntegrationError("JSM 404: Service desk " + projectId + " not found.", { code: "404", status: 404, blocking: true });
    return db.projects[projectId].map((id) => normalizeJsmCustomer(db.customers[id], projectId));
  }
  async reset() {
    const n = Object.keys(this.load().customers).length;
    this.save({ customers: {}, projects: { SD: [], HR: [] } });
    return n;
  }
}

function createJsmCustomers(env = process.env) {
  return env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN ? new LiveJsmCustomers(env) : new MockJsmCustomers();
}

module.exports = { createJsmCustomers, LiveJsmCustomers, MockJsmCustomers, normalizeJsmCustomer, IntegrationError };
