/* Migration run store — JSON file (default <tmp>/zen-data/runs.json), same
   approach as the goal and mapping stores; swap for Firestore in production. */

const fs = require("fs");
const os = require("os");
const path = require("path");

class JsonFileRunStore {
  constructor(file = path.join(process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data"), "runs.json")) {
    this.file = file;
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
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  async list({ goalId = null } = {}) {
    return Object.values(this.readAll())
      .filter((r) => !goalId || r.goal_id === goalId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async get(id) {
    return this.readAll()[id] || null;
  }

  async save(run) {
    const all = this.readAll();
    all[run.run_id] = run;
    this.writeAll(all);
    return run;
  }
}

module.exports = { JsonFileRunStore };
