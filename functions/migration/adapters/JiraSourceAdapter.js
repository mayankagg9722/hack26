/* JiraSourceAdapter — reads Jira Service Management issues via the Jira
   Cloud REST API v3 and normalises them into Zen records.
   Enabled when JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set;
   otherwise the registry falls back to MockSourceAdapter. */

const { SourceAdapter } = require("./SourceAdapter");
const { ZEN_RECORD_FIELDS } = require("../schema");
const { nativeSchema, nativeFieldMap } = require("../demoData");

const ISSUE_FIELDS = ["summary", "description", "issuetype", "priority", "status", "created", "reporter", "labels"];
// Same column names as a Jira CSV export — shared with the Jira demo profile
const JIRA_ZEN_TO_NATIVE = Object.fromEntries(Object.entries(nativeFieldMap("jira")).map(([n, z]) => [z, n]));

/* Atlassian Document Format → plain text */
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  const inner = (node.content || []).map(adfToText).join(node.type === "doc" ? "\n" : "");
  return node.type === "paragraph" ? inner + "\n" : inner;
}

class JiraSourceAdapter extends SourceAdapter {
  /**
   * @param {object} meta see SourceAdapter
   * @param {object} config
   * @param {string} config.baseUrl   e.g. https://acme.atlassian.net
   * @param {string} config.email
   * @param {string} config.apiToken
   * @param {string} [config.jql]
   */
  constructor(meta, { baseUrl, email, apiToken, jql = "ORDER BY created ASC" }) {
    super({ ...meta, mode: "live" });
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(email + ":" + apiToken).toString("base64");
    this.jql = jql;
  }

  async request(path, init = {}) {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("Jira " + res.status + ": " + text.slice(0, 200));
    }
    return res.json();
  }

  async testConnection() {
    try {
      const me = await this.request("/rest/api/3/myself");
      return { ok: true, message: "Connected to Jira as " + (me.displayName || me.emailAddress || "API user") + "." };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getSchema() {
    return ZEN_RECORD_FIELDS;
  }

  async countRecords() {
    try {
      const data = await this.request("/rest/api/3/search/approximate-count", {
        method: "POST",
        body: JSON.stringify({ jql: this.jql }),
      });
      return typeof data.count === "number" ? data.count : null;
    } catch (err) {
      return null;
    }
  }

  async fetchRecords({ cursor = null, limit = 50 } = {}) {
    const params = new URLSearchParams({
      jql: this.jql,
      maxResults: String(Math.min(limit, 100)),
      fields: ISSUE_FIELDS.join(","),
    });
    if (cursor) params.set("nextPageToken", cursor);
    const data = await this.request("/rest/api/3/search/jql?" + params.toString());
    return {
      records: (data.issues || []).map((issue) => this.toZenRecord(issue)),
      nextCursor: data.nextPageToken || null,
    };
  }

  async getRawSchema() {
    return nativeSchema("jira");
  }

  async fetchRawRecords(opts = {}) {
    const params = new URLSearchParams({
      jql: this.jql,
      maxResults: String(Math.min(opts.limit || 50, 100)),
      fields: ISSUE_FIELDS.join(","),
    });
    if (opts.cursor) params.set("nextPageToken", opts.cursor);
    const data = await this.request("/rest/api/3/search/jql?" + params.toString());
    return {
      records: (data.issues || []).map((issue) => this.toRawRecord(issue)),
      nextCursor: data.nextPageToken || null,
    };
  }

  toRawRecord(issue) {
    const zen = this.toZenRecord(issue);
    const raw = {};
    for (const [zenKey, nativeKey] of Object.entries(JIRA_ZEN_TO_NATIVE)) raw[nativeKey] = zen[zenKey];
    raw.Labels = ((issue.fields && issue.fields.labels) || []).join(" ");
    return raw;
  }

  toZenRecord(issue) {
    const f = issue.fields || {};
    const reporter = f.reporter || {};
    const description = adfToText(f.description).trim();
    return {
      employeeId: reporter.accountId || "",
      employeeName: reporter.displayName || "",
      email: reporter.emailAddress || "",
      department: "", // not a standard Jira field; map from a custom field once known
      ticketId: issue.key,
      ticketType: (f.issuetype && f.issuetype.name) || "",
      priority: (f.priority && f.priority.name) || "",
      description: description || f.summary || "",
      status: (f.status && f.status.name) || "",
      createdDate: f.created ? new Date(f.created).toISOString() : "",
    };
  }
}

module.exports = { JiraSourceAdapter, adfToText };
