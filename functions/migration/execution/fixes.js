/* Basic, deterministic auto-fixes applied when validation finds an error.
   Only unambiguous corrections are made; anything else goes to human review.
   (AI-driven remediation is the next stage.) */

const { EMAIL_RE } = require("./validation");
const { matchEnum, parseDate } = require("./transform");

const FIXERS = {
  invalid_email(value) {
    const cleaned = String(value).trim().toLowerCase()
      .replace(/\s*(\(at\)|\[at\]|\sat\s)\s*/g, "@")
      .replace(/\s*(\(dot\)|\[dot\])\s*/g, ".")
      .replace(/\s+/g, "");
    return EMAIL_RE.test(cleaned) ? { value: cleaned, note: "Normalised email '" + String(value).trim() + "' → " + cleaned } : null;
  },
  invalid_date(value) {
    const iso = parseDate(value, { allowDayFirst: true });
    return iso ? { value: iso, note: "Converted date '" + value + "' (DD/MM/YYYY) → " + iso } : null;
  },
  unrecognized_value(value, field) {
    const stripped = String(value).replace(/priority|severity|status|state|level|[^a-z0-9 ]/gi, " ").trim();
    const m = matchEnum(stripped, field.values || []);
    return m ? { value: stripped, note: field.label + " '" + value + "' → " + m.name } : null;
  },
};

/**
 * @param {object} raw
 * @param {Array} issues  errors from validateRecord
 * @param {Array} targetSchema
 * @returns {{record: object, fixes: string[], unfixed: Array}}
 */
function applyBasicFixes(raw, issues, targetSchema) {
  const record = { ...raw };
  const fixes = [];
  const unfixed = [];
  const byTarget = Object.fromEntries(targetSchema.map((f) => [f.key, f]));
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    const fixer = FIXERS[issue.code];
    const result = fixer && issue.field ? fixer(record[issue.field], byTarget[issue.targetField]) : null;
    if (result) {
      record[issue.field] = result.value;
      fixes.push(result.note);
    } else {
      unfixed.push(issue);
    }
  }
  return { record, fixes, unfixed };
}

module.exports = { applyBasicFixes };
