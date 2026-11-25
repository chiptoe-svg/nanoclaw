/**
 * A partitioned gateway: one install still selects exactly one gateway
 * (`NANOCLAW_GATEWAY_PROVIDER`), but a named set of agent groups gets its
 * credentials from a second source. Core keeps orchestrating ONE definition —
 * this one — and every per-group decision it makes (session lease, agent
 * skills, connection handoff, whether the approval bridge gates the group)
 * is answered by the side that actually serves that group.
 *
 * Install-wide surfaces stay the base gateway's, unchanged: `kind` (approval
 * rows, logs), `availability`, `approvals`. The partition's groups are simply
 * not gated by the base's approval bridge (`gatedByApprovals` → false), so a
 * base outage neither stops nor refuses them, and a partition outage cannot
 * reach the base's groups (their leases come from the base alone).
 *
 * HOOK (approvals milestone): the partition has no approval bridge yet. When
 * OpenShell pending rules are bridged to NanoClaw cards, this is where its
 * subscription joins the base's — `approvals.subscribe` running both, with an
 * outage reported per side so it stops only that side's groups (core's
 * `stopGatewaySessionsForUnavailability` would take a group predicate).
 */
import type { GatewayProviderDefinition } from './gateway-provider-registry.js';

export interface GatewayPartition {
  /** True for the agent groups the partition serves. Stable for the host's lifetime. */
  routes(agentGroupId: string): boolean;
  provider: GatewayProviderDefinition;
}

export function partitionGatewayProvider(
  base: GatewayProviderDefinition,
  partition: GatewayPartition,
): GatewayProviderDefinition {
  const side = (agentGroupId: string) => (partition.routes(agentGroupId) ? partition.provider : base);
  const definition: GatewayProviderDefinition = {
    kind: base.kind,
    agentSkills: base.agentSkills,
    agentSkillsFor(agentGroupId) {
      const provider = side(agentGroupId);
      return provider.agentSkillsFor?.(agentGroupId) ?? provider.agentSkills;
    },
    sessions: {
      ensure: (input, signal) => side(input.key.agentGroupId).sessions.ensure(input, signal),
      async reapOrphans() {
        await base.sessions.reapOrphans?.();
        await partition.provider.sessions.reapOrphans?.();
      },
      gatedByApprovals(agentGroupId) {
        if (partition.routes(agentGroupId)) return false;
        return base.sessions.gatedByApprovals?.(agentGroupId) ?? true;
      },
    },
    // The base's bridge, as is: the partition's groups never produce its events.
    approvals: base.approvals,
  };
  if (base.availability) definition.availability = base.availability;
  if (base.connections || partition.provider.connections) {
    definition.connections = {
      connect(input) {
        const connections = side(input.agentGroupId).connections;
        return connections
          ? connections.connect(input)
          : Promise.resolve({
              status: 'unsupported' as const,
              message: 'This gateway does not implement account connection handoff.',
            });
      },
    };
  }
  return definition;
}
