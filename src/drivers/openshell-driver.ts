/**
 * OpenShell driver (prototype) — sessions as OpenShell sandboxes on the
 * gateway's MicroVM compute driver, by shelling out to the `openshell` CLI.
 *
 * Contract → CLI:
 *   prepare   validate + translate (pure, `openshell/translate.ts`), stage
 *             single files and the policy YAML on the host. Nothing runs yet:
 *             `sandbox create` starts the main process, so it belongs to start.
 *             An existing live sandbox wearing this key's labels IS the session.
 *   start     `sandbox create --detach` (waits for Ready), lazily starting the
 *             loopback proxy forwarder first.
 *   status    `sandbox get -o json` → phase (Ready/Completed/Error/...).
 *   stop      `sandbox delete` (idempotent) + staging cleanup.
 *   list      `sandbox list --selector nanoclaw-install=<slug>,nanoclaw-role=agent`
 *             — handles rebuilt from labels alone.
 *   watch     ONE polling loop per install over `sandbox list` (the CLI has
 *             no event stream); bounded backoff, never gives up.
 *   reap      delete terminal sandboxes of this install + orphaned staging.
 *   exec      describes `openshell sandbox exec` argv; never runs it.
 *
 * Only sandboxes carrying this install's labels are ever listed, stopped or
 * reaped — other sandboxes on the gateway are invisible to this driver.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { stringify } from 'yaml';

import { log } from '../log.js';

import { validateRuntimeName } from './cli.js';
import { startForwarder, type Forwarder } from './openshell/forwarder.js';
import {
  RUNNER_LOG,
  sandboxName,
  sandboxNamePrefix,
  translateSpec,
  type MountProbe,
  type SandboxPlan,
} from './openshell/translate.js';
import {
  LABELS,
  asFailureError,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type NetworkReconcile,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

/** Async on purpose: a first VM boot takes ~35 s, which a sync exec would block the host for. */
export interface OpenShellCli {
  readonly bin: string;
  /** Resolves stdout; rejects on non-zero exit with stderr in the message. */
  run(args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 240_000;
const LINT_TIMEOUT_MS = 15_000;
/** Old CLIs reject the unknown subcommand at argument parsing. */
const LINT_MISSING = /unrecognized subcommand|unknown (sub)?command|invalid subcommand|unexpected argument 'lint'/i;
const FORWARD_ANNOTATION = 'nanoclaw-forward';

export function realOpenShellCli(bin = 'openshell'): OpenShellCli {
  return {
    bin,
    run(args, opts) {
      return new Promise((resolve, reject) => {
        execFile(
          bin,
          args,
          {
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, OPENSHELL_COLOR: 'never', ...(opts?.env ?? {}) },
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`${error.message}\n${String(stderr)}`, { cause: error }));
              return;
            }
            resolve(String(stdout));
          },
        );
      });
    },
  };
}

export const fsProbe: MountProbe = {
  kind(hostPath) {
    try {
      return fs.statSync(hostPath).isDirectory() ? 'dir' : 'file';
    } catch {
      return 'missing';
    }
  },
  realpath: (hostPath) => fs.realpathSync(hostPath),
};

export interface OpenShellDriverOptions extends MountPolicy {
  cli?: OpenShellCli;
  /** Host loopback port the proxy forwarder listens on (NANOCLAW_OPENSHELL_FORWARD_PORT). */
  forwardPort: number;
  /** Where per-session staged files and policy YAML live (under DATA_DIR). */
  stagingRoot: string;
  namePrefix?: string;
  pollMs?: number;
  probe?: MountProbe;
  /** Test seam. */
  startForwarder?: (listenPort: number, targetPort: number) => Promise<Forwarder>;
}

interface SandboxDoc {
  name?: string;
  phase?: string;
  exit_code?: number | null;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** OpenShell phase → the seam's two views of it. Pure; unknown phases count as live. */
export function mapSandboxPhase(
  phase: string | undefined,
  exitCode: number | null | undefined,
): { listed: SessionPhase; status: SessionStatus; failure?: SessionFailure } {
  switch (phase) {
    case 'Ready':
      return { listed: 'running', status: { phase: 'running' } };
    case 'Completed':
      return { listed: 'terminal', status: { phase: 'stopped' } };
    case 'Error':
    case 'Failed': {
      const failure: SessionFailure = {
        kind: 'started-then-died',
        retryable: false,
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
      };
      return { listed: 'terminal', status: { phase: 'failed', failure }, failure };
    }
    case 'Deleting':
    case 'Deleted':
    case 'Stopped':
    case 'Suspended':
      return { listed: 'terminal', status: { phase: 'stopped' } };
    default:
      // Provisioning / Pending / Starting / unknown: booting, not a corpse.
      return { listed: 'starting', status: { phase: 'running' } };
  }
}

const NOT_FOUND = /not found|NotFound|does not exist/i;

export function normalizeOpenShellError(error: unknown): Error & SessionFailure {
  const msg = error instanceof Error ? error.message : String(error);
  const failure: SessionFailure =
    /manifest unknown|pull access denied|image .*not found|No such image|failed to (pull|resolve) image/i.test(msg)
      ? { kind: 'image-unavailable', retryable: true }
      : /ENOENT|connection refused|transport error|Unavailable|gateway .*(unreachable|not running)|deadline exceeded|ETIMEDOUT|timed out/i.test(
            msg,
          )
        ? { kind: 'runtime-unavailable', retryable: true }
        : /no space left|cannot allocate memory|resource(s)? exhausted|quota/i.test(msg)
          ? { kind: 'resources-exhausted', retryable: true }
          : { kind: 'unknown', retryable: false, opaqueRef: `openshell-${Date.now()}` };
  if (failure.kind === 'unknown') log.warn('OpenShell CLI failed', { opaqueRef: failure.opaqueRef, error: msg.trim() });
  return asFailureError(failure);
}

function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  /** Last observed listed phase per key; a key that vanishes was a terminal. */
  seen: Map<string, { key: SessionKey; phase: SessionPhase }>;
  attempt: number;
  timer?: NodeJS.Timeout;
  primed: boolean;
}

export class OpenShellSessionDriver implements SessionDriver {
  readonly kind = 'openshell' as const;
  readonly #cli: OpenShellCli;
  readonly #policy: MountPolicy;
  readonly #prefix: string;
  readonly #probe: MountProbe;
  readonly #pollMs: number;
  readonly #watches = new Map<string, InstallWatch>();
  #forwarder: Promise<Forwarder> | null = null;
  #lintUnsupported = false;

  constructor(private readonly opts: OpenShellDriverOptions) {
    this.#cli = opts.cli ?? realOpenShellCli();
    this.#policy = opts;
    this.#prefix = opts.namePrefix ?? 'nc-';
    this.#probe = opts.probe ?? fsProbe;
    this.#pollMs = opts.pollMs ?? 3_000;
  }

  capabilities(): DriverCapabilities {
    return {
      // A MicroVM is at least container isolation; a group configured for
      // either tier is realizable.
      isolationTiers: ['vm', 'container'],
      // `--provider`: OpenShell resolves each provider's placeholder at egress.
      credentialProviders: true,
      admissionEnforced: false,
      // OpenShell enforces egress declaratively from the per-sandbox policy.
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      // VM sizing is gateway-wide on the vm compute driver.
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      // Images come from the local Docker store via `--from`; this driver
      // builds nothing itself.
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    const out = await this.#cli.run(['status'], { timeoutMs: 10_000 }).catch((err: unknown) => {
      throw normalizeOpenShellError(err);
    });
    if (!/Status:\s*Connected/i.test(out)) {
      throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
  }

  async reconcileNetworkAccess(): Promise<NetworkReconcile> {
    // The policy travels with the sandbox and the Docker egress network does
    // not apply here: nothing to re-realize on adoption.
    return 'kept';
  }

  stagingDir(name: string): string {
    return path.join(this.opts.stagingRoot, name);
  }

  /** Runner output for one sandbox name; kept after stop (unlike staging) for diagnosis. */
  logsDir(name: string): string {
    return path.join(path.dirname(this.opts.stagingRoot), 'openshell-logs', name);
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());
    const name = validateRuntimeName(sandboxName(spec.key, this.#prefix), 'sandbox');

    const existing = await this.#get(name);
    if (existing) {
      const labels = existing.labels ?? {};
      if (
        labels[LABELS.install] !== spec.key.installSlug ||
        labels[LABELS.group] !== spec.key.agentGroupId ||
        labels[LABELS.session] !== spec.key.sessionId
      ) {
        log.warn('Sandbox name collision: existing sandbox is not this session', { name, wanted: spec.key, labels });
        throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
      }
      if (mapSandboxPhase(existing.phase, existing.exit_code).listed !== 'terminal') {
        await this.#ensureForwarderFromAnnotation(existing);
        return new OpenShellHandle(spec.key, name, this, null);
      }
      // A corpse under our name: clear it so the fresh incarnation can claim it.
      await this.deleteSandbox(name);
    }

    const stagingDir = this.stagingDir(name);
    const logsDir = this.logsDir(name);
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const runnerLog = path.join(logsDir, RUNNER_LOG);
    if (fs.existsSync(runnerLog)) fs.renameSync(runnerLog, path.join(logsDir, `prev-${RUNNER_LOG}`));
    const plan = translateSpec(spec, {
      logsDir,
      name,
      stagingFilesDir: path.join(stagingDir, 'files'),
      forwardPort: this.opts.forwardPort,
      probe: this.#probe,
      imageEnv: await imageEnvOf(spec.containers[0]?.image),
    });
    for (const drop of plan.dropped) {
      log.debug('OpenShell: mount not realized separately', { name, ...drop });
    }
    if (plan.unsizedResources.length > 0) {
      log.info('OpenShell: VM sizing is gateway-wide; per-session resource limits are not applied', {
        name,
        resources: plan.unsizedResources,
      });
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(stagingDir, 'files'), { recursive: true, mode: 0o700 });
    for (const file of plan.staged) {
      fs.copyFileSync(file.source, path.join(stagingDir, 'files', file.stagedName));
    }
    const policyFile = path.join(stagingDir, 'policy.yaml');
    fs.writeFileSync(policyFile, stringify(plan.policy), { mode: 0o600 });
    try {
      await this.#lintPolicy(policyFile);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
    return new OpenShellHandle(spec.key, name, this, plan);
  }

  /**
   * `openshell policy lint` (0.1.10+) validates the generated policy offline.
   * A rejection fails the spawn with the lint output; a CLI without the
   * subcommand is skipped (warned once) so older gateways keep working.
   */
  async #lintPolicy(file: string): Promise<void> {
    if (this.#lintUnsupported) return;
    try {
      await this.#cli.run(['policy', 'lint', file], { timeoutMs: LINT_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (LINT_MISSING.test(msg)) {
        this.#lintUnsupported = true;
        log.warn('OpenShell CLI has no `policy lint`; generated policies are not pre-validated');
        return;
      }
      if (/ETIMEDOUT|timed out|ENOENT|SIGTERM/i.test(msg)) throw normalizeOpenShellError(err);
      throw specInvalid(`policy lint failed: ${msg.trim()}`);
    }
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const docs = await this.#list(installSlug);
    const snapshots: SessionSnapshot[] = [];
    for (const doc of docs) {
      const labels = doc.labels ?? {};
      const agentGroupId = labels[LABELS.group];
      const sessionId = labels[LABELS.session];
      if (!doc.name || !agentGroupId || !sessionId) continue;
      const mapped = mapSandboxPhase(doc.phase, doc.exit_code);
      // Adopted live sessions still need their proxy hop after a host restart.
      if (mapped.listed !== 'terminal') await this.#ensureForwarderFromAnnotation(doc);
      snapshots.push({
        handle: new OpenShellHandle({ installSlug, agentGroupId, sessionId }, doc.name, this, null),
        phase: mapped.listed,
        ...(mapped.failure ? { failure: mapped.failure } : {}),
      });
    }
    return snapshots;
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), seen: new Map(), attempt: 0, primed: false };
      this.#watches.set(installSlug, watch);
      this.#schedulePoll(installSlug, watch, 0);
    }
    watch.subscribers.add(onEvent);
    const current = watch;
    return {
      stop: () => {
        current.subscribers.delete(onEvent);
        if (current.subscribers.size === 0) {
          if (current.timer) clearTimeout(current.timer);
          this.#watches.delete(installSlug);
        }
      },
    };
  }

  #schedulePoll(installSlug: string, watch: InstallWatch, delay: number): void {
    watch.timer = setTimeout(() => void this.#poll(installSlug, watch), delay);
    watch.timer.unref?.();
  }

  /**
   * One poll: diff the listed phases against the previous poll. A key that
   * turned terminal or vanished is a 'terminal' hint; any other change is a
   * 'phase' hint. Hints only — the session-events hub re-reads truth.
   */
  async #poll(installSlug: string, watch: InstallWatch): Promise<void> {
    if (this.#watches.get(installSlug) !== watch) return;
    let docs: SandboxDoc[];
    try {
      docs = await this.#list(installSlug);
    } catch (err) {
      const delay = Math.min(this.#pollMs * 2 ** ++watch.attempt, 30_000);
      log.debug('OpenShell watch poll failed; backing off', { delayMs: delay, err });
      this.#schedulePoll(installSlug, watch, delay);
      return;
    }
    watch.attempt = 0;
    const next = new Map<string, { key: SessionKey; phase: SessionPhase }>();
    for (const doc of docs) {
      const labels = doc.labels ?? {};
      if (!labels[LABELS.group] || !labels[LABELS.session]) continue;
      const key = { installSlug, agentGroupId: labels[LABELS.group], sessionId: labels[LABELS.session] };
      next.set(keyId(key), { key, phase: mapSandboxPhase(doc.phase, doc.exit_code).listed });
    }
    if (watch.primed) {
      for (const [id, prev] of watch.seen) {
        const now = next.get(id);
        if (!now) this.emit({ key: prev.key, kind: 'terminal' });
        else if (now.phase !== prev.phase) {
          this.emit({ key: now.key, kind: now.phase === 'terminal' ? 'terminal' : 'phase' });
        }
      }
      for (const [id, now] of next) {
        if (!watch.seen.has(id)) this.emit({ key: now.key, kind: now.phase === 'terminal' ? 'terminal' : 'phase' });
      }
    } else {
      // First poll after (re)subscribing: corpses already present are hinted
      // once so the hub can settle them; live ones are just recorded.
      for (const now of next.values()) if (now.phase === 'terminal') this.emit({ key: now.key, kind: 'terminal' });
      watch.primed = true;
    }
    watch.seen = next;
    this.#schedulePoll(installSlug, watch, this.#pollMs);
  }

  /** Handle-observed transitions ride the same stream as poll hints. */
  readonly emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  async reapResidue(installSlug: string): Promise<void> {
    let docs: SandboxDoc[];
    try {
      docs = await this.#list(installSlug);
    } catch (err) {
      log.warn('OpenShell: could not list sandboxes for residue reaping', { err });
      return;
    }
    const keep = new Set<string>();
    for (const doc of docs) {
      if (!doc.name) continue;
      if (mapSandboxPhase(doc.phase, doc.exit_code).listed === 'terminal') {
        try {
          await this.deleteSandbox(doc.name);
          log.info('OpenShell: removed terminal sandbox', { name: doc.name });
        } catch (err) {
          log.warn('OpenShell: failed to remove terminal sandbox', { name: doc.name, err });
          keep.add(doc.name);
        }
      } else {
        keep.add(doc.name);
      }
    }
    // Staging dirs are named after sandboxes; this install's prefix only.
    const ownPrefix = sandboxNamePrefix(installSlug, this.#prefix);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.opts.stagingRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(ownPrefix) || keep.has(entry)) continue;
      fs.rmSync(path.join(this.opts.stagingRoot, entry), { recursive: true, force: true });
    }
  }

  // ---------- CLI plumbing shared with handles ----------

  async getSandbox(name: string): Promise<SandboxDoc | null> {
    return this.#get(name);
  }

  async #get(name: string): Promise<SandboxDoc | null> {
    try {
      return JSON.parse(await this.#cli.run(['sandbox', 'get', name, '-o', 'json'])) as SandboxDoc;
    } catch (err) {
      if (NOT_FOUND.test(err instanceof Error ? err.message : String(err))) return null;
      throw normalizeOpenShellError(err);
    }
  }

  async #list(installSlug: string): Promise<SandboxDoc[]> {
    const out: SandboxDoc[] = [];
    let token = '';
    for (let page = 0; page < 50; page++) {
      let raw: string;
      try {
        raw = await this.#cli.run([
          'sandbox',
          'list',
          '--selector',
          `${LABELS.install}=${installSlug},${LABELS.role}=agent`,
          '--page-size',
          '100',
          ...(token ? ['--page-token', token] : []),
          '-o',
          'json',
        ]);
      } catch (err) {
        throw normalizeOpenShellError(err);
      }
      const parsed = JSON.parse(raw || '{}') as { sandboxes?: SandboxDoc[]; next_page_token?: string };
      // Belt and braces: the selector is the gateway's filter; ownership is ours to check.
      out.push(...(parsed.sandboxes ?? []).filter((d) => d.labels?.[LABELS.install] === installSlug));
      token = parsed.next_page_token ?? '';
      if (!token) break;
    }
    return out;
  }

  async deleteSandbox(name: string): Promise<void> {
    try {
      await this.#cli.run(['sandbox', 'delete', validateRuntimeName(name, 'sandbox')], { timeoutMs: 120_000 });
    } catch (err) {
      if (NOT_FOUND.test(err instanceof Error ? err.message : String(err))) return;
      throw normalizeOpenShellError(err);
    }
  }

  async createSandbox(plan: SandboxPlan): Promise<SandboxDoc> {
    if (plan.forward) await this.#ensureForwarder(plan.forward.listenPort, plan.forward.targetPort);
    const childEnv: Record<string, string> = {};
    const args = [
      'sandbox',
      'create',
      '--name',
      plan.name,
      '--from',
      plan.image,
      '--policy',
      path.join(this.stagingDir(plan.name), 'policy.yaml'),
      '--driver-config-json',
      JSON.stringify({ vm: { mounts: plan.mounts } }),
      '--detach',
      '--restart-policy',
      'never',
      '--no-credential-warnings',
      '-o',
      'json',
    ];
    for (const [k, v] of Object.entries(plan.labels)) args.push('--label', `${k}=${v}`);
    if (plan.forward) {
      args.push('--annotation', `${FORWARD_ANNOTATION}=${plan.forward.listenPort}:${plan.forward.targetPort}`);
    }
    if (plan.providers.length > 0) {
      // Attach by name only. Never let the CLI auto-create a missing provider
      // from the HOST's environment: a missing provider fails the create.
      for (const provider of plan.providers) args.push('--provider', provider);
      args.push('--no-auto-providers');
    }
    for (const [k, v] of Object.entries(plan.env)) args.push('--env', `${k}=${v}`);
    // The contributed lane carries credential-NAMED values (a per-spawn
    // mailbox bearer, gateway placeholders): pass them by reference so they
    // never appear in the host's process table.
    Object.entries(plan.contributedEnv).forEach(([k, v], i) => {
      const ref = `NANOCLAW_OPENSHELL_ENV_${i}`;
      childEnv[ref] = v;
      args.push('--env-from', `${k}=${ref}`);
    });
    args.push('--', ...plan.command);
    let out: string;
    try {
      out = await this.#cli.run(args, { timeoutMs: CREATE_TIMEOUT_MS, env: childEnv });
    } catch (err) {
      // Allocate all or leave nothing: a half-created sandbox would wear our labels.
      await this.deleteSandbox(plan.name).catch(() => {});
      throw normalizeOpenShellError(err);
    }
    try {
      return JSON.parse(out) as SandboxDoc;
    } catch {
      return { name: plan.name };
    }
  }

  async #ensureForwarderFromAnnotation(doc: SandboxDoc): Promise<void> {
    const value = doc.annotations?.[FORWARD_ANNOTATION];
    const match = value ? /^(\d+):(\d+)$/.exec(value) : null;
    if (!match) return;
    try {
      await this.#ensureForwarder(Number(match[1]), Number(match[2]));
    } catch (err) {
      log.error('OpenShell: proxy forwarder for an adopted sandbox could not start', { name: doc.name, err });
    }
  }

  async #ensureForwarder(listenPort: number, targetPort: number): Promise<void> {
    if (!this.#forwarder) {
      const start = this.opts.startForwarder ?? startForwarder;
      this.#forwarder = start(listenPort, targetPort);
      this.#forwarder.catch(() => {
        this.#forwarder = null;
      });
    }
    let fwd: Forwarder;
    try {
      fwd = await this.#forwarder;
    } catch (err) {
      log.error('OpenShell proxy forwarder failed to start', { listenPort, targetPort, err });
      throw asFailureError({ kind: 'runtime-unavailable', retryable: true });
    }
    if (fwd.listenPort !== listenPort || fwd.targetPort !== targetPort) {
      throw asFailureError({
        kind: 'spec-invalid',
        retryable: false,
        detail: `forwarder already serves ${fwd.listenPort}->${fwd.targetPort}, session wants ${listenPort}->${targetPort}`,
      });
    }
  }
}

class OpenShellHandle implements SessionHandle {
  #loggedFailure = false;
  #started: boolean;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly driver: OpenShellSessionDriver,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly plan: SandboxPlan | null,
  ) {
    this.#started = plan === null;
  }

  async start(): Promise<void> {
    if (this.#started || !this.plan) return;
    this.#started = true;
    let doc: SandboxDoc;
    try {
      doc = await this.driver.createSandbox(this.plan);
    } catch (err) {
      this.#started = false;
      throw err;
    }
    const mapped = mapSandboxPhase(doc.phase, doc.exit_code);
    this.driver.emit({ key: this.key, kind: mapped.listed === 'terminal' ? 'terminal' : 'phase' });
  }

  async status(): Promise<SessionStatus> {
    const doc = await this.driver.getSandbox(this.name);
    if (!doc) return this.plan && !this.#started ? { phase: 'ready' } : { phase: 'stopped' };
    if (this.#stopping) return { phase: 'stopped' };
    const mapped = mapSandboxPhase(doc.phase, doc.exit_code);
    if (mapped.status.phase === 'failed' && !this.#loggedFailure) {
      this.#loggedFailure = true;
      log.warn('Sandbox runner exited non-zero', {
        name: this.name,
        exitCode: doc.exit_code,
        outputTail: tailLines(path.join(this.driver.logsDir(this.name), RUNNER_LOG), 15),
      });
    }
    return mapped.status;
  }

  stop(reason: string): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    log.info('Stopping session sandbox', { name: this.name, reason });
    this.#stopping = true;
    const teardown = (async () => {
      await this.driver.deleteSandbox(this.name);
      fs.rmSync(this.driver.stagingDir(this.name), { recursive: true, force: true });
      // Every observed end rides the stream; intent filtering is the hub's.
      this.driver.emit({ key: this.key, kind: 'terminal' });
    })().finally(() => {
      if (this.#stopPromise === teardown) this.#stopPromise = undefined;
    });
    this.#stopPromise = teardown;
    return teardown;
  }

  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'openshell',
      argsTty: ['sandbox', 'exec', '-n', this.name, '--tty', '--', ...command],
      argsPlain: ['sandbox', 'exec', '-n', this.name, '--no-tty', '--', ...command],
    };
  }
}

const imageEnvCache = new Map<string, Record<string, string>>();

/**
 * The image's Docker Config.Env. OpenShell ignores it (the VM starts with its
 * own PATH), so the translation re-exports it. Best-effort: an image the local
 * daemon can't inspect yields {} and the sandbox runs with OpenShell's env.
 */
async function imageEnvOf(image: string | undefined): Promise<Record<string, string>> {
  if (!image) return {};
  const cached = imageEnvCache.get(image);
  if (cached) return cached;
  const env = await new Promise<Record<string, string>>((resolve) => {
    execFile(
      'docker',
      ['image', 'inspect', '--format', '{{json .Config.Env}}', image],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const entries = JSON.parse(stdout) as string[] | null;
          resolve(
            Object.fromEntries(
              (entries ?? []).flatMap((entry) => {
                const i = entry.indexOf('=');
                return i > 0 ? [[entry.slice(0, i), entry.slice(i + 1)]] : [];
              }),
            ),
          );
        } catch {
          resolve({});
        }
      },
    );
  });
  imageEnvCache.set(image, env);
  return env;
}

/** Last `n` lines of a runner log, or [] when absent. Bounded read: the log is append-only. */
function tailLines(file: string, n: number): string[] {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, 16_384);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
