/* Zen Migration Agent — hackathon deck.
   Same visual language as ../build-deck.js. Screenshots in ./agent-shots come
   from a real demo run of /agent (simulated JSM + Freshservice tenant).
   Build: npm i pptxgenjs@3 (anywhere on NODE_PATH), then node deck/build-agent-deck.js */

const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Zen';
pptx.company = 'Zen';
pptx.subject = 'Zen migration agent: JSM → Freshservice';
pptx.title = 'Zen — the autonomous migration agent';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };

/* ---------------- design tokens (from build-deck.js) ---------------- */
const C = {
  purple: '9400FF', purpleDeep: '7000C4', lilac: 'F4E9FE', lilacLine: 'DDBFF7',
  ink: '141019', inkSoft: '2A2430', gray: '655F6D', grayLight: '95909C',
  hair: 'E6E2EA', wash: 'FAF9FB', white: 'FFFFFF',
  green: '11824A', greenBg: 'E9F7EF', greenLine: 'B4E2C8',
  red: 'CE3F3F', redBg: 'FDF3F3', redLine: 'F0C9C9',
  amber: '9A5B00', amberBg: 'FFF6E5', amberLine: 'F2D59B',
};
const G = { L: 0.7, R: 12.63, W: 11.93, BODY: 2.18, FLOOR: 6.92 };
const shotPath = (n) => path.join(__dirname, 'agent-shots', n);

/* PNG width/height from the IHDR chunk, so screenshots keep their ratio */
function dims(n) {
  const b = fs.readFileSync(shotPath(n));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

pptx.defineSlideMaster({
  title: 'ZEN',
  background: { color: C.white },
  objects: [
    { text: { text: 'ZEN', options: { x: G.L, y: 0.2, w: 0.6, h: 0.16, fontSize: 7.5, bold: true, color: C.purple, charSpacing: 2.2, margin: 0 } } },
    { text: { text: 'AUTONOMOUS MIGRATION AGENT', options: { x: 1.28, y: 0.2, w: 3, h: 0.16, fontSize: 7.5, color: C.grayLight, charSpacing: 1.1, margin: 0 } } },
    { line: { x: G.L, y: 0.46, w: G.W, h: 0, line: { color: C.hair, width: 0.7 } } },
    { line: { x: G.L, y: 7.08, w: G.W, h: 0, line: { color: C.hair, width: 0.7 } } },
    { text: { text: 'ZEN  /  FRESHWORKS HACKATHON 2026', options: { x: G.L, y: 7.2, w: 3.4, h: 0.16, fontSize: 7, color: C.grayLight, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.2, w: 0.43, h: 0.16, align: 'right', color: C.grayLight, fontSize: 7 },
});

/* ---------------- helpers ---------------- */
const light = () => pptx.addSlide({ masterName: 'ZEN' });
const bare = () => pptx.addSlide();

function head(s, eyebrow, headline, sub) {
  s.addText(eyebrow.toUpperCase(), { x: G.L, y: 0.72, w: 8, h: 0.2, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.6, margin: 0 });
  s.addText(headline, { x: G.L, y: 1.0, w: G.W, h: 0.6, fontSize: 28, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  if (sub) s.addText(sub, { x: G.L, y: 1.66, w: 11.2, h: 0.32, fontSize: 12.5, color: C.gray, margin: 0, fit: 'shrink' });
}

/* Screenshot fitted inside a box (never distorted), framed like build-deck.js. */
function shot(s, name, x, y, maxW, maxH, { align = 'center' } = {}) {
  const d = dims(name);
  let w = maxW;
  let h = (w * d.h) / d.w;
  if (h > maxH) { h = maxH; w = (h * d.w) / d.h; }
  const ox = align === 'left' ? x : x + (maxW - w) / 2;
  s.addShape(pptx.ShapeType.roundRect, {
    x: ox - 0.035, y: y - 0.035, w: w + 0.07, h: h + 0.07, rectRadius: 0.06,
    fill: { color: C.white }, line: { color: C.hair, width: 1 },
    shadow: { type: 'outer', color: 'A9A1B0', opacity: 0.22, blur: 2, angle: 45, distance: 1.4 },
  });
  s.addImage({ path: shotPath(name), x: ox, y, w, h });
  return { x: ox, y, w, h };
}

function card(s, x, y, w, h, fill = C.white, line = C.hair) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.09, fill: { color: fill }, line: { color: line, width: 0.9 } });
}
function tag(s, text, x, y, w, fill = C.lilac, color = C.purple) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.27, rectRadius: 0.135, fill: { color: fill }, line: { color: fill } });
  s.addText(text, { x: x + 0.06, y: y + 0.05, w: w - 0.12, h: 0.17, fontSize: 7.5, bold: true, color, align: 'center', charSpacing: 0.75, margin: 0, fit: 'shrink' });
}
function stepNo(s, n, x, y, d = 0.34) {
  s.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: C.purple }, line: { color: C.purple } });
  s.addText(String(n), { x, y: y + d * 0.2, w: d, h: d * 0.6, fontSize: 9, bold: true, color: C.white, align: 'center', margin: 0 });
}
function bullets(s, items, x, y, w, h, size = 12) {
  s.addText(items.map((t) => (typeof t === 'string'
    ? { text: t, options: { bullet: { indent: 14 }, breakLine: true } }
    : { text: t.text, options: { bullet: { indent: 14 }, breakLine: true, bold: t.bold } })), {
    x, y, w, h, fontSize: size, color: C.inkSoft, valign: 'top', margin: 0, paraSpaceAfter: 6, fit: 'shrink',
  });
}
function label(s, text, x, y, w, color = C.purple) {
  s.addText(text.toUpperCase(), { x, y, w, h: 0.2, fontSize: 8, bold: true, color, charSpacing: 1.3, margin: 0 });
}

/* ================= 1 — Title ================= */
{
  const s = bare();
  s.background = { color: 'FBFAFC' };
  s.addShape(pptx.ShapeType.ellipse, { x: 10.64, y: -1.25, w: 4.2, h: 4.2, fill: { color: C.lilac, transparency: 30 }, line: { color: C.lilac, transparency: 100 } });
  s.addShape(pptx.ShapeType.arc, { x: 0.66, y: 0.56, w: 0.48, h: 0.48, adjustPoint: 0.22, rotate: 20, fill: { color: 'FBFAFC', transparency: 100 }, line: { color: C.purple, width: 4.5 } });
  s.addText('ZEN', { x: 1.25, y: 0.69, w: 0.9, h: 0.28, fontSize: 14, bold: true, color: C.ink, charSpacing: 2.5, margin: 0 });

  s.addText('ZEN  |  AUTONOMOUS MIGRATION AGENT', { x: G.L, y: 1.42, w: 5.2, h: 0.22, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.55, margin: 0 });
  s.addText('Moving to Freshservice?\nLet an agent do the migration.', { x: G.L, y: 1.89, w: 5.35, h: 1.65, fontSize: 32, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  s.addText('Zen discovers what Jira Service Management and Freshservice hold, maps one onto the other, migrates customers and tickets, fixes what is safe to fix, asks a human about the rest — and explains the result with Claude.', { x: 0.72, y: 3.72, w: 4.95, h: 1.2, fontSize: 13.5, color: C.gray, margin: 0, fit: 'shrink' });

  const d = dims('hero.png');
  const w = 6.42; const h = (w * d.h) / d.w;
  s.addShape(pptx.ShapeType.roundRect, { x: 6.18, y: 1.05, w: 6.62, h: h + 0.2, rectRadius: 0.12, fill: { color: C.white }, line: { color: 'E1DCE5', width: 1 }, shadow: { type: 'outer', color: 'AFA7B5', opacity: 0.25, blur: 2, angle: 45, distance: 1.5 } });
  s.addImage({ path: shotPath('hero.png'), x: 6.28, y: 1.15, w, h });

  const sep = { text: '   →   ', options: { color: 'ADA7B4', bold: false } };
  s.addText([
    { text: 'DISCOVER', options: { color: C.purple, bold: true } }, sep,
    { text: 'MAP', options: { color: C.ink, bold: true } }, sep,
    { text: 'MIGRATE', options: { color: C.purple, bold: true } }, sep,
    { text: 'REVIEW', options: { color: C.ink, bold: true } }, sep,
    { text: 'EXPLAIN', options: { color: C.purple, bold: true } },
  ], { x: G.L, y: 5.68, w: 5.35, h: 0.2, fontSize: 8.5, charSpacing: 0.9, margin: 0, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: G.L, y: 6.05, w: 4.8, h: 0, line: { color: 'DED9E2', width: 0.8 } });
  s.addText('JSM  →  FRESHSERVICE  ·  CUSTOMERS + TICKETS', { x: G.L, y: 6.39, w: 4.8, h: 0.18, fontSize: 8.2, bold: true, color: '8D8791', charSpacing: 1.2, margin: 0 });
  s.addNotes('Zen is an autonomous migration agent. Today: Jira Service Management customers and tickets into Freshservice requesters and tickets. Five steps — discover, map, migrate, review, explain.');
}

/* ================= 2 — Problem ================= */
{
  const s = light();
  head(s, 'The problem', 'ITSM migrations fail in the details, not the big picture', 'Moving from one service desk to another is mostly careful, repetitive work — and the mistakes surface late.');
  const items = [
    ['Mapping is manual', 'Every field, every picklist value, every reference (requester, department, workspace) is matched by hand in spreadsheets.'],
    ['Dirty data surfaces late', 'Missing emails, unknown departments, custom priorities and blank summaries only fail when the target API rejects them.'],
    ['Retries create duplicates', 'Re-running a half-finished migration creates the same requester or ticket twice unless someone tracks every ID.'],
    ['People do the routine fixes', 'Admins spend their time normalising values and re-running batches instead of deciding the few cases that need judgement.'],
  ];
  const w = 2.83; const gap = 0.2;
  items.forEach(([t, d], i) => {
    const x = G.L + i * (w + gap);
    card(s, x, 2.45, w, 3.3, i === 2 ? C.redBg : C.wash, i === 2 ? C.redLine : C.hair);
    s.addText(String(i + 1).padStart(2, '0'), { x: x + 0.25, y: 2.7, w: 1, h: 0.4, fontSize: 20, bold: true, color: i === 2 ? C.red : C.purple, margin: 0 });
    s.addText(t, { x: x + 0.25, y: 3.25, w: w - 0.5, h: 0.6, fontSize: 15, bold: true, color: C.ink, margin: 0, fit: 'shrink', valign: 'top' });
    s.addText(d, { x: x + 0.25, y: 3.95, w: w - 0.5, h: 1.6, fontSize: 11.5, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  });
  s.addText('Zen turns this into an agent loop: the machine does the routine work, the human makes the exceptions.', { x: G.L, y: 6.15, w: G.W, h: 0.35, fontSize: 13, bold: true, color: C.purpleDeep, margin: 0 });
  s.addNotes('Nobody fails a migration because of the architecture diagram. They fail on a department called "Information Technology" that the target calls "IT", on a customer without an email, on a retry that creates a second requester.');
}

/* ================= 3 — Five tools ================= */
{
  const s = light();
  head(s, 'What Zen does', 'One agent, five tools', 'Each tool is a real backend capability with its own API — the UI and the agent loop call the same endpoints.');
  const tools = [
    ['list_source_entities', 'Discover', 'Asks JSM which entities exist and which fields they expose.'],
    ['list_target_entities', 'Discover', 'Asks Freshservice for requesters, tickets, departments, groups, workspaces.'],
    ['generate_mapping', 'Map', 'Proposes source → target fields with confidence and transformations.'],
    ['run_migration', 'Migrate', 'Plans, pre-checks, migrates, remediates, pauses for review, reconciles.'],
    ['generate_migration_insights', 'Explain', 'Claude analyses the finished run and recommends what to fix next.'],
  ];
  const w = 2.25; const gap = 0.17;
  tools.forEach(([name, stage, d], i) => {
    const x = G.L + i * (w + gap);
    card(s, x, 2.4, w, 3.4, i === 4 ? C.lilac : C.white, i === 4 ? C.lilacLine : C.hair);
    stepNo(s, i + 1, x + 0.22, 2.62);
    tag(s, stage.toUpperCase(), x + 0.7, 2.66, 1.1);
    s.addText(name, { x: x + 0.22, y: 3.2, w: w - 0.4, h: 0.5, fontSize: 11.5, bold: true, color: C.ink, fontFace: 'Consolas', margin: 0, fit: 'shrink', valign: 'top' });
    s.addText(d, { x: x + 0.22, y: 3.8, w: w - 0.4, h: 1.8, fontSize: 11.5, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  });
  s.addText('GET /api/agent/tools describes all five  ·  every response is credential-free', { x: G.L, y: 6.2, w: G.W, h: 0.3, fontSize: 11, color: C.grayLight, margin: 0 });
  s.addNotes('Five tools. Two discovery tools, a mapping tool, the migration executor, and Claude insights. They are plain HTTP endpoints, so they can be driven by the UI, a scheduler, or an LLM agent.');
}

/* ================= 4 — Discover ================= */
{
  const s = light();
  head(s, 'Tool 1 + 2 · Discover', 'Zen reads both systems before it moves anything', 'Every entity shows where its schema came from — and whether the data is real or simulated.');
  shot(s, 'discover.png', G.L, 2.25, 7.7, 4.4, { align: 'left' });
  const x = 8.75; const w = 3.88;
  label(s, 'Freshworks integration', x, 2.3, w);
  bullets(s, [
    'Freshservice REST API v2 — /api/v2 (requester fields, ticket form fields, departments, groups, workspaces).',
    'Freshservice Product MCP — https://{domain}.freshservice.com/mcp. Tools discovered via tools/list, never assumed; REST is the fallback.',
    'JSM via Jira Cloud REST v3 (fields, JQL search) + the project customer endpoint.',
  ], x, 2.6, w, 2.3, 11.5);
  label(s, 'Honest by design', x, 5.0, w);
  tag(s, 'REAL API', x, 5.3, 1.1, C.greenBg, C.green);
  tag(s, 'MOCK DATA', x + 1.25, 5.3, 1.2, C.amberBg, C.amber);
  s.addText('The UI never passes simulated data off as real. Credentials stay server-side.', { x, y: 5.7, w, h: 0.7, fontSize: 11, color: C.gray, margin: 0, valign: 'top' });
  s.addNotes('Discovery is the first thing the agent does. Per the Freshworks hackathon cookbook we support both the Freshservice REST API v2 and the Freshservice Product MCP; MCP tool names are discovered at runtime. In this demo both systems are simulated, and the UI says MOCK DATA.');
}

/* ================= 5 — Map ================= */
{
  const s = light();
  head(s, 'Tool 3 · Map', 'Mappings with confidence, transformations — and no guessing', 'Rules first, Claude second, a human for anything uncertain.');
  shot(s, 'mapping-tickets.png', G.L, 2.25, 7.5, 4.5, { align: 'left' });
  const x = 8.55; const w = 4.08;
  label(s, 'How a field gets mapped', x, 2.3, w);
  const ladder = [['1', 'Exact name', 'description → description'], ['2', 'JSM → Freshservice vendor rules', 'summary → subject'], ['3', 'Semantic match', 'office → location'], ['4', 'Claude', 'fields the rules cannot place']];
  ladder.forEach(([n, t, e], i) => {
    const y = 2.62 + i * 0.52;
    stepNo(s, n, x, y, 0.3);
    s.addText([{ text: t, options: { bold: true, color: C.ink } }, { text: '   ' + e, options: { color: C.gray } }], { x: x + 0.42, y: y + 0.02, w: w - 0.42, h: 0.28, fontSize: 11, margin: 0, fit: 'shrink' });
  });
  label(s, 'Confidence', x, 4.8, w);
  tag(s, 'HIGH ≥ 90%', x, 5.08, 1.2, C.greenBg, C.green);
  tag(s, 'MEDIUM ≥ 75%', x + 1.3, 5.08, 1.3, C.amberBg, C.amber);
  tag(s, 'LOW → CONFIRM', x + 2.7, 5.08, 1.38, C.redBg, C.red);
  s.addText('Transformations: transformPriority() (Highest → 4 Urgent), transformStatus(), requester and department lookups, Workspace Classification. Unmapped fields stay unmapped.', { x, y: 5.5, w, h: 1.0, fontSize: 10.5, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  s.addNotes('Generate mapping reads both schemas. Exact names, then known JSM-to-Freshservice rules, then semantic similarity, then Claude for the leftovers. Low confidence blocks the run until a human confirms. Freshservice priority is 1 Low to 4 Urgent, so JSM Highest becomes 4.');
}

/* ================= 6 — Migrate ================= */
{
  const s = light();
  head(s, 'Tool 4 · Run migration', 'A resumable pipeline, driven by real state', 'Customers first — tickets reference requesters. Every number on screen comes from the record ledger.');
  const stages = ['Plan', 'Pre-check', 'Fetch', 'Transform', 'Look up refs', 'Create / update', 'Validate', 'Reconcile', 'Complete'];
  const w = 1.26; const gap = 0.07;
  stages.forEach((t, i) => {
    const x = G.L + i * (w + gap);
    s.addShape(pptx.ShapeType.chevron, { x, y: 2.3, w, h: 0.55, fill: { color: i === 5 ? C.purple : C.lilac }, line: { color: i === 5 ? C.purple : C.lilacLine, width: 0.7 } });
    s.addText(t, { x: x + 0.18, y: 2.42, w: w - 0.3, h: 0.3, fontSize: 9.5, bold: true, color: i === 5 ? C.white : C.purpleDeep, align: 'center', margin: 0, fit: 'shrink' });
  });
  shot(s, 'run-body.png', G.L, 3.15, 7.3, 3.55, { align: 'left' });
  const x = 8.35; const w2 = 4.28;
  const props = [
    ['Idempotent', 'Source → target ID stored the moment a record is written. Retries update or link — never duplicate.'],
    ['Resumable', 'Each call does one bounded step and persists the run — works on serverless and schedulers.'],
    ['Verified', 'Every written record is read back and checked; reconciliation balances source vs target.'],
    ['Goal-aware', 'Runs can attach to a Goal Planner goal: its blackout windows and success criteria apply.'],
  ];
  props.forEach(([t, d], i) => {
    const y = 3.15 + i * 0.9;
    s.addText(t, { x, y, w: w2, h: 0.25, fontSize: 12, bold: true, color: C.ink, margin: 0 });
    s.addText(d, { x, y: y + 0.28, w: w2, h: 0.55, fontSize: 10.5, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  });
  s.addNotes('Run migration follows the pipeline in the prompt: plan, pre-check, fetch, transform, look up references, create or update, validate, reconcile, complete — per entity. It is idempotent: the second run of the demo created zero records and updated all of them.');
}

/* ================= 7 — Failures ================= */
{
  const s = light();
  head(s, 'Failure handling', 'Nine kinds of failure. Captured, typed, never hidden.', 'From the demo run: what went wrong, and who fixed it.');
  const rows = [
    ['Invalid department', '10', '9', '1', "'Information Technology' → IT; placeholders like 'Dept-42' go to a human"],
    ['Missing requester', '4', '2', '2', 'ID map → search by email → search by name → human'],
    ['Missing required field', '3', '2', '1', 'Subject from description; name from email'],
    ['API failure (5xx)', '3', '2', '1', 'Retried with backoff; a persistent 500 goes to a human'],
    ['Invalid priority', '3', '2', '1', "'P1 - Critical' → Urgent; 'Whenever' needs a decision"],
    ['Duplicate requester', '2', '2', '0', 'Existing requester linked instead of created'],
    ['Rate limit (429)', '2', '2', '0', 'Backed off and retried'],
    ['Invalid workspace', '2', '2', '0', 'Re-routed by Workspace Classification'],
    ['Missing email', '1', '0', '1', 'Admin enters the email, Zen creates the requester'],
  ];
  const hdr = ['Failure type', 'Seen', 'Fixed by Zen', 'Human', 'What Zen does'].map((t) => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.ink }, fontSize: 10.5 } }));
  const body = rows.map((r, i) => r.map((t, j) => ({ text: t, options: { fontSize: 10.5, color: j === 2 ? C.green : j === 3 && t !== '0' ? C.red : C.inkSoft, bold: j === 0 || j === 2, fill: { color: i % 2 ? C.wash : C.white }, align: j >= 1 && j <= 3 ? 'center' : 'left' } })));
  s.addTable([hdr].concat(body), { x: G.L, y: 2.2, w: G.W, colW: [2.4, 0.8, 1.2, 0.9, 6.63], rowH: 0.38, border: { type: 'solid', color: C.hair, pt: 0.6 }, margin: [0.04, 0.1, 0.04, 0.1] });
  s.addText('Totals in the demo: 30 failures across 29 records — 23 fixed automatically, 7 decided by a human, 0 left open.', { x: G.L, y: 6.2, w: G.W, h: 0.35, fontSize: 12.5, bold: true, color: C.purpleDeep, margin: 0 });
  s.addNotes('Every failure has a type, a severity and a remediation log: what failed, why, what Zen tried, and whether it worked. A fix only counts once Freshservice accepted the record.');
}

/* ================= 8 — Human in the loop ================= */
{
  const s = light();
  head(s, 'Human in the loop', 'AI handles routine work. Humans handle exceptions.', 'When a safe fix isn’t possible, Zen stops at a review gate and shows its working.');
  shot(s, 'review-card.png', G.L, 2.3, G.W, 2.6);
  const cols = [
    ['What failed and why', 'The problem in plain language, with the failure type and severity.'],
    ['What Zen tried', 'Every lookup and fix it attempted — ID map, email search, name search, normalisation.'],
    ['What to do', 'A recommendation the admin can approve, skip, or stop the migration on.'],
  ];
  const w = 3.83; const gap = 0.22;
  cols.forEach(([t, d], i) => {
    const x = G.L + i * (w + gap);
    card(s, x, 5.2, w, 1.5, C.wash);
    s.addText(t, { x: x + 0.22, y: 5.35, w: w - 0.44, h: 0.3, fontSize: 13, bold: true, color: C.ink, margin: 0 });
    s.addText(d, { x: x + 0.22, y: 5.72, w: w - 0.44, h: 0.85, fontSize: 11, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  });
  s.addNotes('The migration never silently continues past a critical failure. Customers are reviewed before tickets start, because tickets need their requesters. Decisions are remembered, so a re-run does not ask again. A name match alone is never applied automatically — Zen recommends it and a human confirms.');
}

/* ================= 9 — Insights ================= */
{
  const s = light();
  head(s, 'Tool 5 · Claude insights', 'Claude explains the migration — from facts, not guesses', 'Zen computes the numbers from the ledger; Claude writes what went well, what went wrong and what to do next.');
  shot(s, 'insights.png', G.L, 2.2, 7.9, 4.6, { align: 'left' });
  const x = 8.95; const w = 3.68;
  label(s, 'Built for trust', x, 2.3, w);
  bullets(s, [
    'Structured output (JSON schema) — Summary, went well, went wrong, how Zen fixed it, needs a human, recommendations.',
    'Claude is told to use only the facts it is given; every count comes from Zen.',
    'No credentials, no emails or names in the prompt — record IDs only.',
    'Without Claude, a rule-based summary is shown and labelled as such.',
  ], x, 2.6, w, 3.6, 11.5);
  s.addNotes('Insights use Claude with a JSON-schema response. The facts sent to Claude are counts, failure categories, remediation outcomes, mappings and reconciliation — no credentials and no personal data. In the demo the label reads Generated by Claude.');
}

/* ================= 10 — Results ================= */
{
  const s = light();
  head(s, 'Demo results', 'One run, end to end — every record accounted for', 'Simulated JSM + Freshservice tenant with controlled failures built in. Numbers are from the actual run shown in the demo.');
  const stats = [
    ['299', 'records migrated', '59 customers + 240 tickets'],
    ['270', 'clean on the first pass', 'no failure at all'],
    ['22', 'fixed by Zen', 'accepted by Freshservice'],
    ['7', 'decided by a human', 'at two review gates'],
    ['0', 'duplicates', '2 existing requesters linked'],
  ];
  const w = 2.25; const gap = 0.17;
  stats.forEach(([n, t, d], i) => {
    const x = G.L + i * (w + gap);
    card(s, x, 2.35, w, 2.1, i === 4 ? C.greenBg : C.wash, i === 4 ? C.greenLine : C.hair);
    s.addText(n, { x: x + 0.25, y: 2.55, w: w - 0.5, h: 0.8, fontSize: 40, bold: true, color: i === 4 ? C.green : C.purple, margin: 0 });
    s.addText(t, { x: x + 0.25, y: 3.4, w: w - 0.5, h: 0.3, fontSize: 13, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
    s.addText(d, { x: x + 0.25, y: 3.75, w: w - 0.5, h: 0.5, fontSize: 10.5, color: C.gray, margin: 0, valign: 'top', fit: 'shrink' });
  });
  card(s, G.L, 4.75, G.W, 1.55, C.lilac, C.lilacLine);
  label(s, 'Then we ran it again', G.L + 0.3, 4.95, 4);
  s.addText([
    { text: '0 created · 297 updated · 2 still linked', options: { bold: true, color: C.ink, fontSize: 20 } },
    { text: '   and no questions asked — Zen remembered every human decision.', options: { color: C.gray, fontSize: 13 } },
  ], { x: G.L + 0.3, y: 5.3, w: G.W - 0.6, h: 0.6, margin: 0, fit: 'shrink' });
  s.addText('Reconciliation: customers 59 / 59 · tickets 240 / 240 · every record read back from the target.', { x: G.L, y: 6.45, w: G.W, h: 0.3, fontSize: 11, color: C.grayLight, margin: 0 });
  s.addNotes('These are the real numbers from the demo run on the simulated tenant — not projections. The second run proves idempotency: nothing was created twice.');
}

/* ================= 11 — Architecture ================= */
{
  const s = light();
  head(s, 'Architecture', 'Vendor-neutral core, pluggable adapters', 'The engine only sees normalised entities; JSM and Freshservice details live in adapters.');
  const box = (x, y, w, h, title, lines, fill = C.white, line = C.hair, titleColor = C.ink) => {
    card(s, x, y, w, h, fill, line);
    s.addText(title, { x: x + 0.22, y: y + 0.18, w: w - 0.44, h: 0.3, fontSize: 13, bold: true, color: titleColor, margin: 0 });
    bullets(s, lines, x + 0.22, y + 0.6, w - 0.44, h - 0.75, 10.5);
  };
  box(G.L, 2.35, 3.2, 2.7, 'SourceAdapter · JSM', ['Jira Cloud REST v3: fields, JQL search', 'JSM project customers (config)', 'Demo tenant when not configured']);
  box(4.35, 2.35, 4.6, 2.7, 'Zen migration engine', ['Normalised entities (customer, ticket, requester)', 'Mapping + transformations', 'Remediation + human review gate', 'Idempotent source → target ID map', 'Validate + reconcile'], C.lilac, C.lilacLine, C.purpleDeep);
  box(9.43, 2.35, 3.2, 2.7, 'TargetAdapter · Freshservice', ['Product MCP (tools/list) for reads', 'REST API v2 for writes + fallback', 'Live writes need an explicit switch']);
  s.addShape(pptx.ShapeType.rightArrow, { x: 3.95, y: 3.5, w: 0.35, h: 0.35, fill: { color: C.lilacLine }, line: { color: C.lilacLine } });
  s.addShape(pptx.ShapeType.rightArrow, { x: 9.0, y: 3.5, w: 0.35, h: 0.35, fill: { color: C.lilacLine }, line: { color: C.lilacLine } });
  box(4.35, 5.3, 4.6, 1.45, 'Claude (claude-opus-5)', ['Field mapping for what rules can’t place · department matching · migration insights'], C.wash);
  box(G.L, 5.3, 3.2, 1.45, 'Security', ['Credentials server-side only (env / secrets)', 'No PII or keys in Claude prompts'], C.wash);
  box(9.43, 5.3, 3.2, 1.45, 'Runs on', ['Firebase Hosting + Functions v2', 'React + Freshworks Dew UI'], C.wash);
  s.addNotes('SourceAdapter and TargetAdapter isolate the vendors. Adding another source — ServiceNow, Zendesk — means another adapter; the engine does not change.');
}

/* ================= 12 — Status & next ================= */
{
  const s = light();
  head(s, 'Where it stands', 'Working today, and what comes next', null);
  const colW = 5.8;
  card(s, G.L, 1.9, colW, 4.8, C.greenBg, C.greenLine);
  label(s, 'Working and tested', G.L + 0.3, 2.1, 5, C.green);
  bullets(s, [
    'All five tools, end to end in the UI and over the API',
    'Customers → Requesters and Tickets → Tickets',
    'Nine failure types with remediation and review',
    'Idempotent re-runs, validation and reconciliation',
    'Claude mapping suggestions and insights (live Claude calls)',
    '78 automated backend tests',
  ], G.L + 0.3, 2.45, colW - 0.6, 4.0, 12.5);
  const x2 = G.L + colW + 0.33;
  card(s, x2, 1.9, colW, 4.8, C.wash);
  label(s, 'Next', x2 + 0.3, 2.1, 5);
  bullets(s, [
    'Connect a Freshservice sandbox (REST v2) and verify live writes',
    'Turn on Freshservice Product MCP for discovery on a real tenant',
    'Confirm the JSM project-customer endpoint for live customer reads',
    'More entities: attachments, knowledge articles, assets',
    'Run large migrations as scheduled waves from the Goal Planner',
  ], x2 + 0.3, 2.45, colW - 0.6, 4.0, 12.5);
  s.addNotes('Be clear with judges: the demo runs on a simulated JSM and Freshservice tenant. The live REST and MCP paths are implemented but have not been exercised against a real tenant yet — that is the next step.');
}

/* ================= 13 — Close ================= */
{
  const s = bare();
  s.background = { color: C.ink };
  s.addShape(pptx.ShapeType.arc, { x: G.L, y: 2.05, w: 0.7, h: 0.7, adjustPoint: 0.22, rotate: 20, fill: { color: C.ink, transparency: 100 }, line: { color: C.purple, width: 6 } });
  s.addText('Zen does the migration.\nYou make the decisions that matter.', { x: G.L, y: 3.0, w: 10, h: 1.6, fontSize: 36, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addText('Discover  →  Map  →  Migrate  →  Review  →  Explain', { x: G.L, y: 4.85, w: 10, h: 0.4, fontSize: 15, color: 'C9B8E8', margin: 0 });
  s.addText('Live demo: /agent', { x: G.L, y: 5.6, w: 6, h: 0.3, fontSize: 12, color: '9C95A3', margin: 0 });
  s.addNotes('Close with the live demo on /agent: discover, generate mappings, run, approve the review items, show insights, then re-run to show zero duplicates.');
}

const out = path.join(__dirname, '..', 'Zen-Migration-Agent-Deck.pptx');
pptx.writeFile({ fileName: out }).then((f) => console.log('wrote', f));
