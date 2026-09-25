/* Adapter registry — the only place that knows which concrete adapter backs
   each system. Swapping mock → live is a config change (env vars), not a
   code change anywhere else. */

const { MockSourceAdapter } = require("./adapters/MockSourceAdapter");
const { JiraSourceAdapter } = require("./adapters/JiraSourceAdapter");
const { FreshserviceTargetAdapter } = require("./adapters/FreshserviceTargetAdapter");
const { MockFreshserviceTargetAdapter } = require("./adapters/MockFreshserviceTargetAdapter");

const DEFAULT_COUNT = 750;
const MAX_COUNT = 5000;

const SOURCES = {
  jira: {
    meta: {
      id: "jira",
      name: "Jira Service Management",
      system: "jira-service-management",
      description: "Service desk tickets and requesters from Jira Cloud.",
    },
    profile: "jira",
    live: (env) =>
      env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN
        ? { baseUrl: env.JIRA_BASE_URL, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN, jql: env.JIRA_JQL || undefined }
        : null,
    LiveAdapter: JiraSourceAdapter,
  },
  "legacy-itsm": {
    meta: {
      id: "legacy-itsm",
      name: "Legacy ITSM",
      system: "legacy-itsm",
      description: "On-prem ITSM export (incidents with P1–P4 priorities).",
    },
    profile: "legacy-itsm",
    live: () => null, // no live connector yet
  },
  "mock-legacy": {
    meta: {
      id: "mock-legacy",
      name: "Mock Legacy System",
      system: "mock-legacy",
      description: "Synthetic legacy helpdesk for demos and testing.",
    },
    profile: "mock-legacy",
    live: () => null,
  },
};

const TARGETS = {
  freshservice: {
    meta: {
      id: "freshservice",
      name: "Freshservice",
      system: "freshservice",
      description: "Freshworks ITSM — tickets, requesters and departments.",
    },
    live: (env) =>
      env.FRESHSERVICE_DOMAIN && env.FRESHSERVICE_API_KEY
        ? { domain: env.FRESHSERVICE_DOMAIN, apiKey: env.FRESHSERVICE_API_KEY }
        : null,
    LiveAdapter: FreshserviceTargetAdapter,
    MockAdapter: MockFreshserviceTargetAdapter,
  },
};

function clampCount(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_COUNT;
  return Math.min(v, MAX_COUNT);
}

/**
 * @param {string} id
 * @param {object} [opts]  demo options for mock adapters: { count, seed }
 * @param {object} [env]
 * @returns {import("./adapters/SourceAdapter").SourceAdapter|null}
 */
function createSourceAdapter(id, opts = {}, env = process.env) {
  const def = SOURCES[id];
  if (!def) return null;
  const liveConfig = def.live(env);
  if (liveConfig && def.LiveAdapter) return new def.LiveAdapter(def.meta, liveConfig);
  const seed = parseInt(opts.seed, 10);
  return new MockSourceAdapter(def.meta, {
    profile: def.profile,
    count: clampCount(opts.count),
    seed: Number.isFinite(seed) ? seed : 42,
    quality: opts.quality === "clean" ? "clean" : "realistic",
  });
}

/** @returns {import("./adapters/TargetAdapter").TargetAdapter|null} */
function createTargetAdapter(id, env = process.env) {
  const def = TARGETS[id];
  if (!def) return null;
  const liveConfig = def.live(env);
  return liveConfig ? new def.LiveAdapter(def.meta, liveConfig) : new def.MockAdapter(def.meta);
}

function listIntegrations(env = process.env) {
  return {
    sources: Object.keys(SOURCES).map((id) => createSourceAdapter(id, {}, env).info()),
    targets: Object.keys(TARGETS).map((id) => createTargetAdapter(id, env).info()),
  };
}

module.exports = {
  createSourceAdapter,
  createTargetAdapter,
  listIntegrations,
  DEFAULT_COUNT,
  MAX_COUNT,
};
