/**
 * Network approvals for agent groups whose credentials come from OpenShell
 * providers (the partition in openshell.ts).
 *
 * Such a sandbox has no gateway proxy: its egress is exactly its OpenShell
 * policy, and OpenShell refuses everything else at once (there is no held
 * request to approve, unlike OneCLI). So this bridge works one rule at a time:
 *
 * 1. Detect: `openshell logs <sandbox> --tail --source sandbox` per watched
 *    sandbox; a deny is the OCSF line
 *    `NET:OPEN [MED] DENIED /usr/bin/curl(381) -> example.com:443 [reason:transparent_tcp_policy_denied]`.
 * 2. Ask: the denial becomes a gateway approval request through the core
 *    coordinator (`decide`), which owns approver routing, `pending_approvals`,
 *    the card, click auth and expiry. One card per (group, host, port) while
 *    it is pending; a refusal is remembered for `DENIAL_MEMORY_MS` so an agent
 *    retrying in a loop cannot spam cards.
 * 3. Apply: on approval the endpoint is persisted for the group
 *    (approved-endpoints.ts; every new sandbox of the group gets it) and added
 *    live to each of the group's running sandboxes with
 *    `openshell policy update --add-endpoint host:port --binary '/**' --rule-name nanoclaw_approved --wait`.
 * 4. Tell the agent: the request already failed, so the outcome reaches the
 *    session as a system message (core's `notifyAgent`) — "approved, retry" or
 *    "not approved".
 *
 * Only exact DNS names qualify (approved-endpoints.ts); a denial for an IP
 * literal or an internal name is logged and never carded.
 *
 * Outage: a log tail that ends (sandbox gone, OpenShell gateway down) is
 * restarted with backoff. Denial stays enforced by OpenShell whatever this
 * bridge's state, so an outage here costs cards, not containment — it stops
 * no session, and never reaches the base gateway's groups.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import readline from 'readline';

import {
  addApprovedEndpoint,
  APPROVED_RULE,
  isApprovableHost,
  isApprovablePort,
  readApprovedEndpoints,
} from '../drivers/openshell/approved-endpoints.js';
import type { OpenShellCli } from '../drivers/openshell-driver.js';
import { log } from '../log.js';
import type { GatewayApprovalDecision, GatewayApprovalRequest } from './gateway-provider-registry.js';

/** How long a refused (group, host, port) stays quiet before a new denial may card again. */
export const DENIAL_MEMORY_MS = 15 * 60_000;
/** How long a card stays answerable. Nothing is held meanwhile, so this can outlast OneCLI's two minutes. */
export const APPROVAL_WINDOW_MS = 30 * 60_000;
const MAX_PENDING_PER_GROUP = 3;
const APPLY_WAIT_S = 60;
const TAIL_BACKOFF_BASE_MS = 1_000;
const TAIL_BACKOFF_MAX_MS = 30_000;
/** A tail that ran this long before ending was healthy: restart from the base backoff. */
const TAIL_HEALTHY_MS = 30_000;
/** The VM's clock and the host's can differ slightly; events this close before watch start still count. */
const CLOCK_SLACK_MS = 2_000;

export interface DenialEvent {
  /** Event time, epoch ms (the sandbox's clock). */
  atMs: number;
  binary: string;
  host: string;
  port: number;
  reason: string;
}

const DENIAL_LINE =
  /^\[(\d+(?:\.\d+)?)\]\s+\[sandbox\]\s+\[OCSF\s*\]\s+\[ocsf\]\s+NET:OPEN\s+\[[A-Z]+\]\s+DENIED\s+(\S+?)(?:\(\d+\))?\s+->\s+(\S+):(\d{1,5})\s+\[reason:([a-z0-9_]+)\]/;

/** One `openshell logs` line → a policy denial, or null for anything else. */
export function parseDenialLine(line: string): DenialEvent | null {
  const m = DENIAL_LINE.exec(line);
  if (!m) return null;
  const reason = m[5];
  // Only "no policy allows this endpoint"; an SSRF or other guard refusal is not ours to override.
  if (!reason.endsWith('_policy_denied')) return null;
  return {
    atMs: Math.round(Number(m[1]) * 1000),
    binary: m[2].slice(0, 200),
    host: m[3].toLowerCase(),
    port: Number(m[4]),
    reason,
  };
}

export interface LogTail {
  onLine(listener: (line: string) => void): void;
  /** Settles when the tail ends, for any reason. */
  readonly closed: Promise<void>;
  stop(): void;
}

export type StartLogTail = (sandbox: string) => LogTail;

export function realLogTail(bin = 'openshell'): StartLogTail {
  return (sandbox) => {
    // `-n` only trims the replayed buffer; the cursor below skips what was seen.
    const child = spawn(bin, ['logs', sandbox, '--tail', '--source', 'sandbox', '-n', '50'], {
      env: { ...process.env, OPENSHELL_COLOR: 'never' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const listeners: Array<(line: string) => void> = [];
    readline.createInterface({ input: child.stdout }).on('line', (line) => listeners.forEach((l) => l(line)));
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    const closed = new Promise<void>((resolve) => {
      child.once('error', (err) => {
        stderr ||= err.message;
        resolve();
      });
      child.once('close', (code) => {
        if (code && stderr) log.debug('OpenShell log tail exited', { sandbox, code, stderr: stderr.trim() });
        resolve();
      });
    });
    return {
      onLine: (listener) => listeners.push(listener),
      closed,
      stop: () => {
        if (child.exitCode === null) child.kill('SIGTERM');
      },
    };
  };
}

export interface NetworkApprovalDeps {
  cli: OpenShellCli;
  startTail: StartLogTail;
  /** DATA_DIR: where `openshell-policy/<group>.json` lives. */
  dataRoot: string;
  /** Write a system message into the session and wake it. */
  notify(agentGroupId: string, sessionId: string, text: string): Promise<void>;
  agentName(agentGroupId: string): Promise<string>;
  now?: () => number;
  denialMemoryMs?: number;
  approvalWindowMs?: number;
  tailBackoffBaseMs?: number;
}

export interface WatchedSandbox {
  agentGroupId: string;
  sessionId: string;
  sandbox: string;
}

interface Watched extends WatchedSandbox {
  /** Events at or before this (sandbox clock, ms) were seen already, or predate the watch. */
  cursor: number;
  tail?: { stop(): void; abort: AbortController };
  /** Approved endpoints this sandbox was re-sent after denying one (a race with a policy update). */
  resent: Set<string>;
}

type Decide = (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>;

export class OpenShellNetworkApprovals {
  readonly #deps: NetworkApprovalDeps;
  readonly #now: () => number;
  readonly #watched = new Map<string, Watched>();
  /** group\0host\0port → sessions waiting on that card. */
  readonly #pending = new Map<string, { agentGroupId: string; sessions: Map<string, Watched> }>();
  /** group\0host\0port → refused until (ms). */
  readonly #refused = new Map<string, number>();
  #active: { decide: Decide; signal: AbortSignal } | null = null;

  constructor(deps: NetworkApprovalDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Called from the session lease: watch this sandbox while the session lives. Returns the unwatch. */
  watch(target: WatchedSandbox): () => void {
    const previous = this.#watched.get(target.sandbox);
    if (previous) this.#stopTail(previous);
    const entry: Watched = { ...target, cursor: this.#now() - CLOCK_SLACK_MS, resent: new Set() };
    this.#watched.set(target.sandbox, entry);
    if (this.#active) this.#startTail(entry);
    return () => {
      if (this.#watched.get(target.sandbox) !== entry) return;
      this.#stopTail(entry);
      this.#watched.delete(target.sandbox);
    };
  }

  /** Runs until `signal` aborts. Never rejects: a failure here must not reach the base gateway. */
  async subscribe(decide: Decide, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (this.#active) throw new Error('OpenShell network approvals already subscribed');
    this.#active = { decide, signal };
    for (const entry of this.#watched.values()) this.#startTail(entry);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    for (const entry of this.#watched.values()) this.#stopTail(entry);
    this.#active = null;
  }

  #startTail(entry: Watched): void {
    if (entry.tail) return;
    const abort = new AbortController();
    const control = { stop: () => {}, abort };
    entry.tail = control;
    void this.#runTail(entry, control).catch((err) =>
      log.error('OpenShell log tail supervisor failed', { sandbox: entry.sandbox, err }),
    );
  }

  #stopTail(entry: Watched): void {
    if (!entry.tail) return;
    entry.tail.abort.abort();
    entry.tail.stop();
    entry.tail = undefined;
  }

  async #runTail(entry: Watched, control: { stop: () => void; abort: AbortController }): Promise<void> {
    const base = this.#deps.tailBackoffBaseMs ?? TAIL_BACKOFF_BASE_MS;
    let backoff = base;
    while (!control.abort.signal.aborted) {
      const started = this.#now();
      const tail = this.#deps.startTail(entry.sandbox);
      control.stop = () => tail.stop();
      if (control.abort.signal.aborted) {
        tail.stop();
        break;
      }
      tail.onLine((line) => this.#onLine(entry, line));
      await tail.closed;
      if (control.abort.signal.aborted) break;
      if (this.#now() - started >= TAIL_HEALTHY_MS) backoff = base;
      log.warn('OpenShell log tail ended; network approvals for this sandbox resume when it reconnects', {
        sandbox: entry.sandbox,
        agentGroupId: entry.agentGroupId,
        retryInMs: backoff,
      });
      await sleep(backoff, control.abort.signal);
      backoff = Math.min(backoff * 2, TAIL_BACKOFF_MAX_MS);
    }
  }

  #onLine(entry: Watched, line: string): void {
    const event = parseDenialLine(line);
    if (!event || event.atMs < entry.cursor) return;
    entry.cursor = event.atMs;
    void this.#onDenial(entry, event).catch((err) =>
      log.error('OpenShell network approval failed', { sandbox: entry.sandbox, host: event.host, err }),
    );
  }

  async #onDenial(entry: Watched, event: DenialEvent): Promise<void> {
    const active = this.#active;
    if (!active || active.signal.aborted) return;
    const { host, port } = event;
    const { agentGroupId } = entry;
    if (!isApprovableHost(host) || !isApprovablePort(port)) {
      log.info('OpenShell denied egress that cannot be approved by card (not an exact DNS name)', {
        agentGroupId,
        sandbox: entry.sandbox,
        destination: `${host}:${port}`,
      });
      return;
    }
    const endpoint = `${host}:${port}`;
    const key = `${agentGroupId}\0${endpoint}`;

    if (this.#isApproved(agentGroupId, host, port)) {
      // Approved already (persisted) but this sandbox missed the live update: send it once.
      if (entry.resent.has(endpoint)) return;
      entry.resent.add(endpoint);
      await this.#apply(entry.sandbox, endpoint).catch((err) =>
        log.warn('OpenShell approved endpoint could not be re-applied', { sandbox: entry.sandbox, endpoint, err }),
      );
      return;
    }
    const waiting = this.#pending.get(key);
    if (waiting) {
      waiting.sessions.set(entry.sessionId, entry);
      return;
    }
    const refusedUntil = this.#refused.get(key);
    if (refusedUntil !== undefined) {
      if (refusedUntil > this.#now()) return;
      this.#refused.delete(key);
    }
    const groupPending = [...this.#pending.values()].filter((p) => p.agentGroupId === agentGroupId).length;
    if (groupPending >= MAX_PENDING_PER_GROUP) {
      log.info('OpenShell network approval not carded: too many pending for this group', {
        agentGroupId,
        destination: endpoint,
      });
      return;
    }

    const sessions = new Map([[entry.sessionId, entry]]);
    this.#pending.set(key, { agentGroupId, sessions });
    let decision: GatewayApprovalDecision;
    try {
      await this.#tell(
        entry,
        `Your connection to ${endpoint} was blocked by your sandbox's network policy. An admin has been asked ` +
          'to allow it; you will get a message with the decision. Until then, do not retry it.',
      );
      decision = await active.decide(await this.#request(entry, event));
    } catch (err) {
      this.#pending.delete(key);
      throw err;
    }
    if (active.signal.aborted) {
      // Host shutting down: the coordinator denied everything in flight; that is not an answer.
      this.#pending.delete(key);
      return;
    }
    try {
      if (decision === 'approve') await this.#approved(agentGroupId, host, port, sessions);
      else {
        this.#refused.set(key, this.#now() + (this.#deps.denialMemoryMs ?? DENIAL_MEMORY_MS));
        log.info('OpenShell network access not approved', { agentGroupId, destination: endpoint, decision });
        for (const waiter of sessions.values()) {
          await this.#tell(
            waiter,
            `Access to ${endpoint} was not approved (rejected, or no admin answered in time), so it stays ` +
              'blocked. Do not retry it; if the task needs it, tell the user so an admin can allow it.',
          );
        }
      }
    } finally {
      this.#pending.delete(key);
    }
  }

  async #approved(agentGroupId: string, host: string, port: number, waiting: Map<string, Watched>): Promise<void> {
    const endpoint = `${host}:${port}`;
    addApprovedEndpoint(this.#deps.dataRoot, agentGroupId, { host, port }, new Date(this.#now()));
    const sandboxes = [...this.#watched.values()].filter((w) => w.agentGroupId === agentGroupId);
    const started = this.#now();
    const results = new Map<string, unknown>();
    await Promise.all(
      sandboxes.map(async (w) => {
        try {
          await this.#apply(w.sandbox, endpoint);
          w.resent.add(endpoint);
        } catch (err) {
          results.set(w.sandbox, err);
        }
      }),
    );
    log.info('OpenShell network access approved and applied', {
      agentGroupId,
      destination: endpoint,
      sandboxes: sandboxes.map((w) => w.sandbox),
      failed: [...results.keys()],
      applyMs: this.#now() - started,
    });
    for (const waiter of waiting.values()) {
      const err = results.get(waiter.sandbox);
      if (!err && this.#watched.get(waiter.sandbox) === waiter) {
        await this.#tell(
          waiter,
          `An admin approved access to ${endpoint} and it is now allowed in your sandbox. Retry the request that was blocked.`,
        );
      } else {
        if (err) log.warn('OpenShell approved endpoint not applied live', { sandbox: waiter.sandbox, endpoint, err });
        await this.#tell(
          waiter,
          `An admin approved access to ${endpoint}, but it could not be applied to your running sandbox. ` +
            'It takes effect in your next session; tell the user.',
        );
      }
    }
  }

  #isApproved(agentGroupId: string, host: string, port: number): boolean {
    try {
      return readApprovedEndpoints(this.#deps.dataRoot, agentGroupId).endpoints.some(
        (e) => e.host === host && e.port === port,
      );
    } catch {
      return false;
    }
  }

  async #apply(sandbox: string, endpoint: string): Promise<void> {
    // Any binary: the card approves a destination for the agent, and every
    // binary in the sandbox runs on the agent's behalf (scoping to the denied
    // one would only card the same host again for the next tool).
    await this.#deps.cli.run(
      [
        'policy',
        'update',
        sandbox,
        '--add-endpoint',
        endpoint,
        '--binary',
        '/**',
        '--rule-name',
        APPROVED_RULE,
        '--wait',
        '--timeout',
        String(APPLY_WAIT_S),
      ],
      { timeoutMs: (APPLY_WAIT_S + 30) * 1000 },
    );
  }

  async #request(entry: Watched, event: DenialEvent): Promise<GatewayApprovalRequest> {
    const now = this.#now();
    const endpoint = `${event.host}:${event.port}`;
    const agent = await this.#deps.agentName(entry.agentGroupId).catch(() => entry.agentGroupId);
    return {
      // A card always: never the coordinator's "default" shortcuts, which consult the base gateway's credentials.
      trigger: 'policy',
      id: `openshell-net-${randomBytes(8).toString('hex')}`,
      agentGroupId: entry.agentGroupId,
      sessionId: entry.sessionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.#deps.approvalWindowMs ?? APPROVAL_WINDOW_MS)).toISOString(),
      destination: { host: event.host },
      title: 'Allow network access?',
      // Plain text, no displayFields: a request with displayFields needs a registered
      // card renderer, and a channel without one (Telegram today) fails it closed.
      question:
        `${agent} tried to connect to ${endpoint} (program ${event.binary}). Its network policy does not allow that, ` +
        "so it was blocked. Approving adds this host and port to the agent's policy for good (every session, " +
        'also after restarts) until an operator removes it.',
      audit: { source: 'openshell', sandbox: entry.sandbox, host: event.host, port: event.port },
    };
  }

  async #tell(entry: Watched, text: string): Promise<void> {
    try {
      await this.#deps.notify(entry.agentGroupId, entry.sessionId, text);
    } catch (err) {
      log.warn('Could not tell the agent about a network approval', { sessionId: entry.sessionId, err });
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
