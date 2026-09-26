/* generate_mapping — source entity schema → target entity schema.

   Each source field is resolved by the first method that applies:
     1. exact     same field name on both sides
     2. known     JSM → Freshservice vendor knowledge (API docs), incl. the transformation
     3. semantic  name similarity after synonyms/abbreviations (mapping/suggest.js)
     4. ai        Claude, for fields the first three leave open (when a key is configured)
   Confidence → level: HIGH ≥ 0.90, MEDIUM ≥ 0.75, LOW below (LOW needs a human to
   confirm before the migration can run). Unresolved fields stay unmapped —
   Zen does not invent mappings. */

const crypto = require("crypto");
const { tokens } = require("../mapping/suggest");

const PAIRS = {
  "customer→requester": { source: "customer", target: "requester", label: "JSM Customers → Freshservice Requesters" },
  "ticket→ticket": { source: "ticket", target: "ticket", label: "JSM Tickets → Freshservice Tickets" },
};

/* Vendor knowledge: JSM field → Freshservice field, with the transformation it needs. */
const KNOWN = {
  "customer→requester": {
    displayName: { target: "name", confidence: 0.99, transformation: "splitName", reason: "JSM display name → Freshservice first_name + last_name." },
    emailAddress: { target: "email", confidence: 0.99, transformation: "direct", reason: "Both hold the person's email (lower-cased; used to detect existing requesters)." },
    department: { target: "department", confidence: 0.92, transformation: "lookupDepartment", reason: "Department name resolved to a Freshservice department ID." },
    jobTitle: { target: "job_title", confidence: 0.94, transformation: "direct", reason: "Job title → job_title (same meaning, different name)." },
    phone: { target: "phone", confidence: 0.9, transformation: "direct", reason: "Phone → work_phone_number." },
    accountId: { target: null, confidence: 1, transformation: "idMapping", reason: "Kept in Zen's source → target ID map (not a Freshservice field)." },
  },
  "ticket→ticket": {
    summary: { target: "subject", confidence: 0.98, transformation: "rename", reason: "JSM summary is the Freshservice subject." },
    priority: { target: "priority", confidence: 0.97, transformation: "transformPriority", reason: "JSM priority names → Freshservice 1–4 (Highest → 4 Urgent)." },
    status: { target: "status", confidence: 0.95, transformation: "transformStatus", reason: "JSM status (or status category) → Freshservice 2–5." },
    reporter: { target: "requester_id", confidence: 0.9, transformation: "lookupRequester", reason: "Reporter resolved to a Freshservice requester: ID map, then email, then name." },
    issuetype: { target: "type", confidence: 0.92, transformation: "issueType", reason: "Incident/Problem → Incident; everything else → Service Request." },
    department: { target: "department_id", confidence: 0.9, transformation: "lookupDepartment", reason: "Department name resolved to a Freshservice department ID." },
    workspace: { target: "workspace_id", confidence: 0.9, transformation: "classifyWorkspace", reason: "Service workspace if it exists in Freshservice, else Workspace Classification by department." },
    created: { target: "created_at", confidence: 0.8, transformation: "preserveInDescription", reason: "created_at is read-only in Freshservice, so the JSM date is kept in the description footer." },
    key: { target: null, confidence: 1, transformation: "idMapping", reason: "Kept in Zen's source → target ID map (JSM key → Freshservice ticket ID)." },
  },
};

// extra semantic synonyms for fields vendors name differently
const SEMANTIC = { office: ["location"], title: ["job", "subject"], phone: ["work", "phone"], mobile: ["phone"] };

function level(c) {
  return c >= 0.9 ? "HIGH" : c >= 0.75 ? "MEDIUM" : "LOW";
}

function semanticScore(sourceKey, target) {
  const s = tokens(sourceKey).flatMap((t) => [t].concat(SEMANTIC[t] || []));
  const t = tokens(target.key).concat(tokens(target.label || ""), tokens(target.api || ""));
  if (!s.length || !t.length) return 0;
  const hit = s.filter((x) => t.includes(x)).length;
  return hit / Math.max(tokens(sourceKey).length, 1);
}

function row(source, target, confidence, method, transformation, reason) {
  return {
    source: source.key, sourceLabel: source.label || source.key, target: target ? target.key : null,
    targetLabel: target ? target.label : null, targetApi: target ? target.api || target.key : null,
    confidence: Math.round(confidence * 100) / 100, level: target || transformation === "idMapping" ? level(confidence) : null,
    method, transformation, reason,
    requiresConfirmation: Boolean(target) && level(confidence) === "LOW",
    decision: target && level(confidence) === "LOW" ? "pending" : "auto",
  };
}

/**
 * @param {object} args
 * @param {string} args.pair           "customer→requester" | "ticket→ticket"
 * @param {object} args.sourceEntity   from list_source_entities
 * @param {object} args.targetEntity   from list_target_entities
 * @param {Function|null} [args.aiSuggest]  ({sourceFields, targetFields}) → [{sourceField, targetField, confidence, reason}]
 */
async function generateMapping({ pair, sourceEntity, targetEntity, aiSuggest = null }) {
  const known = KNOWN[pair] || {};
  const targets = targetEntity.fields.filter((f) => !f.readOnly || f.key === "created_at");
  const used = new Set();
  const rows = [];
  const open = [];
  for (const f of sourceEntity.fields) {
    const exact = targets.find((t) => !used.has(t.key) && (t.key === f.key || t.api === f.key));
    const k = known[f.key];
    if (exact) {
      used.add(exact.key);
      // same name, but the value may still need converting (priority names → numbers, department → ID)
      const transformation = k && k.target === exact.key ? k.transformation : "direct";
      rows.push(row(f, exact, 0.99, "exact", transformation, transformation === "direct" ? "Same field name in both systems." : "Same field name. " + k.reason));
      continue;
    }
    if (k) {
      const t = k.target ? targets.find((x) => x.key === k.target && !used.has(x.key)) : null;
      if (k.target && !t) { open.push(f); continue; }
      if (t) used.add(t.key);
      rows.push(row(f, t, k.confidence, "known", k.transformation, k.reason));
      continue;
    }
    open.push(f);
  }

  let aiError = null;
  let aiRows = {};
  const candidates = targets.filter((t) => !used.has(t.key) && !t.readOnly);
  if (open.length && candidates.length && aiSuggest) {
    try {
      const out = await aiSuggest({
        sourceFields: open.map((f) => ({ key: f.key, samples: f.sample ? [f.sample] : [] })),
        targetFields: candidates.map((t) => ({ key: t.key, label: t.label, type: t.type })),
      });
      for (const s of out || []) if (s.targetField) aiRows[s.sourceField] = s;
    } catch (err) {
      aiError = err.message;
      aiRows = {};
    }
  }
  for (const f of open) {
    const ai = aiRows[f.key];
    const t = ai ? candidates.find((x) => x.key === ai.targetField && !used.has(x.key)) : null;
    if (t) {
      used.add(t.key);
      // Claude's suggestions are capped at MEDIUM unless it is very sure — a human confirms the rest
      rows.push(row(f, t, Math.min(ai.confidence, 0.93), "ai", "direct", ai.reason || "Suggested by Claude."));
      continue;
    }
    let best = null;
    for (const c of candidates) {
      if (used.has(c.key)) continue;
      const s = semanticScore(f.key, c);
      if (s > 0 && (!best || s > best.s)) best = { c, s };
    }
    if (best) {
      used.add(best.c.key);
      rows.push(row(f, best.c, 0.45 + best.s * 0.2, "semantic", best.c.type === "reference" ? "lookup" : "direct",
        "'" + (f.label || f.key) + "' looks like '" + best.c.label + "' — please confirm."));
      continue;
    }
    rows.push(row(f, null, 0, "none", null, "No Freshservice field holds this information — not migrated."));
  }

  const mappedTargets = new Set(rows.filter((r) => r.target).map((r) => r.target));
  const missingRequired = targetEntity.fields.filter((t) => t.required && !mappedTargets.has(t.key)).map((t) => t.key);
  return {
    mappingId: "map_" + crypto.randomBytes(5).toString("hex"),
    pair, label: (PAIRS[pair] || {}).label || pair,
    sourceEntity: sourceEntity.entityType, targetEntity: targetEntity.entityType,
    fields: rows,
    missingRequired,
    aiUsed: Boolean(aiSuggest) && !aiError && open.length > 0,
    aiError,
    createdAt: new Date().toISOString(),
  };
}

/** Admin decision on one row (confirm / reject). Returns the updated mapping. */
function decide(mapping, source, decision) {
  if (!["confirmed", "rejected"].includes(decision)) throw new Error("decision must be confirmed or rejected");
  const r = mapping.fields.find((f) => f.source === source);
  if (!r || !r.target) throw new Error("No mapping for field " + source);
  r.decision = decision;
  r.requiresConfirmation = false;
  return mapping;
}

/** Rows the engine applies: everything with a target that wasn't rejected or left pending. */
function activeRows(mapping) {
  return mapping.fields.filter((r) => (r.target || r.transformation === "idMapping") && (r.decision === "auto" || r.decision === "confirmed"));
}
function pendingRows(mapping) {
  return mapping.fields.filter((r) => r.decision === "pending");
}

module.exports = { generateMapping, decide, activeRows, pendingRows, PAIRS, KNOWN, level };
