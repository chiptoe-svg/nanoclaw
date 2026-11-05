/**
 * Print one past turn from the Claude SDK transcripts in readable form: the
 * request, then each assistant text and tool call (inputs and results cut
 * short), up to the next real request.
 *
 *   bun /app/skills/learned-skills/show-turn.ts <turn timestamp from the review data>
 */
import fs from 'node:fs';
import path from 'node:path';

const AT = process.argv[2];
const PROJECTS = path.join(process.env.HOME ?? '/home/node', '.claude', 'projects');
const CONTINUATION = ['This session is being continued', '<task-notification>'];
const MAX_OUTPUT = 60_000;

if (!AT) {
  console.error('usage: show-turn.ts <timestamp>');
  process.exit(2);
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; id?: string };
type Entry = { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } };

function cut(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return (content as Block[]).map((c) => (c?.type === 'text' ? (c.text ?? '') : '')).join(' ');
  return '';
}

function isRequest(e: Entry): boolean {
  if (e.type !== 'user' || e.isMeta) return false;
  const content = e.message?.content;
  if (Array.isArray(content) && (content as Block[]).some((c) => c?.type === 'tool_result')) return false;
  const text = textOf(content).trimStart();
  return !CONTINUATION.some((p) => text.startsWith(p));
}

function findFile(): string | null {
  for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    const full = path.join(PROJECTS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      if (fs.readFileSync(file, 'utf8').includes(`"timestamp":"${AT}"`)) return file;
    }
  }
  return null;
}

const file = findFile();
if (!file) {
  console.error(`no transcript has a turn at ${AT}`);
  process.exit(1);
}

const out: string[] = [];
const seen = new Set<string>();
let inTurn = false;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  let e: Entry;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (!inTurn) {
    if (e.timestamp === AT && isRequest(e)) {
      inTurn = true;
      out.push(`REQUEST (${AT}):\n${cut(textOf(e.message?.content), 4000)}\n`);
    }
    continue;
  }
  if (isRequest(e)) break;
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  for (const c of content as Block[]) {
    if (c?.id && seen.has(c.id)) continue;
    if (c?.id) seen.add(c.id);
    if (e.type === 'assistant' && c?.type === 'text' && c.text?.trim()) out.push(`ASSISTANT: ${cut(c.text, 1500)}`);
    else if (e.type === 'assistant' && c?.type === 'tool_use') out.push(`TOOL ${c.name}: ${cut(c.input, 400)}`);
    else if (e.type === 'user' && c?.type === 'tool_result') out.push(`  → ${cut(c.content, 300)}`);
  }
}

const text = out.join('\n');
console.log(text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated)` : text);
