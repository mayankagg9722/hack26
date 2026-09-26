const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const Anthropic = require("@anthropic-ai/sdk");

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const SYSTEM_PROMPT = `You are Zen, the AI onboarding assistant for the Zen product (getzen.ai).

Your job is to help users with:
- Product onboarding and guided setup sessions
- Payments and pricing questions
- Security, privacy, and compliance (SOC 2, encryption, data handling)
- Integrations (QuickBooks, Xero, Twilio, OAuth, field mapping, API keys)
- General support and when to escalate to a human

Tone: warm, clear, concise, and practical. Speak like a capable onboarding agent, not a generic chatbot.

Guidelines:
- Keep replies short (2–4 sentences) unless the user asks for detail.
- Use light HTML only when helpful: <b> for emphasis. No markdown, no code fences, no scripts.
- If you are unsure, say so and suggest a next step (live session sandbox, Admin Hub, or booking a demo).
- Never invent credentials, API keys, or claim you can see the user's real screen unless the product UI context says you are in a guided session.
- When context.page is "demo", you are helping during a live guided onboarding session; acknowledge their current step if provided and keep them moving forward.
- When context.page is "landing", you are on the marketing site helping visitors understand Zen.`;

function buildUserContent(message, context) {
  const page = (context && context.page) || "unknown";
  const step = (context && context.step) || "unknown";
  return [
    "Context:",
    `- page: ${page}`,
    `- step: ${step}`,
    "",
    "User message:",
    message,
  ].join("\n");
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return "";
  return response.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

exports.chatWithClaude = onRequest(
  {
    secrets: [anthropicApiKey],
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const context = body.context && typeof body.context === "object" ? body.context : {};

    if (!message) {
      res.status(400).json({ error: 'Missing required field "message".' });
      return;
    }

    if (message.length > 4000) {
      res.status(400).json({ error: "Message is too long." });
      return;
    }

    try {
      const client = new Anthropic({ apiKey: anthropicApiKey.value() });
      const response = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildUserContent(message, context),
          },
        ],
      });

      const reply = extractText(response);
      if (!reply) {
        logger.warn("Claude returned empty content", { id: response.id });
        res.status(502).json({
          error: "Empty response from Claude",
          reply:
            "I hit a snag generating a reply. Try one of the quick options, or ask again in a moment.",
        });
        return;
      }

      res.status(200).json({ reply });
    } catch (err) {
      logger.error("chatWithClaude failed", err);
      res.status(500).json({
        error: "Claude unavailable",
        reply:
          "I'm having trouble reaching my AI brain right now. Please try again in a moment, or use the quick options below.",
      });
    }
  }
);

/* ---------- Source → Zen → Target integrations (see ./migration) ---------- */
const { createMigrationApi } = require("./migration/api");

// Claude powers mapping suggestions when the key is available; otherwise
// Zen falls back to its built-in heuristics.
const handleMigrationApi = createMigrationApi({ getAnthropicKey: () => anthropicApiKey.value() });

exports.integrationsApi = onRequest(
  {
    secrets: [anthropicApiKey],
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 120,
  },
  handleMigrationApi
);

/* ---------- scheduled customer migrations ----------
   Starts JSM → Freshservice customer migrations whose scheduled time has come
   and drives them with the same engine "Start Migration" uses. (Locally the
   Integrations page also starts due migrations while it is open.) */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { CustomerMigrationEngine } = require("./migration/customers/engine");
const { CustomerMigrationStore, EntityMappingStore } = require("./migration/customers/stores");

exports.customerMigrationScheduler = onSchedule({ schedule: "every 5 minutes", timeoutSeconds: 120 }, async () => {
  const engine = new CustomerMigrationEngine({ store: new CustomerMigrationStore(), mappings: new EntityMappingStore() });
  const ran = await engine.runScheduled({ budgetMs: 100000 });
  logger.info("Scheduled customer migrations", { ran });
});
