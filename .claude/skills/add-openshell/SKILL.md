---
name: add-openshell
description: Run chosen agent groups as OpenShell MicroVMs instead of Docker containers. Per group via NANOCLAW_OPENSHELL_GROUPS; every other group stays on Docker. Requires /add-remote-mailbox (the VM reaches its mailbox over HTTP). Runtime only — credentials stay with the install's gateway. macOS on Apple silicon.
---

# OpenShell MicroVM sessions

This skill adds a session driver, `openshell`, that runs the agent groups listed
in `NANOCLAW_OPENSHELL_GROUPS` as [OpenShell](https://github.com/ai-openshell/openshell)
sandboxes on its MicroVM compute driver. Every other group keeps running in
Docker exactly as before. With no group listed the driver is the Docker driver
itself.

A MicroVM cannot share the session directory's SQLite files with the host, so
every OpenShell group must also use the remote mailbox from
`/add-remote-mailbox`. The two drivers stack: `remote-mailbox` is selected as
the install's driver and wraps `openshell`, which wraps `docker`. The mailbox
driver rewrites a listed group's spec (scratch `/workspace`, mailbox env, a
heartbeat directory); the OpenShell driver then turns that spec into a sandbox.

How a spec becomes a sandbox (`src/drivers/openshell/translate.ts`):

- VM mounts are directories only, cannot nest, at most 32. Single files are
  copied into a read-only staging share, nested directories are mounted flat
  and symlinked into place by an entrypoint prelude.
- OpenShell rewrites the environment (proxy and CA variables, `HOME`, `PATH`);
  the prelude restores what the agent image expects.
- `host.docker.internal` and the mailbox host become `host.openshell.internal`.
  OpenShell always blocks a few ports, so the session's proxy URL is re-pointed
  at a loopback forwarder on the host (`NANOCLAW_OPENSHELL_FORWARD_PORT`,
  default 18755). The sandbox policy admits only those host ports.
- The runner's output is written to `data/openshell-logs/<sandbox>/runner.log`
  (OpenShell does not capture it).
- Endpoints an admin approved for a group are kept in
  `data/openshell-policy/<agentGroupId>.json` (host-only, never mounted) and
  merged into every new sandbox policy of that group, in the
  `nanoclaw_approved` rule. Only a session without a gateway proxy gets them
  (one whose credentials come from OpenShell providers); a proxied session's
  egress stays the proxy. Each entry must be one exact DNS name and port;
  others are skipped with a warning. The approval bridge that writes the file
  is not part of this skill. To revoke an endpoint, delete its entry; running
  sandboxes keep it until they are replaced (or
  `openshell policy update <sandbox> --remove-endpoint host:port`).

Credentials are untouched: the session gets the same gateway env as on Docker.

## Before you start: OpenShell on the host

Tell the user to set up OpenShell once on this Mac (Apple silicon), if it is
not running yet:

1. Install OpenShell with its installer (Homebrew formula; it runs the gateway
   as the launchd service `homebrew.mxcl.openshell` at `https://localhost:17670`).
2. `brew install e2fsprogs` (the VM driver builds ext4 disks).
3. In `~/.config/openshell/gateway.toml`: `compute_driver = "vm"`; in the VM
   section `enable_bind_mounts = true` and `allow_driver_config = true`; turn
   resource admission off. In the Docker section set
   `supervisor_network_mode = "bridge"` (host mode fails on Docker Desktop).
4. Optional: `OPENSHELL_TELEMETRY_ENABLED=false` in
   `~/.config/openshell/gateway.env`.
5. Restart the gateway (`brew services restart openshell`) and check that
   `openshell status` prints `Status: Connected`.

The agent image comes from the local Docker store, so Docker Desktop stays
installed and the image stays built (`./container/build.sh`).

## Install

### 1. Check the prerequisites

The remote mailbox skill must be installed (with its inner-driver setting), the
`openshell` CLI must reach a connected gateway, and the host must be macOS on
Apple silicon. If this fails, install `/add-remote-mailbox` first or finish
the host setup above.

```nc:run effect:check
test "$(uname -s)/$(uname -m)" = "Darwin/arm64" && test -f src/mailbox/remote/driver.ts && grep -q "NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER" src/mailbox/remote/config.ts && grep -q "export function getSessionDriverFactory" src/drivers/driver-registry.ts && command -v openshell >/dev/null && openshell status | grep -q "Status: Connected"
```

### 2. Copy the skill files

Copy each file below from this skill's `payload/` to the same path at the
project root, overwriting any older copy.

```nc:copy
payload/src/drivers/openshell-driver.ts -> src/drivers/openshell-driver.ts
payload/src/drivers/openshell-driver.test.ts -> src/drivers/openshell-driver.test.ts
payload/src/drivers/openshell/approved-endpoints.ts -> src/drivers/openshell/approved-endpoints.ts
payload/src/drivers/openshell/approved-endpoints.test.ts -> src/drivers/openshell/approved-endpoints.test.ts
payload/src/drivers/openshell/composite.ts -> src/drivers/openshell/composite.ts
payload/src/drivers/openshell/composite.test.ts -> src/drivers/openshell/composite.test.ts
payload/src/drivers/openshell/config.ts -> src/drivers/openshell/config.ts
payload/src/drivers/openshell/config.test.ts -> src/drivers/openshell/config.test.ts
payload/src/drivers/openshell/fake-openshell.ts -> src/drivers/openshell/fake-openshell.ts
payload/src/drivers/openshell/forwarder.ts -> src/drivers/openshell/forwarder.ts
payload/src/drivers/openshell/register.ts -> src/drivers/openshell/register.ts
payload/src/drivers/openshell/register.test.ts -> src/drivers/openshell/register.test.ts
payload/src/drivers/openshell/translate.ts -> src/drivers/openshell/translate.ts
payload/src/drivers/openshell/translate.test.ts -> src/drivers/openshell/translate.test.ts
```

### 3. Register the session driver

Append this line to `src/drivers/installed.ts`, keeping the existing lines:

```nc:append to:src/drivers/installed.ts
import './openshell/register.js';
```

### 4. Build and test

The tests register the driver through the real drivers barrel, stack it under
the remote-mailbox driver, and drive the OpenShell driver against a fake
`openshell` CLI.

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/drivers/openshell src/drivers/openshell-driver.test.ts src/mailbox/remote/driver.test.ts
```

### 5. Choose the groups

Ask the user which agent groups should run as MicroVMs. `ncl groups list` shows
their ids. Each one must also be listed in `NANOCLAW_REMOTE_MAILBOX_GROUPS`;
add any that are missing there by hand.

```nc:prompt openshell_groups validate:^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$
Which agent group ids should run as OpenShell MicroVMs? Comma-separated, no spaces (for example ag-123). Each must also use the remote mailbox.
```

Write the groups and stack the drivers in `.env`: the install selects
`remote-mailbox`, and the mailbox driver wraps `openshell`.

```nc:env-set
NANOCLAW_OPENSHELL_GROUPS={{openshell_groups}}
NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell
NANOCLAW_RUNTIME_DRIVER=remote-mailbox
```

If `.env` already sets any of these keys to something else, update it by hand.
`NANOCLAW_OPENSHELL_FORWARD_PORT` (default 18755) moves the loopback proxy
forwarder if that port is taken.

VM size: OpenShell's vm compute driver sizes every VM from `mem_mib` and
`vcpus` in `~/.config/openshell/gateway.toml`. `NANOCLAW_OPENSHELL_SIZES`
(`<agentGroupId>:<memoryMb>[:<cpus>]`, comma-separated) requests a size per
group with `--memory`/`--cpu`, but the vm driver ignores those flags today
(ai-openshell/openshell#5744); the host logs a warning once when a size is
requested.

Memory: while its agent is idle (no heartbeat for
`NANOCLAW_OPENSHELL_EVICT_IDLE_SECONDS`, default 120; `0` turns it off), a VM
drops its file cache once, so the pages go back to macOS through the VM's
free-page-reporting balloon instead of staying held until the VM ends.

### 6. Restart

```nc:run effect:restart
bash setup/lib/restart.sh
```

A running Docker container of a listed group keeps running until it exits;
`ncl groups restart --id <group-id>` moves the group now.

## Verify

`logs/nanoclaw.log` shows `Session runtime driver selected` with
`remote-mailbox(docker+openshell)`. After a listed group's next message,
`openshell sandbox list` shows a sandbox named `nc-<slug>-<hash>`, the agent
answers, and `data/openshell-logs/<sandbox>/runner.log` has the runner's
output. Other groups still run in Docker (`docker ps`).

A first VM boot takes up to a minute; later cold starts take about 4-5 s.

## Troubleshooting

- **`NANOCLAW_OPENSHELL_GROUPS is set but the session driver does not reach OpenShell`**:
  set `NANOCLAW_RUNTIME_DRIVER=remote-mailbox` and
  `NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER=openshell`, then restart.
- **Spawn refused with `... is in NANOCLAW_OPENSHELL_GROUPS but not in NANOCLAW_REMOTE_MAILBOX_GROUPS`**:
  add the group to `NANOCLAW_REMOTE_MAILBOX_GROUPS` and restart.
- **`OpenShell gateway is not reachable; opted-in agent groups cannot spawn`**:
  `openshell status` must print `Status: Connected`. Restart the gateway with
  `brew services restart openshell`. Docker groups keep working meanwhile.
- **The agent never answers**: read
  `data/openshell-logs/<sandbox>/runner.log` (the previous run is in
  `prev-runner.log`). A policy rejection fails the spawn with the
  `openshell policy lint` output in `logs/nanoclaw.error.log`.
- **Bind mounts unreadable in the sandbox**: the gateway runs the Docker
  compute driver, which cannot read bind mounts on macOS. Set
  `compute_driver = "vm"` in `~/.config/openshell/gateway.toml`.
- **An idle VM stops after about 30 minutes**: the host's absolute ceiling
  ends idle sessions, as for Docker. The next message starts a fresh VM.

## Remove

See [REMOVE.md](REMOVE.md).
