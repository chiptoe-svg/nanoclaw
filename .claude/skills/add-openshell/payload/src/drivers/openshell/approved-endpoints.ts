/**
 * Network endpoints an admin approved for one agent group, kept across
 * sandboxes: `data/openshell-policy/<agentGroupId>.json` (host-only, never
 * mounted into a sandbox). The approval bridge appends an entry when a card is
 * approved; the driver merges the entries into every new sandbox policy for
 * that group (`TranslateOptions.approvedEndpoints`).
 *
 *   { "endpoints": [ { "host": "example.com", "port": 443, "approvedAt": "…" } ] }
 *
 * Revoke by deleting the entry (or the file); it leaves a running sandbox's
 * policy alone until that sandbox is replaced, or until
 * `openshell policy update <sandbox> --remove-endpoint host:port`.
 *
 * Strict on purpose: one exact DNS name and one port per entry. Wildcards, IP
 * literals and ranges, and host-internal names never qualify — the bridge only
 * ever asks about an exact name the sandbox tried to reach, and a hand edit
 * that widens beyond that is skipped, not merged.
 */
import fs from 'fs';
import path from 'path';

export const APPROVED_ENDPOINTS_DIR = 'openshell-policy';
/** The policy rule approved endpoints live in, live (`--rule-name`) and in a new sandbox's policy alike. */
export const APPROVED_RULE = 'nanoclaw_approved';

export interface ApprovedEndpoint {
  host: string;
  port: number;
  approvedAt?: string;
}

/** Lowercase DNS name with an alphabetic TLD; never a wildcard, an IP literal, or a host-internal name. */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const INTERNAL_SUFFIXES = ['.internal', '.local', '.localhost', '.localdomain', '.home.arpa'];

export function isApprovableHost(host: string): boolean {
  return DNS_NAME.test(host) && !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function isApprovablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536;
}

export function isApprovableEndpoint(entry: unknown): entry is ApprovedEndpoint {
  if (!entry || typeof entry !== 'object') return false;
  const { host, port } = entry as Record<string, unknown>;
  return typeof host === 'string' && isApprovableHost(host) && isApprovablePort(port);
}

const SAFE_GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function approvedEndpointsPath(dataRoot: string, agentGroupId: string): string {
  if (!SAFE_GROUP_ID.test(agentGroupId) || agentGroupId.includes('..')) {
    throw new Error(`invalid agent group id for the approved-endpoint store: ${agentGroupId}`);
  }
  return path.join(dataRoot, APPROVED_ENDPOINTS_DIR, `${agentGroupId}.json`);
}

export interface ApprovedEndpointsRead {
  endpoints: ApprovedEndpoint[];
  /** Entries present in the file that failed validation (skipped, never merged). */
  rejected: unknown[];
}

/** Missing file → empty. An unreadable or malformed file throws: the caller decides how loudly to fail. */
export function readApprovedEndpoints(dataRoot: string, agentGroupId: string): ApprovedEndpointsRead {
  let raw: string;
  try {
    raw = fs.readFileSync(approvedEndpointsPath(dataRoot, agentGroupId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { endpoints: [], rejected: [] };
    throw err;
  }
  const doc = JSON.parse(raw) as { endpoints?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.endpoints)) {
    throw new Error(`${approvedEndpointsPath(dataRoot, agentGroupId)}: expected { "endpoints": [...] }`);
  }
  const endpoints: ApprovedEndpoint[] = [];
  const rejected: unknown[] = [];
  for (const entry of doc.endpoints) {
    if (isApprovableEndpoint(entry)) {
      if (!endpoints.some((e) => e.host === entry.host && e.port === entry.port)) {
        endpoints.push({ host: entry.host, port: entry.port, approvedAt: entry.approvedAt });
      }
    } else rejected.push(entry);
  }
  return { endpoints, rejected };
}

/** Idempotent append; atomic replace. Returns false when the entry was already there. */
export function addApprovedEndpoint(
  dataRoot: string,
  agentGroupId: string,
  endpoint: { host: string; port: number },
  now: Date = new Date(),
): boolean {
  if (!isApprovableEndpoint(endpoint)) throw new Error(`not an approvable endpoint: ${JSON.stringify(endpoint)}`);
  const file = approvedEndpointsPath(dataRoot, agentGroupId);
  let doc: { endpoints: unknown[] } = { endpoints: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { endpoints?: unknown };
    if (parsed && Array.isArray(parsed.endpoints)) doc = { ...parsed, endpoints: parsed.endpoints };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const exists = doc.endpoints.some(
    (e) => isApprovableEndpoint(e) && e.host === endpoint.host && e.port === endpoint.port,
  );
  if (exists) return false;
  doc.endpoints.push({ host: endpoint.host, port: endpoint.port, approvedAt: now.toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}
