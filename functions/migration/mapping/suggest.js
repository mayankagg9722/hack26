/* Heuristic field-mapping suggestions: field-name similarity (after
   expanding abbreviations and synonyms) plus what the sample values look
   like. Always available; the AI layer (aiSuggest.js) refines on top. */

// token → canonical token ("" drops it)
const TOKEN_MAP = {
  emp: "employee", empl: "employee", staff: "employee", reporter: "employee", requester: "employee",
  identification: "id", identifier: "id", no: "id", num: "id", nbr: "id", nr: "id", number: "id", key: "id",
  dept: "department", dep: "department",
  tkt: "ticket", issue: "ticket", incident: "ticket", case: "ticket",
  desc: "description", details: "description", detail: "description", body: "description",
  mail: "email", e: "", emailaddress: "email",
  category: "type", kind: "type", cat: "type",
  state: "status", stat: "status",
  severity: "priority", sev: "priority", urgency: "priority", pri: "priority", prio: "priority",
  open: "created", opened: "created", dt: "date", timestamp: "date",
  summary: "subject", title: "subject",
  updt: "updated", usr: "user",
  // noise words
  the: "", of: "", level: "", current: "", code: "", address: "", full: "", on: "", at: "", value: "",
};

const ABBREVIATIONS = new Set(["emp", "empl", "dept", "dep", "tkt", "desc", "no", "num", "nbr", "dt", "sev", "pri", "prio", "cat"]);

function rawTokens(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokens(name) {
  const out = [];
  for (const t of rawTokens(name)) {
    const mapped = Object.prototype.hasOwnProperty.call(TOKEN_MAP, t) ? TOKEN_MAP[t] : t;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const inter = a.filter((t) => b.includes(t)).length;
  return inter / new Set([...a, ...b]).size;
}

/* ---------- value profiling ---------- */
const VOCAB = {
  priority: /^(p[1-5]|sev ?[1-5]|highest|high|medium|low|lowest|urgent|critical|major|minor)$/i,
  status: /^(open|closed|resolved|pending|in progress|new|assigned|wip|waiting.*|on hold|done|cancel+ed)$/i,
  type: /^(incident|service request|request|change|problem|task|question)$/i,
};

function valueKind(values) {
  const vals = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "").map(String);
  if (!vals.length) return { kind: "empty" };
  const all = (re) => vals.every((v) => re.test(v));
  if (all(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i)) return { kind: "email" };
  if (all(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}/)) return { kind: "datetime" };
  if (all(/^[A-Z][a-zA-Z'’À-ÿ-]+( [A-Z][a-zA-Z'’À-ÿ-]+)+$/)) return { kind: "person" };
  for (const [vocab, re] of Object.entries(VOCAB)) if (all(re)) return { kind: "enum", vocab };
  if (all(/^[A-Za-z]{0,6}[-_]?\d{2,}$/)) return { kind: "id" };
  const avgLen = vals.reduce((n, v) => n + v.length, 0) / vals.length;
  if (avgLen > 24 && vals.some((v) => v.includes(" "))) return { kind: "text" };
  return { kind: "enum" };
}

function valueScore(profile, target) {
  const expects = target.expects;
  if (!expects || profile.kind === "empty") return { score: 0 };
  if (profile.kind === expects) {
    if (profile.kind === "enum" && profile.vocab) {
      const vocabTarget = { priority: "priority", status: "status", type: "type" }[profile.vocab];
      return target.key === vocabTarget
        ? { score: 0.35, why: "values look like " + profile.vocab + " values" }
        : { score: -0.2 };
    }
    return { score: 0.35, why: "sample values look like " + describeKind(profile.kind) };
  }
  // strong kinds that clearly don't fit
  if (["email", "datetime", "person"].includes(profile.kind) || ["email", "datetime"].includes(expects)) {
    return { score: -0.3 };
  }
  return { score: 0 };
}

function describeKind(kind) {
  return { email: "email addresses", datetime: "dates", person: "people's names", id: "identifiers", text: "free text", enum: "category values" }[kind] || kind;
}

/* ---------- scoring ---------- */
function nameScore(sourceKey, target) {
  const s = tokens(sourceKey);
  const candidates = [target.label, target.key.split(".").pop()].concat(target.aliases || []);
  let best = 0;
  let bestLabel = target.label;
  for (const c of candidates) {
    const score = jaccard(s, tokens(c));
    if (score > best) { best = score; bestLabel = c; }
  }
  return { score: best, matched: bestLabel };
}

function reasonFor(sourceKey, target, name, value) {
  const parts = [];
  const abbrev = rawTokens(sourceKey).filter((t) => ABBREVIATIONS.has(t));
  if (name.score >= 0.99) {
    parts.push(abbrev.length
      ? "'" + abbrev[0] + "' is a common abbreviation — the names are equivalent"
      : "The field names are equivalent");
  } else if (name.score > 0) {
    parts.push("Names are similar ('" + sourceKey + "' ≈ '" + name.matched + "')");
  }
  if (value.why) parts.push(value.why);
  return parts.join("; ") + ".";
}

const THRESHOLD = 0.45;

/**
 * @param {Array<{key: string, samples?: any[]}>} sourceFields
 * @param {Array<object>} targetFields  target schema (key, label, expects, aliases)
 * @returns {Array<{sourceField, targetField, confidence, reason, method}>}
 */
function suggestMappings(sourceFields, targetFields) {
  const pairs = [];
  for (const sf of sourceFields) {
    const profile = valueKind(sf.samples || []);
    for (const tf of targetFields) {
      const name = nameScore(sf.key, tf);
      const value = valueScore(profile, tf);
      const score = Math.min(1, name.score + value.score);
      if (score >= THRESHOLD && name.score > 0) {
        pairs.push({ sourceField: sf.key, targetField: tf.key, score, reason: reasonFor(sf.key, tf, name, value) });
      }
    }
  }
  // greedy one-to-one assignment, best scores first
  pairs.sort((a, b) => b.score - a.score);
  const usedSource = new Set();
  const usedTarget = new Set();
  const chosen = {};
  for (const p of pairs) {
    if (usedSource.has(p.sourceField) || usedTarget.has(p.targetField)) continue;
    usedSource.add(p.sourceField);
    usedTarget.add(p.targetField);
    chosen[p.sourceField] = p;
  }
  return sourceFields.map((sf) => {
    const p = chosen[sf.key];
    return p
      ? { sourceField: sf.key, targetField: p.targetField, confidence: round(p.score), reason: p.reason, method: "heuristic" }
      : { sourceField: sf.key, targetField: null, confidence: 0, reason: "No equivalent Freshservice field found.", method: "heuristic" };
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { suggestMappings, tokens, valueKind };
