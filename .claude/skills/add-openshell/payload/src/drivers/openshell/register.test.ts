/**
 * The `openshell` kind through the real drivers barrel, and its stacking under
 * the remote-mailbox driver: a listed group's spec is rewritten by the mailbox
 * driver first and then reaches the OpenShell driver, whose translation
 * realizes it. Only the OpenShell runtime itself is replaced (a recorder).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSpec } from '../types.js';

const fake = vi.hoisted(() => ({
  openshellGroups: [] as string[],
  inner: 'docker',
  prepared: [] as unknown[],
}));
const ROOT = `/tmp/nanoclaw-test-openshell-register-${process.pid}`;

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  const root = `/tmp/nanoclaw-test-openshell-register-${process.pid}`;
  return { ...actual, DATA_DIR: `${root}/data`, GROUPS_DIR: `${root}/groups`, EGRESS_LOCKDOWN: false };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get OPENSHELL_GROUPS() {
      return fake.openshellGroups;
    },
  };
});
vi.mock('../../mailbox/remote/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../mailbox/remote/config.js')>(
    '../../mailbox/remote/config.js',
  );
  return {
    ...actual,
    REMOTE_MAILBOX_GROUPS: ['g-vm'],
    MAILBOX_PORT: 18999,
    get REMOTE_MAILBOX_INNER_DRIVER() {
      return fake.inner;
    },
  };
});
// The runtime edge: records what the OpenShell driver would realize.
vi.mock('../openshell-driver.js', () => ({
  OpenShellSessionDriver: class {
    readonly kind = 'openshell';
    capabilities() {
      return {
        isolationTiers: ['vm', 'container'],
        admissionEnforced: false,
        networkPolicy: 'declarative',
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: false,
      };
    }
    async prepare(spec: SessionSpec) {
      fake.prepared.push(spec);
      return {
        key: spec.key,
        name: 'nc-test',
        start: async () => {},
        stop: async () => {},
        status: async () => ({ phase: 'running' as const }),
        execSpec: () => ({ bin: 'openshell', argsTty: [], argsPlain: [] }),
      };
    }
    async listSessions() {
      return [];
    }
    watchSessions() {
      return { stop() {} };
    }
  },
}));

import { log } from '../../log.js';
import { createSessionDriver, listSessionDriverKinds, mountPolicy } from '../index.js';
import { OPENSHELL_HOST, translateSpec } from './translate.js';
import { OPENSHELL_DRIVER_KIND, warnIfNotStacked } from './register.js';

beforeEach(() => {
  fake.openshellGroups = [];
  fake.inner = 'docker';
  fake.prepared = [];
});
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function vmSpec(): SessionSpec {
  const policy = mountPolicy();
  const sessionDir = `${policy.dataRoot}/v2-sessions/g-vm/s1`;
  const runnerSrc = policy.surfaceRoots[0];
  return {
    key: { installSlug: 'test', agentGroupId: 'g-vm', sessionId: 's1' },
    labels: {},
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent:test',
        env: { TZ: 'UTC' },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        mounts: [
          { class: 'group-state', hostPath: sessionDir, containerPath: '/workspace', mode: 'rw', groupScope: 'g-vm' },
          { class: 'install-surface', hostPath: runnerSrc, containerPath: '/app/src', mode: 'ro', groupScope: 'g-vm' },
        ],
      },
    ],
    network: 'shared-private',
    networkAccess: { endpoint: 'host.docker.internal', target: { kind: 'host' } },
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 1,
  };
}

describe('registration', () => {
  it('the real drivers barrel registers the openshell kind beside docker and remote-mailbox', () => {
    expect(listSessionDriverKinds()).toEqual(
      expect.arrayContaining(['docker', 'remote-mailbox', OPENSHELL_DRIVER_KIND]),
    );
  });

  it('is the docker driver itself while no group is listed', () => {
    expect(createSessionDriver(OPENSHELL_DRIVER_KIND).kind).toBe('docker');
  });

  it('routes listed groups to OpenShell, everything else to docker', () => {
    fake.openshellGroups = ['g-vm'];
    expect(createSessionDriver(OPENSHELL_DRIVER_KIND).kind).toBe('docker+openshell');
  });
});

describe('stacked under the remote mailbox', () => {
  it('a listed group: mailbox rewrite first, then OpenShell realizes it', async () => {
    fake.openshellGroups = ['g-vm'];
    fake.inner = OPENSHELL_DRIVER_KIND;
    const driver = createSessionDriver('remote-mailbox');
    expect(driver.kind).toBe('remote-mailbox(docker+openshell)');

    await driver.prepare(vmSpec());
    expect(fake.prepared).toHaveLength(1);
    const spec = fake.prepared[0] as SessionSpec;
    const agent = spec.containers[0];
    expect(agent.contributedEnv?.NANOCLAW_MAILBOX_URL).toBe('http://host.docker.internal:18999/v1/mailbox');
    expect(agent.env.NANOCLAW_HEARTBEAT_PATH).toBe('/opt/nanoclaw-heartbeat/heartbeat');

    // Every mount the mailbox driver hands over is a directory the VM can mount.
    for (const m of agent.mounts) fs.mkdirSync(m.hostPath, { recursive: true });
    const plan = translateSpec(spec, {
      name: 'nc-test',
      stagingFilesDir: `${ROOT}/staging`,
      forwardPort: 18755,
      probe: { kind: (p) => (fs.existsSync(p) ? 'dir' : 'missing'), realpath: (p) => p },
    });
    const env = { ...plan.env, ...plan.contributedEnv };
    expect(env.NANOCLAW_MAILBOX_URL).toBe(`http://${OPENSHELL_HOST}:18999/v1/mailbox`);
    expect(env.NANOCLAW_HEARTBEAT_PATH).toBe('/opt/nanoclaw-heartbeat/heartbeat');
    expect(plan.mounts.map((m) => m.target)).toEqual(['/workspace', '/app/src', '/opt/nanoclaw-heartbeat']);
    expect(plan.staged).toEqual([]);
  });
});

describe('misconfiguration', () => {
  it('names the missing settings when groups are listed but the stack does not reach OpenShell', () => {
    const error = vi.mocked(log.error);
    error.mockClear();
    warnIfNotStacked({ NANOCLAW_RUNTIME_DRIVER: 'remote-mailbox' }, ['g-vm'], 'openshell');
    warnIfNotStacked({ NANOCLAW_RUNTIME_DRIVER: 'docker' }, [], 'docker');
    expect(error).not.toHaveBeenCalled();
    warnIfNotStacked({ NANOCLAW_RUNTIME_DRIVER: 'remote-mailbox' }, ['g-vm'], 'docker');
    warnIfNotStacked({ NANOCLAW_RUNTIME_DRIVER: 'openshell' }, ['g-vm'], 'openshell');
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toMatch(/NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell/);
  });
});
