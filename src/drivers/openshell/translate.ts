/**
 * SessionSpec → OpenShell sandbox plan. PURE: no filesystem writes, no CLI,
 * no clock — every host fact it needs (is this source a file or a directory,
 * what does it resolve to) comes through the injected `MountProbe`, so the
 * whole mapping is unit-testable from literals.
 *
 * What does not translate one-to-one, and what this does instead:
 *
 * - VM mounts are directories only (no single files, no symlinked sources,
 *   at most 32). A file mount whose source is the very same path inside an
 *   already-mounted parent directory is dropped — the guest sees it through
 *   the parent. A nested directory mount of the same shape is dropped for the
 *   same reason. Either way the nested READ-ONLY overlay Docker gives it is
 *   lost (landlock cannot carve a read-only hole into a read-write grant);
 *   the plan records each drop so the driver can say so.
 * - VM mount targets cannot overlap. A kept directory nested in another
 *   (the group folder at /workspace/agent inside /workspace) is mounted under
 *   `OPENSHELL_MOUNTS_DIR` and symlinked into place by the entrypoint prelude.
 * - Every other file is staged: the driver copies it into a per-session
 *   staging directory mounted read-only at `OPENSHELL_FILES_DIR`, and every
 *   env value naming the original container path is rewritten to the staged
 *   one. A staged file no env value names is linked into place by a one-line
 *   prelude on the `bash -c` entrypoint (only under writable guest roots).
 * - `/app/.nanoclaw-session.json` is skipped when the remote mailbox is in
 *   use (the runner reads NANOCLAW_MAILBOX_SESSION instead); without it the
 *   runner's fixed read path cannot be met and the spec is refused.
 * - OpenShell owns some env keys (proxy, CA bundle): they travel under an
 *   alias and the prelude exports them back (`OPENSHELL_RESERVED_ENV`).
 * - Egress: OpenShell is deny-by-default and always blocks a fixed set of
 *   ports (10255 among them, which is OneCLI's proxy). `host.docker.internal`
 *   becomes `host.openshell.internal` in every env value, and the proxy URLs
 *   are re-pointed at a host-side loopback forwarder the driver runs. The
 *   policy admits exactly the host ports the rewritten env names.
 */
import { createHash } from 'crypto';
import path from 'path';

import {
  labelsForKey,
  specInvalid,
  type ContainerSpec,
  type MountSpec,
  type SessionResources,
  type SessionSpec,
} from '../types.js';

export const OPENSHELL_HOST = 'host.openshell.internal';
export const DOCKER_HOST = 'host.docker.internal';
/** Guest directory staged single files are mounted at (read-only). */
export const OPENSHELL_FILES_DIR = '/opt/nanoclaw-files';
/** Guest directory nested directory mounts are relocated under (VM mounts cannot overlap). */
export const OPENSHELL_MOUNTS_DIR = '/opt/nanoclaw-mounts';
/** Guest dir of the driver-owned log share; the runner's output lands in runner.log. */
export const OPENSHELL_LOGS_DIR = '/opt/nanoclaw-logs';
export const RUNNER_LOG = 'runner.log';
export const SESSION_CONTEXT_PATH = '/app/.nanoclaw-session.json';
export const MAX_VM_MOUNTS = 32;
/** OpenShell's own limit on one `--env` value. */
const MAX_ENV_VALUE_BYTES = 8 * 1024;

const PROXY_KEYS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']);
/**
 * Keys OpenShell owns in the workload's environment: it drops the proxy
 * variables and points the CA variables at its own supervisor CA, whatever
 * `--env` says (observed on 0.1.9). These ride under `RESTORE_PREFIX` aliases
 * and the entrypoint prelude exports them back before exec, so the agent sees
 * the values composition chose.
 */
export const OPENSHELL_RESERVED_ENV = new Set([
  ...PROXY_KEYS,
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'DENO_CERT',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
]);
export const RESTORE_PREFIX = 'NANOCLAW_RESTORE_';

/** CA-bundle variables OpenShell sets that must follow the gateway CA bundle. */
export const OPENSHELL_CA_FOLLOWERS = ['CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE'] as const;

/** The agent image's runtime surface, readable by the workload. */
export const BASE_READ_ONLY = [
  '/bin',
  '/usr',
  '/lib',
  '/proc',
  // /sys: Chromium reads CPU topology at startup ("Failed to initialize cpuinfo").
  '/sys',
  '/dev/urandom',
  '/etc',
  '/var/log',
  '/app',
  '/pnpm',
];
// /dev/shm: Chromium (agent-browser) creates its shared-memory regions there.
export const BASE_READ_WRITE = ['/tmp', '/dev/null', '/dev/shm', '/home/node', '/workspace'];
/** Where the entrypoint prelude may link a staged file into place. */
const LINKABLE_ROOTS = ['/home/node', '/tmp', '/workspace'];

export interface MountProbe {
  /** What the source is, following symlinks; 'missing' when it does not resolve. */
  kind(hostPath: string): 'dir' | 'file' | 'missing';
  /** Canonical source (symlinks resolved): VM mounts refuse symlinked sources. */
  realpath(hostPath: string): string;
}

export interface TranslateOptions {
  /** Sandbox name (already derived from the key). */
  name: string;
  /** Host directory the driver copies staged files into. */
  stagingFilesDir: string;
  /** Host loopback port of the driver's TCP forwarder to the gateway proxy. */
  forwardPort: number;
  probe: MountProbe;
  /**
   * The image's own ENV (Docker Config.Env). OpenShell starts the workload
   * with its own PATH and ignores image ENV, which hides /pnpm globals such
   * as agent-browser; the prelude exports these first (spec env still wins).
   */
  imageEnv?: Record<string, string>;
  /**
   * Host dir the runner's stdout/stderr is written to (OpenShell does not
   * capture the workload's output). Each line is prefixed with
   * $EPOCHREALTIME so start-up can be timed.
   */
  logsDir?: string;
}

export interface VmMount {
  type: 'bind';
  source: string;
  target: string;
  read_only: boolean;
}

export interface StagedFile {
  /** Host source, as declared. */
  source: string;
  /** Filename inside the staging directory. */
  stagedName: string;
  /** The container path the spec asked for. */
  target: string;
  /** Where the guest actually finds it. */
  guestPath: string;
  /** True when the entrypoint prelude links it into place (no env names it). */
  linked: boolean;
}

export interface RelocatedMount {
  /** Where the spec wanted it (becomes a symlink). */
  containerPath: string;
  /** Where the VM actually mounts it. */
  guestPath: string;
}

export interface DroppedMount {
  containerPath: string;
  hostPath: string;
  reason: 'covered-by-parent' | 'session-context-unused';
  /** The spec asked for read-only and the guest now sees it read-write. */
  readOnlyLost: boolean;
}

export interface NetworkEndpoint {
  host: string;
  ports: number[];
  tls?: 'skip';
}

export interface OpenShellPolicy {
  version: 1;
  filesystem_policy: { read_only: string[]; read_write: string[] };
  landlock: { compatibility: 'best_effort' };
  network_policies: Record<string, { name: string; endpoints: NetworkEndpoint[]; binaries: Array<{ path: string }> }>;
}

export interface SandboxPlan {
  name: string;
  image: string;
  command: string[];
  /** Composed lane: non-secret, passed as `--env K=V`. Reserved keys appear under `RESTORE_PREFIX`. */
  env: Record<string, string>;
  /** Contributed lane (wins collisions): passed via `--env-from`, so values stay off argv. */
  contributedEnv: Record<string, string>;
  mounts: VmMount[];
  staged: StagedFile[];
  dropped: DroppedMount[];
  relocated: RelocatedMount[];
  labels: Record<string, string>;
  policy: OpenShellPolicy;
  /** Present when a proxy URL was re-pointed: forwarder listen → host target port. */
  forward?: { listenPort: number; targetPort: number };
  /** Spec resources the VM cannot size per sandbox (gateway-wide). */
  unsizedResources: (keyof SessionResources)[];
}

/** The environment the agent process ends up with: both lanes, aliases restored, contributed winning. */
export function effectiveEnv(plan: Pick<SandboxPlan, 'env' | 'contributedEnv'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...plan.env, ...plan.contributedEnv })) {
    out[key.startsWith(RESTORE_PREFIX) ? key.slice(RESTORE_PREFIX.length) : key] = value;
  }
  return out;
}

/** OpenShell 0.1.9 rejects longer sandbox names ("name exceeds maximum length (30 > 19)"). */
export const MAX_SANDBOX_NAME = 19;
const MIN_NAME_HASH = 6;

/** `<prefix><install slug, up to 8>-` — the part every sandbox of one install shares. */
export function sandboxNamePrefix(installSlug: string, prefix = 'nc-'): string {
  const slug = installSlug
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return `${prefix}${slug}-`;
}

/**
 * Key-derived, never time-derived: prepare is idempotent on key only if the
 * name it allocates is stable. With a 19-character ceiling there is no room
 * for a readable session id, so the name is the install prefix plus a hash of
 * the full key; identity lives in the labels, which prepare verifies before
 * treating an existing sandbox as this session.
 */
export function sandboxName(key: SessionSpec['key'], prefix = 'nc-'): string {
  const head = sandboxNamePrefix(key.installSlug, prefix);
  const room = MAX_SANDBOX_NAME - head.length;
  if (room < MIN_NAME_HASH) throw specInvalid(`sandbox name prefix '${head}' leaves no room for a session hash`);
  const hash = createHash('sha256').update(`${key.installSlug}\u0000${key.sessionId}`).digest('hex');
  return `${head}${hash.slice(0, room)}`;
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace a whole path token (not a prefix of a longer path) inside an env value. */
function replacePathToken(value: string, from: string, to: string): string {
  const re = new RegExp(`(^|[\\s:=;,])${escapeRegExp(from)}(?=$|[\\s:;,])`, 'g');
  return value.replace(re, (_m, lead: string) => `${lead}${to}`);
}

function rewriteHost(value: string): string {
  return value.replaceAll(DOCKER_HOST, OPENSHELL_HOST);
}

/** Proxy URL → forwarder; returns the original port, or undefined when not ours. */
function rewriteProxy(value: string, forwardPort: number): { value: string; targetPort?: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { value };
  }
  if (url.hostname !== DOCKER_HOST && url.hostname !== OPENSHELL_HOST) return { value };
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  url.hostname = OPENSHELL_HOST;
  url.port = String(forwardPort);
  // URL adds a trailing slash to an origin-only href; keep the operator's shape.
  const out = value.endsWith('/') ? url.href : url.href.replace(/\/$/, '');
  return { value: out, targetPort };
}

/** Ports of every URL in the env that names the OpenShell host alias. */
function hostPorts(values: string[]): number[] {
  const ports = new Set<number>();
  const re = new RegExp(`${escapeRegExp(OPENSHELL_HOST)}:(\\d{1,5})`, 'g');
  for (const value of values) {
    for (const match of value.matchAll(re)) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

export function translateSpec(spec: SessionSpec, opts: TranslateOptions): SandboxPlan {
  const extra = spec.containers.filter((c) => c.role !== 'agent');
  if (extra.length > 0) {
    // Never validate-then-ignore: a composed container silently dropped is
    // semantic loss (capabilities().auxiliaryContainers is false).
    throw specInvalid(
      `openshell driver does not realize auxiliary containers (${extra.map((c) => c.role).join(', ')})`,
    );
  }
  if (spec.networkAccess.target.kind === 'session-container') {
    throw specInvalid('openshell driver cannot route to a session-container network target');
  }
  const agent = spec.containers.find((c) => c.role === 'agent') as ContainerSpec;

  // Contributed lane wins collisions (ContainerSpec.contributedEnv).
  const contributedRaw = { ...(agent.contributedEnv ?? {}) };
  const composedRaw = Object.fromEntries(Object.entries(agent.env).filter(([k]) => !(k in contributedRaw)));
  const remoteMailbox = Boolean(contributedRaw.NANOCLAW_MAILBOX_SESSION || composedRaw.NANOCLAW_MAILBOX_SESSION);

  // ---- mounts ----
  const dirs: Array<MountSpec & { source: string }> = [];
  const files: Array<MountSpec & { source: string }> = [];
  for (const mount of agent.mounts) {
    const kind = opts.probe.kind(mount.hostPath);
    if (kind === 'missing') throw specInvalid(`mount source missing: ${mount.hostPath}`);
    const source = opts.probe.realpath(mount.hostPath);
    (kind === 'dir' ? dirs : files).push({ ...mount, source });
  }

  const dropped: DroppedMount[] = [];
  // Outermost first, so a nested mount is judged against a parent that is kept.
  const keptDirs: Array<MountSpec & { source: string }> = [];
  const coveringParent = (m: { containerPath: string; source: string }) =>
    keptDirs.find(
      (d) =>
        m.containerPath !== d.containerPath &&
        under(m.containerPath, d.containerPath) &&
        m.source === path.join(d.source, path.relative(d.containerPath, m.containerPath)),
    );
  for (const dir of [...dirs].sort((a, b) => a.containerPath.length - b.containerPath.length)) {
    if (coveringParent(dir)) {
      dropped.push({
        containerPath: dir.containerPath,
        hostPath: dir.hostPath,
        reason: 'covered-by-parent',
        readOnlyLost: dir.mode === 'ro' && coveringParent(dir)!.mode === 'rw',
      });
      continue;
    }
    keptDirs.push(dir);
  }

  const staged: StagedFile[] = [];
  for (const file of files) {
    if (file.containerPath === SESSION_CONTEXT_PATH) {
      if (remoteMailbox) {
        dropped.push({
          containerPath: file.containerPath,
          hostPath: file.hostPath,
          reason: 'session-context-unused',
          readOnlyLost: false,
        });
        continue;
      }
      throw specInvalid(
        `${SESSION_CONTEXT_PATH} is a fixed runner path a MicroVM cannot mount (no single-file mounts, /app is ` +
          'image content); OpenShell sessions need the remote mailbox (NANOCLAW_MAILBOX_SESSION)',
      );
    }
    const parent = coveringParent(file);
    if (parent) {
      dropped.push({
        containerPath: file.containerPath,
        hostPath: file.hostPath,
        reason: 'covered-by-parent',
        readOnlyLost: file.mode === 'ro' && parent.mode === 'rw',
      });
      continue;
    }
    const stagedName = `${staged.length}-${path.basename(file.containerPath)}`;
    staged.push({
      source: file.source,
      stagedName,
      target: file.containerPath,
      guestPath: `${OPENSHELL_FILES_DIR}/${stagedName}`,
      linked: false,
    });
  }

  // VM mount targets may not overlap ("vm mount target '/workspace/agent'
  // overlaps mount target '/workspace'"). A kept directory nested inside
  // another kept, writable one is mounted at a flat guest path instead and
  // symlinked into place by the entrypoint prelude — the link lands in the
  // parent mount, which is why the parent must be writable.
  const relocated: RelocatedMount[] = [];
  const guestTarget = new Map<MountSpec, string>();
  for (const dir of keptDirs) {
    const parent = keptDirs.find((d) => d !== dir && under(dir.containerPath, d.containerPath));
    if (!parent) continue;
    if (parent.mode !== 'rw') {
      throw specInvalid(`mount ${dir.containerPath} nests inside read-only mount ${parent.containerPath}`);
    }
    const guestPath = `${OPENSHELL_MOUNTS_DIR}/${relocated.length}-${path.posix.basename(dir.containerPath)}`;
    relocated.push({ containerPath: dir.containerPath, guestPath });
    guestTarget.set(dir, guestPath);
  }

  // Emit in the spec's own order; the length sort above only decided drops.
  const mounts: VmMount[] = dirs
    .filter((d) => keptDirs.includes(d))
    .map((d) => ({
      type: 'bind',
      source: d.source,
      target: guestTarget.get(d) ?? d.containerPath,
      read_only: d.mode === 'ro',
    }));
  if (staged.length > 0) {
    mounts.push({ type: 'bind', source: opts.stagingFilesDir, target: OPENSHELL_FILES_DIR, read_only: true });
  }
  if (opts.logsDir) {
    mounts.push({ type: 'bind', source: opts.logsDir, target: OPENSHELL_LOGS_DIR, read_only: false });
  }
  if (mounts.length > MAX_VM_MOUNTS) {
    throw specInvalid(`openshell VM supports at most ${MAX_VM_MOUNTS} mounts; spec needs ${mounts.length}`);
  }

  // ---- env ----
  let targetPort: number | undefined;
  const rewriteEnv = (env: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(env)) {
      let value = raw;
      for (const file of staged) value = replacePathToken(value, file.target, file.guestPath);
      if (PROXY_KEYS.has(key)) {
        const proxied = rewriteProxy(value, opts.forwardPort);
        value = proxied.value;
        if (proxied.targetPort !== undefined) {
          if (targetPort !== undefined && targetPort !== proxied.targetPort) {
            throw specInvalid(`proxy env names two gateway ports (${targetPort}, ${proxied.targetPort})`);
          }
          targetPort = proxied.targetPort;
        }
      }
      value = rewriteHost(value);
      if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES || value.includes('\n')) {
        throw specInvalid(`env '${key}' exceeds the sandbox env limits (8 KiB, single line)`);
      }
      out[key] = value;
    }
    return out;
  };
  const finalEnv = rewriteEnv(composedRaw);
  const finalContributed = rewriteEnv(contributedRaw);
  const allValues = [...Object.values(finalEnv), ...Object.values(finalContributed)];
  const restores: string[] = [];
  const aliasReserved = (lane: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(lane).map(([key, value]) => {
        if (!OPENSHELL_RESERVED_ENV.has(key)) return [key, value];
        restores.push(key);
        return [`${RESTORE_PREFIX}${key}`, value];
      }),
    );
  const env = aliasReserved(finalEnv);
  const contributedEnv = aliasReserved(finalContributed);

  // ---- entrypoint prelude: relocated dirs first, then unreferenced files ----
  // `ln -T` refuses to drop a link INSIDE an existing directory, so a target
  // that already exists as a real directory fails the boot loudly.
  const link = (from: string, to: string) =>
    `mkdir -p ${shellQuote(path.posix.dirname(to))} && ln -sfnT ${shellQuote(from)} ${shellQuote(to)}`;
  // OpenShell sets HOME=/sandbox; the agent image (and the /home/node/.claude
  // mount) expects the image user's home.
  const specKeys = new Set([...Object.keys(finalEnv), ...Object.keys(finalContributed)]);
  const imageExports = Object.entries(opts.imageEnv ?? {})
    .filter(([key]) => key !== 'HOME' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !specKeys.has(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  // OpenShell points these at its own CA bundle, but the agent's HTTPS goes
  // through the credential gateway's proxy, which re-signs with the gateway
  // CA — so follow the restored SSL_CERT_FILE unless the spec set them.
  const caFollowers = restores.includes('SSL_CERT_FILE')
    ? OPENSHELL_CA_FOLLOWERS.filter((key) => !specKeys.has(key)).map((key) => `export ${key}="$SSL_CERT_FILE"`)
    : [];
  const prelude: string[] = [
    // First, so the prelude's own failures are captured too. One timestamp per
    // line without forking: bash's $EPOCHREALTIME.
    ...(opts.logsDir
      ? [
          `exec > >(while IFS= read -r l; do printf '%s %s\\n' "$EPOCHREALTIME" "$l"; done >> ${OPENSHELL_LOGS_DIR}/${RUNNER_LOG}) 2>&1`,
        ]
      : []),
    'export HOME=/home/node',
    ...imageExports,
    ...restores.map((key) => `export ${key}="$${RESTORE_PREFIX}${key}" && unset ${RESTORE_PREFIX}${key}`),
    ...caFollowers,
    // Chromium's own sandbox and zygote need user namespaces, which OpenShell's
    // seccomp filter forbids; the VM, Landlock and seccomp already contain it.
    ...(specKeys.has('AGENT_BROWSER_ARGS')
      ? []
      : [`export AGENT_BROWSER_ARGS=${shellQuote('--no-sandbox,--no-zygote')}`]),
  ];
  prelude.push(...relocated.map((r) => link(r.guestPath, r.containerPath)));
  for (const file of staged) {
    if (allValues.some((v) => v.includes(file.guestPath))) continue;
    if (!LINKABLE_ROOTS.some((root) => under(file.target, root) && file.target !== root)) {
      throw specInvalid(`file mount ${file.target} is outside the writable guest roots and no env names it`);
    }
    file.linked = true;
    prelude.push(link(file.guestPath, file.target));
  }
  const baseCommand = [...(agent.command ?? []), ...(agent.args ?? [])];
  let command = baseCommand;
  if (prelude.length > 0) {
    if (baseCommand.length !== 3 || baseCommand[0] !== 'bash' || baseCommand[1] !== '-c') {
      throw specInvalid('the entrypoint prelude (env restores, mount links) needs a `bash -c <script>` entrypoint');
    }
    command = ['bash', '-c', `${prelude.join(' && ')} && ${baseCommand[2]}`];
  }
  if (command.length === 0) throw specInvalid('openshell sandbox needs an explicit command');

  // ---- policy ----
  const rwTargets = mounts.filter((m) => !m.read_only).map((m) => m.target);
  const roTargets = mounts.filter((m) => m.read_only).map((m) => m.target);
  const readWrite = [...new Set([...BASE_READ_WRITE, ...rwTargets])];
  const readOnly = [...new Set([...BASE_READ_ONLY, ...roTargets.filter((t) => !readWrite.some((rw) => under(t, rw)))])];
  const forward = targetPort !== undefined ? { listenPort: opts.forwardPort, targetPort } : undefined;
  const ports = hostPorts(allValues);
  const endpoints: NetworkEndpoint[] = [];
  const plainPorts = ports.filter((p) => p !== forward?.listenPort);
  // One endpoint per host: OpenShell 0.1.9 DNS-maps only the first endpoint
  // naming a host, so a second host.openshell.internal entry is unreachable.
  // A forward proxy speaks CONNECT, which OpenShell's HTTP inspector rejects
  // ("request-target is not a valid origin-form path"); `tls: skip` keeps the
  // tunnel raw. The mailbox is plain HTTP, so skipping TLS inspection costs it nothing.
  const hostPortList = forward ? [...plainPorts, forward.listenPort] : plainPorts;
  if (hostPortList.length > 0) {
    endpoints.push({ host: OPENSHELL_HOST, ports: hostPortList, ...(forward ? { tls: 'skip' as const } : {}) });
  }
  const policy: OpenShellPolicy = {
    version: 1,
    filesystem_policy: { read_only: readOnly, read_write: readWrite },
    landlock: { compatibility: 'best_effort' },
    network_policies: {},
  };
  if (endpoints.length > 0) {
    // An omitted/empty `binaries` matches NO binary; `/**` matches all — every
    // agent tool (bun, node, the SDK's claude binary, git, curl, chromium)
    // sends HTTPS through the proxy, so a per-binary list would be a guess.
    policy.network_policies.nanoclaw_host = { name: 'nanoclaw_host', endpoints, binaries: [{ path: '/**' }] };
  }

  const unsizedResources = (Object.keys(spec.resources) as (keyof SessionResources)[]).filter(
    (k) => spec.resources[k] !== undefined,
  );

  return {
    name: opts.name,
    image: agent.image,
    command,
    env,
    contributedEnv,
    mounts,
    staged,
    dropped,
    relocated,
    labels: labelsForKey(spec.key, 'agent', { ...spec.labels, ...(agent.labels ?? {}) }),
    policy,
    forward,
    unsizedResources,
  };
}
