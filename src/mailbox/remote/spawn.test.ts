import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  groups: [] as string[],
  lockdown: false,
  dataDir: `${process.env.TMPDIR ?? '/tmp'}/nanoclaw-spawn-test-${process.pid}`,
}));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get EGRESS_LOCKDOWN() {
      return cfg.lockdown;
    },
    get DATA_DIR() {
      return cfg.dataDir;
    },
  };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get REMOTE_MAILBOX_GROUPS() {
      return cfg.groups;
    },
    MAILBOX_PORT: 18770,
  };
});
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '../../log.js';
import fs from 'fs';
import path from 'path';

import { parseMailboxPort, parseRemoteMailboxGroups } from './config.js';
import {
  hasRemoteMailboxState,
  isRemoteMailboxGroup,
  issueRemoteMailboxEnv,
  prepareRemoteHeartbeat,
  prepareRemoteWorkspace,
  releaseRemoteMailbox,
  remoteHeartbeatFile,
  sessionHeartbeatPath,
  remoteMailboxEnabled,
  warnIfRelayMustForwardMailbox,
  withdrawRemoteMailboxEnv,
} from './spawn.js';
import { verifyMailboxToken } from './tokens.js';

beforeEach(() => {
  vi.clearAllMocks();
  cfg.groups = [];
  cfg.lockdown = false;
});

describe('remote mailbox opt-in', () => {
  it('is off for every group when the list is empty', () => {
    expect(remoteMailboxEnabled()).toBe(false);
    expect(isRemoteMailboxGroup('ag-1')).toBe(false);
  });

  it('matches only listed groups', () => {
    cfg.groups = ['ag-1'];
    expect(remoteMailboxEnabled()).toBe(true);
    expect(isRemoteMailboxGroup('ag-1')).toBe(true);
    expect(isRemoteMailboxGroup('ag-2')).toBe(false);
  });

  it('warns about the relay only when enabled under egress lockdown', () => {
    cfg.groups = ['ag-1'];
    warnIfRelayMustForwardMailbox();
    expect(log.warn).not.toHaveBeenCalled();
    cfg.lockdown = true;
    warnIfRelayMustForwardMailbox();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('18770'), expect.anything());
    vi.clearAllMocks();
    cfg.groups = [];
    warnIfRelayMustForwardMailbox();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('spawn attempts never disturb a runtime that is still live', () => {
  const key = { agentGroupId: 'ag-live', sessionId: 'sess-live' };
  const header = 'ag-live/sess-live';

  beforeEach(() => fs.rmSync(cfg.dataDir, { recursive: true, force: true }));

  it('a failed spawn withdraws only its own token; the live runtime keeps working', () => {
    const live = issueRemoteMailboxEnv(key).NANOCLAW_MAILBOX_TOKEN;
    const failed = issueRemoteMailboxEnv(key);
    withdrawRemoteMailboxEnv(key, failed);
    expect(verifyMailboxToken(`Bearer ${failed.NANOCLAW_MAILBOX_TOKEN}`, header)).toBeNull();
    expect(verifyMailboxToken(`Bearer ${live}`, header)).toEqual(key);
  });

  it('preparing the workspace never clears what a live runtime already has there', () => {
    const dir = prepareRemoteWorkspace(key);
    fs.mkdirSync(path.join(dir, 'outbox', 'msg-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outbox', 'msg-1', 'report.txt'), 'pending upload');
    expect(prepareRemoteWorkspace(key)).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'outbox', 'msg-1', 'report.txt'), 'utf8')).toBe('pending upload');
  });
});

describe('settings', () => {
  it('parses the group list and port like every other host setting', () => {
    expect(parseRemoteMailboxGroups(' ag-1, ,ag-2 ')).toEqual(['ag-1', 'ag-2']);
    expect(parseRemoteMailboxGroups('')).toEqual([]);
    expect(parseMailboxPort('18999')).toBe(18999);
    expect(parseMailboxPort('')).toBe(18770);
    expect(parseMailboxPort('70000')).toBe(18770);
  });
});

describe('heartbeat link', () => {
  const key = { agentGroupId: 'ag-hb', sessionId: 'sess-hb' };

  beforeEach(() => fs.rmSync(cfg.dataDir, { recursive: true, force: true }));

  it('links a fresh heartbeat (mtime 0, read as absent) at the session heartbeat path', () => {
    const file = prepareRemoteHeartbeat(key);
    expect(file).toBe(remoteHeartbeatFile(key));
    expect(fs.statSync(sessionHeartbeatPath(key)).mtimeMs).toBe(0);
    const now = new Date();
    fs.utimesSync(file, now, now);
    expect(fs.statSync(sessionHeartbeatPath(key)).mtimeMs).toBe(fs.statSync(file).mtimeMs);
  });

  it('re-links the same file after the host deletes the session heartbeat, so a reused runtime stays visible', () => {
    const file = prepareRemoteHeartbeat(key);
    const now = new Date();
    fs.utimesSync(file, now, now);
    fs.rmSync(sessionHeartbeatPath(key));
    prepareRemoteHeartbeat(key);
    expect(fs.statSync(sessionHeartbeatPath(key)).ino).toBe(fs.statSync(file).ino);
    expect(fs.statSync(sessionHeartbeatPath(key)).mtimeMs).toBeGreaterThan(0);
  });

  it('release removes the token, the scratch dir and the heartbeat file', () => {
    issueRemoteMailboxEnv(key);
    prepareRemoteWorkspace(key);
    prepareRemoteHeartbeat(key);
    expect(hasRemoteMailboxState(key)).toBe(true);
    releaseRemoteMailbox(key);
    expect(hasRemoteMailboxState(key)).toBe(false);
  });
});
