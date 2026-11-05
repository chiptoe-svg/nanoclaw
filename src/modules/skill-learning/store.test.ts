import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyChange,
  loadRegistry,
  readInstalled,
  readLedger,
  registryView,
  rollbackTo,
  type StorePaths,
} from './store.js';
import { sha256 } from './validate.js';

let tmp: string;
let p: StorePaths;

const skill = (body: string) =>
  `---\nname: call-notes\ndescription: Summarise an earnings call into the user's notes format.\n---\n\n${body}\n`;
const meta = { actor: 'telegram:1', sessionId: 's1' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-learning-'));
  p = {
    stateDir: path.join(tmp, 'state'),
    skillsRoot: path.join(tmp, 'group'),
    skillsSegments: ['.claude-shared', 'skills'],
    sharedSkillsDir: path.join(tmp, 'shared'),
  };
  fs.mkdirSync(path.join(p.sharedSkillsDir, 'alojoh'), { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('skill-learning store', () => {
  it('installs, records and versions a skill', () => {
    applyChange(p, { op: 'create', name: 'call-notes', content: skill('v1'), rationale: 'r' }, meta);
    applyChange(p, { op: 'update', name: 'call-notes', content: skill('v2'), rationale: 'r' }, meta);

    expect(readInstalled(p, 'call-notes')).toBe(skill('v2'));
    expect(loadRegistry(p).skills['call-notes']).toMatchObject({
      status: 'active',
      version: 2,
      sha256: sha256(skill('v2')),
    });
    const ledger = readLedger(p);
    expect(ledger.map((e) => e.op)).toEqual(['create', 'update']);
    expect(ledger[1].before_sha).toBe(sha256(skill('v1')));
  });

  it('reserves shared and foreign skill names and reads approved content from blobs', () => {
    applyChange(p, { op: 'create', name: 'call-notes', content: skill('v1'), rationale: 'r' }, meta);
    fs.mkdirSync(path.join(p.skillsRoot, '.claude-shared', 'skills', 'template-skill'));
    // The agent edits its installed copy outside approval.
    fs.writeFileSync(path.join(p.skillsRoot, '.claude-shared', 'skills', 'call-notes', 'SKILL.md'), skill('tampered'));

    const view = registryView(p);
    expect([...view.reserved].sort()).toEqual(['alojoh', 'template-skill']);
    expect(view.active.get('call-notes')).toBe(skill('v1'));
    expect(view.bases.get('call-notes')).toEqual(new Set([sha256(skill('v1')), sha256(skill('tampered'))]));
  });

  it('records drift and keeps the drifted text', () => {
    applyChange(p, { op: 'create', name: 'call-notes', content: skill('v1'), rationale: 'r' }, meta);
    fs.writeFileSync(path.join(p.skillsRoot, '.claude-shared', 'skills', 'call-notes', 'SKILL.md'), skill('tampered'));
    const result = applyChange(p, { op: 'update', name: 'call-notes', content: skill('v2'), rationale: 'r' }, meta);

    expect(result.drift).toBe(true);
    const last = readLedger(p).at(-1)!;
    expect(last.before_sha).toBe(sha256(skill('tampered')));
    expect(fs.readFileSync(path.join(p.stateDir, 'blobs', `${last.before_sha}.md`), 'utf8')).toBe(skill('tampered'));
  });

  it('archives into host-only state and rolls back', () => {
    applyChange(p, { op: 'create', name: 'call-notes', content: skill('v1'), rationale: 'r' }, meta);
    applyChange(p, { op: 'update', name: 'call-notes', content: skill('v2'), rationale: 'r' }, meta);
    rollbackTo(p, 'call-notes', sha256(skill('v1')), 'operator');
    expect(readInstalled(p, 'call-notes')).toBe(skill('v1'));
    expect(readLedger(p).at(-1)!.op).toBe('rollback');

    applyChange(p, { op: 'archive', name: 'call-notes', content: null, rationale: 'r' }, meta);
    expect(readInstalled(p, 'call-notes')).toBeNull();
    expect(fs.existsSync(path.join(p.skillsRoot, '.claude-shared', 'skills', 'call-notes'))).toBe(false);
    expect(loadRegistry(p).skills['call-notes'].status).toBe('archived');
    expect(fs.readdirSync(path.join(p.stateDir, 'archive'))).toHaveLength(1);
  });

  it('never follows a symlink planted at the skill name', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(p.skillsRoot, '.claude-shared', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(p.skillsRoot, '.claude-shared', 'skills', 'call-notes'));

    expect(() =>
      applyChange(p, { op: 'create', name: 'call-notes', content: skill('v1'), rationale: 'r' }, meta),
    ).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
