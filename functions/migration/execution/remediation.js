/* RemediationEngine: decides whether a captured failure can be fixed safely,
   and if so, how. It proposes changes to the source record (or a retry); the
   executor then re-runs the record through the normal pipeline and only a
   successful write counts as resolved.

   Strategies (all deterministic except ai_department):
     normalize_format       emails, DD/MM/YYYY dates, noisy enum values
     swap_mismatched_fields values that landed in each other's columns
     infer_employee_id      from the same employee's other records (by email)
     previous_migration     requester already created in the target by an earlier migration
     infer_email            from the same employee's other records (by ID)
     normalize_department   aliases, abbreviations, typos
     ai_department          Claude maps an unknown department (confidence ≥ 0.8)
     retry_api              retry transient target errors (up to 3 attempts)
   Not safe to fix: duplicates, missing descriptions, placeholder departments,
   employees with no other record, persistent API errors. Those go to human
   review with a log of what Zen tried (failure.attempts) and a recommended
   resolution the human can approve (recommend()). */

const { applyBasicFixes } = require("./fixes");
const { detectSwap } = require("./failures");
const { matchEnum, norm, SYNONYMS } = require("./transform");
const { EMAIL_RE } = require("./validation");
const { MIN_CONFIDENCE } = require("./aiDepartments");

const MAX_ATTEMPTS = 3;
const DEPT_NOISE = /\b(dept|department|team|group|division|unit|ops|the)\b|[.&/,-]/gi;

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

/** Rule-based department normalisation; returns a target department name or null. */
function normalizeDepartment(value, departments) {
  const direct = matchEnum(value, departments);
  if (direct) return { department: direct.name, via: "known alias" };
  const cleaned = String(value || "").replace(DEPT_NOISE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const m = matchEnum(cleaned, departments);
  if (m) return { department: m.name, via: "abbreviation" };
  const n = norm(cleaned);
  for (const d of departments) {
    const group = (SYNONYMS[norm(d)] || []).concat(norm(d));
    // prefix of a known spelling ("Human Res." → humanresources), at least 5 letters
    if (n.length >= 5 && group.some((g) => g.startsWith(n))) return { department: d, via: "abbreviation" };
    // one known token ("Fin & Accts" → fin)
    const tokens = cleaned.toLowerCase().split(" ").map(norm).filter((t) => t.length >= 2);
    if (tokens.some((t) => group.includes(t))) return { department: d, via: "known abbreviation" };
    // typo within 2 edits ("Facilties" → facilities)
    if (n.length >= 6 && group.some((g) => g.length >= 6 && levenshtein(n, g) <= 2)) return { department: d, via: "spelling correction" };
  }
  return null;
}

function isPlaceholder(v) {
  const s = String(v == null ? "" : v).trim();
  return !s || !/[a-z]{2,}/i.test(s) || /^(n\/?a|none|unknown|null|tbd|-+|\?+)$/i.test(s) || /^dept-?\d+$/i.test(s);
}

/** Lookups built from the whole source: who has which email / ID. */
function buildEmployeeIndex(records, fields) {
  const src = (target) => (fields.find((f) => f.targetField === target) || {}).sourceField;
  const idF = src("requester.employee_id");
  const emailF = src("email");
  const deptF = src("department");
  const idsByEmail = new Map();
  const emailsById = new Map();
  const deptsById = new Map();
  for (const r of records) {
    const id = idF ? String(r[idF] || "").trim() : "";
    const email = emailF ? String(r[emailF] || "").trim().toLowerCase() : "";
    const dept = deptF ? String(r[deptF] || "").trim() : "";
    if (id && dept) {
      if (!deptsById.has(id)) deptsById.set(id, new Map());
      deptsById.get(id).set(dept, (deptsById.get(id).get(dept) || 0) + 1);
    }
    if (id && EMAIL_RE.test(email)) {
      if (!idsByEmail.has(email)) idsByEmail.set(email, new Set());
      idsByEmail.get(email).add(id);
      if (!emailsById.has(id)) emailsById.set(id, new Set());
      emailsById.get(id).add(email);
    }
  }
  return { idField: idF, emailField: emailF, deptField: deptF, idsByEmail, emailsById, deptsById };
}

class RemediationEngine {
  /**
   * @param {object} ctx
   * @param {Array} ctx.fields           active mappings
   * @param {Array} ctx.targetSchema
   * @param {object} ctx.employeeIndex   from buildEmployeeIndex
   * @param {Object<string, object>} ctx.aiDepartments  cached Claude answers by value
   * @param {boolean} ctx.aiAvailable
   * @param {Object<string, {employee_id}>} [ctx.previousRequesters]  target lookups by email (earlier migrations)
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.departments = (ctx.targetSchema.find((f) => f.key === "department") || {}).values || [];
  }

  /**
   * Decide how to handle a failure without changing anything.
   * @returns {{fixable: boolean, steps: Array, recommended_action: string, reason?: string}}
   */
  analyze(failure) {
    const attempts = [];
    const tried = (step, result, ok = false) => attempts.push({ step, result, ok });
    if (failure.category === "api_failure") {
      const retryable = failure.write_error && failure.write_error.retryable;
      tried("Source data validation", "Record is valid — the target API returned " + failure.write_error.code, true);
      return retryable
        ? { fixable: true, attempts, steps: [{ strategy: "retry_api" }], recommended_action: "Retry the API request (up to " + MAX_ATTEMPTS + " attempts)" }
        : { fixable: false, attempts, steps: [], recommended_action: "Human review", reason: "The target rejected the record permanently: " + failure.write_error.message };
    }

    const raw = failure.source;
    const steps = [];
    const blockers = [];
    const prev = this.ctx.previousRequesters || {};
    const byField = Object.fromEntries(this.ctx.fields.map((f) => [f.targetField, f.sourceField]));

    for (const issue of failure.issues) {
      if (steps.some((s) => s.covers && s.covers.includes(issue))) continue;
      const t = issue.targetField;
      if (issue.code === "duplicate") {
        tried("Duplicate check", "Ticket " + raw[issue.field] + " was already migrated in this run");
        blockers.push("Ticket " + raw[issue.field] + " already exists in this migration — a person must decide which record is correct.");
      } else if (issue.code === "unmapped_required") {
        tried("Field mapping lookup", issue.message);
        blockers.push(issue.message + " — the field mapping has to be updated.");
      } else if (t === "requester.employee_id" && issue.code === "missing_required") {
        const email = String(raw[byField.email] || "").trim().toLowerCase();
        const mappedSources = new Set(this.ctx.fields.map((f) => f.sourceField));
        const idLike = Object.keys(raw).filter((k) => !mappedSources.has(k) && /^[A-Za-z]{0,6}[-_]?\d{3,}$/.test(String(raw[k] || "")));
        tried("Field mapping lookup", idLike.length ? "Unmapped field " + idLike[0] + " looks like an ID but isn't mapped to Employee ID" : "No other source field holds an employee ID");
        const earlier = prev[email];
        if (earlier && earlier.employee_id) {
          tried("Previous migration mapping", "Requester " + email + " already exists in the target as " + earlier.employee_id, true);
          steps.push({ strategy: "previous_migration", field: issue.field, value: earlier.employee_id, from: email });
          continue;
        }
        tried("Previous migration mapping", "No requester with " + (email || "this email") + " exists in the target yet");
        const ids = this.ctx.employeeIndex.idsByEmail.get(email);
        if (ids && ids.size === 1) {
          tried("Source data validation", "Other tickets from " + email + " carry employee ID " + [...ids][0], true);
          steps.push({ strategy: "infer_employee_id", field: issue.field, value: [...ids][0], from: email });
        } else {
          tried("Source data validation", ids && ids.size > 1 ? ids.size + " different employee IDs use " + email : "No other ticket for " + (email || "this employee") + " in the source");
          tried("Automatic retry", "Not attempted — the record can't be written without an employee ID");
          blockers.push(ids && ids.size > 1
            ? "Several employee IDs share " + email + " — can't choose safely."
            : "Employee ID is missing and cannot be safely inferred: no other record for " + (email || "this employee") + ".");
        }
      } else if (t === "email" && (issue.code === "missing_required" || issue.code === "invalid_email")) {
        const fixed = issue.code === "invalid_email" ? applyBasicFixes(raw, [issue], this.ctx.targetSchema) : { unfixed: [issue] };
        if (!fixed.unfixed.length) {
          tried("Data normalisation", fixed.fixes[0], true);
          steps.push({ strategy: "normalize_format", issue, fix: fixed });
        } else {
          if (issue.code === "invalid_email") tried("Data normalisation", "'" + raw[issue.field] + "' can't be turned into a valid address");
          const id = String(raw[byField["requester.employee_id"]] || "").trim();
          const emails = id ? this.ctx.employeeIndex.emailsById.get(id) : null;
          if (emails && emails.size === 1) {
            tried("Source data validation", "Employee " + id + " uses " + [...emails][0] + " on other tickets", true);
            steps.push({ strategy: "infer_email", field: issue.field, value: [...emails][0], from: id });
          } else {
            tried("Source data validation", id ? "No valid email on file for " + id : "No employee ID to look the email up by");
            blockers.push(id ? "No valid email on file for " + id + " — can't infer one safely." : "Email is missing and there's no employee ID to look it up.");
          }
        }
      } else if (t === "department") {
        const value = raw[issue.field];
        const rule = normalizeDepartment(value, this.departments);
        const ai = this.ctx.aiDepartments[value];
        tried("Known department mapping", rule ? "'" + value + "' → " + rule.department + " (" + rule.via + ")" : "'" + value + "' doesn't match any known department spelling", Boolean(rule));
        if (rule) steps.push({ strategy: "normalize_department", field: issue.field, value: rule.department, via: rule.via });
        else if (isPlaceholder(value)) {
          tried("AI analysis", "Skipped — '" + value + "' is a placeholder, not a department name");
          blockers.push("'" + value + "' is a placeholder, not a department — needs a person to assign one.");
        } else if (ai && ai.department && ai.confidence >= MIN_CONFIDENCE) {
          tried("AI analysis", "Claude: " + ai.department + " (" + Math.round(ai.confidence * 100) + "%)", true);
          steps.push({ strategy: "ai_department", field: issue.field, value: ai.department, confidence: ai.confidence, reason: ai.reason });
        } else if (ai) {
          tried("AI analysis", "Claude suggested " + (ai.department || "nothing") + " at " + Math.round(ai.confidence * 100) + "% — below the 80% bar for automatic changes");
          blockers.push("Claude couldn't map '" + value + "' confidently (" + Math.round(ai.confidence * 100) + "%): " + ai.reason);
        } else {
          tried("AI analysis", this.ctx.aiAvailable ? "No answer for this value" : "AI remediation unavailable");
          blockers.push("'" + value + "' isn't a known department" + (this.ctx.aiAvailable ? "." : " and AI remediation is unavailable."));
        }
      } else if (issue.code === "unrecognized_value") {
        const swap = detectSwap(issue, raw, this.ctx);
        if (swap) {
          tried("Field mapping lookup", "Values in " + swap.a + " and " + swap.b + " belong to each other's fields", true);
          const covered = failure.issues.filter((i) => i.field === swap.a || i.field === swap.b);
          steps.push({ strategy: "swap_mismatched_fields", a: swap.a, b: swap.b, covers: covered });
          continue;
        }
        const fixed = applyBasicFixes(raw, [issue], this.ctx.targetSchema);
        if (!fixed.unfixed.length) steps.push({ strategy: "normalize_format", issue, fix: fixed });
        else blockers.push(issue.message + " — no safe correction.");
      } else if (issue.code === "invalid_date" || issue.code === "invalid_email") {
        const fixed = applyBasicFixes(raw, [issue], this.ctx.targetSchema);
        if (!fixed.unfixed.length) steps.push({ strategy: "normalize_format", issue, fix: fixed });
        else blockers.push(issue.message + " — no safe correction.");
      } else if (issue.code === "missing_required") {
        tried("Source data validation", "No other source field contains a " + (issue.message.split(" is ")[0] || "value").toLowerCase());
        tried("Automatic retry", "Not attempted — the target requires this field");
        blockers.push(issue.message + " and there is no other field to derive it from safely.");
      } else {
        blockers.push(issue.message);
      }
    }

    if (blockers.length) return { fixable: false, attempts, steps, recommended_action: "Human review", reason: blockers.join(" ") };
    return {
      fixable: true,
      attempts,
      steps,
      recommended_action: "Auto-fix: " + steps.map((s) => STRATEGY_LABELS[s.strategy]).filter((v, i, a) => a.indexOf(v) === i).join(", "),
    };
  }

  /**
   * Apply a fixable plan to a copy of the source record.
   * @returns {{record: object, changes: Array<{field, from, to, strategy, detail}>, method: "rule"|"ai"}}
   */
  apply(failure, plan) {
    const record = { ...failure.source };
    const changes = [];
    let method = "rule";
    for (const s of plan.steps) {
      if (s.strategy === "normalize_format") {
        const field = s.issue.field;
        const fixed = applyBasicFixes(record, [s.issue], this.ctx.targetSchema);
        if (!fixed.unfixed.length) {
          changes.push({ field, from: record[field], to: fixed.record[field], strategy: s.strategy, detail: fixed.fixes[0] });
          record[field] = fixed.record[field];
        }
      } else if (s.strategy === "swap_mismatched_fields") {
        const a = record[s.a];
        const b = record[s.b];
        record[s.a] = b;
        record[s.b] = a;
        changes.push({ field: s.a, from: a, to: b, strategy: s.strategy, detail: "Values in " + s.a + " and " + s.b + " were swapped in the source export" });
        changes.push({ field: s.b, from: b, to: a, strategy: s.strategy, detail: "" });
      } else if (["infer_employee_id", "infer_email", "previous_migration"].includes(s.strategy)) {
        changes.push({ field: s.field, from: record[s.field], to: s.value, strategy: s.strategy,
          detail: s.strategy === "infer_employee_id" ? "Same email (" + s.from + ") has employee ID " + s.value + " on other tickets"
            : s.strategy === "previous_migration" ? "Requester " + s.from + " already exists in the target as " + s.value
              : "Employee " + s.from + " uses " + s.value + " on other tickets" });
        record[s.field] = s.value;
      } else if (s.strategy === "normalize_department" || s.strategy === "ai_department") {
        changes.push({ field: s.field, from: record[s.field], to: s.value, strategy: s.strategy,
          detail: s.strategy === "ai_department" ? "Claude (" + Math.round(s.confidence * 100) + "%): " + s.reason : "Recognised as " + s.value + " (" + s.via + ")" });
        record[s.field] = s.value;
        if (s.strategy === "ai_department") method = "ai";
      }
    }
    return { record, changes, method };
  }
}

/* ---------- human review recommendations ---------- */

const REVIEW_GROUPS = {
  "missing_employee_id": "Employee ID is missing and cannot be safely inferred",
  "missing_email": "Email is missing and cannot be inferred",
  "missing_description": "Required description is missing",
  "department_placeholder": "Department is a placeholder",
  "department_uncertain": "Department could not be mapped confidently",
  "duplicate_record": "Possible duplicate ticket",
  "api_failure": "Target API kept failing after automatic retries",
  "invalid_value": "Value can't be corrected automatically",
  "mapping": "Field mapping is incomplete",
};

function provisionalId(raw, emailField) {
  const base = String(raw[emailField] || "employee").split("@")[0].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 12);
  return "PENDING-" + (base || "EMPLOYEE");
}

/**
 * What Zen suggests a human approves, for a failure it couldn't fix safely.
 * @returns {{group, title, action: "retry"|"retry_with_changes"|"skip", summary, changes: Array<{field, label, value, hint}>, needs_input: boolean}}
 */
RemediationEngine.prototype.recommend = function recommend(failure) {
  const raw = failure.source;
  const byTarget = Object.fromEntries(this.ctx.fields.map((f) => [f.targetField, f.sourceField]));
  const labelOf = (t) => (this.ctx.targetSchema.find((f) => f.key === t) || {}).label || t;
  const change = (t, value, hint) => ({ field: byTarget[t], target: t, label: labelOf(t), value, hint });
  const issues = failure.issues || [];
  const has = (pred) => issues.some(pred);
  const out = (group, action, summary, changes = [], needsInput = false) =>
    ({ group, title: REVIEW_GROUPS[group], action, summary, changes, needs_input: needsInput });

  if (failure.target_payload && (failure.category === "api_failure" || (failure.outcome && failure.outcome.error && failure.outcome.error.retryable))) {
    return out("api_failure", "retry", "Retry the write — the " + ((failure.outcome && failure.outcome.error) || failure.write_error).code +
      " error looks transient and may have cleared.");
  }
  if (has((i) => i.code === "duplicate")) {
    const id = raw[byTarget["custom_fields.legacy_ticket_id"]];
    return out("duplicate_record", "skip", "Skip this record — ticket " + id + " was already migrated. Approve Retry only if it is genuinely a different ticket; it will be imported as " + id + "-DUP.",
      [change("custom_fields.legacy_ticket_id", id + "-DUP", "Imported under a new legacy ID so both tickets are kept")]);
  }
  if (has((i) => i.code === "unmapped_required")) {
    return out("mapping", "skip", "Update the field mapping to include the missing field, then run the migration again.");
  }
  const changes = [];
  let group = "invalid_value";
  let summary = [];
  let needsInput = false;
  for (const i of issues) {
    if (i.targetField === "requester.employee_id" && i.code === "missing_required") {
      group = "missing_employee_id";
      const pid = provisionalId(raw, byTarget.email);
      changes.push(change(i.targetField, pid, "Provisional ID — replace it with the HR system ID if you have it"));
      summary.push("Create the requester with provisional employee ID " + pid + "; HR can update it later");
    } else if (i.targetField === "email") {
      group = group === "invalid_value" ? "missing_email" : group;
      changes.push(change(i.targetField, "", "Enter the requester's email address"));
      summary.push("Enter the requester's email");
      needsInput = true;
    } else if (i.targetField === "description" && i.code === "missing_required") {
      group = group === "invalid_value" ? "missing_description" : group;
      const tid = raw[byTarget["custom_fields.legacy_ticket_id"]];
      const text = "No description in the source system. Migrated from " + tid + " (" + (raw[byTarget.type] || "ticket") + ", " + (raw[byTarget.status] || "unknown status") + ").";
      changes.push(change(i.targetField, text, "Placeholder that makes the gap visible to agents"));
      summary.push("Migrate with a placeholder description that states the source had none");
    } else if (i.targetField === "department") {
      const value = raw[i.field];
      const ai = this.ctx.aiDepartments[value];
      const id = String(raw[byTarget["requester.employee_id"]] || "").trim();
      const seen = id && this.ctx.employeeIndex.deptsById && this.ctx.employeeIndex.deptsById.get(id);
      const usual = seen ? [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => normalizeDepartment(d, this.departments)).find(Boolean) : null;
      let pick;
      let why;
      if (ai && ai.department) { pick = ai.department; why = "Claude's suggestion (" + Math.round(ai.confidence * 100) + "%)"; }
      else if (usual) { pick = usual.department; why = "Department on this employee's other tickets"; }
      else { pick = "IT"; why = "Default department for the primary IT workspace"; }
      group = isPlaceholder(value) ? "department_placeholder" : "department_uncertain";
      changes.push(change(i.targetField, pick, why));
      summary.push("Use department " + pick + " (" + why.toLowerCase() + ")");
    } else {
      changes.push(change(i.targetField, "", i.message));
      summary.push("Correct " + labelOf(i.targetField));
      needsInput = true;
    }
  }
  return out(group, "retry_with_changes", summary.join("; ") + ".", changes.filter((c) => c.field), needsInput);
};

const STRATEGY_LABELS = {
  normalize_format: "normalise data",
  swap_mismatched_fields: "correct swapped fields",
  infer_employee_id: "infer employee ID",
  previous_migration: "reuse requester from a previous migration",
  infer_email: "infer email",
  normalize_department: "apply known department mapping",
  ai_department: "AI department mapping",
  retry_api: "retry API request",
};

module.exports = { RemediationEngine, buildEmployeeIndex, normalizeDepartment, isPlaceholder, MAX_ATTEMPTS, STRATEGY_LABELS, REVIEW_GROUPS };
