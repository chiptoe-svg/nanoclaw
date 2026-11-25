/**
 * OpenShell providers as a per-group credential source (prototype).
 *
 * The operator creates OpenShell providers (`openshell provider create`, the
 * secret read from the operator's shell); NanoClaw only REFERENCES them by
 * name. A group listed in NANOCLAW_OPENSHELL_CREDENTIALS gets, per session:
 *
 * - its providers attached at sandbox create (`--provider`), which put a
 *   placeholder in the sandbox env (e.g. CLAUDE_CODE_OAUTH_TOKEN) that
 *   OpenShell swaps for the real value at egress, only for the profile's
 *   endpoints and binaries; each provider also opens its own endpoints;
 * - no gateway proxy env, CA, stub mounts or loopback forwarder, so the model
 *   client talks to the real endpoint (api.anthropic.com) directly;
 * - no dependency on the install gateway's approval bridge
 *   (`gatedByApprovals` → false via the partition);
 * - its own approval bridge for egress its policy denies
 *   (openshell-approvals.ts): each live sandbox is watched while its lease
 *   lives, and an approved destination is added to the sandbox and persisted
 *   for the group.
 *
 * Every other group is served by the install's gateway exactly as before; with
 * the setting empty the install gateway is returned unwrapped.
 */
import { OPENSHELL_GROUPS } from '../drivers/openshell/config.js';
import { OPENSHELL_HOST, sandboxName } from '../drivers/openshell/translate.js';
import { realOpenShellCli, type OpenShellCli } from '../drivers/openshell-driver.js';
import { CREDENTIAL_PROVIDER_NAME } from '../drivers/types.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayPartition,
  type GatewayProviderDefinition,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';
import { OpenShellNetworkApprovals, realLogTail } from './openshell-approvals.js';
import { partitionGatewayProvider } from './partition.js';

const SETTING = 'NANOCLAW_OPENSHELL_CREDENTIALS';

/** Raw setting: `process.env` wins, then `.env`. Parsed and checked when the gateway is selected. */
function readCredentialsSetting(): string {
  return process.env[SETTING] || readEnvFile([SETTING])[SETTING] || '';
}
const NOT_FOUND = /not found|NotFound|does not exist/i;

/** `<agentGroupId>:<provider>[+<provider>…]`, comma-separated. Throws on anything malformed. */
export function parseOpenShellCredentials(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const colon = entry.indexOf(':');
    const group = colon > 0 ? entry.slice(0, colon).trim() : '';
    const providers =
      colon > 0
        ? entry
            .slice(colon + 1)
            .split('+')
            .map((p) => p.trim())
        : [];
    if (!group || providers.length === 0 || providers.some((p) => !CREDENTIAL_PROVIDER_NAME.test(p))) {
      throw new Error(`${SETTING}: entry '${entry}' must be <agentGroupId>:<provider>[+<provider>…]`);
    }
    if (out.has(group)) throw new Error(`${SETTING}: agent group ${group} is listed twice`);
    out.set(group, [...new Set(providers)]);
  }
  return out;
}

export interface OpenShellCredentialGatewayOptions {
  /** agentGroupId → OpenShell provider names. */
  credentials: ReadonlyMap<string, readonly string[]>;
  /** NANOCLAW_OPENSHELL_GROUPS: only these run in a sandbox that can attach providers. */
  openshellGroups: readonly string[];
  cli: OpenShellCli;
  /** Network approval bridge; the real one (CLI log tails, core notifications) when absent. */
  networkApprovals?: OpenShellNetworkApprovals;
}

/** The bridge with its host dependencies. Core modules load lazily: they import the container runner. */
export function realNetworkApprovals(cli: OpenShellCli): OpenShellNetworkApprovals {
  return new OpenShellNetworkApprovals({
    cli,
    startTail: realLogTail(cli.bin),
    dataRoot: DATA_DIR,
    async notify(_agentGroupId, sessionId, text) {
      const { getSession } = await import('../db/sessions.js');
      const session = await getSession(sessionId);
      if (!session || session.status !== 'active') return;
      const { notifyAgent } = await import('../modules/approvals/primitive.js');
      await notifyAgent(session, text);
    },
    async agentName(agentGroupId) {
      const { getAgentGroup } = await import('../db/agent-groups.js');
      return (await getAgentGroup(agentGroupId))?.name ?? agentGroupId;
    },
  });
}

/** Fail the spawn with an operator-actionable message rather than a bare `sandbox create` error. */
async function assertProvidersExist(cli: OpenShellCli, providers: readonly string[]): Promise<void> {
  for (const name of providers) {
    try {
      await cli.run(['provider', 'get', name], { timeoutMs: 10_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_FOUND.test(message)) {
        throw new Error(
          `OpenShell provider '${name}' does not exist; create it with ` +
            `\`openshell provider create --name ${name} --type <profile> --credential <ENV_VAR>\``,
          { cause: err },
        );
      }
      throw new Error(`OpenShell provider '${name}' could not be checked (gateway unreachable?)`, { cause: err });
    }
  }
}

export function createOpenShellCredentialGateway(opts: OpenShellCredentialGatewayOptions): GatewayProviderDefinition {
  const networkApprovals = opts.networkApprovals ?? realNetworkApprovals(opts.cli);

  async function ensure(input: GatewaySessionInput, signal?: AbortSignal): Promise<GatewaySessionLease> {
    const { agentGroupId, sessionId } = input.key;
    const providers = opts.credentials.get(agentGroupId);
    if (!providers) throw new Error(`agent group ${agentGroupId} has no OpenShell credential providers`);
    if (!opts.openshellGroups.includes(agentGroupId)) {
      // Never fall back to the install gateway: the operator asked for these credentials.
      throw new Error(
        `agent group ${agentGroupId} is in ${SETTING} but not in NANOCLAW_OPENSHELL_GROUPS; ` +
          'OpenShell providers attach only to OpenShell sandboxes',
      );
    }
    // An adopted sandbox already has its providers; an OpenShell blip must not stop it.
    if (input.disposition !== 'adopt') await assertProvidersExist(opts.cli, providers);
    log.info('OpenShell credential providers applied', { agentGroupId, sessionId, providers });
    // The driver names the sandbox from the key alone (default prefix), so the
    // lease can watch it before it exists; the tail retries until it does.
    const unwatch = networkApprovals.watch({ agentGroupId, sessionId, sandbox: sandboxName(input.key) });
    signal?.addEventListener('abort', unwatch, { once: true });
    return {
      contribution: {
        credentialProviders: [...providers],
        // No gateway hop: egress is the sandbox's own declarative policy plus
        // the providers' entries. The driver ignores a `host` target.
        networkAccess: { endpoint: OPENSHELL_HOST, target: { kind: 'host' } },
      },
      async release() {
        unwatch();
      },
    };
  }

  return {
    kind: 'openshell',
    agentSkills: [],
    sessions: { ensure },
    approvals: {
      // Joined to the base gateway's subscription by the partition (partition.ts).
      subscribe: (decide, signal) => networkApprovals.subscribe(decide, signal),
    },
  };
}

/** The base gateway itself when no group opts in — byte-identical behavior. */
export function withOpenShellCredentialGroups(
  base: GatewayProviderDefinition,
  config: { raw: string; openshellGroups: readonly string[]; cli: () => OpenShellCli },
): GatewayProviderDefinition {
  const credentials = parseOpenShellCredentials(config.raw);
  if (credentials.size === 0) return base;
  const outside = [...credentials.keys()].filter((g) => !config.openshellGroups.includes(g));
  if (outside.length > 0) {
    log.error(`${SETTING} lists groups not in NANOCLAW_OPENSHELL_GROUPS; their spawns will be refused`, {
      groups: outside,
    });
  }
  log.info('OpenShell credential providers serve selected agent groups', {
    gatewayProvider: base.kind,
    groups: Object.fromEntries(credentials),
  });
  return partitionGatewayProvider(base, {
    routes: (agentGroupId) => credentials.has(agentGroupId),
    provider: createOpenShellCredentialGateway({
      credentials,
      openshellGroups: config.openshellGroups,
      cli: config.cli(),
    }),
  });
}

registerGatewayPartition((base) =>
  withOpenShellCredentialGroups(base, {
    raw: readCredentialsSetting(),
    openshellGroups: OPENSHELL_GROUPS,
    cli: () => realOpenShellCli(),
  }),
);
