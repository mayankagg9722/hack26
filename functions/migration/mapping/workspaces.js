/* Workspace classification: decide which target workspace a record belongs
   in from its department. Order: admin override → department rule →
   target's primary (default) workspace. */

const CATEGORY_RULES = [
  { category: "it", label: "IT", re: /\b(it|information technology|it operations|infrastructure|service desk|helpdesk|tech support)\b/i },
  { category: "hr", label: "HR", re: /\b(hr|human resources|people|people & culture|people and culture|talent|payroll)\b/i },
  { category: "finance", label: "Finance", re: /\b(fin|finance|accounts?|accounting|procurement|proc|purchasing|treasury)\b/i },
  { category: "facilities", label: "Facilities", re: /\b(fac|facilities|workplace|workplace services|office services|real estate|maintenance)\b/i },
];

// how a category shows up in a workspace name
const WORKSPACE_NAME_RE = {
  it: /\b(it|information technology|technology)\b/i,
  hr: /\b(hr|human resources|people)\b/i,
  finance: /\b(finance|accounts?|accounting)\b/i,
  facilities: /\b(facilities|workplace)\b/i,
};

function categorize(department) {
  const d = String(department || "").trim();
  if (!d) return null;
  return CATEGORY_RULES.find((r) => r.re.test(d)) || null;
}

function defaultWorkspace(workspaces) {
  return workspaces.find((w) => w.primary) || workspaces[0] || null;
}

function workspaceForCategory(category, workspaces) {
  const re = WORKSPACE_NAME_RE[category];
  return re ? workspaces.find((w) => re.test(w.name)) || null : null;
}

/**
 * @param {string} department
 * @param {Array<{id, name, primary?}>} workspaces
 * @param {Object<string, string|number>} [overrides]  department value → workspace id
 * @returns {{workspaceId, workspaceName, rule: "override"|"rule"|"default"|"none", reason}}
 */
function classifyWorkspace(department, workspaces, overrides = {}) {
  const dept = String(department == null ? "" : department).trim();
  if (!workspaces.length) {
    return { workspaceId: null, workspaceName: null, rule: "none", reason: "Target has a single workspace." };
  }

  if (dept && Object.prototype.hasOwnProperty.call(overrides, dept)) {
    const w = workspaces.find((x) => String(x.id) === String(overrides[dept]));
    if (w) return { workspaceId: w.id, workspaceName: w.name, rule: "override", reason: "Admin mapped '" + dept + "' to " + w.name + "." };
  }

  const cat = categorize(dept);
  if (cat) {
    const w = workspaceForCategory(cat.category, workspaces);
    if (w) {
      return { workspaceId: w.id, workspaceName: w.name, rule: "rule", reason: "Department '" + dept + "' is " + cat.label + " → " + w.name + "." };
    }
  }

  const def = defaultWorkspace(workspaces);
  return {
    workspaceId: def.id,
    workspaceName: def.name,
    rule: "default",
    reason: dept
      ? "No dedicated workspace for '" + dept + "' — routed to the default " + def.name + "."
      : "No department — routed to the default " + def.name + ".",
  };
}

module.exports = { classifyWorkspace, categorize, workspaceForCategory, defaultWorkspace };
