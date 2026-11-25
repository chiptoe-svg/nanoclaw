/**
 * Per-group routing: opted-in groups reach OpenShell, every other group
 * reaches the primary (Docker) driver exactly as before — and with no group
 * opted in there is no wrapper at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createSessionDriver } from '../index.js';
import { fixtureSpec } from '../spec-fixture.js';
import type { DriverCapabilities, SessionDriver, SessionHandle, SessionKey, SessionSpec } from '../types.js';
import { GroupRoutedDriver, withOpenShellGroups } from './composite.js';

function caps(kind: string): DriverCapabilities {
  return {
    isolationTiers: ['container'],
    admissionEnforced: false,
    networkPolicy: kind === 'docker' ? 'topology' : 'declarative',
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: false,
    auxiliaryContainers: kind === 'docker',
    imageBuild: kind === 'docker',
  };
}

function handle(key: SessionKey): SessionHandle {
  return {
    key,
    name: `h-${key.sessionId}`,
    start: async () => {},
    status: async () => ({ phase: 'running' }),
    stop: async () => {},
    execSpec: () => ({ bin: 'x', argsTty: [], argsPlain: [] }),
  };
}

function fakeDriver(kind: string) {
  const watchStop = vi.fn();
  const driver = {
    kind,
    capabilities: vi.fn(() => caps(kind)),
    ensureReady: vi.fn(async () => {}),
    reconcileNetworkAccess: vi.fn(async () => (kind === 'docker' ? ('restart' as const) : ('kept' as const))),
    prepare: vi.fn(async (spec: SessionSpec) => handle(spec.key)),
    listSessions: vi.fn(async (installSlug: string) => [
      { handle: handle({ installSlug, agentGroupId: `${kind}-g`, sessionId: `${kind}-s` }), phase: 'running' as const },
    ]),
    watchSessions: vi.fn(() => ({ stop: watchStop })),
    reapResidue: vi.fn(async () => {}),
  } satisfies SessionDriver;
  return { driver, watchStop };
}

let docker: ReturnType<typeof fakeDriver>;
let openshell: ReturnType<typeof fakeDriver>;
let routed: GroupRoutedDriver;

beforeEach(() => {
  docker = fakeDriver('docker');
  openshell = fakeDriver('openshell');
  routed = new GroupRoutedDriver(docker.driver, openshell.driver, {
    groups: ['g-vm'],
    remoteMailboxGroups: ['g-vm'],
  });
});

const specFor = (agentGroupId: string) => fixtureSpec({ key: { installSlug: 'spike', agentGroupId, sessionId: 's1' } });

describe('withOpenShellGroups', () => {
  it('returns the primary driver itself when no group opts in', () => {
    const makeSecondary = vi.fn(() => openshell.driver);
    expect(withOpenShellGroups(docker.driver, { groups: [], remoteMailboxGroups: [] }, makeSecondary)).toBe(
      docker.driver,
    );
    expect(makeSecondary).not.toHaveBeenCalled();
  });

  it('wraps only when a group opts in', () => {
    const d = withOpenShellGroups(
      docker.driver,
      { groups: ['g-vm'], remoteMailboxGroups: ['g-vm'] },
      () => openshell.driver,
    );
    expect(d).toBeInstanceOf(GroupRoutedDriver);
    expect(d.kind).toBe('docker+openshell');
  });

  it('leaves the shipped docker registration untouched', () => {
    // The hub wraps whatever the factory made; its kind is the inner driver's.
    expect(createSessionDriver('docker').kind).toBe('docker');
  });
});

describe('GroupRoutedDriver', () => {
  it('sends non-opted groups to the primary with the very same spec, untouched', async () => {
    const spec = specFor('g-docker');
    await routed.prepare(spec);
    expect(docker.driver.prepare).toHaveBeenCalledWith(spec);
    expect(docker.driver.prepare.mock.calls[0][0]).toBe(spec);
    expect(openshell.driver.prepare).not.toHaveBeenCalled();
  });

  it('sends opted-in groups to OpenShell', async () => {
    await routed.prepare(specFor('g-vm'));
    expect(openshell.driver.prepare).toHaveBeenCalledOnce();
    expect(docker.driver.prepare).not.toHaveBeenCalled();
  });

  it('refuses an opted-in group without the remote mailbox, naming both settings', async () => {
    const strict = new GroupRoutedDriver(docker.driver, openshell.driver, {
      groups: ['g-vm'],
      remoteMailboxGroups: [],
    });
    await expect(strict.prepare(specFor('g-vm'))).rejects.toMatchObject({
      kind: 'spec-invalid',
      detail: expect.stringMatching(/NANOCLAW_OPENSHELL_GROUPS.*NANOCLAW_REMOTE_MAILBOX_GROUPS/),
    });
    expect(openshell.driver.prepare).not.toHaveBeenCalled();
    expect(docker.driver.prepare).not.toHaveBeenCalled();
  });

  it('reports the primary capabilities install-wide', () => {
    expect(routed.capabilities()).toEqual(caps('docker'));
  });

  it('merges discovery from both, and survives an unreachable OpenShell gateway', async () => {
    const all = await routed.listSessions('spike');
    expect(all.map((s) => s.handle.key.sessionId)).toEqual(['docker-s', 'openshell-s']);
    openshell.driver.listSessions.mockRejectedValueOnce(new Error('gateway down'));
    const dockerOnly = await routed.listSessions('spike');
    expect(dockerOnly.map((s) => s.handle.key.sessionId)).toEqual(['docker-s']);
  });

  it('routes network reconciliation by the key the secondary produced, not handle identity', async () => {
    await routed.listSessions('spike');
    // A different object for the same key — what the session-events hub hands out.
    const vmKey = { installSlug: 'spike', agentGroupId: 'openshell-g', sessionId: 'openshell-s' };
    const dockerKey = { installSlug: 'spike', agentGroupId: 'docker-g', sessionId: 'docker-s' };
    const access = specFor('x').networkAccess;
    await expect(routed.reconcileNetworkAccess(access, handle(vmKey))).resolves.toBe('kept');
    await expect(routed.reconcileNetworkAccess(access, handle(dockerKey))).resolves.toBe('restart');
    expect(openshell.driver.reconcileNetworkAccess).toHaveBeenCalledOnce();
    expect(docker.driver.reconcileNetworkAccess).toHaveBeenCalledOnce();
  });

  it('keeps Docker readiness fatal and OpenShell readiness advisory', async () => {
    openshell.driver.ensureReady.mockRejectedValueOnce(new Error('no gateway'));
    await expect(routed.ensureReady()).resolves.toBeUndefined();
    docker.driver.ensureReady.mockRejectedValueOnce(new Error('no docker'));
    await expect(routed.ensureReady()).rejects.toThrow('no docker');
  });

  it('watches and reaps both runtimes', async () => {
    const onEvent = vi.fn();
    routed.watchSessions('spike', onEvent).stop();
    expect(docker.watchStop).toHaveBeenCalledOnce();
    expect(openshell.watchStop).toHaveBeenCalledOnce();
    openshell.driver.reapResidue.mockRejectedValueOnce(new Error('down'));
    await expect(routed.reapResidue('spike')).resolves.toBeUndefined();
    expect(docker.driver.reapResidue).toHaveBeenCalledWith('spike');
  });
});
