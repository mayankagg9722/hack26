/* Freshservice fields Zen maps into (API v2). Requester fields are resolved
   to a requester record at write time; department is matched by name to a
   department_id. Shared by the live and mock Freshservice adapters.
   `expects` describes the kind of value, used by Zen's mapping suggestions. */

const FRESHSERVICE_TICKET_FIELDS = [
  { key: "requester.employee_id", label: "Employee ID", type: "string", required: true, expects: "id",
    aliases: ["employee id", "employee number", "staff id", "requester id"] },
  { key: "requester.name", label: "Name", type: "string", expects: "person",
    aliases: ["employee name", "requester name", "full name"] },
  { key: "email", label: "Email", type: "email", required: true, expects: "email",
    aliases: ["requester email", "email address"] },
  { key: "department", label: "Department", type: "enum", expects: "enum",
    values: ["IT", "HR", "Finance", "Facilities", "Engineering", "Sales", "Marketing", "Legal", "Customer Support", "Procurement"],
    aliases: ["dept", "department name", "business unit"] },
  { key: "custom_fields.legacy_ticket_id", label: "Ticket ID", type: "string", expects: "id",
    aliases: ["ticket number", "incident number", "issue key", "ticket id"] },
  { key: "type", label: "Ticket Type", type: "enum", expects: "enum",
    values: ["Incident", "Service Request"], aliases: ["issue type", "category", "ticket category"] },
  {
    key: "priority", label: "Priority", type: "enum", required: true, expects: "enum",
    values: [{ id: 1, name: "Low" }, { id: 2, name: "Medium" }, { id: 3, name: "High" }, { id: 4, name: "Urgent" }],
    aliases: ["severity", "urgency", "priority level"],
  },
  { key: "description", label: "Description", type: "html", required: true, expects: "text",
    aliases: ["details", "ticket description", "body"] },
  {
    key: "status", label: "Status", type: "enum", required: true, expects: "enum",
    values: [{ id: 2, name: "Open" }, { id: 3, name: "Pending" }, { id: 4, name: "Resolved" }, { id: 5, name: "Closed" }],
    aliases: ["state", "current state", "ticket status"],
  },
  { key: "custom_fields.legacy_created_at", label: "Created Date", type: "datetime", expects: "datetime",
    aliases: ["created", "created on", "opened date", "open date"] },
  { key: "subject", label: "Subject", type: "string", required: true, expects: "text",
    aliases: ["summary", "title"], note: "Derived from the description when not mapped." },
];

/* Default workspaces for the demo / fallback. Live adapters read the real list. */
const FRESHSERVICE_DEFAULT_WORKSPACES = [
  { id: "it", name: "IT Workspace", primary: true },
  { id: "hr", name: "HR Workspace" },
  { id: "finance", name: "Finance Workspace" },
  { id: "facilities", name: "Facilities Workspace" },
];

module.exports = { FRESHSERVICE_TICKET_FIELDS, FRESHSERVICE_DEFAULT_WORKSPACES };
