import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, DatePicker, TimePicker, HyperlinkButton, InlineMessage, Modal, ProgressLoader, SegmentedTabs, Select, Spinner,
  Table, Tag, TextButton, TextField, Wizard, useToast,
} from "@freshworks/dew-components";
import type { ColumnDef, IStepperStepData, ISelectOption, TTagVariant } from "@freshworks/dew-components";
import { api, formatWhen } from "./api";
import type { CustomerMigration, CustomerRecord, MigrationConfig, RecordStatus, RunStatus } from "./api";
import { Section } from "./Shell";

/* Customers → Employees migration: setup, progress, results, details and scheduling.
   All orchestration happens on the server; this only starts, schedules, retries and shows state. */

const STATUS_TAG: Record<RecordStatus, { label: string; variant: TTagVariant }> = {
  MIGRATED: { label: "Migrated", variant: "green" },
  SKIPPED: { label: "Skipped", variant: "yellow" },
  FAILED: { label: "Failed", variant: "red" },
  PENDING: { label: "Pending", variant: "gray" },
  IN_PROGRESS: { label: "In progress", variant: "blue" },
};

const RUN_TAG: Record<RunStatus, { label: string; variant: TTagVariant }> = {
  SCHEDULED: { label: "Scheduled", variant: "blue" },
  RUNNING: { label: "In progress", variant: "blue" },
  COMPLETED: { label: "Completed", variant: "green" },
  COMPLETED_WITH_EXCEPTIONS: { label: "Completed with exceptions", variant: "yellow" },
  FAILED: { label: "Stopped", variant: "red" },
};

type Filter = "ALL" | "MIGRATED" | "SKIPPED" | "FAILED";
interface RecordRow extends CustomerRecord { id: string }
interface RunRow { id: string; run: CustomerMigration }

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export function CustomerMigrationSection() {
  const toast = useToast();
  const [cfg, setCfg] = useState<MigrationConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [runs, setRuns] = useState<CustomerMigration[]>([]);
  const [current, setCurrent] = useState<CustomerMigration | null>(null);
  const [project, setProject] = useState<ISelectOption | null>(null);
  const [count, setCount] = useState<string>("100");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState<Date | undefined>(undefined);
  const [scheduleTime, setScheduleTime] = useState<Date | undefined>(undefined);
  const scheduleAt = useMemo(() => {
    if (!scheduleDate || !scheduleTime) return undefined;
    const d = new Date(scheduleDate);
    d.setHours(scheduleTime.getHours(), scheduleTime.getMinutes(), 0, 0);
    return d;
  }, [scheduleDate, scheduleTime]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const driving = useRef<string | null>(null);
  // the date picker's calendar must render inside the modal, above its overlay
  const [pickerHost, setPickerHost] = useState<HTMLDivElement | null>(null);

  const projectOptions: ISelectOption[] = useMemo(() => (cfg ? cfg.projects.map((p) => ({ value: p.id, label: p.name })) : []), [cfg]);
  const needsConfig = cfg ? cfg.source.missing_config.length > 0 : false;
  const demoMode = cfg ? cfg.source.mode === "mock" && cfg.target.mode === "mock" : false;
  const running = current ? current.status === "RUNNING" : false;

  const open = useCallback(async (id: string) => {
    const { migration } = await api.get(id);
    setCurrent(migration);
    return migration;
  }, []);

  const refreshList = useCallback(async () => {
    const { migrations } = await api.list();
    setRuns(migrations);
    return migrations;
  }, []);

  /* first load */
  useEffect(() => {
    (async () => {
      try {
        const c = await api.config();
        setCfg(c);
        if (c.projects[0]) setProject({ value: c.projects[0].id, label: c.projects[0].name });
        const list = await refreshList();
        if (list[0]) await open(list[0].id);
      } catch (e) {
        setCfgError((e as Error).message);
      }
    })();
  }, [open, refreshList]);

  /* drive a running migration: the server does one step per call. Runs outside
     React's effect lifecycle so re-renders never cancel it mid-way. */
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const drive = useCallback(async (id: string) => {
    if (driving.current === id) return;
    driving.current = id;
    let m: CustomerMigration | null = null;
    try {
      do {
        m = (await api.advance(id)).migration;
        const latest = m;
        setCurrent((prev) => (prev && prev.id === id ? latest : prev));
        if (m.status === "RUNNING") await sleep(80);
      } while (m.status === "RUNNING" && driving.current === id);
    } catch (e) {
      toastRef.current.addErrorToast({ title: "Migration step failed", description: (e as Error).message });
    } finally {
      if (driving.current === id) driving.current = null;
    }
    await refreshList();
    if (!m) return;
    const t = toastRef.current;
    if (m.status === "COMPLETED") t.addSuccessToast({ title: "Migration complete", description: m.summary.migrated + " customers migrated to Freshservice." });
    else if (m.status === "COMPLETED_WITH_EXCEPTIONS") t.addWarningToast({ title: "Migration completed with exceptions", description: m.summary.failed + " customer(s) need attention." });
    else if (m.status === "FAILED") t.addErrorToast({ title: "Migration stopped", description: m.error || "" });
  }, [refreshList]);

  useEffect(() => {
    if (current && current.status === "RUNNING" && driving.current !== current.id) drive(current.id);
  }, [current, drive]);

  /* scheduled migrations start on the server when due; poll while any is waiting */
  useEffect(() => {
    if (!runs.some((r) => r.status === "SCHEDULED")) return;
    const t = setInterval(async () => {
      const list = await refreshList();
      const started = list.find((r) => r.status === "RUNNING");
      if (started && (!current || current.status !== "RUNNING")) await open(started.id);
    }, 5000);
    return () => clearInterval(t);
  }, [runs, current, refreshList, open]);

  async function start(scheduledAt?: Date) {
    if (!project) return;
    setBusy(true);
    try {
      const { migration } = await api.start({
        project_id: String(project.value),
        customer_count: Math.max(1, Math.min(1000, parseInt(count, 10) || 100)),
        scheduled_at: scheduledAt ? scheduledAt.toISOString() : undefined,
      });
      setShowDetails(false);
      setFilter("ALL");
      setCurrent(migration);
      await refreshList();
      if (scheduledAt) toast.addSuccessToast({ title: "Migration scheduled", description: "Zen will run it on " + formatWhen(scheduledAt.toISOString()) + "." });
      return true;
    } catch (e) {
      toast.addErrorToast({ title: scheduledAt ? "Could not schedule the migration" : "Could not start the migration", description: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (!current) return;
    try {
      const { migration } = await api.retryFailed(current.id);
      setCurrent(migration);
    } catch (e) {
      toast.addErrorToast({ title: "Could not retry", description: (e as Error).message });
    }
  }

  async function submitSchedule() {
    if (!scheduleDate || !scheduleTime) { setScheduleError("Choose a date and a time."); return; }
    if (!scheduleAt) return;
    if (scheduleAt <= new Date()) { setScheduleError("Choose a time in the future."); return; }
    setScheduleError(null);
    if (await start(scheduleAt)) setScheduleOpen(false);
  }

  if (cfgError) {
    return (
      <Section title="Customer migration">
        <InlineMessage variant="error">The migration service is not reachable ({cfgError}). Start Zen's backend and reload this page.</InlineMessage>
      </Section>
    );
  }

  return (
    <Section title="Customer migration" description="Zen creates customers in Jira Service Management, maps them to the JSM project, fetches them from the project and creates them as Freshservice employees.">
      {/* ---------- setup ---------- */}
      <Card variant="outlined" padding="none" className="zen-setup">
        <dl className="zen-setup-grid">
          <div className="zen-setup-item">
            <dt className="fw-text-sm fw-text-secondary">Source</dt>
            <dd>
              <span className="fw-text-base fw-font-semibold">Jira Service Management</span>
              {cfg ? (needsConfig ? <Tag variant="yellow" iconName="Warning">Needs configuration</Tag> : <Tag variant="green" iconName="Check">Connected</Tag>) : <Spinner size="xs" aria-label="Checking connection" />}
            </dd>
          </div>
          <div className="zen-setup-arrow fw-text-secondary" aria-hidden="true">→</div>
          <div className="zen-setup-item">
            <dt className="fw-text-sm fw-text-secondary">Destination</dt>
            <dd>
              <span className="fw-text-base fw-font-semibold">Freshservice</span>
              {cfg ? <Tag variant="green" iconName="Check">Connected</Tag> : <Spinner size="xs" aria-label="Checking connection" />}
            </dd>
          </div>
          <div className="zen-setup-item">
            <dt className="fw-text-sm fw-text-secondary">Migration</dt>
            <dd><span className="fw-text-base fw-font-semibold">Customers → Employees</span></dd>
          </div>
        </dl>
        <div className="zen-setup-form fw-border-divider-mildest">
          <div className="zen-field">
            <label className="fw-text-sm fw-font-semibold" id="zen-project-label">JSM project</label>
            <Select
              aria-labelledby="zen-project-label"
              options={projectOptions}
              value={project}
              onValueChange={(v) => setProject(v)}
              placeholder="Choose a project"
              disabled={!cfg || running}
            />
          </div>
          <div className="zen-field zen-field-narrow">
            <TextField label="Customers" type="number" min={1} max={1000} value={count} disabled={running}
              onChange={(v) => setCount(v == null ? "" : String(v))} />
          </div>
          <div className="zen-setup-actions">
            <TextButton variant="secondary" prefixIcon="Calendar" disabled={!cfg || !project || running || busy || needsConfig}
              onClick={() => { setScheduleError(null); setScheduleOpen(true); }}>
              Schedule Migration
            </TextButton>
            <TextButton variant="primary" loading={busy} disabled={!cfg || !project || running || needsConfig} onClick={() => start()}>
              Start Migration
            </TextButton>
          </div>
        </div>
      </Card>

      {needsConfig && cfg ? (
        <InlineMessage variant="warning">
          The JSM connection needs server configuration before it can run: {cfg.source.missing_config.join(", ")}.
        </InlineMessage>
      ) : null}
      {demoMode ? (
        <div className="zen-demo-note">
          <InlineMessage variant="info">Demo mode — Jira Service Management and Freshservice are simulated in this environment. Add API credentials on the server to connect real accounts.</InlineMessage>
          <TextButton variant="link" size="mini" disabled={running} onClick={async () => {
            await api.demoReset(); setCurrent(null); setRuns([]); toast.addInfoToast({ title: "Demo data reset" });
          }}>Reset demo data</TextButton>
        </div>
      ) : null}

      {/* ---------- current migration ---------- */}
      {current ? <MigrationStatus m={current} onRetry={retryFailed} showDetails={showDetails} setShowDetails={setShowDetails} filter={filter} setFilter={setFilter} /> : (
        cfg ? <p className="zen-empty fw-text-base fw-text-secondary">No migrations yet. Choose a project and start a migration — Zen will show each step here.</p> : null
      )}

      {/* ---------- history & schedules ---------- */}
      {runs.length > 0 ? <MigrationList runs={runs} currentId={current ? current.id : null} onOpen={(id) => { setShowDetails(false); open(id); }} /> : null}

      {/* ---------- schedule modal ---------- */}
      <Modal open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <Modal.Content size="md">
          <Modal.Header title="Schedule migration" description="Zen runs the same migration automatically at the time you choose." onClose={() => setScheduleOpen(false)} />
          <Modal.Body>
            <dl className="zen-summary-list">
              <div><dt className="fw-text-secondary">Source</dt><dd>Jira Service Management</dd></div>
              <div><dt className="fw-text-secondary">Destination</dt><dd>Freshservice</dd></div>
              <div><dt className="fw-text-secondary">Migration</dt><dd>Customers → Employees</dd></div>
              <div><dt className="fw-text-secondary">JSM project</dt><dd>{project ? project.label : "—"}</dd></div>
              <div><dt className="fw-text-secondary">Customers</dt><dd>{count}</dd></div>
            </dl>
            <div className="zen-when">
              <div className="zen-field">
                <label className="fw-text-sm fw-font-semibold" id="zen-date-label">Date</label>
                <DatePicker aria-labelledby="zen-date-label" value={scheduleDate} onChange={setScheduleDate} minDate={new Date()}
                  error={Boolean(scheduleError) && !scheduleDate} portalTarget={pickerHost} />
              </div>
              <div className="zen-field">
                <label className="fw-text-sm fw-font-semibold" id="zen-time-label">Time</label>
                <TimePicker aria-labelledby="zen-time-label" value={scheduleTime} onChange={setScheduleTime} minuteStep={5}
                  error={Boolean(scheduleError) && !scheduleTime} portalTarget={pickerHost} />
              </div>
            </div>
            {scheduleError ? <span className="fw-text-sm fw-text-error">{scheduleError}</span> : null}
            {scheduleAt ? <p className="fw-text-sm fw-text-secondary">Runs {formatWhen(scheduleAt.toISOString())} (your local time).</p> : null}
            <div ref={setPickerHost} />
          </Modal.Body>
          <Modal.Footer>
            <TextButton variant="secondary" onClick={() => setScheduleOpen(false)}>Cancel</TextButton>
            <TextButton variant="primary" loading={busy} onClick={submitSchedule}>Schedule migration</TextButton>
          </Modal.Footer>
        </Modal.Content>
      </Modal>
    </Section>
  );
}

/* ---------- status of one migration ---------- */

function toSteps(m: CustomerMigration): { steps: IStepperStepData[]; current: number } {
  let active = m.steps.findIndex((s) => s.status === "running" || s.status === "failed");
  if (active < 0) active = m.steps.every((s) => s.status === "done") ? m.steps.length - 1 : 0;
  return {
    current: active,
    steps: m.steps.map((s) => ({
      id: s.key,
      label: s.status === "running" && s.running ? s.running : s.label,
      description: s.status === "failed" ? undefined : s.detail || undefined,
      errorMessage: s.status === "failed" ? s.detail : undefined,
      status: s.status === "done" ? "completed" : s.status === "running" ? "active" : s.status === "failed" ? "error" : "upcoming",
    })),
  };
}

function MigrationStatus({ m, onRetry, showDetails, setShowDetails, filter, setFilter }: {
  m: CustomerMigration; onRetry: () => void; showDetails: boolean; setShowDetails: (v: boolean) => void; filter: Filter; setFilter: (f: Filter) => void;
}) {
  const s = m.summary;
  const finished = m.status === "COMPLETED" || m.status === "COMPLETED_WITH_EXCEPTIONS" || m.status === "FAILED";
  const { steps, current } = toSteps(m);
  const failed = (m.records || []).filter((r) => r.status === "FAILED");
  const title = m.status === "RUNNING" ? "Migration in progress" : m.status === "SCHEDULED" ? "Migration scheduled"
    : m.status === "COMPLETED" ? "Migration complete" : m.status === "COMPLETED_WITH_EXCEPTIONS" ? "Migration completed with exceptions" : "Migration stopped";

  return (
    <div className="zen-run">
      <div className="zen-run-head">
        <div className="zen-run-title">
          {m.status === "RUNNING" ? <Spinner size="sm" aria-label="Migration in progress" /> : null}
          <h3 className="fw-text-xl fw-font-semibold">{title}</h3>
          <Tag variant={RUN_TAG[m.status].variant}>{RUN_TAG[m.status].label}</Tag>
        </div>
        <p className="fw-text-sm fw-text-secondary">
          {m.config.project_name} · {s.total} customers · {m.id}
          {m.status === "SCHEDULED" ? " · runs " + formatWhen(m.config.scheduled_at) : m.finished_at ? " · finished " + formatWhen(m.finished_at) : m.started_at ? " · started " + formatWhen(m.started_at) : ""}
          {m.retries ? " · retried " + m.retries + "×" : ""}
        </p>
      </div>

      <div className="zen-run-body">
        <Wizard.Vertical aria-label="Migration steps" currentStep={current} steps={steps} size="default" />

        <div className="zen-run-side">
          {m.status === "SCHEDULED" ? (
            <InlineMessage variant="info">Scheduled for {formatWhen(m.config.scheduled_at)}. Zen starts automatically and runs the same steps as Start Migration.</InlineMessage>
          ) : (
            <>
              <div className="zen-count">
                <span className="fw-text-2xl fw-font-semibold">{s.migrated + s.skipped}</span>
                <span className="fw-text-base fw-text-secondary"> / {s.total} customers migrated</span>
              </div>
              <ProgressLoader aria-label="Customers migrated" value={s.done} max={s.total || 1} />
              <dl className="zen-results">
                <div><dt><Tag variant="green">Migrated</Tag></dt><dd className="fw-text-2xl fw-font-semibold">{s.migrated}</dd></div>
                <div><dt><Tag variant="yellow">Skipped</Tag></dt><dd className="fw-text-2xl fw-font-semibold">{s.skipped}</dd></div>
                <div><dt><Tag variant="red">Failed</Tag></dt><dd className="fw-text-2xl fw-font-semibold">{s.failed}</dd></div>
              </dl>
              {finished && m.status === "COMPLETED" ? <InlineMessage variant="success">Every customer is in Freshservice and its JSM ↔ Freshservice mapping is stored.</InlineMessage> : null}
              {finished && m.status === "COMPLETED_WITH_EXCEPTIONS" ? (
                <InlineMessage variant="warning">
                  {failed.length} customer{failed.length === 1 ? "" : "s"} failed: {failed.slice(0, 2).map((r) => (r.name || "(no name in JSM)") + " — " + r.message).join("; ")}{failed.length > 2 ? "; …" : ""}
                </InlineMessage>
              ) : null}
              {m.status === "FAILED" ? <InlineMessage variant="error">{m.error}</InlineMessage> : null}
              {finished ? (
                <div className="zen-run-actions">
                  <TextButton variant="secondary" onClick={() => setShowDetails(!showDetails)} active={showDetails}>
                    {showDetails ? "Hide migration details" : "View migration details"}
                  </TextButton>
                  {failed.length || m.status === "FAILED" ? <TextButton variant="primary" prefixIcon="Refresh" onClick={onRetry}>Retry failed</TextButton> : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {showDetails ? <MigrationDetails m={m} filter={filter} setFilter={setFilter} /> : null}
    </div>
  );
}

/* ---------- per-customer records ---------- */

function MigrationDetails({ m, filter, setFilter }: { m: CustomerMigration; filter: Filter; setFilter: (f: Filter) => void }) {
  const records = m.records || [];
  const count = (f: Filter) => (f === "ALL" ? records.length : records.filter((r) => r.status === f).length);
  const data: RecordRow[] = records.filter((r) => filter === "ALL" || r.status === filter).map((r) => ({ ...r, id: r.key }));
  const columns: ColumnDef<RecordRow>[] = [
    {
      id: "customer", header: "Customer", size: 230,
      cell: ({ row }) => (
        <div className="zen-cell-stack">
          <span className="fw-text-base fw-font-medium">{row.original.name || "(no name in JSM)"}</span>
          <span className="fw-text-sm fw-text-secondary">{row.original.email}</span>
        </div>
      ),
    },
    { id: "jsm", header: "JSM Customer ID", size: 165, cell: ({ row }) => <code className="zen-code fw-text-sm">{row.original.jsm_customer_id || "—"}</code> },
    { id: "fs", header: "Freshservice Employee ID", size: 150, cell: ({ row }) => <code className="zen-code fw-text-sm">{row.original.fs_employee_id || "—"}</code> },
    { id: "status", header: "Status", size: 105, cell: ({ row }) => <Tag variant={STATUS_TAG[row.original.status].variant}>{STATUS_TAG[row.original.status].label}</Tag> },
    {
      id: "error", header: "Error", size: 250,
      cell: ({ row }) => row.original.status === "FAILED"
        ? <span className="fw-text-sm fw-text-error">{row.original.message}</span>
        : <span className="fw-text-sm fw-text-secondary">{row.original.message || "—"}</span>,
    },
    { id: "updated", header: "Last updated", size: 150, cell: ({ row }) => <span className="fw-text-sm fw-text-secondary">{formatWhen(row.original.updated_at)}</span> },
  ];
  return (
    <div className="zen-details">
      <div className="zen-details-head">
        <h4 className="fw-text-lg fw-font-semibold">Migration details</h4>
        <SegmentedTabs value={filter} onValueChange={(v) => setFilter(v as Filter)} size="mini">
          <SegmentedTabs.List aria-label="Filter customers by status">
            <SegmentedTabs.Trigger value="ALL">All ({count("ALL")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="MIGRATED">Migrated ({count("MIGRATED")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="SKIPPED">Skipped ({count("SKIPPED")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="FAILED">Failed ({count("FAILED")})</SegmentedTabs.Trigger>
          </SegmentedTabs.List>
        </SegmentedTabs>
      </div>
      <div className="zen-table-scroll">
        <Table<RecordRow> data={data} columns={columns} rowDensity="compact" skipPagination />
      </div>
    </div>
  );
}

/* ---------- migrations and schedules ---------- */

function MigrationList({ runs, currentId, onOpen }: { runs: CustomerMigration[]; currentId: string | null; onOpen: (id: string) => void }) {
  const data: RunRow[] = runs.map((r) => ({ id: r.id, run: r }));
  const columns: ColumnDef<RunRow>[] = [
    {
      id: "migration", header: "Migration", size: 210,
      cell: ({ row }) => (
        <div className="zen-cell-stack">
          <span className="fw-text-base fw-font-medium">Customers → Employees</span>
          <span className="fw-text-sm fw-text-secondary">{row.original.id}{row.original.id === currentId ? " · shown above" : ""}</span>
        </div>
      ),
    },
    { id: "route", header: "Source → Destination", size: 250, cell: () => <span className="fw-text-base">Jira Service Management → Freshservice</span> },
    { id: "project", header: "JSM project", size: 170, cell: ({ row }) => <span className="fw-text-base">{row.original.run.config.project_name}</span> },
    {
      id: "when", header: "Scheduled / started", size: 180,
      cell: ({ row }) => <span className="fw-text-sm">{formatWhen(row.original.run.config.scheduled_at || row.original.run.started_at || row.original.run.created_at)}</span>,
    },
    {
      id: "result", header: "Result", size: 220,
      cell: ({ row }) => {
        const s = row.original.run.summary;
        return row.original.run.status === "SCHEDULED" ? <span className="fw-text-sm fw-text-secondary">{s.total} customers</span>
          : <span className="fw-text-sm">{s.migrated} migrated · {s.skipped} skipped · {s.failed} failed</span>;
      },
    },
    { id: "status", header: "Status", size: 200, cell: ({ row }) => <Tag variant={RUN_TAG[row.original.run.status].variant}>{RUN_TAG[row.original.run.status].label}</Tag> },
    { id: "open", header: "", size: 90, cell: ({ row }) => <HyperlinkButton href={"#" + row.original.id} size="mini" onClick={(e) => { e.preventDefault(); onOpen(row.original.id); }}>Open</HyperlinkButton> },
  ];
  return (
    <div className="zen-history">
      <h4 className="fw-text-lg fw-font-semibold">Scheduled and recent migrations</h4>
      <div className="zen-table-x"><Table<RunRow> data={data} columns={columns} rowDensity="compact" skipPagination onRowClick={(r) => onOpen(r.id)} /></div>
    </div>
  );
}
