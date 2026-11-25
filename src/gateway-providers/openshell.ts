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
 *   (`gatedByApprovals` → false via the partition).
 *
 * Every other group is served by the install's gateway exactly as before; with
 * the setting empty the install gateway is returned unwrapped.
 */
import { OPENSHELL_CREDENTIALS_RAW, OPENSHELL_GROUPS } from '../config.js';
import { OPENSHELL_HOST } from '../drivers/openshell/translate.js';
import { realOpenShellCli, type OpenShellCli } from '../drivers/openshell-driver.js';
import { CREDENTIAL_PROVIDER_NAME } from '../drivers/types.js';
import { log } from '../log.js';

import {
  registerGatewayPartition,
  type GatewayProviderDefinition,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';
import { partitionGatewayProvider } from './partition.js';

const SETTING = 'NANOCLAW_OPENSHELL_CREDENTIALS';
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
  async function ensure(input: GatewaySessionInput): Promise<GatewaySessionLease> {
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
    return {
      contribution: {
        credentialProviders: [...providers],
        // No gateway hop: egress is the sandbox's own declarative policy plus
        // the providers' entries. The driver ignores a `host` target.
        networkAccess: { endpoint: OPENSHELL_HOST, target: { kind: 'host' } },
      },
    };
  }

  return {
    kind: 'openshell',
    agentSkills: [],
    sessions: { ensure },
    approvals: {
      // No bridge yet (see partition.ts HOOK): held until shutdown, never deciding.
      subscribe: (_decide, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
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
    raw: OPENSHELL_CREDENTIALS_RAW,
    openshellGroups: OPENSHELL_GROUPS,
    cli: () => realOpenShellCli(),
  }),
);
