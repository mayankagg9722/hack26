/* Deterministic demo-record generator. Same (profile, count, seed) always
   yields the same records, so demos are repeatable. */

const FIRST_NAMES = [
  "Aarav", "Priya", "Liam", "Olivia", "Noah", "Emma", "Mateo", "Sofia", "Kenji", "Aiko",
  "Omar", "Layla", "Lucas", "Mia", "Arjun", "Ananya", "Ethan", "Chloe", "Diego", "Isabella",
  "Wei", "Mei", "Samuel", "Grace", "Tanvi", "Rohan", "Hannah", "Jack", "Zara", "Leo",
];
const LAST_NAMES = [
  "Sharma", "Patel", "Smith", "Nguyen", "Garcia", "Kim", "Tanaka", "Okafor", "Müller", "Rossi",
  "Brown", "Wilson", "Singh", "Chen", "Lopez", "Haddad", "Martin", "Kowalski", "Silva", "Taylor",
];
const DEPARTMENTS = [
  "Engineering", "Finance", "Human Resources", "IT Operations", "Sales",
  "Marketing", "Legal", "Customer Support", "Facilities", "Procurement",
];
const TICKET_TYPES = ["Incident", "Service Request", "Change", "Problem"];

const DESCRIPTIONS = {
  Incident: [
    "VPN disconnects every few minutes when working remotely",
    "Unable to log in to email after password reset",
    "Laptop will not boot past the manufacturer logo",
    "Shared drive is not accessible from the office network",
    "Printer on floor 3 is jamming on every job",
    "Video calls drop audio after about ten minutes",
  ],
  "Service Request": [
    "Request access to the finance reporting dashboard",
    "New starter needs a laptop and standard software",
    "Please install Adobe Acrobat Pro on my machine",
    "Request a second monitor for my desk",
    "Add me to the marketing distribution list",
    "Need a temporary licence for the design tool",
  ],
  Change: [
    "Upgrade the HR system to the latest version",
    "Rotate SSL certificates on the customer portal",
    "Migrate team mailboxes to the new tenant",
    "Enable MFA for all contractor accounts",
    "Decommission the legacy file server",
  ],
  Problem: [
    "Recurring outages on the payroll integration",
    "Intermittent slowness across the CRM every Monday",
    "Repeated sync failures between HR and directory",
    "Backups failing silently on the reporting database",
  ],
};

/* Each source system speaks its own dialect: its own field names, ticket
   numbering, priority/status vocabulary and department naming. */
const PROFILES = {
  jira: {
    ticketId: (n) => "JSM-" + (1000 + n),
    priorities: ["Highest", "High", "Medium", "Low", "Lowest"],
    priorityWeights: [0.06, 0.18, 0.46, 0.22, 0.08],
    statuses: ["Open", "In Progress", "Waiting for customer", "Resolved", "Closed"],
    emailDomain: "northwind.example.com",
    departments: {},
    // Jira CSV export column names
    fields: {
      employeeId: "Reporter Account ID",
      employeeName: "Reporter",
      email: "Reporter Email",
      department: "Department",
      ticketId: "Issue key",
      ticketType: "Issue Type",
      priority: "Priority",
      description: "Description",
      status: "Status",
      createdDate: "Created",
    },
    extra: { name: "Labels", values: ["vpn", "hardware", "access", "onboarding", "email", ""] },
  },
  "legacy-itsm": {
    ticketId: (n) => "INC" + String(40000 + n).padStart(7, "0"),
    priorities: ["P1", "P2", "P3", "P4"],
    priorityWeights: [0.07, 0.2, 0.5, 0.23],
    statuses: ["NEW", "ASSIGNED", "WIP", "RESOLVED", "CLOSED"],
    emailDomain: "corp.northwind.example.com",
    departments: {
      "IT Operations": "IT", "Human Resources": "HR", Finance: "FIN", Facilities: "FAC",
      Engineering: "ENG", Sales: "SALES", Marketing: "MKTG", Legal: "LEGAL",
      "Customer Support": "SUPPORT", Procurement: "PROC",
    },
    fields: {
      employeeId: "employee_identification_number",
      employeeName: "employee_name",
      email: "email_address",
      department: "dept",
      ticketId: "ticket_number",
      ticketType: "issue_type",
      priority: "priority_level",
      description: "ticket_description",
      status: "current_state",
      createdDate: "created_on",
    },
    extra: { name: "assignment_group", values: ["Service Desk", "Network", "Desktop Support", "Applications"] },
  },
  "mock-legacy": {
    ticketId: (n) => "TKT-" + String(n + 1).padStart(5, "0"),
    priorities: ["Urgent", "High", "Medium", "Low"],
    priorityWeights: [0.08, 0.22, 0.45, 0.25],
    statuses: ["Open", "Pending", "Resolved", "Closed"],
    emailDomain: "legacy.example.com",
    departments: {
      "IT Operations": "Information Technology", "Human Resources": "People & Culture",
      Finance: "Accounts", Facilities: "Workplace Services",
    },
    fields: {
      employeeId: "EMP_NO",
      employeeName: "FULL_NAME",
      email: "MAIL",
      department: "DEPT_CODE",
      ticketId: "TKT_NO",
      ticketType: "CATEGORY",
      priority: "SEVERITY",
      description: "DETAILS",
      status: "STATE",
      createdDate: "OPEN_DT",
    },
    extra: { name: "LAST_UPDT_BY", values: ["SYSTEM", "BATCH01", "ADMIN", "JSMITH"] },
  },
};

/* mulberry32 — tiny seeded PRNG */
function createRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function pickWeighted(rng, list, weights) {
  let r = rng();
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

function slug(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

function generateEmployees(rng, size, emailDomain) {
  const employees = [];
  const usedEmails = new Set();
  for (let i = 0; i < size; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    let email = slug(first) + "." + slug(last) + "@" + emailDomain;
    let n = 2;
    while (usedEmails.has(email)) {
      email = slug(first) + "." + slug(last) + n + "@" + emailDomain;
      n++;
    }
    usedEmails.add(email);
    employees.push({
      employeeId: "EMP" + String(10001 + i),
      employeeName: first + " " + last,
      email,
      department: pick(rng, DEPARTMENTS),
    });
  }
  return employees;
}

/* Data-quality problems real legacy exports have. A separate PRNG stream
   decides which records get one, so the clean data (and every count derived
   from it) is identical with or without them. The first CLEAN_HEAD records
   stay clean so previews and mapping samples look tidy. */
const ISSUE_RATE = 0.06;
const CLEAN_HEAD = 25;
const ISSUES = [
  { type: "email_obfuscated", weight: 28 },   // fixable: "ana.p at corp.com"
  { type: "email_formatting", weight: 16 },   // fixable: " Ana.P@Corp.COM "
  { type: "email_missing", weight: 5 },       // needs review
  { type: "email_placeholder", weight: 4 },   // needs review: "n/a"
  { type: "description_missing", weight: 6 }, // needs review
  { type: "priority_noise", weight: 18 },     // fixable: "PRIORITY: HIGH"
  { type: "date_dmy", weight: 16 },           // fixable: "25/09/2025 14:03"
  { type: "duplicate_ticket", weight: 7 },    // needs review
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function injectIssue(record, type, rng, previous) {
  const r = record;
  switch (type) {
    case "email_obfuscated": r.email = r.email.replace("@", rng() < 0.5 ? " at " : "(at)"); break;
    case "email_formatting": r.email = " " + r.email.replace(/^./, (c) => c.toUpperCase()).replace(/\.(com)$/, ".COM") + " "; break;
    case "email_missing": r.email = ""; break;
    case "email_placeholder": r.email = pick(rng, ["n/a", "unknown", "none"]); break;
    case "description_missing": r.description = ""; break;
    case "priority_noise": r.priority = pick(rng, ["PRIORITY: ", "Priority - ", ""]) + String(r.priority).toUpperCase() + pick(rng, ["", " PRIORITY", "!!"]); break;
    case "date_dmy": {
      const d = new Date(r.createdDate);
      r.createdDate = pad2(d.getUTCDate()) + "/" + pad2(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear() + " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
      break;
    }
    case "duplicate_ticket": if (previous) r.ticketId = previous.ticketId; break;
    default: break;
  }
  r._issue = type;
}

/**
 * @param {object} opts
 * @param {string} opts.profile  jira | legacy-itsm | mock-legacy
 * @param {number} opts.count    number of ticket records
 * @param {number} opts.seed     PRNG seed
 * @param {Date}   [opts.now]    anchor for created dates (last 365 days)
 * @param {"realistic"|"clean"} [opts.quality]  realistic adds ~6% data-quality issues
 */
function generateDemoRecords({ profile = "mock-legacy", count = 750, seed = 42, now = new Date(), quality = "realistic" } = {}) {
  const p = PROFILES[profile];
  if (!p) throw new Error("Unknown demo profile: " + profile);

  const rng = createRng(seed);
  // roughly 4 tickets per employee
  const employees = generateEmployees(rng, Math.max(10, Math.ceil(count / 4)), p.emailDomain);
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yearMs = 365 * 24 * 3600 * 1000;

  const records = [];
  for (let i = 0; i < count; i++) {
    const emp = pick(rng, employees);
    const ticketType = pick(rng, TICKET_TYPES);
    records.push({
      employeeId: emp.employeeId,
      employeeName: emp.employeeName,
      email: emp.email,
      department: p.departments[emp.department] || emp.department,
      ticketId: "",
      ticketType,
      priority: pickWeighted(rng, p.priorities, p.priorityWeights),
      description: pick(rng, DESCRIPTIONS[ticketType]),
      status: pick(rng, p.statuses),
      createdDate: new Date(anchor - Math.floor(rng() * yearMs)).toISOString(),
    });
  }
  // oldest first, like a real export; ticket numbers follow creation order
  records.sort((a, b) => (a.createdDate < b.createdDate ? -1 : 1));
  records.forEach((r, i) => { r.ticketId = p.ticketId(i); });

  if (quality === "realistic") {
    const issueRng = createRng(seed + 7919);
    const totalWeight = ISSUES.reduce((n, x) => n + x.weight, 0);
    records.forEach((r, i) => {
      const roll = issueRng();
      const which = issueRng() * totalWeight;
      if (i < CLEAN_HEAD || roll >= ISSUE_RATE) return;
      let acc = 0;
      const issue = ISSUES.find((x) => (acc += x.weight) >= which) || ISSUES[0];
      injectIssue(r, issue.type, issueRng, records[i - 1]);
    });
  }
  // _issue is ground truth for tests only; strip it from what sources expose
  return records.map((r) => {
    const { _issue, ...rest } = r;
    Object.defineProperty(rest, "_issue", { value: _issue, enumerable: false });
    return rest;
  });
}

/* Native (source-dialect) view of the profile: field names as the source
   system exports them, plus one extra field with no Freshservice equivalent. */
function nativeSchema(profile) {
  const p = PROFILES[profile];
  if (!p) throw new Error("Unknown demo profile: " + profile);
  return Object.values(p.fields).concat(p.extra.name).map((key) => ({ key, label: key }));
}

function toNativeRecord(profile, record, index) {
  const p = PROFILES[profile];
  const out = {};
  for (const [zenKey, nativeKey] of Object.entries(p.fields)) out[nativeKey] = record[zenKey];
  out[p.extra.name] = p.extra.values[index % p.extra.values.length];
  return out;
}

/* Ground truth used by tests: native field → Zen record field. */
function nativeFieldMap(profile) {
  const p = PROFILES[profile];
  const map = {};
  for (const [zenKey, nativeKey] of Object.entries(p.fields)) map[nativeKey] = zenKey;
  return map;
}

module.exports = {
  generateDemoRecords,
  nativeSchema,
  toNativeRecord,
  nativeFieldMap,
  DEMO_PROFILES: Object.keys(PROFILES),
};
