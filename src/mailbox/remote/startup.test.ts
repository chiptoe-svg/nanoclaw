import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enabled, start, warn } = vi.hoisted(() => ({ enabled: vi.fn(), start: vi.fn(), warn: vi.fn() }));
vi.mock('./spawn.js', () => ({ remoteMailboxEnabled: enabled, warnIfRelayMustForwardMailbox: warn }));
vi.mock('./service.js', () => ({ startRemoteMailboxService: start }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '../../log.js';
import { startRemoteMailboxServiceIfEnabled } from './startup.js';

beforeEach(() => vi.clearAllMocks());

describe('startRemoteMailboxServiceIfEnabled', () => {
  it('does not start the service when no group opted in', async () => {
    enabled.mockReturnValue(false);
    expect(await startRemoteMailboxServiceIfEnabled(18770)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('starts it on the configured port, logs the port, and checks the relay', async () => {
    enabled.mockReturnValue(true);
    const service = { port: 18770, stop: vi.fn() };
    start.mockResolvedValue(service);
    expect(await startRemoteMailboxServiceIfEnabled(18770)).toBe(service);
    expect(start).toHaveBeenCalledWith({ port: 18770 });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Remote mailbox'), { port: 18770 });
    expect(warn).toHaveBeenCalled();
  });
});
