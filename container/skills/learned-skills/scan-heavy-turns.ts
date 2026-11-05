/**
 * Pre-task gate for the skill review: flags turns since the last review that
 * took many tool calls and ended without a propose_skill call, from the
 * Claude SDK transcripts under ~/.claude/projects. Prints the scheduled-task
 * gate JSON as its last line: wake only when something was flagged.
 *
 *   bun /app/skills/learned-skills/scan-heavy-turns.ts [threshold]
 *
 * State lives in /workspace/agent so it survives container restarts: the
 * last scanned timestamp (the first run looks back 24 hours) and the requests
 * already sent for review, so a recurring scheduled task that is heavy every
 * day is reviewed once per fortnight, not daily.
 */
import fs from 'node:fs';
import path from 'node:path';

const THRESHOLD = Number(process.argv[2] ?? 15);
const MAX_FLAGGED = 5;
const REVIEW_MARKER = '[skill-review]';
const PROJECTS = path.join(process.env.HOME ?? '/home/node', '.claude', 'projects');
const STATE = '/workspace/agent/.skill-review-state.json';
const CONTINUATION = ['This session is being continued', '<task-notification>'];
/** Banners a task prompt can arrive under; the same job must sign the same way under either. */
const TASK_PREFIX = /^(\[SCHEDULED TASK[^\]]*\]\s*)?(Instructions:\s*)?/;
const RESEND_AFTER_MS = 14 * 24 * 3_600_000;

interface Turn {
  at: string;
  tools: number;
  proposed: boolean;
  request: string;
}

interface State {
  since: string;
  /** Request signature → when it was last sent for review. */
  reviewed: Record<string, string>;
}

function readState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8')) as Partial<State>;
    if (typeof s.since === 'string') return { since: s.since, reviewed: s.reviewed ?? {} };
  } catch {
    /* first run */
  }
  return { since: new Date(Date.now() - 24 * 3_600_000).toISOString(), reviewed: {} };
}

/** Human-readable request text, without markup or the scheduled-task banner. */
function clean(request: string): string {
  return request
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TASK_PREFIX, '');
}

/** Identifies "the same job": a recurring task's prompt starts the same way every run. */
function signature(request: string): string {
  return clean(request).toLowerCase().slice(0, 80);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? (c as { text: string }).text : '',
      )
      .join(' ');
  }
  return '';
}

function scanFile(file: string, since: string, seen: Set<string>): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message?.content;
    if (e.type === 'user') {
      const isToolResult =
        Array.isArray(content) && content.some((c) => (c as { type?: string } | null)?.type === 'tool_result');
      // Tool results, injected skill text, compaction summaries and subagent
      // notifications continue the current turn; only a real request starts one.
      if (isToolResult || e.isMeta) continue;
      const request = textOf(content);
      if (CONTINUATION.some((prefix) => request.trimStart().startsWith(prefix))) continue;
      if (cur) turns.push(cur);
      cur = { at: e.timestamp ?? '', tools: 0, proposed: false, request };
    } else if (e.type === 'assistant' && cur && Array.isArray(content)) {
      for (const c of content as Array<{ type?: string; id?: string; name?: string }>) {
        if (c?.type !== 'tool_use' || !c.id || seen.has(c.id)) continue;
        seen.add(c.id);
        cur.tools++;
        if (c.name?.endsWith('propose_skill')) cur.proposed = true;
      }
    }
  }
  if (cur) turns.push(cur);
  return turns.filter((t) => t.at > since);
}

const state = readState();
const since = state.since;
const now = new Date().toISOString();
const seen = new Set<string>();
const flagged: Turn[] = [];

for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
  const full = path.join(PROJECTS, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(full, name);
    if (fs.statSync(file).mtime.toISOString() <= since) continue;
    for (const t of scanFile(file, since, seen)) {
      if (t.tools >= THRESHOLD && !t.proposed && !t.request.includes(REVIEW_MARKER)) flagged.push(t);
    }
  }
}

// Heaviest run per job, skipping jobs sent for review within the last fortnight.
flagged.sort((a, b) => b.tools - a.tools);
const picked: Turn[] = [];
const pickedSigs = new Set<string>();
for (const t of flagged) {
  const sig = signature(t.request);
  const last = state.reviewed[sig];
  if (pickedSigs.has(sig) || (last && Date.parse(now) - Date.parse(last) < RESEND_AFTER_MS)) continue;
  pickedSigs.add(sig);
  picked.push(t);
  if (picked.length === MAX_FLAGGED) break;
}

const reviewed: Record<string, string> = {};
for (const [sig, at] of Object.entries(state.reviewed)) {
  if (Date.parse(now) - Date.parse(at) < RESEND_AFTER_MS) reviewed[sig] = at;
}
for (const sig of pickedSigs) reviewed[sig] = now;
fs.writeFileSync(STATE, JSON.stringify({ since: now, reviewed }, null, 2) + '\n');

const data = {
  since,
  threshold: THRESHOLD,
  flagged: picked.map((t) => ({
    at: t.at,
    toolCalls: t.tools,
    request: clean(t.request).slice(0, 200),
  })),
};
console.log(JSON.stringify({ wakeAgent: picked.length > 0, data }));
