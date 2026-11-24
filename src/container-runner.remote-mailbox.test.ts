/**
 * Opt-in remote mailbox at spawn: an opted-in group gets no session-directory
 * mount, the three runner env vars and a live token; a group not on the list is
 * composed exactly as before; the token dies with the container.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisedHandle } from './drivers/session-events.js';
import type { SessionSpec } from './drivers/types.js';

const ROOT = `/tmp/nanoclaw-test-remote-mailbox-${process.pid}`;
const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  const root = `/tmp/nanoclaw-test-remote-mailbox-${process.pid}`;
  return {
    ...actual,
    DATA_DIR: `${root}/data`,
    GROUPS_DIR: `${root}/groups`,
    REMOTE_MAILBOX_GROUPS: ['ag-remote'],
    MAILBOX_PORT: 18999,
  };
});
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions: async () => [], prepare, capabilities: () => ({}) };
  return { getSessionDriver: () => driver, isSessionEventsDriver: () => false };
});

import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import { verifyMailboxToken } from './mailbox/remote/tokens.js';
import type { Session } from './types.js';

const sessionOf = (agentGroupId: string): Session => {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  };
};

function fakeHandle(agentGroupId: string): SupervisedHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId, sessionId: 'sess-1' },
    name: 'nanoclaw-v2-sess-1',
    async start() {},
    async stop() {},
    async status() {
      return { phase: 'running' };
    },
    onTerminal() {},
  } as unknown as SupervisedHandle;
}

const tokenFile = (group: string) => path.join(ROOT, 'data', 'mailbox-tokens', group, 'sess-1');
const specOf = (): SessionSpec => prepare.mock.calls[0][0] as SessionSpec;
const workspaceMount = () => specOf().containers[0].mounts.find((m) => m.containerPath === '/workspace')!;
const allEnv = () => ({ ...specOf().containers[0].env, ...specOf().containers[0].contributedEnv });

beforeEach(async () => {
  prepare.mockReset();
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: [],
    sessions: {
      ensure: async () => ({
        contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
      }),
    },
    approvals: { subscribe: async () => {} },
  });
  await runMigrations(await initTestDb());
  for (const [id, folder] of [
    ['ag-remote', 'remote-agent'],
    ['ag-plain', 'plain-agent'],
  ]) {
    await createAgentGroup({
      id,
      name: id,
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig(id);
  }
});

afterEach(async () => {
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  resetGatewayProvider();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('remote mailbox spawn wiring', () => {
  it('opted-in group: scratch /workspace, three env vars, live token', async () => {
    prepare.mockResolvedValue(fakeHandle('ag-remote'));
    await createSession(sessionOf('ag-remote'));
    expect(await wakeContainer(sessionOf('ag-remote'))).toBe(true);

    const sessDir = path.join(ROOT, 'data', 'v2-sessions', 'ag-remote', 'sess-1');
    expect(specOf().containers[0].mounts.some((m) => m.hostPath === sessDir)).toBe(false);
    expect(workspaceMount()).toMatchObject({ mode: 'rw', class: 'group-state', groupScope: 'ag-remote' });
    expect(workspaceMount().hostPath).toBe(path.join(ROOT, 'data/v2-sessions/ag-remote/.remote-workspace/sess-1'));
    expect(fs.readdirSync(workspaceMount().hostPath)).toEqual([]);
    // The other mounts are untouched.
    const targets = specOf().containers[0].mounts.map((m) => m.containerPath);
    expect(targets).toEqual(expect.arrayContaining(['/workspace/agent', '/app/.nanoclaw-session.json']));

    const env = allEnv();
    expect(env.NANOCLAW_MAILBOX_URL).toBe('http://host.docker.internal:18999/v1/mailbox');
    expect(env.NANOCLAW_MAILBOX_SESSION).toBe('ag-remote/sess-1');
    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(true);
    expect(verifyMailboxToken(`Bearer ${env.NANOCLAW_MAILBOX_TOKEN}`, 'ag-remote/sess-1')).toEqual({
      agentGroupId: 'ag-remote',
      sessionId: 'sess-1',
    });
  });

  it('group not opted in: session mount, no mailbox env, no token', async () => {
    prepare.mockResolvedValue(fakeHandle('ag-plain'));
    await createSession(sessionOf('ag-plain'));
    expect(await wakeContainer(sessionOf('ag-plain'))).toBe(true);

    expect(workspaceMount().hostPath).toBe(path.join(ROOT, 'data', 'v2-sessions', 'ag-plain', 'sess-1'));
    for (const k of ['NANOCLAW_MAILBOX_URL', 'NANOCLAW_MAILBOX_TOKEN', 'NANOCLAW_MAILBOX_SESSION']) {
      expect(allEnv()[k]).toBeUndefined();
    }
    expect(fs.existsSync(path.join(ROOT, 'data', 'mailbox-tokens'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'data/v2-sessions/ag-plain/.remote-workspace'))).toBe(false);
  });

  it('revokes the token and drops the scratch workspace when the container exits', async () => {
    prepare.mockResolvedValue(fakeHandle('ag-remote'));
    await createSession(sessionOf('ag-remote'));
    await wakeContainer(sessionOf('ag-remote'));
    const token = allEnv().NANOCLAW_MAILBOX_TOKEN;
    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(true);

    killContainer('sess-1', 'test-exit');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));

    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(false);
    expect(verifyMailboxToken(`Bearer ${token}`, 'ag-remote/sess-1')).toBeNull();
    expect(fs.existsSync(workspaceMount().hostPath)).toBe(false);
  });

  it('revokes the token when the driver refuses the spawn', async () => {
    prepare.mockRejectedValue(new Error('boom'));
    await createSession(sessionOf('ag-remote'));
    expect(await wakeContainer(sessionOf('ag-remote'))).toBe(false);
    expect(fs.existsSync(tokenFile('ag-remote'))).toBe(false);
  });
});
