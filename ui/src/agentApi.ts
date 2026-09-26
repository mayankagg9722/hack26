/* Client for the migration agent tools (/api/agent/*). No credentials here —
   every JSM / Freshservice / Claude call happens server-side. */

export type Mode = "live" | "mock";
export type Level = "HIGH" | "MEDIUM" | "LOW";

export interface EntityField { key: string; label?: string; api?: string; type?: string; required?: boolean; sample?: string | null }
export interface DiscoveredEntity {
  entityType: string; displayName: string; description: string; fields: EntityField[]; count: number | null;
  schemaSource: "api" | "documented" | "demo"; status: "ready" | "needs_config" | "error"; message?: string;
  migratesToLabel?: string; via?: string; values?: string[];
}
export interface Discovery { system: string; mode: Mode; label: "REAL API" | "MOCK DATA"; via: string; entities: DiscoveredEntity[]; notes?: string[]; writes_allowed?: boolean }

export interface MappingRow {
  source: string; sourceLabel: string; target: string | null; targetLabel: string | null; targetApi: string | null;
  confidence: number; level: Level | null; method: "exact" | "known" | "semantic" | "ai" | "none";
  transformation: string | null; reason: string; requiresConfirmation: boolean; decision: "auto" | "pending" | "confirmed" | "rejected";
}
export interface Mapping {
  mappingId: string; pair: string; label: string; fields: MappingRow[]; missingRequired: string[];
  aiUsed: boolean; aiAvailable?: boolean; aiError: string | null; createdAt: string;
}

export type RecStatus = "PENDING" | "SUCCESS" | "REMEDIATED" | "RESOLVED" | "SKIPPED" | "FAILED" | "HUMAN_REVIEW_REQUIRED";
export type RunStatus = "RUNNING" | "HUMAN_REVIEW_REQUIRED" | "COMPLETED" | "STOPPED" | "FAILED" | "BLOCKED";
export interface Failure { type: string; label: string; severity: "HIGH" | "MEDIUM" | "LOW"; message: string; stage: string; at: string; retry?: boolean; remediation: { strategy: string; detail: string; ok: boolean } | null }
export interface Review {
  problem: string; tried: string[]; recommendation: string; action: string; needsInput?: "email" | null;
  failure_type: string; severity: string; history?: { action: string; by: string; at: string }[];
  decision?: { action: string; by: string; at: string };
}
export interface LedgerRecord {
  key: string; entity: "customers" | "tickets"; entityType: string; sourceId: string; label: string; targetId: string | null;
  action: "created" | "updated" | "linked" | "update" | null; status: RecStatus; stage: string; timestamp: string;
  errors: Failure[]; error: Failure | null; remediationAttempted: boolean; remediationResult: "SUCCESS" | "FAILED" | null;
  remediation: { strategy: string; detail: string; ok: boolean; at: string; retry?: boolean }[]; notes: string[]; review: Review | null;
  workspace?: { id: string; name: string; rule: string };
}
export interface EntityCounts { total: number; processed: number; successful: number; remediated: number; resolved: number; failed: number; skipped: number; human_review: number; created: number; updated: number; linked: number }
export interface RunSummary {
  total: number; processed: number; migrated: number; successful: number; remediated: number; resolved: number;
  failed: number; skipped: number; human_review: number; progress: number; success_rate: number | null;
  per_entity: Record<string, EntityCounts>;
  failures_by_type: { type: string; label: string; severity: string; count: number; auto_fixed: number; human: number; open: number; examples: string[] }[];
}
export interface RunStep { key: string; entity: string | null; label: string; status: "upcoming" | "running" | "done" | "failed" | "skipped"; detail: string | null }
export interface Insights {
  generated_by: "claude" | "rules"; model?: string; error?: string; generated_at: string; duration_seconds: number;
  summary: { records: number; processed: number; migrated: number; successful_first_time: number; auto_remediated: number; resolved_by_human: number; skipped: number; failed: number; awaiting_human_review: number; success_rate: number | null };
  insights: {
    headline: string; went_well: string[]; went_wrong: { title: string; count: number; detail: string }[];
    how_fixed: { title: string; count: number }[]; needs_human: { count: number; reason: string; recommended_action: string }; recommendations: string[];
  };
}
export interface AgentRun {
  id: string; goal_id: string | null; goal_name: string | null; status: RunStatus; status_reason: string | null;
  source: { name: string; mode: Mode; via: string }; target: { name: string; mode: Mode; via: string };
  entities: string[]; mapping_ids: Record<string, string>; steps: RunStep[]; cursor: number;
  plan: null | { order: string[]; order_reason: string | null; workspace_mapping: Record<string, { workspace_id: string; workspace: string; rule: string }>; prechecks?: { check: string; ok: boolean; detail: string }[] };
  reconciliation: null | Record<string, { source_total: number; migrated: number; created: number; updated: number; linked: number; skipped: number; failed: number; pending_review: number; id_map_entries: number; verified_in_target: number; duplicate_target_ids: number; balanced: boolean }>;
  evaluation: null | { success_rate: number | null; min_success_rate: number; met: boolean };
  insights: Insights | null; summary: RunSummary; records?: LedgerRecord[];
  events: { at: string; level: string; message: string }[];
  created_at: string; started_at: string; finished_at: string | null;
}
export interface Goal { goal_id: string; name?: string; title?: string; record_types?: string[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
  return data as T;
}
const enc = encodeURIComponent;

export const agent = {
  source: () => call<Discovery>("GET", "/api/agent/source-entities"),
  target: () => call<Discovery>("GET", "/api/agent/target-entities"),
  latestMapping: (pair: string) => call<{ mapping: Mapping | null }>("GET", "/api/agent/mappings?pair=" + enc(pair)),
  generateMapping: (pair: string) => call<{ mapping: Mapping }>("POST", "/api/agent/mappings", { pair }),
  decide: (id: string, source: string, decision: "confirmed" | "rejected") => call<{ mapping: Mapping }>("POST", "/api/agent/mappings/" + enc(id) + "/decide", { source, decision }),
  runs: () => call<{ runs: AgentRun[] }>("GET", "/api/agent/runs"),
  run: (id: string) => call<{ run: AgentRun }>("GET", "/api/agent/runs/" + enc(id)),
  start: (body: { goalId?: string | null; entities: string[]; mappingIds: Record<string, string> }) => call<{ run: AgentRun }>("POST", "/api/agent/runs", body),
  advance: (id: string) => call<{ run: AgentRun }>("POST", "/api/agent/runs/" + enc(id) + "/advance", {}),
  review: (id: string, record: string, action: "approve" | "skip", input?: { email?: string }) => call<{ run: AgentRun }>("POST", "/api/agent/runs/" + enc(id) + "/review", { record, action, input }),
  stop: (id: string) => call<{ run: AgentRun }>("POST", "/api/agent/runs/" + enc(id) + "/stop", {}),
  insights: (id: string) => call<{ insights: Insights }>("POST", "/api/agent/runs/" + enc(id) + "/insights", {}),
  demoReset: () => call<Record<string, number>>("POST", "/api/agent/demo-reset", {}),
  goals: () => call<{ goals: Goal[] }>("GET", "/api/goals"),
};

export const PAIRS = [
  { pair: "customer→requester", entity: "customers", label: "Customers → Requesters" },
  { pair: "ticket→ticket", entity: "tickets", label: "Tickets → Tickets" },
] as const;

export function pct(x: number | null | undefined): string {
  return x == null ? "—" : +(x * 100).toFixed(1) + "%";
}
