/**
 * Skill-learning MCP tool: propose_skill.
 *
 * Fire-and-forget like the self-mod tools: it writes a system action row and
 * returns. The host validates the proposal against the group's learned-skill
 * registry, shows the approver the full text, and on approval installs it at
 * ~/.claude/skills/<name>/SKILL.md. The agent hears back in a chat message.
 *
 * Checks here are a fast first pass; the host re-validates everything.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SKILLS_DIR = path.join(process.env.HOME ?? '/home/node', '.claude', 'skills');
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILL_CHARS = 12_000;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** sha256 of the installed SKILL.md, so the host can tell whether the skill changed after it was read. */
function installedSha(name: string): string | null {
  try {
    return createHash('sha256')
      .update(fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'))
      .digest('hex');
  } catch {
    return null;
  }
}

export const proposeSkill: McpToolDefinition = {
  tool: {
    name: 'propose_skill',
    description:
      'Propose a change to YOUR learned skills: create a new skill, update one you already have, or archive one. ' +
      'Requires admin approval; fire-and-forget. The approver reads the full text; on approval the skill is installed at ' +
      '~/.claude/skills/<name>/SKILL.md. For update, read the current SKILL.md first and send the complete new file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['create', 'update', 'archive'], description: 'What to do' },
        name: {
          type: 'string',
          description: 'Skill name: lowercase letters, digits, hyphens. Must match the frontmatter name.',
        },
        content: {
          type: 'string',
          description: `Complete SKILL.md (frontmatter with name + one-line description, then the body). Max ${MAX_SKILL_CHARS} characters. Omit for archive.`,
        },
        rationale: {
          type: 'string',
          description: 'One or two sentences: what happened that makes this worth keeping or changing.',
        },
      },
      required: ['op', 'name', 'rationale'],
    },
  },
  async handler(args) {
    const op = args.op as string;
    const name = (args.name as string) || '';
    const content = typeof args.content === 'string' ? args.content : null;
    const rationale = ((args.rationale as string) || '').trim();

    if (op !== 'create' && op !== 'update' && op !== 'archive') return err('op must be create, update or archive');
    if (!NAME_RE.test(name)) return err('name must be lowercase letters, digits and hyphens (max 64 characters)');
    if (!rationale) return err('rationale is required');
    if (op !== 'archive') {
      if (!content) return err('content is required for create and update');
      if (content.length > MAX_SKILL_CHARS)
        return err(`content is ${content.length} characters; the limit is ${MAX_SKILL_CHARS}`);
      if (!new RegExp(`^---\\r?\\n[\\s\\S]*?^name:\\s*['"]?${name}['"]?\\s*$`, 'm').test(content)) {
        return err(`content must start with a --- frontmatter block whose name is "${name}"`);
      }
    }
    const baseSha = op === 'update' ? installedSha(name) : null;
    if (op === 'update' && !baseSha) return err(`no installed skill "${name}" to update; use create`);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'propose_skill',
        op,
        name,
        content: op === 'archive' ? null : content,
        rationale,
        base_sha256: baseSha,
      }),
    });

    log(`propose_skill: ${requestId} → ${op} ${name}`);
    return ok(`Skill ${op} for "${name}" submitted for approval. You will be told when it is approved or rejected.`);
  },
};

registerTools([proposeSkill]);
