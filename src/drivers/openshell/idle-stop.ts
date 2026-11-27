/**
 * Idle stop — end an OpenShell VM soon after its agent goes idle.
 *
 * Core's absolute ceiling (30 min by default, install-wide) reaps idle
 * containers, which is cheap for Docker but holds ~1.4 GB of host memory per
 * VM. This stops a VM earlier, through core's own `killContainer`, using the
 * same signals the ceiling uses: the heartbeat (or the spawn time when the
 * heartbeat predates this incarnation), a Bash command declared as running
 * longer, and messages still being processed. A VM with a claimed message is
 * left to core's stuck checks, and one with a due message not yet claimed is
 * left alone so the stop never races the message's pickup (nanocoai/nanoclaw
 * #4558); this only ever stops an idle one.
 */
import fs from 'fs';

import { log } from '../../log.js';

import type { SessionKey } from '../types.js';

export interface IdleInputs {
  now: number;
  heartbeatMtimeMs: number; // 0 when the heartbeat file is absent
  startedAtMs: number | undefined;
  bashTimeoutMs: number | null;
  claims: number;
  /** Due inbound messages not yet claimed. */
  due: number;
}

/** Pure: should this running VM be stopped as idle? */
export function decideIdleStop(idleMs: number, inputs: IdleInputs): boolean {
  if (idleMs <= 0 || inputs.claims > 0 || inputs.due > 0 || inputs.startedAtMs === undefined) return false;
  // A heartbeat older than this incarnation's start is the previous one's file.
  const last = Math.max(inputs.heartbeatMtimeMs, inputs.startedAtMs);
  return inputs.now - last > Math.max(idleMs, inputs.bashTimeoutMs ?? 0);
}

export interface IdleProbe {
  /** undefined when core is not running this session (nothing to stop). */
  read(key: SessionKey): Promise<Omit<IdleInputs, 'now'> | undefined>;
  stop(key: SessionKey): void;
}

/**
 * Core-backed probe. Imported lazily: the driver loads before core's
 * container runner, which itself depends on the driver registry.
 */
export const coreIdleProbe: IdleProbe = {
  async read(key) {
    const runner = await import('../../container-runner.js');
    const startedAtMs = runner.getContainerStartedAtMs(key.sessionId);
    if (startedAtMs === undefined) return undefined;
    const sessions = await import('../../session-manager.js');
    let heartbeatMtimeMs = 0;
    try {
      heartbeatMtimeMs = fs.statSync(sessions.heartbeatPath(key.agentGroupId, key.sessionId)).mtimeMs;
    } catch {
      // absent: the spawn time stands in
    }
    const outbound = await sessions.withExistingMailboxSession(key.agentGroupId, key.sessionId, (mailbox) => {
      const state = mailbox.getContainerState();
      return {
        claims: mailbox.getProcessingClaims().length,
        due: mailbox.countDueMessages(),
        bashTimeoutMs: state?.currentTool === 'Bash' ? state.toolDeclaredTimeoutMs : null,
      };
    });
    if (!outbound) return undefined;
    return { heartbeatMtimeMs, startedAtMs, ...outbound };
  },
  stop(key) {
    void import('../../container-runner.js').then((runner) => runner.killContainer(key.sessionId, 'openshell-idle'));
  },
};

/** One pass over the live VMs; a failure on one never blocks the others. */
export async function stopIdleSessions(
  keys: SessionKey[],
  idleMs: number,
  probe: IdleProbe = coreIdleProbe,
  now = Date.now(),
): Promise<void> {
  if (idleMs <= 0) return;
  for (const key of keys) {
    try {
      const inputs = await probe.read(key);
      if (!inputs || !decideIdleStop(idleMs, { now, ...inputs })) continue;
      log.info('OpenShell: stopping idle VM', { sessionId: key.sessionId, idleMs });
      probe.stop(key);
    } catch (err) {
      log.debug('OpenShell idle check failed', { sessionId: key.sessionId, err });
    }
  }
}
