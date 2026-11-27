import { describe, expect, it, vi } from 'vitest';

import { decideIdleStop, stopIdleSessions, type IdleInputs, type IdleProbe } from './idle-stop.js';

const NOW = 1_000_000_000;
const base: IdleInputs = {
  now: NOW,
  heartbeatMtimeMs: 0,
  startedAtMs: NOW - 10 * 60_000,
  bashTimeoutMs: null,
  claims: 0,
  due: 0,
};
const IDLE = 5 * 60_000;

describe('decideIdleStop', () => {
  it('stops once the latest sign of life is older than the idle window', () => {
    expect(decideIdleStop(IDLE, { ...base, heartbeatMtimeMs: NOW - 6 * 60_000 })).toBe(true);
    expect(decideIdleStop(IDLE, { ...base, heartbeatMtimeMs: NOW - 4 * 60_000 })).toBe(false);
  });

  it('treats a heartbeat from before this incarnation as absent (spawn time stands in)', () => {
    expect(decideIdleStop(IDLE, { ...base, heartbeatMtimeMs: NOW - 60 * 60_000, startedAtMs: NOW - 60_000 })).toBe(
      false,
    );
    expect(decideIdleStop(IDLE, { ...base, heartbeatMtimeMs: 0, startedAtMs: NOW - 6 * 60_000 })).toBe(true);
  });

  it('never stops a VM with a claimed or waiting message, and honours a longer declared Bash timeout', () => {
    expect(decideIdleStop(IDLE, { ...base, claims: 1 })).toBe(false);
    expect(decideIdleStop(IDLE, { ...base, due: 1 })).toBe(false);
    expect(decideIdleStop(IDLE, { ...base, bashTimeoutMs: 20 * 60_000 })).toBe(false);
    expect(decideIdleStop(IDLE, { ...base, bashTimeoutMs: 2 * 60_000 })).toBe(true);
  });

  it('is off at 0 and without a tracked start', () => {
    expect(decideIdleStop(0, base)).toBe(false);
    expect(decideIdleStop(IDLE, { ...base, startedAtMs: undefined })).toBe(false);
  });
});

describe('stopIdleSessions', () => {
  const key = (sessionId: string) => ({ installSlug: 'i', agentGroupId: 'ag-1', sessionId });

  it('stops only the idle sessions and survives a failing read', async () => {
    const stop = vi.fn();
    const probe: IdleProbe = {
      read: async (k) => {
        if (k.sessionId === 'boom') throw new Error('db gone');
        if (k.sessionId === 'gone') return undefined;
        return { ...base, heartbeatMtimeMs: k.sessionId === 'idle' ? NOW - 6 * 60_000 : NOW - 1_000 };
      },
      stop,
    };
    await stopIdleSessions([key('boom'), key('gone'), key('busy'), key('idle')], IDLE, probe, NOW);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(key('idle'));
  });
});
