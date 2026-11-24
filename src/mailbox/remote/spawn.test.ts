import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ groups: [] as string[], lockdown: false }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get REMOTE_MAILBOX_GROUPS() {
      return cfg.groups;
    },
    get EGRESS_LOCKDOWN() {
      return cfg.lockdown;
    },
    MAILBOX_PORT: 18770,
  };
});
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '../../log.js';
import { isRemoteMailboxGroup, remoteMailboxEnabled, warnIfRelayMustForwardMailbox } from './spawn.js';

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
