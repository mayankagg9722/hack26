const pptxgen = require('pptxgenjs');
const path = require('path');

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Zen';
pptx.company = 'Zen';
pptx.subject = 'AI onboarding agent for B2B SaaS';
pptx.title = 'Zen — Your customer is stuck. Zen can see why.';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };

/* ---------------- design tokens ---------------- */
const C = {
  purple: '9400FF',
  purpleDeep: '7000C4',
  lilac: 'F4E9FE',
  lilacLine: 'DDBFF7',
  ink: '141019',
  inkSoft: '2A2430',
  gray: '655F6D',
  grayLight: '95909C',
  hair: 'E6E2EA',
  wash: 'FAF9FB',
  white: 'FFFFFF',
  green: '11824A',
  greenBg: 'E9F7EF',
  greenLine: 'B4E2C8',
  red: 'CE3F3F',
  redBg: 'FDF3F3',
  redLine: 'F0C9C9'
};

const G = { L: 0.7, R: 12.63, W: 11.93, BODY: 2.18, FLOOR: 6.92 };
const RATIO = 1.5; // all product screenshots are 3:2
const img = (n) => path.join(__dirname, 'devpost', n);

pptx.defineSlideMaster({
  title: 'ZEN',
  background: { color: C.white },
  objects: [
    { text: { text: 'ZEN', options: { x: G.L, y: 0.2, w: 0.6, h: 0.16, fontSize: 7.5, bold: true, color: C.purple, charSpacing: 2.2, margin: 0 } } },
    { text: { text: 'AI ONBOARDING AGENT', options: { x: 1.28, y: 0.2, w: 2.2, h: 0.16, fontSize: 7.5, color: C.grayLight, charSpacing: 1.1, margin: 0 } } },
    { line: { x: G.L, y: 0.46, w: G.W, h: 0, line: { color: C.hair, width: 0.7 } } },
    { line: { x: G.L, y: 7.08, w: G.W, h: 0, line: { color: C.hair, width: 0.7 } } },
    { text: { text: 'ZEN  /  2026', options: { x: G.L, y: 7.2, w: 1.4, h: 0.16, fontSize: 7, color: C.grayLight, margin: 0 } } }
  ],
  slideNumber: { x: 12.2, y: 7.2, w: 0.43, h: 0.16, align: 'right', color: C.grayLight, fontSize: 7 }
});

/* ---------------- helpers ---------------- */
const light = () => pptx.addSlide('ZEN');
const bare = () => pptx.addSlide();

function head(s, eyebrow, headline, sub) {
  s.addText(eyebrow.toUpperCase(), { x: G.L, y: 0.72, w: 6, h: 0.2, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.6, margin: 0 });
  s.addText(headline, { x: G.L, y: 1.0, w: G.W, h: 0.6, fontSize: 28, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  if (sub) s.addText(sub, { x: G.L, y: 1.66, w: 10.4, h: 0.32, fontSize: 12.5, color: C.gray, margin: 0, fit: 'shrink' });
}

// Preserves the 3:2 source ratio so screenshots never distort.
function shot(s, name, x, y, w) {
  const h = w / RATIO;
  s.addShape(pptx.ShapeType.roundRect, {
    x: x - 0.035, y: y - 0.035, w: w + 0.07, h: h + 0.07, rectRadius: 0.09,
    fill: { color: C.white }, line: { color: C.hair, width: 1 },
    shadow: { type: 'outer', color: 'A9A1B0', opacity: 0.22, blur: 2, angle: 45, distance: 1.4 }
  });
  s.addImage({ path: img(name), x, y, w, h });
  return h;
}

function card(s, x, y, w, h, fill = C.white, line = C.hair) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.09, fill: { color: fill }, line: { color: line, width: 0.9 } });
}

function tag(s, text, x, y, w, fill = C.lilac, color = C.purple) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.27, rectRadius: 0.135, fill: { color: fill }, line: { color: fill } });
  s.addText(text, { x: x + 0.06, y: y + 0.05, w: w - 0.12, h: 0.13, fontSize: 7.5, bold: true, color, align: 'center', charSpacing: 0.75, margin: 0, fit: 'shrink' });
}

function arrow(s, x, y) {
  s.addShape(pptx.ShapeType.chevron, { x, y, w: 0.28, h: 0.52, fill: { color: C.lilacLine }, line: { color: C.lilacLine } });
}

function stepNo(s, n, x, y, d = 0.34) {
  s.addShape(pptx.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: C.purple }, line: { color: C.purple } });
  s.addText(String(n), { x, y: y + d * 0.22, w: d, h: 0.13, fontSize: 8, bold: true, color: C.white, align: 'center', margin: 0 });
}

/* ================= 1 — Title ================= */
{
  const s = bare();
  s.background = { color: 'FBFAFC' };
  s.addShape(pptx.ShapeType.ellipse, { x: 10.64, y: -1.25, w: 4.2, h: 4.2, fill: { color: C.lilac, transparency: 30 }, line: { color: C.lilac, transparency: 100 } });

  s.addShape(pptx.ShapeType.arc, { x: 0.66, y: 0.56, w: 0.48, h: 0.48, adjustPoint: 0.22, rotate: 20, fill: { color: 'FBFAFC', transparency: 100 }, line: { color: C.purple, width: 4.5 } });
  s.addText('ZEN', { x: 1.25, y: 0.69, w: 0.9, h: 0.28, fontSize: 14, bold: true, color: C.ink, charSpacing: 2.5, margin: 0 });

  s.addText('ZEN  |  AI-NATIVE ENTERPRISE', { x: G.L, y: 1.42, w: 4.95, h: 0.22, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.55, margin: 0 });
  s.addText('Your customer is stuck.\nZen can see why.', { x: G.L, y: 1.89, w: 5.35, h: 1.65, fontSize: 35, bold: true, color: C.ink, breakLine: false, margin: 0, fit: 'shrink' });
  s.addText('An AI onboarding agent that sees the customer’s screen, guides every step, and brings in a human only when it matters.', { x: 0.72, y: 3.82, w: 4.92, h: 1.0, fontSize: 14.5, color: C.gray, breakLine: false, margin: 0, fit: 'shrink' });

  s.addShape(pptx.ShapeType.roundRect, { x: 6.18, y: 1.05, w: 6.62, h: 4.9, rectRadius: 0.12, fill: { color: C.white }, line: { color: 'E1DCE5', width: 1 }, shadow: { type: 'outer', color: 'AFA7B5', opacity: 0.25, blur: 2, angle: 45, distance: 1.5 } });
  s.addImage({ path: img('04-live-session-spotlight.png'), x: 6.28, y: 1.15, w: 6.42, h: 4.28 });
  s.addShape(pptx.ShapeType.roundRect, { x: 7.46, y: 5.12, w: 3.42, h: 0.62, rectRadius: 0.08, fill: { color: C.ink }, line: { color: C.ink }, shadow: { type: 'outer', color: '5A5160', opacity: 0.3, blur: 1.5, angle: 45, distance: 1 } });
  s.addText('Zen sees the active screen and points to the next action.', { x: 7.7, y: 5.3, w: 2.95, h: 0.2, fontSize: 9.5, bold: true, color: C.white, align: 'center', margin: 0, fit: 'shrink' });

  const sep = { text: '     →     ', options: { color: 'ADA7B4', bold: false } };
  s.addText([
    { text: 'SEE', options: { color: C.purple, bold: true } }, sep,
    { text: 'UNDERSTAND', options: { color: C.ink, bold: true } }, sep,
    { text: 'GUIDE', options: { color: C.purple, bold: true } }, sep,
    { text: 'ESCALATE', options: { color: C.ink, bold: true } }
  ], { x: G.L, y: 5.68, w: 5.35, h: 0.2, fontSize: 8.5, charSpacing: 0.9, margin: 0, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: G.L, y: 6.05, w: 4.8, h: 0, line: { color: 'DED9E2', width: 0.8 } });
  s.addText('AI ONBOARDING FOR B2B SAAS', { x: G.L, y: 6.39, w: 2.75, h: 0.18, fontSize: 8.2, bold: true, color: '8D8791', charSpacing: 1.2, margin: 0 });
}

/* ================= 2 — Problem ================= */
{
  const s = light();
  head(s, 'The problem', 'Onboarding still scales with headcount.', 'Every new customer adds scheduling, repetition and avoidable delay.');

  const items = [
    ['5 days', 'Waiting for a slot', 'The customer is ready Monday.\nThe specialist is free Friday.', C.purple],
    ['40×', 'The same walkthrough', 'Your best CSM repeats one\nsetup call over and over.', C.purple],
    ['1 step', 'Silent drop-off', 'One confusing screen and the\ncustomer quietly disappears.', C.red]
  ];
  items.forEach((it, i) => {
    const x = G.L + i * 4.05;
    const last = i === 2;
    card(s, x, 2.35, 3.66, 2.95, last ? C.redBg : C.white, last ? C.redLine : C.hair);
    s.addText(it[0], { x: x + 0.32, y: 2.72, w: 2.9, h: 0.72, fontSize: 40, bold: true, color: it[3], margin: 0, fit: 'shrink' });
    s.addText(it[1], { x: x + 0.32, y: 3.62, w: 3.0, h: 0.3, fontSize: 15, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
    s.addShape(pptx.ShapeType.line, { x: x + 0.32, y: 4.06, w: 0.62, h: 0, line: { color: last ? C.redLine : C.lilacLine, width: 2 } });
    s.addText(it[2], { x: x + 0.32, y: 4.3, w: 3.0, h: 0.85, fontSize: 12, color: C.gray, breakLine: false, margin: 0, fit: 'shrink' });
  });

  s.addText('The bottleneck is not knowledge. It is context, timing and availability.', { x: G.L, y: 6.2, w: G.W, h: 0.34, fontSize: 15, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
}

/* ================= 3 — Core insight (dark) ================= */
{
  const s = bare();
  s.background = { color: C.ink };

  s.addText('THE INSIGHT', { x: G.L, y: 1.5, w: 4, h: 0.2, fontSize: 8.5, bold: true, color: 'C79BF0', charSpacing: 1.6, margin: 0 });
  s.addText('A chatbot answers questions.', { x: G.L, y: 2.05, w: 11.4, h: 0.95, fontSize: 40, bold: true, color: '7C7484', margin: 0, fit: 'shrink' });
  s.addText('Zen sees the work.', { x: G.L, y: 3.05, w: 11.4, h: 0.95, fontSize: 40, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: G.L, y: 4.32, w: 1.9, h: 0, line: { color: C.purple, width: 3 } });
  s.addText('It reads the live screen, knows which step the customer is on, and acts on what it sees — not on what it was asked.', { x: G.L, y: 4.66, w: 8.4, h: 0.8, fontSize: 15, color: 'B5AFBC', breakLine: false, margin: 0, fit: 'shrink' });
}

/* ================= 4 — How it works ================= */
{
  const s = light();
  head(s, 'How it works', 'See. Understand. Guide. Escalate.', 'One loop that runs on every session, adapted to each customer.');

  const steps = [
    ['See', 'Reads the live screen and the customer’s actual setup.'],
    ['Understand', 'Builds a plan around their goal — no fixed script.'],
    ['Guide', 'Highlights the exact next action and waits.'],
    ['Escalate', 'Hands to a human with full context attached.']
  ];
  steps.forEach((st, i) => {
    const y = 2.3 + i * 1.12;
    const on = i === 0 || i === 2;
    stepNo(s, i + 1, G.L, y + 0.04);
    s.addText(st[0], { x: 1.2, y, w: 1.75, h: 0.3, fontSize: 17, bold: true, color: on ? C.purple : C.ink, margin: 0, fit: 'shrink' });
    s.addText(st[1], { x: 1.2, y: y + 0.36, w: 4.55, h: 0.5, fontSize: 11.5, color: C.gray, breakLine: false, margin: 0, fit: 'shrink' });
    if (i < 3) s.addShape(pptx.ShapeType.line, { x: G.L + 0.17, y: y + 0.42, w: 0, h: 0.68, line: { color: C.hair, width: 1.1, dash: 'dash' } });
  });

  shot(s, '02-how-it-works.png', 6.42, 2.3, 6.21);
}

/* ================= 5 — Example: guidance ================= */
{
  const s = light();
  head(s, 'Example 01', 'Zen points. The customer acts.', 'The instruction appears where the work is happening — not in a help article.');

  shot(s, '04-live-session-spotlight.png', G.L, 2.25, 7.0);

  const rx = 8.18;
  tag(s, 'IN THE MOMENT', rx, 2.3, 1.45);
  s.addText('Customer goal', { x: rx, y: 2.85, w: 3.5, h: 0.22, fontSize: 10.5, bold: true, color: C.grayLight, margin: 0 });
  s.addText('Connect the accounting system', { x: rx, y: 3.14, w: 4.3, h: 0.72, fontSize: 22, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  s.addText('Zen finds the right integration, spotlights the real button, and waits until it is done.', { x: rx, y: 4.0, w: 4.25, h: 0.8, fontSize: 12.5, color: C.gray, breakLine: false, margin: 0, fit: 'shrink' });

  s.addShape(pptx.ShapeType.line, { x: rx, y: 5.0, w: 4.25, h: 0, line: { color: C.hair, width: 0.9 } });
  [['1', 'clear next step'], ['0', 'tabs to search']].forEach((m, i) => {
    const x = rx + i * 2.2;
    s.addText(m[0], { x, y: 5.24, w: 2.0, h: 0.52, fontSize: 30, bold: true, color: C.purple, margin: 0, fit: 'shrink' });
    s.addText(m[1], { x, y: 5.82, w: 2.05, h: 0.24, fontSize: 10.5, color: C.gray, margin: 0, fit: 'shrink' });
  });
  s.addText('Context turns documentation into action.', { x: rx, y: 6.42, w: 4.3, h: 0.28, fontSize: 13, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
}

/* ================= 6 — Example: course correction ================= */
{
  const s = light();
  head(s, 'Example 02', 'Zen catches the costly “small” mistake.', 'Understanding the setup — not just answering the question.');

  shot(s, '06-mapping-gst.png', G.L, 2.25, 7.0);

  const rx = 8.18;
  card(s, rx, 2.28, 4.3, 1.62, C.redBg, C.redLine);
  s.addText('DEFAULT', { x: rx + 0.3, y: 2.56, w: 1.4, h: 0.18, fontSize: 8, bold: true, color: C.red, charSpacing: 1.2, margin: 0 });
  s.addText('GST 10%', { x: rx + 0.3, y: 2.86, w: 3.0, h: 0.5, fontSize: 26, bold: true, color: C.red, margin: 0, fit: 'shrink' });
  s.addText('Wrong for a health provider', { x: rx + 0.3, y: 3.44, w: 3.5, h: 0.22, fontSize: 11, color: C.gray, margin: 0, fit: 'shrink' });

  s.addShape(pptx.ShapeType.downArrow, { x: rx + 1.94, y: 4.06, w: 0.42, h: 0.56, fill: { color: C.purple }, line: { color: C.purple } });

  card(s, rx, 4.8, 4.3, 1.62, C.greenBg, C.greenLine);
  s.addText('ZEN CORRECTS', { x: rx + 0.3, y: 5.08, w: 1.9, h: 0.18, fontSize: 8, bold: true, color: C.green, charSpacing: 1.2, margin: 0 });
  s.addText('GST-FREE', { x: rx + 0.3, y: 5.38, w: 3.0, h: 0.5, fontSize: 26, bold: true, color: C.green, margin: 0, fit: 'shrink' });
  s.addText('Correct for this customer', { x: rx + 0.3, y: 5.96, w: 3.5, h: 0.22, fontSize: 11, color: C.gray, margin: 0, fit: 'shrink' });

  s.addText('Prevents rework  •  Protects trust  •  Speeds go-live', { x: rx, y: 6.6, w: 4.3, h: 0.24, fontSize: 10.5, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
}

/* ================= 7 — Where we start ================= */
{
  const s = light();
  head(s, 'Where we start', 'Healthcare operations SaaS.', 'Begin where setup is complex, regulated and repeated across many sites.');

  card(s, G.L, 2.3, 4.15, 4.4, C.ink, C.ink);
  tag(s, 'IDEAL CUSTOMER', 1.0, 2.62, 1.5, '332C3B', 'D3ADF5');
  s.addText('Vertical SaaS serving multi-site clinics.', { x: 1.0, y: 3.18, w: 3.5, h: 1.05, fontSize: 25, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addText('Practice management  •  Billing\nPatient engagement  •  Workforce', { x: 1.0, y: 4.42, w: 3.45, h: 0.6, fontSize: 11.5, color: 'ADA6B5', breakLine: false, margin: 0, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: 1.0, y: 5.2, w: 1.5, h: 0, line: { color: C.purple, width: 2.5 } });
  s.addText('High configuration, thin CS capacity, costly setup errors.', { x: 1.0, y: 5.46, w: 3.4, h: 0.7, fontSize: 13, bold: true, color: C.white, breakLine: false, margin: 0, fit: 'shrink' });

  s.addText('ONE CUSTOMER, ONE TAILORED PLAYBOOK', { x: 5.4, y: 2.34, w: 4.5, h: 0.2, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.3, margin: 0 });
  const play = [
    ['Import practitioners', 'Roles, locations, provider IDs'],
    ['Connect systems', 'Calendar, accounting, payments'],
    ['Apply clinic policy', 'Tax rules, permissions, workflows'],
    ['Train each role', 'Front desk, clinicians, admins']
  ];
  play.forEach((p, i) => {
    const y = 2.82 + i * 0.92;
    stepNo(s, i + 1, 5.42, y);
    s.addText(p[0], { x: 5.98, y: y + 0.01, w: 2.55, h: 0.24, fontSize: 13.5, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
    s.addText(p[1], { x: 8.6, y: y + 0.03, w: 4.0, h: 0.22, fontSize: 11, color: C.gray, margin: 0, fit: 'shrink' });
    if (i < 3) s.addShape(pptx.ShapeType.line, { x: 5.59, y: y + 0.4, w: 0, h: 0.5, line: { color: C.hair, width: 1.1, dash: 'dash' } });
  });

  card(s, 5.4, 6.28, 7.23, 0.42, C.lilac, C.lilacLine);
  s.addText('Customization layer  →  customer policies  ·  role-based flows  ·  approved terminology', { x: 5.55, y: 6.4, w: 6.93, h: 0.18, fontSize: 9.5, bold: true, color: C.purpleDeep, align: 'center', margin: 0, fit: 'shrink' });
}

/* ================= 8 — Fits the stack ================= */
{
  const s = light();
  head(s, 'Integration', 'Embed once. Connect what they already run.', 'Zen orchestrates across systems — it does not replace the system of record.');

  card(s, G.L, 2.32, 3.05, 3.85, C.wash);
  s.addText('YOUR PRODUCT', { x: 0.9, y: 2.62, w: 2.65, h: 0.18, fontSize: 8.5, bold: true, color: C.grayLight, charSpacing: 1.2, align: 'center', margin: 0 });
  card(s, 1.12, 3.1, 2.2, 1.15);
  s.addText('</>', { x: 1.12, y: 3.36, w: 2.2, h: 0.3, fontSize: 19, bold: true, color: C.purple, align: 'center', margin: 0 });
  s.addText('Web or mobile app', { x: 1.12, y: 3.82, w: 2.2, h: 0.2, fontSize: 10.5, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
  tag(s, 'ONE-LINE SDK', 1.3, 4.6, 1.85, C.ink, C.white);
  s.addText('or secure session link', { x: 0.9, y: 5.12, w: 2.65, h: 0.22, fontSize: 9.5, color: C.gray, align: 'center', margin: 0, fit: 'shrink' });

  arrow(s, 3.95, 3.95);

  card(s, 4.62, 2.32, 3.1, 3.85, C.lilac, C.lilacLine);
  s.addText('ZEN ORCHESTRATION', { x: 4.8, y: 2.62, w: 2.74, h: 0.18, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.2, align: 'center', margin: 0 });
  ['Session + screen context', 'Customer playbook', 'Tool calls + policy checks', 'Human escalation'].forEach((v, i) => {
    const y = 3.06 + i * 0.68;
    card(s, 4.9, y, 2.54, 0.5, C.white, C.lilacLine);
    s.addText(v, { x: 4.98, y: y + 0.17, w: 2.38, h: 0.16, fontSize: 9.5, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
  });

  arrow(s, 7.95, 3.95);

  card(s, 8.62, 2.32, 4.01, 3.85);
  s.addText('SYSTEMS ALREADY IN PLACE', { x: 8.8, y: 2.62, w: 3.65, h: 0.18, fontSize: 8.5, bold: true, color: C.grayLight, charSpacing: 1.1, align: 'center', margin: 0 });
  const sys = [
    ['IDENTITY', 'Okta  ·  Entra ID  ·  WorkOS'],
    ['KNOWLEDGE', 'SharePoint  ·  Confluence  ·  Zendesk'],
    ['CUSTOMER', 'Salesforce  ·  HubSpot  ·  Gainsight'],
    ['WORK', 'Teams  ·  Slack  ·  Jira'],
    ['DATA', 'Segment  ·  Snowflake  ·  Power BI']
  ];
  sys.forEach((d, i) => {
    const y = 3.1 + i * 0.6;
    s.addText(d[0], { x: 8.86, y: y + 0.02, w: 0.85, h: 0.15, fontSize: 7.5, bold: true, color: C.purple, margin: 0, fit: 'shrink' });
    s.addText(d[1], { x: 9.78, y, w: 2.7, h: 0.2, fontSize: 9.5, color: C.ink, margin: 0, fit: 'shrink' });
    if (i < 4) s.addShape(pptx.ShapeType.line, { x: 8.86, y: y + 0.37, w: 3.55, h: 0, line: { color: C.hair, width: 0.7 } });
  });

  s.addText('Salesforce opens the session  →  Zen guides the setup  →  an unresolved issue becomes a Zendesk ticket with transcript  →  the outcome lands in Gainsight.', { x: G.L, y: 6.48, w: G.W, h: 0.3, fontSize: 11, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
}

/* ================= 9 — Enterprise ready ================= */
{
  const s = light();
  head(s, 'Enterprise ready', 'A control plane around the agent.', 'Observable, governable and safe to put in front of customers.');

  const cols = [
    ['CUSTOMER', ['Embedded widget', 'Voice or text', 'Screen share']],
    ['ZEN AGENT', ['Goal planner', 'Screen context', 'Policy guardrails']],
    ['KNOWLEDGE', ['Product docs', 'Approved answers', 'Session memory']],
    ['ENTERPRISE', ['CRM + support', 'Slack / Teams', 'Analytics + data']]
  ];
  cols.forEach((c, i) => {
    const x = G.L + i * 3.06;
    const on = i === 1;
    card(s, x, 2.35, 2.72, 2.92, on ? C.lilac : C.wash, on ? C.lilacLine : C.hair);
    s.addText(c[0], { x: x + 0.16, y: 2.64, w: 2.4, h: 0.18, fontSize: 8.5, bold: true, color: on ? C.purple : C.grayLight, charSpacing: 1.2, align: 'center', margin: 0 });
    c[1].forEach((it, j) => {
      const y = 3.06 + j * 0.72;
      card(s, x + 0.18, y, 2.36, 0.5, C.white, on ? C.lilacLine : C.hair);
      s.addText(it, { x: x + 0.26, y: y + 0.17, w: 2.2, h: 0.16, fontSize: 10, bold: on, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
    });
    if (i < 3) arrow(s, x + 2.86, 3.75);
  });

  s.addText('CONTROL LAYER', { x: G.L, y: 6.06, w: 1.6, h: 0.18, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.2, margin: 0 });
  ['IDENTITY & RBAC', 'AUDIT TRAIL', 'DATA BOUNDARIES', 'HUMAN APPROVAL', 'EVALUATION'].forEach((v, i) => {
    tag(s, v, 2.36 + i * 2.07, 6.0, 1.86, i === 3 ? C.purple : C.ink, C.white);
  });
  s.addText('Architecture is the production target. The hackathon submission is a working frontend prototype.', { x: G.L, y: 6.62, w: G.W, h: 0.22, fontSize: 8.5, italic: true, color: C.gray, align: 'center', margin: 0 });
}

/* ================= 10 — What the team keeps ================= */
{
  const s = light();
  head(s, 'For the business', 'Automate the work. Keep the visibility.', 'Zen runs the sessions. Customer Success still owns the portfolio.');

  shot(s, '08-admin-hub.png', G.L, 2.25, 7.0);

  const rx = 8.18;
  [['91%', 'self-serve rate'], ['2.4 days', 'to first value'], ['4', 'human escalations']].forEach((o, i) => {
    const y = 2.3 + i * 1.42;
    card(s, rx, y, 4.3, 1.16, i === 0 ? C.lilac : C.white, i === 0 ? C.lilacLine : C.hair);
    s.addText(o[0], { x: rx + 0.28, y: y + 0.2, w: 1.72, h: 0.44, fontSize: 24, bold: true, color: C.purple, margin: 0, fit: 'shrink' });
    s.addText(o[1], { x: rx + 0.28, y: y + 0.7, w: 2.6, h: 0.24, fontSize: 11.5, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  });
  s.addText('Illustrative prototype metrics.', { x: rx, y: 6.62, w: 4.3, h: 0.2, fontSize: 8.5, italic: true, color: C.grayLight, align: 'center', margin: 0 });
}

/* ================= 11 — Close (dark) ================= */
{
  const s = bare();
  s.background = { color: C.ink };
  s.addShape(pptx.ShapeType.ellipse, { x: 9.9, y: -1.9, w: 5.6, h: 5.6, fill: { color: C.purple, transparency: 90 }, line: { color: C.purple, transparency: 100 } });

  s.addShape(pptx.ShapeType.arc, { x: 0.72, y: 0.72, w: 0.56, h: 0.56, adjustPoint: 0.22, rotate: 20, fill: { color: C.ink, transparency: 100 }, line: { color: C.purple, width: 5.5 } });
  s.addText('ZEN', { x: 1.42, y: 0.87, w: 1.2, h: 0.32, fontSize: 15, bold: true, color: C.white, charSpacing: 2.5, margin: 0 });

  s.addText('High-touch onboarding.\nEvery customer.\nNo extra headcount.', { x: G.L, y: 2.05, w: 7.1, h: 2.35, fontSize: 38, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addShape(pptx.ShapeType.line, { x: G.L, y: 4.72, w: 1.9, h: 0, line: { color: C.purple, width: 3 } });
  s.addText('Let’s see it live.', { x: G.L, y: 5.02, w: 4.0, h: 0.44, fontSize: 21, bold: true, color: 'C79BF0', margin: 0, fit: 'shrink' });
  s.addText('Landing page  →  Guided session  →  Admin Hub', { x: 0.72, y: 5.62, w: 6.4, h: 0.28, fontSize: 12, color: 'A9A2B1', margin: 0, fit: 'shrink' });

  s.addShape(pptx.ShapeType.roundRect, { x: 8.28, y: 1.5, w: 4.35, h: 2.94, rectRadius: 0.09, fill: { color: C.white }, line: { color: '3B3443', width: 1 } });
  s.addImage({ path: img('07-complete.png'), x: 8.36, y: 1.58, w: 4.19, h: 2.79 });

  card(s, 8.28, 4.68, 4.35, 1.15, '221D29', '3B3443');
  s.addText('5 / 5', { x: 8.6, y: 4.94, w: 1.1, h: 0.4, fontSize: 22, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addText('steps completed', { x: 8.6, y: 5.38, w: 1.6, h: 0.2, fontSize: 9.5, color: 'A9A2B1', margin: 0, fit: 'shrink' });
  s.addText('0', { x: 10.85, y: 4.94, w: 0.6, h: 0.4, fontSize: 22, bold: true, color: 'C79BF0', margin: 0, fit: 'shrink' });
  s.addText('human handoffs', { x: 10.85, y: 5.38, w: 1.6, h: 0.2, fontSize: 9.5, color: 'A9A2B1', margin: 0, fit: 'shrink' });
}

pptx.writeFile({ fileName: path.join(__dirname, 'Zen-Deck.pptx') })
  .then((f) => console.log('Created:', f));
