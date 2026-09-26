const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

const sourcePath = path.join(__dirname, 'deckv2.md');
const sourceBrief = fs.readFileSync(sourcePath, 'utf8');
const sectionStarts = [...sourceBrief.matchAll(/^(?:SLIDE\s+[1-8]|FINAL SLIDE)[^\r\n]*$/gm)];
if (sectionStarts.length !== 9) {
  throw new Error(`Expected nine sections in deckv2.md; found ${sectionStarts.length}.`);
}
const sourceSections = sectionStarts.map((section, index) =>
  sourceBrief.slice(section.index, sectionStarts[index + 1]?.index ?? sourceBrief.length).trim()
);

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Zen';
pptx.company = 'Zen';
pptx.subject = 'Goal-driven enterprise migration from Jira Service Management to Freshservice';
pptx.title = 'Zen | The Autonomous Enterprise Migration Agent';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };

const SIZE = { width: 13.333333, height: 7.5, left: 0.68, right: 12.65, inner: 11.97 };
const COLOR = {
  ink: '19171D',
  muted: '66636D',
  faint: '95909D',
  line: 'E5E2E9',
  wash: 'F7F6F9',
  white: 'FFFFFF',
  purple: '853BDD',
  purpleLight: 'CDA6FF',
  lilac: 'F3EBFC',
  green: '147E64',
  mint: 'B6EDCF',
  greenWash: 'EAF7F0',
  amber: 'A56611',
  amberWash: 'FCF3E3',
  darkLine: '3A3542',
  darkPanel: '242129',
  darkMuted: 'B9B2C3'
};
const ARROW = '\u2192';
const slideAudit = [];

function bounds(slide, kind, x, y, width, height, content = '') {
  const values = [x, y, width, height];
  if (!values.every(Number.isFinite) || x < 0 || y < 0 || width < 0 || height < 0 ||
      x + width > SIZE.width + 0.005 || y + height > SIZE.height + 0.005) {
    throw new Error(`Invalid ${kind} geometry on slide ${slideAudit.length}: ${JSON.stringify({ x, y, width, height, content })}`);
  }
  slideAudit[slideAudit.length - 1].elements.push({ kind, x, y, width, height, content });
}

function text(slide, content, x, y, width, height, fontSize = 14, options = {}) {
  bounds(slide, 'text', x, y, width, height, content);
  slide.addText(content, {
    x, y, w: width, h: height, fontSize,
    fontFace: 'Aptos', color: COLOR.ink, margin: 0,
    breakLine: false, paraSpaceAfterPt: 0, charSpacing: 0,
    valign: 'mid', fit: 'shrink', lang: 'en-US',
    ...options
  });
}

function rect(slide, x, y, width, height, fill, border = fill, radius = false) {
  bounds(slide, 'shape', x, y, width, height);
  slide.addShape(radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
    x, y, w: width, h: height, rectRadius: 0.06,
    radius: 0.06, fill: { color: fill }, line: { color: border, width: 0.7 }
  });
}

function line(slide, startX, startY, endX, endY, color = COLOR.line, arrow = false, width = 1) {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const shapeWidth = Math.abs(endX - startX);
  const shapeHeight = Math.abs(endY - startY);
  bounds(slide, 'line', x, y, shapeWidth, shapeHeight);
  slide.addShape(pptx.ShapeType.line, {
    x, y, w: shapeWidth, h: shapeHeight,
    flipH: endX < startX, flipV: endY < startY,
    line: { color, width, ...(arrow ? { endArrowType: 'triangle' } : {}) }
  });
}

function label(slide, content, x, y, width, color = COLOR.purple, align = 'left') {
  text(slide, content.toUpperCase(), x, y, width, 0.2, 10, { bold: true, color, align });
}

function addSlide(title, sectionIndex, presenterNotes = '', dark = false) {
  const slide = pptx.addSlide();
  slide.background = { color: dark ? COLOR.ink : COLOR.white };
  slideAudit.push({ title, elements: [] });
  line(slide, SIZE.left, 7.08, SIZE.right, 7.08, dark ? COLOR.darkLine : COLOR.line, false, 0.65);
  text(slide, 'ZEN / AUTONOMOUS ENTERPRISE MIGRATION', SIZE.left, 7.21, 6, 0.15, 8,
    { color: dark ? COLOR.darkMuted : COLOR.faint });
  text(slide, String(slideAudit.length).padStart(2, '0'), 12.18, 7.2, 0.47, 0.17, 8,
    { align: 'right', color: dark ? COLOR.darkMuted : COLOR.faint });
  slide.addNotes([
    `SLIDE ${slideAudit.length}: ${title}`,
    presenterNotes,
    'CONTENT SOURCE: deckv2.md. Full corresponding brief section is retained below. Research statements are supplied by the brief; no external source URLs were provided.',
    sourceSections[sectionIndex]
  ]);
  return slide;
}

function heading(slide, eyebrow, title, subtitle = '', dark = false) {
  label(slide, eyebrow, SIZE.left, 0.63, 11.9, dark ? COLOR.purpleLight : COLOR.purple);
  text(slide, title, SIZE.left, 0.99, SIZE.inner, 0.66, 29,
    { fontFace: 'Aptos Display', bold: true, color: dark ? COLOR.white : COLOR.ink });
  if (subtitle) {
    text(slide, subtitle, SIZE.left, 1.7, SIZE.inner, 0.38, 13.5,
      { color: dark ? COLOR.darkMuted : COLOR.muted });
  }
}

function route(slide, points, color = COLOR.purpleLight, width = 1.25) {
  points.slice(1).forEach((point, index) => {
    const previous = points[index];
    line(slide, previous[0], previous[1], point[0], point[1], color, index === points.length - 2, width);
  });
}

function diagramNode(slide, title, detail, x, y, width, height, options = {}) {
  rect(slide, x, y, width, height, options.fill || COLOR.darkPanel, options.border || COLOR.darkLine, true);
  text(slide, title, x + 0.13, y + (detail ? 0.1 : 0.05), width - 0.26, detail ? 0.25 : height - 0.1,
    options.fontSize || 13, { bold: true, color: options.color || COLOR.white, align: 'center' });
  if (detail) {
    text(slide, detail, x + 0.13, y + 0.4, width - 0.26, height - 0.48, options.detailSize || 10.5,
      { color: options.detailColor || COLOR.darkMuted, align: 'center' });
  }
}

{
  const slide = addSlide('Zen', 0,
    'OPEN: Give Zen a migration goal. Zen discovers, maps, tests, migrates, remediates and explains the outcome, involving people when confidence or judgment requires it. Introduce the migration story, not the older onboarding concept.', true);
  label(slide, 'Goal-driven migration / Human judgment when it matters', SIZE.left, 0.65, 10, COLOR.purpleLight);
  text(slide, 'Zen', 0.62, 1.04, 7.3, 1.58, 92,
    { bold: true, fontFace: 'Aptos Display', color: COLOR.white });
  label(slide, 'Jira Service Management', 9.05, 1.39, 3.6, COLOR.darkMuted, 'right');
  line(slide, 12.43, 1.78, 12.43, 2.13, COLOR.purpleLight, true, 1.6);
  text(slide, 'Freshservice', 9.05, 2.25, 3.6, 0.33, 19, { color: COLOR.white, bold: true, align: 'right' });
  text(slide, 'The Autonomous Enterprise Migration Agent', SIZE.left, 2.88, SIZE.inner, 0.61, 30,
    { fontFace: 'Aptos Display', bold: true, color: COLOR.white });
  text(slide, 'From manual migration projects to goal-driven, intelligent migration.', SIZE.left, 3.66, 11.6, 0.35, 17,
    { color: COLOR.darkMuted });
  text(slide, 'Give Zen the goal. It manages the migration and brings in humans only when needed.', SIZE.left, 4.16, 11.9, 0.37, 15,
    { color: COLOR.darkMuted });

  const capabilities = [
    ['DISCOVER', 'Understand source\nand target data'],
    ['MAP', 'AI-powered field\nand entity mapping'],
    ['TEST', 'Validate before\nfull migration'],
    ['EXECUTE', 'Migrate records\nautonomously'],
    ['REMEDIATE', 'Fix recoverable\nfailures'],
    ['EXPLAIN', 'Migration insights\nwith Claude']
  ];
  capabilities.forEach(([name, description], index) => {
    const x = SIZE.left + index * 2.02;
    line(slide, x, 5.07, x + 1.65, 5.07, index === 5 ? COLOR.mint : COLOR.purpleLight, false, 2.1);
    label(slide, name, x, 5.29, 1.82, index === 5 ? COLOR.mint : COLOR.white);
    text(slide, description, x, 5.67, 1.8, 0.55, 12.5, { color: COLOR.darkMuted });
    if (index < 5) text(slide, ARROW, x + 1.77, 5.28, 0.2, 0.22, 12, { color: COLOR.purpleLight });
  });
  text(slide, `From "Can we migrate?" ${ARROW} "Zen knows we're ready."`, SIZE.left, 6.58, SIZE.inner, 0.32, 18,
    { color: COLOR.mint, bold: true });
}

{
  const slide = addSlide('The problem', 1,
    'Migration is not simply a bulk copy. Walk through the journey, then group the friction into schema, history, execution and trust. The Freshservice documentation challenges cited in the brief are context, not measured findings from this prototype. The opportunity is a workflow-owning agent, not one more import script.');
  heading(slide, '02 / The problem', 'Enterprise migration is more than moving data.',
    'Changing ITSM platforms means preserving meaning, relationships and operational trust.');

  const journey = ['Discover', 'Map', 'Transform', 'Test', 'Migrate', 'Validate', 'Fix', 'Reconcile'];
  journey.forEach((stage, index) => {
    const x = SIZE.left + index * 1.51;
    text(slide, stage, x, 2.45, 1.21, 0.3, 13, { bold: true, align: 'center' });
    if (index < journey.length - 1) text(slide, ARROW, x + 1.29, 2.45, 0.2, 0.3, 13, { color: COLOR.faint });
    line(slide, x, 2.98, x + 1.18, 2.98, COLOR.line, false, 2);
  });

  const friction = [
    ['Schema', 'Different entities and models\nComplex field mappings\nTransformation rules'],
    ['History', 'Historical records\nRelationships to preserve\nMissing or incompatible data'],
    ['Execution', 'API and rate-limit constraints\nFailures and retries\nAttachment limitations'],
    ['Trust', 'Workflow / notification effects\nValidation and reconciliation\nSearch / analytics delays']
  ];
  friction.forEach(([title, detail], index) => {
    const x = SIZE.left + index * 3.08;
    text(slide, title, x, 3.43, 2.72, 0.38, 21, { bold: true });
    text(slide, detail, x, 4.01, 2.72, 1.13, 13.2, { color: COLOR.muted, valign: 'top' });
    if (index < friction.length - 1) line(slide, x + 2.87, 3.43, x + 2.87, 5.19);
  });
  text(slide, 'Freshservice migration documentation identifies API constraints, side effects, attachment limits and indexing delays.',
    SIZE.left, 5.44, SIZE.inner, 0.25, 10.5, { color: COLOR.muted });
  rect(slide, SIZE.left, 5.99, SIZE.inner, 0.65, COLOR.ink);
  text(slide, 'The hard part is making migration safe, complete and trustworthy.', 0.92, 6.14, 11.49, 0.33, 19,
    { bold: true, color: COLOR.white });
  text(slide, `APIs + scripts + specialists + troubleshooting  ${ARROW}  An agent that manages the workflow`,
    SIZE.left, 6.79, SIZE.inner, 0.21, 11.5, { color: COLOR.muted, align: 'center' });
}

{
  const slide = addSlide('Why now?', 2,
    'Four signals converge: customized migration remains high-touch; Freshservice offers REST API v2 and Product MCP; existing vendors already emphasize mapping, tests, validation, delta migration and human support; AI enables a goal-driven operating model. Avoid implying that current migration providers lack those capabilities. Product MCP, not Developer MCP, is the target product-data integration layer in the brief.');
  heading(slide, '03 / Why now?', 'The technology is ready for agentic migration.',
    'The integration foundation exists. The next step is intelligent orchestration.');

  const signals = [
    ['01', 'Migration is\nstill high-touch', 'Customized implementations\nand historical data make\nmigration more complex.'],
    ['02', 'The integration\nlayer is ready', 'Freshservice REST API v2\nplus Product MCP, with\nClaude client support.'],
    ['03', 'Confidence is\nalready expected', 'Mapping, test migrations,\nvalidation, delta migration\nand specialist assistance.'],
    ['04', 'AI can own\nthe workflow', 'Reason across the journey.\nTake routine actions.\nEscalate uncertainty.']
  ];
  signals.forEach(([number, title, detail], index) => {
    const x = SIZE.left + index * 3.08;
    text(slide, number, x, 2.48, 0.82, 0.55, 32, { color: COLOR.purple, bold: true });
    text(slide, title, x, 3.22, 2.74, 0.76, 20, { bold: true, valign: 'top' });
    text(slide, detail, x, 4.18, 2.74, 0.9, 13.2, { color: COLOR.muted, valign: 'top' });
  });
  line(slide, SIZE.left, 5.48, SIZE.right, 5.48);
  label(slide, 'Traditional', SIZE.left, 5.75, 1.59, COLOR.muted);
  text(slide, `API ${ARROW} Script ${ARROW} Import ${ARROW} Human troubleshooting`, 2.49, 5.7, 10.16, 0.32, 15,
    { color: COLOR.muted });
  label(slide, 'Agentic', SIZE.left, 6.2, 1.59);
  text(slide, `Goal ${ARROW} Discover ${ARROW} Reason ${ARROW} Map ${ARROW} Test ${ARROW} Execute ${ARROW} Remediate ${ARROW} Explain`,
    2.49, 6.15, 10.16, 0.34, 14.5, { bold: true });
  text(slide, 'Not another migration script. Confidence before, during and after migration.',
    SIZE.left, 6.73, SIZE.inner, 0.27, 15.5, { bold: true, color: COLOR.green });
}

{
  const slide = addSlide('The solution', 3,
    'The readiness score is illustrative, not a measured result or a specified scoring algorithm. Blocking mappings and required fields must be resolved before execution. Customer-to-requester and ticket-to-ticket are example entity mappings. Department-to-workspace classification depends on the customer configuration and approved mapping rules; it is not a universal equivalence. Keep detailed mappings and validation checks in the conversation, not all on the slide.');
  heading(slide, '04 / The solution', 'Zen turns migration into a confidence-based workflow.',
    'Test first. Execute when ready. Recover what is safe. Explain what remains.');
  rect(slide, SIZE.left, 2.22, SIZE.inner, 0.57, COLOR.wash);
  label(slide, 'The goal', 0.89, 2.4, 1.07);
  text(slide, '"Migrate all employees and tickets from Jira Service Management to Freshservice."',
    2.05, 2.34, 10.33, 0.34, 15, { bold: true });

  const CHECK = '\u2713';
  const stages = [
    ['Discover', 'JSM: customers + tickets\nFreshservice: requesters,\ntickets, departments,\nworkspaces'],
    ['Map', `Customer ${ARROW} Requester\nTicket ${ARROW} Ticket\nDepartment ${ARROW} Workspace\nPriority / Status ${ARROW} same`],
    ['Test', 'Controlled sample migration\nValidate before cutover'],
    ['Assess readiness', `${CHECK} Required fields   ${CHECK} Mapping\n${CHECK} Workspace classification\n${CHECK} Test migration   ${CHECK} Validation`],
    ['Execute', 'Run the full migration\nwith validated mappings'],
    ['Remediate', `Detect ${ARROW} Diagnose\nFix ${ARROW} Retry`],
    ['Reconcile', 'Compare source vs target\nIdentify remaining exceptions'],
    ['Explain', 'Claude summarizes outcomes,\nfixes and open issues']
  ];
  stages.forEach(([title, detail], index) => {
    const column = index % 4;
    const x = SIZE.left + column * 3.1;
    const y = index < 4 ? 3.08 : 5.09;
    const readiness = index === 3;
    if (readiness) {
      rect(slide, x - 0.13, y - 0.12, 2.82, 1.5, COLOR.greenWash, COLOR.greenWash, true);
      text(slide, 'Migration Readiness: 96%', x, y + 0.3, 2.6, 0.32, 15.5, { bold: true, color: COLOR.green });
    }
    label(slide, `${String(index + 1).padStart(2, '0')} / ${title}`, x, y, 2.65,
      readiness ? COLOR.green : COLOR.purple);
    text(slide, detail, x, y + (readiness ? 0.7 : 0.36), 2.6, readiness ? 0.6 : (index < 4 ? 0.95 : 0.64),
      readiness ? 11.5 : (index < 2 ? 12 : 13.1),
      { color: readiness ? COLOR.green : COLOR.ink, valign: 'top' });
    if (column < 3) text(slide, ARROW, x + 2.77, y - 0.02, 0.23, 0.23, 13, { color: COLOR.faint });
  });
  route(slide, [[12.84, 3.66], [12.98, 3.66], [12.98, 4.73], [0.47, 4.73], [0.47, 5.18], [0.62, 5.18]], COLOR.line, 1.2);
  label(slide, 'Ready to proceed', 10.09, 4.47, 2.56, COLOR.green, 'right');
  text(slide, 'Automate where confidence is high. Escalate where judgment is required.',
    SIZE.left, 6.55, SIZE.inner, 0.32, 17, { bold: true });
  text(slide, 'Readiness score shown is an illustrative example.', SIZE.left, 6.93, SIZE.inner, 0.13, 8.5,
    { color: COLOR.faint });
}

{
  const slide = addSlide('How Zen works', 4,
    'PROPOSED ARCHITECTURE: User goal enters the Zen Migration Engine through the goal interpreter. Entity discovery queries the JSM source adapter and Freshservice target integration. AI mapping feeds a controlled test and readiness assessment. Not-ready results loop through remediation and retesting. Ready results proceed to full migration and source-to-target validation/reconciliation. Recoverable failures are fixed and retried; unresolved cases go to human review. Both paths feed Claude insights. Zen MCP is the orchestration layer. Target connectivity uses Product MCP / REST API v2, not Developer MCP. This is the architecture from the brief, not a verified statement about implemented backend components.', true);
  heading(slide, '05 / How Zen works', `From natural language ${ARROW} autonomous execution`,
    'Proposed architecture / A readiness gate and an explicit human-review path.', true);

  diagramNode(slide, 'USER: "Migrate JSM to Freshservice"', '', 4.34, 2.27, 4.1, 0.48,
    { fill: COLOR.purple, border: COLOR.purple, fontSize: 13 });
  diagramNode(slide, 'ZEN AGENT', 'Goal interpreter / Zen Migration Engine', 4.84, 3.03, 3.11, 0.69,
    { border: COLOR.purpleLight, detailSize: 10 });
  diagramNode(slide, 'JSM SOURCE', 'Customers / Employees\nTickets', SIZE.left, 3.16, 2.38, 0.87);
  diagramNode(slide, 'FRESHSERVICE TARGET', 'Requesters / Tickets\nWorkspaces / Departments', SIZE.left, 4.55, 2.38, 0.91,
    { fontSize: 11.7 });
  diagramNode(slide, 'Entity discovery + AI mapping', '', 4.84, 4.05, 3.11, 0.56, { fontSize: 12.5 });
  diagramNode(slide, 'Test migration', '', 4.84, 4.91, 3.11, 0.54);
  diagramNode(slide, 'Migration readiness', '', 4.84, 5.77, 3.11, 0.56,
    { fill: '173C31', border: COLOR.mint, color: COLOR.mint });
  diagramNode(slide, 'REMEDIATE + RETEST', '', SIZE.left, 6.01, 2.38, 0.57,
    { fontSize: 11.2, border: COLOR.purpleLight, color: COLOR.purpleLight });

  route(slide, [[6.39, 2.75], [6.39, 3.01]]);
  route(slide, [[6.39, 3.72], [6.39, 4.03]]);
  route(slide, [[3.06, 3.59], [3.62, 3.59], [3.62, 4.33], [4.81, 4.33]]);
  route(slide, [[3.06, 5.0], [3.62, 5.0], [3.62, 4.33], [4.81, 4.33]]);
  route(slide, [[6.39, 4.61], [6.39, 4.89]]);
  route(slide, [[6.39, 5.45], [6.39, 5.75]]);
  label(slide, 'Not ready', 3.41, 5.68, 1.22, COLOR.purpleLight, 'center');
  route(slide, [[4.84, 6.05], [3.67, 6.05], [3.67, 6.3], [3.09, 6.3]]);
  route(slide, [[0.68, 6.3], [0.41, 6.3], [0.41, 4.33], [4.81, 4.33]], COLOR.darkMuted, 0.85);

  diagramNode(slide, 'Full migration', '', 9.28, 3.03, 3.37, 0.56, { border: COLOR.mint });
  diagramNode(slide, 'Validate + reconcile', 'Source vs target', 9.28, 3.94, 3.37, 0.7);
  diagramNode(slide, 'AUTO-FIXED', 'Fix + retry', 9.28, 5.13, 1.61, 0.68,
    { fontSize: 10.6, color: COLOR.mint, detailSize: 10.2 });
  diagramNode(slide, 'HUMAN REVIEW', 'Unresolved records', 11.04, 5.13, 1.61, 0.68,
    { fontSize: 10.3, color: 'F0C786', detailSize: 9.4 });
  diagramNode(slide, 'CLAUDE INSIGHTS', '', 9.28, 6.15, 3.37, 0.45,
    { fill: COLOR.purple, border: COLOR.purple, fontSize: 12 });
  label(slide, 'Ready', 7.99, 5.67, 0.65, COLOR.mint, 'center');
  route(slide, [[7.95, 6.05], [8.6, 6.05], [8.6, 3.31], [9.25, 3.31]], COLOR.mint);
  route(slide, [[10.97, 3.59], [10.97, 3.92]], COLOR.mint);
  route(slide, [[10.97, 4.64], [10.97, 4.89], [10.08, 4.89], [10.08, 5.1]], COLOR.mint);
  route(slide, [[10.97, 4.64], [10.97, 4.89], [11.85, 4.89], [11.85, 5.1]], 'F0C786');
  route(slide, [[10.08, 5.81], [10.08, 5.98], [10.97, 5.98], [10.97, 6.12]], COLOR.darkMuted);
  route(slide, [[11.85, 5.81], [11.85, 5.98], [10.97, 5.98], [10.97, 6.12]], COLOR.darkMuted);

  text(slide, 'SOURCE  JSM API / Adapter', SIZE.left, 6.83, 3.06, 0.18, 9.2, { color: COLOR.darkMuted });
  text(slide, 'TARGET  Freshservice Product MCP / REST API v2', 3.78, 6.83, 4.8, 0.18, 9.2, { color: COLOR.darkMuted });
  text(slide, 'AI  Claude   |   ORCHESTRATION  Zen MCP', 8.77, 6.83, 3.88, 0.18, 9.2,
    { color: COLOR.darkMuted, align: 'right' });
}

{
  const slide = addSlide('The agentic experience', 5,
    'ILLUSTRATIVE DEMO, NOT VERIFIED PRODUCTION RESULTS. Deliver the 3-4 minute story: one sentence; discover the systems; map; test; assess readiness; execute; show a recoverable failure; show the fix; let Claude explain. The mapping checkpoint contains 42 fields: 36 high-confidence, 5 medium-confidence, 1 requiring review. Do not silently bypass a blocking review. The sample contains 100 records: 98 initially successful and 2 remediated, with zero critical errors after remediation. The full example uses disjoint counts: 9,650 first-pass successes + 280 successfully remediated + 70 for human review = 10,000 records. Thus 96.5% is the first-pass success rate, while 99.3% is migrated after remediation. The original brief calls 96.5% the success rate; the slide clarifies this denominator without altering the counts. Missing requester information is the main failure category. Only reliable email matches and known department normalization are auto-fixed. Seventy records lack a reliable requester match and require human review.');
  heading(slide, '06 / The agentic experience', 'One goal. End-to-end migration.',
    'Illustrative walkthrough / Jira Service Management to Freshservice');
  rect(slide, SIZE.left, 2.21, SIZE.inner, 0.52, COLOR.lilac);
  text(slide, '"Migrate all employees and tickets from JSM to Freshservice."', 0.9, 2.32, 11.53, 0.28, 15,
    { bold: true });

  label(slide, 'Zen discovers', SIZE.left, 3.02, 4.25);
  text(slide, `Customers + tickets ${ARROW} Requesters + tickets\nWorkspaces and departments discovered`,
    SIZE.left, 3.34, 4.25, 0.6, 13.2, { color: COLOR.muted });
  label(slide, 'Zen maps', SIZE.left, 4.14, 4.25);
  text(slide, '42 fields: 36 high-confidence\n5 medium-confidence / 1 requires review',
    SIZE.left, 4.45, 4.25, 0.57, 13.2, { color: COLOR.muted });
  label(slide, 'Zen tests', SIZE.left, 5.21, 4.25);
  text(slide, '100 records: 98 passed + 2 auto-fixed', SIZE.left, 5.52, 4.25, 0.28, 13.2, { color: COLOR.muted });
  text(slide, `0 critical errors ${ARROW} MIGRATION READY`, SIZE.left, 5.9, 4.25, 0.28, 12.8,
    { bold: true, color: COLOR.green });
  line(slide, 5.07, 3.01, 5.07, 6.17);

  label(slide, 'Zen executes', 5.47, 3.02, 3.5);
  text(slide, '10,000', 5.45, 3.26, 3.4, 0.85, 48, { bold: true, fontFace: 'Aptos Display' });
  text(slide, 'records in this example', 5.49, 4.12, 3.56, 0.25, 12.3, { color: COLOR.muted });
  text(slide, '96.5%', 9.6, 3.39, 3.04, 0.66, 37,
    { bold: true, color: COLOR.green, align: 'right' });
  text(slide, 'first-pass success', 9.61, 4.12, 3.04, 0.25, 12.3, { color: COLOR.muted, align: 'right' });

  const results = [
    { label: 'Successfully migrated first pass', count: 9650, color: COLOR.green },
    { label: 'Automatically remediated', count: 280, color: COLOR.purple },
    { label: 'Human review', count: 70, color: COLOR.amber }
  ];
  const total = results.reduce((sum, result) => sum + result.count, 0);
  if (total !== 10000 || results[0].count / total !== 0.965 ||
      (results[0].count + results[1].count) / total !== 0.993) {
    throw new Error('The illustrative migration counts do not reconcile.');
  }
  let segmentX = 5.49;
  results.forEach(result => {
    const segmentWidth = 7.16 * result.count / total;
    rect(slide, segmentX, 4.6, segmentWidth, 0.15, result.color);
    segmentX += segmentWidth;
  });
  results.forEach((result, index) => {
    const y = 4.99 + index * 0.35;
    rect(slide, 5.49, y + 0.045, 0.1, 0.1, result.color);
    text(slide, result.label, 5.77, y, 5.37, 0.24, 13, { color: COLOR.muted });
    text(slide, result.count.toLocaleString('en-US'), 11.55, y, 1.1, 0.24, 13.5,
      { bold: true, align: 'right' });
  });
  text(slide, '99.3% migrated after remediation', 5.49, 6.02, 7.16, 0.26, 13.8,
    { bold: true, color: COLOR.green });

  rect(slide, SIZE.left, 6.44, SIZE.inner, 0.57, COLOR.wash);
  const explanations = [
    ['Claude / What went wrong?', 'Missing requester information.'],
    ['What Zen fixed', 'Reliable email matches + department values.'],
    ['What remains', '70 records without a reliable requester match.']
  ];
  explanations.forEach(([title, detail], index) => {
    const x = 0.83 + index * 4.0;
    text(slide, title.toUpperCase(), x, 6.52, 3.75, 0.16, 8.8, { bold: true, color: COLOR.purple });
    text(slide, detail, x, 6.77, 3.75, 0.16, 10.1, { color: COLOR.muted });
  });
}

{
  const slide = addSlide('What makes Zen different?', 6,
    'This compares a manual/script-led operating model with the proposed Zen workflow, not every existing commercial migration product. Existing providers already offer mapping, test migrations, validation, support and sometimes delta migration. Zen differentiates by unifying these capabilities into one goal-driven agent. The principle is to automate at high confidence and escalate when judgment is needed.');
  heading(slide, '07 / What makes Zen different?', `From migration execution ${ARROW} migration autonomy`,
    'A goal-driven operating model, with people involved where judgment matters.');
  rect(slide, SIZE.left, 2.3, SIZE.inner, 0.45, COLOR.ink);
  label(slide, 'Manual / script-led workflow', 0.92, 2.43, 5.41, COLOR.darkMuted);
  label(slide, 'Zen', 6.91, 2.43, 5.5, COLOR.mint);
  const comparisons = [
    ['Human defines every step', 'User defines the goal'],
    ['Manual schema discovery', 'Automatic discovery'],
    ['Manual field mapping', 'AI-assisted mapping'],
    ['Import and hope', 'Test before full migration'],
    ['Monitor failures manually', 'Agent detects failures'],
    ['Manually troubleshoot', 'AI remediation + retry'],
    ['Manual reconciliation', 'Automated reconciliation'],
    ['Human involved throughout', 'Human only for exceptions'],
    ['Static migration report', 'Claude-generated insights']
  ];
  comparisons.forEach(([traditional, zen], index) => {
    const y = 2.77 + index * 0.365;
    if (index % 2 === 0) rect(slide, SIZE.left, y, SIZE.inner, 0.365, COLOR.wash);
    text(slide, traditional, 0.92, y + 0.03, 5.35, 0.28, 13.3, { color: COLOR.muted });
    text(slide, zen, 6.91, y + 0.03, 5.48, 0.28, 13.3, { bold: true });
  });
  line(slide, 6.52, 2.8, 6.52, 6.05);
  text(slide, 'Automate where confidence is high. Escalate where judgment is required.',
    SIZE.left, 6.32, SIZE.inner, 0.35, 18.7, { bold: true, color: COLOR.green });
  text(slide, 'Migration providers already offer mapping, tests and validation. Zen brings them together in one goal-driven agent.',
    SIZE.left, 6.83, SIZE.inner, 0.19, 10.8, { color: COLOR.muted });
}

{
  const slide = addSlide('Business value and success', 7,
    'These are proposed MVP targets, not claimed achieved outcomes. Target enterprises adopting Freshservice, especially IT administrators, onboarding teams, Professional Services and migration teams. Report the denominator and stage of success explicitly: migration success after validation/reconciliation; recoverable failures remediated as a share of recoverable failures; records requiring human intervention as a share of all attempted records; and zero duplicate records. No measured acceleration or production reliability is asserted.');
  heading(slide, '08 / Business value & success', 'Accelerate customer time-to-value.',
    'For enterprise customers adopting Freshservice.');
  const values = [
    ['Faster', 'Automate repetitive\nmigration work.', COLOR.purple],
    ['Safer', 'Test, validate and reconcile\nbefore and after migration.', COLOR.green],
    ['Autonomous', 'Handle routine failures\nand recovery automatically.', COLOR.purple],
    ['Human-controlled', 'Escalate uncertainty\nand critical issues.', COLOR.amber]
  ];
  values.forEach(([title, detail, accent], index) => {
    const x = SIZE.left + index * 3.08;
    line(slide, x, 2.45, x + 0.54, 2.45, accent, false, 3);
    text(slide, title, x, 2.73, 2.73, 0.39, 20.5, { bold: true });
    text(slide, detail, x, 3.3, 2.73, 0.58, 13, { color: COLOR.muted, valign: 'top' });
  });
  rect(slide, SIZE.left, 4.22, SIZE.inner, 0.58, COLOR.wash);
  label(slide, 'Primary users', 0.88, 4.41, 1.38, COLOR.muted);
  text(slide, 'IT administrators / Onboarding teams / Professional Services / Migration teams',
    2.58, 4.37, 9.85, 0.29, 12.8, { bold: true });

  label(slide, 'MVP success targets', SIZE.left, 5.12, 5.8);
  const targets = [
    ['\u226595%', 'Migration success\nrate'],
    ['\u226580%', 'Recoverable failures\nautomatically remediated'],
    ['<10%', 'Records requiring\nhuman intervention'],
    ['0', 'Duplicate\nrecords']
  ];
  targets.forEach(([value, detail], index) => {
    const x = SIZE.left + index * 3.08;
    text(slide, value, x, 5.47, 2.73, 0.7, 42, { bold: true, color: COLOR.green, fontFace: 'Aptos Display' });
    text(slide, detail, x, 6.25, 2.73, 0.5, 13.2, { color: COLOR.muted });
  });
  text(slide, 'Target metrics for the MVP. Not claimed achieved results.', SIZE.left, 6.87, SIZE.inner, 0.17, 10.5,
    { color: COLOR.amber, bold: true });
}

{
  const slide = addSlide('The vision', 8,
    'CLOSE: The shift is from humans orchestrating a migration project to humans giving an agent a goal. Zen owns discovery, mapping, testing, execution, remediation, reconciliation and explanation, with humans only when needed. Final line: Give Zen the goal. Let Zen own the migration. The final brief section below also retains the full demo sequence and presentation guidance.', true);
  label(slide, '09 / The vision', SIZE.left, 0.65, 8, COLOR.purpleLight);
  text(slide, 'From Migration Project', SIZE.left, 1.15, SIZE.inner, 0.75, 42,
    { fontFace: 'Aptos Display', bold: true, color: COLOR.darkMuted });
  text(slide, 'to Migration Agent', SIZE.left, 1.99, SIZE.inner, 0.75, 42,
    { fontFace: 'Aptos Display', bold: true, color: COLOR.white });
  label(slide, 'Today', SIZE.left, 3.44, 4.86, COLOR.darkMuted);
  text(slide, 'People manage every step.', SIZE.left, 3.85, 5.12, 0.46, 22,
    { bold: true, color: COLOR.darkMuted });
  text(slide, `Configure ${ARROW} Map ${ARROW} Script ${ARROW} Test\nMigrate ${ARROW} Troubleshoot ${ARROW} Validate`,
    SIZE.left, 4.66, 5.1, 0.92, 15, { color: COLOR.darkMuted, valign: 'top' });
  line(slide, 6.06, 3.43, 6.06, 5.95, COLOR.darkLine);
  label(slide, 'With Zen', 6.68, 3.44, 5.97, COLOR.mint);
  text(slide, '"Move JSM to Freshservice."', 6.68, 3.85, 5.97, 0.46, 22,
    { bold: true, color: COLOR.white });
  text(slide, `Discover ${ARROW} Map ${ARROW} Test ${ARROW} Execute\nRemediate ${ARROW} Reconcile ${ARROW} Explain`,
    6.68, 4.66, 5.97, 0.79, 15, { color: COLOR.white, valign: 'top' });
  text(slide, 'Human only when needed.', 6.68, 5.64, 5.97, 0.35, 17,
    { bold: true, color: COLOR.mint });
  text(slide, 'Give Zen the goal. Let Zen own the migration.', SIZE.left, 6.56, SIZE.inner, 0.39, 24,
    { bold: true, color: COLOR.white });
}

async function main() {
  const expectedSlides = 9;
  if (slideAudit.length !== expectedSlides) throw new Error(`Expected ${expectedSlides} slides, found ${slideAudit.length}.`);
  const outputPath = path.join(__dirname, 'Zen-Deck-v2.pptx');
  await pptx.writeFile({ fileName: outputPath });
  console.log(JSON.stringify({
    file: outputPath,
    slides: slideAudit.length,
    sourceSections: sourceSections.length,
    elements: slideAudit.reduce((total, slide) => total + slide.elements.length, 0),
    bounds: 'All slide elements are within the 16:9 canvas.',
    notes: 'Complete source sections included in speaker notes.'
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});