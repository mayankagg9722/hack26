/* Minimal MCP client (JSON-RPC over Streamable HTTP) for the Freshservice
   Product MCP: https://{domain}.freshservice.com/mcp
   Auth per the Freshworks hackathon cookbook: API key in the Authorization
   header (OAuth 2.0 + DCR is the other documented option).

   Only what Zen needs: initialize, tools/list, tools/call. Tool names are
   discovered from tools/list at runtime — Zen never assumes a tool exists.
   Not yet exercised against a live tenant. */

const PROTOCOL_VERSION = "2025-06-18";

class McpError extends Error {}

function parseSse(text, id) {
  let found = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg.id === id) found = msg;
    } catch (e) { /* keep-alive or partial event */ }
  }
  return found;
}

class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {Object<string,string>} opts.headers  auth headers (never logged)
   * @param {Function} [opts.fetchImpl]
   */
  constructor({ url, headers, fetchImpl, timeoutMs = 20000 }) {
    this.url = url;
    this.headers = headers;
    this.fetch = fetchImpl || fetch;
    this.timeoutMs = timeoutMs;
    this.session = null;
    this.nextId = 1;
    this.ready = null;
    this.tools = null;
  }

  async rpc(method, params, { notify = false } = {}) {
    const id = notify ? undefined : this.nextId++;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.headers,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, ...(id != null ? { id } : {}), ...(params ? { params } : {}) }), signal: ctrl.signal });
    } catch (err) {
      throw new McpError("MCP request failed: " + err.message);
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers && res.headers.get && res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await res.text();
    if (!res.ok) throw new McpError("MCP " + res.status + ": " + text.slice(0, 200));
    const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    const msg = type.includes("text/event-stream") ? parseSse(text, id) : JSON.parse(text);
    if (!msg) throw new McpError("MCP: no response for " + method);
    if (msg.error) throw new McpError("MCP " + method + ": " + (msg.error.message || JSON.stringify(msg.error)));
    return msg.result;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "zen-migration-agent", version: "1.0.0" } });
        await this.rpc("notifications/initialized", null, { notify: true });
      })().catch((err) => { this.ready = null; throw err; });
    }
    return this.ready;
  }

  async listTools() {
    await this.init();
    if (!this.tools) {
      const out = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await this.rpc("tools/list", cursor ? { cursor } : {});
        out.push(...(r.tools || []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      this.tools = out;
    }
    return this.tools;
  }

  /** First tool whose name matches the pattern, or null. */
  async findTool(re) {
    return (await this.listTools()).find((t) => re.test(t.name)) || null;
  }

  /** Calls a tool; returns structuredContent, or the JSON in its text content. */
  async callTool(name, args = {}) {
    await this.init();
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r.isError) {
      const msg = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      throw new McpError("MCP tool " + name + " failed: " + msg.slice(0, 200));
    }
    if (r.structuredContent) return r.structuredContent;
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    try { return JSON.parse(text); } catch (e) { return { text }; }
  }
}

module.exports = { McpClient, McpError, parseSse };
