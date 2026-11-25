# OpenShell prototype: findings for production

Prototype status as of 2026-11-24 (main `8f36c18e`). One test agent group
(`lab`, CLI channel) runs every session as an NVIDIA/CNCF OpenShell MicroVM;
every other group is untouched on Docker. Nothing here is upstream; the
related upstream question is nanocoai/nanoclaw#4543.

## What was built

| Piece                         | Where                                                                                         | Purpose                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote agent mailbox (host)   | `src/mailbox/remote/`                                                                         | Serves the runner's `MailboxOperations` over HTTP on `127.0.0.1:18770`, against the unchanged SQLite session DBs. Per-session bearer tokens (sha256 on disk in `data/mailbox-tokens/`), per-session serialization, idempotent `writeMessageOut`, symlink-proof inbox/outbox file ops. |
| Remote agent mailbox (runner) | `container/agent-runner/src/mailbox/remote/`                                                  | Synchronous calls via a worker thread + `Atomics.wait` (request ids, timeouts, retry), inbox sync, outbox upload, heartbeat. Session comes from `NANOCLAW_MAILBOX_SESSION` when there is no context file.                                                                             |
| OpenShell session driver      | `src/drivers/openshell-driver.ts`, `src/drivers/openshell/{translate,composite,forwarder}.ts` | Drives the `openshell` CLI. Translates a NanoClaw spec to a sandbox (mounts, env, policy, entrypoint prelude), adopts sandboxes after a host restart, captures runner output. A composite driver routes only opted-in groups to OpenShell.                                            |

Opt-in (`.env`), both required for an OpenShell group:

```
NANOCLAW_REMOTE_MAILBOX_GROUPS=<agentGroupId,...>
NANOCLAW_OPENSHELL_GROUPS=<agentGroupId,...>
# optional: NANOCLAW_MAILBOX_PORT=18770  NANOCLAW_OPENSHELL_FORWARD_PORT=18755
# optional: NANOCLAW_OPENSHELL_IDLE_MINUTES=120   (keep idle VMs alive longer; see below)
```

Rollback: remove those lines and restart. A group switched Docker→OpenShell
keeps an already-running Docker container until it exits.

## Host setup (macOS, Apple silicon)

- OpenShell v0.1.9 via its installer (Homebrew formula, launchd
  `homebrew.mxcl.openshell`, gateway `https://localhost:17670`, mTLS).
- `~/.config/openshell/gateway.env`: `OPENSHELL_TELEMETRY_ENABLED=false`.
- `~/.config/openshell/gateway.toml`: `compute_driver = "vm"`, VM
  `enable_bind_mounts = true`, `allow_driver_config = true`, resource admission
  off; Docker section `supervisor_network_mode = "bridge"` (host mode fails on
  Docker Desktop). Docker-mode copy kept as `gateway.toml.docker`.
- `brew install e2fsprogs` (the VM driver builds ext4 disks).
- Egress-lockdown relay (`data/gateway-relay/relay.js`, operator-local)
  forwards `18770 → docker.for.mac.host.internal:18770` for Docker groups on
  the remote mailbox.

## Gotchas (each cost a debugging round)

1. **Docker compute driver on macOS can't use bind mounts**: Landlock denies all
   reads under Docker Desktop VirtioFS (OpenShell #4733, stale). Named volumes
   work; Linux hosts are unaffected. → MicroVM driver on macOS. Switching Docker
   Desktop's file sharing to gRPC FUSE is reported to fix it (confirmed by a
   second user on #4733, 2026-11-24; not tested here) — but see "gRPC FUSE
   trade-offs" below before choosing it.
2. **OpenShell hard-blocks ports 2379, 2380, 6443, 10250, 10255** on named
   hosts; 10255 is OneCLI's proxy. → loopback forwarder 18755 → 10255.
3. **Only the first policy endpoint per host is DNS-mapped.** → one
   `host.openshell.internal` endpoint with a `ports` list (`tls: skip` for the
   proxy's CONNECT).
4. **VM mounts are directories only, can't nest, max 32**; sandbox names ≤ 19
   chars. → relocate nested dirs to `/opt/nanoclaw-mounts/N` + symlink; stage
   single files into `/opt/nanoclaw-files`; skip the session context file.
5. **OpenShell rewrites the environment**: drops `*_PROXY`, points CA vars
   (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`,
   `NODE_EXTRA_CA_CERTS`, `DENO_CERT`) at its own CA, sets `HOME=/sandbox`,
   and ignores the image's `ENV` (PATH loses `/pnpm`). → entrypoint prelude
   restores all of these.
6. **Bun's `fetch` honours `HTTP(S)_PROXY`**, so mailbox calls (and their
   token) went through the credential gateway. → `NO_PROXY` for the mailbox
   host.
7. **Inside the relay container `host.docker.internal` is the relay itself**
   (egress-network alias). → route to `docker.for.mac.host.internal`.
8. **Chromium**: needs `/dev/shm` (rw) and `/sys` (ro) in the policy, and
   `--no-sandbox,--no-zygote` (`AGENT_BROWSER_ARGS`) because OpenShell's seccomp
   forbids the user namespaces Chromium's own sandbox needs.
9. **OpenShell does not capture the workload's stdout/stderr.** → driver writes
   `data/openshell-logs/<name>/runner.log` (timestamped with `$EPOCHREALTIME`,
   previous run kept as `prev-runner.log`) and logs the tail on a non-zero exit.

## Verified (live, lab agent in a MicroVM)

- Reply, `send_file`, `ncl` round trip, scheduled task (runs in its own VM),
  inbox attachment, question card, burst of 3 messages in order.
- Host restart: sandboxes adopted, not recreated. Kill: token revoked, staging
  cleaned, fresh VM with a new token. OpenShell gateway restart: VM survives.
- Tools: git and curl with certificate checks, Parallel web search (MCP),
  agent-browser (Chromium).
- Security probes from inside the VM: another session's mailbox / bogus token /
  traversal header → 401; host ports (OneCLI admin, Postgres, SSH, VNC,
  OpenShell gateway), direct internet and metadata IP blocked; no host files
  beyond the shares; `/app/src` and staged files read-only; `/etc/shadow` denied.
- Credentials (spike only): an OpenShell custom provider profile carries a
  Claude subscription setup-token (`CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_AUTH_TOKEN`), bound to the SDK's `claude` binary; verified with a
  dummy token. Pending-rule approval via gRPC (`GetDraftPolicy`,
  `ApproveDraftChunk`) works; a rule goes live ~15-20 s after approval.

## Upgrade and failure tests (2026-11-24, OpenShell v0.1.10)

- **Upgrade 0.1.9 → 0.1.10** (installer diff: repo rename only): gateway config
  kept; running VMs re-provisioned on their own in ~40 s (same sandbox, restart
  count 0); full regression (tools, file, fresh VM 4.2 s, kill/respawn) passed
  with no driver change.
- **OpenShell gateway stopped**: its VMs die with it. NanoClaw can't see them
  while the gateway is down, so messages wait silently; on gateway start
  OpenShell re-creates the sandbox from its record and the waiting message is
  answered ~5 s later. No NanoClaw action needed.
- **Docker Desktop restart**: VMs don't depend on Docker, but OneCLI does;
  NanoClaw's rule "credential gateway unavailable → stop all sessions" stops
  the VMs too (by design). Fresh VM on the next message. Moving credentials to
  OpenShell providers would remove this dependency.
- **Host hard kill (`kill -9`)**: the dead host's session claim is honoured for
  ~2 min, so the new host skips adoption and refuses wakes in that window
  (NanoClaw core, same for Docker). Two remote-mailbox bugs found and fixed:
  a spawn re-issued (replaced) the session token while `prepare()` reused the
  still-live runtime → runtime locked out; and each refused spawn wiped the
  scratch `/workspace` and revoked all tokens. Now tokens accumulate (newest 4
  valid, all revoked when the runtime ends), the workspace is never cleared at
  spawn, and a failed spawn withdraws only its own token.
- **Reply after a host restart** took ~28 s: the first mailbox call hung on a
  kept-alive connection that went dead behind OpenShell's proxy. Fixed
  (`Connection: close`, 10 s call timeout): ~8.5 s now; the call that was in
  flight at the moment of the restart still waited out one timeout. Now
  `getPendingMessages` (read-only; rows stay pending until marked) times out
  after 3 s and the heartbeat after 3 s, while writes and file transfer keep
  10 s (so a slow write is never abandoned and replayed).
- **Memory**: one running VM ≈ 1.4 GB host RSS (relevant to keeping idle VMs
  alive).
- **Soak test** started 2026-11-24 17:27: hourly task `vm-soak-5935` on the lab
  group (new VM per run). Check runs/failures, leftover sandboxes, VM memory,
  `data/openshell-logs/`, and `logs/nanoclaw.error.log`.

## Policy lint and idle keep-alive (small prototype changes)

- **Policy lint**: after writing `policy.yaml`, `prepare()` runs
  `openshell policy lint <file>` (15 s timeout). A rejection fails the spawn
  as a non-retryable `spec-invalid` carrying the lint output (staging removed).
  A CLI without the subcommand (< 0.1.10) is skipped with one warning.
  Checked against a real generated policy on 0.1.10: "Policy is valid
  (offline)"; a malformed file exits 1 with the field path.
- **What ends an idle session today** (nothing in the runner does): the host
  sweep's absolute ceiling in `src/reconcile-session.ts`
  (`decideStuckAction`): heartbeat age > `max(NANOCLAW_ABSOLUTE_CEILING_MS,
default 30 min, declared Bash timeout)` kills the container ("Stopping idle
  container past absolute ceiling"). The runner only touches the heartbeat on
  SDK events, not while idle polling, so an idle session ends ~30 min after
  its last turn. The runner has no idle exit (`poll-loop.ts` exits only on a
  mailbox-failure streak). Claim-stuck (60 s) concerns claimed messages only.
- **Keep-alive**: `NANOCLAW_OPENSHELL_IDLE_MINUTES` (1..1440, default off)
  raises that ceiling, never lowers it, for groups in
  `NANOCLAW_OPENSHELL_GROUPS` only; Docker groups use the unchanged global
  ceiling. Cost: one running VM is about 1.4 GB host RSS, per idle session,
  for the whole window. It also delays the reaping of a genuinely hung VM
  (without a claimed message) up to the same window.

## Performance (same prompt, lab agent)

|                    | Docker  | MicroVM    |
| ------------------ | ------- | ---------- |
| Warm reply         | ~1.95 s | ~1.9 s     |
| Cold start         | ~2.3 s  | ~4.4-4.7 s |
| Mailbox call (p50) | ~0.9 ms | ~1.7 ms    |

Cold-start breakdown in a VM (from message sent):

| Span         | Step                                                  | Cost                       |
| ------------ | ----------------------------------------------------- | -------------------------- |
| 0 → 1.7 s    | spawn, VM boot, supervisor, policy, isolation         | ~1.7 s, VM-specific        |
| 1.7 → 2.1 s  | Bun compiles the runner's ~100 TS files over virtiofs | ~0.4 s, mostly VM-specific |
| 2.1 → 2.2 s  | runner setup, session resume                          | 0.1 s                      |
| 2.2 → 3.05 s | Claude session start                                  | 0.8 s, same on Docker      |
| 3.05 → 4.0 s | model                                                 | 0.95 s, same on Docker     |
| 4.0 → 4.6 s  | host delivery polling                                 | 0.6 s, same on Docker      |

Not causes: virtiofs file reads in general, Bun startup itself, first launch
of the Claude binary (126 ms vs 5 ms).

## Upstream state (checked 2026-11-24)

- **OpenShell v0.1.10** (2026-11-24): weekly cadence continues (~120 merged
  PRs and ~156 new issues per week, mostly NVIDIA staff). Repo is now
  `ai-openshell/openshell`, images on `quay.io/ai-openshell`. Relevant: sandboxes
  may set their own CPU affinity/nice/limits and signal themselves; a restart no
  longer flips a starting sandbox to `Error`; **`openshell policy lint <file>`**
  checks policies offline; OAuth refresh options, workspace secrets
  (`--material-secret`), per-sandbox GitHub App tokens. Breaking changes were
  Kubernetes/Helm only. The prototype still runs 0.1.9.
- **TypeScript SDK `@ai-openshell/sdk` 0.1.10** — first real release
  (2026-11-24, npm with provenance, repo `ai-openshell/sdk-typescript`; the old
  `@nvidia/openshell-sdk` ends at 0.1.10). Covers sandbox create/exec/stream,
  port forwards, templates, policy (static fields only at create), provider
  credentials, mTLS/OIDC auth, plus a raw client (draft-policy approvals go
  through it). Node ≥ 20.3. Version tracks the gateway's. pnpm's
  `minimumReleaseAge` (3 days) blocks it until 2026-11-27 without an approved
  exclusion.
- Still open, unchanged: #4733 (Docker/VirtioFS mounts, stale), #4406
  (per-request hold), VM bugs #5149 / #5507 / #5015, #4769 (stopped sandboxes
  deleted after a driver change), #5200 (desktop drivers moving to
  `ai-openshell/desktop`). VM suspend/resume still not implemented.

## gRPC FUSE trade-offs (macOS Docker driver option)

Switching Docker Desktop's file sharing from VirtioFS to gRPC FUSE reportedly
lets OpenShell's Docker driver read bind mounts, but:

- **It is global**: every container's bind mounts change, including all
  existing NanoClaw agents on the plain Docker path.
- **Slower file I/O**: gRPC FUSE is the older implementation that VirtioFS
  replaced as the default largely for speed; metadata-heavy work (git,
  `node_modules`, many small files) suffers most, and the Docker backend uses
  more CPU.
- **Correctness risk for NanoClaw's SQLite-over-mount design**: Docker-path
  agents share `inbound.db` / `outbound.db` across the mount and depend on
  `journal_mode=DELETE` cross-mount visibility. A different file-sharing
  implementation has different caching and locking behaviour; this must be
  re-tested before relying on it (agents on the remote mailbox are unaffected).
- **Future support**: gRPC FUSE is the legacy option; it is not known how long
  Docker Desktop will keep it.

Prefer the MicroVM driver on macOS, or the Docker driver on a Linux host.

## Production backlog (ordered)

1. **Credentials through OpenShell providers** instead of OneCLI: needs a real
   setup-token test, then a NanoClaw gateway provider (per-agent-group
   providers + policy).
2. **Approvals**: bridge OpenShell pending rules to NanoClaw approval cards
   (rule-level; OpenShell has no per-request hold, #4406), and persist approved
   rules into the group's policy so new sandboxes don't re-ask.
3. **Keep idle VMs alive longer**: opt-in knob done (`NANOCLAW_OPENSHELL_IDLE_MINUTES`);
   still open: per-group setting, a memory-aware cap on concurrent idle VMs.
4. **Ship the runner pre-bundled in the image** (saves most of the 0.4 s and
   one share).
5. **Move the driver from the `openshell` CLI to `@ai-openshell/sdk`** once it
   has a few releases (typed calls, mTLS, `WatchSandbox` stream → event-driven
   status instead of 3-5 s polling for exit detection),
   (policy lint on every generated policy is done via the CLI).
6. **Read-only overlays** (`CLAUDE.md`, `container.json`, `plugins/`) become
   writable through their parent share in a VM; restore protection.
7. **VM sizing** is gateway-wide (`vcpus`, `mem_mib`); per-session limits are
   not applied.
8. **Watch upstream**: OpenShell ships breaking changes most weeks at 0.1.x
   (RFC 0014 stability policy under review); VM driver restart bugs (#5149,
   #5507); desktop drivers moving to `ai-openshell/desktop` (#5200); TypeScript
   SDK first release; VM suspend/resume is in the API but not implemented by
   the VM driver.
9. **Linux hosts**: the Docker compute driver works there (no #4733), which may
   be the better production target for multi-user installs.
