/* Claude goal interpreter: natural language → intent (same shape as
   rulesInterpreter). Claude extracts meaning only; dates are resolved by
   planner.js in the customer's timezone, so Claude never does calendar maths.
   Structured output uses sentinels ("" / -1) instead of nulls. */

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5";
const CATEGORIES = ["it", "hr", "finance", "facilities", "all"];
const DAY_ENUM = ["", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const SYSTEM_PROMPT = `You turn a customer's migration request into a structured migration plan intent for Zen, an ITSM data migration agent.

Extract only what the customer said or clearly implied; leave everything else empty ("" or -1 or false as the schema describes). Never compute calendar dates: describe schedules with day/relative/time words, and only fill "date" when the customer gave an explicit calendar date.

Waves: one per department group the customer wants migrated separately, in the order they should run. Categories map to target workspaces: it, hr, finance, facilities. Use "all" for a single wave covering everything when no departments are named.

schedule.kind:
- "at": a specific day/time ("this Saturday at 11 PM", "tomorrow at 10 PM", "next weekend").
- "relative": relative to the previous wave ("the following Saturday", "a week later") with week_offset (usually 1).
- "after": no fixed time, runs after another wave is validated; set after_wave.
- "immediate": now / immediately.
- "unspecified": no timing given.
relative is "this", "next" or "following" ("" if none). time is 24h "HH:MM" ("" if none). "weekend" means Saturday.

depends_on lists waves that must succeed first, with the customer's condition wording. success_criteria values use -1 when not stated; min_success_rate is a fraction (95% → 0.95). Blackout periods are times migrations must not run (business hours default Mon–Fri 09:00–18:00 when the customer mentions business hours without times). days use mon,tue,wed,thu,fri,sat,sun.

options (validation, remediation, human_escalation) are "disabled" only when the customer explicitly turns them off; otherwise "unstated".

wants_recommendation is true when the customer asks Zen to pick a time, gives no timing for the first wave, or says they want to avoid disruption.`;

function intentSchema(sourceIds, targetIds) {
  const str = { type: "string" };
  const num = { type: "number" };
  const bool = { type: "boolean" };
  const toggle = { type: "string", enum: ["enabled", "disabled", "unstated"] };
  const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  return obj({
    source: { type: "string", enum: sourceIds.concat("") },
    target: { type: "string", enum: targetIds.concat("") },
    record_types: { type: "array", items: { type: "string", enum: ["employees", "tickets"] } },
    scope: { type: "string", enum: ["all", "filtered"] },
    waves: {
      type: "array",
      items: obj({
        category: { type: "string", enum: CATEGORIES },
        schedule: obj({
          kind: { type: "string", enum: ["at", "relative", "after", "immediate", "unspecified"] },
          day: { type: "string", enum: DAY_ENUM },
          relative: { type: "string", enum: ["", "this", "next", "following"] },
          date: str,
          time: str,
          day_offset: num,
          week_offset: num,
          after_wave: { type: "string", enum: CATEGORIES.concat("") },
        }),
        depends_on: { type: "array", items: obj({ category: { type: "string", enum: CATEGORIES }, condition_text: str }) },
      }),
    },
    success_criteria: obj({
      min_success_rate: num,
      max_critical_errors: num,
      required_fields_populated: bool,
      reconciliation_complete: bool,
      no_unresolved_high_severity: bool,
    }),
    blackout: { type: "array", items: obj({ label: str, days: { type: "array", items: { type: "string", enum: DAY_ABBR } }, start: str, end: str }) },
    failure_policy: obj({ pause_below_success_rate: num, on_critical_failure: { type: "string", enum: ["", "pause", "stop", "escalate"] } }),
    window: obj({ duration_minutes: num, start_time: str, end_time: str, on_overrun: { type: "string", enum: ["", "pause", "continue", "escalate", "stop"] } }),
    options: obj({ validation: toggle, remediation: toggle, human_escalation: toggle }),
    recurrence: obj({ enabled: bool, day: { type: "string", enum: DAY_ENUM }, time: str }),
    wants_recommendation: bool,
    volume_hint: num,
    notes: { type: "array", items: str },
  });
}

const nz = (v) => (v === "" || v === -1 || v === undefined ? null : v);
const hhmmOrNull = (v) => (/^\d{2}:\d{2}$/.test(v || "") ? v : null);

/* sentinels → nulls, matching the rules interpreter's intent */
function normalizeAiIntent(ai) {
  const sc = ai.success_criteria || {};
  return {
    source: nz(ai.source),
    target: nz(ai.target),
    record_types: ai.record_types && ai.record_types.length ? ai.record_types : ["employees", "tickets"],
    scope: ai.scope || "all",
    waves: (ai.waves || []).map((w) => ({
      category: w.category,
      schedule: {
        kind: w.schedule.kind,
        day: nz(w.schedule.day),
        relative: nz(w.schedule.relative),
        date: /^\d{4}-\d{2}-\d{2}$/.test(w.schedule.date || "") ? w.schedule.date : null,
        time: hhmmOrNull(w.schedule.time),
        day_offset: nz(w.schedule.day_offset),
        week_offset: nz(w.schedule.week_offset),
        after_wave: nz(w.schedule.after_wave),
      },
      depends_on: (w.depends_on || []).filter((d) => d.category !== w.category),
    })),
    success_criteria: {
      min_success_rate: nz(sc.min_success_rate),
      max_critical_errors: nz(sc.max_critical_errors),
      // booleans: only "true" is a stated requirement; false means unstated
      required_fields_populated: sc.required_fields_populated || null,
      reconciliation_complete: sc.reconciliation_complete || null,
      no_unresolved_high_severity: sc.no_unresolved_high_severity || null,
    },
    blackout: (ai.blackout || []).filter((b) => hhmmOrNull(b.start) && hhmmOrNull(b.end) && b.days.length),
    failure_policy: {
      pause_below_success_rate: nz(ai.failure_policy.pause_below_success_rate),
      on_critical_failure: nz(ai.failure_policy.on_critical_failure),
    },
    window: {
      duration_minutes: nz(ai.window.duration_minutes),
      start_time: hhmmOrNull(ai.window.start_time),
      end_time: hhmmOrNull(ai.window.end_time),
      on_overrun: nz(ai.window.on_overrun),
    },
    // validation, remediation and escalation stay on unless explicitly turned off
    options: {
      validation: ai.options.validation !== "disabled",
      remediation: ai.options.remediation !== "disabled",
      human_escalation: ai.options.human_escalation !== "disabled",
    },
    recurrence: ai.recurrence && ai.recurrence.enabled
      ? { every: "week", day: nz(ai.recurrence.day) || "saturday", time: hhmmOrNull(ai.recurrence.time) || "23:00" }
      : null,
    wants_recommendation: Boolean(ai.wants_recommendation),
    volume_hint: nz(ai.volume_hint),
    notes: ai.notes || [],
  };
}

/**
 * @param {object} args
 * @param {string} args.text
 * @param {{sources: Array, targets: Array}} args.catalog
 * @param {string} [args.apiKey]
 * @param {object} [args.client]  injectable Anthropic client (tests)
 */
async function interpretWithClaude({ text, catalog, apiKey, client }) {
  const anthropic = client || new Anthropic({ apiKey, timeout: 60000, maxRetries: 1 });
  const sourceIds = catalog.sources.map((s) => s.id);
  const targetIds = catalog.targets.map((t) => t.id);
  const systems = "Source systems: " + catalog.sources.map((s) => s.id + " = " + s.name).join("; ") +
    "\nTarget systems: " + catalog.targets.map((t) => t.id + " = " + t.name).join("; ");

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: intentSchema(sourceIds, targetIds) } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: systems + "\n\nCustomer request:\n" + text }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off");
  const out = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizeAiIntent(JSON.parse(out));
}

module.exports = { interpretWithClaude, normalizeAiIntent, MODEL };
