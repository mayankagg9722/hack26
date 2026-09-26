import { useEffect, useState } from "react";
import { HyperlinkButton, InlineMessage, Table, Tag, TextButton, useToast } from "@freshworks/dew-components";
import type { ColumnDef } from "@freshworks/dew-components";
import { api, loadConn, saveConn } from "./api";
import type { ConnState, IntegrationInfo } from "./api";
import { Section } from "./Shell";

/* Systems used by ticket migrations (field mapping, goal planner). Connection
   choices are stored in the same place those pages read them from. */

interface Row extends IntegrationInfo { connected: boolean }

export function ConnectedSystemsSection() {
  const toast = useToast();
  const [items, setItems] = useState<IntegrationInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>(loadConn());
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    api.integrations()
      .then((d) => {
        const sources: IntegrationInfo[] = d.sources.map((s) => ({ ...s, role: "source" }));
        const targets: IntegrationInfo[] = d.targets.map((t) => ({ ...t, role: "target" }));
        setItems(sources.concat(targets));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  function update(next: ConnState) { setConn(next); saveConn(next); }

  async function toggle(item: IntegrationInfo) {
    if (conn.connected[item.id]) {
      const next = { ...conn, connected: { ...conn.connected } };
      delete next.connected[item.id];
      update(next);
      return;
    }
    setPending(item.id);
    try {
      const res = await api.connect(item.id);
      if (!res.connected) throw new Error(res.message);
      update({ ...conn, connected: { ...conn.connected, [item.id]: true }, [item.role]: item.id });
    } catch (e) {
      toast.addErrorToast({ title: "Could not connect " + item.name, description: (e as Error).message });
    } finally {
      setPending(null);
    }
  }

  const data: Row[] = (items || []).map((i) => ({ ...i, connected: Boolean(conn.connected[i.id]) }));
  const columns: ColumnDef<Row>[] = [
    {
      id: "system", header: "System", size: 320,
      cell: ({ row }) => (
        <div className="zen-cell-stack">
          <span className="fw-text-base fw-font-medium">{row.original.name}</span>
          <span className="fw-text-sm fw-text-secondary">{row.original.description}</span>
        </div>
      ),
    },
    { id: "role", header: "Role", size: 120, cell: ({ row }) => <span className="fw-text-base">{row.original.role === "source" ? "Source" : "Destination"}</span> },
    { id: "mode", header: "Mode", size: 110, cell: ({ row }) => <Tag variant={row.original.mode === "live" ? "green" : "gray"}>{row.original.mode === "live" ? "Live API" : "Demo"}</Tag> },
    { id: "status", header: "Status", size: 140, cell: ({ row }) => row.original.connected ? <Tag variant="green" iconName="Check">Connected</Tag> : <Tag variant="gray">Not connected</Tag> },
    {
      id: "action", header: "", size: 130,
      cell: ({ row }) => (
        <TextButton size="mini" variant="secondary" loading={pending === row.original.id} onClick={() => toggle(row.original)}>
          {row.original.connected ? "Disconnect" : "Connect"}
        </TextButton>
      ),
    },
  ];

  return (
    <Section
      title="Connected systems"
      description="Sources and destinations used for ticket migrations, field mapping and the goal planner."
      aside={<div className="zen-inline-links"><HyperlinkButton href="mapping.html">Field mapping</HyperlinkButton><HyperlinkButton href="planner.html">Goal planner</HyperlinkButton><HyperlinkButton href="integrations-classic.html">Pipeline and demo data</HyperlinkButton></div>}
    >
      {error ? <InlineMessage variant="error">Could not load integrations: {error}</InlineMessage> : (
        <div className="zen-table-x"><Table<Row> data={data} columns={columns} rowDensity="compact" skipPagination isDataLoading={!items} /></div>
      )}
    </Section>
  );
}
