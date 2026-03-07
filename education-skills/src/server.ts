import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import fs from 'fs';
import { google } from 'googleapis';
import { marked } from 'marked';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readApiKey(): string {
  const envPath = path.join(__dirname, '../../.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      if (t.slice(0, eq).trim() === 'ANTHROPIC_API_KEY') {
        return t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
  return process.env.ANTHROPIC_API_KEY ?? '';
}

interface Field {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
}

interface Skill {
  id: string;
  name: string;
  description: string;
  fields: Field[];
  system: string;
  userPrompt: (inputs: Record<string, string>) => string;
}

const SKILLS: Skill[] = [
  {
    id: 'mixed-age-learning',
    name: 'Mixed-Age Learning Task Designer',
    description:
      'Design tasks where both older (tutor) and younger (tutee) students genuinely learn — not babysitting. Based on peer tutoring research (Hattie effect size 0.55) and Montessori mixed-age principles.',
    fields: [
      { id: 'age_groups', label: 'Age Groups', type: 'text', required: true, placeholder: 'e.g. 6–7 year olds and 9–10 year olds' },
      { id: 'subject', label: 'Subject / Topic', type: 'text', required: true, placeholder: 'e.g. fractions, life cycles, letter formation' },
      { id: 'objectives', label: 'Learning Objectives', type: 'textarea', required: true, placeholder: 'What should each age group learn or consolidate?' },
      { id: 'materials', label: 'Available Materials', type: 'textarea', required: false, placeholder: 'Resources or materials available in the classroom' },
      { id: 'duration', label: 'Session Duration', type: 'text', required: false, placeholder: 'e.g. 45 minutes' },
      { id: 'constraints', label: 'Constraints', type: 'textarea', required: false, placeholder: 'School policies, space limitations, SEN considerations, etc.' },
    ],
    system: `You are an expert Montessori educator and learning designer specialising in mixed-age classroom pedagogy.

Design learning tasks using this evidence-based framework:

CORE PRINCIPLE: Both age groups genuinely learn — the older student consolidates through the "protégé effect" (teaching requires reorganising knowledge); the younger student benefits from peer scaffolding within their zone of proximal development (Vygotsky, 1978). Optimal age gap: 2–3 years.

FIVE DESIGN IMPERATIVES:
1. Interdependence — both groups contribute skills the other lacks; neither can complete the task alone
2. Tutor preparation — explicit training in questioning, explaining, step-sequencing, and checking understanding
3. Structured interaction — specific protocols prevent the older student from simply doing the work
4. Cognitive demand for tutors — tasks must require reorganisation of knowledge, not autopilot help
5. Role clarity — each role is genuinely challenging for that age group

EVIDENCE: Hattie (2009) effect size 0.55 for peer tutoring; Lillard & Else-Quest (2006) superior social skills and community; Topping (2005) success requires tutor training, cognitive work, defined roles.

Output a complete, professional learning task design in well-structured markdown. Include: task overview, tutor preparation protocol, step-by-step activity structure, structured interaction script/prompts, differentiation strategies, assessment indicators, and implementation notes.`,
    userPrompt: (i) => `Design a mixed-age learning task for the following context:

**Age Groups:** ${i.age_groups}
**Subject / Topic:** ${i.subject}
**Learning Objectives:**
${i.objectives}
${i.materials ? `\n**Available Materials:**\n${i.materials}` : ''}
${i.duration ? `\n**Session Duration:** ${i.duration}` : ''}
${i.constraints ? `\n**Constraints:**\n${i.constraints}` : ''}`,
  },

  {
    id: 'prepared-environment',
    name: 'Prepared Environment Designer',
    description:
      'Evaluate and redesign learning spaces against six Montessori principles. Produces phased improvement plans across zero-cost, low-cost, and investment tiers.',
    fields: [
      { id: 'environment', label: 'Current Environment Description', type: 'textarea', required: true, placeholder: 'Describe the classroom or learning space — layout, furniture, materials, displays, storage.' },
      { id: 'goals', label: 'Improvement Goals', type: 'textarea', required: true, placeholder: 'What outcomes do you want this redesign to achieve?' },
      { id: 'age_range', label: 'Student Age Range', type: 'text', required: false, placeholder: 'e.g. 3–6 years, 6–9 years' },
      { id: 'budget', label: 'Budget Level', type: 'select', required: false, options: ['', 'Zero cost only', 'Low (under $500)', 'Medium ($500–$2,000)', 'High (over $2,000)'] },
      { id: 'constraints', label: 'Space / Policy Constraints', type: 'textarea', required: false, placeholder: 'Fixed walls, shared spaces, landlord/school restrictions, rental agreements, etc.' },
      { id: 'timeline', label: 'Implementation Timeline', type: 'text', required: false, placeholder: 'e.g. before next term, over the next 6 months' },
    ],
    system: `You are an expert Montessori environment designer and educational consultant.

Evaluate and redesign learning spaces against these six principles:

1. ACCESSIBILITY — Materials at child height, independently reachable without adult help
2. ORDER — Defined place for everything; visual order supports responsibility and autonomy
3. BEAUTY — Aesthetic design using natural materials; communicates respect for children's work
4. REAL MATERIALS — Functional objects over plastic; develops careful handling and practical skills
5. CHILD SCALE — Furniture sized for actual users; signals belonging and ownership
6. DEFINED AREAS — Distinct zones for different work types (practical life, language, maths, sensorial, art, etc.)

EVIDENCE: Barrett et al. (2015) classroom design explained 16% of variance in pupil learning progress across 153 classrooms; Fisher et al. (2014) heavily decorated rooms showed 38.6% time off-task vs 28.4% in sparse rooms; Lillard (2005) alignment with embodied cognition, executive function, intrinsic motivation.

Output format:
1. Environment audit table (each principle: current state, rating, priority)
2. Phased redesign plan (zero-cost changes, low-cost changes, investment items)
3. Implementation sequence with timeline
4. Maintenance protocol for sustaining the environment
5. Before/after comparison summary

Use well-structured markdown with tables, clear headings, and specific actionable recommendations.`,
    userPrompt: (i) => `Design a prepared environment improvement plan:

**Current Environment:**
${i.environment}

**Improvement Goals:**
${i.goals}
${i.age_range ? `\n**Student Age Range:** ${i.age_range}` : ''}
${i.budget ? `\n**Budget Level:** ${i.budget}` : ''}
${i.constraints ? `\n**Space / Policy Constraints:**\n${i.constraints}` : ''}
${i.timeline ? `\n**Implementation Timeline:** ${i.timeline}` : ''}`,
  },

  {
    id: 'three-part-lesson',
    name: 'Three-Part Lesson Designer',
    description:
      'Design complete Montessori three-period lessons: Period 1 (naming), Period 2 (recognition), Period 3 (recall). Includes ready-to-use teacher scripts and mastery indicators.',
    fields: [
      { id: 'concept', label: 'Concept to Teach', type: 'text', required: true, placeholder: 'e.g. isosceles triangle, rough vs smooth, the colour cerulean' },
      { id: 'materials', label: 'Concrete Materials Available', type: 'text', required: true, placeholder: 'e.g. geometric inset cards, sandpaper tablets, colour box' },
      { id: 'student_level', label: 'Student Level / Age', type: 'text', required: false, placeholder: 'e.g. 4-year-olds, early primary' },
      { id: 'subject', label: 'Subject Area', type: 'text', required: false, placeholder: 'e.g. maths, sensorial, language, practical life' },
      { id: 'group_size', label: 'Group Size', type: 'text', required: false, placeholder: 'e.g. individual, pairs, small group of 3' },
      { id: 'prior_knowledge', label: 'Prior Knowledge', type: 'textarea', required: false, placeholder: 'What do students already know or have mastered?' },
      { id: 'language', label: 'Language Considerations', type: 'text', required: false, placeholder: 'e.g. EAL learners, bilingual classroom, key vocabulary concerns' },
    ],
    system: `You are an expert Montessori teacher trainer specialising in the three-period lesson.

Design complete three-period lessons following this methodology exactly:

PERIOD 1 — NAMING (Introduction):
- Teacher names the concept; student handles material passively
- Use precise language without explanation ("This is an isosceles triangle" — not "This triangle has two equal sides because...")
- No questions, no testing; pure reception
- Engage multiple senses with the material

PERIOD 2 — RECOGNITION:
- Student identifies named items from options; embedded in movement and play
- 5–6 varied prompts (e.g. "Show me the rough one", "Can you put the isosceles triangle on the window?", "Which one would you like to trace?")
- Recognition memory (easier than recall) — this period builds confidence
- Movement is not optional; it consolidates learning

PERIOD 3 — RECALL:
- Teacher presents item; student produces the name
- Never supply the answer if student fails — return to Period 2 and try again later
- This is the test of mastery; do not rush here

FIVE DESIGN PRINCIPLES:
1. Isolation of difficulty — materials differ ONLY in the target feature
2. Precise language — exact terms without explanation in Period 1
3. Active Period 2 — 5–6 distinct movement-based prompts
4. No-rush Period 3 — return-to-Period-2 protocol strictly followed
5. Three items maximum — 2–3 concepts per lesson only

EVIDENCE: Lillard & Else-Quest (2006); cognitive science: embodied cognition, cognitive load reduction, retrieval practice, mastery learning.

Output:
1. Lesson header (concept, materials, group size, estimated duration)
2. Materials preparation checklist (including isolation verification)
3. Period 1 script (exact teacher language, sensory engagement)
4. Period 2 script (5–6 distinct movement-based prompts)
5. Period 3 script (with explicit return-to-Period-2 protocol)
6. Assessment indicators table (mastery signals per period)
7. Extensions (immediate and longer-term follow-up activities)
8. Adaptation notes (age, group size, EAL, non-Montessori contexts)`,
    userPrompt: (i) => `Design a three-period Montessori lesson:

**Concept to Teach:** ${i.concept}
**Concrete Materials:** ${i.materials}
${i.student_level ? `\n**Student Level / Age:** ${i.student_level}` : ''}
${i.subject ? `\n**Subject Area:** ${i.subject}` : ''}
${i.group_size ? `\n**Group Size:** ${i.group_size}` : ''}
${i.prior_knowledge ? `\n**Prior Knowledge:**\n${i.prior_knowledge}` : ''}
${i.language ? `\n**Language Considerations:** ${i.language}` : ''}`,
  },

  {
    id: 'work-cycle',
    name: 'Uninterrupted Work Cycle Designer',
    description:
      'Design sustained self-directed learning periods. Adapts the Montessori 3-hour ideal to realistic school time blocks, with opening routines, observation protocols, and a phased 5-week introduction plan.',
    fields: [
      { id: 'time', label: 'Available Time Block', type: 'text', required: true, placeholder: 'e.g. 90 minutes, 2 hours' },
      { id: 'age_group', label: 'Age Group / Grade', type: 'text', required: true, placeholder: 'e.g. 6–9 year olds, Year 3–4' },
      { id: 'num_students', label: 'Number of Students', type: 'text', required: false, placeholder: 'e.g. 24 students' },
      { id: 'challenges', label: 'Current Challenges', type: 'textarea', required: false, placeholder: 'e.g. students struggle to settle, choice paralysis, constant seeking of adult approval, off-task behaviour' },
      { id: 'context', label: 'Classroom Context', type: 'textarea', required: false, placeholder: 'Current setup, routines, materials available, curriculum constraints, prior experience with self-directed learning.' },
    ],
    system: `You are an expert in Montessori pedagogy and self-directed learning environments.

Design uninterrupted work cycles using this evidence-based framework:

FIVE CRITICAL PRINCIPLES:
1. Design for actual available time — not the Montessori 3-hour ideal, but the realistic block the school provides
2. Opening routine determines everything — calm transitions and explicit goal-setting determine whether students settle productively
3. Teacher role is observer, not instructor — the cycle is assessment-rich; document what students choose and how they sustain effort
4. Choice requires explicit training — students need scaffolded support in selecting appropriately challenging work
5. Protect the block — no announcements, interruptions, or mid-cycle transitions; non-negotiable

NATURAL WORK CYCLE PHASES (Lillard, 2005):
1. Settling (getting materials, false starts, social negotiation) — 10–15 min
2. Initial engagement
3. Deep concentration — the goal state
4. Satisfaction and natural completion
5. Rest and transition to new work

EVIDENCE:
- Csikszentmihalyi (1990): flow requires 15–20 minutes to establish; easily disrupted by any interruption
- Rosenshine (2012): uninterrupted engaged time correlates strongly with learning outcomes
- Diamond & Lee (2011): self-directed planning, initiating, sustaining, completing builds executive function
- Lillard & Else-Quest (2006): Montessori students show stronger executive function development

Output:
1. Work cycle overview (annotated timeline with phases)
2. Opening routine (step-by-step script, 5–10 minutes)
3. Work period structure with teacher observation protocol and documentation tool
4. Choice management system and materials rotation
5. Closing routine with structured reflection
6. Phased introduction plan (weeks 1–5 for new implementations)
7. Responses to common teacher concerns (behaviour, accountability, parental questions, curriculum coverage)
8. Assessment and documentation framework

Use well-structured markdown with clear headings, tables, and practical ready-to-use scripts.`,
    userPrompt: (i) => `Design an uninterrupted work cycle:

**Available Time Block:** ${i.time}
**Age Group / Grade:** ${i.age_group}
${i.num_students ? `\n**Number of Students:** ${i.num_students}` : ''}
${i.challenges ? `\n**Current Challenges:**\n${i.challenges}` : ''}
${i.context ? `\n**Classroom Context:**\n${i.context}` : ''}`,
  },
];

// In-memory store for quick-ref pages { id -> { html, created } }
const quickRefStore = new Map<string, { html: string; created: number }>();
function purgeOldQuickRefs() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of quickRefStore) {
    if (entry.created < cutoff) quickRefStore.delete(id);
  }
}

// Report persistence
interface ReportRecord {
  id: string;
  skillId: string;
  title: string;
  description: string;
  inputs: Record<string, string>;
  docUrl: string;
  createdAt: string;
}

const REPORTS_PATH = path.join(__dirname, '../reports.json');

function loadReports(): ReportRecord[] {
  try { return JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf-8')); }
  catch { return []; }
}

function saveReports(reports: ReportRecord[]): void {
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
}

function inputsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const norm = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim()));
  const na = norm(a), nb = norm(b);
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  return [...keys].every(k => (na[k] ?? '') === (nb[k] ?? ''));
}

function generateDescription(skill: Skill, inputs: Record<string, string>): string {
  const vals = skill.fields.filter(f => f.required).map(f => inputs[f.id]).filter(Boolean);
  return vals.slice(0, 2).map(v => v.replace(/\n.*/s, '').slice(0, 70)).join(' — ');
}

function docIdFromUrl(url: string): string {
  return url.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? '';
}

const briefWebHtml = (html: string) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quick Reference · Montessori Skill Designer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f1eb; color: #2c2c2c; min-height: 100vh; }
  .topbar { background: #1a1a2e; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 12px; }
  .topbar a { color: #8a8aa0; font-size: 13px; text-decoration: none; flex-shrink: 0; }
  .topbar a:hover { color: #fff; }
  .topbar .title { font-size: 14px; font-weight: 600; flex: 1; }
  .topbar .date { color: #8a8aa0; font-size: 12px; flex-shrink: 0; }
  .content { max-width: 680px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 20px; color: #1a1a2e; border-bottom: 3px solid #8B7355; padding-bottom: 8px; margin-top: 0; margin-bottom: 8px; line-height: 1.3; }
  h2 { font-size: 13px; color: #fff; background: #8B7355; padding: 6px 12px; border-radius: 5px; margin-top: 20px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { font-size: 15px; color: #1a1a2e; margin-top: 16px; margin-bottom: 6px; }
  p { margin: 8px 0; font-size: 15px; line-height: 1.6; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
  li { margin: 6px 0; font-size: 15px; line-height: 1.55; }
  strong { color: #1a1a2e; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
  th { background: #8B7355; color: #fff; padding: 8px 10px; text-align: left; font-size: 13px; }
  td { padding: 8px 10px; border-bottom: 1px solid #e0d8cc; vertical-align: top; font-size: 14px; }
  tr:nth-child(even) td { background: #f9f6f1; }
  blockquote { border: 2px solid #8B7355; border-radius: 6px; margin: 14px 0; padding: 12px 14px; background: #f9f6f1; font-weight: 600; font-size: 15px; }
  hr { border: none; border-top: 1px solid #e0d8cc; margin: 16px 0; }
  @media (min-width: 600px) {
    .content { padding: 28px 24px 60px; }
    h1 { font-size: 22px; }
  }
</style>
</head><body>
<div class="topbar">
  <a href="javascript:history.back()">← Back</a>
  <span class="title">Quick Reference</span>
  <span class="date">${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
</div>
<div class="content">
${html}
</div>
</body></html>`;

function getGoogleAuth() {
  const credsPath = path.join(os.homedir(), '.workspace-mcp/credentials/chiptoe1@gmail.com.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  auth.setCredentials({ refresh_token: creds.refresh_token });
  return auth;
}

async function createGoogleDoc(title: string, bodyHtml: string): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head><body>${bodyHtml}</body></html>`;
  const res = await drive.files.create({
    requestBody: { name: title, mimeType: 'application/vnd.google-apps.document' },
    media: { mimeType: 'text/html', body: html },
    fields: 'id',
  });
  const docId = res.data.id!;
  // Make the doc openable by anyone with the link (no Google sign-in required)
  await drive.permissions.create({
    fileId: docId,
    requestBody: { role: 'writer', type: 'anyone' },
  });
  return docId;
}

async function shareGoogleDoc(docId: string, recipientEmail: string): Promise<void> {
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  await drive.permissions.create({
    fileId: docId,
    sendNotificationEmail: true,
    requestBody: { role: 'writer', type: 'user', emailAddress: recipientEmail },
  });
}

async function fetchDocText(docId: string): Promise<string> {
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  const res = await drive.files.export(
    { fileId: docId, mimeType: 'text/plain' },
    { responseType: 'text' },
  );
  return res.data as string;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/quick-ref/:id', (req, res) => {
  const entry = quickRefStore.get(req.params.id);
  if (!entry) { res.status(404).send('Not found or expired.'); return; }
  res.set('Content-Type', 'text/html');
  res.send(entry.html);
});

app.get('/api/skills', (_req, res) => {
  res.json(SKILLS.map(({ id, name, description, fields }) => ({ id, name, description, fields })));
});

app.get('/api/reports', (_req, res) => {
  res.json([...loadReports()].reverse());
});

app.delete('/api/reports/:id', (req, res) => {
  saveReports(loadReports().filter(r => r.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/generate', async (req, res) => {
  const { skill: skillId, inputs, recipientEmail } = req.body as { skill: string; format: string; inputs: Record<string, string>; recipientEmail?: string };
  const skill = SKILLS.find((s) => s.id === skillId);
  if (!skill) { res.status(400).json({ error: 'Unknown skill' }); return; }

  const apiKey = readApiKey();
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' }); return; }

  const format = (req.body.format === 'brief') ? 'brief' : 'full';

  const briefSuffix = `

IMPORTANT: This is a QUICK REFERENCE format for use on a mobile device during a lesson.
- Total length: 400–600 words maximum
- No paragraphs — use numbered steps and short bullet points only
- Bold every key action or term
- Structure strictly: Overview (2–3 lines) → Materials checklist → Step-by-step sequence → One quick-reference box at the end
- Omit all evidence citations, theoretical background, and extended explanations`;

  const email = recipientEmail?.trim() || undefined;

  try {
    const existing = loadReports().find(r => r.skillId === skillId && inputsMatch(r.inputs, inputs));
    const client = new Anthropic({ apiKey });

    // --- QUICK REFERENCE ---
    if (format === 'brief') {
      let markdown: string;

      if (existing) {
        // Generate quick ref from the current Google Doc content
        const docText = await fetchDocText(docIdFromUrl(existing.docUrl));
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: skill.system + briefSuffix,
          messages: [{ role: 'user', content: `Condense this full report into a quick reference:\n\n${docText}` }],
        });
        markdown = (msg.content[0] as { type: 'text'; text: string }).text;
      } else {
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: skill.system + briefSuffix,
          messages: [{ role: 'user', content: skill.userPrompt(inputs) }],
        });
        markdown = (msg.content[0] as { type: 'text'; text: string }).text;
      }

      const bodyHtml = await marked(markdown);
      purgeOldQuickRefs();
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      quickRefStore.set(id, { html: briefWebHtml(bodyHtml), created: Date.now() });
      res.json({ url: `/quick-ref/${id}`, fromExisting: !!existing });
      return;
    }

    // --- FULL REPORT ---
    if (existing) {
      if (email) await shareGoogleDoc(docIdFromUrl(existing.docUrl), email);
      res.json({ url: existing.docUrl, reused: true, shared: !!email });
      return;
    }

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: skill.system,
      messages: [{ role: 'user', content: skill.userPrompt(inputs) }],
    });
    const bodyHtml = await marked((msg.content[0] as { type: 'text'; text: string }).text);

    const title = `${skill.name} — ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const docId = await createGoogleDoc(title, bodyHtml); // throws on failure — no save below if this fails
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    if (email) await shareGoogleDoc(docId, email);

    try {
      const reports = loadReports();
      reports.push({
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        skillId,
        title,
        description: generateDescription(skill, inputs),
        inputs,
        docUrl,
        createdAt: new Date().toISOString(),
      });
      saveReports(reports);
    } catch (saveErr) {
      console.error('Failed to save report record (doc was created):', saveErr);
    }

    res.json({ url: docUrl, reused: false, shared: !!email });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Generation error:', msg);
    res.status(500).json({ error: msg });
  }
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`Education Skills → http://localhost:${PORT}`));
