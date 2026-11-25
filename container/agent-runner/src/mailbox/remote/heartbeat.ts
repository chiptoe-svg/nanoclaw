/** Best-effort remote heartbeat used by touchHeartbeat() when NANOCLAW_MAILBOX_URL is set. */
import fs from 'node:fs';

import { SyncRpcClient } from './sync-rpc.js';

const SESSION_CONTEXT = '/app/.nanoclaw-session.json';
/** Best-effort and idempotent: give up fast so a dead connection never stalls the loop. */
const HEARTBEAT_TIMEOUT_MS = 3_000;
const FAILURE_COOLDOWN_MS = 10_000;

let client: SyncRpcClient | undefined;
let clientKey = '';
let skipUntil = 0;

function sessionFromEnv(): string | undefined {
  if (process.env.NANOCLAW_MAILBOX_SESSION) return process.env.NANOCLAW_MAILBOX_SESSION;
  try {
    const context = JSON.parse(fs.readFileSync(SESSION_CONTEXT, 'utf8'));
    return `${context.agentGroupId}/${context.sessionId}`;
  } catch {
    return undefined;
  }
}

export function sendRemoteHeartbeat(): void {
  try {
    const url = process.env.NANOCLAW_MAILBOX_URL;
    const token = process.env.NANOCLAW_MAILBOX_TOKEN;
    if (!url || !token || Date.now() < skipUntil) return;
    const key = `${url}\0${token}`;
    if (!client || clientKey !== key) {
      client?.close();
      client = new SyncRpcClient({ url, token, timeoutMs: HEARTBEAT_TIMEOUT_MS, retryBudgetMs: 0 });
      clientKey = key;
    }
    client.session ??= sessionFromEnv();
    if (!client.session) return;
    client.call('heartbeat');
  } catch {
    // A missed heartbeat must never take the poll loop down; back off briefly
    // so a dead host does not stall every iteration for the call timeout.
    skipUntil = Date.now() + FAILURE_COOLDOWN_MS;
  }
}

export function resetRemoteHeartbeatForTesting(): void {
  client?.close();
  client = undefined;
  skipUntil = 0;
}
