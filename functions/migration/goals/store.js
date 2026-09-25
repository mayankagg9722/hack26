/* Goal store. Same persistence approach as the mapping store: a JSON file
   (default <tmp>/zen-data/goals.json) for local use; swap for Firestore in
   production by implementing list/get/save/remove. */

const fs = require("fs");
const os = require("os");
const path = require("path");

class JsonFileGoalStore {
  constructor(file = path.join(process.env.ZEN_DATA_DIR || path.join(os.tmpdir(), "zen-data"), "goals.json")) {
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
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  async list() {
    return Object.values(this.readAll()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async get(id) {
    return this.readAll()[id] || null;
  }

  async save(goal) {
    const all = this.readAll();
    all[goal.goal_id] = goal;
    this.writeAll(all);
    return goal;
  }

  async remove(id) {
    const all = this.readAll();
    const existed = Boolean(all[id]);
    delete all[id];
    this.writeAll(all);
    return existed;
  }
}

module.exports = { JsonFileGoalStore };
