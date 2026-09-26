/* JSM entity source for the migration agent (list_source_entities + fetch).

   Returns entities in two shapes:
     native      field names exactly as JSM returns them (input to mapping)
     normalized  Zen's vendor-neutral shape (what the engine reasons about)

   Live mode (JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN, server-side only):
     tickets    GET  /rest/api/3/field                      field catalogue
                POST /rest/api/3/search/approximate-count   record count
                GET  /rest/api/3/search/jql                 records (JQL: JIRA_JQL, or project = JSM_PROJECT_KEY)
                JSM_DEPARTMENT_FIELD (optional)             custom field holding the department, e.g. customfield_10050
     customers  project-level customer endpoint via ../customers/jsm.js
                (JSM_LIST_PROJECT_CUSTOMERS_PATH — TODO/config; GET /rest/servicedeskapi/customer returns 405 and is not used)
   Otherwise the demo tenant (./demoTenant.js) is served and labelled MOCK DATA. */

const { LiveJsmCustomers } = require("../customers/jsm");
const { adfToText } = require("../adapters/JiraSourceAdapter");
const { demoJsm } = require("./demoTenant");

const CUSTOMER_FIELDS = [
  { key: "accountId", label: "Account ID", type: "id" },
  { key: "displayName", label: "Display name", type: "string" },
  { key: "emailAddress", label: "Email address", type: "email" },
  { key: "department", label: "Department", type: "string" },
  { key: "jobTitle", label: "Job title", type: "string" },
  { key: "phone", label: "Phone", type: "string" },
  { key: "office", label: "Office", type: "string" },
  { key: "timeZone", label: "Time zone", type: "string" },
];
const TICKET_FIELDS = [
  { key: "key", label: "Issue key", type: "id" },
  { key: "summary", label: "Summary", type: "string" },
  { key: "description", label: "Description", type: "text" },
  { key: "status", label: "Status", type: "enum" },
  { key: "priority", label: "Priority", type: "enum" },
  { key: "reporter", label: "Reporter (customer)", type: "user" },
  { key: "issuetype", label: "Issue type", type: "enum" },
  { key: "department", label: "Department", type: "string" },
  { key: "workspace", label: "Service workspace", type: "string" },
  { key: "created", label: "Created", type: "datetime" },
  { key: "updated", label: "Updated", type: "datetime" },
];

const ENTITY_META = {
  customer: { displayName: "Customers", description: "JSM customers representing employees / requesters", migratesTo: "requester", migratesToLabel: "Freshservice Requesters", order: 1 },
  ticket: { displayName: "Tickets", description: "JSM service tickets", migratesTo: "ticket", migratesToLabel: "Freshservice Tickets", order: 2 },
};

function normalizeCustomer(n) {
  return {
    entityType: "customer", id: n.accountId, name: n.displayName || "", email: (n.emailAddress || "").toLowerCase(),
    department: n.department || null, jobTitle: n.jobTitle || null,
  };
}
function normalizeTicket(n) {
  const r = n.reporter || {};
  return {
    entityType: "ticket", id: n.key, summary: n.summary || "", description: n.description || "", status: n.status || "",
    priority: n.priority || "", requester: { id: r.accountId || null, name: r.displayName || "", email: (r.emailAddress || "").toLowerCase() },
    department: n.department || null, createdAt: n.created || null, updatedAt: n.updated || null,
  };
}

/* ---------- demo ---------- */

class MockJsmSource {
  constructor() {
    this.mode = "mock";
    this.system = "Jira Service Management";
    this.via = "Demo data";
  }
  async discover() {
    const { customers, tickets } = demoJsm();
    return [
      entity("customer", CUSTOMER_FIELDS, customers.length, "demo", customers[0]),
      entity("ticket", TICKET_FIELDS, tickets.length, "demo", toTicketNative(tickets[0])),
    ];
  }
  async fetch(entityType) {
    const { customers, tickets } = demoJsm();
    if (entityType === "customer") return customers.map((c) => wrap("customer", c.accountId, stripDemo(c), c._demo));
    if (entityType === "ticket") return tickets.map((t) => wrap("ticket", t.key, toTicketNative(t), t._demo));
    return [];
  }
}

function toTicketNative(t) {
  return {
    key: t.key, summary: t.summary, description: t.description, status: t.status, priority: t.priority,
    reporter: t.reporter, issuetype: t.issueType, department: t.department, workspace: t.workspace,
    created: t.createdAt, updated: t.updatedAt,
  };
}
function stripDemo(o) {
  const { _demo, ...rest } = o; // eslint-disable-line no-unused-vars
  return rest;
}
function wrap(entityType, id, native, demo) {
  const out = { entityType, id, native, normalized: entityType === "customer" ? normalizeCustomer(native) : normalizeTicket(native) };
  if (demo) Object.defineProperty(out, "demo", { value: demo, enumerable: false });
  return out;
}
function entity(type, fields, count, schemaSource, sample, extra = {}) {
  return {
    entityType: type, ...ENTITY_META[type], count, schemaSource,
    fields: fields.map((f) => ({ ...f, sample: sample ? sampleOf(sample[f.key]) : null })),
    status: "ready", ...extra,
  };
}
function sampleOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v.displayName || v.name || null;
  return String(v).slice(0, 60);
}

/* ---------- live ---------- */

class LiveJsmSource {
  constructor(env) {
    this.mode = "live";
    this.system = "Jira Service Management";
    this.via = "Jira Cloud REST API v3";
    this.customers = new LiveJsmCustomers(env);
    this.departmentField = env.JSM_DEPARTMENT_FIELD || null;
    this.projectKey = env.JSM_PROJECT_KEY || null;
    this.projectId = env.JSM_PROJECT_ID || null;
    this.jql = env.JIRA_JQL || (this.projectKey ? "project = " + this.projectKey + " ORDER BY created ASC" : null);
  }
  request(method, p, body) {
    return this.customers.request(method, p, body);
  }

  async discover() {
    return [await this.discoverCustomers(), await this.discoverTickets()];
  }

  async discoverCustomers() {
    const missing = this.customers.missingConfig().filter((k) => k === "JSM_LIST_PROJECT_CUSTOMERS_PATH");
    if (missing.length || !this.projectId) {
      return entity("customer", CUSTOMER_FIELDS.filter((f) => ["accountId", "displayName", "emailAddress", "timeZone"].includes(f.key)), null, "documented", null, {
        status: "needs_config",
        message: "Set " + (missing.length ? missing.join(", ") : "JSM_PROJECT_ID") + " to read customers from the JSM project (TODO: confirm the project-level endpoint from the JSM API contract).",
      });
    }
    try {
      const list = await this.customers.listProjectCustomers(this.projectId);
      const sample = list[0] ? { accountId: list[0].jsmCustomerId, displayName: list[0].name, emailAddress: list[0].email } : null;
      return entity("customer", CUSTOMER_FIELDS.filter((f) => ["accountId", "displayName", "emailAddress"].includes(f.key)), list.length, "api", sample);
    } catch (err) {
      return entity("customer", CUSTOMER_FIELDS.slice(0, 3), null, "documented", null, { status: "error", message: err.message });
    }
  }

  async discoverTickets() {
    if (!this.jql) {
      return entity("ticket", TICKET_FIELDS, null, "documented", null, { status: "needs_config", message: "Set JSM_PROJECT_KEY (or JIRA_JQL) to choose which JSM tickets to migrate." });
    }
    try {
      const [fields, count, page] = await Promise.all([
        this.request("GET", "/rest/api/3/field"),
        this.request("POST", "/rest/api/3/search/approximate-count", { jql: this.jql }).catch(() => ({ count: null })),
        this.searchPage(null, 1),
      ]);
      const names = new Map((fields || []).map((f) => [f.id, f.name]));
      const known = TICKET_FIELDS.filter((f) => f.key === "key" || names.has(f.key) || (f.key === "department" && this.departmentField));
      // custom fields that are on this site, so Admins see what else could be mapped
      const custom = (fields || []).filter((f) => f.custom && f.id !== this.departmentField).slice(0, 12)
        .map((f) => ({ key: f.id, label: f.name, type: (f.schema && f.schema.type) || "string" }));
      return entity("ticket", known.concat(custom), typeof count.count === "number" ? count.count : null, "api", page.records[0] ? page.records[0].native : null);
    } catch (err) {
      return entity("ticket", TICKET_FIELDS, null, "documented", null, { status: "error", message: err.message });
    }
  }

  async searchPage(cursor, limit = 100) {
    const fields = ["summary", "description", "status", "priority", "reporter", "issuetype", "created", "updated"];
    if (this.departmentField) fields.push(this.departmentField);
    const params = new URLSearchParams({ jql: this.jql, maxResults: String(limit), fields: fields.join(",") });
    if (cursor) params.set("nextPageToken", cursor);
    const data = await this.request("GET", "/rest/api/3/search/jql?" + params.toString());
    return { records: (data.issues || []).map((i) => this.toTicket(i)), next: data.nextPageToken || null };
  }

  toTicket(issue) {
    const f = issue.fields || {};
    const dept = this.departmentField ? f[this.departmentField] : null;
    const native = {
      key: issue.key, summary: f.summary || "", description: adfToText(f.description).trim(),
      status: (f.status && f.status.name) || "", statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.key : null,
      priority: (f.priority && f.priority.name) || "",
      reporter: f.reporter ? { accountId: f.reporter.accountId, displayName: f.reporter.displayName, emailAddress: f.reporter.emailAddress || "" } : null,
      issuetype: (f.issuetype && f.issuetype.name) || "",
      department: dept && typeof dept === "object" ? dept.value || dept.name || "" : dept || "",
      workspace: null, created: f.created || null, updated: f.updated || null,
    };
    return wrap("ticket", issue.key, native);
  }

  async fetch(entityType, { limit = 5000 } = {}) {
    if (entityType === "customer") {
      if (!this.projectId) throw new Error("JSM_PROJECT_ID is not set");
      const list = await this.customers.listProjectCustomers(this.projectId);
      return list.map((c) => wrap("customer", c.jsmCustomerId, { accountId: c.jsmCustomerId, displayName: c.name, emailAddress: c.email }));
    }
    if (entityType === "ticket") {
      if (!this.jql) throw new Error("JSM_PROJECT_KEY or JIRA_JQL is not set");
      const out = [];
      let cursor = null;
      do {
        const page = await this.searchPage(cursor, 100);
        out.push(...page.records);
        cursor = page.next;
      } while (cursor && out.length < limit);
      return out;
    }
    return [];
  }
}

function createJsmSource(env = process.env) {
  return env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN ? new LiveJsmSource(env) : new MockJsmSource();
}

module.exports = { createJsmSource, MockJsmSource, LiveJsmSource, normalizeCustomer, normalizeTicket, CUSTOMER_FIELDS, TICKET_FIELDS };
