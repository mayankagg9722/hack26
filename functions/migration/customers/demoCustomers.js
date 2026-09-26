/* Customers the demo migrates: real people from Zen's Jira demo data
   (unique requesters), so the flow uses the same organisation as the rest
   of the demo. One has no display name in the source — Freshservice rejects
   it — and two already exist as employees in Freshservice. */

const { generateDemoRecords } = require("../demoData");

const BLANK_NAME_INDEX = 40;
const PRE_EXISTING = [17, 58];

function demoCustomers(count = 100, seed = 42) {
  const seen = new Set();
  const out = [];
  for (const r of generateDemoRecords({ profile: "jira", count: 1500, seed, quality: "clean" })) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    out.push({ name: r.employeeName, email: r.email });
    if (out.length >= count) break;
  }
  if (out[BLANK_NAME_INDEX]) out[BLANK_NAME_INDEX] = { ...out[BLANK_NAME_INDEX], name: "" };
  return out;
}

/** emails of the employees that exist in the simulated Freshservice before Zen runs */
function preExistingEmployeeEmails(count = 100, seed = 42) {
  const list = demoCustomers(Math.max(count, 100), seed);
  return PRE_EXISTING.filter((i) => i < count).map((i) => list[i].email);
}

module.exports = { demoCustomers, preExistingEmployeeEmails };
