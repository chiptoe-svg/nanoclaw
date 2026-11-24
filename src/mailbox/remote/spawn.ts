/**
 * Spawn-time wiring for the remote mailbox (opt-in per agent group).
 *
 * An opted-in group's container gets no session-directory mount. Its runner
 * talks to the host service in `service.ts` with a per-spawn bearer token, and
 * keeps its local inbox/outbox/heartbeat in a scratch directory the host
 * creates empty for each spawn and deletes when the container ends.
 *
 * Why a scratch directory and not tmpfs: `MountSpec` has no tmpfs kind, and
 * adding one means a new seam type plus every driver and the conformance suite.
 * A per-session host directory under the group's own `v2-sessions/<group>/`
 * root is an ordinary `group-state` mount, so the driver and its policy are
 * untouched. It holds only what the runner itself writes.
 *
 * Egress lockdown: under NANOCLAW_EGRESS_LOCKDOWN, `host.docker.internal` is
 * the gateway relay container, which forwards only the gateway port. The relay
 * (operator-local, outside this repo) must also forward the mailbox port, or
 * opted-in containers cannot reach the service. `warnIfRelayMustForwardMailbox`
 * says so at startup.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, EGRESS_LOCKDOWN, MAILBOX_PORT, REMOTE_MAILBOX_GROUPS } from '../../config.js';
import { log } from '../../log.js';
import { isValidSessionKey, type RemoteSessionKey } from './ids.js';
import { issueMailboxToken, revokeMailboxToken } from './tokens.js';

export function isRemoteMailboxGroup(agentGroupId: string): boolean {
  return REMOTE_MAILBOX_GROUPS.includes(agentGroupId);
}

export function remoteMailboxEnabled(): boolean {
  return REMOTE_MAILBOX_GROUPS.length > 0;
}

export function remoteWorkspaceDir(key: RemoteSessionKey): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, '.remote-workspace', key.sessionId);
}

/** Fresh, empty scratch /workspace for one spawn. */
export function prepareRemoteWorkspace(key: RemoteSessionKey): string {
  const dir = remoteWorkspaceDir(key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Issue a fresh token for this spawn and return the runner's env. Goes on the
 * contributed env lane: the token is a credential-NAMED variable, which the
 * composed lane refuses by design; the lane still refuses real credential
 * values, and this is a spawn-scoped bearer the host revokes at exit.
 */
export function issueRemoteMailboxEnv(key: RemoteSessionKey): Record<string, string> {
  const token = issueMailboxToken(key);
  return {
    NANOCLAW_MAILBOX_URL: `http://host.docker.internal:${MAILBOX_PORT}/v1/mailbox`,
    NANOCLAW_MAILBOX_TOKEN: token,
    NANOCLAW_MAILBOX_SESSION: `${key.agentGroupId}/${key.sessionId}`,
  };
}

/**
 * Container gone (or never started): revoke its token and drop its scratch
 * workspace. Idempotent and a no-op for sessions that never used the remote
 * mailbox. NOT called on host shutdown — adopted containers keep working.
 */
export function releaseRemoteMailbox(key: RemoteSessionKey): void {
  if (!isValidSessionKey(key)) return;
  try {
    revokeMailboxToken(key);
    fs.rmSync(remoteWorkspaceDir(key), { recursive: true, force: true });
  } catch (err) {
    log.warn('Remote mailbox release failed', { ...key, err });
  }
}

export function warnIfRelayMustForwardMailbox(): void {
  if (!remoteMailboxEnabled() || !EGRESS_LOCKDOWN) return;
  log.warn(
    `Egress lockdown is on and the remote mailbox is enabled: host.docker.internal is the gateway relay, ` +
      `which must also forward port ${MAILBOX_PORT} to the host or opted-in containers cannot reach their mailbox`,
    { port: MAILBOX_PORT, groups: REMOTE_MAILBOX_GROUPS },
  );
}
