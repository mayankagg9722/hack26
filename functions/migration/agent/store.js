/* Persistence for the migration agent: runs and generated mappings (JSON
   file, like the other Zen stores; swap for Firestore in production). */

const fs = require("fs");
const os = require("os");
const path = require("path");

function dataDir() {
  return process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data");
}

class AgentStore {
  constructor(file = path.join(dataDir(), "agent.json")) { this.file = file; }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return { runs: {}, mappings: {} }; }
  }
  write(d) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(d));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  async getRun(id) { return this.read().runs[id] || null; }
  async saveRun(run) { const d = this.read(); d.runs[run.id] = run; this.write(d); return run; }
  async listRuns() { return Object.values(this.read().runs).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); }
  async getMapping(id) { return this.read().mappings[id] || null; }
  async saveMapping(m) { const d = this.read(); d.mappings[m.mappingId] = m; this.write(d); return m; }
  async latestMapping(pair) {
    return Object.values(this.read().mappings).filter((m) => m.pair === pair).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
  }
  async clear() { const n = Object.keys(this.read().runs).length; this.write({ runs: {}, mappings: {} }); return n; }

  /* Cross-process lock per run (mkdir is atomic). The Functions emulator runs
     overlapping requests in separate workers, so an in-memory lock alone is
     not enough. A lock older than staleMs is treated as abandoned. */
  async withRunLock(id, fn, { waitMs = 15000, staleMs = 60000 } = {}) {
    const dir = path.join(path.dirname(this.file), "locks", String(id).replace(/[^\w-]/g, "_") + ".lock");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { fs.mkdirSync(dir); break; } catch (err) {
        if (err.code !== "EEXIST") throw err;
        try { if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) { fs.rmdirSync(dir); continue; } } catch (e) { continue; }
        if (Date.now() > deadline) throw Object.assign(new Error("The migration is busy — try again in a moment"), { status: 409 });
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try { return await fn(); } finally { try { fs.rmdirSync(dir); } catch (e) { /* already released */ } }
  }
}

module.exports = { AgentStore };
