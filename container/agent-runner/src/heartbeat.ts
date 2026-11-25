import fs from 'fs';

// OpenShell prototype only; the module ships with /add-remote-mailbox.
import { sendRemoteHeartbeat } from './mailbox/remote/heartbeat.js';

const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

/**
 * The heartbeat location is deployment-configurable via
 * NANOCLAW_HEARTBEAT_PATH for setups that relocate the workspace heartbeat.
 * Unset = today's path, byte-identical. Read per call so the container env,
 * not import order, decides.
 */
export function heartbeatPath(): string {
  return process.env.NANOCLAW_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;
}

export function touchHeartbeat(): void {
  // OpenShell prototype only (fork shim, not part of /add-remote-mailbox): a
  // MicroVM cannot mount the heartbeat file, so its sessions carry the
  // remote-mailbox env without NANOCLAW_HEARTBEAT_PATH and heartbeat over RPC.
  if (process.env.NANOCLAW_MAILBOX_URL && !process.env.NANOCLAW_HEARTBEAT_PATH) {
    sendRemoteHeartbeat();
    return;
  }
  const heartbeat = heartbeatPath();
  const now = new Date();
  try {
    fs.utimesSync(heartbeat, now, now);
  } catch {
    try {
      fs.writeFileSync(heartbeat, '');
    } catch {
      // Parent may not exist in tests.
    }
  }
}
