const pptxgen = require('pptxgenjs');
const path = require('path');

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Zen';
pptx.subject = 'Enterprise AI onboarding agent hackathon pitch';
pptx.title = 'Zen — Enterprise Customer Onboarding, Reimagined';
pptx.company = 'Zen';
pptx.lang = 'en-US';
pptx.theme = {
  headFontFace: 'Aptos Display',
  bodyFontFace: 'Aptos',
  lang: 'en-US'
};
pptx.defineSlideMaster({
  title: 'ZEN_MASTER',
  background: { color: 'FFFFFF' },
  objects: [
    { line: { x: 0.46, y: 0.32, w: 12.4, h: 0, line: { color: 'E8E5EB', width: 0.7 } } },
    { text: { text: 'ZEN', options: { x: 0.48, y: 0.1, w: 0.8, h: 0.18, fontFace: 'Aptos', fontSize: 7.5, bold: true, color: '9400FF', charSpacing: 2.2, margin: 0 } } },
    { text: { text: 'AI CUSTOMER ONBOARDING', options: { x: 1.18, y: 0.1, w: 2, h: 0.18, fontFace: 'Aptos', fontSize: 7.5, color: '8B8790', charSpacing: 1.2, margin: 0 } } },
    { text: { text: 'HACKATHON PROTOTYPE', options: { x: 10.95, y: 0.1, w: 1.9, h: 0.18, fontFace: 'Aptos', fontSize: 7.5, color: '8B8790', align: 'right', charSpacing: 1.2, margin: 0 } } },
    { text: { text: 'ZEN  /  2026', options: { x: 0.48, y: 7.18, w: 1.2, h: 0.16, fontFace: 'Aptos', fontSize: 7, color: 'A09CA6', margin: 0 } } }
  ],
  slideNumber: { x: 12.45, y: 7.16, color: 'A09CA6', fontSize: 7 }
});

const C = {
  purple: '9400FF',
  purple2: '7B00D4',
  lilac: 'F5ECFF',
  ink: '151218',
  gray: '66616B',
  light: 'F7F6F8',
  line: 'E8E5EB',
  green: '138A4A',
  greenBg: 'EAF8F0',
  amber: 'A65D00',
  amberBg: 'FFF4DD',
  red: 'D64545',
  black: '000000',
  white: 'FFFFFF'
};
const img = (name) => path.join(__dirname, 'devpost', name);

function slide() {
  return pptx.addSlide('ZEN_MASTER');
}
function title(s, eyebrow, heading, sub) {
  if (eyebrow) s.addText(eyebrow.toUpperCase(), { x: 0.58, y: 0.63, w: 4.5, h: 0.22, margin: 0, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.8 });
  s.addText(heading, { x: 0.58, y: eyebrow ? 0.94 : 0.68, w: 12.1, h: 0.72, margin: 0, fontSize: 29, bold: true, color: C.ink, breakLine: false, fit: 'shrink' });
  if (sub) s.addText(sub, { x: 0.6, y: eyebrow ? 1.68 : 1.45, w: 10.8, h: 0.38, margin: 0, fontSize: 12.5, color: C.gray, breakLine: false, fit: 'shrink' });
}
function roundRect(s, x, y, w, h, fill = C.white, line = C.line, radius = 0.08) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: radius, fill: { color: fill }, line: { color: line, width: 0.8 } });
}
function pill(s, text, x, y, w, fill = C.lilac, color = C.purple) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.28, rectRadius: 0.14, fill: { color: fill }, line: { color: fill } });
  s.addText(text, { x: x + 0.08, y: y + 0.055, w: w - 0.16, h: 0.12, fontSize: 7.5, bold: true, align: 'center', color, margin: 0, charSpacing: 0.8, fit: 'shrink' });
}
function metric(s, x, y, w, value, label, accent = C.purple) {
  s.addText(value, { x, y, w, h: 0.5, fontSize: 26, bold: true, color: accent, margin: 0, fit: 'shrink' });
  s.addText(label, { x, y: y + 0.52, w, h: 0.3, fontSize: 10.5, color: C.gray, margin: 0, fit: 'shrink' });
}
function imageCard(s, name, x, y, w, h) {
  s.addShape(pptx.ShapeType.roundRect, { x: x - 0.03, y: y - 0.03, w: w + 0.06, h: h + 0.06, rectRadius: 0.07, fill: { color: C.white }, line: { color: C.line, width: 0.9 }, shadow: { type: 'outer', color: 'C9C4CE', opacity: 0.22, blur: 2, angle: 45, distance: 1 } });
  s.addImage({ path: img(name), x, y, w, h });
}
function numberCircle(s, n, x, y) {
  s.addShape(pptx.ShapeType.ellipse, { x, y, w: 0.38, h: 0.38, fill: { color: C.purple }, line: { color: C.purple } });
  s.addText(String(n), { x, y: y + 0.075, w: 0.38, h: 0.14, fontSize: 8.5, bold: true, color: C.white, align: 'center', margin: 0 });
}

// 1 — Cover
{
  const s = pptx.addSlide();
  s.background = { color: 'FBFAFC' };

  // Brand lockup and restrained ambient accent.
  s.addShape(pptx.ShapeType.ellipse, { x: 10.64, y: -1.25, w: 4.2, h: 4.2, fill: { color: 'F3E7FC', transparency: 22 }, line: { color: 'F3E7FC', transparency: 100 } });
  s.addShape(pptx.ShapeType.arc, { x: 0.66, y: 0.56, w: 0.48, h: 0.48, adjustPoint: 0.22, rotate: 20, fill: { color: 'FBFAFC', transparency: 100 }, line: { color: C.purple, width: 4.5 } });
  s.addText('ZEN', { x: 1.25, y: 0.69, w: 0.9, h: 0.28, fontSize: 14, bold: true, color: C.ink, charSpacing: 2.5, margin: 0 });

  s.addText('ZEN  |  AI-NATIVE ENTERPRISE', { x: 0.67, y: 1.42, w: 4.95, h: 0.22, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.55, margin: 0 });
  s.addText('Your customer is stuck.\nZen can see why.', { x: 0.67, y: 1.89, w: 5.35, h: 1.65, fontSize: 35, bold: true, color: C.ink, breakLine: false, margin: 0, fit: 'shrink' });
  s.addText('An AI onboarding agent that sees the customer’s screen, guides every step, and brings in a human only when it matters.', { x: 0.69, y: 3.82, w: 4.92, h: 1.0, fontSize: 14.5, color: C.gray, breakLine: false, margin: 0, fit: 'shrink' });

  // Product interface and visible contextual guidance.
  s.addShape(pptx.ShapeType.roundRect, { x: 6.18, y: 1.05, w: 6.62, h: 4.75, rectRadius: 0.12, fill: { color: C.white }, line: { color: 'E1DCE5', width: 1 }, shadow: { type: 'outer', color: 'AFA7B5', opacity: 0.25, blur: 2, angle: 45, distance: 1.5 } });
  s.addImage({ path: img('04-live-session-spotlight.png'), x: 6.28, y: 1.15, w: 6.42, h: 4.28 });
  s.addShape(pptx.ShapeType.roundRect, { x: 7.46, y: 4.94, w: 3.42, h: 0.62, rectRadius: 0.08, fill: { color: C.ink }, line: { color: C.ink }, shadow: { type: 'outer', color: '5A5160', opacity: 0.25, blur: 1.5, angle: 45, distance: 1 } });
  s.addText('Zen sees the active screen and points to the next action.', { x: 7.7, y: 5.12, w: 2.95, h: 0.2, fontSize: 9.5, bold: true, color: C.white, align: 'center', margin: 0, fit: 'shrink' });

  // Differentiator loop.
  const coverFlow = ['SEE', 'UNDERSTAND', 'GUIDE', 'ESCALATE'];
  coverFlow.forEach((label, i) => {
    const x = 0.69 + i * 1.28;
    s.addText(label, { x, y: 5.66, w: 0.96, h: 0.18, fontSize: 8, bold: true, color: i === 0 || i === 2 ? C.purple : C.ink, align: 'center', charSpacing: 0.9, margin: 0, fit: 'shrink' });
    if (i < 3) s.addText('→', { x: x + 0.98, y: 5.65, w: 0.26, h: 0.18, fontSize: 10, color: 'AAA4AD', align: 'center', margin: 0 });
  });
  s.addShape(pptx.ShapeType.line, { x: 0.69, y: 6.05, w: 4.8, h: 0, line: { color: 'DED9E2', width: 0.8 } });
  s.addText('AI ONBOARDING FOR B2B SAAS', { x: 0.69, y: 6.39, w: 2.75, h: 0.18, fontSize: 8.2, bold: true, color: '8D8791', charSpacing: 1.2, margin: 0 });
}

// 2 — Problem
{
  const s = slide();
  title(s, 'The enterprise problem', 'Onboarding still scales with headcount.', 'Every new customer adds coordination, repetition and avoidable delay.');
  const cards = [
    ['01', 'Scheduling drag', 'Customer is ready Monday.\nThe next specialist slot is Friday.', '5 days', 'lost momentum'],
    ['02', 'Repetitive work', 'Your strongest CSM repeats\nthe same setup for the 40th time.', '40×', 'same walkthrough'],
    ['03', 'Silent drop-off', 'One confusing integration step.\nCustomer leaves and never returns.', '1 step', 'can stop activation']
  ];
  cards.forEach((c, i) => {
    const x = 0.58 + i * 4.16;
    roundRect(s, x, 2.35, 3.76, 3.5, i === 2 ? 'FFF9F9' : C.white, i === 2 ? 'F2CACA' : C.line);
    s.addText(c[0], { x: x + 0.25, y: 2.64, w: 0.5, h: 0.25, fontSize: 10, bold: true, color: C.purple, margin: 0 });
    s.addText(c[1], { x: x + 0.25, y: 3.05, w: 3.15, h: 0.35, fontSize: 19, bold: true, color: C.ink, margin: 0 });
    s.addText(c[2], { x: x + 0.25, y: 3.58, w: 3.1, h: 0.68, fontSize: 12, color: C.gray, margin: 0, breakLine: false, fit: 'shrink' });
    s.addText(c[3], { x: x + 0.25, y: 4.62, w: 1.3, h: 0.44, fontSize: 25, bold: true, color: i === 2 ? C.red : C.purple, margin: 0 });
    s.addText(c[4], { x: x + 1.35, y: 4.76, w: 1.75, h: 0.25, fontSize: 9.5, color: C.gray, margin: 0, fit: 'shrink' });
  });
  s.addText('THE BOTTLENECK IS NOT KNOWLEDGE. IT IS CONTEXT, TIMING AND AVAILABILITY.', { x: 0.58, y: 6.35, w: 12.1, h: 0.28, fontSize: 11, bold: true, color: C.ink, align: 'center', charSpacing: 1.4, margin: 0 });
}

// 3 — Initial market wedge
{
  const s = slide();
  title(s, 'Initial market wedge', 'Healthcare operations SaaS.', 'Start where onboarding is complex, regulated and repeated across many locations.');

  roundRect(s, 0.58, 2.08, 4.05, 4.65, C.ink, C.ink);
  pill(s, 'IDEAL CUSTOMER', 0.9, 2.42, 1.38, '302A34', 'D6B5F4');
  s.addText('Vertical SaaS platforms serving multi-site clinics.', { x: 0.9, y: 3.03, w: 3.35, h: 0.9, fontSize: 25, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addText('Practice management  •  Billing  •  Patient engagement  •  Workforce operations', { x: 0.9, y: 4.25, w: 3.22, h: 0.72, fontSize: 11.5, color: 'D2CDD5', margin: 0, fit: 'shrink' });
  s.addText('WHY THIS WEDGE', { x: 0.9, y: 5.43, w: 1.25, h: 0.18, fontSize: 8.5, bold: true, color: 'CDA0F3', charSpacing: 1.3, margin: 0 });
  s.addText('High configuration + thin CS capacity + costly setup errors', { x: 0.9, y: 5.82, w: 3.2, h: 0.52, fontSize: 14, bold: true, color: C.white, margin: 0, fit: 'shrink' });

  s.addText('ONE CUSTOMER, A CUSTOM PLAYBOOK', { x: 5.08, y: 2.2, w: 3.0, h: 0.2, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.25, margin: 0 });
  const clinicSteps = [
    ['01', 'Import practitioners', 'Validate roles, locations and provider IDs'],
    ['02', 'Connect systems', 'Calendar, accounting, payments and messaging'],
    ['03', 'Apply clinic policy', 'Tax rules, permissions and approved workflows'],
    ['04', 'Train each role', 'Front desk, clinicians and administrators']
  ];
  clinicSteps.forEach((d, i) => {
    const y = 2.72 + i * 0.91;
    numberCircle(s, d[0], 5.1, y);
    s.addText(d[1], { x: 5.65, y: y + 0.01, w: 2.2, h: 0.22, fontSize: 13, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
    s.addText(d[2], { x: 7.85, y: y + 0.02, w: 3.95, h: 0.24, fontSize: 10.5, color: C.gray, margin: 0, fit: 'shrink' });
    if (i < 3) s.addShape(pptx.ShapeType.line, { x: 5.29, y: y + 0.4, w: 0, h: 0.5, line: { color: 'D4CFD8', width: 1.1, dash: 'dash' } });
  });
  roundRect(s, 5.08, 6.34, 7.55, 0.45, C.lilac, 'D9B1F8');
  s.addText('CUSTOMIZATION LAYER  →  customer policies + role-based flows + approved terminology', { x: 5.35, y: 6.47, w: 7.0, h: 0.16, fontSize: 9.5, bold: true, color: C.purple2, align: 'center', margin: 0, fit: 'shrink' });
}

// 4 — Product loop
{
  const s = slide();
  title(s, 'The Zen loop', 'An agent that works with the customer.', 'Not another help-center bot. Zen observes progress and acts in the moment.');
  const labels = [
    ['UNDERSTANDS', 'Goal + setup', '“Connect accounting\nfor 12 clinics.”'],
    ['SEES', 'Live context', 'Customer is on the\nIntegrations screen.'],
    ['GUIDES', 'Next best action', 'Highlights QuickBooks\nand waits.'],
    ['ESCALATES', 'Human judgment', 'Pricing or edge case,\nwith context attached.']
  ];
  labels.forEach((d, i) => {
    const x = 0.58 + i * 3.1;
    roundRect(s, x, 2.35, 2.72, 2.75, i === 2 ? C.lilac : C.white, i === 2 ? 'D9B1F8' : C.line);
    numberCircle(s, i + 1, x + 0.22, 2.62);
    s.addText(d[0], { x: x + 0.75, y: 2.72, w: 1.66, h: 0.16, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.4, margin: 0 });
    s.addText(d[1], { x: x + 0.22, y: 3.25, w: 2.25, h: 0.36, fontSize: 18, bold: true, color: C.ink, margin: 0 });
    s.addText(d[2], { x: x + 0.22, y: 3.88, w: 2.25, h: 0.58, fontSize: 11.5, color: C.gray, margin: 0, breakLine: false });
    if (i < 3) s.addShape(pptx.ShapeType.chevron, { x: x + 2.79, y: 3.46, w: 0.24, h: 0.46, fill: { color: 'D6D1DA' }, line: { color: 'D6D1DA' } });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 2.43, y: 5.62, w: 8.45, h: 0.67, rectRadius: 0.3, fill: { color: C.ink }, line: { color: C.ink } });
  s.addText('One session  →  one customer outcome  →  one structured learning signal', { x: 2.78, y: 5.83, w: 7.75, h: 0.22, fontSize: 13, bold: true, color: C.white, align: 'center', margin: 0, fit: 'shrink' });
}

// 4 — Live example
{
  const s = slide();
  title(s, 'Example 01 — live guidance', 'Zen points. The customer acts.', 'The instruction appears exactly where work is happening—not in another tab.');
  imageCard(s, '04-live-session-spotlight.png', 0.58, 2.05, 8.5, 5.02);
  pill(s, 'IN THE MOMENT', 9.48, 2.18, 1.38);
  s.addText('Customer goal', { x: 9.48, y: 2.74, w: 2.8, h: 0.26, fontSize: 11, bold: true, color: C.gray, margin: 0 });
  s.addText('Connect the accounting system', { x: 9.48, y: 3.08, w: 3.1, h: 0.55, fontSize: 22, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  s.addText('Zen identifies the right integration, spotlights the real button and waits for completion.', { x: 9.48, y: 3.88, w: 3.0, h: 0.85, fontSize: 12.5, color: C.gray, margin: 0, breakLine: false, fit: 'shrink' });
  metric(s, 9.48, 5.22, 1.3, '1', 'clear next step');
  metric(s, 11.05, 5.22, 1.3, '0', 'tab switching');
  s.addText('Why it matters', { x: 9.48, y: 6.28, w: 1.25, h: 0.2, fontSize: 9, bold: true, color: C.purple, margin: 0 });
  s.addText('Context turns documentation into action.', { x: 9.48, y: 6.56, w: 3.1, h: 0.3, fontSize: 14, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
}

// 6 — Error prevention
{
  const s = slide();
  title(s, 'Example 03 — risk prevention', 'Zen catches the costly “small” mistake.', 'The difference between answering a question and understanding the setup.');
  imageCard(s, '06-mapping-gst.png', 0.58, 2.05, 8.55, 5.02);
  s.addShape(pptx.ShapeType.roundRect, { x: 9.5, y: 2.18, w: 3.05, h: 1.52, rectRadius: 0.08, fill: { color: 'FFF6F6' }, line: { color: 'F1CCCC' } });
  s.addText('WRONG', { x: 9.8, y: 2.47, w: 0.75, h: 0.18, fontSize: 8.5, bold: true, color: C.red, charSpacing: 1.2, margin: 0 });
  s.addText('GST 10%', { x: 9.8, y: 2.82, w: 2.0, h: 0.42, fontSize: 23, bold: true, color: C.red, margin: 0 });
  s.addText('Generic default', { x: 9.8, y: 3.28, w: 1.5, h: 0.2, fontSize: 10, color: C.gray, margin: 0 });
  s.addShape(pptx.ShapeType.downArrow, { x: 10.72, y: 3.92, w: 0.42, h: 0.6, fill: { color: C.purple }, line: { color: C.purple } });
  s.addShape(pptx.ShapeType.roundRect, { x: 9.5, y: 4.75, w: 3.05, h: 1.52, rectRadius: 0.08, fill: { color: C.greenBg }, line: { color: 'B9E3CB' } });
  s.addText('RIGHT', { x: 9.8, y: 5.04, w: 0.75, h: 0.18, fontSize: 8.5, bold: true, color: C.green, charSpacing: 1.2, margin: 0 });
  s.addText('GST-FREE', { x: 9.8, y: 5.39, w: 2.2, h: 0.42, fontSize: 23, bold: true, color: C.green, margin: 0 });
  s.addText('Health-provider context', { x: 9.8, y: 5.85, w: 2.0, h: 0.2, fontSize: 10, color: C.gray, margin: 0 });
  s.addText('PREVENT REWORK  •  PROTECT TRUST  •  ACCELERATE GO-LIVE', { x: 9.5, y: 6.66, w: 3.05, h: 0.2, fontSize: 8.5, bold: true, color: C.ink, align: 'center', charSpacing: 0.7, margin: 0, fit: 'shrink' });
}

// 7 — Outcomes
{
  const s = slide();
  title(s, 'The operating model', 'Automation without losing visibility.', 'Zen runs the sessions. Customer Success keeps control of the portfolio.');
  imageCard(s, '08-admin-hub.png', 0.58, 2.02, 7.92, 5.12);
  const outcomes = [
    ['91%', 'self-serve rate', 'Illustrative demo metric'],
    ['2.4 days', 'time to value', 'Illustrative demo metric'],
    ['4', 'human escalations', 'Only where judgment matters']
  ];
  outcomes.forEach((o, i) => {
    const y = 2.1 + i * 1.45;
    roundRect(s, 8.9, y, 3.8, 1.15, i === 0 ? C.lilac : C.white, i === 0 ? 'DAB8F6' : C.line);
    s.addText(o[0], { x: 9.15, y: y + 0.2, w: 1.35, h: 0.38, fontSize: 22, bold: true, color: C.purple, margin: 0, fit: 'shrink' });
    s.addText(o[1], { x: 10.4, y: y + 0.25, w: 1.9, h: 0.25, fontSize: 11.5, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
    s.addText(o[2], { x: 10.4, y: y + 0.62, w: 1.95, h: 0.2, fontSize: 8.5, color: C.gray, margin: 0, fit: 'shrink' });
  });
  pill(s, 'PORTFOLIO INTELLIGENCE', 9.35, 6.55, 2.65, C.ink, C.white);
}

// 10 — Existing-stack integration
{
  const s = slide();
  title(s, 'Fits the existing stack', 'Embed once. Connect what enterprises already use.', 'Zen acts as an orchestration layer—not a replacement for systems of record.');

  roundRect(s, 0.58, 2.13, 3.1, 3.9, C.light, C.line);
  s.addText('YOUR PRODUCT', { x: 0.85, y: 2.48, w: 2.55, h: 0.2, fontSize: 9, bold: true, color: C.gray, charSpacing: 1.3, align: 'center', margin: 0 });
  s.addShape(pptx.ShapeType.roundRect, { x: 1.02, y: 3.0, w: 2.22, h: 1.2, rectRadius: 0.08, fill: { color: C.white }, line: { color: C.line } });
  s.addText('</>', { x: 1.74, y: 3.24, w: 0.8, h: 0.32, fontSize: 19, bold: true, color: C.purple, align: 'center', margin: 0 });
  s.addText('Web app / mobile app', { x: 1.23, y: 3.72, w: 1.8, h: 0.18, fontSize: 10.5, bold: true, color: C.ink, align: 'center', margin: 0 });
  pill(s, '1-LINE JS SDK', 1.2, 4.68, 1.85, C.ink, C.white);
  s.addText('or native SDK / secure session link', { x: 0.92, y: 5.23, w: 2.45, h: 0.22, fontSize: 9.5, color: C.gray, align: 'center', margin: 0, fit: 'shrink' });

  s.addShape(pptx.ShapeType.chevron, { x: 3.91, y: 3.56, w: 0.5, h: 0.76, fill: { color: C.purple }, line: { color: C.purple } });
  roundRect(s, 4.65, 2.13, 3.15, 3.9, C.lilac, 'D9B1F8');
  s.addText('ZEN ORCHESTRATION', { x: 4.93, y: 2.48, w: 2.55, h: 0.2, fontSize: 9, bold: true, color: C.purple, charSpacing: 1.3, align: 'center', margin: 0 });
  const zenLayers = ['Session + screen context', 'Customer-specific playbook', 'Tool calls + policy checks', 'Human escalation'];
  zenLayers.forEach((v, i) => {
    s.addShape(pptx.ShapeType.roundRect, { x: 5.03, y: 2.98 + i * 0.62, w: 2.38, h: 0.4, rectRadius: 0.04, fill: { color: C.white }, line: { color: 'D9B1F8' } });
    s.addText(v, { x: 5.18, y: 3.1 + i * 0.62, w: 2.08, h: 0.13, fontSize: 9.5, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
  });
  pill(s, 'REST + WEBHOOKS + EVENTS', 4.98, 5.53, 2.5, C.purple, C.white);

  s.addShape(pptx.ShapeType.chevron, { x: 8.05, y: 3.56, w: 0.5, h: 0.76, fill: { color: C.purple }, line: { color: C.purple } });
  roundRect(s, 8.78, 2.13, 3.95, 3.9, C.white, C.line);
  s.addText('SYSTEMS ALREADY IN PLACE', { x: 9.05, y: 2.48, w: 3.4, h: 0.2, fontSize: 9, bold: true, color: C.gray, charSpacing: 1.1, align: 'center', margin: 0 });
  const systems = [
    ['IDENTITY', 'Okta  •  Entra ID  •  WorkOS'],
    ['KNOWLEDGE', 'SharePoint  •  Confluence  •  Zendesk'],
    ['CUSTOMER', 'Salesforce  •  HubSpot  •  Gainsight'],
    ['WORK', 'Teams  •  Slack  •  Jira'],
    ['DATA', 'Segment  •  Snowflake  •  Power BI']
  ];
  systems.forEach((d, i) => {
    const y = 2.93 + i * 0.55;
    s.addText(d[0], { x: 9.08, y: y + 0.03, w: 0.72, h: 0.14, fontSize: 7.5, bold: true, color: C.purple, margin: 0, fit: 'shrink' });
    s.addText(d[1], { x: 9.88, y, w: 2.48, h: 0.18, fontSize: 9.5, color: C.ink, margin: 0, fit: 'shrink' });
    if (i < 4) s.addShape(pptx.ShapeType.line, { x: 9.08, y: y + 0.33, w: 3.18, h: 0, line: { color: C.line, width: 0.7 } });
  });
  s.addText('Example: Salesforce opens the session → Zen guides QuickBooks setup → unresolved issue creates a Zendesk ticket with transcript → outcome flows to Gainsight.', { x: 0.72, y: 6.49, w: 11.9, h: 0.37, fontSize: 11.3, bold: true, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
}

// 11 — Enterprise architecture
{
  const s = slide();
  title(s, 'Designed for enterprise', 'A control plane around the agent.', 'Production architecture: observable, governable and integration-ready.');
  const cols = [
    { x: 0.62, w: 2.35, label: 'CUSTOMER', items: ['Embedded widget', 'Voice / text', 'Screen share'] },
    { x: 3.36, w: 2.6, label: 'ZEN AGENT', items: ['Goal planner', 'Screen context', 'Policy guardrails'] },
    { x: 6.35, w: 2.62, label: 'KNOWLEDGE', items: ['Product docs', 'Approved answers', 'Session memory'] },
    { x: 9.36, w: 3.25, label: 'ENTERPRISE SYSTEMS', items: ['CRM + Support', 'Slack / Teams', 'Analytics + Data'] }
  ];
  cols.forEach((c, ci) => {
    roundRect(s, c.x, 2.18, c.w, 3.58, ci === 1 ? C.lilac : C.light, ci === 1 ? 'D9B1F8' : C.line);
    s.addText(c.label, { x: c.x + 0.2, y: 2.5, w: c.w - 0.4, h: 0.18, fontSize: 8.5, bold: true, color: ci === 1 ? C.purple : C.gray, charSpacing: 1.25, align: 'center', margin: 0 });
    c.items.forEach((item, i) => {
      s.addShape(pptx.ShapeType.roundRect, { x: c.x + 0.2, y: 3.0 + i * 0.72, w: c.w - 0.4, h: 0.48, rectRadius: 0.05, fill: { color: C.white }, line: { color: ci === 1 ? 'D9B1F8' : C.line } });
      s.addText(item, { x: c.x + 0.34, y: 3.15 + i * 0.72, w: c.w - 0.68, h: 0.14, fontSize: 10.5, bold: ci === 1, color: C.ink, align: 'center', margin: 0, fit: 'shrink' });
    });
    if (ci < 3) s.addShape(pptx.ShapeType.chevron, { x: c.x + c.w + 0.22, y: 3.68, w: 0.34, h: 0.56, fill: { color: C.purple }, line: { color: C.purple } });
  });
  const controls = ['Identity & RBAC', 'Audit trail', 'Data boundaries', 'Human approval', 'Evaluation'];
  s.addText('CONTROL LAYER', { x: 0.62, y: 6.12, w: 1.2, h: 0.18, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.2, margin: 0 });
  controls.forEach((v, i) => pill(s, v.toUpperCase(), 1.82 + i * 2.02, 6.05, 1.76, i === 3 ? C.purple : C.ink, C.white));
  s.addText('Architecture is the proposed production target; the submitted hackathon experience is a frontend prototype.', { x: 0.62, y: 6.82, w: 11.9, h: 0.2, fontSize: 8.5, italic: true, color: C.gray, align: 'center', margin: 0 });
}

// 10 — Value
{
  const s = slide();
  title(s, 'Enterprise value', 'Turn onboarding from a queue into a system.', 'Four stakeholder wins from one shared customer journey.');
  const wins = [
    ['CUSTOMER', 'Start now', 'No calendar delay.\nGuidance in context.', '⏱'],
    ['CUSTOMER SUCCESS', 'Focus humans', 'Escalate judgment.\nAutomate repetition.', '◎'],
    ['PRODUCT', 'See friction', 'Every struggle becomes\na roadmap signal.', '↗'],
    ['LEADERSHIP', 'Scale coverage', 'More customers without\nlinear headcount.', '∞']
  ];
  wins.forEach((w, i) => {
    const x = 0.58 + i * 3.1;
    roundRect(s, x, 2.2, 2.75, 3.72, i === 3 ? C.ink : C.white, i === 3 ? C.ink : C.line);
    s.addText(w[3], { x: x + 0.24, y: 2.55, w: 0.55, h: 0.55, fontSize: 27, bold: true, color: i === 3 ? 'CDA0F3' : C.purple, margin: 0, align: 'center' });
    s.addText(w[0], { x: x + 0.24, y: 3.36, w: 2.2, h: 0.18, fontSize: 8.5, bold: true, color: i === 3 ? 'CDA0F3' : C.gray, charSpacing: 1.1, margin: 0, fit: 'shrink' });
    s.addText(w[1], { x: x + 0.24, y: 3.86, w: 2.2, h: 0.42, fontSize: 22, bold: true, color: i === 3 ? C.white : C.ink, margin: 0, fit: 'shrink' });
    s.addText(w[2], { x: x + 0.24, y: 4.6, w: 2.2, h: 0.62, fontSize: 12, color: i === 3 ? 'D4CFD8' : C.gray, margin: 0, breakLine: false, fit: 'shrink' });
  });
  s.addText('NORTH STAR', { x: 3.93, y: 6.45, w: 1.1, h: 0.18, fontSize: 8.5, bold: true, color: C.purple, charSpacing: 1.2, margin: 0 });
  s.addText('Time from signed contract → first customer value', { x: 5.05, y: 6.38, w: 4.75, h: 0.32, fontSize: 15, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
}

// 12 — Close
{
  const s = slide();
  s.background = { color: C.ink };
  s.addShape(pptx.ShapeType.arc, { x: 0.74, y: 0.74, w: 0.62, h: 0.62, adjustPoint: 0.22, rotate: 20, fill: { color: C.ink, transparency: 100 }, line: { color: C.purple, width: 6 } });
  s.addText('ZEN', { x: 1.5, y: 0.9, w: 1.25, h: 0.35, fontSize: 16, bold: true, color: C.white, charSpacing: 2.4, margin: 0 });
  s.addText('High-touch onboarding.\nEvery customer.\nNo extra headcount.', { x: 0.76, y: 2.02, w: 7.4, h: 2.35, fontSize: 40, bold: true, color: C.white, margin: 0, fit: 'shrink' });
  s.addText('Let’s see it live.', { x: 0.78, y: 5.0, w: 3.5, h: 0.48, fontSize: 22, bold: true, color: 'CDA0F3', margin: 0 });
  s.addText('Interactive prototype  →  Landing page  →  Guided session  →  Admin Hub', { x: 0.78, y: 5.65, w: 6.65, h: 0.32, fontSize: 12, color: 'B9B4BD', margin: 0, fit: 'shrink' });
  imageCard(s, '07-complete.png', 8.2, 1.35, 4.42, 2.95);
  s.addShape(pptx.ShapeType.roundRect, { x: 8.2, y: 4.72, w: 4.42, h: 1.17, rectRadius: 0.08, fill: { color: '25212A' }, line: { color: '3A3440' } });
  s.addText('5 / 5', { x: 8.55, y: 4.98, w: 1.0, h: 0.35, fontSize: 22, bold: true, color: C.white, margin: 0 });
  s.addText('steps completed', { x: 9.53, y: 5.08, w: 1.35, h: 0.2, fontSize: 10, color: 'B9B4BD', margin: 0 });
  s.addText('0', { x: 11.0, y: 4.98, w: 0.4, h: 0.35, fontSize: 22, bold: true, color: 'CDA0F3', margin: 0 });
  s.addText('human handoffs', { x: 11.4, y: 5.08, w: 0.95, h: 0.2, fontSize: 10, color: 'B9B4BD', margin: 0, fit: 'shrink' });
  s.addText('Prototype metrics shown are illustrative.', { x: 8.2, y: 6.28, w: 4.42, h: 0.18, fontSize: 8.5, color: '7F7885', align: 'center', margin: 0 });
}

pptx.writeFile({ fileName: path.join(__dirname, 'Zen-Enterprise-Hackathon-Deck-Final-v5.pptx') });
