# OpenShell prototype: findings for production

Prototype status as of 2026-11-24 (main `8f36c18e`). One test agent group
(`lab`, CLI channel) runs every session as an NVIDIA/CNCF OpenShell MicroVM;
every other group is untouched on Docker. Nothing here is upstream; the
related upstream question is nanocoai/nanoclaw#4543.

## What was built

| Piece                         | Where                                                                                         | Purpose                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote agent mailbox (host)   | `src/mailbox/remote/`                                                                         | Serves the runner's `MailboxOperations` over HTTP on `127.0.0.1:18770`, against the unchanged SQLite session DBs. Per-session bearer tokens (sha256 on disk in `data/mailbox-tokens/`), per-session serialization, idempotent `writeMessageOut`, symlink-proof inbox/outbox file ops. |
| Remote agent mailbox (runner) | `container/agent-runner/src/mailbox/remote/`                                                  | Synchronous calls via a worker thread + `Atomics.wait` (request ids, timeouts, retry), inbox sync, outbox upload. Session comes from `NANOCLAW_MAILBOX_SESSION` when there is no context file.                                                                                        |
| OpenShell session driver      | `src/drivers/openshell-driver.ts`, `src/drivers/openshell/{translate,composite,forwarder}.ts` | Drives the `openshell` CLI. Translates a NanoClaw spec to a sandbox (mounts, env, policy, entrypoint prelude), adopts sandboxes after a host restart, captures runner output. A composite driver routes only opted-in groups to OpenShell.                                            |

Both pieces ship as skills. `/add-remote-mailbox`
(`.claude/skills/add-remote-mailbox/`) installs the remote mailbox and its
`remote-mailbox` session driver; `/add-openshell` (`.claude/skills/add-openshell/`)
installs the OpenShell driver, its settings module
(`src/drivers/openshell/config.ts`) and registers the driver kind `openshell`
(`src/drivers/openshell/register.ts`, one import appended to
`src/drivers/installed.ts`): the `docker` driver with the listed groups routed
to OpenShell, or `docker` itself when none is listed. The drivers stack with
`remote-mailbox` outermost: it wraps whatever
`NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER` names (default `docker`), so an
OpenShell group gets the remote-mailbox spec rewrite first and `translate.ts`
then realizes it.

Heartbeat: the mailbox driver mounts a per-session directory
(`data/v2-sessions/<group>/.remote-workspace/<session>.hb/`) at
`/opt/nanoclaw-heartbeat` and points `NANOCLAW_HEARTBEAT_PATH` at the
`heartbeat` file in it, hard-linked to `<sessionDir>/.heartbeat`. A MicroVM
mounts directories, so VMs and Docker containers use the same file; the
runner's RPC-heartbeat shim and the service's `heartbeat` op are gone. Checked
live (2026-11-25, `nc-dev-` sandbox): `fs.utimesSync` from Bun inside the VM
moved the host link's mtime within 0.4-0.9 s every time (same inode, link
count 2); same check in Docker.

Opt-in (`.env`), all required for an OpenShell group:

```
NANOCLAW_RUNTIME_DRIVER=remote-mailbox
NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell
NANOCLAW_REMOTE_MAILBOX_GROUPS=<agentGroupId,...>
NANOCLAW_OPENSHELL_GROUPS=<agentGroupId,...>
# optional: NANOCLAW_MAILBOX_PORT=18770  NANOCLAW_OPENSHELL_FORWARD_PORT=18755
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
10. **Driver events ran inside the caller's AsyncLocalStorage scope**: when the
    idle check stopped a VM, the follow-up sweep inherited that session's
    mailbox context and failed with "Nested mailbox session" (hourly, lab only).
    → events are delivered from a neutral `AsyncResource` scope (`69783470`).

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
  group (new VM per run). Result to 2026-11-25 07:07: 14 runs, 0 failures; no
  "Nested mailbox session" error after the fix (last one 21:37, fix 22:13).

## Remote mailbox on plain Docker + OneCLI (2026-11-25)

The remote mailbox needs no OpenShell. With the group in
`NANOCLAW_REMOTE_MAILBOX_GROUPS` and _not_ in `NANOCLAW_OPENSHELL_GROUPS`, lab
ran in an ordinary Docker container behind OneCLI and the relay, with no
session DB mounted (`/workspace/inbound.db` absent). All passed:

- scheduled task, reply to its destination, and a follow-up task the agent
  scheduled itself (fired 2 min later);
- `ncl groups get` from inside the container;
- outbound HTTPS through OneCLI (200);
- sending a file (outbox upload) and reading an inbound attachment (inbox sync);
- question card → answer → agent continues;
- host restart with the container live: adopted, next reply in 2 s.

Same day the agent-side mailbox SQL became one file shared by the runner and
the host (`src/mailbox/sqlite-operations.ts`, copied into the runner by
`pnpm mailbox-model:generate`), so the remote path runs the same SQL as the
mounted one; the host-side port shrank from 542 to 54 lines.

Upstream fit: CONTRIBUTING accepts only fixes, security fixes and
simplifications in core; features ship as skills. The viable shape is an
`/add-remote-mailbox` skill plus a small core spawn/exit hook on the mailbox
seam (ask on #4543 first).

## Credentials from OpenShell providers (per group, opt-in)

Added 2026-11-24. A group can take its credentials from OpenShell providers
instead of OneCLI. Every other group, Felix included, is unchanged: with the
setting empty, the selected gateway object is used as it is, with no wrapper.

### Design

**A partition over the selected gateway, not a second gateway.** The seam
still selects one gateway per install (`NANOCLAW_GATEWAY_PROVIDER=onecli`).
`src/gateway-providers/openshell.ts` registers a _partition_
(`registerGatewayPartition`, used by `getGatewayProvider`). The partition wraps
the OneCLI definition with `partitionGatewayProvider`
(`src/gateway-providers/partition.ts`), so every per-group question goes to
the side that serves that group:

| Question                                           | OneCLI groups       | OpenShell-credential groups                                       |
| -------------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `sessions.ensure` (the lease)                      | OneCLI, unchanged   | provider names only: `credentialProviders`, `networkAccess: host` |
| `sessions.gatedByApprovals(group)` (new, optional) | true                | false                                                             |
| `agentSkillsFor(group)` (new, optional)            | `onecli-gateway`    | none (not told about a proxy it is not behind)                    |
| `connections.connect`                              | OneCLI              | `unsupported`                                                     |
| `kind`, `approvals`, `availability`                | OneCLI's, as before | not used                                                          |

Why a partition and not a second registered gateway: core runs one approval
coordinator and one availability state, and both are install-wide. A second
full gateway would need two coordinators. The partition keeps OneCLI as the
install's only approval bridge and only exempts the groups that never go
through it. The other option, OpenShell as the only gateway, would move Felix
off OneCLI, which is out of scope.

**Typed, not argv.** The lease gives provider _names_
(`GatewayContribution.credentialProviders`). Composition copies them into
`SessionSpec.credentialProviders`, and that key exists only for these groups.
Only a driver that declares `capabilities().credentialProviders` may realize
it. `validateSpec` refuses the spec on any other driver (Docker), and also
refuses names that are not plain (`[A-Za-z0-9][A-Za-z0-9._-]{0,62}`). The
OpenShell driver passes `--provider <name>` for each name, plus
`--no-auto-providers`. That flag matters: without it, the CLI could create a
missing provider from the _host's_ environment.

**What the sandbox gets.** No OneCLI proxy env, no CA or stub mounts, no
loopback forwarder, and no `tls: skip` endpoint. OpenShell injects each
provider's env var as a placeholder (`openshell:resolve:env:…`) and swaps in
the real value at egress. The swap happens only for the profile's endpoints
and only for its listed binaries. The model client uses the real endpoint,
because nothing sets `ANTHROPIC_BASE_URL`. NanoClaw never sees a secret.

**Availability.** Core's "gateway unavailable" path
(`stopGatewaySessionsForUnavailability`, admission closure, and the
pre-start check) now skips groups for which `gatedByApprovals` is false. So a
OneCLI outage stops only OneCLI groups. An OpenShell outage cannot reach
OneCLI groups: their leases come only from OneCLI, and the composite driver
already isolates spawns. An OpenShell-credential spawn checks
`openshell provider get` for each provider and fails with the fix if one is
missing. Adoption skips that check, so an OpenShell blip does not stop a
surviving sandbox.

**Network approvals** (added 2026-11-25, `src/gateway-providers/openshell-approvals.ts`).
OpenShell refuses a denied connection at once; there is no held request. So
the bridge works per rule:

- Detect: one `openshell logs <sandbox> --tail --source sandbox` per live
  sandbox of a partition group (watched from the session lease, so adoption is
  covered). A deny is the OCSF line
  `NET:OPEN [MED] DENIED /usr/bin/curl(381) -> example.com:443 [reason:transparent_tcp_policy_denied]`.
  The tail replays its buffer on connect, so a per-sandbox cursor skips events
  seen before. The CLI has no draft-rule listing; gRPC `GetDraftPolicy` would
  need `@grpc/*` or the SDK, so it is not used.
- Ask: a `trigger: 'policy'` gateway approval request through core's
  coordinator (approver routing, `pending_approvals`, card, click auth,
  expiry; 30-minute window). One card per (group, host, port) while pending,
  at most 3 pending per group, and a refusal or timeout is remembered for
  15 minutes. Only exact DNS names are carded. IP literals, `*.internal`,
  `.local` and the like are logged, never carded.
- Apply: the endpoint goes into `data/openshell-policy/<group>.json`, then
  `openshell policy update <sandbox> --add-endpoint host:port --binary '/**' --rule-name nanoclaw_approved --wait`
  runs on each of the group's running sandboxes. It takes about 8 s on 0.1.10.
  New sandboxes get the file's entries from `translate.ts`. Any binary is
  allowed because the card approves a destination for the agent, and every
  binary in the sandbox acts for the agent.
- Tell: core's `notifyAgent` (a system chat message plus a wake), when the
  card is sent ("blocked, an admin was asked") and after the decision
  ("approved, retry" or "not approved").
- Outage: the partition's `approvals.subscribe` runs the base's subscription
  and the OpenShell bridge side by side. The combined promise settles exactly
  when the base's does, so core's outage handling sees only OneCLI. A failed
  log tail is retried with backoff and stops nothing: OpenShell still enforces
  the denial, so an outage costs cards, not containment. No core change was
  needed. While the base (OneCLI) subscription is down, the coordinator
  decides nothing, so no OpenShell card appears either.

Live check (2026-11-25, dev sandbox, fake coordinator): from the denied
`curl https://example.com` to the decision took 0.4 s. From approval to the
agent's message took 8.2 s, of which `--wait` was 8.1 s. The retry returned 200.
`example.net` was denied, the agent was told, the retry stayed blocked, and no
second card was raised. A new sandbox of the same group reached example.com
straight away from the persisted file.

### Verified (live, dummy token, 2026-11-24)

I used the real `OpenShellSessionDriver` with a `nc-dev-echo` profile:
`NC_DEV_ECHO_TOKEN`, bearer auth, `httpbin.org:443`, binaries
`[/usr/bin/curl]`. The image was the v2 agent image.

- The sandbox env had `NC_DEV_ECHO_TOKEN=openshell:resolve:env:…` and no
  `*_PROXY` apart from the mailbox `NO_PROXY`. OpenShell's proxy is
  transparent and sets no proxy variables.
- `curl https://httpbin.org/headers` with the placeholder returned 200, and the
  echoed header was `Authorization: Bearer <the dummy value>`. **The swap
  works.** Our policy file had no entry for httpbin.org, so the provider's own
  `_provider_*` policy entry opened it.
- `bun fetch` to the same URL with the provider attached was **blocked**,
  because Bun is not in the profile's `binaries`.
- Without the provider, `curl` to httpbin.org was **blocked** (exit 7).
- A plain-HTTP host port (a stand-in for the mailbox on
  `host.openshell.internal`) worked **without** `tls: skip`. Any other host was
  blocked.

### Settings

```
NANOCLAW_OPENSHELL_CREDENTIALS=<agentGroupId>:<provider>[+<provider>…][,<agentGroupId>:…]
```

Each group listed here must also be in `NANOCLAW_OPENSHELL_GROUPS` and
`NANOCLAW_REMOTE_MAILBOX_GROUPS`. If it isn't, its spawns are refused: they
never fall back to OneCLI. A malformed value stops the host at startup. The
change applies at the next spawn. A sandbox that is already running keeps the
OneCLI env it started with until it exits.

### Live rehearsal (2026-11-25, real Telegram cards, dummy credentials)

A throwaway group on OpenShell credentials ran a script-only task (no model
call) that curled sites outside its policy. Results:

- Detection to card in ~2 s. Approve (example.com, example.net): rule live in
  all three of the group's VMs ~9 s after the tap, saved for the group, retry
  200. Reject (example.org): not saved, retry still blocked, no repeat card,
  agent told.
- Bug found and fixed: requests with `displayFields` need a registered card
  renderer; Telegram has none, so every OpenShell card failed closed. Cards are
  plain text now.
- Bug found and fixed: the documented Claude profile bound the token to the
  agent SDK's `claude` binary, but the runner starts Claude Code
  (`/pnpm/claude` → versioned `claude.exe`). With the corrected profile a dummy
  token reached Anthropic (`ALLOWED POST /v1/messages`, then `401 OAuth access
  token is invalid`), so the real token should work.

### Switch `lab` to OpenShell credentials (about 5 minutes)

Prerequisite: lab already runs in a VM (`NANOCLAW_OPENSHELL_GROUPS` lists it,
`NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell`). You need a Claude
subscription setup-token (`claude setup-token` on a logged-in machine prints
`sk-ant-oat…`).

1. **You, in a terminal on the Mac** (Screen Sharing, or SSH over Tailscale),
   from `~/nanoclaw-v2`:

   ```bash
   bash scripts/openshell-claude-provider.sh lab-claude
   ```

   It imports the provider profile (`docs/openshell/nanoclaw-claude.yaml`),
   asks for the token with input hidden, and creates the provider. The token
   never reaches a command line, shell history or a coding agent. (Don't run it
   through Claude Code's `!` prefix; that would put the token in the session.)
2. **Then tell Claude Code to switch lab over.** It adds
   `NANOCLAW_OPENSHELL_CREDENTIALS=<lab-id>:lab-claude` to `.env`, restarts the
   host, runs `ncl groups restart --id <lab-id>`, and checks:
   - lab replies to a message;
   - `logs/nanoclaw.log` shows `OpenShell credential providers applied` with
     `providers: ["lab-claude"]`;
   - in the sandbox, `printenv CLAUDE_CODE_OAUTH_TOKEN` is an
     `openshell:resolve:env:` placeholder, not the token;
   - the first site lab is not allowed to reach produces an "Allow network
     access?" card in Telegram.

The profile binds the token to the Claude Code binary the runner actually
starts (`/pnpm/claude` resolves to
`/pnpm/global/*/.pnpm/@anthropic-ai+claude-code@*/…/bin/claude.exe`; the glob
survives upgrades). An earlier version bound the agent SDK's own `claude`
under `/app/node_modules`, which the runner no longer uses, so OpenShell would
have refused the real token's traffic (found in the 2026-11-25 rehearsal).

**Rollback:** remove the `.env` line and restart. Delete the provider with
`openshell provider delete lab-claude`.

### Known gaps

- **General egress.** Without the OneCLI proxy, an OpenShell-credential group
  reaches only the remote mailbox and the endpoints of its attached providers.
  Web search MCP, git, curl and agent-browser to other hosts are blocked. To
  give them access, add providers (or provider profiles with `endpoints` and no
  credentials) for those hosts, or approve them as they come up (network
  approvals above).
- **Startup still waits for OneCLI.** The host waits for the OneCLI approval
  subscription before it adopts or spawns anything. If OneCLI is down at host
  start, OpenShell-credential groups wait too. Only outages _after_ startup
  are scoped per group.
- The OpenShell side has no health lease, so an OpenShell gateway outage shows
  up as failed spawns, dying VMs and missing approval cards, not as closed
  admission.
- Only the Claude provider has been looked at. Codex and OpenCode would need
  their own profiles (env var, endpoints, binary path). The agent gets no
  container skill describing the OpenShell credentials.
- The real setup-token has not been tested yet: only the dummy-token echo
  check above has.

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
- **Keep-alive** (`NANOCLAW_OPENSHELL_IDLE_MINUTES`, a core edit in
  `src/reconcile-session.ts`) was dropped when the runtime moved into the
  `/add-openshell` skill: it was off on the live install and was the only
  OpenShell reach-in into the host sweep. An idle VM ends with the global
  ceiling like any container. A per-group keep-alive would need a core hook.

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

## VM memory (2026-11-25, v0.1.10)

- Per-sandbox `--memory`/`--cpu` are accepted and ignored by the vm driver: a
  VM created with `--memory 768Mi --cpu 1` still had ~2 GB / 2 CPUs (gateway
  `mem_mib`/`vcpus`). Tracked upstream in ai-openshell/openshell#5744 (we
  commented). The driver already passes them (`NANOCLAW_OPENSHELL_SIZES`, or the
  install-wide container limits) and warns once that they're not applied.
- Set `mem_mib = 1024` under `[openshell.drivers.vm]` in
  `~/.config/openshell/gateway.toml` (backup `gateway.toml.before-1g`); a new VM
  then reports MemTotal ≈ 1 GB. Not yet tried with a real agent turn (browser use
  may need more).
- An idle VM is small: ~167 MB host RSS; inside, 48 MB used, kernel (slab,
  stacks, page tables) ~16 MB, Linux 6.12. Trimming the kernel would gain little.
- Freed guest memory IS returned, lazily: the VM has a virtio-balloon with
  free-page reporting; ~30 s after the guest frees memory, the host process's
  RSS drops (967 → 767 MB). libkrun releases with `MADV_FREE`, so macOS keeps
  counting the pages in the footprint until it needs them (it reclaims those
  first). (An earlier note here said the opposite — measured too soon.)
- The guest's FILE CACHE is never reported (it isn't free memory) and was the
  biggest controllable part (~500 MB after a browser turn; ~950 MB after reading
  the image). Dropping it unprivileged (`dd iflag=nocache count=0` per file =
  posix_fadvise DONTNEED; `drop_caches` needs root, and exec runs as uid 1000)
  took the cache 946 → 39 MB and the host footprint 1.9 → 1.4 GB within 30 s.
  The VM prelude now runs an idle evictor: once the heartbeat is quiet for
  `NANOCLAW_OPENSHELL_EVICT_IDLE_SECONDS` (default 120), it drops the cache once
  per idle period. Verified live (946 → 72 MB at the first check after idle).
- The second "shared memory" region (~512 MB) is reserved address space with
  0 resident — not a cost. Guest RAM is 8 × 128 MB blocks.

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

1. **Credentials through OpenShell providers** instead of OneCLI: built as a
   per-group partition (see "Credentials from OpenShell providers"); needs the
   real setup-token test and a per-group answer for general egress.
2. **Approvals**: done for network egress of partition groups (see "Network
   approvals"). Still open: L7 (method/path) denials, and revoking an endpoint
   from a running sandbox when its entry is deleted.
3. **Keep idle VMs alive longer**: the prototype knob
   (`NANOCLAW_OPENSHELL_IDLE_MINUTES`) was dropped with the move to a skill;
   needs a core hook, a per-group setting and a memory-aware cap.
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
