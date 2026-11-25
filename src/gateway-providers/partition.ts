/**
 * A partitioned gateway: one install still selects exactly one gateway
 * (`NANOCLAW_GATEWAY_PROVIDER`), but a named set of agent groups gets its
 * credentials from a second source. Core keeps orchestrating ONE definition —
 * this one — and every per-group decision it makes (session lease, agent
 * skills, connection handoff, whether the approval bridge gates the group)
 * is answered by the side that actually serves that group.
 *
 * Install-wide surfaces stay the base gateway's, unchanged: `kind` (approval
 * rows, logs), `availability`, and every approvals field but `subscribe`. The
 * partition's groups are simply not gated by the base's approval bridge
 * (`gatedByApprovals` → false), so a base outage neither stops nor refuses
 * them, and a partition outage cannot reach the base's groups (their leases
 * come from the base alone).
 *
 * Approvals: `subscribe` runs the base's subscription and, beside it, the
 * partition's own bridge, both deciding through core's one coordinator. The
 * combined subscription is the base's: it settles exactly when the base's
 * does (so core's outage handling — stop gated sessions, close admission,
 * reconnect — sees only the base), and the partition's side is stopped then
 * and restarted with the next attempt. A partition-side failure is logged and
 * retried here, never reported to core: it must not stop the base's groups,
 * and the partition's groups do not need stopping either (its runtime refuses
 * unapproved egress by itself; an outage only means no new cards).
 */
import { log } from '../log.js';

import type { GatewayProviderDefinition } from './gateway-provider-registry.js';

const PARTITION_RETRY_MS = 5_000;

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
    approvals: {
      ...base.approvals,
      async subscribe(decide, signal, resolved, scope) {
        const side = new AbortController();
        const stopSide = () => side.abort();
        signal.addEventListener('abort', stopSide, { once: true });
        const sideRun = runPartitionApprovals(partition.provider, decide, side.signal);
        try {
          return await base.approvals.subscribe(decide, signal, resolved, scope);
        } finally {
          signal.removeEventListener('abort', stopSide);
          side.abort();
          await sideRun;
        }
      },
    },
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

/** The partition's bridge for as long as `signal` lives; its failures stay on its side. */
async function runPartitionApprovals(
  provider: GatewayProviderDefinition,
  decide: Parameters<GatewayProviderDefinition['approvals']['subscribe']>[0],
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await provider.approvals.subscribe(decide, signal);
      if (signal.aborted) return;
      log.warn('Partition approval bridge ended; restarting it', { gatewayProvider: provider.kind });
    } catch (err) {
      if (signal.aborted) return;
      log.error('Partition approval bridge failed; restarting it (base gateway unaffected)', {
        gatewayProvider: provider.kind,
        err,
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, PARTITION_RETRY_MS);
      timer.unref?.();
      signal.addEventListener('abort', done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
    });
  }
}
