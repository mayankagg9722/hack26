/* Claude-powered mapping suggestions. Given source fields (with sample
   values) and target fields, Claude returns a structured mapping. Callers
   fall back to the heuristic suggestions if this fails or no key is set. */

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You map fields from a source ITSM system to a target system (Freshservice) for a data migration.

For each source field, choose the single target field that holds the same information, or "" if none does. Use the field names and the sample values. Each target field may be used at most once. Do not map a field just because the names share a word: "Reporter" is a person's name, not an ID.

confidence is 0 to 1. reason is one short sentence a migration admin can read, for example "Both hold the employee's email address."`;

function buildPrompt(sourceFields, targetFields) {
  const src = sourceFields.map((f) => ({
    field: f.key,
    samples: (f.samples || []).slice(0, 3).map((v) => String(v).slice(0, 80)),
  }));
  const tgt = targetFields.map((f) => ({
    field: f.key,
    label: f.label,
    type: f.type,
    ...(f.values ? { allowed_values: f.values.map((v) => (typeof v === "string" ? v : v.name)) } : {}),
  }));
  return "Source fields:\n" + JSON.stringify(src, null, 2) + "\n\nTarget fields:\n" + JSON.stringify(tgt, null, 2);
}

function outputSchema(sourceFields, targetFields) {
  return {
    type: "object",
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_field: { type: "string", enum: sourceFields.map((f) => f.key) },
            target_field: { type: "string", enum: targetFields.map((f) => f.key).concat("") },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
          required: ["source_field", "target_field", "confidence", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["mappings"],
    additionalProperties: false,
  };
}

/**
 * @param {object} args
 * @param {Array<{key, samples}>} args.sourceFields
 * @param {Array<object>} args.targetFields
 * @param {string} [args.apiKey]
 * @param {object} [args.client]  injectable Anthropic client (tests)
 * @returns {Promise<Array<{sourceField, targetField, confidence, reason, method}>>}
 */
async function aiSuggestMappings({ sourceFields, targetFields, apiKey, client }) {
  const anthropic = client || new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: outputSchema(sourceFields, targetFields) } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(sourceFields, targetFields) }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined the mapping request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);

  // one target per source field, one source per target (keep the most confident)
  const bySource = {};
  const sorted = (parsed.mappings || []).slice().sort((a, b) => b.confidence - a.confidence);
  const usedTargets = new Set();
  for (const m of sorted) {
    if (bySource[m.source_field]) continue;
    const target = m.target_field && !usedTargets.has(m.target_field) ? m.target_field : null;
    if (target) usedTargets.add(target);
    bySource[m.source_field] = {
      sourceField: m.source_field,
      targetField: target,
      confidence: target ? Math.max(0, Math.min(1, Math.round(m.confidence * 100) / 100)) : 0,
      reason: m.reason,
      method: "ai",
    };
  }
  return sourceFields.map((f) => bySource[f.key] || {
    sourceField: f.key, targetField: null, confidence: 0, reason: "No equivalent Freshservice field found.", method: "ai",
  });
}

module.exports = { aiSuggestMappings, MODEL };
