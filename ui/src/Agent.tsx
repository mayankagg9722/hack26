import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card, Checkbox, InlineMessage, ProgressLoader, SegmentedTabs, Select, Spinner, Table, Tag, TextButton, TextField, useToast,
} from "@freshworks/dew-components";
import type { ColumnDef, ISelectOption, TTagVariant } from "@freshworks/dew-components";
import { agent, PAIRS, pct } from "./agentApi";
import type { AgentRun, Discovery, DiscoveredEntity, Goal, Insights, LedgerRecord, Mapping, MappingRow, RecStatus, RunStatus, RunStep } from "./agentApi";
import { formatWhen } from "./api";
import { Section } from "./Shell";

/* Migration agent: discover → map → run (with remediation and human review) → insights.
   The server does all the work; every number here comes from the run's record ledger. */

const MODE_TAG = (mode: string) => (mode === "live"
  ? <Tag variant="green" iconName="Check">REAL API</Tag>
  : <Tag variant="yellow">MOCK DATA</Tag>);

const LEVEL_VARIANT: Record<string, TTagVariant> = { HIGH: "green", MEDIUM: "yellow", LOW: "red" };
const REC_TAG: Record<RecStatus, { label: string; variant: TTagVariant }> = {
  PENDING: { label: "Pending", variant: "gray" },
  SUCCESS: { label: "Success", variant: "green" },
  REMEDIATED: { label: "Remediated", variant: "blue" },
  RESOLVED: { label: "Resolved by human", variant: "blue" },
  SKIPPED: { label: "Skipped", variant: "yellow" },
  FAILED: { label: "Failed", variant: "red" },
  HUMAN_REVIEW_REQUIRED: { label: "Human review", variant: "red" },
};
const RUN_TAG: Record<RunStatus, { label: string; variant: TTagVariant }> = {
  RUNNING: { label: "Running", variant: "blue" },
  HUMAN_REVIEW_REQUIRED: { label: "Human review required", variant: "red" },
  COMPLETED: { label: "Completed", variant: "green" },
  STOPPED: { label: "Stopped", variant: "gray" },
  FAILED: { label: "Failed", variant: "red" },
  BLOCKED: { label: "Blocked", variant: "red" },
};
const STEP_TAG: Record<RunStep["status"], { label: string; variant: TTagVariant }> = {
  upcoming: { label: "Upcoming", variant: "gray" },
  running: { label: "In progress", variant: "blue" },
  done: { label: "Done", variant: "green" },
  failed: { label: "Failed", variant: "red" },
  skipped: { label: "Not needed", variant: "gray" },
};
const TRANSFORM_TEXT: Record<string, string> = {
  direct: "direct", rename: "rename", splitName: "splitName()", transformPriority: "transformPriority()", transformStatus: "transformStatus()",
  lookupRequester: "lookup requester", lookupDepartment: "lookup department", classifyWorkspace: "Workspace Classification",
  issueType: "transformType()", preserveInDescription: "keep in description", idMapping: "Zen ID map", lookup: "lookup",
};

export function AgentPage() {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [source, setSource] = useState<Discovery | null>(null);
  const [target, setTarget] = useState<Discovery | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [mappings, setMappings] = useState<Record<string, Mapping | null>>({});
  const [run, setRun] = useState<AgentRun | null>(null);
  const driving = useRef<string | null>(null);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const [s, t] = await Promise.all([agent.source(), agent.target()]);
      setSource(s);
      setTarget(t);
    } catch (e) {
      setDiscoverError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    discover();
    Promise.all(PAIRS.map((p) => agent.latestMapping(p.pair))).then((res) => {
      setMappings(Object.fromEntries(PAIRS.map((p, i) => [p.entity, res[i].mapping])));
    }).catch(() => null);
    agent.runs().then(async ({ runs }) => {
      if (runs[0]) setRun((await agent.run(runs[0].id)).run);
    }).catch(() => null);
  }, [discover]);

  // advance the run while it is RUNNING; each call does one bounded step on the server
  const drive = useCallback(async (id: string) => {
    if (driving.current === id) return;
    driving.current = id;
    try {
      let r: AgentRun;
      do {
        r = (await agent.advance(id)).run;
        setRun(r);
        await new Promise((ok) => setTimeout(ok, 60));
      } while (r.status === "RUNNING" && driving.current === id);
      if (r.status === "COMPLETED") toastRef.current.addSuccessToast({ title: "Migration completed", description: r.status_reason || "" });
      else if (r.status === "HUMAN_REVIEW_REQUIRED") toastRef.current.addWarningToast({ title: "Human review required", description: r.status_reason || "" });
      else if (r.status === "BLOCKED" || r.status === "FAILED") toastRef.current.addErrorToast({ title: "Migration " + r.status.toLowerCase(), description: r.status_reason || "" });
    } catch (e) {
      toastRef.current.addErrorToast({ title: "Lost contact with the migration", description: (e as Error).message });
    } finally {
      if (driving.current === id) driving.current = null;
    }
  }, []);

  useEffect(() => {
    if (run && run.status === "RUNNING") drive(run.id);
  }, [run, drive]);

  return (
    <>
      <DiscoverSection source={source} target={target} error={discoverError} loading={discovering} onRefresh={discover} />
      <MappingSection mappings={mappings} setMappings={setMappings} ready={Boolean(source && target)} run={run} />
      <RunSection mappings={mappings} run={run} setRun={setRun} demo={source?.mode === "mock" && target?.mode === "mock"} targetWrites={target ? target.writes_allowed !== false : true}
        onReset={async () => {
          await agent.demoReset();
          setRun(null);
          setMappings({});
          discover();
          toast.addInfoToast({ title: "Demo data reset", description: "Migrations, mappings and the simulated Freshservice records were cleared." });
        }} />
      {run && run.summary.processed > 0 ? <InsightsSection run={run} setRun={setRun} /> : null}
    </>
  );
}

/* ---------- 1. discover ---------- */

function DiscoverSection({ source, target, error, loading, onRefresh }: { source: Discovery | null; target: Discovery | null; error: string | null; loading: boolean; onRefresh: () => void }) {
  return (
    <Section title="1. Discover entities" description="Zen asks each system what it holds and which fields it exposes (list_source_entities, list_target_entities)."
      aside={<TextButton variant="secondary" size="mini" prefixIcon="Refresh" loading={loading} onClick={onRefresh}>Discover again</TextButton>}>
      {error ? <InlineMessage variant="error">Discovery failed: {error}</InlineMessage> : null}
      <div className="zen-agent-systems">
        <SystemCard role="Source" d={source} />
        <SystemCard role="Target" d={target} />
      </div>
      {target?.notes?.length ? <InlineMessage variant="warning">{target.notes.join(" ")}</InlineMessage> : null}
    </Section>
  );
}

function SystemCard({ role, d }: { role: string; d: Discovery | null }) {
  type ERow = DiscoveredEntity & { id: string };
  const columns: ColumnDef<ERow>[] = [
    {
      id: "entity", header: "Entity", size: 190,
      cell: ({ row }) => (
        <div className="zen-cell-stack">
          <span className="fw-text-base fw-font-medium">{row.original.displayName}</span>
          <span className="fw-text-sm fw-text-secondary">{row.original.description}</span>
          {row.original.status !== "ready" ? <span className="fw-text-sm fw-text-secondary">{row.original.message}</span> : null}
        </div>
      ),
    },
    {
      id: "fields", header: "Fields", size: 150,
      cell: ({ row }) => (
        <span className="fw-text-sm fw-text-secondary" title={row.original.fields.map((f) => f.key).join(", ")}>
          {row.original.fields.length} · {row.original.fields.slice(0, 4).map((f) => f.key).join(", ")}{row.original.fields.length > 4 ? "…" : ""}
        </span>
      ),
    },
    { id: "count", header: "Records", size: 80, cell: ({ row }) => <span className="fw-text-base">{row.original.count == null ? "—" : row.original.count.toLocaleString()}</span> },
    {
      id: "status", header: role === "Source" ? "Migrates to" : "Status", size: 130,
      cell: ({ row }) => row.original.status === "ready"
        ? (role === "Source" ? <span className="fw-text-sm">{row.original.migratesToLabel}</span> : <Tag variant="green" iconName="Check">Discovered</Tag>)
        : <Tag variant={row.original.status === "error" ? "red" : "yellow"}>{row.original.status === "error" ? "Error" : "Needs configuration"}</Tag>,
    },
  ];
  return (
    <Card variant="outlined" className="zen-agent-system">
      <div className="zen-agent-system-head">
        <div>
          <div className="fw-text-sm fw-text-secondary zen-eyebrow">{role} system</div>
          <div className="fw-text-lg fw-font-semibold">{d ? d.system : role === "Source" ? "Jira Service Management" : "Freshservice"}</div>
        </div>
        {d ? <div className="zen-agent-mode">{MODE_TAG(d.mode)}<span className="fw-text-sm fw-text-secondary">via {d.via}</span></div> : <Spinner size="xs" aria-label="Discovering" />}
      </div>
      <div className="zen-table-x">
        <Table<ERow> data={d ? d.entities.map((e) => ({ ...e, id: e.entityType })) : []} columns={columns} rowDensity="compact" skipPagination isDataLoading={!d} />
      </div>
    </Card>
  );
}

/* ---------- 2. mapping ---------- */

function MappingSection({ mappings, setMappings, ready, run }: { mappings: Record<string, Mapping | null>; setMappings: (f: (m: Record<string, Mapping | null>) => Record<string, Mapping | null>) => void; ready: boolean; run: AgentRun | null }) {
  const toast = useToast();
  const [tab, setTab] = useState<string>(PAIRS[0].entity);
  const [busy, setBusy] = useState<string | null>(null);
  const pair = PAIRS.find((p) => p.entity === tab) || PAIRS[0];
  const m = mappings[pair.entity] || null;

  async function generate() {
    setBusy("generate");
    try {
      const res = await agent.generateMapping(pair.pair);
      setMappings((prev) => ({ ...prev, [pair.entity]: res.mapping }));
    } catch (e) {
      toast.addErrorToast({ title: "Could not generate the mapping", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function decide(row: MappingRow, decision: "confirmed" | "rejected") {
    if (!m) return;
    setBusy(row.source + decision);
    try {
      const res = await agent.decide(m.mappingId, row.source, decision);
      setMappings((prev) => ({ ...prev, [pair.entity]: res.mapping }));
    } catch (e) {
      toast.addErrorToast({ title: "Could not save the decision", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const pending = m ? m.fields.filter((f) => f.decision === "pending").length : 0;
  type MRow = MappingRow & { id: string };
  const columns: ColumnDef<MRow>[] = [
    { id: "source", header: "Source (JSM)", size: 140, cell: ({ row }) => <span className="zen-code fw-text-sm">{row.original.source}</span> },
    {
      id: "target", header: "Destination (Freshservice)", size: 190,
      cell: ({ row }) => row.original.target
        ? <div className="zen-cell-stack"><span className="zen-code fw-text-sm">{row.original.target}</span>{row.original.targetApi && row.original.targetApi !== row.original.target ? <span className="fw-text-sm fw-text-secondary">API: {row.original.targetApi}</span> : null}</div>
        : <span className="fw-text-sm fw-text-secondary">{row.original.transformation === "idMapping" ? "Zen ID map" : "Not migrated"}</span>,
    },
    {
      id: "confidence", header: "Confidence", size: 120,
      cell: ({ row }) => row.original.level ? <span className="zen-inline"><Tag variant={LEVEL_VARIANT[row.original.level]}>{row.original.level}</Tag><span className="fw-text-sm">{Math.round(row.original.confidence * 100)}%</span></span> : <span className="fw-text-sm fw-text-secondary">—</span>,
    },
    { id: "transformation", header: "Transformation", size: 170, cell: ({ row }) => <span className="zen-code fw-text-sm">{row.original.transformation ? TRANSFORM_TEXT[row.original.transformation] || row.original.transformation : "—"}</span> },
    { id: "method", header: "Method", size: 100, cell: ({ row }) => <span className="fw-text-sm">{{ exact: "Exact name", known: "Vendor rule", semantic: "Semantic", ai: "Claude", none: "—" }[row.original.method]}</span> },
    {
      id: "decision", header: "Decision", size: 150,
      cell: ({ row }) => {
        const r = row.original;
        if (r.decision === "pending") {
          return (
            <span className="zen-inline">
              <TextButton size="mini" variant="primary" loading={busy === r.source + "confirmed"} onClick={() => decide(r, "confirmed")}>Confirm</TextButton>
              <TextButton size="mini" variant="secondary" loading={busy === r.source + "rejected"} onClick={() => decide(r, "rejected")}>Reject</TextButton>
            </span>
          );
        }
        if (r.decision === "confirmed") return <Tag variant="green" iconName="Check">Confirmed</Tag>;
        if (r.decision === "rejected") return <Tag variant="gray">Rejected</Tag>;
        return r.target ? <span className="fw-text-sm fw-text-secondary">Automatic</span> : null;
      },
    },
    { id: "reason", header: "Why", size: 250, cell: ({ row }) => <span className="fw-text-sm fw-text-secondary">{row.original.reason}</span> },
  ];

  const ws = run?.plan?.workspace_mapping || {};
  const wsRows = Object.entries(ws).map(([department, w]) => ({ id: department, department, ...w }));

  return (
    <Section title="2. Map source → destination" description="Exact names first, then JSM → Freshservice vendor rules, then semantic matching, then Claude. Low-confidence suggestions wait for you — Zen does not invent mappings.">
      <div className="zen-details-head">
        <SegmentedTabs value={tab} onValueChange={(v) => setTab(v)} size="mini">
          <SegmentedTabs.List aria-label="Entity mapping">
            {PAIRS.map((p) => <SegmentedTabs.Trigger key={p.entity} value={p.entity}>{p.label}</SegmentedTabs.Trigger>)}
          </SegmentedTabs.List>
        </SegmentedTabs>
        <TextButton variant={m ? "secondary" : "primary"} size="mini" prefixIcon="MagicWand" loading={busy === "generate"} disabled={!ready} onClick={generate}>
          {m ? "Regenerate mapping" : "Generate mapping"}
        </TextButton>
      </div>
      {!m ? <p className="zen-empty fw-text-base fw-text-secondary">No mapping yet for {pair.label}. Generate it — Zen reads both schemas and proposes each field.</p> : (
        <>
          {pending ? <InlineMessage variant="warning">{pending} low-confidence {pending === 1 ? "mapping needs" : "mappings need"} your confirmation before the migration can run.</InlineMessage> : null}
          {m.missingRequired.length ? <InlineMessage variant="error">Required Freshservice fields with no source: {m.missingRequired.join(", ")}.</InlineMessage> : null}
          <p className="fw-text-sm fw-text-secondary zen-note">
            {m.aiUsed ? "Claude reviewed the fields the rules could not place." : m.aiError ? "Claude was unavailable (" + m.aiError + ") — rules only." : m.aiAvailable ? "Every field was placed by rules; Claude was not needed." : "Claude is not configured on the server — rules only."}
            {" "}Generated {formatWhen(m.createdAt)}.
          </p>
          <div className="zen-table-x"><Table<MRow> data={m.fields.map((f) => ({ ...f, id: f.source }))} columns={columns} rowDensity="compact" skipPagination /></div>
        </>
      )}
      {tab === "tickets" ? (
        <div className="zen-agent-sub">
          <h4 className="fw-text-base fw-font-semibold">Workspace mapping</h4>
          {wsRows.length ? (
            <div className="zen-table-x">
              <Table data={wsRows} rowDensity="compact" skipPagination columns={[
                { id: "d", header: "JSM department", size: 220, cell: ({ row }) => <span className="fw-text-base">{row.original.department}</span> },
                { id: "w", header: "Freshservice workspace", size: 220, cell: ({ row }) => <span className="fw-text-base">{row.original.workspace}</span> },
                { id: "r", header: "Rule", size: 180, cell: ({ row }) => <Tag variant={row.original.rule === "default" ? "gray" : "blue"}>{row.original.rule === "rule" ? "Department rule" : row.original.rule === "override" ? "Admin override" : "Default workspace"}</Tag> },
              ]} />
            </div>
          ) : <p className="fw-text-sm fw-text-secondary zen-note">Computed from the ticket departments during the run, by Zen's Workspace Classification (department rules, Admin overrides from Field mapping, then the default workspace).</p>}
        </div>
      ) : null}
    </Section>
  );
}

/* ---------- 3. run ---------- */

function RunSection({ mappings, run, setRun, demo, targetWrites, onReset }: { mappings: Record<string, Mapping | null>; run: AgentRun | null; setRun: (r: AgentRun | null) => void; demo: boolean; targetWrites: boolean; onReset: () => void }) {
  const toast = useToast();
  const [entities, setEntities] = useState<string[]>(["customers", "tickets"]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goal, setGoal] = useState<ISelectOption | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { agent.goals().then((g) => setGoals(g.goals || [])).catch(() => setGoals([])); }, []);
  const goalOptions: ISelectOption[] = useMemo(() => [{ value: "", label: "No goal — run now" }].concat(goals.map((g) => ({ value: g.goal_id, label: g.title || g.name || g.goal_id }))), [goals]);

  const missing = entities.filter((e) => !mappings[e]);
  const pending = entities.filter((e) => mappings[e]?.fields.some((f) => f.decision === "pending"));
  const active = run && (run.status === "RUNNING" || run.status === "HUMAN_REVIEW_REQUIRED");
  const blockedReason = !entities.length ? "Choose at least one entity." : missing.length ? "Generate the " + missing.join(" and ") + " mapping first." : pending.length ? "Confirm the low-confidence " + pending.join(" and ") + " mappings first." : null;

  async function start() {
    setBusy(true);
    try {
      const mappingIds = Object.fromEntries(entities.map((e) => [e, mappings[e]!.mappingId]));
      const res = await agent.start({ goalId: goal && goal.value ? String(goal.value) : null, entities, mappingIds });
      setRun(res.run);
    } catch (e) {
      toast.addErrorToast({ title: "Could not start the migration", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="3. Run migration" description="Plan → pre-check → fetch → transform → look up references → create or update → validate → reconcile. Customers go first because tickets reference requesters.">
      <Card variant="outlined" className="zen-setup">
        <div className="zen-setup-form zen-agent-form">
          <div className="zen-field">
            <label className="fw-text-sm fw-font-semibold" id="zen-goal-label">Migration goal (Goal Planner)</label>
            <Select aria-labelledby="zen-goal-label" options={goalOptions} value={goal || goalOptions[0]} onValueChange={(v) => setGoal(v)} disabled={Boolean(active)} />
          </div>
          <fieldset className="zen-agent-entities">
            <legend className="fw-text-sm fw-font-semibold">Entities</legend>
            {PAIRS.map((p) => (
              <Checkbox key={p.entity} label={p.label} checked={entities.includes(p.entity)} isDisabled={Boolean(active)}
                onChange={(c) => setEntities((prev) => (c ? prev.concat(p.entity) : prev.filter((x) => x !== p.entity)))} />
            ))}
          </fieldset>
          <div className="zen-setup-actions">
            <TextButton variant="primary" prefixIcon="Transfer" loading={busy} disabled={Boolean(blockedReason) || Boolean(active) || !targetWrites} onClick={start}>Run migration</TextButton>
          </div>
        </div>
      </Card>
      {blockedReason && !active ? <InlineMessage variant="info">{blockedReason}</InlineMessage> : null}
      {!targetWrites ? <InlineMessage variant="warning">Writes to the live Freshservice tenant are disabled on the server (ZEN_ALLOW_LIVE_WRITES).</InlineMessage> : null}
      {demo ? (
        <div className="zen-demo-note">
          <InlineMessage variant="info">Mock data — JSM and Freshservice are simulated here, including controlled failures (missing requesters, invalid departments and priorities, API errors, rate limits, duplicates). Configure the API credentials on the server to use real systems.</InlineMessage>
          <TextButton variant="link" size="mini" disabled={Boolean(active)} onClick={onReset}>Reset demo data</TextButton>
        </div>
      ) : null}
      {run ? <RunPanel run={run} setRun={setRun} /> : null}
    </Section>
  );
}

function RunPanel({ run, setRun }: { run: AgentRun; setRun: (r: AgentRun) => void }) {
  const toast = useToast();
  const s = run.summary;
  const running = run.status === "RUNNING";
  const [stopping, setStopping] = useState(false);

  async function stop() {
    setStopping(true);
    try { setRun((await agent.stop(run.id)).run); } catch (e) { toast.addErrorToast({ title: "Could not stop", description: (e as Error).message }); } finally { setStopping(false); }
  }

  const current = run.steps[run.cursor];
  // decisions open at the review gate; records flagged mid-run show in the ledger until then
  const reviewItems = run.status === "HUMAN_REVIEW_REQUIRED" ? (run.records || []).filter((r) => r.status === "HUMAN_REVIEW_REQUIRED") : [];
  return (
    <div className="zen-run">
      <div className="zen-run-head">
        <div className="zen-run-title">
          {running ? <Spinner size="xs" aria-label="Running" /> : null}
          <h3 className="fw-text-lg fw-font-semibold">{running && current ? current.label + (current.entity ? " · " + current.entity : "") : "Migration " + run.id.replace("agent_", "#")}</h3>
          <Tag variant={RUN_TAG[run.status].variant}>{RUN_TAG[run.status].label}</Tag>
          {run.goal_name ? <Tag variant="normal">Goal: {run.goal_name}</Tag> : null}
        </div>
        <p className="fw-text-sm fw-text-secondary">
          {run.source.name} ({run.source.mode === "live" ? "real API" : "mock data"}) → {run.target.name} ({run.target.mode === "live" ? "real API" : "mock data"}) · started {formatWhen(run.started_at)}
          {run.finished_at ? " · finished " + formatWhen(run.finished_at) : ""}
        </p>
      </div>

      {run.status_reason && run.status !== "RUNNING" ? (
        <InlineMessage variant={run.status === "COMPLETED" ? (run.evaluation?.met ? "success" : "warning") : run.status === "HUMAN_REVIEW_REQUIRED" ? "warning" : run.status === "STOPPED" ? "info" : "error"}>{run.status_reason}</InlineMessage>
      ) : null}

      <div className="zen-run-body">
        <div className="zen-run-side">
          <div className="zen-count">
            <span className="fw-text-2xl fw-font-semibold">{s.processed.toLocaleString()}</span>
            <span className="fw-text-base fw-text-secondary">/ {s.total.toLocaleString()} records processed · {pct(s.progress)}</span>
          </div>
          <ProgressLoader aria-label="Records processed" value={s.processed} max={s.total || 1} />
          <dl className="zen-agent-stats">
            <Stat label="Successful" value={s.successful} />
            <Stat label="Remediated by Zen" value={s.remediated} />
            <Stat label="Resolved by human" value={s.resolved} />
            <Stat label="Human review" value={s.human_review} tone={s.human_review ? "red" : undefined} />
            <Stat label="Skipped" value={s.skipped} />
            <Stat label="Failed" value={s.failed} tone={s.failed ? "red" : undefined} />
            <Stat label="Success rate" value={pct(s.success_rate)} />
          </dl>
          <EntityTable run={run} />
          {(running || run.status === "HUMAN_REVIEW_REQUIRED") ? (
            <div className="zen-run-actions"><TextButton variant="destructive" size="mini" prefixIcon="Pause" loading={stopping} onClick={stop}>Stop migration</TextButton></div>
          ) : null}
        </div>
        <StageTable run={run} />
      </div>

      {run.plan?.prechecks && run.status === "BLOCKED" ? (
        <ul className="zen-agent-checks">
          {run.plan.prechecks.map((c) => <li key={c.check} className="fw-text-sm"><Tag variant={c.ok ? "green" : "red"}>{c.ok ? "Passed" : "Failed"}</Tag> <strong>{c.check}</strong> — {c.detail}</li>)}
        </ul>
      ) : null}

      {reviewItems.length ? <ReviewQueue run={run} items={reviewItems} setRun={setRun} onStop={stop} /> : null}
      {run.records && run.records.length ? <Ledger run={run} /> : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "red" }) {
  return (
    <div>
      <dt className="fw-text-sm fw-text-secondary">{label}</dt>
      <dd className={"fw-text-lg fw-font-semibold" + (tone === "red" ? " fw-text-danger" : "")}>{typeof value === "number" ? value.toLocaleString() : value}</dd>
    </div>
  );
}

function EntityTable({ run }: { run: AgentRun }) {
  const rows = run.entities.map((e) => ({ id: e, entity: e, ...run.summary.per_entity[e], rec: run.reconciliation ? run.reconciliation[e] : null }));
  return (
    <div className="zen-table-x">
      <Table data={rows} rowDensity="compact" skipPagination columns={[
        { id: "e", header: "Entity", size: 110, cell: ({ row }) => <span className="fw-text-base fw-font-medium">{row.original.entity === "customers" ? "Customers" : "Tickets"}</span> },
        { id: "p", header: "Processed", size: 100, cell: ({ row }) => <span className="fw-text-base">{row.original.processed} / {row.original.total}</span> },
        { id: "c", header: "Created", size: 80, cell: ({ row }) => <span className="fw-text-base">{row.original.created}</span> },
        { id: "u", header: "Updated", size: 80, cell: ({ row }) => <span className="fw-text-base">{row.original.updated}</span> },
        { id: "l", header: "Linked", size: 80, cell: ({ row }) => <span className="fw-text-base">{row.original.linked}</span> },
        { id: "r", header: "Reconciled", size: 120, cell: ({ row }) => row.original.rec ? <Tag variant={row.original.rec.balanced ? "green" : "red"}>{row.original.rec.balanced ? "Balanced" : "Differences"}</Tag> : <span className="fw-text-sm fw-text-secondary">—</span> },
      ]} />
    </div>
  );
}

function StageTable({ run }: { run: AgentRun }) {
  type Row = { id: string; key: string; label: string; cells: Record<string, RunStep | undefined> };
  const rows: Row[] = [];
  for (const s of run.steps) {
    let row = rows.find((r) => r.key === s.key);
    if (!row) { row = { id: s.key, key: s.key, label: s.label, cells: {} }; rows.push(row); }
    if (s.entity) row.cells[s.entity] = s;
    else for (const e of run.entities) row.cells[e] = s;
  }
  const cell = (st?: RunStep) => st ? (
    <div className="zen-cell-stack">
      <Tag variant={STEP_TAG[st.status].variant}>{STEP_TAG[st.status].label}</Tag>
      {st.detail ? <span className="fw-text-sm fw-text-secondary">{st.detail}</span> : null}
    </div>
  ) : <span className="fw-text-sm fw-text-secondary">—</span>;
  return (
    <div className="zen-table-x">
      <Table<Row> data={rows} rowDensity="compact" skipPagination columns={[
        { id: "stage", header: "Stage", size: 150, cell: ({ row }) => <span className="fw-text-base">{row.original.label}</span> },
        ...run.entities.map((e): ColumnDef<Row> => ({ id: e, header: e === "customers" ? "Customers" : "Tickets", size: 145, cell: ({ row }) => cell(row.original.cells[e]) })),
      ]} />
    </div>
  );
}

/* ---------- human review ---------- */

function ReviewQueue({ run, items, setRun, onStop }: { run: AgentRun; items: LedgerRecord[]; setRun: (r: AgentRun) => void; onStop: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});

  async function decide(rec: LedgerRecord, action: "approve" | "skip") {
    setBusy(rec.key + action);
    try {
      const res = await agent.review(run.id, rec.key, action, rec.review?.needsInput === "email" ? { email: emails[rec.key] || "" } : undefined);
      setRun(res.run);
      const after = res.run.records?.find((r) => r.key === rec.key);
      if (action === "approve" && after && after.status === "HUMAN_REVIEW_REQUIRED") toast.addWarningToast({ title: rec.sourceId + " still needs attention", description: after.review?.problem || "" });
    } catch (e) {
      toast.addErrorToast({ title: "Could not apply the decision", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="zen-agent-review">
      <div className="zen-details-head">
        <h4 className="fw-text-base fw-font-semibold">Human review required · {items.length}</h4>
        <span className="fw-text-sm fw-text-secondary">Zen handled the routine fixes. These need a decision before the migration continues.</span>
      </div>
      {items.map((rec) => {
        const r = rec.review!;
        return (
          <Card key={rec.key} variant="outlined" className="zen-agent-review-card">
            <div className="zen-agent-review-head">
              <Tag variant="red" iconName="Warning">Human review required</Tag>
              <span className="fw-text-base fw-font-semibold">{rec.sourceId}</span>
              <span className="fw-text-sm fw-text-secondary">{rec.label}</span>
              <Tag variant="normal">{rec.error?.label || r.failure_type}</Tag>
              <Tag variant={r.severity === "HIGH" ? "red" : r.severity === "MEDIUM" ? "yellow" : "gray"}>{r.severity}</Tag>
            </div>
            <dl className="zen-agent-review-body">
              <div><dt className="fw-text-sm fw-text-secondary">Problem</dt><dd className="fw-text-base">{r.problem}</dd></div>
              <div>
                <dt className="fw-text-sm fw-text-secondary">Zen tried</dt>
                <dd><ul className="fw-text-base">{r.tried.map((t) => <li key={t}>{t}</li>)}</ul></dd>
              </div>
              <div><dt className="fw-text-sm fw-text-secondary">Recommendation</dt><dd className="fw-text-base">{r.recommendation}</dd></div>
            </dl>
            {r.needsInput === "email" ? (
              <div className="zen-field zen-agent-input">
                <TextField label="Email address" type="email" value={emails[rec.key] || ""} onChange={(v) => setEmails((p) => ({ ...p, [rec.key]: String(v ?? "") }))} />
              </div>
            ) : null}
            <div className="zen-run-actions">
              <TextButton variant="primary" size="mini" prefixIcon="Refresh" loading={busy === rec.key + "approve"} disabled={Boolean(busy)} onClick={() => decide(rec, "approve")}>Approve &amp; retry</TextButton>
              <TextButton variant="secondary" size="mini" loading={busy === rec.key + "skip"} disabled={Boolean(busy)} onClick={() => decide(rec, "skip")}>Skip record</TextButton>
              <TextButton variant="destructive" size="mini" disabled={Boolean(busy)} onClick={onStop}>Stop migration</TextButton>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ---------- record ledger ---------- */

type LedgerFilter = "ALL" | "REMEDIATED" | "REVIEW" | "ISSUES";

function Ledger({ run }: { run: AgentRun }) {
  const [filter, setFilter] = useState<LedgerFilter>("ALL");
  const all = run.records || [];
  const match = (r: LedgerRecord, f: LedgerFilter) => f === "ALL" || (f === "REMEDIATED" && (r.status === "REMEDIATED" || r.status === "RESOLVED"))
    || (f === "REVIEW" && r.status === "HUMAN_REVIEW_REQUIRED") || (f === "ISSUES" && (r.status === "SKIPPED" || r.status === "FAILED"));
  const rows = all.filter((r) => match(r, filter));
  type LRow = LedgerRecord & { id: string };
  const columns: ColumnDef<LRow>[] = [
    {
      id: "record", header: "Source record", size: 220,
      cell: ({ row }) => <div className="zen-cell-stack"><span className="zen-code fw-text-sm">{row.original.sourceId}</span><span className="fw-text-sm fw-text-secondary">{row.original.label}</span></div>,
    },
    { id: "type", header: "Type", size: 90, cell: ({ row }) => <span className="fw-text-sm">{row.original.entityType === "customer" ? "Customer" : "Ticket"}</span> },
    { id: "status", header: "Status", size: 150, cell: ({ row }) => <Tag variant={REC_TAG[row.original.status].variant}>{REC_TAG[row.original.status].label}</Tag> },
    {
      id: "target", header: "Freshservice ID", size: 140,
      cell: ({ row }) => row.original.targetId ? <div className="zen-cell-stack"><span className="zen-code fw-text-sm">{row.original.targetId}</span><span className="fw-text-sm fw-text-secondary">{row.original.action}</span></div> : <span className="fw-text-sm fw-text-secondary">—</span>,
    },
    {
      id: "error", header: "Failure", size: 260,
      cell: ({ row }) => {
        const errs = row.original.errors.filter((e) => !e.retry);
        return errs.length ? <div className="zen-cell-stack">{errs.map((e, i) => <span key={i} className="fw-text-sm"><strong>{e.label}</strong> — {e.message}</span>)}</div> : <span className="fw-text-sm fw-text-secondary">—</span>;
      },
    },
    {
      id: "remediation", header: "Remediation", size: 260,
      cell: ({ row }) => row.original.remediationAttempted
        ? <div className="zen-cell-stack">{row.original.remediation.filter((m) => !m.retry).map((m, i) => <span key={i} className="fw-text-sm">{m.ok ? "Fixed: " : "Tried: "}{m.detail}</span>)}</div>
        : <span className="fw-text-sm fw-text-secondary">Not needed</span>,
    },
    { id: "when", header: "Updated", size: 150, cell: ({ row }) => <span className="fw-text-sm fw-text-secondary">{formatWhen(row.original.timestamp)}</span> },
  ];
  const count = (f: LedgerFilter) => all.filter((r) => match(r, f)).length;
  return (
    <div className="zen-details">
      <div className="zen-details-head">
        <h4 className="fw-text-base fw-font-semibold">Record ledger</h4>
        <SegmentedTabs value={filter} onValueChange={(v) => setFilter(v as LedgerFilter)} size="mini">
          <SegmentedTabs.List aria-label="Filter records">
            <SegmentedTabs.Trigger value="ALL">All ({count("ALL")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="REMEDIATED">Remediated ({count("REMEDIATED")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="REVIEW">Human review ({count("REVIEW")})</SegmentedTabs.Trigger>
            <SegmentedTabs.Trigger value="ISSUES">Skipped / failed ({count("ISSUES")})</SegmentedTabs.Trigger>
          </SegmentedTabs.List>
        </SegmentedTabs>
      </div>
      <div className="zen-table-scroll zen-table-x"><Table<LRow> data={rows.map((r) => ({ ...r, id: r.key }))} columns={columns} rowDensity="compact" skipPagination /></div>
    </div>
  );
}

/* ---------- 4. insights ---------- */

function InsightsSection({ run, setRun }: { run: AgentRun; setRun: (r: AgentRun) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const available = ["COMPLETED", "STOPPED", "HUMAN_REVIEW_REQUIRED", "FAILED", "BLOCKED"].includes(run.status);
  const ins: Insights | null = run.insights;

  async function generate() {
    setBusy(true);
    try {
      const res = await agent.insights(run.id);
      setRun({ ...run, insights: res.insights });
    } catch (e) {
      toast.addErrorToast({ title: "Could not generate insights", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="4. Migration insights" description="Claude analyses the finished migration — counts come from Zen's record ledger; Claude explains them and recommends what to do next."
      aside={<TextButton variant={ins ? "secondary" : "primary"} size="mini" prefixIcon="Ai" loading={busy} disabled={!available} onClick={generate}>{ins ? "Regenerate insights" : "Generate insights with Claude"}</TextButton>}>
      {!available ? <InlineMessage variant="info">Insights are available once the migration finishes or pauses for review.</InlineMessage> : null}
      {!ins ? null : (
        <Card variant="outlined" className="zen-agent-insights">
          <div className="zen-agent-insights-head">
            {ins.generated_by === "claude"
              ? <Tag variant="blue" iconName="Ai">Generated by Claude · {ins.model}</Tag>
              : <Tag variant="yellow">Rule-based summary — Claude not used</Tag>}
            <span className="fw-text-sm fw-text-secondary">{formatWhen(ins.generated_at)}{ins.error ? " · " + ins.error : ""}</span>
          </div>
          <h3 className="fw-text-lg fw-font-semibold">{ins.insights.headline}</h3>
          <dl className="zen-agent-stats">
            <Stat label="Records processed" value={ins.summary.processed} />
            <Stat label="Migrated" value={ins.summary.migrated} />
            <Stat label="Auto-remediated" value={ins.summary.auto_remediated} />
            <Stat label="Resolved by human" value={ins.summary.resolved_by_human} />
            <Stat label="Human review" value={ins.summary.awaiting_human_review + ins.summary.skipped} />
            <Stat label="Success rate" value={pct(ins.summary.success_rate)} />
            <Stat label="Duration" value={ins.duration_seconds < 90 ? ins.duration_seconds + "s" : Math.round(ins.duration_seconds / 60) + " min"} />
          </dl>
          <div className="zen-agent-insights-grid">
            <InsightList title="What went well" items={ins.insights.went_well} />
            <InsightList title="What went wrong" items={ins.insights.went_wrong.map((w) => w.count + " × " + w.title + " — " + w.detail)} />
            <InsightList title="How Zen fixed it" items={ins.insights.how_fixed.map((f) => f.count + " " + f.title)} />
            <div>
              <h4 className="fw-text-base fw-font-semibold">What still needs human action</h4>
              <p className="fw-text-base"><strong>{ins.insights.needs_human.count}</strong> {ins.insights.needs_human.count === 1 ? "record" : "records"}. {ins.insights.needs_human.reason}</p>
              <p className="fw-text-sm fw-text-secondary">Recommended: {ins.insights.needs_human.recommended_action}</p>
            </div>
            <InsightList title="Recommendations" items={ins.insights.recommendations} />
          </div>
        </Card>
      )}
    </Section>
  );
}

function InsightList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="fw-text-base fw-font-semibold">{title}</h4>
      {items.length ? <ul className="fw-text-base">{items.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="fw-text-sm fw-text-secondary">Nothing to report.</p>}
    </div>
  );
}
