/**
 * OpenShell runtime settings, read by the skill itself rather than core config.
 *
 * `process.env` wins, then `.env` (the host parses `.env` in-process; it has no
 * `EnvironmentFile=`). Read once at import, like every other host setting: an
 * edit applies on restart.
 *
 * - NANOCLAW_OPENSHELL_GROUPS: comma-separated agent group ids whose sessions
 *   run as OpenShell MicroVMs. Every listed group must also be in
 *   NANOCLAW_REMOTE_MAILBOX_GROUPS. Empty = feature fully off (the `openshell`
 *   driver is the `docker` driver itself, unwrapped).
 * - NANOCLAW_OPENSHELL_FORWARD_PORT: host loopback port of the forwarder that
 *   carries sandbox proxy traffic to the credential gateway (OpenShell blocks
 *   the gateway's own port). Default 18755.
 */
import { readEnvFile } from '../../env.js';

const KEYS = ['NANOCLAW_OPENSHELL_GROUPS', 'NANOCLAW_OPENSHELL_FORWARD_PORT'] as const;

export const DEFAULT_FORWARD_PORT = 18755;

function read(key: (typeof KEYS)[number], env: NodeJS.ProcessEnv): string {
  return env[key] || readEnvFile([...KEYS])[key] || '';
}

export function parseOpenShellGroups(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function parseForwardPort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_FORWARD_PORT;
}

export const OPENSHELL_GROUPS: readonly string[] = parseOpenShellGroups(read('NANOCLAW_OPENSHELL_GROUPS', process.env));
export const OPENSHELL_FORWARD_PORT: number = parseForwardPort(read('NANOCLAW_OPENSHELL_FORWARD_PORT', process.env));
