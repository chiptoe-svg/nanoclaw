/**
 * Per-group driver routing: the session driver is install-wide, so OpenShell
 * opt-in is realized as a delegating driver that sends the agent groups in
 * NANOCLAW_OPENSHELL_GROUPS to OpenShell and EVERYTHING else to the primary
 * (Docker) driver, untouched. With the setting empty, `withOpenShellGroups`
 * returns the primary driver instance itself — no wrapper, no behavior change.
 *
 * Capabilities are the primary's: they are read install-wide by composition
 * (aux-container gating, image rebuild gating) for groups that stay on
 * Docker; the OpenShell driver still validates every spec it gets against its
 * own capabilities.
 */
import { log } from '../../log.js';

import {
  specInvalid,
  type DriverCapabilities,
  type NetworkAccessIntent,
  type NetworkReconcile,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionWatch,
} from '../types.js';

function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

export interface GroupRoutingConfig {
  /** Agent group ids that run on the secondary driver. */
  groups: readonly string[];
  /** Agent group ids with the remote mailbox; every routed group must be one. */
  remoteMailboxGroups: readonly string[];
}

export class GroupRoutedDriver implements SessionDriver {
  readonly kind: string;
  /**
   * Keys the secondary produced (prepared or listed). Handle-keyed calls route
   * by key, not handle identity: the session-events hub hands consumers its
   * own wrapper, never the handle this driver returned.
   */
  readonly #secondaryKeys = new Set<string>();

  constructor(
    private readonly primary: SessionDriver,
    private readonly secondary: SessionDriver,
    private readonly config: GroupRoutingConfig,
  ) {
    this.kind = `${primary.kind}+${secondary.kind}`;
    const missing = config.groups.filter((g) => !config.remoteMailboxGroups.includes(g));
    if (missing.length > 0) {
      log.error('NANOCLAW_OPENSHELL_GROUPS lists groups without the remote mailbox; their spawns will be refused', {
        groups: missing,
      });
    }
  }

  routes(agentGroupId: string): boolean {
    return this.config.groups.includes(agentGroupId);
  }

  capabilities(): DriverCapabilities {
    return this.primary.capabilities();
  }

  async ensureReady(): Promise<void> {
    await this.primary.ensureReady?.();
    // Not fatal for the install: Docker groups must keep running when the
    // OpenShell gateway is down. Opted-in spawns fail on their own.
    try {
      await this.secondary.ensureReady?.();
    } catch (err) {
      log.error('OpenShell gateway is not reachable; opted-in agent groups cannot spawn', {
        groups: this.config.groups,
        err,
      });
    }
  }

  async reconcileNetworkAccess(access: NetworkAccessIntent, handle: SessionHandle): Promise<NetworkReconcile | void> {
    const owner = this.#secondaryKeys.has(keyId(handle.key)) ? this.secondary : this.primary;
    return owner.reconcileNetworkAccess?.(access, handle);
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    if (!this.routes(spec.key.agentGroupId)) return this.primary.prepare(spec);
    if (!this.config.remoteMailboxGroups.includes(spec.key.agentGroupId)) {
      // A MicroVM cannot share the session directory's SQLite files with the
      // host (journal_mode=DELETE across a virtiofs mount is unproven, and the
      // session-context file is a single-file mount the VM cannot make).
      throw specInvalid(
        `agent group ${spec.key.agentGroupId} is in NANOCLAW_OPENSHELL_GROUPS but not in ` +
          'NANOCLAW_REMOTE_MAILBOX_GROUPS; OpenShell sessions require the remote mailbox',
      );
    }
    const handle = await this.secondary.prepare(spec);
    this.#secondaryKeys.add(keyId(handle.key));
    return handle;
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const primary = await this.primary.listSessions(installSlug);
    let secondary: SessionSnapshot[] = [];
    try {
      secondary = await this.secondary.listSessions(installSlug);
      for (const snapshot of secondary) this.#secondaryKeys.add(keyId(snapshot.handle.key));
    } catch (err) {
      // Docker adoption must not fail because the OpenShell gateway is down.
      log.warn('OpenShell sessions could not be listed; they are not adopted this pass', { err });
    }
    return [...primary, ...secondary];
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    const a = this.primary.watchSessions(installSlug, onEvent);
    const b = this.secondary.watchSessions(installSlug, onEvent);
    return {
      stop: () => {
        a.stop();
        b.stop();
      },
    };
  }

  async reapResidue(installSlug: string): Promise<void> {
    await this.primary.reapResidue?.(installSlug);
    try {
      await this.secondary.reapResidue?.(installSlug);
    } catch (err) {
      log.warn('OpenShell residue reaping failed', { err });
    }
  }
}

/** The primary itself when no group opts in — byte-identical behavior. */
export function withOpenShellGroups(
  primary: SessionDriver,
  config: GroupRoutingConfig,
  makeSecondary: () => SessionDriver,
): SessionDriver {
  if (config.groups.length === 0) return primary;
  return new GroupRoutedDriver(primary, makeSecondary(), config);
}
