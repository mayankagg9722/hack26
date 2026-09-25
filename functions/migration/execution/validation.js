/* ValidationEngine: checks a source record's values against the target
   fields they map to, before anything is written. Also verifies records
   read back from the target after migration. Generic over target schemas. */

const { matchEnum, parseDate, getPath } = require("./transform");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const LIMITS = { subject: 255 };

/**
 * @param {object} raw  source record (source field names)
 * @param {object} ctx  { fields: [{sourceField, targetField}], targetSchema, seenIds: Set }
 * @returns {Array<{field, targetField, code, severity: "error"|"warning", message}>}
 */
function validateRecord(raw, ctx) {
  const issues = [];
  const byTarget = Object.fromEntries(ctx.targetSchema.map((f) => [f.key, f]));
  const mappedTargets = new Set(ctx.fields.map((f) => f.targetField));

  for (const m of ctx.fields) {
    const f = byTarget[m.targetField];
    if (!f) continue;
    const v = raw[m.sourceField];
    const s = v == null ? "" : String(v).trim();
    const at = { field: m.sourceField, targetField: f.key };

    if (!s) {
      if (f.required) issues.push({ ...at, code: "missing_required", severity: "error", message: f.label + " is required but empty" });
      continue;
    }
    if (f.type === "email" && !EMAIL_RE.test(s)) {
      issues.push({ ...at, code: "invalid_email", severity: "error", message: "'" + s + "' is not a valid email address" });
    } else if (f.type === "datetime" && !parseDate(s)) {
      issues.push({ ...at, code: "invalid_date", severity: "error", message: "'" + s + "' is not an ISO date" });
    } else if (f.type === "enum" && f.values && !matchEnum(s, f.values)) {
      issues.push({ ...at, code: "unrecognized_value", severity: "error", message: "'" + s + "' is not a known " + f.label.toLowerCase() });
    } else if (LIMITS[f.key] && s.length > LIMITS[f.key]) {
      issues.push({ ...at, code: "too_long", severity: "warning", message: f.label + " will be truncated to " + LIMITS[f.key] + " characters" });
    }
    if (f.key === "custom_fields.legacy_ticket_id" && ctx.seenIds && ctx.seenIds.has(s)) {
      issues.push({ ...at, code: "duplicate", severity: "error", message: "Ticket " + s + " was already migrated in this run — possible duplicate" });
    }
  }

  // required target fields with no mapping at all (subject is derived from description)
  for (const f of ctx.targetSchema) {
    if (f.required && !mappedTargets.has(f.key) && !(f.key === "subject" && mappedTargets.has("description"))) {
      issues.push({ field: null, targetField: f.key, code: "unmapped_required", severity: "error", message: f.label + " has no source field mapped" });
    }
  }
  return issues;
}

/**
 * Check records read back from the target.
 * @returns {{checked: number, problems: Array<{id, message}>}}
 */
function verifyTargetRecords(records, targetSchema, expectedWorkspaceId) {
  const problems = [];
  for (const r of records) {
    for (const f of targetSchema) {
      if (f.required) {
        const v = getPath(r, f.key);
        if (v === undefined || v === null || v === "") problems.push({ id: r.id, message: f.label + " missing in target" });
      }
    }
    if (expectedWorkspaceId != null && String(r.workspace_id) !== String(expectedWorkspaceId)) {
      problems.push({ id: r.id, message: "Landed in workspace " + r.workspace_id + " instead of " + expectedWorkspaceId });
    }
  }
  return { checked: records.length, problems };
}

module.exports = { validateRecord, verifyTargetRecords, EMAIL_RE };
