/**
 * OpenShell driver lifecycle against a stateful fake `openshell` CLI, wrapped
 * in the session-events hub exactly as `createSessionDriver` wraps it.
 *
 * The shared conformance suite (`conformance.test.ts`) does not apply
 * verbatim: its harness parses Docker argv and its fixture realizes a
 * single-file mount (/app/CLAUDE.md) that a MicroVM stages rather than binds.
 * The contract properties it pins — refuse before allocating, labels as the
 * adoption identity, idempotent prepare, stop-is-teardown with no terminal,
 * at-most-once terminal, honest corpses, failure taxonomy, describe-only exec —
 * are asserted here against the same contract.
 */
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { FakeOpenShell } from './openshell/fake-openshell.js';
import type { Forwarder } from './openshell/forwarder.js';
import { mapSandboxPhase, OpenShellSessionDriver } from './openshell-driver.js';
import { sandboxName } from './openshell/translate.js';
import { withSessionEvents, type SessionEventsDriver } from './session-events.js';
import type { MountPolicy, SessionSpec } from './types.js';

/** `credentialProviders` is a key only on installs whose gateway attaches OpenShell providers. */
function withProviders(base: SessionSpec, credentialProviders: string[]): SessionSpec {
  return { ...base, credentialProviders } as SessionSpec & { credentialProviders: string[] };
}

const N1 = sandboxName({ installSlug: 'inst', agentGroupId: 'g1', sessionId: 's1' });
const N2 = sandboxName({ installSlug: 'inst', agentGroupId: 'g1', sessionId: 's2' });

let root: string;
let policy: MountPolicy;
let cli: FakeOpenShell;
let forwarders: Array<[number, number]>;
let driver: SessionEventsDriver;
let raw: OpenShellSessionDriver;

function spec(sessionId = 's1', agentGroupId = 'g1'): SessionSpec {
  const ws = path.join(policy.dataRoot, 'v2-sessions', agentGroupId, '.remote-workspace', sessionId);
  const group = path.join(policy.groupsRoot, 'main');
  const ca = path.join(policy.dataRoot, 'onecli', 'ca.pem');
  for (const d of [ws, group, path.dirname(ca)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(ca, 'CA');
  fs.writeFileSync(path.join(group, 'CLAUDE.md'), '# hi');
  return {
    key: { installSlug: 'inst', agentGroupId, sessionId },
    labels: { 'nanoclaw-group-folder': 'main' },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent:test',
        env: { TZ: 'UTC' },
        contributedEnv: {
          HTTPS_PROXY: 'http://x:aoc_secret@host.docker.internal:10255',
          NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
          NANOCLAW_MAILBOX_URL: 'http://host.docker.internal:18770/v1/mailbox',
          NANOCLAW_MAILBOX_TOKEN: 'mbx-secret-token',
          NANOCLAW_MAILBOX_SESSION: `${agentGroupId}/${sessionId}`,
        },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        mounts: [
          { class: 'group-state', hostPath: ws, containerPath: '/workspace', mode: 'rw', groupScope: agentGroupId },
          {
            class: 'group-state',
            hostPath: group,
            containerPath: '/workspace/agent',
            mode: 'rw',
            groupScope: agentGroupId,
          },
          {
            class: 'group-state',
            hostPath: path.join(group, 'CLAUDE.md'),
            containerPath: '/workspace/agent/CLAUDE.md',
            mode: 'ro',
            groupScope: agentGroupId,
          },
          {
            class: 'allowlisted-extra',
            hostPath: ca,
            containerPath: '/tmp/onecli-gateway-ca.pem',
            mode: 'ro',
            groupScope: agentGroupId,
          },
        ],
      },
    ],
    network: 'shared-private',
    networkAccess: { endpoint: 'host.docker.internal', target: { kind: 'runtime', identity: 'onecli' } },
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 1,
  };
}

function makeDriver(pollMs = 5): void {
  raw = new OpenShellSessionDriver({
    ...policy,
    cli,
    forwardPort: 18755,
    stagingRoot: path.join(policy.dataRoot, 'openshell-staging'),
    pollMs,
    startForwarder: async (listenPort, targetPort): Promise<Forwarder> => {
      forwarders.push([listenPort, targetPort]);
      return { listenPort, targetPort, close: async () => {} };
    },
  });
  driver = withSessionEvents(raw);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-openshell-')));
  policy = {
    groupsRoot: path.join(root, 'groups'),
    dataRoot: path.join(root, 'data'),
    surfaceRoots: [path.join(root, 'container', 'agent-runner', 'src')],
    materialsRoot: path.join(root, 'data', 'session-materials'),
    gatewayTrustRoot: path.join(root, 'data', 'gateway-trust'),
  };
  cli = new FakeOpenShell();
  forwarders = [];
  makeDriver();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const staging = (name: string) => path.join(policy.dataRoot, 'openshell-staging', name);

describe('prepare', () => {
  it('refuses a policy violation before touching the runtime', async () => {
    const s = spec();
    s.containers[0].env.SERVICE_TOKEN = 'shhh';
    await expect(driver.prepare(s)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(cli.calls).toEqual([]);
  });

  it('allocates staging and policy but starts nothing', async () => {
    const handle = await driver.prepare(spec());
    expect(handle.name).toBe(N1);
    expect(N1).toMatch(/^nc-inst-[0-9a-f]{11}$/);
    expect(cli.calls.map((c) => c.args[1])).toEqual(['get', 'lint']);
    const lint = cli.calls.find((c) => c.args[1] === 'lint')!.args;
    expect(lint).toEqual(['policy', 'lint', path.join(staging(N1), 'policy.yaml')]);
    expect(fs.readFileSync(path.join(staging(N1), 'files', '0-onecli-gateway-ca.pem'), 'utf8')).toBe('CA');
    expect(fs.readFileSync(path.join(staging(N1), 'policy.yaml'), 'utf8')).toContain('host.openshell.internal');
    expect(await handle.status()).toEqual({ phase: 'ready' });
  });

  it('fails the spawn, non-retryably and with the lint output, when the policy does not lint', async () => {
    cli.failNext.push({ match: /^policy lint/, message: 'Command failed\nerror: network_policies.x: bad host' });
    const err = await driver.prepare(spec()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect((err as Error).message).toContain('bad host');
    expect(fs.existsSync(staging(N1))).toBe(false);
  });

  it('skips lint with one warning when the CLI has no `policy lint`', async () => {
    const { log } = await import('../log.js');
    vi.mocked(log.warn).mockClear();
    cli.lintUnsupported = true;
    await driver.prepare(spec('s1'));
    await driver.prepare(spec('s2'));
    expect(cli.calls.filter((c) => c.args[1] === 'lint')).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls.filter((c) => /policy lint/.test(String(c[0])))).toHaveLength(1);
  });

  it('is idempotent on key: a live sandbox wearing our labels is the session', async () => {
    await (await driver.prepare(spec())).start();
    const again = await driver.prepare(spec());
    expect(again.name).toBe(N1);
    expect(cli.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
  });

  it('refuses to alias a sandbox that wears another session’s labels', async () => {
    cli.boxes.set(N1, {
      name: N1,
      phase: 'Ready',
      exit_code: null,
      labels: { 'nanoclaw-install': 'other', 'nanoclaw-group': 'g1', 'nanoclaw-session': 's1' },
      annotations: {},
    });
    await expect(driver.prepare(spec())).rejects.toMatchObject({
      kind: 'unknown',
      opaqueRef: `name-collision-${N1}`,
    });
  });

  it('replaces a corpse left under our name', async () => {
    await (await driver.prepare(spec())).start();
    cli.boxes.get(N1)!.phase = 'Error';
    await (await driver.prepare(spec())).start();
    expect(cli.calls.map((c) => c.args[1])).toContain('delete');
    expect(cli.boxes.get(N1)!.phase).toBe('Ready');
  });
});

describe('start', () => {
  it('creates the sandbox from the translated plan, secrets off argv', async () => {
    const handle = await driver.prepare(spec());
    await handle.start();
    const args = cli.argsOf('create')!;
    const env = cli.calls.find((c) => c.args[1] === 'create')!.env!;

    expect(args.slice(0, 6)).toEqual(['sandbox', 'create', '--name', N1, '--from', 'nanoclaw-agent:test']);
    expect(args[args.indexOf('--policy') + 1]).toBe(path.join(staging(N1), 'policy.yaml'));
    const vm = JSON.parse(args[args.indexOf('--driver-config-json') + 1]);
    expect(vm.vm.mounts.map((m: { target: string }) => m.target)).toEqual([
      '/workspace',
      '/opt/nanoclaw-mounts/0-agent',
      '/opt/nanoclaw-files',
      // Driver-owned share for the runner's output (OpenShell doesn't capture it).
      '/opt/nanoclaw-logs',
    ]);
    expect(args).toContain('--detach');
    expect(args).toContain('nanoclaw-session=s1');
    expect(args).toContain('nanoclaw-forward=18755:10255');
    expect(args).toContain('TZ=UTC');
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      'bash',
      '-c',
      'exec > >(while IFS= read -r l; do printf \'%s %s\\n\' "$EPOCHREALTIME" "$l"; done >> /opt/nanoclaw-logs/runner.log) 2>&1 && ' +
        'export HOME=/home/node && export HTTPS_PROXY="$NANOCLAW_RESTORE_HTTPS_PROXY" && unset NANOCLAW_RESTORE_HTTPS_PROXY && ' +
        'export NODE_EXTRA_CA_CERTS="$NANOCLAW_RESTORE_NODE_EXTRA_CA_CERTS" && unset NANOCLAW_RESTORE_NODE_EXTRA_CA_CERTS && ' +
        "export AGENT_BROWSER_ARGS='--no-sandbox,--no-zygote' && " +
        "mkdir -p '/workspace' && ln -sfnT '/opt/nanoclaw-mounts/0-agent' '/workspace/agent' && exec bun run /app/src/index.ts",
    ]);

    // Contributed values travel by reference: never in the argv.
    expect(args.join(' ')).not.toContain('mbx-secret-token');
    expect(args.join(' ')).not.toContain('aoc_secret');
    const refs = Object.fromEntries(
      args.flatMap((a, i) => (a === '--env-from' ? [args[i + 1].split('=') as [string, string]] : [])),
    );
    const passed = (key: string) => env[refs[key]];
    expect(passed('NANOCLAW_MAILBOX_TOKEN')).toBe('mbx-secret-token');
    expect(passed('NANOCLAW_RESTORE_HTTPS_PROXY')).toBe('http://x:aoc_secret@host.openshell.internal:18755');
    expect(passed('NANOCLAW_MAILBOX_URL')).toBe('http://host.openshell.internal:18770/v1/mailbox');
    expect(passed('NANOCLAW_RESTORE_NODE_EXTRA_CA_CERTS')).toBe('/opt/nanoclaw-files/0-onecli-gateway-ca.pem');

    expect(forwarders).toEqual([[18755, 10255]]);
    expect(await handle.status()).toEqual({ phase: 'running' });
  });

  it('attaches credential providers by name and never auto-creates one', async () => {
    const handle = await driver.prepare(withProviders(spec(), ['nc-claude-lab', 'nc-github-lab']));
    await handle.start();
    const args = cli.argsOf('create')!;
    const flags = args.slice(0, args.indexOf('--'));
    expect(flags.flatMap((a, i) => (a === '--provider' ? [args[i + 1]] : []))).toEqual([
      'nc-claude-lab',
      'nc-github-lab',
    ]);
    expect(flags).toContain('--no-auto-providers');
    expect(flags).not.toContain('--auto-providers');
  });

  it('adds no provider flags for a session without credential providers', async () => {
    const handle = await driver.prepare(spec());
    await handle.start();
    const args = cli.argsOf('create')!;
    expect(args).not.toContain('--provider');
    expect(args).not.toContain('--no-auto-providers');
  });

  it('refuses a provider name that is not a plain name', async () => {
    await expect(driver.prepare(withProviders(spec(), ['--gateway=evil']))).rejects.toMatchObject({
      kind: 'spec-invalid',
    });
  });

  it('maps runtime failures into the taxonomy and leaves nothing behind', async () => {
    const handle = await driver.prepare(spec());
    cli.failNext.push({ match: /^sandbox create/, message: 'transport error: connection refused' });
    await expect(handle.start()).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
    expect(cli.calls.at(-1)!.args.slice(0, 2)).toEqual(['sandbox', 'delete']);

    const h2 = await driver.prepare(spec('s2'));
    cli.failNext.push({ match: /^sandbox create/, message: `${policy.dataRoot}/onecli/secret: permission denied` });
    await expect(h2.start()).rejects.toThrow(/^session realization failed: unknown$/);
  });
});

describe('status, stop and terminals', () => {
  it('maps OpenShell phases', () => {
    expect(mapSandboxPhase('Ready', null).status).toEqual({ phase: 'running' });
    expect(mapSandboxPhase('Provisioning', null)).toMatchObject({ listed: 'starting', status: { phase: 'running' } });
    expect(mapSandboxPhase('Completed', 0)).toMatchObject({ listed: 'terminal', status: { phase: 'stopped' } });
    expect(mapSandboxPhase('Error', 3)).toMatchObject({
      listed: 'terminal',
      status: { phase: 'failed', failure: { kind: 'started-then-died', exitCode: 3 } },
    });
  });

  it('fires one terminal, with the exit code, for a sandbox that died on its own', async () => {
    const handle = await driver.prepare(spec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();
    await wait(20);
    cli.boxes.get(N1)!.phase = 'Error';
    cli.boxes.get(N1)!.exit_code = 3;
    await wait(60);
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith({ kind: 'started-then-died', retryable: false, exitCode: 3 });
  });

  it('stop is full teardown and reports no terminal', async () => {
    const handle = await driver.prepare(spec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();
    await handle.stop('host-shutdown');
    await wait(30);
    expect(terminal).not.toHaveBeenCalled();
    expect(cli.boxes.has(N1)).toBe(false);
    expect(fs.existsSync(staging(N1))).toBe(false);
  });
});

describe('discovery and residue', () => {
  it('rebuilds handles from labels alone, lists corpses honestly, ignores other installs', async () => {
    await (await driver.prepare(spec('s1'))).start();
    await (await driver.prepare(spec('s2'))).start();
    cli.boxes.get(N2)!.phase = 'Error';
    cli.boxes.get(N2)!.exit_code = 1;
    cli.boxes.set('foreign', {
      name: 'foreign',
      phase: 'Ready',
      exit_code: null,
      labels: {
        'nanoclaw-install': 'someone-else',
        'nanoclaw-role': 'agent',
        'nanoclaw-group': 'g',
        'nanoclaw-session': 'x',
      },
      annotations: {},
    });

    makeDriver(); // a fresh host: no memory of what it prepared
    forwarders = [];
    const snapshots = await driver.listSessions('inst');
    expect(snapshots.map((s) => [s.handle.key, s.phase])).toEqual([
      [{ installSlug: 'inst', agentGroupId: 'g1', sessionId: 's1' }, 'running'],
      [{ installSlug: 'inst', agentGroupId: 'g1', sessionId: 's2' }, 'terminal'],
    ]);
    expect(snapshots[1].failure).toMatchObject({ exitCode: 1 });
    // Adopted live sandboxes get their proxy hop back.
    expect(forwarders).toEqual([[18755, 10255]]);
  });

  it('reaps terminal sandboxes and orphaned staging of this install only', async () => {
    await (await driver.prepare(spec('s1'))).start();
    await (await driver.prepare(spec('s2'))).start();
    cli.boxes.get(N2)!.phase = 'Completed';
    fs.mkdirSync(staging('nc-inst-gone'), { recursive: true });
    fs.mkdirSync(staging('nc-otherinst-s9'), { recursive: true });
    await driver.reapResidue!('inst');
    expect([...cli.boxes.keys()]).toEqual([N1]);
    expect(fs.existsSync(staging(N1))).toBe(true);
    expect(fs.existsSync(staging(N2))).toBe(false);
    expect(fs.existsSync(staging('nc-inst-gone'))).toBe(false);
    expect(fs.existsSync(staging('nc-otherinst-s9'))).toBe(true);
  });
});

describe('surface', () => {
  it('describes exec without running it', async () => {
    const handle = await driver.prepare(spec());
    const before = cli.calls.length;
    const exec = handle.execSpec(['bash', '-lc', 'echo hi']);
    expect(exec.bin).toBe('openshell');
    expect(exec.argsTty.slice(-3)).toEqual(['bash', '-lc', 'echo hi']);
    expect(exec.argsPlain).toEqual(['sandbox', 'exec', '-n', N1, '--no-tty', '--', 'bash', '-lc', 'echo hi']);
    expect(cli.calls).toHaveLength(before);
  });

  it('declares capabilities honestly', async () => {
    expect(driver.capabilities()).toEqual({
      isolationTiers: ['vm', 'container'],
      credentialProviders: true,
      admissionEnforced: false,
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
    });
    await expect(driver.reconcileNetworkAccess!(spec().networkAccess, await driver.prepare(spec()))).resolves.toBe(
      'kept',
    );
  });

  it('ensureReady requires a connected gateway', async () => {
    await expect(driver.ensureReady!()).resolves.toBeUndefined();
    cli.statusOutput = 'Status: Disconnected';
    await expect(driver.ensureReady!()).rejects.toMatchObject({ kind: 'runtime-unavailable' });
  });
});

describe('event delivery context', () => {
  it("delivers events outside the emitter's async context (no inherited mailbox scope)", () => {
    // stop() runs inside a session's mailbox scope (the idle sweep); a subscriber
    // that queues a reconcile must not inherit it, or the reconcile trips the
    // nested-mailbox-session guard.
    const scope = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const key = { installSlug: 'inst', agentGroupId: 'ag-1', sessionId: 's1' };
    const watch = raw.watchSessions('inst', () => seen.push(scope.getStore()));
    scope.run('held-mailbox-scope', () => raw.emit({ key, kind: 'terminal' }));
    watch.stop();
    expect(seen).toEqual([undefined]);
  });
});
