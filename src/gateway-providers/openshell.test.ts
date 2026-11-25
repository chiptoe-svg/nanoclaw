/**
 * Per-group credentials from OpenShell providers: setting parsing, the
 * partitioned gateway's routing, and the OpenShell side's contribution.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { OpenShellCli } from '../drivers/openshell-driver.js';
import { FakeOpenShell } from '../drivers/openshell/fake-openshell.js';
import type { GatewayProviderDefinition, GatewaySessionInput } from './gateway-provider-registry.js';
import {
  createOpenShellCredentialGateway,
  parseOpenShellCredentials,
  withOpenShellCredentialGroups,
} from './openshell.js';

const OPENSHELL_GROUP = 'ag-lab';
const ONECLI_GROUP = 'ag-felix';

/** A CLI that knows a fixed set of providers; records every call. */
class ProviderCli extends FakeOpenShell {
  constructor(private readonly providers: string[]) {
    super();
  }
  override async run(args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
    if (args[0] === 'provider' && args[1] === 'get') {
      this.calls.push({ args, env: opts?.env });
      if (!this.providers.includes(args[2])) throw new Error(`Error: × provider not found`);
      return `Provider: ${args[2]}`;
    }
    return super.run(args, opts);
  }
}

function input(agentGroupId: string, disposition: 'create' | 'adopt' = 'create'): GatewaySessionInput {
  return {
    disposition,
    key: { installSlug: 'inst', agentGroupId, sessionId: 'sess-1' },
    runtimeIdentity: `inst/${agentGroupId}/sess-1`,
    groupName: agentGroupId,
    provider: 'claude',
    containerName: 'c',
    capabilities: {} as never,
  };
}

function baseGateway(): GatewayProviderDefinition & { ensure: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(async () => ({
    contribution: {
      env: { HTTPS_PROXY: 'http://x:aoc@host.docker.internal:10255' },
      networkAccess: { endpoint: 'host.docker.internal', target: { kind: 'runtime' as const, identity: 'onecli' } },
    },
  }));
  return {
    ensure,
    kind: 'onecli',
    agentSkills: ['onecli-gateway'],
    availability: { publish: async () => {}, read: async () => true },
    connections: { connect: async () => ({ status: 'unsupported' as const, message: 'base' }) },
    sessions: { ensure },
    approvals: { legacyActions: ['onecli_credential'], subscribe: async () => {} },
  };
}

function partitioned(providers = ['nc-claude-lab'], cli: OpenShellCli = new ProviderCli(providers)) {
  const base = baseGateway();
  const gateway = withOpenShellCredentialGroups(base, {
    raw: `${OPENSHELL_GROUP}:${providers.join('+')}`,
    openshellGroups: [OPENSHELL_GROUP],
    cli: () => cli,
  });
  return { base, gateway };
}

describe('parseOpenShellCredentials', () => {
  it('maps groups to provider names', () => {
    expect(parseOpenShellCredentials(' ag-1:claude-a+github-a , ag-2:claude-b ')).toEqual(
      new Map([
        ['ag-1', ['claude-a', 'github-a']],
        ['ag-2', ['claude-b']],
      ]),
    );
    expect(parseOpenShellCredentials('')).toEqual(new Map());
  });

  it('refuses malformed entries, bad names and duplicates', () => {
    expect(() => parseOpenShellCredentials('ag-1')).toThrow(/must be <agentGroupId>:<provider>/);
    expect(() => parseOpenShellCredentials('ag-1:')).toThrow(/must be/);
    expect(() => parseOpenShellCredentials(':p')).toThrow(/must be/);
    expect(() => parseOpenShellCredentials('ag-1:--evil')).toThrow(/must be/);
    expect(() => parseOpenShellCredentials('ag-1:a b')).toThrow(/must be/);
    expect(() => parseOpenShellCredentials('ag-1:a,ag-1:b')).toThrow(/listed twice/);
  });
});

describe('withOpenShellCredentialGroups', () => {
  it('returns the install gateway itself when no group opts in', () => {
    const base = baseGateway();
    const cli = vi.fn();
    expect(withOpenShellCredentialGroups(base, { raw: '', openshellGroups: [OPENSHELL_GROUP], cli })).toBe(base);
    expect(cli).not.toHaveBeenCalled();
  });

  it('keeps every install-wide surface of the base gateway', () => {
    const { base, gateway } = partitioned();
    expect(gateway.kind).toBe('onecli');
    expect(gateway.approvals).toBe(base.approvals);
    expect(gateway.availability).toBe(base.availability);
    expect(gateway.agentSkills).toEqual(['onecli-gateway']);
  });

  it('serves non-opted groups from the base gateway, unchanged', async () => {
    const { base, gateway } = partitioned();
    const signal = new AbortController().signal;
    const lease = await gateway.sessions.ensure(input(ONECLI_GROUP), signal);
    expect(base.ensure).toHaveBeenCalledWith(input(ONECLI_GROUP), signal);
    expect(lease).toEqual(await base.ensure.mock.results[0].value);
    expect(gateway.sessions.gatedByApprovals!(ONECLI_GROUP)).toBe(true);
    expect(gateway.agentSkillsFor!(ONECLI_GROUP)).toEqual(['onecli-gateway']);
    expect(await gateway.connections!.connect({ agentGroupId: ONECLI_GROUP, host: 'x.com' })).toMatchObject({
      message: 'base',
    });
  });

  it('serves opted groups from OpenShell providers: no proxy env, names only, not gated by approvals', async () => {
    const { base, gateway } = partitioned(['nc-claude-lab', 'nc-github-lab']);
    const lease = await gateway.sessions.ensure(input(OPENSHELL_GROUP), new AbortController().signal);
    expect(base.ensure).not.toHaveBeenCalled();
    expect(lease.contribution).toEqual({
      credentialProviders: ['nc-claude-lab', 'nc-github-lab'],
      networkAccess: { endpoint: 'host.openshell.internal', target: { kind: 'host' } },
    });
    expect(lease.onUnavailable).toBeUndefined();
    expect(gateway.sessions.gatedByApprovals!(OPENSHELL_GROUP)).toBe(false);
    // Not told about a proxy it is not behind.
    expect(gateway.agentSkillsFor!(OPENSHELL_GROUP)).toEqual([]);
    expect(await gateway.connections!.connect({ agentGroupId: OPENSHELL_GROUP, host: 'x.com' })).toMatchObject({
      status: 'unsupported',
    });
  });
});

describe('OpenShell credential gateway', () => {
  const credentials = new Map([[OPENSHELL_GROUP, ['nc-claude-lab']]]);

  it('checks each provider exists before a new sandbox, naming the fix when one is missing', async () => {
    const cli = new ProviderCli([]);
    const gateway = createOpenShellCredentialGateway({ credentials, openshellGroups: [OPENSHELL_GROUP], cli });
    await expect(gateway.sessions.ensure(input(OPENSHELL_GROUP), new AbortController().signal)).rejects.toThrow(
      /OpenShell provider 'nc-claude-lab' does not exist; create it with `openshell provider create --name nc-claude-lab/,
    );
    expect(cli.calls.map((c) => c.args)).toEqual([['provider', 'get', 'nc-claude-lab']]);
  });

  it('adopts a surviving sandbox without consulting OpenShell', async () => {
    const cli = new ProviderCli([]);
    const gateway = createOpenShellCredentialGateway({ credentials, openshellGroups: [OPENSHELL_GROUP], cli });
    const lease = await gateway.sessions.ensure(input(OPENSHELL_GROUP, 'adopt'), new AbortController().signal);
    expect(lease.contribution.credentialProviders).toEqual(['nc-claude-lab']);
    expect(cli.calls).toEqual([]);
  });

  it('refuses a group that does not run in OpenShell — never falls back to the install gateway', async () => {
    const gateway = createOpenShellCredentialGateway({
      credentials,
      openshellGroups: [],
      cli: new ProviderCli(['nc-claude-lab']),
    });
    await expect(gateway.sessions.ensure(input(OPENSHELL_GROUP), new AbortController().signal)).rejects.toThrow(
      /not in NANOCLAW_OPENSHELL_GROUPS/,
    );
  });

  it('holds its (empty) approval subscription until shutdown', async () => {
    const gateway = createOpenShellCredentialGateway({ credentials, openshellGroups: [], cli: new ProviderCli([]) });
    const controller = new AbortController();
    let done = false;
    const subscription = gateway.approvals
      .subscribe(async () => 'deny', controller.signal)
      .then(() => {
        done = true;
      });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    controller.abort();
    await subscription;
    expect(done).toBe(true);
  });
});
