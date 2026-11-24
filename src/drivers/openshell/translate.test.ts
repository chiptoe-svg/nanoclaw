import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import type { MountSpec, SessionSpec } from '../types.js';
import {
  effectiveEnv,
  OPENSHELL_FILES_DIR,
  sandboxName,
  translateSpec,
  type MountProbe,
  type TranslateOptions,
} from './translate.js';

const G = '/inst/groups/main';
const D = '/inst/data';

/** Host facts as literals: which sources are dirs, which are files, what symlinks resolve to. */
function probe(dirs: string[], files: string[], links: Record<string, string> = {}): MountProbe {
  return {
    kind: (p) => (dirs.includes(p) ? 'dir' : files.includes(p) ? 'file' : 'missing'),
    realpath: (p) => links[p] ?? p,
  };
}

function mount(hostPath: string, containerPath: string, mode: 'rw' | 'ro' = 'rw'): MountSpec {
  return { class: 'group-state', hostPath, containerPath, mode, groupScope: 'g1' };
}

/** The mount/env shape a real remote-mailbox NanoClaw session composes today. */
function realisticSpec(overrides: { contributedEnv?: Record<string, string> } = {}): SessionSpec {
  return {
    key: { installSlug: 'e85a96b1', agentGroupId: 'g1', sessionId: 'sess-1' },
    labels: { 'nanoclaw-group-folder': 'main', 'nanoclaw-container-name': 'nanoclaw-v2-main-1' },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent-v2-e85a96b1:latest',
        env: { TZ: 'UTC', HOME: '/home/node', NANOCLAW_MAILBOX: 'remote' },
        contributedEnv: {
          HTTPS_PROXY: 'http://x:aoc_tok@host.docker.internal:10255',
          HTTP_PROXY: 'http://x:aoc_tok@host.docker.internal:10255',
          https_proxy: 'http://x:aoc_tok@host.docker.internal:10255',
          http_proxy: 'http://x:aoc_tok@host.docker.internal:10255',
          NO_PROXY: 'localhost,127.0.0.1,host.docker.internal',
          SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
          DENO_CERT: '/tmp/onecli-combined-ca.pem',
          NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
          NANOCLAW_MAILBOX_URL: 'http://host.docker.internal:18770/v1/mailbox',
          NANOCLAW_MAILBOX_TOKEN: 'mbx-token',
          NANOCLAW_MAILBOX_SESSION: 'g1/sess-1',
          ...overrides.contributedEnv,
        },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        mounts: [
          mount(`${D}/v2-sessions/g1/.remote-workspace/sess-1`, '/workspace'),
          mount(`${D}/v2-sessions/g1/sess-1/session.json`, '/app/.nanoclaw-session.json', 'ro'),
          mount('/inst/container/skills', '/app/skills', 'ro'),
          mount('/inst/container/agent-runner/src', '/app/src', 'ro'),
          mount(`${D}/onecli/combined-abc.pem`, '/tmp/onecli-combined-ca.pem', 'ro'),
          mount(`${D}/onecli/ca-def.pem`, '/tmp/onecli-gateway-ca.pem', 'ro'),
          mount(G, '/workspace/agent'),
          mount(`${D}/v2-sessions/g1/.claude-shared`, '/home/node/.claude'),
          mount(`${G}/CLAUDE.md`, '/workspace/agent/CLAUDE.md', 'ro'),
          mount(`${G}/container.json`, '/workspace/agent/container.json', 'ro'),
          mount(`${G}/plugins`, '/workspace/agent/plugins', 'ro'),
        ],
      },
    ],
    network: 'shared-private',
    networkAccess: { endpoint: 'host.docker.internal', target: { kind: 'runtime', identity: 'onecli' } },
    hardening: 'standard',
    resources: { pidsLimit: 2048, shmSizeMb: 1024 },
    runtimeTier: 'container',
    runAs: { uid: 501, gid: 20 },
    stopGraceSeconds: 5,
  };
}

const realisticProbe = probe(
  [
    `${D}/v2-sessions/g1/.remote-workspace/sess-1`,
    '/inst/container/skills',
    '/inst/container/agent-runner/src',
    G,
    `${D}/v2-sessions/g1/.claude-shared`,
    `${G}/plugins`,
  ],
  [
    `${D}/v2-sessions/g1/sess-1/session.json`,
    `${D}/onecli/combined-abc.pem`,
    `${D}/onecli/ca-def.pem`,
    `${G}/CLAUDE.md`,
    `${G}/container.json`,
  ],
);

const opts = (over: Partial<TranslateOptions> = {}): TranslateOptions => ({
  name: 'nc-e85a96b1-sess-1',
  stagingFilesDir: `${D}/openshell-staging/nc-e85a96b1-sess-1/files`,
  forwardPort: 18755,
  probe: realisticProbe,
  ...over,
});

describe('translateSpec: mounts', () => {
  it('maps directory mounts to vm binds and drops files/dirs already visible through their parent', () => {
    const plan = translateSpec(realisticSpec(), opts());
    expect(plan.mounts).toEqual([
      { type: 'bind', source: `${D}/v2-sessions/g1/.remote-workspace/sess-1`, target: '/workspace', read_only: false },
      { type: 'bind', source: '/inst/container/skills', target: '/app/skills', read_only: true },
      { type: 'bind', source: '/inst/container/agent-runner/src', target: '/app/src', read_only: true },
      // Nested in /workspace: VM targets cannot overlap, so it is relocated and linked.
      { type: 'bind', source: G, target: '/opt/nanoclaw-mounts/0-agent', read_only: false },
      { type: 'bind', source: `${D}/v2-sessions/g1/.claude-shared`, target: '/home/node/.claude', read_only: false },
      {
        type: 'bind',
        source: `${D}/openshell-staging/nc-e85a96b1-sess-1/files`,
        target: OPENSHELL_FILES_DIR,
        read_only: true,
      },
    ]);
    expect(plan.dropped.map((d) => [d.containerPath, d.reason, d.readOnlyLost])).toEqual([
      ['/workspace/agent/plugins', 'covered-by-parent', true],
      ['/app/.nanoclaw-session.json', 'session-context-unused', false],
      ['/workspace/agent/CLAUDE.md', 'covered-by-parent', true],
      ['/workspace/agent/container.json', 'covered-by-parent', true],
    ]);
  });

  it('stages files no parent covers and rewrites every env value naming them', () => {
    const plan = translateSpec(realisticSpec(), opts());
    expect(plan.staged).toEqual([
      {
        source: `${D}/onecli/combined-abc.pem`,
        stagedName: '0-onecli-combined-ca.pem',
        target: '/tmp/onecli-combined-ca.pem',
        guestPath: `${OPENSHELL_FILES_DIR}/0-onecli-combined-ca.pem`,
        linked: false,
      },
      {
        source: `${D}/onecli/ca-def.pem`,
        stagedName: '1-onecli-gateway-ca.pem',
        target: '/tmp/onecli-gateway-ca.pem',
        guestPath: `${OPENSHELL_FILES_DIR}/1-onecli-gateway-ca.pem`,
        linked: false,
      },
    ]);
    const env = effectiveEnv(plan);
    expect(env.SSL_CERT_FILE).toBe(`${OPENSHELL_FILES_DIR}/0-onecli-combined-ca.pem`);
    expect(env.DENO_CERT).toBe(`${OPENSHELL_FILES_DIR}/0-onecli-combined-ca.pem`);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(`${OPENSHELL_FILES_DIR}/1-onecli-gateway-ca.pem`);
    // The prelude links only the relocated group dir: every staged file is reached through env.
    expect(plan.relocated).toEqual([{ containerPath: '/workspace/agent', guestPath: '/opt/nanoclaw-mounts/0-agent' }]);
    expect(plan.command[2]).toMatch(
      /&& mkdir -p '\/workspace' && ln -sfnT '\/opt\/nanoclaw-mounts\/0-agent' '\/workspace\/agent' && exec bun run \/app\/src\/index\.ts$/,
    );
    expect(plan.command[2]).not.toContain("ln -sfnT '/opt/nanoclaw-files");
  });

  it('does not rewrite a longer path that merely starts with a staged one', () => {
    const plan = translateSpec(
      realisticSpec({ contributedEnv: { OTHER: '/tmp/onecli-combined-ca.pem.bak:/tmp/onecli-combined-ca.pem' } }),
      opts(),
    );
    expect(effectiveEnv(plan).OTHER).toBe(
      `/tmp/onecli-combined-ca.pem.bak:${OPENSHELL_FILES_DIR}/0-onecli-combined-ca.pem`,
    );
  });

  it('links a staged file no env names into place from the bash -c entrypoint', () => {
    const spec = realisticSpec();
    spec.containers[0].mounts.push(mount(`${D}/onecli/stub-1`, '/home/node/.codex/auth.json', 'ro'));
    const plan = translateSpec(
      spec,
      opts({ probe: { ...realisticProbe, kind: (p) => (p.endsWith('stub-1') ? 'file' : realisticProbe.kind(p)) } }),
    );
    const stub = plan.staged.find((f) => f.target === '/home/node/.codex/auth.json')!;
    expect(stub.linked).toBe(true);
    expect(
      plan.command[2].endsWith(
        "ln -sfnT '/opt/nanoclaw-mounts/0-agent' '/workspace/agent' && " +
          `mkdir -p '/home/node/.codex' && ln -sfnT '${stub.guestPath}' '/home/node/.codex/auth.json' && ` +
          'exec bun run /app/src/index.ts',
      ),
    ).toBe(true);
  });

  it('refuses an unreferenced file outside the writable guest roots', () => {
    const spec = realisticSpec();
    spec.containers[0].mounts.push(mount(`${D}/x.conf`, '/etc/x.conf', 'ro'));
    expect(() =>
      translateSpec(
        spec,
        opts({ probe: { ...realisticProbe, kind: (p) => (p === `${D}/x.conf` ? 'file' : realisticProbe.kind(p)) } }),
      ),
    ).toThrow(/outside the writable guest roots/);
  });

  it('refuses a directory nested inside a read-only mount', () => {
    const spec = realisticSpec();
    spec.containers[0].mounts.push(mount('/elsewhere', '/app/skills/extra'));
    const p = {
      ...realisticProbe,
      kind: (x: string) => (x === '/elsewhere' ? ('dir' as const) : realisticProbe.kind(x)),
    };
    expect(() => translateSpec(spec, opts({ probe: p }))).toThrow(/nests inside read-only mount \/app\/skills/);
  });

  it('refuses the session-context file when the remote mailbox is not in use', () => {
    const spec = realisticSpec();
    delete spec.containers[0].contributedEnv!.NANOCLAW_MAILBOX_SESSION;
    expect(() => translateSpec(spec, opts())).toThrow(/remote mailbox/);
  });

  it('mounts the canonical source of a symlinked directory', () => {
    const spec = realisticSpec();
    const linkProbe = {
      ...realisticProbe,
      realpath: (p: string) => (p === '/inst/container/skills' ? '/real/skills' : p),
    };
    const plan = translateSpec(spec, opts({ probe: linkProbe }));
    expect(plan.mounts.find((m) => m.target === '/app/skills')!.source).toBe('/real/skills');
  });

  it('refuses a missing source and more than 32 mounts', () => {
    const missing = realisticSpec();
    missing.containers[0].mounts.push(mount('/nope', '/workspace/nope'));
    expect(() => translateSpec(missing, opts())).toThrow(/mount source missing: \/nope/);

    const many = realisticSpec();
    const dirs: string[] = [];
    for (let i = 0; i < 30; i++) {
      many.containers[0].mounts.push(mount(`/extra/${i}`, `/mnt/${i}`));
      dirs.push(`/extra/${i}`);
    }
    const p = {
      ...realisticProbe,
      kind: (x: string) => (dirs.includes(x) ? ('dir' as const) : realisticProbe.kind(x)),
    };
    expect(() => translateSpec(many, opts({ probe: p }))).toThrow(/at most 32 mounts/);
  });

  it('refuses auxiliary containers instead of dropping them', () => {
    const spec = realisticSpec();
    spec.containers.push({ role: 'egress-proxy', image: 'x', env: {}, mounts: [] });
    expect(() => translateSpec(spec, opts())).toThrow(/auxiliary containers \(egress-proxy\)/);
  });
});

describe('translateSpec: env', () => {
  it('re-points every proxy URL at the forwarder and records the gateway port as its target', () => {
    const plan = translateSpec(realisticSpec(), opts());
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(effectiveEnv(plan)[key]).toBe('http://x:aoc_tok@host.openshell.internal:18755');
    }
    expect(plan.forward).toEqual({ listenPort: 18755, targetPort: 10255 });
  });

  it('rewrites host.docker.internal everywhere else', () => {
    const plan = translateSpec(realisticSpec(), opts());
    expect(plan.contributedEnv.NANOCLAW_MAILBOX_URL).toBe('http://host.openshell.internal:18770/v1/mailbox');
    expect(effectiveEnv(plan).NO_PROXY).toBe('localhost,127.0.0.1,host.openshell.internal');
    expect(JSON.stringify(plan)).not.toContain('host.docker.internal');
  });

  it('carries OpenShell-reserved keys under an alias and exports them back before exec', () => {
    const spec = realisticSpec();
    spec.containers[0].env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
    const plan = translateSpec(spec, opts());
    expect(plan.contributedEnv).not.toHaveProperty('HTTPS_PROXY');
    expect(plan.contributedEnv.NANOCLAW_RESTORE_HTTPS_PROXY).toBe('http://x:aoc_tok@host.openshell.internal:18755');
    expect(plan.env).not.toHaveProperty('CURL_CA_BUNDLE');
    expect(plan.env.NANOCLAW_RESTORE_CURL_CA_BUNDLE).toBe('/etc/ssl/certs/ca-certificates.crt');
    // Unreserved keys pass under their own names.
    expect(plan.contributedEnv.NANOCLAW_MAILBOX_TOKEN).toBe('mbx-token');
    expect(
      plan.command[2].startsWith(
        'export HOME=/home/node && ' +
          'export CURL_CA_BUNDLE="$NANOCLAW_RESTORE_CURL_CA_BUNDLE" && unset NANOCLAW_RESTORE_CURL_CA_BUNDLE && ' +
          'export HTTPS_PROXY="$NANOCLAW_RESTORE_HTTPS_PROXY" && unset NANOCLAW_RESTORE_HTTPS_PROXY && ',
      ),
    ).toBe(true);
    expect(plan.command[2]).toContain('export NODE_EXTRA_CA_CERTS="$NANOCLAW_RESTORE_NODE_EXTRA_CA_CERTS"');
    // Values never reach the command line, only alias names do.
    expect(plan.command[2]).not.toContain('aoc_tok');
  });

  it('keeps the lanes apart, contributed winning a collision', () => {
    const spec = realisticSpec({ contributedEnv: { TZ: 'Europe/Paris' } });
    const plan = translateSpec(spec, opts());
    expect(plan.env).toEqual({ HOME: '/home/node', NANOCLAW_MAILBOX: 'remote' });
    expect(plan.contributedEnv.TZ).toBe('Europe/Paris');
    expect(plan.contributedEnv.NANOCLAW_MAILBOX_TOKEN).toBe('mbx-token');
  });

  it('has no forward when no proxy env points at the host', () => {
    const spec = realisticSpec();
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
      delete spec.containers[0].contributedEnv![k];
    expect(translateSpec(spec, opts()).forward).toBeUndefined();
  });
});

describe('translateSpec: policy', () => {
  it('generates the filesystem and network policy the sandbox needs', () => {
    const plan = translateSpec(realisticSpec(), opts());
    const policy = parse(stringify(plan.policy));
    expect(policy.filesystem_policy.read_write).toEqual([
      '/tmp',
      '/dev/null',
      '/home/node',
      '/workspace',
      '/opt/nanoclaw-mounts/0-agent',
      '/home/node/.claude',
    ]);
    expect(policy.filesystem_policy.read_only).toEqual([
      '/bin',
      '/usr',
      '/lib',
      '/proc',
      '/dev/urandom',
      '/etc',
      '/var/log',
      '/app',
      '/pnpm',
      '/app/skills',
      '/app/src',
      OPENSHELL_FILES_DIR,
    ]);
    expect(policy.landlock).toEqual({ compatibility: 'best_effort' });
    expect(policy.network_policies).toEqual({
      nanoclaw_host: {
        name: 'nanoclaw_host',
        endpoints: [
          // One endpoint per host (OpenShell maps only the first per host);
          // CONNECT tunnels must bypass OpenShell's HTTP inspector.
          { host: 'host.openshell.internal', ports: [18770, 18755], tls: 'skip' },
        ],
        // Empty matches no binary; every agent tool needs the proxy.
        binaries: [{ path: '/**' }],
      },
    });
  });

  it('opens no host endpoint when the env names none', () => {
    const spec = realisticSpec();
    spec.containers[0].contributedEnv = { NANOCLAW_MAILBOX_SESSION: 'g1/sess-1' };
    spec.containers[0].mounts = spec.containers[0].mounts.filter((m) => !m.containerPath.startsWith('/tmp/onecli'));
    expect(translateSpec(spec, opts()).policy.network_policies).toEqual({});
  });

  it('stamps the canonical labels and reports resources it cannot size', () => {
    const plan = translateSpec(realisticSpec(), opts());
    expect(plan.labels).toMatchObject({
      'nanoclaw-install': 'e85a96b1',
      'nanoclaw-group': 'g1',
      'nanoclaw-session': 'sess-1',
      'nanoclaw-role': 'agent',
      'nanoclaw-group-folder': 'main',
    });
    expect(plan.unsizedResources).toEqual(['pidsLimit', 'shmSizeMb']);
  });
});

describe('sandboxName', () => {
  it('is key-derived, stable, and fits the 19-character OpenShell limit', () => {
    const a = sandboxName({ installSlug: 'e85a96b1', agentGroupId: 'g', sessionId: 'sess-1795545516491-abcdef' });
    expect(a).toMatch(/^nc-e85a96b1-[0-9a-f]{7}$/);
    expect(a).toHaveLength(19);
    expect(
      sandboxName({ installSlug: 'e85a96b1', agentGroupId: 'other', sessionId: 'sess-1795545516491-abcdef' }),
    ).toBe(a);
    expect(sandboxName({ installSlug: 'e85a96b1', agentGroupId: 'g', sessionId: 'sess-2' })).not.toBe(a);
    expect(sandboxName({ installSlug: 'dev', agentGroupId: 'g', sessionId: 'x' })).toMatch(/^nc-dev-[0-9a-f]{12}$/);
    expect(() => sandboxName({ installSlug: 'x', agentGroupId: 'g', sessionId: 's' }, 'a-very-long-prefix-')).toThrow(
      /no room/,
    );
  });
});
