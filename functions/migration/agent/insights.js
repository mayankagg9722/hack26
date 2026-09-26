/* generate_migration_insights — Claude analyses a finished migration.

   The numbers (summary block) are computed by Zen from the record ledger;
   Claude only writes the analysis, from facts Zen gives it. The facts
   contain counts, failure categories, remediation outcomes, mappings,
   reconciliation and record IDs — no credentials, no emails or names.
   Without a key (or if the call fails) a rule-based analysis is returned
   and labelled as such. */

const Anthropic = require("@anthropic-ai/sdk");
const { summarize } = require("./engine");

const MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You are Zen, an autonomous data-migration agent. You analyse a completed migration from Jira Service Management to Freshservice for the IT admin who ran it.

Use only the facts provided. Every number you write must appear in the facts or be a direct sum of numbers in the facts — never estimate or invent counts. Be specific and practical: name the failure types, the fixes Zen applied, and the records that still need a person. Keep each bullet to one sentence. Recommendations must be actions the admin can take before the next migration (pre-checks, mapping changes, source data fixes).`;

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    went_well: { type: "array", items: { type: "string" } },
    went_wrong: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, count: { type: "integer" }, detail: { type: "string" } },
        required: ["title", "count", "detail"], additionalProperties: false,
      },
    },
    how_fixed: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, count: { type: "integer" } },
        required: ["title", "count"], additionalProperties: false,
      },
    },
    needs_human: {
      type: "object",
      properties: { count: { type: "integer" }, reason: { type: "string" }, recommended_action: { type: "string" } },
      required: ["count", "reason", "recommended_action"], additionalProperties: false,
    },
    recommendations: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "went_well", "went_wrong", "how_fixed", "needs_human", "recommendations"],
  additionalProperties: false,
};

function durationSeconds(run) {
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
}

/** Facts for Claude and for the rule-based fallback. */
function buildFacts(run, mappings = {}) {
  const s = summarize(run);
  const recs = Object.values(run.records);
  const strategies = {};
  for (const r of recs) for (const m of r.remediation.filter((x) => !x.retry)) {
    const k = m.strategy + (m.ok ? ":ok" : ":failed");
    strategies[k] = (strategies[k] || 0) + 1;
  }
  const unresolved = recs.filter((r) => ["HUMAN_REVIEW_REQUIRED", "SKIPPED", "FAILED"].includes(r.status)).map((r) => ({
    record: r.sourceId, entity: r.entity, status: r.status, failure: r.review ? r.review.failure_type : r.error && r.error.type,
    problem: r.review ? r.review.problem : r.error && r.error.message.replace(/[^\s@]+@[^\s@]+/g, "<email>"),
  }));
  return {
    source: run.source.name + " (" + (run.source.mode === "live" ? "real API" : "mock data") + ")",
    target: run.target.name + " (" + (run.target.mode === "live" ? "real API" : "mock data") + ")",
    entities: run.entities,
    duration_seconds: durationSeconds(run),
    status: run.status,
    summary: {
      records: s.total, processed: s.processed, migrated: s.migrated, successful_first_time: s.successful,
      auto_remediated: s.remediated, resolved_by_human: s.resolved, skipped: s.skipped, failed: s.failed,
      awaiting_human_review: s.human_review, success_rate: s.success_rate,
    },
    per_entity: s.per_entity,
    failures_by_type: s.failures_by_type.map(({ examples, ...f }) => ({ ...f, example_records: examples })),
    remediation_strategies: strategies,
    unresolved_records: unresolved.slice(0, 40),
    mappings: Object.fromEntries(Object.entries(mappings).map(([e, m]) => [e, m ? m.fields.map((f) => ({ source: f.source, target: f.target, confidence: f.level, transformation: f.transformation, decision: f.decision })) : null])),
    reconciliation: run.reconciliation,
    success_criteria: run.evaluation,
  };
}

async function claudeInsights(facts, { apiKey, client }) {
  const anthropic = client || new Anthropic({ apiKey, timeout: 90000, maxRetries: 1 });
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "Migration facts:\n" + JSON.stringify(facts, null, 2) }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off");
  return JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

const STRATEGY_TEXT = {
  normalize_department: "department values normalised to Freshservice departments",
  ai_department: "departments matched by Claude",
  link_existing_requester: "existing requesters linked instead of creating duplicates",
  requester_by_email: "requesters resolved by email lookup",
  normalize_priority: "priority values transformed from noisy source values",
  subject_from_description: "subjects derived from the ticket description",
  fill_description: "blank descriptions filled from the summary",
  derive_name_from_email: "blank names derived from the email address",
  classify_workspace: "tickets re-routed by Workspace Classification",
  retry_api: "transient Freshservice API errors retried successfully",
  backoff_retry: "rate-limited writes retried after backoff",
};

/** Deterministic analysis when Claude is not available. */
function ruleInsights(facts) {
  const s = facts.summary;
  const rate = s.success_rate == null ? "—" : +(s.success_rate * 100).toFixed(1) + "%";
  const well = [rate + " of processed records migrated (" + s.migrated + " of " + s.processed + ")."];
  const dup = facts.failures_by_type.find((f) => f.type === "DUPLICATE_REQUESTER");
  if (dup) well.push("Duplicate detection linked " + dup.auto_fixed + " existing requesters instead of creating duplicates.");
  if (s.auto_remediated) well.push(s.auto_remediated + " records were fixed automatically and accepted by Freshservice.");
  const wrong = facts.failures_by_type.filter((f) => f.type !== "DUPLICATE_REQUESTER")
    .map((f) => ({ title: f.label, count: f.count, detail: f.auto_fixed + " fixed automatically, " + f.human + " resolved by a person, " + f.open + " still open." }));
  const fixed = Object.entries(facts.remediation_strategies).filter(([k]) => k.endsWith(":ok"))
    .map(([k, n]) => ({ title: STRATEGY_TEXT[k.split(":")[0]] || k.split(":")[0], count: n }));
  const open = facts.unresolved_records;
  const types = [...new Set(open.map((u) => u.failure).filter(Boolean))];
  const rec = [];
  if (facts.failures_by_type.some((f) => f.type === "MISSING_REQUESTER" || f.type === "MISSING_EMAIL")) rec.push("Validate that every JSM customer and reporter has an email before migrating, and configure a fallback requester.");
  if (facts.failures_by_type.some((f) => f.type === "INVALID_DEPARTMENT")) rec.push("Add department normalisation to the pre-migration checks, or create the missing departments in Freshservice.");
  if (facts.failures_by_type.some((f) => f.type === "INVALID_PRIORITY")) rec.push("Extend the priority mapping with the custom JSM priority values found in this run.");
  if (facts.failures_by_type.some((f) => f.type === "API_FAILURE" || f.type === "RATE_LIMIT")) rec.push("Schedule large migrations outside business hours to stay within Freshservice API rate limits.");
  return {
    headline: "Migrated " + s.migrated + " of " + s.records + " records (" + rate + ").",
    went_well: well,
    went_wrong: wrong,
    how_fixed: fixed,
    needs_human: {
      count: open.length,
      reason: open.length ? "Open issues: " + types.join(", ") + "." : "Nothing is waiting for a person.",
      recommended_action: open.length ? "Review these records in the human review queue, correct the source data and retry." : "No action needed.",
    },
    recommendations: rec,
  };
}

/**
 * @returns {Promise<{generated_by: "claude"|"rules", model?: string, error?: string, summary: object, insights: object, generated_at: string}>}
 */
async function generateMigrationInsights(run, { mappings = {}, apiKey = "", client = null } = {}) {
  const facts = buildFacts(run, mappings);
  const base = { summary: facts.summary, per_entity: facts.per_entity, duration_seconds: facts.duration_seconds, generated_at: new Date().toISOString() };
  if (apiKey || client) {
    try {
      return { ...base, generated_by: "claude", model: MODEL, insights: await claudeInsights(facts, { apiKey, client }) };
    } catch (err) {
      return { ...base, generated_by: "rules", error: "Claude unavailable: " + err.message, insights: ruleInsights(facts) };
    }
  }
  return { ...base, generated_by: "rules", error: "No Anthropic API key configured", insights: ruleInsights(facts) };
}

module.exports = { generateMigrationInsights, buildFacts, ruleInsights, MODEL };
