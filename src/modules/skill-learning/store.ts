/**
 * Storage for agent-learned skills.
 *
 * Two places, with different owners:
 *   - The installed skill: `data/v2-sessions/<group>/.claude-shared/skills/<name>/SKILL.md`,
 *     the same group-private store agent templates stamp real skill dirs into.
 *     It is mounted read-write at ~/.claude/skills, so the host reaches it only
 *     through AnchoredDir and never trusts what it finds there.
 *   - Host-only state: `data/skill-learning/<group>/` — registry.json (what was
 *     approved, at which hash), ledger.jsonl (every change), blobs/<sha>.md
 *     (every approved version, content-addressed, for diff and rollback) and
 *     archive/. No container mounts this directory.
 *
 * The registry's hash is the approved content. When the installed file no
 * longer matches it, the agent (or anything else) edited it outside the
 * approval flow; the next change records that as drift.
 */
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from '../../anchored-dir.js';
import { DATA_DIR } from '../../config.js';
import { sha256, type RegistryView, type SkillOp } from './validate.js';

export interface SkillRecord {
  status: 'active' | 'archived';
  version: number;
  sha256: string;
  created_at: string;
  updated_at: string;
  approved_by: string;
}

export interface Registry {
  skills: Record<string, SkillRecord>;
}

export interface LedgerEntry {
  at: string;
  op: SkillOp | 'rollback';
  name: string;
  version: number;
  before_sha: string | null;
  after_sha: string | null;
  /** The installed file did not match the approved hash when this change was applied. */
  drift: boolean;
  actor: string;
  rationale: string;
  session_id: string | null;
}

export interface StorePaths {
  /** Host-only state for one agent group. */
  stateDir: string;
  /** Host-owned anchor above the agent-writable skills dir. */
  skillsRoot: string;
  skillsSegments: readonly string[];
  /** Shared container skills (`container/skills/`), whose names are reserved. */
  sharedSkillsDir: string;
}

export function storePaths(agentGroupId: string): StorePaths {
  return {
    stateDir: path.join(DATA_DIR, 'skill-learning', agentGroupId),
    skillsRoot: path.join(DATA_DIR, 'v2-sessions', agentGroupId),
    skillsSegments: ['.claude-shared', 'skills'],
    sharedSkillsDir: path.join(process.cwd(), 'container', 'skills'),
  };
}

export function loadRegistry(p: StorePaths): Registry {
  try {
    return JSON.parse(fs.readFileSync(path.join(p.stateDir, 'registry.json'), 'utf8')) as Registry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skills: {} };
    throw err;
  }
}

function saveRegistry(p: StorePaths, registry: Registry): void {
  fs.mkdirSync(p.stateDir, { recursive: true });
  const file = path.join(p.stateDir, 'registry.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function appendLedger(p: StorePaths, entry: LedgerEntry): void {
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.appendFileSync(path.join(p.stateDir, 'ledger.jsonl'), JSON.stringify(entry) + '\n');
}

export function readLedger(p: StorePaths): LedgerEntry[] {
  try {
    return fs
      .readFileSync(path.join(p.stateDir, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function writeBlob(p: StorePaths, content: string): string {
  const sha = sha256(content);
  const dir = path.join(p.stateDir, 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  return sha;
}

export function readBlob(p: StorePaths, sha: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`invalid blob hash ${sha}`);
  return fs.readFileSync(path.join(p.stateDir, 'blobs', `${sha}.md`), 'utf8');
}

function openSkillsDir(p: StorePaths, create = false): AnchoredDir | null {
  return AnchoredDir.open(p.skillsRoot, p.skillsSegments, create);
}

/** The installed SKILL.md for `name`, or null if absent or not a plain file in a real dir. */
export function readInstalled(p: StorePaths, name: string): string | null {
  const skills = openSkillsDir(p);
  if (!skills) return null;
  try {
    const dir = skills.openDir(name);
    if (!dir) return null;
    try {
      return dir.readFile('SKILL.md').toString('utf8');
    } finally {
      dir.close();
    }
  } catch {
    return null;
  } finally {
    skills.close();
  }
}

function installSkill(p: StorePaths, name: string, content: string): void {
  const skills = openSkillsDir(p, true);
  if (!skills) throw new Error('skills directory unavailable');
  try {
    const dir = skills.openDir(name, true);
    if (!dir) throw new Error(`could not create skill directory ${name}`);
    try {
      dir.replaceFile('SKILL.md', content);
    } finally {
      dir.close();
    }
  } finally {
    skills.close();
  }
}

/** Remove the installed skill dir. Top-level files and links go; a nested directory is left and reported. */
function uninstallSkill(p: StorePaths, name: string): string[] {
  const skills = openSkillsDir(p);
  if (!skills) return [];
  const leftovers: string[] = [];
  try {
    let dir: AnchoredDir | null;
    try {
      dir = skills.openDir(name);
    } catch {
      // A symlink or file planted under the name: remove the entry itself, never its target.
      skills.unlink(name);
      return [];
    }
    if (!dir) return [];
    try {
      for (const entry of dir.entries()) {
        if (dir.lstat(entry).isDirectory()) leftovers.push(entry);
        else dir.unlink(entry);
      }
    } finally {
      dir.close();
    }
    if (leftovers.length === 0) skills.rmdir(name);
  } finally {
    skills.close();
  }
  return leftovers;
}

/** Current state the validator checks a proposal against. Approved content comes from blobs, not the agent-writable copy. */
export function registryView(p: StorePaths): RegistryView {
  const registry = loadRegistry(p);
  const active = new Map<string, string>();
  const bases = new Map<string, Set<string>>();
  for (const [name, rec] of Object.entries(registry.skills)) {
    if (rec.status !== 'active') continue;
    active.set(name, readBlob(p, rec.sha256));
    const accepted = new Set([rec.sha256]);
    const installed = readInstalled(p, name);
    if (installed !== null) accepted.add(sha256(installed));
    bases.set(name, accepted);
  }
  const reserved = new Set<string>();
  if (fs.existsSync(p.sharedSkillsDir)) for (const e of fs.readdirSync(p.sharedSkillsDir)) reserved.add(e);
  const skills = openSkillsDir(p);
  if (skills) {
    try {
      for (const e of skills.entries()) if (!active.has(e)) reserved.add(e);
    } finally {
      skills.close();
    }
  }
  return { active, reserved, bases };
}

export interface ApplyResult {
  version: number;
  drift: boolean;
  leftovers: string[];
}

/** Apply an approved change: blob, install (or archive), registry, ledger. */
export function applyChange(
  p: StorePaths,
  change: { op: SkillOp; name: string; content: string | null; rationale: string },
  meta: { actor: string; sessionId: string | null; now?: string; ledgerOp?: LedgerEntry['op'] },
): ApplyResult {
  const now = meta.now ?? new Date().toISOString();
  const registry = loadRegistry(p);
  const prev = registry.skills[change.name];
  const installed = readInstalled(p, change.name);
  const drift = prev?.status === 'active' && installed !== null && sha256(installed) !== prev.sha256;
  // Keep what was actually on disk too, so drifted edits are never lost.
  const beforeSha = drift && installed !== null ? writeBlob(p, installed) : (prev?.sha256 ?? null);

  let afterSha: string | null = null;
  let leftovers: string[] = [];
  if (change.op === 'archive') {
    if (installed !== null) {
      const archiveDir = path.join(p.stateDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, `${change.name}-${now.replace(/[:.]/g, '-')}.md`), installed);
    }
    leftovers = uninstallSkill(p, change.name);
  } else {
    afterSha = writeBlob(p, change.content as string);
    installSkill(p, change.name, change.content as string);
  }

  const version = (prev?.version ?? 0) + 1;
  registry.skills[change.name] = {
    status: change.op === 'archive' ? 'archived' : 'active',
    version,
    sha256: afterSha ?? prev?.sha256 ?? '',
    created_at: prev?.created_at ?? now,
    updated_at: now,
    approved_by: meta.actor,
  };
  saveRegistry(p, registry);
  appendLedger(p, {
    at: now,
    op: meta.ledgerOp ?? change.op,
    name: change.name,
    version,
    before_sha: beforeSha,
    after_sha: afterSha,
    drift,
    actor: meta.actor,
    rationale: change.rationale,
    session_id: meta.sessionId,
  });
  return { version, drift, leftovers };
}

/** Operator rollback: reinstall a previously approved version by its blob hash. */
export function rollbackTo(p: StorePaths, name: string, sha: string, actor: string): ApplyResult {
  const content = readBlob(p, sha);
  return applyChange(
    p,
    { op: 'update', name, content, rationale: `rollback to ${sha.slice(0, 12)}` },
    { actor, sessionId: null, ledgerOp: 'rollback' },
  );
}
