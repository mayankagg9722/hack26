/* Persistence for the customer flow (JSON files, same approach as the other
   stores; swap for Firestore in production).
   - CustomerMigrationStore: one document per migration run (state for the UI)
   - EntityMappingStore: source ↔ destination IDs per entity. Customers now;
     tickets / attachments / knowledge articles later reuse the same store. */

const fs = require("fs");
const os = require("os");
const path = require("path");

function dataDir() {
  return process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data");
}

class JsonFile {
  constructor(file, empty) { this.file = file; this.empty = empty; }
  read() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { return JSON.parse(JSON.stringify(this.empty)); } }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(data));
    fs.renameSync(this.file + ".tmp", this.file);
  }
}

class CustomerMigrationStore {
  constructor(file = path.join(dataDir(), "customer-migrations.json")) { this.f = new JsonFile(file, {}); }
  async list() { return Object.values(this.f.read()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); }
  async get(id) { return this.f.read()[id] || null; }
  async save(run) { const all = this.f.read(); all[run.id] = run; this.f.write(all); return run; }
  async clear() { const n = Object.keys(this.f.read()).length; this.f.write({}); return n; }
}

class EntityMappingStore {
  constructor(file = path.join(dataDir(), "entity-mappings.json")) { this.f = new JsonFile(file, { entities: {}, source_ids: {} }); }
  /** destination mapping for a source record, e.g. ("customers", jsmCustomerId) */
  async get(entity, sourceId) { const d = this.f.read(); return ((d.entities[entity] || {})[sourceId]) || null; }
  async set(entity, sourceId, value) {
    const d = this.f.read();
    d.entities[entity] = d.entities[entity] || {};
    d.entities[entity][sourceId] = { ...value, source_id: sourceId, updated_at: new Date().toISOString() };
    this.f.write(d);
  }
  async all(entity) { return Object.values(this.f.read().entities[entity] || {}); }
  /** source-side IDs Zen created (e.g. JSM customer ID by email), so re-runs reuse them */
  async getSourceId(kind, key) { return ((this.f.read().source_ids[kind] || {})[key]) || null; }
  async setSourceId(kind, key, id) {
    const d = this.f.read();
    d.source_ids[kind] = d.source_ids[kind] || {};
    d.source_ids[kind][key] = id;
    this.f.write(d);
  }
  async clear() { const n = Object.keys(this.f.read().entities.customers || {}).length; this.f.write({ entities: {}, source_ids: {} }); return n; }
}

module.exports = { CustomerMigrationStore, EntityMappingStore };
