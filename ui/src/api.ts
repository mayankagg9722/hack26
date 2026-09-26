/* Thin client for Zen's existing backend. No credentials here — every
   JSM / Freshservice call happens server-side. */

export type RecordStatus = "PENDING" | "IN_PROGRESS" | "MIGRATED" | "SKIPPED" | "FAILED";
export type RunStatus = "SCHEDULED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_EXCEPTIONS" | "FAILED";

export interface MigrationStep { key: string; label: string; running?: string; status: "pending" | "running" | "done" | "failed"; detail: string }
export interface CustomerRecord {
  key: string; name: string; email: string; jsm_customer_id: string | null; fs_employee_id: string | null;
  status: RecordStatus; stage: string | null; message: string; attempts: number; updated_at?: string;
}
export interface Summary { total: number; migrated: number; skipped: number; failed: number; pending: number; in_progress: number; done: number }
export interface CustomerMigration {
  id: string; status: RunStatus; phase: string | null; retries: number; error: string | null;
  source: { name: string; mode: string }; target: { name: string; mode: string };
  config: { project_id: string; project_name: string; customer_count: number; scheduled_at: string | null; created_by: string };
  steps: MigrationStep[]; records?: CustomerRecord[]; failed_records?: CustomerRecord[]; summary: Summary;
  created_at: string; started_at: string | null; finished_at: string | null; updated_at: string;
}
export interface MigrationConfig {
  source: { name: string; mode: string; missing_config: string[] };
  target: { name: string; mode: string };
  entity: { source: string; target: string };
  projects: { id: string; name: string }[];
}
export interface IntegrationInfo { id: string; name: string; role: "source" | "target"; mode: string; description: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
  return data as T;
}

export const api = {
  config: () => call<MigrationConfig>("GET", "/api/customer-migrations/config"),
  list: () => call<{ migrations: CustomerMigration[] }>("GET", "/api/customer-migrations"),
  get: (id: string) => call<{ migration: CustomerMigration }>("GET", "/api/customer-migrations/" + encodeURIComponent(id)),
  start: (body: { project_id: string; customer_count: number; scheduled_at?: string }) =>
    call<{ migration: CustomerMigration }>("POST", "/api/customer-migrations", body),
  advance: (id: string) => call<{ migration: CustomerMigration }>("POST", "/api/customer-migrations/" + encodeURIComponent(id) + "/advance", {}),
  retryFailed: (id: string) => call<{ migration: CustomerMigration }>("POST", "/api/customer-migrations/" + encodeURIComponent(id) + "/retry-failed", {}),
  demoReset: () => call<Record<string, number>>("POST", "/api/customer-migrations/demo-reset", {}),
  integrations: () => call<{ sources: IntegrationInfo[]; targets: IntegrationInfo[] }>("GET", "/api/integrations"),
  connect: (id: string) => call<{ connected: boolean; message: string }>("POST", "/api/integrations/" + encodeURIComponent(id) + "/connect", {}),
};

/* Connection choices are shared with the Field mapping and Goal planner pages. */
const STORE_KEY = "zen.integrations.v1";
export interface ConnState { connected: Record<string, boolean>; source: string; target: string; demo: { count: number; seed: number } }
export function loadConn(): ConnState {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && s.connected) return s;
  } catch (e) { /* fall through */ }
  return { connected: {}, source: "jira", target: "freshservice", demo: { count: 750, seed: 42 } };
}
export function saveConn(s: ConnState) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
