/* FreshserviceTargetAdapter — talks to the Freshservice REST API v2.
   Enabled when FRESHSERVICE_DOMAIN and FRESHSERVICE_API_KEY are set;
   otherwise the registry falls back to MockFreshserviceTargetAdapter. */

const { TargetAdapter } = require("./TargetAdapter");
const { FRESHSERVICE_TICKET_FIELDS, FRESHSERVICE_DEFAULT_WORKSPACES } = require("./freshserviceSchema");

class FreshserviceTargetAdapter extends TargetAdapter {
  /**
   * @param {object} meta see TargetAdapter
   * @param {object} config
   * @param {string} config.domain  e.g. acme.freshservice.com
   * @param {string} config.apiKey
   */
  constructor(meta, { domain, apiKey }) {
    super({ ...meta, mode: "live" });
    this.baseUrl = "https://" + domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    // Freshservice basic auth: API key as username, any password
    this.auth = "Basic " + Buffer.from(apiKey + ":X").toString("base64");
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
      throw new Error("Freshservice " + res.status + ": " + text.slice(0, 200));
    }
    return res.json();
  }

  async testConnection() {
    try {
      await this.request("/api/v2/tickets?per_page=1");
      return { ok: true, message: "Connected to Freshservice at " + this.baseUrl + "." };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getSchema() {
    return FRESHSERVICE_TICKET_FIELDS;
  }

  /* Freshservice workspaces (GET /api/v2/workspaces). Accounts without the
     workspaces feature fall back to the default set. */
  async getWorkspaces() {
    try {
      const data = await this.request("/api/v2/workspaces");
      const list = (data.workspaces || []).map((w) => ({ id: w.id, name: w.name, primary: Boolean(w.primary) }));
      return list.length ? list : FRESHSERVICE_DEFAULT_WORKSPACES;
    } catch (err) {
      return FRESHSERVICE_DEFAULT_WORKSPACES;
    }
  }

  /* POST /api/v2/tickets per record. Requester details (employee id, name)
     are resolved by Freshservice from the email. Untested against a live
     account — the demo runs on MockFreshserviceTargetAdapter. */
  async writeRecords(records, { runId = null } = {}) {
    const results = [];
    for (const p of records) {
      const body = {
        email: p.email, subject: p.subject, description: p.description, priority: p.priority, status: p.status,
        ...(p.type ? { type: p.type } : {}),
        ...(p.workspace_id != null ? { workspace_id: p.workspace_id } : {}),
        custom_fields: { ...(p.custom_fields || {}), ...(runId ? { zen_migration_run: runId } : {}) },
      };
      try {
        const res = await fetch(this.baseUrl + "/api/v2/tickets", {
          method: "POST",
          headers: { Authorization: this.auth, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) results.push({ ok: true, id: data.ticket && data.ticket.id });
        else results.push({ ok: false, error: { code: String(res.status), message: JSON.stringify(data).slice(0, 300), retryable: res.status === 429 || res.status >= 500 } });
      } catch (err) {
        results.push({ ok: false, error: { code: "network", message: err.message, retryable: true } });
      }
    }
    return results;
  }

  async readRecords(ids) {
    const out = [];
    for (const id of ids) {
      try {
        const data = await this.request("/api/v2/tickets/" + encodeURIComponent(id));
        if (data.ticket) out.push(data.ticket);
      } catch (err) {
        // missing tickets surface as reconciliation gaps
      }
    }
    return out;
  }

  async countRecords() {
    return null; // Freshservice has no cheap filtered count; reconciliation uses readRecords
  }
}

module.exports = { FreshserviceTargetAdapter };
