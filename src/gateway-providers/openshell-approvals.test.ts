/**
 * OpenShell network approvals: denial detection from `openshell logs`, the
 * request handed to core's coordinator, and what follows each decision —
 * live apply, persistence, the agent's message — with dedupe, denial memory
 * and tail outages. Every dependency is a fake; no CLI, no host.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { readApprovedEndpoints, addApprovedEndpoint } from '../drivers/openshell/approved-endpoints.js';
import type { OpenShellCli } from '../drivers/openshell-driver.js';
import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalDecision, GatewayApprovalRequest } from './gateway-provider-registry.js';
import {
  OpenShellNetworkApprovals,
  parseDenialLine,
  type LogTail,
  type NetworkApprovalDeps,
} from './openshell-approvals.js';

// Real lines from `openshell logs <sandbox> --tail --source sandbox` (OpenShell 0.1.10).
const REAL_DENY =
  '[1795628222.282] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(381) -> example.com:443 [reason:transparent_tcp_policy_denied]';
const REAL_NOISE = [
  '[1795628222.277] [sandbox] [OCSF ] [ocsf] NET:REFUSE [MED] DENIED example.com [reason:policy_dns_ineligible]',
  '[1795628222.277] [sandbox] [OCSF ] [ocsf] CONFIG:OBSERVATION [INFO] Policy DNS staged unapproved name example.com synthetic=198.18.0.2 for TCP policy review',
  '[1795628222.282] [sandbox] [WARN ] [openshell_supervisor_network::proxy] Denied staged transparent connection destination=198.18.0.2:443 reason=endpoint example.com:443 is not allowed by any policy',
  '[1795628217.067] [sandbox] [OCSF ] [ocsf] NET:LISTEN [INFO] 127.0.0.1:3128',
  '[1795628222.181] [sandbox] [OCSF ] [ocsf] SSH:OPEN [INFO] ALLOWED',
];

describe('parseDenialLine', () => {
  it('reads the OCSF policy-denial line', () => {
    expect(parseDenialLine(REAL_DENY)).toEqual({
      atMs: 1795628222282,
      binary: '/usr/bin/curl',
      host: 'example.com',
      port: 443,
      reason: 'transparent_tcp_policy_denied',
    });
    expect(
      parseDenialLine(
        '[1795628222.463] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/bun(379) -> Example.ORG:8443 [reason:transparent_tcp_policy_denied]',
      ),
    ).toMatchObject({ binary: '/usr/local/bin/bun', host: 'example.org', port: 8443 });
  });

  it('ignores everything else, including denials that are not "no policy allows it"', () => {
    for (const line of REAL_NOISE) expect(parseDenialLine(line)).toBeNull();
    expect(parseDenialLine(REAL_DENY.replace('transparent_tcp_policy_denied', 'ssrf_private_ip'))).toBeNull();
    expect(parseDenialLine('')).toBeNull();
  });
});

/** A tail the test feeds and ends by hand. */
class FakeTail implements LogTail {
  listeners: Array<(line: string) => void> = [];
  stopped = false;
  end!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.end = resolve;
  });
  onLine(listener: (line: string) => void): void {
    this.listeners.push(listener);
  }
  emit(line: string): void {
    this.listeners.forEach((l) => l(line));
  }
  stop(): void {
    this.stopped = true;
    this.end();
  }
}

class RecordingCli implements OpenShellCli {
  readonly bin = 'openshell';
  calls: string[][] = [];
  fail: RegExp | null = null;
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    if (this.fail && this.fail.test(args.join(' '))) throw new Error('policy update failed');
    return '✓ Policy version 2 loaded';
  }
}

const deny = (atSec: number, host = 'example.com', port = 443, binary = '/usr/bin/curl') =>
  `[${atSec.toFixed(3)}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED ${binary}(1) -> ${host}:${port} [reason:transparent_tcp_policy_denied]`;

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await flush();
}

let root: string;
let clock: number;
let cli: RecordingCli;
let tails: Map<string, FakeTail[]>;
let notes: Array<{ sessionId: string; text: string }>;
let bridge: OpenShellNetworkApprovals;
let controller: AbortController;
let requests: GatewayApprovalRequest[];
let answer: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>;
let subscription: Promise<void>;

function makeBridge(over: Partial<NetworkApprovalDeps> = {}): void {
  bridge = new OpenShellNetworkApprovals({
    cli,
    startTail: (sandbox) => {
      const tail = new FakeTail();
      tails.set(sandbox, [...(tails.get(sandbox) ?? []), tail]);
      return tail;
    },
    dataRoot: root,
    notify: async (_group, sessionId, text) => {
      notes.push({ sessionId, text });
    },
    agentName: async () => 'Lab',
    now: () => clock,
    tailBackoffBaseMs: 1,
    ...over,
  });
}

function start(): void {
  controller = new AbortController();
  subscription = bridge.subscribe((request) => {
    requests.push(request);
    return answer(request);
  }, controller.signal);
}

const tail = (sandbox: string) => tails.get(sandbox)!.at(-1)!;
const nowSec = () => clock / 1000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-osa-'));
  clock = Date.parse('2026-11-25T12:00:00.000Z');
  cli = new RecordingCli();
  tails = new Map();
  notes = [];
  requests = [];
  answer = async () => 'approve';
  makeBridge();
});

afterEach(async () => {
  controller?.abort();
  await subscription;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenShellNetworkApprovals', () => {
  it('turns a denial into a policy card request, then applies, persists and tells the agent', async () => {
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-2', sandbox: 'nc-x-2' });
    bridge.watch({ agentGroupId: 'ag-other', sessionId: 'sess-3', sandbox: 'nc-x-3' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      trigger: 'policy',
      agentGroupId: 'ag-lab',
      sessionId: 'sess-1',
      destination: { host: 'example.com' },
      title: 'Allow network access?',
      displayFields: [
        { label: 'Agent', type: 'text', value: 'Lab' },
        { label: 'Destination', type: 'text', value: 'example.com:443' },
        { label: 'Program', type: 'text', value: '/usr/bin/curl' },
      ],
    });
    expect(requests[0].question).toMatch(/example\.com:443.*for good/);
    expect(Date.parse(requests[0].expiresAt!) - Date.parse(requests[0].createdAt)).toBe(30 * 60_000);
    // Core's renderer accepts it as is.
    const card = gatewayApprovalPresentation(requests[0]);
    expect(card.title).toBe('Allow network access?');
    expect(card.question).toContain('*Destination:* example.com:443');

    // Applied live to every running sandbox of the group, not to other groups.
    expect(cli.calls).toEqual(
      ['nc-x-1', 'nc-x-2'].map((sandbox) => [
        'policy',
        'update',
        sandbox,
        '--add-endpoint',
        'example.com:443',
        '--binary',
        '/**',
        '--rule-name',
        'nanoclaw_approved',
        '--wait',
        '--timeout',
        '60',
      ]),
    );
    expect(readApprovedEndpoints(root, 'ag-lab').endpoints).toMatchObject([{ host: 'example.com', port: 443 }]);
    expect(readApprovedEndpoints(root, 'ag-other').endpoints).toEqual([]);
    expect(notes.map((n) => [n.sessionId, n.text])).toEqual([
      ['sess-1', expect.stringMatching(/blocked.*admin has been asked/)],
      ['sess-1', expect.stringMatching(/approved access to example\.com:443.*Retry/)],
    ]);
  });

  it('cards once per (group, host, port) while pending, and tells every waiting session', async () => {
    const resolvers: Array<(d: GatewayApprovalDecision) => void> = [];
    answer = () => new Promise((resolve) => resolvers.push(resolve));
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-2', sandbox: 'nc-x-2' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    tail('nc-x-1').emit(deny(nowSec() + 2));
    tail('nc-x-2').emit(deny(nowSec() + 3, 'example.com', 443, '/usr/local/bin/bun'));
    tail('nc-x-1').emit(deny(nowSec() + 4, 'example.com', 8443));
    await settle();
    expect(requests.map((r) => r.displayFields![1].value)).toEqual(['example.com:443', 'example.com:8443']);
    resolvers[0]('approve');
    await settle();
    const approvals = notes.filter((n) => /approved access to example\.com:443/.test(n.text));
    expect(approvals.map((n) => n.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('remembers a refusal: no new card for the same destination until the memory lapses', async () => {
    answer = async () => 'deny';
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    await settle();
    expect(requests).toHaveLength(1);
    expect(cli.calls).toEqual([]);
    expect(readApprovedEndpoints(root, 'ag-lab').endpoints).toEqual([]);
    expect(notes.at(-1)!.text).toMatch(/example\.com:443 was not approved.*Do not retry/);

    clock += 14 * 60_000;
    tail('nc-x-1').emit(deny(nowSec()));
    await settle();
    expect(requests).toHaveLength(1);

    clock += 2 * 60_000;
    tail('nc-x-1').emit(deny(nowSec()));
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('ignores replayed and pre-watch events, IP literals and internal names', async () => {
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    tail('nc-x-1').emit(deny(nowSec() - 60)); // buffer replay from before the watch
    tail('nc-x-1').emit(deny(nowSec() + 1, '1.1.1.1'));
    tail('nc-x-1').emit(deny(nowSec() + 2, 'host.docker.internal', 10255));
    await settle();
    expect(requests).toEqual([]);

    // The tail ends and reconnects; its replayed buffer is behind the cursor.
    tail('nc-x-1').emit(deny(nowSec() + 3, 'a.example.com'));
    await settle();
    expect(requests).toHaveLength(1);
    tail('nc-x-1').end();
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    expect(tails.get('nc-x-1')).toHaveLength(2);
    answer = async () => {
      throw new Error('must not card again');
    };
    tail('nc-x-1').emit(deny(nowSec() + 2.5, 'b.example.com'));
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('re-sends an already-approved endpoint to a sandbox that still denies it, without a card', async () => {
    addApprovedEndpoint(root, 'ag-lab', { host: 'example.com', port: 443 });
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    tail('nc-x-1').emit(deny(nowSec() + 2));
    await settle();
    expect(requests).toEqual([]);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0].slice(0, 5)).toEqual(['policy', 'update', 'nc-x-1', '--add-endpoint', 'example.com:443']);
  });

  it('persists an approval even when the live apply fails, and says it lands next session', async () => {
    cli.fail = /policy update/;
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    await settle();
    expect(readApprovedEndpoints(root, 'ag-lab').endpoints).toHaveLength(1);
    expect(notes.at(-1)!.text).toMatch(/could not be applied.*next session/);
  });

  it('treats a decision cut short by shutdown as no answer: nothing remembered, nothing told', async () => {
    let decideNow!: (d: GatewayApprovalDecision) => void;
    answer = () => new Promise((resolve) => (decideNow = resolve));
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    tail('nc-x-1').emit(deny(nowSec() + 1));
    await settle();
    controller.abort();
    decideNow('deny');
    await settle();
    expect(notes).toHaveLength(1); // only the "asked an admin" note
    expect(tail('nc-x-1').stopped).toBe(true);
  });

  it('tails only while subscribed and while the session is watched', async () => {
    const unwatch = bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    expect(tails.get('nc-x-1')).toBeUndefined();
    start();
    await settle();
    expect(tails.get('nc-x-1')).toHaveLength(1);
    unwatch();
    expect(tail('nc-x-1').stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(tails.get('nc-x-1')).toHaveLength(1);
    // A late watch while subscribed starts at once.
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-2', sandbox: 'nc-x-2' });
    expect(tails.get('nc-x-2')).toHaveLength(1);
  });

  it('caps pending cards per group', async () => {
    answer = () => new Promise(() => {});
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    for (let i = 0; i < 5; i++) tail('nc-x-1').emit(deny(nowSec() + i + 1, `h${i}.example.com`));
    await settle();
    expect(requests).toHaveLength(3);
  });

  it('keeps tailing through a tail that keeps failing, and never rejects', async () => {
    bridge.watch({ agentGroupId: 'ag-lab', sessionId: 'sess-1', sandbox: 'nc-x-1' });
    start();
    for (let i = 0; i < 3; i++) {
      tail('nc-x-1').end();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(tails.get('nc-x-1')!.length).toBeGreaterThanOrEqual(3);
    controller.abort();
    await expect(subscription).resolves.toBeUndefined();
  });
});
