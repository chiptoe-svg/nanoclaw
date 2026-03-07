import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import fs from 'fs';
import { marked } from 'marked';
import path from 'path';
import puppeteer from 'puppeteer';
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

const pdfHtml = (html: string) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: Georgia, serif; max-width: 740px; margin: 0 auto; padding: 36px 48px; color: #1e1e1e; line-height: 1.75; }
  h1 { font-size: 24px; color: #1a1a2e; border-bottom: 2px solid #8B7355; padding-bottom: 10px; margin-top: 0; }
  h2 { font-size: 18px; color: #1a1a2e; margin-top: 32px; border-left: 4px solid #8B7355; padding-left: 10px; }
  h3 { font-size: 15px; color: #333; margin-top: 20px; }
  p { margin: 10px 0; }
  ul, ol { margin: 10px 0; padding-left: 22px; }
  li { margin: 5px 0; }
  strong { color: #111; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px; }
  th { background: #8B7355; color: #fff; padding: 9px 13px; text-align: left; }
  td { padding: 8px 13px; border-bottom: 1px solid #e0d8cc; vertical-align: top; }
  tr:nth-child(even) td { background: #f9f6f1; }
  blockquote { border-left: 3px solid #8B7355; margin: 14px 0; padding: 6px 14px; background: #f9f6f1; color: #555; font-style: italic; }
  code { background: #f0ede7; padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: monospace; }
  pre { background: #f0ede7; padding: 12px; border-radius: 5px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .meta { color: #999; font-size: 12px; margin-bottom: 28px; }
  hr { border: none; border-top: 1px solid #e0d8cc; margin: 20px 0; }
</style></head><body>
<div class="meta">Montessori Alternative Approaches · ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
${html}
</body></html>`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/skills', (_req, res) => {
  res.json(SKILLS.map(({ id, name, description, fields }) => ({ id, name, description, fields })));
});

app.post('/api/generate', async (req, res) => {
  const { skill: skillId, inputs } = req.body as { skill: string; inputs: Record<string, string> };
  const skill = SKILLS.find((s) => s.id === skillId);
  if (!skill) { res.status(400).json({ error: 'Unknown skill' }); return; }

  const apiKey = readApiKey();
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' }); return; }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: skill.system,
      messages: [{ role: 'user', content: skill.userPrompt(inputs) }],
    });

    const markdown = (message.content[0] as { type: 'text'; text: string }).text;
    const bodyHtml = await marked(markdown);
    const fullHtml = pdfHtml(bodyHtml);

    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' } });
    await browser.close();

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${skillId}-${Date.now()}.pdf"`);
    res.send(pdf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Generation error:', msg);
    res.status(500).json({ error: msg });
  }
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`Education Skills → http://localhost:${PORT}`));
