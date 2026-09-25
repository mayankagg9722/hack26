/* Claude department resolver for remediation: maps department values the
   rules couldn't recognise onto the target's department list. Only answers
   with high confidence are used, and every fix is re-validated and actually
   written before it counts as resolved. */

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5";
const MIN_CONFIDENCE = 0.8;

const SYSTEM_PROMPT = `You help migrate ITSM tickets. Each source ticket has a department name that doesn't match the target system's department list. For each value, pick the target department that clearly means the same business unit, or "" if it is ambiguous, a placeholder, or not a department.

Be conservative: a wrong department routes tickets to the wrong team. Only pick a department when an administrator would agree without further context. confidence is 0 to 1. reason is one short sentence.`;

/**
 * @param {object} args
 * @param {string[]} args.values        unrecognised department values
 * @param {string[]} args.departments   target department names
 * @param {string} [args.apiKey]
 * @param {object} [args.client]        injectable Anthropic client (tests)
 * @returns {Promise<Object<string, {department: string|null, confidence: number, reason: string}>>}
 */
async function resolveDepartmentsWithClaude({ values, departments, apiKey, client }) {
  const anthropic = client || new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
  const schema = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: { type: "string", enum: values },
            department: { type: "string", enum: departments.concat("") },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
          required: ["value", "department", "confidence", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: "Target departments: " + JSON.stringify(departments) + "\n\nUnrecognised source values: " + JSON.stringify(values),
    }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off");
  const parsed = JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  const out = {};
  for (const r of parsed.results || []) {
    out[r.value] = {
      department: r.department && departments.includes(r.department) ? r.department : null,
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
      reason: String(r.reason || "").slice(0, 200),
    };
  }
  return out;
}

module.exports = { resolveDepartmentsWithClaude, MIN_CONFIDENCE, MODEL };
