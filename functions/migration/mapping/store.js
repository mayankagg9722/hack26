/* Approved-mapping store. One record per (source, target) pair holding the
   admin's field decisions and workspace overrides, so the next run with the
   same pair reuses them instead of rediscovering.

   JsonFileMappingStore persists to a JSON file (default: <tmp>/zen-data).
   That survives emulator restarts locally; on Cloud Functions the disk is
   per-instance and temporary, so production should swap in a Firestore-backed
   store implementing the same get/save/remove methods. */

const fs = require("fs");
const os = require("os");
const path = require("path");

class JsonFileMappingStore {
  constructor(file = path.join(process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data"), "mappings.json")) {
    this.file = file;
  }

  static key(sourceId, targetId) {
    return sourceId + "->" + targetId;
  }

  readAll() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      return {};
    }
  }

  writeAll(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  async get(sourceId, targetId) {
    return this.readAll()[JsonFileMappingStore.key(sourceId, targetId)] || null;
  }

  /**
   * @param {object} record  { sourceId, targetId, fields, workspaceRules }
   * @returns {Promise<object>} stored record with version + approvedAt
   */
  async save(record) {
    const all = this.readAll();
    const key = JsonFileMappingStore.key(record.sourceId, record.targetId);
    const prev = all[key];
    const stored = {
      ...record,
      version: prev ? (prev.version || 0) + 1 : 1,
      approvedAt: new Date().toISOString(),
    };
    all[key] = stored;
    this.writeAll(all);
    return stored;
  }

  async remove(sourceId, targetId) {
    const all = this.readAll();
    const key = JsonFileMappingStore.key(sourceId, targetId);
    const existed = Boolean(all[key]);
    delete all[key];
    this.writeAll(all);
    return existed;
  }
}

module.exports = { JsonFileMappingStore };
