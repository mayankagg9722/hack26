/* Failure engine: turns validation issues or target errors into a captured
   failure record with a category, so remediation can decide what to do. */

const { matchEnum } = require("./transform");

const CATEGORIES = {
  missing_employee_id: "Missing employee ID",
  invalid_department: "Invalid department",
  field_mapping_mismatch: "Invalid field mapping",
  missing_required_field: "Missing required field",
  invalid_format: "Invalid format",
  duplicate_record: "Duplicate record",
  api_failure: "Target API failure",
  invalid_field_mapping: "Invalid field mapping",
};

// when a record has several issues, the first matching category names it
const PRIORITY = ["api_failure", "invalid_field_mapping", "duplicate_record", "field_mapping_mismatch", "missing_employee_id",
  "invalid_department", "missing_required_field", "invalid_format"];

/** Values of two enum fields that belong to each other's vocabulary → the columns were swapped. */
function detectSwap(issue, raw, ctx) {
  if (issue.code !== "unrecognized_value" || !issue.field) return null;
  const schema = Object.fromEntries(ctx.targetSchema.map((f) => [f.key, f]));
  const value = raw[issue.field];
  for (const other of ctx.fields) {
    if (other.targetField === issue.targetField) continue;
    const of = schema[other.targetField];
    if (!of || of.type !== "enum" || !of.values) continue;
    const mine = schema[issue.targetField];
    if (matchEnum(value, of.values) && matchEnum(raw[other.sourceField], mine.values || [])) {
      return { a: issue.field, b: other.sourceField, aTarget: issue.targetField, bTarget: other.targetField };
    }
  }
  return null;
}

function categoryOf(issue, raw, ctx) {
  if (issue.code === "unmapped_required") return "invalid_field_mapping";
  if (issue.code === "duplicate") return "duplicate_record";
  if (issue.code === "missing_required" && issue.targetField === "requester.employee_id") return "missing_employee_id";
  if (issue.code === "missing_required") return "missing_required_field";
  if (issue.targetField === "department") return "invalid_department";
  if (detectSwap(issue, raw, ctx)) return "field_mapping_mismatch";
  return "invalid_format";
}

/**
 * @param {object} args
 * @param {object} args.raw          source record
 * @param {string} args.recordId
 * @param {string} args.waveId
 * @param {Array}  [args.issues]     validation errors (validation failure)
 * @param {object} [args.writeError] target error (API failure)
 * @param {object} [args.payload]    transformed payload (API failures, for retry)
 * @param {object} args.ctx          { fields, targetSchema }
 */
function captureFailure({ raw, recordId, waveId, issues = [], writeError = null, payload = null, ctx, seq }) {
  let category;
  if (writeError) {
    category = "api_failure";
  } else {
    const cats = issues.map((i) => categoryOf(i, raw, ctx));
    category = PRIORITY.find((c) => cats.includes(c)) || "invalid_format";
  }
  const reason = writeError
    ? "Target API error " + writeError.code + ": " + writeError.message
    : issues.map((i) => i.message).join("; ");
  const targetMapping = ctx.fields.map((f) => ({ sourceField: f.sourceField, targetField: f.targetField, value: raw[f.sourceField] }));
  return {
    failure_id: "f" + seq,
    wave_id: waveId,
    record_id: recordId,
    category,
    category_label: CATEGORIES[category],
    reason,
    issues: issues.map((i) => ({ field: i.field, targetField: i.targetField, code: i.code, severity: i.severity || "error", message: i.message })),
    source: raw,
    target_mapping: targetMapping,
    target_payload: payload,
    write_error: writeError,
    recommended_action: null, // set by RemediationEngine.analyze
    fixable: null,
    retry_count: 0,
    status: "OPEN",
    remediation: null,
    outcome: null,
    detected_at: new Date().toISOString(),
    resolved_at: null,
  };
}

module.exports = { captureFailure, detectSwap, CATEGORIES };
