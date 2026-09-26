/* Freshservice target for the migration agent (list_target_entities + writes).

   Connection strategy (Freshworks hackathon cookbook):
     1. Freshservice Product MCP  https://{domain}.freshservice.com/mcp — used for
        discovery reads when FRESHSERVICE_MCP_ENABLED=true and the tenant exposes a
        matching tool (names come from tools/list, never assumed).
     2. Freshservice REST API v2  https://{domain}.freshservice.com/api/v2 — direct
        path for everything else, and the fallback when an MCP call fails.
   Credentials: FRESHSERVICE_DOMAIN + FRESHSERVICE_API_KEY (server-side only).
   Writes to a live tenant additionally need ZEN_ALLOW_LIVE_WRITES=true.
   Without credentials a simulated tenant is used and labelled MOCK DATA. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { IntegrationError } = require("../customers/jsm");
const { McpClient } = require("./mcpClient");
const { FS_DEPARTMENTS, FS_GROUPS, FS_WORKSPACES, demoJsm, preExistingRequesters } = require("./demoTenant");

/* Normalised target fields (key) and the Freshservice API attribute they write (api). */
const REQUESTER_FIELDS = [
  { key: "name", api: "first_name + last_name", label: "Name", type: "string", required: true },
  { key: "email", api: "primary_email", label: "Email", type: "email", required: true },
  { key: "department", api: "department_ids", label: "Department", type: "reference" },
  { key: "job_title", api: "job_title", label: "Job title", type: "string" },
  { key: "phone", api: "work_phone_number", label: "Work phone", type: "string" },
  { key: "location", api: "location_id", label: "Location", type: "reference" },
];
const TICKET_FIELDS = [
  { key: "subject", api: "subject", label: "Subject", type: "string", required: true },
  { key: "description", api: "description", label: "Description", type: "html", required: true },
  { key: "status", api: "status", label: "Status", type: "enum", required: true, values: ["2 Open", "3 Pending", "4 Resolved", "5 Closed"] },
  { key: "priority", api: "priority", label: "Priority", type: "enum", required: true, values: ["1 Low", "2 Medium", "3 High", "4 Urgent"] },
  { key: "requester_id", api: "requester_id", label: "Requester", type: "reference", required: true },
  { key: "type", api: "type", label: "Type", type: "enum", values: ["Incident", "Service Request"] },
  { key: "department_id", api: "department_id", label: "Department", type: "reference" },
  { key: "group_id", api: "group_id", label: "Group", type: "reference" },
  { key: "workspace_id", api: "workspace_id", label: "Workspace", type: "reference" },
  { key: "created_at", api: "created_at", label: "Created at", type: "datetime", readOnly: true },
];
const ORG_FIELDS = {
  department: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "description", label: "Description" }, { key: "head_user_id", label: "Head" }],
  group: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "description", label: "Description" }, { key: "members", label: "Members" }],
  workspace: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "primary", label: "Primary" }, { key: "state", label: "State" }],
};
const API_TO_KEY = {
  requester: { first_name: "name", last_name: null, primary_email: "email", department_ids: "department", job_title: "job_title", work_phone_number: "phone", location_id: "location" },
  ticket: { requester: "requester_id", department: "department_id", group: "group_id", ticket_type: "type", workspace: "workspace_id" },
};
const META = {
  requester: { displayName: "Requesters", description: "Employees who raise tickets (Freshservice requesters)" },
  ticket: { displayName: "Tickets", description: "Service desk tickets" },
  department: { displayName: "Departments", description: "Referenced by requesters and tickets" },
  group: { displayName: "Groups", description: "Agent groups tickets are assigned to" },
  workspace: { displayName: "Workspaces", description: "Where tickets live (Workspace Classification target)" },
};

function entity(type, fields, count, schemaSource, via, extra = {}) {
  return { entityType: type, ...META[type], fields, count, schemaSource, via, status: "ready", ...extra };
}

/* ---------- live ---------- */

class LiveFreshservice {
  constructor(env) {
    this.mode = "live";
    this.system = "Freshservice";
    const domain = env.FRESHSERVICE_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.baseUrl = "https://" + (domain.includes(".") ? domain : domain + ".freshservice.com");
    this.auth = "Basic " + Buffer.from(env.FRESHSERVICE_API_KEY + ":X").toString("base64");
    this.writesAllowed = env.ZEN_ALLOW_LIVE_WRITES === "true";
    this.mcp = env.FRESHSERVICE_MCP_ENABLED === "true"
      ? new McpClient({ url: this.baseUrl + "/mcp", headers: { Authorization: env.FRESHSERVICE_API_KEY } })
      : null;
    this.via = this.mcp ? "Freshservice MCP + REST API v2" : "Freshservice REST API v2";
    this.notes = [];
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
        blocking: res.status === 401 || res.status === 403, duplicate: res.status === 409 || /already exists|has already been taken/i.test(detail),
      });
    }
    return data;
  }

  /* MCP first (when enabled and a matching tool exists), REST otherwise. */
  async read(toolRe, mcpArgs, restPath, pick) {
    if (this.mcp) {
      try {
        const tool = await this.mcp.findTool(toolRe);
        if (tool) {
          const data = await this.mcp.callTool(tool.name, mcpArgs);
          return { data: pick(data), via: "MCP " + tool.name };
        }
      } catch (err) {
        this.notes.push("MCP unavailable (" + err.message.slice(0, 120) + ") — used REST API v2.");
      }
    }
    return { data: pick(await this.request("GET", restPath)), via: "REST GET " + restPath.split("?")[0] };
  }

  async pages(restPath, key, max = 5) {
    const out = [];
    for (let page = 1; page <= max; page++) {
      const sep = restPath.includes("?") ? "&" : "?";
      const data = await this.request("GET", restPath + sep + "per_page=100&page=" + page);
      const list = data[key] || [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async departments() { return (await this.pages("/api/v2/departments", "departments")).map((d) => ({ id: d.id, name: d.name })); }
  async groups() { return (await this.pages("/api/v2/groups", "groups")).map((g) => ({ id: g.id, name: g.name })); }
  async workspaces() {
    try {
      const data = await this.request("GET", "/api/v2/workspaces");
      return (data.workspaces || []).map((w) => ({ id: w.id, name: w.name, primary: Boolean(w.primary) }));
    } catch (err) {
      return []; // account without workspaces: a single space
    }
  }
  async locations() { return (await this.pages("/api/v2/locations", "locations", 2).catch(() => [])).map((l) => ({ id: l.id, name: l.name })); }

  async discover() {
    this.notes = [];
    const results = await Promise.allSettled([
      this.read(/^fetchRequesterFields$/i, {}, "/api/v2/requester_fields", (d) => d.requester_fields || d.fields || []),
      this.read(/^fetchTicketFormFields$/i, {}, "/api/v2/ticket_form_fields", (d) => d.ticket_fields || d.fields || []),
      this.read(/^fetch(Departments|Departments?List)$/i, {}, "/api/v2/departments?per_page=100", (d) => d.departments || []),
      this.read(/^fetchGroups$/i, {}, "/api/v2/groups?per_page=100", (d) => d.groups || []),
      this.read(/^fetchWorkspaces$/i, {}, "/api/v2/workspaces", (d) => d.workspaces || []),
    ]);
    const [req, tkt, dep, grp, wsp] = results;
    const out = [];
    out.push(req.status === "fulfilled"
      ? entity("requester", nativeFields("requester", req.value.data, REQUESTER_FIELDS), null, "api", req.value.via)
      : entity("requester", REQUESTER_FIELDS, null, "documented", "REST", { status: "error", message: req.reason.message }));
    out.push(tkt.status === "fulfilled"
      ? entity("ticket", nativeFields("ticket", tkt.value.data, TICKET_FIELDS), null, "api", tkt.value.via)
      : entity("ticket", TICKET_FIELDS, null, "documented", "REST", { status: "error", message: tkt.reason.message }));
    for (const [type, r] of [["department", dep], ["group", grp], ["workspace", wsp]]) {
      out.push(r.status === "fulfilled"
        ? entity(type, ORG_FIELDS[type], r.value.data.length, "api", r.value.via, { values: r.value.data.slice(0, 20).map((x) => x.name) })
        : entity(type, ORG_FIELDS[type], null, "documented", "REST", { status: "error", message: r.reason.message }));
    }
    return { entities: out, notes: this.notes };
  }

  guardWrite() {
    if (!this.writesAllowed) throw new IntegrationError("Writes to the live Freshservice tenant are disabled. Set ZEN_ALLOW_LIVE_WRITES=true to allow them.", { code: "config", blocking: true });
  }
  async findRequesterByEmail(email) {
    const data = await this.request("GET", "/api/v2/requesters?email=" + encodeURIComponent(email));
    const r = (data.requesters || [])[0];
    return r ? toPerson(r) : null;
  }
  async searchRequestersByName(name) {
    // Freshservice requester filter query: https://api.freshservice.com/#filter_requesters
    const [first, ...rest] = String(name).trim().split(/\s+/);
    const q = rest.length ? "first_name:'" + first + "' AND last_name:'" + rest.join(" ") + "'" : "first_name:'" + first + "'";
    const data = await this.request("GET", "/api/v2/requesters?query=" + encodeURIComponent('"' + q.replace(/"/g, "") + '"'));
    return (data.requesters || []).map(toPerson);
  }
  async createRequester(payload) { this.guardWrite(); const d = await this.request("POST", "/api/v2/requesters", payload); return { id: String(d.requester.id) }; }
  async updateRequester(id, payload) { this.guardWrite(); await this.request("PUT", "/api/v2/requesters/" + encodeURIComponent(id), payload); return { id: String(id) }; }
  async getRequester(id) { const d = await this.request("GET", "/api/v2/requesters/" + encodeURIComponent(id)); return d.requester || null; }
  async createTicket(payload) { this.guardWrite(); const d = await this.request("POST", "/api/v2/tickets", payload); return { id: String(d.ticket.id) }; }
  async updateTicket(id, payload) { this.guardWrite(); await this.request("PUT", "/api/v2/tickets/" + encodeURIComponent(id), payload); return { id: String(id) }; }
  async getTicket(id) { const d = await this.request("GET", "/api/v2/tickets/" + encodeURIComponent(id)); return d.ticket || null; }
}

function toPerson(r) {
  return { id: String(r.id), name: [r.first_name, r.last_name].filter(Boolean).join(" "), email: r.primary_email || null };
}

/** API field list → normalised fields, keeping the documented ones first. */
function nativeFields(type, list, documented) {
  const map = API_TO_KEY[type];
  const seen = new Set();
  const out = [];
  for (const f of list || []) {
    const name = f.name || f.field_name;
    if (!name) continue;
    const key = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : name;
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const doc = documented.find((d) => d.key === key);
    out.push({ ...(doc || { key, api: name, type: f.field_type || f.type || "string" }), label: (doc && doc.label) || f.label || name, required: Boolean((doc && doc.required) || f.required || f.required_for_agents) });
  }
  for (const d of documented) if (!seen.has(d.key) && (d.key === "workspace_id" || d.key === "created_at")) out.push(d);
  return out.length ? out : documented;
}

/* ---------- simulated tenant ---------- */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
function dataDir() { return process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data"); }
function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

/* Behaves like the Freshservice API where a migration notices: validation
   errors, 409 on duplicate emails, and deterministic 429/503/500s for the
   records the demo marks (a 500 outlasts three attempts, then clears). */
class MockFreshservice {
  constructor({ latencyMs } = {}) {
    this.mode = "mock";
    this.system = "Freshservice";
    this.via = "Demo tenant";
    this.file = path.join(dataDir(), "agent-mock-freshservice.json");
    this.latencyMs = latencyMs != null ? latencyMs : Number(process.env.MOCK_API_LATENCY_MS || 4);
  }
  load() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return null; } }
  save(db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(db));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  db() {
    let db = this.load();
    if (!db) {
      db = { next_requester: 70001, next_ticket: 9001, requesters: {}, tickets: {}, attempts: {} };
      for (const p of preExistingRequesters(demoJsm().customers)) {
        const id = String(db.next_requester++);
        const n = p.name.split(" ");
        db.requesters[id] = { id, first_name: n[0], last_name: n.slice(1).join(" "), primary_email: p.email, created_by: "admin (before Zen)" };
      }
      this.save(db);
    }
    return db;
  }
  async departments() { return FS_DEPARTMENTS.map((name, i) => ({ id: 3001 + i, name })); }
  async groups() { return FS_GROUPS.map((name, i) => ({ id: 4001 + i, name })); }
  async workspaces() { return FS_WORKSPACES.map((w) => ({ ...w })); }
  async locations() { return ["London", "Bengaluru", "Austin", "Berlin"].map((name, i) => ({ id: 5001 + i, name })); }

  async discover() {
    await sleep(this.latencyMs);
    const db = this.db();
    const [dep, grp, wsp] = [await this.departments(), await this.groups(), await this.workspaces()];
    return {
      entities: [
        entity("requester", REQUESTER_FIELDS, Object.keys(db.requesters).length, "demo", "Demo tenant"),
        entity("ticket", TICKET_FIELDS, Object.keys(db.tickets).length, "demo", "Demo tenant"),
        entity("department", ORG_FIELDS.department, dep.length, "demo", "Demo tenant", { values: dep.map((d) => d.name) }),
        entity("group", ORG_FIELDS.group, grp.length, "demo", "Demo tenant", { values: grp.map((g) => g.name) }),
        entity("workspace", ORG_FIELDS.workspace, wsp.length, "demo", "Demo tenant", { values: wsp.map((w) => w.name) }),
      ],
      notes: [],
    };
  }

  simulate(db, key, code) {
    if (!code) return;
    db.attempts[key] = (db.attempts[key] || 0) + 1;
    const n = db.attempts[key];
    const limit = code === "429" ? 1 : code === "503" ? 2 : 3;
    if (n > limit) return;
    this.save(db);
    const msg = { 429: "Rate limit exceeded — retry after 1s", 503: "Service temporarily unavailable", 500: "Internal server error" }[code];
    throw new IntegrationError("Freshservice " + code + ": " + msg, { code, status: +code, retryable: true, rateLimited: code === "429" });
  }

  async findRequesterByEmail(email) {
    await sleep(this.latencyMs);
    const e = String(email || "").toLowerCase();
    const r = e && Object.values(this.db().requesters).find((x) => x.primary_email === e);
    return r ? toPerson(r) : null;
  }
  async searchRequestersByName(name) {
    await sleep(this.latencyMs);
    const n = String(name || "").trim().toLowerCase();
    return n ? Object.values(this.db().requesters).filter((r) => [r.first_name, r.last_name].filter(Boolean).join(" ").toLowerCase() === n).map(toPerson) : [];
  }
  async createRequester(p, { simulate, key } = {}) {
    await sleep(this.latencyMs);
    const db = this.db();
    this.simulate(db, "r:" + (key || p.primary_email), simulate);
    const email = String(p.primary_email || "").toLowerCase();
    if (!p.first_name) throw validation("first_name: It should not be blank");
    if (!EMAIL_RE.test(email)) throw validation("primary_email: It should be a valid email address");
    if (Object.values(db.requesters).some((r) => r.primary_email === email)) {
      throw new IntegrationError("Freshservice 409: primary_email: has already been taken", { code: "409", status: 409, duplicate: true });
    }
    const deps = await this.departments();
    for (const d of p.department_ids || []) if (!deps.some((x) => x.id === d)) throw validation("department_ids: Department does not exist");
    const id = String(db.next_requester++);
    db.requesters[id] = { id, ...p, primary_email: email, created_by: "Zen" };
    this.save(db);
    return { id };
  }
  async updateRequester(id, p) {
    await sleep(this.latencyMs);
    const db = this.db();
    if (!db.requesters[id]) throw new IntegrationError("Freshservice 404: Requester not found", { code: "404", status: 404 });
    db.requesters[id] = { ...db.requesters[id], ...p, id, updated_by: "Zen" };
    this.save(db);
    return { id };
  }
  async getRequester(id) { return this.db().requesters[id] || null; }

  async checkTicket(db, p) {
    if (!p.subject) throw validation("subject: It should not be blank");
    if (!p.description) throw validation("description: It should not be blank");
    if (![1, 2, 3, 4].includes(p.priority)) throw validation("priority: It should be one of these values: '1,2,3,4'");
    if (![2, 3, 4, 5].includes(p.status)) throw validation("status: It should be one of these values: '2,3,4,5'");
    if (!p.requester_id || !db.requesters[p.requester_id]) throw validation("requester_id: Requester does not exist");
    if (p.workspace_id != null && !FS_WORKSPACES.some((w) => String(w.id) === String(p.workspace_id))) throw validation("workspace_id: Workspace does not exist");
    if (p.department_id != null && !(await this.departments()).some((d) => d.id === p.department_id)) throw validation("department_id: Department does not exist");
  }
  async createTicket(p, { simulate, key } = {}) {
    await sleep(this.latencyMs);
    const db = this.db();
    this.simulate(db, "t:" + key, simulate);
    await this.checkTicket(db, p);
    const id = String(db.next_ticket++);
    db.tickets[id] = { id, ...p, created_at: new Date().toISOString(), created_by: "Zen" };
    this.save(db);
    return { id };
  }
  async updateTicket(id, p) {
    await sleep(this.latencyMs);
    const db = this.db();
    if (!db.tickets[id]) throw new IntegrationError("Freshservice 404: Ticket not found", { code: "404", status: 404 });
    await this.checkTicket(db, { ...db.tickets[id], ...p });
    db.tickets[id] = { ...db.tickets[id], ...p, id, updated_at: new Date().toISOString() };
    this.save(db);
    return { id };
  }
  async getTicket(id) { return this.db().tickets[id] || null; }

  async reset() {
    const db = this.load();
    const n = db ? Object.keys(db.tickets).length + Object.values(db.requesters).filter((r) => r.created_by === "Zen").length : 0;
    try { fs.unlinkSync(this.file); } catch (e) { /* already clean */ }
    return n;
  }
}

function validation(msg) {
  return new IntegrationError("Freshservice 400: Validation failed — " + msg, { code: "400", status: 400 });
}

function createFreshserviceTarget(env = process.env, opts = {}) {
  return env.FRESHSERVICE_DOMAIN && env.FRESHSERVICE_API_KEY ? new LiveFreshservice(env) : new MockFreshservice(opts);
}

module.exports = { createFreshserviceTarget, LiveFreshservice, MockFreshservice, REQUESTER_FIELDS, TICKET_FIELDS, nativeFields };
