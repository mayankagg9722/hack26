/* Demo data for the migration agent when real systems aren't configured.
   Everything is deterministic, so every demo run shows the same failures.

   JSM side: customers and tickets from Zen's Jira demo organisation (the
   customers are the tickets' reporters), with controlled problems a real
   migration hits. Freshservice side: the departments, groups and workspaces
   of the demo tenant, and a few requesters that already exist there. */

const { generateDemoRecords } = require("../demoData");

const JOB_TITLES = ["Analyst", "Engineer", "Manager", "Coordinator", "Specialist", "Associate", "Director", "Consultant"];
const OFFICES = ["London", "Bengaluru", "Austin", "Berlin", "Singapore"];
const DOMAIN = "northwind.example.com";

/* Controlled customer problems, by position in the customer list */
const CUSTOMER_CASES = {
  5: { department: "Information Technology" },   // INVALID_DEPARTMENT — normalised to IT
  11: { department: "Dept-42" },                 // INVALID_DEPARTMENT — placeholder, human review
  17: { preExisting: true },                     // DUPLICATE_REQUESTER — already in Freshservice
  23: { email: "" },                             // MISSING_EMAIL — human review
  29: { name: "" },                              // MISSING_REQUIRED_FIELD — name derived from email
  33: { preExisting: true },                     // DUPLICATE_REQUESTER
  41: { apiFailure: "503" },                     // API_FAILURE — transient, retried
  47: { apiFailure: "429" },                     // RATE_LIMIT — retried after backoff
  52: { department: "Fin & Accts" },             // INVALID_DEPARTMENT — known abbreviation
};

/* Controlled ticket problems, by position in the ticket list */
const TICKET_CASES = {
  12: { summary: "" },                                   // MISSING_REQUIRED_FIELD — subject from description
  37: { priority: "P1 - Critical" },                     // INVALID_PRIORITY — normalised to Urgent
  44: { workspace: "Legal Workspace" },                  // INVALID_WORKSPACE — reclassified by department
  58: { reporter: { name: "Dana Whitfield", email: "dana.whitfield@contractors.example.com" } }, // MISSING_REQUIRED — found by email
  66: { apiFailure: "429" },                             // RATE_LIMIT
  71: { department: "Information Technology" },          // INVALID_DEPARTMENT — normalised
  83: { priority: "Whenever" },                          // INVALID_PRIORITY — human review
  95: { reporter: { name: "Sam Lee", email: "sam.lee@partners.example.com" } }, // MISSING_REQUESTER — nobody by email/name
  104: { summary: "", description: "" },                 // MISSING_REQUIRED_FIELD — human review
  118: { apiFailure: "503" },                            // API_FAILURE — transient
  126: { workspace: "Legal Workspace" },                 // INVALID_WORKSPACE
  139: { reporter: { name: "Morgan Reyes", email: "" } },// MISSING_REQUESTER — name matches one requester
  151: { priority: "PRIORITY: HIGH" },                   // INVALID_PRIORITY — normalised
  163: { apiFailure: "500" },                            // API_FAILURE — outlasts retries, human review
  177: { reporter: { name: "Dana Whitfield", email: "dana.whitfield@contractors.example.com" } },
};

/* Requesters that exist in the demo Freshservice before Zen runs */
function preExistingRequesters(customers) {
  const fromCustomers = Object.entries(CUSTOMER_CASES).filter(([, c]) => c.preExisting)
    .map(([i]) => customers[+i]).filter(Boolean)
    .map((c) => ({ name: c.displayName, email: c.emailAddress, department: null }));
  return fromCustomers.concat([
    { name: "Dana Whitfield", email: "dana.whitfield@contractors.example.com", department: null },
    { name: "Morgan Reyes", email: "morgan.reyes@northwind.example.com", department: null },
  ]);
}

const FS_DEPARTMENTS = ["IT", "HR", "Finance", "Facilities", "Engineering", "Sales", "Marketing", "Customer Support", "Legal", "Procurement"];
const FS_GROUPS = ["Service Desk", "Network", "Desktop Support", "Applications", "HR Operations", "Finance Operations", "Workplace"];
const FS_WORKSPACES = [
  { id: "it", name: "IT Workspace", primary: true },
  { id: "hr", name: "HR Workspace" },
  { id: "finance", name: "Finance Workspace" },
  { id: "facilities", name: "Facilities Workspace" },
];

function accountId(i) {
  return "qm:5f8c" + String(1000 + i) + ":" + (0x9a3e1 + i * 7919).toString(16);
}

let cache = null;
function demoJsm() {
  if (cache) return cache;
  const records = generateDemoRecords({ profile: "jira", count: 240, seed: 42, quality: "clean", now: new Date(Date.UTC(2026, 8, 1)) });
  const byEmail = new Map();
  for (const r of records) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, { name: r.employeeName, email: r.email, department: r.department === "IT Operations" ? "IT" : r.department === "Human Resources" ? "HR" : r.department });
  }
  const customers = [...byEmail.values()].map((c, i) => {
    const cs = CUSTOMER_CASES[i] || {};
    return {
      accountId: accountId(i),
      displayName: cs.name !== undefined ? cs.name : c.name,
      emailAddress: cs.email !== undefined ? cs.email : c.email,
      department: cs.department || c.department,
      jobTitle: JOB_TITLES[i % JOB_TITLES.length],
      office: OFFICES[i % OFFICES.length],
      phone: "+1 555 01" + String(i).padStart(2, "0"),
      timeZone: "UTC",
      _demo: { apiFailure: cs.apiFailure || null, originalEmail: c.email },
    };
  });
  const customerByEmail = new Map(customers.map((c) => [c._demo.originalEmail, c]));

  const tickets = records.map((r, i) => {
    const cs = TICKET_CASES[i] || {};
    const cust = customerByEmail.get(r.email);
    const reporter = cs.reporter
      ? { accountId: null, displayName: cs.reporter.name, emailAddress: cs.reporter.email }
      : { accountId: cust.accountId, displayName: cust.displayName, emailAddress: cust.emailAddress };
    const summary = r.description.length > 60 ? r.description.slice(0, 57) + "…" : r.description;
    return {
      key: "SD-" + (1001 + i),
      summary: cs.summary !== undefined ? cs.summary : summary,
      description: cs.description !== undefined ? cs.description : r.description + ". Reported via the IT Service Desk portal.",
      status: r.status,
      priority: cs.priority || r.priority,
      issueType: r.ticketType === "Incident" || r.ticketType === "Problem" ? "Incident" : "Service Request",
      reporter,
      department: cs.department || (cust ? cust.department : ""),
      workspace: cs.workspace || null,
      createdAt: r.createdDate,
      updatedAt: r.createdDate,
      _demo: { apiFailure: cs.apiFailure || null },
    };
  });
  // the department typo cases must not leak into other customers' tickets
  for (const t of tickets) if (t.department === "Dept-42" || t.department === "Fin & Accts") t.department = "Finance";
  cache = { customers, tickets };
  return cache;
}

module.exports = { demoJsm, preExistingRequesters, FS_DEPARTMENTS, FS_GROUPS, FS_WORKSPACES, DOMAIN };
