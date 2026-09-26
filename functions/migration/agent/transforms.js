/* Value transformations used by agent mappings. Each mapping row names one
   of these; the engine applies it and records what it did.

   Freshservice API v2 values (https://api.freshservice.com/#ticket_attributes):
     priority  1 Low · 2 Medium · 3 High · 4 Urgent
     status    2 Open · 3 Pending · 4 Resolved · 5 Closed */

const { norm } = require("../execution/transform");
const { normalizeDepartment } = require("../execution/remediation");

const FS_PRIORITY = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const FS_STATUS = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };

// JSM priority names (default scheme + common custom ones) → Freshservice priority
const PRIORITY_MAP = {
  highest: 4, blocker: 4, critical: 4, urgent: 4, p1: 4,
  high: 3, major: 3, p2: 3,
  medium: 2, normal: 2, moderate: 2, p3: 2,
  low: 1, lowest: 1, minor: 1, trivial: 1, p4: 1, p5: 1,
};

// JSM status names → Freshservice status. Unknown names fall back to the JSM status category.
const STATUS_MAP = {
  open: 2, new: 2, todo: 2, reopened: 2, waitingforsupport: 2, escalated: 2,
  inprogress: 3, waitingforcustomer: 3, pending: 3, onhold: 3, waitingforapproval: 3, workinprogress: 3,
  resolved: 4, done: 4, completed: 4, fixed: 4,
  closed: 5, cancelled: 5, canceled: 5, declined: 5, rejected: 5,
};
const STATUS_CATEGORY = { new: 2, indeterminate: 3, done: 4 };

/** JSM priority → {value, note} | {error}. Strips decoration like "P1 - Critical" or "HIGH!!". */
function transformPriority(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return { value: 2, note: "No priority in JSM — Freshservice default Medium" };
  const direct = PRIORITY_MAP[norm(raw)];
  if (direct) return { value: direct, note: raw + " → " + FS_PRIORITY[direct] };
  return { error: "Priority '" + raw + "' has no Freshservice equivalent" };
}

/** Remediation: find a known priority word inside a noisy value ("P1 - Critical", "PRIORITY: HIGH"). */
function normalizePriority(value) {
  const words = String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) if (PRIORITY_MAP[w]) return { value: PRIORITY_MAP[w], word: w };
  return null;
}

function transformStatus(value, category) {
  const raw = String(value == null ? "" : value).trim();
  const direct = STATUS_MAP[norm(raw)];
  if (direct) return { value: direct, note: raw + " → " + FS_STATUS[direct] };
  const byCat = STATUS_CATEGORY[norm(category)];
  if (byCat) return { value: byCat, note: raw + " (status category " + category + ") → " + FS_STATUS[byCat] };
  return { value: 2, note: "Unknown status '" + raw + "' → Open" };
}

/** "Priya Sharma" → {first_name, last_name} */
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] || "", last_name: parts.slice(1).join(" ") };
}

/** "priya.sharma@x.com" → "Priya Sharma" (remediation for a blank name) */
function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  const parts = local.split(/[._-]+/).map((p) => p.replace(/\d+/g, "")).filter((p) => p.length > 1);
  return parts.length ? parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ") : "";
}

/** Department name → Freshservice department ({id, name}) by exact name, then normalisation. */
function lookupDepartment(value, departments) {
  const v = String(value || "").trim();
  if (!v) return { department: null };
  const exact = departments.find((d) => norm(d.name) === norm(v));
  if (exact) return { department: exact, via: "exact" };
  return { department: null, error: "Department '" + v + "' does not exist in Freshservice" };
}

function remediateDepartment(value, departments) {
  const hit = normalizeDepartment(value, departments.map((d) => d.name));
  if (!hit) return null;
  return { department: departments.find((d) => d.name === hit.department), via: hit.via };
}

module.exports = {
  transformPriority, normalizePriority, transformStatus, splitName, nameFromEmail,
  lookupDepartment, remediateDepartment, FS_PRIORITY, FS_STATUS, PRIORITY_MAP,
};
