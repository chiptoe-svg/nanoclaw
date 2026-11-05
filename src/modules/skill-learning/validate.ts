/**
 * Pure validation for agent-proposed skills.
 *
 * The container tool checks the same rules first; these run on the host as
 * the delivery precheck (and again on the approved replay), against the live
 * registry, so a proposal that went stale while it waited is refused.
 */
import { createHash } from 'node:crypto';

export type SkillOp = 'create' | 'update' | 'archive';

export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Approvers read the whole skill on a phone before approving it. */
export const MAX_SKILL_CHARS = 12_000;
/** Descriptions sit in every session's skill index; keep them short. */
export const MIN_DESCRIPTION_CHARS = 20;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_RATIONALE_CHARS = 400;
/** Cap on active learned skills per agent group, so the index cannot bloat. */
export const MAX_ACTIVE_SKILLS = 40;
/** Token-set overlap at which a new skill is treated as a near-duplicate of an existing one. */
export const DUPLICATE_THRESHOLD = 0.5;

/** Credential shapes that must never be written into a skill. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic/OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
];

export interface SkillProposal {
  op: SkillOp;
  name: string;
  content: string | null;
  rationale: string;
  /** sha256 of the SKILL.md an update was drafted from. */
  baseSha: string | null;
}

export interface RegistryView {
  /** Active agent-learned skills: name → current SKILL.md content. */
  active: Map<string, string>;
  /** Names the agent may not take: shared container skills and any other entry in the skills dir. */
  reserved: Set<string>;
  /**
   * Hashes an update may be based on, per skill: the approved version and the
   * installed copy. Anything else means the skill changed after the agent read
   * it (another update was approved), so the draft would overwrite that change.
   */
  bases: Map<string, Set<string>>;
}

export type ParseResult = { ok: true; proposal: SkillProposal } | { ok: false; error: string };

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Read `name` and `description` from a SKILL.md frontmatter block (single-line values only). */
export function parseFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { name: fields.name, description: fields.description };
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4),
  );
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** The closest active skill to `content`, if any reaches the duplicate threshold. */
export function findNearDuplicate(
  content: string,
  active: Map<string, string>,
): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const [name, existing] of active) {
    const score = similarity(content, existing);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { name, score };
  }
  return best;
}

export function findSecret(content: string): string | null {
  for (const [label, re] of SECRET_PATTERNS) if (re.test(content)) return label;
  return null;
}

/** Validate a raw system-action payload against the group's current skills. */
export function parseProposal(raw: Record<string, unknown>, view: RegistryView): ParseResult {
  const op = raw.op;
  if (op !== 'create' && op !== 'update' && op !== 'archive') {
    return { ok: false, error: 'op must be "create", "update" or "archive"' };
  }
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, error: 'name must be lowercase letters, digits and hyphens (max 64 characters)' };
  }
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'rationale is required' };
  if (rationale.length > MAX_RATIONALE_CHARS) {
    return { ok: false, error: `rationale is limited to ${MAX_RATIONALE_CHARS} characters` };
  }

  if (op === 'archive') {
    if (!view.active.has(name)) return { ok: false, error: `"${name}" is not one of your learned skills` };
    return { ok: true, proposal: { op, name, content: null, rationale, baseSha: null } };
  }

  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!content.trim()) return { ok: false, error: 'content (the full SKILL.md) is required' };
  if (content.length > MAX_SKILL_CHARS) {
    return { ok: false, error: `content is ${content.length} characters; the limit is ${MAX_SKILL_CHARS}` };
  }
  const fm = parseFrontmatter(content);
  if (!fm) return { ok: false, error: 'content must start with a --- frontmatter block' };
  if (fm.name !== name) return { ok: false, error: `frontmatter name must be "${name}"` };
  const description = fm.description ?? '';
  if (description.length < MIN_DESCRIPTION_CHARS || description.length > MAX_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `frontmatter description must be one line of ${MIN_DESCRIPTION_CHARS}-${MAX_DESCRIPTION_CHARS} characters`,
    };
  }
  const secret = findSecret(content);
  if (secret)
    return { ok: false, error: `content looks like it contains a ${secret}; skills must never hold credentials` };

  if (op === 'create') {
    if (view.active.has(name)) return { ok: false, error: `"${name}" already exists; use op "update"` };
    if (view.reserved.has(name)) return { ok: false, error: `"${name}" is taken by an installed skill` };
    if (view.active.size >= MAX_ACTIVE_SKILLS) {
      return { ok: false, error: `you already have ${MAX_ACTIVE_SKILLS} learned skills; update or archive one first` };
    }
    const dup = findNearDuplicate(content, view.active);
    if (dup) {
      return {
        ok: false,
        error: `this overlaps heavily with your skill "${dup.name}" (similarity ${dup.score.toFixed(2)}); update that one instead`,
      };
    }
  } else {
    const current = view.active.get(name);
    if (current === undefined) return { ok: false, error: `"${name}" is not one of your learned skills` };
    if (current === content) return { ok: false, error: 'the update is identical to the current skill' };
    const baseSha = typeof raw.base_sha256 === 'string' ? raw.base_sha256 : '';
    if (!view.bases.get(name)?.has(baseSha)) {
      return {
        ok: false,
        error: `"${name}" changed after you read it; read ~/.claude/skills/${name}/SKILL.md again and redo the update`,
      };
    }
    return { ok: true, proposal: { op, name, content, rationale, baseSha } };
  }

  return { ok: true, proposal: { op, name, content, rationale, baseSha: null } };
}
