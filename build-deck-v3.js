const path = require('path');
const pptxgen = require('pptxgenjs');

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Zen';
pptx.company = 'Zen';
pptx.title = 'Zen | The Autonomous Enterprise Migration Agent';
pptx.subject = 'Goal-driven enterprise migration from Jira Service Management to Freshservice';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };

const S = pptx.ShapeType;
const W = 13.333, H = 7.5, L = 0.7, R = 12.633, CW = R - L;
const HEAD = 'Aptos Display', BODY = 'Aptos', SYMBOL = 'Segoe UI Symbol';
const ARROW = '\u2192', CHECK = '\u2713', DOT = '\u00B7';
const C = {
  ink: '111111', grey: '5F5F66', grey2: '8A8A93', rule: 'E7E5EC', soft: 'F6F5F8', chip: 'EFECF4', white: 'FFFFFF',
  purple: '9400FF', purpleDk: '7A00D2', tint: 'F5ECFF', lav: 'C9A2FF',
  green: '0E9F6E', greenTint: 'E7F6EF', mint: '5EE6A8',
  amber: 'D97706', amberTint: 'FDF1E0', gold: 'F5B94A',
  dark: '0D0B12', panel: '17141F', panel2: '221D2C', darkLine: '2F2A3A', darkMuted: 'A39DB0', dim: '6B6479'
};
const SHADOW = { type: 'outer', color: '2A1650', opacity: 0.1, blur: 9, offset: 2, angle: 90 };
let slideNo = 0;

for (const name of ['roundRect', 'rect', 'ellipse', 'line', 'arc', 'pie', 'chevron', 'homePlate', 'triangle', 'star4', 'gear6', 'lightningBolt']) {
  if (!S[name]) throw new Error(`pptxgenjs shape "${name}" is unavailable.`);
}

function check(x, y, w, h, what) {
  const ok = [x, y, w, h].every(Number.isFinite) && x >= -0.001 && y >= -0.001 && w >= 0 && h >= 0 &&
    x + w <= W + 0.005 && y + h <= H + 0.005;
  if (!ok) throw new Error(`Slide ${slideNo}: "${what}" is off-canvas ${JSON.stringify({ x, y, w, h })}`);
}

function text(slide, content, x, y, w, h, size, opts = {}) {
  check(x, y, w, h, typeof content === 'string' ? content : content.map(run => run.text).join(''));
  slide.addText(content, { x, y, w, h, fontSize: size, fontFace: BODY, color: C.ink, margin: 0, valign: 'middle', ...opts });
}

function label(slide, content, x, y, w, color, opts = {}) {
  text(slide, content.toUpperCase(), x, y, w, 0.22, 9.5, { bold: true, color, charSpacing: 1.5, ...opts });
}

function shape(slide, type, x, y, w, h, opts = {}) {
  check(x, y, w, h, type);
  const { fill, line, lineWidth = 0.75, dash, radius, shadow, ...rest } = opts;
  slide.addShape(type, {
    x, y, w, h,
    ...(fill ? { fill: { color: fill } } : {}),
    line: line ? { color: line, width: lineWidth, ...(dash ? { dashType: dash } : {}) } : { type: 'none' },
    ...(radius !== undefined ? { rectRadius: radius } : {}),
    ...(shadow ? { shadow: { ...SHADOW } } : {}),
    ...rest
  });
}

function chip(slide, content, x, y, w, h, opts = {}) {
  check(x, y, w, h, content);
  const { fill, line, lineWidth = 0.75, radius = h / 2, type = S.roundRect, size = 11.5, color = C.ink, bold = false, shadow, ...rest } = opts;
  slide.addText(content, {
    shape: type, x, y, w, h,
    ...(type === S.roundRect ? { rectRadius: radius } : {}),
    ...(fill ? { fill: { color: fill } } : {}),
    ...(line ? { line: { color: line, width: lineWidth } } : {}),
    ...(shadow ? { shadow: { ...SHADOW } } : {}),
    fontFace: BODY, fontSize: size, color, bold, align: 'center', valign: 'middle', margin: 0,
    ...rest
  });
}

function seg(slide, x1, y1, x2, y2, color, width = 1, opts = {}) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  check(x, y, w, h, 'line');
  slide.addShape(S.line, {
    x, y, w, h, flipH: x2 < x1, flipV: y2 < y1,
    line: {
      color, width,
      ...(opts.dash ? { dashType: opts.dash } : {}),
      ...(opts.arrow ? { endArrowType: 'triangle' } : {}),
      ...(opts.both ? { beginArrowType: 'triangle', endArrowType: 'triangle' } : {})
    }
  });
}

function route(slide, points, color, width = 1.25) {
  points.slice(1).forEach((point, i) =>
    seg(slide, points[i][0], points[i][1], point[0], point[1], color, width, { arrow: i === points.length - 2 }));
}

function person(slide, cx, top, size, color) {
  const head = size * 0.4, body = size * 0.8;
  shape(slide, S.ellipse, cx - head / 2, top, head, head, { fill: color });
  shape(slide, S.pie, cx - body / 2, top + head + size * 0.07, body, body, { fill: color, angleRange: [180, 0] });
}

function tick(slide, x, y, d, fill, color = C.white) {
  chip(slide, CHECK, x, y, d, d, { type: S.ellipse, fill, color, bold: true, size: Math.round(d * 380) / 10, fontFace: SYMBOL });
}

function heading(slide, eyebrow, title, opts = {}) {
  const dark = Boolean(opts.dark);
  label(slide, eyebrow, L, 0.55, 7, dark ? C.lav : C.purple, { fontSize: 10.5, charSpacing: 2 });
  text(slide, title, L, 0.84, CW, 0.66, 28, { bold: true, fontFace: HEAD, color: dark ? C.white : C.ink });
  if (opts.sub) text(slide, opts.sub, L, 1.52, CW, 0.34, 14, { color: dark ? C.darkMuted : C.grey });
}

function newSlide(notes, { dark = false, footer = true } = {}) {
  const slide = pptx.addSlide();
  slideNo += 1;
  slide.background = { color: dark ? C.dark : C.white };
  if (footer) {
    const color = dark ? C.darkMuted : C.grey2;
    text(slide, `ZEN  ${DOT}  AUTONOMOUS ENTERPRISE MIGRATION AGENT`, L, 7.08, 6, 0.18, 8, { color, charSpacing: 1 });
    text(slide, String(slideNo).padStart(2, '0'), R - 0.6, 7.08, 0.6, 0.18, 8, { color, align: 'right' });
  }
  slide.addNotes(notes);
  return slide;
}

const NOTES = {
  cover: [
    'Zen is the autonomous enterprise migration agent.',
    'Give Zen a migration goal. Zen discovers, maps, tests, migrates, remediates and explains the outcome, with humans involved only when needed.',
    'The shift we want customers to feel: from "Can we migrate?" to "Zen knows we\'re ready."'
  ].join('\n\n'),
  problem: [
    'Changing ITSM platforms is more than moving data. Teams manage a whole journey: discover, map, transform, test, migrate, validate, fix and reconcile.',
    'Friction shows up at every step: different entities and data models, complex field mappings and transformations, historical records and relationships, missing or incompatible data, API and rate-limit constraints, failures and retries, workflow and notification side effects, and manual validation and reconciliation.',
    'Freshservice\'s own migration documentation calls out rate limits, API flexibility, migration-triggered notifications, workflow and business-rule execution, attachment constraints, and possible search and analytics delays.',
    'The real problem: teams spend significant effort making migration safe, complete and trustworthy, not just moving records from A to B.',
    'Today, migration = APIs + scripts + specialists + manual troubleshooting. The opportunity: an autonomous agent that manages the workflow.'
  ].join('\n\n'),
  whyNow: [
    '1. Enterprise migration remains high-touch. Basic Freshservice onboarding can be straightforward, but complexity rises with customized implementations and historical data migration.',
    '2. Freshservice provides the integration foundation: REST API v2 and the Product MCP. The Product MCP exposes resources such as tickets, requesters, workspaces, departments and other organizational data, and supports Claude as a client.',
    '3. Migration vendors already focus on confidence: mapping, test migrations, validation, custom migration support, delta migration and human assistance.',
    '4. AI changes the operating model. Traditional: API, script, import, human troubleshooting. Agentic: goal, discover, reason, map, test, execute, remediate, explain.',
    'Close: the opportunity is not another migration script. It is an intelligent migration experience that gives customers confidence before, during and after migration.'
  ].join('\n\n'),
  landscape: [
    'Other tools in the industry help customers onboard to Freshworks. Representative providers include HDM by Relokia, SaaSGenie, and Klamp from Arbaan.',
    'HDM by Relokia represents migration-focused services and transfer automation. A recurring challenge is handling custom configurations and exceptions without specialist intervention.',
    'SaaSGenie represents guided onboarding and migration support. A recurring challenge is that mapping, validation and reconciliation can remain project-led and manual.',
    'Klamp from Arbaan represents integration and connector automation. A recurring challenge is that moving data through connectors does not by itself establish migration readiness or end-to-end confidence.',
    'The market validates demand. The remaining opportunity is a single autonomous workflow that discovers, reasons, tests, executes, remediates and explains.'
  ].join('\n\n'),
  solution: [
    'The user starts with one goal: "Migrate all employees and tickets from Jira Service Management to Freshservice."',
    '01 Discover: JSM customers/employees and tickets; Freshservice requesters, tickets, departments and workspaces.',
    '02 Map: JSM customer to Freshservice requester, JSM ticket to Freshservice ticket, department to workspace, priority to priority, status to status.',
    '03 Test: run a controlled sample migration.',
    '04 Assess readiness: required fields, mapping, workspace classification, test migration and validation. The 96% readiness score is illustrative.',
    '05 Execute the full migration. 06 Remediate: detect, diagnose, fix, retry. 07 Reconcile source vs target. 08 Explain: Claude summarizes what happened, what went wrong, what was fixed and what remains.'
  ].join('\n\n'),
  architecture: [
    'The user states the goal in natural language. The Zen agent interprets it, discovers entities in the JSM source and the Freshservice target, and the AI mapping engine proposes the mapping.',
    'A test migration feeds the readiness gate. Not ready: Zen remediates and retests. Ready: Zen runs the full migration, then validates and reconciles source vs target.',
    'Recoverable failures are auto-fixed and retried. Unresolved records go to human review. Both paths feed Claude insights.',
    'Technology layer: Source = Jira Service Management API / adapter. Agent = Zen Migration Engine. Target = Freshservice Product MCP / REST API v2. AI = Claude. Orchestration = Zen MCP.',
    'The Freshworks cookbook identifies REST APIs and the Product MCP as the relevant connection layers, and distinguishes the Product MCP from the Developer MCP.'
  ].join('\n\n'),
  demo: [
    'Illustrative demo scenario. Suggested talk track (3-4 minutes):',
    '"I give Zen one sentence." "Zen discovers the systems." "Zen maps them." "Zen tests the migration." "Zen tells me whether we\'re ready." "Zen executes." "Something fails." "Zen fixes it." "Claude tells me what happened."',
    'Discover: source customers and tickets; target requesters, tickets, workspaces and departments.',
    'Map: 42 fields discovered; 36 high-confidence, 5 medium-confidence, 1 requires review.',
    'Test: 100 sample records; 98 successful, 2 automatically remediated, 0 critical errors. Migration ready.',
    'Execute: 10,000 records; 9,650 successfully migrated (96.5% first-pass success rate), 280 automatically remediated, 70 sent to human review.',
    'Claude explains: missing requester information was the primary failure category. Zen resolved records where an existing requester could be identified by email and normalized known department values. 70 records need human review because no reliable requester match was found.'
  ].join('\n\n'),
  different: [
    'Traditional approach vs Zen: human defines every step vs user defines the goal; manual schema discovery vs automatic discovery; manual field mapping vs AI-assisted mapping; import and hope vs test before full migration; monitor failures manually vs agent detects failures; manually troubleshoot vs AI remediation and retry; manual reconciliation vs automated reconciliation; human involved throughout vs human only for exceptions; static migration report vs Claude-generated insights.',
    'Existing migration solutions demonstrate the value of mapping, test migrations, validation and migration support. Zen brings these capabilities together into one goal-driven agent.',
    'The Zen principle: automate where confidence is high, escalate where judgment is required.'
  ].join('\n\n'),
  value: [
    'Customer value: faster (automate repetitive migration work), safer (test, validate and reconcile before and after migration), autonomous (AI handles routine failures and remediation), human-controlled (escalate uncertain or critical issues instead of silently proceeding).',
    'Target customers: enterprise customers adopting Freshservice. Primary users: IT administrators, customer onboarding teams, Professional Services and migration teams.',
    'MVP success targets: at least 95% migration success rate, at least 80% of recoverable failures automatically remediated, under 10% of records requiring human intervention, and zero duplicate records. These are targets for the MVP, not claimed achieved results.'
  ].join('\n\n'),
  vision: [
    'Today: a human configures, maps, scripts, tests, migrates, troubleshoots and validates, managing every step.',
    'With Zen: a human says "Move JSM to Freshservice." Zen discovers, maps, tests, executes, remediates, reconciles and explains, and brings the human back only when needed.',
    'Close: Give Zen the goal. Let Zen own the migration.'
  ].join('\n\n'),
  future: [
    'Future plan: expose the complete Zen migration workflow as focused MCP tools.',
    '1. List all source entities in Jira Service Management that must be migrated, beginning with customers (employees) and tickets.',
    '2. List all available destination entities in Freshservice.',
    '3. Generate the source-to-destination entity and field mapping.',
    '4. Run the migration using the approved mapping and controls.',
    '5. Use Claude to generate a concise migration summary and actionable insights.',
    '6. Explain what went wrong and recommend how to fix it, enabling remediation and retry.',
    'Together, these tools turn the prototype workflow into a reusable, observable migration capability.'
  ].join('\n\n')
};

// 1. Cover
{
  const s = newSlide(NOTES.cover, { footer: false });
  shape(s, S.ellipse, 8.25, 0.55, 4.7, 4.7, { line: C.rule, lineWidth: 0.75 });
  shape(s, S.arc, 8.6, 0.9, 4.0, 4.0, { line: C.purple, lineWidth: 18, angleRange: [335, 285] });
  label(s, `Jira Service Management  ${ARROW}  Freshservice`, L, 0.9, 7.2, C.purple, { fontSize: 11, charSpacing: 2 });
  text(s, 'Zen', L - 0.05, 1.2, 6.5, 1.9, 120, { bold: true, fontFace: HEAD, color: C.ink });
  text(s, 'The Autonomous Enterprise\nMigration Agent', L, 3.22, 7.4, 1.05, 30,
    { bold: true, fontFace: HEAD, color: C.ink, valign: 'top' });
  text(s, 'From manual migration projects to goal-driven, intelligent migration.', L, 4.42, 7.4, 0.34, 15,
    { color: C.grey });

  const steps = ['Discover', 'Map', 'Test', 'Execute', 'Remediate', 'Explain'];
  const stepGap = 2.12, lineY = 5.62;
  seg(s, L + 0.08, lineY, L + 5 * stepGap + 0.08, lineY, C.rule, 1.25);
  steps.forEach((step, i) => {
    const x = L + i * stepGap;
    const last = i === steps.length - 1;
    shape(s, S.ellipse, x, lineY - 0.08, 0.16, 0.16, { fill: last ? C.green : C.purple });
    label(s, step, x, lineY + 0.22, Math.min(1.8, R - x), last ? C.green : C.ink, { fontSize: 11.5, charSpacing: 2 });
  });
  text(s, [
    { text: `From \u201CCan we migrate?\u201D  ${ARROW}  `, options: { color: C.grey } },
    { text: '\u201CZen knows we\u2019re ready.\u201D', options: { color: C.green, bold: true } }
  ], L, 6.42, CW, 0.4, 17);
}

// 2. The problem
{
  const s = newSlide(NOTES.problem);
  heading(s, 'The problem', 'Enterprise migration is more than moving data', {
    sub: 'The hard part isn\u2019t moving records from A to B. It\u2019s making migration safe, complete and trustworthy.'
  });
  label(s, 'The migration journey', L, 2.28, 5, C.grey2);
  text(s, [
    { text: '\u25CF  ', options: { color: C.amber } },
    { text: 'FRICTION POINT', options: { color: C.grey2, bold: true, charSpacing: 1.5 } }
  ], R - 2.5, 2.28, 2.5, 0.22, 9.5, { align: 'right' });

  const stages = ['Discover', 'Map', 'Transform', 'Test', 'Migrate', 'Validate', 'Fix', 'Reconcile'];
  const friction = [
    'Different entities & data models', 'Complex field mappings', 'Missing or incompatible data',
    'Workflow & notification effects', 'API & rate-limit constraints', 'Manual validation & reconciliation',
    'Failures & retries', 'Historical records & relationships'
  ];
  const chevW = 1.6925, chevStep = 1.4625, chevY = 2.6, chevH = 0.6;
  stages.forEach((stage, i) => {
    const x = L + i * chevStep;
    chip(s, stage, x, chevY, chevW, chevH, { type: i === 0 ? S.homePlate : S.chevron, fill: C.chip, size: 12.5, bold: true });
    const cx = i === 0 ? x + 0.72 : x + chevW / 2;
    seg(s, cx, chevY + chevH + 0.1, cx, chevY + chevH + 0.34, 'D8D4E0', 1);
    shape(s, S.ellipse, cx - 0.07, chevY + chevH + 0.34, 0.14, 0.14, { fill: C.amber });
    text(s, friction[i], cx - 0.7, chevY + chevH + 0.58, 1.4, 0.5, 10.5, { color: C.grey, align: 'center', valign: 'top' });
  });

  shape(s, S.roundRect, L, 4.72, CW, 1.66, { fill: C.soft, radius: 0.14 });
  label(s, 'Migration today', 1.05, 5.09, 1.9, C.grey2);
  const parts = [['APIs', 1.35], ['Scripts', 1.55], ['Specialists', 1.85], ['Manual troubleshooting', 2.9]];
  let x = 3.05;
  parts.forEach(([name, w], i) => {
    chip(s, name, x, 4.95, w, 0.5, { fill: C.white, line: 'DDD9E4', size: 13 });
    x += w;
    if (i < parts.length - 1) {
      text(s, '+', x, 4.95, 0.42, 0.5, 16, { color: C.grey2, align: 'center', bold: true });
      x += 0.42;
    }
  });
  label(s, 'The opportunity', 1.05, 5.81, 1.9, C.purple);
  chip(s, 'An autonomous agent that manages the workflow', 3.05, 5.67, x - 3.05, 0.5,
    { fill: C.purple, color: C.white, bold: true, size: 13.5 });
  text(s, 'Source: Freshservice migration documentation cites rate limits, API flexibility, notifications, workflow execution, attachments and search/analytics delays.',
    L, 6.6, CW, 0.2, 9, { color: C.grey2 });
}

// 3. Why now
{
  const s = newSlide(NOTES.whyNow);
  heading(s, 'Why now', 'The technology is ready for agentic migration');
  const signals = [
    ['01', 'Migration is still\nhigh-touch', 'Complexity rises with customization and historical data'],
    ['02', 'The integration\nlayer exists', 'Freshservice REST API v2 +\nProduct MCP, with Claude support'],
    ['03', 'Confidence is\nthe benchmark', 'Vendors lead with mapping, test runs, validation and delta migration'],
    ['04', 'AI changes the\noperating model', 'From scripted steps to goal-driven agents']
  ];
  signals.forEach(([num, title, detail], i) => {
    const x = L + i * 3.06;
    text(s, num, x, 1.9, 1, 0.52, 28, { bold: true, fontFace: HEAD, color: C.purple });
    seg(s, x, 2.55, x + 2.75, 2.55, C.rule, 1);
    text(s, title, x, 2.72, 2.75, 0.62, 16.5, { bold: true, valign: 'top' });
    text(s, detail, x, 3.42, 2.7, 0.56, 12, { color: C.grey, valign: 'top' });
  });

  seg(s, L, 4.3, R, 4.3, C.rule, 0.75);
  const x0 = 2.45, slot = 1.08, gap = (R - x0 - 8 * slot) / 7, pillH = 0.46;
  const rowY = [4.72, 5.48];
  label(s, 'Traditional', L, rowY[0] + 0.12, 1.6, C.grey2);
  label(s, 'Agentic', L, rowY[1] + 0.12, 1.6, C.purple);
  const wide = 2 * slot + gap;
  ['API', 'Script', 'Import', 'Human troubleshooting'].forEach((name, i) => {
    const x = x0 + i * (wide + gap);
    const human = i === 3;
    chip(s, name, x, rowY[0], wide, pillH, {
      fill: human ? C.amberTint : C.white, line: human ? 'F2D3A6' : 'DDD9E4',
      color: human ? C.amber : C.grey, size: 12.5, bold: human
    });
    if (i < 3) seg(s, x + wide + 0.04, rowY[0] + pillH / 2, x + wide + gap - 0.04, rowY[0] + pillH / 2, C.grey2, 1, { arrow: true });
  });
  ['Goal', 'Discover', 'Reason', 'Map', 'Test', 'Execute', 'Remediate', 'Explain'].forEach((name, i) => {
    const x = x0 + i * (slot + gap);
    chip(s, name, x, rowY[1], slot, pillH, { fill: i === 0 ? C.purple : C.tint, color: i === 0 ? C.white : C.purpleDk, size: 12, bold: true });
    if (i < 7) seg(s, x + slot + 0.04, rowY[1] + pillH / 2, x + slot + gap - 0.04, rowY[1] + pillH / 2, C.purple, 1, { arrow: true });
  });
  text(s, [
    { text: 'Not another migration script. ', options: { color: C.ink } },
    { text: 'Confidence before, during and after migration.', options: { color: C.purple } }
  ], L, 6.3, CW, 0.4, 16, { bold: true });
}

// 4. Industry landscape
{
  const s = newSlide(NOTES.landscape);
  heading(s, 'Industry landscape', 'Customers already seek help getting to Freshworks', {
    sub: 'The market validates migration demand. The experience is still service-led, project-led or connector-led.'
  });

  const vendors = [
    {
      name: 'HDM', owner: 'by Relokia', mode: 'MIGRATION-LED',
      strength: 'Transfer automation', challenge: 'Custom configurations\n& exception handling'
    },
    {
      name: 'SaaSGenie', owner: 'Onboarding support', mode: 'SERVICE-LED',
      strength: 'Guided migration', challenge: 'Manual mapping,\nvalidation & reconciliation'
    },
    {
      name: 'Klamp', owner: 'from Arbaan', mode: 'CONNECTOR-LED',
      strength: 'Integration automation', challenge: 'Readiness across the\nend-to-end journey'
    }
  ];
  vendors.forEach((vendor, i) => {
    const x = L + i * 4.08;
    shape(s, S.roundRect, x, 2.12, 3.72, 3.32, { fill: C.white, line: 'E3DFE9', radius: 0.14, shadow: true });
    label(s, vendor.mode, x + 0.28, 2.4, 2.8, i === 2 ? C.green : C.purple, { fontSize: 9 });
    text(s, vendor.name, x + 0.28, 2.72, 3.1, 0.56, 27, { bold: true, fontFace: HEAD });
    text(s, vendor.owner, x + 0.28, 3.25, 3.1, 0.26, 11.5, { color: C.grey2 });
    seg(s, x + 0.28, 3.72, x + 3.44, 3.72, C.rule, 0.75);
    label(s, 'Helps with', x + 0.28, 3.98, 1.2, C.grey2, { fontSize: 8.5 });
    text(s, vendor.strength, x + 0.28, 4.22, 3.1, 0.3, 14, { bold: true });
    label(s, 'Recurring challenge', x + 0.28, 4.7, 2.2, C.amber, { fontSize: 8.5 });
    text(s, vendor.challenge, x + 0.28, 4.96, 3.1, 0.42, 12.5, { color: C.grey, valign: 'top' });
  });

  shape(s, S.roundRect, L, 5.78, CW, 0.76, { fill: C.dark, radius: 0.14 });
  label(s, 'The gap', 1.0, 6.05, 1.1, C.lav);
  text(s, 'One agent that owns readiness, execution, remediation and explanation.', 2.2, 5.78, 10.0, 0.76, 16,
    { bold: true, color: C.white });
  text(s, 'Representative market framing; recurring challenges describe the migration category, not product-specific limitations.',
    L, 6.68, CW, 0.18, 8.5, { color: C.grey2 });
}

// 5. The solution
{
  const s = newSlide(NOTES.solution);
  heading(s, 'The solution', 'Zen turns migration into a confidence-based workflow');
  shape(s, S.roundRect, L, 1.75, CW, 0.6, { fill: C.soft, radius: 0.3 });
  label(s, 'User goal', 1.05, 1.94, 1.3, C.purple);
  text(s, '\u201CMigrate all employees and tickets from Jira Service Management to Freshservice.\u201D', 2.35, 1.75, 10.0, 0.6, 14.5,
    { bold: true });

  const col = CW / 8, cx = i => L + col / 2 + i * col, nodeY = 3.92;
  label(s, 'Prove it\u2019s safe', L + 0.1, 2.8, 4, C.grey2);
  seg(s, L + 0.1, 3.08, L + 4 * col - 0.12, 3.08, 'D8D4E0', 1);
  label(s, 'Execute with control', L + 4 * col + 0.12, 2.8, 4, C.purple);
  seg(s, L + 4 * col + 0.12, 3.08, R - 0.1, 3.08, C.lav, 1);
  seg(s, cx(0), nodeY, cx(3), nodeY, 'D8D4E0', 1.5);
  seg(s, cx(3), nodeY, cx(7), nodeY, C.purple, 1.5);

  const stages = [
    ['Discover', 'Source & target data'],
    ['Map', 'AI field & entity mapping'],
    ['Test', 'Controlled sample migration'],
    ['Readiness', 'Go / no-go before cutover'],
    ['Execute', 'Full migration'],
    ['Remediate', 'Detect, diagnose, fix, retry'],
    ['Reconcile', 'Source vs target'],
    ['Explain', 'Claude summarizes the outcome']
  ];
  stages.forEach(([name, detail], i) => {
    const x = cx(i);
    if (i === 3) {
      const d = 1.2;
      shape(s, S.ellipse, x - d / 2, nodeY - d / 2, d, d, { fill: C.white, line: C.greenTint, lineWidth: 7 });
      shape(s, S.arc, x - d / 2, nodeY - d / 2, d, d, { line: C.green, lineWidth: 7, angleRange: [270, 255.6] });
      text(s, '96%', x - 0.5, nodeY - 0.22, 1.0, 0.44, 20, { bold: true, color: C.green, align: 'center', fontFace: HEAD });
    } else {
      const execute = i > 3;
      chip(s, String(i + 1).padStart(2, '0'), x - 0.31, nodeY - 0.31, 0.62, 0.62, {
        type: S.ellipse, fill: execute ? C.purple : C.white, line: execute ? undefined : C.purple, lineWidth: 1.5,
        color: execute ? C.white : C.purple, bold: true, size: 13
      });
    }
    text(s, name, x - 0.72, 4.73, 1.44, 0.3, 13.5, { bold: true, align: 'center', color: i === 3 ? C.green : C.ink });
    text(s, detail, x - 0.72, 5.05, 1.44, 0.5, 10.5, { align: 'center', valign: 'top', color: C.grey });
  });

  shape(s, S.roundRect, L, 5.84, CW, 0.62, { fill: C.greenTint, radius: 0.31 });
  label(s, 'Readiness checks', 1.05, 6.04, 2.0, C.green);
  const checks = ['Required fields', 'Mapping', 'Workspace classification', 'Test migration', 'Validation'];
  const textWidths = checks.map(item => item.length * 0.085 + 0.15);
  const checkGap = (12.3 - 3.0 - textWidths.reduce((a, b) => a + b + 0.33, 0)) / (checks.length - 1);
  let checkX = 3.0;
  checks.forEach((item, i) => {
    tick(s, checkX, 6.03, 0.24, C.green);
    text(s, item, checkX + 0.33, 5.84, textWidths[i], 0.62, 12);
    checkX += 0.33 + textWidths[i] + checkGap;
  });
  text(s, 'Readiness score shown is illustrative.', L, 6.62, CW, 0.2, 9, { color: C.grey2 });
}

// 5. How Zen works
{
  const s = newSlide(NOTES.architecture);
  heading(s, 'How Zen works', 'From natural language to autonomous execution');
  person(s, 0.95, 1.88, 0.4, C.purple);
  chip(s, `\u201CMigrate JSM ${ARROW} Freshservice\u201D`, 1.35, 1.8, 3.3, 0.5,
    { fill: C.tint, line: C.lav, color: C.purpleDk, bold: true, size: 13.5 });
  text(s, 'Natural-language goal', 4.85, 1.8, 3, 0.5, 11, { color: C.grey });
  seg(s, 3.0, 2.3, 3.0, 2.6, C.purple, 1.25, { arrow: true });

  shape(s, S.roundRect, L, 2.62, CW, 2.5, { fill: '14111B', line: '4B2A7A', lineWidth: 1, radius: 0.14 });
  label(s, `Zen agent  ${DOT}  Zen Migration Engine`, 0.95, 2.78, 6, C.lav);
  const chevW = 1.6475, chevStep = 1.3975, chevY = 3.2, chevH = 0.62;
  const chevX = i => 0.95 + i * chevStep;
  const chevCx = i => chevX(i) + chevW / 2;
  const flow = [
    ['Interpret\ngoal', C.panel2, C.white],
    ['Discover\nentities', C.panel2, C.white],
    ['AI\nmapping', C.panel2, C.white],
    ['Test\nmigration', C.panel2, C.white],
    ['Readiness\ngate', '123A2C', C.mint],
    ['Full\nmigration', '3A1D66', C.white],
    ['Validate &\nreconcile', '3A1D66', C.white],
    ['Claude\ninsights', C.purple, C.white]
  ];
  flow.forEach(([name, fill, color], i) =>
    chip(s, name, chevX(i), chevY, chevW, chevH, { type: i === 0 ? S.homePlate : S.chevron, fill, color, bold: true, size: 11 }));
  text(s, `READY ${ARROW}`, chevX(5) - 0.3, 2.98, 0.9, 0.2, 8.5, { bold: true, color: C.mint, charSpacing: 1, align: 'center' });

  const loopY = chevY + chevH + 0.26;
  route(s, [[chevCx(4), chevY + chevH], [chevCx(4), loopY], [chevCx(3), loopY], [chevCx(3), chevY + chevH + 0.02]], C.lav, 1.25);
  text(s, `Not ready ${ARROW} remediate & retest`, (chevCx(3) + chevCx(4)) / 2 - 1.2, loopY + 0.07, 2.4, 0.24, 10,
    { color: C.lav, align: 'center' });

  const vx = chevCx(6), fixY = 4.3, reviewY = 4.7;
  seg(s, vx, chevY + chevH, vx, reviewY, C.darkMuted, 1);
  seg(s, vx, fixY, 10.42, fixY, C.mint, 1, { arrow: true });
  seg(s, vx, reviewY, 10.42, reviewY, C.gold, 1, { arrow: true });
  chip(s, 'Auto-fix + retry', 10.47, fixY - 0.16, 1.9, 0.32, { fill: '123A2C', color: C.mint, size: 10, bold: true });
  chip(s, 'Human review', 10.47, reviewY - 0.16, 1.9, 0.32, { fill: '3A2A12', color: C.gold, size: 10, bold: true });

  const cards = [
    { x: L, w: 3.5, tag: 'Source', name: 'Jira Service Management', detail: `JSM API / Adapter\nCustomers ${DOT} Tickets` },
    { x: 4.515, w: 3.6, tag: 'AI + orchestration', name: 'Claude  +  Zen MCP', detail: 'Claude: reasoning & insights\nZen MCP: orchestration' },
    { x: 8.43, w: R - 8.43, tag: 'Target', name: 'Freshservice',
      detail: `Product MCP / REST API v2\nRequesters ${DOT} Tickets ${DOT} Workspaces ${DOT} Departments` }
  ];
  cards.forEach(card => {
    const y = 5.42;
    shape(s, S.roundRect, card.x, y, card.w, 1.36, { fill: C.panel, line: C.darkLine, radius: 0.12 });
    label(s, card.tag, card.x + 0.25, y + 0.17, card.w - 0.5, C.lav, { fontSize: 9 });
    text(s, card.name, card.x + 0.25, y + 0.42, card.w - 0.5, 0.32, 14, { bold: true, color: C.white });
    text(s, card.detail, card.x + 0.25, y + 0.8, card.w - 0.5, 0.46, 10.5, { color: C.darkMuted, valign: 'top' });
  });
  seg(s, chevCx(1), 5.4, chevCx(1), chevY + chevH + 0.02, C.darkMuted, 1, { arrow: true });
  seg(s, chevCx(5), chevY + chevH, chevCx(5), 5.4, C.darkMuted, 1, { arrow: true });
  seg(s, cards[1].x + cards[1].w / 2, 5.14, cards[1].x + cards[1].w / 2, 5.4, C.darkMuted, 1, { both: true });
}

// 6. The agentic experience
{
  const s = newSlide(NOTES.demo);
  heading(s, 'The agentic experience', 'One goal. End-to-end migration.');
  label(s, 'Illustrative demo scenario', R - 3.6, 0.55, 3.6, C.grey2, { align: 'right', fontSize: 9 });
  shape(s, S.roundRect, L, 1.7, CW, 0.62, { fill: C.white, line: 'DCD6E8', radius: 0.31, shadow: true });
  shape(s, S.ellipse, L + 0.1, 1.79, 0.44, 0.44, { fill: C.tint });
  person(s, L + 0.32, 1.9, 0.26, C.purple);
  text(s, '\u201CMigrate all employees and tickets from JSM to Freshservice.\u201D', L + 0.72, 1.7, 9.9, 0.62, 15, { bold: true });
  chip(s, ARROW, R - 0.56, 1.79, 0.44, 0.44, { type: S.ellipse, fill: C.purple, color: C.white, bold: true, size: 15 });

  const cardY = 2.62, cardH = 2.42, cardW = 2.8, cardStep = (CW - cardW) / 3;
  const cardX = i => L + i * cardStep;
  ['Discover', 'Map', 'Test', 'Execute'].forEach((name, i) => {
    const x = cardX(i);
    shape(s, S.roundRect, x, cardY, cardW, cardH, { fill: C.white, line: 'E6E3EC', radius: 0.12, shadow: true });
    label(s, `0${i + 1}  ${name}`, x + 0.25, cardY + 0.22, 1.9, C.purple, { fontSize: 10 });
    tick(s, x + cardW - 0.5, cardY + 0.2, 0.26, C.green);
  });
  const big = (x, value, caption, color = C.ink, captionSize = 11) => {
    text(s, value, x + 0.25, cardY + 0.5, 2.3, 0.6, 38, { bold: true, fontFace: HEAD, color });
    text(s, caption, x + 0.25, cardY + 1.1, 2.45, 0.24, captionSize, { color: C.grey });
  };
  const bar = (x, parts) => {
    const total = parts.reduce((sum, [value]) => sum + value, 0);
    let barX = x + 0.25;
    parts.forEach(([value, color], i) => {
      const width = 2.3 * value / total;
      shape(s, S.rect, barX, cardY + 1.52, Math.max(width - (i < parts.length - 1 ? 0.02 : 0), 0.03), 0.14, { fill: color });
      barX += width;
    });
  };
  const legend = (x, y, items) => {
    let legendX = x + 0.25;
    items.forEach(([num, word, color, width]) => {
      text(s, num, legendX, y, width, 0.3, 14, { bold: true, color });
      text(s, word, legendX, y + 0.29, width, 0.2, 9.5, { color: C.grey });
      legendX += width;
    });
  };
  const checkItem = (x, y, name) => {
    tick(s, x, y + 0.03, 0.18, C.green);
    text(s, name, x + 0.25, y, 1.1, 0.24, 11);
  };

  {
    const x = cardX(0);
    label(s, 'JSM', x + 0.25, cardY + 0.64, 1.0, C.grey2, { fontSize: 8.5 });
    label(s, 'Freshservice', x + 1.42, cardY + 0.64, 1.3, C.grey2, { fontSize: 8.5 });
    ['Customers', 'Tickets'].forEach((name, k) => checkItem(x + 0.25, cardY + 0.95 + k * 0.31, name));
    ['Requesters', 'Tickets', 'Workspaces', 'Departments'].forEach((name, k) => checkItem(x + 1.42, cardY + 0.95 + k * 0.31, name));
  }
  {
    const x = cardX(1);
    big(x, '42', 'fields discovered');
    bar(x, [[36, C.green], [5, C.purple], [1, C.amber]]);
    legend(x, cardY + 1.76, [['36', 'high', C.green, 0.72], ['5', 'medium', C.purple, 0.72], ['1', 'needs review', C.amber, 0.86]]);
  }
  {
    const x = cardX(2);
    big(x, '100', 'sample records tested');
    legend(x, cardY + 1.42, [['98', 'passed', C.green, 0.72], ['2', 'auto-fixed', C.purple, 0.86], ['0', 'critical', C.ink, 0.7]]);
    chip(s, '\u25CF  MIGRATION READY', x + 0.25, cardY + 1.98, 1.95, 0.3,
      { fill: C.greenTint, color: C.green, bold: true, size: 9.5, charSpacing: 1 });
  }
  {
    const x = cardX(3);
    const counts = [9650, 280, 70];
    if (counts.reduce((a, b) => a + b, 0) !== 10000 || counts[0] / 10000 !== 0.965) {
      throw new Error('Illustrative execution counts do not reconcile to 10,000 records at 96.5%.');
    }
    big(x, '96.5%', `first-pass success ${DOT} 10,000 records`, C.green, 10.5);
    bar(x, [[counts[0], C.green], [counts[1], C.purple], [counts[2], C.amber]]);
    legend(x, cardY + 1.76, [['9,650', 'migrated', C.green, 0.82], ['280', 'auto-fixed', C.purple, 0.78], ['70', 'human review', C.amber, 0.9]]);
  }

  shape(s, S.roundRect, L, 5.3, CW, 1.5, { fill: C.dark, radius: 0.14 });
  shape(s, S.star4, 1.0, 5.56, 0.34, 0.34, { fill: C.lav });
  text(s, 'Claude\nexplains', 1.0, 5.98, 1.55, 0.62, 15, { bold: true, color: C.white, valign: 'top', fontFace: HEAD });
  const qa = [
    ['What went wrong?', 'Missing requester information was the primary failure category.'],
    ['What did Zen fix?', 'Matched existing requesters by email and normalized known department values.'],
    ['What remains?', '70 records need human review \u2014 no reliable requester match was found.']
  ];
  qa.forEach(([question, answer], i) => {
    const x = 2.75 + i * 3.28;
    if (i > 0) seg(s, x - 0.2, 5.55, x - 0.2, 6.55, C.darkLine, 0.75);
    label(s, question, x, 5.52, 3.0, C.lav, { fontSize: 9 });
    text(s, answer, x, 5.8, 3.05, 0.85, 12, { color: C.white, valign: 'top' });
  });
}

// 7. What makes Zen different
{
  const s = newSlide(NOTES.different);
  heading(s, 'What makes Zen different', 'From migration execution to migration autonomy', {
    sub: 'Existing tools prove mapping, test runs and validation work. Zen unifies them in one goal-driven agent.'
  });
  label(s, 'Traditional approach', 0.95, 2.3, 3.3, C.grey2);
  label(s, 'Zen', 5.32, 2.3, 3.2, C.purple);
  seg(s, L, 2.6, 8.6, 2.6, 'D9D6DF', 1);
  const rows = [
    ['Human defines every step', 'User defines the goal'],
    ['Manual discovery & field mapping', 'Auto-discovery + AI mapping'],
    ['Import and hope', 'Test before full migration'],
    ['Monitor & troubleshoot manually', 'AI detects, fixes & retries'],
    ['Manual reconciliation', 'Automated reconciliation'],
    ['Human involved throughout', 'Human only for exceptions'],
    ['Static migration report', 'Claude-generated insights']
  ];
  const rowH = 0.54;
  rows.forEach(([before, after], i) => {
    const y = 2.62 + i * rowH;
    text(s, before, 0.95, y, 3.4, rowH, 13, { color: C.grey });
    text(s, ARROW, 4.42, y, 0.4, rowH, 13, { color: 'B9B4C3', align: 'center' });
    tick(s, 4.95, y + (rowH - 0.24) / 2, 0.24, C.purple);
    text(s, after, 5.32, y, 3.25, rowH, 13, { bold: true });
    seg(s, L, y + rowH, 8.6, y + rowH, 'EEECF2', 0.75);
  });

  const cardBottom = 2.62 + rows.length * rowH;
  shape(s, S.roundRect, 9.0, 2.3, R - 9.0, cardBottom - 2.3, { fill: C.dark, radius: 0.14 });
  label(s, 'The Zen principle', 9.28, 2.62, 3.0, C.lav);
  text(s, 'Automate where\nconfidence is high.', 9.28, 3.02, 3.1, 0.8, 21,
    { bold: true, fontFace: HEAD, color: C.white, valign: 'top' });
  text(s, 'Escalate where\njudgment is required.', 9.28, 3.98, 3.1, 0.8, 21,
    { bold: true, fontFace: HEAD, color: C.mint, valign: 'top' });
  const meterX = 9.28, meterW = 3.07, meterY = cardBottom - 0.72;
  shape(s, S.rect, meterX, meterY, meterW * 0.72, 0.08, { fill: C.mint });
  shape(s, S.rect, meterX + meterW * 0.72 + 0.03, meterY, meterW * 0.28 - 0.03, 0.08, { fill: C.gold });
  text(s, 'Zen acts', meterX, meterY + 0.16, 1.5, 0.2, 9.5, { color: C.mint, bold: true });
  text(s, 'People decide', meterX + meterW - 1.5, meterY + 0.16, 1.5, 0.2, 9.5, { color: C.gold, bold: true, align: 'right' });
}

// 8. Business value & success
{
  const s = newSlide(NOTES.value);
  heading(s, 'Business value & success', 'Accelerate customer time-to-value');
  const values = [
    ['Faster', 'Automates repetitive\nmigration work'],
    ['Safer', 'Tests, validates and reconciles\nbefore and after migration'],
    ['Autonomous', 'AI handles routine failures\nand remediation'],
    ['Human-controlled', 'Escalates uncertain or\ncritical issues']
  ];
  values.forEach(([title, detail], i) => {
    const x = L + i * 3.06, iconY = 1.85, icx = x + 0.31, icy = iconY + 0.31;
    shape(s, S.ellipse, x, iconY, 0.62, 0.62, { fill: C.tint });
    if (i === 0) shape(s, S.lightningBolt, icx - 0.15, icy - 0.17, 0.3, 0.34, { fill: C.purple });
    if (i === 1) tick(s, icx - 0.17, icy - 0.17, 0.34, C.purple);
    if (i === 2) {
      shape(s, S.gear6, icx - 0.17, icy - 0.17, 0.34, 0.34, { fill: C.purple });
      shape(s, S.ellipse, icx - 0.055, icy - 0.055, 0.11, 0.11, { fill: C.tint });
    }
    if (i === 3) person(s, icx, icy - 0.15, 0.34, C.purple);
    text(s, title, x, 2.64, 2.75, 0.36, 17, { bold: true });
    text(s, detail, x, 3.0, 2.7, 0.5, 12, { color: C.grey, valign: 'top' });
  });

  shape(s, S.roundRect, L, 3.85, CW, 1.95, { fill: C.soft, radius: 0.14 });
  label(s, 'MVP success targets', 1.05, 4.08, 4, C.purple);
  text(s, 'Targets for the MVP \u2014 not claimed results', R - 4.35, 4.08, 4, 0.22, 9.5,
    { color: C.grey2, align: 'right', italic: true });
  const metrics = [
    ['\u226595%', 'Migration success rate'],
    ['\u226580%', 'Recoverable failures\nauto-remediated'],
    ['<10%', 'Records needing\nhuman intervention'],
    ['0', 'Duplicate records']
  ];
  metrics.forEach(([value, caption], i) => {
    const x = 1.05 + i * 2.93;
    if (i > 0) seg(s, x - 0.25, 4.5, x - 0.25, 5.5, 'DDD9E4', 0.75);
    text(s, value, x, 4.4, 2.6, 0.72, 44, { bold: true, fontFace: HEAD, color: C.purpleDk });
    text(s, caption, x, 5.14, 2.4, 0.5, 12, { color: C.grey, valign: 'top' });
  });

  label(s, 'Built for enterprises adopting Freshservice', L, 6.08, 6, C.grey2);
  let chipX = L;
  [['IT administrators', 1.75], ['Customer onboarding teams', 2.5], ['Professional Services', 2.1], ['Migration teams', 1.6]]
    .forEach(([name, w]) => {
      chip(s, name, chipX, 6.38, w, 0.4, { fill: C.white, line: 'DDD9E4', size: 11.5 });
      chipX += w + 0.15;
    });
}

// 9. The vision
{
  const s = newSlide(NOTES.vision);
  label(s, 'The vision', L, 0.55, 4, C.purple, { fontSize: 10.5, charSpacing: 2 });
  text(s, 'From migration project', L, 0.86, CW, 0.7, 40, { bold: true, fontFace: HEAD, color: C.grey2 });
  text(s, 'to migration agent', L, 1.52, CW, 0.7, 40, { bold: true, fontFace: HEAD, color: C.ink });

  label(s, 'Today', L, 2.8, 1.8, C.grey2, { fontSize: 10 });
  text(s, 'People run\nevery step', L, 3.06, 1.8, 0.62, 14, { bold: true, color: C.grey, valign: 'top' });
  const todaySteps = ['Configure', 'Map', 'Script', 'Test', 'Migrate', 'Troubleshoot', 'Validate'];
  const todayX = 2.7, todayW = 1.25, todayStep = (R - 0.1 - todayX - todayW) / 6;
  seg(s, todayX + todayW / 2, 3.66, todayX + 6 * todayStep + todayW / 2, 3.66, C.rule, 1);
  todaySteps.forEach((step, i) => {
    const x = todayX + i * todayStep;
    person(s, x + todayW / 2, 2.92, 0.32, C.grey2);
    chip(s, step, x, 3.43, todayW, 0.46, { fill: C.soft, line: C.rule, color: C.grey, size: 11.5 });
  });

  label(s, 'With Zen', L, 4.62, 1.8, C.green, { fontSize: 10 });
  text(s, 'People set\nthe goal', L, 4.88, 1.8, 0.62, 14, { bold: true, color: C.ink, valign: 'top' });
  chip(s, `\u201CMove JSM ${ARROW} Freshservice\u201D`, 2.45, 4.3, 2.75, 0.44, { fill: C.purple, color: C.white, bold: true, size: 12 });
  shape(s, S.triangle, 2.8, 4.73, 0.2, 0.12, { fill: C.purple, flipV: true });
  person(s, 2.9, 4.98, 0.44, C.purple);
  seg(s, 3.2, 5.2, 3.5, 5.2, C.purple, 1.25, { arrow: true });
  const zenX = 3.55, zenW = 8.3, zenY = 4.85, zenH = 0.7;
  shape(s, S.roundRect, zenX, zenY, zenW, zenH, { fill: C.tint, line: C.lav, lineWidth: 1, radius: 0.12 });
  chip(s, 'ZEN', zenX + 0.1, zenY + 0.12, 0.75, 0.46, { fill: C.purple, color: C.white, bold: true, size: 12, charSpacing: 2, radius: 0.08 });
  const zenSteps = ['Discover', 'Map', 'Test', 'Execute', 'Remediate', 'Reconcile', 'Explain'];
  const zenChipW = (zenW - 0.2 - 0.75 - 0.1 - 6 * 0.07) / 7;
  zenSteps.forEach((step, i) =>
    chip(s, step, zenX + 0.95 + i * (zenChipW + 0.07), zenY + 0.12, zenChipW, 0.46, { fill: C.white, line: C.lav, color: C.purpleDk, size: 11, radius: 0.08 }));
  label(s, 'Zen owns the migration', 8.0, 4.52, zenX + zenW - 8.0, C.green, { align: 'right', fontSize: 9 });
  seg(s, zenX + zenW + 0.05, 5.2, zenX + zenW + 0.3, 5.2, C.purple, 1.25, { arrow: true });
  person(s, 12.4, 4.98, 0.44, C.grey2);
  text(s, 'Only when needed', 11.3, 5.62, R - 11.3, 0.2, 9, { color: C.green, bold: true, align: 'right' });

  text(s, [
    { text: 'Give Zen the goal. ', options: { color: C.ink } },
    { text: 'Let Zen own the migration.', options: { color: C.purple } }
  ], L, 6.22, CW, 0.56, 26, { bold: true, fontFace: HEAD });
}

// 11. Future plans
{
  const s = newSlide(NOTES.future);
  heading(s, 'Future plans', 'Productize the workflow as MCP tools', {
    sub: 'Six focused tools. One autonomous migration capability.'
  });

  const tools = [
    ['01', 'Discover source', 'List JSM entities', `Customers (Employees)\n${DOT} Tickets`],
    ['02', 'Discover target', 'List Freshservice entities', 'Available destination\nentities'],
    ['03', 'Map', 'Source to destination', 'Entity + field\nmapping'],
    ['04', 'Migrate', 'Run the migration', 'Approved mappings\n+ controls'],
    ['05', 'Summarize', 'Claude insights', 'Outcome + migration\nsummary'],
    ['06', 'Diagnose', 'Explain and fix', 'What went wrong\n+ how to fix it']
  ];
  const cardW = 1.78, gap = 0.23, startX = 0.7, cardY = 2.42, cardH = 2.52;
  tools.forEach(([num, title, action, detail], i) => {
    const x = startX + i * (cardW + gap);
    const final = i === tools.length - 1;
    shape(s, S.roundRect, x, cardY, cardW, cardH, {
      fill: final ? C.greenTint : C.white,
      line: final ? C.green : 'E3DFE9',
      lineWidth: final ? 1.2 : 0.75,
      radius: 0.12,
      shadow: !final
    });
    chip(s, num, x + 0.18, cardY + 0.2, 0.46, 0.46, {
      type: S.ellipse, fill: final ? C.green : C.purple, color: C.white,
      bold: true, size: 11
    });
    label(s, title, x + 0.18, cardY + 0.85, cardW - 0.36, final ? C.green : C.purple, { fontSize: 8.8 });
    text(s, action, x + 0.18, cardY + 1.17, cardW - 0.36, 0.48, 14, {
      bold: true, color: C.ink, valign: 'top'
    });
    text(s, detail, x + 0.18, cardY + 1.79, cardW - 0.36, 0.5, 10.5, {
      color: final ? C.green : C.grey, valign: 'top'
    });
    if (i < tools.length - 1) {
      seg(s, x + cardW + 0.04, cardY + cardH / 2, x + cardW + gap - 0.04, cardY + cardH / 2, C.purple, 1.1, { arrow: true });
    }
  });

  label(s, 'MCP tool chain', L, 5.4, 2.2, C.grey2);
  seg(s, 2.25, 5.51, R, 5.51, C.rule, 0.9);
  text(s, [
    { text: 'Discover. Map. Migrate. ', options: { color: C.ink } },
    { text: 'Understand the outcome and improve the next run.', options: { color: C.green } }
  ], L, 5.86, CW, 0.48, 20, { bold: true, fontFace: HEAD });
  text(s, 'Next milestone: a reusable, observable and recoverable migration platform.', L, 6.48, CW, 0.28, 12.5,
    { color: C.grey });
}

async function main() {
  if (slideNo !== 11) throw new Error(`Expected 11 slides, built ${slideNo}.`);
  const file = process.env.ZEN_DECK_OUTPUT || path.join(__dirname, 'Zen-Deck-v3.pptx');
  await pptx.writeFile({ fileName: file });
  console.log(`Wrote ${file} (${slideNo} slides)`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
