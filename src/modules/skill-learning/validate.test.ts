import { describe, expect, it } from 'vitest';

import { MAX_SKILL_CHARS, parseFrontmatter, parseProposal, sha256, type RegistryView } from './validate.js';

function skill(
  name: string,
  description = 'Summarise an earnings call into the notes format the user wants.',
  body = 'Steps here.',
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

function view(active: Record<string, string> = {}, reserved: string[] = []): RegistryView {
  const bases = new Map<string, Set<string>>();
  for (const [name, content] of Object.entries(active)) bases.set(name, new Set([sha256(content)]));
  return { active: new Map(Object.entries(active)), reserved: new Set(reserved), bases };
}

const rationale = 'The user corrected the format twice.';

describe('parseFrontmatter', () => {
  it('reads name and description, stripping quotes', () => {
    expect(parseFrontmatter('---\nname: a-b\ndescription: "Hello there"\n---\nbody')).toEqual({
      name: 'a-b',
      description: 'Hello there',
    });
  });
  it('returns null without a frontmatter block', () => {
    expect(parseFrontmatter('# no frontmatter')).toBeNull();
  });
});

describe('parseProposal', () => {
  it('accepts a valid create', () => {
    const r = parseProposal({ op: 'create', name: 'call-notes', content: skill('call-notes'), rationale }, view());
    expect(r.ok).toBe(true);
  });

  it('rejects bad names, missing rationale and oversize content', () => {
    expect(parseProposal({ op: 'create', name: '../x', content: skill('x'), rationale }, view()).ok).toBe(false);
    expect(parseProposal({ op: 'create', name: 'x-y', content: skill('x-y'), rationale: ' ' }, view()).ok).toBe(false);
    const big = skill('big', undefined, 'a'.repeat(MAX_SKILL_CHARS));
    expect(parseProposal({ op: 'create', name: 'big', content: big, rationale }, view()).ok).toBe(false);
  });

  it('requires the frontmatter name to match and a sized description', () => {
    expect(parseProposal({ op: 'create', name: 'one', content: skill('two'), rationale }, view()).ok).toBe(false);
    expect(parseProposal({ op: 'create', name: 'one', content: skill('one', 'short'), rationale }, view()).ok).toBe(
      false,
    );
  });

  it('rejects content that carries a credential', () => {
    const r = parseProposal(
      {
        op: 'create',
        name: 'leaky',
        content: skill('leaky', undefined, 'token ghp_abcdefghijklmnopqrstuvwxyz0123'),
        rationale,
      },
      view(),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('GitHub token') });
  });

  it('refuses names held by installed skills', () => {
    const r = parseProposal(
      { op: 'create', name: 'alojoh', content: skill('alojoh'), rationale },
      view({}, ['alojoh']),
    );
    expect(r.ok).toBe(false);
  });

  it('routes a near-duplicate create to update', () => {
    const existing = skill(
      'call-notes',
      undefined,
      'Pull the transcript, list guidance changes, margins, segment revenue and risks.',
    );
    const r = parseProposal(
      {
        op: 'create',
        name: 'call-summary',
        content: skill(
          'call-summary',
          undefined,
          'Pull the transcript, list guidance changes, margins, segment revenue and risks.',
        ),
        rationale,
      },
      view({ 'call-notes': existing }),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('"call-notes"') });
  });

  it('accepts an update drafted from the approved version only', () => {
    const current = skill('call-notes');
    const next = skill('call-notes', undefined, 'Better steps.');
    const v = view({ 'call-notes': current });
    expect(
      parseProposal({ op: 'update', name: 'call-notes', content: next, rationale, base_sha256: sha256(current) }, v).ok,
    ).toBe(true);
    expect(
      parseProposal({ op: 'update', name: 'call-notes', content: next, rationale, base_sha256: 'stale' }, v),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after you read it'),
    });
  });

  it('only updates or archives learned skills', () => {
    expect(
      parseProposal({ op: 'update', name: 'alojoh', content: skill('alojoh'), rationale }, view({}, ['alojoh'])).ok,
    ).toBe(false);
    expect(parseProposal({ op: 'archive', name: 'alojoh', rationale }, view({}, ['alojoh'])).ok).toBe(false);
    expect(
      parseProposal({ op: 'archive', name: 'call-notes', rationale }, view({ 'call-notes': skill('call-notes') })).ok,
    ).toBe(true);
  });
});
