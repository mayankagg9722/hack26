/* Value transformer: converts source values into what the target accepts.
   Enum fields are matched against the target schema's allowed values using
   generic ITSM synonyms (P1 → Urgent, WIP → Pending, ...), so nothing here is
   specific to one source or target. Dates become ISO 8601. */

const SYNONYMS = {
  urgent: ["urgent", "p1", "highest", "critical", "sev1", "blocker", "emergency"],
  high: ["high", "p2", "major", "sev2"],
  medium: ["medium", "p3", "normal", "moderate", "sev3"],
  low: ["low", "p4", "p5", "lowest", "minor", "trivial", "sev4", "sev5"],
  open: ["open", "new", "assigned", "todo", "reopened", "queued"],
  pending: ["pending", "inprogress", "wip", "waiting", "waitingforcustomer", "onhold", "workinprogress"],
  resolved: ["resolved", "done", "fixed", "completed"],
  closed: ["closed", "cancelled", "canceled", "rejected"],
  incident: ["incident", "problem", "bug", "outage", "fault"],
  servicerequest: ["servicerequest", "request", "change", "task", "question", "access"],
};

function norm(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueName(v) {
  return typeof v === "string" ? v : v.name;
}
function valueOut(v) {
  return typeof v === "string" ? v : v.id;
}

/** Find the target enum value for a source value, or null. */
function matchEnum(sourceValue, allowed) {
  const n = norm(sourceValue);
  if (!n) return null;
  const direct = allowed.find((v) => norm(valueName(v)) === n);
  if (direct) return { value: valueOut(direct), name: valueName(direct), via: "exact" };
  for (const v of allowed) {
    const group = SYNONYMS[norm(valueName(v))];
    if (group && group.includes(n)) return { value: valueOut(v), name: valueName(v), via: "synonym" };
  }
  return null;
}

/** ISO date from ISO or DD/MM/YYYY [HH:MM] input; null if unparseable. */
function parseDate(v, { allowDayFirst = false } = {}) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s))) return new Date(s).toISOString();
  if (allowDayFirst) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
    if (m) {
      const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)));
      if (d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1) return d.toISOString();
    }
  }
  return null;
}

/**
 * Turn a mapped record ({targetKey: sourceValue}) into a target payload.
 * @returns {{payload: object, notes: string[], unmapped: string[]}}
 */
function transformRecord(mapped, targetSchema) {
  const payload = {};
  const notes = [];
  const unmapped = [];
  for (const f of targetSchema) {
    if (!Object.prototype.hasOwnProperty.call(mapped, f.key)) continue;
    let v = mapped[f.key];
    if (typeof v === "string") v = v.trim();
    if (f.type === "enum" && f.values) {
      const m = matchEnum(v, f.values);
      if (m) {
        if (m.via === "synonym") notes.push(f.label + ": '" + v + "' → " + m.name);
        v = m.value;
      } else {
        unmapped.push(f.key);
      }
    } else if (f.type === "datetime") {
      v = parseDate(v) || v;
    } else if (f.type === "email" && typeof v === "string") {
      v = v.toLowerCase();
    }
    setPath(payload, f.key, v);
  }
  return { payload, notes, unmapped };
}

function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    o[parts[i]] = o[parts[i]] || {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function getPath(obj, key) {
  return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

module.exports = { matchEnum, parseDate, transformRecord, getPath, setPath, norm };
