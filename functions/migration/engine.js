/* MigrationEngine — Zen, the middle of Source → Zen → Target.
   Depends only on the SourceAdapter / TargetAdapter contracts. This stage
   establishes the pipeline (describe), field mapping (suggest / preview)
   and workspace classification; the migration run itself (validate →
   write) is a later milestone. */

const { ZEN_RECORD_FIELDS } = require("./schema");
const { suggestMappings } = require("./mapping/suggest");
const { applyMapping, departmentSourceField } = require("./mapping/apply");
const { classifyWorkspace } = require("./mapping/workspaces");

const SAMPLE_SIZE = 5;
const SCAN_LIMIT = 5000;

const SOURCE_METHODS = ["info", "testConnection", "getSchema", "countRecords", "fetchRecords"];
const TARGET_METHODS = ["info", "testConnection", "getSchema", "writeRecords"];

function assertImplements(adapter, methods, role) {
  if (!adapter) throw new TypeError("MigrationEngine needs a " + role + " adapter");
  const missing = methods.filter((m) => typeof adapter[m] !== "function");
  if (missing.length) {
    throw new TypeError(role + " adapter is missing: " + missing.join(", "));
  }
}

class MigrationEngine {
  /**
   * @param {object} deps
   * @param {object} deps.source  SourceAdapter
   * @param {object} deps.target  TargetAdapter
   */
  constructor({ source, target }) {
    assertImplements(source, SOURCE_METHODS, "source");
    assertImplements(target, TARGET_METHODS, "target");
    this.source = source;
    this.target = target;
  }

  /** Snapshot of the pipeline: both ends' status and schemas. */
  async describe() {
    const [sourceConn, targetConn, sourceSchema, targetSchema, recordCount] = await Promise.all([
      this.source.testConnection(),
      this.target.testConnection(),
      this.source.getSchema(),
      this.target.getSchema(),
      this.source.countRecords(),
    ]);
    return {
      source: { ...this.source.info(), connection: sourceConn, recordCount, schema: sourceSchema },
      zen: { recordModel: ZEN_RECORD_FIELDS },
      target: { ...this.target.info(), connection: targetConn, schema: targetSchema },
      ready: Boolean(sourceConn.ok && targetConn.ok),
    };
  }

  /** Source fields (native names + sample values), target fields, workspaces. */
  async describeMapping() {
    const [rawSchema, page, targetFields, workspaces] = await Promise.all([
      this.source.getRawSchema(),
      this.source.fetchRawRecords({ limit: SAMPLE_SIZE }),
      this.target.getSchema(),
      this.target.getWorkspaces(),
    ]);
    const sourceFields = rawSchema.map((f) => ({
      key: f.key,
      label: f.label || f.key,
      samples: page.records.map((r) => r[f.key]),
    }));
    return { sourceFields, targetFields, workspaces };
  }

  /**
   * Suggest a mapping. Decisions from a saved mapping are reused as-is; only
   * source fields it doesn't cover are rediscovered.
   * @param {object} [opts]
   * @param {object|null} [opts.saved]      stored mapping for this source/target
   * @param {Function|null} [opts.aiSuggest] async ({sourceFields, targetFields}) => suggestions
   */
  async suggestMapping({ saved = null, aiSuggest = null } = {}) {
    const { sourceFields, targetFields, workspaces } = await this.describeMapping();
    const savedByField = {};
    for (const f of (saved && saved.fields) || []) savedByField[f.sourceField] = f;

    const fresh = sourceFields.filter((f) => !savedByField[f.key]);
    let suggestions = [];
    let aiUsed = false;
    let aiError = null;
    if (fresh.length) {
      suggestions = suggestMappings(fresh, targetFields);
      if (aiSuggest) {
        try {
          suggestions = await aiSuggest({ sourceFields: fresh, targetFields });
          aiUsed = true;
        } catch (err) {
          aiError = err.message || String(err);
        }
      }
    }

    // targets already claimed by saved decisions aren't offered again
    const claimed = new Set(
      Object.values(savedByField).filter((f) => f.decision !== "rejected" && f.targetField).map((f) => f.targetField)
    );
    const bySource = Object.fromEntries(suggestions.map((s) => [s.sourceField, s]));
    const rows = sourceFields.map((f) => {
      const kept = savedByField[f.key];
      if (kept) return { ...kept, samples: f.samples, method: "saved" };
      const s = bySource[f.key];
      const target = s.targetField && !claimed.has(s.targetField) ? s.targetField : null;
      return {
        sourceField: f.key,
        samples: f.samples,
        suggestedTarget: target,
        targetField: target,
        confidence: target ? s.confidence : 0,
        reason: s.reason,
        method: s.method,
        decision: "pending",
      };
    });

    return {
      rows,
      targetFields,
      workspaces,
      reused: sourceFields.length - fresh.length,
      discovered: fresh.length,
      aiUsed,
      aiError,
    };
  }

  /**
   * Walk records through the mapping: source record → mapped fields →
   * target payload → workspace. Also classifies every scanned record to give
   * per-department and per-workspace counts.
   * @param {object} opts
   * @param {Array<{sourceField, targetField}>} opts.fields  active mappings
   * @param {Object<string, string|number>} [opts.workspaceRules]  department → workspace id overrides
   * @param {number} [opts.index]  first record to return
   * @param {number} [opts.limit]  records to return
   */
  async previewMapping({ fields, workspaceRules = {}, index = 0, limit = 1 }) {
    const [targetSchema, workspaces, total] = await Promise.all([
      this.target.getSchema(),
      this.target.getWorkspaces(),
      this.source.countRecords(),
    ]);
    const deptField = departmentSourceField(fields);
    const deptCounts = new Map();
    const picked = [];
    let cursor = null;
    let i = 0;
    do {
      const page = await this.source.fetchRawRecords({ cursor, limit: 100 });
      for (const r of page.records) {
        if (i >= index && i < index + limit) picked.push({ i, r });
        const dept = deptField ? String(r[deptField] == null ? "" : r[deptField]) : "";
        deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
        i++;
      }
      cursor = page.nextCursor;
    } while (cursor && i < SCAN_LIMIT);

    const classify = (dept) => classifyWorkspace(dept, workspaces, workspaceRules);
    const departments = [...deptCounts.entries()]
      .map(([value, count]) => ({ value, count, ...classify(value), suggested: classifyWorkspace(value, workspaces).workspaceId }))
      .sort((a, b) => b.count - a.count);
    const distribution = workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      count: departments.filter((d) => String(d.workspaceId) === String(w.id)).reduce((n, d) => n + d.count, 0),
    }));

    const records = picked.map(({ i: idx, r }) => {
      const { mapped, target } = applyMapping(r, fields, targetSchema);
      const dept = deptField ? r[deptField] : "";
      const workspace = { department: dept, departmentField: deptField, ...classify(dept) };
      if (workspace.workspaceId !== null) target.workspace_id = workspace.workspaceId;
      return { index: idx, source: r, mapped, target, workspace };
    });

    return { total, scanned: i, departmentField: deptField, records, departments, distribution, workspaces };
  }

  /**
   * Ticket and unique-employee counts per target workspace, using a mapping
   * to find the department and employee fields. Used to size migration waves.
   */
  async workspaceSummary({ fields, workspaceRules = {} }) {
    const workspaces = await this.target.getWorkspaces();
    const deptField = departmentSourceField(fields);
    const emp = fields.find((f) => f.targetField === "requester.employee_id");
    const empField = emp ? emp.sourceField : null;
    const byWs = new Map(workspaces.map((w) => [String(w.id), { tickets: 0, employees: new Set() }]));
    const cache = new Map();
    let cursor = null;
    let scanned = 0;
    const employeesAll = new Set();
    do {
      const page = await this.source.fetchRawRecords({ cursor, limit: 100 });
      for (const r of page.records) {
        const dept = deptField ? String(r[deptField] == null ? "" : r[deptField]) : "";
        if (!cache.has(dept)) cache.set(dept, classifyWorkspace(dept, workspaces, workspaceRules).workspaceId);
        const bucket = byWs.get(String(cache.get(dept)));
        if (bucket) {
          bucket.tickets++;
          if (empField && r[empField]) bucket.employees.add(r[empField]);
        }
        if (empField && r[empField]) employeesAll.add(r[empField]);
        scanned++;
      }
      cursor = page.nextCursor;
    } while (cursor && scanned < SCAN_LIMIT);
    return {
      scanned,
      departmentField: deptField,
      employeeField: empField,
      totals: { tickets: scanned, employees: empField ? employeesAll.size : null },
      workspaces: workspaces.map((w) => {
        const b = byWs.get(String(w.id));
        return { id: w.id, name: w.name, primary: Boolean(w.primary), tickets: b.tickets, employees: empField ? b.employees.size : null };
      }),
    };
  }
}

module.exports = { MigrationEngine };
