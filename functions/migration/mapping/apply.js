/* Apply an approved field mapping to a raw source record, producing the
   target payload. Values are copied as-is; value translation (e.g. P1 →
   Urgent) is a later step of the migration run. */

/**
 * @param {object} raw  record in source field names
 * @param {Array<{sourceField, targetField}>} fields  active mappings (no rejected rows)
 * @param {Array<object>} targetSchema
 */
function applyMapping(raw, fields, targetSchema) {
  const labels = Object.fromEntries(targetSchema.map((f) => [f.key, f.label]));
  const mapped = [];
  const target = {};
  for (const f of fields) {
    if (!f.targetField || !Object.prototype.hasOwnProperty.call(labels, f.targetField)) continue;
    const value = raw[f.sourceField];
    mapped.push({ sourceField: f.sourceField, targetField: f.targetField, targetLabel: labels[f.targetField], value });
    target[f.targetField] = value;
  }
  // Freshservice requires a subject; derive it when nothing maps to it
  if (target.subject === undefined && labels.subject && typeof target.description === "string") {
    target.subject = target.description.length > 80 ? target.description.slice(0, 77) + "…" : target.description;
  }
  return { mapped, target };
}

/** Source field currently mapped to the target's department field, if any. */
function departmentSourceField(fields) {
  const f = fields.find((x) => x.targetField === "department");
  return f ? f.sourceField : null;
}

module.exports = { applyMapping, departmentSourceField };
