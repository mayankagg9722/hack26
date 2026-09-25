/* Zen record — the neutral shape every source adapter normalises into.
   The migration engine only ever sees this shape, never Jira- or
   Freshservice-specific payloads. Values keep the source's own vocabulary
   (e.g. Jira "Highest" vs legacy "P1"); mapping to the target happens later. */

const ZEN_RECORD_FIELDS = [
  { key: "employeeId", label: "Employee ID", type: "string" },
  { key: "employeeName", label: "Employee Name", type: "string" },
  { key: "email", label: "Email", type: "email" },
  { key: "department", label: "Department", type: "string" },
  { key: "ticketId", label: "Ticket ID", type: "string" },
  { key: "ticketType", label: "Ticket Type", type: "string" },
  { key: "priority", label: "Priority", type: "string" },
  { key: "description", label: "Description", type: "text" },
  { key: "status", label: "Status", type: "string" },
  { key: "createdDate", label: "Created Date", type: "datetime" },
];

module.exports = { ZEN_RECORD_FIELDS };
